# dsh-plugin-update-manager

在 DSH 设置页集中查看**已安装插件**的版本状态，并把插件安全地升级到「最新版」或「与当前 DSH 运行时兼容的版本」。

DSH 的插件有 `engines.dsh` / `@deepseek-ai/dsh*` peer 版本闸，直接 `pnpm add` 到最新版经常会被宿主拒绝加载。本插件把「检查 → 选目标版本 → 备份 → 安装 → 回读校验 → 失败回滚」做成一条可回退的链路，并把不可用的版本挡在选择阶段。

- 四种更新源：npm 官方、npm 国内镜像（默认）、GitHub、GitHub 国内镜像（自动回退）
- 兼容性判定与宿主一致：`engines.dsh` 优先，peer 兜底
- 原子更新：失败时 profile 的 `package.json`、`pnpm-lock.yaml`、`node_modules/<pkg>` 逐字节/逐目录恢复
- 不引入任何第三方依赖，不向 DSH 之外发送数据

> 界面截图（真实宿主 0.2.0-rc.2 + 真实 npm 镜像与真实 pnpm 更新流程）：
>
> - `docs/screenshots/section-update-available.png` — 设置 → 插件更新：可更新状态（已装版本下方带 `→ 兼容版` 徽标）
> - `docs/screenshots/update-toast.png` — 每次重启 DSH 后，右下角提示「哪些插件有兼容更新及版本号」，点击即打开升级浮层
> - `docs/screenshots/update-toast-dialog.png` — 点击浮窗后打开的自绘升级浮层（同一张表 + 行内更新按钮）
> - `docs/screenshots/one-click-update.png` — 工具行：「立即检查」右侧的「一键更新」（仅当有兼容更新时出现）
> - `docs/screenshots/one-click-updated.png` — 点「一键更新」后：串行更新全部可更新插件，汇总条 + 行内「需重启生效 / 重启 DSH」
> - `docs/screenshots/update-all-summary.png` — 「一键更新」完成后的汇总条 + 行内「需重启生效 / 重启 DSH」
> - `docs/screenshots/restart-guide.png` — 宿主无重启接口时的退出引导
> - `docs/screenshots/tab-in-builtin-plugins.png`
> - `docs/screenshots/diag-banner.png` — 启动诊断横幅：「启动诊断：N 个插件加载异常 / 查看分析 / 重新诊断」
> - `docs/screenshots/diag-dialog.png` — 诊断分析弹窗：每个异常的插件、错误码、原因、可复制修复命令 — 同样的表格也注册在「设置 → 内置插件 → 插件更新」tab
> - `docs/screenshots/diag-toast-rich.png` — 重启后的右下角启动诊断浮窗：异常插件名 + 错误码 + 发现时间，点任意一条直接定位
> - `docs/screenshots/diag-dialog-rich.png` — 从浮窗点进来后的诊断弹窗：汇总行（条目数/扫描文件数/检查时刻）、严重级别、绝对+相对时间、日志预览
> - `docs/screenshots/row-checking.png` — 检查进行中：行首旋转指示器、状态列「正在检查」、整行扫光
> - `docs/screenshots/light-theme.png` — 浅色主题下的更新源下拉：背景与文字都跟随主题，不再白底白字
> - `docs/screenshots/manage-rows.png` — 每行右侧「⋯」菜单入口 + 加载失败红色徽标
> - `docs/screenshots/manage-menu.png` — 「⋯」菜单展开：重新安装 / 卸载
> - `docs/screenshots/manage-uninstall-confirm.png` — 卸载确认弹窗（删 dependencies 与 bundles、需重启）
> - `docs/screenshots/manage-loadfailure.png` — 点红色「加载失败」只查看该插件的诊断原因

## 环境要求

| 项 | 要求 |
|---|---|
| DSH | `>=0.2.0-rc.2 <0.4.0`（桌面版 0.2.1-rc.4 实测） |
| Node.js | `>=20`（开发机 v24.20.0） |
| 包管理器 | pnpm（宿主注入优先，其次 PATH，最后 corepack） |

## 安装

插件已发布到 npm：[`dsh-plugin-update-manager`](https://www.npmjs.com/package/dsh-plugin-update-manager)。

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add dsh-plugin-update-manager --save-exact
```

装完后把 `dsh-plugin-update-manager` 加进该 profile `package.json` 的 `dsh.profile.bundles`，再完全退出并重开桌面版。

插件需要装进**目标 profile 的 `node_modules`**，并在该 profile 的 `package.json` 里登记 bundle。

### 方式一：在 profile 目录用 pnpm 安装（推荐，可离线）

```powershell
# 1) 打包（在插件仓库根目录）
pnpm pack
# 产出 dsh-plugin-update-manager-0.1.0.tgz

# 2) 进入桌面版 profile 目录（Windows 默认路径）
cd "$env:USERPROFILE\.dsh\profiles\desktop"

# 3a) 直接用本地目录（开发调试）
pnpm add file:E:\project\dsh-plugin-update-manager
# 3b) 或用打包产物
pnpm add .\dsh-plugin-update-manager-0.1.0.tgz
```

安装后检查该 profile 的 `package.json`，确认：

```json
{
  "dependencies": { "dsh-plugin-update-manager": "file:..." },
  "dsh": { "profile": { "bundles": ["...", "dsh-plugin-update-manager"] } }
}
```

`dsh.profile.bundles` 若未自动追加，需要手动加入 `"dsh-plugin-update-manager"`（数组元素也可以是 `{ "id": "...", "name": "..." }` 形式）。

### 方式二：`dsh plugin add`

```powershell
dsh plugin add dsh-plugin-update-manager
# 本地包：dsh plugin add file:E:\project\dsh-plugin-update-manager
```

桌面版 profile 由 Electron 进程内的 plugin manager 独占，某些版本会拒绝 CLI 对 `desktop` profile 的写操作。若命令被拒绝，请改用方式一。

### 安装后必须重启

**桌面版要完全退出（含托盘图标）再重新打开**，仅刷新页面不够。宿主进程会缓存已加载的 bundle，Windows 上还持有 `node_modules` 里的文件句柄，不退出会导致安装/更新出现 `EPERM`。

## 配置

配置文件：`<DSH_HOME>/plugin-updater/config.json`

- 默认 `<DSH_HOME>` 为 `~/.dsh`，Windows 即 `C:\Users\<你>\.dsh`
- 若 profile 的 `package.json` 在上层提供 `dshHome` / 环境变量 `DSH_HOME` 存在，则优先使用
- 文件不存在时按默认值工作；写入是「临时文件 + rename」的原子写，损坏文件自动回退默认值

```json
{
  "defaultSource": "npm-mirror",
  "customRegistry": "",
  "githubMirrorPrefixes": ["https://gh-proxy.com", "https://ghfast.top", "https://ghproxy.net"],
  "allowPrerelease": false,
  "checkIntervalHours": 6,
  "ignore": [],
  "perPackageSource": {},
  "proxyUrl": "",
  "requestTimeoutMs": 8000,
  "concurrency": 4,
  "totalTimeoutMs": 30000,
  "checkOnStartup": "force",
  "autoCheckOnStart": true
}
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `defaultSource` | `'npm-official' \| 'npm-mirror' \| 'github' \| 'github-mirror'` | `"npm-mirror"` | 全局默认更新源；非法值回落到默认 |
| `customRegistry` | string | `""` | 自定义 npm registry（必须 `http(s)://`）。非空时**覆盖**两个 npm 源的默认地址 |
| `githubMirrorPrefixes` | string[] | `gh-proxy.com`、`ghfast.top`、`ghproxy.net` | GitHub 国内镜像前缀，按顺序回退；仅接受 http(s)，自动去掉尾部 `/` |
| `allowPrerelease` | boolean | `false` | 是否把 rc/beta 纳入候选（已装预发布时无论如何都允许） |
| `checkIntervalHours` | number | `6` | 检查节流窗口（0.05–720 小时） |
| `ignore` | string[] | `[]` | 不检查、不提示的插件名（精确匹配） |
| `perPackageSource` | object | `{}` | 单包覆盖更新源，如 `{ "some-plugin": "github" }`，只保留合法源 |
| `proxyUrl` | string | `""` | 可选 HTTP(S) 代理，供插件自身的检查请求使用（仅 `http(s)://` 合法，非法忽略）；安装子进程的代理由 pnpm 的 `npm_config_*` 变量决定 |
| `requestTimeoutMs` | number | `8000` | 单次 HTTP 请求超时（1000–60000 ms） |
| `concurrency` | number | `4` | 检查并发数（1–16） |
| `totalTimeoutMs` | number | `30000` | 一轮检查的总时长上限（5000–300000 ms） |
| `checkOnStartup` | `'force' \| 'throttle'` | `"force"` | 启动检查语义：`force` = 每次重启都强制检查（右下角提示因此能拿到最新结果）；`throttle` = 走 `checkIntervalHours` 节流；非法值回落 `force` |
| `autoCheckOnStart` | boolean | `true` | 旧字段（legacy），保留仅为兼容旧配置；启动检查现在由 `checkOnStartup` 控制 |

其余状态（`cache.json`、`update-log.jsonl`、`backups/`）都存在同一目录 `<DSH_HOME>/plugin-updater/` 下。

## 四档更新源

| 源 id | 名称 | 默认地址 | 说明 |
|---|---|---|---|
| `npm-official` | npm 官方 | `https://registry.npmjs.org` | 最权威，国内可能慢 |
| `npm-mirror` | npm 国内镜像 | `https://registry.npmmirror.com` | **默认**，请求 `Accept: application/vnd.npm.install-v1+json` 拿精简元数据 |
| `github` | GitHub Releases | `https://api.github.com` | 从 `manifest.repository` 或 `customRepository` 解析 `owner/repo` |
| `github-mirror` | GitHub 国内镜像 | 见 `githubMirrorPrefixes` | 所有 URL 变为 `<prefix>/<完整原始 URL>`，前缀按顺序回退 |

**GitHub 源的行为**：

1. 优先读 Releases（`/releases?per_page=100`）；资产名匹配 `.tgz` / `.tar.gz` 时记为 `installKind: tarball`，**`installSpec` 就是这个 release 资产的下载 URL**（`browser_download_url`；`github-mirror` 源会加上可用的镜像前缀，例如 `https://ghfast.top/https://github.com/.../pkg-1.2.3.tgz`）。资产 URL 安装不会执行包的 `prepare` 构建脚本，因此不受 pnpm 12 默认 `allowBuilds: []` 的限制。
2. Releases 为空则回退 tags（`/tags`）；tag 去掉 `v` 前缀后必须是合法 semver。
3. 没有 `.tgz` / `.tar.gz` 资产时只能给源码包（`installKind: source-tarball`，`installSpec` 为 `github:<owner>/<repo>#<tag>`），并给出**该版本大概率装不上**的警告；这类目标会在安装前被拒绝（`github-source-needs-build`），提示改用 npm 源。
4. 每个候选的 manifest 从 `raw.githubusercontent.com/<o>/<r>/<tag>/package.json` 读取；取不到记为 `null`，该候选不会被默认推荐。
5. **release 资产安装后 profile 里的依赖会记为资产 URL**（例如 `https://github.com/.../releases/download/v1.2.3/pkg-1.2.3.tgz`），而不是 `name@version`；下次切回 npm 源更新时会恢复为 `name@version`。镜像前缀只出现在 URL 前缀里，不会把 `https://mirror/https://...` 交给 pnpm 当 integrity 校验对象——镜像 URL 本身就是一份合法的远程 tarball 地址。
6. `github-mirror` 遇到网络错误或 5xx 会换下一个前缀；成功后**在本进程内记住**可用前缀，后续请求从它开始。当前生效的前缀会写进该次检查的 warnings。

> GitHub / GitHub 国内镜像源优先从 **release 资产（.tgz / .tar.gz）** 安装，安装后 profile 里该依赖会记为资产 URL；下次切回 npm 源更新会恢复为 `name@version`。**没有 release 资产的版本会被直接拒绝**并提示改用 npm 源（见「故障排查」）。

匿名 GitHub REST API 限流为 **60 次/小时**；检查大量 GitHub 来源插件时可能触发 `rate-limit`，建议配一个 `npm-*` 源或降低检查频率。

## 检查与一键更新

设置页「插件更新」的工具行从左到右：**更新源选择器 → 立即检查 → 一键更新 → （右侧）最后检查时间**。

- **立即检查**：绕过 6 小时节流，立刻检查当前列表里的全部插件。
- **一键更新**：只在「检查后有插件存在兼容的新版本」时出现（按钮 hover 显示「更新全部 N 个有兼容版本的插件」）。点击后按列表顺序**串行**更新所有可更新插件，单个失败不阻断后续；完成后表格上方出现汇总条（成功/失败数 + 可复制的报告），每行原位变为「需重启生效 / 重启 DSH」。没有可更新项时按钮自动消失，列表不抖动。
- 更新期间所有行与按钮禁用，行内显示「更新中/排队」，不会弹全局进度框。

## 版本状态与兼容性判定

| status | 含义 | 主操作 |
|---|---|---|
| `checking` | 正在检查 | 行内骨架 |
| `latest` | 已装 = 最新且兼容 | 无（灰字「最新」） |
| `update-latest` | 最新版兼容且比已装新 | 更新到 `X.Y.Z` |
| `update-compatible` | 最新版不兼容，但有比已装新的兼容版 | 更新到兼容版（次要选项：更新到最新版，有风险） |
| `switch-compatible` | **已装版本本身不兼容**，但存在兼容版本（可能更低） | 切换到兼容版（明确提示降级） |
| `incompatible-no-compatible` | 不兼容且无任何兼容候选 | 查看原因（列出未满足项） |
| `local` | `link:` / `file:` / 本地目录 | 无（灰标签「本地」） |
| `builtin` | `@deepseek-ai/*` 宿主内置 bundle | 无（禁用） |
| `error` | 检查失败（网络 / 404 / 私有包 / 限流） | 重试 |

**判定规则**（与宿主版本闸一致）：

1. manifest 有 `engines.dsh` 时，**只看它**，忽略 peer；空字符串或非法 range 视为不兼容。
2. 否则检查 `peerDependencies` 中 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 前缀的条目，**全部满足**才兼容；`workspace:^` / `workspace:~` / `workspace:*` 视为「当前运行时版本」。
3. 预发布策略：已装是稳定版时默认丢弃 rc/beta，`allowPrerelease: true` 才放开；已装本身是预发布时始终允许。
4. 安装了不兼容版本时，会算出 `compatibleMax`（兼容候选中的语义最大者）并给出「切换到兼容版」——这可能是一次**降级**，UI 会显式提示。
5. 提示方向：失败项低于下限 → 升级 DSH 有用；高于上限 → 升级 DSH 也没用，应换插件版本。

## 重启后的右下角更新提示

每次 DSH 重启后，host 会在挂载 6 秒后按 `checkOnStartup` 跑一次启动检查（默认 `force`，即不受 6 小时节流限制）。检查完成后，如果存在**有兼容更新目标**的插件（`update-latest` / `update-compatible` / `switch-compatible`）：

- 右下角出现一张浮窗，最多列出 3 个插件：「包名 + 当前版本 → 兼容目标版本」，超过 3 个显示「等 N 个」；
- 点击浮窗（整卡可点，也支持 Enter/Space）会打开一个自绘的升级浮层，里面就是「设置 → 插件更新」那张表，可直接在行内点更新；
- 右上角 `×` 可关闭；点到遮罩、按 Esc 或点浮层右上角关闭浮层；
- 同一次启动只弹一次（用 host 的 `bootId` 记在 `localStorage`），刷新页面不会重复弹；下次重启（新 `bootId`）重新提示。

> 没有兼容更新、或只存在 `incompatible-no-compatible` 的插件时，浮窗不出现（这类情况请到设置页查看原因）。
> 浮窗依赖宿主 slot `shell.overlay`；即使该 slot 不可用，也只是不弹浮窗，不影响设置页功能。

## 原子更新与回滚

一次更新的固定顺序：

1. **校验入参**：包名、版本号格式；目标版本必须非空。
2. **备份**到 `<DSH_HOME>/plugin-updater/backups/<name>@<stamp>/`：
   - `package.json`
   - `pnpm-lock.yaml`（存在才备份）
   - `node_modules/<name>`（递归复制；超过 200MB 时跳过并降级为「只回滚 manifest」）
3. **安装**：包管理器按 `profile.packageManager` → PATH `pnpm` → `corepack pnpm` → `corepack pnpm@11` 顺序解析；命令为
   `add <spec> --save-exact --reporter=append-only`，`cwd = profile.dir`，环境里固定 `CI=true`、`npm_config_confirm_modules_purge=false`，并把 `HTTPS_PROXY/HTTP_PROXY/NO_PROXY` 映射成 `npm_config_*`（pnpm 只认后者）。Windows 上 `.cmd` 走 `cmd.exe /d /s /c` 并 `windowsHide`。
4. **回读校验**：`node_modules/<name>/package.json` 的 version 必须等于目标版本，且新 manifest 仍与本机运行时兼容（除非显式允许不兼容）；再校验 profile manifest 中**除该包依赖之外**的所有 `dependencies` 与 `dsh.profile.bundles` 逐字未变。
5. **失败回滚**：恢复 `package.json`、`pnpm-lock.yaml`，删除并还原 `node_modules/<name>`；回滚后重新读回校验，与备份不一致时报 `rollback-failed` 并在消息里给出备份目录，供手动恢复。
6. **成功**：写 `update-log.jsonl`，返回 `needsRestart: true`。

其它行为：

- 版本回读不符 → `version-mismatch`；安装进程非零退出 → `install-failed`；超时 → `timeout`；取消 → 杀掉进程树（Windows `taskkill /PID /T /F`）后回滚并返回 `cancelled`。
- 目标只能是 GitHub 源码包（`installKind: source-tarball` 或 `github:` installSpec）→ `github-source-needs-build`：在备份和安装**之前**就拒绝，profile 一个字节都不会动，消息里提示改用 npm 源或自行加 `allowBuilds`。
- 三种包管理器都不可用 → `spawn-failed`，消息里指向本文的安装说明。

> 回滚只覆盖 `package.json` / `pnpm-lock.yaml` / 目标包目录，**不是整个 profile 的完整快照**。极端情况下 pnpm 可能顺手改动 `.pnpm` store 中的相邻目录；此时需要按备份目录手动恢复。

## 命令行兜底（桌面版文件锁时使用）

桌面版运行期间会锁定 profile 的 `node_modules`，含原生模块（`.node`）的包无法被 pnpm 重命名替换，界面更新会报 `windows-file-locked`。此时用同一个插件包自带的 CLI，在**完全退出 DSH（含系统托盘）**后直接更新：

```powershell
# 用完整路径调用（profile 里已安装本插件）
node "C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-plugin-update-manager\lib\cli.js" update dshmarket --version 1.73.15

# 也可用安装时生成的 shim（profile 的 node_modules/.bin 在 PATH 中时）
dsh-plugin-update-manager update dshmarket@1.73.15
```

常用命令：

| 命令 | 说明 |
|---|---|
| `check` | 遍历所有 registry 包并打印状态（不安装） |
| `check <name>` | 只检查一个包 |
| `update <name> --version <x.y.z>` | 安装指定版本（与 `update <name>@<x.y.z>` 等价） |
| `--source <id>` | 临时指定源：`npm-official` / `npm-mirror` / `github` / `github-mirror` |
| `--profile-dir <dir>` | 指定 profile 目录（默认自动定位 desktop profile） |
| `--allow-incompatible` | 目标版本与本机 DSH 不兼容时仍安装（有被版本闸跳过的风险） |
| `--json` | 每行输出一个 JSON 事件，便于脚本处理 |

退出码：`0` 成功 / `1` 运行失败（含安装失败、回滚） / `2` 用法或前置校验失败。安装成功后仍需重新打开 DSH 才会加载新版本。

## RPC 接口简表

前缀 `/plugin-updater/api`，除 `GET /state` 外均为 `POST`，统一信封：

```json
{ "ok": true, "value": <T> }
{ "ok": false, "error": { "code": "bad-request", "message": "..." } }
```

| 方法 | 路径 | body | 返回 `value` |
|---|---|---|---|
| GET | `/state` | — | `UpdaterState`（profile、config、rows、operations、capabilities、diagnostics…） |
| POST | `/check` | `{ force?, names? }` | `{ started: true, ids }`，进度轮询 `/state` |
| POST | `/diagnose` | `{ force? }` | `Diagnostics`：`{ checkedAt, scanned[], items[], errors[] }` |
| POST | `/update` | `{ name, version }` | `{ operationId }`，立即返回 |
| POST | `/update-all` | `{ names? }` | `{ operationId, queued }` |
| POST | `/uninstall` | `{ name }` | `{ operationId }`，卸载该插件（见下节） |
| POST | `/reinstall` | `{ name, version? }` | `{ operationId }`，重装；省略 `version` 时用当前已装版本 |
| POST | `/cancel` | `{ operationId? }` | `{ cancelled: boolean }` |
| POST | `/config` | `{ patch }` 或全量 config | 归一化后的 `UpdaterState`（切源会自动重查） |
| GET | `/log` | `?limit=100` | `{ entries }` |
| POST | `/restart` | — | `{ supported, scheduled?, mode: 'desktop'\|'cli'\|'none', message }` |

更新任务串行执行：`activeOperationId` 非空时新请求排队（`operations[].state = 'queued'`）。状态里的 `capabilities` 为 `{ restart, restartMode, restartHint }`。

## 卸载与重新安装

设置页每一行插件右侧都有一个「⋯」菜单，里面是「重新安装」和「卸载」（危险色）；两者都走与更新相同的串行队列，做完需要重启宿主才会生效。操作进行中、或该行有排队任务时菜单会被禁用；两个操作都不碰别的插件，也**不允许**对本插件自己或内置/本地插件执行（菜单直接置灰，接口层返回 `self-operation` / `not-managed`）。

**卸载**（`POST /uninstall { name }`）一次做三件事：

1. 从 profile `package.json` 的 `dependencies` 删掉该包；
2. 删除 `node_modules/<包名>`；
3. 从 `dsh.profile.bundles` 里移除对应条目——按包名或 bundleId 匹配字符串或 `{ id, name }` 对象，**其余条目保持原有顺序**。

动手前会把 `package.json`、`pnpm-lock.yaml`（存在才备）和该包的 `node_modules/<包名>`（存在且不超过 200MB 才备）备份到 `<DSH_HOME>/plugin-updater/backups/<包名>@<时间戳>-uninstall/`；卸载后回读确认依赖已删、目录已不存在，任一步失败就按备份逐字节恢复并返回 `uninstall-failed`。

**重新安装**（`POST /reinstall { name, version? }`）用于修复损坏的包或退回某个已知可用版本：先整体备份，再按 §7 的流程卸掉旧包（**不动 bundles**），然后以 `version`（缺省为当前已装版本，精确版本、`--save-exact`）走正常的原子安装：备份 → 安装 → 回读校验。安装失败或版本不符时整体回滚到重装前的状态（含 `package.json`、lockfile、`node_modules/<包名>`），返回 `reinstall-failed`。

被拒绝的两个前置条件（不会产生任何文件改动）：

| 情况 | `error.code` | 说明 |
|---|---|---|
| 目标是内置包（`@deepseek-ai/*`）或 `link:`/`file:` 本地包 | `not-managed` | 内置包随 DSH 升级；本地包由你自己的工作目录管理 |
| 目标是 `dsh-plugin-update-manager` 自己 | `self-operation` | 自毁会让面板在重启前失效；升级请用更新功能 |
| 包管理器失败 / 回滚 | `uninstall-failed` / `reinstall-failed` | 失败时 `rolledBack` 为真，`backupDir` 指向备份目录 |

桌面版运行中卸载可能撞上文件锁（同更新，见「故障排查」的 `windows-file-locked`）：先完全退出 DSH（含托盘）再操作。卸载后如果还残留 UI，重启即可消失。

## 已知限制

- **桌面 profile 被 Electron 独占**：官方桌面版由宿主进程内的 plugin manager 管理插件，CLI / 第三方进程直接跑 pnpm 可能被拒绝或撞上文件锁。更新前建议完全退出桌面版，或只更新非桌面 profile。
- **重启能力视宿主而定**：插件会探测当前进程。
  - **DSH 桌面版（Electron）**：走官方 IPC（`process.send({type:'desktop-action', action:'restart'})`），等效于点设置页右上角的「重启」，会弹主进程的确认框；确认后工作环境重启、页面自动重连。
  - **CLI 宿主（`dsh web …`）**：启动一个分离的 helper，先结束当前进程再用同样命令重新拉起，页面几秒后自动重连。
  - **都不适用时**（无 IPC、找不到入口）：`POST /restart` 返回 `supported: false`，界面给出「完全退出 DSH 后重开」的引导。
- **源码 tarball 不会被自动安装**：GitHub 只有 tag、没有 release 资产时，该版本只能从源码装，pnpm 12 会因默认 `allowBuilds: []` 拒绝执行 `prepare`（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）。面板会在安装前直接拒绝（`github-source-needs-build`）并提示改用 npm 源；想强装只能在完全退出 DSH 后手动 `pnpm add`，并按需在该 profile 的 `pnpm-workspace.yaml` 里加 `allowBuilds`。
- **`@deepseek-ai/*` 只读**：宿主内置 bundle 不参与更新（状态 `builtin`）。
- **不处理本地依赖**：`link:` / `file:` / 本地目录视为 `local`，不检查、不更新。
- **插件自身请求默认不读代理环境变量**：只设 `HTTPS_PROXY` 时，检查请求不会自动走代理（会给出 warning）。可在 `config.json` 配 `proxyUrl` 让检查请求走代理；安装子进程的代理另由 pnpm 的 `npm_config_*` 变量控制。
- **GitHub 匿名 API 限流 60 次/小时**，大量 GitHub 源插件可能触发 `rate-limit`。
- **一次只服务一个 profile**（当前宿主 profile），不支持跨 profile 批量更新。
- **Self-update**：理论上可以更新自己，但当前进程仍加载旧代码，更新后必须重启；更稳妥的做法是先更新其他插件。

## 启动诊断

插件加载失败时，DSH 往往只把原因写进日志，界面上表现成「插件没生效」。本插件会读本地启动日志，把失败归因到具体插件，并给出可执行的下一步：

- 正在检查的插件：行首有旋转指示器，状态列显示「正在检查」，整行有一道缓慢扫过的光带（`prefers-reduced-motion` 下自动关闭）。
- 打开设置页时，若有异常，顶部显示「启动诊断：N 个插件加载异常」，点「查看分析」看条目，点「重新诊断」强制重扫。
- 重启后右下角会弹出一张诊断浮窗：标题是去重后的异常插件数，下面最多列 3 条「插件名 + 错误码 + 发现时间」，点任意一条直接打开只看这个插件的诊断详情；超出显示「还有 N 条异常」，底部「查看全部 N 项分析」打开完整列表。
- 命中的插件在列表里带**红色徽标**（「加载失败」），悬停可看一句话摘要，点徽标会打开诊断详情并定位到该插件；徽标只认 `error` 级条目，只有 `warn` 的插件不会被打红。
- 诊断弹窗顶部有一行汇总：`共 N 项 · 扫描 M 个日志 · 检查于 HH:MM:SS`；每条固定显示插件名、错误码、严重级别（错误/警告）与 `HH:MM:SS · 相对时间`，并把日志详情前 2 行直接作为预览（等宽小字，可展开看全文），修复动作默认可见。
- 自动扫描在插件挂载后约 9 秒执行一次（此时内核已写完启动日志），结果缓存在 `GET /state` 的 `diagnostics` 字段，60 秒内复用；`POST /diagnose { force?: true }` 可立即重扫。

检查范围：

- 只读 `<DSH_HOME>/logs` 下最新的 **最多 3 个**日志文件（`*.jsonl` 与 `desktop-next*.log`，按修改时间倒序），每个文件只读末尾 **4 MB**；
- 只保留 `error` / `warn` 级别的行，并优先看当前这次启动的时间窗；
- `pending (waiting for service: …)` 这类「还在等其它服务」的行不算失败；无法归属到具体插件的宿主级报错（例如只指向 `app.asar` 的堆栈）也不会硬凑成一条。

可识别的模式与给出的动作：

| 日志里出现 | code | 面板给出的动作 |
|---|---|---|
| `skipping profile bundle "…" … is incompatible with dsh …` | `incompatible` | 版本闸跳过；若缓存知道兼容版本则提供「更新到 x.y.z」，否则只解释原因 |
| `cannot get property "webServer" without inject` | `missing-inject` | 插件 API 与运行时不一致；提供兼容版本更新或升级 DSH 的说明 |
| `Cannot find module` / `ERR_MODULE_NOT_FOUND` / `Failed to resolve entry` | `missing-dependency` | 给出 `corepack pnpm install …`；能解析 `imported from <path>` 时，命令的 cwd 指向插件目录，否则指向 profile 目录 |
| `ERR_PNPM_IGNORED_BUILDS` / `Ignored build scripts` | `ignored-builds` | 提示 `pnpm approve-builds` 并说明在 `pnpm-workspace.yaml` 的 `allowBuilds` 里授权 |
| `SyntaxError` / `Unexpected token` / `is not a function` | `broken-package` | 重装当前版本（`pnpm add <pkg>@<ver> --save-exact --force`）；`failed to import` 这类运行时错误只建议更新，不提供误导性的重装命令 |
| `already registered` / `duplicate` / `conflict with` | `duplicate-registration` | 建议先在 `dsh.profile.bundles` 里停用其中一个再重启 |
| 以上都不匹配、但确实来自插件内核的错误 | `unknown` | 保留原始片段，建议反馈给插件作者 |

同一插件的同一类问题只保留最新一条（按日志时间），详情截断到 2000 字符并自动打码 `token=` / `api_key=` / `Bearer …` 等敏感值；`dsh-` 前缀别名（如 `ego-browser` 与 `dsh-ego-browser`）会合并成同一个插件。内置插件（`@deepseek-ai/dsh-*`）只给「内置插件」说明，不会提示用 npm 更新。

隐私：诊断**只读本地日志**，不联网、不上传任何内容；面板里的「复制命令」也只复制到剪贴板。诊断不会自动改插件或配置，所有修复动作都由你确认后执行（更新走正常的原子更新流程）。

探测失败（日志目录不存在、读文件出错）不会影响其它功能：`/diagnose` 仍返回 `{ checkedAt, scanned: [], items: [], errors: [...] }`，界面显示「诊断失败，请稍后重试」。

## 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 设置页看不到插件 / 宿主日志出现 `skipping profile bundle` | 未登记 bundle，或依赖缺失 | 确认 profile `package.json` 的 `dsh.profile.bundles` 含 `dsh-plugin-update-manager`，并确认其依赖已安装 |
| 更新报 `EPERM` / `operation not permitted, rename ..._tmp_<pid>` / `ERR_PNPM_EPERM`（分类 `windows-file-locked`） | 桌面版运行中会锁定 profile 的 `node_modules`，含原生模块（`.node`）的包无法被重命名/替换；刷新页面不会释放锁 | **完全退出 DSH 桌面版（含系统托盘图标）** 后再更新，然后重开；把 profile 目录加入杀毒/索引白名单 |
| 更新报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` / `git-dep-prepare-not-allowed` / 提示 `allowBuilds` | 该版本只能从 GitHub 源码安装、需要执行构建脚本，pnpm 12 默认拒绝 | 改用「npm 国内镜像」源更新该插件；确需该版本时，在 profile 的 `pnpm-workspace.yaml` 按 pnpm 提示加入 `allowBuilds` 条目（如 `dshmarket@<commit>: true`）后重试，或完全退出 DSH 后手动 `pnpm add` |
| 更新报 `github-source-needs-build` | 所选候选没有 release 资产（只有 tag/源码） | 这是保护行为（安装前拒绝，未改 profile）：换 `npm-official` / `npm-mirror` 源，或等作者发布带 `.tgz` 的 release |
| `rollback-failed` | 回滚时文件仍被占用 | 打开消息里的备份目录，手动恢复 `package.json`、`pnpm-lock.yaml`、`node_modules/<pkg>` |
| 检查全部超时 / `timeout` | 网络慢、镜像不可达、`requestTimeoutMs` 太小 | 调大 `requestTimeoutMs`；切换 `defaultSource`；配置 `customRegistry` |
| `not-found` / 私有包 | 包未发布到该源，或仓库私有 | 换源，或给该包配 `perPackageSource`；私有包需自行提供可访问的 registry |
| `rate-limit`（GitHub） | 匿名 API 60 次/小时用尽 | 降低 `checkIntervalHours`、改用 npm 源，或等待窗口重置 |
| 更新成功但行为没变 | 还没重启 | 完全退出并重开 DSH |
| 切换源后数据没刷新 | 节流命中（`stale: true`） | 手动点「检查」或等 `checkIntervalHours`；切源会自动强制重查 |

日志：界面里每一行可展开「查看日志」；等价的接口是 `GET /plugin-updater/api/log?limit=100`，落盘文件为 `<DSH_HOME>/plugin-updater/update-log.jsonl`。

## 开发与测试

```powershell
# 语法检查
node --check lib/index.js
node --check lib/client.js

# 单元测试（零依赖、不联网）
npm test
```

`npm test` 实际执行 `node --test --experimental-test-isolation=none test/*.test.js`。测试覆盖 `semver`、`compat`、`pick`、`sources`（本地 http 桩 + fetch 桩）、`update`（临时 profile + `DSH_UPDATER_FAKE_PM` 假包管理器 + pnpm 失败分类回归）、`remove`（卸载/重装 + 字节级回滚，同样走假包管理器）、`restart`（宿主探测与重启 helper）、`store`、`state`（RPC 路由、状态、`loadFailure`/`selfPlugin` 投影）和 `diagnose`（真实日志样本在 `test/fixtures/logs/`，扫描时会复制到临时目录，不读仓库文件也不联网）。如果运行环境的 Node 测试运行器允许创建子进程，也可以用默认隔离模式：

```powershell
node --test test/*.test.js
```

仓库布局：

```text
lib/
  index.js        # 插件入口：RPC 路由、调度、状态组装
  client.js       # 设置页 UI（loader 格式）
  core/
    semver.js     # 最小 semver（零依赖）
    compat.js     # engines/peer 兼容判定
    sources.js    # npm / GitHub / 镜像前缀回退
    pick.js       # 候选选择与状态落表
    update.js     # 备份 → 安装 → 回读 → 回滚
    profile.js    # profile 与已装插件发现
    remove.js     # 卸载 / 重新安装（备份 → 改 profile → 回读 → 回滚）
    restart.js    # 宿主重启探测与分离式重启 helper
    diagnose.js   # 启动日志诊断（只读，不联网）
    http.js       # 代理感知的 HTTP 请求（可选 proxyUrl）
    store.js      # 配置 / 缓存 / 日志（唯一碰磁盘的状态模块）
test/             # node:test 测试
  fixtures/logs/  # 启动日志样本（真实日志摘录）
docs/
  contract.md     # 实现契约（唯一事实来源）
  research.md     # dshmarket v1.73.6 调研
```

## License

MIT
