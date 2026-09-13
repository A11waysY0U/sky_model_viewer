'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const ctx = {
  console,
  TextEncoder, TextDecoder, JSON, Object, Math, String, Array, Map, Set,
  Number, RegExp,
  toast() {}, renderDressPanel() {}, loadDressCharacter: async () => {},
  outfitDefs: null, dyeColorDefs: [
    { id: 38, name: 'yellow_red', hsv: [12, 34, 56] },
  ],
  outfitCatalog: null, dressSelection: {}, DRESS_SLOTS: null,
  importedCaptures: [], activeCaptureIdx: -1, apkFile: {}, dressGroup: null,
};
ctx.baseDefs = [
  { name: 'CharSkyKid_Body_Test', type: 'body', mesh: 'Body_Test', shader: 'Avatar', diffuseTex: 'CharRampAvatar' },
  { name: 'CharSkyKid_Hair_Test', type: 'hair', mesh: 'Hair_Test', shader: 'Avatar', diffuseTex: 'CharRampAvatar' },
  { name: 'CharSkyKid_Hat_Empty', type: 'hat', mesh: 'Outfit_None' },
  { name: 'CharSkyKid_Prop_FriendshipDuckSofa', type: 'prop', mesh: 'Prop_Duck', shader: 'Mesh', diffuseTex: 'Prop_Duck' },
];
ctx.overlayDefs = [
  { name: 'CharSkyKid_Hair_Test', base_hsv: [180, 40, 80] },
];

vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/src/dress.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/src/materials.js'), 'utf8'), ctx);
ctx.outfitDefs = vm.runInContext('mergeOutfitDefs(baseDefs, overlayDefs)', ctx);
ctx.outfitCatalog = vm.runInContext('buildOutfitCatalog(outfitDefs)', ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/src/outfit-import.js'), 'utf8'), ctx);

let failures = 0;
const assert = (ok, msg) => {
  if (ok) console.log('  ✓', msg);
  else { failures++; console.error('  ✗', msg); }
};

const mergedHair = ctx.outfitDefs.find((def) => def.name === 'CharSkyKid_Hair_Test');
assert(mergedHair.type === 'hair' && mergedHair.mesh === 'Hair_Test', '国服覆盖表按字段合并，不丢基础字段');
assert(JSON.stringify(mergedHair.base_hsv) === JSON.stringify([180, 40, 80]), '国服覆盖表更新 base_hsv');
assert(ctx.fnv1a32('') === 0x811c9dc5 && ctx.fnv1a32('abc') === 0x1a47e90b, 'FNV-1a 32 位结果稳定');

const id = {};
for (const def of ctx.outfitDefs) id[def.name] = ctx.fnv1a32(def.name);
const dump = {
  captures: [{
    slots: {
      'body?putBody?postBody': { id: id.CharSkyKid_Body_Test, dye: [38, 0] },
      hair: { id: 999, dye: 'yellow_red' },
      hat: { id: id.CharSkyKid_Hat_Empty },
    },
    idNameMap: { '999': 'CharSkyKid_Hair_Test' },
    body: { scale: 0.2, height: 1.2 },
    source: 'fixture',
  }],
};
const parsed = vm.runInContext('parseOutfitDumpText(' + JSON.stringify(JSON.stringify(dump)) + ')', ctx);
assert(parsed.length === 1, '解析 captures 容器');
assert(parsed[0].slots.body && parsed[0].slots.hair && parsed[0].slots.hat, '脏槽位键清洗并保留槽位');
ctx.cap = parsed[0];
const resolved = vm.runInContext('resolveCapture(cap)', ctx);
assert(resolved.fails.length === 0, '全部槽位按名称哈希和 idNameMap 解析');
assert(resolved.sel.body && resolved.sel.body.wrapper.name === 'CharSkyKid_Body_Test', 'body 槽正确解析');
assert(resolved.sel.hair && resolved.sel.hair.wrapper.name === 'CharSkyKid_Hair_Test', 'idNameMap 兜底解析 hair');
assert(JSON.stringify(resolved.sel.body.hsv) === JSON.stringify([12, 34, 56]), '数字 dye 映射到 DyeColorDefs HSV');
assert(resolved.total === 3 && resolved.resolvedCount === 2 && !resolved.sel.hat, 'Outfit_None 不穿戴，但不计为解析失败');

const myOutfit = {
  set_outfit: {
    body: { id: id.CharSkyKid_Body_Test },
    hair: { id: id.CharSkyKid_Hair_Test, dye: '(yellow_red,none)' },
    arms: { id: 0 },
    scale: 0.25,
    height: 2.5,
  },
};
const myParsed = vm.runInContext('parseOutfitDumpText(' + JSON.stringify(JSON.stringify(myOutfit)) + ')', ctx);
assert(myParsed.length === 1 && myParsed[0].source === 'my_outfit', '解析 my_outfit set_outfit');
assert(Object.keys(myParsed[0].slots).length === 2 && !myParsed[0].slots.arms, '跳过 id=0 的空槽位');
assert(myParsed[0].body.scale === 0.25 && myParsed[0].body.height === 2.5, '保留体型 scale/height');
assert(JSON.stringify(myParsed[0].slots.hair.dyeNames) === JSON.stringify(['yellow_red', 'none']), '解析命名染色');
ctx.cap = myParsed[0];
const myResolved = vm.runInContext('resolveCapture(cap)', ctx);
assert(myResolved.sel.hair && JSON.stringify(myResolved.sel.hair.hsv) === JSON.stringify([12, 34, 56]), '命名染色映射到 HSV');

let invalidRejected = false;
try { vm.runInContext('parseOutfitDumpText(\'{"foo":1}\')', ctx); } catch (e) { invalidRejected = /没有装扮记录/.test(e.message); }
assert(invalidRejected, '缺少装扮字段的 JSON 被拒绝');

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
