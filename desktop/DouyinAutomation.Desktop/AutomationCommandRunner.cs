using System.Diagnostics;
using System.Text;

namespace DouyinAutomation.Desktop;

internal sealed class AutomationCommandRunner : IDisposable
{
    private readonly string _projectRoot;
    private readonly string _nodeExecutable;
    private readonly object _processSync = new();
    private readonly HashSet<Process> _activeProcesses = [];
    private bool _disposed;

    public AutomationCommandRunner(string projectRoot)
    {
        _projectRoot = projectRoot;
        _nodeExecutable = ResolveNodeExecutable(projectRoot);
    }

    public async Task<CommandResult> RunAsync(IEnumerable<string> arguments, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        List<string> args = arguments.ToList();
        ProcessStartInfo startInfo = BuildStartInfo(args);

        using Process process = new()
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true,
        };

        try
        {
            process.Start();
            RegisterProcess(process);
        }
        catch (Exception error)
        {
            return new CommandResult(
                CommandText: FormatCommand(args),
                ExitCode: -1,
                Stdout: string.Empty,
                Stderr: error.Message);
        }

        Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
        Task<string> stderrTask = process.StandardError.ReadToEndAsync();

        try
        {
            await process.WaitForExitAsync(cancellationToken);
        }
        catch (OperationCanceledException)
        {
            await StopProcessAsync(process, stdoutTask, stderrTask);
            UnregisterProcess(process);
            throw;
        }
        catch
        {
            UnregisterProcess(process);
            throw;
        }

        try
        {
            return new CommandResult(
                CommandText: FormatCommand(args),
                ExitCode: process.ExitCode,
                Stdout: await stdoutTask,
                Stderr: await stderrTask);
        }
        finally
        {
            UnregisterProcess(process);
        }
    }

    public async Task<CommandResult> RunStreamingAsync(
        IEnumerable<string> arguments,
        Action<string> onStdoutLine,
        Action<string> onStderrLine,
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        List<string> args = arguments.ToList();
        ProcessStartInfo startInfo = BuildStartInfo(args);

        using Process process = new()
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true,
        };

        try
        {
            process.Start();
            RegisterProcess(process);
        }
        catch (Exception error)
        {
            return new CommandResult(
                CommandText: FormatCommand(args),
                ExitCode: -1,
                Stdout: string.Empty,
                Stderr: error.Message);
        }

        StringBuilder stdout = new();
        StringBuilder stderr = new();
        Task stdoutTask = ReadLinesAsync(process.StandardOutput, stdout, onStdoutLine, cancellationToken);
        Task stderrTask = ReadLinesAsync(process.StandardError, stderr, onStderrLine, cancellationToken);

        try
        {
            await process.WaitForExitAsync(cancellationToken);
            await Task.WhenAll(stdoutTask, stderrTask);
        }
        catch (OperationCanceledException)
        {
            await StopProcessAsync(process, stdoutTask, stderrTask);
            UnregisterProcess(process);
            throw;
        }
        catch
        {
            UnregisterProcess(process);
            throw;
        }

        try
        {
            return new CommandResult(
                CommandText: FormatCommand(args),
                ExitCode: process.ExitCode,
                Stdout: stdout.ToString(),
                Stderr: stderr.ToString());
        }
        finally
        {
            UnregisterProcess(process);
        }
    }

    public void CancelAll()
    {
        Process[] active;
        lock (_processSync)
        {
            active = [.. _activeProcesses];
        }

        foreach (Process process in active)
        {
            TryKill(process);
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;
        CancelAll();
    }

    private void RegisterProcess(Process process)
    {
        lock (_processSync)
        {
            if (_disposed)
            {
                TryKill(process);
                throw new ObjectDisposedException(nameof(AutomationCommandRunner));
            }
            _activeProcesses.Add(process);
        }
    }

    private void UnregisterProcess(Process process)
    {
        lock (_processSync)
        {
            _activeProcesses.Remove(process);
        }
    }

    private ProcessStartInfo BuildStartInfo(IEnumerable<string> args)
    {
        ProcessStartInfo startInfo = new()
        {
            FileName = _nodeExecutable,
            WorkingDirectory = _projectRoot,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        startInfo.ArgumentList.Add("src/cli.js");
        foreach (string arg in args)
        {
            startInfo.ArgumentList.Add(arg);
        }

        return startInfo;
    }

    private static async Task ReadLinesAsync(
        StreamReader reader,
        StringBuilder sink,
        Action<string> onLine,
        CancellationToken cancellationToken)
    {
        while (true)
        {
            string? line = await reader.ReadLineAsync(cancellationToken);
            if (line is null)
            {
                break;
            }

            sink.AppendLine(line);
            try
            {
                onLine(line);
            }
            catch (Exception error)
            {
                AppLog.Exception("命令输出处理失败", error);
            }
        }
    }

    private static async Task StopProcessAsync(Process process, params Task[] drainTasks)
    {
        TryKill(process);
        try
        {
            await process.WaitForExitAsync(CancellationToken.None);
        }
        catch
        {
            // The process may already have been disposed by a racing shutdown.
        }

        try
        {
            await Task.WhenAll(drainTasks).WaitAsync(TimeSpan.FromSeconds(3));
        }
        catch
        {
            // Best effort pipe draining after cancellation.
        }
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Best effort cleanup.
        }
    }

    private static string FormatCommand(IEnumerable<string> args)
    {
        return "node src/cli.js " + string.Join(" ", args.Select(QuoteIfNeeded));
    }

    private static string ResolveNodeExecutable(string projectRoot)
    {
        string[] candidates =
        [
            // .runtime is user-controlled profile/session data and must never
            // be allowed to override the executable shipped with the product.
            Path.Combine(projectRoot, "runtime", "node.exe"),
            Path.Combine(projectRoot, "runtime", "node", "node.exe"),
            Path.Combine(AppContext.BaseDirectory, "runtime", "node.exe"),
            Path.Combine(AppContext.BaseDirectory, "node.exe"),
        ];

        return candidates.FirstOrDefault(File.Exists) ?? "node";
    }

    private static string QuoteIfNeeded(string value)
    {
        if (value.Contains(' ') || value.Contains(';') || value.Contains('；'))
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        return value;
    }
}

internal sealed record CommandResult(
    string CommandText,
    int ExitCode,
    string Stdout,
    string Stderr);
