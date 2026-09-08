# 抖音工作台 v1.2.0

这是一个本地 Windows 桌面工具。原生 WinForms 界面通过随包 Node 控制器连接可见 Chrome，再由 Chrome DevTools Protocol 执行用户在界面中明确选择的动作；

## v1.2 白色卡片界面

- 白色主题、浅灰背景、圆角卡片和蓝色重点操作。
- 导航、采集准备与内容区采用独立卡片，保留全部原有功能。
- 表格、设置、AI 弹窗、错误详情和启动中心同步采用浅色样式。
- 保持键盘焦点、禁用状态和任务警示的可见性。

## v1.1 界面与设置

- 侧栏分为采集工作台、AI 文案、私信管理、设置、连接诊断和运行日志。
- 首页只保留搜索与浏览操作、筛选和评论表格；任务参数集中在设置中。
- 设置标明秒、条和轮等单位，支持范围校验、恢复默认任务参数、紧凑表格、窗口大小记忆。
- 保存操作固定在设置页底部，小窗口仍可直接保存；文案页支持垂直滚动。
- 参数修改用于下一次任务，点击保存设置或正常关闭窗口后持久保存。
- AI 地址检查会拦截错误格式、重复的 chat/completions 路径和空模型名称。
- 原有评论/私信授权仍每次启动重置。分析报告和需求分类未包含在本次版本中。

## 成品运行（推荐）

发布后双击：

```text
dist\DouyinAutomation\抖音自动化启动器.exe
```

成品已经包含自包含 Launcher、Desktop 和 `runtime\node.exe`。普通运行只需要：

- 64 位 Windows；
- 本机已安装 Google Chrome；
- 对成品目录及其 `.runtime` 子目录有读写权限。

不需要另外安装 Node.js、npm 或 .NET SDK。`.NET SDK 10+` 只在源码开发目录缺少发布物、需要回退构建时使用。

启动器提供两个入口：

- **打开工作台**：只打开桌面界面，不创建浏览器连接，不执行页面动作；
- **连接浏览器并打开**：创建或复用专用 Chrome 调试会话，通过 `/json/version` 重新验证连接成功后再打开桌面界面。

状态区会明确显示：正在使用发布包还是开发产物、随包还是系统 Node、Chrome 路径、当前连接、残留 session 和开发构建能力。遇到问题时点击 **诊断详情 → 复制全部**，即可复制版本、路径、状态与最近命令结果。

如果启动器正在检测、构建或连接：点击 **取消**、按 `Esc`，或直接关闭窗口，都将先终止当前子进程；关闭操作会在取消完成后继续，不需要在后台等待失控进程。

## 成品目录与数据目录

标准成品结构：

```text
DouyinAutomation\
  抖音自动化启动器.exe
  app\DouyinAutomation.Desktop.exe
  runtime\node.exe
  src\
  package.json
  README.md
  LICENSES\
```

首次连接后会在**当前成品根目录**创建：

```text
.runtime\
  chrome-profile\   独立 Chrome 用户资料、登录态和站点数据
  session.json      最近一次调试连接的进程、端口与复用标记
```

`.runtime` 是用户数据，不属于程序成品。发布脚本不会复制源码目录中已有的 `.runtime`、Chrome profile 或 `session.json`。升级时可以替换程序文件并保留自己的 `.runtime`；分享或打包给别人前，不要附带 `.runtime`，因为其中可能包含登录信息。

桌面偏好、文案池与 AI 配置保存在 `%LocalAppData%\DouyinAutomation\Desktop\settings.json`，运行日志保存在 `%LocalAppData%\DouyinAutomation\Logs\desktop.log`。API Key 使用当前 Windows 用户的 DPAPI 加密；删除上述目录可以清除本机桌面设置和日志。评论/私信的“允许发送”开关不会跨启动保存，每次打开程序都需要重新启用。

如果状态显示“发现残留 session，但未连接”，表示记录仍在但调试端口已经不可达。它不是成功连接；再次点击 **连接浏览器并打开** 会创建连接并刷新记录。

## 连接、停止与关闭

桌面端的典型链路：

```text
连接抖音页面 -> 执行关键词搜索 -> 选中搜索结果视频 -> 打开评论区 -> 刷评论区并切换视频 -> 换未用搜索词
```

- **停止当前桌面动作**：按 `Esc`；
- **停止循环**：点击桌面端的 **停止循环**，或按 `Esc`；
- **停止采集/用户队列/私信队列**：点击对应的停止按钮，或按 `Esc`；
- **关闭桌面界面**：会取消当前界面任务，但不会默认删除独立 Chrome profile；
- **关闭自动化 Chrome**：在源码目录用 `npm run browser:close`，在成品目录用下面的随包命令。

```powershell
.\runtime\node.exe .\src\cli.js browser close
```

如果 session 标记为“复用既有调试会话”，普通关闭会拒绝误关。只有在确认该调试 Chrome 可以整体关闭时，才显式使用：

```powershell
.\runtime\node.exe .\src\cli.js browser close --force
```

`--force` 只绕过“复用会话”的默认拒绝，不能绕过所有权校验。程序仍会核对 session 的 host/port、浏览器 WebSocket 身份；必要时还会核对 Chrome 路径、调试端口和 profile 路径。无法证明是本工具记录的会话时会拒绝关闭并保留 session。验证通过后会关闭整个调试 Chrome 会话，不只是当前标签页。

## 安全确认

- 启动器的环境检测、诊断、打开工作台不会操作抖音页面；“连接浏览器并打开”只建立连接和打开默认页面，不会自动评论或私信。
- 无限循环和批量私信在桌面端开始前会显示确认弹窗；批量任务运行期间关键配置会锁定，并可按 `Esc` 停止。
- 评论发送默认需要在“评论发送”区域显式启用。启用后，“发送一条”就是实际外部发送动作；点击前应检查当前账号、视频和评论文案。
- 使用 AI 生成功能时，会把主题、模板和最近 20 条评论文本发送到界面中配置的 AI 服务商；不用该功能时不会发生这项数据外发。
- 复用已有调试会话时，默认关闭保护不会替用户强制关闭日常 Chrome；`--force` 也只绕过复用标记，绝不会绕过进程/端点所有权证明。
- `.runtime\chrome-profile` 持久保存专用浏览器登录态。不要提交到版本库或交给其他人。

## 开发与发布

源码开发需要 Node.js 22+ 和 .NET SDK 10+：

```powershell
cd path\to\douyin-workbench
npm install
npm run launcher
```

开发目录中的 Launcher 按以下顺序找桌面端：

1. 当前根目录 `app\DouyinAutomation.Desktop.exe`；
2. `dist\DouyinAutomation\app\DouyinAutomation.Desktop.exe` 完整成品；
3. `dist\DouyinAutomation.Desktop\DouyinAutomation.Desktop.exe` 独立 Desktop 发布物；
4. 缓存的 `.runtime\desktop-build\DouyinAutomation.Desktop.exe`。

只有这些发布物都不存在、并且当前目录确实包含 Desktop 项目时，Launcher 才会执行一次 `Release` 回退构建；不会再在每次启动时构建 Debug。

生成完整可分发成品：

```powershell
npm run product:publish
```

发布脚本会先在 `dist` 下的隔离暂存目录完成并校验所有文件，再安全切换到 `dist\DouyinAutomation`。它生成两个 `win-x64` 自包含单文件程序、复制 Node、`src`、说明和实际运行时许可证，并验证没有 `.runtime` 或 `session.json` 混入；升级现有成品时会原子迁移并保留原有 `.runtime`。可用 `-NodeExe` 指定要随包的 Node 22+：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-product.ps1 -NodeExe C:\path\to\node.exe
```

仅发布某个开发组件时仍可使用 `npm run launcher:publish` 或 `npm run desktop:publish`，但交付给普通用户应使用 `product:publish`。

## 项目分层

- `desktop/DouyinAutomation.Launcher`：成品发现、运行环境、连接状态、诊断和开发回退构建；
- `desktop/DouyinAutomation.Desktop`：WinForms 主界面、状态、按钮、确认弹窗和日志；
- `src/cli.js`：命令行入口与参数解析；
- `src/app`：应用服务层，编排业务动作；
- `src/infra/chrome`：Chrome 查找、启动、进程参数；
- `src/infra/cdp`：Chrome DevTools Protocol 连接与输入；
- `src/config`、`src/core`、`src/shared`：配置与通用基础设施。

详细设计见 `docs/ARCHITECTURE.zh-CN.md`。

## 命令行打开浏览器（开发）

```powershell
npm run browser:open
npm run browser:status
npm run browser:close
```

`browser:open` 默认打开 `https://www.douyin.com/jingxuan` 并返回；需要保持控制器监控时使用 `npm run browser:serve`，再以 `Ctrl+C` 停止监控进程。关闭监控进程不等于关闭 Chrome，关闭 Chrome 请使用 `browser:close`。

## 终端控制台

运行：

```powershell
npm run console
```

也可以启动时传入候选搜索词：

```powershell
npm run console -- --terms "情感;日常vlog;恋爱技巧"
```

控制台会识别当前步骤并给出下一步建议。当前步骤链路：

```text
连接抖音页面 -> 执行关键词搜索 -> 选中搜索结果视频 -> 打开评论区 -> 刷评论区并切换视频 -> 刷一会后换未用搜索词
```

控制台内常用命令：

```text
status        识别当前位置和下一步
next          执行系统建议的下一步
open          打开自动化 Chrome 和抖音
find-search   识别当前可用搜索框
search        用当前搜索框随机搜索一个词
open-video    打开搜索结果里的第一个视频
comments      打开评论区
watch         刷评论区并切到下一个视频
cycle         刷一会后换未用搜索词
terms 词1;词2 设置候选搜索词
quick         把刷视频/换词等待改成 10-15 秒，方便测试
quit          退出控制台
```

## 输入搜索词

建议每次测试先清理旧状态：

```powershell
npm run browser:close
```

然后打开浏览器：

```powershell
npm run browser:open
```

输入多个候选词，英文分号或中文分号都支持：

```powershell
node .\src\cli.js douyin input-search --terms "恋爱;情感;日常vlog"
```

工具会随机选择一个词填入抖音顶部搜索框，并默认按回车执行搜索。随机延迟默认在 `400ms` 到 `1200ms` 之间：

```powershell
node .\src\cli.js douyin input-search --terms "恋爱;情感;日常vlog" --min-delay-ms 800 --max-delay-ms 1800
```

这个命令现在会优先使用当前页面可见搜索框，不只支持首页。比如你已经进入视频浮层，左上角有搜索框时，也可以直接执行：

```powershell
npm run douyin:find-search
```

确认返回里 `searchBox.rect` 是左上角搜索框后，再执行：

```powershell
npm run douyin:input-search -- --terms "恋爱;情感;日常vlog"
```

如果只想填入搜索框，不提交搜索：

```powershell
node .\src\cli.js douyin input-search --terms "恋爱;情感;日常vlog" --no-submit
```

## 选中视频

先让页面停在抖音搜索结果页，再执行：

```powershell
npm run douyin:open-video
```

默认会点击当前可见搜索结果里识别到的第一个视频。要点击第 2 个、第 3 个视频，可以传入从 `0` 开始的序号：

```powershell
npm run douyin:open-video -- --index 1
```

也可以直接运行 CLI：

```powershell
node .\src\cli.js douyin open-video --index 0
```

这个步骤不强制切换“多列/单列”，会直接从当前页面可见的视频卡片中识别候选项并点击。当前返回结果里会包含识别到的候选数量、点击的视频摘要、点击前后的 URL，方便判断是否真的进入视频浮层。

## 视频停留、滚动评论、切到下一个视频

先进入视频详情页或视频浮层，再执行：

```powershell
npm run douyin:open-comments
```

这个命令只测试打开评论区，不会切换视频。确认评论区能打开后，再执行完整周期：

```powershell
npm run douyin:watch-cycle
```

默认流程：

- 如果评论区还没打开，先尝试按一次 `x`；如果没打开，再点击右侧评论按钮兜底。
- 在当前视频停留 `120` 到 `180` 秒，也就是 2 到 3 分钟。
- 停留期间，每隔约 4.5 到 9 秒低速滚动一次评论区。
- 每次评论滚动幅度随机在 `180px` 到 `420px` 之间。
- 时间到后按 `ArrowDown` 切到下一个视频，然后命令结束。

为了快速测试，可以把时间缩短：

```powershell
npm run douyin:watch-cycle -- --min-watch-sec 10 --max-watch-sec 15
```

连续处理多个视频周期：

```powershell
npm run douyin:watch-cycle -- --cycles 3
```

调慢评论滚动：

```powershell
npm run douyin:watch-cycle -- --comment-scroll-min-interval-sec 8 --comment-scroll-max-interval-sec 14 --comment-scroll-min-delta 120 --comment-scroll-max-delta 260
```

如果要用上键切换：

```powershell
npm run douyin:watch-cycle -- --direction up
```

## 刷一会后自动换搜索词

当前已经在视频浮层或结果页时，可以用候选词列表做自动换词。工具会先刷一段随机时间，再从候选词里随机选一个没有用过的词，用当前页面可见搜索框执行搜索。

快速测试：

```powershell
npm run douyin:search-cycle -- --terms "恋爱;情感;日常vlog" --searches 2 --min-browse-sec 10 --max-browse-sec 15
```

默认逻辑：

- 候选词用英文分号或中文分号分隔。
- 每次搜索都会从本次命令还没用过的词里随机选择。
- 本次命令里已经搜索过的词会从后续候选里剔除。
- 搜索前会先刷一段随机时间，默认 `120` 到 `180` 秒。
- 搜索后如果回到搜索结果页，会尝试点击第一个视频继续进入视频浮层。

如果希望启动后先搜索一次，再开始刷视频：

```powershell
npm run douyin:search-cycle -- --terms "恋爱;情感;日常vlog" --searches 2 --search-first
```

如果只想搜索，不要搜索后自动点第一个视频：

```powershell
npm run douyin:search-cycle -- --terms "恋爱;情感;日常vlog" --searches 2 --no-open-video-after-search
```

## 可视化循环

可视化界面里的“开始循环”会持续运行，直到点击“停止”。

每一轮会执行：

```text
随机取一个未用搜索词 -> 搜索 -> 点击进入视频 -> 打开评论区 -> 翻评论并切视频 -> 到随机搜索时间后换下一个未用搜索词
```

候选词会按轮次剔除已经用过的词；一轮候选词全部用完后，会重新洗牌进入下一轮。

关键参数：

- `步骤延迟最小/最大 秒`：每个大动作之间随机等待，例如搜索前、搜索后、打开评论前。
- `加载超时 秒`：等待搜索框或视频结果出现的最长时间，网络慢时可以调大。

底层单次循环也可以用命令测试：

```powershell
npm run douyin:full-cycle -- --terms "恋爱;情感;日常vlog" --searches 3 --min-browse-sec 120 --max-browse-sec 180 --min-step-delay-sec 3 --max-step-delay-sec 7 --video-ready-timeout-sec 30
```

## 独立评论采集测试

这个功能暂时不接入可视化界面和循环任务，只提供独立命令测试。

推荐先在自动化 Chrome 里打开某个视频，但不要手动打开评论区；命令会先开启 CDP Network 监听，再尝试打开评论区，这样更容易抓到 `cursor=0` 的第一页评论请求。

```powershell
npm run douyin:collect-comments -- --max-pages 3 --max-comments 80 --listen-timeout-sec 60
```

如果评论区已经打开，也可以直接运行。此时第一页请求可能已经发生过，命令会从后续滚动触发的请求继续采集。

滚动默认使用 `--scroll-driver wheel`，也就是在识别到的评论列表区域内发小幅随机鼠标滚轮事件，不会直接把 `scrollTop` 跳到底部。只有需要排查滚动触发时，再手动尝试：

```powershell
npm run douyin:collect-comments -- --max-pages 3 --max-comments 80 --scroll-driver hybrid
```

实现方式：

```text
CDP Network.enable
-> 注册 Network.requestWillBeSent / responseReceived / loadingFinished
-> 打开评论区
-> 只监听 /aweme/v1/web/comment/list/ 和可选 reply 接口
-> 只对匹配 requestId 调 Network.getResponseBody
-> 解析 comments
-> 提取评论内容、评论 ID、评论区显示属地、用户 uid、sec_uid、昵称和用户主页链接
```

默认不会输出完整原始请求 URL，避免把 `msToken`、`a_bogus` 等临时参数写进日志。需要调试 URL 时可以加：

```powershell
npm run douyin:collect-comments -- --max-pages 1 --include-raw-urls
```

输出里的每条评论包含：

```text
comment_id, text, likes, reply_count, create_time,
comment_ip_location,
user_nickname, user_uid, user_sec_uid, user_unique_id, user_short_id, user_link
```

采集停止原因看 `stopReason`：

```text
max-pages / max-comments / remote-has-more-false / no-new-comment-request-after-scroll / listen-timeout
```

## 方案说明

之前的 PowerShell WinForms 脚本 GUI 已废弃，不再作为主入口。它不适合承载后续复杂状态识别、异步任务和发布维护。

当前桌面端分层：

```text
Launcher（成品发现 / 环境与连接诊断）
  -> WinForms MainForm
  -> AutomationCommandRunner
  -> runtime/node.exe（成品）或系统 node（开发）
  -> src/cli.js
  -> BrowserController / DouyinController
  -> Chrome DevTools Protocol
  -> 可见 Chrome 抖音页面
```

后续新增功能时，优先在 `DouyinController` 里增加可测试动作，再在 WinForms 界面上增加按钮、参数和步骤展示。

当前默认使用运行根目录下的独立 Chrome Profile：`.runtime/chrome-profile`。成品运行时就是 `dist/DouyinAutomation/.runtime/chrome-profile`；源码运行时就是项目根目录的 `.runtime/chrome-profile`。这不是你平时打开的 Chrome 用户资料，所以不会自动带上日常 Chrome 的登录态。

这个独立 Profile 本身会保存登录信息；你在这个自动化 Chrome 里登录一次后，后续继续使用 `.runtime/chrome-profile` 就会保留。后续如果必须使用你日常 Chrome 的登录态，需要单独做 `attach` 模式或浏览器扩展模式。

后续如果要直接控制你已经登录的日常 Chrome，需要另做 `attach` 模式：先由用户用 `--remote-debugging-port` 启动 Chrome，然后本工具连接那个端口。
