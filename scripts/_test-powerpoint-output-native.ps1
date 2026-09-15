$ErrorActionPreference = 'Stop'
$taskTokens = $null
$taskErrors = $null
$taskSource = Join-Path $PSScriptRoot 'powerpoint-daemon.ps1'
$taskAst = [System.Management.Automation.Language.Parser]::ParseFile($taskSource,[ref]$taskTokens,[ref]$taskErrors)
if($taskErrors.Count -gt 0){throw ($taskErrors | Out-String)}
# Compile the exact production interop declarations, not a copied test version.
$taskGuard = $taskAst.EndBlock.Statements | Where-Object {
 $_ -is [System.Management.Automation.Language.IfStatementAst] -and $_.Extent.Text.Contains('Add-Type -ReferencedAssemblies System.Drawing -Name Native')
} | Select-Object -First 1
if(-not $taskGuard){throw 'Native interop guard missing'}
Invoke-Expression $taskGuard.Extent.Text
Add-Type -AssemblyName System.Windows.Forms
$taskOld = New-Object System.Windows.Forms.Form
$taskNew = New-Object System.Windows.Forms.Form
try {
 # Real HWNDs, never shown; no Office or operator window is touched.
 $taskOldHandle = $taskOld.Handle
 $taskNewHandle = $taskNew.Handle
 $taskBefore = New-Object PptDaemon.Native+RECT
 [PptDaemon.Native]::GetWindowRect($taskNewHandle,[ref]$taskBefore) | Out-Null
 $taskForeground = [PptDaemon.Native]::GetForegroundWindow()
 if(-not [PptDaemon.Native]::PromoteWarmedOutput($taskNewHandle,$taskOldHandle)){throw 'Real native batch failed'}
 $taskAfter = New-Object PptDaemon.Native+RECT
 [PptDaemon.Native]::GetWindowRect($taskNewHandle,[ref]$taskAfter) | Out-Null
 if(($taskBefore | ConvertTo-Json -Compress) -ne ($taskAfter | ConvertTo-Json -Compress)){throw 'Batch changed prepared geometry'}
 if([PptDaemon.Native]::GetForegroundWindow() -ne $taskForeground){throw 'Batch stole operator focus'}
 if([PptDaemon.Native]::PromoteWarmedOutput($taskNewHandle,[IntPtr]::Zero)){throw 'Invalid previous HWND was accepted'}
 if([PptDaemon.Native]::PromoteWarmedOutput($taskNewHandle,$taskNewHandle)){throw 'Identical HWNDs were accepted'}
 $taskScope = [PptDaemon.Native]::BeginLinkedPicturesEditorScope($PID)
 if([PptDaemon.Native]::ExposeEditorForLinkedPictures($taskNewHandle.ToInt64(),$PID,$taskScope)){throw 'Non-editor window transparency accepted'}
 [PptDaemon.Native]::RestoreLinkedPicturesEditor()
} finally { $taskOld.Dispose(); $taskNew.Dispose() }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class SyntheticPptEditor {
 delegate IntPtr Proc(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 struct WindowClass { public uint style; public Proc procedure; public int classExtra; public int windowExtra; public IntPtr instance; public IntPtr icon; public IntPtr cursor; public IntPtr brush; public string menu; public string name; }
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern ushort RegisterClass(ref WindowClass windowClass);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowEx(int extendedStyle, string className, string name, int style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
 [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
 [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr window);
 [DllImport("user32.dll")] public static extern bool GetLayeredWindowAttributes(IntPtr window, out uint key, out byte alpha, out uint flags);
 static Proc procedure = DefWindowProc;
 public static IntPtr Create() {
  var windowClass = new WindowClass { name="PPTFrameClass", procedure=procedure };
  RegisterClass(ref windowClass);
  return CreateWindowEx(0,"PPTFrameClass","synthetic - PowerPoint",0xCF0000,100,100,200,100,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
 }
}
'@
$taskEditor = [SyntheticPptEditor]::Create()
try {
 if($taskEditor -eq [IntPtr]::Zero){throw 'Synthetic editor HWND creation failed'}
 $taskForeground = [PptDaemon.Native]::GetForegroundWindow()
 $taskStyle = [PptDaemon.Native]::GetWindowLong($taskEditor,-20)
 $taskBefore = New-Object PptDaemon.Native+RECT
 [PptDaemon.Native]::GetWindowRect($taskEditor,[ref]$taskBefore) | Out-Null
 $taskScope = [PptDaemon.Native]::BeginLinkedPicturesEditorScope($PID)
 if([PptDaemon.Native]::ExposeEditorForLinkedPictures($taskEditor.ToInt64(),($PID+1),$taskScope)){throw 'Foreign editor PID accepted'}
 if(-not [PptDaemon.Native]::ExposeEditorForLinkedPictures($taskEditor.ToInt64(),$PID,$taskScope)){throw 'Invisible accessibility editor failed'}
 [uint32]$taskKey=0; [byte]$taskAlpha=255; [uint32]$taskFlags=0
 if(-not [SyntheticPptEditor]::GetLayeredWindowAttributes($taskEditor,[ref]$taskKey,[ref]$taskAlpha,[ref]$taskFlags) -or $taskAlpha -ne 0){throw 'Editor was not completely transparent'}
 if(-not [PptDaemon.Native]::IsWindowVisible($taskEditor)){throw 'Editor unavailable to accessibility'}
 [PptDaemon.Native]::ShowWindow($taskEditor,0) | Out-Null
 if(-not [PptDaemon.Native]::ExposeEditorForLinkedPictures($taskEditor.ToInt64(),$PID,$taskScope) -or -not [PptDaemon.Native]::IsWindowVisible($taskEditor)){throw 'Re-hidden editor unavailable to the same scope'}
 if(-not [SyntheticPptEditor]::GetLayeredWindowAttributes($taskEditor,[ref]$taskKey,[ref]$taskAlpha,[ref]$taskFlags) -or $taskAlpha -ne 0){throw 'Re-hidden editor lost zero alpha'}
 if([PptDaemon.Native]::GetForegroundWindow() -ne $taskForeground){throw 'Invisible editor stole focus'}
 $taskAfter = New-Object PptDaemon.Native+RECT
 [PptDaemon.Native]::GetWindowRect($taskEditor,[ref]$taskAfter) | Out-Null
 if(($taskBefore | ConvertTo-Json -Compress) -ne ($taskAfter | ConvertTo-Json -Compress)){throw 'Invisible editor changed geometry'}
 [PptDaemon.Native]::RestoreLinkedPicturesEditor()
 if([PptDaemon.Native]::IsWindowVisible($taskEditor)){throw 'Editor remained visible after cleanup'}
 if([PptDaemon.Native]::GetWindowLong($taskEditor,-20) -ne $taskStyle){throw 'Editor styles not restored'}
 if([PptDaemon.Native]::ExposeEditorForLinkedPictures($taskEditor.ToInt64(),$PID,$taskScope)){throw 'Retired worker exposure scope accepted'}
} finally { [PptDaemon.Native]::RestoreLinkedPicturesEditor(); [SyntheticPptEditor]::DestroyWindow($taskEditor) | Out-Null }
foreach($taskName in @('Resolve-ActiveSlideShowWindow','Resolve-PdmSlideShowWindow','Reset-SlideVideoClickState')){
 $taskFunction = $taskAst.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $taskName},$true)
 Invoke-Expression $taskFunction.Extent.Text
}
function Restore-MediaForeground {}
$script:startedSlideVideos = $null
Reset-SlideVideoClickState
if($script:startedSlideVideos -isnot [hashtable]){throw 'Video visit reset did not recreate state'}
$script:activeSlideShowWindow = [PSCustomObject]@{View=$null}
$script:activePresentationPath = ''
$script:activeSlideShowHwnd = 123
if($null -ne (Resolve-PdmSlideShowWindow $null)){throw 'Null slideshow view was accepted'}
if($script:activeSlideShowHwnd -ne 0){throw 'Invalid cached HWND retained'}
$script:activePresentationPath = 'synthetic.pptx'
$script:activeSlideShowWindow = [PSCustomObject]@{Presentation=[PSCustomObject]@{FullName='synthetic.pptx'};View=[PSCustomObject]@{Slide=$null}}
if($null -ne (Resolve-ActiveSlideShowWindow $null 'synthetic.pptx')){throw 'Null slide was accepted by the fallback resolver'}
$script:activePresentationPath = ''
$taskValid = [PSCustomObject]@{View=[PSCustomObject]@{Slide=[PSCustomObject]@{SlideIndex=1}}}
$script:activeSlideShowWindow = $taskValid
if(-not [object]::ReferenceEquals((Resolve-PdmSlideShowWindow $null),$taskValid)){throw 'Valid direct slideshow was lost'}
Write-Output 'PASS: production PowerShell parser/C# compilation, real hidden HWND batch, geometry/focus, invalid HWND rejection, null view and video state reset'
