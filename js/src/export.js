/* ===================== 导出 ===================== */
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportOBJ() {
  if (!currentData) return;
  const d = currentData;
  const lines = ['# Sky Mesh Studio', `# ${d.name}`, `o ${d.name}`];
  const v = d.vertices;
  for (let i = 0; i < v.length; i += 3) lines.push(`v ${v[i]} ${v[i+1]} ${v[i+2]}`);
  if (d.uvs) { const u = d.uvs; for (let i = 0; i < u.length; i += 2) lines.push(`vt ${u[i]} ${u[i+1]}`); }
  const hasN = d.normals && d.normals.length === d.vertices.length;
  if (hasN) { const n = d.normals; for (let i = 0; i < n.length; i += 3) lines.push(`vn ${n[i]} ${n[i+1]} ${n[i+2]}`); }
  const idx = d.indices;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i]+1, b = idx[i+1]+1, c = idx[i+2]+1;
    const fv = (x) => d.uvs ? (hasN ? `${x}/${x}/${x}` : `${x}/${x}`) : (hasN ? `${x}//${x}` : `${x}`);
    lines.push(`f ${fv(a)} ${fv(b)} ${fv(c)}`);
  }
  download(new Blob([lines.join('\n')], { type: 'text/plain' }), d.name + '.obj');
  toast('已导出 OBJ');
}

/* ---------- GLB 材质/纹理转换 ----------
 * 场景内使用 skyMaterial(ShaderMaterial)，三方的 GLTFExporter 不支持 ShaderMaterial。
 * 导出前深拷贝对象树，把自定义 uniform 转成 glTF 标准 PBR 材质槽：
 *   uTex       -> map
 *   uNormTex   -> normalMap
 *   uLightTex  -> aoMap（取 G 通道，UV1）
 *   uDiffuse2Tex -> 无 uTex 时的 map（UV3；glTF 没有双反照率层）
 * 导出的是材质本身，不受预览层「白模」uColorOn 开关影响。
 * 原始场景和 GPU 资源不会被修改，临时克隆在导出结束/失败后统一释放。
 */
function glbUniformValue(material, name) {
  const u = material && material.uniforms && material.uniforms[name];
  return u ? u.value : undefined;
}
function glbColorFromUniform(value, fallback) {
  const f = fallback == null ? 1 : fallback;
  const c = new THREE.Color().setRGB(f, f, f);
  if (value && value.isVector3) c.setRGB(value.x, value.y, value.z);
  else if (Array.isArray(value) && value.length >= 3) c.setRGB(value[0], value[1], value[2]);
  return c;
}
function glbHsvToColor(value) {
  const h = value && value.isVector3 ? value.x : (Array.isArray(value) ? value[0] : 0);
  const s = value && value.isVector3 ? value.y : (Array.isArray(value) ? value[1] : 0);
  const v = value && value.isVector3 ? value.z : (Array.isArray(value) ? value[2] : 100);
  const hn = (((h || 0) % 360) + 360) % 360 / 360;
  const sn = Math.max(0, Math.min(1, (s || 0) / 100));
  const vn = Math.max(0, Math.min(1, (v == null ? 100 : v) / 100));
  const p = Math.abs((hn + 1) % 1 * 6 - 3);
  const q = Math.abs((hn + 2 / 3) % 1 * 6 - 3);
  const t = Math.abs((hn + 1 / 3) % 1 * 6 - 3);
  return new THREE.Color().setRGB(
    vn * (1 + sn * (Math.max(0, Math.min(1, p - 1)) - 1)),
    vn * (1 + sn * (Math.max(0, Math.min(1, q - 1)) - 1)),
    vn * (1 + sn * (Math.max(0, Math.min(1, t - 1)) - 1))
  );
}
function glbShaderBaseColor(material) {
  const base = glbColorFromUniform(glbUniformValue(material, 'uBaseColor'), 1);
  if (glbUniformValue(material, 'uBaseColor')) return base;
  // 云/水面没有 uBaseColor，用其主色 uniform 做静态近似。
  const pair = [
    ['uSkyTop', 'uSkyBottom'],
    ['uShallowColor', 'uDeepColor'],
  ];
  for (const names of pair) {
    const a = glbUniformValue(material, names[0]);
    const b = glbUniformValue(material, names[1]);
    if (a && a.isVector3 && b && b.isVector3) {
      return new THREE.Color().setRGB((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
    }
  }
  return base;
}
function glbShaderHasValidHsv(material) {
  const hsvValue = glbUniformValue(material, 'uBaseHsv');
  const marker = glbUniformValue(material, 'uHasBaseHsv');
  if (marker != null) return Number(marker) === 1;
  return !!(hsvValue && ((hsvValue.isVector3 && [hsvValue.x, hsvValue.y, hsvValue.z].every(Number.isFinite)) ||
    (Array.isArray(hsvValue) && hsvValue.length >= 3 && hsvValue.slice(0, 3).every(Number.isFinite))));
}
function glbShaderBaseMap(material, isOverride) {
  const override = isOverride == null
    ? Number(glbUniformValue(material, 'uHasColorOverride')) === 1 && glbShaderHasValidHsv(material)
    : !!isOverride;
  if (override) return null;
  const tex = glbUniformValue(material, 'uTex');
  if (tex && tex.isTexture && Number(glbUniformValue(material, 'uHasTex')) !== 0) {
    return { texture: tex, channel: 0 };
  }
  const diffuse2 = glbUniformValue(material, 'uDiffuse2Tex');
  if (diffuse2 && diffuse2.isTexture && Number(glbUniformValue(material, 'uHasDiffuse2')) !== 0) {
    return { texture: diffuse2, channel: 3 };
  }
  return null;
}
function glbShaderNeedsLightUV(material) {
  const tex = glbUniformValue(material, 'uLightTex');
  return !!(material && material.isShaderMaterial && tex && tex.isTexture && Number(glbUniformValue(material, 'uHasLightTex')) !== 0);
}
function glbCopyExportTextureSettings(source, target) {
  target.name = source.name || target.name;
  target.mapping = source.mapping;
  target.channel = source.channel;
  target.wrapS = source.wrapS;
  target.wrapT = source.wrapT;
  target.magFilter = source.magFilter;
  target.minFilter = source.minFilter;
  target.anisotropy = source.anisotropy;
  target.colorSpace = source.colorSpace;
  target.flipY = source.flipY;
  target.generateMipmaps = source.generateMipmaps;
  target.needsUpdate = true;
}
function glbCreateExportTexture(source, channel, mode, state) {
  if (!source || !source.isTexture) return null;
  const key = source.uuid + ':' + channel + ':' + (mode || 'copy');
  if (state.texturesByKey.has(key)) return state.texturesByKey.get(key);
  let out;
  const image = source.image || {};
  if (mode === 'ao' && image.data && image.width && image.height) {
    // glTF 的 occlusionTexture 只读 R。游戏光照图的 G 通道是 AO，转到 R 后语义最接近。
    const src = image.data;
    const data = new Uint8Array(image.width * image.height * 4);
    for (let i = 0; i < data.length; i += 4) {
      const ao = src[i + 1] == null ? src[i] : src[i + 1];
      data[i] = ao; data[i + 1] = ao; data[i + 2] = ao; data[i + 3] = 255;
    }
    out = new THREE.DataTexture(data, image.width, image.height, THREE.RGBAFormat);
    glbCopyExportTextureSettings(source, out);
  } else {
    out = source.clone();
  }
  // 游戏颜色贴图在运行时由 shader 手动按 sRGB 解码，原始 DataTexture
  // 因此标记为 NoColorSpace。GLTFExporter/标准 PBR 需要显式声明颜色贴图
  // 为 sRGB，否则 Blender 等导入器会把它当线性数据，颜色会明显变亮。
  if (mode === 'color' && (channel === 0 || channel === 3) && THREE.SRGBColorSpace != null) {
    out.colorSpace = THREE.SRGBColorSpace;
  }
  out.channel = channel;
  out.needsUpdate = true;
  state.textures.add(out);
  state.texturesByKey.set(key, out);
  return out;
}
function glbCreateExportMaterial(source, state) {
  if (!source) return null;
  if (state.materialsBySource.has(source)) return state.materialsBySource.get(source);

  let out;
  if (source.isShaderMaterial) {
    const hsvValue = glbUniformValue(source, 'uBaseHsv');
    const hasHsv = glbShaderHasValidHsv(source);
    // 缺失 base_hsv 时不能把 color_override 当成有效纯色覆盖，否则会
    // 丢弃主贴图并回退到白色（典型现象：Wing 红色导出后变白）。
    const override = Number(glbUniformValue(source, 'uHasColorOverride')) === 1 && hasHsv;
    const baseMapInfo = glbShaderBaseMap(source, override);
    const baseTex = glbUniformValue(source, 'uTex');
    const normalTex = glbUniformValue(source, 'uNormTex');
    const lightTex = glbUniformValue(source, 'uLightTex');
    const opacityValue = Number(glbUniformValue(source, 'uOpacity'));
    const opacity = Number.isFinite(opacityValue)
      ? opacityValue
      : (Number.isFinite(source.opacity) ? source.opacity : 1);
    const alphaTest = Number(glbUniformValue(source, 'uAlphaTest')) || 0;

    let color = glbShaderBaseColor(source);
    if (override) color = glbHsvToColor(glbUniformValue(source, 'uBaseHsv'));
    else color.multiply(glbHsvToColor(glbUniformValue(source, 'uBaseHsv')));
    out = new THREE.MeshStandardMaterial({
      color,
      map: baseMapInfo ? glbCreateExportTexture(baseMapInfo.texture, baseMapInfo.channel, 'color', state) : null,
      vertexColors: !override && !!source.vertexColors,
    });
    out.name = source.name || '';
    out.side = source.side;
    out.transparent = !!source.transparent || opacity < 1;
    out.opacity = opacity;
    out.alphaTest = alphaTest;
    out.depthWrite = source.depthWrite;
    out.wireframe = !!source.wireframe;
    out.roughness = 0.78;
    out.metalness = 0;
    if (normalTex && normalTex.isTexture && baseTex && baseTex.isTexture && Number(glbUniformValue(source, 'uHasNormTex')) !== 0) {
      out.normalMap = glbCreateExportTexture(normalTex, 0, 'copy', state);
      const strength = Number(glbUniformValue(source, 'uNormStrength'));
      out.normalScale.set(Number.isFinite(strength) ? strength : 1, Number.isFinite(strength) ? strength : 1);
    }
    if (lightTex && lightTex.isTexture && Number(glbUniformValue(source, 'uHasLightTex')) !== 0) {
      out.aoMap = glbCreateExportTexture(lightTex, 1, 'ao', state);
      out.aoMapIntensity = 1;
    }
  } else {
    out = source.clone();
  }

  state.materialsBySource.set(source, out);
  state.materials.add(out);
  return out;
}
function glbSourceMaterials(object) {
  const m = object && object.material;
  if (!m) return [];
  return Array.isArray(m) ? m : [m];
}
function glbPrepareCustomSkin(object, state) {
  const records = object && object.userData && object.userData.skeletonBones;
  if (!object || !object.isMesh || object.isSkinnedMesh || !Array.isArray(records) || !records.length) return null;
  const geo = object.geometry;
  const indices = geo.getAttribute('boneIndices');
  const weights = geo.getAttribute('boneWeights');
  if (!indices || !weights) return null;
  const bones = records.map((record) => {
    const bone = new THREE.Bone();
    bone.name = record.name || 'Bone';
    return bone;
  });
  records.forEach((record, i) => {
    const parent = Number(record.parent);
    if (parent >= 0 && parent < bones.length) bones[parent].add(bones[i]);
  });
  const roots = bones.filter((bone) => !bone.parent);
  const inverseBind = records.map((record) => {
    const matrix = new THREE.Matrix4();
    if (record.matrix && record.matrix.length === 16) matrix.fromArray(record.matrix);
    else matrix.identity();
    return matrix;
  });
  const skinned = new THREE.SkinnedMesh(geo, object.material);
  skinned.name = object.name;
  skinned.userData = Object.assign({}, object.userData);
  skinned.userData.skeletonBones = null;
  skinned.position.copy(object.position); skinned.quaternion.copy(object.quaternion); skinned.scale.copy(object.scale);
  // Joints must live inside the exported node tree. The original mesh is
  // replaced below, so attach roots to the new SkinnedMesh directly.
  roots.forEach((bone) => skinned.add(bone));
  skinned.bind(new THREE.Skeleton(bones, inverseBind));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(indices.array), 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(weights.array), 4));
  object.parent && object.parent.add(skinned);
  object.parent && object.parent.remove(object);
  state.customSkins.set(object, skinned);
  return skinned;
}
function glbPrepareExportGeometry(object, materials, state) {
  if (!object || !object.geometry) return;
  const geo = object.geometry;
  const hasAuv1 = !!geo.getAttribute('auv1');
  const hasAuv3 = !!geo.getAttribute('auv3');
  const hasVertexColor = !!geo.getAttribute('color');
  const needsUV1 = materials.some(glbShaderNeedsLightUV);
  const needsUV3 = materials.some((m) => {
    const info = m && m.isShaderMaterial ? glbShaderBaseMap(m) : null;
    return !!(info && info.channel === 3);
  });
  const needsVertexColor = materials.some((m) => {
    if (!m || !m.vertexColors) return false;
    return !m.isShaderMaterial || !(Number(glbUniformValue(m, 'uHasColorOverride')) === 1 && glbShaderHasValidHsv(m));
  });
  const dropVertexColor = hasVertexColor && !needsVertexColor;
  if (!hasAuv1 && !hasAuv3 && !needsUV1 && !needsUV3 && !dropVertexColor) return;

  const copy = geo.clone();
  // 导出器识别 uv1/uv3；游戏原属性名 auv1/auv3 会变成无效的 _AUVn 扩展属性。
  if (needsUV1 && copy.getAttribute('auv1') && !copy.getAttribute('uv1')) {
    copy.setAttribute('uv1', copy.getAttribute('auv1'));
  }
  if (needsUV3 && copy.getAttribute('auv3') && !copy.getAttribute('uv3')) {
    copy.setAttribute('uv3', copy.getAttribute('auv3'));
  }
  copy.deleteAttribute('auv1');
  copy.deleteAttribute('auv3');
  if (dropVertexColor) copy.deleteAttribute('color');
  state.geometries.add(copy);
  object.geometry = copy;
}
function glbBakeCurrentFrame(object, state) {
  if (!object || !object.isMesh || !object.geometry) return false;
  const geo = object.geometry;
  const indices = geo.getAttribute('boneIndices') || geo.getAttribute('skinIndex');
  const weights = geo.getAttribute('boneWeights') || geo.getAttribute('skinWeight');
  const material = Array.isArray(object.material) ? object.material[0] : object.material;
  const boneData = material && material.userData && material.userData.boneData;
  const position = geo.getAttribute('position');
  if (!indices || !weights || !position || !boneData) return false;
  const copy = geo.clone();
  const out = copy.getAttribute('position');
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i); q.set(0, 0, 0);
    let total = 0;
    for (let k = 0; k < 4; k++) {
      const w = weights.getComponent(i, k), bi = indices.getComponent(i, k);
      if (!(w > 0) || !Number.isFinite(bi)) continue;
      const o = bi * 16;
      if (o + 15 >= boneData.length) continue;
      const x = p.x, y = p.y, z = p.z;
      q.x += w * (boneData[o] * x + boneData[o + 4] * y + boneData[o + 8] * z + boneData[o + 12]);
      q.y += w * (boneData[o + 1] * x + boneData[o + 5] * y + boneData[o + 9] * z + boneData[o + 13]);
      q.z += w * (boneData[o + 2] * x + boneData[o + 6] * y + boneData[o + 10] * z + boneData[o + 14]);
      total += w;
    }
    if (total > 0) out.setXYZ(i, q.x, q.y, q.z);
  }
  copy.deleteAttribute('boneIndices'); copy.deleteAttribute('boneWeights');
  copy.deleteAttribute('skinIndex'); copy.deleteAttribute('skinWeight');
  state.geometries.add(copy); object.geometry = copy;
  return true;
}
function glbBuildExportRoot(source, state, options) {
  const target = source.clone(true);
  // SkinnedMesh.clone() 默认继续引用原始 Skeleton；GLTFExporter 只能把克隆树中的
  // 节点写入 joints。没有重映射时 joints 会变成 null，角色动画导出因此损坏。
  const sourceBones = [];
  const targetBones = [];
  source.traverse((object) => { if (object.isBone) sourceBones.push(object); });
  target.traverse((object) => { if (object.isBone) targetBones.push(object); });
  if (sourceBones.length !== targetBones.length) throw new Error('蒙皮骨骼克隆不完整');
  const boneMap = new Map();
  for (let i = 0; i < sourceBones.length; i++) boneMap.set(sourceBones[i], targetBones[i]);
  target.traverse((object) => {
    if (!object.isSkinnedMesh || !object.skeleton) return;
    const bones = object.skeleton.bones.map((bone) => boneMap.get(bone));
    if (bones.some((bone) => !bone)) throw new Error('蒙皮骨骼不在导出对象树中');
    object.skeleton = new THREE.Skeleton(bones, object.skeleton.boneInverses);
  });
  target.traverse((object) => {
    const baked = options && options.bakeCurrentFrame ? glbBakeCurrentFrame(object, state) : false;
    const exportObject = baked ? object : (glbPrepareCustomSkin(object, state) || object);
    const sourceMaterials = glbSourceMaterials(exportObject);
    glbPrepareExportGeometry(exportObject, sourceMaterials, state);
    if (!exportObject.material) return;
    const convert = (m) => glbCreateExportMaterial(m, state);
    exportObject.material = Array.isArray(exportObject.material) ? exportObject.material.map(convert) : convert(exportObject.material);
  });
  return target;
}
function glbDisposeExportState(state) {
  for (const geo of state.geometries) geo.dispose();
  for (const mat of state.materials) mat.dispose();
  for (const tex of state.textures) tex.dispose();
  state.geometries.clear();
  state.materials.clear();
  state.textures.clear();
  state.texturesByKey.clear();
  if (state.customSkins) state.customSkins.clear();
}
function exportGLB(options) {
  if (!currentMesh) return;
  const state = {
    geometries: new Set(),
    materials: new Set(),
    materialsBySource: new Map(),
    textures: new Set(),
    texturesByKey: new Map(),
    customSkins: new Map(),
  };

  let target;
  try {
    target = glbBuildExportRoot(currentMesh, state, options);
  } catch (err) {
    glbDisposeExportState(state);
    toast('GLB 导出失败: ' + err, true);
    return;
  }

  const exporter = new GLTFExporter();
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    glbDisposeExportState(state);
  };
  try {
    exporter.parse(target, (result) => {
      const suffix = options && options.bakeCurrentFrame ? '_frame' : '';
      download(new Blob([result], { type: 'model/gltf-binary' }), ((currentData && currentData.name) || 'model') + suffix + '.glb');
      toast(`已导出 GLB（材质 ${state.materials.size}，贴图 ${state.textures.size}）`);
      cleanup();
    }, (err) => {
      toast('GLB 导出失败: ' + err, true);
      cleanup();
    }, { binary: true, onlyVisible: true });
  } catch (err) {
    toast('GLB 导出失败: ' + err, true);
    cleanup();
  }
}
function exportGLBCurrentFrame() {
  if (currentMesh) exportGLB({ bakeCurrentFrame: true });
}

