param(
    [int]$X = 100,
    [int]$Y = 100,
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
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

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

    public void Run(int x, int y, string file)
    {
        dataFile = file;

        window = new Window
        {
            WindowStyle = WindowStyle.None,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            Topmost = true,
            ShowInTaskbar = false,
            ResizeMode = ResizeMode.NoResize,
            SizeToContent = SizeToContent.WidthAndHeight,
            Left = x,
            Top = y
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
            if (scale > 4.0) scale = 4.0;
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
        };

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
            if (remaining < 0)
            {
                text.Foreground = new SolidColorBrush(Color.FromRgb(239, 68, 68));
                border.Background = new SolidColorBrush(Color.FromArgb(180, 60, 0, 0));
            }
            else if (remaining <= 60 && remaining >= 0 && running)
            {
                text.Foreground = new SolidColorBrush(Color.FromRgb(250, 204, 21));
                border.Background = new SolidColorBrush(Color.FromArgb(160, 60, 20, 0));
            }
            else
            {
                text.Foreground = Brushes.White;
                border.Background = new SolidColorBrush(Color.FromArgb(128, 0, 0, 0));
            }

            if (window.Visibility != Visibility.Visible)
                window.Show();
        }
        catch { }
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
}
"@

Add-Type -TypeDefinition $code -ReferencedAssemblies PresentationFramework, PresentationCore, WindowsBase, System, System.Xaml

$overlay = New-Object TimerOverlay
$overlay.Run($X, $Y, $DataFile)
