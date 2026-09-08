# 架构设计

## 目标

先把浏览器控制做成可靠底座，再逐步接入抖音页面动作。

当前第一阶段只做一件事：

```text
打开 Chrome -> 打开抖音 -> 确认 DevTools 可连接
```

`browser open` 默认打开浏览器后返回，方便人工测试。`browser serve` 对应的 npm 脚本会保持控制器进程运行，后续可以作为 exe/桌面软件的常驻模式。

## 总体分层

```text
CLI 命令层
  -> 应用服务层
  -> 浏览器领域接口
  -> Chrome 基础设施
  -> DevTools 连接检查
```

现在新增了一个 WinForms 桌面可视化层：

```text
WinForms MainForm
  -> AutomationCommandRunner
  -> CLI JSON 命令
  -> 应用服务层
  -> Chrome DevTools Protocol
```

桌面 GUI 只负责展示、按钮和日志，不重新实现抖音自动化逻辑。

## 目录职责

### `src/cli.js`

命令行入口。

只负责：

- 解析命令。
- 调用应用服务。
- 输出用户能理解的结果。

不直接写 Chrome 启动细节。

### `desktop/DouyinAutomation.Desktop`

WinForms 桌面可视化控制台。

负责：

- 展示当前页面状态。
- 展示完整步骤链路。
- 展示下一步建议。
- 提供按钮调用现有 CLI JSON 命令。
- 显示执行日志。

它不直接操作抖音页面，实际动作仍由 `DouyinController` 完成。旧的 `desktop/DouyinAutomationGui.ps1` 不再作为主入口。

桌面层内部继续分层：

```text
MainForm
  -> AutomationCommandRunner
  -> node src/cli.js
  -> BrowserController / DouyinController
```

桌面层只负责任务参数、按钮、步骤识别展示和日志。它不复制页面识别逻辑；当前状态由 `DouyinController.inspectState` 返回。

### `src/app`

应用服务层。

负责把一个用户动作编排成多个底层动作。例如：

```text
browser open
  -> 找 Chrome
  -> 准备用户数据目录
  -> 启动 Chrome
  -> 等待 DevTools 可用
  -> 写入 session.json
```

后续搜索、打开视频、评论区滚动，也都从这里发起。

`AutomationConsole` 是终端交互层，只负责展示状态、接收命令和调用应用服务；页面识别和实际动作仍放在 `DouyinController`。

### `src/infra/chrome`

Chrome 基础设施层。

负责：

- 查找 Chrome 路径。
- 组装 Chrome 启动参数。
- 启动可见浏览器进程。

这一层不理解“抖音业务”。

### `src/infra/cdp`

Chrome DevTools Protocol 连接层。

第一阶段只做健康检查：

- 访问 `/json/version`。
- 判断调试端口是否可用。
- 返回浏览器版本和 WebSocket 地址。

后续可以扩展为：

- 创建标签页。
- 执行页面脚本。
- 发送键盘、鼠标、滚动事件。

### `src/config`

默认配置。

例如：

- 默认抖音地址。
- 默认远程调试端口。
- 默认 Chrome Profile 目录。

### `src/core`

通用工具。

例如：

- 日志。
- sleep/retry。
- 错误格式化。

## 后续功能接入顺序

建议按这个顺序开发：

1. 打开浏览器。
2. 连接浏览器并列出当前标签页。
3. 打开或定位抖音标签页。
4. 搜索框点击和输入。
5. 点击搜索结果视频。
6. 按 `x` 打开评论区。
7. 识别评论区滚动容器。
8. 评论区滚动。
9. 上下键切换视频。
10. 组合成任务循环。

每一步都先做成 CLI 命令并验证成功，再考虑是否需要 UI。

## 已实现的抖音动作

### 终端控制台和步骤识别

命令：

```powershell
node .\src\cli.js console --terms "恋爱;情感;日常vlog"
```

控制台调用：

```text
AutomationConsole
  -> BrowserController.status/open
  -> DouyinController.inspectState
  -> DouyinController.inputSearch/openVideo/openComments/watchCycle/searchCycle
```

`inspectState` 会读取当前页面 URL、搜索框、视频候选、评论区状态，并给出下一步建议。

### 搜索框输入

命令：

```powershell
node .\src\cli.js douyin input-search --terms "恋爱;情感;日常vlog" --min-delay-ms 400 --max-delay-ms 1200
```

分层路径：

```text
CLI
  -> DouyinController.inputSearch
  -> DevtoolsClient.listTargets
  -> DevtoolsSession WebSocket
  -> Runtime.evaluate
  -> 页面内定位搜索框并写入随机候选词
  -> 随机延迟
  -> Input.dispatchKeyEvent 按 Enter 执行搜索
```

候选词使用英文分号 `;` 或中文分号 `；` 分隔。

默认会执行搜索。传入 `--no-submit` 时只填入搜索框。搜索框定位不是固定首页选择器，而是选择当前页面可见搜索框；搜索结果页、视频浮层左上角搜索框都走同一套逻辑。

### 搜索结果选中视频

命令：

```powershell
node .\src\cli.js douyin open-video --index 0
```

分层路径：

```text
CLI
  -> DouyinController.openVideo
  -> DevtoolsClient.listTargets
  -> DevtoolsSession WebSocket
  -> Runtime.evaluate
  -> 页面内围绕 video/img/picture/canvas 识别视频卡片
  -> 将候选卡片滚动到视口中间
  -> Input.dispatchMouseEvent 点击选中视频
  -> 点击无效时 Runtime.evaluate 执行 DOM click 兜底
```

默认点击识别到的第一个视频，`--index` 从 `0` 开始。当前实现不强制切换“多列/单列”，而是在当前搜索结果页里按从上到下、从左到右的顺序识别可见视频卡片。

### 视频周期浏览

命令：

```powershell
node .\src\cli.js douyin watch-cycle --cycles 1 --min-watch-sec 120 --max-watch-sec 180
```

分层路径：

```text
CLI
  -> DouyinController.watchCycle
  -> DevtoolsClient.listTargets
  -> DevtoolsSession WebSocket
  -> Runtime.evaluate 检测评论区滚动容器
  -> Input.dispatchKeyEvent 按 x 打开评论区
  -> Input.dispatchMouseEvent mouseWheel 翻阅评论
  -> Input.dispatchKeyEvent 按 ArrowDown/ArrowUp 切换视频
```

默认只做 1 个周期：当前视频停留 2 到 3 分钟，期间低速、小幅度滚动评论区，时间到后按下方向键进入下一个视频。后续任务循环可以复用这个动作作为基础单元。

### 刷一会后换搜索词

命令：

```powershell
node .\src\cli.js douyin search-cycle --terms "恋爱;情感;日常vlog" --searches 2 --min-browse-sec 120 --max-browse-sec 180
```

分层路径：

```text
CLI
  -> DouyinController.searchCycle
  -> browseVideosForDuration
  -> searchVisibleBox
  -> openVisibleVideoFromResults
```

这个动作是任务层组合：先浏览一段随机时间，再从本次命令未用过的候选词里随机选词搜索。搜索后如果回到结果页，会尝试点击第一个视频继续进入视频浮层。

### 完整循环

命令：

```powershell
node .\src\cli.js douyin full-cycle --terms "恋爱;情感;日常vlog" --searches 3 --min-browse-sec 120 --max-browse-sec 180
```

分层路径：

```text
CLI
  -> DouyinController.fullCycle
  -> searchVisibleBox
  -> openVisibleVideoFromResults
  -> ensureCommentPanelOpen
  -> browseVideosForDuration
  -> 换下一个未用搜索词
```

每轮先搜索并进入视频，再打开评论区、翻评论、按上下键切视频。到达随机搜索间隔后，从本次未用搜索词里选下一个词进入下一轮。

WinForms 界面的“开始循环”是在桌面层持续调用单次 `full-cycle`，并维护本轮未用搜索词队列；点击“停止”会取消当前任务并终止正在运行的 Node 子进程。

## 为什么当前不做 Web 控制台

Web 控制台的价值是管理远程任务和展示状态，但这个项目当前目标是本机桌面自动化和后续 exe 软件形态。

因此主入口选择 WinForms 原生桌面端：

- 不需要启动额外 Web 服务。
- 可以直接调用本地 Node 控制器。
- 能保留可视化参数、日志、步骤识别。
- 可以直接通过 `dotnet publish` 输出 Windows exe。

CLI 和终端控制台继续保留，作为调试和单步验证入口。
