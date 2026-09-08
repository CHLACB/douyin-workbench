using System.Diagnostics;
using System.Runtime.InteropServices;

namespace DouyinAutomation.Desktop;

internal static class Program
{
    private const string SingleInstanceName = @"Local\DouyinAutomation.Desktop.Singleton";

    [STAThread]
    private static void Main()
    {
        using Mutex instanceMutex = new(initiallyOwned: true, SingleInstanceName, out bool isFirstInstance);
        if (!isFirstInstance)
        {
            BringExistingInstanceToFront();
            MessageBox.Show(
                "抖音自动化控制台已经在运行。",
                "抖音自动化",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, args) => HandleFatalException("界面线程未处理异常", args.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
            AppLog.Error("进程未处理异常", args.ExceptionObject?.ToString() ?? "未知异常");
        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            AppLog.Exception("后台任务未观察异常", args.Exception);
            args.SetObserved();
        };

        try
        {
            Application.Run(new MainForm(ProjectRootResolver.Resolve()));
        }
        catch (Exception error)
        {
            HandleFatalException("应用程序启动失败", error);
        }
    }

    private static void HandleFatalException(string title, Exception error)
    {
        AppLog.Exception(title, error);
        try
        {
            MessageBox.Show(
                $"{error.Message}\n\n详细信息已写入：\n{AppLog.FilePath}",
                title,
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        catch
        {
            // Nothing else is safe to do at this point.
        }
    }

    private static void BringExistingInstanceToFront()
    {
        try
        {
            int currentId = Environment.ProcessId;
            using Process? existing = Process.GetProcessesByName("DouyinAutomation.Desktop")
                .FirstOrDefault(process => process.Id != currentId && process.MainWindowHandle != IntPtr.Zero);
            if (existing is null)
            {
                return;
            }

            ShowWindow(existing.MainWindowHandle, 9);
            SetForegroundWindow(existing.MainWindowHandle);
        }
        catch
        {
            // The information dialog still prevents a duplicate instance.
        }
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr window);
}

internal static class ProjectRootResolver
{
    public static string Resolve()
    {
        string? current = Directory.GetCurrentDirectory();
        string? resolved = FindProjectRoot(current);
        if (resolved is not null)
        {
            return resolved;
        }

        resolved = FindProjectRoot(AppContext.BaseDirectory);
        if (resolved is not null)
        {
            return resolved;
        }

        return Directory.GetCurrentDirectory();
    }

    private static string? FindProjectRoot(string? start)
    {
        if (string.IsNullOrWhiteSpace(start))
        {
            return null;
        }

        DirectoryInfo? directory = new(start);
        while (directory is not null)
        {
            string cli = Path.Combine(directory.FullName, "src", "cli.js");
            string packageJson = Path.Combine(directory.FullName, "package.json");
            if (File.Exists(cli) && File.Exists(packageJson))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        return null;
    }
}
