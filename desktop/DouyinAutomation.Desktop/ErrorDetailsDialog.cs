namespace DouyinAutomation.Desktop;

internal sealed class ErrorDetailsDialog : Form
{
    public ErrorDetailsDialog(string title, string message)
    {
        Text = title;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(680, 390);
        MinimumSize = new Size(520, 300);
        BackColor = WorkspaceTheme.Surface;
        ForeColor = WorkspaceTheme.Text;
        Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
        ShowInTaskbar = false;

        TableLayoutPanel root = new()
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(16),
            RowCount = 3,
            ColumnCount = 1,
        };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
        Controls.Add(root);

        Label heading = new()
        {
            Dock = DockStyle.Fill,
            Text = title,
            ForeColor = WorkspaceTheme.Danger,
            Font = new Font(Font, FontStyle.Bold),
            TextAlign = ContentAlignment.MiddleLeft,
        };
        root.Controls.Add(heading, 0, 0);

        RichTextBox details = new()
        {
            Dock = DockStyle.Fill,
            Text = string.IsNullOrWhiteSpace(message) ? "未知错误" : message,
            ReadOnly = true,
            DetectUrls = true,
            BackColor = WorkspaceTheme.Field,
            ForeColor = WorkspaceTheme.Text,
            BorderStyle = BorderStyle.FixedSingle,
        };
        root.Controls.Add(details, 0, 1);

        FlowLayoutPanel actions = new()
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.RightToLeft,
            Padding = new Padding(0, 8, 0, 0),
        };
        Button close = new() { Text = "关闭", Width = 96, Height = 34, DialogResult = DialogResult.OK };
        Button copy = new() { Text = "复制详情", Width = 110, Height = 34 };
        copy.Click += (_, _) =>
        {
            if (!string.IsNullOrEmpty(details.Text))
            {
                Clipboard.SetText(details.Text);
            }
        };
        actions.Controls.Add(close);
        actions.Controls.Add(copy);
        root.Controls.Add(actions, 0, 2);
        AcceptButton = close;
        CancelButton = close;
    }
}
