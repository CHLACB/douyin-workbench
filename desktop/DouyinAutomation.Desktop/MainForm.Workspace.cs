namespace DouyinAutomation.Desktop;

internal sealed partial class MainForm
{
    private readonly List<Control> _workspacePages = [];
    private readonly List<Button> _navigationButtons = [];
    private readonly CheckBox _compactRowsInput = new();
    private readonly CheckBox _rememberWindowInput = new();
    private readonly Label _emptyComments = new();
    private readonly Label _preferencesFeedback = new();
    private readonly List<Button> _preferenceTaskButtons = [];
    private Panel _workspaceHost = null!;

    private Control BuildWorkspace()
    {
        // Initialize the existing controls once; move their real instances into
        // the new pages so handlers, busy-state protection and persisted values stay shared.
        InitializeTaskControls();
        Control comments = BuildCommentsPanel();
        Control writing = BuildCommentSendPanel();
        Control messages = BuildPrivateMessagePanel();
        Control diagnostics = BuildStatusPanel();
        Control logs = BuildLogPanel();

        TableLayoutPanel shell = new() { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = Padding.Empty, Padding = new Padding(12) };
        shell.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 156));
        shell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        FlowLayoutPanel navigation = new()
        {
            Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false,
            Padding = new Padding(0, 10, 0, 0), BackColor = WorkspaceTheme.Surface,
        };
        WorkspaceCard navigationCard = new() { Dock = DockStyle.Fill, Margin = new Padding(0, 0, 12, 0), Padding = new Padding(8) };
        navigationCard.Controls.Add(navigation);
        _workspaceHost = new Panel { Dock = DockStyle.Fill, Padding = new Padding(8, 6, 0, 0), Margin = Padding.Empty };
        shell.Controls.Add(navigationCard, 0, 0);
        shell.Controls.Add(_workspaceHost, 1, 0);

        AddWorkspacePage(navigation, "采集工作台", "采集工作台", "连接浏览器 → 搜索主题 → 打开视频与评论 → 开始采集", BuildCollectionWorkspace(comments));
        AddWorkspacePage(navigation, "AI 文案", "AI 文案", "结合已采集评论生成候选文案，检查后再加入评论池。", WithMinimumHeight(writing, 530));
        AddWorkspacePage(navigation, "私信管理", "私信管理", "维护文案与发送上限；在采集表格中选择用户后执行。", messages);
        AddWorkspacePage(navigation, "设置", "工作台设置", "调整任务参数与显示偏好；已有配置会继续保留。", BuildPreferences());
        AddWorkspacePage(navigation, "连接诊断", "连接诊断", "查看当前页面、识别结果与下一步操作。", diagnostics);
        AddWorkspacePage(navigation, "运行日志", "运行日志", "查看执行记录，定位异常并复制日志位置。", logs);
        Label shortcut = CreateMutedLabel("F5  刷新状态\nCtrl+B  连接浏览器\nEsc  停止任务");
        shortcut.AutoSize = false;
        shortcut.Size = new Size(128, 90);
        shortcut.Margin = new Padding(4, 28, 0, 0);
        navigation.Controls.Add(shortcut);

        _emptyComments.Text = "还没有采集结果\n\n先连接浏览器，在左侧搜索主题并打开评论区。";
        _emptyComments.Dock = DockStyle.Fill;
        _emptyComments.TextAlign = ContentAlignment.MiddleCenter;
        _emptyComments.ForeColor = WorkspaceTheme.Muted;
        _emptyComments.BackColor = _commentGrid.BackgroundColor;
        _commentGrid.Controls.Add(_emptyComments);
        _emptyComments.BringToFront();
        ShowWorkspacePage(0);
        return shell;
    }

    private void AddWorkspacePage(FlowLayoutPanel navigation, string label, string title, string description, Control content)
    {
        TableLayoutPanel page = new() { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, Visible = false, Margin = Padding.Empty };
        page.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        page.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        page.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        Label heading = new() { Text = title, Dock = DockStyle.Fill, ForeColor = WorkspaceTheme.Text, Font = new Font(Font.FontFamily, 17, FontStyle.Bold), Margin = Padding.Empty };
        Label hint = CreateMutedLabel(description);
        hint.Dock = DockStyle.Fill;
        hint.AutoEllipsis = true;
        content.Dock = DockStyle.Fill;
        content.Margin = Padding.Empty;
        page.Controls.Add(heading, 0, 0);
        page.Controls.Add(hint, 0, 1);
        page.Controls.Add(content, 0, 2);
        int index = _workspacePages.Count;
        _workspacePages.Add(page);
        _workspaceHost.Controls.Add(page);
        Button button = CreateButton(label);
        button.Size = new Size(126, 44);
        button.TextAlign = ContentAlignment.MiddleLeft;
        button.Padding = new Padding(10, 0, 0, 0);
        button.Margin = new Padding(0, 0, 0, 8);
        button.Click += (_, _) => ShowWorkspacePage(index);
        navigation.Controls.Add(button);
        _navigationButtons.Add(button);
    }

    private static Control WithMinimumHeight(Control content, int minimum)
    {
        Panel scroll = new() { Dock = DockStyle.Fill, AutoScroll = true };
        content.Dock = DockStyle.Top;
        content.Height = minimum;
        scroll.Controls.Add(content);
        scroll.Resize += (_, _) => content.Height = Math.Max(minimum, scroll.ClientSize.Height);
        return scroll;
    }

    private void ShowWorkspacePage(int index)
    {
        for (int i = 0; i < _workspacePages.Count; i++)
        {
            _workspacePages[i].Visible = i == index;
            ApplyButtonStyle(_navigationButtons[i], primary: i == index);
            _navigationButtons[i].BackColor = i == index ? WorkspaceTheme.AccentSoft : WorkspaceTheme.Surface;
            _navigationButtons[i].ForeColor = i == index ? WorkspaceTheme.Accent : WorkspaceTheme.Muted;
            _navigationButtons[i].FlatAppearance.BorderColor = i == index ? WorkspaceTheme.AccentSoft : WorkspaceTheme.Surface;
        }
        _workspacePages[index].BringToFront();
    }

    private Control BuildCollectionWorkspace(Control comments)
    {
        TableLayoutPanel columns = new() { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1 };
        columns.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 240));
        columns.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        Panel tasks = CreatePanel();
        tasks.Padding = new Padding(16);
        tasks.Margin = new Padding(0, 0, 12, 0);
        tasks.AutoScroll = true;
        TableLayoutPanel form = new() { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 1, RowCount = 9 };
        form.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        foreach (int height in new[] { 30, 110, 46, 46, 46, 46, 30, 46, 60 }) form.RowStyles.Add(new RowStyle(SizeType.Absolute, height));
        tasks.Controls.Add(form);
        form.Controls.Add(CreateSectionTitle("采集准备"), 0, 0);
        ConfigureField(_termsInput);
        _termsInput.PlaceholderText = "输入主题，用分号分隔";
        AddLabeledControl(form, "搜索主题（分号分隔）", _termsInput, 1, height: 110);
        AddActionButton(form, "1  搜索主题", 2, 0, async () => await InputSearchAsync());
        AddActionButton(form, "2  打开视频", 3, 0, async () => await OpenVideoAsync());
        AddActionButton(form, "3  打开评论区", 4, 0, async () => await OpenCommentsAsync());
        AddActionButton(form, "浏览下一视频", 5, 0, async () => await WatchCycleAsync());
        form.Controls.Add(CreateMutedLabel("连续浏览"), 0, 6);
        _loopButton = CreateButton("开始循环");
        _loopButton.Click += async (_, _) => { if (_loopRunning) StopLoop(); else await StartLoopAsync(); };
        _actionButtons.Add(_loopButton);
        _loopButton.Dock = DockStyle.Fill;
        _loopButton.Margin = new Padding(4);
        form.Controls.Add(_loopButton, 0, 7);
        Button settings = CreateButton("调整采集参数 →");
        settings.Dock = DockStyle.Fill;
        settings.Margin = new Padding(4, 12, 4, 8);
        settings.Click += (_, _) => ShowWorkspacePage(3);
        form.Controls.Add(settings, 0, 8);
        columns.Controls.Add(tasks, 0, 0);
        columns.Controls.Add(comments, 1, 0);
        return columns;
    }

    private Control BuildPreferences()
    {
        Panel scroll = CreatePanel();
        scroll.AutoScroll = true;
        scroll.Padding = new Padding(20);
        TableLayoutPanel form = new() { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2, RowCount = 12 };
        form.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        form.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        for (int i = 0; i < 12; i++) form.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
        scroll.Controls.Add(form);
        void Heading(string text, int row) { Label label = CreateSectionTitle(text); form.Controls.Add(label, 0, row); form.SetColumnSpan(label, 2); }
        Heading("采集与浏览", 0);
        AddLabeledControl(form, "评论上限（条）", _commentLimitInput, 1);
        AddLabeledControl(form, "采集超时（秒）", _commentTimeoutSecInput, 1, 1);
        AddLabeledControl(form, "无新增停止（轮）", _commentNoNewScrollsInput, 2);
        AddLabeledControl(form, "视频序号（从 0 起）", _openVideoIndexInput, 2, 1);
        AddLabeledControl(form, "视频停留最短（秒）", _minWatchMsInput, 3);
        AddLabeledControl(form, "视频停留最长（秒）", _maxWatchMsInput, 3, 1);
        AddLabeledControl(form, "搜索间隔最短（秒）", _minBrowseMsInput, 4);
        AddLabeledControl(form, "搜索间隔最长（秒）", _maxBrowseMsInput, 4, 1);
        AddLabeledControl(form, "步骤延迟最短（秒）", _minStepDelaySecInput, 5);
        AddLabeledControl(form, "步骤延迟最长（秒）", _maxStepDelaySecInput, 5, 1);
        AddLabeledControl(form, "页面超时（秒）", _loadTimeoutSecInput, 6);
        AddLabeledControl(form, "周期数", _cyclesInput, 6, 1);
        AddLabeledControl(form, "搜索次数", _searchesInput, 7);
        Heading("显示偏好", 8);
        _compactRowsInput.Text = "紧凑表格行高";
        _rememberWindowInput.Text = "记住窗口大小";
        foreach (CheckBox checkbox in new[] { _compactRowsInput, _rememberWindowInput })
        { checkbox.ForeColor = WorkspaceTheme.Text; checkbox.Dock = DockStyle.Fill; }
        _compactRowsInput.CheckedChanged += (_, _) => ApplyRowDensity();
        form.Controls.Add(_compactRowsInput, 0, 9);
        form.Controls.Add(_rememberWindowInput, 1, 9);
        Heading("AI 服务", 10);
        Button ai = CreateButton("配置模型与 API Key");
        ai.Dock = DockStyle.Fill;
        ai.Click += (_, _) => OpenAiSettingsDialog();
        form.Controls.Add(ai, 0, 11);
        _preferenceTaskButtons.Add(ai);
        Label note = CreateMutedLabel("密钥使用当前 Windows 用户加密保存。");
        note.Dock = DockStyle.Fill;
        form.Controls.Add(note, 1, 11);
        Button save = CreateButton("保存设置", primary: true);
        save.Dock = DockStyle.Fill;
        save.Click += (_, _) =>
        {
            try { ValidateWorkspaceSettings(); SaveSettings(); _preferencesFeedback.Text = "已保存，下次启动自动恢复。"; }
            catch (Exception error) { _preferencesFeedback.Text = error.Message; }
        };
        TableLayoutPanel footer = new() { Dock = DockStyle.Bottom, Height = 96, ColumnCount = 2, RowCount = 2, Padding = new Padding(20, 8, 20, 4) };
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        footer.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        footer.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        footer.Controls.Add(save, 0, 0);
        Button reset = CreateButton("恢复默认任务参数");
        reset.Dock = DockStyle.Fill;
        reset.Click += (_, _) => ResetTaskPreferences();
        footer.Controls.Add(reset, 1, 0);
        _preferenceTaskButtons.Add(reset);
        _preferencesFeedback.ForeColor = WorkspaceTheme.Muted;
        _preferencesFeedback.Dock = DockStyle.Fill;
        _preferencesFeedback.Text = "参数修改立即用于下一次任务；关闭窗口时也会保存。";
        footer.Controls.Add(_preferencesFeedback, 0, 1);
        footer.SetColumnSpan(_preferencesFeedback, 2);
        Panel container = new() { Dock = DockStyle.Fill };
        container.Controls.Add(scroll);
        container.Controls.Add(footer);
        return container;
    }

    private void ValidateWorkspaceSettings()
    {
        if (_minWatchMsInput.Value > _maxWatchMsInput.Value) throw new InvalidOperationException("视频停留：最短时间不能大于最长时间。");
        if (_minBrowseMsInput.Value > _maxBrowseMsInput.Value) throw new InvalidOperationException("搜索间隔：最短时间不能大于最长时间。");
        if (_minStepDelaySecInput.Value > _maxStepDelaySecInput.Value) throw new InvalidOperationException("步骤延迟：最短时间不能大于最长时间。");
    }

    private void ResetTaskPreferences()
    {
        DesktopSettings defaults = new();
        foreach ((NumericUpDown input, decimal value) in new (NumericUpDown, decimal)[] {
            (_commentLimitInput, defaults.CommentLimit), (_commentTimeoutSecInput, defaults.CommentTimeoutSec),
            (_commentNoNewScrollsInput, defaults.CommentNoNewScrolls), (_openVideoIndexInput, defaults.OpenVideoIndex),
            (_minWatchMsInput, defaults.MinWatchSec), (_maxWatchMsInput, defaults.MaxWatchSec),
            (_minBrowseMsInput, defaults.MinBrowseSec), (_maxBrowseMsInput, defaults.MaxBrowseSec),
            (_minStepDelaySecInput, defaults.MinStepDelaySec), (_maxStepDelaySecInput, defaults.MaxStepDelaySec),
            (_loadTimeoutSecInput, defaults.LoadTimeoutSec), (_cyclesInput, defaults.Cycles), (_searchesInput, defaults.Searches)
        }) SetNumericValue(input, value);
        _preferencesFeedback.Text = "已恢复任务参数。点击保存设置可保存到本机。";
    }

    private void ApplyRowDensity()
    {
        int height = _compactRowsInput.Checked ? 28 : 40;
        _commentGrid.RowTemplate.Height = height;
        foreach (DataGridViewRow row in _commentGrid.Rows) row.Height = height;
    }

    private void InitializeTaskControls()
    {
        _termsInput.Multiline = true;
        _termsInput.ScrollBars = ScrollBars.Vertical;
        ConfigureNumber(_openVideoIndexInput, 0, 20, 0);
        ConfigureNumber(_minWatchMsInput, 1, 3600, 120);
        ConfigureNumber(_maxWatchMsInput, 1, 3600, 180);
        ConfigureNumber(_minBrowseMsInput, 1, 3600, 20);
        ConfigureNumber(_maxBrowseMsInput, 1, 3600, 45);
        ConfigureNumber(_minStepDelaySecInput, 0, 300, 3);
        ConfigureNumber(_maxStepDelaySecInput, 0, 300, 7);
        ConfigureNumber(_loadTimeoutSecInput, 3, 300, 30);
        ConfigureNumber(_cyclesInput, 1, 100, 1);
        ConfigureNumber(_searchesInput, 1, 100, 2);
        ConfigureNumber(_commentLimitInput, 1, 100000, 300);
        ConfigureNumber(_commentTimeoutSecInput, 5, 86400, 600);
        ConfigureNumber(_commentNoNewScrollsInput, 1, 100, 8);
    }
}
