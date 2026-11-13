"""The I/O priority a process reads the disk at (Windows; elsewhere nothing is known or changed).

The staging service is started by a scheduled task, and a task at the default
priority (7) runs at low I/O priority — the service logs it when it starts
(``io_priority``: ``low`` on 09.11.2026) — as does every FFmpeg it starts. A read
at low priority waits for every ordinary reader of the same disk: describing a
film behind one sequential reader took 4.7–26 s at low priority and 0.2–1.2 s at
normal (measured 09.11.2026 on the 14 TB media disk). The background pass gives
a description a minute, and four films of its full run did not get theirs.
"""

from __future__ import annotations

import sys

# NtQueryInformationProcess / NtSetInformationProcess: ProcessIoPriority.
_PROCESS_IO_PRIORITY = 33
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_PROCESS_SET_INFORMATION = 0x0200
NORMAL = 2
_NAMES = {0: "very low", 1: "low", 2: "normal", 3: "high", 4: "critical"}


def _api():  # pragma: no cover - Windows only
    import ctypes
    from ctypes import wintypes

    ntdll = ctypes.WinDLL("ntdll")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    ntdll.NtQueryInformationProcess.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p
    ]
    ntdll.NtQueryInformationProcess.restype = ctypes.c_long
    ntdll.NtSetInformationProcess.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, ctypes.c_ulong]
    ntdll.NtSetInformationProcess.restype = ctypes.c_long
    return ctypes, ntdll, kernel32


def io_priority_level(pid: int | None = None) -> int | None:
    """The I/O priority of this process (or of ``pid``) as Windows numbers it, or None."""
    if sys.platform != "win32":
        return None
    try:
        ctypes, ntdll, kernel32 = _api()
        handle = (
            kernel32.GetCurrentProcess() if pid is None
            else kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        )
        if not handle:
            return None
        try:
            value = ctypes.c_ulong(99)
            status = ntdll.NtQueryInformationProcess(handle, _PROCESS_IO_PRIORITY, ctypes.byref(value), 4, None)
        finally:
            if pid is not None:
                kernel32.CloseHandle(handle)
    except (OSError, AttributeError):
        return None
    return value.value if status == 0 and value.value in _NAMES else None


def io_priority() -> str | None:
    """This process's I/O priority by name, or None where it cannot be read."""
    level = io_priority_level()
    return None if level is None else _NAMES[level]


def set_io_priority(pid: int, level: int) -> bool:
    """Set the I/O priority of ``pid``; whether it worked (never on other systems)."""
    if sys.platform != "win32":
        return False
    try:
        ctypes, ntdll, kernel32 = _api()
        handle = kernel32.OpenProcess(_PROCESS_SET_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            wanted = ctypes.c_ulong(level)
            return ntdll.NtSetInformationProcess(handle, _PROCESS_IO_PRIORITY, ctypes.byref(wanted), 4) == 0
        finally:
            kernel32.CloseHandle(handle)
    except (OSError, AttributeError):
        return False


def read_at_normal_priority(pid: int) -> bool:
    """Lift a process just started to ordinary I/O priority if it was started below it.

    For FFmpeg runs that read a few megabytes somebody is waiting for — the
    description of a film, where a seek lands. The long reads of the background
    pass keep whatever the service runs at. Done right after the process starts —
    FFmpeg takes longer than that to reach the film; a process already at normal
    or above is left alone. Failing changes nothing but the speed of that one read.
    """
    level = io_priority_level(pid)
    if level is None or level >= NORMAL:
        return level is not None
    return set_io_priority(pid, NORMAL)
