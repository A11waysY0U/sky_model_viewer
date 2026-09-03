/* ===================== 事件 ===================== */
const apkInput = $('apkInput');
$('openApkBtn').onclick = () => apkInput.click();
apkInput.onchange = () => { if (apkInput.files[0]) importApk(apkInput.files[0]); apkInput.value = ''; };
$('objBtn').onclick = exportOBJ;
$('glbBtn').onclick = exportGLB;
$('wireBtn').onclick = (e) => {
  wireframe = !wireframe;
  e.currentTarget.classList.toggle('active', wireframe);
  if (currentMesh) currentMesh.traverse(o => { if (o.material && 'wireframe' in o.material) o.material.wireframe = wireframe; });
};
$('gridBtn').onclick = (e) => {
  showGrid = !showGrid;
  e.currentTarget.classList.toggle('active', showGrid);
  gridHelper.visible = showGrid; axesHelper.visible = showGrid;
};
// 全局上色总开关：默认关闭=白模。点击后全场景（人物/地图/单模型）统一上色上贴图。
// 用 uColorOn 控制，遍历所有 skyMaterial 材质切换；新加载的材质会读全局 colorOn 初值。
$('dyeBtn').onclick = (e) => {
  colorOn = !colorOn;
  e.currentTarget.classList.toggle('active', colorOn);
  applyColorOn();
  toast(colorOn ? '已上色' : '已切换到白模');
};

// 平移方向盘：点按钮开/关，方向键沿屏幕平面移动画面（同时移相机与目标点，保持朝向）。
const _panBtn = $('panBtn'), _panpad = $('panpad');
const _crosshair = $('crosshair');
if (_panBtn && _panpad) {
  _panBtn.onclick = (e) => {
    const on = !_panpad.classList.contains('show');
    _panpad.classList.toggle('show', on);
    if (_crosshair) _crosshair.classList.toggle('show', on);
    e.currentTarget.classList.toggle('active', on);
  };
  const _panRight = new THREE.Vector3(), _panUp = new THREE.Vector3(), _panFwd = new THREE.Vector3(), _panMove = new THREE.Vector3();
  // 无人机式移动：forward 沿视线前进 / back 后退 / left|right 横移。速度慢，步长按视距自适应。
  function panStep(dir) {
    if (!camera || !controls) return;
    // 步长基准用模型包围盒尺寸（不随前进变小），前进也不会越走越慢/停住；无模型时退回视距
    let base;
    if (curBox && !curBox.isEmpty()) base = curBox.getSize(_panMove).length();
    else base = camera.position.distanceTo(controls.target);
    const step = Math.max(base * 0.008, 1e-5); // 慢速：基准的 0.8%
    camera.matrixWorld.extractBasis(_panRight, _panUp, _panFwd); // 相机右/上/后向量（_panFwd 指向相机背后）
    _panMove.set(0, 0, 0);
    if (dir === 'left') _panMove.addScaledVector(_panRight, -step);
    else if (dir === 'right') _panMove.addScaledVector(_panRight, step);
    else if (dir === 'forward') _panMove.addScaledVector(_panFwd, -step); // 前进=沿视线方向（-forward）
    else if (dir === 'back') _panMove.addScaledVector(_panFwd, step);
    camera.position.add(_panMove);
    controls.target.add(_panMove);
    controls.update();
  }
  // 回中：把目标点移回模型包围盒中心（相机跟着平移，朝向不变）
  function panReset() {
    if (!camera || !controls || !curBox || curBox.isEmpty()) return;
    const c = curBox.getCenter(new THREE.Vector3());
    _panMove.copy(c).sub(controls.target);
    camera.position.add(_panMove);
    controls.target.add(_panMove);
    controls.update();
  }
  // 按住连续平移
  let _panTimer = null;
  const startPan = (dir) => {
    if (dir === 'reset') { panReset(); return; }
    panStep(dir);
    clearInterval(_panTimer);
    _panTimer = setInterval(() => panStep(dir), 60);
  };
  const stopPan = () => { clearInterval(_panTimer); _panTimer = null; };
  _panpad.querySelectorAll('.pb[data-pan]').forEach(btn => {
    const dir = btn.dataset.pan;
    btn.addEventListener('pointerdown', (ev) => { ev.preventDefault(); startPan(dir); });
    btn.addEventListener('pointerup', stopPan);
    btn.addEventListener('pointerleave', stopPan);
    btn.addEventListener('pointercancel', stopPan);
    // 手机长按连续平移时，阻止浏览器弹出「复制/搜索/全选」系统菜单与文本选择
    btn.addEventListener('contextmenu', (ev) => ev.preventDefault());
    btn.addEventListener('selectstart', (ev) => ev.preventDefault());
    // 部分安卓内核在 touchstart 触发长按选择，需在此阻止默认
    btn.addEventListener('touchstart', (ev) => ev.preventDefault(), { passive: false });
  });
  // 整个方向盘容器兜底屏蔽长按菜单
  _panpad.addEventListener('contextmenu', (ev) => ev.preventDefault());
}
// 把全局 colorOn 应用到场景中所有 skyMaterial 材质
function applyColorOn() {
  const v = colorOn ? 1 : 0;
  scene.traverse((o) => {
    const m = o.material;
    if (!m) return;
    const mats = Array.isArray(m) ? m : [m];
    for (const mm of mats) {
      if (mm && mm.uniforms && mm.uniforms.uColorOn) mm.uniforms.uColorOn.value = v;
    }
  });
}

const _dressBtn = $('dressBtn');
if (_dressBtn) _dressBtn.onclick = () => toggleDressMode();
const _mapBtn = $('mapBtn');
if (_mapBtn) _mapBtn.onclick = () => toggleMapMode();

// 信息卡折叠：卡内 × 收起，点 ⓘ 展开
const _infoToggle = $('infoToggle');
if (_infoToggle) {
  _infoToggle.onclick = () => {
    infoEl.classList.remove('collapsed');
    _infoToggle.style.display = 'none';
  };
}
// 每次信息卡内容更新后，补一个收起按钮（内容由 innerHTML 覆盖，故用 MutationObserver）
function attachInfoClose() {
  if (!infoEl || infoEl.querySelector('#infoClose')) return;
  if (infoEl.style.display === 'none' || !infoEl.innerHTML.trim()) return;
  const btn = document.createElement('div');
  btn.id = 'infoClose'; btn.textContent = '×'; btn.title = '收起';
  btn.onclick = (e) => {
    e.stopPropagation();
    infoEl.classList.add('collapsed');
    if (_infoToggle) _infoToggle.style.display = 'flex';
  };
  infoEl.appendChild(btn);
}
if (infoEl) new MutationObserver(attachInfoClose).observe(infoEl, { childList: true, attributes: true, attributeFilter: ['style'] });

// 视图立方
document.querySelectorAll('.vc').forEach(vc => vc.onclick = () => setView(vc.dataset.view));

// 折叠侧栏
const sidebar = $('sidebar');
const handle = $('handle');
const isMobile = () => window.matchMedia('(max-width:640px)').matches;
// 按当前真实状态（是否折叠 / 是否移动端）重算把手的方向与位置。
// 抽成独立函数，让初始化、点击、窗口尺寸变化三条路径都走同一套逻辑，避免内联 left 残留导致把手悬空/压住内容。
function positionHandle() {
  const collapsed = sidebar.classList.contains('collapsed');
  handle.textContent = collapsed ? '›' : '‹';
  // 展开时把手贴在侧栏右边缘外侧（用实际渲染宽度，避免侧栏被内容撑宽后把手卡在中间）；折叠时贴屏幕左边。
  handle.style.left = collapsed ? '0' : (sidebar.offsetWidth + 'px');
}
function setCollapsed(collapsed) {
  sidebar.classList.toggle('collapsed', collapsed);
  positionHandle();
  setTimeout(onResize, 220);
}
handle.onclick = () => setCollapsed(!sidebar.classList.contains('collapsed'));
// 移动端：初始折叠
if (isMobile()) sidebar.classList.add('collapsed');
// 初始定位一次；窗口尺寸/断点变化时重定位，修复把手卡在错位置的问题
positionHandle();
window.addEventListener('resize', positionHandle);

$('searchInput').oninput = (e) => {
  const q = e.target.value.trim().toLowerCase();
  filtered = q ? meshEntries.filter(x => x.name.toLowerCase().includes(q)) : meshEntries;
  renderList();
};

// 拖放
viewport.addEventListener('dragover', e => e.preventDefault());
viewport.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (/\.(apk|zip|xapk|apks|ipa)$/i.test(f.name)) importApk(f);
  else loadSingleMesh(f);
});

renderList();
initThree();
