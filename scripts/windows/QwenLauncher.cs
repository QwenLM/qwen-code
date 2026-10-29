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
        if (!File.Exists(node) || !File.Exists(cli))
        {
            Console.Error.WriteLine("Qwen files missing. Extract the complete ZIP before launching.");
            return 1;
        }

        var start = new ProcessStartInfo {
            FileName = node,
            WorkingDirectory = directory,
            UseShellExecute = false
        };
        start.ArgumentList.Add(cli);
        foreach (string arg in args) start.ArgumentList.Add(arg);

        using (var child = Process.Start(start))
        {
            if (child == null) return 1;
            child.WaitForExit();
            return child.ExitCode;
        }
    }
}
