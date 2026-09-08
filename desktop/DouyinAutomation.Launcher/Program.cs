namespace DouyinAutomation.Launcher;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new LauncherForm(ProjectRootResolver.Resolve()));
    }
}

internal static class ProjectRootResolver
{
    public static string Resolve()
    {
        string? configuredRoot = Environment.GetEnvironmentVariable("DOUYIN_AUTOMATION_HOME");
        IEnumerable<string> starts = new[]
        {
            configuredRoot ?? string.Empty,
            AppContext.BaseDirectory,
            Directory.GetCurrentDirectory(),
        }.Where(path => !string.IsNullOrWhiteSpace(path));

        foreach (string start in starts)
        {
            DirectoryInfo? directory;
            try
            {
                directory = new DirectoryInfo(Path.GetFullPath(start));
            }
            catch
            {
                continue;
            }

            while (directory is not null)
            {
                if (File.Exists(Path.Combine(directory.FullName, "src", "cli.js")) &&
                    File.Exists(Path.Combine(directory.FullName, "package.json")))
                {
                    return directory.FullName;
                }

                directory = directory.Parent;
            }
        }

        return Path.GetFullPath(AppContext.BaseDirectory);
    }
}
