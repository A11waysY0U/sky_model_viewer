/* ===== zip.js ===== */
// ============================================================
// Sky Mesh Viewer —— ZIP/APK 读取模块
// 通过 File.slice 按需读取，不把整个 APK 读进内存
// ============================================================

// 从 Blob 读取指定范围为 Uint8Array
// 大文件（>2GB ipa）按需读取：不整包入内存（手机扛不住），每次只 slice 一小段。
// Chrome/移动端对大文件并发 slice 易抛 NotReadableError——用全局串行队列逐个读，
// 每段重试多次，再退回 FileReader，最大化稳定性。内存占用只跟单次读的段大小相关（几 MB）。
let _readChain = Promise.resolve();
function _readSliceOnce(file, start, end) {
  return new Promise((resolve, reject) => {
    // 优先 Blob.arrayBuffer；失败由外层重试/退路处理
    file.slice(start, end).arrayBuffer()
      .then(buf => resolve(new Uint8Array(buf)))
      .catch(reject);
  });
}
function _readSliceFR(file, start, end) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result));
    fr.onerror = () => reject(fr.error || new Error('FileReader 读取失败'));
    try { fr.readAsArrayBuffer(file.slice(start, end)); } catch (e) { reject(e); }
  });
}
async function readSlice(file, start, end) {
  // 串行化：把本次读取排到链尾，保证同一时刻只有一个 slice 在读大文件
  const run = _readChain.then(async () => {
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { return await _readSliceOnce(file, start, end); }
      catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 100 * (attempt + 1))); }
    }
    // 退路：FileReader（部分环境比 Blob.arrayBuffer 稳），也重试几次
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await _readSliceFR(file, start, end); }
      catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 150 * (attempt + 1))); }
    }
    throw lastErr || new Error('读取失败');
  });
  // 无论成败都让链继续（不因单次失败卡死后续读取）
  _readChain = run.then(() => {}, () => {});
  return run;
}

// >2GB 文件（iOS ipa）：Chrome 对 2^31 以上偏移的 slice 是确定性 NotReadableError，
// 纯按需读会在读文件尾部的 zip 目录时就失败。唯一可靠绕法是 file.stream() 流式读取
// （stream 不用大偏移，不受该 bug 影响）。读入内存分块后包成 ChunkedFile，暴露与
// File 兼容的 slice(s,e).arrayBuffer()，让现有 zip 解析代码零改动地随机访问。
// 代价：整包驻留内存（约文件大小），手机大内存机型可行、低端机可能崩——这是浏览器平台硬限制。
class ChunkedFile {
  constructor(chunks, offsets, size) { this._chunks = chunks; this._offsets = offsets; this.size = size; }
  _findChunk(pos) {
    let lo = 0, hi = this._offsets.length - 1, ans = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (this._offsets[mid] <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  _read(start, end) {
    const len = Math.max(0, end - start);
    const out = new Uint8Array(len);
    if (len === 0) return out.buffer;
    let i = this._findChunk(start), written = 0;
    while (written < len && i < this._chunks.length) {
      const cStart = this._offsets[i], chunk = this._chunks[i];
      const localFrom = (start + written) - cStart;
      const take = Math.min(chunk.length - localFrom, len - written);
      out.set(chunk.subarray(localFrom, localFrom + take), written);
      written += take; i++;
    }
    return out.buffer;
  }
  slice(start, end) {
    const s = start < 0 ? 0 : start;
    const e = (end === undefined || end > this.size) ? this.size : end;
    const self = this;
    return { arrayBuffer: async () => self._read(s, e) };
  }
}
async function buildChunkedFile(file, onProgress) {
  const chunks = [], offsets = [];
  let total = 0, lastPct = -1;
  const reader = file.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    offsets.push(total);
    chunks.push(value);
    total += value.length;
    if (onProgress && file.size) {
      const pct = Math.floor(total / file.size * 100);
      if (pct !== lastPct) { lastPct = pct; onProgress(total / file.size); }
    }
  }
  return new ChunkedFile(chunks, offsets, total);
}

// 读中央目录，返回条目数组 [{name, method, compSize, uncompSize, localOff}]
async function readCentralDirectory(file) {
  const size = file.size;
  // 读尾部 (EOCD + 可能的注释)，最多 64K+22
  const tailLen = Math.min(size, 65557);
  const tail = await readSlice(file, size - tailLen, size);
  const tdv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  // 找 EOCD 0x06054b50
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tdv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('未找到 ZIP 结尾记录，可能不是有效的 APK/ZIP');

  let cdOffset = tdv.getUint32(eocd + 16, true);
  let cdSize = tdv.getUint32(eocd + 12, true);
  let total = tdv.getUint16(eocd + 10, true);

  // ZIP64
  if (cdOffset === 0xFFFFFFFF || total === 0xFFFF || cdSize === 0xFFFFFFFF) {
    const locPos = eocd - 20;
    if (locPos >= 0 && tdv.getUint32(locPos, true) === 0x07064b50) {
      const eocd64Off = Number(tdv.getBigUint64(locPos + 8, true));
      const e64 = await readSlice(file, eocd64Off, eocd64Off + 56);
      const e64dv = new DataView(e64.buffer, e64.byteOffset, e64.byteLength);
      if (e64dv.getUint32(0, true) === 0x06064b50) {
        total = Number(e64dv.getBigUint64(32, true));
        cdSize = Number(e64dv.getBigUint64(40, true));
        cdOffset = Number(e64dv.getBigUint64(48, true));
      }
    }
  }

  // 读整个中央目录
  const cd = await readSlice(file, cdOffset, cdOffset + cdSize);
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const dec = new TextDecoder();
  const entries = [];
  let p = 0;
  for (let n = 0; n < total; n++) {
    if (p + 46 > cd.length || dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    let compSize = dv.getUint32(p + 20, true);
    let uncompSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nameLen));
    if (compSize === 0xFFFFFFFF || uncompSize === 0xFFFFFFFF || localOff === 0xFFFFFFFF) {
      let ep = p + 46 + nameLen;
      const extraEnd = ep + extraLen;
      while (ep + 4 <= extraEnd) {
        const hid = dv.getUint16(ep, true);
        const hsz = dv.getUint16(ep + 2, true);
        let fp = ep + 4;
        if (hid === 0x0001) {
          if (uncompSize === 0xFFFFFFFF) { uncompSize = Number(dv.getBigUint64(fp, true)); fp += 8; }
          if (compSize === 0xFFFFFFFF) { compSize = Number(dv.getBigUint64(fp, true)); fp += 8; }
          if (localOff === 0xFFFFFFFF) { localOff = Number(dv.getBigUint64(fp, true)); fp += 8; }
        }
        ep += 4 + hsz;
      }
    }
    entries.push({ name, method, compSize, uncompSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// 提取单个条目为 Uint8Array（按需 slice + 解压）
async function extractEntry(file, entry) {
  // local header 长度不确定，读 30 字节头，得到 name/extra 长度
  const head = await readSlice(file, entry.localOff, entry.localOff + 30);
  const hdv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (hdv.getUint32(0, true) !== 0x04034b50) throw new Error('local header 签名错误');
  const nameLen = hdv.getUint16(26, true);
  const extraLen = hdv.getUint16(28, true);
  const dataStart = entry.localOff + 30 + nameLen + extraLen;
  const comp = await readSlice(file, dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return comp;
  if (entry.method === 8) return await inflateRaw(comp);
  throw new Error('不支持的压缩方法 ' + entry.method);
}

// 用浏览器 DecompressionStream 做 raw deflate 解压
async function inflateRaw(comp) {
  if (typeof DecompressionStream === 'undefined')
    throw new Error('浏览器不支持 DecompressionStream');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([comp]).stream().pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}


