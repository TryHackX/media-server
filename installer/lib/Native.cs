// Native helpers of the TryHackX Media Server wizard. C# 5 only: Windows PowerShell 5.1
// compiles this with the compiler that ships with .NET Framework.
using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace TryHackX.Setup
{
    /// <summary>
    /// Runs one child process and hands its output over line by line.
    ///
    /// PowerShell cannot do this itself from a background runspace: its event
    /// handlers are script blocks, and a script block invoked on a thread-pool
    /// thread has no runspace to run in. Here both streams are read by .NET and
    /// queued; the script only polls the queue. Standard output and standard
    /// error arrive interleaved, in the order they were written.
    /// </summary>
    public sealed class ProcessRunner : IDisposable
    {
        private readonly ConcurrentQueue<string> lines = new ConcurrentQueue<string>();
        private Process process;
        private int openStreams;

        public ConcurrentQueue<string> Lines { get { return lines; } }

        [DllImport("kernel32.dll")]
        private static extern uint GetOEMCP();

        /// <summary>
        /// The code page a console program without a window writes in: the system's OEM page
        /// (852 on Polish Windows), which follows the system locale, not the user's formats.
        /// </summary>
        public static Encoding OemEncoding
        {
            get
            {
                try { return Encoding.GetEncoding((int) GetOEMCP()); }
                catch (Exception) { return Encoding.GetEncoding(CultureInfo.CurrentCulture.TextInfo.OEMCodePage); }
            }
        }

        public void Start(string file, string arguments, string workingDirectory, IDictionary environment,
            byte[] standardInput, bool oemOutput)
        {
            ProcessStartInfo info = new ProcessStartInfo(file, arguments ?? "");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.RedirectStandardInput = true;
            Encoding encoding = oemOutput ? OemEncoding : new UTF8Encoding(false);
            info.StandardOutputEncoding = encoding;
            info.StandardErrorEncoding = encoding;
            if (!string.IsNullOrEmpty(workingDirectory))
            {
                info.WorkingDirectory = workingDirectory;
            }
            if (environment != null)
            {
                foreach (DictionaryEntry entry in environment)
                {
                    info.EnvironmentVariables[Convert.ToString(entry.Key)] = Convert.ToString(entry.Value);
                }
            }
            process = new Process();
            process.StartInfo = info;
            process.OutputDataReceived += OnData;
            process.ErrorDataReceived += OnData;
            openStreams = 2;
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            try
            {
                if (standardInput != null && standardInput.Length > 0)
                {
                    // Bytes, not text: the writer .NET offers would re-encode a password
                    // in the console code page.
                    process.StandardInput.BaseStream.Write(standardInput, 0, standardInput.Length);
                    process.StandardInput.BaseStream.Flush();
                }
                process.StandardInput.Close();
            }
            catch (System.IO.IOException)
            {
                // The child closed its input before reading it; its exit code will say why.
            }
        }

        private void OnData(object sender, DataReceivedEventArgs e)
        {
            if (e.Data == null)
            {
                Interlocked.Decrement(ref openStreams);
            }
            else
            {
                lines.Enqueue(e.Data);
            }
        }

        /// <summary>True once the process has ended and both streams have been read to their end.</summary>
        public bool Finished
        {
            get { return process != null && process.HasExited && Volatile.Read(ref openStreams) <= 0; }
        }

        public bool HasExited { get { return process != null && process.HasExited; } }

        public int ExitCode { get { return process.ExitCode; } }

        public void Kill()
        {
            try
            {
                if (process != null && !process.HasExited)
                {
                    // The whole tree, not only the direct child: Process.Kill on .NET Framework
                    // leaves what the child started (pip's builds, a script's own programs) running.
                    try
                    {
                        var info = new ProcessStartInfo(System.IO.Path.Combine(Environment.SystemDirectory, "taskkill.exe"),
                            "/T /F /PID " + process.Id.ToString(CultureInfo.InvariantCulture));
                        info.CreateNoWindow = true;
                        info.UseShellExecute = false;
                        using (var taskkill = Process.Start(info))
                        {
                            if (taskkill != null) taskkill.WaitForExit(10000);
                        }
                    }
                    catch (System.ComponentModel.Win32Exception) { }
                    if (!process.HasExited)
                    {
                        process.Kill();
                    }
                }
            }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
        }

        public void Dispose()
        {
            if (process != null)
            {
                process.Dispose();
                process = null;
            }
        }
    }

    public static class NativeMethods
    {
        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        private static extern IntPtr GetDC(IntPtr window);

        [DllImport("user32.dll")]
        private static extern int ReleaseDC(IntPtr window, IntPtr dc);

        [DllImport("gdi32.dll")]
        private static extern int GetDeviceCaps(IntPtr dc, int index);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetConsoleWindow();

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr window, int command);

        /// <summary>Horizontal dots per inch of the primary display (96 = 100 %).</summary>
        public static int ScreenDpi()
        {
            IntPtr dc = GetDC(IntPtr.Zero);
            try { return GetDeviceCaps(dc, 88); }
            finally { ReleaseDC(IntPtr.Zero, dc); }
        }

        public static void ShowConsole(bool visible)
        {
            IntPtr console = GetConsoleWindow();
            if (console != IntPtr.Zero)
            {
                ShowWindow(console, visible ? 5 : 0);
            }
        }
    }
}
