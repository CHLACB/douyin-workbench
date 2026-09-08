using System.Text;

namespace DouyinAutomation.Desktop;

internal static class AppLog
{
    private const long MaxLogBytes = 2 * 1024 * 1024;
    private const int BackupCount = 3;
    private static readonly object Sync = new();

    public static string DirectoryPath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "DouyinAutomation",
        "Logs");

    public static string FilePath { get; } = Path.Combine(DirectoryPath, "desktop.log");

    public static void Info(string title, string message) => Write("INFO", title, message);

    public static void Error(string title, string message) => Write("ERROR", title, message);

    public static void Exception(string title, Exception error) => Write("FATAL", title, error.ToString());

    private static void Write(string level, string title, string message)
    {
        try
        {
            lock (Sync)
            {
                Directory.CreateDirectory(DirectoryPath);
                RotateIfNeeded();
                string normalized = (message ?? string.Empty).TrimEnd();
                string entry = $"[{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss.fff zzz}] [{level}] {title}{Environment.NewLine}{normalized}{Environment.NewLine}{Environment.NewLine}";
                File.AppendAllText(FilePath, entry, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            }
        }
        catch
        {
            // Logging must never take down the desktop application.
        }
    }

    private static void RotateIfNeeded()
    {
        if (!File.Exists(FilePath) || new FileInfo(FilePath).Length < MaxLogBytes)
        {
            return;
        }

        string oldest = FilePath + $".{BackupCount}";
        if (File.Exists(oldest))
        {
            File.Delete(oldest);
        }

        for (int index = BackupCount - 1; index >= 1; index -= 1)
        {
            string source = FilePath + $".{index}";
            if (File.Exists(source))
            {
                File.Move(source, FilePath + $".{index + 1}", overwrite: true);
            }
        }

        File.Move(FilePath, FilePath + ".1", overwrite: true);
    }
}
