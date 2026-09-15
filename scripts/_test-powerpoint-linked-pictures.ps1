$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'powerpoint-linked-pictures.ps1')
if (-not ('PdmOffice.LinkedPicturesGuard' -as [type])) { throw 'Automation helper did not compile' }
if (-not [PdmOffice.LinkedPicturesGuard]::IsPictureWarning('References to external pictures have been blocked')) { throw 'English picture warning missed' }
$taskRussian = -join (0x421,0x441,0x44b,0x43b,0x43a,0x438 | ForEach-Object { [char]$_ })
if (-not [PdmOffice.LinkedPicturesGuard]::IsPictureWarning("$taskRussian " + (-join (0x43d,0x430,0x20,0x432,0x43d,0x435,0x448,0x43d,0x438,0x435,0x20,0x440,0x438,0x441,0x443,0x43d,0x43a,0x438,0x20,0x437,0x430,0x431,0x43b,0x43e,0x43a,0x438,0x440,0x43e,0x432,0x430,0x43d,0x44b | ForEach-Object { [char]$_ })))) { throw 'Russian picture warning missed' }
if ([PdmOffice.LinkedPicturesGuard]::IsPictureWarning('Macros have been disabled')) { throw 'Macro warning authorized' }
foreach ($taskTitle in @('sample - PowerPoint','sample.pptx - Microsoft PowerPoint','sample [Compatibility Mode] - PowerPoint')) {
 if (-not [PdmOffice.LinkedPicturesGuard]::MatchesDocument($taskTitle,'sample.pptx')) { throw 'Exact document missed' }
}
foreach ($taskTitle in @('sample-other - PowerPoint','sample other - PowerPoint','sample - another - PowerPoint','different - PowerPoint')) {
 if ([PdmOffice.LinkedPicturesGuard]::MatchesDocument($taskTitle,'sample.pptx')) { throw 'Different document authorized' }
}
if ($null -ne (Start-PdmLinkedPicturesGuard $PID 'sample.pptx')) { throw 'Non-PowerPoint process authorized' }

# Actual UI Automation providers and InvokePattern on invisible synthetic
# message bars, on separate UI/client threads. No Office or mouse input.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing,UIAutomationClient,UIAutomationTypes,WindowsBase -TypeDefinition @'
using System;
using System.Threading;
using System.Reflection;
using System.Windows.Forms;
using System.Windows.Automation;
public class PictureBarFixture {
    class InvisibleForm : Form { protected override bool ShowWithoutActivation { get { return true; } } }
    public static void Check(string text, bool expected) {
        Form form = null; Button button = null; IntPtr handle = IntPtr.Zero;
        Exception failure = null; int clicks = 0;
        var ready = new ManualResetEvent(false);
        Thread ui = new Thread(() => {
            try {
                form = new InvisibleForm { Opacity=0, ShowInTaskbar=false };
                Panel bar = new Panel { AccessibleName="Warning bar", AccessibleRole=AccessibleRole.Grouping, Dock=DockStyle.Top, Height=100 };
                bar.Controls.Add(new Label { Text=text, AccessibleName=text, Width=300 });
                button = new Button { Text="Enable Content", AccessibleName="Enable Content", Top=30 };
                button.Click += (sender, args) => { Interlocked.Increment(ref clicks); };
                bar.Controls.Add(button); form.Controls.Add(bar);
                form.Shown += (sender, args) => { handle = button.Handle; ready.Set(); };
                Application.Run(form);
            } catch (Exception e) { failure=e; ready.Set(); }
        });
        ui.SetApartmentState(ApartmentState.STA); ui.IsBackground=true; ui.Start();
        if (!ready.WaitOne(5000)) throw new Exception("Synthetic UI did not start");
        try {
            if (failure != null) throw failure;
            Thread client = new Thread(() => {
                try {
                    Type guardType = null;
                    foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies()) {
                        guardType = assembly.GetType("PdmOffice.LinkedPicturesGuard");
                        if (guardType != null) break;
                    }
                    using (var guard = (IDisposable)Activator.CreateInstance(guardType, new object[] { 0, 0L, "sample.pptx", false, 0L })) {
                        AutomationElement element = AutomationElement.FromHandle(handle);
                        MethodInfo allow = guardType.GetMethod("AllowedBar", BindingFlags.NonPublic | BindingFlags.Instance);
                        bool actual = (bool)allow.Invoke(guard, new object[] { element });
                        if (actual != expected) throw new Exception("Message bar authorization mismatch: " + text);
                        if (actual) ((InvokePattern)element.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
                    }
                } catch (Exception e) { failure=e; }
            });
            client.SetApartmentState(ApartmentState.MTA); client.IsBackground=true; client.Start();
            if (!client.Join(5000)) throw new Exception("UI Automation timed out");
            if (failure != null) throw failure;
            if (clicks != (expected ? 1 : 0)) throw new Exception("Wrong synthetic button click count");
        } finally {
            if (form != null && form.IsHandleCreated) form.BeginInvoke(new Action(() => form.Close()));
            ui.Join(1000); ready.Dispose();
        }
    }
}
'@
[PictureBarFixture]::Check('References to external pictures have been blocked', $true)
[PictureBarFixture]::Check('Macros have been disabled', $false)
[PictureBarFixture]::Check('References to external pictures have been blocked; macros have been disabled', $false)
[PictureBarFixture]::Check('Protected View', $false)

Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
$taskDirectory = Join-Path ([IO.Path]::GetTempPath()) ('pdm-linked-pictures-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskDirectory | Out-Null
try {
 foreach ($taskCase in @(
  @{Name='linked';Mode='External';Type='image';Expected=$true},
  @{Name='embedded';Mode='Internal';Type='image';Expected=$false},
  @{Name='hyperlink';Mode='External';Type='hyperlink';Expected=$false},
  @{Name='disguised-macro';Mode='External';Type='image';Expected=$false;Vba=$true}
 )) {
  $taskPath = Join-Path $taskDirectory ($taskCase.Name + '.pptx')
  $taskZip = [IO.Compression.ZipFile]::Open($taskPath,[IO.Compression.ZipArchiveMode]::Create)
  try {
   if ($taskCase.Vba) { $null = $taskZip.CreateEntry('ppt/vbaProject.bin') }
   $taskEntry = $taskZip.CreateEntry('ppt/slides/_rels/slide1.xml.rels')
   $taskWriter = New-Object IO.StreamWriter($taskEntry.Open())
   try { $taskWriter.Write('<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/' + $taskCase.Type + '" TargetMode="' + $taskCase.Mode + '" Target="https://example.invalid/image.png"/></Relationships>') }
   finally { $taskWriter.Dispose() }
  } finally { $taskZip.Dispose() }
  if ((Test-PdmLinkedPictures $taskPath) -ne $taskCase.Expected) { throw 'Relationship preflight mismatch' }
 }
 $taskMacroPath = Join-Path $taskDirectory 'linked.pptm'
 Copy-Item -LiteralPath (Join-Path $taskDirectory 'linked.pptx') -Destination $taskMacroPath
 if (Test-PdmLinkedPictures $taskMacroPath) { throw 'Macro-capable extension authorized' }
 # A missing UIA helper must preserve ordinary hidden opening and ReadOnly.
 function Start-PdmLinkedPicturesGuard { return $null }
 function Hide-PPEditor {}
 $taskPresentation = [PSCustomObject]@{Marker='opened'}
 $taskCollection = [PSCustomObject]@{}
 $taskCollection | Add-Member ScriptMethod Open { param($path,$readOnly,$untitled,$window) $script:taskOpenArgs=@($path,$readOnly,$untitled,$window); return $taskPresentation }
 $taskPpt = [PSCustomObject]@{Presentations=$taskCollection}
 $script:pptOwnedByRoland=$true
 $script:pptOwnedProcessId=0
 $script:commandLinkedPicturesGuard=$null
 $taskPath=Join-Path $taskDirectory 'linked.pptx'
 if ((Open-PdmPowerPointPresentation $taskPpt $taskPath -1 0).Marker -ne 'opened') { throw 'Open result lost' }
 if (($script:taskOpenArgs[1..3] -join ',') -ne '-1,0,0') { throw 'Fallback changed opening flags' }
} finally {
 # Exact freshly generated test directory only, never a presentation cache.
 Remove-Item -LiteralPath $taskDirectory -Recurse -Force
}
Write-Output 'PASS: linked-picture helper compilation, RU/EN warnings, document/process isolation, real UIA Invoke, macro/mixed/protected rejection, relationships and hidden-open fallback'
