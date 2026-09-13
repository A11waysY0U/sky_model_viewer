'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
let failures = 0;
const assert = (ok, msg) => { if (ok) console.log('  ✓', msg); else { failures++; console.error('  ✗', msg); } };
class ImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } }
class FakeCanvas {
  constructor() { this.width = 1; this.height = 1; }
  getContext() {
    if (this._2d) return this._2d;
    this._2d = {
      putImageData: (image) => { this.lastPutImageData = image; },
      drawImage() {},
      getImageData: () => new ImageData(new Uint8ClampedArray([100, 150, 200, 200]), 1, 1),
    };
    return this._2d;
  }
  toBlob(cb, type) { cb(new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: type || 'image/png' })); }
}
const canvases = [];
const ctx = { console, Blob, ImageData, TextEncoder, TextDecoder, ArrayBuffer, DataView, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Float32Array, Float64Array, JSON, Math, Number, String, Object, Array, Map, Set, Promise, URL, document: { createElement: () => { const canvas = new FakeCanvas(); canvases.push(canvas); return canvas; } }, currentMesh: null, currentData: { name: 'mf-test' }, toast: () => {}, download: () => {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/vendor/three.js'), 'utf8') + '\nthis.THREE = THREE;', ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/src/export3mf.js'), 'utf8'), ctx);
const THREE = ctx.THREE;
const texturedGeometry = new THREE.BufferGeometry();
texturedGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0,0,0, 2,0,0, 2,2,0, 0,2,0]), 3));
texturedGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0,0, 1,0, 1,1, 0,1]), 2));
texturedGeometry.setIndex([0,1,2, 0,2,3]);
const texture = new THREE.DataTexture(new Uint8Array([255,128,0,255, 0,128,255,255, 255,255,255,255, 0,0,0,255]), 2, 2, THREE.RGBAFormat);
const shaderMaterial = new THREE.ShaderMaterial({ uniforms: {
  uHasColorOverride: { value: 0 }, uBaseColor: { value: new THREE.Vector3(1,1,1) }, uBaseHsv: { value: new THREE.Vector3(0,0,100) },
  uHasTex: { value: 1 }, uTex: { value: texture }, uOpacity: { value: 1 },
}, vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }' });
const textured = new THREE.Mesh(texturedGeometry, shaderMaterial); textured.name = 'TexturedQuad';
const solidGeometry = new THREE.BufferGeometry();
solidGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0,0,0, 1,0,0, 0,1,0]), 3));
const solid = new THREE.Mesh(solidGeometry, new THREE.MeshStandardMaterial({ color: 0x3366CC, opacity: 1 })); solid.name = 'SolidTri';
const imageTexture = new THREE.Texture();
imageTexture.image = { width: 1, height: 1 };
const imageMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, opacity: 0.5, transparent: true, map: imageTexture });
const imageQuad = new THREE.Mesh(texturedGeometry, imageMaterial); imageQuad.name = 'ImageQuad';
ctx.currentMesh = new THREE.Group(); ctx.currentMesh.add(textured, solid, imageQuad);
let blob = null, exportError = null;
ctx.download = (value) => { blob = value; };
ctx.toast = (msg, isError) => { if (isError) exportError = msg; };
vm.runInContext('export3MF()', ctx);
function unzipStored(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) if (bytes.readUInt32LE(i) === 0x06054B50) { eocd = i; break; }
  if (eocd < 0) throw new Error('EOCD not found');
  const total = bytes.readUInt16LE(eocd + 10);
  const cdOffset = bytes.readUInt32LE(eocd + 16);
  const files = {};
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (bytes.readUInt32LE(p) !== 0x02014B50) throw new Error('Central directory invalid');
    const method = bytes.readUInt16LE(p + 10);
    const size = bytes.readUInt32LE(p + 20);
    const nameLen = bytes.readUInt16LE(p + 28);
    const extraLen = bytes.readUInt16LE(p + 30);
    const commentLen = bytes.readUInt16LE(p + 32);
    const local = bytes.readUInt32LE(p + 42);
    const name = bytes.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (method !== 0) throw new Error('Test expects stored ZIP entries');
    const localNameLen = bytes.readUInt16LE(local + 26);
    const localExtraLen = bytes.readUInt16LE(local + 28);
    const start = local + 30 + localNameLen + localExtraLen;
    files[name] = bytes.subarray(start, start + size);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
(async () => {
  for (let i = 0; i < 100 && !blob && !exportError; i++) await new Promise((r) => setTimeout(r, 20));
  assert(!exportError, '导出过程无错误' + (exportError ? ': ' + exportError : ''));
  assert(blob instanceof Blob, '产生 3MF Blob');
  const bytes = Buffer.from(await blob.arrayBuffer());
  if (process.env.MF_OUT) fs.writeFileSync(process.env.MF_OUT, bytes);
  assert(bytes.readUInt32LE(0) === 0x04034B50, 'ZIP local header 正确');
  const files = unzipStored(bytes);
  assert(!!files['[Content_Types].xml'], '包含 [Content_Types].xml');
  assert(!!files['_rels/.rels'], '包含根 relationships');
  assert(!!files['3D/3dmodel.model'], '包含 3D/3dmodel.model');
  assert(!!files['3D/_rels/3dmodel.model.rels'], '包含模型贴图 relationships');
  const textureName = Object.keys(files).find((n) => n.startsWith('3D/Textures/') && n.endsWith('.png'));
  assert(!!textureName, '包含 PNG 贴图资源');
  const tintedCanvas = canvases.find((canvas) => canvas.lastPutImageData && canvas.lastPutImageData.data[0] === 100);
  assert(tintedCanvas && tintedCanvas.lastPutImageData.data[3] === 100, '普通图片贴图会烘焙材质透明度');
  const xml = files['3D/3dmodel.model'].toString('utf8');
  assert(xml.includes('xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"'), '包含材料扩展命名空间');
  assert(xml.includes('<basematerials'), '包含 basematerials');
  assert(xml.includes('<m:texture2d '), '包含 texture2d');
  assert(xml.includes('<m:texture2dgroup '), '包含 texture2dgroup');
  assert(xml.includes('<m:tex2coord '), '包含 UV 坐标');
  assert(xml.includes('<m:tex2coord u="0" v="1" />'), '3MF UV V 轴方向正确');
  assert(xml.includes('p1="0" p2="1" p3="2"'), '贴图三角形包含三组 UV 索引');
  assert((xml.match(/<object /g) || []).length === 3, '包含 3 个 3MF object');
  assert((xml.match(/<item /g) || []).length === 3, 'build 包含 3 个 item');
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });



