/* ===== app.js ===== */
// ============================================================
// Sky Mesh Studio —— 主应用
// ============================================================


/* ===================== 全局状态 ===================== */
let renderer, scene, camera, controls, currentMesh, currentData;
let axesHelper, gridHelper;
let wireframe = false, showGrid = false;
// 全局上色总开关：默认关闭=白模（仅光照素模）。点击🎨后全场景（人物/地图/单模型）统一上色上贴图。
let colorOn = false;
// 整体色调轻微降饱和，削弱过艳、增强和谐感（0=不变，越大越灰）。
const TONE_DESAT = 0.08;
let apkFile = null, meshEntries = [], filtered = [];
let curBox = null;
let outfitDefs = null, placeableDefs = null, defsLoaded = false;
let texIndex = null; // 小写贴图名 -> zip entry
let showTexture = true, currentTexture = null;
const texCache = new Map();
// 换装状态
let dressMode = false, outfitCatalog = null, dressSelection = {}, dressGroup = null;
// 衣柜图标（当场从 APK 的 UIPackedAtlas 解析+分割+染色）
let atlasRegionMap = null;          // icon 名(小写) -> { image:'uipackedatlas7', uv:[l,t,r,b] }
let atlasLuaEntry = null;           // UIPackedAtlas.lua 的 zip entry
const atlasImgCache = new Map();    // 图集名(小写) -> {width,height,data} 解码后的 RGBA（懒解码）
const iconDataUrlCache = new Map(); // 装扮名 -> 裁剪染色后的 dataURL
let dressActiveSlot = 'body';       // 当前衣柜分页槽位
const meshEntryIndex = new Map(); // 小写 mesh 基名 -> zip entry
// 地图状态
let mapMode = false, mapEntries = []; // .meshes 关卡条目
let mapGroup = null;
let mapMarkerSprites = []; // 当前地图的点位标记 Sprite（用于每帧恒定屏幕尺寸更新）
let mapEvents = null; // 当前地图的事件逻辑（extractLevelEvents 结果），供事件面板用
let mapInfo = null; // 当前地图的信息清单（extractLevelInfo：传送/任务/音乐/对白）
let sunLight = null, fillLight = null, hemiLight = null; // 场景灯光引用
const levelBinIndex = new Map(); // 关卡名(小写) -> Objects.level.bin zip entry
// 单模型贴图反查索引：mesh 资源名(小写) -> 该 mesh 在任意关卡里用过的真实 diffuseTex。
// Sky 物件贴图不在 mesh 文件里，而由关卡 Objects.level.bin 的 shaderParams(u_diffuse1Tex) 指定，
// 故单模型脱离关卡无从得知贴图。首次单模型加载时懒扫描所有关卡 bin 建此索引。
let meshTexIndex = null;        // Map 或 null(未扫描)
let meshTexScanPromise = null;  // 扫描进行中的 Promise（避免重复扫）
// 异步加载序列号：快速切换模型/换装/地图时，只让最后一次加载结果生效
let loadToken = 0;
// 动画加载专用序列号：快速切换动画下拉时，只让最后一次生效（独立于 loadToken，
// 因为 loadDressCharacter 会推进 loadToken 并在内部 await loadAnimation）
let animLoadToken = 0;
// 动画状态：当前 animpack、解码数据、播放控制、蒙皮部件列表
let animState = {
  pack: null,          // parseAnimPack 结果
  decoded: null,       // decodeAnimation 结果
  frameCount: 0,
  fps: 30,
  time: 0,             // 播放时间（秒）
  playing: false,
  speed: 1.0,
  loop: true,          // 循环播放；关闭时播到末帧停住
  entries: [],         // 可选动画 zip entry 列表
  name: '',
  skinnedParts: [],    // [{mesh, geo, mat, skeletonBones, boneToAnim:Int32Array}]
  lastT: 0,            // 上一帧时间戳
};

/* ===================== 材质（对齐原项目 MeshRenderer 加性光照） =====================
 * 原项目用自定义 shader，非 PBR：
 *   base = ambient(118/255) + key(244/255)*NdotL + fill(150,160,176/255)*NdotF*0.3
 *   base *= texColor.rgb（有贴图）；base *= vColor.rgb（有顶点色）
 * ambient+key 峰值可达 ~1.42，直接顶到白，所以颜色鲜亮而非发灰。
 * MeshStandardMaterial 是能量守恒 PBR，漫反射天然偏暗，无法复现，故改用 ShaderMaterial。 */
const SKY_LIGHT_DIR = (() => {
  // lightYaw=-2.0344439358, lightPitch=-0.52
  const yaw = -2.0344439358, pitch = -0.52;
  const cp = Math.cos(pitch);
  const d = [cp * Math.cos(yaw), Math.sin(pitch), cp * Math.sin(yaw)];
  const l = Math.hypot(d[0], d[1], d[2]);
  return new THREE.Vector3(d[0] / l, d[1] / l, d[2] / l);
})();
const SKY_MAX_BONES = 128;
// 设备实际可用的骨数上限（默认 128，initThree 里按 GPU 顶点 uniform 上限下调）。
// 一个 mat4 骨矩阵占 4 个顶点 uniform 向量，另需给内建/自定义 uniform 留出余量。
let skyMaxBones = SKY_MAX_BONES;
// 顶点着色器 uBoneMatrices 数组大小按部件实际骨骼数生成。
// 手机 GPU 顶点 uniform 向量上限常见仅 256（GLES 规范下限），一个 mat4 占 4 个向量，
// 固定 128 骨就要 512 个向量，超限会导致带骨骼的角色部件在手机上着色器链接失败、整体不显示。
// 因此按需分配骨数（下限 1，避免声明 [0]）。
const SKY_VS_BODY = `
    vec3 pos = position;
    vec3 nrm = normal;
    #ifdef USE_SKINNING
      // 4 骨骼加权蒙皮（对齐参考 skinProgram：boneMat = Σ getBoneMatrix(idx)*weight）
      // 骨矩阵改从骨骼纹理采样，不再用 uniform 数组：手机顶点 uniform 向量上限（常见 256）
      // 只够 ~54 骨，超出会截断导致骨表后段的左手/左脚拿不到矩阵而定死绑定姿势。
      mat4 boneMat =
        getBoneMatrix(boneIndices.x) * boneWeights.x +
        getBoneMatrix(boneIndices.y) * boneWeights.y +
        getBoneMatrix(boneIndices.z) * boneWeights.z +
        getBoneMatrix(boneIndices.w) * boneWeights.w;
      // 权重和为 0 的顶点（无绑定）退化为单位阵，避免坍缩到原点
      if (boneWeights.x + boneWeights.y + boneWeights.z + boneWeights.w < 0.0001) boneMat = mat4(1.0);
      pos = (boneMat * vec4(position, 1.0)).xyz;
      nrm = (boneMat * vec4(normal, 0.0)).xyz;
    #endif
    vNormalW = normalize(normalMatrix * nrm);
    vUv = uv;
    #ifdef USE_UV13
      vUv1 = auv1;   // 光照/AO 图坐标
      vUv3 = auv3;   // 第二层色坐标
    #endif
    #ifdef USE_COLOR
      vColorV = color;
    #else
      vColorV = vec3(1.0);
    #endif
    vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
    vViewPos = mvPos.xyz;      // 视图空间坐标：供高光/菲涅尔算视线，dFdx 算屏幕空间细节
    gl_Position = projectionMatrix * mvPos;
  }`;
function buildSkyVS(boneCount) {
  return `
  varying vec3 vNormalW;
  varying vec2 vUv;
  varying vec3 vColorV;
  varying vec3 vViewPos;
  #ifdef USE_UV13
    attribute vec2 auv1;
    attribute vec2 auv3;
    varying vec2 vUv1;
    varying vec2 vUv3;
  #endif
  #ifdef USE_SKINNING
    attribute vec4 boneIndices;
    attribute vec4 boneWeights;
    // 骨矩阵存进浮点纹理（每骨占 4 个纹素=一个 mat4），按行主序逐列读回。
    // 纹理宽度 = 4*ceil(sqrt(boneCount))，方形贴图省纹素；uBoneTexSize 为边长。
    uniform sampler2D uBoneTexture;
    uniform float uBoneTexSize;
    mat4 getBoneMatrix(float i) {
      float j = i * 4.0;
      float x = mod(j, uBoneTexSize);
      float y = floor(j / uBoneTexSize);
      float dx = 1.0 / uBoneTexSize;
      float dy = 1.0 / uBoneTexSize;
      y = dy * (y + 0.5);
      vec4 v1 = texture2D(uBoneTexture, vec2(dx * (x + 0.5), y));
      vec4 v2 = texture2D(uBoneTexture, vec2(dx * (x + 1.5), y));
      vec4 v3 = texture2D(uBoneTexture, vec2(dx * (x + 2.5), y));
      vec4 v4 = texture2D(uBoneTexture, vec2(dx * (x + 3.5), y));
      return mat4(v1, v2, v3, v4);
    }
  #endif
  void main() {`.trimStart() + SKY_VS_BODY;
}
const SKY_FS = `
  precision highp float;
  varying vec3 vNormalW;
  varying vec2 vUv;
  varying vec3 vColorV;
  varying vec3 vViewPos;
  #ifdef USE_UV13
    varying vec2 vUv1;
    varying vec2 vUv3;
  #endif
  uniform sampler2D uDiffuse2Tex; // 第二层色（uv3）——门/石头真实颜色
  uniform int uHasDiffuse2;
  uniform vec2 uDiffuse2Offset;   // 第二层色 uv 偏移
  uniform sampler2D uLightTex;    // 光照/AO 图（uv1）——烘焙的明暗光影
  uniform int uHasLightTex;
  uniform vec3 uLightDir;
  uniform vec3 uAmbient;
  uniform vec3 uKey;
  uniform vec3 uFill;
  uniform float uSpecStrength;  // 镜面高光强度（按材质类型调；0=纯漫反射）
  uniform float uShininess;     // 高光锐度（越大越集中，金属/水高、岩石/布料低）
  uniform float uFresnel;       // 菲涅尔边缘光强度（体积/轮廓感）
  uniform vec3 uBaseColor;
  uniform sampler2D uTex;
  uniform int uHasTex;
  uniform sampler2D uNormTex;   // 切线空间法线贴图（与 uTex 共用 uv0）
  uniform int uHasNormTex;      // 是否有法线贴图
  uniform float uNormStrength;  // 法线扰动强度（0=不扰动）
  uniform int uHasVCol;
  uniform float uOpacity;
  uniform float uAlphaTest;
  uniform vec3 uBaseHsv;
  uniform int uHasColorOverride;
uniform float uDesaturate;
uniform int uForceDesat;
  uniform float uExposure;
  uniform int uColorOn;      // 全局上色开关：0=白模(仅光照)，1=正常贴图/颜色/染色
  uniform float uToneDesat;  // 整体轻微降饱和（0=不变），让色调更柔和不刺眼
  uniform vec3 uClayColor;   // 白模底色（浅灰黏土，避免纯白过曝顶死）
  // 输出编码：exposure 微调后做 linear→sRGB 显示编码。
  // 关键修复：之前只在采样端做 srgb2lin 却没在输出端编码回显示空间，
  // 导致暗部被线性值直接输出而黑死。参考 APP 靠 sRGB framebuffer 硬件编码抬亮暗部，
  // 我们输出走 LinearSRGBColorSpace（不自动编码），故必须在此手动 lin2srgb。
  vec3 softClip(vec3 c) {
    c *= uExposure;
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c));
  }
  // HSV(h:0-360, s:0-100, v:0-100) -> RGB，逐行对齐参考实现 _skyviewer_ref/MeshRenderer hsv2rgb
  vec3 hsv2rgb(vec3 hsv) {
    float h = hsv.x / 360.0;
    float s = hsv.y / 100.0;
    float v = hsv.z / 100.0;
    vec3 p = abs(fract(vec3(h) + vec3(1.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0);
    return v * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), s);
  }
  // sRGB -> linear：复现参考实现中 GPU 对 SRGB8_ETC2 纹理的硬件采样解码
  vec3 srgb2lin(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }
  // 整体轻微降饱和：往亮度灰靠拢一点，削弱过艳、增强和谐感（不改亮度）
  vec3 toneDesat(vec3 c) {
    if (uToneDesat <= 0.0) return c;
    float g = dot(c, vec3(0.2126, 0.7152, 0.0722));
    return mix(c, vec3(g), clamp(uToneDesat, 0.0, 1.0));
  }
  void main() {
    // 精确复现参考实现 _skyviewer_ref 的真实链路（关键：纹理是 SRGB8_ETC2，GPU 采样自动 sRGB→linear）：
    //   lighting = uAmbient + uKey*NdotL + uFill*NdotF   （光照系数按原值直接用，不转换）
    //   base = srgb2lin(texColor.rgb)                    （复现 GPU 对 sRGB 纹理的硬件解码）
    //   base *= vColor.rgb                               （顶点色按原值）
    //   base *= hsv2rgb(uBaseHsv)                         （染色 uniform 按原值直乘）
    //   直接输出线性值到非 sRGB framebuffer（LinearSRGBColorSpace，不做 linear→sRGB 编码）
    // 用平滑插值法线（保持圆润），不做屏幕空间面法线混合——
    // 面法线混合等同 flat-shading，会把低模每个三角面凸显成棱块（分面感），与"精致"相反。
    vec3 N = normalize(vNormalW);
    // ── 切线空间法线贴图（对齐真实 MeshSh：屏幕导数构造 TBN，不需顶点切线）──
    // 真实 shader 解包：n.xy = tex.xy*2.0079-1.0079，n.z=sqrt(1-|xy|²)，再乘余切帧。
    // 这里给低模加回表面凹凸/雕刻高频细节，且不做 sRGB 解码（法线数据是线性存储）。
    if (uHasNormTex == 1 && uHasTex == 1) {
      vec3 npk = texture2D(uNormTex, vUv).xyz;
      vec2 nxy = npk.xy * 2.0078125 - 1.0078125;
      float nz2 = dot(nxy, nxy);
      vec3 nTan = (nz2 <= 0.9975) ? vec3(nxy, sqrt(1.0 - nz2)) : vec3(normalize(nxy) * 0.9985, 0.0447);
      nTan.xy *= uNormStrength;
      nTan = normalize(nTan);
      // 屏幕空间余切帧（Mikkelsen）：由 uv 与视图坐标导数解出 T/B
      vec3 dpx = dFdx(vViewPos), dpy = dFdy(vViewPos);
      vec2 dux = dFdx(vUv), duy = dFdy(vUv);
      vec3 dpyp = cross(dpy, N), dpxp = cross(N, dpx);
      vec3 T = dpyp * dux.x + dpxp * duy.x;
      vec3 B = dpyp * dux.y + dpxp * duy.y;
      float inv = inversesqrt(max(dot(T, T), dot(B, B)));
      if (inv < 1e8) { // 有效 UV 导数才扰动，退化三角/无 UV 保持原法线
        mat3 tbn = mat3(T * inv, B * inv, N);
        N = normalize(tbn * nTan);
      }
    }
    vec3 L = normalize(-uLightDir);
    float NdotL = max(dot(N, L), 0.0);
    vec3 keyC = uKey * NdotL;
    vec3 fillLight = normalize(vec3(-uLightDir.z, uLightDir.y, -uLightDir.x));
    float NdotF = max(dot(N, normalize(-fillLight)), 0.0) * 0.3;
    vec3 fillC = uFill * NdotF;
    vec3 lighting = uAmbient + keyC + fillC;
    // ── 烘焙光照/AO（u_lightTex，用 uv1）──：门/石头"中间那光影"就是这层。
    // 真实 MeshSh 用 .x 调直射+高光、.y 调环境遮蔽；White 贴图(=1)时不改变光照。
    #ifdef USE_UV13
    if (uHasLightTex == 1) {
      vec2 ao = texture2D(uLightTex, vUv1).xy;
      lighting = uAmbient * ao.y + (keyC + fillC) * ao.x;
    }
    #endif
    // ── 镜面高光（Blinn-Phong）+ 菲涅尔边缘光 ──
    // 视图空间：相机在原点，视线 V = 归一化(-坐标)。半角向量 H=归一化(L+V)。
    vec3 V = normalize(-vViewPos);
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), uShininess) * uSpecStrength * NdotL;
    // 菲涅尔：视线越掠射边缘越亮，给出体积/轮廓感（Schlick 近似）
    float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0) * uFresnel;
    vec3 gSpec = uKey * spec + uFill * fres;
    // ── 白模（全局上色关闭）：只显示带光照的浅灰素模，便于看结构 ──
    // 白模保留细节法线与轻微边缘光，让结构起伏更清楚，但不加彩色高光。
    if (uColorOn == 0) {
      // 透明大气/水面片在白模下直接隐去，避免灰片糊住画面
      if (uOpacity < 0.99) discard;
      gl_FragColor = vec4(softClip(uClayColor * lighting + uFill * fres * 0.5), 1.0);
      return;
    }
    // 逐行对齐参考：纹理与顶点色是两个独立 if（累乘），而非互斥
    vec3 base = uBaseColor;
    float alpha = uOpacity;
    if (uHasTex == 1) {
      vec4 t = texture2D(uTex, vUv);
      base *= srgb2lin(t.rgb);
      alpha *= t.a;
    }
    // ── 第二层色（u_diffuse2Tex，用 uv3）──：与 diffuse1 相乘得反照率，给灰底石纹上真实颜色。
    // 真实 MeshSh：albedo = diffuse1 * diffuse2（第 314-318 行 _1155=_1138*_1150）。
    #ifdef USE_UV13
    if (uHasDiffuse2 == 1) {
      vec4 t2 = texture2D(uDiffuse2Tex, vUv3 + uDiffuse2Offset);
      base *= srgb2lin(t2.rgb);
    }
    #endif
    if (uHasVCol == 1) {
      base *= vColorV;
    }
    // 「原始颜色」开关：直接显示 ramp/贴图原色，不做 HSV 染色
    if (uForceDesat == 1) {
      if (alpha < uAlphaTest) discard;
      gl_FragColor = vec4(softClip(toneDesat(base) * lighting + gSpec), alpha);
      return;
    }
    // ── 染色：逐行对齐参考实现 ──
    //   uHasColorOverride==1（纯色覆盖件）：base = hsvColor * 光照，丢弃贴图/顶点色
    //   否则（普通染色）：base *= hsvColor
    //   base_hsv=[0,0,100](白) → hsv2rgb=(1,1,1) 即原样显示
    vec3 hsvColor = hsv2rgb(uBaseHsv);
    if (uHasColorOverride == 1) {
      if (alpha < uAlphaTest) discard;
      gl_FragColor = vec4(softClip(toneDesat(hsvColor) * lighting + gSpec), alpha);
      return;
    }
    base *= hsvColor;
    // 去饱和：仅当显式请求（uDesaturate>0，对应游戏 u_desaturateAmount+u_ghost）
    if (uDesaturate > 0.0) {
      float g = dot(base, vec3(0.15, 0.30, 0.5));
      base = mix(base, vec3(g), clamp(uDesaturate, 0.0, 1.0));
    }
    if (alpha < uAlphaTest) discard;
    gl_FragColor = vec4(softClip(toneDesat(base) * lighting + gSpec), alpha);
  }`;
function skyMaterial(opts) {
  const o = opts || {};
  const tex = o.map || null;
  // 蒙皮骨数：用部件实际骨数（骨矩阵走纹理，不再受顶点 uniform 上限约束）。
  const boneN = o.skinning ? Math.max(1, o.boneCount || SKY_MAX_BONES) : 0;
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uLightDir: { value: SKY_LIGHT_DIR },
      // 光照系数：降低环境光、加大方向光对比，让浮雕/凹凸的阴影显出来（原 ambient 0.46 太高把细节洗平）
      // 可被 opts 覆盖：地形是预烘焙自发光（顶点色即最终色），需高 ambient/低方向光避免二次压暗。
      uAmbient: { value: Array.isArray(o.ambient) ? new THREE.Vector3(o.ambient[0], o.ambient[1], o.ambient[2]) : new THREE.Vector3(70 / 255, 70 / 255, 72 / 255) },
      uKey: { value: Array.isArray(o.key) ? new THREE.Vector3(o.key[0], o.key[1], o.key[2]) : new THREE.Vector3(255 / 255, 255 / 255, 255 / 255) },
      uFill: { value: Array.isArray(o.fill) ? new THREE.Vector3(o.fill[0], o.fill[1], o.fill[2]) : new THREE.Vector3(150 / 255, 160 / 255, 176 / 255) },
      // 用原始归一化 RGB（Vector3），避免 THREE.Color 被 ColorManagement 自动转线性
      uBaseColor: { value: (() => { const c = o.color != null ? o.color : 0xffffff; return new THREE.Vector3(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255); })() },
      uTex: { value: tex },
      uHasTex: { value: tex ? 1 : 0 },
      uNormTex: { value: o.normalMap || null },
      uHasNormTex: { value: o.normalMap ? 1 : 0 },
      uNormStrength: { value: o.normStrength != null ? o.normStrength : 1.0 },
      uDiffuse2Tex: { value: o.diffuse2Map || null },
      uHasDiffuse2: { value: o.diffuse2Map ? 1 : 0 },
      uDiffuse2Offset: { value: Array.isArray(o.diffuse2Offset) ? new THREE.Vector2(o.diffuse2Offset[0], o.diffuse2Offset[1]) : new THREE.Vector2(0, 0) },
      uLightTex: { value: o.lightMap || null },
      uHasLightTex: { value: o.lightMap ? 1 : 0 },
      uHasVCol: { value: o.vertexColors ? 1 : 0 },
      uOpacity: { value: o.opacity != null ? o.opacity : 1.0 },
      uAlphaTest: { value: o.alphaTest != null ? o.alphaTest : 0.0 },
      uBaseHsv: { value: Array.isArray(o.baseHsv) && o.baseHsv.length === 3
        ? new THREE.Vector3(o.baseHsv[0], o.baseHsv[1], o.baseHsv[2])
        : new THREE.Vector3(0, 0, 100) },
      uHasColorOverride: { value: o.colorOverride ? 1 : 0 },
      uDesaturate: { value: o.desaturate != null ? o.desaturate : 0.0 },
      uForceDesat: { value: 0 },
      uExposure: { value: o.exposure != null ? o.exposure : 0.62 },
      uColorOn: { value: colorOn ? 1 : 0 },
      uToneDesat: { value: TONE_DESAT },
      uClayColor: { value: new THREE.Vector3(0.6, 0.6, 0.62) },
      // 表面质感参数（按材质类型可覆盖，默认适度）：高光/锐度/边缘光/细节凹凸
      uSpecStrength: { value: o.specStrength != null ? o.specStrength : 0.08 },
      uShininess: { value: o.shininess != null ? o.shininess : 16.0 },
      uFresnel: { value: o.fresnel != null ? o.fresnel : 0.06 },
    },
    vertexShader: buildSkyVS(boneN || 1),
    fragmentShader: SKY_FS,
    side: o.side != null ? o.side : THREE.DoubleSide,
    transparent: !!o.transparent,
    depthWrite: o.depthWrite != null ? o.depthWrite : true,
    wireframe: !!o.wireframe,
    vertexColors: !!o.vertexColors,
  });
  // 蒙皮：加 uBoneMatrices 数组 + USE_SKINNING 宏。默认单位阵，动画每帧更新。
  // 数组大小按部件实际骨数、并受设备上限 skyMaxBones 约束，避免手机端顶点 uniform 超限。
  // 片元用 dFdx/dFdy 算屏幕空间几何法线（细节凹凸）。WebGL1 需显式开启导数扩展；
  // WebGL2(GLSL3) 内建可用，设置该标志无副作用。
  m.extensions = Object.assign({}, m.extensions, { derivatives: true });
  // 第二层色/光照图需要 uv3/uv1 属性；仅在提供任一贴图时开宏（避免无属性几何编译报错）。
  if (o.diffuse2Map || o.lightMap) {
    m.defines = Object.assign({}, m.defines, { USE_UV13: '' });
  }
  if (o.skinning) {
    // 骨矩阵纹理：每骨 4 个 RGBA 浮点纹素（一个 mat4）。用方形贴图，边长向上取到 4 的倍数。
    const size = boneTexSizeFor(boneN);
    const data = new Float32Array(size * size * 4);
    // 初始化为单位阵（列主序写入，getBoneMatrix 用 mat4(col0..col3) 读回）
    for (let i = 0; i < boneN; i++) writeBoneIdentity(data, i);
    const btex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
    btex.needsUpdate = true;
    m.uniforms.uBoneTexture = { value: btex };
    m.uniforms.uBoneTexSize = { value: size };
    m.userData.boneData = data;
    m.userData.boneTex = btex;
    m.defines = Object.assign({}, m.defines, { USE_SKINNING: '' });
    m.userData.boneCount = boneN;
  }
  return m;
}
// 骨骼纹理边长：boneN 骨 × 4 纹素，开方向上取整、再对齐到 4 的倍数（每骨占一行内 4 连续纹素不跨行更稳）。
function boneTexSizeFor(boneN) {
  let size = Math.ceil(Math.sqrt(boneN * 4));
  size = Math.ceil(size / 4) * 4;
  return Math.max(4, size);
}
// 往骨数据数组的第 bone 个 mat4（16 float）写单位阵
function writeBoneIdentity(data, bone) {
  const o = bone * 16;
  data[o] = 1; data[o+1] = 0; data[o+2] = 0; data[o+3] = 0;
  data[o+4] = 0; data[o+5] = 1; data[o+6] = 0; data[o+7] = 0;
  data[o+8] = 0; data[o+9] = 0; data[o+10] = 1; data[o+11] = 0;
  data[o+12] = 0; data[o+13] = 0; data[o+14] = 0; data[o+15] = 1;
}

// ── 云材质 ──
// 对齐游戏 CloudShMesh（Terrain.frag + CLOUD 宏）观感：云是烘焙在关卡里的网格，
// 顶点色（材质80 浅蓝白）为底，实机再叠 3D 噪声起伏 + 天空/太阳散射 + 菲涅尔透光。
// 离线拿不到噪声体纹理与天空探针，这里做静态近似：
//   颜色 = 顶点色 × 天空亮色；朝上更亮偏冷；边缘（法线垂直视线）增亮模拟蓬松透光；
//   半透明、双面、不写深度，避免遮挡地形。
const CLOUD_VS = `
  varying vec3 vNormalW;
  varying vec3 vColorV;
  varying vec3 vViewDir;
  void main() {
    vNormalW = normalize(normalMatrix * normal);
    #ifdef USE_COLOR
      vColorV = color;
    #else
      vColorV = vec3(1.0);
    #endif
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const CLOUD_FS = `
  precision highp float;
  varying vec3 vNormalW;
  varying vec3 vColorV;
  varying vec3 vViewDir;
  uniform vec3 uSkyTop;
  uniform vec3 uSkyBottom;
  uniform vec3 uSunColor;
  uniform vec3 uLightDir;
  uniform float uOpacity;
  void main() {
    vec3 N = normalize(vNormalW);
    // 顶点色（云密度/底色），gamma 空间直用（对齐直出管线）
    vec3 base = clamp(vColorV, 0.0, 1.0);
    // 半球天空色：朝上偏冷亮、朝下偏暖暗
    float hemi = N.y * 0.5 + 0.5;
    vec3 sky = mix(uSkyBottom, uSkyTop, hemi);
    // 太阳方向散射：正对阳光的云更亮
    float sun = max(dot(N, normalize(-uLightDir)), 0.0);
    vec3 col = base * sky + uSunColor * (sun * 0.35);
    // 边缘透光（Fresnel）：视线掠射处更亮更透，模拟蓬松感
    float ndv = abs(dot(N, normalize(vViewDir)));
    float rim = pow(1.0 - ndv, 2.5);
    col += uSunColor * rim * 0.4;
    // 边缘半透明：正面实、边缘虚
    float alpha = uOpacity * mix(0.55, 1.0, ndv);
    gl_FragColor = vec4(col, alpha);
  }`;
function cloudMaterial(opts) {
  const o = opts || {};
  return new THREE.ShaderMaterial({
    uniforms: {
      uSkyTop: { value: new THREE.Vector3(1.15, 1.2, 1.35) },
      uSkyBottom: { value: new THREE.Vector3(0.85, 0.82, 0.8) },
      uSunColor: { value: new THREE.Vector3(1.0, 0.95, 0.85) },
      uLightDir: { value: SKY_LIGHT_DIR },
      uOpacity: { value: o.opacity != null ? o.opacity : 0.7 },
    },
    vertexShader: CLOUD_VS,
    fragmentShader: CLOUD_FS,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    wireframe: !!o.wireframe,
  });
}

// ── 水面材质 ──
// 游戏海平面用 Ocean.frag（屏幕空间反射 + cubemap 天空反射 + 菲涅尔 + 多层滚动噪声法线 + 焦散），
// 依赖运行时深度缓冲/cubemap/点光，离线不可得。这里对水体物件（IslandWater 等）做静态近似：
//   深色水底 → 天空反射（菲涅尔，掠射角更反光）+ 程序化波纹扰动法线 + 高光；半透明。
const WATER_VS = `
  varying vec3 vWorldPos;
  varying vec3 vNormalW;
  varying vec3 vViewDirW;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDirW = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const WATER_FS = `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vNormalW;
  varying vec3 vViewDirW;
  uniform float uTime;
  uniform vec3 uLightDir;
  uniform vec3 uDeepColor;
  uniform vec3 uShallowColor;
  uniform vec3 uSkyColor;
  uniform vec3 uSunColor;
  uniform float uOpacity;
  // 便宜的程序化波纹：几个错向 sin 叠加，扰动法线
  vec3 waveNormal(vec2 p) {
    float n = 0.0;
    vec2 d1 = vec2(0.8, 0.2), d2 = vec2(-0.3, 0.9), d3 = vec2(0.5, -0.7);
    float t = uTime;
    vec2 grad = vec2(0.0);
    grad += d1 * cos(dot(p, d1) * 0.35 + t * 1.1) * 0.06;
    grad += d2 * cos(dot(p, d2) * 0.6  + t * 1.7) * 0.035;
    grad += d3 * cos(dot(p, d3) * 1.1  + t * 2.3) * 0.02;
    return normalize(vec3(-grad.x, 1.0, -grad.y));
  }
  void main() {
    // 以世界法线为主，掺入波纹法线（水多为近水平面，向上）
    vec3 baseN = normalize(vNormalW);
    vec3 wn = waveNormal(vWorldPos.xz);
    vec3 N = normalize(mix(baseN, wn, 0.6));
    vec3 V = normalize(vViewDirW);
    // 菲涅尔：掠射角强反射天空，正视看到水底深色
    float f = pow(1.0 - max(dot(N, V), 0.0), 4.0);
    f = mix(0.04, 1.0, f);
    vec3 water = mix(uDeepColor, uShallowColor, max(dot(N, V), 0.0));
    vec3 col = mix(water, uSkyColor, f);
    // 太阳高光（Blinn-Phong）
    vec3 L = normalize(-uLightDir);
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), 120.0);
    col += uSunColor * spec * 0.8;
    gl_FragColor = vec4(col, mix(uOpacity, 1.0, f));
  }`;
const waterMats = []; // 需要每帧更新 uTime 的水面材质
function waterMaterial(opts) {
  const o = opts || {};
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uLightDir: { value: SKY_LIGHT_DIR },
      uDeepColor: { value: new THREE.Vector3(0.02, 0.09, 0.16) },
      uShallowColor: { value: new THREE.Vector3(0.05, 0.22, 0.32) },
      uSkyColor: { value: new THREE.Vector3(0.55, 0.68, 0.85) },
      uSunColor: { value: new THREE.Vector3(1.0, 0.96, 0.85) },
      uOpacity: { value: o.opacity != null ? o.opacity : 0.72 },
    },
    vertexShader: WATER_VS,
    fragmentShader: WATER_FS,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    wireframe: !!o.wireframe,
  });
  waterMats.push(m);
  return m;
}

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const infoEl = $('info');
const hintEl = $('hint');
const toastEl = $('toast');
const listEl = $('list');
const countEl = $('count');
const overlay = $('overlay');
const overlayTxt = $('overlayTxt');
const overlayBar = $('overlayBar');

