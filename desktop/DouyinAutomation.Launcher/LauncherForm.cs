using DouyinAutomation.Desktop;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace DouyinAutomation.Launcher;

internal sealed class LauncherForm : Form
{
    private static readonly Color WindowColor = WorkspaceTheme.Canvas;
    private static readonly Color SurfaceColor = WorkspaceTheme.Surface;
    private static readonly Color SurfaceRaisedColor = WorkspaceTheme.Field;
    private static readonly Color BorderColor = WorkspaceTheme.Border;
    private static readonly Color MutedColor = WorkspaceTheme.Muted;
    private static readonly Color AccentColor = WorkspaceTheme.Accent;
    private static readonly Color WarningColor = WorkspaceTheme.Warning;
    private static readonly Color ErrorColor = WorkspaceTheme.Danger;

    private readonly string _projectRoot;
    private readonly Label _modeBadge = new();
    private readonly Label _productState = new();
    private readonly Label _nodeState = new();
    private readonly Label _chromeState = new();
    private readonly Label _connectionState = new();
    private readonly Label _developerState = new();
    private readonly Label _dataState = new();
    private readonly Label _launchState = new();
    private readonly Button _launchButton;
    private readonly Button _connectButton;
    private readonly Button _refreshButton;
    private readonly Button _detailsButton;
    private readonly Button _cancelButton;
    private readonly ToolTip _toolTip = new();
    private readonly StringBuilder _diagnosticHistory = new();

    private DesktopArtifact? _desktopArtifact;
    private string? _nodeExecutable;
    private bool _canLaunch;
    private bool _chromeAvailable;
    private bool _canBuild;
    private bool _browserConnected;
    private bool _working;
    private bool _closeWhenIdle;
    private CancellationTokenSource? _operationCancellation;

    public LauncherForm(string projectRoot)
    {
        _projectRoot = Path.GetFullPath(projectRoot);
        Text = "抖音工作台 · 启动中心";
        ClientSize = new Size(820, 586);
        MinimumSize = new Size(760, 550);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
        BackColor = WindowColor;
        ForeColor = WorkspaceTheme.Text;
        KeyPreview = true;

        TableLayoutPanel root = new()
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(26, 22, 26, 20),
            ColumnCount = 1,
            RowCount = 5,
        };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 88));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 292));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        Controls.Add(root);

        root.Controls.Add(BuildHeader(), 0, 0);
        root.Controls.Add(BuildEnvironmentPanel(), 0, 1);

        TableLayoutPanel actions = new()
        {
            Dock = DockStyle.Fill,
            ColumnCount = 5,
            Margin = new Padding(0, 14, 0, 0),
        };
        actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
        actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 27));
        actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 16));
        actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 18));
        actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 14));

        _launchButton = CreateButton("打开工作台", primary: true);
        _connectButton = CreateButton("连接浏览器并打开");
        _refreshButton = CreateButton("重新检测");
        _detailsButton = CreateButton("诊断详情");
        _cancelButton = CreateButton("取消");
        _cancelButton.ForeColor = WarningColor;
        _cancelButton.FlatAppearance.BorderColor = WarningColor;

        _launchButton.Click += async (_, _) => await LaunchAsync(connectBrowser: false);
        _connectButton.Click += async (_, _) => await LaunchAsync(connectBrowser: true);
        _refreshButton.Click += async (_, _) => await CheckEnvironmentAsync();
        _detailsButton.Click += (_, _) => ShowDiagnostics();
        _cancelButton.Click += (_, _) => CancelCurrentOperation(closeAfterCancel: false);

        actions.Controls.Add(_launchButton, 0, 0);
        actions.Controls.Add(_connectButton, 1, 0);
        actions.Controls.Add(_refreshButton, 2, 0);
        actions.Controls.Add(_detailsButton, 3, 0);
        actions.Controls.Add(_cancelButton, 4, 0);
        root.Controls.Add(actions, 0, 2);

        Label safetyHint = new()
        {
            Dock = DockStyle.Fill,
            Text = "连接只会创建或复用专用 Chrome 调试会话；启动器不会自动搜索、评论或发送消息。",
            ForeColor = MutedColor,
            TextAlign = ContentAlignment.MiddleLeft,
        };
        root.Controls.Add(safetyHint, 0, 3);

        _launchState.Dock = DockStyle.Fill;
        _launchState.ForeColor = MutedColor;
        _launchState.Text = "正在检查成品与运行环境…";
        _launchState.TextAlign = ContentAlignment.MiddleLeft;
        _launchState.AutoEllipsis = true;
        root.Controls.Add(_launchState, 0, 4);

        AcceptButton = _launchButton;
        _toolTip.SetToolTip(_launchButton, "直接打开已发布控制台；仅开发目录缺少成品时才执行 Release 构建（Enter）");
        _toolTip.SetToolTip(_connectButton, "确认 Chrome 可用并建立调试连接后打开工作台");
        _toolTip.SetToolTip(_refreshButton, "重新检查成品、Node、Chrome 和连接状态（F5）");
        _toolTip.SetToolTip(_detailsButton, "查看并复制路径、版本、会话和最近命令结果");
        _toolTip.SetToolTip(_cancelButton, "取消当前检测、构建或连接操作（Esc）");
        UpdateButtons();
    }

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        await CheckEnvironmentAsync();
    }

    protected override async void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.F5 && !_working)
        {
            e.Handled = true;
            await CheckEnvironmentAsync();
            return;
        }

        if (e.KeyCode == Keys.Escape && _working)
        {
            e.Handled = true;
            CancelCurrentOperation(closeAfterCancel: false);
            return;
        }

        base.OnKeyDown(e);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (_working && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            CancelCurrentOperation(closeAfterCancel: true);
            return;
        }

        base.OnFormClosing(e);
    }

    private Control BuildHeader()
    {
        TableLayoutPanel panel = new()
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 2,
        };
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));

        Label title = new()
        {
            Dock = DockStyle.Fill,
            Text = "抖音工作台",
            Font = new Font("Microsoft YaHei UI", 17F, FontStyle.Bold, GraphicsUnit.Point),
            ForeColor = WorkspaceTheme.Text,
            TextAlign = ContentAlignment.MiddleLeft,
        };
        Label subtitle = new()
        {
            Dock = DockStyle.Fill,
            Text = "优先运行发布成品 · 环境检查 · 浏览器连接 · 故障诊断",
            ForeColor = MutedColor,
            TextAlign = ContentAlignment.TopLeft,
        };
        _modeBadge.Dock = DockStyle.Fill;
        _modeBadge.Margin = new Padding(12, 4, 0, 6);
        _modeBadge.BackColor = SurfaceRaisedColor;
        _modeBadge.ForeColor = MutedColor;
        _modeBadge.Text = "正在识别";
        _modeBadge.TextAlign = ContentAlignment.MiddleCenter;

        panel.Controls.Add(title, 0, 0);
        panel.SetRowSpan(title, 1);
        panel.Controls.Add(_modeBadge, 1, 0);
        panel.Controls.Add(subtitle, 0, 1);
        panel.SetColumnSpan(subtitle, 2);
        return panel;
    }

    private Control BuildEnvironmentPanel()
    {
        Panel panel = new WorkspaceCard()
        {
            Dock = DockStyle.Fill,
            BackColor = SurfaceColor,
            Padding = new Padding(20, 13, 20, 13),
        };
        TableLayoutPanel table = new()
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 6,
        };
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 128));
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (int row = 0; row < 6; row += 1)
        {
            table.RowStyles.Add(new RowStyle(SizeType.Percent, 16.6667F));
        }

        AddStatusRow(table, 0, "桌面成品", _productState);
        AddStatusRow(table, 1, "Node 运行时", _nodeState);
        AddStatusRow(table, 2, "Chrome", _chromeState);
        AddStatusRow(table, 3, "连接 / session", _connectionState);
        AddStatusRow(table, 4, "开发构建", _developerState);
        AddStatusRow(table, 5, "数据目录", _dataState);
        panel.Controls.Add(table);
        return panel;
    }

    private static void AddStatusRow(TableLayoutPanel table, int row, string name, Label value)
    {
        Label label = new()
        {
            Dock = DockStyle.Fill,
            Text = name,
            ForeColor = MutedColor,
            TextAlign = ContentAlignment.MiddleLeft,
        };
        value.Dock = DockStyle.Fill;
        value.ForeColor = WorkspaceTheme.Text;
        value.TextAlign = ContentAlignment.MiddleLeft;
        value.AutoEllipsis = true;
        table.Controls.Add(label, 0, row);
        table.Controls.Add(value, 1, row);
    }

    private Button CreateButton(string text, bool primary = false)
    {
        Button button = new WorkspaceButton()
        {
            Dock = DockStyle.Fill,
            Margin = new Padding(0, 0, 8, 0),
            Text = text,
            FlatStyle = FlatStyle.Flat,
            ForeColor = primary ? Color.White : WorkspaceTheme.Text,
            BackColor = primary ? AccentColor : SurfaceRaisedColor,
            Cursor = Cursors.Hand,
        };
        button.FlatAppearance.BorderColor = primary ? AccentColor : BorderColor;
        button.FlatAppearance.MouseOverBackColor = primary ? Color.FromArgb(70, 225, 198) : Color.FromArgb(43, 51, 64);
        return button;
    }

    private async Task CheckEnvironmentAsync()
    {
        CancellationToken token = BeginOperation("正在检查成品与运行环境…");
        try
        {
            _diagnosticHistory.Clear();
            AppendDiagnostic($"检测时间: {DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz}");
            AppendDiagnostic($"启动器: {Environment.ProcessPath ?? "未知"}");
            AppendDiagnostic($"识别根目录: {_projectRoot}");
            AppendDiagnostic($"系统: {RuntimeInformation.OSDescription} ({RuntimeInformation.ProcessArchitecture})");

            _desktopArtifact = ResolveDesktopArtifact();
            bool runtimeFilesOk = HasRuntimeFiles(_desktopArtifact?.WorkingRoot ?? _projectRoot);
            bool developerProject = File.Exists(GetDesktopProjectFile());

            if (_desktopArtifact is not null)
            {
                SetCheckState(_productState, CheckLevel.Ok, $"{_desktopArtifact.Kind} · {_desktopArtifact.Executable}");
                bool developmentArtifact = _desktopArtifact.Kind.Contains("开发", StringComparison.Ordinal);
                _modeBadge.Text = developmentArtifact ? "开发模式" : "成品模式";
                _modeBadge.ForeColor = developmentArtifact ? WarningColor : AccentColor;
            }
            else if (developerProject)
            {
                SetCheckState(_productState, CheckLevel.Warning, "未发现发布成品；首次启动将构建 Release 开发产物");
                _modeBadge.Text = "开发模式";
                _modeBadge.ForeColor = WarningColor;
            }
            else
            {
                SetCheckState(_productState, CheckLevel.Error, "未找到 app/DouyinAutomation.Desktop.exe 或可构建项目");
                _modeBadge.Text = "文件不完整";
                _modeBadge.ForeColor = ErrorColor;
            }

            string runtimeRoot = _desktopArtifact?.WorkingRoot ?? _projectRoot;
            if (!runtimeFilesOk)
            {
                SetCheckState(_productState, CheckLevel.Error, "缺少 src/cli.js 或 package.json，成品无法运行");
            }

            _nodeExecutable = ResolveNodeExecutable(runtimeRoot);
            CommandResult node = _nodeExecutable is null
                ? CommandResult.Failed("没有找到 bundled runtime/node.exe 或系统 Node.js")
                : await RunCommandAsync(_nodeExecutable, ["--version"], runtimeRoot, 10, token);
            bool nodeOk = node.Success && TryGetMajorVersion(node.Stdout, out int nodeMajor) && nodeMajor >= 22;
            string nodeSource = _nodeExecutable is not null && IsPathInside(_nodeExecutable, Path.Combine(runtimeRoot, "runtime"))
                ? "随包运行时"
                : "系统运行时";
            SetCheckState(_nodeState, nodeOk ? CheckLevel.Ok : CheckLevel.Error,
                nodeOk ? $"{nodeSource} · {node.Stdout.Trim()} · {_nodeExecutable}" : FirstNonEmpty(node.Stderr, node.Stdout, "需要 Node.js 22+"));

            _chromeAvailable = false;
            string chromeText = "需要可用的 Chrome 才能建立浏览器连接";
            if (runtimeFilesOk && nodeOk && _nodeExecutable is not null)
            {
                CommandResult doctor = await RunCommandAsync(_nodeExecutable, ["src/cli.js", "doctor"], runtimeRoot, 18, token);
                if (doctor.Success && TryExtractChromePath(doctor.Stdout, out string chromePath))
                {
                    _chromeAvailable = File.Exists(chromePath);
                    chromeText = _chromeAvailable ? chromePath : $"路径不存在: {chromePath}";
                }
                else
                {
                    chromeText = FirstNonEmpty(doctor.Stderr, doctor.Stdout, "未找到 Chrome");
                }
            }
            SetCheckState(_chromeState, _chromeAvailable ? CheckLevel.Ok : CheckLevel.Error, chromeText);

            BrowserSessionState sessionState = runtimeFilesOk && nodeOk && _nodeExecutable is not null
                ? await ReadBrowserStateAsync(_nodeExecutable, runtimeRoot, token)
                : BrowserSessionState.Unavailable("运行文件或 Node 不可用，尚未检查连接");
            ApplyBrowserState(sessionState);

            _canBuild = false;
            if (_desktopArtifact is not null)
            {
                SetCheckState(_developerState, CheckLevel.Neutral, "运行发布成品不需要 .NET SDK");
            }
            else if (developerProject)
            {
                CommandResult dotnet = await RunCommandAsync("dotnet", ["--version"], _projectRoot, 10, token);
                _canBuild = dotnet.Success && TryGetMajorVersion(dotnet.Stdout, out int dotnetMajor) && dotnetMajor >= 10;
                SetCheckState(_developerState, _canBuild ? CheckLevel.Warning : CheckLevel.Error,
                    _canBuild ? $"仅用于 Release 回退构建 · SDK {dotnet.Stdout.Trim()}" : FirstNonEmpty(dotnet.Stderr, dotnet.Stdout, "开发构建需要 .NET SDK 10+"));
            }
            else
            {
                SetCheckState(_developerState, CheckLevel.Neutral, "非开发目录；不执行也不要求 SDK 检查");
            }

            string dataRoot = Path.Combine(runtimeRoot, ".runtime");
            SetCheckState(_dataState, CheckLevel.Neutral, $"首次使用时创建 · {dataRoot}");
            _canLaunch = runtimeFilesOk && nodeOk && (_desktopArtifact is not null || _canBuild);

            string summary = _canLaunch
                ? _browserConnected
                    ? "运行环境正常，浏览器已连接。"
                    : "控制台可以启动；需要自动化时再点击“连接浏览器并打开”。"
                : "运行条件不完整；打开“诊断详情”可复制具体信息。";
            SetStatus(summary, _canLaunch ? CheckLevel.Ok : CheckLevel.Error);
        }
        catch (OperationCanceledException)
        {
            SetStatus("环境检查已取消。", CheckLevel.Warning);
        }
        catch (Exception error)
        {
            AppendDiagnostic("环境检查异常: " + error);
            ReportError("环境检查失败", error.Message);
        }
        finally
        {
            EndOperation();
        }
    }

    private async Task LaunchAsync(bool connectBrowser)
    {
        if (!_canLaunch)
        {
            await CheckEnvironmentAsync();
            if (!_canLaunch)
            {
                ReportError("暂时无法启动", "缺少运行成品或必要环境。请查看红色项目，并打开“诊断详情”复制信息。", showDialog: true);
                return;
            }
        }

        CancellationToken token = BeginOperation(connectBrowser ? "正在确认浏览器连接…" : "正在打开工作台…");
        try
        {
            DesktopArtifact artifact = _desktopArtifact ?? await BuildReleaseFallbackAsync(token);
            string runtimeRoot = artifact.WorkingRoot;
            string? nodeExecutable = ResolveNodeExecutable(runtimeRoot) ?? _nodeExecutable;
            if (nodeExecutable is null)
            {
                throw new InvalidOperationException("启动前未找到 Node.js 运行时。");
            }

            _desktopArtifact = artifact;
            _nodeExecutable = nodeExecutable;

            Process? existing = FindExistingDesktopProcess(artifact.Executable, out List<string> conflictingProcesses);
            if (existing is not null)
            {
                if (connectBrowser)
                {
                    await EnsureBrowserConnectedAsync(token);
                }

                BringProcessToFront(existing);
                existing.Dispose();
                SetStatus("控制台已经在运行，已切换到现有窗口。", CheckLevel.Ok);
                CloseAfterSuccessfulLaunch();
                return;
            }

            if (conflictingProcesses.Count > 0)
            {
                throw new InvalidOperationException(
                    "检测到另一目录中的抖音自动化控制台正在运行。为避免浏览器连接与控制台读取不同 session，" +
                    "请先关闭旧控制台后重试。\n\n" + string.Join("\n", conflictingProcesses));
            }

            if (connectBrowser)
            {
                await EnsureBrowserConnectedAsync(token);
            }

            token.ThrowIfCancellationRequested();
            ProcessStartInfo startInfo = new()
            {
                FileName = artifact.Executable,
                WorkingDirectory = runtimeRoot,
                UseShellExecute = false,
            };
            string nodeDirectory = Path.GetDirectoryName(nodeExecutable) ?? string.Empty;
            string inheritedPath = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            startInfo.Environment["PATH"] = string.IsNullOrWhiteSpace(nodeDirectory)
                ? inheritedPath
                : nodeDirectory + Path.PathSeparator + inheritedPath;
            startInfo.Environment["DOUYIN_AUTOMATION_HOME"] = runtimeRoot;

            Process.Start(startInfo);
            AppendDiagnostic($"已启动桌面端: {artifact.Executable}");
            SetStatus(connectBrowser ? "浏览器连接已验证，控制台已启动。" : "控制台已启动。", CheckLevel.Ok);
            CloseAfterSuccessfulLaunch();
        }
        catch (OperationCanceledException)
        {
            SetStatus("启动操作已取消；未继续打开工作台。", CheckLevel.Warning);
        }
        catch (Exception error)
        {
            AppendDiagnostic("启动异常: " + error);
            ReportError("启动失败", error.Message, showDialog: true);
        }
        finally
        {
            EndOperation();
        }
    }

    private async Task<DesktopArtifact> BuildReleaseFallbackAsync(CancellationToken token)
    {
        if (!_canBuild)
        {
            throw new InvalidOperationException("未发现发布成品，并且当前环境不能执行开发构建。");
        }

        string projectFile = GetDesktopProjectFile();
        string outputDirectory = Path.Combine(_projectRoot, ".runtime", "desktop-build");
        Directory.CreateDirectory(outputDirectory);
        SetStatus("未发现发布成品，正在执行一次 Release 开发构建…", CheckLevel.Warning);
        CommandResult build = await RunCommandAsync(
            "dotnet",
            ["build", projectFile, "-c", "Release", "-r", "win-x64", "-o", outputDirectory, "--nologo"],
            _projectRoot,
            240,
            token);
        if (!build.Success)
        {
            throw new InvalidOperationException("Release 构建失败：" + SummarizeCommandError(build));
        }

        string executable = Path.Combine(outputDirectory, "DouyinAutomation.Desktop.exe");
        if (!File.Exists(executable))
        {
            throw new FileNotFoundException("Release 构建完成，但没有生成 DouyinAutomation.Desktop.exe。", executable);
        }

        AppendDiagnostic($"Release 回退产物: {executable}");
        return new DesktopArtifact(executable, _projectRoot, "Release 开发产物");
    }

    private async Task EnsureBrowserConnectedAsync(CancellationToken token)
    {
        if (_browserConnected)
        {
            SetStatus("已有可用调试连接，正在启动控制台…", CheckLevel.Ok);
            return;
        }

        DesktopArtifact? artifact = _desktopArtifact;
        string runtimeRoot = artifact?.WorkingRoot ?? _projectRoot;
        string? nodeExecutable = ResolveNodeExecutable(runtimeRoot) ?? _nodeExecutable;
        if (nodeExecutable is null)
        {
            throw new InvalidOperationException("没有可用的 Node.js，无法建立浏览器连接。");
        }

        if (!_chromeAvailable)
        {
            throw new InvalidOperationException("没有检测到 Chrome，无法建立浏览器连接。");
        }

        SetStatus("正在创建或复用专用 Chrome 调试会话…", CheckLevel.Warning);
        CommandResult open = await RunCommandAsync(nodeExecutable, ["src/cli.js", "browser", "open", "--once"], runtimeRoot, 60, token);
        if (!open.Success)
        {
            throw new InvalidOperationException("Chrome 连接失败：" + SummarizeCommandError(open));
        }

        BrowserSessionState verified = await ReadBrowserStateAsync(nodeExecutable, runtimeRoot, token);
        ApplyBrowserState(verified);
        if (!verified.Connected)
        {
            throw new InvalidOperationException("Chrome 已启动，但调试端口验证失败：" + verified.Detail);
        }

        SetStatus("Chrome 调试连接已验证，正在启动控制台…", CheckLevel.Ok);
    }

    private async Task<BrowserSessionState> ReadBrowserStateAsync(string nodeExecutable, string runtimeRoot, CancellationToken token)
    {
        string sessionFile = Path.Combine(runtimeRoot, ".runtime", "session.json");
        CommandResult status = await RunCommandAsync(nodeExecutable, ["src/cli.js", "browser", "status"], runtimeRoot, 15, token);
        if (!status.Success)
        {
            string detail = "状态命令失败: " + SummarizeCommandError(status);
            return File.Exists(sessionFile)
                ? new BrowserSessionState(true, false, false, "发现残留 session，但无法读取 · " + detail)
                : BrowserSessionState.Unavailable(detail);
        }

        if (!TryExtractJson(status.Stdout, out JsonDocument? document) || document is null)
        {
            return File.Exists(sessionFile)
                ? new BrowserSessionState(true, false, false, "发现残留 session，但状态输出不是有效 JSON")
                : BrowserSessionState.Unavailable("状态输出不是有效 JSON");
        }

        using (document)
        {
            JsonElement root = document.RootElement;
            bool hasSession = TryReadBoolean(root, "hasSession");
            bool connected = TryReadBoolean(root, "connected");
            if (!hasSession)
            {
                return new BrowserSessionState(false, false, false, "未连接；没有 session 记录");
            }

            bool reused = false;
            int? pid = null;
            string endpoint = "127.0.0.1:9222";
            if (root.TryGetProperty("session", out JsonElement session))
            {
                reused = TryReadBoolean(session, "reused");
                if (session.TryGetProperty("pid", out JsonElement pidElement) && pidElement.TryGetInt32(out int parsedPid))
                {
                    pid = parsedPid;
                }

                string host = TryReadString(session, "remoteDebuggingHost") ?? "127.0.0.1";
                string port = session.TryGetProperty("remoteDebuggingPort", out JsonElement portElement) ? portElement.ToString() : "9222";
                endpoint = $"{host}:{port}";
            }

            if (connected)
            {
                string owner = reused ? "复用既有调试会话" : pid is not null ? $"专用进程 PID {pid}" : "调试会话";
                return new BrowserSessionState(true, true, reused, $"已连接 {endpoint} · {owner}");
            }

            string error = TryReadString(root, "error") ?? "调试端口不可达";
            return new BrowserSessionState(true, false, reused, $"发现残留 session，但未连接 · {error}");
        }
    }

    private void ApplyBrowserState(BrowserSessionState state)
    {
        _browserConnected = state.Connected;
        if (state.Connected)
        {
            SetCheckState(_connectionState, CheckLevel.Ok, state.Detail);
        }
        else if (state.HasSession)
        {
            SetCheckState(_connectionState, CheckLevel.Warning, state.Detail + "；下次连接会刷新记录");
        }
        else
        {
            SetCheckState(_connectionState, CheckLevel.Neutral, state.Detail);
        }
    }

    private DesktopArtifact? ResolveDesktopArtifact()
    {
        List<DesktopArtifact> candidates =
        [
            new(Path.Combine(_projectRoot, "app", "DouyinAutomation.Desktop.exe"), _projectRoot, "发布包"),
            new(Path.Combine(_projectRoot, "dist", "DouyinAutomation", "app", "DouyinAutomation.Desktop.exe"), Path.Combine(_projectRoot, "dist", "DouyinAutomation"), "项目内完整成品"),
            new(Path.Combine(_projectRoot, "dist", "DouyinAutomation.Desktop", "DouyinAutomation.Desktop.exe"), _projectRoot, "项目内 Desktop 成品"),
            new(Path.Combine(_projectRoot, ".runtime", "desktop-build", "DouyinAutomation.Desktop.exe"), _projectRoot, "缓存的 Release 开发产物"),
        ];

        foreach (DesktopArtifact candidate in candidates)
        {
            if (File.Exists(candidate.Executable) && HasRuntimeFiles(candidate.WorkingRoot))
            {
                AppendDiagnostic($"桌面成品: {candidate.Kind} | {candidate.Executable}");
                return candidate;
            }
        }

        AppendDiagnostic("桌面成品: 未找到");
        return null;
    }

    private static bool HasRuntimeFiles(string root)
    {
        return File.Exists(Path.Combine(root, "src", "cli.js")) && File.Exists(Path.Combine(root, "package.json"));
    }

    private string? ResolveNodeExecutable(string runtimeRoot)
    {
        string bundled = Path.Combine(runtimeRoot, "runtime", "node.exe");
        if (File.Exists(bundled))
        {
            return bundled;
        }

        string projectBundled = Path.Combine(_projectRoot, "runtime", "node.exe");
        if (File.Exists(projectBundled))
        {
            return projectBundled;
        }

        return FindExecutableOnPath("node.exe");
    }

    private static string? FindExecutableOnPath(string executable)
    {
        string? pathValue = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrWhiteSpace(pathValue))
        {
            return null;
        }

        foreach (string item in pathValue.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            try
            {
                string candidate = Path.Combine(item.Trim('"'), executable);
                if (File.Exists(candidate))
                {
                    return Path.GetFullPath(candidate);
                }
            }
            catch
            {
                // Ignore malformed PATH items and continue with the next one.
            }
        }

        return null;
    }

    private string GetDesktopProjectFile()
    {
        return Path.Combine(_projectRoot, "desktop", "DouyinAutomation.Desktop", "DouyinAutomation.Desktop.csproj");
    }

    private CancellationToken BeginOperation(string message)
    {
        _operationCancellation?.Dispose();
        _operationCancellation = new CancellationTokenSource();
        _working = true;
        UseWaitCursor = true;
        SetStatus(message, CheckLevel.Neutral);
        UpdateButtons();
        return _operationCancellation.Token;
    }

    private void EndOperation()
    {
        _working = false;
        UseWaitCursor = false;
        _operationCancellation?.Dispose();
        _operationCancellation = null;
        UpdateButtons();
        if (_closeWhenIdle && !IsDisposed)
        {
            BeginInvoke(Close);
        }
    }

    private void CancelCurrentOperation(bool closeAfterCancel)
    {
        if (!_working)
        {
            if (closeAfterCancel)
            {
                Close();
            }
            return;
        }

        _closeWhenIdle |= closeAfterCancel;
        SetStatus(closeAfterCancel ? "正在取消当前工作，完成后关闭…" : "正在取消当前工作…", CheckLevel.Warning);
        _operationCancellation?.Cancel();
        _cancelButton.Enabled = false;
    }

    private void UpdateButtons()
    {
        _launchButton.Enabled = !_working && _canLaunch;
        _connectButton.Enabled = !_working && _canLaunch && _chromeAvailable;
        _refreshButton.Enabled = !_working;
        _detailsButton.Enabled = true;
        _cancelButton.Enabled = _working;
    }

    private void CloseAfterSuccessfulLaunch()
    {
        _closeWhenIdle = true;
    }

    private void SetStatus(string message, CheckLevel level)
    {
        _launchState.Text = message;
        _launchState.ForeColor = ColorFor(level);
        AppendDiagnostic("状态: " + message);
    }

    private void ReportError(string title, string message, bool showDialog = false)
    {
        SetStatus(message, CheckLevel.Error);
        if (showDialog && !IsDisposed)
        {
            MessageBox.Show(this, message + "\n\n可点击“诊断详情”复制完整信息。", title, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static void SetCheckState(Label label, CheckLevel level, string text)
    {
        string prefix = level switch
        {
            CheckLevel.Ok => "● 可用   ",
            CheckLevel.Warning => "● 注意   ",
            CheckLevel.Error => "● 不可用 ",
            _ => "● 信息   ",
        };
        label.Text = prefix + CollapseWhitespace(text);
        label.ForeColor = ColorFor(level);
    }

    private static Color ColorFor(CheckLevel level)
    {
        return level switch
        {
            CheckLevel.Ok => AccentColor,
            CheckLevel.Warning => WarningColor,
            CheckLevel.Error => ErrorColor,
            _ => MutedColor,
        };
    }

    private void ShowDiagnostics()
    {
        string details = BuildDiagnosticText();
        using Form dialog = new()
        {
            Text = "启动器诊断详情",
            ClientSize = new Size(760, 500),
            MinimumSize = new Size(640, 420),
            StartPosition = FormStartPosition.CenterParent,
            BackColor = WindowColor,
            ForeColor = WorkspaceTheme.Text,
            Font = Font,
        };
        TextBox textBox = new()
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Both,
            WordWrap = false,
            BackColor = SurfaceColor,
            ForeColor = WorkspaceTheme.Text,
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Consolas", 9F),
            Text = details,
        };
        Button copy = CreateButton("复制全部", primary: true);
        copy.Dock = DockStyle.Right;
        copy.Width = 126;
        copy.Margin = new Padding(8);
        copy.Click += (_, _) =>
        {
            try
            {
                Clipboard.SetText(details);
                copy.Text = "已复制";
            }
            catch (Exception error)
            {
                MessageBox.Show(dialog, "无法复制到剪贴板：" + error.Message, "复制失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        };
        Button close = CreateButton("关闭");
        close.Dock = DockStyle.Right;
        close.Width = 100;
        close.Margin = new Padding(8);
        close.Click += (_, _) => dialog.Close();
        Panel footer = new() { Dock = DockStyle.Bottom, Height = 54, Padding = new Padding(8) };
        footer.Controls.Add(close);
        footer.Controls.Add(copy);
        dialog.Controls.Add(textBox);
        dialog.Controls.Add(footer);
        dialog.AcceptButton = copy;
        dialog.CancelButton = close;
        dialog.ShowDialog(this);
    }

    private string BuildDiagnosticText()
    {
        StringBuilder builder = new();
        builder.AppendLine("抖音自动化启动器诊断");
        builder.AppendLine(new string('=', 48));
        builder.AppendLine($"生成时间: {DateTimeOffset.Now:O}");
        builder.AppendLine($"根目录: {_projectRoot}");
        builder.AppendLine($"桌面程序: {_desktopArtifact?.Executable ?? "未找到"}");
        builder.AppendLine($"运行目录: {_desktopArtifact?.WorkingRoot ?? _projectRoot}");
        builder.AppendLine($"Node: {_nodeExecutable ?? "未找到"}");
        builder.AppendLine($"可启动: {_canLaunch}");
        builder.AppendLine($"Chrome 可用: {_chromeAvailable}");
        builder.AppendLine($"浏览器已连接: {_browserConnected}");
        builder.AppendLine($"session 文件: {Path.Combine(_desktopArtifact?.WorkingRoot ?? _projectRoot, ".runtime", "session.json")}");
        builder.AppendLine();
        builder.AppendLine("界面状态");
        builder.AppendLine($"桌面成品: {_productState.Text}");
        builder.AppendLine($"Node 运行时: {_nodeState.Text}");
        builder.AppendLine($"Chrome: {_chromeState.Text}");
        builder.AppendLine($"连接 / session: {_connectionState.Text}");
        builder.AppendLine($"开发构建: {_developerState.Text}");
        builder.AppendLine($"数据目录: {_dataState.Text}");
        builder.AppendLine();
        builder.AppendLine("检测与命令记录");
        builder.Append(_diagnosticHistory);
        return builder.ToString();
    }

    private void AppendDiagnostic(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return;
        }

        _diagnosticHistory.AppendLine($"[{DateTime.Now:HH:mm:ss}] {value.Trim()}");
    }

    private async Task<CommandResult> RunCommandAsync(
        string fileName,
        IEnumerable<string> arguments,
        string workingDirectory,
        int timeoutSeconds,
        CancellationToken cancellationToken)
    {
        List<string> args = arguments.ToList();
        ProcessStartInfo startInfo = new()
        {
            FileName = fileName,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (string argument in args)
        {
            startInfo.ArgumentList.Add(argument);
        }

        AppendDiagnostic($"> {Quote(fileName)} {string.Join(" ", args.Select(Quote))}");
        using Process process = new() { StartInfo = startInfo };
        try
        {
            process.Start();
            Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
            Task<string> stderrTask = process.StandardError.ReadToEndAsync();
            using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));
            try
            {
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                TryKillProcessTree(process);
                if (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }

                string timeoutMessage = $"执行超过 {timeoutSeconds} 秒，已停止。";
                AppendDiagnostic(timeoutMessage);
                return new CommandResult(-1, await stdoutTask, FirstNonEmpty(await stderrTask, timeoutMessage));
            }

            CommandResult result = new(process.ExitCode, await stdoutTask, await stderrTask);
            AppendDiagnostic($"退出码: {result.ExitCode}");
            if (!string.IsNullOrWhiteSpace(result.Stdout))
            {
                AppendDiagnostic("stdout: " + LimitText(result.Stdout));
            }
            if (!string.IsNullOrWhiteSpace(result.Stderr))
            {
                AppendDiagnostic("stderr: " + LimitText(result.Stderr));
            }
            return result;
        }
        catch (OperationCanceledException)
        {
            TryKillProcessTree(process);
            AppendDiagnostic("命令已由用户取消。");
            throw;
        }
        catch (Exception error)
        {
            AppendDiagnostic("命令启动失败: " + error.Message);
            return CommandResult.Failed(error.Message);
        }
    }

    private static void TryKillProcessTree(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(5_000);
            }
        }
        catch
        {
            // Best effort cancellation.
        }
    }

    private static Process? FindExistingDesktopProcess(string expectedExecutable, out List<string> conflicts)
    {
        conflicts = [];
        Process? matching = null;
        string expectedPath = Path.GetFullPath(expectedExecutable);

        foreach (Process process in Process.GetProcessesByName("DouyinAutomation.Desktop"))
        {
            if (process.MainWindowHandle == IntPtr.Zero)
            {
                process.Dispose();
                continue;
            }

            string? actualPath = null;
            try
            {
                actualPath = process.MainModule?.FileName;
            }
            catch
            {
                // Treat an unreadable path as a conflict.  It is safer to ask
                // the user to close it than to connect this root to that UI.
            }

            if (!string.IsNullOrWhiteSpace(actualPath) &&
                string.Equals(Path.GetFullPath(actualPath), expectedPath, StringComparison.OrdinalIgnoreCase))
            {
                if (matching is null)
                {
                    matching = process;
                }
                else
                {
                    process.Dispose();
                }
                continue;
            }

            conflicts.Add($"PID {process.Id}: {actualPath ?? "无法读取可执行文件路径"}");
            process.Dispose();
        }

        return matching;
    }

    private static void BringProcessToFront(Process process)
    {
        IntPtr handle = process.MainWindowHandle;
        if (handle == IntPtr.Zero)
        {
            return;
        }

        ShowWindow(handle, 9);
        SetForegroundWindow(handle);
    }

    private static bool TryGetMajorVersion(string value, out int major)
    {
        string normalized = value.Trim().TrimStart('v', 'V');
        string first = normalized.Split('.', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? string.Empty;
        return int.TryParse(first, out major);
    }

    private static bool TryExtractChromePath(string stdout, out string chromePath)
    {
        chromePath = string.Empty;
        if (!TryExtractJson(stdout, out JsonDocument? document) || document is null)
        {
            return false;
        }

        using (document)
        {
            if (!document.RootElement.TryGetProperty("chromePath", out JsonElement pathElement))
            {
                return false;
            }

            chromePath = pathElement.GetString() ?? string.Empty;
            return !string.IsNullOrWhiteSpace(chromePath);
        }
    }

    private static bool TryExtractJson(string value, out JsonDocument? document)
    {
        document = null;
        int start = value.IndexOf('{');
        int end = value.LastIndexOf('}');
        if (start < 0 || end < start)
        {
            return false;
        }

        try
        {
            document = JsonDocument.Parse(value[start..(end + 1)]);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool TryReadBoolean(JsonElement element, string property)
    {
        return element.TryGetProperty(property, out JsonElement value) && value.ValueKind == JsonValueKind.True;
    }

    private static string? TryReadString(JsonElement element, string property)
    {
        return element.TryGetProperty(property, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static bool IsPathInside(string path, string directory)
    {
        string normalizedPath = Path.GetFullPath(path);
        string normalizedDirectory = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return normalizedPath.StartsWith(normalizedDirectory, StringComparison.OrdinalIgnoreCase);
    }

    private static string SummarizeCommandError(CommandResult result)
    {
        string source = FirstNonEmpty(result.Stderr, result.Stdout, "没有错误详情");
        string[] lines = source.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        string[] important = lines.Where(line => line.Contains("error", StringComparison.OrdinalIgnoreCase) || line.Contains("失败", StringComparison.OrdinalIgnoreCase)).Take(3).ToArray();
        return CollapseWhitespace(string.Join(" | ", important.Length > 0 ? important : lines.TakeLast(3)));
    }

    private static string FirstNonEmpty(params string[] values)
    {
        return values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))?.Trim() ?? string.Empty;
    }

    private static string CollapseWhitespace(string value)
    {
        return string.Join(" ", value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
    }

    private static string LimitText(string value)
    {
        string normalized = value.Trim();
        return normalized.Length <= 4_000 ? normalized : normalized[..4_000] + " …(已截断)";
    }

    private static string Quote(string value)
    {
        return value.Any(char.IsWhiteSpace) ? $"\"{value.Replace("\"", "\\\"")}\"" : value;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    private enum CheckLevel
    {
        Neutral,
        Ok,
        Warning,
        Error,
    }

    private sealed record DesktopArtifact(string Executable, string WorkingRoot, string Kind);

    private sealed record BrowserSessionState(bool HasSession, bool Connected, bool Reused, string Detail)
    {
        public static BrowserSessionState Unavailable(string detail) => new(false, false, false, detail);
    }

    private sealed record CommandResult(int ExitCode, string Stdout, string Stderr)
    {
        public bool Success => ExitCode == 0;

        public static CommandResult Failed(string error) => new(-1, string.Empty, error);
    }
}
