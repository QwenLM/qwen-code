using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        Environment.SetEnvironmentVariable("NODE_USE_SYSTEM_CA", "1");
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new QwenWindow());
    }
}

internal sealed class QwenWindow : Form
{
    private readonly string appDir = AppDomain.CurrentDomain.BaseDirectory;
    private readonly RichTextBox transcript = new();
    private readonly TextBox message = new();
    private readonly TextBox workspace = new();
    private readonly TextBox model = new();
    private readonly Button send = new();
    private readonly Button cancel = new();
    private readonly Label status = new();
    private readonly StringBuilder history = new();
    private Process? active;

    public QwenWindow()
    {
        Text = "Qwen Code Desktop";
        Size = new Size(1120, 760);
        MinimumSize = new Size(740, 510);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(20, 22, 32);
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 10);
        var header = new Panel { Dock = DockStyle.Top, Height = 72, BackColor = Color.FromArgb(31, 34, 50) };
        Controls.Add(header);
        header.Controls.Add(new Label { Text = "QWEN  /  Desktop", ForeColor = Color.FromArgb(178, 151, 255), Font = new Font("Segoe UI", 20, FontStyle.Bold), Location = new Point(20, 15), AutoSize = true });
        status.Text = "Ready";
        status.ForeColor = Color.LightGray;
        status.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        status.TextAlign = ContentAlignment.MiddleRight;
        status.SetBounds(850, 23, 230, 25);
        header.Controls.Add(status);
        header.Resize += (_, _) => status.Left = header.ClientSize.Width - status.Width - 18;

        var controls = new Panel { Dock = DockStyle.Top, Height = 58, Padding = new Padding(16, 12, 16, 8) };
        Controls.Add(controls);
        var choose = new Button { Text = "Browse folder", Dock = DockStyle.Right, Width = 120 };
        choose.Click += (_, _) => { using var picker = new FolderBrowserDialog { SelectedPath = workspace.Text }; if (picker.ShowDialog() == DialogResult.OK) workspace.Text = picker.SelectedPath; };
        controls.Controls.Add(choose);
        model.Dock = DockStyle.Right;
        model.Width = 175;
        model.PlaceholderText = "Model (optional)";
        model.BackColor = Color.FromArgb(42, 45, 62);
        model.ForeColor = Color.White;
        controls.Controls.Add(model);
        workspace.Dock = DockStyle.Fill;
        workspace.Text = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        workspace.BackColor = Color.FromArgb(42, 45, 62);
        workspace.ForeColor = Color.White;
        controls.Controls.Add(workspace);

        var bottom = new Panel { Dock = DockStyle.Bottom, Height = 125, Padding = new Padding(16) };
        Controls.Add(bottom);
        send.Text = "Send";
        send.Dock = DockStyle.Right;
        send.Width = 90;
        send.Click += async (_, _) => await SendAsync();
        bottom.Controls.Add(send);
        cancel.Text = "Stop";
        cancel.Dock = DockStyle.Right;
        cancel.Width = 75;
        cancel.Enabled = false;
        cancel.Click += (_, _) => { try { if (active is { HasExited: false }) active.Kill(true); } catch { } };
        bottom.Controls.Add(cancel);
        message.Multiline = true;
        message.AcceptsReturn = true;
        message.ScrollBars = ScrollBars.Vertical;
        message.Dock = DockStyle.Fill;
        message.BackColor = Color.FromArgb(42, 45, 62);
        message.ForeColor = Color.White;
        message.Font = new Font("Segoe UI", 11);
        message.KeyDown += async (_, e) => { if (e.KeyCode == Keys.Enter && !e.Shift) { e.SuppressKeyPress = true; await SendAsync(); } };
        bottom.Controls.Add(message);

        transcript.Dock = DockStyle.Fill;
        transcript.ReadOnly = true;
        transcript.BackColor = Color.FromArgb(20, 22, 32);
        transcript.ForeColor = Color.Gainsboro;
        transcript.BorderStyle = BorderStyle.None;
        transcript.Font = new Font("Consolas", 11);
        Controls.Add(transcript);
        transcript.BringToFront();
        Append("Welcome to Qwen Code Desktop. Select a project folder, enter a prompt, and press Send.\nExisting Qwen authentication settings are reused.\n\n");
        if (!File.Exists(Path.Combine(appDir, "node.exe")) || !File.Exists(Path.Combine(appDir, "dist", "cli.js")))
            Append("ERROR: Extract the entire ZIP; node.exe and dist/cli.js must be beside Qwen.exe.\n");
    }

    private void Append(string value)
    {
        if (IsDisposed) return;
        if (InvokeRequired) { BeginInvoke(new Action<string>(Append), value); return; }
        transcript.AppendText(value);
        transcript.SelectionStart = transcript.TextLength;
        transcript.ScrollToCaret();
    }

    private async Task SendAsync()
    {
        if (active != null || string.IsNullOrWhiteSpace(message.Text)) return;
        string prompt = message.Text.Trim();
        string folder = workspace.Text.Trim();
        if (!Directory.Exists(folder)) { MessageBox.Show("Select an existing project folder."); return; }
        string node = Path.Combine(appDir, "node.exe");
        string cli = Path.Combine(appDir, "dist", "cli.js");
        if (!File.Exists(node) || !File.Exists(cli)) { MessageBox.Show("Missing bundled Qwen files. Extract the complete ZIP."); return; }
        message.Clear();
        Append("\nYOU\n" + prompt + "\n\nQWEN\n");
        send.Enabled = false;
        cancel.Enabled = true;
        status.Text = "Working...";
        var combined = history.Length == 0 ? prompt : history.ToString() + "\nUser: " + prompt;
        var start = new ProcessStartInfo(node) { WorkingDirectory = folder, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        start.ArgumentList.Add(cli);
        start.ArgumentList.Add("-p");
        start.ArgumentList.Add(combined);
        start.ArgumentList.Add("--output-format");
        start.ArgumentList.Add("text");
        if (!string.IsNullOrWhiteSpace(model.Text)) { start.ArgumentList.Add("-m"); start.ArgumentList.Add(model.Text.Trim()); }
        start.Environment["NODE_USE_SYSTEM_CA"] = "1";
        var output = new StringBuilder();
        try
        {
            using var process = new Process { StartInfo = start };
            active = process;
            process.Start();
            Task stdout = Task.Run(async () => { string? line; while ((line = await process.StandardOutput.ReadLineAsync()) != null) { output.AppendLine(line); Append(line + "\n"); } });
            Task stderr = Task.Run(async () => { string? line; while ((line = await process.StandardError.ReadLineAsync()) != null) Append("[log] " + line + "\n"); });
            await Task.WhenAll(stdout, stderr, process.WaitForExitAsync());
            if (process.ExitCode == 0) { history.Append("\nUser: ").Append(prompt).Append("\nAssistant: ").Append(output); Append("\n"); }
            else Append("\nQwen exited with code " + process.ExitCode + ". Check authentication and certificate configuration.\n");
        }
        catch (Exception ex) { Append("\nERROR: " + ex.Message + "\n"); }
        finally { active = null; send.Enabled = true; cancel.Enabled = false; status.Text = "Ready"; }
    }
}
