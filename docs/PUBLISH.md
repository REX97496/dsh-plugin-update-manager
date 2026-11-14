# 发布到 GitHub 与 npm

本仓库已经初始化好本地 git 仓库并完成首次提交，`npm pack` 产物也可直接发布。
但**推送 GitHub 与发布 npm 需要你本人的凭据**（本机没有登录 GitHub CLI / npm，且当前网络到 github.com 不稳定），
所以剩下这几步需要你自己执行——都是复制粘贴即可。

## 一、GitHub（已完成 ✅）

仓库已推送：https://github.com/REX97496/dsh-plugin-update-manager
本机可用的推送命令（代理端口 7897 + 关闭证书吊销校验）：

```bash
export HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897
GIT_SSL_NO_VERIFY=true git push
```

历史版本说明（首次建仓时的手工步骤）：


1. 在 https://github.com/new 新建仓库 `dsh-plugin-update-manager`（不要勾选 README / .gitignore，保持空仓库）。
2. 回到本项目根目录执行：

```bash
git remote add origin https://github.com/REX97496/dsh-plugin-update-manager.git
git branch -M main
git push -u origin main
```

如果提示没有权限，先登录一次：

```bash
gh auth login          # 有 GitHub CLI 时
# 或者配置一次 Personal Access Token（repo 权限）后
git push -u origin main
```

> 网络问题：如果 `git push` 报 `schannel: ... CRYPT_E_NO_REVOCATION_CHECK`，先关掉本机的证书吊销检查：
> ```bash
> git config --global http.schannelCheckRevoke false
> ```
> 或者改用 SSH：`git remote set-url origin git@github.com:REX97496/dsh-plugin-update-manager.git`。

## 二、npm（待登录后发布）

npm 官方源需要登录（当前 `npm whoami` 为 `ENEEDAUTH`，且默认源是 npmmirror，不能发布到镜像）：

```bash
npm login --registry=https://registry.npmjs.org
npm publish --registry=https://registry.npmjs.org --access public
```

包名 `dsh-plugin-update-manager` 在 npm 官方源上仍然可用（已确认 404），版本是 `0.1.0`。
发布后安装方式会变成：

```bash
pnpm add dsh-plugin-update-manager --save-exact
```

并把 `dsh-plugin-update-manager` 加进 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`。

## 三、发布前本地自检（已通过）

```bash
npm test                 # 90 个用例
npm run check            # node --check host + client
npm pack --dry-run       # 25 个文件，约 556 kB
```

## 四、版本号

首发 `0.1.0`。之后每次发布前改 `package.json` 的 `version`，再 `npm publish`。
