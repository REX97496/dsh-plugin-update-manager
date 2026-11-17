# 宣传片（dsh-plugin-update-manager）

成片：`out/dsh-plugin-update-manager-promo-1080p.mp4`
1920×1080 · 30 fps · 02:04 · H.264 + AAC 48 kHz

## 结构（122 BPM 网格，齐拍剪辑）

| 时间 | 内容 |
| --- | --- |
| 0:00 | 「插件，越装越多。」16 个真实插件逐个落位 |
| 0:13 | 版本闸日志：`skipping profile bundle "dsh-skills-manager"`，插件不加载也不报错 |
| 0:25 | 标题：插件更新管理器 —— 它只做一件事：看清版本，安全地更新 |
| 0:34 | 真实设置页截图 + 三条注释（内置 / 有兼容更新 / 本地插件） |
| 0:53 | 0.30.1 不兼容被划掉，0.26.1 兼容版落位，「更新到兼容版」 |
| 1:10 | 四档更新源（npm 官方 / npm 国内镜像 / GitHub / GitHub 国内镜像） |
| 1:16 | 失败回滚：只删目标依赖，其余 26 项原样保留 |
| 1:22 | 重启后右下角提示 → 点开升级面板 |
| 1:36 | 三条原则：不自动更新 / 不改插件内部 / 不上传 |
| 1:46 | 「更新这件事，本该这么简单。」→ 片尾卡 |

## 素材

- 界面素材来自真实运行截图：`../docs/screenshots/`、`../_recon/shots/`，裁切结果在 `assets/`。
- 合成：`comp/comp.html`（单文件，纯 `f(t)`），`comp/look.js` + `comp/msyh-sub.ttf`（Microsoft YaHei 单 face）。
- 音效：`sfx_score.py` 用 onetake 的 `sfx_palette` 合成 `sfx.wav`（101 个事件，自制的 air/glass/wood/sub/bubble）。
- 音乐床：`make_bed.py` 生成 `music/bed.wav`（见下）。

## 音乐与授权

背景音乐：**"Voxel Revolution" — Kevin MacLeod (incompetech.com)**，CC BY 4.0。
片尾卡已按要求署名；音乐仅作背景，未改动曲目本身。

如要更换音乐：把文件放到 `music/`，改 `make_bed.py` 里的文件名与窗口，重跑即可。

## 重新生成

```bash
cd promo
python3 make_bed.py                                   # 音乐床（含 duck 与淡出）
python3 sfx_score.py                                  # 音效
PATH="$PWD/bin:$PATH" python3 "$HOME/.dsh/skills/onetake/scripts/render.py" \
  comp/comp.html --out out/draft.mp4 --sfx sfx.wav --dur 124 --crf 18
ffmpeg -i out/draft.mp4 -i music/bed.wav -filter_complex \
  "[0:a]volume=1.0[sfx];[1:a]volume=0.80[mus];[mus][sfx]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,volume=0.80,loudnorm=I=-18:TP=-3.5:LRA=11,aresample=48000[aout]" \
  -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 256k -shortest out/final.mp4
```

要 4K60：把 `render.py` 换成 `--final`（3840×2160 / 60 fps，耗时与体积都显著增加）。

## 验收

`verify_promo.py out/....mp4 --comp comp/comp.html --shots ...` → **VERDICT: PASS**
（cadence CV 0.48 / rest 0.938 / audio peak −3.4 dBFS quiet 0.167 / continuity 1.00 / curves 64 px·frame⁻¹）

---

# v2（重绘版）

成片：`out/dsh-plugin-update-manager-promo-v2-1080p.mp4` · 1920×1080 · 30 fps · **01:27** · H.264 + AAC

v1 保持不变（`out/dsh-plugin-update-manager-promo-1080p.mp4`，02:04）。

## v2 改了什么

- **插件管理器不再用截图**：整块界面在合成里重绘（边框先画出来 → 标题/副标题 → 五行插件逐行划过 → 更新源与检查按钮最后出现）。
- **模拟一次检查**：点「立即检查」→ 行内「检查中…」→ 结果落到 dshmarket / dsh-better-sidebar → 「一键更新」按钮弹出。
- **更新到兼容版**：保留界面并放大聚焦到「更新到兼容版 0.26.1」，按钮移到屏幕左侧靠中间；被划掉的 0.30.1 与说明挪到右侧；鼠标移过去点击 → 「更新完成 · 重启后应用」（去掉了旧版的版本号讲解与进度条段落）。
- **节奏更紧**：镜头之间空档 ≤ 0.7 s，总时长 02:04 → 01:27；标题/开篇改为左对齐，字号加大，减少“全挤在中间”。
- 重启提示段落同样改为重绘的面板（示意弹窗），不再是截图贴图。

## v2 素材与重建

```bash
cd promo
python3 sfx_score2.py        # 音效（159 个事件，仍全部自制）
python3 make_bed2.py         # 音乐床（87 s，duck 窗口按 v2 时间轴重算）
PATH="$PWD/bin:$PATH" python3 "$DSH_SKILLS/onetake/scripts/render.py"   comp/comp2.html --out out/draft2.mp4 --sfx sfx2.wav --dur 87 --crf 18
# 混音 + 校验
ffmpeg -i out/draft2.mp4 -i music/bed2.wav -filter_complex   "[1:a]volume=1.0[mus];[0:a]volume=1.0[sfx];[mus][sfx]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-18:TP=-3.5:LRA=11[aout]"   -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 256k -shortest out/preview2.mp4
python3 "$DSH_SKILLS/onetake/scripts/verify_promo.py" out/preview2.mp4 --comp comp/comp2.html --shots 4.4,11,18,23.3,30,36.2,41.4,45,50.9,56.7,60,64.1,70.9,78,84.5
```

注意：`comp/comp2.html` 引用 `look2.js`（单独生成，避免动 v1 的 `look.js`）；`look2.js` 由 `look.py apply dusk comp2.html --cjk msyh-sub.ttf` 生成后改名。

# v3（更快、更贴真机）

目标：更短的时长、更快的音乐、更“像真的在操作 DSH”。

- **音乐换为 Kevin MacLeod — “Laser Groove”（140 BPM，CC BY 4.0）**，全片按 140 BPM 网格（B = 60/140 ≈ 0.4286 s）排点；音效 141 个事件全部落在拍点上。
- **片子 82 s**（v2 87 s）：镜头更短，句间空档压到 ≤0.7 s。
- **开场不再缩放**：开场句直接退场，不再缩成 caption，避免与插件方框列表重叠。
- **chip 阵列会呼吸**：16 个插件卡落位后各自错相位上下浮动（`5·sin(t/1.15 + i·0.85)`），每拍轻微放大；下方补一句「其中 3 个的版本被内核拒绝 · 不加载，也不报错」。
- **插件页改为真实 DSH 设置对话框**（与参考图一致的颜色/圆角/字号/按钮）：先显示「通用设置」页 → 鼠标从左侧「通用设置」移到「插件更新」→ 点击 → 页面**瞬时切换**（真机观感，不做交叉淡化）→ 镜头拉远回整页 → 工具栏与九行插件逐行滑入 → 点「立即检查」→ 行内「检查中…」→ 结果全部为「有可用更新 / 有兼容更新」（**没有更新失败行**）→ 「一键更新」弹出 → 聚焦「更新到兼容版 0.26.1」（按钮在屏幕左侧靠中间，0.30.1 划线 + 0.26.1 在右侧）→ 鼠标点击 → 「已更新到 0.26.1」+「更新完成 · 重启后应用」。
- 四档源、失败回滚、右下角浮窗、三条原则、尾句、片尾卡沿用 v2 的结构，但时长与节奏按 140 BPM 重排。

## v3 素材与重建

```bash
cd promo
python3 sfx_score3.py        # 音效（141 个事件，140 BPM 网格）
python3 make_bed3.py         # 音乐床（Laser Groove，82 s，duck 窗口按 v3 时间轴）
PATH="$PWD/bin:$PATH" python3 "$DSH_SKILLS/onetake/scripts/render.py" \
  comp/comp3.html --out out/draft3.mp4 --sfx sfx3.wav --dur 82 --crf 18
ffmpeg -i out/draft3.mp4 -i music/bed3.wav -filter_complex \
  "[1:a]volume=1.0[mus];[0:a]volume=1.0[sfx];[mus][sfx]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-18:TP=-3.5:LRA=11[aout]" \
  -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 256k -shortest out/preview3.mp4
python3 "$DSH_SKILLS/onetake/scripts/verify_promo.py" out/preview3.mp4 --comp comp/comp3.html \
  --shots 3.0,9.2,15.2,19.8,24.6,28.0,31.8,35.0,39.4,41.4,43.2,48.2,53.2,60.2,66.0,71.6,78.4
```

注意：`comp/comp3.html` 引用 `look3.js`（用 `look.py apply dusk comp3.html --cjk msyh-sub.ttf` 生成后改名）；v1/v2 分别用 `look.js` / `look2.js`，互不影响。

# v4（4K60 · 滚动片头 · 真实设置界面）

本版回应：片头插件要**横向循环滚动**、数量更多（不只本机安装的）；正常加载的插件**缩小飞向四角退场**、不加载的**放大到中央**讲解；设置页左侧导航换成**真正的图标 SVG**；修掉 57s 弹出菜单错乱；输出 **3840×2160 / 60fps / 高码率**。

- **片头**：25 张插件卡分四行**无缝横向循环滚动**（左右边缘渐变淡出）；3 张「被内核拒绝」的卡停在队列外，8.0s 时其余卡片缩小飞向四角离场，这 3 张放大到画面中央排成一行，下方接版本闸日志与「提示是没有的。它只是不加载。」
- **设置界面**：14 项左侧导航全部改用 inline SVG 图标（齿轮/立方体/插件/星芒/机器人/钱包/播放/星/扳手/书/胶片/分栏/显示器/平板），外观三张卡也用 SVG（太阳/月亮/显示器）；先显示「通用设置」→ 鼠标移到「插件更新」→ 点击 → 页面瞬时切换 → 镜头拉远。
- **57s 的浮窗场景**：不再克隆对话框（克隆会丢 ID 作用域样式导致文字重叠），改为**复用同一个对话框**，缩放到 0.79 作为浮层出现，右侧浮窗截图仍在，左下角一句说明。
- **规格**：3840×2160 · 60fps · H.264 High@5.2 · CRF 8（本片约 **10 Mbps**）· AAC 320k；渲染用 `--final --shutter 0`（无运动模糊，靠 60fps 保顺滑），约 9 分钟。

## v4 素材与重建

```bash
cd promo
PATH="$PWD/bin:$PATH" python3 "$DSH_SKILLS/onetake/scripts/render.py" \
  comp/comp4.html --final --shutter 0 --crf 16 --dur 82 --sfx sfx3.wav --out out/draft4.mp4
ffmpeg -i out/draft4.mp4 -i music/bed3.wav -filter_complex \
  "[1:a]volume=1.0[mus];[0:a]volume=1.0[sfx];[mus][sfx]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-18:TP=-3.5:LRA=11[aout]" \
  -map 0:v -map "[aout]" -c:v libx264 -preset slow -crf 10 -pix_fmt yuv420p -profile:v high -level 5.2 \
  -c:a aac -b:a 320k -movflags +faststart -shortest out/preview4.mp4
ffmpeg -i out/preview4.mp4 -c:v libx264 -preset slow -crf 8 -pix_fmt yuv420p \
  -profile:v high -level 5.2 -x264-params "keyint=120:min-keyint=60" -c:a copy -movflags +faststart out/final4-high.mp4
python3 "$DSH_SKILLS/onetake/scripts/verify_promo.py" out/final4-high.mp4 --comp comp/comp4.html \
  --shots 3.0,9.2,15.2,19.8,24.6,28.0,31.8,35.0,39.4,41.4,43.2,48.2,53.2,60.2,66.0,71.6,78.4
```

`comp/comp4.html` 用独立的 `look4.js`（`look.py apply dusk comp4.html --cjk msyh-sub.ttf` 生成后改名），v1/v2/v3 的 look 互不影响。

# v5（4K60 · 平铺片头 · 结尾署名）

- 片头：25 张插件卡**平铺成 5×5**（不再滚动），入场 stagger 后短暂停留。
- 分裂：普通卡缩到 28% 飞向四角淡出；被内核拒绝的 3 张卡放大到中央一排，接版本闸日志。
- 设置页：沿用 v4 的真实重绘界面 + 内联 SVG 导航图标。
- 鼠标指针：`#cursor` z-index 60（不再被对话框盖住）、`#tap` 跟随指针；聚焦段左下角标签移到 y=906/948 空白带。
- 结尾卡：头像（`assets/avatar.png`，取自用户 GIF）+ 昵称 **SpaceSphere** + 「本插件由 DSH 创造模式制作」+ `github.com/REX97496/dsh-plugin-update-manager`，并有一道低强度扫光（`#endSheen`）。
- 音乐：`make_bed4.py`，结尾不再 duck（只在 0–1.7 / 14.6–20.2 / 59.8–66.4 / 66.2–70.1 处压低），80.8–82 淡出。
- 渲染：`render.py comp/comp5.html --final --shutter 0 --crf 16 --dur 82 --sfx sfx3.wav` → 混 `music/bed4.wav` → 编码 CRF 8 → `verify_promo.py` PASS（quiet 0.155 / continuity 0.88 / curves 123px@60）。
- 产物：`out/dsh-plugin-update-manager-promo-v5-4k60.mp4`（3840×2160 · 60fps · 10.5 Mbps · 107.7 MB · 82s）。

# v6（4K60 · 滚动插件墙 · 提示弹窗）

- 片头：45 张卡片（含网上查到的真实 DSH 插件：@dshhubs/plugin-search、dsh-find-plugins、dsh-hub-plugin、dsh-mcp-market、dsh-plain-plugin-menu、dsh-client-plugin-manager、@microspotlight/openharness-find-plugin、dsh-market-github、deepSea、deepseek-plugin、dsh-1024store、dsh-dify-marketplace、dsh-employee、dsh-plgstore 等）排成 **5 行 × 9 列无缝横向滚动**（每行同相位，无空洞），2.6s 起滚动。
- 分裂：普通卡缩到 28% 飞向四角，3 张被拒卡放大到中央。
- 修指针：光标坐标改为按对话框当前的 `translate + scale` 反算（`s*(210+20+40)` 等），点击时确实落在「插件更新」上。
- 18–19s：标题出现时右下角弹出「插件更新 · 3 个插件有兼容更新」卡片（bili-scroll / billion-context / dsh-better-sidebar），20.5s 随对话框入场淡出。
- 音量：`sfx5.wav` 把 59.8–70.4 的原则/尾句音效 +4/+2 dB；`bed5.wav` 取消该段的 duck（只在 0–1.7 / 9–15 / 43.2–48.4 / 53.2–60.4 压低，ramp 0.5s），结尾不再忽大忽小。
- 产物：`out/dsh-plugin-update-manager-promo-v6-4k60.mp4`（3840×2160 · 60fps · 11.4 Mbps · 116.9 MB · 82s），`verify_promo.py` PASS（quiet 0.195，continuity 0.90，curves 172px@60）。

# v7（4K60 · 片头卡片爆散入场 · 音乐全程不降音量）

- 片头：卡片不再一开始就摆在墙上；`T.chip0` 前 0.58s 开始，45 张卡片从画面中心附近按「行 0.085s / 列 0.041s」的斜向波次**爆散飞入**各自的位置（起始 scale 0.22、blur 14px、±9° 旋转，`OM.spring(0.90, 11)` 落地），最后一行落定后插件墙才开始横向滚动（与原 v6 相同的 5 行 × 9 列、同相位无缝循环）。
- 开场句「插件，越装越多。」与卡片飞入交叠，不再出现空档；滚动的相位从入场结束时起算，所以卡片落位后是「静止一瞬 → 开始滑动」。
- 音乐：`make_bed6.py` 生成 `music/bed6.wav`，**全程恒定电平**，不再有 duck 窗口（v5/v6 曾在 0–1.7 / 9–15 / 43.2–48.4 / 53.2–60.4 压低），只在开头 0.45s 淡入、结尾 0.8s 淡出防爆音。
- 混音与成片：`mix7.py`（sfx + bed6，`MUS_GAIN=0.8`，两遍 loudnorm 线性增益到 −16 LUFS）→ `encode7.py`（CRF 8 / medium / 4K60）→ `out/dsh-plugin-update-manager-promo-v7-4k60.mp4`（3840×2160 · 60fps · 120.7 MB · 82s）。
- `verify_promo.py`：rest / burst / not-flat / continuity(0.90) / curves 全 PASS，唯一 FAIL 是 `audio quiet 0.03`（该检查要求 ≥15% 的秒级窗口接近静音）——与「任何情况下都不让声音变小」直接冲突，属于按需求刻意保留的偏离，不是缺陷。

# 封面（cover/）

- `cover/cover.html` + `cover/look.js`（`look.py apply dusk` 生成，字体子集内联）：同一份 DOM 里用 `#h` / `#v` 两套版面，`window.__layout('h'|'v')` 切换。
- 渲染：`PYTHONUTF8=1 python3 cover/shot_cover.py cover/cover.html out/covers` → 1920×1080 与 1080×1920 两张 PNG（JPG 由 ffmpeg -q:v 2 转出）。
- 视觉沿用 v7：dusk 深紫底 + 等宽卡片 + 紫色主色 / 金色辅助；横版左侧标题 + 右侧「已安装 0.20.0 → 0.26.1」主卡与四档源；竖版上标题、中主卡、下四档源与三条原则。
