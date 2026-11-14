# dshmarket v1.73.6 调研：对本插件的可直接复用经验

调研对象：`C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dshmarket`（v1.73.6，已装在我们目标 profile 里）。
只读分析，不含源码片段；所有引用为 `文件:行号`（相对 `dshmarket/lib/`）。

## 结论（优先读这 5 条）

1. **兼容判定照 `verify.js` 抄：engines.dsh 独占决定，peer 兜底，空 range = 不满足**。这与我们契约 3.4 完全一致，并且是 dshmarket 实测后从"只看 peer"改过来的（`verify.js:222-232` 注释：只读 peer 在 2796 组 (package, runtime) 里有 62 组误判为可通过）。运行时版本取 `@deepseek-ai/dsh-app-boot/package.json`，取不到才回落 CLI 包版本（`verify.js:182-186`、`verify.js:335-380`）——正是我们 `profile.js` 的优先级。
2. **桌面版的包管理器操作要交给宿主，别自己拼 pnpm 命令**。官方 Electron profile 由 DSH 进程内 plugin manager 独占（`official-desktop.js:1`），`dsh plugin --profile desktop` 会被直接拒绝（`official-desktop.js:140` 附近注释）；桌面端只能走宿主 manager API，并给操作加外部 deadline（remove 90s / install 300s，`official-desktop.js:18-19`）。我们能做的安全路线是"备份 → 在 profile 目录跑 pnpm add → 回读校验 → 失败回滚"，并在 README 明说需要完全退出桌面版。
3. **pnpm 失败必须分类成人话，不能只贴 exit code**。最有价值的三类：`windows-file-locked`（`pnpm-compat.js:741-745`，EPERM rename / 原生模块 .node 不释放 → 提示**完全退出 DSH**，刷新页面没用）、`profile-file-locked`（`pnpm-compat.js:687-693`，package.json / pnpm-lock.yaml 被 rename 占用 → 杀毒/索引器，重试一次即可）、`transient-network`（`pnpm-compat.js:753-768`，含国内镜像 tarball reset 时建议换全球源）。另两类：`no-matching-version`（`:574`、`:597`）与 `host-incompatible-install`（`:431`，宿主自己拒绝安装）。
4. **代理是 `npm_config_*` 的世界**。pnpm 只认 `npm_config_https_proxy` / `npm_config_proxy` / `npm_config_noproxy`，用户常见的 `HTTPS_PROXY` 必须做映射；若 `npm_config_*` 已存在则不覆盖（`dsh-cli.js:83-132`）。Windows 上 `.cmd` shim 必须用 `cmd.exe /d /s /c` + 逐 token 引号转义 + `windowsHide`（`dsh-cli.js:404-470`）；杀进程树用 `taskkill /PID /T /F`（`dsh-cli.js:599-627`）。
5. **GitHub 镜像只用于"取元数据/下载"，绝不把前缀化 URL 交给 pnpm**。pnpm 11 会把 `https://proxy/https://codeload...` 当普通远程 tarball 并索要 integrity，实测报 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`（`accelerate.js:1-25`）；正确做法是镜像解析出 commit SHA，再交 `github:owner/repo#<sha>`，解析失败就回退原 target（`accelerate.js:40-48`）。镜像前缀形式为 `<prefix>/<完整原始URL>`（`sources.js:148-151`），按区域记住可用前缀即可（`regions.js` 的 `rememberGithubRoute`）。

## 1. 运行时版本与兼容判定

- 运行时版本来源：优先 `@deepseek-ai/dsh-app-boot/package.json`，两处探测（`<host>/node_modules/@deepseek-ai/dsh-app-boot` 或 `<host>/../dsh-app-boot`），再回落 dsh CLI 包版本；进程内缓存一次（`verify.js:335-380`）。找不到 host 时 gate 直接放行（`verify.js:180-186`）——我们契约在 unknown 时判为不兼容更保守，保留我们的行为。
- 判定顺序：`engines.dsh` 存在则**独占决定**、peer 全部忽略；空/非法 range 视为不满足（`verify.js:236-243`）。否则遍历 `peerDependencies`，只认 dsh 系 peer，`satisfiesRange(runtime, range, { includePrerelease: true })`，空 range 不满足，第一个失败者即结论（`verify.js:244-250`）。
- 存在性细节：`engines.dsh` 不是 string 时宿主自身会抛，dshmarket 选择"不作判定"（`verify.js:232-235`）；我们契约规定非法参数 → 不兼容，更安全，保持契约。
- 提示方向由 range 的哪一侧决定：低于下限 → 升宿主有用；高于上限 → 升宿主没用（`verify.js:201-206`，`unmetOf.hostTooOld`）。这一条值得写进 UI 文案。
- `compatibility.js` 只是"已装插件的风险分类"UI 层：`belowMin` 一定 risk，`aboveMax` 只有显式 upper/exact 才 risk，隐式 caret 越界只 warning（`compatibility.js:111-113`、`:178-195`）；optional peer 只 warning（`:160-168`）。我们的 `evaluateManifest` 不需要这层，但 README 可借用"隐式上限只是警告"的说法。

## 2. 包管理器探测 / Windows spawn / 代理 / 超时

- 探测顺序：宿主 `profileContext.packageManager`（跑 `<command> <args> --version` 验证，失败回落）→ PATH pnpm（区分"没装"与"装了但失败"）→ corepack（只出现在安装 pnpm 的 provision 流程里）(`dsh-cli.js:703-726`、`:748-770`、`:792-833`)。和我们契约第 3.5 节的三级顺序一致，只是我们的第三级是 `corepack pnpm`，不需要装 pnpm。
- Windows shim：`winCmdShim` 判断 `.cmd/.bat`，`quoteCmdArg` 用 `CMD_METACHARS` 引号包裹并双写内部引号，最终 `spawn(COMSPEC, ['/d','/s','/c', '"<cmdline>"'], { windowsVerbatimArguments: true, windowsHide: true })`（`dsh-cli.js:404-470`）。非 shell 路径也始终 `windowsHide: true`。
- 环境合并：`process.env` + 宿主 env + build env，PATH 把宿主 PATH 排在继承 PATH 前（`dsh-cli.js:353-398`）；`CI: 'true'` 常开；代理映射在合并后执行。
- 代理映射（`dsh-cli.js:83-132`）：`HTTPS_PROXY`/`https_proxy`（小写优先）→ `npm_config_https_proxy`；`http_proxy` → `npm_config_proxy`；`no_proxy` → `npm_config_noproxy`；已存在的 `npm_config_*` 不覆盖；反向只在标准变量为空时做。
- 超时：`INSTALL_TIMEOUT_MS = 15min`，可用 `DSH_MARKET_INSTALL_TIMEOUT_MS` 覆盖（`dsh-cli.js:399`）。我们契约是单次 30s 总量 + 8s 单包检查，更新路径用调用方 `timeoutMs`，要注意别把 15min 的默认值当成常规等待。
- killTree：Windows `taskkill /pid <pid> /t /f`；POSIX 先 SIGTERM 进程组，5s 后 SIGKILL（`dsh-cli.js:599-627`）。取消更新时必须走它，否则 pnpm 子进程会留下文件锁。

## 3. pnpm 错误分类（`pnpm-compat.js:188` `classifyPnpmFailure`）

| 分类码 | 位置 | 触发特征 | 给用户的建议 |
| --- | --- | --- | --- |
| `windows-file-locked` | `:741-745` | `ERR_PNPM_EPERM`、`EPERM ... rename`、`failed to remove existing directory ... prior to swap` | **完全退出 DSH 桌面版**（不是刷新页面）；原生模块 `.node` 不释放；pnpm 可能已删目标旁内容，故只恢复 manifest+lockfile 再检查旧入口 |
| `profile-file-locked` | `:687-693` | EPERM rename 到 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `.pnpm/lock.yaml.<hash>` | 杀毒/索引器占用，不是插件占用；已自动重试一次，提示再试 |
| `transient-network` | `:753-768` | 网络类报错；国内镜像 tarball reset 有专门判断 | 重试；国内镜像失败时建议切全球源 |
| `no-matching-version` | `:564-601` | 版本不存在 / dist-tag 不匹配；宿主 peer 有特判（`:572`） | 检查包名/版本是否已发布、镜像是否同步；换源 |
| `host-incompatible-install` | `:428-431` | `dsh: installation rejected:` + `is incompatible with dsh <ver>` | 宿主自己拒绝，换兼容版本（不是重试能解决的） |
| 其他 | `:196` `pnpm-stalled`、`:215` `profile-write-lock`、`:287` `missing-tarball-integrity`、`:413` release-age、`:440` ignored-builds、`:459` native-oom、`:540+` fetch-404、`:618/:645` lockfile、`:774` fetch-timeout、`:781` pnpm-missing | | |

对我们最小可用集：`windows-file-locked`、`profile-file-locked`、`transient-network`、`no-matching-version`、`host-incompatible-install`、`pnpm-missing`。契约第 3.5 节只要求 `error.code` 九类（timeout/spawn-failed/install-failed/version-mismatch/incompatible/manifest-mutated/rollback-failed/cancelled/unknown），建议在 `error.detail` 里带 dshmarket 风格分类，UI 直接映射文案。

## 4. 原子更新：备份 / 校验 / 回滚

- 安装与回滚的实现在 `install.js`：失败后恢复 `package.json` 与 `pnpm-lock.yaml`（`:239-241` 注释），回滚逻辑集中在 `:494` 附近（注释 #919：pnpm 已启动、读过 lockfile、然后 exit 1）。
- 备份能力比我们契约重：`createProfileBackup`（`backup.js:69`）校验 profile `package.json` 存在、可按 `includeDeps` 只备指定依赖；`validatedBackup`（`:128`）在恢复前校验备份文档；`restoreProfileBackup`（`:179-200`）先记录 `previous` 再逐文件写，任何一步失败用 `rollback()` 就地恢复，并拒绝 `..` 逃逸路径（`unsafe backup path`）。
- 快照（`snapshot.js:1-25`）只抓"组合关键文件"：`package.json`、`cordis.patch.yml`、`.dsh-market/state.json`；版本 2 会显式记录可选文件缺失；恢复时校验每个路径、协调写入与删除，部分失败会回滚已完成动作；保留最近 20 份。
- 额外保护：`pending-updates.js` journal —— 宿主 manager 调用无 deadline 时可能永远不 resolve，市场用 journal 让下次启动收尾（`official-desktop.js:9-17`、`interrupted()` 返回 `update-incomplete` + `repairOnRestart:true`，`official-desktop.js:200+`）。我们契约不实现 journal，但应在 `update-log` 里记录 `rolledBack` 与 `backupDir`，让用户可人工恢复。
- 结论：我们的三件套（manifest + lockfile + `node_modules/<pkg>`）方向正确；补两点：恢复前先校验备份存在且可读（对应 `validatedBackup`），恢复路径做 `startsWith(root+sep)` 校验（对应 `restoreProfileBackup:199`）。

## 5. 重启与桌面独占

- 宿主**没有**通用重启 API。dshmarket 自己实现了 self-restart（`restart.js`），且有严格前提：`restartAllowed` 在检测到 systemd supervisor 时默认禁止（`:154-159`），信任判定要求 Host/Origin 同 authority（`:346-355`）；桌面文档代理会剥掉这些头，而重启路由仍保留严格谓词，注释明说"spawns a replacement host, which is not something a desktop-managed profile should get from here"（`:311-330`）。重启靠 detached helper + 500ms 后 `SIGTERM` 自己（`:653-688`），Windows 用 `powershell -WindowStyle Hidden` 包一层（`:398`）。
- 官方桌面 profile：Electron 进程内 manager 独占（`official-desktop.js:1`），CLI 改 profile 被拒（`:140`），市场连自己都不能更新自己（`:120-172`：先卸载→再安装，重新安装那步根本跑不到）；`OFFICIAL_PAGE_HINT`（`:26`）直接告诉用户去"设置 → 插件"。
- 对我们的结论：`POST /restart` 返回 `{supported:false,message}` 是正确的；README 必须写"更新后完全退出 DSH 并重新打开"，并给出 `%USERPROFILE%\.dsh\profiles\<name>` 路径。不要把"重启"做成按钮的默认预期。

## 6. GitHub 镜像与加速

- 前缀拼接：`codeloadTarball` 返回 `proxy === null ? direct : '<prefix>/<direct>'`（`sources.js:148-151`），与契约第 3.3 节 `<prefix>/<完整URL>` 一致；仓库解析 `parseGitHubRepository:77`、`parseGitHubRemote:93`、`repoOf:132`，安装目标 `installTargetFor:506`、`sourceFallbackFor:543`。
- 不要给 pnpm 传前缀化 tarball：`accelerate.js:1-25` 完整解释了 `ERR_PNPM_MISSING_TARBALL_INTEGRITY` 的成因；安全中间路线是镜像解析 40 位 SHA → `github:owner/repo#<sha>`（`:26-70`），HEAD 用 git 的 `info/refs?service=git-upload-pack`（`:80-160`），因为匿名 GitHub REST 只有 60 次/小时，而 git 协议端点不受此限且更抗镜像 403；任何 SHA 解析失败都回退原 target（`:40-48`）。
- 缓存：`regions.js` 的 `rememberGithubRoute` 按区域记住可用前缀。我们契约只需要"本轮内记住成功前缀 + warnings 记录当前前缀"，不要跨进程缓存（profile/网络会变）。

## 7. 与我们契约的已知差异（不需要改契约，但要知道）

- dshmarket 的兼容门是 `verify.js` 的 `hostPeerGate`，与契约 3.4 等价；差异只在 "unknown runtime" 时它放行、我们判不兼容。
- dshmarket 的更新路径在官方桌面版走宿主 manager，不走 pnpm；我们契约统一走 pnpm，因此 README 的"已知限制"要更醒目。
- dshmarket 有 pending-updates journal / 整 profile 备份 / 快照三套保护，我们只有三件套备份 + 回读校验，属于有意的范围收敛。
