using System.Globalization;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Reflection;

namespace DouyinAutomation.Desktop;

internal sealed partial class MainForm : Form
{
    private readonly string _projectRoot;
    private readonly AutomationCommandRunner _runner;
    private readonly SettingsStore _settingsStore;
    private readonly bool _refreshOnShown;
    private readonly List<Button> _actionButtons = [];
    private readonly Random _random = new();
    private readonly List<CommentRecord> _commentRecords = [];
    private readonly HashSet<string> _commentKeys = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _selectedCommentKeys = new(StringComparer.OrdinalIgnoreCase);

    private string _nextCommand = "status";
    private CancellationTokenSource? _loopCancellation;
    private CancellationTokenSource? _commentCollectCancellation;
    private CancellationTokenSource? _userLinkQueueCancellation;
    private CancellationTokenSource? _actionCancellation;
    private Task? _commentCollectionTask;
    private bool _loopRunning;
    private bool _commentCollectRunning;
    private bool _userLinkQueueRunning;
    private bool _busy;
    private bool _commentCollectionFollowsLoop;
    private bool _browserConnected;
    private bool _closing;
    private List<string> _remainingLoopTerms = [];

    private readonly Label _statusBadge = new();
    private readonly Label _connectionBadge = new();
    private readonly Label _lastCheckedLabel = new();
    private readonly TextBox _termsInput = new();
    private readonly NumericUpDown _openVideoIndexInput = new();
    private readonly NumericUpDown _minWatchMsInput = new();
    private readonly NumericUpDown _maxWatchMsInput = new();
    private readonly NumericUpDown _minBrowseMsInput = new();
    private readonly NumericUpDown _maxBrowseMsInput = new();
    private readonly NumericUpDown _minStepDelaySecInput = new();
    private readonly NumericUpDown _maxStepDelaySecInput = new();
    private readonly NumericUpDown _loadTimeoutSecInput = new();
    private readonly NumericUpDown _cyclesInput = new();
    private readonly NumericUpDown _searchesInput = new();
    private readonly Label _pageTitle = new();
    private readonly Label _pageUrl = new();
    private readonly Label _currentStep = new();
    private readonly Label _nextAction = new();
    private readonly ListBox _workflowList = new();
    private readonly Label _searchBoxState = new();
    private readonly Label _videoState = new();
    private readonly Label _commentState = new();
    private readonly RichTextBox _logBox = new();
    private readonly CheckBox _collectCommentsEnabledInput = new();
    private readonly NumericUpDown _commentLimitInput = new();
    private readonly NumericUpDown _commentTimeoutSecInput = new();
    private readonly NumericUpDown _commentNoNewScrollsInput = new();
    private readonly CheckBox _ipFilterEnabledInput = new();
    private readonly TextBox _ipFilterInput = new();
    private readonly CheckBox _textFilterEnabledInput = new();
    private readonly TextBox _textFilterInput = new();
    private readonly Label _commentCollectState = new();
    private readonly DataGridView _commentGrid = new();
    private readonly CheckBox _sendCommentsEnabledInput = new();
    private readonly RichTextBox _commentPoolInput = new();
    private readonly RichTextBox _privateMessagePoolInput = new();
    private readonly CheckBox _sendPrivateMessagesEnabledInput = new();
    private readonly NumericUpDown _privateMessageMaxSendInput = new();
    private readonly Label _privateMessageState = new();
    private readonly Dictionary<string, int> _privateMessageSendCounts = new(StringComparer.OrdinalIgnoreCase);
    private readonly TextBox _aiTopicInput = new();
    private readonly TextBox _aiTemplateInput = new();
    private readonly NumericUpDown _aiGenerateCountInput = new();
    private readonly TextBox _aiSystemPromptInput = new();
    private readonly CheckedListBox _aiCandidateList = new();
    private readonly Label _commentSendState = new();
    private readonly HashSet<string> _sentCommentVideoIds = new(StringComparer.OrdinalIgnoreCase);
    private readonly ToolTip _toolTip = new();
    private readonly System.Windows.Forms.Timer _commentRenderTimer = new() { Interval = 250 };
    private Button? _openBrowserButton;
    private Button? _refreshStateButton;
    private Button? _collectCommentsButton;
    private Button? _openSelectedUserLinksButton;
    private Button? _loopButton;
    private Button? _sendNextCommentButton;
    private Button? _generateAiButton;
    private Button? _appendAiCandidatesButton;
    private Button? _aiSettingsButton;
    private bool _commentSendBusy;
    private int _poolCursorIndex;
    private int _poolRepeatCount;
    private int _poolRepeatTarget;
    private int _sentCommentCount;
    private string _aiProvider = "DeepSeek";
    private string _aiBaseUrl = "https://api.deepseek.com";
    private string _aiModel = "deepseek-chat";
    private string _aiApiKey = "";
    private bool _aiRewriteEnabled;
    private string _aiRewriteTarget = "comment";
    private decimal _aiTemperature = 0.8M;

    public MainForm(string projectRoot, bool refreshOnShown = true, string? settingsDirectory = null)
    {
        _settingsStore = new SettingsStore(settingsDirectory);
        _projectRoot = projectRoot;
        _runner = new AutomationCommandRunner(projectRoot);
        _refreshOnShown = refreshOnShown;
        InitializeComponent();
        ConfigureCommentRenderTimer();
        LoadSettings();
        AppLog.Info("应用启动", $"版本 {GetApplicationVersion()}，项目目录：{_projectRoot}");
    }

    private sealed record CommentRecord(
        int Index,
        string IpLocation,
        string Text,
        string UserNickname,
        string UserLink,
        string UserUid,
        string UserSecUid,
        int Likes,
        int ReplyCount,
        string CreateTime,
        string CommentId,
        string VideoId,
        string Key);

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        if (_refreshOnShown)
        {
            await RefreshStateAsync(showErrors: false);
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        _closing = true;
        _actionCancellation?.Cancel();
        _loopCancellation?.Cancel();
        _commentCollectCancellation?.Cancel();
        _userLinkQueueCancellation?.Cancel();
        _runner.CancelAll();
        _commentRenderTimer.Stop();
        try
        {
            SaveSettings();
        }
        catch (Exception error)
        {
            AppLog.Exception("关闭时保存设置失败", error);
        }
        _runner.Dispose();
        base.OnFormClosing(e);
    }

    protected override async void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Escape)
        {
            e.Handled = true;
            StopActiveOperation();
            return;
        }

        if (e.KeyCode == Keys.F5 && !_busy && !_loopRunning)
        {
            e.Handled = true;
            await RefreshStateAsync();
            return;
        }

        if (e.Control && e.KeyCode == Keys.B && !_busy && !_loopRunning)
        {
            e.SuppressKeyPress = true;
            await OpenBrowserAsync();
            return;
        }

        if (e.Control && e.KeyCode == Keys.Enter && !_busy)
        {
            e.SuppressKeyPress = true;
            if (_loopRunning)
            {
                StopLoop();
            }
            else
            {
                await StartLoopAsync();
            }
            return;
        }

        base.OnKeyDown(e);
    }

    private void InitializeComponent()
    {
        Rectangle workArea = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1600, 900);
        AutoScaleMode = AutoScaleMode.Dpi;
        Text = $"抖音工作台 v{GetApplicationVersion()}";
        Width = Math.Min(1600, Math.Max(960, workArea.Width - 24));
        Height = Math.Min(920, Math.Max(660, workArea.Height - 24));
        MinimumSize = new Size(920, 640);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
        BackColor = WorkspaceTheme.Canvas;
        ForeColor = WorkspaceTheme.Text;
        KeyPreview = true;

        TableLayoutPanel root = new()
        {
            Dock = DockStyle.Fill,
            RowCount = 2,
            ColumnCount = 1,
        };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 72));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        Controls.Add(root);

        root.Controls.Add(BuildHeader(), 0, 0);
        root.Controls.Add(BuildBody(), 0, 1);
    }

    private Control BuildHeader()
    {
        TableLayoutPanel header = new()
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(18, 8, 18, 8),
            BackColor = WorkspaceTheme.Surface,
            ColumnCount = 4,
            RowCount = 1,
        };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 170));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 250));
        header.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        TableLayoutPanel identity = new()
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 2,
            Margin = Padding.Empty,
        };
        identity.RowStyles.Add(new RowStyle(SizeType.Percent, 55));
        identity.RowStyles.Add(new RowStyle(SizeType.Percent, 45));
        Label title = new()
        {
            Dock = DockStyle.Fill,
            Text = "抖音工作台",
            Font = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold, GraphicsUnit.Point),
            ForeColor = WorkspaceTheme.Text,
            TextAlign = ContentAlignment.BottomLeft,
        };
        Label subtitle = CreateMutedLabel("收集信息 · 整理素材 · AI 辅助创作");
        subtitle.Dock = DockStyle.Fill;
        subtitle.TextAlign = ContentAlignment.TopLeft;
        identity.Controls.Add(title, 0, 0);
        identity.Controls.Add(subtitle, 0, 1);

        ConfigureHeaderStatus(_connectionBadge, "浏览器：未检测", WorkspaceTheme.Warning);

        TableLayoutPanel taskState = new()
        {
            Dock = DockStyle.Fill,
            RowCount = 2,
            ColumnCount = 1,
            Margin = Padding.Empty,
        };
        taskState.RowStyles.Add(new RowStyle(SizeType.Percent, 55));
        taskState.RowStyles.Add(new RowStyle(SizeType.Percent, 45));
        ConfigureHeaderStatus(_statusBadge, "任务：空闲", WorkspaceTheme.Success);
        _lastCheckedLabel.Dock = DockStyle.Fill;
        _lastCheckedLabel.Text = "最后检测：-";
        _lastCheckedLabel.ForeColor = WorkspaceTheme.Muted;
        _lastCheckedLabel.TextAlign = ContentAlignment.TopRight;
        _lastCheckedLabel.AutoEllipsis = true;
        taskState.Controls.Add(_statusBadge, 0, 0);
        taskState.Controls.Add(_lastCheckedLabel, 0, 1);

        FlowLayoutPanel actions = new()
        {
            Dock = DockStyle.Fill,
            AutoSize = false,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Padding = new Padding(12, 0, 0, 0),
        };
        _openBrowserButton = CreateButton("连接浏览器", primary: true);
        _openBrowserButton.Width = 118;
        _openBrowserButton.Margin = new Padding(0, 0, 8, 0);
        _openBrowserButton.Click += async (_, _) => await OpenBrowserAsync();
        _refreshStateButton = CreateButton("刷新状态");
        _refreshStateButton.Width = 100;
        _refreshStateButton.Margin = Padding.Empty;
        _refreshStateButton.Click += async (_, _) => await RefreshStateAsync();
        actions.Controls.Add(_openBrowserButton);
        actions.Controls.Add(_refreshStateButton);
        _actionButtons.Add(_openBrowserButton);
        _actionButtons.Add(_refreshStateButton);
        _toolTip.SetToolTip(_openBrowserButton, "打开或连接 Chrome（Ctrl+B）");
        _toolTip.SetToolTip(_refreshStateButton, "刷新浏览器与页面状态（F5）");

        header.Controls.Add(identity, 0, 0);
        header.Controls.Add(_connectionBadge, 1, 0);
        header.Controls.Add(taskState, 2, 0);
        header.Controls.Add(actions, 3, 0);

        return header;
    }

    private Control BuildBody()
    {
        return BuildWorkspace();
    }

    private Control BuildLogPanel()
    {
        Panel panel = CreatePanel();
        panel.Margin = Padding.Empty;
        panel.Padding = new Padding(14);

        TableLayoutPanel layout = new()
        {
            Dock = DockStyle.Fill,
            RowCount = 2,
            ColumnCount = 1,
        };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        panel.Controls.Add(layout);

        TableLayoutPanel header = new()
        {
            Dock = DockStyle.Fill,
            ColumnCount = 4,
            RowCount = 1,
        };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 82));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 104));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 104));
        Label title = CreateSectionTitle("运行日志");
        title.Dock = DockStyle.Fill;
        LinkLabel path = new()
        {
            Dock = DockStyle.Fill,
            Text = AppLog.FilePath,
            LinkColor = WorkspaceTheme.Accent,
            ActiveLinkColor = WorkspaceTheme.Accent,
            VisitedLinkColor = WorkspaceTheme.Accent,
            TextAlign = ContentAlignment.MiddleLeft,
            AutoEllipsis = true,
        };
        path.LinkClicked += (_, _) => OpenLogLocation();
        ContextMenuStrip pathMenu = new();
        pathMenu.Items.Add("复制日志路径", null, (_, _) => CopyLogPath());
        path.ContextMenuStrip = pathMenu;

        Button copyPath = CreateButton("复制路径");
        copyPath.Dock = DockStyle.Fill;
        copyPath.Margin = new Padding(4, 6, 4, 6);
        copyPath.Click += (_, _) => CopyLogPath();
        Button clearView = CreateButton("清空界面");
        clearView.Dock = DockStyle.Fill;
        clearView.Margin = new Padding(4, 6, 0, 6);
        clearView.Click += (_, _) => _logBox.Clear();
        header.Controls.Add(title, 0, 0);
        header.Controls.Add(path, 1, 0);
        header.Controls.Add(copyPath, 2, 0);
        header.Controls.Add(clearView, 3, 0);
        layout.Controls.Add(header, 0, 0);

        ConfigureRichField(_logBox);
        _logBox.ReadOnly = true;
        _logBox.DetectUrls = true;
        _logBox.WordWrap = false;
        _logBox.Font = new Font("Consolas", 9F, FontStyle.Regular, GraphicsUnit.Point);
        layout.Controls.Add(_logBox, 0, 1);
        AppendLogText("日志", $"日志文件：{AppLog.FilePath}");
        return panel;
    }

    private static TabPage CreateTabPage(string title)
    {
        return new TabPage(title)
        {
            BackColor = WorkspaceTheme.Canvas,
            ForeColor = WorkspaceTheme.Text,
            Padding = new Padding(14),
        };
    }

    private static void ConfigureHeaderStatus(Label label, string text, Color color)
    {
        label.AutoSize = false;
        label.Text = text;
        label.ForeColor = color;
        label.Dock = DockStyle.Fill;
        label.TextAlign = ContentAlignment.MiddleRight;
        label.AutoEllipsis = true;
    }

    private void OpenLogLocation()
    {
        try
        {
            Directory.CreateDirectory(AppLog.DirectoryPath);
            string arguments = File.Exists(AppLog.FilePath)
                ? $"/select,\"{AppLog.FilePath}\""
                : $"\"{AppLog.DirectoryPath}\"";
            Process.Start(new ProcessStartInfo("explorer.exe", arguments) { UseShellExecute = true });
        }
        catch (Exception error)
        {
            ShowError("打开日志位置", error.Message);
        }
    }

    private void CopyLogPath()
    {
        Clipboard.SetText(AppLog.FilePath);
        SetStatus("已复制日志路径");
    }

    private static string GetApplicationVersion()
    {
        Assembly assembly = typeof(MainForm).Assembly;
        string? informational = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        return FirstNonEmpty(informational?.Split('+')[0] ?? string.Empty, assembly.GetName().Version?.ToString(3) ?? "1.0.0");
    }

    private void ConfigureCommentRenderTimer()
    {
        _commentRenderTimer.Tick += (_, _) =>
        {
            _commentRenderTimer.Stop();
            if (!_closing)
            {
                RenderCommentGrid();
            }
        };
    }

    private void LoadSettings()
    {
        try
        {
            DesktopSettings settings = _settingsStore.Load();
            _termsInput.Text = settings.Terms;
            SetNumericValue(_openVideoIndexInput, settings.OpenVideoIndex);
            SetNumericValue(_minWatchMsInput, settings.MinWatchSec);
            SetNumericValue(_maxWatchMsInput, settings.MaxWatchSec);
            SetNumericValue(_minBrowseMsInput, settings.MinBrowseSec);
            SetNumericValue(_maxBrowseMsInput, settings.MaxBrowseSec);
            SetNumericValue(_minStepDelaySecInput, settings.MinStepDelaySec);
            SetNumericValue(_maxStepDelaySecInput, settings.MaxStepDelaySec);
            SetNumericValue(_loadTimeoutSecInput, settings.LoadTimeoutSec);
            SetNumericValue(_cyclesInput, settings.Cycles);
            SetNumericValue(_searchesInput, settings.Searches);
            _collectCommentsEnabledInput.Checked = settings.CollectCommentsEnabled;
            SetNumericValue(_commentLimitInput, settings.CommentLimit);
            SetNumericValue(_commentTimeoutSecInput, settings.CommentTimeoutSec);
            SetNumericValue(_commentNoNewScrollsInput, settings.CommentNoNewScrolls);
            _ipFilterEnabledInput.Checked = settings.IpFilterEnabled;
            _ipFilterInput.Text = settings.IpFilter;
            _textFilterEnabledInput.Checked = settings.TextFilterEnabled;
            _textFilterInput.Text = settings.TextFilter;
            // External-send permissions are intentionally per launch. Restore
            // the text pools, but require the user to opt in again each time.
            _sendCommentsEnabledInput.Checked = false;
            _commentPoolInput.Text = settings.CommentPool;
            _sendPrivateMessagesEnabledInput.Checked = false;
            _privateMessagePoolInput.Text = settings.PrivateMessagePool;
            SetNumericValue(_privateMessageMaxSendInput, settings.PrivateMessageMaxSend);
            _aiTopicInput.Text = settings.AiTopic;
            _aiTemplateInput.Text = settings.AiTemplate;
            SetNumericValue(_aiGenerateCountInput, settings.AiGenerateCount);
            _aiSystemPromptInput.Text = settings.AiSystemPrompt;
            _aiProvider = FirstNonEmpty(settings.AiProvider, "DeepSeek");
            _aiBaseUrl = FirstNonEmpty(settings.AiBaseUrl, "https://api.deepseek.com");
            _aiModel = FirstNonEmpty(settings.AiModel, "deepseek-chat");
            _aiApiKey = settings.AiApiKey;
            _aiRewriteEnabled = settings.AiRewriteEnabled;
            _aiRewriteTarget = settings.AiRewriteTarget == "private" ? "private" : "comment";
            _aiTemperature = Math.Clamp(settings.AiTemperature, 0M, 2M);
            _compactRowsInput.Checked = settings.CompactRows;
            _rememberWindowInput.Checked = settings.RememberWindow;
            if (settings.RememberWindow && settings.WindowWidth > 0 && settings.WindowHeight > 0)
            {
                Rectangle area = Screen.FromControl(this).WorkingArea;
                Size = new Size(Math.Clamp(settings.WindowWidth, MinimumSize.Width, Math.Max(MinimumSize.Width, area.Width)),
                    Math.Clamp(settings.WindowHeight, MinimumSize.Height, Math.Max(MinimumSize.Height, area.Height)));
            }
            ApplyRowDensity();
            ResetCommentPoolProgress();
            ReconcilePrivateMessageProgress();
            RenderCommentGrid();
            AppendLogText("设置", $"已从 {_settingsStore.SettingsPath} 恢复");
        }
        catch (Exception error)
        {
            AppLog.Exception("加载设置失败，使用默认值", error);
            AppendLogText("设置", $"加载失败，已使用默认值：{error.Message}");
        }
    }

    private void SaveSettings()
    {
        ValidateWorkspaceSettings();
        DesktopSettings settings = new()
        {
            CompactRows = _compactRowsInput.Checked,
            RememberWindow = _rememberWindowInput.Checked,
            WindowWidth = WindowState == FormWindowState.Normal ? Width : RestoreBounds.Width,
            WindowHeight = WindowState == FormWindowState.Normal ? Height : RestoreBounds.Height,
            Terms = _termsInput.Text,
            OpenVideoIndex = _openVideoIndexInput.Value,
            MinWatchSec = _minWatchMsInput.Value,
            MaxWatchSec = _maxWatchMsInput.Value,
            MinBrowseSec = _minBrowseMsInput.Value,
            MaxBrowseSec = _maxBrowseMsInput.Value,
            MinStepDelaySec = _minStepDelaySecInput.Value,
            MaxStepDelaySec = _maxStepDelaySecInput.Value,
            LoadTimeoutSec = _loadTimeoutSecInput.Value,
            Cycles = _cyclesInput.Value,
            Searches = _searchesInput.Value,
            CollectCommentsEnabled = _collectCommentsEnabledInput.Checked,
            CommentLimit = _commentLimitInput.Value,
            CommentTimeoutSec = _commentTimeoutSecInput.Value,
            CommentNoNewScrolls = _commentNoNewScrollsInput.Value,
            IpFilterEnabled = _ipFilterEnabledInput.Checked,
            IpFilter = _ipFilterInput.Text,
            TextFilterEnabled = _textFilterEnabledInput.Checked,
            TextFilter = _textFilterInput.Text,
            SendCommentsEnabled = false,
            CommentPool = _commentPoolInput.Text,
            SendPrivateMessagesEnabled = false,
            PrivateMessagePool = _privateMessagePoolInput.Text,
            PrivateMessageMaxSend = _privateMessageMaxSendInput.Value,
            AiTopic = _aiTopicInput.Text,
            AiTemplate = _aiTemplateInput.Text,
            AiGenerateCount = _aiGenerateCountInput.Value,
            AiSystemPrompt = _aiSystemPromptInput.Text,
            AiProvider = _aiProvider,
            AiBaseUrl = _aiBaseUrl,
            AiModel = _aiModel,
            AiApiKey = _aiApiKey,
            AiRewriteEnabled = _aiRewriteEnabled,
            AiRewriteTarget = _aiRewriteTarget,
            AiTemperature = _aiTemperature,
        };
        _settingsStore.Save(settings);
    }

    private void SaveSettingsToLogOnly()
    {
        try
        {
            SaveSettings();
        }
        catch (Exception error)
        {
            AppLog.Exception("保存设置失败", error);
            AppendLogText("设置", $"保存失败：{error.Message}");
        }
    }

    private static void SetNumericValue(NumericUpDown control, decimal value)
    {
        control.Value = Math.Clamp(value, control.Minimum, control.Maximum);
    }

    private Control BuildPrivateMessagePanel()
    {
        Panel panel = CreatePanel();
        panel.Margin = new Padding(0, 0, 0, 12);
        panel.Padding = new Padding(14);

        TableLayoutPanel layout = new()
        {
            Dock = DockStyle.Fill,
            RowCount = 4,
            ColumnCount = 1,
        };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 72));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 22));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        panel.Controls.Add(layout);

        FlowLayoutPanel header = new()
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = true,
        };
        Label title = CreateSectionTitle("私信池");
        title.Width = 72;
        _sendPrivateMessagesEnabledInput.Text = "启用私信";
        _sendPrivateMessagesEnabledInput.AutoSize = true;
        _sendPrivateMessagesEnabledInput.ForeColor = WorkspaceTheme.Text;
        _sendPrivateMessagesEnabledInput.BackColor = Color.Transparent;
        _sendPrivateMessagesEnabledInput.Margin = new Padding(4, 8, 10, 0);
        _sendPrivateMessagesEnabledInput.CheckedChanged += (_, _) => UpdateCommentControls();
        Label limitLabel = CreateMutedLabel("单条上限");
        limitLabel.Width = 82;
        limitLabel.Margin = new Padding(0, 10, 4, 0);
        ConfigureNumber(_privateMessageMaxSendInput, 1, 100, 3);
        _privateMessageMaxSendInput.Width = 58;
        _privateMessageMaxSendInput.Dock = DockStyle.None;
        _privateMessageMaxSendInput.Margin = new Padding(0, 5, 0, 0);
        _privateMessageMaxSendInput.ValueChanged += (_, _) => SetPrivateMessageState();
        Button resetCounts = CreateButton("重置计数");
        resetCounts.Width = 82;
        resetCounts.Height = 30;
        resetCounts.Margin = new Padding(8, 5, 0, 0);
        resetCounts.Click += (_, _) =>
        {
            if (_privateMessageSendCounts.Count == 0 ||
                ConfirmOperation("重置私信计数", "将清除所有私信文案的已发送次数，但不会修改私信池内容。是否继续？"))
            {
                _privateMessageSendCounts.Clear();
                SetPrivateMessageState("发送计数已重置");
            }
        };
        header.Controls.Add(title);
        header.Controls.Add(_sendPrivateMessagesEnabledInput);
        header.Controls.Add(limitLabel);
        header.Controls.Add(_privateMessageMaxSendInput);
        header.Controls.Add(resetCounts);
        layout.Controls.Add(header, 0, 0);

        Label poolLabel = CreateMutedLabel("私信池：使用中文或英文分号分隔");
        poolLabel.Dock = DockStyle.Fill;
        layout.Controls.Add(poolLabel, 0, 1);

        _privateMessagePoolInput.Dock = DockStyle.Fill;
        _privateMessagePoolInput.Text = "你好，看到你的内容很有意思，方便交流一下吗？；你好，想了解一下你的内容方向，可以聊聊吗？";
        ConfigureRichField(_privateMessagePoolInput);
        _privateMessagePoolInput.TextChanged += (_, _) => ReconcilePrivateMessageProgress();
        layout.Controls.Add(_privateMessagePoolInput, 0, 2);

        _privateMessageState.Dock = DockStyle.Fill;
        _privateMessageState.ForeColor = WorkspaceTheme.Muted;
        _privateMessageState.TextAlign = ContentAlignment.MiddleLeft;
        layout.Controls.Add(_privateMessageState, 0, 3);
        SetPrivateMessageState();
        return panel;
    }

    private Control BuildStatusPanel()
    {
        TableLayoutPanel panel = new()
        {
            Dock = DockStyle.Fill,
            RowCount = 3,
        };
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 126));
        panel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 88));

        Panel current = CreatePanel();
        current.Padding = new Padding(14);
        TableLayoutPanel summary = new()
        {
            Dock = DockStyle.Fill,
            RowCount = 4,
            ColumnCount = 2,
        };
        summary.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 82));
        summary.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        current.Controls.Add(summary);
        AddSummaryRow(summary, 0, "当前位置", _currentStep);
        AddSummaryRow(summary, 1, "页面", _pageTitle);
        AddSummaryRow(summary, 2, "地址", _pageUrl);
        AddSummaryRow(summary, 3, "下一步", _nextAction);
        panel.Controls.Add(current, 0, 0);

        Panel workflowPanel = CreatePanel();
        workflowPanel.Padding = new Padding(14);
        Label workflowTitle = CreateSectionTitle("链路步骤");
        workflowTitle.Dock = DockStyle.Top;
        _workflowList.Dock = DockStyle.Fill;
        _workflowList.BackColor = WorkspaceTheme.Surface;
        _workflowList.ForeColor = WorkspaceTheme.Text;
        _workflowList.BorderStyle = BorderStyle.FixedSingle;
        workflowPanel.Controls.Add(_workflowList);
        workflowPanel.Controls.Add(workflowTitle);
        panel.Controls.Add(workflowPanel, 0, 1);

        TableLayoutPanel metrics = new()
        {
            Dock = DockStyle.Fill,
            ColumnCount = 3,
            Padding = new Padding(0, 12, 0, 0),
        };
        metrics.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33));
        metrics.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 34));
        metrics.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33));
        metrics.Controls.Add(BuildMetric("搜索框", _searchBoxState), 0, 0);
        metrics.Controls.Add(BuildMetric("视频候选", _videoState), 1, 0);
        metrics.Controls.Add(BuildMetric("评论区", _commentState), 2, 0);
        panel.Controls.Add(metrics, 0, 2);

        return panel;
    }

    private Control BuildCommentsPanel()
    {
        Panel panel = CreatePanel();
        panel.Margin = Padding.Empty;
        panel.Padding = new Padding(14);

        TableLayoutPanel layout = new()
        {
            Dock = DockStyle.Fill,
            RowCount = 4,
            ColumnCount = 1,
        };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 76));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
        panel.Controls.Add(layout);

        TableLayoutPanel header = new()
        {
            Dock = DockStyle.Fill,
            ColumnCount = 4,
            RowCount = 1,
        };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 104));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 124));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 114));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        header.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        Label title = CreateSectionTitle("评论采集");
        title.Dock = DockStyle.Fill;
        _collectCommentsEnabledInput.Text = "启用采集";
        _collectCommentsEnabledInput.Checked = false;
        _collectCommentsEnabledInput.AutoSize = true;
        _collectCommentsEnabledInput.ForeColor = WorkspaceTheme.Text;
        _collectCommentsEnabledInput.BackColor = Color.Transparent;
        _collectCommentsEnabledInput.Dock = DockStyle.Fill;
        _collectCommentsEnabledInput.Margin = new Padding(4, 0, 4, 0);
        _collectCommentsEnabledInput.CheckedChanged += (_, _) => UpdateCommentControls();

        _collectCommentsButton = CreateButton("开始采集", primary: true);
        _collectCommentsButton.Dock = DockStyle.Fill;
        _collectCommentsButton.Margin = new Padding(4, 2, 6, 2);
        _collectCommentsButton.Click += async (_, _) =>
        {
            if (_commentCollectRunning)
            {
                StopCommentCollection();
                return;
            }

            await CollectCommentsAsync();
        };
        _toolTip.SetToolTip(_collectCommentsButton, "开始或停止评论采集（Esc 可停止）");

        _commentCollectState.AutoSize = false;
        _commentCollectState.Dock = DockStyle.Fill;
        _commentCollectState.ForeColor = WorkspaceTheme.Muted;
        _commentCollectState.Margin = new Padding(4, 0, 0, 0);
        _commentCollectState.Text = "0 / 命中0 / 选0";
        _commentCollectState.TextAlign = ContentAlignment.MiddleLeft;
        _commentCollectState.AutoEllipsis = true;

        header.Controls.Add(title, 0, 0);
        header.Controls.Add(_collectCommentsEnabledInput, 1, 0);
        header.Controls.Add(_collectCommentsButton, 2, 0);
        header.Controls.Add(_commentCollectState, 3, 0);
        layout.Controls.Add(header, 0, 0);

        TableLayoutPanel filters = new()
        {
            Dock = DockStyle.Fill,
            RowCount = 2,
            ColumnCount = 2,
        };
        filters.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 138));
        filters.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        filters.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        filters.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        ConfigureFilter(_ipFilterEnabledInput, "按 IP 属地筛选", _ipFilterInput);
        ConfigureFilter(_textFilterEnabledInput, "按评论文本筛选", _textFilterInput);
        filters.Controls.Add(_ipFilterEnabledInput, 0, 0);
        filters.Controls.Add(_ipFilterInput, 1, 0);
        filters.Controls.Add(_textFilterEnabledInput, 0, 1);
        filters.Controls.Add(_textFilterInput, 1, 1);
        layout.Controls.Add(filters, 0, 1);

        ConfigureCommentGrid();
        layout.Controls.Add(_commentGrid, 0, 2);

        FlowLayoutPanel footer = new()
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
        };
        _openSelectedUserLinksButton = CreateButton("处理选中用户");
        _openSelectedUserLinksButton.Width = 112;
        _openSelectedUserLinksButton.Margin = new Padding(4);
        _openSelectedUserLinksButton.Click += async (_, _) =>
        {
            if (_userLinkQueueRunning)
            {
                StopUserLinkQueue();
                return;
            }

            await OpenCheckedUserLinksAsync();
        };
        _toolTip.SetToolTip(_openSelectedUserLinksButton, "按表格顺序处理已勾选用户（Esc 可停止）");
        Button clearResults = CreateButton("清空结果");
        clearResults.Width = 86;
        clearResults.Margin = new Padding(4);
        clearResults.Click += (_, _) => ClearCommentResults();
        Button exportCsv = CreateButton("导出 CSV");
        exportCsv.Width = 90;
        exportCsv.Margin = new Padding(4);
        exportCsv.Click += (_, _) => ExportComments("csv");
        Button exportJson = CreateButton("导出 JSON");
        exportJson.Width = 90;
        exportJson.Margin = new Padding(4);
        exportJson.Click += (_, _) => ExportComments("json");
        footer.Controls.Add(_openSelectedUserLinksButton);
        footer.Controls.Add(exportCsv);
        footer.Controls.Add(exportJson);
        footer.Controls.Add(clearResults);
        layout.Controls.Add(footer, 0, 3);

        UpdateCommentControls();
        RenderCommentGrid();
        return panel;
    }

    private Control BuildCommentSendPanel()
    {
        Panel panel = CreatePanel();
        panel.Padding = new Padding(14);

        TableLayoutPanel layout = new()
        {
            Dock = DockStyle.Fill,
            RowCount = 7,
            ColumnCount = 1,
        };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 116));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 86));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 56));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
        panel.Controls.Add(layout);

        FlowLayoutPanel header = new()
        {
            Dock = DockStyle.Fill,
            WrapContents = false,
            AutoScroll = false,
        };
        Label title = CreateSectionTitle("评论发送");
        title.Width = 98;
        _sendCommentsEnabledInput.Text = "启用发送";
        _sendCommentsEnabledInput.Checked = false;
        _sendCommentsEnabledInput.AutoSize = true;
        _sendCommentsEnabledInput.ForeColor = WorkspaceTheme.Text;
        _sendCommentsEnabledInput.BackColor = Color.Transparent;
        _sendCommentsEnabledInput.Margin = new Padding(8, 8, 0, 0);
        _sendCommentsEnabledInput.CheckedChanged += (_, _) => UpdateSendControls();
        header.Controls.Add(title);
        header.Controls.Add(_sendCommentsEnabledInput);
        layout.Controls.Add(header, 0, 0);

        Panel poolPanel = new()
        {
            Dock = DockStyle.Fill,
            Margin = new Padding(0, 4, 0, 4),
        };
        Label poolLabel = CreateMutedLabel("评论池：使用中文或英文分号分隔");
        poolLabel.Dock = DockStyle.Top;
        poolLabel.Height = 22;
        _commentPoolInput.Dock = DockStyle.Fill;
        _commentPoolInput.Text = "这个角度挺有意思；确实有点共鸣；这条说得挺真实";
        ConfigureRichField(_commentPoolInput);
        _commentPoolInput.TextChanged += (_, _) => ResetCommentPoolProgress();
        poolPanel.Controls.Add(_commentPoolInput);
        poolPanel.Controls.Add(poolLabel);
        layout.Controls.Add(poolPanel, 0, 1);

        TableLayoutPanel sendButtons = new()
        {
            Dock = DockStyle.Fill,
            ColumnCount = 3,
        };
        sendButtons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 38));
        sendButtons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 32));
        sendButtons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 30));
        _sendNextCommentButton = CreateButton("发送一条");
        _sendNextCommentButton.Dock = DockStyle.Fill;
        _sendNextCommentButton.Margin = new Padding(0, 4, 6, 4);
        _sendNextCommentButton.Click += async (_, _) => await RunCancellableUiOperationAsync(
            token => SendNextCommentAsync(automatic: false, token));
        _aiSettingsButton = CreateButton("AI 设置");
        _aiSettingsButton.Dock = DockStyle.Fill;
        _aiSettingsButton.Margin = new Padding(0, 4, 6, 4);
        _aiSettingsButton.Click += (_, _) => OpenAiSettingsDialog();
        _toolTip.SetToolTip(_aiSettingsButton, "AI 服务、系统提示词和自动重构设置");
        Button clearSent = CreateButton("清空已发");
        clearSent.Dock = DockStyle.Fill;
        clearSent.Margin = new Padding(0, 4, 0, 4);
        clearSent.Click += (_, _) =>
        {
            if ((_sentCommentVideoIds.Count == 0 && _sentCommentCount == 0) ||
                ConfirmOperation("清空已发记录", "将清除已发送次数和已记录视频，用于允许这些视频再次发送；评论池游标不会改变。是否继续？", warning: true))
            {
                _sentCommentVideoIds.Clear();
                _sentCommentCount = 0;
                SetCommentSendState("已发记录已清空，评论池进度未改变");
            }
        };
        sendButtons.Controls.Add(_sendNextCommentButton, 0, 0);
        sendButtons.Controls.Add(_aiSettingsButton, 1, 0);
        sendButtons.Controls.Add(clearSent, 2, 0);
        layout.Controls.Add(sendButtons, 0, 2);

        TableLayoutPanel aiInputs = new()
        {
            Dock = DockStyle.Fill,
            RowCount = 2,
            ColumnCount = 2,
        };
        aiInputs.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 96));
        aiInputs.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        aiInputs.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        aiInputs.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        ConfigureField(_aiTopicInput);
        ConfigureField(_aiTemplateInput);
        _aiTopicInput.PlaceholderText = "例如：数码产品使用体验";
        _aiTemplateInput.PlaceholderText = "可选，填写语气或参考文案";
        aiInputs.Controls.Add(CreateMutedLabel("主题/内容"), 0, 0);
        aiInputs.Controls.Add(_aiTopicInput, 1, 0);
        aiInputs.Controls.Add(CreateMutedLabel("模板/样品"), 0, 1);
        aiInputs.Controls.Add(_aiTemplateInput, 1, 1);
        layout.Controls.Add(aiInputs, 0, 3);

        TableLayoutPanel aiButtons = new()
        {
            Dock = DockStyle.Fill,
            ColumnCount = 3,
        };
        aiButtons.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 88));
        aiButtons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        aiButtons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        ConfigureNumber(_aiGenerateCountInput, 1, 20, 5);
        _toolTip.SetToolTip(_aiGenerateCountInput, "本次生成数量：1–20 条");
        _aiGenerateCountInput.Margin = new Padding(0, 8, 8, 8);
        _generateAiButton = CreateButton("生成候选", primary: true);
        _generateAiButton.Dock = DockStyle.Fill;
        _generateAiButton.Margin = new Padding(0, 8, 8, 8);
        _generateAiButton.Click += async (_, _) => await RunCancellableUiOperationAsync(
            token => GenerateAiCandidatesAsync(showErrors: true, token));
        _appendAiCandidatesButton = CreateButton("加入评论池");
        _appendAiCandidatesButton.Dock = DockStyle.Fill;
        _appendAiCandidatesButton.Margin = new Padding(0, 8, 0, 8);
        _appendAiCandidatesButton.Click += (_, _) => AppendCheckedAiCandidates();
        aiButtons.Controls.Add(_aiGenerateCountInput, 0, 0);
        aiButtons.Controls.Add(_generateAiButton, 1, 0);
        aiButtons.Controls.Add(_appendAiCandidatesButton, 2, 0);
        layout.Controls.Add(aiButtons, 0, 4);

        _aiCandidateList.Dock = DockStyle.Fill;
        _aiCandidateList.CheckOnClick = true;
        _aiCandidateList.BackColor = WorkspaceTheme.Field;
        _aiCandidateList.ForeColor = WorkspaceTheme.Text;
        _aiCandidateList.BorderStyle = BorderStyle.FixedSingle;
        _aiCandidateList.HorizontalScrollbar = true;
        layout.Controls.Add(_aiCandidateList, 0, 5);

        _aiSystemPromptInput.Text = "你是短视频评论和私信文案助手。生成自然、简短、不营销、不夸张的中文内容。";

        _commentSendState.Dock = DockStyle.Fill;
        _commentSendState.ForeColor = WorkspaceTheme.Muted;
        _commentSendState.TextAlign = ContentAlignment.MiddleLeft;
        _commentSendState.AutoEllipsis = true;
        layout.Controls.Add(_commentSendState, 0, 6);

        SetCommentSendState();
        UpdateSendControls();
        Control[] ordered = new[] { 3, 4, 5, 0, 1, 2, 6 }
            .Select(row => layout.GetControlFromPosition(0, row)!).ToArray();
        layout.SuspendLayout();
        layout.Controls.Clear();
        layout.RowStyles.Clear();
        foreach (int height in new[] { 86, 56, -1, 42, 116, 46, 50 })
            layout.RowStyles.Add(new RowStyle(height < 0 ? SizeType.Percent : SizeType.Absolute, height < 0 ? 100 : height));
        for (int row = 0; row < ordered.Length; row++) layout.Controls.Add(ordered[row], 0, row);
        layout.ResumeLayout();
        return panel;
    }

    private async Task OpenBrowserAsync()
    {
        await RunActionAsync("连接浏览器", token => RunCliAsync(token, "browser", "open", "--once"));
    }

    private async Task FindSearchAsync()
    {
        await RunActionAsync("识别搜索框", token => RunCliAsync(token, "douyin", "find-search"));
    }

    private async Task InputSearchAsync()
    {
        if (ParseTerms(_termsInput.Text).Count == 0)
        {
            ShowError("搜索", "候选搜索词为空，请至少填写一个搜索词。");
            return;
        }

        await RunActionAsync("搜索", token => RunCliAsync(token,
            "douyin",
            "input-search",
            "--terms",
            _termsInput.Text,
            "--min-step-delay-sec",
            FormatNumber(_minStepDelaySecInput.Value),
            "--max-step-delay-sec",
            FormatNumber(_maxStepDelaySecInput.Value),
            "--search-ready-timeout-sec",
            FormatNumber(_loadTimeoutSecInput.Value)));
    }

    private async Task OpenVideoAsync()
    {
        await RunActionAsync("选视频", token => RunCliAsync(token,
            "douyin",
            "open-video",
            "--index",
            FormatNumber(_openVideoIndexInput.Value)));
    }

    private async Task OpenCommentsAsync()
    {
        await RunActionAsync("打开评论", token => RunCliAsync(token, "douyin", "open-comments"));
    }

    private async Task WatchCycleAsync()
    {
        await RunActionAsync("刷评论/切视频", token => RunCliAsync(token, BuildWatchCycleArgs()));
    }

    private async Task CollectCommentsAsync()
    {
        if (!_collectCommentsEnabledInput.Checked)
        {
            ShowError("评论采集", "未启用评论区采集。");
            return;
        }

        await StartCommentCollectionAsync(followVideos: _loopRunning);
    }

    private async Task StartCommentCollectionAsync(bool followVideos)
    {
        if (_commentCollectRunning)
        {
            SetStatus("采集任务已在运行");
            return;
        }

        _commentCollectCancellation = new CancellationTokenSource();
        CancellationToken token = _commentCollectCancellation.Token;
        _commentCollectRunning = true;
        UpdateCommentControls();
        _commentCollectState.Text = followVideos
            ? "采集中：跟随循环视频"
            : "采集中";
        SetStatus(followVideos ? "跟随采集中" : "评论采集中");

        try
        {
            CommandResult result = await RunCliStreamingAsync(
                BuildCollectCommentsArgs(followVideos),
                line => HandleCommentStreamLine(line),
                line => AppendUiLog("评论采集错误", line),
                token);

            if (result.ExitCode != 0)
            {
                string details = $"采集进程退出，ExitCode: {result.ExitCode}\n{FirstNonEmpty(result.Stderr, "没有错误详情")}";
                AppendLogText("评论采集", details);
                if (!followVideos)
                {
                    ShowError("评论采集", details);
                }
                SetStatus("评论采集异常", danger: true);
            }
        }
        catch (OperationCanceledException)
        {
            SetStatus("采集已停止");
        }
        finally
        {
            _commentRenderTimer.Stop();
            _commentCollectRunning = false;
            _commentCollectCancellation?.Dispose();
            _commentCollectCancellation = null;
            UpdateCommentControls();
            RenderCommentGrid();
        }
    }

    private void StopCommentCollection()
    {
        if (!_commentCollectRunning)
        {
            return;
        }

        _commentCollectState.Text = "正在停止采集";
        _commentCollectCancellation?.Cancel();
    }

    private async Task SearchCycleAsync()
    {
        await RunActionAsync("换词循环", token => RunCliAsync(token, BuildSearchCycleArgs()));
    }

    private async Task FullCycleAsync()
    {
        await RunActionAsync("完整循环", token => RunCliAsync(token, BuildFullCycleArgs()));
    }

    private async Task StartLoopAsync()
    {
        if (_loopRunning)
        {
            return;
        }

        List<string> terms = ParseTerms(_termsInput.Text);
        if (terms.Count == 0)
        {
            ShowError("循环未启动", "候选搜索词为空。");
            SetStatus("缺少搜索词", danger: true);
            return;
        }

        string confirmation =
            $"即将启动无限循环，直到你点击停止或按 Esc。\n\n" +
            $"搜索词：{terms.Count} 个（{string.Join("、", terms.Take(5))}{(terms.Count > 5 ? "…" : string.Empty)}）\n" +
            $"每轮搜索：1 次；视频停留：{_minWatchMsInput.Value}-{_maxWatchMsInput.Value} 秒\n" +
            $"评论采集：{(_collectCommentsEnabledInput.Checked ? "开启" : "关闭")}\n" +
            $"自动评论：{(_sendCommentsEnabledInput.Checked ? "开启" : "关闭")}\n\n" +
            "运行期间关键参数会被锁定。是否继续？";
        if (!ConfirmOperation("确认启动无限循环", confirmation))
        {
            SetStatus("已取消启动");
            return;
        }

        _remainingLoopTerms = [];
        _loopCancellation = new CancellationTokenSource();
        CancellationToken token = _loopCancellation.Token;
        _loopRunning = true;
        SetLoopUi(true);
        SetStatus("开始循环");

        try
        {
            CommandResult openResult = await RunCliAsync(token, "browser", "open", "--once");
            AppendLog("循环准备", openResult);
            if (openResult.ExitCode != 0)
            {
                ShowError("浏览器启动失败", FirstNonEmpty(openResult.Stderr, openResult.Stdout, "没有错误详情"));
                SetStatus("浏览器启动失败", danger: true);
                return;
            }

            if (_collectCommentsEnabledInput.Checked && !_commentCollectRunning)
            {
                _commentCollectionFollowsLoop = true;
                _commentCollectionTask = StartCommentCollectionAsync(followVideos: true);
            }

            int round = 1;
            while (!token.IsCancellationRequested)
            {
                string term = TakeNextLoopTerm();
                if (string.IsNullOrWhiteSpace(term))
                {
                    AppendLogText("循环", "搜索词池为空，循环已安全停止。");
                    SetStatus("搜索词池为空", danger: true);
                    break;
                }
                SetStatus($"循环中：{term}");

                CommandResult result = await RunCliAsync(token, BuildFullCycleArgs(term));
                AppendLog($"循环第 {round} 轮", result);

                if (result.ExitCode != 0)
                {
                    AppendLogText($"循环第 {round} 轮失败", FirstNonEmpty(result.Stderr, result.Stdout, "没有错误详情"));
                    SetStatus("循环异常", danger: true);
                    await Task.Delay(TimeSpan.FromSeconds(3), token);
                }
                else if (_sendCommentsEnabledInput.Checked)
                {
                    await SendNextCommentAsync(automatic: true, token);
                }

                round += 1;
            }
        }
        catch (OperationCanceledException)
        {
            SetStatus("已停止");
        }
        finally
        {
            if (_commentCollectionFollowsLoop && _commentCollectRunning)
            {
                StopCommentCollection();
            }
            if (_commentCollectionTask is not null)
            {
                try
                {
                    await _commentCollectionTask;
                }
                catch (OperationCanceledException)
                {
                    // Expected when the loop owns and stops the collector.
                }
                catch (Exception error)
                {
                    AppendLogText("伴随采集收尾", error.ToString());
                }
            }
            _commentCollectionTask = null;
            _commentCollectionFollowsLoop = false;
            _loopRunning = false;
            _loopCancellation?.Dispose();
            _loopCancellation = null;
            SetLoopUi(false);
        }
    }

    private void StopLoop()
    {
        if (!_loopRunning)
        {
            return;
        }

        SetStatus("正在停止");
        if (_loopButton is not null)
        {
            _loopButton.Enabled = false;
        }
        _loopCancellation?.Cancel();
        if (_commentCollectionFollowsLoop && _commentCollectRunning)
        {
            StopCommentCollection();
        }
    }

    private void StopActiveOperation()
    {
        bool stopped = false;
        if (_actionCancellation is not null)
        {
            _actionCancellation.Cancel();
            stopped = true;
        }
        if (_userLinkQueueRunning)
        {
            StopUserLinkQueue();
            stopped = true;
        }

        if (_commentCollectRunning)
        {
            StopCommentCollection();
            stopped = true;
        }

        if (_loopRunning)
        {
            StopLoop();
            stopped = true;
        }

        if (!stopped)
        {
            SetStatus("当前没有运行中的任务");
        }
    }

    private async Task RunNextStepAsync()
    {
        switch (_nextCommand)
        {
            case "open":
                await OpenBrowserAsync();
                break;
            case "find-search":
                await FindSearchAsync();
                break;
            case "search":
                await InputSearchAsync();
                break;
            case "open-video":
                await OpenVideoAsync();
                break;
            case "comments":
                await OpenCommentsAsync();
                break;
            case "watch":
                await WatchCycleAsync();
                break;
            default:
                await RefreshStateAsync();
                break;
        }
    }

    private async Task RefreshStateAsync(bool showErrors = true)
    {
        if (_closing)
        {
            return;
        }

        CancellationTokenSource cancellation = new();
        _actionCancellation = cancellation;
        SetBusy(true, "刷新状态");
        try
        {
            CommandResult browserResult = await RunCliAsync(cancellation.Token, "browser", "status");
            AppendLog("浏览器状态", browserResult);
            if (browserResult.ExitCode != 0 || !TryExtractJson(browserResult.Stdout, out JsonDocument? browserDocument))
            {
                SetConnectionState(connected: false, hasSession: false, "检测失败");
                RenderUnavailable("无法检测浏览器连接，请检查 Node.js 运行环境。");
                SetStatus("连接检测失败", danger: true);
                if (showErrors)
                {
                    ShowError("连接检测失败", FirstNonEmpty(browserResult.Stderr, browserResult.Stdout, "browser status 没有返回有效 JSON"));
                }
                return;
            }

            bool connected;
            bool hasSession;
            using (JsonDocument parsedBrowser = browserDocument!)
            {
                connected = GetBool(parsedBrowser.RootElement, "connected");
                hasSession = GetBool(parsedBrowser.RootElement, "hasSession");
            }
            SetConnectionState(connected, hasSession);
            if (!connected)
            {
                RenderUnavailable(hasSession
                    ? "浏览器会话已断开，请点击“重新连接”。"
                    : "尚未连接浏览器，请点击“连接浏览器”。");
                SetStatus("等待浏览器连接");
                return;
            }

            CommandResult inspectResult = await RunCliAsync(cancellation.Token, "douyin", "inspect");
            AppendLog("页面状态", inspectResult);
            if (inspectResult.ExitCode != 0)
            {
                string details = FirstNonEmpty(inspectResult.Stderr, inspectResult.Stdout, "无法识别当前状态");
                SetStatus("页面识别失败", danger: true);
                RenderUnavailable(details);
                if (showErrors)
                {
                    ShowError("页面识别失败", details);
                }
                return;
            }

            if (!TryExtractJson(inspectResult.Stdout, out JsonDocument? inspectDocument))
            {
                SetStatus("页面解析失败", danger: true);
                RenderUnavailable("inspect 没有返回有效 JSON");
                if (showErrors)
                {
                    ShowError("页面解析失败", "inspect 没有返回有效 JSON");
                }
                return;
            }

            using (JsonDocument parsedInspect = inspectDocument!)
            {
                RenderInspect(parsedInspect.RootElement);
            }
            SetStatus("状态已更新");
        }
        catch (OperationCanceledException)
        {
            SetStatus("操作已取消");
            AppendLogText("刷新状态", "用户取消了状态刷新。");
        }
        catch (Exception error)
        {
            SetStatus("刷新异常", danger: true);
            AppendLogText("刷新异常", error.ToString());
            if (showErrors)
            {
                ShowError("刷新状态", error.ToString());
            }
        }
        finally
        {
            _lastCheckedLabel.Text = $"最后检测：{DateTime.Now:HH:mm:ss}";
            if (ReferenceEquals(_actionCancellation, cancellation))
            {
                _actionCancellation = null;
            }
            cancellation.Dispose();
            SetBusy(false);
        }
    }

    private async Task<CommandResult> RunCliAsync(params string[] args)
    {
        return await _runner.RunAsync(args);
    }

    private async Task<CommandResult> RunCliAsync(CancellationToken cancellationToken, params string[] args)
    {
        return await _runner.RunAsync(args, cancellationToken);
    }

    private async Task<CommandResult> RunCliStreamingAsync(
        string[] args,
        Action<string> onStdoutLine,
        Action<string> onStderrLine,
        CancellationToken cancellationToken)
    {
        return await _runner.RunStreamingAsync(args, onStdoutLine, onStderrLine, cancellationToken);
    }

    private async Task RunActionAsync(string title, Func<CancellationToken, Task<CommandResult>> action)
    {
        CancellationTokenSource cancellation = new();
        _actionCancellation = cancellation;
        bool succeeded = false;
        SetBusy(true, title);
        try
        {
            CommandResult result = await action(cancellation.Token);
            AppendLog(title, result);
            if (result.ExitCode != 0)
            {
                SetStatus("执行失败", danger: true);
                ShowError(title, FirstNonEmpty(result.Stderr, result.Stdout, "没有错误详情"));
                return;
            }

            succeeded = true;
            SetStatus("执行完成");
        }
        catch (OperationCanceledException)
        {
            SetStatus("操作已取消");
            AppendLogText(title, "用户取消了操作。");
        }
        catch (Exception error)
        {
            SetStatus("执行异常", danger: true);
            AppendLogText(title, error.ToString());
            ShowError(title, error.ToString());
        }
        finally
        {
            if (ReferenceEquals(_actionCancellation, cancellation))
            {
                _actionCancellation = null;
            }
            cancellation.Dispose();
            SetBusy(false);
        }

        if (succeeded && !_closing)
        {
            await RefreshStateAsync(showErrors: false);
        }
    }

    private async Task RunCancellableUiOperationAsync(Func<CancellationToken, Task> action)
    {
        CancellationTokenSource cancellation = new();
        _actionCancellation = cancellation;
        try
        {
            await action(cancellation.Token);
        }
        catch (OperationCanceledException)
        {
            SetStatus("操作已取消");
        }
        catch (Exception error)
        {
            SetStatus("操作异常", danger: true);
            ShowError("操作异常", error.ToString());
        }
        finally
        {
            if (ReferenceEquals(_actionCancellation, cancellation))
            {
                _actionCancellation = null;
            }
            cancellation.Dispose();
        }
    }

    private string[] BuildWatchCycleArgs()
    {
        return
        [
            "douyin",
            "watch-cycle",
            "--cycles",
            FormatNumber(_cyclesInput.Value),
            "--min-watch-sec",
            FormatNumber(_minWatchMsInput.Value),
            "--max-watch-sec",
            FormatNumber(_maxWatchMsInput.Value),
            "--min-step-delay-sec",
            FormatNumber(_minStepDelaySecInput.Value),
            "--max-step-delay-sec",
            FormatNumber(_maxStepDelaySecInput.Value),
            "--open-video-index",
            FormatNumber(_openVideoIndexInput.Value),
        ];
    }

    private string[] BuildSearchCycleArgs()
    {
        return
        [
            "douyin",
            "search-cycle",
            "--terms",
            _termsInput.Text,
            "--searches",
            FormatNumber(_searchesInput.Value),
            "--min-browse-sec",
            FormatNumber(_minBrowseMsInput.Value),
            "--max-browse-sec",
            FormatNumber(_maxBrowseMsInput.Value),
            "--min-watch-sec",
            FormatNumber(_minWatchMsInput.Value),
            "--max-watch-sec",
            FormatNumber(_maxWatchMsInput.Value),
            "--min-step-delay-sec",
            FormatNumber(_minStepDelaySecInput.Value),
            "--max-step-delay-sec",
            FormatNumber(_maxStepDelaySecInput.Value),
            "--search-ready-timeout-sec",
            FormatNumber(_loadTimeoutSecInput.Value),
            "--video-ready-timeout-sec",
            FormatNumber(_loadTimeoutSecInput.Value),
        ];
    }

    private string[] BuildFullCycleArgs()
    {
        return BuildFullCycleArgs(_termsInput.Text, FormatNumber(_searchesInput.Value));
    }

    private string[] BuildFullCycleArgs(string terms)
    {
        return BuildFullCycleArgs(terms, "1");
    }

    private string[] BuildFullCycleArgs(string terms, string searches)
    {
        return
        [
            "douyin",
            "full-cycle",
            "--terms",
            terms,
            "--searches",
            searches,
            "--min-browse-sec",
            FormatNumber(_minBrowseMsInput.Value),
            "--max-browse-sec",
            FormatNumber(_maxBrowseMsInput.Value),
            "--min-watch-sec",
            FormatNumber(_minWatchMsInput.Value),
            "--max-watch-sec",
            FormatNumber(_maxWatchMsInput.Value),
            "--min-step-delay-sec",
            FormatNumber(_minStepDelaySecInput.Value),
            "--max-step-delay-sec",
            FormatNumber(_maxStepDelaySecInput.Value),
            "--search-ready-timeout-sec",
            FormatNumber(_loadTimeoutSecInput.Value),
            "--video-ready-timeout-sec",
            FormatNumber(_loadTimeoutSecInput.Value),
            "--open-video-index",
            FormatNumber(_openVideoIndexInput.Value),
        ];
    }

    private string[] BuildCollectCommentsArgs(bool followVideos)
    {
        List<string> args =
        [
            "douyin",
            "collect-comments",
            "--stream",
            "--max-pages",
            "100000",
            "--max-comments",
            FormatNumber(_commentLimitInput.Value),
            "--listen-timeout-sec",
            FormatNumber(_commentTimeoutSecInput.Value),
            "--max-no-new-scrolls",
            FormatNumber(_commentNoNewScrollsInput.Value),
        ];

        if (followVideos)
        {
            args.Add("--follow-videos");
            args.Add("--listen-only");
            args.Add("--no-open-comments");
        }

        return [.. args];
    }

    private void RenderInspect(JsonElement root)
    {
        JsonElement workflow = GetObject(root, "workflow");
        JsonElement target = GetObject(root, "target");
        JsonElement page = GetObject(root, "page");
        JsonElement nextAction = GetObject(workflow, "nextAction");
        JsonElement searchBox = GetObject(root, "searchBox");
        JsonElement commentPanel = GetObject(root, "commentPanel");

        _nextCommand = GetString(nextAction, "command", "status");
        _currentStep.Text = GetString(workflow, "current", "unknown");
        _pageTitle.Text = FirstNonEmpty(GetString(target, "title"), GetString(page, "title"), "-");
        _pageUrl.Text = FirstNonEmpty(GetString(target, "url"), GetString(page, "url"), "-");
        _nextAction.Text = FirstNonEmpty(GetString(nextAction, "name"), "刷新状态")
            + "："
            + FirstNonEmpty(GetString(nextAction, "reason"), "-");

        _workflowList.Items.Clear();
        if (TryGet(workflow, "steps", out JsonElement steps) && steps.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement step in steps.EnumerateArray())
            {
                bool done = GetBool(step, "done");
                _workflowList.Items.Add($"{(done ? "✓" : "○")} {GetString(step, "name", "-")}");
            }
        }

        _searchBoxState.Text = GetBool(searchBox, "ok")
            ? "可用：" + FirstNonEmpty(GetString(searchBox, "value"), GetString(searchBox, "placeholder"), GetString(searchBox, "source"), "-")
            : "未识别";

        int videoCount = GetInt(root, "videoCandidateCount", 0);
        _videoState.Text = $"{videoCount} 个候选";

        _commentState.Text = GetBool(commentPanel, "ok")
            ? "已打开：" + FirstNonEmpty(GetString(commentPanel, "kind"), "comment-panel")
            : "未打开";
    }

    private void RenderUnavailable(string message)
    {
        _nextCommand = "status";
        _currentStep.Text = "不可用";
        _pageTitle.Text = "-";
        _pageUrl.Text = "-";
        _nextAction.Text = message;
        _workflowList.Items.Clear();
        _searchBoxState.Text = "-";
        _videoState.Text = "-";
        _commentState.Text = "-";
    }

    private void HandleCommentCollectResult(string title, CommandResult result)
    {
        if (result.ExitCode != 0)
        {
            ShowError(title, $"采集失败，ExitCode: {result.ExitCode}\n{FirstNonEmpty(result.Stderr, result.Stdout, "没有错误详情")}");
            SetStatus("评论采集失败", danger: true);
            return;
        }

        if (!TryExtractJson(result.Stdout, out JsonDocument? document))
        {
            ShowError(title, "采集命令没有返回有效 JSON。");
            SetStatus("评论采集解析失败", danger: true);
            return;
        }

        using JsonDocument parsed = document!;
        JsonElement root = parsed.RootElement;
        JsonElement network = GetObject(root, "network");
        string videoId = FirstNonEmpty(GetString(root, "awemeId"), GetString(network, "awemeId"));
        int beforeCount = _commentRecords.Count;
        int incomingCount = 0;

        if (TryGet(root, "comments", out JsonElement comments) && comments.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in comments.EnumerateArray())
            {
                incomingCount += 1;
                AddCommentRecord(item, videoId);
            }
        }

        RenderCommentGrid();

        int addedCount = _commentRecords.Count - beforeCount;
        string stopReason = FirstNonEmpty(GetString(root, "stopReason"), "-");
        int pageCount = GetInt(network, "pageCount", 0);
        int networkCount = GetInt(network, "commentCount", incomingCount);
        int elapsedMs = GetInt(root, "elapsedMs", 0);

        _commentCollectState.Text = $"完成 {_commentRecords.Count} / 新增 {addedCount} / {stopReason}";
        SetStatus("评论采集完成");
    }

    private void HandleCommentStreamLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return;
        }

        RunOnUi(() =>
        {
            if (!TryExtractJson(line, out JsonDocument? document))
            {
                return;
            }

            using JsonDocument parsed = document!;
            JsonElement root = parsed.RootElement;
            string eventName = GetString(root, "event");

            switch (eventName)
            {
                case "started":
                    _commentCollectState.Text = $"采集中：上限 {GetInt(root, "maxComments", 0)} 条";
                    break;
                case "comment":
                    if (TryGet(root, "comment", out JsonElement comment))
                    {
                        int before = _commentRecords.Count;
                        AddCommentRecord(comment, GetString(root, "awemeId"));
                        if (_commentRecords.Count > before)
                        {
                            QueueCommentGridRender();
                        }
                    }
                    break;
                case "page":
                    if (TryGet(root, "page", out JsonElement page))
                    {
                        _commentCollectState.Text =
                            $"采集中 {_commentRecords.Count} / 第 {GetInt(page, "index", 0) + 1} 页 / 新增 {GetInt(page, "newCount", 0)}";
                    }
                    break;
                case "summary":
                    _commentCollectState.Text =
                        $"采集摘要：{GetInt(root, "commentCount", _commentRecords.Count)} 条，接口页 {GetInt(root, "pageCount", 0)}，停止原因 {FirstNonEmpty(GetString(root, "stopReason"), "-")}";
                    break;
                case "done":
                    IngestCommentSnapshot(root);
                    JsonElement summary = GetObject(root, "summary");
                    _commentCollectState.Text =
                        $"采集结束：{GetInt(summary, "commentCount", _commentRecords.Count)} 条，接口页 {GetInt(summary, "pageCount", 0)}，停止原因 {FirstNonEmpty(GetString(summary, "stopReason"), "-")}";
                    SetStatus("评论采集完成");
                    QueueCommentGridRender();
                    break;
                case "final-snapshot":
                case "final_snapshot":
                case "snapshot":
                    int added = IngestCommentSnapshot(root);
                    _commentCollectState.Text = $"采集快照：累计 {_commentRecords.Count} 条 / 新增 {added} 条";
                    QueueCommentGridRender();
                    break;
                case "scroll":
                    _commentCollectState.Text = $"采集中 {_commentRecords.Count} / 正在翻页";
                    break;
                case "comment-panel":
                    if (!GetBool(root, "ok"))
                    {
                        _commentCollectState.Text = $"评论区未确认打开：{FirstNonEmpty(GetString(root, "reason"), "等待后续页面动作")}";
                    }
                    break;
                default:
                    if (IngestCommentSnapshot(root) > 0)
                    {
                        QueueCommentGridRender();
                    }
                    break;
            }
        });
    }

    private void QueueCommentGridRender()
    {
        _commentRenderTimer.Stop();
        _commentRenderTimer.Start();
    }

    private int IngestCommentSnapshot(JsonElement root)
    {
        int before = _commentRecords.Count;
        IngestCommentSnapshotCore(root, string.Empty, depth: 0);
        return _commentRecords.Count - before;
    }

    private void IngestCommentSnapshotCore(JsonElement element, string fallbackVideoId, int depth)
    {
        if (element.ValueKind != JsonValueKind.Object || depth > 3)
        {
            return;
        }

        string videoId = FirstNonEmpty(GetString(element, "awemeId"), GetString(element, "aweme_id"), fallbackVideoId);
        if (TryGet(element, "comments", out JsonElement comments) && comments.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement comment in comments.EnumerateArray())
            {
                AddCommentRecord(comment, videoId);
            }
        }

        string[] nestedNames = ["network", "snapshot", "finalSnapshot", "final_snapshot", "result", "payload", "data"];
        foreach (string name in nestedNames)
        {
            if (TryGet(element, name, out JsonElement nested) && nested.ValueKind == JsonValueKind.Object)
            {
                IngestCommentSnapshotCore(nested, videoId, depth + 1);
            }
        }
    }

    private void AppendUiLog(string title, string message)
    {
        AppendLogText(title, message);
    }

    private void AddCommentRecord(JsonElement item, string fallbackVideoId)
    {
        string commentId = GetString(item, "comment_id");
        string videoId = FirstNonEmpty(GetString(item, "aweme_id"), fallbackVideoId);
        string text = GetString(item, "text");
        string userLink = GetString(item, "user_link");
        string key = FirstNonEmpty(commentId, $"{videoId}|{userLink}|{text}");
        if (string.IsNullOrWhiteSpace(key) || _commentKeys.Contains(key))
        {
            return;
        }

        _commentKeys.Add(key);
        _commentRecords.Add(new CommentRecord(
            Index: _commentRecords.Count + 1,
            IpLocation: GetString(item, "comment_ip_location"),
            Text: text,
            UserNickname: GetString(item, "user_nickname"),
            UserLink: userLink,
            UserUid: GetString(item, "user_uid"),
            UserSecUid: GetString(item, "user_sec_uid"),
            Likes: GetInt(item, "likes", 0),
            ReplyCount: GetInt(item, "reply_count", 0),
            CreateTime: GetString(item, "create_time"),
            CommentId: commentId,
            VideoId: videoId,
            Key: key));
    }

    private void RenderCommentGrid()
    {
        List<CommentRecord> matched = GetFilteredCommentRecords();

        _commentGrid.Rows.Clear();
        foreach (CommentRecord record in matched)
        {
            int rowIndex = _commentGrid.Rows.Add(
                _selectedCommentKeys.Contains(record.Key),
                record.Index,
                record.IpLocation,
                record.Text,
                record.UserNickname,
                record.UserLink);
            _commentGrid.Rows[rowIndex].Tag = record;
        }

        _commentCollectState.Text = $"共 {_commentRecords.Count} 条 · 筛选 {matched.Count} · 已选 {CountVisibleCheckedUserLinks()}";
        _emptyComments.Visible = matched.Count == 0;
        _emptyComments.Text = _commentRecords.Count == 0
            ? "还没有采集结果\n\n先连接浏览器，在左侧搜索主题并打开评论区。"
            : "没有符合筛选条件的评论\n\n调整关键词或取消筛选后重试。";
        ApplyRowDensity();
        UpdateCommentControls();
    }

    private List<CommentRecord> GetFilteredCommentRecords()
    {
        List<string> ipKeywords = _ipFilterEnabledInput.Checked ? ParseFilterKeywords(_ipFilterInput.Text) : [];
        List<string> textKeywords = _textFilterEnabledInput.Checked ? ParseFilterKeywords(_textFilterInput.Text) : [];

        return _commentRecords
            .Where(record =>
                MatchesFilter(record.IpLocation, ipKeywords) &&
                MatchesFilter(record.Text, textKeywords))
            .ToList();
    }

    private static bool MatchesFilter(string value, List<string> keywords)
    {
        if (keywords.Count == 0)
        {
            return true;
        }

        return keywords.Any(keyword => value.Contains(keyword, StringComparison.OrdinalIgnoreCase));
    }

    private static List<string> ParseFilterKeywords(string value)
    {
        return value
            .Split(['，', ',', ' ', '\t', '\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(keyword => !string.IsNullOrWhiteSpace(keyword))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private void ClearCommentResults()
    {
        if (_commentCollectRunning)
        {
            ShowError("清空评论结果", "评论仍在采集中，请先停止采集再清空。");
            return;
        }
        if (_commentRecords.Count > 0 &&
            !ConfirmOperation("清空评论结果", $"将永久清空当前内存中的 {_commentRecords.Count} 条评论及勾选状态。是否继续？", warning: true))
        {
            return;
        }

        _commentRecords.Clear();
        _commentKeys.Clear();
        _selectedCommentKeys.Clear();
        RenderCommentGrid();
        SetStatus("评论结果已清空");
    }

    private void ExportComments(string format)
    {
        List<CommentRecord> records = GetFilteredCommentRecords();
        if (records.Count == 0)
        {
            ShowError("导出评论", "当前筛选结果为空，没有可导出的评论。");
            return;
        }

        bool csv = string.Equals(format, "csv", StringComparison.OrdinalIgnoreCase);
        using SaveFileDialog dialog = new()
        {
            Title = csv ? "导出评论 CSV" : "导出评论 JSON",
            Filter = csv ? "CSV 文件 (*.csv)|*.csv" : "JSON 文件 (*.json)|*.json",
            DefaultExt = csv ? "csv" : "json",
            AddExtension = true,
            FileName = $"douyin-comments-{DateTime.Now:yyyyMMdd-HHmmss}.{(csv ? "csv" : "json")}",
        };
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        try
        {
            if (csv)
            {
                StringBuilder output = new();
                output.AppendLine("Index,IpLocation,Text,UserNickname,UserLink,UserUid,UserSecUid,Likes,ReplyCount,CreateTime,CommentId,VideoId");
                foreach (CommentRecord record in records)
                {
                    string[] values =
                    [
                        record.Index.ToString(CultureInfo.InvariantCulture), record.IpLocation, record.Text,
                        record.UserNickname, record.UserLink, record.UserUid, record.UserSecUid,
                        record.Likes.ToString(CultureInfo.InvariantCulture), record.ReplyCount.ToString(CultureInfo.InvariantCulture),
                        record.CreateTime, record.CommentId, record.VideoId,
                    ];
                    output.AppendLine(string.Join(",", values.Select(ToCsvField)));
                }
                File.WriteAllText(dialog.FileName, output.ToString(), new UTF8Encoding(encoderShouldEmitUTF8Identifier: true));
            }
            else
            {
                string json = JsonSerializer.Serialize(records, new JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText(dialog.FileName, json, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            }

            AppendLogText("导出评论", $"已导出 {records.Count} 条到 {dialog.FileName}");
            SetStatus($"已导出 {records.Count} 条评论");
        }
        catch (Exception error)
        {
            ShowError("导出评论失败", error.ToString());
        }
    }

    private static string ToCsvField(string? value)
    {
        string normalized = value ?? string.Empty;
        return '"' + normalized.Replace("\"", "\"\"") + '"';
    }

    private CommentRecord? GetSelectedCommentRecord()
    {
        return _commentGrid.CurrentRow?.Tag as CommentRecord;
    }

    private void CopySelectedUserLink()
    {
        CommentRecord? record = GetSelectedCommentRecord();
        if (record is null || string.IsNullOrWhiteSpace(record.UserLink))
        {
            ShowError("复制用户链接", "当前选中评论没有用户链接。");
            return;
        }

        Clipboard.SetText(record.UserLink);
        SetStatus("已复制用户链接");
    }

    private void CopySelectedCommentText()
    {
        CommentRecord? record = GetSelectedCommentRecord();
        if (record is null || string.IsNullOrWhiteSpace(record.Text))
        {
            ShowError("复制评论内容", "当前选中行没有评论内容。");
            return;
        }

        Clipboard.SetText(record.Text);
        SetStatus("已复制评论内容");
    }

    private void CopySelectedCommentRow()
    {
        CommentRecord? record = GetSelectedCommentRecord();
        if (record is null)
        {
            ShowError("复制整行", "请先选中一条评论。");
            return;
        }

        string text = $"[{record.IpLocation}] {record.Text} - {record.UserNickname} - {record.UserLink}";
        Clipboard.SetText(text);
        SetStatus("已复制整行");
    }

    private async Task OpenSelectedUserLinkAsync()
    {
        CommentRecord? record = GetSelectedCommentRecord();
        if (record is null || string.IsNullOrWhiteSpace(record.UserLink))
        {
            ShowError("打开用户链接", "当前选中评论没有用户链接。");
            return;
        }

        await RunUserLinkQueueAsync([record]);
    }

    private async Task OpenCheckedUserLinksAsync()
    {
        List<CommentRecord> records = GetCheckedCommentRecords();
        if (records.Count == 0)
        {
            ShowError("打开选中用户", "请先勾选至少一条带用户链接的评论。");
            return;
        }

        await RunUserLinkQueueAsync(records);
    }

    private async Task RunUserLinkQueueAsync(List<CommentRecord> records)
    {
        if (_userLinkQueueRunning)
        {
            SetStatus("用户链接队列正在运行");
            return;
        }

        List<CommentRecord> queue = records
            .Where(record => !string.IsNullOrWhiteSpace(record.UserLink))
            .ToList();
        if (queue.Count == 0)
        {
            ShowError("打开用户链接", "选中的评论没有可打开的用户链接。");
            return;
        }

        bool sendPrivateMessage = _sendPrivateMessagesEnabledInput.Checked;
        if (sendPrivateMessage)
        {
            List<string> privatePool = ParseCommentPool(_privateMessagePoolInput.Text);
            if (privatePool.Count == 0)
            {
                ShowError("批量私信", "私信池为空，请先填写至少一条私信文案。");
                return;
            }

            string confirmation =
                $"即将向 {queue.Count} 位已勾选用户执行批量私信。\n\n" +
                $"私信池：{privatePool.Count} 条\n" +
                $"每条文案发送上限：{_privateMessageMaxSendInput.Value} 次\n" +
                "处理过程中可按 Esc 停止，关键配置会被锁定。\n\n是否继续？";
            if (!ConfirmOperation("确认批量私信", confirmation, warning: true))
            {
                SetStatus("已取消批量私信");
                return;
            }
        }

        _userLinkQueueCancellation = new CancellationTokenSource();
        CancellationToken token = _userLinkQueueCancellation.Token;
        _userLinkQueueRunning = true;
        UpdateCommentControls();
        UpdateConfigurationLock();

        try
        {
            int handledCount = 0;
            for (int index = 0; index < queue.Count; index += 1)
            {
                token.ThrowIfCancellationRequested();
                CommentRecord record = queue[index];
                string name = FirstNonEmpty(record.UserNickname, $"第 {record.Index} 条评论");
                string privateMessage = string.Empty;
                if (sendPrivateMessage)
                {
                    privateMessage = await GetNextPrivateMessageTextAsync(automatic: true, token);
                    if (string.IsNullOrWhiteSpace(privateMessage))
                    {
                        SetStatus("私信池无可用文案", danger: true);
                        break;
                    }
                }

                _commentCollectState.Text = sendPrivateMessage
                    ? $"私信用户 {index + 1}/{queue.Count}：{name}"
                    : $"打开用户 {index + 1}/{queue.Count}：{name}。关闭窗口后继续。";
                SetStatus(sendPrivateMessage ? $"私信用户 {index + 1}/{queue.Count}" : $"打开用户 {index + 1}/{queue.Count}");

                CommandResult result = sendPrivateMessage
                    ? await RunCliAsync(
                        token,
                        "browser",
                        "send-private-message",
                        "--url",
                        record.UserLink,
                        "--text",
                        privateMessage)
                    : await RunCliAsync(
                        token,
                        "browser",
                        "open-user-window",
                        "--url",
                        record.UserLink);
                AppendLog($"打开用户 {index + 1}/{queue.Count}", result);
                if (result.ExitCode != 0)
                {
                    string failureTitle = sendPrivateMessage ? "私信用户失败" : "打开用户失败";
                    SetStatus(failureTitle, danger: true);
                    string details = FirstNonEmpty(result.Stderr, result.Stdout, "没有错误详情");
                    AppendLogText(failureTitle, details);
                    if (!sendPrivateMessage)
                    {
                        ShowError("打开用户链接", details);
                    }
                    break;
                }

                handledCount += 1;
                if (sendPrivateMessage)
                {
                    MarkPrivateMessageSent(privateMessage, SummarizePrivateMessageResult(result.Stdout));
                }

                if (index < queue.Count - 1)
                {
                    _commentCollectState.Text = sendPrivateMessage ? "私信已完成，3 秒后处理下一位" : "用户窗口已关闭，3 秒后打开下一位";
                    await Task.Delay(TimeSpan.FromSeconds(3), token);
                }
            }

            if (!token.IsCancellationRequested)
            {
                _commentCollectState.Text = $"用户链接处理完成：{handledCount}/{queue.Count} 条";
                SetStatus("用户链接处理完成");
            }
        }
        catch (OperationCanceledException)
        {
            _commentCollectState.Text = "已停止打开用户链接";
            SetStatus("已停止打开用户");
        }
        finally
        {
            _userLinkQueueRunning = false;
            _userLinkQueueCancellation?.Dispose();
            _userLinkQueueCancellation = null;
            UpdateCommentControls();
            UpdateConfigurationLock();
        }
    }

    private void StopUserLinkQueue()
    {
        if (!_userLinkQueueRunning)
        {
            return;
        }

        _commentCollectState.Text = "正在停止打开用户链接";
        _userLinkQueueCancellation?.Cancel();
    }

    private async Task<string> GetNextPrivateMessageTextAsync(bool automatic, CancellationToken cancellationToken)
    {
        List<string> pool = ParseCommentPool(_privateMessagePoolInput.Text);
        if (pool.Count == 0)
        {
            bool generated = await TryAutoRewritePoolAsync("private", showErrors: !automatic, cancellationToken);
            if (generated)
            {
                pool = ParseCommentPool(_privateMessagePoolInput.Text);
            }
        }

        int maxPerMessage = Math.Max(1, decimal.ToInt32(_privateMessageMaxSendInput.Value));
        List<string> available = pool
            .Where(message => !_privateMessageSendCounts.TryGetValue(message, out int count) || count < maxPerMessage)
            .ToList();

        if (available.Count == 0 && pool.Count > 0)
        {
            bool generated = await TryAutoRewritePoolAsync("private", showErrors: !automatic, cancellationToken);
            if (generated)
            {
                pool = ParseCommentPool(_privateMessagePoolInput.Text);
                available = pool
                    .Where(message => !_privateMessageSendCounts.TryGetValue(message, out int count) || count < maxPerMessage)
                    .ToList();
            }
        }

        if (available.Count == 0)
        {
            if (!automatic)
            {
                ShowError("私信池为空", "私信池没有可用文案。请先追加私信文案，或开启 AI 自动重构。 ");
            }
            SetPrivateMessageState("无可用私信文案");
            return string.Empty;
        }

        string selected = available[_random.Next(available.Count)];
        SetPrivateMessageState($"已选择：{selected}");
        return selected;
    }

    private void MarkPrivateMessageSent(string message, string? extra = null)
    {
        if (!string.IsNullOrWhiteSpace(message))
        {
            _privateMessageSendCounts.TryGetValue(message, out int currentCount);
            _privateMessageSendCounts[message] = currentCount + 1;
        }

        SetPrivateMessageState(extra);
    }

    private void ReconcilePrivateMessageProgress()
    {
        HashSet<string> currentPool = ParseCommentPool(_privateMessagePoolInput.Text)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (string removed in _privateMessageSendCounts.Keys.Where(key => !currentPool.Contains(key)).ToList())
        {
            _privateMessageSendCounts.Remove(removed);
        }
        SetPrivateMessageState();
    }

    private void SetPrivateMessageState(string? extra = null)
    {
        List<string> pool = ParseCommentPool(_privateMessagePoolInput.Text);
        int maxPerMessage = Math.Max(1, decimal.ToInt32(_privateMessageMaxSendInput.Value));
        int available = pool.Count(message => !_privateMessageSendCounts.TryGetValue(message, out int count) || count < maxPerMessage);
        string rewrite = _aiRewriteEnabled
            ? $"AI重构：开 / 目标 {(_aiRewriteTarget == "private" ? "私信池" : "评论池")}" 
            : "AI重构：关";
        string suffix = string.IsNullOrWhiteSpace(extra) ? string.Empty : $"；{extra}";
        _privateMessageState.Text = $"私信池：{pool.Count} 条 / 可用 {available} 条 / 单条上限 {maxPerMessage}；{rewrite}{suffix}";
    }

    private static string SummarizePrivateMessageResult(string stdout)
    {
        if (!TryExtractJson(stdout, out JsonDocument? document))
        {
            return "结束标志：私信流程完成";
        }

        using JsonDocument parsed = document!;
        JsonElement root = parsed.RootElement;
        JsonElement signal = GetObject(root, "finishSignal");
        string signalText = FirstNonEmpty(GetString(signal, "text"), GetString(root, "message"));
        if (!string.IsNullOrWhiteSpace(signalText))
        {
            return signalText;
        }

        if (GetBool(root, "blocked"))
        {
            return "结束标志：私信已发送，但可能被对方拒收或受限";
        }

        return GetBool(root, "sent") ? "结束标志：私信发送完成" : "结束标志：私信流程完成";
    }

    private async Task SendNextCommentAsync(bool automatic, CancellationToken cancellationToken = default)
    {
        if (!_sendCommentsEnabledInput.Checked)
        {
            if (!automatic)
            {
                ShowError("评论发送", "未启用评论发送功能。");
            }

            return;
        }

        if (_commentSendBusy)
        {
            return;
        }

        _commentSendBusy = true;
        UpdateSendControls();
        SetCommentSendState("正在识别当前视频");

        try
        {
            CommandResult currentResult = cancellationToken.CanBeCanceled
                ? await RunCliAsync(cancellationToken, "douyin", "current-video")
                : await RunCliAsync("douyin", "current-video");
            if (currentResult.ExitCode != 0)
            {
                HandleSendFailure("识别当前视频失败", currentResult, automatic);
                return;
            }

            if (!TryExtractJson(currentResult.Stdout, out JsonDocument? currentDocument))
            {
                NotifySendIssue("识别当前视频失败", "current-video 没有返回有效 JSON。", automatic);
                return;
            }

            string awemeId;
            string pageUrl;
            using (JsonDocument parsed = currentDocument!)
            {
                awemeId = GetString(parsed.RootElement, "awemeId");
                pageUrl = GetString(parsed.RootElement, "url");
            }

            string videoKey = FirstNonEmpty(awemeId, pageUrl);
            if (string.IsNullOrWhiteSpace(videoKey))
            {
                NotifySendIssue("评论发送", "当前没有识别到视频，请先进入视频并打开右侧评论区。", automatic);
                return;
            }

            if (_sentCommentVideoIds.Contains(videoKey))
            {
                SetCommentSendState("当前视频已发送过评论，已跳过");
                return;
            }

            string commentText = await GetNextCommentTextAsync(automatic, cancellationToken);
            if (string.IsNullOrWhiteSpace(commentText))
            {
                return;
            }

            SetCommentSendState("正在发送评论");
            CommandResult sendResult = cancellationToken.CanBeCanceled
                ? await RunCliAsync(cancellationToken, "douyin", "send-comment", "--text", commentText, "--after-send-wait-sec", "1")
                : await RunCliAsync("douyin", "send-comment", "--text", commentText, "--after-send-wait-sec", "1");
            if (sendResult.ExitCode != 0)
            {
                HandleSendFailure("评论发送失败", sendResult, automatic);
                return;
            }

            _sentCommentVideoIds.Add(videoKey);
            _sentCommentCount += 1;
            AdvancePoolAfterSuccessfulSend();
            SetCommentSendState();
            SetStatus("评论已发送");
        }
        catch (OperationCanceledException)
        {
            SetCommentSendState("发送已取消");
            throw;
        }
        catch (Exception error)
        {
            NotifySendIssue("评论发送异常", error.Message, automatic);
        }
        finally
        {
            _commentSendBusy = false;
            UpdateSendControls();
        }
    }

    private async Task<string> GetNextCommentTextAsync(bool automatic, CancellationToken cancellationToken)
    {
        List<string> pool = ParseCommentPool(_commentPoolInput.Text);
        if (_poolCursorIndex < pool.Count)
        {
            if (_poolRepeatTarget <= 0)
            {
                _poolRepeatTarget = _random.Next(2, 4);
            }

            return pool[_poolCursorIndex];
        }

        SetCommentSendState("评论池已用完，等待追加文案");
        bool rewritten = await TryAutoRewritePoolAsync("comment", showErrors: !automatic, cancellationToken);
        if (rewritten)
        {
            pool = ParseCommentPool(_commentPoolInput.Text);
            if (_poolCursorIndex < pool.Count)
            {
                SetCommentSendState("AI 已自动追加评论池文案");
                return pool[_poolCursorIndex];
            }
        }
        else if (!automatic)
        {
            ShowError("评论池为空", "评论池已经用完。请先追加评论，或在 AI 重构设置里开启自动重构。 ");
        }

        return string.Empty;
    }

    private void AdvancePoolAfterSuccessfulSend()
    {
        _poolRepeatCount += 1;
        if (_poolRepeatTarget <= 0)
        {
            _poolRepeatTarget = _random.Next(2, 4);
        }

        if (_poolRepeatCount < _poolRepeatTarget)
        {
            return;
        }

        _poolCursorIndex += 1;
        _poolRepeatCount = 0;
        _poolRepeatTarget = 0;
    }

    private void ResetCommentPoolProgress()
    {
        _poolCursorIndex = 0;
        _poolRepeatCount = 0;
        _poolRepeatTarget = 0;

        SetCommentSendState();
    }

    private async Task<bool> TryAutoRewritePoolAsync(string target, bool showErrors, CancellationToken cancellationToken)
    {
        if (!_aiRewriteEnabled || !string.Equals(_aiRewriteTarget, target, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(_aiApiKey))
        {
            if (showErrors)
            {
                ShowError("AI 自动重构", "请先在 AI 重构设置里填写 API Key。");
            }
            return false;
        }

        try
        {
            int count = decimal.ToInt32(_aiGenerateCountInput.Value);
            string content = await RequestAiCompletionAsync(BuildAiPrompt(count, target), cancellationToken);
            List<string> candidates = ParseAiCandidates(content, count);
            if (candidates.Count == 0)
            {
                if (showErrors)
                {
                    ShowError("AI 自动重构", "AI 没有返回可用文案。");
                }
                return false;
            }

            if (string.Equals(target, "private", StringComparison.OrdinalIgnoreCase))
            {
                List<string> existing = ParseCommentPool(_privateMessagePoolInput.Text);
                existing.AddRange(candidates);
                _privateMessagePoolInput.Text = string.Join("；", existing.Distinct(StringComparer.OrdinalIgnoreCase));
                ReconcilePrivateMessageProgress();
                SetPrivateMessageState($"AI 自动追加 {candidates.Count} 条");
            }
            else
            {
                List<string> existing = ParseCommentPool(_commentPoolInput.Text);
                existing.AddRange(candidates);
                _commentPoolInput.Text = string.Join("；", existing.Distinct(StringComparer.OrdinalIgnoreCase));
                ResetCommentPoolProgress();
                SetCommentSendState($"AI 自动追加 {candidates.Count} 条");
            }

            return true;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception error)
        {
            if (showErrors)
            {
                ShowError("AI 自动重构失败", error.Message);
            }
            return false;
        }
    }
    private async Task<bool> GenerateAiCandidatesAsync(bool showErrors, CancellationToken cancellationToken = default)
    {
        if (_commentSendBusy && showErrors)
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(_aiApiKey))
        {
            if (showErrors)
            {
                ShowError("AI 生成", "请先点击 AI 设置，填写 API Key。");
            }

            return false;
        }

        _commentSendBusy = true;
        UpdateSendControls();
        SetCommentSendState("正在生成候选文案");

        try
        {
            int count = decimal.ToInt32(_aiGenerateCountInput.Value);
            string content = await RequestAiCompletionAsync(BuildAiPrompt(count), cancellationToken);
            List<string> candidates = ParseAiCandidates(content, count);
            if (candidates.Count == 0)
            {
                if (showErrors)
                {
                    ShowError("AI 生成", "AI 没有返回可用候选文案。");
                }

                return false;
            }

            _aiCandidateList.Items.Clear();
            foreach (string candidate in candidates)
            {
                _aiCandidateList.Items.Add(candidate, false);
            }

            SetCommentSendState($"已生成 {candidates.Count} 条候选");
            return true;
        }
        catch (OperationCanceledException)
        {
            SetCommentSendState("AI 生成已取消");
            throw;
        }
        catch (Exception error)
        {
            if (showErrors)
            {
                ShowError("AI 生成失败", error.Message);
            }
            else
            {
                SetCommentSendState("AI 生成失败");
            }

            return false;
        }
        finally
        {
            _commentSendBusy = false;
            UpdateSendControls();
        }
    }

    private async Task<string> RequestAiCompletionAsync(string prompt, CancellationToken cancellationToken)
    {
        string baseUrl = _aiBaseUrl.Trim().TrimEnd('/');
        if (string.IsNullOrWhiteSpace(baseUrl))
        {
            throw new InvalidOperationException("AI Base URL 为空。");
        }

        using HttpClient client = new()
        {
            Timeout = TimeSpan.FromSeconds(60),
        };
        using HttpRequestMessage request = new(HttpMethod.Post, $"{baseUrl}/chat/completions");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _aiApiKey.Trim());

        var payload = new
        {
            model = _aiModel.Trim(),
            messages = new[]
            {
                new { role = "system", content = FirstNonEmpty(_aiSystemPromptInput.Text, "你是短视频评论和私信文案助手。") },
                new { role = "user", content = prompt },
            },
            temperature = decimal.ToDouble(_aiTemperature),
        };

        request.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        using HttpResponseMessage response = await client.SendAsync(request, cancellationToken);
        string body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"AI API 返回 {(int)response.StatusCode}：{body}");
        }

        using JsonDocument document = JsonDocument.Parse(body);
        JsonElement root = document.RootElement;
        if (TryGet(root, "choices", out JsonElement choices) && choices.ValueKind == JsonValueKind.Array)
        {
            JsonElement first = choices.EnumerateArray().FirstOrDefault();
            JsonElement message = GetObject(first, "message");
            string content = GetString(message, "content");
            if (!string.IsNullOrWhiteSpace(content))
            {
                return content;
            }
        }

        throw new InvalidOperationException("AI API 响应中没有 choices[0].message.content。");
    }

    private string BuildAiPrompt(int count, string target = "comment")
    {
        bool privateTarget = string.Equals(target, "private", StringComparison.OrdinalIgnoreCase);
        string topic = FirstNonEmpty(_aiTopicInput.Text, privateTarget ? "根据用户主页生成自然私信" : "根据当前视频评论区生成自然评论");
        string template = _aiTemplateInput.Text.Trim();
        string recentComments = string.Join("\n", _commentRecords
            .TakeLast(20)
            .Select(record => "- " + record.Text)
            .Where(text => text.Length > 2));

        StringBuilder prompt = new();
        if (privateTarget)
        {
            prompt.AppendLine($"请生成 {count} 条可加入私信池的短私信。");
            prompt.AppendLine("要求：一行一条；不要编号；不要解释；语气自然、有礼貌、不夸张；不要承诺交易或收益；长度 10 到 60 个中文字符。");
        }
        else
        {
            prompt.AppendLine($"请生成 {count} 条可加入评论池的短评论。");
            prompt.AppendLine("要求：一行一条；不要编号；不要解释；不要直接要求关注、私信或交易；语气自然，长度 8 到 35 个中文字符。");
        }

        prompt.AppendLine($"主题/内容：{topic}");
        if (!string.IsNullOrWhiteSpace(template))
        {
            prompt.AppendLine($"模板/样品：{template}");
        }

        if (!string.IsNullOrWhiteSpace(recentComments))
        {
            prompt.AppendLine("当前评论区参考：");
            prompt.AppendLine(recentComments);
        }

        return prompt.ToString();
    }

    private static List<string> ParseAiCandidates(string value, int maxCount)
    {
        return value
            .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(line => Regex.Replace(line, @"^\s*[-*•\d\.、\)\（\）]+\s*", "").Trim())
            .Where(line => line.Length is >= 2 and <= 80)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(maxCount)
            .ToList();
    }

    private void AppendCheckedAiCandidates()
    {
        List<string> selected = _aiCandidateList.CheckedItems
            .Cast<object>()
            .Select(item => item.ToString() ?? "")
            .Where(text => !string.IsNullOrWhiteSpace(text))
            .ToList();

        if (selected.Count == 0)
        {
            ShowError("追加候选", "请先勾选要追加的候选文案。");
            return;
        }

        List<string> existing = ParseCommentPool(_commentPoolInput.Text);
        existing.AddRange(selected);
        _commentPoolInput.Text = string.Join("；", existing);
        _aiCandidateList.Items.Clear();
        SetCommentSendState($"已追加 {selected.Count} 条候选");
    }

    private void OpenAiSettingsDialog()
    {
        using Form dialog = new()
        {
            Text = "AI 服务设置",
            StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            ClientSize = new Size(640, 590),
            BackColor = WorkspaceTheme.Surface,
            Font = Font,
        };

        TableLayoutPanel layout = new()
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(16),
            RowCount = 10,
            ColumnCount = 2,
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (int row = 0; row < 7; row += 1)
        {
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        }
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 130));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        dialog.Controls.Add(layout);

        ComboBox provider = new()
        {
            Dock = DockStyle.Fill,
            DropDownStyle = ComboBoxStyle.DropDownList,
        };
        provider.Items.AddRange(["DeepSeek", "千问百炼", "自定义"]);
        provider.FlatStyle = FlatStyle.Flat;
        provider.BackColor = WorkspaceTheme.Field;
        provider.ForeColor = WorkspaceTheme.Text;
        provider.SelectedItem = _aiProvider;

        TextBox apiKey = new()
        {
            Dock = DockStyle.Fill,
            Text = _aiApiKey,
            PasswordChar = '●',
        };
        ConfigureField(apiKey);

        TextBox baseUrl = new()
        {
            Dock = DockStyle.Fill,
            Text = _aiBaseUrl,
        };
        ConfigureField(baseUrl);

        TextBox model = new()
        {
            Dock = DockStyle.Fill,
            Text = _aiModel,
        };
        ConfigureField(model);

        NumericUpDown temperature = new()
        {
            Dock = DockStyle.Fill,
            Minimum = 0,
            Maximum = 2,
            DecimalPlaces = 1,
            Increment = 0.1M,
            Value = _aiTemperature,
        };

        CheckBox autoRewrite = new()
        {
            Dock = DockStyle.Fill,
            Text = "启用自动重构",
            Checked = _aiRewriteEnabled,
            ForeColor = WorkspaceTheme.Text,
            BackColor = Color.Transparent,
        };

        ComboBox rewriteTarget = new()
        {
            Dock = DockStyle.Fill,
            DropDownStyle = ComboBoxStyle.DropDownList,
        };
        rewriteTarget.Items.AddRange(["评论池", "私信池"]);
        rewriteTarget.FlatStyle = FlatStyle.Flat;
        rewriteTarget.BackColor = WorkspaceTheme.Field;
        rewriteTarget.ForeColor = WorkspaceTheme.Text;
        temperature.BackColor = WorkspaceTheme.Field;
        temperature.ForeColor = WorkspaceTheme.Text;
        rewriteTarget.SelectedItem = _aiRewriteTarget == "private" ? "私信池" : "评论池";

        TextBox systemPrompt = new()
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            ScrollBars = ScrollBars.Vertical,
            Text = _aiSystemPromptInput.Text,
        };
        ConfigureField(systemPrompt);

        provider.SelectedIndexChanged += (_, _) =>
        {
            string selected = provider.SelectedItem?.ToString() ?? "";
            if (selected == "DeepSeek")
            {
                baseUrl.Text = "https://api.deepseek.com";
                model.Text = "deepseek-chat";
            }
            else if (selected == "千问百炼")
            {
                baseUrl.Text = "https://dashscope.aliyuncs.com/compatible-mode/v1";
                model.Text = "qwen-plus";
            }
        };

        AddDialogRow(layout, 0, "服务商", provider);
        AddDialogRow(layout, 1, "API Key", apiKey);
        AddDialogRow(layout, 2, "Base URL", baseUrl);
        AddDialogRow(layout, 3, "模型", model);
        AddDialogRow(layout, 4, "Temperature", temperature);
        AddDialogRow(layout, 5, "自动重构", autoRewrite);
        AddDialogRow(layout, 6, "重构目标", rewriteTarget);
        AddDialogRow(layout, 7, "系统提示词", systemPrompt);

        Label privacyNotice = CreateMutedLabel(
            "数据说明：生成时会将主题/模板及最近 20 条评论文本发送到所配置的 AI 服务；API Key 仅以 Windows DPAPI 加密后保存在本机。");
        privacyNotice.Dock = DockStyle.Fill;
        privacyNotice.Padding = new Padding(0, 8, 0, 0);
        privacyNotice.AutoEllipsis = false;
        layout.Controls.Add(privacyNotice, 0, 8);
        layout.SetColumnSpan(privacyNotice, 2);

        FlowLayoutPanel actions = new()
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.RightToLeft,
        };
        Button ok = CreateButton("保存", primary: true);
        ok.Width = 96;
        ok.Click += (_, _) =>
        {
            if (!Uri.TryCreate(baseUrl.Text.Trim(), UriKind.Absolute, out Uri? endpoint) ||
                (endpoint.Scheme != Uri.UriSchemeHttps && !(endpoint.Scheme == Uri.UriSchemeHttp && endpoint.IsLoopback)) ||
                !string.IsNullOrEmpty(endpoint.UserInfo) || !string.IsNullOrEmpty(endpoint.Query) || !string.IsNullOrEmpty(endpoint.Fragment))
            {
                MessageBox.Show(dialog, "请填写有效的 HTTPS 服务地址；本地模型可使用 http://localhost。地址中不能包含密钥、查询参数或片段。", "检查服务地址", MessageBoxButtons.OK, MessageBoxIcon.Information);
                baseUrl.Focus();
                return;
            }
            if (string.IsNullOrWhiteSpace(model.Text))
            {
                MessageBox.Show(dialog, "请填写模型名称。", "检查模型", MessageBoxButtons.OK, MessageBoxIcon.Information);
                model.Focus();
                return;
            }
            if (baseUrl.Text.TrimEnd('/').EndsWith("/chat/completions", StringComparison.OrdinalIgnoreCase))
            {
                MessageBox.Show(dialog, "这里只需填写基础地址，请移除末尾 /chat/completions。", "检查服务地址", MessageBoxButtons.OK, MessageBoxIcon.Information);
                baseUrl.Focus();
                return;
            }
            dialog.DialogResult = DialogResult.OK;
        };
        Button cancel = CreateButton("取消");
        cancel.Width = 96;
        cancel.DialogResult = DialogResult.Cancel;
        actions.Controls.Add(ok);
        actions.Controls.Add(cancel);
        layout.Controls.Add(actions, 1, 9);

        dialog.AcceptButton = ok;
        dialog.CancelButton = cancel;

        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        _aiProvider = provider.SelectedItem?.ToString() ?? "自定义";
        _aiApiKey = apiKey.Text.Trim();
        _aiBaseUrl = baseUrl.Text.Trim();
        _aiModel = model.Text.Trim();
        _aiTemperature = temperature.Value;
        _aiRewriteEnabled = autoRewrite.Checked;
        _aiRewriteTarget = rewriteTarget.SelectedItem?.ToString() == "私信池" ? "private" : "comment";
        _aiSystemPromptInput.Text = systemPrompt.Text.Trim();
        SetCommentSendState("AI 重构设置已保存");
        SetPrivateMessageState();
        SaveSettingsToLogOnly();
    }

    private static void AddDialogRow(TableLayoutPanel layout, int row, string label, Control control)
    {
        Label labelControl = CreateMutedLabel(label);
        labelControl.Dock = DockStyle.Fill;
        labelControl.TextAlign = ContentAlignment.MiddleLeft;
        control.Margin = new Padding(0, 4, 0, 4);
        layout.Controls.Add(labelControl, 0, row);
        layout.Controls.Add(control, 1, row);
    }

    private void HandleSendFailure(string title, CommandResult result, bool automatic)
    {
        NotifySendIssue(title, FirstNonEmpty(result.Stderr, result.Stdout, "没有错误详情"), automatic);
    }

    private void NotifySendIssue(string title, string message, bool automatic)
    {
        SetCommentSendState(title);
        SetStatus(title, danger: true);
        AppendLogText(title, message);
        if (!automatic)
        {
            ShowError(title, message);
        }
    }

    private void SetCommentSendState(string? extra = null)
    {
        int poolCount = ParseCommentPool(_commentPoolInput.Text).Count;
        string active = poolCount > _poolCursorIndex
            ? $"当前第 {_poolCursorIndex + 1}/{poolCount} 条，已连续 {_poolRepeatCount}/{(_poolRepeatTarget <= 0 ? 2 : _poolRepeatTarget)} 次"
            : $"评论池 {poolCount} 条";
        string suffix = string.IsNullOrWhiteSpace(extra) ? string.Empty : $"；{extra}";
        _commentSendState.Text = $"评论发送：已发送 {_sentCommentCount} 次；已记录视频 {_sentCommentVideoIds.Count} 个；{active}{suffix}";
    }

    private static List<string> ParseCommentPool(string value)
    {
        return value
            .Split([';', '；', '\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(text => !string.IsNullOrWhiteSpace(text))
            .ToList();
    }

    private void AppendLog(string title, CommandResult result)
    {
        StringBuilder message = new();
        message.AppendLine($"命令：{result.CommandText}");
        message.AppendLine($"退出码：{result.ExitCode}");
        message.Append(AppendBlock("STDOUT", result.Stdout));
        message.Append(AppendBlock("STDERR", result.Stderr));
        string text = message.ToString().TrimEnd();
        if (result.ExitCode == 0)
        {
            AppLog.Info(title, text);
        }
        else
        {
            AppLog.Error(title, text);
        }
        AppendVisibleLog(title, text);
    }

    private void AppendLogText(string title, string message)
    {
        AppLog.Info(title, message);
        AppendVisibleLog(title, message);
    }

    private void AppendVisibleLog(string title, string message)
    {
        RunOnUi(() =>
        {
            if (_logBox.IsDisposed)
            {
                return;
            }

            const int maximumCharacters = 250_000;
            if (_logBox.TextLength > maximumCharacters)
            {
                _logBox.Select(0, _logBox.TextLength - maximumCharacters);
                _logBox.SelectedText = string.Empty;
            }

            _logBox.AppendText($"[{DateTime.Now:HH:mm:ss}] {title}{Environment.NewLine}");
            if (!string.IsNullOrWhiteSpace(message))
            {
                _logBox.AppendText(message.TrimEnd() + Environment.NewLine);
            }
            _logBox.AppendText(Environment.NewLine);
            _logBox.SelectionStart = _logBox.TextLength;
            _logBox.ScrollToCaret();
        });
    }

    private static string AppendBlock(string name, string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        return $"{name}:\n{value.Trim()}\n";
    }

    private void SetBusy(bool busy, string? label = null)
    {
        _busy = busy;
        foreach (Button button in _actionButtons)
        {
            button.Enabled = !busy && !_loopRunning;
        }

        if (_loopButton is not null)
        {
            _loopButton.Enabled = _loopRunning || !busy;
        }

        if (busy && !string.IsNullOrWhiteSpace(label))
        {
            _statusBadge.Text = "任务：" + label;
            _statusBadge.ForeColor = WorkspaceTheme.Warning;
        }

        UpdateCommentControls();
        UpdateSendControls();
        UpdateConfigurationLock();
    }

    private void SetStatus(string text, bool danger = false)
    {
        _statusBadge.Text = "任务：" + text;
        _statusBadge.ForeColor = danger ? WorkspaceTheme.Danger : WorkspaceTheme.Success;
    }

    private void SetConnectionState(bool connected, bool hasSession, string? detail = null)
    {
        _browserConnected = connected;
        if (connected)
        {
            _connectionBadge.Text = "浏览器：已连接";
            _connectionBadge.ForeColor = WorkspaceTheme.Success;
            if (_openBrowserButton is not null)
            {
                _openBrowserButton.Text = "重新连接";
            }
            return;
        }

        _connectionBadge.Text = detail is not null
            ? $"浏览器：{detail}"
            : hasSession ? "浏览器：已断开" : "浏览器：未连接";
        _connectionBadge.ForeColor = hasSession || detail is not null
            ? WorkspaceTheme.Danger
            : WorkspaceTheme.Warning;
        if (_openBrowserButton is not null)
        {
            _openBrowserButton.Text = hasSession ? "重新连接" : "连接浏览器";
        }
    }

    private bool ConfirmOperation(string title, string message, bool warning = false)
    {
        return MessageBox.Show(
            this,
            message,
            title,
            MessageBoxButtons.YesNo,
            warning ? MessageBoxIcon.Warning : MessageBoxIcon.Question,
            MessageBoxDefaultButton.Button2) == DialogResult.Yes;
    }

    private void UpdateConfigurationLock()
    {
        bool locked = _busy || _loopRunning || _commentCollectRunning || _userLinkQueueRunning || _commentSendBusy;
        Control[] criticalControls =
        [
            _termsInput,
            _openVideoIndexInput,
            _minWatchMsInput,
            _maxWatchMsInput,
            _minBrowseMsInput,
            _maxBrowseMsInput,
            _minStepDelaySecInput,
            _maxStepDelaySecInput,
            _loadTimeoutSecInput,
            _cyclesInput,
            _searchesInput,
            _commentLimitInput,
            _commentTimeoutSecInput,
            _commentNoNewScrollsInput,
            _commentPoolInput,
            _privateMessagePoolInput,
            _privateMessageMaxSendInput,
            _aiTopicInput,
            _aiTemplateInput,
            _aiGenerateCountInput,
        ];
        foreach (Control control in criticalControls)
        {
            control.Enabled = !locked;
        }

        _collectCommentsEnabledInput.Enabled = !locked;
        _sendCommentsEnabledInput.Enabled = !locked;
        _sendPrivateMessagesEnabledInput.Enabled = !locked;
        if (_aiSettingsButton is not null)
        {
            _aiSettingsButton.Enabled = !locked;
        }
        foreach (Button button in _preferenceTaskButtons) button.Enabled = !locked;
    }

    private void ShowError(string title, string message)
    {
        if (_closing || IsDisposed)
        {
            return;
        }

        void Show()
        {
            AppendLogText(title, message);
            using ErrorDetailsDialog dialog = new(title, message);
            dialog.ShowDialog(this);
        }

        if (InvokeRequired)
        {
            BeginInvoke((Action)Show);
            return;
        }

        Show();
    }

    private void SetLoopUi(bool running)
    {
        foreach (Button button in _actionButtons)
        {
            button.Enabled = !running;
        }

        if (_loopButton is not null)
        {
            _loopButton.Text = running ? "停止循环" : "开始循环";
            _loopButton.Enabled = running || !_busy;
            ApplyButtonStyle(_loopButton, primary: !running, danger: running);
        }

        UpdateCommentControls();
        UpdateSendControls();
        UpdateConfigurationLock();
    }

    private Button AddActionButton(
        TableLayoutPanel layout,
        string text,
        int row,
        int column,
        Func<Task> action,
        bool primary = false,
        int columnSpan = 1)
    {
        Button button = CreateButton(text, primary);
        button.Dock = DockStyle.Fill;
        button.Margin = new Padding(4);
        button.Click += async (_, _) => await action();
        layout.Controls.Add(button, column, row);
        if (columnSpan > 1)
        {
            layout.SetColumnSpan(button, columnSpan);
        }
        _actionButtons.Add(button);
        return button;
    }

    private static Panel CreatePanel()
    {
        return new WorkspaceCard
        {
            Dock = DockStyle.Fill,
            BackColor = WorkspaceTheme.Surface,
            Margin = new Padding(0, 0, 12, 0),
        };
    }

    private Button CreateButton(string text, bool primary = false)
    {
        Button button = new WorkspaceButton()
        {
            Text = text,
            Height = 36,
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand,
        };
        ApplyButtonStyle(button, primary);
        return button;
    }

    private static void ApplyButtonStyle(Button button, bool primary = false, bool danger = false)
    {
        Color background = danger
            ? WorkspaceTheme.Danger
            : primary
                ? WorkspaceTheme.Accent
                : WorkspaceTheme.Field;
        Color border = danger
            ? WorkspaceTheme.Danger
            : primary
                ? WorkspaceTheme.Accent
                : WorkspaceTheme.Border;
        button.ForeColor = primary || danger ? Color.White : WorkspaceTheme.Text;
        button.BackColor = background;
        button.FlatAppearance.BorderColor = border;
    }

    private static void ConfigureFilter(CheckBox checkBox, TextBox textBox)
    {
        checkBox.Dock = DockStyle.Fill;
        checkBox.ForeColor = WorkspaceTheme.Text;
        checkBox.BackColor = Color.Transparent;
        ConfigureField(textBox);
        textBox.Margin = new Padding(4);
    }

    private static void ConfigureField(TextBoxBase textBox)
    {
        textBox.Dock = DockStyle.Fill;
        textBox.BackColor = WorkspaceTheme.Field;
        textBox.ForeColor = WorkspaceTheme.Text;
        textBox.BorderStyle = BorderStyle.FixedSingle;
    }

    private static void ConfigureRichField(RichTextBox textBox)
    {
        ConfigureField(textBox);
        textBox.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
    }

    private void ConfigureFilter(CheckBox checkBox, string label, TextBox textBox)
    {
        ConfigureFilter(checkBox, textBox);
        checkBox.Text = label;
        checkBox.CheckedChanged += (_, _) => RenderCommentGrid();
        textBox.TextChanged += (_, _) => RenderCommentGrid();
    }

    private void ConfigureCommentGrid()
    {
        _commentGrid.Dock = DockStyle.Fill;
        _commentGrid.ReadOnly = false;
        _commentGrid.AllowUserToAddRows = false;
        _commentGrid.AllowUserToDeleteRows = false;
        _commentGrid.AllowUserToResizeRows = false;
        _commentGrid.AutoGenerateColumns = false;
        _commentGrid.RowHeadersVisible = false;
        _commentGrid.ScrollBars = ScrollBars.Vertical;
        _commentGrid.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
        _commentGrid.MultiSelect = false;
        _commentGrid.BackgroundColor = WorkspaceTheme.Field;
        _commentGrid.GridColor = WorkspaceTheme.Border;
        _commentGrid.BorderStyle = BorderStyle.None;
        _commentGrid.CellBorderStyle = DataGridViewCellBorderStyle.SingleHorizontal;
        _commentGrid.ColumnHeadersBorderStyle = DataGridViewHeaderBorderStyle.None;
        _commentGrid.ColumnHeadersHeight = 38;
        _commentGrid.EnableHeadersVisualStyles = false;
        _commentGrid.ColumnHeadersDefaultCellStyle.BackColor = WorkspaceTheme.Field;
        _commentGrid.ColumnHeadersDefaultCellStyle.ForeColor = WorkspaceTheme.Text;
        _commentGrid.ColumnHeadersDefaultCellStyle.SelectionBackColor = WorkspaceTheme.Field;
        _commentGrid.DefaultCellStyle.BackColor = WorkspaceTheme.Field;
        _commentGrid.DefaultCellStyle.ForeColor = WorkspaceTheme.Text;
        _commentGrid.DefaultCellStyle.SelectionBackColor = WorkspaceTheme.AccentSoft;
        _commentGrid.DefaultCellStyle.SelectionForeColor = WorkspaceTheme.Text;
        _commentGrid.AlternatingRowsDefaultCellStyle.BackColor = WorkspaceTheme.Field;
        _commentGrid.Columns.Clear();
        _commentGrid.Columns.Add(new DataGridViewCheckBoxColumn { Name = "Selected", HeaderText = "全选", Width = 54, TrueValue = true, FalseValue = false });
        _commentGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Index", HeaderText = "序", Width = 36 });
        _commentGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "IpLocation", HeaderText = "属地", Width = 62 });
        _commentGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Text", HeaderText = "评论内容", AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill, MinimumWidth = 120 });
        _commentGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "UserNickname", HeaderText = "昵称", Width = 74 });
        _commentGrid.Columns.Add(new DataGridViewLinkColumn
        {
            Name = "UserLink",
            HeaderText = "主页",
            Width = 76,
            LinkColor = WorkspaceTheme.Accent,
            ActiveLinkColor = WorkspaceTheme.Accent,
            VisitedLinkColor = WorkspaceTheme.Accent,
        });
        _toolTip.SetToolTip(_commentGrid, "点击“全选”列头可勾选或取消当前筛选结果；空格切换当前行");

        foreach (DataGridViewColumn column in _commentGrid.Columns)
        {
            column.ReadOnly = column.Name != "Selected";
        }

        ContextMenuStrip menu = new();
        menu.Items.Add("复制评论内容", null, (_, _) => CopySelectedCommentText());
        menu.Items.Add("复制用户链接", null, (_, _) => CopySelectedUserLink());
        menu.Items.Add("打开用户链接", null, async (_, _) => await OpenSelectedUserLinkAsync());
        menu.Items.Add("复制整行", null, (_, _) => CopySelectedCommentRow());
        _commentGrid.ContextMenuStrip = menu;
        _commentGrid.CurrentCellDirtyStateChanged += (_, _) =>
        {
            if (_commentGrid.IsCurrentCellDirty && _commentGrid.CurrentCell?.OwningColumn?.Name == "Selected")
            {
                _commentGrid.CommitEdit(DataGridViewDataErrorContexts.Commit);
            }
        };
        _commentGrid.CellValueChanged += (_, e) =>
        {
            if (e.RowIndex >= 0 && _commentGrid.Columns[e.ColumnIndex].Name == "Selected")
            {
                UpdateCommentSelection(_commentGrid.Rows[e.RowIndex]);
            }
        };
        _commentGrid.CellContentClick += async (_, e) =>
        {
            if (e.RowIndex < 0)
            {
                return;
            }

            string columnName = _commentGrid.Columns[e.ColumnIndex].Name;
            if (columnName == "UserLink")
            {
                _commentGrid.CurrentCell = _commentGrid.Rows[e.RowIndex].Cells[e.ColumnIndex];
                await OpenSelectedUserLinkAsync();
            }
        };
        _commentGrid.CellMouseDown += (_, e) =>
        {
            if (e.RowIndex >= 0 && e.Button == MouseButtons.Right)
            {
                _commentGrid.ClearSelection();
                _commentGrid.Rows[e.RowIndex].Selected = true;
                _commentGrid.CurrentCell = _commentGrid.Rows[e.RowIndex].Cells[Math.Max(e.ColumnIndex, 0)];
            }
        };
        _commentGrid.ColumnHeaderMouseClick += (_, e) =>
        {
            if (_commentGrid.Columns[e.ColumnIndex].Name == "Selected")
            {
                ToggleVisibleCommentSelection();
            }
        };
        _commentGrid.KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Space && _commentGrid.CurrentRow is not null)
            {
                e.SuppressKeyPress = true;
                ToggleCommentRowSelection(_commentGrid.CurrentRow);
            }
        };
    }

    private void ToggleVisibleCommentSelection()
    {
        _commentGrid.EndEdit();
        List<DataGridViewRow> selectableRows = _commentGrid.Rows
            .Cast<DataGridViewRow>()
            .Where(row => row.Tag is CommentRecord record && !string.IsNullOrWhiteSpace(record.UserLink))
            .ToList();
        bool select = selectableRows.Any(row => row.Tag is CommentRecord record && !_selectedCommentKeys.Contains(record.Key));
        foreach (DataGridViewRow row in selectableRows)
        {
            row.Cells["Selected"].Value = select;
        }

        _commentGrid.EndEdit();
        UpdateCommentControls();
    }

    private void ToggleCommentRowSelection(DataGridViewRow row)
    {
        if (row.Tag is not CommentRecord record || string.IsNullOrWhiteSpace(record.UserLink))
        {
            return;
        }

        bool selected = _selectedCommentKeys.Contains(record.Key);
        row.Cells["Selected"].Value = !selected;
        _commentGrid.EndEdit();
    }

    private void UpdateCommentSelection(DataGridViewRow row)
    {
        if (row.Tag is not CommentRecord record)
        {
            return;
        }

        bool selected = row.Cells["Selected"].Value is bool value && value;
        if (selected)
        {
            _selectedCommentKeys.Add(record.Key);
        }
        else
        {
            _selectedCommentKeys.Remove(record.Key);
        }

        _commentCollectState.Text = $"{_commentRecords.Count} / 命中{GetFilteredCommentRecords().Count} / 选{CountVisibleCheckedUserLinks()}";
        UpdateCommentControls();
    }

    private List<CommentRecord> GetCheckedCommentRecords()
    {
        _commentGrid.EndEdit();
        List<CommentRecord> records = [];
        foreach (DataGridViewRow row in _commentGrid.Rows)
        {
            if (row.Tag is CommentRecord record && _selectedCommentKeys.Contains(record.Key) && !string.IsNullOrWhiteSpace(record.UserLink))
            {
                records.Add(record);
            }
        }

        return records;
    }

    private int CountVisibleCheckedUserLinks()
    {
        int count = 0;
        foreach (DataGridViewRow row in _commentGrid.Rows)
        {
            if (row.Tag is CommentRecord record && _selectedCommentKeys.Contains(record.Key) && !string.IsNullOrWhiteSpace(record.UserLink))
            {
                count += 1;
            }
        }

        return count;
    }
    private void UpdateCommentControls()
    {
        _collectCommentsEnabledInput.Enabled = !_commentCollectRunning && !_loopRunning && !_busy;
        _sendPrivateMessagesEnabledInput.Enabled = !_userLinkQueueRunning && !_loopRunning && !_busy;

        if (_collectCommentsButton is not null)
        {
            _collectCommentsButton.Text = _commentCollectRunning ? "停止采集" : "开始采集";
            _collectCommentsButton.Enabled = _commentCollectRunning || (_collectCommentsEnabledInput.Checked && !_busy);
            ApplyButtonStyle(_collectCommentsButton, primary: !_commentCollectRunning, danger: _commentCollectRunning);
        }

        if (_openSelectedUserLinksButton is not null)
        {
            bool privateMode = _sendPrivateMessagesEnabledInput.Checked;
            _openSelectedUserLinksButton.Text = _userLinkQueueRunning
                ? privateMode ? "停止私信" : "停止打开"
                : privateMode ? "私信选中用户" : "打开选中用户";
            _openSelectedUserLinksButton.Enabled = _userLinkQueueRunning || (!_busy && CountVisibleCheckedUserLinks() > 0);
            ApplyButtonStyle(_openSelectedUserLinksButton, danger: _userLinkQueueRunning);
        }
        UpdateConfigurationLock();
    }

    private void UpdateSendControls()
    {
        bool enabled = _sendCommentsEnabledInput.Checked && !_commentSendBusy && !_busy && !_loopRunning && !_userLinkQueueRunning;
        _sendCommentsEnabledInput.Enabled = !_commentSendBusy && !_loopRunning && !_userLinkQueueRunning && !_busy;
        if (_sendNextCommentButton is not null)
        {
            _sendNextCommentButton.Enabled = enabled;
        }

        if (_generateAiButton is not null)
        {
            _generateAiButton.Enabled = !_commentSendBusy;
        }

        if (_appendAiCandidatesButton is not null)
        {
            _appendAiCandidatesButton.Enabled = !_commentSendBusy;
        }

        if (_aiSettingsButton is not null)
        {
            _aiSettingsButton.Enabled = !_commentSendBusy;
        }
        UpdateConfigurationLock();
    }

    private void RunOnUi(Action action)
    {
        if (_closing || IsDisposed)
        {
            return;
        }

        if (InvokeRequired)
        {
            try
            {
                BeginInvoke(action);
            }
            catch (InvalidOperationException)
            {
                // The form closed between the state check and BeginInvoke.
            }
            return;
        }

        action();
    }

    private static Label CreateSectionTitle(string text)
    {
        return new Label
        {
            Text = text,
            ForeColor = WorkspaceTheme.Text,
            Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold, GraphicsUnit.Point),
            Height = 30,
        };
    }

    private static Label CreateMutedLabel(string text)
    {
        return new Label
        {
            Text = text,
            ForeColor = WorkspaceTheme.Muted,
            AutoEllipsis = true,
        };
    }

    private static Control BuildMetric(string title, Label value)
    {
        Panel panel = CreatePanel();
        panel.Margin = new Padding(0, 0, 8, 0);
        panel.Padding = new Padding(12);

        Label label = CreateMutedLabel(title);
        label.Dock = DockStyle.Top;
        value.Dock = DockStyle.Fill;
        value.ForeColor = WorkspaceTheme.Text;
        value.Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold, GraphicsUnit.Point);
        value.Text = "-";

        panel.Controls.Add(value);
        panel.Controls.Add(label);
        return panel;
    }

    private static void ConfigureNumber(NumericUpDown control, decimal min, decimal max, decimal value)
    {
        control.Minimum = min;
        control.Maximum = max;
        control.Value = value;
        control.Increment = min >= 1000 ? 1000 : 1;
        control.BackColor = WorkspaceTheme.Field;
        control.ForeColor = WorkspaceTheme.Text;
        control.BorderStyle = BorderStyle.FixedSingle;
        control.Dock = DockStyle.Fill;
    }

    private static void AddLabeledControl(
        TableLayoutPanel layout,
        string label,
        Control control,
        int row,
        int column = 0,
        int columnSpan = 1,
        int height = 62)
    {
        Panel panel = new()
        {
            Dock = DockStyle.Fill,
            Height = height,
            Margin = new Padding(4),
        };
        Label labelControl = CreateMutedLabel(label);
        if (control is NumericUpDown)
        {
            TableLayoutPanel inline = new()
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 1,
                Margin = Padding.Empty,
            };
            inline.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 48));
            inline.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 52));
            inline.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            labelControl.Dock = DockStyle.Fill;
            labelControl.Font = new Font("Microsoft YaHei UI", 8F, FontStyle.Regular, GraphicsUnit.Point);
            labelControl.TextAlign = ContentAlignment.MiddleLeft;
            control.Dock = DockStyle.Fill;
            control.Margin = new Padding(4, 2, 0, 2);
            inline.Controls.Add(labelControl, 0, 0);
            inline.Controls.Add(control, 1, 0);
            panel.Controls.Add(inline);
        }
        else
        {
            labelControl.Dock = DockStyle.Top;
            labelControl.Height = 22;
            control.Dock = DockStyle.Fill;
            panel.Controls.Add(control);
            panel.Controls.Add(labelControl);
        }
        layout.Controls.Add(panel, column, row);
        if (columnSpan > 1)
        {
            layout.SetColumnSpan(panel, columnSpan);
        }
    }

    private static void AddSummaryRow(TableLayoutPanel layout, int row, string label, Label value)
    {
        Label labelControl = CreateMutedLabel(label);
        labelControl.Dock = DockStyle.Fill;
        value.Dock = DockStyle.Fill;
        value.ForeColor = WorkspaceTheme.Text;
        value.AutoEllipsis = true;
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 25));
        layout.Controls.Add(labelControl, 0, row);
        layout.Controls.Add(value, 1, row);
    }

    private static bool TryExtractJson(string stdout, out JsonDocument? document)
    {
        document = null;
        if (string.IsNullOrWhiteSpace(stdout))
        {
            return false;
        }

        int start = stdout.IndexOf('{');
        if (start < 0)
        {
            return false;
        }

        string json = stdout[start..].Trim();
        try
        {
            document = JsonDocument.Parse(json);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool TryGet(JsonElement element, string name, out JsonElement value)
    {
        value = default;
        return element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out value);
    }

    private static JsonElement GetObject(JsonElement element, string name)
    {
        return TryGet(element, name, out JsonElement value) && value.ValueKind == JsonValueKind.Object
            ? value
            : default;
    }

    private static string GetString(JsonElement element, string name, string fallback = "")
    {
        if (!TryGet(element, name, out JsonElement value))
        {
            return fallback;
        }

        return value.ValueKind == JsonValueKind.String ? value.GetString() ?? fallback : fallback;
    }

    private static bool GetBool(JsonElement element, string name)
    {
        return TryGet(element, name, out JsonElement value)
            && value.ValueKind is JsonValueKind.True or JsonValueKind.False
            && value.GetBoolean();
    }

    private static int GetInt(JsonElement element, string name, int fallback)
    {
        return TryGet(element, name, out JsonElement value) && value.TryGetInt32(out int result)
            ? result
            : fallback;
    }

    private static string FirstNonEmpty(params string[] values)
    {
        return values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? string.Empty;
    }

    private static string FormatNumber(decimal value)
    {
        return decimal.Truncate(value).ToString(CultureInfo.InvariantCulture);
    }

    private string TakeNextLoopTerm()
    {
        if (_remainingLoopTerms.Count == 0)
        {
            _remainingLoopTerms = Shuffle(ParseTerms(_termsInput.Text));
        }

        if (_remainingLoopTerms.Count == 0)
        {
            return string.Empty;
        }

        string term = _remainingLoopTerms[0];
        _remainingLoopTerms.RemoveAt(0);
        return term;
    }

    private List<string> Shuffle(List<string> terms)
    {
        List<string> shuffled = [.. terms];
        for (int index = shuffled.Count - 1; index > 0; index -= 1)
        {
            int swapIndex = _random.Next(index + 1);
            (shuffled[index], shuffled[swapIndex]) = (shuffled[swapIndex], shuffled[index]);
        }

        return shuffled;
    }

    private static List<string> ParseTerms(string value)
    {
        return value
            .Split([';', '；', '\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(term => !string.IsNullOrWhiteSpace(term))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }
}
