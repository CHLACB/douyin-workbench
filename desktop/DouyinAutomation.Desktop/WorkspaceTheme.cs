using System.Drawing.Drawing2D;

namespace DouyinAutomation.Desktop;

internal static class WorkspaceTheme
{
    public static readonly Color Canvas = Color.FromArgb(245, 247, 250);
    public static readonly Color Surface = Color.White;
    public static readonly Color Field = Color.FromArgb(250, 251, 253);
    public static readonly Color Text = Color.FromArgb(32, 42, 58);
    public static readonly Color Muted = Color.FromArgb(103, 116, 136);
    public static readonly Color Border = Color.FromArgb(225, 231, 239);
    public static readonly Color Accent = Color.FromArgb(44, 99, 220);
    public static readonly Color AccentSoft = Color.FromArgb(235, 242, 255);
    public static readonly Color Success = Color.FromArgb(25, 126, 89);
    public static readonly Color Warning = Color.FromArgb(155, 103, 22);
    public static readonly Color Danger = Color.FromArgb(186, 58, 71);

    public static GraphicsPath Rounded(RectangleF bounds, float radius)
    {
        float diameter = Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height));
        GraphicsPath path = new();
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }
}

internal sealed class WorkspaceCard : Panel
{
    public WorkspaceCard()
    {
        SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
        BackColor = WorkspaceTheme.Surface;
        Padding = new Padding(16);
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        Color outside = Parent?.BackColor ?? WorkspaceTheme.Canvas;
        e.Graphics.Clear(outside.A == 255 ? outside : WorkspaceTheme.Canvas);
        if (Width < 4 || Height < 4) return;
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using GraphicsPath shape = WorkspaceTheme.Rounded(new RectangleF(0.5F, 0.5F, Width - 1.5F, Height - 1.5F), 14);
        using SolidBrush fill = new(BackColor);
        using Pen border = new(WorkspaceTheme.Border);
        e.Graphics.FillPath(fill, shape);
        e.Graphics.DrawPath(border, shape);
    }
}

internal sealed class WorkspaceButton : Button
{
    private bool _hovered;
    public WorkspaceButton()
    {
        SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
        FlatStyle = FlatStyle.Flat;
    }
    protected override void OnMouseEnter(EventArgs e) { _hovered = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hovered = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
    protected override void OnPaint(PaintEventArgs e)
    {
        if (Width < 4 || Height < 4) return;
        e.Graphics.Clear(Parent?.BackColor ?? WorkspaceTheme.Surface);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        Color fill = Enabled ? BackColor : WorkspaceTheme.Field;
        if (_hovered && Enabled) fill = ControlPaint.Light(fill, 0.08F);
        using GraphicsPath shape = WorkspaceTheme.Rounded(new RectangleF(0.5F, 0.5F, Width - 1.5F, Height - 1.5F), 8);
        using SolidBrush brush = new(fill);
        using Pen border = new(Enabled ? FlatAppearance.BorderColor : WorkspaceTheme.Border);
        e.Graphics.FillPath(brush, shape);
        e.Graphics.DrawPath(border, shape);
        Rectangle text = new(Padding.Left + 4, 2, Math.Max(1, Width - Padding.Horizontal - 8), Height - 4);
        TextFormatFlags flags = TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis;
        flags |= TextAlign == ContentAlignment.MiddleLeft ? TextFormatFlags.Left : TextFormatFlags.HorizontalCenter;
        TextRenderer.DrawText(e.Graphics, Text, Font, text, Enabled ? ForeColor : Color.FromArgb(149, 160, 176), flags);
        if (Focused && ShowFocusCues) ControlPaint.DrawFocusRectangle(e.Graphics, Rectangle.Inflate(ClientRectangle, -5, -5), WorkspaceTheme.Accent, fill);
    }
}
