/* ===================== 3MF 导出 =====================
 * 3MF 是 ZIP/OPC + XML。这里不依赖额外库，直接写出 stored ZIP，
 * 支持静态三角网格、对象层级烘焙、基础颜色和主贴图。
 * 动画、法线/金属度/粗糙度/AO、自定义光照不会写入 3MF。
 */
const MF_CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const MF_MATERIAL_NS = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';
const MF_MODEL_REL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
const MF_TEXTURE_REL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dtexture';
let mfExporting = false;

function mfXmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function mfNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  // 3MF uses decimal doubles; retaining 9 fractional digits avoids visible
  // banding in UVs and preserves small colour/geometry related coordinates.
  return String(Math.round(n * 1000000000) / 1000000000);
}
function mfColorBytes(color, opacity) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round((Number(v) || 0) * 255)));
  const rawAlpha = Number(opacity);
  const a = Number.isFinite(rawAlpha) ? Math.max(0, Math.min(1, rawAlpha)) : 1;
  return [clamp(color && color.r), clamp(color && color.g), clamp(color && color.b), Math.round(a * 255)];
}
function mfColorHex(color, opacity) {
  return '#' + mfColorBytes(color, opacity).map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}
function mfUniformValue(material, name) {
  const u = material && material.uniforms && material.uniforms[name];
  return u ? u.value : undefined;
}
function mfColorFromUniform(value, fallback) {
  const f = fallback == null ? 1 : fallback;
  const color = new THREE.Color().setRGB(f, f, f);
  if (value && value.isVector3) color.setRGB(value.x, value.y, value.z);
  else if (Array.isArray(value) && value.length >= 3) color.setRGB(value[0], value[1], value[2]);
  return color;
}
function mfHsvToColor(value) {
  const h = value && value.isVector3 ? value.x : (Array.isArray(value) ? value[0] : 0);
  const s = value && value.isVector3 ? value.y : (Array.isArray(value) ? value[1] : 0);
  const v = value && value.isVector3 ? value.z : (Array.isArray(value) ? value[2] : 100);
  const hn = (((h || 0) % 360) + 360) % 360 / 360;
  const sn = Math.max(0, Math.min(1, (s || 0) / 100));
  const vn = Math.max(0, Math.min(1, (v == null ? 100 : v) / 100));
  const p = Math.abs((hn + 1) % 1 * 6 - 3);
  const q = Math.abs((hn + 2 / 3) % 1 * 6 - 3);
  const t = Math.abs((hn + 1 / 3) % 1 * 6 - 3);
  return new THREE.Color().setRGB(
    vn * (1 + sn * (Math.max(0, Math.min(1, p - 1)) - 1)),
    vn * (1 + sn * (Math.max(0, Math.min(1, q - 1)) - 1)),
    vn * (1 + sn * (Math.max(0, Math.min(1, t - 1)) - 1))
  );
}
function mfShaderBaseColor(material) {
  const base = mfColorFromUniform(mfUniformValue(material, 'uBaseColor'), 1);
  if (mfUniformValue(material, 'uBaseColor')) return base;
  const pair = [['uSkyTop', 'uSkyBottom'], ['uShallowColor', 'uDeepColor']];
  for (const names of pair) {
    const a = mfUniformValue(material, names[0]);
    const b = mfUniformValue(material, names[1]);
    if (a && a.isVector3 && b && b.isVector3) {
      return new THREE.Color().setRGB((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
    }
  }
  return base;
}
function mfShaderHasValidHsv(material) {
  const hsv = mfUniformValue(material, 'uBaseHsv');
  const marker = mfUniformValue(material, 'uHasBaseHsv');
  if (marker != null) return Number(marker) === 1;
  return !!(hsv && ((hsv.isVector3 && [hsv.x, hsv.y, hsv.z].every(Number.isFinite)) ||
    (Array.isArray(hsv) && hsv.length >= 3 && hsv.slice(0, 3).every(Number.isFinite))));
}
function mfShaderBaseMap(material, isOverride) {
  const override = isOverride == null
    ? Number(mfUniformValue(material, 'uHasColorOverride')) === 1 && mfShaderHasValidHsv(material)
    : !!isOverride;
  if (override) return null;
  const tex = mfUniformValue(material, 'uTex');
  if (tex && tex.isTexture && Number(mfUniformValue(material, 'uHasTex')) !== 0) return { texture: tex, channel: 0 };
  const diffuse2 = mfUniformValue(material, 'uDiffuse2Tex');
  if (diffuse2 && diffuse2.isTexture && Number(mfUniformValue(material, 'uHasDiffuse2')) !== 0) return { texture: diffuse2, channel: 3 };
  return null;
}function mfMaterialInfo(source) {
  if (!source) return { color: new THREE.Color(1, 1, 1), opacity: 1, texture: null, uvChannel: 0 };
  if (source.isShaderMaterial) {
    const override = Number(mfUniformValue(source, 'uHasColorOverride')) === 1 && mfShaderHasValidHsv(source);
    let color = mfShaderBaseColor(source).clone();
    if (override) color = mfHsvToColor(mfUniformValue(source, 'uBaseHsv'));
    else color.multiply(mfHsvToColor(mfUniformValue(source, 'uBaseHsv')));
    const opacityValue = Number(mfUniformValue(source, 'uOpacity'));
    const opacity = Number.isFinite(opacityValue) ? opacityValue : (Number.isFinite(source.opacity) ? source.opacity : 1);
    const baseMap = mfShaderBaseMap(source, override);
    return { color, opacity, texture: baseMap ? baseMap.texture : null, uvChannel: baseMap ? baseMap.channel : 0 };
  }
  const color = source.color && source.color.isColor ? source.color.clone() : new THREE.Color(1, 1, 1);
  const opacity = Number.isFinite(source.opacity) ? source.opacity : 1;
  const texture = source.map || null;
  const uvChannel = texture && Number.isFinite(texture.channel) ? texture.channel : 0;
  return { color, opacity, texture, uvChannel };
}
function mfUVAttribute(geometry, channel) {
  if (!geometry) return null;
  if (channel === 0) return geometry.getAttribute('uv');
  if (channel === 1) return geometry.getAttribute('uv1') || geometry.getAttribute('auv1');
  if (channel === 3) return geometry.getAttribute('uv3') || geometry.getAttribute('auv3');
  return geometry.getAttribute('uv' + channel);
}
function mfGeometryRanges(geometry) {
  const index = geometry.index;
  const position = geometry.getAttribute('position');
  const total = index ? index.count : (position ? position.count : 0);
  if (!total) return [];
  const dr = geometry.drawRange || {};
  const drawStart = Math.max(0, Math.min(total, Number(dr.start) || 0));
  const drawCount = Number.isFinite(dr.count) ? Math.max(0, dr.count) : total;
  const drawEnd = Math.min(total, drawStart + drawCount);
  const ranges = [];
  if (geometry.groups && geometry.groups.length) {
    for (const group of geometry.groups) {
      const start = Math.max(drawStart, Number(group.start) || 0);
      const end = Math.min(drawEnd, start + (Number(group.count) || 0));
      if (end - start >= 3) ranges.push({ start, count: end - start, materialIndex: group.materialIndex || 0 });
    }
  } else if (drawEnd - drawStart >= 3) {
    ranges.push({ start: drawStart, count: drawEnd - drawStart, materialIndex: 0 });
  }
  return ranges;
}
function mfBuildMeshGroup(object, range, material) {
  const geometry = object.geometry;
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  const uvAttr = mfUVAttribute(geometry, material.uvChannel);
  const world = object.matrixWorld;
  const reverseWinding = world.determinant() < 0;
  const vertices = [];
  const triangles = [];
  const uvs = [];
  const vertexMap = new Map();
  const uvMap = new Map();
  const sourceIndex = (i) => index ? index.getX(i) : i;
  const getVertex = (vertexIndex) => {
    let out = vertexMap.get(vertexIndex);
    if (out !== undefined) return out;
    const p = new THREE.Vector3().fromBufferAttribute(position, vertexIndex).applyMatrix4(world);
    out = vertices.length;
    vertices.push([p.x, p.y, p.z]);
    vertexMap.set(vertexIndex, out);
    return out;
  };
  const getUv = (vertexIndex) => {
    const u = uvAttr ? uvAttr.getX(vertexIndex) : 0;
    // 3MF texture coordinates use a bottom-left origin while PNG rows start
    // at the top. The viewer uploads game textures with flipY=false, so
    // invert V at export time to keep the printed texture orientation.
    const v = uvAttr ? 1 - uvAttr.getY(vertexIndex) : 1;
    const key = mfNumber(u) + ',' + mfNumber(v);
    let out = uvMap.get(key);
    if (out !== undefined) return out;
    out = uvs.length;
    uvs.push([u, v]);
    uvMap.set(key, out);
    return out;
  };
  const end = Math.min(range.start + range.count, index ? index.count : position.count);
  for (let i = range.start; i + 2 < end; i += 3) {
    let a = sourceIndex(i), b = sourceIndex(i + 1), c = sourceIndex(i + 2);
    if (reverseWinding) { const tmp = b; b = c; c = tmp; }
    const tri = { a: getVertex(a), b: getVertex(b), c: getVertex(c) };
    if (material.texture && uvAttr) tri.uv = [getUv(a), getUv(b), getUv(c)];
    triangles.push(tri);
  }
  return { vertices, triangles, uvs };
}
function mfCollectMeshes(root) {
  if (!root) return [];
  root.updateMatrixWorld(true);
  const meshes = [];
  const walk = (node, visible) => {
    if (!node || visible === false || node.visible === false) return;
    if (node.isMesh && !node.isLine && !node.isPoints && node.geometry && node.material) {
      const geometry = node.geometry;
      if (geometry.getAttribute('position')) {
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        const ranges = mfGeometryRanges(geometry);
        for (const range of ranges) {
          const source = materials[Math.min(range.materialIndex, materials.length - 1)] || materials[0];
          const info = mfMaterialInfo(source);
          if (info.texture && !mfUVAttribute(geometry, info.uvChannel)) info.texture = null;
          const mesh = mfBuildMeshGroup(node, range, info);
          if (mesh.triangles.length) {
            meshes.push({
              name: node.name || ('Mesh_' + (meshes.length + 1)),
              color: info.color, opacity: info.opacity,
              texture: info.texture, uvChannel: info.uvChannel,
              vertices: mesh.vertices, triangles: mesh.triangles, uvs: mesh.uvs,
            });
          }
        }
      }
    }
    for (const child of node.children) walk(child, true);
  };
  walk(root, true);
  return meshes;
}
function mfTextureKey(mesh) {
  return mesh.texture.uuid + '|' + mfColorBytes(mesh.color, mesh.opacity).join(',');
}
async function mfTextureToPng(texture, color, opacity) {
  const image = texture && texture.image ? texture.image : {};
  const width = Number(image.width) || 0;
  const height = Number(image.height) || 0;
  if (!width || !height) throw new Error('贴图尺寸无效');
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持 Canvas 2D');
  const out = new Uint8ClampedArray(width * height * 4);
  const factor = mfColorBytes(color, opacity);
  if (image.data !== undefined) {
    const src = image.data;
    const isFloat = src instanceof Float32Array || src instanceof Float64Array;
    const is16 = src instanceof Uint16Array;
    const channels = Math.max(1, Math.min(4, Math.floor(src.length / (width * height)) || 4));
    const convert = (v) => isFloat ? Math.max(0, Math.min(255, v * 255)) : (is16 ? v / 257 : v);
    for (let i = 0; i < width * height; i++) {
      const si = i * channels, p = i * 4;
      // DataTexture sources are commonly RGB8/RGBA8, while decoded HDR data
      // may be float or 16-bit. Normalize all of them to a PNG RGBA surface.
      out[p] = convert(src[si] == null ? 0 : src[si]) * factor[0] / 255;
      out[p + 1] = convert(src[si + Math.min(1, channels - 1)] == null ? 0 : src[si + Math.min(1, channels - 1)]) * factor[1] / 255;
      out[p + 2] = convert(src[si + Math.min(2, channels - 1)] == null ? 0 : src[si + Math.min(2, channels - 1)]) * factor[2] / 255;
      const alpha = channels >= 4 ? src[si + 3] : 255;
      out[p + 3] = convert(alpha == null ? 255 : alpha) * factor[3] / 255;
    }
    ctx.putImageData(new ImageData(out, width, height), 0, 0);
  } else {
    ctx.drawImage(image, 0, 0, width, height);
    const needsTint = factor[0] !== 255 || factor[1] !== 255 || factor[2] !== 255 || factor[3] !== 255;
    if (needsTint) {
      // 3MF 的 texture2dgroup 没有 baseColorFactor；普通图片必须先烘焙材质色/透明度，
      // 否则同一张贴图配不同材质色时会全部导出成原始颜色。
      if (typeof ctx.getImageData !== 'function') throw new Error('浏览器不支持贴图颜色烘焙');
      const pixels = ctx.getImageData(0, 0, width, height);
      const data = pixels.data;
      for (let i = 0; i < data.length; i += 4) {
        data[i] = data[i] * factor[0] / 255;
        data[i + 1] = data[i + 1] * factor[1] / 255;
        data[i + 2] = data[i + 2] * factor[2] / 255;
        data[i + 3] = data[i + 3] * factor[3] / 255;
      }
      ctx.putImageData(pixels, 0, 0);
    }
  }
  const blob = await new Promise((resolve, reject) => {
    if (canvas.toBlob) canvas.toBlob((b) => b ? resolve(b) : reject(new Error('PNG 编码失败')), 'image/png');
    else if (canvas.convertToBlob) canvas.convertToBlob({ type: 'image/png' }).then(resolve, reject);
    else reject(new Error('浏览器不支持 PNG 导出'));
  });
  return new Uint8Array(await blob.arrayBuffer());
}
let _mfCrcTable = null;
function mfCrc32(data) {
  if (!_mfCrcTable) {
    _mfCrcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _mfCrcTable[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = _mfCrcTable[(c ^ data[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function mfZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const records = [];
  let offset = 0;
  const u16 = (dv, p, v) => dv.setUint16(p, v, true);
  const u32 = (dv, p, v) => dv.setUint32(p, v >>> 0, true);
  for (const file of files) {
    const name = enc.encode(file.name);
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    if (offset + 30 + name.length + data.length > 0xFFFFFFFF) throw new Error('3MF 文件超过 4GB ZIP 限制');
    const crc = mfCrc32(data);
    const local = new Uint8Array(30 + name.length);
    const ldv = new DataView(local.buffer);
    u32(ldv, 0, 0x04034B50); u16(ldv, 4, 20); u16(ldv, 6, 0); u16(ldv, 8, 0);
    u16(ldv, 10, 0); u16(ldv, 12, 0x21); u32(ldv, 14, crc); u32(ldv, 18, data.length); u32(ldv, 22, data.length);
    u16(ldv, 26, name.length); u16(ldv, 28, 0); local.set(name, 30);
    chunks.push(local, data);
    records.push({ name, data, crc, offset });
    offset += local.length + data.length;
  }
  const centralStart = offset;
  for (const rec of records) {
    const h = new Uint8Array(46 + rec.name.length);
    if (offset + h.length > 0xFFFFFFFF) throw new Error('3MF 文件超过 4GB ZIP 限制');
    const dv = new DataView(h.buffer);
    u32(dv, 0, 0x02014B50); u16(dv, 4, 0x0314); u16(dv, 6, 20); u16(dv, 8, 0); u16(dv, 10, 0);
    u16(dv, 12, 0); u16(dv, 14, 0x21); u32(dv, 16, rec.crc); u32(dv, 20, rec.data.length); u32(dv, 24, rec.data.length);
    u16(dv, 28, rec.name.length); u16(dv, 30, 0); u16(dv, 32, 0); u16(dv, 34, 0); u16(dv, 36, 0);
    u32(dv, 38, 0); u32(dv, 42, rec.offset); h.set(rec.name, 46);
    chunks.push(h); offset += h.length;
  }
  const centralSize = offset - centralStart;
  const end = new Uint8Array(22);
  const edv = new DataView(end.buffer);
  u32(edv, 0, 0x06054B50); u16(edv, 4, 0); u16(edv, 6, 0); u16(edv, 8, records.length); u16(edv, 10, records.length);
  u32(edv, 12, centralSize); u32(edv, 16, centralStart); u16(edv, 20, 0);
  chunks.push(end);
  if (offset + end.length > 0xFFFFFFFF) throw new Error('3MF 文件超过 4GB ZIP 限制');
  return new Blob(chunks, { type: 'model/3mf' });
}
async function mfBuildPackage(root, title) {
  const meshes = mfCollectMeshes(root);
  if (!meshes.length) throw new Error('没有可导出的三角网格');
  let nextId = 2;
  const baseColors = [];
  const baseLookup = new Map();
  const baseIndex = (mesh) => {
    const hex = mfColorHex(mesh.color, mesh.opacity);
    let idx = baseLookup.get(hex);
    if (idx === undefined) {
      idx = baseColors.length;
      baseColors.push({ hex, name: 'color_' + idx });
      baseLookup.set(hex, idx);
    }
    mesh.baseIndex = idx;
  };
  const textureDefs = [];
  const textureLookup = new Map();
  const textureFiles = [];
  for (const mesh of meshes) {
    if (!mesh.texture) { baseIndex(mesh); continue; }
    const key = mfTextureKey(mesh);
    let def = textureLookup.get(key);
    if (!def) {
      try {
        const png = await mfTextureToPng(mesh.texture, mesh.color, mesh.opacity);
        const path = '/3D/Textures/texture_' + textureDefs.length + '.png';
        def = { id: nextId++, path, file: '3D/Textures/texture_' + textureDefs.length + '.png' };
        textureDefs.push(def); textureLookup.set(key, def);
        textureFiles.push({ name: def.file, data: png });
      } catch (e) {
        mesh.texture = null; baseIndex(mesh); continue;
      }
    }
    mesh.textureDef = def;
  }
  for (const mesh of meshes) {
    if (mesh.textureDef) mesh.propertyId = nextId++;
    mesh.objectId = nextId++;
  }
  if (!baseColors.length) {
    baseColors.push({ hex: '#FFFFFFFF', name: 'default' });
    baseLookup.set('#FFFFFFFF', 0);
  }
  const xml = [];
  xml.push('<?xml version="1.0" encoding="UTF-8"?>');
  xml.push('<model unit="meter" xml:lang="zh-CN" xmlns="' + MF_CORE_NS + '" xmlns:m="' + MF_MATERIAL_NS + '">');
  xml.push('<metadata name="Title">' + mfXmlEscape(title) + '</metadata>');
  xml.push('<metadata name="Application">Sky Mesh Studio</metadata>');
  xml.push('<resources>');
  xml.push('<basematerials id="1">');
  for (const c of baseColors) xml.push('<base name="' + mfXmlEscape(c.name) + '" displaycolor="' + c.hex + '" />');
  xml.push('</basematerials>');
  for (const tex of textureDefs) {
    xml.push('<m:texture2d id="' + tex.id + '" path="' + tex.path + '" contenttype="image/png" tilestyleu="wrap" tilestylev="wrap" />');
  }
  for (const mesh of meshes) {
    if (!mesh.textureDef) continue;
    xml.push('<m:texture2dgroup id="' + mesh.propertyId + '" texid="' + mesh.textureDef.id + '">');
    for (const uv of mesh.uvs) xml.push('<m:tex2coord u="' + mfNumber(uv[0]) + '" v="' + mfNumber(uv[1]) + '" />');
    xml.push('</m:texture2dgroup>');
  }
  for (const mesh of meshes) {
    xml.push('<object id="' + mesh.objectId + '" type="model" name="' + mfXmlEscape(mesh.name) + '">');
    xml.push('<mesh><vertices>');
    for (const v of mesh.vertices) xml.push('<vertex x="' + mfNumber(v[0]) + '" y="' + mfNumber(v[1]) + '" z="' + mfNumber(v[2]) + '" />');
    xml.push('</vertices><triangles>');
    for (const tri of mesh.triangles) {
      let props;
      if (mesh.textureDef && tri.uv) props = ' pid="' + mesh.propertyId + '" p1="' + tri.uv[0] + '" p2="' + tri.uv[1] + '" p3="' + tri.uv[2] + '"';
      else props = ' pid="1" p1="' + (mesh.baseIndex == null ? 0 : mesh.baseIndex) + '"';
      xml.push('<triangle v1="' + tri.a + '" v2="' + tri.b + '" v3="' + tri.c + '"' + props + ' />');
    }
    xml.push('</triangles></mesh></object>');
  }
  xml.push('</resources><build>');
  for (const mesh of meshes) xml.push('<item objectid="' + mesh.objectId + '" />');
  xml.push('</build></model>');
  const modelXml = xml.join('\n');
  const enc = new TextEncoder();
  const files = [
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" /><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />' + (textureDefs.length ? '<Default Extension="png" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodeltexture" />' : '') + '</Types>') },
    { name: '_rels/.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="' + MF_MODEL_REL + '" /></Relationships>') },
    { name: '3D/3dmodel.model', data: enc.encode(modelXml) },
  ];
  if (textureDefs.length) {
    const rels = textureDefs.map((tex, i) => '<Relationship Target="' + tex.path + '" Id="rel' + (i + 1) + '" Type="' + MF_TEXTURE_REL + '" />').join('');
    files.push({ name: '3D/_rels/3dmodel.model.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels + '</Relationships>') });
    for (const tex of textureFiles) files.push(tex);
  }
  return { blob: mfZip(files), objects: meshes.length, textures: textureDefs.length };
}
async function export3MF() {
  if (mfExporting) return;
  if (!currentMesh) { toast('请先加载模型再导出 3MF', true); return; }
  mfExporting = true;
  toast('正在导出 3MF...');
  try {
    const result = await mfBuildPackage(currentMesh, (currentData && currentData.name) || 'model');
    download(result.blob, ((currentData && currentData.name) || 'model') + '.3mf');
    toast('已导出 3MF（对象 ' + result.objects + '，贴图 ' + result.textures + '）');
  } catch (err) {
    toast('3MF 导出失败: ' + err, true);
  } finally {
    mfExporting = false;
  }
}



