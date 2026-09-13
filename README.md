# Sky Model Studio

This is the split version of the original single-file `sky_model_studio.html`.
Open `index.html` directly; no build step or local server is required.

## Structure

- `index.html`: page structure and script loading order
- `css/main.css`: UI styles
- `js/vendor/three.js`: self-contained Three.js r160 runtime
- `js/src`: mesh, texture, animation, map, import, rendering, and UI logic

## Run

Double-click `index.html`, or host this directory with any static file server.

## Import sources

- **导入安装包**：Sky 的安卓 APK / iOS IPA（zip 格式）。
- **从安装目录导入**：电脑版 Sky 安装目录下的 `pak` 文件夹（如 `D:\SkyRE\sky\pak`），
  其中 `*.pak` 为 zip 格式资源包，导入时合并全部 pak 的条目；超过 2GB 的 pak 会自动
  按浏览器能力选择按需读取或整包载入内存。PC 包没有 OutfitDefs.json / UIPackedAtlas.lua，
  衣柜（换装）按钮在 pak 模式下不可用，其余功能（模型列表、贴图、地图、动画、导出）正常。
- **导入装扮**（衣柜面板内）：支持 `my_outfit.json`（顶层 `set_outfit`，含命名染色）以及
  `frida/sky_room_outfit_dump.js` 抓取的房间玩家外观 JSON；按槽位组装角色。需要先导入含
  OutfitDefs.json / DyeColorDefs.json 的包（APK）。国服包会额外合并
  OutfitDefs_Netease.json，以解析 FriendshipDuckSofa 等区域专属部件。

## frida/

`sky_room_outfit_dump.js`：Hook 国服 Sky.exe 的外观解析链路，抓取房间内指定玩家的
装扮（槽位 id/染色/体型）并导出 JSON，供 viewer 的「导入装扮」使用。
配套分析见 `D:\SkyRE\Sky_房间玩家体型与装扮_获取机制_Ghidra分析.md`。

## GLB 导出

导出会保留当前对象树，并把 `skyMaterial` 的自定义纹理槽转换为 glTF 材质：

- `uTex` → `baseColorTexture`
- `uNormTex` → `normalTexture`
- `uLightTex` → `occlusionTexture`（使用 UV1，取光照图 G 通道作为 AO）
- `uDiffuse2Tex` → 仅在没有 `uTex` 时作为 `baseColorTexture`（glTF 不支持双 UV 反照率相乘层）
- HSV 染色、基础色、透明度、alpha test、双面/线框与顶点色会写入导出的材质

预览界面的「白模」开关不会影响 GLB 中的材质和贴图。游戏自定义光照、镜面/菲涅尔、
第二层色叠加属于非 PBR 效果，只能近似转换为标准 glTF 材质。

## 3MF 导出

3MF 导出会烘焙当前可见静态网格的世界变换，并写入：

- 3MF Core 三角网格与对象
- 3MF Core 基础材质和颜色
- 可用的主贴图 PNG（`texture2d` / `texture2dgroup`）

3MF 不支持骨骼动画、glTF 式 PBR 法线/金属度/粗糙度纹理以及游戏自定义光照；
透明材质会使用带 Alpha 的基础颜色或 PNG，但不同 3MF 查看器/切片器的支持程度不一致。
