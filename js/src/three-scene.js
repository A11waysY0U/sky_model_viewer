/* ===================== Three.js ===================== */
function initThree() {
  scene = new THREE.Scene();
  // 背景底色对齐参考 APP（深灰，能衬出角色暗部轮廓，避免纯黑吞掉手脚/身体）。
  scene.background = new THREE.Color(0x1b1f27);
  const w = viewport.clientWidth, h = viewport.clientHeight;
  camera = new THREE.PerspectiveCamera(45, w / h, 0.001, 100000);
  camera.position.set(3, 3, 5);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  // 按 GPU 顶点 uniform 上限推算可用骨数，避免手机端蒙皮着色器超限链接失败（角色不显示）。
  try {
    const gl = renderer.getContext();
    const maxVec = gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS) || 256;
    // 预留 ~40 个向量给相机/法线矩阵及其它 uniform，其余 /4 得骨数上限。
    const budget = Math.max(4, Math.floor((maxVec - 40) / 4));
    skyMaxBones = Math.min(SKY_MAX_BONES, budget);
  } catch (e) { skyMaxBones = 64; }
  // 颜色管线：shader 内做 srgb2lin(采样)→线性光照→lin2srgb(softClip 输出编码)。
  // 因 shader 已手动完成 linear→sRGB 显示编码，渲染器输出保持 Linear（不重复编码）。
  // 关键：暗部黑死的根因是曾漏掉输出端 gamma 编码，现已在 softClip 内补上。
  THREE.ColorManagement.enabled = false;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  viewport.appendChild(renderer.domElement);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.minDistance = 1e-4;   // 放开近距离，可无限放大
  controls.maxDistance = Infinity; // 放开远距离，可无限缩小
  controls.zoomToCursor = true;  // 朝光标/手指位置缩放，可怼近任意物件而非只往场景中心
  controls.screenSpacePanning = true; // 屏幕空间平移，前后左右跟手

  controls.zoomSpeed = 1.2;
  // 缩放/旋转/平移时实时更新裁剪面，任意缩放级别都不裁剪
  controls.addEventListener('change', updateClip);
  // 光照对齐原渲染器: ambient(118) + key(244)*NdotL + fill(150,160,176)*NdotF
  hemiLight = new THREE.HemisphereLight(0xffffff, 0x33384a, 0.93); // ~ambient 118/255
  scene.add(hemiLight);
  sunLight = new THREE.DirectionalLight(0xffffff, 0.96);          // key 244/255（关卡环境会驱动方向/色）
  sunLight.position.set(5, 10, 7); scene.add(sunLight);
  fillLight = new THREE.DirectionalLight(0x96a0b0, 0.3);          // fill (150,160,176)
  fillLight.position.set(-5, -3, -7); scene.add(fillLight);
  gridHelper = new THREE.GridHelper(20, 20, 0x5a6a86, 0x3a4560);
gridHelper.name = '_grid'; gridHelper.visible = showGrid; scene.add(gridHelper);
axesHelper = new THREE.AxesHelper(1.5);
axesHelper.name = '_axes'; axesHelper.visible = showGrid; scene.add(axesHelper);
  window.addEventListener('resize', onResize);
  initMarkerPicking();
  animate();
}

// 点位标记点击拾取：点标记头显示其名称 + 坐标（浮层 tooltip）。
let markerTip = null;
const _markerRay = new THREE.Raycaster();
const _markerNdc = new THREE.Vector2();
function initMarkerPicking() {
  markerTip = document.createElement('div');
  markerTip.id = 'markerTip';
  markerTip.style.cssText = 'position:absolute;z-index:50;display:none;pointer-events:none;' +
    'padding:5px 9px;border-radius:7px;font-size:12px;line-height:1.4;max-width:260px;word-break:break-all;' +
    'background:rgba(16,20,28,.92);color:#fff;border:1px solid var(--accent);' +
    'box-shadow:0 3px 12px rgba(0,0,0,.5);transform:translate(-50%,-115%);';
  viewport.appendChild(markerTip);
  // 用 pointerup + 未拖拽判定，避免和 OrbitControls 旋转冲突
  let downX = 0, downY = 0, moved = false;
  renderer.domElement.addEventListener('pointerdown', e => {
    downX = e.clientX; downY = e.clientY; moved = false;
  });
  renderer.domElement.addEventListener('pointermove', e => {
    if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) moved = true;
    // 旋转直接沿用 OrbitControls 默认行为（绕当前 target），不再吸附回模型中心，避免视角被拉回。
  });
  renderer.domElement.addEventListener('pointerup', e => {
    if (moved) return; // 拖拽视角，不当作点击
    pickMarkerAt(e);
  });
}
function pickMarkerAt(e) {
  if (!markerTip) return;
  // 只在标记图层可见时才拾取
  const heads = (mapMarkerSprites || []).filter(o => o.isSprite && o.visible && o.userData.markerLabel);
  if (!heads.length) { markerTip.style.display = 'none'; return; }
  const rect = renderer.domElement.getBoundingClientRect();
  _markerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _markerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  _markerRay.setFromCamera(_markerNdc, camera);
  const hits = _markerRay.intersectObjects(heads, false);
  if (hits.length) {
    const o = hits[0].object;
    const p = o.userData.markerPos || [0, 0, 0];
    let html = `<b>${o.userData.markerLabel}</b><br>X ${p[0].toFixed(1)}　Y ${p[1].toFixed(1)}　Z ${p[2].toFixed(1)}`;
    const det = o.userData.markerDetail;
    if (det && det.length) {
      const safe = det.map(s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])));
      html += '<br><span style="opacity:.55">' + safe.join('<br>') + '</span>';
    }
    markerTip.innerHTML = html;
    markerTip.style.left = (e.clientX - rect.left) + 'px';
    markerTip.style.top = (e.clientY - rect.top) + 'px';
    markerTip.style.display = 'block';
  } else {
    markerTip.style.display = 'none';
  }
}
function onResize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

let fpsLast = performance.now(), fpsFrames = 0;
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  if (waterMats.length) {
    const t = performance.now() * 0.001;
    for (const m of waterMats) m.uniforms.uTime.value = t;
  }
  // 骨骼动画推进：按 fps 循环，更新蒙皮矩阵
  if (animState.playing && animState.pack && animState.frameCount > 1) {
    const now = performance.now();
    const dt = animState.lastT ? (now - animState.lastT) / 1000 : 0;
    animState.lastT = now;
    animState.time += dt * animState.speed;
    const totalDur = animState.frameCount / animState.fps;
    let frameIdx;
    if (animState.time >= totalDur) {
      if (animState.loop) {
        animState.time -= totalDur * Math.floor(animState.time / totalDur);
        frameIdx = Math.floor(animState.time * animState.fps) % animState.frameCount;
      } else {
        // 非循环：停在末帧并暂停
        animState.time = totalDur;
        animState.playing = false;
        frameIdx = animState.frameCount - 1;
        updateAnimUI();
      }
    } else {
      frameIdx = Math.floor(animState.time * animState.fps) % animState.frameCount;
    }
    applyAnimFrame(frameIdx);
    updateAnimSeek(frameIdx);
  } else {
    animState.lastT = performance.now();
  }
  // 点位标记：恒定屏幕大小（像光标一样，不随远近缩放）。世界 scale = 距离 × 系数
  if (mapGroup && mapMarkerSprites && mapMarkerSprites.length) {
    const fovK = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    for (const sp of mapMarkerSprites) {
      if (!sp.visible) continue;
      const dist = camera.position.distanceTo(sp.position);
      const s = dist * fovK * (sp.userData.screenScale || 0.045);
      sp.scale.set(s, s, s);
    }
  }
  renderer.render(scene, camera);
  fpsFrames++;
  const now = performance.now();
  if (now - fpsLast >= 500) {
    $('stFps').textContent = Math.round(fpsFrames * 1000 / (now - fpsLast));
    fpsLast = now; fpsFrames = 0;
  }
}

function buildGeometry(data) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(data.vertices, 3));
  if (data.uvs) geo.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  // 第二/第三套 UV：uv1=光照/AO（u_lightTex），uv3=第二层色（u_diffuse2Tex）。
  // 命名为自定义属性 auv1/auv3，避免与 three 内建 uv1 语义冲突，shader 内直接引用。
  if (data.uvs1) geo.setAttribute('auv1', new THREE.BufferAttribute(data.uvs1, 2));
  if (data.uvs3) geo.setAttribute('auv3', new THREE.BufferAttribute(data.uvs3, 2));
  geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
  // 优先使用文件内的原生法线；数量匹配才用，否则回退重算
  if (data.normals && data.normals.length === data.vertices.length) {
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  } else {
    geo.computeVertexNormals();
  }
  // 骨骼蒙皮属性（仅动画部件有）：每顶点 4 骨骼索引 + 权重
  if (data.boneIndices && data.boneWeights) {
    geo.setAttribute('boneIndices', new THREE.BufferAttribute(data.boneIndices, 4));
    geo.setAttribute('boneWeights', new THREE.BufferAttribute(data.boneWeights, 4));
  }
  return geo;
}
function showMesh(data, keepView) {
  clearScene();
  const geo = buildGeometry(data);
  const useTex = showTexture && data.texture && data.uvs;
  const dm = data.material || {};
  const mat = skyMaterial({
    color: 0xffffff,
    map: useTex ? data.texture : null,
    normalMap: (useTex && data.normTexture) ? data.normTexture : null,
    // 第二层色/光照图：仅当几何体带 uv3/uv1 时才生效（USE_UV13 宏由是否传图决定）
    diffuse2Map: (useTex && data.diffuse2Texture && data.uvs3) ? data.diffuse2Texture : null,
    diffuse2Offset: (useTex && data.diffuse2Texture && data.diffuse2Offset) ? [data.diffuse2Offset[0], data.diffuse2Offset[1]] : null,
    lightMap: (useTex && data.lightTexture && data.uvs1) ? data.lightTexture : null,
    side: THREE.DoubleSide, wireframe,
    baseHsv: dm.baseHsv || null,
    colorOverride: !!dm.colorOverride,
    rampDye: !!dm.rampDye,
  });
  currentMesh = new THREE.Mesh(geo, mat);
  currentTexture = data.texture || null;
  scene.add(currentMesh);
  currentData = data;
  curBox = new THREE.Box3().setFromObject(currentMesh);
  if (!keepView) setView('reset');
  updateInfo(data, geo);
  hintEl.style.display = 'none';
  $('objBtn').disabled = false;
  $('glbBtn').disabled = false;
  if ($('glbFrameBtn')) $('glbFrameBtn').disabled = false;
  $('mfBtn').disabled = false;
}

function setView(mode) {
  if (!currentMesh || !curBox) return;
  const size = curBox.getSize(new THREE.Vector3());
  const center = curBox.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  // 按 FOV 计算刚好填满视口的距离，再留一点边距
  const fov = camera.fov * Math.PI / 180;
  const dist = (maxDim / 2) / Math.tan(fov / 2) * 1.3;
  controls.target.copy(center);
  if (mode === 'front') camera.position.set(center.x, center.y, center.z + dist);
  else if (mode === 'top') camera.position.set(center.x, center.y + dist, center.z + 0.001);
  else if (mode === 'side') camera.position.set(center.x + dist, center.y, center.z);
  else camera.position.set(center.x + dist * 0.7, center.y + dist * 0.5, center.z + dist);
  updateClip();
  controls.update();
  // 网格/坐标轴随模型缩放定位
  const s = Math.max(1, Math.round(maxDim));
  gridHelper.scale.setScalar(s / 10);
  gridHelper.position.set(center.x, curBox.min.y, center.z);
  axesHelper.scale.setScalar(maxDim * 0.4);
  axesHelper.position.set(curBox.min.x, curBox.min.y, curBox.min.z);
}

// near/far 随相机到内容的距离自适应：任意缩放级别都不裁剪，等效无限缩放
function updateClip() {
  // 用相机到包围盒中心的距离为基准，同时考虑到目标点的距离，取较小者算 near，避免怼近物件时被裁
  let dist = camera.position.distanceTo(controls.target) || 1;
  if (curBox) {
    const c = curBox.getCenter(new THREE.Vector3());
    const dc = camera.position.distanceTo(c);
    if (dc < dist) dist = dc;
  }
  camera.near = Math.max(dist / 1000, 1e-4);
  camera.far = Math.max(dist * 1000, 1000);
  camera.updateProjectionMatrix();
}

function updateInfo(data, geo) {
  const box = new THREE.Box3().setFromBufferAttribute(geo.getAttribute('position'));
  const size = box.getSize(new THREE.Vector3());
  infoEl.style.display = 'block';
  const nativeNorm = data.normals && data.normals.length === data.vertices.length;
  let html =
    `<div class="name">${data.name}</div>` +
    `<div class="dim">版本 0x${data.version.toString(16)} · ${data.animated ? '含骨骼动画' : '静态网格'}</div>` +
    `<div class="dim">尺寸 ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}</div>` +
    `<div class="dim">法线 ${nativeNorm ? '原生' : '重算'} · UV ${data.uvs ? '有' : '无'}</div>`;
  if (data.animated) {
    html += `<div class="dim">骨骼 ${data.boneCount || 0} · 加权顶点 ${(data.weightedVertices||0).toLocaleString()}</div>`;
  }
  if (data.material && data.material.name) {
    const mt = data.material;
    html += `<div class="dim">材质 ${mt.name}${mt.shader ? ' · '+mt.shader : ''}</div>`;
    if (mt.diffuseTex) html += `<div class="dim">贴图 ${mt.diffuseTex}</div>`;
  }
  infoEl.innerHTML = html;
  // 状态栏
  $('stVerts').textContent = (data.vertices.length/3).toLocaleString();
  $('stFaces').textContent = (data.indices.length/3).toLocaleString();
  $('stVer').textContent = '0x' + data.version.toString(16);
  $('stUv').textContent = data.uvs ? '有' : '无';
}
function toast(msg, isErr) {
  toastEl.textContent = msg;
  toastEl.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.className = ''; }, 2800);
}

