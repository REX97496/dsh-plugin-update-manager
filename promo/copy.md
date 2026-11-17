# 宣传文案（标题 / 简介）

## 长标题（视频站、博客、README 顶部）

DSH 插件更新管理器：把「装上了却不生效」变成一眼看得见——兼容版优先、四档更新源、原子回滚，还能一键更新与启动诊断

### 备用长标题

- DSH 插件更新管理器｜版本闸静默跳过？插件更新失败只剩一句 unknown？用它看清版本、安全更新
- 装完插件没反应、更新怕装坏、报错看不懂：一个很小的 DSH 插件，把插件更新这件事讲清楚

## 短标题（信息流、群分享、封面角标）

- 插件更新管理器 · 兼容版优先
- DSH 插件更新管理器：一眼看清版本
- 插件更新，别再用猜的

## 简介（含下载方式 + 解决的痛点）

DSH 装插件多了以后，最常见的三个坑：一是版本闸会**静默跳过**不兼容的插件——日志里一行 `skipping profile bundle`，界面上什么都不显示，你只看到「装了但没出现」；二是「更新到最新版」可能正好是不兼容的那一版，装完反而从列表里消失；三是更新失败时只剩一句 `unknown`，不知道是网络、文件锁、还是包本身的构建脚本被拦。

dsh-plugin-update-manager 是一个很小的 DSH 插件，只做三件事：**看清版本、安全更新、失败能退回来**。

它会读取 profile 的安装清单和已装版本，算出「已装 / 最新 / 与本机 DSH 兼容的最高版本」；最新版不兼容时，默认帮你选兼容版（必要时降级，让插件重新被加载），并标出会触发版本闸的风险版本。更新是原子的：先备份 `package.json` 与 lockfile，安装后回读版本、复跑兼容判定，失败就连同依赖和 `dsh.profile.bundles` 一起回滚。更新源支持 npm 官方、npm 国内镜像、GitHub Release、GitHub 国内镜像四档，可在全局和单个插件上切换。另有启动诊断（找出加载失败的插件和原因）、检查中的行内指示与扫光、一键更新、卸载与重新安装，以及更新完成后右下角的提示浮窗。

### 下载与安装

npm 包名：`dsh-plugin-update-manager`（当前版本 0.1.6，`npm view dsh-plugin-update-manager version` 可查）
GitHub：`https://github.com/REX97496/dsh-plugin-update-manager`

桌面版 profile 由 Electron 独占，外部 `dsh plugin --profile desktop` 会被拒绝，所以装法是直接在 profile 目录里用 pnpm：

```
cd %USERPROFILE%\.dsh\profiles\desktop
corepack pnpm add dsh-plugin-update-manager --save-exact --config.strict-dep-builds=false
```

也可以从 GitHub 拿源码本地装（适合想看代码或改一行的人）：

```
git clone https://github.com/REX97496/dsh-plugin-update-manager
cd %USERPROFILE%\.dsh\profiles\desktop
corepack pnpm add file:E:\path	o\dsh-plugin-update-manager --save-exact
```

装好后把 `dsh-plugin-update-manager` 加进该 `package.json` 的 `dsh.profile.bundles` 数组，完全退出 DSH 桌面版（含托盘）再打开；设置 → 插件更新 里就能看到版本状态。命令行兜底：

```
node "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-plugin-update-manager\lib\cli.js" check  <包名>
node "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-plugin-update-manager\lib\cli.js" update <包名> --version <x.y.z>
```

要求：DSH 0.2.x（`engines.dsh >=0.2.0-rc.2 <0.4.0`），Node 20+。插件不自动更新、不改插件内部文件、不上传任何状态，所有数据只在 `$DSH_HOME/plugin-updater/`。

### 适合谁

- 装了一堆插件、升级 DSH 后「有些插件突然不见了」的人
- 想升级但怕升到不兼容版本、装坏 profile 的人
- 在墙内、npm/GitHub 时好时坏，需要一个能换源的人
- 更新失败只看到 `unknown`、想直接看到 pnpm 原文的人
