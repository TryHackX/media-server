[CmdletBinding()]
param(
    [string] $ConfigPath,
    [ValidateRange(1, 60)]
    [int] $RestartDelaySeconds = 3,
    [ValidateRange(1, 20)]
    [int] $MaximumRapidFailures = 5
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$MediaPython = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
if (-not $ConfigPath) {
    $ConfigPath = Join-Path $ProjectRoot 'config\config.local.toml'
}
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)

if (-not (Test-Path -LiteralPath $MediaPython -PathType Leaf)) {
    throw 'Missing .venv. Run python scripts\install.py first.'
}
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw 'Missing private config\config.local.toml.'
}
$JobType = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace TryHackX
{
    public sealed class KillOnCloseJob : IDisposable
    {
        private const uint JobObjectExtendedLimitInformation = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private IntPtr handle;

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimitInformation
        {
            public BasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo
        {
            public int cb;
            public string reserved;
            public string desktop;
            public string title;
            public int x;
            public int y;
            public int xSize;
            public int ySize;
            public int xCountChars;
            public int yCountChars;
            public int fillAttribute;
            public int flags;
            public short showWindow;
            public short reserved2Length;
            public IntPtr reserved2;
            public IntPtr standardInput;
            public IntPtr standardOutput;
            public IntPtr standardError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation
        {
            public IntPtr process;
            public IntPtr thread;
            public uint processId;
            public uint threadId;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcess(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref StartupInfo startupInfo,
            out ProcessInformation processInformation
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            uint informationClass,
            IntPtr information,
            uint informationLength
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        public KillOnCloseJob()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            var information = new ExtendedLimitInformation();
            information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            var length = Marshal.SizeOf(typeof(ExtendedLimitInformation));
            var pointer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(information, pointer, false);
                if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, pointer, (uint)length))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            }
            catch
            {
                CloseHandle(handle);
                handle = IntPtr.Zero;
                throw;
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }
        }

        public void AddProcess(IntPtr processHandle)
        {
            if (handle == IntPtr.Zero || !AssignProcessToJobObject(handle, processHandle))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }

        public int StartProcess(string executable, string arguments, string workingDirectory)
        {
            const uint createSuspended = 0x00000004;
            const uint createNoWindow = 0x08000000;
            var startup = new StartupInfo();
            startup.cb = Marshal.SizeOf(typeof(StartupInfo));
            var commandLine = new StringBuilder("\"" + executable + "\" " + arguments);
            ProcessInformation information;

            if (!CreateProcess(
                executable,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                createSuspended | createNoWindow,
                IntPtr.Zero,
                workingDirectory,
                ref startup,
                out information
            ))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            try
            {
                if (!AssignProcessToJobObject(handle, information.process))
                {
                    var error = Marshal.GetLastWin32Error();
                    TerminateProcess(information.process, 1);
                    throw new Win32Exception(error);
                }
                if (ResumeThread(information.thread) == UInt32.MaxValue)
                {
                    var error = Marshal.GetLastWin32Error();
                    TerminateProcess(information.process, 1);
                    throw new Win32Exception(error);
                }
                return checked((int)information.processId);
            }
            finally
            {
                CloseHandle(information.thread);
                CloseHandle(information.process);
            }
        }

        public void Dispose()
        {
            if (handle != IntPtr.Zero)
            {
                CloseHandle(handle);
                handle = IntPtr.Zero;
            }
            GC.SuppressFinalize(this);
        }

        ~KillOnCloseJob()
        {
            Dispose();
        }
    }
}
'@
Add-Type -TypeDefinition $JobType
$ProcessJob = New-Object TryHackX.KillOnCloseJob
$ServiceArguments = '-m media_server --config "' + $ConfigPath + '" serve'


$FailureWindowMinutes = 10
$RapidFailureSeconds = 30
$Failures = @()

while ($true) {
    $StartedAt = Get-Date
    $ServiceProcessId = $ProcessJob.StartProcess($MediaPython, $ServiceArguments, $ProjectRoot)
    $ServiceProcess = Get-Process -Id $ServiceProcessId -ErrorAction Stop
    $ServiceProcess.WaitForExit()
    $ServiceExitCode = $ServiceProcess.ExitCode
    $StoppedAt = Get-Date
    $RuntimeSeconds = ($StoppedAt - $StartedAt).TotalSeconds

    if ($RuntimeSeconds -ge $RapidFailureSeconds) {
        $Failures = @()
    } else {
        $WindowStart = $StoppedAt.AddMinutes(-$FailureWindowMinutes)
        $Failures = @($Failures | Where-Object { $_ -ge $WindowStart })
        $Failures += $StoppedAt
    }

    if ($Failures.Count -ge $MaximumRapidFailures) {
        Write-Error "Transfer service stopped $($Failures.Count) times in $FailureWindowMinutes minutes; supervisor exits with code $ServiceExitCode."
        exit 1
    }

    Start-Sleep -Seconds $RestartDelaySeconds
}
