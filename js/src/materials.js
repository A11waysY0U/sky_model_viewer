/* ===================== 材质定义解析 ===================== */
function meshBaseName(name) {
  let n = name.substring(name.lastIndexOf('/') + 1).replace(/\.mesh$/i, '');
  return n;
}
function stripVariant(meshName) {
  let n = meshName.replace(/_(StripAnim|CompOcc|ZipPos|ZipUvs|StripNorm|StripUv13|NoOcc|NoCollision).*$/, '');
  n = n.replace(/_\d+$/, '');
  return n;
}
async function loadMaterialDefs(file, entries) {
  const find = (base) => entries.find(e => e.name.toLowerCase().endsWith('/' + base) || e.name.toLowerCase().endsWith(base));
  try {
    const oe = find('outfitdefs.json');
    if (oe) { const raw = await extractEntry(file, oe); outfitDefs = JSON.parse(new TextDecoder().decode(raw)); }
  } catch (e) { outfitDefs = null; }
  try {
    const pe = find('placeabledefs.json');
    if (pe) { const raw = await extractEntry(file, pe); placeableDefs = JSON.parse(new TextDecoder().decode(raw)); }
  } catch (e) { placeableDefs = null; }
  // 建立纹理索引：Images/Bin/ETC2 下的 .ktx，键为小写文件名（不含扩展）
  texIndex = new Map();
  for (const e of entries) {
    const nl = e.name.toLowerCase();
    if (nl.endsWith('.ktx')) {
      const base = nl.substring(nl.lastIndexOf('/') + 1).replace(/\.ktx$/, '');
      if (!texIndex.has(base)) texIndex.set(base, e);
    }
  }
  // 记录 UI 图集坐标表 UIPackedAtlas.lua（衣柜图标当场从图集切图用）
  atlasLuaEntry = entries.find(e => e.name.toLowerCase().endsWith('uipackedatlas.lua')) || null;
  atlasRegionMap = null;
  atlasImgCache.clear();
  iconDataUrlCache.clear();
}

// 解析 UIPackedAtlas.lua，建立 icon 名 -> {图集名, uv[l,t,r,b]} 表（只做一次，懒解析）。
// lua 行格式：resource "ImageRegion" "IconName" { image = "UIPackedAtlas7", uv = { 0.0625, 0.125, 0.1875, 0.25 } }
// uv 值可能是小数(0.0625)或分数(1/2048)，都要能解析。
async function ensureAtlasRegions() {
  if (atlasRegionMap) return atlasRegionMap;
  if (!apkFile || !atlasLuaEntry) { atlasRegionMap = new Map(); return atlasRegionMap; }
  const map = new Map();
  try {
    const raw = await extractEntry(apkFile, atlasLuaEntry);
    const text = new TextDecoder().decode(raw);
    const re = /resource\s+"ImageRegion"\s+"([^"]+)"\s*\{[^}]*?image\s*=\s*"([^"]+)"[^}]*?uv\s*=\s*\{([^}]+)\}/g;
    let m;
    const parseNum = (s) => { s = s.trim(); if (s.includes('/')) { const [a, b] = s.split('/'); return parseFloat(a) / parseFloat(b); } return parseFloat(s); };
    while ((m = re.exec(text)) !== null) {
      const icon = m[1], image = m[2].toLowerCase();
      const parts = m[3].split(',').map(parseNum);
      if (parts.length !== 4 || parts.some(v => !isFinite(v))) continue;
      map.set(icon.toLowerCase(), { image, uv: parts });
    }
  } catch (e) { /* 解析失败则返回空表，图标退回文字 */ }
  atlasRegionMap = map;
  return map;
}

// UI 图集是单通道 GL_COMPRESSED_R11_EAC(0x9270)：强度只在 R 通道，块布局同 EAC alpha。
// viewer 的通用 decodeKtx 只认 ETC2 RGB/RGBA，故这里单独解 R11 -> 把强度写进 RGBA 的 R=G=B=强度。
// 复用已有 decodeEacBlock（EAC 8bit 索引解码），得到 4x4 的强度块。
const GL_R11_EAC = 0x9270;
function decodeR11Ktx(bytes) {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (dv.getUint32(12, true) !== 0x04030201) return null;
  const glInternalFormat = dv.getUint32(28, true);
  if (glInternalFormat !== GL_R11_EAC) return null;
  const width = dv.getUint32(36, true), height = dv.getUint32(40, true);
  const kvSize = dv.getUint32(60, true);
  let offset = 64 + kvSize;
  const imageSize = dv.getUint32(offset, true); offset += 4;
  const out = new Uint8Array(width * height * 4);
  const bdv = new DataView(raw.buffer, raw.byteOffset + offset, imageSize);
  const bxCount = Math.ceil(width / 4), byCount = Math.ceil(height / 4);
  let p = 0;
  for (let by = 0; by < byCount; by++) {
    for (let bx = 0; bx < bxCount; bx++) {
      const vals = decodeEacBlock(bdv, p); p += 8; // 16 个 0-255 强度（列优先）
      for (let i = 0; i < 16; i++) {
        const px = bx * 4 + (i >> 2), py = by * 4 + (i & 3);
        if (px >= width || py >= height) continue;
        const o = (py * width + px) * 4;
        const v = vals[i];
        out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
      }
    }
  }
  return { width, height, data: out };
}
// 后台预热：把衣柜图标用到的 UI 图集整张提前解码并缓存，避免首次打开衣柜时在主线程同步解码卡顿。
// 分批 yield，不冻结 UI；已缓存的图集自动跳过。
let dressIconsPrewarmed = false;
async function prewarmDressIcons() {
  if (dressIconsPrewarmed || !apkFile || !atlasLuaEntry) return;
  dressIconsPrewarmed = true;
  try {
    const regions = await ensureAtlasRegions();
    const images = new Set();
    for (const r of regions.values()) if (r && r.image) images.add(r.image);
    let n = 0;
    for (const img of images) {
      if (!atlasImgCache.has(img)) await ensureAtlasImage(img);
      if (++n % 2 === 0) await new Promise(r => setTimeout(r, 0)); // 让出主线程
    }
  } catch (e) { /* 预热失败不影响按需解码 */ }
}

// 懒解码某张 UI 图集 KTX -> {width,height,data(RGBA)}，带缓存。R11 EAC 走专用解码。
async function ensureAtlasImage(imageName) {
  const key = imageName.toLowerCase();
  if (atlasImgCache.has(key)) return atlasImgCache.get(key);
  let img = null;
  try {
    const entry = texIndex && texIndex.get(key);
    if (entry) {
      const raw = await extractEntry(apkFile, entry);
      img = decodeR11Ktx(raw) || decodeKtx(raw); // UI 图集是 R11 EAC，退回通用 ETC2
    }
  } catch (e) { img = null; }
  atlasImgCache.set(key, img);
  return img;
}

// HSV(色相0-360/饱和0-100/明度0-100) -> [r,g,b] 0-255
function dressHsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(1, s / 100)); v = Math.max(0, Math.min(1, v / 100));
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), mm = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return [Math.round((r + mm) * 255), Math.round((g + mm) * 255), Math.round((b + mm) * 255)];
}
// 选染色 HSV（对齐图标工具：优先彩色 secondary→primary→icon→base，其次任何非默认白，最后原样）
function dressSelectTint(def) {
  const pick = (a) => (Array.isArray(a) && a.length >= 3) ? [Number(a[0]), Number(a[1]), Number(a[2])] : null;
  const cand = [pick(def.secondary_dye_hsv), pick(def.primary_dye_hsv), pick(def.icon_hsv), pick(def.base_hsv)];
  for (const hsv of cand) if (hsv && hsv[1] > 0 && hsv[2] > 0) return hsv;
  for (const hsv of cand) if (hsv && !(Math.abs(hsv[0]) < 1e-6 && Math.abs(hsv[1]) < 1e-6 && Math.abs(hsv[2] - 100) < 1e-6)) return hsv;
  return null;
}

// 生成某装扮的图标 dataURL：从图集裁剪 + 按 HSV 染色（保留原图明度作亮度）。带缓存。
// 图集是"粉白透明"编码：像素强度存在 RGB，alpha 需用 max(R,G,B) 当灰度/不透明度还原（对齐图标工具）。
async function buildIconDataUrl(def) {
  const name = def.name || def.mesh || '';
  if (iconDataUrlCache.has(name)) return iconDataUrlCache.get(name);
  const iconName = (def.icon || '').toLowerCase();
  if (!iconName) { iconDataUrlCache.set(name, null); return null; }
  const regions = await ensureAtlasRegions();
  const region = regions.get(iconName);
  if (!region) { iconDataUrlCache.set(name, null); return null; }
  const img = await ensureAtlasImage(region.image);
  if (!img) { iconDataUrlCache.set(name, null); return null; }
  const W = img.width, H = img.height;
  const left = Math.round(region.uv[0] * W), top = Math.round(region.uv[1] * H);
  const right = Math.round(region.uv[2] * W), bottom = Math.round(region.uv[3] * H);
  const cw = right - left, ch = bottom - top;
  if (cw <= 0 || ch <= 0 || left < 0 || top < 0 || right > W || bottom > H) { iconDataUrlCache.set(name, null); return null; }
  const tint = dressSelectTint(def);
  const tr = tint ? dressHsvToRgb(tint[0], tint[1], 100) : null;
  const valScale = tint ? Math.max(0, Math.min(1, tint[2] / 100)) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  const out = ctx.createImageData(cw, ch);
  const src = img.data;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = (((top + y) * W) + (left + x)) * 4;
      const r = src[si], g = src[si + 1], b = src[si + 2];
      // 图集强度=max(R,G,B)，既当 alpha 又当明度灰度
      const inten = Math.max(r, g, b);
      const di = (y * cw + x) * 4;
      if (inten === 0) { out.data[di + 3] = 0; continue; }
      if (tr) {
        const lum = Math.max(0, Math.min(255, Math.round(inten * valScale)));
        out.data[di] = (tr[0] * lum / 255) | 0;
        out.data[di + 1] = (tr[1] * lum / 255) | 0;
        out.data[di + 2] = (tr[2] * lum / 255) | 0;
      } else {
        // 无染色：白色图标（用强度当亮度），做浅色图标显示
        out.data[di] = inten; out.data[di + 1] = inten; out.data[di + 2] = inten;
      }
      out.data[di + 3] = inten;
    }
  }
  ctx.putImageData(out, 0, 0);
  const url = canvas.toDataURL('image/png');
  iconDataUrlCache.set(name, url);
  return url;
}
// 按贴图名查找并解码为 Three.js 纹理（带缓存）
async function loadTexture(texName) {
  if (!texName || !texIndex) return null;
  const key = texName.toLowerCase();
  if (texCache.has(key)) return texCache.get(key);
  const entry = texIndex.get(key);
  if (!entry) { texCache.set(key, null); return null; }
  try {
    const raw = await extractEntry(apkFile, entry);
    const img = decodeKtx(raw);
    if (!img) { texCache.set(key, null); return null; }
    const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
    // 游戏贴图是 sRGB 编码的 ETC2（glInternalFormat=0x9275 SRGB8_ETC2）。
    // 对齐参考实现：标 NoColorSpace（shader 内手动 srgb2lin 复现 GPU 硬件解码）。
    tex.colorSpace = THREE.NoColorSpace;
    // 关键：flipY=false 对齐参考。参考用 glCompressedTexImage2D 上传 KTX 原始行序、不翻 Y，
    // 且 UV 原样读取不翻 V。我们软解也是 KTX 原始行序，故必须 flipY=false，否则 V 镜像。
    // 对 CharRamp* 这类 LUT（白在 v=0 顶部、黑在 v=1 底部）尤其致命：翻转会把亮部采成黑（玩偶变黑）。
    tex.flipY = false;
    // ramp 类贴图分辨率低，必须线性过滤 + 关 mipmap，否则放大出现硬色带断层
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    texCache.set(key, tex);
    return tex;
  } catch (e) { texCache.set(key, null); return null; }
}
// 所有 Avatar 系列材质本质相同：ramp 提供明暗梯度，base_hsv 提供实际颜色。
// ramp 贴图自带固定色相（CharRampS11 是黄绿、CharRampAvatar 是绿等），
// 真实颜色由 base_hsv 决定：S=0(白) 完全去色成中性明暗，S>0 保留 ramp 色相并叠色。
// 因此 Avatar/AvatarClipped/AvatarHairClipped/AvatarCham 等都统一走去饱和染色分支，
// 由 base_hsv 的饱和度 S 控制去色程度，而不是靠 diffuseTex 名字判定。
function isDyeRamp(shader, diffuseTex) {
  const sh = (shader || '').toLowerCase();
  const tex = (diffuseTex || '').toLowerCase();
  // Avatar 系列角色材质（含 Clipped/HairClipped/Cham/Fur/Alpha 等变体）
  if (/^avatar/.test(sh)) return true;
  // 兜底：diffuseTex 是 CharRamp* 调色板贴图
  if (/^charramp/.test(tex)) return true;
  return false;
}
// 懒扫描所有关卡 Objects.level.bin，建立「mesh 资源名 -> 真实 diffuseTex」索引。
// 只扫一次；扫描中复用同一 Promise。失败/无贴图的 mesh 不入表（保持白模兜底）。
async function ensureMeshTexIndex() {
  if (meshTexIndex) return meshTexIndex;
  if (meshTexScanPromise) return meshTexScanPromise;
  meshTexScanPromise = (async () => {
    const idx = new Map();
    if (apkFile && levelBinIndex.size) {
      toast(`后台建立贴图索引（扫描 ${levelBinIndex.size} 个关卡）...`);
      let done = 0;
      for (const [, entry] of levelBinIndex) {
        try {
          const raw = await extractEntry(apkFile, entry);
          const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
          const insts = extractLevelMeshes(ab);
          for (const it of insts) {
            if (!it.resourceName || !it.diffuseTex) continue;
            const key = it.resourceName.toLowerCase();
            // 首次命中即记录（同一 mesh 在多关卡贴图一般一致）；值含漫反射+法线+第二层色+光照图名
            if (!idx.has(key)) idx.set(key, { diffuse: it.diffuseTex, norm: it.normTex || '', diffuse2: it.diffuse2Tex || '', light: it.lightTex || '', d2off: it.diffuse2Offset || null });
          }
        } catch (e) { /* 单个关卡失败忽略 */ }
        // 每扫完一个关卡就让出主线程，避免长时间同步解析冻结 UI（掉帧/卡顿）
        done++;
        if (done % 2 === 0) await new Promise(r => setTimeout(r, 0));
      }
    }
    meshTexIndex = idx;
    if (idx.size) toast(`贴图索引就绪（${idx.size} 个物件）`);
    return idx;
  })();
  return meshTexScanPromise;
}
function resolveMaterial(meshEntryName) {
  const meshName = meshBaseName(meshEntryName);
  const meshLower = meshName.toLowerCase();
  // 1. OutfitDefs：精确 / 前缀匹配
  if (Array.isArray(outfitDefs)) {
    let best = null, bestLen = 0;
    for (const o of outfitDefs) {
      const em = (o && o.mesh || '').toLowerCase();
      if (!em) continue;
      if (meshLower === em || meshLower.startsWith(em + '_')) {
        if (em.length > bestLen) { best = o; bestLen = em.length; }
      }
    }
    if (best) return { name: best.name || meshName, shader: best.shader || '', diffuseTex: best.diffuseTex || '', baseHsv: best.base_hsv || null, colorOverride: !!best.color_override, rampDye: isDyeRamp(best.shader, best.diffuseTex), source: 'OutfitDefs' };
  }
  // 2. PlaceableDefs
  if (Array.isArray(placeableDefs)) {
    let best = null, bestLen = 0;
    for (const p of placeableDefs) {
      const em = (p && p.mesh || '').toLowerCase();
      if (!em) continue;
      if (meshLower === em || meshLower.startsWith(em + '_') || meshLower.endsWith('_' + em)) {
        if (em.length > bestLen) { best = p; bestLen = em.length; }
      }
    }
    if (best) return { name: best.name || meshName, shader: best.shader || '', diffuseTex: best.diffuse1Tex || best.diffuseTex || '', baseHsv: best.base_hsv || null, colorOverride: !!best.color_override, source: 'PlaceableDefs' };
  }
  // 3. 回退：用去掉变体后缀的名字
  const stripped = stripVariant(meshName);
  if (stripped) return { name: stripped, shader: 'Mesh', diffuseTex: stripped, source: 'MeshName' };
  return null;
}

// 从 PlaceableDefs 解析物件统一缩放（对齐原项目 SkyResourceResolver.lookupPlaceableScale）
// 匹配规则：精确/前缀/后缀，取 scale 数组第 0 个元素；找不到返回 1。
function resolvePlaceableScale(meshName) {
  if (!Array.isArray(placeableDefs)) return 1;
  const meshLower = stripVariant(meshName).toLowerCase();
  let best = 1, bestLen = 0;
  for (const p of placeableDefs) {
    const em = (p && p.mesh || '').toLowerCase();
    if (!em) continue;
    if (meshLower === em || meshLower.startsWith(em + '_') || meshLower.endsWith('_' + em)) {
      if (em.length <= bestLen) continue;
      const s = Array.isArray(p.scale) && p.scale.length ? Number(p.scale[0]) : null;
      if (s != null && s > 0) { best = s; bestLen = em.length; }
    }
  }
  return best;
}

