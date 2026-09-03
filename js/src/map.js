/* ===== map.js ===== */
// SkyMeshViewer.map.js
// 解析 Sky 的关卡地形文件 .meshes（LVL0 / GEO0 meshopt 路径，v0x39+）。
// 包含 meshopt 顶点缓冲解码器（从 MeshoptDecoder.java 移植）和地形上色。

const MAP_VERTEX_SIZE = 36;
const MAP_CHUNK_SIZE = 56;
const MAP_SUBCHUNK_SIZE = 8;
const LVL0_MAGIC = 0x304C564C; // "LVL0" LE

// ---------- meshopt 顶点解码器 ----------
const K_VERTEX_HEADER = 0xA0;
const K_VERTEX_BLOCK_SIZE_BYTES = 8192;
const K_VERTEX_BLOCK_MAX_SIZE = 256;
const K_BYTE_GROUP_SIZE = 16;

const REVERSE_BITS8 = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i, r = 0;
    for (let j = 0; j < 8; j++) { r = ((r << 1) | (v & 1)) & 0xFF; v >>= 1; }
    t[i] = r;
  }
  return t;
})();

function getVertexBlockSize(vertexSize) {
  const result = ((K_VERTEX_BLOCK_SIZE_BYTES / vertexSize) | 0) & ~(K_BYTE_GROUP_SIZE - 1);
  return result < K_VERTEX_BLOCK_MAX_SIZE ? result : K_VERTEX_BLOCK_MAX_SIZE;
}

function decodeBytesGroup(data, pos, out, outOff, bits) {
  if (bits === 0) { for (let i = 0; i < 16; i++) out[outOff + i] = 0; return pos; }
  if (bits === 8) { out.set(data.subarray(pos, pos + 16), outOff); return pos + 16; }
  const sentinel = (1 << bits) - 1;
  const byteSize = (8 / bits) | 0;
  const fixedCount = (16 / byteSize) | 0;
  let varPos = pos + fixedCount;
  let idx = outOff;
  for (let fb = 0; fb < fixedCount; fb++) {
    let b = data[pos + fb] & 0xFF;
    if (bits === 1) b = REVERSE_BITS8[b];
    for (let j = 0; j < byteSize; j++) {
      const enc = b >> (8 - bits);
      b = (b << bits) & 0xFF;
      if (enc === sentinel) { out[idx] = data[varPos]; varPos++; }
      else out[idx] = enc;
      idx++;
    }
  }
  return varPos;
}

function decodeBytes(data, pos, bufferSize, bitsTable, out) {
  const numGroups = (bufferSize / 16) | 0;
  const headerSize = ((numGroups + 3) / 4) | 0;
  const headerBase = pos;
  pos += headerSize;
  for (let g = 0; g < numGroups; g++) {
    const bitsk = ((data[headerBase + ((g / 4) | 0)] & 0xFF) >> ((g % 4) * 2)) & 3;
    pos = decodeBytesGroup(data, pos, out, g * 16, bitsTable[bitsk]);
  }
  return pos;
}

function decodeDeltasU8(planes, result, base, vertexCount, vertexSize, lastVertex, k) {
  for (let kb = 0; kb < 4; kb++) {
    const plane = planes[kb];
    let p = lastVertex[k + kb] & 0xFF;
    let off = base + kb;
    for (let i = 0; i < vertexCount; i++) {
      const v0 = plane[i] & 0xFF;
      const zigzag = ((v0 & 1) !== 0 ? 255 : 0) ^ (v0 >> 1);
      const v = (zigzag + p) & 0xFF;
      result[off] = v; p = v; off += vertexSize;
    }
  }
}

function decodeDeltasU16(planes, result, base, vertexCount, vertexSize, lastVertex, k) {
  for (let kb = 0; kb <= 2; kb += 2) {
    let p = (lastVertex[k + kb] & 0xFF) | ((lastVertex[k + kb + 1] & 0xFF) << 8);
    let off = base + kb;
    const p0 = planes[kb], p1 = planes[kb + 1];
    for (let i = 0; i < vertexCount; i++) {
      const v0 = (p0[i] & 0xFF) | ((p1[i] & 0xFF) << 8);
      const zigzag = ((v0 & 1) !== 0 ? 0xFFFF : 0) ^ (v0 >> 1);
      const v = (zigzag + p) & 0xFFFF;
      result[off] = v & 0xFF;
      result[off + 1] = (v >> 8) & 0xFF;
      p = v; off += vertexSize;
    }
  }
}

function decodeDeltasU32Xor(planes, result, base, vertexCount, vertexSize, lastVertex, k, rot) {
  let p = ((lastVertex[k] & 0xFF) |
    ((lastVertex[k + 1] & 0xFF) << 8) |
    ((lastVertex[k + 2] & 0xFF) << 16) |
    ((lastVertex[k + 3] & 0xFF) << 24)) >>> 0;
  let off = base;
  const p0 = planes[0], p1 = planes[1], p2 = planes[2], p3 = planes[3];
  if (rot === 0) {
    for (let i = 0; i < vertexCount; i++) {
      const cur = ((p0[i] & 0xFF) | ((p1[i] & 0xFF) << 8) | ((p2[i] & 0xFF) << 16) | ((p3[i] & 0xFF) << 24)) >>> 0;
      const v = (cur ^ p) >>> 0;
      result[off] = v & 0xFF; result[off + 1] = (v >>> 8) & 0xFF;
      result[off + 2] = (v >>> 16) & 0xFF; result[off + 3] = (v >>> 24) & 0xFF;
      p = v; off += vertexSize;
    }
  } else {
    const rshift = 32 - rot;
    for (let i = 0; i < vertexCount; i++) {
      let v = ((p0[i] & 0xFF) | ((p1[i] & 0xFF) << 8) | ((p2[i] & 0xFF) << 16) | ((p3[i] & 0xFF) << 24)) >>> 0;
      v = (((v << rot) | (v >>> rshift)) ^ p) >>> 0;
      result[off] = v & 0xFF; result[off + 1] = (v >>> 8) & 0xFF;
      result[off + 2] = (v >>> 16) & 0xFF; result[off + 3] = (v >>> 24) & 0xFF;
      p = v; off += vertexSize;
    }
  }
}

function decodeVertexBlock(data, pos, result, vertexOffset, vertexCount, vertexSize, lastVertex, channels, version) {
  const vertexCountAligned = (vertexCount + 15) & ~15;
  const controlSize = (version === 0) ? 0 : (vertexSize / 4) | 0;
  const controlBase = pos;
  pos += controlSize;
  const planes = [null, null, null, null];
  for (let k = 0; k < vertexSize; k += 4) {
    const ctrlByte = (version === 0) ? 0 : (data[controlBase + ((k / 4) | 0)] & 0xFF);
    for (let j = 0; j < 4; j++) {
      const ctrl = (ctrlByte >> (j * 2)) & 3;
      if (ctrl === 3) {
        planes[j] = data.subarray(pos, pos + vertexCount);
        pos += vertexCount;
      } else if (ctrl === 2) {
        planes[j] = new Uint8Array(vertexCount);
      } else {
        let bitsTable;
        if (version === 0) bitsTable = [0, 2, 4, 8];
        else bitsTable = (ctrl === 0) ? [0, 1, 2, 4] : [1, 2, 4, 8];
        planes[j] = new Uint8Array(vertexCountAligned);
        pos = decodeBytes(data, pos, vertexCountAligned, bitsTable, planes[j]);
      }
    }
    const channel = (version === 0) ? 0 : (channels[(k / 4) | 0] & 0xFF);
    const ctype = channel & 3;
    const base = vertexOffset * vertexSize + k;
    if (ctype === 0) decodeDeltasU8(planes, result, base, vertexCount, vertexSize, lastVertex, k);
    else if (ctype === 1) decodeDeltasU16(planes, result, base, vertexCount, vertexSize, lastVertex, k);
    else {
      const rot = (32 - (channel >> 4)) & 31;
      decodeDeltasU32Xor(planes, result, base, vertexCount, vertexSize, lastVertex, k, rot);
    }
  }
  const lastStart = vertexOffset * vertexSize + (vertexCount - 1) * vertexSize;
  lastVertex.set(result.subarray(lastStart, lastStart + vertexSize), 0);
  return pos;
}

function meshoptDecodeVertexBuffer(vertexCount, vertexSize, data) {
  if (vertexSize % 4 !== 0) throw new Error('vertex size must be multiple of 4');
  const dataEnd = data.length;
  if (dataEnd < 1) throw new Error('meshopt data empty');
  const header = data[0] & 0xFF;
  if ((header & 0xF0) !== K_VERTEX_HEADER) throw new Error('meshopt header mismatch: 0x' + header.toString(16));
  const version = header & 0x0F;
  if (version > 1) throw new Error('unsupported meshopt version: ' + version);
  const tailSize = vertexSize + (version === 0 ? 0 : (vertexSize / 4) | 0);
  const tailSizeMin = version === 0 ? 32 : 24;
  const tailSizePad = Math.max(tailSize, tailSizeMin);
  if (dataEnd < 1 + tailSizePad) throw new Error('meshopt data too short');
  const tailStart = dataEnd - tailSize;
  const lastVertex = new Uint8Array(256);
  lastVertex.set(data.subarray(tailStart, tailStart + vertexSize), 0);
  let channels = null;
  if (version !== 0) {
    channels = new Uint8Array(vertexSize / 4);
    channels.set(data.subarray(tailStart + vertexSize, tailStart + vertexSize + (vertexSize / 4) | 0), 0);
  }
  const vertexBlockSize = getVertexBlockSize(vertexSize);
  const result = new Uint8Array(vertexCount * vertexSize);
  let pos = 1;
  let vertexOffset = 0;
  while (vertexOffset < vertexCount) {
    const blockSize = Math.min(vertexBlockSize, vertexCount - vertexOffset);
    pos = decodeVertexBlock(data, pos, result, vertexOffset, blockSize, vertexSize, lastVertex, channels, version);
    vertexOffset += blockSize;
  }
  return result;
}

// ---------- 材质颜色表（kMaterial enum -> RGB）----------
const MAP_MATERIAL_COLORS = (() => {
  const c = new Array(256);
  for (let i = 0; i < 256; i++) c[i] = [0.7, 0.7, 0.7];
  const set = (i, r, g, b) => { c[i] = [r, g, b]; };
  set(0, 0.5, 0.5, 0.5); set(2, 0.6, 0.7, 0.8); set(3, 0.2, 0.2, 0.2);
  set(4, 0.9, 0.8, 0.6); set(5, 0.6, 0.45, 0.3); set(6, 0.3, 0.3, 0.3);
  set(7, 0.65, 0.5, 0.35); set(16, 0.55, 0.5, 0.45); set(17, 0.6, 0.5, 0.35);
  set(18, 0.65, 0.6, 0.5); set(19, 0.4, 0.35, 0.3); set(20, 0.5, 0.5, 0.55);
  set(21, 0.9, 0.8, 0.3); set(22, 0.7, 0.85, 0.95); set(23, 0.8, 0.8, 0.85);
  set(24, 0.75, 0.75, 0.8); set(25, 0.7, 0.7, 0.75); set(26, 0.6, 0.45, 0.35);
  set(27, 0.4, 0.35, 0.25); set(28, 0.35, 0.35, 0.35); set(29, 0.85, 0.85, 0.8);
  set(30, 0.6, 0.45, 0.3); set(31, 0.8, 0.7, 0.6); set(32, 0.85, 0.78, 0.55);
  set(33, 0.7, 0.65, 0.45); set(34, 0.9, 0.85, 0.65); set(35, 0.95, 0.95, 0.98);
  set(36, 0.75, 0.68, 0.45); set(37, 0.45, 0.4, 0.3); set(48, 0.4, 0.6, 0.3);
  set(49, 0.3, 0.5, 0.25); set(50, 0.5, 0.7, 0.35); set(51, 0.35, 0.55, 0.3);
  set(52, 0.7, 0.5, 0.5); set(80, 0.9, 0.9, 1.0);
  return c;
})();

function readAscii(data, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) { const ch = data[off + i]; if (ch === 0) break; s += String.fromCharCode(ch); }
  return s;
}

function snorm8(b) {
  const v = (b << 24) >> 24; // sign-extend
  return Math.max(-1, v / 127);
}

// ---------- .meshes 解析（GEO0 路径）----------
function isMeshesFile(bytes) {
  return bytes && bytes.length >= 4 && bytes[0] === 0x4C && bytes[1] === 0x56 && bytes[2] === 0x4C && bytes[3] === 0x30;
}

function parseMeshes(arrayBuffer) {
  const data = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);
  if (data.length < 12) throw new Error('文件过短');
  if (dv.getUint32(0, true) !== LVL0_MAGIC) throw new Error('非 LVL0 文件');
  const version = dv.getUint32(4, true);
  const tocCount = data[8] & 0xFF;
  let geo0Offset = -1, geo0Length = 0;
  for (let i = 0; i < tocCount; i++) {
    const eo = 12 + i * 12;
    if (eo + 12 > data.length) break;
    const type = readAscii(data, eo, 4);
    const segOff = dv.getUint32(eo + 4, true);
    const segLen = dv.getUint32(eo + 8, true);
    if (type === 'GEO0') { geo0Offset = segOff; geo0Length = segLen; }
  }
  if (geo0Offset < 0 || geo0Offset >= data.length) throw new Error('无 GEO0 段（不支持的地图版本 0x' + version.toString(16) + '）');
  return parseGeo0(data, dv, geo0Offset, geo0Length, version);
}

function parseGeo0(data, dv, offset, length, version) {
  let pos = offset;
  const indexCount = dv.getUint32(pos, true); pos += 4;
  const vertexCount = dv.getUint32(pos, true); pos += 4;
  const chunkCount = dv.getUint32(pos, true); pos += 4;
  const cloudCount = dv.getUint32(pos, true); pos += 4;
  const subchunkCount = dv.getUint32(pos, true); pos += 4;
  if (vertexCount <= 0 || vertexCount > 2000000) throw new Error('顶点数异常: ' + vertexCount);

  const compressedSize = dv.getUint32(pos, true); pos += 4;
  if (compressedSize <= 0 || pos + compressedSize > data.length) throw new Error('压缩块大小异常');
  const compressed = data.subarray(pos, pos + compressedSize);
  pos += compressedSize;

  const rawVerts = meshoptDecodeVertexBuffer(vertexCount, MAP_VERTEX_SIZE, compressed);

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const rvDv = new DataView(rawVerts.buffer, rawVerts.byteOffset, rawVerts.byteLength);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < vertexCount; i++) {
    const b = i * MAP_VERTEX_SIZE;
    const px = rvDv.getFloat32(b, true);
    const py = rvDv.getFloat32(b + 4, true);
    const pz = rvDv.getFloat32(b + 8, true);
    positions[i * 3] = px; positions[i * 3 + 1] = py; positions[i * 3 + 2] = pz;
    if (px < minX) minX = px; if (py < minY) minY = py; if (pz < minZ) minZ = pz;
    if (px > maxX) maxX = px; if (py > maxY) maxY = py; if (pz > maxZ) maxZ = pz;

    normals[i * 3] = snorm8(rawVerts[b + 12]);
    normals[i * 3 + 1] = snorm8(rawVerts[b + 13]);
    normals[i * 3 + 2] = snorm8(rawVerts[b + 14]);

    // 地形上色：按 b16-19 材质索引 + b20-23 混合权重，从 MAP_MATERIAL_COLORS 查色加权。
    const m0 = rawVerts[b + 16], m1 = rawVerts[b + 17], m2 = rawVerts[b + 18], m3 = rawVerts[b + 19];
    const w0 = rawVerts[b + 20] / 255, w1 = rawVerts[b + 21] / 255, w2 = rawVerts[b + 22] / 255, w3 = rawVerts[b + 23] / 255;
    const tw = w0 + w1 + w2 + w3;
    if (tw < 0.001) {
      const c = MAP_MATERIAL_COLORS[m0];
      colors[i * 3] = c[0]; colors[i * 3 + 1] = c[1]; colors[i * 3 + 2] = c[2];
    } else {
      const c0 = MAP_MATERIAL_COLORS[m0], c1 = MAP_MATERIAL_COLORS[m1], c2 = MAP_MATERIAL_COLORS[m2], c3 = MAP_MATERIAL_COLORS[m3];
      colors[i * 3] = (c0[0] * w0 + c1[0] * w1 + c2[0] * w2 + c3[0] * w3) / tw;
      colors[i * 3 + 1] = (c0[1] * w0 + c1[1] * w1 + c2[1] * w2 + c3[1] * w3) / tw;
      colors[i * 3 + 2] = (c0[2] * w0 + c1[2] * w1 + c2[2] * w2 + c3[2] * w3) / tw;
    }
  }

  // u8 局部索引
  let localIndices = null;
  if (indexCount > 0 && pos + indexCount <= data.length) {
    localIndices = data.subarray(pos, pos + indexCount);
    pos += indexCount;
  }

  // chunks（56 字节）
  const totalChunks = chunkCount + cloudCount;
  const chunks = [];
  for (let i = 0; i < totalChunks; i++) {
    if (pos + MAP_CHUNK_SIZE > data.length) break;
    const idxStart = dv.getUint32(pos, true);
    const vtxStart = dv.getUint32(pos + 4, true);
    const idxCnt = dv.getUint16(pos + 12, true);
    chunks.push([idxStart, vtxStart, idxCnt]);
    pos += MAP_CHUNK_SIZE;
  }

  // 地形 chunk 组装全局索引（前 chunkCount 个），云 chunk（后 cloudCount 个）单独组装。
  // 游戏里云 = CloudShMesh（Terrain 着色器 + CLOUD 宏），几何就烘焙在 .meshes 顶点缓冲里，
  // 与地形共用顶点，云顶点材质多为 80（浅蓝白）。此前只装地形 → 云"消失"。
  const globalIndices = [];
  const cloudIndices = [];
  // 同时统计"被渲染顶点"的范围，用于取景（避免未使用顶点撑大包围盒）
  let rMinX = Infinity, rMinY = Infinity, rMinZ = Infinity, rMaxX = -Infinity, rMaxY = -Infinity, rMaxZ = -Infinity;
  if (localIndices) {
    for (let ci = 0; ci < chunkCount && ci < chunks.length; ci++) {
      const [idxStart, vtxStart, idxCnt] = chunks[ci];
      for (let j = 0; j < idxCnt; j++) {
        const li = idxStart + j;
        if (li >= indexCount) break;
        const gi = localIndices[li] + vtxStart;
        if (gi >= 0 && gi < vertexCount) {
          globalIndices.push(gi);
          const px = positions[gi * 3], py = positions[gi * 3 + 1], pz = positions[gi * 3 + 2];
          if (px < rMinX) rMinX = px; if (py < rMinY) rMinY = py; if (pz < rMinZ) rMinZ = pz;
          if (px > rMaxX) rMaxX = px; if (py > rMaxY) rMaxY = py; if (pz > rMaxZ) rMaxZ = pz;
        }
      }
    }
    // 云 chunk：不纳入取景（云体积巨大会把相机拉飞，同大气特效处理）
    for (let ci = chunkCount; ci < chunkCount + cloudCount && ci < chunks.length; ci++) {
      const [idxStart, vtxStart, idxCnt] = chunks[ci];
      for (let j = 0; j < idxCnt; j++) {
        const li = idxStart + j;
        if (li >= indexCount) break;
        const gi = localIndices[li] + vtxStart;
        if (gi >= 0 && gi < vertexCount) cloudIndices.push(gi);
      }
    }
  }
  const hasRendered = rMinX !== Infinity;

  return {
    positions, normals, colors,
    indices: new Uint32Array(globalIndices),
    cloudIndices: new Uint32Array(cloudIndices),
    vertexCount, indexCount: globalIndices.length, chunkCount, cloudCount,
    boundsMin: [minX, minY, minZ], boundsMax: [maxX, maxY, maxZ],
    // 被渲染三角形的紧致范围（取景用）
    renderMin: hasRendered ? [rMinX, rMinY, rMinZ] : [minX, minY, minZ],
    renderMax: hasRendered ? [rMaxX, rMaxY, rMaxZ] : [maxX, maxY, maxZ],
    version,
  };
}


