'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
let failures = 0;
const assert = (ok, msg) => {
  if (ok) console.log('  ✓', msg);
  else { failures++; console.error('  ✗', msg); }
};

class FileReader {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((result) => {
      this.result = result;
      if (this.onloadend) this.onloadend({ target: this });
    });
  }
}
class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
}
class FakeCanvas {
  constructor() { this.width = 1; this.height = 1; }
  getContext() {
    return { translate() {}, scale() {}, putImageData() {} };
  }
  toBlob(cb, type) {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, this.width & 255, this.height & 255]);
    cb(new Blob([bytes], { type: type || 'image/png' }));
  }
}

const ctx = {
  console, Blob, FileReader, ImageData, TextEncoder, TextDecoder,
  ArrayBuffer, DataView, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Float32Array,
  JSON, Math, Number, String, Object, Array, Map, Set, Promise, URL,
  document: { createElement: () => new FakeCanvas() },
  currentMesh: null, currentData: { name: 'material-test' },
  toast: () => {}, download: () => {},
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/vendor/three.js'), 'utf8') + '\nthis.THREE = THREE; this.GLTFExporter = GLTFExporter;', ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/src/export.js'), 'utf8'), ctx);

const THREE = ctx.THREE;
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
  -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0,
]), 3));
geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
  0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
]), 3));
geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
  0, 0, 1, 0, 1, 1, 0, 1,
]), 2));
geometry.setAttribute('auv1', new THREE.BufferAttribute(new Float32Array([
  0, 0, 1, 0, 1, 1, 0, 1,
]), 2));
geometry.setAttribute('auv3', new THREE.BufferAttribute(new Float32Array([
  0, 0, 1, 0, 1, 1, 0, 1,
]), 2));
geometry.setIndex([0, 1, 2, 0, 2, 3]);

const pixels = (r, g, b, a = 255) => new Uint8Array([r, g, b, a]);
const baseTex = new THREE.DataTexture(pixels(220, 80, 40), 1, 1, THREE.RGBAFormat);
const normalTex = new THREE.DataTexture(pixels(128, 128, 255), 1, 1, THREE.RGBAFormat);
const lightTex = new THREE.DataTexture(pixels(240, 160, 0, 255), 1, 1, THREE.RGBAFormat);
const material = new THREE.ShaderMaterial({
  uniforms: {
    uColorOn: { value: 0 }, // 导出不应受预览白模开关影响
    uHasColorOverride: { value: 0 },
    uBaseColor: { value: new THREE.Vector3(1, 1, 1) },
    uBaseHsv: { value: new THREE.Vector3(0, 0, 100) },
    uOpacity: { value: 0.8 },
    uAlphaTest: { value: 0.1 },
    uClayColor: { value: new THREE.Vector3(0.6, 0.6, 0.62) },
    uHasTex: { value: 1 },
    uTex: { value: baseTex },
    uHasNormTex: { value: 1 },
    uNormTex: { value: normalTex },
    uNormStrength: { value: 0.75 },
    uHasLightTex: { value: 1 },
    uLightTex: { value: lightTex },
    uHasDiffuse2: { value: 0 },
    uDiffuse2Tex: { value: null },
  },
  vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }',
  transparent: true,
  side: THREE.DoubleSide,
  vertexColors: false,
});
ctx.currentMesh = new THREE.Group();
ctx.currentMesh.add(new THREE.Mesh(geometry, material));

let blob = null;
let exportError = null;
ctx.download = (value) => { blob = value; };
ctx.toast = (msg, isError) => { if (isError) exportError = msg; };
vm.runInContext('exportGLB()', ctx);

(async () => {
  for (let i = 0; i < 100 && !blob && !exportError; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert(!exportError, '导出过程无错误' + (exportError ? ': ' + exportError : ''));
  assert(blob instanceof Blob, '产生 GLB Blob');

  const bytes = Buffer.from(await blob.arrayBuffer());
  assert(bytes.readUInt32LE(0) === 0x46546c67, 'GLB magic 正确');
  const jsonLen = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLen).toString('utf8').trim());
  assert(json.materials && json.materials.length === 1, `包含 1 个导出材质（实际 ${json.materials ? json.materials.length : 0}）`);
  const mat = json.materials && json.materials[0];
  assert(mat && mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorTexture, '包含 baseColorTexture');
  assert(mat && mat.normalTexture, '包含 normalTexture');
  assert(mat && mat.occlusionTexture, '包含 occlusionTexture');
  assert(mat && mat.pbrMetallicRoughness.baseColorTexture.texCoord === 0, '主贴图使用 TEXCOORD_0');
  assert(mat && mat.normalTexture.texCoord === 0, '法线贴图使用 TEXCOORD_0');
  assert(mat && mat.occlusionTexture.texCoord === 1, 'AO 贴图使用 TEXCOORD_1');
  assert(json.meshes && json.meshes[0].primitives[0].attributes.TEXCOORD_1 !== undefined, '几何包含 TEXCOORD_1');
  assert(json.meshes && json.meshes[0].primitives[0].attributes._AUV1 === undefined, '不残留无效 _AUV1 属性');
  assert(json.images && json.images.length >= 3, `GLB 嵌入至少 3 张图片（实际 ${json.images ? json.images.length : 0}）`);

  assert(material.isShaderMaterial, '原始材质类型未被修改');
  assert(geometry.getAttribute('auv1') && !geometry.getAttribute('uv1'), '原始几何 UV 属性未被修改');
  assert(!material.map, '原始 ShaderMaterial 未被挂载标准贴图属性');

  const makeExportState = () => ({
    geometries: new Set(), materials: new Set(), materialsBySource: new Map(),
    textures: new Set(), texturesByKey: new Map(), customSkins: new Map(),
  });
  const missingHsv = material.clone();
  missingHsv.uniforms.uHasColorOverride.value = 1;
  missingHsv.uniforms.uHasBaseHsv = { value: 0 };
  const missingState = makeExportState();
  const missingOut = vm.runInContext('glbCreateExportMaterial', ctx)(missingHsv, missingState);
  assert(!!missingOut.map, '缺失 base_hsv 的 color_override 保留主贴图');
  ctx.glbDisposeExportState ? ctx.glbDisposeExportState(missingState) : null;

  const validOverride = material.clone();
  validOverride.uniforms.uHasColorOverride.value = 1;
  validOverride.uniforms.uHasBaseHsv = { value: 1 };
  validOverride.uniforms.uBaseHsv.value.set(0, 100, 100);
  const overrideState = makeExportState();
  const overrideOut = vm.runInContext('glbCreateExportMaterial', ctx)(validOverride, overrideState);
  assert(!overrideOut.map, '有效 base_hsv 的 color_override 使用纯色覆盖');
  assert(overrideOut.color.r > 0.95 && overrideOut.color.g < 0.05 && overrideOut.color.b < 0.05,
    '有效 HSV 覆盖导出为红色');
  ctx.glbDisposeExportState ? ctx.glbDisposeExportState(overrideState) : null;

  const skinRemap = vm.runInContext(`(() => {
    const root = new THREE.Group();
    const bone = new THREE.Bone();
    bone.name = 'rootBone';
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0,0,0, 1,0,0, 0,1,0]), 3));
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(12), 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array([
      1,0,0,0, 1,0,0,0, 1,0,0,0,
    ]), 4));
    const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
    mesh.name = 'skinMesh';
    mesh.add(bone);
    mesh.bind(new THREE.Skeleton([bone]));
    root.add(mesh);
    const state = {
      geometries: new Set(), materials: new Set(), materialsBySource: new Map(),
      textures: new Set(), texturesByKey: new Map(),
    };
    const clone = glbBuildExportRoot(root, state);
    const clonedMesh = clone.getObjectByName('skinMesh');
    const clonedBone = clone.getObjectByName('rootBone');
    const result = {
      skeletonBoneIsClone: clonedMesh.skeleton.bones[0] === clonedBone,
      originalSkeletonUntouched: mesh.skeleton.bones[0] === bone,
      jointHasParent: clonedMesh.skeleton.bones[0].parent === clonedMesh,
    };
    glbDisposeExportState(state);
    return result;
  })()`, ctx);
  assert(skinRemap.skeletonBoneIsClone, '克隆后的 SkinnedMesh 指向克隆骨骼');
  assert(skinRemap.originalSkeletonUntouched, '原始 SkinnedMesh 的骨骼未被修改');
  assert(skinRemap.jointHasParent, '导出 skeleton joint 位于导出对象树中');

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});


