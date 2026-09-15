# Only the external-picture warning is auto-approved, at the user's request.
# Never change Trust Center/registry settings or accept macro/ActiveX prompts.
if (-not ('PdmOffice.LinkedPicturesGuard' -as [type])) {
    try {
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase -ErrorAction Stop
    Add-Type -ReferencedAssemblies UIAutomationClient,UIAutomationTypes,WindowsBase -ErrorAction Stop -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Threading;
using System.Text;
using System.Windows.Automation;
using System.Runtime.InteropServices;
namespace PdmOffice {
public sealed class LinkedPicturesGuard : IDisposable {
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
    delegate bool EnumProc(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int size);
    readonly int processId;
    readonly long startTicks;
    readonly string documentName;
    readonly bool allowTransparentEditor;
    readonly long nativeScope;
    readonly Thread worker;
    volatile bool stopped;
    int clicks;
    public int Clicks { get { return Interlocked.CompareExchange(ref clicks, 0, 0); } }
    public string LastError = "";
    public static bool IsPictureWarning(string text) {
        if (String.IsNullOrWhiteSpace(text)) return false;
        return text.IndexOf("\u0421\u0441\u044b\u043b\u043a\u0438 \u043d\u0430 \u0432\u043d\u0435\u0448\u043d\u0438\u0435 \u0440\u0438\u0441\u0443\u043d\u043a\u0438 \u0437\u0430\u0431\u043b\u043e\u043a\u0438\u0440\u043e\u0432\u0430\u043d\u044b", StringComparison.OrdinalIgnoreCase) >= 0 ||
            text.IndexOf("References to external pictures have been blocked", StringComparison.OrdinalIgnoreCase) >= 0;
    }
    public static bool IsOtherActiveWarning(string text) {
        if (text == null) return false;
        string lower = text.ToLowerInvariant();
        return lower.Contains("macro") || lower.Contains("\u043c\u0430\u043a\u0440\u043e\u0441") || lower.Contains("activex") ||
            lower.Contains("protected view") || lower.Contains("\u0437\u0430\u0449\u0438\u0449\u0435\u043d\u043d\u044b\u0439 \u043f\u0440\u043e\u0441\u043c\u043e\u0442\u0440");
    }
    public static bool MatchesDocument(string title, string name) {
        if (String.IsNullOrWhiteSpace(title) || String.IsNullOrWhiteSpace(name)) return false;
        foreach (string candidate in new string[] { name, System.IO.Path.GetFileNameWithoutExtension(name) }) {
            if (title.Equals(candidate, StringComparison.OrdinalIgnoreCase)) return true;
            string expression = "^" + System.Text.RegularExpressions.Regex.Escape(candidate) +
                @"(?:\s*\[[^\]]*\])?\s+-\s+(?:Microsoft\s+)?PowerPoint(?:\s+\([^)]*\))?$";
            if (System.Text.RegularExpressions.Regex.IsMatch(title, expression, System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return true;
        }
        return false;
    }
    public LinkedPicturesGuard(int pid, long ticks, string name, bool owned, long scope) {
        processId = pid; startTicks = ticks; documentName = name; allowTransparentEditor = owned; nativeScope = scope;
        worker = new Thread(Run);
        worker.IsBackground = true;
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();
    }
    bool SameProcess() {
        try { using (Process p = Process.GetProcessById(processId)) {
            return !p.HasExited && p.ProcessName.Equals("POWERPNT", StringComparison.OrdinalIgnoreCase) &&
                p.StartTime.ToUniversalTime().Ticks == startTicks;
        } } catch { return false; }
    }
    bool AllowedBar(AutomationElement button) {
        AutomationElement parent = button;
        for (int level=0; level<3; level++) {
            parent = TreeWalker.ControlViewWalker.GetParent(parent);
            if (parent == null || parent.Current.ControlType == ControlType.Window || parent.Current.ClassName == "PPTFrameClass") return false;
            bool picture = IsPictureWarning(parent.Current.Name);
            bool unsafeWarning = IsOtherActiveWarning(parent.Current.Name);
            AutomationElementCollection labels = parent.FindAll(TreeScope.Descendants, Condition.TrueCondition);
            // A ribbon/editor subtree is not a message bar. Fail closed.
            if (labels.Count > 80) return false;
            foreach (AutomationElement label in labels) {
                picture |= IsPictureWarning(label.Current.Name);
                unsafeWarning |= IsOtherActiveWarning(label.Current.Name);
            }
            if (unsafeWarning) return false;
            if (picture) return true;
        }
        return false;
    }
    void Scan(IntPtr window) {
        uint pid; GetWindowThreadProcessId(window, out pid);
        if (pid != processId) return;
        StringBuilder name = new StringBuilder(512);
        GetClassName(window, name, name.Capacity);
        if (name.ToString() != "PPTFrameClass") return;
        name.Clear(); GetWindowText(window, name, name.Capacity);
        if (!MatchesDocument(name.ToString(), documentName)) return;
        if (stopped || !SameProcess()) return;
        if (allowTransparentEditor) {
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies()) {
                Type native = assembly.GetType("PptDaemon.Native");
                if (native == null) continue;
                native.GetMethod("ExposeEditorForLinkedPictures").Invoke(null, new object[] { window.ToInt64(), (long)processId, nativeScope });
                break;
            }
        }
        AutomationElement root = AutomationElement.FromHandle(window);
        Condition candidates = new OrCondition(
            new PropertyCondition(AutomationElement.NameProperty, "\u0412\u043a\u043b\u044e\u0447\u0438\u0442\u044c \u0441\u043e\u0434\u0435\u0440\u0436\u0438\u043c\u043e\u0435"),
            new PropertyCondition(AutomationElement.NameProperty, "Enable Content"));
        foreach (AutomationElement button in root.FindAll(TreeScope.Descendants, candidates)) {
            if (stopped || !SameProcess() || Clicks >= 3) return;
            if (!button.Current.IsEnabled || !AllowedBar(button)) continue;
            object pattern;
            if (!button.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) continue;
            // Recheck the current file and cancellation immediately before invoking.
            name.Clear(); GetWindowText(window, name, name.Capacity);
            if (stopped || !MatchesDocument(name.ToString(), documentName) || !SameProcess()) return;
            ((InvokePattern)pattern).Invoke();
            Interlocked.Increment(ref clicks);
            return;
        }
    }
    void Run() {
        DateTime deadline = DateTime.UtcNow.AddMinutes(2);
        while (!stopped && DateTime.UtcNow < deadline && Clicks < 3 && SameProcess()) {
            try { EnumWindows((window, data) => { if (!stopped) Scan(window); return !stopped; }, IntPtr.Zero); }
            catch (Exception e) { LastError = e.GetType().Name; }
            for (int i=0; i<10 && !stopped; i++) Thread.Sleep(25);
        }
    }
    public void Dispose() { stopped = true; if (worker != Thread.CurrentThread) worker.Join(300); }
}
}
'@
    } catch { [Console]::Error.WriteLine("PowerPoint linked-picture automation unavailable: $($_.Exception.GetType().Name)") }
}

function Start-PdmLinkedPicturesGuard([long]$ProcessId, [string]$Path, [long]$ExpectedStartTicks = 0) {
    if ($ProcessId -le 0 -or [string]::IsNullOrWhiteSpace($Path)) { return $null }
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        if ($process.ProcessName -ine 'POWERPNT') { return $null }
        if ($ExpectedStartTicks -ne 0 -and $process.StartTime.ToUniversalTime().Ticks -ne $ExpectedStartTicks) { return $null }
        $transparentEditor = $ExpectedStartTicks -gt 0 -and (Test-PdmLinkedPictures $Path)
        $scope = 0L
        if ($transparentEditor) { $scope = [PptDaemon.Native]::BeginLinkedPicturesEditorScope($ProcessId) }
        return New-Object PdmOffice.LinkedPicturesGuard([int]$ProcessId, $process.StartTime.ToUniversalTime().Ticks, [IO.Path]::GetFileName($Path), $transparentEditor, $scope)
    } catch { return $null }
}

function Test-PdmLinkedPictures([string]$Path) {
    # Inspect relationships only. Do not fetch targets or modify the PPTX.
    if ([IO.Path]::GetExtension($Path) -notin @('.pptx','.ppsx','.potx','.pptm','.ppsm','.potm')) { return $false }
    $archive = $null
    try {
        Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
        $archive = [IO.Compression.ZipFile]::OpenRead($Path)
        $total = 0L
        foreach ($entry in $archive.Entries) {
            if (-not $entry.FullName.StartsWith('ppt/') -or -not $entry.FullName.EndsWith('.rels')) { continue }
            $total += $entry.Length
            if ($entry.Length -gt 2MB -or $total -gt 16MB) { return $false }
            $reader = New-Object IO.StreamReader($entry.Open())
            try {
                $settings = New-Object Xml.XmlReaderSettings
                $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
                $settings.XmlResolver = $null
                $xmlReader = [Xml.XmlReader]::Create($reader, $settings)
                try {
                    while ($xmlReader.Read()) {
                        if ($xmlReader.NodeType -eq [Xml.XmlNodeType]::Element -and $xmlReader.LocalName -eq 'Relationship' -and
                            $xmlReader.GetAttribute('TargetMode') -eq 'External' -and $xmlReader.GetAttribute('Type').EndsWith('/image')) { return $true }
                    }
                } finally { $xmlReader.Dispose() }
            } finally { $reader.Dispose() }
        }
    } catch { return $false } finally { if ($archive) { $archive.Dispose() } }
    return $false
}

function Open-PdmPowerPointPresentation($Ppt, [string]$Path, [int]$ReadOnly = 0, [int]$WithWindow = 0) {
    $guard = $null
    try {
        $processId = 0L
        if ($script:pptOwnedByRoland) { $processId = [long]$script:pptOwnedProcessId }
        else { try { $processId = [long][PptDaemon.Native]::GetWindowProcessId((Get-PPEditorHwnd $Ppt)) } catch {} }
        $guard = $script:commandLinkedPicturesGuard
        if (-not $guard) {
            $guard = Start-PdmLinkedPicturesGuard $processId $Path ([long]$script:pptOwnedProcessStartTimeUtcTicks)
            $script:commandLinkedPicturesGuard = $guard
        }
        $linked = Test-PdmLinkedPictures $Path
        # Linked pictures need a document message bar to expose Enable Content.
        # The PDM editor guard already hides frames synchronously. Never create
        # an extra visible document window in a borrowed user's PowerPoint.
        if ($linked -and $guard -and $script:pptOwnedByRoland) { $WithWindow = -1 }
        $presentation = $Ppt.Presentations.Open($Path, $ReadOnly, 0, $WithWindow)
        if ($linked -and $guard) {
            $deadline = [DateTime]::UtcNow.AddMilliseconds(1500)
            while ($guard.Clicks -eq 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
        }
        return $presentation
    } finally {
        if ($script:pptOwnedByRoland) { Hide-PPEditor $Ppt }
    }
}
