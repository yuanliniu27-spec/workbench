# 工作台

可在电脑和手机使用的备忘与提醒应用（H5 / PWA）。界面为中文，时区为 Asia/Shanghai（上海时间）。任务可按「开始/完成时间」显示在月历上；手机端可从顶部浮条添加到主屏幕，作为独立应用打开。

本地路径：`/workspace/workbench-app/`

## 本地运行

在本目录启动一个静态服务器（不要用 `file://` 直接打开，否则通知和服务工作者无法工作）：

```bash
cd /workspace/workbench-app
python3 -m http.server 8765
```

然后用 Chrome 打开 `http://localhost:8765/`。本机 localhost 可以调试通知；要在手机上稳定使用，需要部署到 HTTPS 网站。

## 发布到 GitHub Pages（推荐的长期地址）

当前环境没有登录 `gh`，也没有可写入仓库的托管凭据，因此还没有自动上线。可用自己的 GitHub 账号发布：

```bash
cd /workspace/workbench-app
git init
git add index.html css js sw.js manifest.webmanifest icons README.md .nojekyll
git commit -m "发布工作台"
# 在 GitHub 新建公开仓库，例如 workbench，然后：
git branch -M main
git remote add origin https://github.com/你的用户名/workbench.git
git push -u origin main
```

在仓库 Settings → Pages 中，Source 选 `main` 分支、根目录 `/`。几分钟后即可打开：

`https://你的用户名.github.io/workbench/`

更新时，改完文件后再执行 `git add -A && git commit -m "更新工作台" && git push`。

## 使用要点

- 把应用「添加到主屏幕」后，再允许通知。
- 小米手机请用 Chrome 打开，并在系统设置里允许通知、关闭过度省电限制。详见应用内「设置」。
- 两台设备配对一次后会自动同步任务和日程：可复制「同步链接」在另一台打开，或使用同步口令。之后任意一端改动都会尽快同步到另一端，不必每次再对口令。链接和口令请自行保管。也可导出/导入 JSON 备份。
