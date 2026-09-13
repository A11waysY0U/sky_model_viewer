/* ===== outfit-import.js ===== */
// ============================================================
// 装扮 JSON 导入（my_outfit.json / frida 抓包 → 衣柜组装）
// ------------------------------------------------------------
// 抓包 JSON 里的槽位 id 是 OutfitDefs.name 的 FNV-1a 32 位哈希
// （用真实抓包 47 个不同 id 对 0.16.3 OutfitDefs 全表验证 47/47 命中），
// 故 viewer 离线即可把 id 反解成部件，无需服务端 id→名字映射。
// ============================================================

// 捕获状态
let importedCaptures = [];   // normalize 后的捕获列表
let activeCaptureIdx = -1;   // 当前应用在角色上的捕获索引

/* ---------- 基础工具 ---------- */
// FNV-1a 32bit（对齐游戏内槽位 id 哈希；按 UTF-8 字节计算）
function fnv1a32(str) {
  const bytes = new TextEncoder().encode(String(str));
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// 脏槽位键清洗：运行时指针表读出的键名无 NUL 终止符，后面串进相邻数据
// （如 "body?putBody?postBody?..."）。真实键名是开头的连续字母段。
function sanitizeSlotKey(raw) {
  const m = String(raw || '').match(/^[A-Za-z]+/);
  return m ? m[0].toLowerCase() : '';
}

// 把 id 统一成 OutfitDefs FNV hash 使用的 uint32。
function toSlotId(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? (n >>> 0) : 0;
}

// 兼容抓包的数字 dye 字节对，以及 my_outfit 的 dye 名称字符串：
// "(yellow_red,none)" / "yellow_red,none" / ["yellow_red", "none"]。
function normalizeDye(raw) {
  let values = [];
  if (Array.isArray(raw)) values = raw;
  else if (typeof raw === 'string') {
    values = raw.replace(/^\s*\(\s*|\s*\)\s*$/g, '').split(',');
  } else if (raw && typeof raw === 'object') {
    values = [raw.primary ?? raw.primary_dye, raw.secondary ?? raw.secondary_dye];
  }
  const ids = [0, 0], names = [];
  for (let i = 0; i < 2; i++) {
    const v = values[i];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'number' || /^\d+$/.test(String(v).trim())) {
      ids[i] = toSlotId(v);
    } else {
      names[i] = String(v).trim().toLowerCase();
    }
  }
  return { dye: ids, dyeNames: names.some(Boolean) ? names : null };
}

function normalizeSlot(raw) {
  const v = raw && typeof raw === 'object' ? raw : { id: raw };
  const d = normalizeDye(v.dye);
  return {
    id: toSlotId(v.id),
    tex: Number(v.tex) || 0,
    pat: Number(v.pat) || 0,
    mask: Number(v.mask) || 0,
    dye: d.dye,
    dyeNames: d.dyeNames,
    name: v.name || null,
  };
}

// my_outfit.json 顶层标量不是装扮槽位；arms/legs 没有 id 时会在下面跳过。
const SET_OUTFIT_META_KEYS = new Set([
  'attitude', 'voice', 'seed', 'refreshversion', 'scale', 'height',
]);

function normalizeSetOutfitCapture(data) {
  const set = data.set_outfit || {};
  const slots = {};
  for (const rawKey of Object.keys(set)) {
    const key = sanitizeSlotKey(rawKey);
    if (!key || SET_OUTFIT_META_KEYS.has(key)) continue;
    const raw = set[rawKey];
    if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(raw, 'id')) continue;
    const slot = normalizeSlot(raw);
    if (!slot.id) continue; // my_outfit 用 id=0 表示该槽位为空
    slots[key] = slot;
  }
  if (!Object.keys(slots).length) throw new Error('set_outfit 里没有可用的装扮槽位');

  const meta = { result: data.result || 'ok' };
  for (const rawKey of Object.keys(set)) {
    const key = sanitizeSlotKey(rawKey);
    if (SET_OUTFIT_META_KEYS.has(key)) meta[key] = set[rawKey];
  }
  if (data.placeable_data && data.placeable_data.name) meta.placeableName = data.placeable_data.name;
  return {
    slots,
    idNameMap: data.idNameMap || set.idNameMap || null,
    body: { scale: Number(set.scale) || 0, height: Number(set.height) || 0 },
    meta,
    source: 'my_outfit',
    time: '',
    playerId: null,
  };
}

/* ---------- 装扮 JSON 解析 ---------- */
// 接受 my_outfit.json、rpc snapshot（{captures:[...]}）、捕获数组和单条捕获（{slots:{...}}）。
function parseOutfitDumpText(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('不是有效的 JSON 文件'); }
  if (data && typeof data === 'object' && data.set_outfit && typeof data.set_outfit === 'object') {
    return [normalizeSetOutfitCapture(data)];
  }
  let caps;
  if (Array.isArray(data)) caps = data;
  else if (data && Array.isArray(data.captures)) caps = data.captures;
  else if (data && data.slots) caps = [data];
  else throw new Error('JSON 里没有装扮记录（需含 set_outfit、slots 或 captures 字段）');
  const topMap = data && !Array.isArray(data) ? data.idNameMap : null;
  const out = [];
  for (const c of caps) {
    if (!c || !c.slots) continue;
    const slots = {};
    for (const rawKey of Object.keys(c.slots)) {
      const k = sanitizeSlotKey(rawKey);
      if (!k || slots[k]) continue; // 清洗后重名取首条
      slots[k] = normalizeSlot(c.slots[rawKey] || {});
    }
    if (!Object.keys(slots).length) continue;
    out.push({
      slots,
      idNameMap: c.idNameMap || topMap || null,
      body: { scale: +((c.body && c.body.scale) || 0), height: +((c.body && c.body.height) || 0) },
      meta: c.meta || {},
      source: c.source || 'capture',
      time: c.time || c.exported || '',
      playerId: c.playerId || null,
    });
  }
  if (!out.length) throw new Error('JSON 里没有可用的捕获记录');
  return out;
}

/* ---------- id → OutfitDefs 部件 ---------- */
let _defHashIndex = null, _defNameIndex = null, _defIndexFor = null;
function ensureDefIndexes() {
  if (_defIndexFor === outfitDefs && _defHashIndex) return { byHash: _defHashIndex, byName: _defNameIndex };
  _defHashIndex = new Map(); _defNameIndex = new Map();
  if (Array.isArray(outfitDefs)) {
    for (const d of outfitDefs) {
      if (!d || !d.name) continue;
      _defHashIndex.set(fnv1a32(d.name), d);
      if (!_defNameIndex.has(d.name)) _defNameIndex.set(d.name, d);
    }
  }
  _defIndexFor = outfitDefs;
  return { byHash: _defHashIndex, byName: _defNameIndex };
}

// 在换装目录里找与原始 def 对应的目录条目（保持与衣柜行为一致：sel={name,mesh,def}）
function findCatalogWrapper(type, defObj) {
  const list = outfitCatalog && outfitCatalog[type];
  if (!list) return null;
  for (const w of list) if (w.def === defObj) return w;
  return null;
}

// 染色名称/字节对 → DyeColorDefs HSV（只作用于可染色件）
function dyeHsvFor(slotData, defObj) {
  if (!Array.isArray(dyeColorDefs) || !dyeColorDefs.length) return null;
  if (!isDyeRamp(defObj.shader, defObj.diffuseTex)) return null;
  const names = Array.isArray(slotData.dyeNames) ? slotData.dyeNames : [];
  for (const rawName of names) {
    const name = String(rawName || '').toLowerCase();
    if (!name || name === 'none') continue;
    const dd = dyeColorDefs.find(d => d && String(d.name || '').toLowerCase() === name);
    if (dd && Array.isArray(dd.hsv)) return dd.hsv.slice();
  }
  const dye = Array.isArray(slotData.dye) ? slotData.dye : [0, 0];
  for (const id of [dye[0], dye[1]]) {
    if (!id) continue;
    const dd = dyeColorDefs.find(d => d && d.id === id);
    if (dd && Array.isArray(dd.hsv)) return dd.hsv.slice();
  }
  return null;
}

// 把一条捕获解析成衣柜选择：{ slotKey: {wrapper, hsv} } + 未解析清单。
// 槽位归属以 def.type 为准（抓包键名仅供参考——存在名字带 Horn、type 却是 face 的部件）。
function resolveCapture(cap) {
  const { byHash, byName } = ensureDefIndexes();
  const sel = {}, fails = [];
  let total = 0;
  for (const key of Object.keys(cap.slots)) {
    const s = cap.slots[key];
    total++;
    let defObj = byHash.get(s.id >>> 0);
    if (!defObj && cap.idNameMap && cap.idNameMap[String(s.id)]) {
      defObj = byName.get(cap.idNameMap[String(s.id)]) || null;
    }
    if (!defObj) { fails.push({ key, id: s.id }); continue; }
    if (defObj.mesh === 'Outfit_None') continue; // 空部件：不穿戴
    const type = (defObj.type && outfitCatalog && outfitCatalog[defObj.type]) ? defObj.type : key;
    const wrapper = findCatalogWrapper(type, defObj);
    if (!wrapper) { fails.push({ key, id: s.id, name: defObj.name }); continue; }
    sel[type] = { wrapper, hsv: dyeHsvFor(s, defObj) };
  }
  return { sel, fails, resolvedCount: Object.keys(sel).length, total };
}

/* ---------- 应用到角色 ---------- */
async function applyCapture(idx) {
  const cap = importedCaptures[idx];
  if (!cap) return;
  if (!outfitCatalog) { toast('请先导入含 OutfitDefs.json 的安装包', true); return; }
  const r = resolveCapture(cap);
  dressSelection = {};
  for (const s of DRESS_SLOTS) dressSelection[s.key] = null;
  for (const k of Object.keys(r.sel)) {
    // 克隆目录条目挂染色覆盖，避免污染衣柜共享目录（高亮按内部 def 对象比对）
    const w = r.sel[k].hsv ? Object.assign({}, r.sel[k].wrapper, { hsvOverride: r.sel[k].hsv }) : r.sel[k].wrapper;
    dressSelection[k] = w;
  }
  activeCaptureIdx = idx;
  renderDressPanel(); // 刷新衣柜行高亮与捕获框
  await loadDressCharacter();
  const sum = r.fails.length ? `（未解析：${r.fails.map(f => f.key).join('、')}）` : '';
  toast(`已应用装扮 #${idx + 1}：${r.resolvedCount}/${r.total} 槽${sum}`);
}

function clearImportedCaptures() {
  importedCaptures = []; activeCaptureIdx = -1;
}

/* ---------- 衣柜面板 UI ---------- */
function captureTooltip(cap) {
  const r = resolveCapture(cap);
  const parts = [];
  for (const k of Object.keys(r.sel)) parts.push(k + '=' + dressShortName(r.sel[k].wrapper.name, k));
  for (const f of r.fails) parts.push(f.key + '=未解析(id:' + f.id + ')');
  return (cap.time ? cap.time.replace('T', ' ').replace(/\..*$/, 'Z') + '\n' : '') + parts.join('\n');
}

function captureMetaLine(cap) {
  const r = resolveCapture(cap);
  const b = cap.body || {};
  const fmt = v => (v > 0 ? '+' : '') + (Math.round(v * 1000) / 1000);
  const src = cap.source + (cap.playerId ? ' · ' + cap.playerId : '');
  return `${src} · 体型 ${fmt(b.scale)} / 高矮 ${fmt(b.height)}（近似） · 槽位 ${r.resolvedCount}/${r.total}`;
}

function renderCaptureBox(panel) {
  const box = document.createElement('div');
  box.id = 'capBox';
  const head = document.createElement('div');
  head.className = 'cap-head';
  const title = document.createElement('span');
  title.className = 'cap-title';
  title.textContent = '装扮导入' + (importedCaptures.length ? ` (${importedCaptures.length})` : '（未导入）');
  head.appendChild(title);
  const imp = document.createElement('button');
  imp.className = 'cap-btn';
  imp.textContent = '📥 导入装扮';
  imp.title = '选择 my_outfit.json（set_outfit）或 frida 抓包装扮 JSON（rpc snapshot / 捕获数组 / 单条捕获）';
  imp.onclick = () => ensureOutfitFileInput().click();
  head.appendChild(imp);
  if (importedCaptures.length) {
    const clr = document.createElement('button');
    clr.className = 'cap-btn';
    clr.textContent = '清除';
    clr.onclick = async () => {
      clearImportedCaptures();
      renderDressPanel();
      await loadDressCharacter();
    };
    head.appendChild(clr);
  }
  box.appendChild(head);
  if (importedCaptures.length) {
    const chips = document.createElement('div');
    chips.className = 'cap-chips';
    importedCaptures.forEach((c, i) => {
      const chip = document.createElement('button');
      chip.className = 'cap-chip' + (i === activeCaptureIdx ? ' active' : '');
      chip.textContent = '#' + (i + 1);
      chip.title = captureTooltip(c);
      chip.onclick = () => applyCapture(i);
      chips.appendChild(chip);
    });
    box.appendChild(chips);
    if (activeCaptureIdx >= 0) {
      const meta = document.createElement('div');
      meta.className = 'cap-meta';
      meta.textContent = `#${activeCaptureIdx + 1} ` + captureMetaLine(importedCaptures[activeCaptureIdx]);
      box.appendChild(meta);
    }
  }
  panel.appendChild(box);
}

/* ---------- 文件选择 ---------- */
let _outfitFileInput = null;
function ensureOutfitFileInput() {
  if (_outfitFileInput) return _outfitFileInput;
  _outfitFileInput = document.createElement('input');
  _outfitFileInput.type = 'file';
  _outfitFileInput.accept = '.json,application/json';
  _outfitFileInput.style.display = 'none';
  _outfitFileInput.onchange = async () => {
    const f = _outfitFileInput.files && _outfitFileInput.files[0];
    _outfitFileInput.value = '';
    if (!f) return;
    try {
      const caps = parseOutfitDumpText(await f.text());
      importedCaptures = caps;
      activeCaptureIdx = -1;
      renderDressPanel();
      toast(`导入 ${caps.length} 条装扮记录`);
      await applyCapture(0); // 自动先穿上第一条，其余点编号切换
    } catch (e) {
      toast('装扮导入失败：' + (e.message || e), true);
    }
  };
  document.body.appendChild(_outfitFileInput);
  return _outfitFileInput;
}
