/* ===== dress.js ===== */
// ============================================================
// Sky Mesh Viewer —— 换装模块
// 按 OutfitDefs 的 type 分组部件，组合加载成完整角色
// 角色部件用 ramp 着色（CharRamp 渐变查找表）
// ============================================================

// 部件槽位顺序（对应 OutfitDefs.type）
const DRESS_SLOTS = [
  { key: 'body', label: '身体' },
  { key: 'mask', label: '面具' },
  { key: 'hair', label: '发型' },
  { key: 'hat',  label: '帽子' },
  { key: 'horn', label: '头饰' },
  { key: 'face', label: '脸' },
  { key: 'neck', label: '颈饰' },
  { key: 'wing', label: '斗篷/翅膀' },
  { key: 'feet', label: '鞋' },
  { key: 'prop', label: '道具' }
];

// 按 type 建立部件目录：{ body:[{name,mesh,def}], ... }
function buildOutfitCatalog(outfitDefs) {
  const cat = {};
  for (const s of DRESS_SLOTS) cat[s.key] = [];
  if (!Array.isArray(outfitDefs)) return cat;
  for (const o of outfitDefs) {
    const t = o.type;
    if (!t || !cat[t]) continue;
    if (!o.mesh) continue;
    cat[t].push({ name: o.name || o.mesh, mesh: o.mesh, def: o });
  }
  // 每个槽位按名字排序
  for (const k in cat) cat[k].sort((a, b) => a.name.localeCompare(b.name));
  return cat;
}

function pickRandom(list) {
  if (!list || !list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}


