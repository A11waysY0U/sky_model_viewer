/* ===================== 换装 UI ===================== */
function toggleDressMode() {
  dressMode = !dressMode;
  const panel = $('dressPanel'), list = $('list'), search = $('search'), title = $('sbtitle');
  $('dressBtn').classList.toggle('active', dressMode);
  // 退出地图模式（与 toggleMapMode 退出换装模式对称，避免两模式高亮/面板状态残留）
  if (dressMode && mapMode) { mapMode = false; $('mapBtn').classList.remove('active'); }
  if (dressMode) {
    if (!outfitCatalog) { toast('该包无服装定义', true); dressMode = false; return; }
    list.style.display = 'none'; search.style.display = 'none';
    panel.style.display = 'flex'; panel.style.flexDirection = 'column';
    title.textContent = '换装';
    renderDressPanel();
    setCollapsed(false);
  } else {
    list.style.display = 'block'; search.style.display = 'block';
    panel.style.display = 'none';
    title.textContent = '模型列表';
  }
}

// 图标下方短名：去掉 CharSkyKid_<Slot>_ 前缀，只留有辨识度的尾段
function dressShortName(name, slotKey) {
  let n = String(name || '');
  n = n.replace(/^CharSkyKid_/i, '').replace(/^NPC_/i, '');
  // 去掉与槽位同名的类别前缀（Body_/Hair_/Hat_…）
  n = n.replace(/^(Body|Hair|Hat|Mask|Horn|Face|Neck|Wing|Cape|Feet|Prop|Legs|Arms)_/i, '');
  return n || name;
}
function renderDressPanel() {
  const panel = $('dressPanel');
  panel.innerHTML = '';
  // 确保当前分页槽位有效
  if (!DRESS_SLOTS.some(s => s.key === dressActiveSlot)) dressActiveSlot = DRESS_SLOTS[0].key;

  // ── 顶部分类切换标签（身体/发型/帽子…），带计数与已选高亮 ──
  const tabs = document.createElement('div');
  tabs.className = 'dress-tabs';
  const tabByKey = {};
  for (const slot of DRESS_SLOTS) {
    const list = outfitCatalog[slot.key] || [];
    if (!list.length) continue; // 该包无此类装扮则不显示该分类
    const tab = document.createElement('button');
    tab.className = 'dress-tab' + (slot.key === dressActiveSlot ? ' active' : '') + (dressSelection[slot.key] ? ' has' : '');
    tab.innerHTML = `${slot.label}<span class="cnt">${list.length}</span>`;
    tab.onclick = () => { dressActiveSlot = slot.key; renderDressPanel(); };
    tabs.appendChild(tab);
    tabByKey[slot.key] = tab;
  }
  panel.appendChild(tabs);

  // ── 装扮导入框（my_outfit.json / frida 抓包；无记录时只有「导入装扮」按钮）──
  if (typeof renderCaptureBox === 'function') renderCaptureBox(panel);

  // ── 当前分类的竖排单行列表：每行左图标 + 右名称，点击即穿 ──
  const slot = DRESS_SLOTS.find(s => s.key === dressActiveSlot);
  const list = outfitCatalog[slot.key] || [];
  const cur = dressSelection[slot.key];
  const scroll = document.createElement('div');
  scroll.className = 'dress-list';
  scroll.style.flex = '1'; scroll.style.overflowY = 'auto';

  const rowEls = [];
  const mkRow = (def, isNone) => {
    const row = document.createElement('div');
    // 选中态按内部 def 对象比对：导入装扮会克隆目录条目挂染色覆盖（hsvOverride），
    // 克隆件与原条目也要视为同一行选中。
    row.className = 'drow' + ((isNone ? !cur : !!(cur && cur.def && def.def && cur.def === def.def)) ? ' active' : '');
    row._isNone = isNone; row._def = isNone ? null : def;
    rowEls.push(row);
    const thumb = document.createElement('div');
    thumb.className = 'drow-thumb';
    if (isNone) {
      thumb.classList.add('none');
      thumb.textContent = '✕';
    } else {
      // 统一占位：未加载/失败时显示衣架图标（不露 alt 破图）；成功解码再淡入真图。
      thumb.classList.add('ph');
      const im = document.createElement('img');
      im.alt = ''; im.loading = 'lazy';
      im.style.opacity = '0';
      im.onload = () => { im.style.opacity = '1'; thumb.classList.remove('ph'); };
      im.onerror = () => { im.remove(); /* 保留占位衣架 */ };
      thumb.appendChild(im);
      buildIconDataUrl(def.def || def).then(url => {
        if (url) im.src = url; else im.remove(); // 无图则保留占位衣架
      }).catch(() => { im.remove(); });
    }
    const cap = document.createElement('div');
    cap.className = 'drow-cap';
    cap.textContent = isNone ? '不穿戴' : dressShortName(def.name, slot.key);
    row.title = isNone ? '清除此项' : def.name;
    row.appendChild(thumb); row.appendChild(cap);
    row.onclick = async () => {
      dressSelection[slot.key] = isNone ? null : def;
      // 只更新行高亮，不重建整个面板——否则列表会被清空重建、滚动位置弹回顶部且图标重新解码
      const sel = dressSelection[slot.key];
      for (const r of rowEls) r.classList.toggle('active', r._isNone ? !sel : !!(sel && r._def && sel.def === r._def.def));
      // 同步顶部该分类标签的「已选」标记
      const tabEl = tabByKey[slot.key];
      if (tabEl) tabEl.classList.toggle('has', !!sel);
      await loadDressCharacter();
    };
    return row;
  };
  scroll.appendChild(mkRow(null, true));
  for (const def of list) scroll.appendChild(mkRow(def, false));
  panel.appendChild(scroll);

  // 操作按钮：只保留「随机换装」，随机各槽位后实时渲染
  const act = document.createElement('div');
  act.id = 'dressActions';
  const btnRandom = document.createElement('button');
  btnRandom.textContent = '🎲 随机换装';
  btnRandom.onclick = async () => {
    // 随机装扮不动「道具」槽位（用户反馈随机道具别扭），道具保持当前选择
    for (const slot of DRESS_SLOTS) {
      if (slot.key === 'prop') continue;
      dressSelection[slot.key] = pickRandom(outfitCatalog[slot.key]);
    }
    renderDressPanel();
    await loadDressCharacter();
    if (isMobile()) setCollapsed(true);
  };
  act.appendChild(btnRandom);
  panel.appendChild(act);

  // 动画控制区
  if (animState.entries && animState.entries.length) {
    const animBox = document.createElement('div');
    animBox.id = 'animBox';

    // 动画选择下拉（复用 .dslot select 的 hover/focus 样式）
    const sel = document.createElement('select');
    sel.id = 'animSelect';
    sel.className = 'anim-select';
    // 只列与换装角色（CharSkyKid 骨架）兼容的动画：名字以 CharKidAnim 开头。
    // 其它骨架（如 CharSkyNPC_*）绑定姿势不同，套用会把顶点拉飞变形。
    // 若一个兼容动画都没有，则退回列出全部（避免下拉空掉）。
    const nameOfEntry = e => e.name.substring(e.name.lastIndexOf('/') + 1).replace(/\.animpack$/i, '');
    const compatIdx = [];
    for (let i = 0; i < animState.entries.length; i++) {
      if (/^CharKidAnim/i.test(nameOfEntry(animState.entries[i]))) compatIdx.push(i);
    }
    const listIdx = compatIdx.length ? compatIdx : animState.entries.map((_, i) => i);
    const none = document.createElement('option');
    none.value = ''; none.textContent = `— 选择动画 (${listIdx.length}) —`;
    sel.appendChild(none);
    for (const i of listIdx) {
      const nm = nameOfEntry(animState.entries[i]);
      const opt = document.createElement('option');
      opt.value = String(i); opt.textContent = nm;
      sel.appendChild(opt);
    }
    sel.onchange = () => {
      const v = sel.value;
      if (v === '') { clearAnimation(); updateAnimUI(); return; }
      const idx = parseInt(v);
      loadAnimation(animState.entries[idx], idx);
    };
    animBox.appendChild(sel);

    // 播放/暂停 + 进度条
    const ctrl = document.createElement('div');
    ctrl.className = 'anim-ctrl';
    const playBtn = document.createElement('button');
    playBtn.id = 'animPlayBtn';
    playBtn.className = 'anim-play';
    playBtn.textContent = '▶';
    playBtn.onclick = () => {
      if (!animState.pack || animState.frameCount <= 1) return;
      animState.playing = !animState.playing;
      animState.lastT = performance.now();
      updateAnimUI();
    };
    const seek = document.createElement('input');
    seek.id = 'animSeek'; seek.type = 'range'; seek.min = '0'; seek.max = '100'; seek.value = '0';
    seek.oninput = () => {
      if (!animState.pack || animState.frameCount <= 1) return;
      animState.playing = false;
      const frac = parseInt(seek.value) / 100;
      const frameIdx = Math.min(animState.frameCount - 1, Math.floor(frac * animState.frameCount));
      animState.time = frameIdx / animState.fps;
      applyAnimFrame(frameIdx);
      const fl = $('animFrame');
      if (fl) fl.textContent = `帧 ${frameIdx + 1}/${animState.frameCount}`;
      updateAnimUI();
    };
    ctrl.appendChild(playBtn); ctrl.appendChild(seek);
    animBox.appendChild(ctrl);

    // 元信息行：当前帧/总帧、速度、循环
    const meta = document.createElement('div');
    meta.className = 'anim-meta';
    const frameLbl = document.createElement('span');
    frameLbl.id = 'animFrame'; frameLbl.className = 'frame'; frameLbl.textContent = '帧 -/-';
    const sp = document.createElement('span'); sp.className = 'spacer';
    const spd = document.createElement('select');
    spd.id = 'animSpeed'; spd.title = '播放速度';
    for (const v of [0.25, 0.5, 1, 1.5, 2]) {
      const o = document.createElement('option');
      o.value = String(v); o.textContent = v + '×';
      if (v === animState.speed) o.selected = true;
      spd.appendChild(o);
    }
    spd.onchange = () => { animState.speed = parseFloat(spd.value); };
    const loop = document.createElement('span');
    loop.id = 'animLoop';
    loop.className = 'loop' + (animState.loop ? ' on' : '');
    loop.textContent = '↻ 循环';
    loop.title = '循环播放开关';
    loop.onclick = () => {
      animState.loop = !animState.loop;
      loop.classList.toggle('on', animState.loop);
    };
    meta.appendChild(frameLbl); meta.appendChild(sp); meta.appendChild(spd); meta.appendChild(loop);
    animBox.appendChild(meta);
    panel.appendChild(animBox);
    updateAnimUI();
  }
}

// 刷新动画 UI（播放按钮图标、下拉选中态）
function updateAnimUI() {
  const playBtn = $('animPlayBtn');
  if (playBtn) playBtn.textContent = animState.playing ? '⏸' : '▶';
  const sel = $('animSelect');
  if (sel) sel.value = animState.pack && animState.curIndex >= 0 ? String(animState.curIndex) : '';
}
// 播放推进时同步进度条（避免与用户拖动冲突）
function updateAnimSeek(frameIdx) {
  const seek = $('animSeek');
  if (seek && animState.frameCount > 1 && document.activeElement !== seek) {
    seek.value = String(Math.round(frameIdx / (animState.frameCount - 1) * 100));
  }
  const fl = $('animFrame');
  if (fl) {
    fl.textContent = animState.pack && animState.frameCount > 0
      ? `帧 ${frameIdx + 1}/${animState.frameCount}` : '帧 -/-';
  }
}

/* ===================== 地图 UI ===================== */
function toggleMapMode() {
  mapMode = !mapMode;
  const panel = $('dressPanel'), list = $('list'), search = $('search'), title = $('sbtitle');
  $('mapBtn').classList.toggle('active', mapMode);
  // 退出换装模式
  if (mapMode && dressMode) { dressMode = false; $('dressBtn').classList.remove('active'); }
  if (mapMode) {
    if (!mapEntries.length) { toast('该包无关卡地形', true); mapMode = false; return; }
    list.style.display = 'none'; search.style.display = 'none';
    panel.style.display = 'flex'; panel.style.flexDirection = 'column';
    title.textContent = '看地图';
    renderMapPanel();
    setCollapsed(false);
  } else {
    list.style.display = 'block'; search.style.display = 'block';
    panel.style.display = 'none';
    title.textContent = '模型列表';
  }
}

function levelNameOf(entry) {
  // Levels/Dawn/BstBaked.meshes -> Dawn
  const parts = entry.name.split('/');
  const bi = parts.indexOf('Levels');
  if (bi >= 0 && parts.length > bi + 1) return parts[bi + 1];
  return entry.name.substring(entry.name.lastIndexOf('/') + 1).replace(/\.meshes$/i, '');
}

function renderMapPanel() {
  const panel = $('dressPanel');
  panel.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.flex = '1'; wrap.style.overflowY = 'auto'; wrap.style.padding = '4px';
  for (const e of mapEntries) {
    const div = document.createElement('div');
    div.className = 'item';
    const dot = document.createElement('span'); dot.className = 'dot';
    const label = document.createElement('span');
    label.textContent = levelNameOf(e);
    div.appendChild(dot); div.appendChild(label);
    div.title = e.name;
    div.onclick = () => { document.querySelectorAll('#dressPanel .item.active').forEach(x=>x.classList.remove('active')); div.classList.add('active'); loadMapLevel(e); };
    wrap.appendChild(div);
  }
  panel.appendChild(wrap);
}

async function loadMapLevel(entry) {
  const myToken = ++loadToken;
  overlay.classList.add('show');
  overlayTxt.textContent = '解析地形 ' + levelNameOf(entry) + '...';
  overlayBar.style.width = '20%';
  try {
    const raw = await extractEntry(apkFile, entry);
    const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    overlayBar.style.width = '55%';
    const d = parseMeshes(ab);
    overlayBar.style.width = '70%';
    if (myToken !== loadToken) return; // 已被更晚的加载取代
    clearScene();
    mapGroup = new THREE.Group();
    // 地形本体
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(d.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(d.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(d.indices, 1));
    const mat = skyMaterial({ vertexColors: true, side: THREE.DoubleSide, wireframe,
      specStrength: 0.05, shininess: 10, fresnel: 0.08, detail: 0.5 }); // 地形：强棱面细节、弱高光
    const terrainMesh = new THREE.Mesh(geo, mat);
    terrainMesh.userData.category = 'terrain';
    terrainMesh.userData.resourceName = '地形网格';
    mapGroup.add(terrainMesh);
    // 分类计数：terrain / 各细分实体类 / effect（云雾风等透明特效）
    const catCounts = { terrain: 1, rock: 0, building: 0, structure: 0, art: 0, light: 0, vegetation: 0, prop: 0, misc: 0, water: 0, cloud: 0, effect: 0, portal: 0, marker: 0 };
    // 云本体：几何烘焙在 .meshes 里（材质80 浅蓝白），与地形共用顶点缓冲。
    // 用专门的云材质渲染（半透明发光/顶点色），归入 cloud 图层，不纳入取景。
    if (d.cloudIndices && d.cloudIndices.length) {
      const cgeo = new THREE.BufferGeometry();
      cgeo.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
      cgeo.setAttribute('normal', new THREE.BufferAttribute(d.normals, 3));
      cgeo.setAttribute('color', new THREE.BufferAttribute(d.colors, 3));
      cgeo.setIndex(new THREE.BufferAttribute(d.cloudIndices, 1));
      const cloudMesh = new THREE.Mesh(cgeo, cloudMaterial({ wireframe }));
      cloudMesh.userData.category = 'cloud';
      cloudMesh.userData.resourceName = '云网格';
      cloudMesh.renderOrder = 10; // 云最后画，正确混合在场景之上
      mapGroup.add(cloudMesh);
      catCounts.cloud = 1;
    }
    // 关卡物件实例（Objects.level.bin → LevelMesh：resourceName + 变换）
    let placed = 0;
    // 取景用被渲染三角形的紧致范围（未使用顶点会把整体包围盒撑得很大）
    const framing = new THREE.Box3(
      new THREE.Vector3(d.renderMin[0], d.renderMin[1], d.renderMin[2]),
      new THREE.Vector3(d.renderMax[0], d.renderMax[1], d.renderMax[2])
    );
    const lvl = levelNameOf(entry).toLowerCase();
    const binEntry = levelBinIndex.get(lvl);
    if (binEntry) {
      overlayTxt.textContent = '摆放关卡物件...';
      try {
        const binRaw = await extractEntry(apkFile, binEntry);
        const binAb = binRaw.buffer.slice(binRaw.byteOffset, binRaw.byteOffset + binRaw.byteLength);
        const insts = extractLevelMeshes(binAb);
        try { mapEvents = extractLevelEvents(binAb); } catch (e) { mapEvents = null; }
        try { mapInfo = extractLevelInfo(binAb); } catch (e) { mapInfo = null; }
        // 相同 resourceName 的几何/材质缓存，避免重复解析与解码
        const geoCache = new Map();
        const matCache = new Map();
        for (const it of insts) {
          const meshEntry = findMeshEntryByName(it.resourceName);
          if (!meshEntry) continue;
          try {
            let ig = geoCache.get(it.resourceName);
            if (ig === undefined) {
              const mraw = await extractEntry(apkFile, meshEntry);
              const mdata = readMesh(mraw, meshEntry.name);
              ig = mdata.vertices.length ? buildGeometry(mdata) : null;
              geoCache.set(it.resourceName, ig);
            }
            if (!ig) continue;
            const nm = it.resourceName || '';
            const sh = it.shaderName || '';
            // 水面物件（游戏用 Ocean 着色器，海平面运行时程序生成；这里只处理烘焙的水体网格）。
            // 实测关卡水体名如 IslandOceanLP / OasisWaterLP / PrairieIslandWater_01 / CSOasis_Water / MemAp8WaterNN。
            // 命中含 Ocean/Water，但排除：Waterfall（瀑布）、(Under)WaterFloor（水下地面，实体）、
            //   Veil（服饰）、Gauge/Bucket（道具）、Cham（角色染色）、Caustics 等。
            const isWater = (/(?:ocean|water)/i.test(nm) &&
              !/waterfall|floor|veil|gauge|bucket|cham|obelisk|hat/i.test(nm) && nm.length >= 5) ||
              (/Ocean/i.test(sh) && !/Caustics|Cham/i.test(sh));
            // 大气特效（雾/云/极光/彩虹/光束/闪电/辉光/星）—— 按资源名识别，半透明、不写深度、不纳入取景。
            // 注意：不能只按 shader（Alpha/Sdf/Cham）判定，很多实体道具/植被也用 alpha-test shader。
            const isAtmo = !isWater && /Fog|Cloud|Aurora|Rainbow|StormCard|StormWind|StormEnd|LightShaft|LightBeam|GodLight|Lightning|Glow|Bloom|Ripple|Shaft|Halo|Constellation|SingleStar|StarStreak|StarField|StarBroken|SunFlower/i.test(nm);
            // 植被/镂空贴图：用 alpha-test 裁切，仍是实体（写深度、参与取景）
            const isCutout = !isAtmo && !isWater && /Alpha|Sdf|Cham|Foliage|Leaf|Bush|Tree|Grass|Flower/i.test(sh + ' ' + nm);
            // 自发光半透明辅助物件（UnlitAlpha 等）：u_diffuseColor.a 极低 = 游戏里近乎不可见的
            // 交互/碰撞占位或微光片（如 CandleSpace 的 BonfireSeatLog_01：Unlit白+alpha0）。
            // 之前被当纯白不透明实体 → 白模块。按真实 alpha 半透明，贴近游戏（几乎看不见）。
            const dcA = (it.diffuseColor && it.diffuseColor.length >= 4) ? it.diffuseColor[3] : null;
            const isFadeSprite = !isWater && !isAtmo && /Unlit/i.test(sh) && dcA != null && dcA < 0.1;
            // 物件材质：优先用 TGCL shaderParams 里的 u_diffuse1Tex，回退到 PlaceableDefs
            const rmat = resolveMaterial(meshEntry.name) || {};
            // 关卡数据已明确该物件是"无贴图纯色"（材质球给了 baseColor / 实例给了 diffuseColor，
            // 但都没有漫反射贴图）时，不能再用 resolveMaterial 拿 mesh 名当贴图名去猜——
            // 猜出的贴图既加载不到（变白模）又会挤掉纯色分支。此时直接走 baseColor 纯色。
            // 例：CandleSpace 的 DawnTempleStairsRail_01 引用材质球"Cliff"(Mesh 着色器,仅 baseColor 灰)。
            const explicitSolid = !it.diffuseTex && (
              (it.matBaseColor && (it.matBaseColor[0] || it.matBaseColor[1] || it.matBaseColor[2])) ||
              (it.diffuseColor && (it.diffuseColor[0] || it.diffuseColor[1] || it.diffuseColor[2]))
            );
            const texName = it.diffuseTex || (explicitSolid ? '' : (rmat.diffuseTex || ''));
            // 法线贴图名（仅实体物件用；大气/水面不用）
            const normName = (!isWater && !isAtmo) ? (it.normTex || '') : '';
            // 第二层色 + 光照/AO 图名（仅实体物件用）：给门/石头上真实颜色与烘焙光影。
            // White/Gray 这类中性贴图相乘不改观感，仍上以保持与游戏一致（且不误伤）。
            const solid = !isWater && !isAtmo;
            // 只有几何实际带对应 UV 通道时才启用（老版本量化 mesh 只有 uv0，强开会采到 0 导致 AO/色错乱）
            const hasUv3 = !!(ig.getAttribute && ig.getAttribute('auv3'));
            const hasUv1 = !!(ig.getAttribute && ig.getAttribute('auv1'));
            const d2Name = (solid && hasUv3) ? (it.diffuse2Tex || '') : '';
            const ltName = (solid && hasUv1) ? (it.lightTex || '') : '';
            const d2Off = it.diffuse2Offset || null;
            const oHsv = Array.isArray(rmat.baseHsv) ? rmat.baseHsv.join(',') : '';
            // 无贴图物件的纯色底：A 类 u_diffuseColor（活动彩色件）优先，其次 B 类材质球 baseColor。
            // 仅 RGB 全 0 视为"无色"跳过（避免把未设置的黑色顶死）。转 0xRRGGBB 供 skyMaterial.color。
            let solidRGB = null;
            if (solid && !texName) {
              const cv = (it.diffuseColor && (it.diffuseColor[0] || it.diffuseColor[1] || it.diffuseColor[2])) ? it.diffuseColor
                       : (it.matBaseColor && (it.matBaseColor[0] || it.matBaseColor[1] || it.matBaseColor[2])) ? it.matBaseColor : null;
              if (cv) {
                const r = Math.max(0, Math.min(255, Math.round(cv[0] * 255)));
                const g = Math.max(0, Math.min(255, Math.round(cv[1] * 255)));
                const bl = Math.max(0, Math.min(255, Math.round(cv[2] * 255)));
                solidRGB = (r << 16) | (g << 8) | bl;
              }
            }
            // 物件类别（用于表面质感与图层归类）；大气/水面单独走
            const objCat = isWater ? 'water' : isAtmo ? 'effect' : classifyMapObject(nm, sh);
            const matKey = (isWater ? 'water' : texName) + '|' + (isWater ? 'w' : isAtmo ? 'a' : isFadeSprite ? 'f' : isCutout ? 'c' : 'o') + '|' + oHsv + '|' + (rmat.colorOverride ? 1 : 0) + '|' + objCat + '|n' + normName + '|d2' + d2Name + '|lt' + ltName + '|c' + (solidRGB == null ? '' : solidRGB.toString(16));
            let imat = matCache.get(matKey);
            if (imat === undefined) {
              if (isWater) {
                imat = waterMaterial({ wireframe });
              } else {
                let tex = null;
                if (texName) { try { tex = await loadTexture(texName); } catch (e) { tex = null; } }
                // 法线贴图：只在有主贴图时才加（TBN 依赖 uv0，无贴图物件不扰动）
                let ntex = null;
                if (showTexture && normName && tex) { try { ntex = await loadTexture(normName); } catch (e) { ntex = null; } }
                // 第二层色/光照图：仅在上色开启时加载（白模模式不需要颜色层，AO 由光照分支自理）
                let d2tex = null, lttex = null;
                if (showTexture && d2Name) { try { d2tex = await loadTexture(d2Name); } catch (e) { d2tex = null; } }
                if (showTexture && ltName) { try { lttex = await loadTexture(ltName); } catch (e) { lttex = null; } }
                // 大气特效不要高光/细节（半透明片），实体物件按类别赋质感
                const surf = isAtmo ? { specStrength: 0, shininess: 8, fresnel: 0.06, detail: 0 } : surfaceParamsFor(objCat, sh);
                imat = skyMaterial({
                  color: (showTexture && solidRGB != null) ? solidRGB : 0xffffff, map: showTexture ? tex : null,
                  normalMap: ntex,
                  diffuse2Map: d2tex, diffuse2Offset: (d2tex && d2Off) ? [d2Off[0], d2Off[1]] : null,
                  lightMap: lttex,
                  side: THREE.DoubleSide,
                  transparent: isAtmo || isFadeSprite,
                  opacity: isFadeSprite ? Math.max(dcA, 0.0) : (isAtmo ? 0.35 : 1.0),
                  depthWrite: !isAtmo && !isFadeSprite,
                  alphaTest: isCutout && tex ? 0.5 : 0.0,
                  baseHsv: rmat.baseHsv || null,
                  colorOverride: !!rmat.colorOverride,
                  specStrength: surf.specStrength, shininess: surf.shininess,
                  fresnel: surf.fresnel, detail: surf.detail,
                });
              }
              matCache.set(matKey, imat);
            }
            const im = new THREE.Mesh(ig, imat);
            im.matrixAutoUpdate = false;
            im.matrix.set.apply(im.matrix, it.matrix); // 列主序变换（对齐游戏 MeshRenderer）
            // 应用 PlaceableDefs 物件缩放（原项目对顶点乘 scale；此处右乘缩放矩阵等效）
            const ps = resolvePlaceableScale(it.resourceName);
            if (ps !== 1) im.matrix.multiply(new THREE.Matrix4().makeScale(ps, ps, ps));
            im.updateMatrixWorld(true);
            im.userData.category = objCat;
            im.userData.resourceName = it.resourceName;
            if (isWater) im.renderOrder = 5; // 水面半透明，在实体之后、云之前
            if (isFadeSprite) im.renderOrder = 4; // 自发光半透明辅助物，在实体之后
            // 雾/风/特效默认不显示（半透明片会糊住画面），用户点该图层才开
            if (objCat === 'effect') im.visible = false;
            catCounts[im.userData.category] = (catCounts[im.userData.category] || 0) + 1;
            mapGroup.add(im);
            // 只把实体物件并入取景范围（大气特效/水面片/近透明辅助物体积可能巨大或无意义，会把相机拉飞）
            if (!isAtmo && !isWater && !isFadeSprite) framing.expandByObject(im);
            placed++;
          } catch (e) { /* 单个物件失败忽略 */ }
        }
        // 收集物/点位标记（烛火/光翼/星座/NPC 等）：无网格，只有坐标，用 Sprite 图标显示。
        // 默认隐藏（归入 marker 图层，MAP_LAYER_DEFAULT_OFF），用户点该图层才显示。
        try {
          const markerGroups = extractLevelMarkers(binAb);
          if (markerGroups.length) {
            // 立体坐标线：从真实点位向【上】引出一小截，标记头浮在点位上方（像图钉/旗子），
            // 底部十字标出真实坐标位置。引线长度按地图尺寸自适应并夹在合理范围。
            const diag = framing.isEmpty() ? 100 : framing.getSize(new THREE.Vector3()).length();
            const stemLen = Math.min(Math.max(diag * 0.025, 2), 40);
            for (const g of markerGroups) {
              const resLabel = g.label; // 子列表按此分组显示
              const col = new THREE.Color(g.color);
              for (const pt of g.points) {
                const baseP = [pt.pos[0], pt.pos[1], pt.pos[2]];         // 真实点位
                const topP = [pt.pos[0], pt.pos[1] + stemLen, pt.pos[2]]; // 标记头（上方）
                // 顶端标记头（恒定屏幕大小），浮在点位上方
                const sp = makeMarkerSprite(g.color, topP);
                sp.visible = false; // 默认不显示
                sp.userData.category = 'marker';
                sp.userData.resourceName = resLabel;
                // 点击时显示：优先该点真实节点名，回退类型标签
                sp.userData.markerLabel = pt.name || g.label;
                sp.userData.markerPos = baseP;       // 真实坐标
                if (pt.detail && pt.detail.length) sp.userData.markerDetail = pt.detail;
                sp.renderOrder = 20; // 标记画在最上层
                mapGroup.add(sp);
                mapMarkerSprites.push(sp); // 供 animate() 每帧做恒定屏幕尺寸更新
                catCounts.marker = (catCounts.marker || 0) + 1;
                // 向上引线：真实点位 → 标记头
                const geo = new THREE.BufferGeometry().setFromPoints([
                  new THREE.Vector3(baseP[0], baseP[1], baseP[2]),
                  new THREE.Vector3(topP[0], topP[1], topP[2]),
                ]);
                const lmat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.5, depthWrite: false, depthTest: false });
                const line = new THREE.Line(geo, lmat);
                line.visible = false; // 随 marker 图层显隐
                line.userData.category = 'marker';
                line.userData.resourceName = resLabel;
                line.userData.markerStem = true; // 统计时跳过，避免子列表数量翻倍
                line.renderOrder = 19;
                mapGroup.add(line);
                // 底部落点：小十字，标出真实坐标位置
                const foot = makeMarkerFoot(g.color, baseP);
                foot.userData.category = 'marker';
                foot.userData.resourceName = resLabel;
                foot.userData.markerStem = true;
                mapGroup.add(foot);
                mapMarkerSprites.push(foot);
              }
            }
          }
        } catch (e) { console.warn('点位标记提取失败', e); }
      } catch (e) { console.warn('物件加载失败', e); }
    }
    overlayBar.style.width = '90%';
    scene.add(mapGroup);
    currentMesh = mapGroup; currentData = { mapData: d, isMap: true };
    curBox = framing;
    setView('reset');
    hintEl.style.display = 'none';
    // 地图信息
    updateMapInfo(d, entry, placed, catCounts);
    // 事件逻辑面板：有事件才显示入口按钮
    setupEventPanel();
    // 关卡信息面板：有传送/任务/音乐等才显示入口
    setupInfoPanel();
    $('objBtn').disabled = false; $('glbBtn').disabled = false; if ($('glbFrameBtn')) $('glbFrameBtn').disabled = false; $('mfBtn').disabled = false;
    overlayBar.style.width = '100%';
    toast(`${levelNameOf(entry)}：地形 ${(d.indexCount/3)|0} 面 + 物件 ${placed}`);
    if (isMobile()) setCollapsed(true);
  } catch (e) {
    console.error(e);
    toast('地形解析失败: ' + e.message, true);
  } finally {
    setTimeout(() => overlay.classList.remove('show'), 250);
  }
}

// 地图物件细分类：按资源名 + shader 归类，便于按图层显隐。
// effect（云/雾/特效）与 terrain（地形）在别处判定；此处只细分实体物件。
function classifyMapObject(name, shader) {
  const n = (name || '');
  const s = (shader || '');
  // 灯烛/火/光源类（可交互物、氛围光）
  if (/Candle|Fire|Sconce|Brazier|Bonfire|Lantern|Lighthorn|GodLight|LightShaft|Bell|Chime|Torch|Flame|Lamp/i.test(n)) return 'light';
  // 壁画/雕像/图腾/祭坛/星座/符文（叙事与收集物）
  if (/Mural|Painting|Statue|Ancestor|Constellation|Shrine|Symbol|Motif|Mote|Alter|Altar|Totem|Tablet|Relic|Rune|Glyph/i.test(n)) return 'art';
  // 门/机关/桥/平台/台阶/传送等结构机关
  if (/Door|Gate|Puzzle|Platform|Bridge|Wall|Steps|Stair|Frame|Elevator|Grate|Portal|Launch|Skyway|Trigger|Elevator/i.test(n)) return 'structure';
  // 建筑主体（庙、塔、房、店、船体等）
  if (/Temple|Stupa|Tower|Shop|House|Canopy|Boat|Ship|Pillar|Column|Roof|Building|Hut|Tent|Aviary|Colosseum|Engine/i.test(n)) return 'building';
  // 植被
  if (/Flower|Plant|Tree|Bush|Grass|Canopy|Darkshroom|Foliage|Leaf|Vine|Mushroom|Seaweed|Coral|Kelp/i.test(n) || /Foliage|Grass|Leaf/i.test(s)) return 'vegetation';
  // 岩石/地貌（自然堆叠物）
  if (/Rock|Cliff|Hill|Dune|Sand|Mountain|Stone|Boulder|Cave|Crag|Reef|Ice|Snow/i.test(n)) return 'rock';
  // 道具/家具/杂物
  if (/Prop|Jar|Crate|Table|Bench|Desk|Backpack|Scroll|Bucket|Pillow|Rug|Box|Barrel|Basket|Pot|Vase|Book|Debris|Flag|Rope|Cloth|Fabric|Paper|Map/i.test(n)) return 'prop';
  // 其余归杂项
  return 'misc';
}

// 按物件类别/着色器返回表面质感参数（仅温和高光 + 轻边缘光；detail 已弃用=0，
// 因面法线混合会把低模凸显成棱块）。参数含义见 skyMaterial：specStrength/shininess/fresnel。
function surfaceParamsFor(category, shader) {
  const s = (shader || '').toLowerCase();
  // 金属/水晶/宝石类：较强而集中的高光
  if (/metal|gold|crystal|gem|glass|mirror/.test(s)) return { specStrength: 0.35, shininess: 64, fresnel: 0.18, detail: 0 };
  switch (category) {
    case 'rock':       return { specStrength: 0.04, shininess: 12, fresnel: 0.06, detail: 0 };
    case 'building':   return { specStrength: 0.08, shininess: 24, fresnel: 0.07, detail: 0 };
    case 'structure':  return { specStrength: 0.10, shininess: 28, fresnel: 0.07, detail: 0 };
    case 'art':        return { specStrength: 0.12, shininess: 32, fresnel: 0.08, detail: 0 };
    case 'light':      return { specStrength: 0.18, shininess: 40, fresnel: 0.12, detail: 0 };
    case 'vegetation': return { specStrength: 0.03, shininess: 12, fresnel: 0.10, detail: 0 };
    case 'prop':       return { specStrength: 0.09, shininess: 24, fresnel: 0.07, detail: 0 };
    case 'terrain':    return { specStrength: 0.03, shininess: 10, fresnel: 0.05, detail: 0 };
    default:           return { specStrength: 0.06, shininess: 16, fresnel: 0.06, detail: 0 };
  }
}
// 默认关闭（不加载显示）的图层：雾/风/特效（半透明片糊画面）、点位标记（收集物图标）。
const MAP_LAYER_DEFAULT_OFF = new Set(['effect', 'marker']);
// 图层元信息：key → {label, 默认属于 solid 家族}
const MAP_LAYER_META = {
  marker: { label: '点位标记（烛火/光翼/星座/NPC等）' },
  terrain: { label: '地形' },
  rock: { label: '岩石/地貌' },
  building: { label: '建筑' },
  structure: { label: '门/机关/结构' },
  art: { label: '壁画/雕像/星座' },
  light: { label: '灯烛/火/光源' },
  vegetation: { label: '植被' },
  prop: { label: '道具/家具' },
  misc: { label: '其他物件' },
  water: { label: '水面' },
  cloud: { label: '云' },
  effect: { label: '雾/风/特效' },
};

// 顶端标记头纹理：实心小圆点 + 深色描边（参考 TGCL 编辑器的点位画法，干净小巧）。按颜色缓存。
const _markerTexCache = new Map();
function markerSpriteTexture(color) {
  if (_markerTexCache.has(color)) return _markerTexCache.get(color);
  const S = 128;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const cx = S / 2, cy = S / 2, r = S * 0.32;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = S * 0.05; ctx.strokeStyle = 'rgba(8,10,16,0.85)'; ctx.stroke();
  // 高光小点，稍微有点体积感
  ctx.beginPath(); ctx.arc(cx - r * 0.3, cy - r * 0.3, r * 0.28, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  _markerTexCache.set(color, tex);
  return tex;
}
// 地面落点纹理：空心小十字（标出竖线落到地面的投影位置）。按颜色缓存。
const _markerFootTexCache = new Map();
function markerFootTexture(color) {
  if (_markerFootTexCache.has(color)) return _markerFootTexCache.get(color);
  const S = 128;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const cx = S / 2, cy = S / 2, r = S * 0.34;
  ctx.lineCap = 'round';
  const draw = (w, col) => {
    ctx.lineWidth = w; ctx.strokeStyle = col;
    ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
  };
  draw(S * 0.13, 'rgba(8,10,16,0.7)'); // 外描边
  draw(S * 0.06, color);               // 主色
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  _markerFootTexCache.set(color, tex);
  return tex;
}
// 创建一个点位标记 Sprite（世界坐标 pos）。尺寸恒定屏幕大小（不随远近缩放，像光标一样），
// 由 animate() 每帧按相机距离调整 scale。
function makeMarkerSprite(color, pos) {
  // depthTest:false → 标记始终浮在地形/物件之上，不会被挡住（用户要求"移到地形上面"）。
  const mat = new THREE.SpriteMaterial({ map: markerSpriteTexture(color), transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: true });
  const sp = new THREE.Sprite(mat);
  sp.position.set(pos[0], pos[1], pos[2]);
  sp.userData.screenScale = 0.022; // 目标屏幕大小系数（小巧），每帧×距离得世界 scale
  return sp;
}
// 地面落点小十字 Sprite（比标记头略小）
function makeMarkerFoot(color, pos) {
  const mat = new THREE.SpriteMaterial({ map: markerFootTexture(color), transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: true });
  const sp = new THREE.Sprite(mat);
  sp.position.set(pos[0], pos[1], pos[2]);
  sp.visible = false;
  sp.renderOrder = 19;
  sp.userData.screenScale = 0.018;
  return sp;
}

// 标记类可显隐对象：Mesh / Sprite / Line（点位竖线也算）
function isMapVisObject(o) { return o.isMesh || o.isSprite || o.isLine; }

function setMapCategoryVisible(cat, visible) {
  if (!mapGroup) return;
  mapGroup.traverse(o => { if (isMapVisObject(o) && o.userData.category === cat) o.visible = visible; });
  if (cat === 'marker' && !visible && markerTip) markerTip.style.display = 'none';
}

// 切换某类型下、指定资源名的所有建模显隐
function setMapObjectVisible(cat, resName, visible) {
  if (!mapGroup) return;
  mapGroup.traverse(o => {
    if (isMapVisObject(o) && o.userData.category === cat && (o.userData.resourceName || '未命名') === resName) o.visible = visible;
  });
}

// 统计某类型下按资源名分组的建模：{ resName: count }。跳过竖线/落点(markerStem)避免重复计数。
function groupMapObjects(cat) {
  const g = new Map();
  if (mapGroup) mapGroup.traverse(o => {
    if (isMapVisObject(o) && o.userData.category === cat && !o.userData.markerStem) {
      const rn = o.userData.resourceName || '未命名';
      g.set(rn, (g.get(rn) || 0) + 1);
    }
  });
  return g;
}

function updateMapInfo(d, entry, placed, catCounts) {
  const size = curBox.getSize(new THREE.Vector3());
  const cc = catCounts || { terrain: 1 };
  infoEl.style.display = 'block';
  // 列出所有类型（含数量为 0 的）。点标签左侧的三角展开子列表逐个勾选，点标签本体整类切换。实时渲染，无 checkbox。
  let layerRows = '';
  for (const key of Object.keys(MAP_LAYER_META)) {
    const n = cc[key] || 0;
    const label = MAP_LAYER_META[key].label;
    const canExpand = n > 0;
    const off = MAP_LAYER_DEFAULT_OFF.has(key); // 默认关闭的图层（如特效）初始为 off
    layerRows +=
      `<div class="maplayer-item" data-cat="${key}">` +
        `<div class="maplayer ${off ? 'off' : 'on'}" data-cat="${key}">` +
          `<span class="expander${canExpand ? '' : ' none'}">${canExpand ? '▸' : ''}</span>` +
          `<span class="lbl">${label}</span><span class="cnt">${n}</span>` +
        `</div>` +
        `<div class="maplayer-sub" data-cat="${key}"></div>` +
      `</div>`;
  }
  infoEl.innerHTML =
    `<div class="name">${levelNameOf(entry)} · 地图</div>` +
    `<div class="dim">版本 0x${d.version.toString(16)} · 关卡地形</div>` +
    `<div class="dim">尺寸 ${size.x.toFixed(0)} × ${size.y.toFixed(0)} × ${size.z.toFixed(0)}</div>` +
    `<div class="dim">顶点 ${d.vertexCount.toLocaleString()} · 面 ${((d.indexCount/3)|0).toLocaleString()}</div>` +
    `<div class="dim">地形块 ${d.chunkCount} · 物件 ${placed || 0}</div>` +
    `<div class="dim" style="margin-top:6px;border-top:1px solid rgba(255,255,255,.12);padding-top:6px">显示类型（点标签整类切换 · 点▸展开逐个）</div>` +
    `<div class="maplayers">${layerRows}</div>`;

  // 用一个 sub 列表构建函数，展开时按资源名分组列出，可逐个/整体勾选
  function buildSub(cat, subEl) {
    const g = groupMapObjects(cat);
    if (!g.size) { subEl.innerHTML = `<div class="sub-empty">（无建模）</div>`; return; }
    let rows = '';
    const off = MAP_LAYER_DEFAULT_OFF.has(cat); // 默认关闭图层的子行也初始为 off
    for (const [rn, cnt] of g) {
      const short = rn.length > 26 ? rn.slice(0, 24) + '…' : rn;
      rows += `<div class="sub-row ${off ? 'off' : 'on'}" data-cat="${cat}" data-res="${rn.replace(/"/g, '&quot;')}" title="${rn}">` +
        `<span class="dot"></span><span class="sub-lbl">${short}</span><span class="cnt">${cnt}</span></div>`;
    }
    subEl.innerHTML = rows;
    subEl.querySelectorAll('.sub-row').forEach(row => {
      row.onclick = (e) => {
        e.stopPropagation();
        const on = row.classList.toggle('on');
        row.classList.toggle('off', !on);
        setMapObjectVisible(row.dataset.cat, row.dataset.res, on);
        syncCatState(cat);
      };
    });
  }

  // 根据子行状态回写类型标签的整体开关外观
  function syncCatState(cat) {
    const head = infoEl.querySelector(`.maplayer[data-cat="${cat}"]`);
    const sub = infoEl.querySelector(`.maplayer-sub[data-cat="${cat}"]`);
    if (!head || !sub) return;
    const rows = sub.querySelectorAll('.sub-row');
    if (!rows.length) return;
    const anyOn = [...rows].some(r => r.classList.contains('on'));
    head.classList.toggle('on', anyOn);
    head.classList.toggle('off', !anyOn);
  }

  infoEl.querySelectorAll('.maplayer').forEach(head => {
    const cat = head.dataset.cat;
    const item = head.closest('.maplayer-item');
    const sub = item.querySelector('.maplayer-sub');
    const expander = head.querySelector('.expander');
    // 点▸：展开/收起子列表（首次展开时懒构建）
    if (expander && !expander.classList.contains('none')) {
      expander.onclick = (e) => {
        e.stopPropagation();
        const open = item.classList.toggle('open');
        expander.textContent = open ? '▾' : '▸';
        if (open && !sub.dataset.built) { buildSub(cat, sub); sub.dataset.built = '1'; }
      };
    }
    // 点标签本体：整类切换，并同步子行
    head.onclick = () => {
      const on = head.classList.toggle('on');
      head.classList.toggle('off', !on);
      setMapCategoryVisible(cat, on);
      sub.querySelectorAll('.sub-row').forEach(r => {
        r.classList.toggle('on', on); r.classList.toggle('off', !on);
      });
    };
  });
  $('stVerts').textContent = d.vertexCount.toLocaleString();
  $('stFaces').textContent = ((d.indexCount/3)|0).toLocaleString();
  $('stVer').textContent = '0x' + d.version.toString(16);
  $('stUv').textContent = '顶点色';
}

// 目标类型 → 中文（事件下游引用展示用；未列出的显示原名）
const EVENT_TARGET_CN = {
  Clump: '节点集合', LevelLink: '关卡门', CandleObject: '烛火', WingBuff: '光翼',
  Npc: 'NPC', Portal: '传送门', LevelMesh: '网格', TerrainBlob: '地形块',
};
// 下游字段名 → 中文
const EVENT_FIELD_CN = {
  events: '触发', onActive: '激活时', onInactive: '失活时', onFinish: '结束时',
  onClose: '关闭时', onTap: '点击时', afterfireOneAtRandomEvents: '随机后触发',
  shoutMarkers: '喊话点', beamMeshes: '光束网格', levelLink: '关卡门', effects: '特效',
  series: '事件系列', outTarget: '输出目标',
};
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// 装配事件逻辑面板：地图加载后调用。无事件则隐藏入口。
function setupEventPanel() {
  const btn = $('eventBtn'), panel = $('eventPanel');
  if (!btn || !panel) return;
  const evs = (mapEvents && mapEvents.events) || [];
  if (!evs.length) { btn.style.display = 'none'; panel.style.display = 'none'; return; }
  btn.style.display = '';
  btn.classList.remove('active');
  panel.style.display = 'none';
  $('evCount').textContent = evs.length;
  renderEventList('');
  btn.onclick = () => {
    const open = panel.style.display === 'none';
    panel.style.display = open ? 'flex' : 'none';
    btn.classList.toggle('active', open);
    if (open) {
      $('evSearch').focus();
      const ip = $('infoPanel'); if (ip) ip.style.display = 'none';
      const ib = $('infoPanelBtn'); if (ib) ib.classList.remove('active');
    }
  };
  $('evClose').onclick = () => { panel.style.display = 'none'; btn.classList.remove('active'); };
  $('evSearch').oninput = (e) => renderEventList(e.target.value.trim().toLowerCase());
  $('evCopy').onclick = () => copyEventsText();
}

// 把当前搜索过滤后的事件列表转成纯文本并复制到剪贴板
async function copyEventsText() {
  const evs = filterEvents(($('evSearch').value || '').trim().toLowerCase());
  if (!evs.length) return;
  const lines = [`# 事件逻辑（共 ${evs.length} 条）`, ''];
  evs.forEach((ev, i) => {
    lines.push(`${i + 1}. ${ev.typeCn}（${ev.type}）  [${ev.autoStart ? '自动启动' : '待触发'}]`);
    if (ev.eventName) lines.push(`   名称: ${ev.eventName}`);
    for (const p of (ev.props || [])) lines.push(`   ${p.label}: ${p.value}`);
    for (const o of (ev.outs || [])) {
      const fcn = EVENT_FIELD_CN[o.field] || o.field;
      const tcn = EVENT_TARGET_CN[o.targetType] || o.targetType;
      lines.push(`   ↳ ${fcn} → ${tcn}`);
    }
    lines.push('');
  });
  const text = lines.join('\n');
  const btn = $('evCopy');
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // 回退：用隐藏 textarea + execCommand（file:// 或无剪贴板权限时）
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
  }
  btn.classList.add('done'); btn.textContent = '✓ 已复制';
  setTimeout(() => { btn.classList.remove('done'); btn.textContent = '⧉ 复制'; }, 1600);
}

// 按查询过滤事件（供列表渲染与复制共用）
function filterEvents(q) {
  const evs = (mapEvents && mapEvents.events) || [];
  if (!q) return evs;
  return evs.filter(ev => (ev.eventName || '').toLowerCase().includes(q)
    || ev.type.toLowerCase().includes(q) || ev.typeCn.toLowerCase().includes(q));
}

// 关卡信息面板：传送连接 / 任务 / 音乐 / 对白
function infoHasContent() {
  const m = mapInfo;
  return !!(m && (m.links.length || m.quests.length || m.music.length || m.dialogs.length || m.worldName));
}
function setupInfoPanel() {
  const btn = $('infoPanelBtn'), panel = $('infoPanel');
  if (!btn || !panel) return;
  if (!infoHasContent()) { btn.style.display = 'none'; panel.style.display = 'none'; return; }
  btn.style.display = '';
  btn.classList.remove('active');
  panel.style.display = 'none';
  renderInfoList();
  btn.onclick = () => {
    const open = panel.style.display === 'none';
    panel.style.display = open ? 'flex' : 'none';
    btn.classList.toggle('active', open);
    // 与事件面板互斥，避免重叠
    if (open) { $('eventPanel').style.display = 'none'; const eb = $('eventBtn'); if (eb) eb.classList.remove('active'); }
  };
  $('ipClose').onclick = () => { panel.style.display = 'none'; btn.classList.remove('active'); };
  $('ipCopy').onclick = () => copyInfoText();
}
function renderInfoList() {
  const el = $('ipList');
  const m = mapInfo;
  if (!m) { el.innerHTML = `<div class="ev-empty">无信息</div>`; return; }
  let html = '';
  const sec = (title, count, rowsHtml) =>
    `<div class="ip-sec"><div class="ip-sec-title">${title}<span class="cnt">${count}</span></div>${rowsHtml}</div>`;
  if (m.worldName) {
    html += sec('世界', 1, `<div class="ip-row"><span class="ip-to">${esc(m.worldName)}</span></div>`);
  }
  if (m.links.length) {
    const rows = m.links.map(l =>
      `<div class="ip-row">${l.link ? esc(l.link) + ' → ' : ''}<span class="ip-to">${esc(l.to)}</span> <span class="ip-kind">${esc(l.kind)}</span></div>`
    ).join('');
    html += sec('传送连接', m.links.length, rows);
  }
  if (m.quests.length) {
    const rows = m.quests.map(q => `<div class="ip-row">${esc(q)}</div>`).join('');
    html += sec('任务', m.quests.length, rows);
  }
  if (m.music.length) {
    const rows = m.music.map(x => `<div class="ip-row">${esc(x)}</div>`).join('');
    html += sec('背景音乐', m.music.length, rows);
  }
  if (m.dialogs.length) {
    const rows = m.dialogs.map(x => `<div class="ip-row">${esc(x)}</div>`).join('');
    html += sec('对白提示', m.dialogs.length, rows);
  }
  el.innerHTML = html || `<div class="ev-empty">无信息</div>`;
}
async function copyInfoText() {
  const m = mapInfo;
  if (!m) return;
  const lines = ['# 关卡信息', ''];
  if (m.worldName) lines.push('世界: ' + m.worldName, '');
  if (m.links.length) {
    lines.push(`## 传送连接 (${m.links.length})`);
    for (const l of m.links) lines.push(`- ${l.link ? l.link + ' → ' : ''}${l.to}（${l.kind}）`);
    lines.push('');
  }
  if (m.quests.length) { lines.push(`## 任务 (${m.quests.length})`); for (const q of m.quests) lines.push('- ' + q); lines.push(''); }
  if (m.music.length) { lines.push(`## 背景音乐 (${m.music.length})`); for (const x of m.music) lines.push('- ' + x); lines.push(''); }
  if (m.dialogs.length) { lines.push(`## 对白提示 (${m.dialogs.length})`); for (const x of m.dialogs) lines.push('- ' + x); lines.push(''); }
  const text = lines.join('\n');
  const btn = $('ipCopy');
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
  }
  btn.classList.add('done'); btn.textContent = '✓ 已复制';
  setTimeout(() => { btn.classList.remove('done'); btn.textContent = '⧉ 复制'; }, 1600);
}

// 渲染事件列表（按查询过滤：匹配事件名/类型/中文类型）
function renderEventList(q) {
  const listEl = $('evList');
  const shown = filterEvents(q);
  if (!shown.length) { listEl.innerHTML = `<div class="ev-empty">无匹配事件</div>`; return; }
  let html = '';
  for (const ev of shown) {
    const badge = ev.autoStart
      ? `<span class="ev-badge auto" title="关卡加载即自动启动">自动</span>`
      : `<span class="ev-badge wait" title="等待上游/事件名触发">待触发</span>`;
    const nameRow = ev.eventName
      ? `<div class="ev-name"><b>名称</b> ${esc(ev.eventName)}</div>` : '';
    let props = '';
    if (ev.props && ev.props.length) {
      props = `<div class="ev-props">` +
        ev.props.map(p => `<span class="ev-prop"><b>${esc(p.label)}</b> ${esc(p.value)}</span>`).join('') +
        `</div>`;
    }
    let outs = '';
    if (ev.outs.length) {
      const rows = ev.outs.slice(0, 12).map(o => {
        const fcn = EVENT_FIELD_CN[o.field] || o.field;
        const tcn = EVENT_TARGET_CN[o.targetType] || o.targetType;
        return `<div class="ev-out"><span class="of">${esc(fcn)}</span> → ${esc(tcn)}</div>`;
      }).join('');
      const more = ev.outs.length > 12 ? `<div class="ev-out">…共 ${ev.outs.length} 项</div>` : '';
      outs = `<div class="ev-outs">${rows}${more}</div>`;
    }
    html += `<div class="ev-item">` +
      `<div class="ev-row1"><span class="ev-type">${esc(ev.typeCn)}</span>${badge}</div>` +
      nameRow + props + outs + `</div>`;
  }
  listEl.innerHTML = html;
}

