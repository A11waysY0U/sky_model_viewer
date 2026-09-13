/* ===================== 换装 ===================== */
// 按 outfit.mesh 名（可能不含变体后缀）查找实际 zip 条目
function findMeshEntryByName(meshName) {
  const key = meshName.toLowerCase();
  if (meshEntryIndex.has(key)) return meshEntryIndex.get(key);
  // 前缀匹配：Body_Ghost -> Body_Ghost_StripAnim_...
  let best = null, bestLen = 1e9;
  for (const [base, entry] of meshEntryIndex) {
    if (base === key || base.startsWith(key + '_')) {
      if (base.length < bestLen) { best = entry; bestLen = base.length; }
    }
  }
  return best;
}

// 人物部件材质：与原渲染器一致——diffuseTex 直接当漫反射贴图采样 + 标准光照。
// 原 shader: baseColor = ambient + key*NdotL + fill*NdotF; baseColor *= texColor.rgb
// CharRamp* 也是直接当贴图用，无需 Toon/ramp 查表。
// 角色专用暖调光照：CharRampAvatar 的皮肤区是中性灰（三通道近似相等，实测脚95/小腿136/短裤168），
// 暖褐肤色在游戏里由运行时暖环境光/SH 探针提供。默认全局光照 ambient 偏低(0.27)+冷蓝 fill(150/160/176)
// 会把中灰皮肤（尤其背光的手臂/小腿）压成"死黑偏冷"。这里给角色单独抬高环境光并暖化、去冷蓝 fill，
// 复现游戏里"暖黄+略偏黑"的肤感。只作用于换装角色，不改地图/单模型。
const CHAR_AMBIENT = [0.50, 0.46, 0.40];
const CHAR_KEY     = [0.98, 0.95, 0.88];
const CHAR_FILL    = [0.42, 0.39, 0.34];
async function buildPartMaterial(def, skinning, boneCount) {
  const difName = def.diffuseTex || '';
  const tex = await loadTexture(difName);
  const dye = isDyeRamp(def.shader, def.diffuseTex);
  const hsv = { baseHsv: def.base_hsv || null, colorOverride: !!def.color_override };
  return skyMaterial({ color: 0xffffff, map: (tex && showTexture) ? tex : null, side: THREE.DoubleSide, baseHsv: hsv.baseHsv, colorOverride: hsv.colorOverride, rampDye: dye, skinning: !!skinning, boneCount: boneCount || 0,
    ambient: CHAR_AMBIENT, key: CHAR_KEY, fill: CHAR_FILL });
}

/* ===================== 骨骼动画：蒙皮矩阵计算 =====================
 * 逐行对齐参考 _skyviewer_ref/MeshRenderer.updateBoneMatrices：
 *  1. 每骨骼取当前帧 SQT（关键帧稀疏：向后再向前查找 hold-last，全无则全局兜底）
 *  2. compose 局部矩阵，按父层级累乘出世界矩阵
 *  3. 最终蒙皮矩阵 B = world × IBM（IBM = animpack bone.matrix，直接用，不转置不求逆）
 *  4. 按「部件骨名 ↔ animpack 骨名」重映射到部件骨序，上传 uBoneMatrices
 * 注：我们的顶点保持原始坐标（静态模型一直正常显示），故不做参考里的 -x,-z 翻转。
 */
// 四元数(x,y,z,w)+trans+scale 合成列主序 mat4（对齐 AnimPackParser.composeMat4）
function animComposeMat4(t, r, s) {
  const x=r[0], y=r[1], z=r[2], w=r[3];
  const xx=x*x, yy=y*y, zz=z*z, xy=x*y, xz=x*z, yz=y*z, wx=w*x, wy=w*y, wz=w*z;
  const r00=1-2*(yy+zz), r01=2*(xy-wz), r02=2*(xz+wy);
  const r10=2*(xy+wz), r11=1-2*(xx+zz), r12=2*(yz-wx);
  const r20=2*(xz-wy), r21=2*(yz+wx), r22=1-2*(xx+yy);
  const sx=s[0], sy=s[1], sz=s[2];
  return new Float32Array([
    r00*sx, r10*sx, r20*sx, 0,
    r01*sy, r11*sy, r21*sy, 0,
    r02*sz, r12*sz, r22*sz, 0,
    t[0], t[1], t[2], 1
  ]);
}
// 列主序 4x4 相乘 a*b
function animMulMat4(a, b) {
  const r = new Float32Array(16);
  for (let col=0; col<4; col++) for (let row=0; row<4; row++) {
    let sum=0; for (let k=0;k<4;k++) sum += a[k*4+row]*b[col*4+k];
    r[col*4+row] = sum;
  }
  return r;
}
// 在 frameData 里为某骨某分量做 hold-last 查找（向后→向前→全局），对齐参考
function animFindComp(dec, boneIdx, fi, compOff, compLen) {
  const fc = dec.frameCount, fd = dec.frameData;
  // 向后
  let f = fi;
  while (f > 0) { const b=(boneIdx*fc+f)*10; if (b+compOff+compLen<=fd.length && !isNaN(fd[b+compOff])) break; f--; }
  let b = (boneIdx*fc+f)*10;
  if (b+compOff+compLen<=fd.length && isNaN(fd[b+compOff])) {
    // 向前
    f = fi+1;
    while (f < fc) { const bb=(boneIdx*fc+f)*10; if (bb+compOff+compLen<=fd.length && !isNaN(fd[bb+compOff])) break; f++; }
  }
  b = (boneIdx*fc+Math.min(f,fc-1))*10;
  if (b+compOff+compLen<=fd.length && f<fc && !isNaN(fd[b+compOff])) {
    const out=[]; for (let k=0;k<compLen;k++) out.push(fd[b+compOff+k]); return out;
  }
  // 全局兜底
  for (let sf=0; sf<fc; sf++) { const bb=(boneIdx*fc+sf)*10; if (bb+compOff+compLen<=fd.length && !isNaN(fd[bb+compOff])) { const out=[]; for(let k=0;k<compLen;k++) out.push(fd[bb+compOff+k]); return out; } }
  return null;
}
// 计算 animpack 各骨的最终蒙皮矩阵（世界×IBM），返回 Float32Array(animBoneCount*16)
function computeAnimBoneMatrices(frameIdx) {
  const ap = animState.pack, dec = animState.decoded;
  if (!ap) return null;
  const bc = ap.boneCount;
  const base = animGetBoneSqtList(ap);
  const locals = new Float32Array(bc * 16);
  for (let i = 0; i < bc; i++) {
    let t, r, s;
    if (dec && dec.frameData) {
      const fi = Math.max(0, Math.min(frameIdx, dec.frameCount - 1));
      r = animFindComp(dec, i, fi, 3, 4) || (base[i] ? base[i].rotation : [0,0,0,1]);
      t = animFindComp(dec, i, fi, 7, 3) || (base[i] ? base[i].translation : [0,0,0]);
      s = animFindComp(dec, i, fi, 0, 3) || (base[i] ? base[i].scale : [1,1,1]);
    } else if (base[i]) {
      t = base[i].translation; r = base[i].rotation; s = base[i].scale;
    } else { t=[0,0,0]; r=[0,0,0,1]; s=[1,1,1]; }
    locals.set(animComposeMat4(t, r, s), i * 16);
  }
  // 世界矩阵（父层级累乘）
  const worlds = new Float32Array(bc * 16);
  for (let i = 0; i < bc; i++) {
    const parent = ap.bones[i].parentIndex;
    const local = locals.subarray(i*16, i*16+16);
    if (parent >= 0 && parent < i) {
      worlds.set(animMulMat4(worlds.subarray(parent*16, parent*16+16), local), i*16);
    } else {
      worlds.set(local, i*16);
    }
  }
  // 最终 = world × IBM（bone.matrix 直接作 IBM）
  const out = new Float32Array(bc * 16);
  for (let i = 0; i < bc; i++) {
    const ibm = ap.bones[i].matrix;
    out.set(animMulMat4(worlds.subarray(i*16, i*16+16), ibm), i*16);
  }
  return out;
}
// 每帧把当前帧的蒙皮矩阵重映射到各部件骨序并写入材质 uBoneMatrices
function applyAnimFrame(frameIdx) {
  if (!animState.pack || !animState.skinnedParts.length) return;
  const animMats = computeAnimBoneMatrices(frameIdx);
  if (!animMats) return;
  for (const part of animState.skinnedParts) {
    const data = part.mat.userData.boneData;
    const btex = part.mat.userData.boneTex;
    if (!data) continue;
    const map = part.boneToAnim; // 部件骨序 -> animpack 骨序
    const boneN = part.mat.userData.boneCount || part.skeletonBones.length;
    const n = Math.min(part.skeletonBones.length, boneN);
    for (let mi = 0; mi < n; mi++) {
      const ai = map[mi];
      const o = mi * 16;
      if (ai >= 0) {
        // 列主序整块拷贝 animpack 骨矩阵到骨骼纹理数据
        const src = ai * 16;
        for (let k = 0; k < 16; k++) data[o + k] = animMats[src + k];
      } else {
        writeBoneIdentity(data, mi);
      }
    }
    if (btex) btex.needsUpdate = true;
  }
}
// 为部件建立「部件骨名 -> animpack 骨序」映射
function buildBoneMapping(skeletonBones, ap) {
  const map = new Int32Array(skeletonBones.length).fill(-1);
  for (let mi = 0; mi < skeletonBones.length; mi++) {
    const mn = skeletonBones[mi].name;
    for (let ai = 0; ai < ap.bones.length; ai++) {
      if (animBoneNamesMatch(mn, ap.bones[ai].name)) { map[mi] = ai; break; }
    }
  }
  return map;
}
// 默认站姿 animpack 候选（对齐参考项目 DEFAULT_ANIM_CANDIDATES / 知识库 35）：
// 只用于「加载骨架让角色归位站姿 + 背饰挂点定位」，静止在第 0 帧、不自动播放。
const DEFAULT_ANIM_CANDIDATES = ['CharKidAnimGroundState', 'CharKidAnimGroundNav', 'CharKidAnimPlayerAct'];
// 从 entries 里挑默认站姿动画：优先候选名单，再退到第一个 CharKidAnim*，最后第一个。返回索引，-1=无。
function pickDefaultIdleAnim() {
  const es = animState.entries || [];
  if (!es.length) return -1;
  const nameOf = e => e.name.substring(e.name.lastIndexOf('/') + 1).replace(/\.animpack$/i, '');
  for (const cand of DEFAULT_ANIM_CANDIDATES) {
    const i = es.findIndex(e => nameOf(e).toLowerCase() === cand.toLowerCase());
    if (i >= 0) return i;
  }
  const ck = es.findIndex(e => /^CharKidAnim/i.test(nameOf(e)));
  return ck >= 0 ? ck : 0;
}

// 加载并应用一个 animpack 到当前换装角色。
// silent=true 不弹 toast；staticPose=true 加载后静止在第 0 帧、不自动播放（默认站姿用，
// 避免移动类动画自动播放呈飞奔/腾空怪姿；背饰仍靠该骨架归位）。
async function loadAnimation(entry, index, silent, staticPose) {
  const myAnimToken = ++animLoadToken;
  try {
    const raw = await extractEntry(apkFile, entry);
    // 解析期间用户又切了动画，丢弃这次过期结果，避免旧动画覆盖新选择
    if (myAnimToken !== animLoadToken) return;
    const ap = parseAnimPack(raw);
    const dec = decodeAnimation(ap);
    animState.pack = ap;
    animState.decoded = dec;
    animState.curIndex = (index != null) ? index : (animState.entries ? animState.entries.indexOf(entry) : -1);
    animState.frameCount = (dec && dec.hasAnimation) ? dec.frameCount : 1;
    animState.name = entry.name.substring(entry.name.lastIndexOf('/') + 1).replace(/\.animpack$/i, '');
    animState.time = 0;
    // 为每个蒙皮部件建立骨骼映射，并统计骨名命中率。
    // 命中率过低说明选了不兼容骨架的动画（如 NPC 动画套到 CharSkyKid），
    // 套用会把顶点拉飞变形——此时放弃套用、保持原姿势并提示。
    let mapped = 0, totalBones = 0;
    const newMaps = [];
    for (const part of animState.skinnedParts) {
      const m = buildBoneMapping(part.skeletonBones, ap);
      newMaps.push(m);
      for (let k = 0; k < m.length; k++) { totalBones++; if (m[k] >= 0) mapped++; }
    }
    const hitRate = totalBones ? mapped / totalBones : 0;
    // Partial name matches are unsafe for skinning: a mismatched animation
    // can still reach 50% while sending the remaining vertices far away.
    // Require near-complete compatibility before applying any matrices.
    if (animState.skinnedParts.length && hitRate < 0.9) {
      animState.pack = null; animState.decoded = null;
      animState.curIndex = -1; animState.playing = false;
      updateAnimUI();
      if (!silent) toast(`该动画骨架与当前角色不匹配（命中 ${Math.round(hitRate*100)}%），已跳过`, true);
      return;
    }
    for (let pi = 0; pi < animState.skinnedParts.length; pi++) {
      animState.skinnedParts[pi].boneToAnim = newMaps[pi];
    }
    applyAnimFrame(0);
    animState.playing = staticPose ? false : (animState.frameCount > 1);
    updateAnimUI();
    if (!silent) toast(`动画：${animState.name}（${ap.boneCount} 骨 / ${animState.frameCount} 帧）`);
  } catch (e) {
    console.error('动画加载失败', e);
    if (!silent) toast('动画加载失败：' + (e.message || e), true);
  }
}
// 停止动画、回到绑定姿势
function clearAnimation() {
  animState.pack = null; animState.decoded = null;
  animState.curIndex = -1;
  animState.frameCount = 0; animState.time = 0; animState.playing = false;
  // 重置各部件骨矩阵为单位阵（回 T-pose）
  for (const part of animState.skinnedParts) {
    const data = part.mat.userData.boneData;
    const btex = part.mat.userData.boneTex;
    if (!data) continue;
    const boneN = part.mat.userData.boneCount || 0;
    for (let i = 0; i < boneN; i++) writeBoneIdentity(data, i);
    if (btex) btex.needsUpdate = true;
  }
}
// 组合加载：把当前 dressSelection 的所有部件渲染成一个 group
async function loadDressCharacter() {
  const myToken = ++loadToken;
  clearScene();
  dressGroup = new THREE.Group();
  // 导入装扮的体型近似（body.scale=横向比例、body.height=高矮）。
  // height 按每单位 5% 估、scale 按比例分数直用；在组成部件前设置，包围盒/取景自动含缩放。
  if (typeof activeCaptureIdx === 'number' && activeCaptureIdx >= 0 && importedCaptures[activeCaptureIdx]) {
    const b = importedCaptures[activeCaptureIdx].body || {};
    const sxz = Math.min(1.25, Math.max(0.8, 1 + (b.scale || 0)));
    const sy = Math.min(1.25, Math.max(0.8, 1 + (b.height || 0) * 0.05));
    dressGroup.scale.set(sxz, sy, sxz);
  }
  let loaded = 0, total = 0;
  const box = new THREE.Box3();
  const skinned = [];
  for (const slot of DRESS_SLOTS) {
    const sel = dressSelection[slot.key];
    if (!sel || !sel.mesh || sel.mesh === 'Outfit_None') continue;
    total++;
    const entry = findMeshEntryByName(sel.mesh);
    if (!entry) continue;
    try {
      const raw = await extractEntry(apkFile, entry);
      const data = readMesh(raw, entry.name);
      if (!data.vertices.length) continue;
      const geo = buildGeometry(data);
      // 有骨骼权重 + 内嵌骨架的部件走 GPU 蒙皮（道具若自带骨架，播放动画时会自行挂到背后）
      const canSkin = !!(data.boneIndices && data.skeletonBones && data.skeletonBones.length);
      // 导入装扮的染色：数字/命名 dye 经 DyeColorDefs 转 HSV，覆盖 def 默认染色
      const defForMat = sel.hsvOverride ? Object.assign({}, sel.def, { base_hsv: sel.hsvOverride }) : sel.def;
      const mat = await buildPartMaterial(defForMat, canSkin, canSkin ? data.skeletonBones.length : 0);
      if (myToken !== loadToken) { geo.dispose(); if (mat && mat.dispose) mat.dispose(); return; }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = slot.key;
      // Keep the embedded bind-pose skeleton available to the GLB exporter.
      // Preview rendering uses a custom bone texture, while glTF needs the
      // original bone records to emit a standard skin.
      if (data.skeletonBones) mesh.userData.skeletonBones = data.skeletonBones;
      mesh.frustumCulled = false; // 蒙皮后包围盒会变，关闭裁剪避免误剔除
      dressGroup.add(mesh);
      if (canSkin) skinned.push({ mesh, geo, mat, skeletonBones: data.skeletonBones, boneToAnim: null });
      loaded++;
    } catch (e) { console.error('部件加载失败', slot.key, e); }
  }
  if (myToken !== loadToken) { disposeObject3D(dressGroup); dressGroup = null; return; }
  // dressGroup.scale 是导入装扮的体型近似；必须更新完子节点矩阵后再取包围盒，
  // 否则 expandByObject 读取到尚未刷新的父矩阵，取景会忽略缩放。
  dressGroup.updateMatrixWorld(true);
  box.setFromObject(dressGroup);
  scene.add(dressGroup);
  currentMesh = dressGroup; currentData = null;
  curBox = box.isEmpty() ? new THREE.Box3(new THREE.Vector3(-1,-1,-1), new THREE.Vector3(1,1,1)) : box;
  animState.skinnedParts = skinned;
  // 若已有动画在播，换装后重建骨骼映射并继续。
  // 帧号必须与 animate() 循环一致做 % frameCount 取模，否则超范围会被钳到最后一帧，
  // 导致新换部件停在末帧、与其它部件当前帧错位（现象：换装后面具等挂点偏移）。
  if (animState.pack) {
    for (const part of skinned) part.boneToAnim = buildBoneMapping(part.skeletonBones, animState.pack);
    const fc = animState.frameCount || 1;
    const frameIdx = Math.floor(animState.time * animState.fps) % fc;
    applyAnimFrame(frameIdx);
  }
  setView('reset');
  hintEl.style.display = 'none';
  toast(`已组合 ${loaded}/${total} 个部件`);
  // 默认摆站姿：还没加载过任何动画时，自动套用第一个站姿（用户仍可在下拉里换）。
  // 道具挂点也依赖动画骨架，套站姿后背饰才会到背后。
  if (!animState.pack && skinned.length) {
    const idx = pickDefaultIdleAnim();
    if (idx >= 0) { await loadAnimation(animState.entries[idx], idx, true, true); }
  }
  updateAnimUI();
}

// 统一释放场景中动态对象的几何/材质，避免切换模型/换装/地图时显存泄漏。
// 注意：共享材质（matCache）在 dispose 后需失效缓存，故地图重建时会重置 matCache。
function disposeObject3D(obj) {
  if (!obj) return;
  obj.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && m.dispose) m.dispose();
    }
  });
}

function clearScene() {
  if (currentMesh) { scene.remove(currentMesh); disposeObject3D(currentMesh); currentMesh = null; }
  if (dressGroup) { scene.remove(dressGroup); disposeObject3D(dressGroup); dressGroup = null; }
  if (mapGroup) { scene.remove(mapGroup); disposeObject3D(mapGroup); mapGroup = null; }
  mapMarkerSprites = []; // 释放旧地图标记引用
  mapEvents = null; // 释放旧地图事件
  mapInfo = null; // 释放旧地图信息清单
  { const ep = $('eventPanel'), eb = $('eventBtn'); if (ep) ep.style.display = 'none'; if (eb) eb.style.display = 'none'; }
  { const ip = $('infoPanel'), ib = $('infoPanelBtn'); if (ip) ip.style.display = 'none'; if (ib) ib.style.display = 'none'; }
  if (markerTip) markerTip.style.display = 'none';
  waterMats.length = 0; // 释放旧水面材质的每帧更新引用
  animState.skinnedParts = []; // 释放蒙皮部件引用（材质随 dressGroup dispose）
  currentData = null;
  curBox = null;
}

