# Target window for the manual end-to-end paste test.
#
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI/GBK on this
# machine, and a trailing double-byte character can swallow the next newline.
#
# A plain WinForms form with a multiline textbox. The textbox content is flushed
# to paste-out.txt every 500ms so the driver script can assert on it.
# Launch it with -WindowStyle Hidden so its own console never competes for focus.
#
# Focus stealing: other desktop apps (and the terminal running the test) may take
# the foreground at any moment. Instead of fighting from outside, the driver drops
# a flag file and this form claims the foreground itself on demand - the same
# AttachThreadInput trick the app under test uses.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TargetActivate {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  public static bool ForceForeground(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return false;
    IntPtr fg = GetForegroundWindow();
    uint dummy;
    uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out dummy);
    uint myThread = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != myThread) attached = AttachThreadInput(myThread, fgThread, true);
    bool ok = SetForegroundWindow(hWnd);
    if (attached) AttachThreadInput(myThread, fgThread, false);
    return ok || GetForegroundWindow() == hWnd;
  }
}
"@

$out = Join-Path $PSScriptRoot 'paste-out.txt'
$focusFlag = Join-Path $PSScriptRoot 'focus-now.txt'
$focusDone = Join-Path $PSScriptRoot 'focus-done.txt'
Remove-Item $out, $focusFlag, $focusDone -ErrorAction SilentlyContinue
Set-Content -Path $out -Value '' -Encoding UTF8

$form = New-Object System.Windows.Forms.Form
$form.Text = 'PASTE-TARGET-WINDOW'
$form.Width = 760
$form.Height = 340
$form.StartPosition = 'CenterScreen'

$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.Dock = 'Fill'
$box.Font = New-Object System.Drawing.Font('Consolas', 12)
$form.Controls.Add($box)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({ Set-Content -Path $out -Value $box.Text -Encoding UTF8 })
$timer.Start()

$focusTimer = New-Object System.Windows.Forms.Timer
$focusTimer.Interval = 250
$focusTimer.Add_Tick({
  if (Test-Path $focusFlag) {
    Remove-Item $focusFlag -ErrorAction SilentlyContinue
    [void][TargetActivate]::ForceForeground($form.Handle)
    $box.Focus()
    Set-Content -Path $focusDone -Value '1' -Encoding ASCII
  }
})
$focusTimer.Start()

$form.Add_Shown({ $form.Activate(); $box.Focus() })
[void]$form.ShowDialog()
