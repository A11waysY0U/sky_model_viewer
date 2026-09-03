/* ===================== APK 导入 ===================== */
async function importApk(file) {
  // 切换新安装包前，清空并释放旧纹理缓存，避免同名贴图命中旧包缓存 + 显存泄漏
  clearScene();
  for (const t of texCache.values()) { if (t && t.dispose) t.dispose(); }
  texCache.clear();
  currentTexture = null;
  overlay.classList.add('show');
  overlayTxt.textContent = '读取安装包目录...';
  overlayBar.style.width = '10%';
  try {
    // >2GB 文件（iOS ipa）：浏览器无法 slice 2^31 以上偏移，改流式全量读入内存（ChunkedFile）
    // 后再随机访问，绕开该 bug。阈值 1.9GB 留余量；小于此则用轻量按需读（不占内存）。
    if (file.size > 1900 * 1024 * 1024 && typeof file.stream === 'function') {
      overlayTxt.textContent = '载入大文件到内存（2GB+，首次较慢，请稍候）...';
      file = await buildChunkedFile(file, (p) => { overlayBar.style.width = (5 + p * 45).toFixed(0) + '%'; });
      overlayTxt.textContent = '读取安装包目录...';
    }
    apkFile = file;
    const entries = await readCentralDirectory(file);
    overlayBar.style.width = '60%';
    meshEntries = entries
      .filter(e => e.name.toLowerCase().endsWith('.mesh') && e.uncompSize > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    // 关卡地形 .meshes 条目（地图）
    mapEntries = entries
      .filter(e => e.name.toLowerCase().endsWith('.meshes') && e.uncompSize > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    const mb = $('mapBtn');
    if (mb) mb.style.display = mapEntries.length ? 'inline-flex' : 'none';
    // 建立 mesh 基名索引（换装按 outfit.mesh 名查找 zip 条目）
    meshEntryIndex.clear();
    for (const e of meshEntries) {
      const nl = e.name.toLowerCase();
      const base = nl.substring(nl.lastIndexOf('/') + 1).replace(/\.mesh$/, '');
      if (!meshEntryIndex.has(base)) meshEntryIndex.set(base, e);
    }
    // 动画：收集 animpack 条目（角色动画主要是 CharKidAnim* 系列）
    animState.entries = entries
      .filter(e => e.name.toLowerCase().endsWith('.animpack') && e.uncompSize > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    // 建立关卡名 -> Objects.level.bin 索引（地图物件实例）
    levelBinIndex.clear();
    for (const e of entries) {
      const nl = e.name.toLowerCase();
      if (nl.endsWith('/objects.level.bin') || nl.endsWith('objects.level.bin')) {
        const parts = e.name.split('/');
        const li = parts.map(p => p.toLowerCase()).indexOf('levels');
        const lvl = (li >= 0 && parts.length > li + 1) ? parts[li + 1].toLowerCase() : '';
        if (lvl) levelBinIndex.set(lvl, e);
      }
    }
    // 加载材质定义（OutfitDefs.json / PlaceableDefs.json），失败不影响主流程
    outfitDefs = placeableDefs = null; defsLoaded = false;
    loadMaterialDefs(file, entries).then(() => {
      defsLoaded = true;
      outfitCatalog = buildOutfitCatalog(outfitDefs);
      // 有服装定义则启用换装按钮
      const db = $('dressBtn');
      if (db) db.style.display = (outfitDefs && outfitDefs.length) ? 'inline-flex' : 'none';
      // 空闲时后台预热衣柜图标图集，打开衣柜时图标直接出、不卡
      const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
      idle(() => prewarmDressIcons());
    });
    overlayBar.style.width = '100%';
    if (!meshEntries.length) {
      toast('未在安装包中找到 .mesh 文件', true);
      countEl.textContent = '无模型';
    } else {
      countEl.textContent = `${meshEntries.length}`;
      filtered = meshEntries;
      renderList();
      toast(`找到 ${meshEntries.length} 个模型`);
      // 导入完成后自动加载列表第一个模型，避免视口停留在空提示界面
      const firstItem = listEl.querySelector('.item');
      if (firstItem) selectEntry(meshEntries[0], firstItem);
    }
  } catch (e) {
    console.error(e);
    const nr = (e && (e.name === 'NotReadableError' || /could not be read/i.test(e.message || '')));
    toast(nr ? '文件读取失败：大文件(2GB+)可能被占用或磁盘忙，请重试导入；或先把 ipa 复制到本地固态盘再试。' : ('读取失败: ' + e.message), true);
  } finally {
    setTimeout(() => overlay.classList.remove('show'), 250);
  }
}

function renderList() {
  listEl.innerHTML = '';
  // 空状态：区分「未导入」与「搜索无结果」
  if (!filtered.length) {
    const es = document.createElement('div');
    es.className = 'empty-state';
    const imported = meshEntries && meshEntries.length;
    es.innerHTML = imported
      ? `<div class="es-ico">🔍</div><div class="es-title">没有匹配的模型</div><div class="es-desc">换个关键词试试，或清空搜索框查看全部。</div>`
      : `<div class="es-ico">◈</div><div class="es-title">还没有导入模型</div><div class="es-desc">点顶部「导入安装包」选择 Sky 的 APK 或 IPA，或直接把文件拖进来。</div>`;
    listEl.appendChild(es);
    return;
  }
  const frag = document.createDocumentFragment();
  const max = Math.min(filtered.length, 3000);
  for (let i = 0; i < max; i++) {
    const e = filtered[i];
    const div = document.createElement('div');
    div.className = 'item';
    const isAnim = /anim/i.test(e.name);
    const dot = document.createElement('span');
    dot.className = isAnim ? 'mdot' : 'dot';
    const label = document.createElement('span');
    label.textContent = e.name.substring(e.name.lastIndexOf('/') + 1).replace(/\.mesh$/i, '');
    div.appendChild(dot); div.appendChild(label);
    div.title = e.name;
    div.onclick = () => selectEntry(e, div);
    frag.appendChild(div);
  }
  listEl.appendChild(frag);
  if (filtered.length > max) {
    const more = document.createElement('div');
    more.className = 'item'; more.style.color = 'var(--dim)';
    more.textContent = `… 还有 ${filtered.length - max} 项，用搜索缩小范围`;
    listEl.appendChild(more);
  }
}

async function selectEntry(entry, el) {
  document.querySelectorAll('.item.active').forEach(x => x.classList.remove('active'));
  if (el) el.classList.add('active');
  const myToken = ++loadToken;
  try {
    const raw = await extractEntry(apkFile, entry);
    const data = readMesh(raw, entry.name);
    if (!data.vertices.length) { toast('该模型无几何数据（空挂件）', true); return; }
    try { data.material = resolveMaterial(entry.name); } catch (e) { data.material = null; }
    // 尝试加载漫反射贴图
    if (data.material && data.material.diffuseTex) {
      try { data.texture = await loadTexture(data.material.diffuseTex); } catch (e) { data.texture = null; }
    }
    // 加载期间用户又点了别的模型，丢弃这次过期结果
    if (myToken !== loadToken) return;
    // 先立即显示（可能是白模），不阻塞在关卡贴图索引扫描上，避免首次点击长时间卡住
    showMesh(data);
    // 移动端选完自动收起侧栏，露出视口
    if (isMobile()) setCollapsed(true);
    // 贴图没加载出来（多为场景物件：真实贴图由关卡指定，不在 mesh/Defs 里）——
    // 后台懒扫描关卡 bin 建「mesh->{diffuse,norm}」索引，好了再回填贴图并刷新显示。
    if (!data.texture) {
      ensureMeshTexIndex().then(async (idx) => {
        if (myToken !== loadToken) return; // 扫描期间用户切了模型
        const resName = (data.material && data.material.name) || meshBaseName(entry.name);
        let rec = idx.get(resName.toLowerCase());
        // 再退一步：用去变体后缀名反查
        if (!rec) { const sv = stripVariant(resName); if (sv) rec = idx.get(sv.toLowerCase()); }
        if (!rec || !rec.diffuse) return;
        try {
          const diffuse = await loadTexture(rec.diffuse);
          if (myToken !== loadToken || !diffuse) return;
          data.texture = diffuse;
          if (data.material) data.material.diffuseTex = rec.diffuse;
          if (rec.norm) {
            try { data.normTexture = await loadTexture(rec.norm); } catch (e) { data.normTexture = null; }
            if (data.material) data.material.normTex = rec.norm;
          }
          // 第二层色 + 光照/AO 图：门/石头的真实颜色与烘焙光影（用 uv3/uv1）
          if (rec.diffuse2) {
            try { data.diffuse2Texture = await loadTexture(rec.diffuse2); } catch (e) { data.diffuse2Texture = null; }
            data.diffuse2Offset = rec.d2off || null;
          }
          if (rec.light) {
            try { data.lightTexture = await loadTexture(rec.light); } catch (e) { data.lightTexture = null; }
          }
          if (myToken !== loadToken) return;
          showMesh(data, true); // 贴图就绪后重新显示，保留用户当前视角
        } catch (e) { /* 贴图加载失败保持白模 */ }
      }).catch(() => { /* 索引不可用则保持白模 */ });
    }
  } catch (e) {
    console.error(e);
    const nr = (e && (e.name === 'NotReadableError' || /could not be read/i.test(e.message || '')));
    toast(nr ? '文件读取失败：大文件(2GB+)可能被占用或磁盘忙，请重试导入；或先把 ipa 复制到本地固态盘再试。' : ('解析失败: ' + e.message), true);
  }
}

/* ===================== 单个 mesh ===================== */
async function loadSingleMesh(file) {
  try {
    const buf = await file.arrayBuffer();
    const data = readMesh(buf, file.name);
    if (!data.vertices.length) { toast('无几何数据', true); return; }
    showMesh(data);
    toast('加载成功');
  } catch (e) {
    console.error(e);
    toast('解析失败: ' + e.message, true);
  }
}

