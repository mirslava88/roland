param(
    [int]$DisplayX = 0,
    [int]$DisplayY = 0,
    [int]$DisplayWidth = 1920,
    [int]$DisplayHeight = 1080,
    [string]$DataFile = ""
)

if (-not $DataFile) {
    Write-Error "DataFile parameter is required"
    exit 1
}

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms

$code = @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Threading;

public class TimerOverlay
{
    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOACTIVATE = 0x0010;

    private Window window;
    private IntPtr windowHwnd = IntPtr.Zero;
    private TextBlock text;
    private Border border;
    private string dataFile;
    private string lastContent = "";
    private double scale = 1.0;
    private int lastPositionRevision = -1;
    private int targetDisplayX;
    private int targetDisplayY;
    private int targetDisplayWidth;
    private int targetDisplayHeight;

    public static void EnablePerMonitorDpiAwareness()
    {
        // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4. The process call
        // can already be locked by WPF assembly initialization; the thread
        // call still guarantees physical-pixel SetWindowPos coordinates.
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch {}
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch {}
    }

    public void Run(int displayX, int displayY, int displayWidth, int displayHeight, string file)
    {
        dataFile = file;
        targetDisplayX = displayX;
        targetDisplayY = displayY;
        targetDisplayWidth = Math.Max(1, displayWidth);
        targetDisplayHeight = Math.Max(1, displayHeight);

        window = new Window
        {
            WindowStyle = WindowStyle.None,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            Topmost = true,
            ShowInTaskbar = false,
            ResizeMode = ResizeMode.NoResize,
            SizeToContent = SizeToContent.WidthAndHeight,
            Left = displayX,
            Top = displayY
        };

        text = new TextBlock
        {
            Text = " --:-- ",
            FontFamily = new FontFamily("Consolas"),
            FontSize = 48,
            FontWeight = FontWeights.Bold,
            Foreground = Brushes.White,
            MinWidth = 220,
            TextAlignment = TextAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            Effect = new DropShadowEffect
            {
                Color = Colors.Black,
                ShadowDepth = 2,
                BlurRadius = 8,
                Opacity = 0.8
            }
        };

        border = new Border
        {
            Background = new SolidColorBrush(Color.FromArgb(128, 0, 0, 0)),
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(24, 8, 24, 8),
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            Child = text
        };

        window.Content = border;

        window.MouseLeftButtonDown += (s, e) => { window.DragMove(); };

        window.MouseWheel += (s, e) =>
        {
            scale += e.Delta > 0 ? 0.1 : -0.1;
            if (scale < 0.5) scale = 0.5;
            if (scale > 8.0) scale = 8.0;
            text.FontSize = Math.Round(48 * scale);
            border.Padding = new Thickness(
                Math.Round(24 * scale), Math.Round(8 * scale),
                Math.Round(24 * scale), Math.Round(8 * scale));
        };

        // Get HWND once window is loaded — нужен для SetWindowPos
        // чтобы периодически поднимать таймер поверх Electron overlay.
        // Electron overlay screen-saver level на Windows = HWND_TOPMOST,
        // WPF Topmost=true тоже HWND_TOPMOST — конкурируют, последний
        // raise выигрывает. overlay делает moveTop при show/pin, затирая
        // наш timer — таймер уходит ПОД непрозрачный overlay (с PP snap)
        // = невидим. Периодический SetWindowPos возвращает таймер сверху.
        window.SourceInitialized += (s, e) =>
        {
            windowHwnd = new WindowInteropHelper(window).Handle;
            RepositionToTarget();
        };
        window.ContentRendered += (s, e) => { RepositionToTarget(); };
        window.SizeChanged += (s, e) => { RepositionToTarget(); };

        var timer = new DispatcherTimer();
        timer.Interval = TimeSpan.FromMilliseconds(100);
        timer.Tick += OnTick;
        timer.Start();

        window.ShowDialog();
    }

    private void OnTick(object sender, EventArgs e)
    {
        // Re-assert HWND_TOPMOST каждый tick чтобы таймер оставался поверх
        // Electron overlay (screen-saver level на Windows = тот же
        // HWND_TOPMOST). Без этого overlay.moveTop() при показе/пиннинге
        // уходит таймер ПОД overlay.
        if (windowHwnd != IntPtr.Zero)
        {
            try { SetWindowPos(windowHwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE); } catch {}
        }

        try
        {
            if (!File.Exists(dataFile)) return;

            string line;
            try
            {
                using (var fs = new FileStream(dataFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var reader = new StreamReader(fs))
                {
                    line = reader.ReadToEnd();
                }
            }
            catch { return; }

            if (string.IsNullOrWhiteSpace(line)) return;
            line = line.Trim();
            if (line == lastContent) return;
            lastContent = line;

            // Simple JSON parsing without external libs
            if (line.Contains("\"cmd\"") && line.Contains("\"exit\""))
            {
                window.Close();
                return;
            }

            // The main program display can be reassigned or change DPI while
            // the timer is running. Re-anchor using the real physical HWND
            // size after WPF has applied per-monitor scaling.
            int positionRevision = GetJsonInt(line, "windowPositionRevision");
            if (windowHwnd != IntPtr.Zero &&
                line.Contains("\"displayX\"") &&
                line.Contains("\"displayY\"") &&
                line.Contains("\"displayWidth\"") &&
                line.Contains("\"displayHeight\"") &&
                positionRevision != lastPositionRevision)
            {
                targetDisplayX = GetJsonInt(line, "displayX");
                targetDisplayY = GetJsonInt(line, "displayY");
                targetDisplayWidth = Math.Max(1, GetJsonInt(line, "displayWidth"));
                targetDisplayHeight = Math.Max(1, GetJsonInt(line, "displayHeight"));
                lastPositionRevision = positionRevision;
                RepositionToTarget();
            }

            int remaining = GetJsonInt(line, "remaining");
            int duration = GetJsonInt(line, "duration");

            bool negative = remaining < 0;
            int abs = Math.Abs(remaining);
            int h = abs / 3600;
            int m = (abs % 3600) / 60;
            int s = abs % 60;
            string time = h > 0
                ? string.Format("{0:D2}:{1:D2}:{2:D2}", h, m, s)
                : string.Format("{0:D2}:{1:D2}", m, s);
            if (negative) time = "-" + time;

            text.Text = time;

            bool running = line.Contains("\"running\":true");
            string colorKey;
            string defaultTextColor;
            if (remaining < 0)
            {
                border.Background = new SolidColorBrush(Color.FromArgb(180, 60, 0, 0));
                colorKey = "overtimeTextColor";
                defaultTextColor = "#EF4444";
            }
            else if (remaining <= 60 && remaining >= 0 && running)
            {
                border.Background = new SolidColorBrush(Color.FromArgb(160, 60, 20, 0));
                colorKey = "warningTextColor";
                defaultTextColor = "#FACC15";
            }
            else
            {
                border.Background = new SolidColorBrush(Color.FromArgb(128, 0, 0, 0));
                colorKey = "textColor";
                defaultTextColor = "#FFFFFF";
            }

            // Appearance is controlled by the operator and arrives in the
            // same JSON payload as the time, so changes also apply while paused.
            string textColor = GetJsonString(line, colorKey);
            try
            {
                if (string.IsNullOrWhiteSpace(textColor)) textColor = defaultTextColor;
                text.Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString(textColor));
            }
            catch
            {
                text.Foreground = Brushes.White;
            }

            double textOpacity = GetJsonDouble(line, "textOpacity", 1.0);
            text.Opacity = Math.Max(0.1, Math.Min(1.0, textOpacity));

            if (window.Visibility != Visibility.Visible)
                window.Show();
        }
        catch { }
    }

    private void RepositionToTarget()
    {
        if (windowHwnd == IntPtr.Zero) return;
        try
        {
            RECT rect;
            if (!GetWindowRect(windowHwnd, out rect)) return;
            int windowWidth = Math.Max(1, rect.Right - rect.Left);
            int windowHeight = Math.Max(1, rect.Bottom - rect.Top);
            uint dpi = GetDpiForWindow(windowHwnd);
            if (dpi == 0) dpi = 96;
            int margin = Math.Max(16, (int)Math.Round(40.0 * dpi / 96.0));
            int targetX = targetDisplayX + targetDisplayWidth - windowWidth - margin;
            int targetY = targetDisplayY + targetDisplayHeight - windowHeight - margin;
            targetX = Math.Max(targetDisplayX, Math.Min(targetX, targetDisplayX + targetDisplayWidth - windowWidth));
            targetY = Math.Max(targetDisplayY, Math.Min(targetY, targetDisplayY + targetDisplayHeight - windowHeight));
            SetWindowPos(
                windowHwnd,
                HWND_TOPMOST,
                targetX,
                targetY,
                0,
                0,
                SWP_NOSIZE | SWP_NOACTIVATE
            );
        }
        catch {}
    }

    private static int GetJsonInt(string json, string key)
    {
        string search = "\"" + key + "\":";
        int idx = json.IndexOf(search);
        if (idx < 0) return 0;
        idx += search.Length;
        string num = "";
        bool neg = false;
        while (idx < json.Length)
        {
            char c = json[idx];
            if (c == '-') { neg = true; idx++; continue; }
            if (c >= '0' && c <= '9') { num += c; idx++; continue; }
            if (c == ' ') { idx++; continue; }
            if (num.Length > 0) break;
            idx++;
        }
        int val = 0;
        int.TryParse(num, out val);
        return neg ? -val : val;
    }

    private static string GetJsonString(string json, string key)
    {
        string search = "\"" + key + "\":";
        int idx = json.IndexOf(search);
        if (idx < 0) return "";
        idx += search.Length;
        while (idx < json.Length && char.IsWhiteSpace(json[idx])) idx++;
        if (idx >= json.Length || json[idx] != '"') return "";
        idx++;
        int end = json.IndexOf('"', idx);
        return end >= idx ? json.Substring(idx, end - idx) : "";
    }

    private static double GetJsonDouble(string json, string key, double fallback)
    {
        string search = "\"" + key + "\":";
        int idx = json.IndexOf(search);
        if (idx < 0) return fallback;
        idx += search.Length;
        string num = "";
        while (idx < json.Length)
        {
            char c = json[idx];
            // JSON always uses a dot as the decimal separator. A comma
            // terminates the value and must not become part of the number.
            if ((c >= '0' && c <= '9') || c == '-' || c == '.')
            {
                num += c;
                idx++;
                continue;
            }
            if (char.IsWhiteSpace(c)) { idx++; continue; }
            if (num.Length > 0) break;
            idx++;
        }
        double value;
        if (double.TryParse(num, System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out value)) return value;
        return fallback;
    }
}
"@

Add-Type -TypeDefinition $code -ReferencedAssemblies PresentationFramework, PresentationCore, WindowsBase, System, System.Xaml

[TimerOverlay]::EnablePerMonitorDpiAwareness()
$overlay = New-Object TimerOverlay
$overlay.Run($DisplayX, $DisplayY, $DisplayWidth, $DisplayHeight, $DataFile)
