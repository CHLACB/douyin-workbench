using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace DouyinAutomation.Desktop;

internal sealed class SettingsStore
{
    private readonly string _settingsDirectory;

    public SettingsStore(string? settingsDirectory = null)
    {
        _settingsDirectory = settingsDirectory ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DouyinAutomation", "Desktop");
    }

    public string SettingsPath => Path.Combine(_settingsDirectory, "settings.json");

    public DesktopSettings Load()
    {
        if (!File.Exists(SettingsPath))
        {
            return new DesktopSettings();
        }

        string json = File.ReadAllText(SettingsPath, Encoding.UTF8);
        StoredDesktopSettings stored = JsonSerializer.Deserialize<StoredDesktopSettings>(json, JsonOptions)
            ?? new StoredDesktopSettings();
        DesktopSettings settings = stored.Settings ?? new DesktopSettings();
        try
        {
            settings.AiApiKey = string.IsNullOrWhiteSpace(stored.ProtectedAiApiKey)
                ? string.Empty
                : WindowsDataProtection.Unprotect(stored.ProtectedAiApiKey);
        }
        catch (Exception error)
        {
            settings.AiApiKey = string.Empty;
            AppLog.Exception("API Key 解密失败，已按空值恢复", error);
        }
        return settings;
    }

    public void Save(DesktopSettings settings)
    {
        Directory.CreateDirectory(_settingsDirectory);
        StoredDesktopSettings stored = new()
        {
            Version = 1,
            Settings = settings with { AiApiKey = string.Empty },
            ProtectedAiApiKey = string.IsNullOrWhiteSpace(settings.AiApiKey)
                ? string.Empty
                : WindowsDataProtection.Protect(settings.AiApiKey),
        };

        string json = JsonSerializer.Serialize(stored, JsonOptions);
        string temporaryPath = SettingsPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporaryPath, json, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            if (File.Exists(SettingsPath))
            {
                try
                {
                    File.Replace(temporaryPath, SettingsPath, destinationBackupFileName: null, ignoreMetadataErrors: true);
                }
                catch (IOException)
                {
                    File.Move(temporaryPath, SettingsPath, overwrite: true);
                }
                catch (PlatformNotSupportedException)
                {
                    File.Move(temporaryPath, SettingsPath, overwrite: true);
                }
            }
            else
            {
                File.Move(temporaryPath, SettingsPath);
            }
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }

    private static JsonSerializerOptions JsonOptions { get; } = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
    };

    private sealed class StoredDesktopSettings
    {
        public int Version { get; set; } = 1;
        public DesktopSettings? Settings { get; set; }
        public string ProtectedAiApiKey { get; set; } = string.Empty;
    }
}

internal sealed record DesktopSettings
{
    public bool CompactRows { get; set; }
    public bool RememberWindow { get; set; } = true;
    public int WindowWidth { get; set; }
    public int WindowHeight { get; set; }
    public string Terms { get; set; } = "情感;日常vlog;恋爱技巧";
    public decimal OpenVideoIndex { get; set; }
    public decimal MinWatchSec { get; set; } = 120;
    public decimal MaxWatchSec { get; set; } = 180;
    public decimal MinBrowseSec { get; set; } = 20;
    public decimal MaxBrowseSec { get; set; } = 45;
    public decimal MinStepDelaySec { get; set; } = 3;
    public decimal MaxStepDelaySec { get; set; } = 7;
    public decimal LoadTimeoutSec { get; set; } = 30;
    public decimal Cycles { get; set; } = 1;
    public decimal Searches { get; set; } = 2;
    public bool CollectCommentsEnabled { get; set; }
    public decimal CommentLimit { get; set; } = 300;
    public decimal CommentTimeoutSec { get; set; } = 600;
    public decimal CommentNoNewScrolls { get; set; } = 8;
    public bool IpFilterEnabled { get; set; }
    public string IpFilter { get; set; } = string.Empty;
    public bool TextFilterEnabled { get; set; }
    public string TextFilter { get; set; } = string.Empty;
    public bool SendCommentsEnabled { get; set; }
    public string CommentPool { get; set; } = "这个角度挺有意思；确实有点共鸣；这条说得挺真实";
    public bool SendPrivateMessagesEnabled { get; set; }
    public string PrivateMessagePool { get; set; } = "你好，看到你的内容很有意思，方便交流一下吗？；你好，想了解一下你的内容方向，可以聊聊吗？";
    public decimal PrivateMessageMaxSend { get; set; } = 3;
    public string AiTopic { get; set; } = string.Empty;
    public string AiTemplate { get; set; } = string.Empty;
    public decimal AiGenerateCount { get; set; } = 5;
    public string AiSystemPrompt { get; set; } = "你是短视频评论和私信文案助手。生成自然、简短、不营销、不夸张的中文内容。";
    public string AiProvider { get; set; } = "DeepSeek";
    public string AiBaseUrl { get; set; } = "https://api.deepseek.com";
    public string AiModel { get; set; } = "deepseek-chat";
    public string AiApiKey { get; set; } = string.Empty;
    public bool AiRewriteEnabled { get; set; }
    public string AiRewriteTarget { get; set; } = "comment";
    public decimal AiTemperature { get; set; } = 0.8M;
}

internal static class WindowsDataProtection
{
    private const int CryptProtectUiForbidden = 0x1;

    public static string Protect(string value)
    {
        byte[] inputBytes = Encoding.UTF8.GetBytes(value);
        DataBlob input = CreateBlob(inputBytes);
        try
        {
            if (!CryptProtectData(ref input, "DouyinAutomation Desktop API Key", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CryptProtectUiForbidden, out DataBlob output))
            {
                throw new InvalidOperationException($"Windows DPAPI 加密失败：{Marshal.GetLastWin32Error()}");
            }

            return Convert.ToBase64String(CopyAndFree(output));
        }
        finally
        {
            ZeroAndFree(input);
            Array.Clear(inputBytes);
        }
    }

    public static string Unprotect(string protectedValue)
    {
        byte[] inputBytes = Convert.FromBase64String(protectedValue);
        DataBlob input = CreateBlob(inputBytes);
        try
        {
            if (!CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CryptProtectUiForbidden, out DataBlob output))
            {
                throw new InvalidOperationException($"Windows DPAPI 解密失败：{Marshal.GetLastWin32Error()}");
            }

            byte[] clearBytes = CopyAndFree(output);
            try
            {
                return Encoding.UTF8.GetString(clearBytes);
            }
            finally
            {
                Array.Clear(clearBytes);
            }
        }
        finally
        {
            ZeroAndFree(input);
            Array.Clear(inputBytes);
        }
    }

    private static DataBlob CreateBlob(byte[] bytes)
    {
        IntPtr pointer = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, pointer, bytes.Length);
        return new DataBlob { ByteCount = bytes.Length, Data = pointer };
    }

    private static byte[] CopyAndFree(DataBlob blob)
    {
        try
        {
            byte[] bytes = new byte[blob.ByteCount];
            if (blob.ByteCount > 0)
            {
                Marshal.Copy(blob.Data, bytes, 0, blob.ByteCount);
            }
            return bytes;
        }
        finally
        {
            if (blob.Data != IntPtr.Zero)
            {
                LocalFree(blob.Data);
            }
        }
    }

    private static void ZeroAndFree(DataBlob blob)
    {
        if (blob.Data == IntPtr.Zero)
        {
            return;
        }

        for (int index = 0; index < blob.ByteCount; index += 1)
        {
            Marshal.WriteByte(blob.Data, index, 0);
        }
        Marshal.FreeHGlobal(blob.Data);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob
    {
        public int ByteCount;
        public IntPtr Data;
    }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptProtectData(
        ref DataBlob dataIn,
        string description,
        IntPtr optionalEntropy,
        IntPtr reserved,
        IntPtr prompt,
        int flags,
        out DataBlob dataOut);

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUnprotectData(
        ref DataBlob dataIn,
        IntPtr description,
        IntPtr optionalEntropy,
        IntPtr reserved,
        IntPtr prompt,
        int flags,
        out DataBlob dataOut);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
}
