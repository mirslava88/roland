$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Keep stdout machine-readable.  The Electron parent speaks one JSON object per
# line and must never have to guess whether a line came from PowerShell itself.
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Pdm.NativeWindows
{
    public sealed class RectInfo
    {
        public int x { get; set; }
        public int y { get; set; }
        public int width { get; set; }
        public int height { get; set; }
    }

    public sealed class WindowInfo
    {
        public string hwnd { get; set; }
        public string ownerHwnd { get; set; }
        public int pid { get; set; }
        public uint threadId { get; set; }
        public int zOrder { get; set; }
        public string title { get; set; }
        public string className { get; set; }
        public string processName { get; set; }
        public string processPath { get; set; }
        public bool visible { get; set; }
        public bool minimized { get; set; }
        public bool maximized { get; set; }
        public bool cloaked { get; set; }
        public bool hung { get; set; }
        public bool toolWindow { get; set; }
        public bool appWindow { get; set; }
        public bool noActivate { get; set; }
        public RectInfo bounds { get; set; }
        public RectInfo normalBounds { get; set; }
    }

    public sealed class RestoreResult
    {
        public string hwnd { get; set; }
        public bool valid { get; set; }
        public bool requested { get; set; }
        public bool wasMinimized { get; set; }
        public bool minimized { get; set; }
        public bool visible { get; set; }
        public bool activated { get; set; }
        public bool foreground { get; set; }
    }

    public sealed class FullscreenResult
    {
        public string hwnd { get; set; }
        public bool valid { get; set; }
        public bool wasFullscreen { get; set; }
        public bool requested { get; set; }
        public bool fullscreen { get; set; }
        public bool foreground { get; set; }
    }

    public static class WindowApi
    {
        private const int GWL_EXSTYLE = -20;
        private const long WS_EX_TOOLWINDOW = 0x00000080L;
        private const long WS_EX_APPWINDOW = 0x00040000L;
        private const long WS_EX_NOACTIVATE = 0x08000000L;
        private const uint GW_OWNER = 4;
        private const uint DWMWA_CLOAKED = 14;
        private const int SW_SHOWNOACTIVATE = 4;
        private const int SW_RESTORE = 9;
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_SHOWWINDOW = 0x0040;
        private static readonly IntPtr HWND_TOP = IntPtr.Zero;
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        private const uint MONITOR_DEFAULTTONEAREST = 2;
        private const byte VK_F11 = 0x7A;
        private const uint KEYEVENTF_KEYUP = 0x0002;

        [return: MarshalAs(UnmanagedType.Bool)]
        private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct WINDOWPLACEMENT
        {
            public int length;
            public int flags;
            public int showCmd;
            public POINT ptMinPosition;
            public POINT ptMaxPosition;
            public RECT rcNormalPosition;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
        }

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsWindowVisible(IntPtr hwnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsIconic(IntPtr hwnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsZoomed(IntPtr hwnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsHungAppWindow(IntPtr hwnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowTextLength(IntPtr hwnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hwnd, StringBuilder className, int maxCount);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

        [DllImport("user32.dll")]
        private static extern IntPtr GetWindow(IntPtr hwnd, uint command);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT placement);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ShowWindowAsync(IntPtr hwnd, int command);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetForegroundWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool BringWindowToTop(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

        [DllImport("user32.dll")]
        private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetWindowPos(
            IntPtr hwnd,
            IntPtr insertAfter,
            int x,
            int y,
            int width,
            int height,
            uint flags);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
        private static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
        private static extern IntPtr GetWindowLong32(IntPtr hwnd, int index);

        [DllImport("dwmapi.dll")]
        private static extern int DwmGetWindowAttribute(
            IntPtr hwnd,
            uint attribute,
            out int value,
            int valueSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(
            uint desiredAccess,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
            uint processId);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryFullProcessImageName(
            IntPtr process,
            uint flags,
            StringBuilder executableName,
            ref int size);

        [DllImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        private static ulong ToUInt64(IntPtr value)
        {
            return unchecked((ulong)value.ToInt64());
        }

        private static IntPtr ToIntPtr(ulong value)
        {
            return new IntPtr(unchecked((long)value));
        }

        private static long GetExtendedStyle(IntPtr hwnd)
        {
            IntPtr value = IntPtr.Size == 8
                ? GetWindowLongPtr64(hwnd, GWL_EXSTYLE)
                : GetWindowLong32(hwnd, GWL_EXSTYLE);
            return value.ToInt64();
        }

        private static bool IsCloaked(IntPtr hwnd)
        {
            try
            {
                int value;
                int result = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out value, sizeof(int));
                return result == 0 && value != 0;
            }
            catch (DllNotFoundException) { return false; }
            catch (EntryPointNotFoundException) { return false; }
        }

        private static string ReadTitle(IntPtr hwnd)
        {
            int length = GetWindowTextLength(hwnd);
            if (length <= 0) return String.Empty;
            StringBuilder text = new StringBuilder(length + 1);
            GetWindowText(hwnd, text, text.Capacity);
            return text.ToString();
        }

        private static string ReadClassName(IntPtr hwnd)
        {
            StringBuilder name = new StringBuilder(512);
            GetClassName(hwnd, name, name.Capacity);
            return name.ToString();
        }

        private static string ReadProcessName(uint pid)
        {
            try
            {
                using (Process process = Process.GetProcessById(unchecked((int)pid)))
                    return process.ProcessName;
            }
            catch { return String.Empty; }
        }

        private static string ReadProcessPath(uint pid)
        {
            // PROCESS_QUERY_LIMITED_INFORMATION works for ordinary desktop and
            // packaged applications without requiring administrator rights.
            IntPtr process = IntPtr.Zero;
            try
            {
                process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                if (process != IntPtr.Zero)
                {
                    int capacity = 32768;
                    StringBuilder path = new StringBuilder(capacity);
                    if (QueryFullProcessImageName(process, 0, path, ref capacity))
                        return path.ToString();
                }
            }
            catch { }
            finally
            {
                if (process != IntPtr.Zero) CloseHandle(process);
            }

            // Keep a best-effort fallback for older Windows environments.
            try
            {
                using (Process fallback = Process.GetProcessById(unchecked((int)pid)))
                    return fallback.MainModule == null ? String.Empty : fallback.MainModule.FileName;
            }
            catch { return String.Empty; }
        }

        private static RectInfo ToRectInfo(RECT rect)
        {
            return new RectInfo
            {
                x = rect.Left,
                y = rect.Top,
                width = Math.Max(0, rect.Right - rect.Left),
                height = Math.Max(0, rect.Bottom - rect.Top)
            };
        }

        private static bool IsFullscreen(IntPtr hwnd)
        {
            RECT bounds;
            if (!IsWindow(hwnd) || IsIconic(hwnd) || !GetWindowRect(hwnd, out bounds)) return false;
            IntPtr monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            if (monitor == IntPtr.Zero) return false;
            MONITORINFO info = new MONITORINFO();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (!GetMonitorInfo(monitor, ref info)) return false;
            const int tolerance = 2;
            return
                Math.Abs(bounds.Left - info.rcMonitor.Left) <= tolerance &&
                Math.Abs(bounds.Top - info.rcMonitor.Top) <= tolerance &&
                Math.Abs(bounds.Right - info.rcMonitor.Right) <= tolerance &&
                Math.Abs(bounds.Bottom - info.rcMonitor.Bottom) <= tolerance;
        }

        private static bool ForceForeground(IntPtr hwnd)
        {
            IntPtr foreground = GetForegroundWindow();
            uint ignored;
            uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignored);
            uint targetThread = GetWindowThreadProcessId(hwnd, out ignored);
            uint currentThread = GetCurrentThreadId();
            bool attachedForeground = false;
            bool attachedTarget = false;
            try
            {
                if (foregroundThread != 0 && foregroundThread != currentThread)
                    attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
                if (targetThread != 0 && targetThread != currentThread)
                    attachedTarget = AttachThreadInput(currentThread, targetThread, true);
                SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                BringWindowToTop(hwnd);
                SetForegroundWindow(hwnd);
                return GetForegroundWindow() == hwnd;
            }
            finally
            {
                if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
                if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
            }
        }

        public static WindowInfo[] Enumerate()
        {
            List<WindowInfo> windows = new List<WindowInfo>();
            int zOrder = 0;
            EnumWindowsProc callback = delegate(IntPtr hwnd, IntPtr ignored)
            {
                try
                {
                    uint pid;
                    uint threadId = GetWindowThreadProcessId(hwnd, out pid);
                    long exStyle = GetExtendedStyle(hwnd);
                    IntPtr owner = GetWindow(hwnd, GW_OWNER);

                    RECT bounds = new RECT();
                    GetWindowRect(hwnd, out bounds);
                    WINDOWPLACEMENT placement = new WINDOWPLACEMENT();
                    placement.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
                    bool hasPlacement = GetWindowPlacement(hwnd, ref placement);

                    windows.Add(new WindowInfo
                    {
                        hwnd = ToUInt64(hwnd).ToString(),
                        ownerHwnd = owner == IntPtr.Zero ? null : ToUInt64(owner).ToString(),
                        pid = unchecked((int)pid),
                        threadId = threadId,
                        zOrder = zOrder++,
                        title = ReadTitle(hwnd),
                        className = ReadClassName(hwnd),
                        processName = ReadProcessName(pid),
                        processPath = ReadProcessPath(pid),
                        visible = IsWindowVisible(hwnd),
                        minimized = IsIconic(hwnd),
                        maximized = IsZoomed(hwnd),
                        cloaked = IsCloaked(hwnd),
                        hung = IsHungAppWindow(hwnd),
                        toolWindow = (exStyle & WS_EX_TOOLWINDOW) != 0,
                        appWindow = (exStyle & WS_EX_APPWINDOW) != 0,
                        noActivate = (exStyle & WS_EX_NOACTIVATE) != 0,
                        bounds = ToRectInfo(bounds),
                        normalBounds = hasPlacement ? ToRectInfo(placement.rcNormalPosition) : ToRectInfo(bounds)
                    });
                }
                catch
                {
                    // A window may disappear between EnumWindows and inspection.
                    // One racing HWND must not invalidate the entire snapshot.
                }
                return true;
            };

            if (!EnumWindows(callback, IntPtr.Zero))
            {
                int error = Marshal.GetLastWin32Error();
                throw new InvalidOperationException("EnumWindows failed with Win32 error " + error + " after " + windows.Count + " windows");
            }
            GC.KeepAlive(callback);
            return windows.ToArray();
        }

        public static RestoreResult Restore(ulong handle, bool activate)
        {
            IntPtr hwnd = ToIntPtr(handle);
            RestoreResult result = new RestoreResult
            {
                hwnd = handle.ToString(),
                valid = IsWindow(hwnd)
            };
            if (!result.valid) return result;

            result.wasMinimized = IsIconic(hwnd);
            bool visible = IsWindowVisible(hwnd);
            if (result.wasMinimized)
            {
                // Adding an item uses no native action at all. Restore is only
                // called by explicit TAKE; activate=true also hands control to
                // the selected application after it leaves the taskbar.
                ShowWindowAsync(hwnd, activate ? SW_RESTORE : SW_SHOWNOACTIVATE);
                result.requested = true;
            }
            else if (activate && visible)
            {
                SetForegroundWindow(hwnd);
                result.requested = true;
            }

            // ShowWindowAsync is intentionally asynchronous.  Wait briefly so
            // a subsequent desktopCapturer snapshot sees the restored HWND.
            if (result.wasMinimized)
            {
                for (int attempt = 0; attempt < 30 && IsWindow(hwnd) && IsIconic(hwnd); attempt++)
                    Thread.Sleep(25);
            }

            result.valid = IsWindow(hwnd);
            result.minimized = result.valid && IsIconic(hwnd);
            result.visible = result.valid && IsWindowVisible(hwnd);
            if (activate && result.valid && !result.minimized)
            {
                // SetForegroundWindow can be rejected by Windows foreground
                // locking when called from the helper process. Raising the
                // restored HWND in the normal z-order first still guarantees
                // that Word/Excel is visibly expanded above PDM; the explicit
                // foreground request then transfers keyboard/mouse control on
                // systems where Windows grants it.
                SetWindowPos(
                    hwnd,
                    HWND_TOP,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                BringWindowToTop(hwnd);
                result.activated = SetForegroundWindow(hwnd);
                Thread.Sleep(50);
                result.foreground = GetForegroundWindow() == hwnd;
            }
            return result;
        }

        public static FullscreenResult EnsureFullscreen(ulong handle)
        {
            IntPtr hwnd = ToIntPtr(handle);
            FullscreenResult result = new FullscreenResult
            {
                hwnd = handle.ToString(),
                valid = IsWindow(hwnd)
            };
            if (!result.valid) return result;

            result.wasFullscreen = IsFullscreen(hwnd);
            result.fullscreen = result.wasFullscreen;
            if (result.wasFullscreen) return result;

            if (IsIconic(hwnd))
            {
                ShowWindowAsync(hwnd, SW_RESTORE);
                for (int attempt = 0; attempt < 30 && IsWindow(hwnd) && IsIconic(hwnd); attempt++)
                    Thread.Sleep(25);
            }

            result.foreground = ForceForeground(hwnd);
            Thread.Sleep(75);
            result.foreground = GetForegroundWindow() == hwnd;
            // Never let F11 leak into PDM or another application when Windows
            // refuses to foreground the selected browser.
            if (!result.foreground) return result;
            // F11 is intentionally emitted only after checking the monitor
            // bounds, so taking an already-fullscreen browser never toggles it
            // back to windowed mode.
            keybd_event(VK_F11, 0, 0, UIntPtr.Zero);
            Thread.Sleep(30);
            keybd_event(VK_F11, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            result.requested = true;

            for (int attempt = 0; attempt < 20 && IsWindow(hwnd) && !IsFullscreen(hwnd); attempt++)
                Thread.Sleep(50);
            result.valid = IsWindow(hwnd);
            result.fullscreen = result.valid && IsFullscreen(hwnd);
            result.foreground = result.valid && GetForegroundWindow() == hwnd;
            return result;
        }

        public static FullscreenResult ExitFullscreen(ulong handle)
        {
            IntPtr hwnd = ToIntPtr(handle);
            FullscreenResult result = new FullscreenResult
            {
                hwnd = handle.ToString(),
                valid = IsWindow(hwnd)
            };
            if (!result.valid) return result;

            // A minimized browser keeps its internal F11 state even though its
            // current native bounds no longer cover the monitor. Restore it
            // first so the fullscreen check and the matching F11 are reliable.
            if (IsIconic(hwnd))
            {
                ShowWindowAsync(hwnd, SW_RESTORE);
                for (int attempt = 0; attempt < 30 && IsWindow(hwnd) && IsIconic(hwnd); attempt++)
                    Thread.Sleep(25);
            }

            result.wasFullscreen = IsFullscreen(hwnd);
            result.fullscreen = result.wasFullscreen;
            if (!result.wasFullscreen) return result;

            result.foreground = ForceForeground(hwnd);
            Thread.Sleep(75);
            result.foreground = GetForegroundWindow() == hwnd;
            if (!result.foreground) return result;

            keybd_event(VK_F11, 0, 0, UIntPtr.Zero);
            Thread.Sleep(30);
            keybd_event(VK_F11, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            result.requested = true;

            for (int attempt = 0; attempt < 20 && IsWindow(hwnd) && IsFullscreen(hwnd); attempt++)
                Thread.Sleep(50);
            result.valid = IsWindow(hwnd);
            result.fullscreen = result.valid && IsFullscreen(hwnd);
            result.foreground = result.valid && GetForegroundWindow() == hwnd;
            return result;
        }
    }
}
'@

$null = Add-Type -TypeDefinition $nativeSource -Language CSharp

function Write-JsonLine {
    param([Parameter(Mandatory = $true)][object]$Value)
    $json = $Value | ConvertTo-Json -Compress -Depth 8
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function ConvertTo-WindowHandle {
    param([Parameter(Mandatory = $true)][object]$Value)
    $text = ([string]$Value).Trim()
    if ($text.StartsWith('0x', [StringComparison]::OrdinalIgnoreCase)) {
        return [Convert]::ToUInt64($text.Substring(2), 16)
    }
    return [UInt64]::Parse($text, [Globalization.CultureInfo]::InvariantCulture)
}

Write-JsonLine ([ordered]@{
    event = 'ready'
    ok = $true
    protocol = 1
    pid = $PID
})

while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ([String]::IsNullOrWhiteSpace($line)) { continue }

    $requestId = $null
    try {
        $request = $line | ConvertFrom-Json
        $requestId = $request.id
        switch ([string]$request.cmd) {
            'list' {
                $windows = @([Pdm.NativeWindows.WindowApi]::Enumerate())
                Write-JsonLine ([ordered]@{
                    id = $requestId
                    ok = $true
                    windows = $windows
                })
            }
            'restore' {
                $handle = ConvertTo-WindowHandle $request.hwnd
                $activate = $false
                if ($null -ne $request.activate) { $activate = [bool]$request.activate }
                $result = [Pdm.NativeWindows.WindowApi]::Restore($handle, $activate)
                Write-JsonLine ([ordered]@{
                    id = $requestId
                    ok = $true
                    result = $result
                })
            }
            'ensure-fullscreen' {
                $handle = ConvertTo-WindowHandle $request.hwnd
                $fullscreenResult = [Pdm.NativeWindows.WindowApi]::EnsureFullscreen($handle)
                Write-JsonLine ([ordered]@{
                    id = $requestId
                    ok = $true
                    fullscreenResult = $fullscreenResult
                })
            }
            'exit-fullscreen' {
                $handle = ConvertTo-WindowHandle $request.hwnd
                $fullscreenResult = [Pdm.NativeWindows.WindowApi]::ExitFullscreen($handle)
                Write-JsonLine ([ordered]@{
                    id = $requestId
                    ok = $true
                    fullscreenResult = $fullscreenResult
                })
            }
            'ping' {
                Write-JsonLine ([ordered]@{ id = $requestId; ok = $true })
            }
            'exit' {
                Write-JsonLine ([ordered]@{ id = $requestId; ok = $true })
                exit 0
            }
            default {
                throw "Unknown command '$($request.cmd)'"
            }
        }
    }
    catch {
        Write-JsonLine ([ordered]@{
            id = $requestId
            ok = $false
            error = $_.Exception.Message
        })
    }
}
