using System;
using System.Diagnostics;
using System.IO;

internal static class Program
{
    private static int Main(string[] args)
    {
        string directory = AppDomain.CurrentDomain.BaseDirectory;
        string node = Path.Combine(directory, "node.exe");
        string cli = Path.Combine(directory, "dist", "cli.js");
        // Trust the Windows certificate store for HTTPS connections, including
        // enterprise or local TLS inspection certificates installed by the user.
        Environment.SetEnvironmentVariable("NODE_USE_SYSTEM_CA", "1");
        if (!File.Exists(node) || !File.Exists(cli))
        {
            Console.Error.WriteLine("Qwen files missing. Extract the complete ZIP before launching.");
            return 1;
        }

        // Windows Terminal supports Ctrl+V paste into interactive terminal applications.
        // Prefer it when installed; otherwise use the existing Windows console.
        string? terminal = FindWindowsTerminal();
        if (terminal != null)
        {
            var terminalStart = new ProcessStartInfo
            {
                FileName = terminal,
                WorkingDirectory = directory,
                UseShellExecute = false
            };
            terminalStart.ArgumentList.Add("-w");
            terminalStart.ArgumentList.Add("new");
            terminalStart.ArgumentList.Add("--");
            terminalStart.ArgumentList.Add(node);
            terminalStart.ArgumentList.Add(cli);
            foreach (string arg in args) terminalStart.ArgumentList.Add(arg);
            using var terminalProcess = Process.Start(terminalStart);
            return terminalProcess == null ? 1 : 0;
        }

        var start = new ProcessStartInfo
        {
            FileName = node,
            WorkingDirectory = directory,
            UseShellExecute = false
        };
        start.ArgumentList.Add(cli);
        foreach (string arg in args) start.ArgumentList.Add(arg);

        using var child = Process.Start(start);
        if (child == null) return 1;
        child.WaitForExit();
        return child.ExitCode;
    }

    private static string? FindWindowsTerminal()
    {
        string? localAppData = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        if (string.IsNullOrEmpty(localAppData)) return null;
        string candidate = Path.Combine(localAppData, "Microsoft", "WindowsApps", "wt.exe");
        return File.Exists(candidate) ? candidate : null;
    }
}
