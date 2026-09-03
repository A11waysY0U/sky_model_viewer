/* ===== tgcl.js ===== */
// SkyMeshViewer.tgcl.js
// TGCL (Objects.level.bin) 解析器 —— 移植自 TGCL编辑器.html 的内核，逐字节结构化解析。
// 提取关卡里的 LevelMesh 物件实例：resourceName + 64字节 transform（basis+位置）。

function TGCL(input) {
  this.raw = input instanceof Uint8Array ? input : new Uint8Array(input);
  this.dv = new DataView(this.raw.buffer, this.raw.byteOffset, this.raw.byteLength);
  this._tf = {};
  this._parse();
}
TGCL.prototype.u32 = function (o) { return this.dv.getUint32(o, true); };
TGCL.prototype._nameAt = function (off) {
  var p = this.pool, e = off; if (off < 0 || off >= p.length) return '';
  while (e < p.length && p[e] !== 0) e++;
  var s = ''; for (var i = off; i < e; i++) s += String.fromCharCode(p[i]); return s;
};
TGCL.prototype._parse = function () {
  var d = this.raw;
  if (!(d[0] === 0x54 && d[1] === 0x47 && d[2] === 0x43 && d[3] === 0x4C)) throw new Error('不是 TGCL 文件');
  this.ver = this.u32(4);
  this.header = []; for (var i = 0; i < 11; i++) this.header.push(this.u32(8 + i * 4));
  var o = 52, run = 0; this.types = [];
  while (true) { var fc = this.u32(o), th = this.u32(o + 4), cum = this.u32(o + 8); if (cum !== run + fc) break; run += fc; this.types.push([fc, th, cum]); o += 12; }
  var gap = this.u32(o); this.types.push([gap, 0, run + gap]);
  this.fieldRecOff = this.header[5]; this.nameOff = this.header[6]; this.dataOff = this.header[7];
  var REC = this.fieldRecOff, nrec = ((this.nameOff - REC) / 16) | 0; this.fieldrecs = [];
  for (i = 0; i < nrec; i++) { var b = REC + i * 16; this.fieldrecs.push([this.u32(b), this.u32(b + 4), this.u32(b + 8), this.u32(b + 12)]); }
  this.pool = d.subarray(this.nameOff, this.dataOff);
  this.typeNames = [];
  for (i = 0; i < this.types.length; i++) this.typeNames.push(i === 0 ? 'Transform' : this._nameAt(this.types[i - 1][1]));
  this.nodes = []; var p = this.dataOff;
  while (p < d.length) { var r = this._readNode(p); this.nodes.push(r.node); p = r.o; }
  // 无损校验：解析终点必须精确等于文件末尾，否则某个字段类型/大小解错了
  this.parseEnd = p;
  this.eofOk = (p === d.length);
};
TGCL.prototype.typeFields = function (ti) {
  if (this._tf[ti]) return this._tf[ti];
  var prev = ti > 0 ? this.types[ti - 1][2] : 0, end = this.types[ti][2], r = [];
  for (var j = prev; j < end; j++) { var fr = this.fieldrecs[j]; r.push({ name: this._nameAt(fr[1]), sub: fr[0], sz: fr[2], col3: fr[3] }); }
  this._tf[ti] = r; return r;
};
TGCL.prototype._readRecord = function (o, ti) {
  var d = this.raw, vals = [], fields = this.typeFields(ti), k, cnt, elems;
  for (var fi = 0; fi < fields.length; fi++) {
    var f = fields[fi];
    if (f.sub === 0) { vals.push({ kind: 'pod', name: f.name, sz: f.sz, bytes: d.slice(o, o + f.sz) }); o += f.sz; }
    else if (f.sub === 1) { var e = o; while (e < d.length && d[e] !== 0) e++; var s = ''; for (var i = o; i < e; i++) s += String.fromCharCode(d[i]); vals.push({ kind: 'str', name: f.name, value: s }); o = e + 1; }
    else if (f.sub === 2) { vals.push({ kind: 'clump', name: f.name, value: this.u32(o) }); o += 4; }
    else if (f.sub === 3) {
      cnt = this.u32(o); o += 4; elems = [];
      if (f.col3 === 0xFFFFFFFF) { for (k = 0; k < cnt; k++) { elems.push(this.u32(o)); o += 4; } }
      else { for (k = 0; k < cnt; k++) { var rr = this._readRecord(o, f.col3); elems.push(rr.vals); o = rr.o; } }
      vals.push({ kind: 'arr', name: f.name, elemType: f.col3, elems: elems });
    } else throw new Error('未知子类型 sub=' + f.sub);
  }
  return { vals: vals, o: o };
};
TGCL.prototype._readNode = function (o) {
  var d = this.raw, tid = this.u32(o); o += 4;
  var e = o; while (e < d.length && d[e] !== 0) e++;
  var name = ''; for (var i = o; i < e; i++) name += String.fromCharCode(d[i]); o = e + 1;
  var r = this._readRecord(o, tid); return { node: { type: tid, name: name, fields: r.vals }, o: r.o };
};

// 从节点提取 transform：64字节 = 4×4 float。三基轴用 4-float 跨步(offset 0/16/32)，位置在 48/52/56。
function nodeTransform(nd) {
  for (var i = 0; i < nd.fields.length; i++) {
    var f = nd.fields[i];
    if (f.kind === 'pod' && f.name === 'transform' && f.sz === 64) {
      var dv = new DataView(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength);
      var m = new Array(16);
      for (var k = 0; k < 16; k++) m[k] = dv.getFloat32(k * 4, true);
      return m;
    }
  }
  return null;
}

function nodeField(nd, name) {
  for (var i = 0; i < nd.fields.length; i++) if (nd.fields[i].name === name) return nd.fields[i];
  return null;
}

// 从 shaderParams 数组里取某个 uniform 的 texValue（如 u_diffuse1Tex / u_normTex）
function shaderTex(nd, uniform) {
  var sp = nodeField(nd, 'shaderParams');
  if (!sp || sp.kind !== 'arr') return '';
  for (var i = 0; i < sp.elems.length; i++) {
    var e = sp.elems[i];
    if (!Array.isArray(e)) continue;
    var un = null, tv = null;
    for (var j = 0; j < e.length; j++) {
      if (e[j].name === 'uniformName') un = e[j].value;
      else if (e[j].name === 'texValue') tv = e[j].value;
    }
    if (un === uniform && tv) return tv;
  }
  return '';
}
// 从 shaderParams 取某个 uniform 的 vecValue（如 u_diffuse2TexOffset / u_diffuse1TexScale）。
// 返回 [x,y,z,w]；取不到返回 null。用于第二层色的平铺缩放与偏移，避免贴歪。
function shaderVec(nd, uniform) {
  var sp = nodeField(nd, 'shaderParams');
  if (!sp || sp.kind !== 'arr') return null;
  for (var i = 0; i < sp.elems.length; i++) {
    var e = sp.elems[i];
    if (!Array.isArray(e)) continue;
    var un = null, vv = null;
    for (var j = 0; j < e.length; j++) {
      if (e[j].name === 'uniformName') un = e[j].value;
      else if (e[j].name === 'vecValue' && e[j].kind === 'pod' && e[j].bytes && e[j].bytes.length >= 16) {
        var dv = new DataView(e[j].bytes.buffer, e[j].bytes.byteOffset, e[j].bytes.byteLength);
        vv = [dv.getFloat32(0, true), dv.getFloat32(4, true), dv.getFloat32(8, true), dv.getFloat32(12, true)];
      }
    }
    if (un === uniform && vv) return vv;
  }
  return null;
}

// 从节点取 mesh 资源名：优先 resourceName，回退 mesh / meshName（不同放置类型字段名不同）
function nodeResourceName(nd) {
  const keys = ['resourceName', 'mesh', 'meshName'];
  for (const k of keys) {
    const f = nodeField(nd, k);
    if (f && f.kind === 'str' && f.value) return f.value;
  }
  return '';
}
// 取 pod 字段的 u32 值（如 materialBstGuid）
function nodePodU32(nd, name) {
  const f = nodeField(nd, name);
  if (!f || f.kind !== 'pod' || !f.bytes || f.bytes.length < 4) return 0;
  const dv = new DataView(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength);
  return dv.getUint32(0, true);
}
// 取 pod 字段的 vec4（如 baseColor / u_diffuseColor 的 16B）
function nodePodVec4(nd, name) {
  const f = nodeField(nd, name);
  if (!f || f.kind !== 'pod' || !f.bytes || f.bytes.length < 16) return null;
  const dv = new DataView(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength);
  return [dv.getFloat32(0, true), dv.getFloat32(4, true), dv.getFloat32(8, true), dv.getFloat32(12, true)];
}
// 取 pod 布尔字段（1 字节）；字段不存在时返回默认值
function nodePodBool(nd, name, dflt) {
  const f = nodeField(nd, name);
  if (!f || f.kind !== 'pod' || !f.bytes || !f.bytes.length) return dflt;
  return f.bytes[0] !== 0;
}
// 从 LevelMaterial 的 shaderParams 取贴图/向量。注意：材质球的元素字段名是 name/tex/vec
// （与 LevelMesh 实例的 uniformName/texValue/vecValue 不同），需单独处理。
function matParamTex(nd, uniform) {
  const sp = nodeField(nd, 'shaderParams');
  if (!sp || sp.kind !== 'arr') return '';
  for (const e of sp.elems) {
    if (!Array.isArray(e)) continue;
    let un = null, tv = null;
    for (const s of e) { if (s.name === 'name') un = s.value; else if (s.name === 'tex') tv = s.value; }
    if (un === uniform && tv) return tv;
  }
  return '';
}
function matParamVec(nd, uniform) {
  const sp = nodeField(nd, 'shaderParams');
  if (!sp || sp.kind !== 'arr') return null;
  for (const e of sp.elems) {
    if (!Array.isArray(e)) continue;
    let un = null, vv = null;
    for (const s of e) {
      if (s.name === 'name') un = s.value;
      else if (s.name === 'vec' && s.kind === 'pod' && s.bytes && s.bytes.length >= 16) {
        const dv = new DataView(s.bytes.buffer, s.bytes.byteOffset, s.bytes.byteLength);
        vv = [dv.getFloat32(0, true), dv.getFloat32(4, true), dv.getFloat32(8, true), dv.getFloat32(12, true)];
      }
    }
    if (un === uniform && vv) return vv;
  }
  return null;
}
// 建立 LevelMaterial 材质球索引：bstGuid(u32) -> 材质。大量场景主体（Beamo 类型，全库 2.2 万+）
// 的贴图/颜色不在自身，而在 materialBstGuid 引用的 LevelMaterial 节点里（如 "Simple Stone"→StoneBase）。
// 不建此索引这些物件全是白模。
function buildLevelMaterialIndex(t) {
  const idx = new Map();
  for (const nd of t.nodes) {
    if ((t.typeNames[nd.type] || '') !== 'LevelMaterial') continue;
    const guid = nodePodU32(nd, 'bstGuid');
    if (!guid) continue;
    idx.set(guid, {
      shaderName: (nodeField(nd, 'shaderName') || {}).value || '',
      diffuse1Tex: matParamTex(nd, 'u_diffuse1Tex') || matParamTex(nd, 'u_diffuseTex'),
      diffuse2Tex: matParamTex(nd, 'u_diffuse2Tex'),
      normTex: matParamTex(nd, 'u_normTex'),
      lightTex: matParamTex(nd, 'u_lightTex'),
      diffuse2Offset: matParamVec(nd, 'u_diffuse2TexOffset'),
      baseColor: nodePodVec4(nd, 'baseColor'),
    });
  }
  return idx;
}

// 提取关卡里**所有**带 mesh 引用 + 64 字节 transform 的节点实例（不再只认 LevelMesh）。
// 原来只提取 LevelMesh，漏掉了其它引用 mesh 的放置类型（各种 Placeable/装饰/道具等），
// 导致"地图里有、却没加载"。改为通用扫描：任意类型只要有 resourceName(或 mesh/meshName)+transform 就纳入；
// 找不到对应 mesh 条目的节点会在渲染侧 findMeshEntryByName 处自动跳过，不会误渲染非网格资源。
// 返回：{ name, resourceName, shaderName, diffuseTex, matrix(16 floats 行主序), typeName }
function extractLevelMeshes(arrayBuffer) {
  const t = new TGCL(new Uint8Array(arrayBuffer));
  const out = [];
  const seen = new Set(); // 去重：同名节点只取一次
  // 材质球索引：Beamo 等类型的贴图/颜色靠 materialBstGuid 引用 LevelMaterial 节点
  const matIndex = buildLevelMaterialIndex(t);
  for (const nd of t.nodes) {
    const resName = nodeResourceName(nd);
    if (!resName) continue;
    const rawTf = nodeTransform(nd);
    if (!rawTf) continue; // 必须有 64 字节变换矩阵才能摆放
    // 去重键：资源名 + 变换（避免同一实例被多个字段重复计入）
    const key = resName + '|' + rawTf.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const shF = nodeField(nd, 'shaderName');
    // 真实漫反射贴图在 shaderParams：多数物件用 u_diffuse1Tex；
    // 角色类 shader（CreatureSl/ChamAlpha 等，如 CineChar 过场角色）用 u_diffuseTex，
    // 故依次回退，避免这些角色因键名不同而取不到贴图变白模。
    let diffuseTex = shaderTex(nd, 'u_diffuse1Tex') || shaderTex(nd, 'u_diffuseTex');
    // 法线贴图（切线空间）：真实 MeshSh 用它与主漫反射共用 uv0（各自 scale 不同），
    // 给低模加回表面凹凸/雕刻细节。不依赖运行时数据，可离线复现。
    let normTex = shaderTex(nd, 'u_normTex');
    // 第二层色（u_diffuse2Tex，用 uv3）：与 diffuse1 相乘得到反照率——门/石头的真实颜色来自这层。
    // 光照/AO 图（u_lightTex，用 uv1）：烘焙好的明暗/环境遮蔽——门"中间那光影"就是它。
    // 这两张都是离线静态数据（贴图+mesh uv 都在包内），可复现，无需运行时光照探针。
    let diffuse2Tex = shaderTex(nd, 'u_diffuse2Tex');
    let lightTex = shaderTex(nd, 'u_lightTex');
    // 第二层色的平铺缩放/偏移（uv3 变换）：diffuse1TexScale 也顺带取，供主层平铺
    let diffuse2Offset = shaderVec(nd, 'u_diffuse2TexOffset');
    const diffuse1Scale = shaderVec(nd, 'u_diffuse1TexScale');
    let shaderName = shF && shF.value || '';
    // 纯色着色器（UnlitAlphaColor/LitAlphaColor/LitAlpha 等）：颜色写在 u_diffuseColor（归一化 RGBA），
    // 不靠贴图。取出后走纯色/自发光分支上色（如活动关的彩色 Cube、闪电等）。
    const diffuseColor = shaderVec(nd, 'u_diffuseColor');
    // Beamo 等类型：贴图/颜色不在自身，而在 materialBstGuid 引用的 LevelMaterial。
    // 这是全库最大的白模来源（2.2 万+ Beamo，844 个材质带贴图）。自身取不到时回退查材质球。
    let matBaseColor = null;
    if (!diffuseTex) {
      const mg = nodePodU32(nd, 'materialBstGuid');
      if (mg && matIndex.has(mg)) {
        const lm = matIndex.get(mg);
        if (lm.diffuse1Tex) diffuseTex = lm.diffuse1Tex;
        if (!normTex && lm.normTex) normTex = lm.normTex;
        if (!diffuse2Tex && lm.diffuse2Tex) diffuse2Tex = lm.diffuse2Tex;
        if (!lightTex && lm.lightTex) lightTex = lm.lightTex;
        if (!diffuse2Offset && lm.diffuse2Offset) diffuse2Offset = lm.diffuse2Offset;
        if (!shaderName && lm.shaderName) shaderName = lm.shaderName;
        matBaseColor = lm.baseColor; // 材质球底色（无贴图时用作纯色）
      }
    }
    // transform 为列主序仿射（列向量），与游戏 MeshRenderer 一致：
    //   列0=X基轴(b0,b1,b2) 列1=Y基轴(b4,b5,b6) 列2=Z基轴(b8,b9,b10) 平移(b12,b13,b14)
    // THREE.Matrix4.set() 入参是行主序，故按行重排（行i = 各列的第i分量）。
    const b = rawTf;
    const m = [
      b[0], b[4], b[8], b[12],
      b[1], b[5], b[9], b[13],
      b[2], b[6], b[10], b[14],
      0, 0, 0, 1,
    ];
    out.push({ name: nd.name, resourceName: resName, shaderName: shaderName, diffuseTex: diffuseTex, normTex: normTex, diffuse2Tex: diffuse2Tex, lightTex: lightTex, diffuse2Offset: diffuse2Offset, diffuse1Scale: diffuse1Scale, diffuseColor: diffuseColor, matBaseColor: matBaseColor, matrix: m, typeName: t.typeNames[nd.type] || '' });
  }
  return out;
}

// 提取关卡里的 Portal 节点（关卡门中间那层发光的传送画面）。它们无 mesh，靠自身 transform
// 定义门洞发光面的位置/尺寸/朝向，用 `texture`(默认 Portal) 作自发光贴图，`customColor` 染色、
// `textureBrightness` 调亮度、flipX/Y 翻转 UV。enabled=0 只是"未触发"初始态，游戏里正常可见，故一律显示。
// 单位 quad 在 XY 平面（±0.5），套 transform 后即门洞平面（列0=宽、列1=高、列2=法线厚度）。
function extractLevelPortals(arrayBuffer) {
  const t = new TGCL(new Uint8Array(arrayBuffer));
  const out = [];
  for (const nd of t.nodes) {
    if ((t.typeNames[nd.type] || '') !== 'Portal') continue;
    const rawTf = nodeTransform(nd);
    if (!rawTf) continue;
    const texF = nodeField(nd, 'texture');
    let tex = (texF && texF.kind === 'str' && texF.value) ? texF.value : 'Portal';
    const col = nodePodVec4(nd, 'customColor') || [1, 1, 1, 1];
    const brF = nodeField(nd, 'textureBrightness');
    let bright = 1.0;
    if (brF && brF.kind === 'pod' && brF.bytes && brF.bytes.length >= 4) {
      bright = new DataView(brF.bytes.buffer, brF.bytes.byteOffset, brF.bytes.byteLength).getFloat32(0, true);
    }
    const flipX = nodePodBool(nd, 'flipX', false);
    const flipY = nodePodBool(nd, 'flipY', false);
    // portalType = 着色器里的 u_portalIndex：Portal 贴图是 3×3 图集，此值选取门显示的那一格
    // （PortalGeo.vert 实测：idx=portalType/3，列=fract(idx)、行=floor(idx)，格内留 15% 边距）。
    const portalType = nodePodU32(nd, 'portalType') || 0;
    const b = rawTf;
    // 过滤非门画面 Portal：门洞发光面宽/高通常 1~10 米。少数 Portal（如 PortalAP、高空穹顶类）
    // 尺寸达数百米、悬在高空，不是门中间那层传送画面，渲染出来是一大片糊图，跳过。
    const wPortal = Math.hypot(b[0], b[1], b[2]);   // 列0 长度 = 宽
    const hPortal = Math.hypot(b[4], b[5], b[6]);   // 列1 长度 = 高
    if (wPortal > 30 || hPortal > 30) continue;
    const m = [
      b[0], b[4], b[8], b[12],
      b[1], b[5], b[9], b[13],
      b[2], b[6], b[10], b[14],
      0, 0, 0, 1,
    ];
    out.push({ name: nd.name, texture: tex, color: [col[0], col[1], col[2]], brightness: (isFinite(bright) && bright > 0) ? bright : 1.0, flipX: flipX, flipY: flipY, portalType: portalType, matrix: m });
  }
  return out;
}

// 收集物/点位标记类型（移植自 TGCL编辑器.html 的 COLL_DEFS）：这些节点无 mesh 网格，
// 只有一个位置（transform 的平移分量或 pos 字段），在地图里用点位标记显示。
// 点位标记：统一用立体感菱形（宝石切面明暗），每类型一个颜色区分。恒定屏幕大小、小巧。
const LEVEL_MARKER_DEFS = [
  { name: 'CandleObject', label: '烛火', color: '#ff9a3c' },
  { name: 'WingBuff', label: '光翼', color: '#5fd3ff' },
  { name: 'Pickup', label: '拾取物', color: '#ffd54a' },
  { name: 'PickupEmitter', label: '蜡堆', color: '#ffb74a' },
  { name: 'MeditationArea', label: '冥想点', color: '#b98cff' },
  { name: 'Portal', label: '传送门', color: '#00e0c0' },
  { name: 'Checkpoint', label: '存档点', color: '#7dff8a' },
  { name: 'ConstellationMarker', label: '星座点', color: '#ffe680' },
  { name: 'MapShrine', label: '地图石', color: '#c0c8d0' },
  { name: 'Npc', label: 'NPC', color: '#ff8fd0' },
  { name: 'LevelLink', label: '关卡门', color: '#a0b4ff' },
  // 以下为带坐标、无网格的可命名点位（实测 Dawn 关卡确认有坐标）。节点名多为 BstNode_数字，故按类型名显示。
  { name: 'StarFragment', label: '星之碎片', color: '#ffe680' },
  { name: 'Collectible', label: '收集品', color: '#ffd54a' },
  { name: 'Flame', label: '火焰', color: '#ff7a3c' },
  { name: 'SoundEmitter', label: '音效点', color: '#9ad0ff' },
  { name: 'DisplayText', label: '显示文字', color: '#d0d8e0' },
  { name: 'PointLight', label: '点光源', color: '#ffef9e' },
  { name: 'ConstellationGate', label: '星座门', color: '#c8a8ff' },
  { name: 'StreamingCrystal', label: '回忆水晶', color: '#8ad0ff' },
];
// 任务点：类型名含 Quest 的各种 Prefab（回忆/寻宝/收集/世界任务等），统一归为一类。
const QUEST_TYPE_RE = /Quest/i;
const QUEST_MARKER_COLOR = '#7dffc4';

// 读节点某字符串字段（空返回 ''）
function nodeStr(nd, name) {
  const f = nodeField(nd, name);
  return f && f.kind === 'str' && f.value ? f.value : '';
}
// 某些标记类型可提取"看得懂的详情"，点击 tooltip 追加显示。返回 ['标签: 值', ...]。
// 只收非空值，保持精简。
const MARKER_DETAIL_EXTRACTORS = {
  Npc(nd) {
    const rows = [];
    const nick = nodeStr(nd, 'nickname'); if (nick) rows.push('昵称: ' + nick);
    const def = nodeStr(nd, 'defName'); if (def) rows.push('角色: ' + def);
    const body = nodeStr(nd, 'body'); if (body) rows.push('身体: ' + body);
    const hair = nodeStr(nd, 'hair'); if (hair) rows.push('头发: ' + hair);
    const mask = nodeStr(nd, 'mask'); if (mask) rows.push('面具: ' + mask);
    const packs = ['animPack', 'animPack2', 'animPack3', 'animPack4'].map(k => nodeStr(nd, k)).filter(Boolean);
    if (packs.length) rows.push('动画包: ' + packs.join(' / '));
    return rows;
  },
  StreamingCrystal(nd) {
    const rows = [];
    const sub = nodeStr(nd, 'subtitle'); if (sub) rows.push('字幕: ' + sub);
    const msg = nodeStr(nd, 'textMessage'); if (msg) rows.push('文本: ' + msg);
    return rows;
  },
  Collectible(nd) {
    const rows = [];
    const nm = nodeStr(nd, 'name'); if (nm) rows.push('名称: ' + nm);
    const ty = nodeStr(nd, 'type'); if (ty) rows.push('类型: ' + ty);
    return rows;
  },
  DisplayText(nd) {
    const rows = [];
    const txt = nodeStr(nd, 'text'); if (txt) rows.push('文本ID: ' + txt);
    return rows;
  },
  SoundEmitter(nd) {
    const rows = [];
    const snd = nodeStr(nd, 'soundName'); if (snd) rows.push('音效: ' + snd);
    return rows;
  },
  MeditationArea(nd) {
    const rows = [];
    const h = nodeStr(nd, 'confirmHintText'); if (h) rows.push('提示: ' + h);
    return rows;
  },
  MapShrine(nd) {
    const rows = [];
    const id = nodeStr(nd, 'landmarkId'); if (id && id !== 'null') rows.push('地标: ' + id);
    return rows;
  },
  Portal(nd) {
    const rows = [];
    const tx = nodeStr(nd, 'texture'); if (tx) rows.push('贴图: ' + tx);
    return rows;
  },
  LevelLink(nd) {
    const rows = [];
    const ln = nodeStr(nd, 'linkName'); if (ln) rows.push('连接: ' + ln);
    const lv = nodeStr(nd, 'levelName'); if (lv) rows.push('通向: ' + lv);
    return rows;
  },
};
// 从节点取位置：优先 64 字节 transform 的平移分量(offset 48/52/56)，
// 回退到多种位置字段名(pos/position/worldPos/spawnPos/origin/point/location) 的前 3 个 float。
const MARKER_POS_FIELDS = ['pos', 'position', 'worldPos', 'worldPosition', 'spawnPos', 'origin', 'point', 'location', 'center', 'target', 'targetPos'];
function nodeMarkerPos(nd) {
  for (const f of nd.fields) {
    if (f.kind === 'pod' && f.name === 'transform' && f.sz >= 64) {
      const dv = new DataView(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength);
      return [dv.getFloat32(48, true), dv.getFloat32(52, true), dv.getFloat32(56, true)];
    }
  }
  for (const key of MARKER_POS_FIELDS) {
    for (const f of nd.fields) {
      if (f.kind === 'pod' && f.name === key && f.sz >= 12) {
        const dv = new DataView(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength);
        return [dv.getFloat32(0, true), dv.getFloat32(4, true), dv.getFloat32(8, true)];
      }
    }
  }
  return null;
}
// 提取关卡里所有收集物/点位标记 + 带坐标的任务点。
// 返回按类型分组：{ key(类型名), label, color, points:[{pos:[x,y,z], name}] }。
// 注：关卡节点名多为自动生成的 BstNode_数字（无可读名），故 point.name 记为「类型中文标签」，tooltip 按类型显示。
function extractLevelMarkers(arrayBuffer) {
  let t;
  try { t = new TGCL(new Uint8Array(arrayBuffer)); } catch (e) { return []; }
  const groups = [];
  const knownTids = new Set();
  // 1) 固定的收集物/点位类型
  for (const def of LEVEL_MARKER_DEFS) {
    const tid = t.typeNames.indexOf(def.name);
    if (tid < 0) continue;
    knownTids.add(tid);
    const detailFn = MARKER_DETAIL_EXTRACTORS[def.name];
    const points = [];
    for (const nd of t.nodes) {
      if (nd.type !== tid) continue;
      const p = nodeMarkerPos(nd);
      if (p && (p[0] || p[1] || p[2])) {
        const pt = { pos: p, name: def.label };
        if (detailFn) { const d = detailFn(nd); if (d && d.length) pt.detail = d; }
        points.push(pt);
      }
    }
    if (points.length) groups.push({ key: def.name, label: def.label, color: def.color, points });
  }
  // 2) 任务点：类型名含 Quest（回忆/寻宝/收集/世界任务等 Prefab），且带非零坐标者，统一归为「任务点」。
  const questPoints = [];
  for (const nd of t.nodes) {
    if (knownTids.has(nd.type)) continue;
    const typeName = t.typeNames[nd.type] || '';
    if (!QUEST_TYPE_RE.test(typeName)) continue;
    const p = nodeMarkerPos(nd);
    if (!p || (!p[0] && !p[1] && !p[2])) continue;
    questPoints.push({ pos: p, name: `任务点·${typeName}` });
  }
  if (questPoints.length) groups.push({ key: 'Quest', label: '任务点', color: QUEST_MARKER_COLOR, points: questPoints });
  return groups;
}

// 事件/触发器类型名 → 中文（常见项；未列出的显示原类型名）。
const EVENT_TYPE_CN = {
  FireTriggerAtRandom: '随机触发', ScheduledEvent: '计划事件', TriggerLevelLink: '触发关卡门',
  TempleEvent: '庙会事件', EventSeries: '事件系列', SetGlobalEventParameter: '设置全局参数',
  BehaviorTreeEvent: '行为树事件', BehaviorEvent: '行为事件', SendAnalyticsEvent: '埋点上报',
  OnEventSeries: '事件系列触发', ScheduledEventTrigger: '计划事件触发器', BeaconEvent: '信标事件',
  ThorNodeTrigger: '雷神节点触发', DissolveEvent: '溶解事件', DisableVisibilityEvent: '禁用可见性',
  TriggerTeleportBeacon: '触发传送信标', TriggerToyEvent: '触发玩具事件', StormEventSpawner: '暴风生成器',
};
// 事件常见字符串字段里，哪个作为"事件名"展示（按优先级）
const EVENT_NAME_FIELDS = ['name', 'eventName', 'analyticsEventName', 'param', 'behaviorTree'];
// 引用字段（clump 标量或 u32 数组）里，哪些是"触发下游"语义（用于展示链路）
const EVENT_OUT_FIELDS = ['events', 'onActive', 'onInactive', 'onFinish', 'onClose', 'onTap',
  'afterfireOneAtRandomEvents', 'shoutMarkers', 'beamMeshes', 'levelLink', 'effects', 'series', 'outTarget'];
// 可读参数字段 → { label(中文), type }。type: bool=布尔(秒/次开关)，sec=秒，num=数值，pct=百分比，str=字符串。
// 这些是"人能看懂"的事件行为参数：延迟多久、触发几次、是否重复、倒计时、激活百分比、行为树、埋点等。
const EVENT_PROP_DEFS = {
  delayMin: { label: '最小延迟', type: 'sec' }, delayMax: { label: '最大延迟', type: 'sec' },
  delayInSeconds: { label: '延迟', type: 'sec' }, countdownTime: { label: '倒计时', type: 'sec' },
  secondsActive: { label: '持续', type: 'sec' }, resetTime: { label: '重置时间', type: 'sec' },
  fireOnce: { label: '只触发一次', type: 'bool' }, fireRepeatedly: { label: '重复触发', type: 'bool' },
  fireOneAtRandom: { label: '随机触发其一', type: 'bool' }, avoidRepeats: { label: '避免重复', type: 'bool' },
  keepFiring: { label: '持续触发', type: 'bool' }, useResetTimer: { label: '用重置计时', type: 'bool' },
  usePlayerSpecificRandomSeed: { label: '玩家专属随机种子', type: 'bool' },
  useNetworkedRandomSeed: { label: '联机随机种子', type: 'bool' },
  activatePercent: { label: '激活百分比', type: 'pct' }, deactivePercent: { label: '失活百分比', type: 'pct' },
  setPercentEmptyBeforeEvent: { label: '事件前清空进度', type: 'bool' },
  setPercentFullAfterEvent: { label: '事件后填满进度', type: 'bool' },
  minSeriesRequired: { label: '所需系列数', type: 'num' }, value: { label: '参数值', type: 'num' },
  behaviorTree: { label: '行为树', type: 'str' }, param: { label: '参数名', type: 'str' },
  networkedRandomSeedEventName: { label: '随机种子事件名', type: 'str' },
  analyticsEventName: { label: '埋点事件', type: 'str' }, analyticsParam1Name: { label: '埋点参数1名', type: 'str' },
  analyticsParam1Value: { label: '埋点参数1值', type: 'str' }, analyticsParam2Name: { label: '埋点参数2名', type: 'str' },
  analyticsParam2Value: { label: '埋点参数2值', type: 'str' }, analyticsParam3Name: { label: '埋点参数3名', type: 'str' },
  analyticsParam3Value: { label: '埋点参数3值', type: 'str' },
};

// 读一个 pod/4 字段为 { f, u }（float 与 uint 两种解读）
function podF32U32(f) {
  if (!f || f.kind !== 'pod' || f.sz < 4) return null;
  const dv = new DataView(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength);
  return { f: dv.getFloat32(0, true), u: dv.getUint32(0, true) };
}

// 把一个 clump/u32 引用值解析为目标节点索引。两种编码：
//  a) 按名字：AutoClump<值> 或 BstNode_<值>；b) 按节点序号（数组下标）。返回 -1 表示空/未解析。
function resolveRef(t, nameIndex, v) {
  if (v === 0xFFFFFFFF || v === undefined) return -1;
  const a = nameIndex.get('AutoClump' + v); if (a !== undefined) return a;
  const b = nameIndex.get('BstNode_' + v); if (b !== undefined) return b;
  if (v < t.nodes.length) return v; // 回退：按节点序号
  return -1;
}

// 提取关卡里全部事件/触发器节点及其逻辑关系（用于"事件逻辑面板"，非地图标点）。
// 返回 { events:[{type, typeCn, node, eventName, autoStart, outs:[{field, targetType, targetName}]}], total }
function extractLevelEvents(arrayBuffer) {
  let t;
  try { t = new TGCL(new Uint8Array(arrayBuffer)); } catch (e) { return { events: [], total: 0 }; }
  const nameIndex = new Map();
  t.nodes.forEach((n, i) => nameIndex.set(n.name, i));
  const isEvt = (tn) => /Event|Trigger/i.test(tn);
  const events = [];
  for (const nd of t.nodes) {
    const typeName = t.typeNames[nd.type] || '';
    if (!isEvt(typeName)) continue;
    // 事件名：取第一个非空的名字类字符串字段
    let eventName = '';
    for (const key of EVENT_NAME_FIELDS) {
      const f = nodeField(nd, key);
      if (f && f.kind === 'str' && f.value) { eventName = f.value; break; }
    }
    // autoStart
    const asf = nodeField(nd, 'autoStart');
    const autoStart = asf && asf.kind === 'pod' && asf.sz >= 1 ? (asf.bytes[0] || 0) : 0;
    // 下游引用链：遍历 clump 字段与 u32 数组元素，解析目标类型
    const outs = [];
    for (const f of nd.fields) {
      if (!EVENT_OUT_FIELDS.includes(f.name)) continue;
      const vals = [];
      if (f.kind === 'clump') vals.push(f.value);
      else if (f.kind === 'arr' && f.elemType === 0xFFFFFFFF) for (const el of f.elems) vals.push(el);
      for (const v of vals) {
        const idx = resolveRef(t, nameIndex, v);
        if (idx < 0) continue;
        const tgt = t.nodes[idx];
        outs.push({ field: f.name, targetType: t.typeNames[tgt.type] || '?', targetName: tgt.name });
      }
    }
    // 可读参数：延迟/次数/百分比/行为树/埋点等（只收非默认值，避免一堆 0/false 噪声）
    const props = [];
    for (const f of nd.fields) {
      const def = EVENT_PROP_DEFS[f.name];
      if (!def) continue;
      if (def.type === 'str') {
        if (f.kind === 'str' && f.value) props.push({ label: def.label, value: f.value });
      } else if (def.type === 'bool') {
        if (f.kind === 'pod' && f.sz >= 1 && f.bytes[0]) props.push({ label: def.label, value: '是' });
      } else {
        const v = podF32U32(f);
        if (!v) continue;
        // 秒/百分比/数值：取 float 优先（多为 f32），过滤 0 与异常大值
        let num = Number.isFinite(v.f) && Math.abs(v.f) < 1e6 ? v.f : v.u;
        if (!num) continue;
        let value;
        if (def.type === 'sec') value = (Number.isInteger(num) ? num : num.toFixed(2)) + ' 秒';
        else if (def.type === 'pct') value = (Number.isInteger(num) ? num : num.toFixed(1)) + '%';
        else value = Number.isInteger(num) ? String(num) : num.toFixed(2);
        props.push({ label: def.label, value });
      }
    }
    events.push({
      type: typeName, typeCn: EVENT_TYPE_CN[typeName] || typeName,
      nodeName: nd.name, eventName, autoStart, outs, props,
    });
  }
  return { events, total: events.length };
}

// 提取关卡的"整体信息清单"（无坐标、适合列表展示）：传送连接 / 任务 / 背景音乐 / 对白提示。
// 返回 { links:[{link,to}], quests:[name], music:[name], dialogs:[textId], worldName }
function extractLevelInfo(arrayBuffer) {
  let t;
  try { t = new TGCL(new Uint8Array(arrayBuffer)); } catch (e) { return null; }
  const byType = (name) => {
    const tid = t.typeNames.indexOf(name);
    if (tid < 0) return [];
    return t.nodes.filter(n => n.type === tid);
  };
  // 传送连接：LevelLink（linkName + levelName）+ ChangeLevelWithFade（levelName）
  const links = [];
  const seenLink = new Set();
  for (const nd of byType('LevelLink')) {
    const to = nodeStr(nd, 'levelName'); if (!to) continue;
    const link = nodeStr(nd, 'linkName');
    const key = link + '|' + to; if (seenLink.has(key)) continue; seenLink.add(key);
    links.push({ link, to, kind: '关卡门' });
  }
  for (const nd of byType('ChangeLevelWithFade')) {
    const to = nodeStr(nd, 'levelName'); if (!to) continue;
    const key = '淡入淡出|' + to; if (seenLink.has(key)) continue; seenLink.add(key);
    links.push({ link: '', to, kind: '淡入切换' });
  }
  // 任务：Quest / OnQuestState / 各种 QuestPrefab 的 questName / questDef
  const quests = new Set();
  for (const nd of t.nodes) {
    const tn = t.typeNames[nd.type] || '';
    if (!/Quest/i.test(tn)) continue;
    const q = nodeStr(nd, 'questName') || nodeStr(nd, 'questDef');
    if (q) quests.add(q);
  }
  // 背景音乐：PlayMusic.music
  const music = new Set();
  for (const nd of byType('PlayMusic')) { const m = nodeStr(nd, 'music'); if (m) music.add(m); }
  // 对白提示：DialogHint / DialogHintTimed 的 text
  const dialogs = new Set();
  for (const name of ['DialogHint', 'DialogHintTimed']) {
    for (const nd of byType(name)) { const d = nodeStr(nd, 'text'); if (d) dialogs.add(d); }
  }
  // 关卡参数：LevelParameters.worldName
  let worldName = '';
  const lp = byType('LevelParameters')[0];
  if (lp) worldName = nodeStr(lp, 'worldName');
  return {
    links, quests: [...quests], music: [...music], dialogs: [...dialogs], worldName,
  };
}

// 读 pod 字段为标量 float / floatN。SetEnvDefault 的颜色是 float4(rgba)、角度/强度是 float。
function podFloat(f) {
  if (!f || f.kind !== 'pod' || f.sz < 4) return null;
  const dv = new DataView(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength);
  return dv.getFloat32(0, true);
}
function podFloat4(f) {
  if (!f || f.kind !== 'pod' || f.sz < 16) return null;
  const dv = new DataView(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength);
  return [dv.getFloat32(0, true), dv.getFloat32(4, true), dv.getFloat32(8, true), dv.getFloat32(12, true)];
}

// 提取关卡环境总配置 SetEnvDefault（每关约 1 个）：天空 5 段 tint 色带、太阳、雾、曝光。
// 用于程序化生成天空盒/环境光/太阳方向。字段实测见知识库 04。缺字段返回 null 由调用方回退。
function extractEnvDefault(arrayBuffer) {
  let t;
  try { t = new TGCL(new Uint8Array(arrayBuffer)); } catch (e) { return null; }
  const tid = t.typeNames.indexOf('SetEnvDefault');
  if (tid < 0) return null;
  const nd = t.nodes.find(n => n.type === tid);
  if (!nd) return null;
  const F = (name) => nodeField(nd, name);
  const c4 = (name) => podFloat4(F(name));
  const f1 = (name) => podFloat(F(name));
  return {
    name: nd.name,
    // 天空渐变色带（从顶到底 5 段，rgba，值域 0-1 显示空间）
    tintTop: c4('tintTop'), tintMidTop: c4('tintMidTop'), tintMidMid: c4('tintMidMid'),
    tintMidBot: c4('tintMidBot'), tintBot: c4('tintBot'),
    // 太阳
    sunColor: c4('sunColor'), sunInt: f1('sunInt'), sunSize: f1('sunSize'),
    sunAngleY: f1('sunAngleY'), sunAngleXZ: f1('sunAngleXZ'), moonPhase: f1('moonPhase'),
    // 雾 / 大气
    fogDensity: f1('fogDensity'), atmosphereDensity: f1('atmosphereDensity'),
    fogHeight: f1('fogHeight'), drawDistance: f1('drawDistance'),
    cheapFogEnabled: F('cheapFogEnabled') ? (F('cheapFogEnabled').bytes[0] || 0) : 0,
    cheapFogNear: f1('cheapFogNear'), cheapFogFar: f1('cheapFogFar'),
    cheapFogTintTop: c4('cheapFogTintTop'), cheapFogTintBot: c4('cheapFogTintBot'),
    // 曝光 / 泛光 / 点光
    exposure: f1('exposure'), bloomIntensity: f1('bloomIntensity'),
    pointColor: c4('pointColor'), pointIntensity: f1('pointIntensity'),
  };
}


