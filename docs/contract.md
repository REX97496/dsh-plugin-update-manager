# dsh-plugin-update-manager — 实现契约（唯一事实来源）

本文件是并行实现的接口契约。**任何**模块的导出签名、返回结构、状态枚举、RPC 路径都以此为准；
如果实现中必须偏离，先在此文件改，再改代码（避免三方对不上）。

## 0. 目标与环境

- 产品：DSH 插件 `dsh-plugin-update-manager`，在「设置 → 插件」里显示每个已安装插件的版本状态，
  支持安全更新（备份 → 安装 → 回读校验 → 失败回滚）与四档更新源。
- 目标运行时：DSH **0.2.1-rc.4**（桌面版）。node **>= 20**（本机 v24.20.0）。
- 代码全部为 **ESM**（`"type":"module"`），**零运行时依赖**，只用 `node:` 内置模块。
- 不使用 TypeScript 构建步骤（`.js` 直接可运行），但保留 JSDoc 类型注释。
- Windows 是主平台；所有路径用 `node:path`，进程调用不得拼接未转义的 shell 字符串。

## 1. 仓库布局与写作用域（避免并行冲突）

```
package.json                 Lead
cordis.patch.yml             Lead
lib/index.js                 Lead    host 入口：RPC 路由 + 调度 + 操作串行化
lib/core/semver.js           Lead    语义版本（已实现，勿改语义）
lib/core/store.js            Lead    config/cache/update-log 持久化（已实现）
lib/core/profile.js          host-dev 读 profile 清单 / 已装版本 / 运行时版本 / link 判定
lib/core/compat.js           host-dev engines.dsh 优先 + peer 兼容判定
lib/core/sources.js          host-dev 四档更新源 listVersions()
lib/core/pick.js             host-dev 状态机 pickTargets()
lib/core/update.js           host-dev 更新执行 + 回滚 + 包管理器调用
lib/client.js                client-dev 设置页 UI（单文件，loader 格式）
docs/contract.md             Lead
docs/research.md             qa-dev  dshmarket 参考实现要点（只读调研）
test/*.test.js               qa-dev  node --test 单测
README.md                    qa-dev
```

**只能写自己名下的文件。** 需要别处的改动，用消息告知 Lead。

## 2. 状态机（UI 与 host 共用）

| status | 含义 | 主按钮 | 目标 |
|---|---|---|---|
| `checking` | 正在检查 | 无（行内骨架） | — |
| `latest` | 已装 = 最新且兼容 | 无（灰字「最新」） | — |
| `update-latest` | 最新版兼容且比已装新 | 「更新到 X.Y.Z」 | latest |
| `update-compatible` | 最新版不兼容，但存在比已装新的兼容版 | 「更新到兼容版 X.Y.Z」+ 次要选项「更新到最新版（有风险）」 | compatibleMax（默认） |
| `switch-compatible` | **已装版本本身不兼容**（被版本闸跳过），但存在兼容版本（可能更低） | 「切换到兼容版 X.Y.Z」+ 明确提示允许降级 | compatibleMax |
| `incompatible-no-compatible` | 不兼容且没有任何兼容候选 | 无按钮，「查看原因」展开未满足项 | — |
| `local` | `link:`/`file:`/本地目录 | 无（灰标签「本地」） | — |
| `builtin` | `@deepseek-ai/*` 宿主内置 bundle | 无（灰标签「内置」，禁用） | — |
| `error` | 检查失败（网络/404/私有包） | 「重试」 | — |

候选选择算法（`pick.js`）：

1. 源返回全部版本（含 `dist-tags.latest`）与每个版本的 manifest 摘要（peerDependencies / engines）。
2. 预发布过滤：已装是预发布 → 允许 rc/beta；已装是稳定版 → 默认丢弃预发布，`config.allowPrerelease` 可放开。
3. 对每个候选算 `compatible`（`engines.dsh` 优先，否则所有 `@deepseek-ai/dsh*` peer 均满足）。
4. `compatibleMax` = 兼容候选中语义版本最大者。
5. 已装版本自身兼容性 = 对 `node_modules/<pkg>/package.json` 跑同一判定。
6. 按第 4 步与已装版本比较落表（见上表）。

## 3. 核心模块契约

### 3.1 `lib/core/profile.js`

```js
/**
 * @param {{ profileContext?: any, env?: NodeJS.ProcessEnv }} [options]
 */
export async function loadProfile(options = {}) -> Profile

Profile = {
  name: string,                // 如 'desktop'
  dir: string,                 // 绝对路径，如 C:\Users\...\.dsh\profiles\desktop
  isLocal: boolean,            // 该 profile 在本机可写、非 ssh/远程
  runtimeVersion: string,      // 如 '0.2.1-rc.4'
  runtimeSource: 'app-boot'|'dsh'|'env'|'profile-context'|'unknown',
  packageManager: null | { command: string, args: string[], env: Record<string,string> },
  dshHome: string,
  manifestPath: string,        // <dir>/package.json
  manifest: object,            // 已解析的 profile package.json
  bundles: string[],           // dsh.profile.bundles（数组，可能为空）
  packages: PackageEntry[],
}

PackageEntry = {
  name: string,
  specifier: string,           // dependencies 里的原始值
  kind: 'registry'|'local'|'builtin',
  installedVersion: string|null,     // 读 node_modules/<name>/package.json
  manifest: object|null,             // 已装包的 package.json（用于兼容判定）
  bundleId: string|null,             // dsh.profile.bundles 中以该包为 name 的 loader 行 id（能对上就填）
  moduleDir: string|null,            // 已装包的绝对目录（不存在则 null）
  reason?: string,                   // kind=local 时如 'link:' / 'file:' / 绝对路径
}
```

- 运行时版本优先级：先找 `@deepseek-ai/dsh-app-boot/package.json` 的 version（与宿主版本闸同源），
  再 `@deepseek-ai/dsh/package.json`，再 `process.env.DSH_RUNTIME_VERSION`，再 `profileContext.runtimeVersion`。
  解析方式优先 `import.meta.resolve()` / `createRequire(import.meta.url).resolve()`，失败再尝试
  `<profileDir>/node_modules/...` 与 `DSH_HOME/profiles/node_modules/...`。**不得抛出**，取不到返回 `'unknown'`。
- `kind` 判定：specifier 以 `link:`/`file:`/`workspace:` 开头、是绝对路径、或指向目录 → `local`；
  name 以 `@deepseek-ai/` 开头 → `builtin`（仍可读 installedVersion）；否则 `registry`。
- `dsh.profile.bundles` 的条目可能是字符串或 `{id,name}`；两种都要兼容。loader id 与 npm 包名的映射：
  bundle 行的 `name` 等于包名时取该行 `id`。
- 读文件失败逐项降级（返回 null / 空数组），绝不整体抛错。

### 3.2 `lib/core/compat.js`

```js
/** 与 @deepseek-ai/dsh-app-boot 的 evaluatePluginCompatibility 语义一致（含包含预发布的 range 匹配）。 */
export function evaluateManifest(manifest, runtimeVersion) -> {
  compatible: boolean,
  source: 'engines'|'peers'|'none',   // 用哪条规则判的；none = 没有任何 dsh 要求
  unmet: Array<{ name: string, range: string, actual: string }>, // actual = runtimeVersion
}

/** 未满足项的一句话摘要（英文，用于日志）；无未满足项返回 ''。 */
export function describeUnmet(unmet) -> string
```

规则（必须逐字一致）：
- `engines.dsh` 存在：只看它。`range.trim()===''` 或非法 range → 不兼容。
- 否则：遍历 `peerDependencies`，只处理 `name === '@deepseek-ai/dsh'` 或以 `'@deepseek-ai/dsh-'` 开头；
  `workspace:^`/`workspace:~`/`workspace:*` 视为当前运行时版本；其余按 `semver.satisfies(runtime, range, {includePrerelease:true})`。
- 参数非法（非对象/版本非法）→ 返回 `{compatible:false, source:'none', unmet:[{name:'(manifest)',...}]}`，不抛。

### 3.3 `lib/core/sources.js`

```js
export const SOURCE_IDS = ['npm-official','npm-mirror','github','github-mirror']

/**
 * 列出某包在某源下的全部候选版本。
 * @param {{
 *   name: string,
 *   source: string,
 *   config: object,                 // store.normalizeConfig 的结果
 *   manifest?: object|null,        // 已装包的 manifest（GitHub 源用它解析 repository）
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 * }} options
 */
export async function listVersions(options) -> SourceResult

SourceResult = {
  source: string,
  registryUrl?: string,            // npm 源用到的 registry
  repo?: { owner: string, repo: string }|null,
  latest: string|null,             // dist-tags.latest 或最大稳定版
  versions: Array<{
    version: string,
    manifest: object|null,         // {name, version, peerDependencies?, engines?, repository?}
    dist: { tarball?: string }|null,
    installSpec: string|null,      // npm 源 = `<name>@<version>`；github 源 = release 资产 URL（无资产时 `github:<owner>/<repo>#<ref>`）
    installKind: 'registry'|'tarball'|'source-tarball'|null,
  }>,
  warnings: string[],              // 例如 'source-tarball: 无 release 资产，只能源码安装，pnpm 12 会拒绝构建脚本'
  fetchedAt: string,               // ISO
}
```

- **npm 源**：`GET <registry>/<name>`，scoped 包名要 encode（`@scope%2Fname`），
  `Accept: application/vnd.npm.install-v1+json`（abbreviated metadata 含 peerDependencies/engines/dist）。
  registry：`config.customRegistry` 优先；否则 `npm-official` → `https://registry.npmjs.org`，
  `npm-mirror` → `https://registry.npmmirror.com`。404 → `throw SourceError('not-found')`。
- **github / github-mirror**：从 `manifest.repository`（string 或 `{url}`）或 `config.customRepository` 解析 `owner/repo`。
  - 取 releases：`GET https://api.github.com/repos/<o>/<r>/releases?per_page=100`，空则
    `GET .../tags?per_page=100`。版本 = tag 去掉前缀 `v`，必须能被 semver 解析。
  - 候选 manifest：`GET https://raw.githubusercontent.com/<o>/<r>/<tag>/package.json`（失败则 manifest=null，
    该候选兼容性标记为 unknown，仍可展示但不可作为默认推荐）。
  - **installSpec**：有 release 资产（`.tgz`/`.tar.gz`）时 = 该资产的 `browser_download_url`
    （`github-mirror` 源为 `<本 sweep 可用前缀>/<原始资产URL>`），`installKind='tarball'`，
    `dist.tarball` 同一 URL。原因（dshmarket + pnpm 12 实测）：
    - `github:<owner>/<repo>#<ref>` 会被 pnpm 当 **git-hosted 包**，安装时执行 `prepare`/构建脚本，
      pnpm 12 默认 `allowBuilds: []` → 必然 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`（真实用户报错根因）。
    - 直接用资产 HTTPS URL 时 pnpm 不跑构建、也不索要 integrity（实测直连 42s、镜像前缀 2.4s 均成功）；
      profile 里该依赖会记为这个 URL，下次用 npm 源更新会恢复成 `<name>@<version>`。
  - release 资产选择启发式：文件名同时含包名+版本 > 含版本 > 含包名 > 首个 `.tgz/.tar.gz`（scoped 包取末段名）。
  - 无 release 资产时：installSpec 保持 `github:<owner>/<repo>#<ref>`、`installKind='source-tarball'`，
    `dist.tarball` = archive URL；warnings 加
    `source-tarball: 该版本没有可安装的 release 资产…pnpm 12 会拒绝执行其构建脚本…建议改用 npm 源`。
    update.js 会在安装前 **fail-fast**（`error.code='github-source-needs-build'`，不备份、不 spawn）。
  - **github-mirror**：所有出站 URL 前置镜像前缀，形如 `<prefix>/<完整原始URL>`；
    按 `config.githubMirrorPrefixes` 顺序尝试，网络错误/5xx 换下一个，成功后记住本 sweep 的可用前缀。
    必须在 `SourceResult.warnings` 里记录当前使用的前缀。
- 超时：单请求 `config.requestTimeoutMs`（默认 8000），用 `AbortSignal.timeout`/`AbortController`；
  `signal` 取消要能中断。失败抛 `SourceError`：

```js
export class SourceError extends Error {
  code: 'timeout'|'network'|'not-found'|'private'|'invalid-repo'|'rate-limit'|'bad-response'
  status?: number
  detail?: string
}
```

- GitHub 请求带 `Accept: application/vnd.github+json`、`X-GitHub-Api-Version: 2022-11-28`、
  `User-Agent: dsh-plugin-update-manager`。环境有 `HTTPS_PROXY/HTTP_PROXY` 时提示：
  Node 内置 fetch 不读代理变量 → 用 `undici` 不可行（零依赖），改为**记录警告并直连**；
  若 `config.proxyUrl` 存在则……（见下）
- 代理：`config.proxyUrl`（config.json 可写，已在 store.DEFAULT_CONFIG/normalizeConfig 中）；为空时读
  `HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy`，`NO_PROXY/no_proxy` 命中则直连。零依赖实现：
  新增 `lib/core/http.js`，提供 `fetchJson/fetchText/fetchBuffer(url, {headers,timeoutMs,signal,config})`；
  无代理时用全局 fetch；有代理时用 `node:https` 的 `CONNECT` 隧道（`http.request({method:'CONNECT'})`
  → 拿到 socket 后 `https.request({createConnection:()=>socket})`），http 目标用 absolute-form 直发。
  `sources.js`/`update.js` 统一走这个模块，不要各处自己 fetch。

### 3.4 `lib/core/pick.js`

```js
/**
 * @param {{
 *   installedVersion: string|null,
 *   installedManifest: object|null,
 *   candidates: Array<{version:string, manifest:object|null}>,
 *   latest: string|null,
 *   runtimeVersion: string,
 *   allowPrerelease: boolean,
 *   kind: 'registry'|'local'|'builtin',
 * }} input
 */
export function pickTargets(input) -> PickResult

PickResult = {
  status: 'latest'|'update-latest'|'update-compatible'|'switch-compatible'|'incompatible-no-compatible'|'local'|'builtin'|'error',
  installedVersion: string|null,
  latestVersion: string|null,          // 源里的最新版（可能不兼容）
  compatibleMax: string|null,          // 与本机 DSH 兼容的最高版本
  installedCompatible: boolean,
  target: { version: string, risk: 'none'|'latest-incompatible' }|null,
  altTarget: { version: string, risk: 'latest-incompatible' }|null,
  reason: { code: string, message: string, unmet: Array<{name,range,actual}> },
  candidatesSeen: number,
  candidatesCompatible: number,
}
```

- `reason.code` 取值：`ok` / `newer-available` / `newer-incompatible` / `installed-incompatible` /
  `no-compatible-candidate` / `no-candidates` / `local-dependency` / `builtin-package` / `missing-install`。
- `reason.message` 用中文短句（直接进 UI tooltip）。
- 必须覆盖 `test/` 里的降级用例：已装 0.30.1（不兼容）→ 兼容 0.28.2 → `switch-compatible`，target=0.28.2。
- 边界：`latest === installed` 且都兼容 → `latest`；候选为空 → `error` + `no-candidates`；
  `installedVersion == null` → `error` + `missing-install`。

### 3.5 `lib/core/update.js`

```js
/**
 * 原子更新一个包。
 * @param {{
 *   profile: Profile,
 *   entry: PackageEntry,
 *   target: { version: string, installSpec?: string|null, installKind?: string },
 *   runtimeVersion: string,
 *   stateDir: string,
 *   signal?: AbortSignal,
 *   onProgress?: (step: { phase: string, message: string }) => void,
 *   timeoutMs?: number,
 * }} options
 */
export async function runUpdate(options) -> UpdateResult

UpdateResult = {
  ok: boolean,
  name: string,
  fromVersion: string|null,
  toVersion: string|null,           // 实际回读到的版本（ok 时为 target.version）
  needsRestart: boolean,            // 成功 true；失败 false
  rolledBack: boolean,
  durationMs: number,
  backupDir: string|null,
  packageManager: { command: string, args: string[] }|null,
  error: null | {
    code: 'timeout'|'spawn-failed'|'install-failed'|'github-source-needs-build'|'version-mismatch'|'incompatible'|'manifest-mutated'|'rollback-failed'|'cancelled'|'unknown',
    message: string,                // 中文一句话
    detail?: string,                // 原文尾部（<=4000 字符）：pnpm 输出；install-failed 时以分类提示开头
  },
  log: string[],                    // 关键步骤，供 UI「查看日志」
}
```

执行顺序（必须）：
1. **校验入参**：包名 `^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$`，版本 `^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`，且
   `target.version` 必须在候选列表里（由调用方保证，update.js 再校验一次目标版本非空）。
2. **备份**到 `<stateDir>/backups/<name>@<stamp>/`：`package.json`、`pnpm-lock.yaml`（存在才备）、
   `node_modules/<name>`（递归复制真实目录；超过 200MB 跳过并降级为「只回滚 manifest」标记）。
3. `packageManager` 解析顺序：`profile.packageManager`（宿主注入，最可信）→ `pnpm`（PATH）
   → `corepack pnpm` → `corepack pnpm@11`。命令拼装：`[...baseArgs, 'add', spec, '--save-exact', '--reporter=append-only']`，
   `cwd = profile.dir`，`env` 合并 `{...process.env, ...pm.commandsEnv, CI:'true', npm_config_confirm_modules_purge:'false'}` 并做代理变量映射
   （`HTTPS_PROXY/https_proxy` → `npm_config_https_proxy`、`HTTP_PROXY` → `npm_config_proxy`、`NO_PROXY` → `npm_config_noproxy`）。
   Windows 上 `.cmd` 用 `cmd.exe /d /s /c` 启动并 `windowsHide:true`。
4. **回读校验**：`node_modules/<name>/package.json` 的 version 必须 `semver.eq(target.version)`；
   且 `compat.evaluateManifest(newManifest, runtimeVersion).compatible === true`（除非调用方明确传 `allowIncompatible`）。
   再校验 profile manifest：除该包那一条依赖外，其余 `dependencies` 与 `dsh.profile.bundles` 数组**逐字相等**。
5. 失败 → **回滚**：恢复 package.json、pnpm-lock.yaml，删除并还原 `node_modules/<name>` 目录；
   回滚后再次读 package.json 校验与备份一致，否则 `code='rollback-failed'` 并在 message 里给出备份目录路径。
6. 成功后写 update-log（调用方负责，或这里 `store.appendUpdateLog`），返回 `needsRestart:true`。
7. `signal` abort → kill 进程树（Windows `taskkill /PID /T /F`），回滚，返回 `cancelled`。

包管理器探测失败（三者都不可用）→ `error.code='spawn-failed'`，message 指向 README 的安装说明。

**GitHub 源 preflight（步骤 2 之前）**：候选 `installKind==='source-tarball'`（或 installKind 为空且 installSpec 以
`github:` 开头）时直接失败：`error.code='github-source-needs-build'`，`needsRestart=false`、`rolledBack=false`、
`backupDir=null`，不备份、不 spawn。原因见 §3.3：pnpm 12 对 git-hosted 包默认拒绝执行构建脚本。

**`install-failed` 的 detail 约定**：`detail` 以分类提示（中文）开头，后接空行 + pnpm 输出尾部原文（<=4000 字符），
保证 UI「查看详情」可复制真实原因。分类器至少覆盖：`windows-file-locked`（桌面版运行中锁 node_modules，
需完全退出含托盘）、`profile-file-locked`、`transient-network`、`no-matching-version`、`host-incompatible-install`、
`ignored-builds`（strictDepBuilds/allowBuilds 拒绝构建，提示 `pnpm approve-builds`）、
`git-dep-prepare-not-allowed`（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，建议改用 npm 源）、`pnpm-missing`。

### 3.6 `lib/index.js`（Lead 实现，供 client 消费）

- 导出：`export const name = 'dsh-plugin-update-manager'`、
  `export const inject = ['webServer']`、
  `export function apply(ctx, config)`。
- 可选服务：`ctx.inject(['profileContext'], ...)` 拿宿主包管理器；`ctx.inject(['settings'], ...)` 暂不使用。
- 路由前缀：`/plugin-updater/api`，全部 `POST` 除 `GET /state`；统一信封：

```json
{ "ok": true, "value": <T> }
{ "ok": false, "error": { "code": "bad-request", "message": "..." } }
```

| 方法 | 路径 | body | 返回 value |
|---|---|---|---|
| GET | `/plugin-updater/api/state` | — | `UpdaterState` |
| POST | `/plugin-updater/api/check` | `{ force?: boolean, names?: string[] }` | `{ started: true, ids: string[] }`（异步，进度从 state 轮询） |
| POST | `/plugin-updater/api/update` | `{ name: string, version: string }` | `{ operationId: string }`（立即返回，进度轮询 state） |
| POST | `/plugin-updater/api/update-all` | `{ names?: string[] }` | `{ operationId: string, queued: string[] }` |
| POST | `/plugin-updater/api/cancel` | `{ operationId?: string }` | `{ cancelled: boolean }` |
| POST | `/plugin-updater/api/config` | `{ patch: object }` 或全量 config | `UpdaterState`（切换源后自动触发重查） |
| GET | `/plugin-updater/api/log` | `?limit=100` | `{ entries: [...] }` |
| POST | `/plugin-updater/api/restart` | — | `{ supported: boolean, scheduled?: boolean, mode: 'desktop'|'cli'|'service'|'none', message: string }` |

`UpdaterState`：

```js
{
  bootId: string,                       // 本宿主实例 id：每次 apply 生成，重启/重挂载后变化
  profile: { name, dir, isLocal, runtimeVersion, runtimeSource },
  config: object,                       // normalizeConfig 结果
  lastCheckAt: string|null,
  checking: boolean,
  rows: Array<{
    name: string,
    source: string,
    status: string,                     // 第 2 节枚举；检查中为 'checking'
    installedVersion: string|null,
    latestVersion: string|null,
    compatibleMax: string|null,
    installedCompatible: boolean,
    bundleId: string|null,
    kind: 'registry'|'local'|'builtin',
    reason: { code: string, message: string, unmet: Array<{name,range,actual}> },
    target: {version:string, risk:string}|null,
    altTarget: {version:string, risk:string}|null,
    checkedAt: string|null,
    stale: boolean,                     // 本轮未刷新（节流/失败），显示上次结果
    error: { code: string, message: string }|null,
    operation: null | {                   // 该包正在跑的任务
      id: string, kind: 'update', phase: string, message: string,
      progress: number|null, startedAt: string,
    },
    pendingRestart: boolean,
    lastUpdate: null | { ok: boolean, fromVersion: string|null, toVersion: string|null, at: string, message: string },
  }>,
  operations: Array<{ id, kind:'update'|'update-all'|'cancel', state:'queued'|'running'|'succeeded'|'failed'|'cancelled'|'rolled-back', name?, startedAt, endedAt?, message, result? }>,
  activeOperationId: string|null,
  capabilities: {
    restart: boolean,                  // 当前宿主能否自动重启（见 §3.8）
    restartMode: 'desktop'|'cli'|'none',
    restartHint: string,               // 给 UI 的一句话说明
  },
  updatedAt: string,
}
```

- 启动诊断：`apply` 内 `setTimeout(..., 9000)` 调一次 `diagnoseStartup(...)`，结果放 `UpdaterState.diagnostics`；同时提供 `POST /diagnose`（见 §3.7）。
- 启动检查：`apply` 内 `setTimeout(..., 6000)` 触发一次 `runCheck({ force: config.checkOnStartup === 'force', reason: 'startup' })`（不阻塞启动）。
  `checkOnStartup` 取值 `'force'`（默认，每次启动都强制刷新，保证重启后提示准确）或 `'throttle'`（沿用 `checkIntervalHours` 节流）。
  手动「立即检查」逻辑不变。
- `bootId`：`GET /state` 顶层返回；client 用它区分「同一次运行内的检查结果」与「重启后的新实例」，不需要额外路由。

### 3.8 重启实现

- **桌面版（DSH NEXT / DSH Desktop）**：宿主是 Electron 的 Node 模式子进程，通过 `process.send({ type: 'desktop-action', action: 'restart' })` 请求主进程重启；主进程会弹确认框，确认后重启整个应用并重载页面。插件**不杀进程、不 relaunch 可执行文件**。
- **命令行宿主（`dsh web …`）**：`/restart` 先返回响应，再由 detached helper 等待本进程退出后用同样的 `execPath + argv` 重新拉起。
- **探测**（`lib/core/restart.js` `probeRestartPlan()`）：`ELECTRON_RUN_AS_NODE=1` 或 `DSH NEXT.exe` 且存在 IPC → desktop；否则若 `argv[1]` 存在 → cli；否则 none（UI 给退出引导）。
- `/restart` 响应里的 `supported` 表示“已受理”：desktop 模式下确认框由桌面版主导，插件不再重复提示。
- 节流：每个包 `cache.packages[name].fetchedAt` 在 `checkIntervalHours` 内 → 不重查，标记 `stale:true`。
- 并发 4，总上限 30s；每个包请求 8s 超时（`config` 可覆盖）。超时的包保留上次结果 + `error.code='timeout'`。
- `check(force:true)` 忽略节流；切换源/allowPrerelease/镜像前缀后自动 `force` 重查。
- 更新任务串行：`activeOperationId` 非空时新请求入队（`operations` 里 `state:'queued'`）。
- 所有定时器/监听在 `ctx.effect(() => () => dispose)` 里注册，插件卸载要能停。
- 路由注册用 `ctx.effect(() => ctx.webServer.register({ kind:'prefix', path:'/plugin-updater/api', handler }), 'plugin-updater: routes')`。

### 3.7 启动诊断（`lib/core/diagnose.js` + index 集成）

**目标**：每次宿主启动后，自动读取 DSH 日志，找出「插件加载失败/未激活/被版本闸跳过」的记录，归类并给出可执行修复建议；不阻塞启动，不上传任何内容。

- 导出：`export async function diagnoseStartup(input) -> Diagnostics`
  - `input = { profile, dshHome, cache, logsDir?, sinceMs?, limitFiles? }`
  - `profile` 复用 `loadProfile()` 结果（取 `dir` 与 `dependencies`）；`cache` 为 updater 的 `cache.packages`，用于给兼容版本建议。
  - 纯读日志文件，最多读 3 个文件、每个文件末尾 4 MB；整体耗时 < 300ms，抛错不致命（返回 `{items:[], errors:[...]}`）。
- 日志发现：`logsDir = input.logsDir || path.join(dshHome,'logs')`；挑 `*.jsonl` 与 `desktop-next.log` 中 mtime 最新的 3 个；`sinceMs` 默认 `Date.now() - (process.uptime()*1000) - 60_000`。
- 解析 JSONL 行：`{time,source,event,level,message}`；只关心 `level` 为 `error`/`warn` 且 `message` 命中规则的行。
- 诊断项：

```js
Diagnostics = {
  checkedAt: string,
  scanned: string[],                 // 读取到的日志文件名
  items: Array<{
    id: string,                      // 去重键：plugin 或 '(host)'
    plugin: string|null,             // 受影响包名（能定位到时）
    code: string,                    // 见下表
    severity: 'error'|'warn',
    title: string,                   // 一句话结论（中文）
    summary: string,                 // 1 行可读摘要（≤160 字）
    detail: string,                  // 原始日志片段（≤2000 字，保留栈首行）
    at: string|null,                 // 日志时间
    fixes: Array<{
      kind: 'update'|'command'|'text',
      label: string,                 // 按钮/标题文案（中文）
      version?: string,              // kind='update' 时的目标版本
      command?: string,              // kind='command' 时给用户复制
      cwd?: string,                  // 命令工作目录（一般是 profile.dir）
      detail?: string,               // kind='text' 的说明或步骤
    }>,
  }>,
  errors: Array<{ file: string, message: string }>,   // 读取/解析失败（可空）
}
```

- 规则（按优先级匹配，命中即归类，同一插件同 code 只留一条、取最新时间）：

| code | 触发（日志特征） | title / fixes |
|---|---|---|
| `incompatible` | `skipping profile bundle "<name>":` 且含 `incompatible with dsh` | 被版本闸跳过；若 `cache[name].compatibleMax` 存在且 ≠ 已装 → fix `update`(该版本)；否则 `text` 说明「等作者发布兼容版 / 换包 / allow-version 无效」 |
| `missing-inject` | `cannot get property "..." without inject` | 插件与当前 DSH 运行时 API 不匹配；有兼容版 → `update`；否则 `text`（升级 DSH 或换包） |
| `not-activated` | `did not activate`（HMR 汇总行，后续行含 `<name> (<id>): Error: ...`）→ 对每个子行生成一项，内层 `message` 作为 detail | 加载期抛错未激活；按内层错误再归类（无法识别则 `unknown`） |
| `missing-dependency` | `Cannot find module` / `ERR_MODULE_NOT_FOUND` / `Failed to resolve entry` | fix `command`: `corepack pnpm install --config.strict-dep-builds=false`（cwd=profile.dir）+ `text` 说明可能是依赖未装全 |
| `ignored-builds` | `ERR_PNPM_IGNORED_BUILDS`（宿主启动/安装日志里出现） | fix `command`: `pnpm approve-builds`（cwd=profile.dir）；`text` 提到 `pnpm-workspace.yaml` 的 `allowBuilds` 需为 true/false |
| `broken-package` | `SyntaxError` / `Unexpected token` / `is not a function` / `ERR_PACKAGE_PATH_NOT_EXPORTED` | fix `command`: `corepack pnpm add <plugin>@<installedVersion> --save-exact --force`（能装回原版） |
| `duplicate-registration` | `already registered` / `duplicate` / `conflict with` | `text`：两个插件注册了同一个 slot/route/section id，先停用其中一个 |
| `unknown` | 其它 `host.kernel.<plugin>` 的 error | `text`：把 detail 反馈给插件作者；可先用 `pnpm install` 重装 |

- `plugin` 推断：JSONL 的 `source` 形如 `host.kernel.<id>`（id 可能等于包名，也可能是 loader 行 id）；再用 profile `dependencies` 键与 `dsh.profile.bundles` 做匹配（先精确匹配包名，再做「loader id == package 去掉 scope」的宽松匹配）。
- `fix.kind='update'` 的 `version` 必须同时满足：`cache[name].compatibleMax` 存在、与已装不同、且 `evaluateManifest` 判定兼容（直接复用 `pick.js` 的 `pickTargets`）。
- index 集成：
  - `GET /state` 顶层新增 `diagnostics: Diagnostics|null`（首轮诊断完成前为 `null`）。
  - 新路由 `POST /plugin-updater/api/diagnose`，body `{ force?: boolean }`；`force` 忽略 60s 缓存直接重扫，返回 `Diagnostics`。
  - 启动后 9s 自动跑一次；更新完成（单条/全部）后重置缓存，下次 `/diagnose` 重扫。
- 所有文案中文，命令字符串必须可复制，不能包含用户机密（token 等）。

## 4. Client 契约（`lib/client.js`）


文件必须是 loader 格式（第一行起）：

```js
window.__ModuleLoader__.load({
  id: "dsh-plugin-update-manager",
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    const React = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    // ...
    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  }
});
```

- 复用 primitives（已确认导出）：`Button`（variant `ghost|primary|outline|toolbar`，size `md(36px)|sm(28px)`）、
  `Pill`、`Tag`、`StateDot`、`Tooltip`、`IconRefreshOutlineRegular`、`IconWarningOutlineRegular`、
  `IconLoadingOutlineRegular`、`IconChevronDownOutlineRegular`、`IconCloseOutlineRegular`、`relativeTime`。
- 语言：`ctx.locale.register(NS='plugin-updater', { zh: {...}, en: {...} })`，`const t = ctx.locale.bind(NS)`。
  中文文案为准，英文同步给出。
- 注册两个入口：
  1. `ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id:'plugin-updater', order:36, label:()=>t('nav'), locale:'plugin-updater', inject:()=>({}) }, Section))`
  2. `ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({ name:'settings.plugins.tab', id:'plugin-updater.tab', order:61, label:()=>t('tab'), locale:'plugin-updater' }, TabPanel))`
  两者复用同一个 `<UpdaterView compact={...} />`。
- 数据：`fetch('/plugin-updater/api/state')`；busy（`checking || activeOperationId`）时 1.5s 轮询，空闲时 30s 轮询（或只在挂载时取一次 + 手动刷新）。
- UI 规格：见需求 m00001 第五节 + 用户追加的样式要求；列宽固定 200px 右侧列，行高与列表一致，不用彩色。
  更新中行内 spinner + 「更新中…」，成功 → 「需重启生效」+「重启 DSH」（无 API 时展示退出引导弹层）。
- 失败详情可复制：用 `navigator.clipboard.writeText`，失败降级为选中文本提示。
- 所有 fetch 带 `AbortSignal`，组件卸载/切换源时 abort。

**宿主模块可用性（已核实）**：`react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives` 属于宿主静态模块表，任何 client bundle 都可直接 `require`，**不需要**写进 `dsh.client.external`；`dsh.client.inject` 只填「必须先加载的插件包 id」（本插件已改为 `@deepseek-ai/dsh-client-locale` + `@deepseek-ai/dsh-client-ui-slots`，primitives 不是插件包，不能填）。我们自己的 `engines.dsh` 放宽为 `>=0.2.0-rc.2 <0.4.0`（本机 CLI 运行时是 0.2.0-rc.2，桌面是 0.2.1-rc.4，两者都要过闸）。

## 5. 测试（qa-dev）

`node --test test/`，零依赖，import 被测模块。至少覆盖：
1. `semver`：`0.2.1-rc.4` vs `>=0.2.1-rc.1 <0.4.0`（含/不含 includePrerelease）、caret/tilde/x、`||`、hyphen。
2. `compat`：engines.dsh 优先（忽略 peer）、peer 全部满足才兼容、`workspace:^` 映射、非法 range。
3. `pick`：latest / update-latest / update-compatible / switch-compatible（0.30.1→0.28.2 降级）/
   incompatible-no-compatible / 预发布过滤（稳定版已装时不给 rc，允许预发布时给）。
4. `sources`：npm abbreviated 解析（成功 + 404 + scoped 包名编码）、GitHub release 解析
   （有 .tgz 资产 / 只有 tag / 镜像前缀回退）。用本地 `node:http` 服务器或注入 fetch 桩，不真发外网请求。
5. `update`：用临时目录 + 假包管理器（`DSH_UPDATER_FAKE_PM=1` 时 update.js 走内置 fake：
   写坏版本/写对版本/模拟失败三种模式）验证成功、version-mismatch 回滚、profile 其他条目不变。
6. `store`：config 归一化、cache 读写、损坏文件降级。

`update.js` 必须支持 `DSH_UPDATER_FAKE_PM` 钩子（仅测试用，生产路径不受影响），实现方式：
spawn 前检查环境变量，为 `'success'|'mismatch'|'fail'` 时改用进程内模拟器。

## 6. 样式硬约束

- 只用宿主 CSS 变量（`--dsw-alias-*`、`--dsw-radius-*`、`--dsw-font-*`、`--dsw-focus-ring-*`），不写死颜色/字体。
- 具体数值：正文 13px / 辅助 12px / 徽标 11px；按钮 28px 高（行内）、radius `var(--dsw-radius-sm)`；
  表头/表体行高 44px；右侧操作列固定 200px；`font-family: inherit`。
- 深浅色自动跟随（不写 `prefers-color-scheme`）。
- 不引入 webfont、不引入图片资源；图标用 primitives 图标组件。
