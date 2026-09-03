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
function exportGLB() {
  if (!currentMesh) return;
  const exporter = new GLTFExporter();
  // 单网格：克隆几何配临时材质导出；换装/地图是 Group（无 geometry、currentData 可能为 null），直接导出整个对象树
  const single = currentMesh.geometry != null;
  const exportName = (currentData && currentData.name) || 'model';
  let target, tmpGeo = null, tmpMat = null;
  if (single) {
    tmpGeo = currentMesh.geometry.clone();
    tmpMat = new THREE.MeshStandardMaterial({ color: 0xb8c2d0, roughness: 0.65, side: THREE.DoubleSide });
    target = new THREE.Mesh(tmpGeo, tmpMat);
  } else {
    target = currentMesh;
  }
  exporter.parse(target, (result) => {
    download(new Blob([result], { type: 'model/gltf-binary' }), exportName + '.glb');
    toast('已导出 GLB');
    if (tmpGeo) tmpGeo.dispose();
    if (tmpMat) tmpMat.dispose();
  }, (err) => {
    toast('GLB 导出失败: ' + err, true);
    if (tmpGeo) tmpGeo.dispose();
    if (tmpMat) tmpMat.dispose();
  }, { binary: true });
}

