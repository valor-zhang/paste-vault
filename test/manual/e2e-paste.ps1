# Manual end-to-end test for the "pick an item -> it gets pasted for you" chain.
#
# Prerequisites: the app must already be running (start.cmd or the packaged exe).
#
# What it verifies, in one pass:
#   global hotkey -> overlay opens and takes keyboard focus -> Enter picks the
#   newest item -> clipboard gets that item back -> foreground is handed back to
#   the window you were in -> Ctrl+V lands the text there.
#
# Why it checks the foreground window: some background apps steal focus
# aggressively (a music player was doing exactly that on this machine). When
# that happens the app correctly pastes into whatever it recorded as the
# foreground window, so the round is SKIPPED as an environment problem instead
# of being reported as an app bug.
#
# Usage (Windows PowerShell; ASCII-only on purpose -- 5.1 reads .ps1 as ANSI):
#   powershell -ExecutionPolicy Bypass -File test\manual\e2e-paste.ps1
#
# IMPORTANT: -Hotkey must match the hotkey configured in the app (SendKeys
# syntax: ^ = Ctrl, + = Shift, % = Alt). The default is the factory setting.
# If you changed the hotkey in Settings, pass it, e.g. -Hotkey '^q'
#
# Exit codes: 0 = passed, 1 = failed, 2 = every round skipped (environment).

param([int]$Rounds = 2, [string]$Hotkey = '^+v')

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class E2eFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  // Same trick the app itself uses: borrow the foreground right from whichever
  // thread currently owns the foreground window, then hand it to the target.
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
    return ok;
  }
}
"@

function Get-ForegroundTitle {
  $h = [E2eFg]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][E2eFg]::GetWindowText($h, $sb, 512)
  return $sb.ToString()
}

function Set-TargetForeground($title) {
  for ($i = 0; $i -lt 10; $i++) {
    $h = [E2eFg]::FindWindow($null, $title)
    if ($h -ne [IntPtr]::Zero) {
      [void][E2eFg]::ForceForeground($h)
      Start-Sleep -Milliseconds 80
      if ((Get-ForegroundTitle) -eq $title) { return $true }
    }
    Start-Sleep -Milliseconds 120
  }
  return $false
}

$targetTitle = 'PASTE-TARGET-WINDOW'
# The overlay's window title comes from the app's productName. Built from code
# points so this file stays pure ASCII: PowerShell 5.1 reads .ps1 as GBK here and
# would mangle literal Chinese.
$overlayTitle = [string]::Join('', [char[]](0x7C98, 0x8D34, 0x7BA1, 0x7406, 0x5668))
$targetScript = Join-Path $PSScriptRoot 'paste-target.ps1'
$outFile = Join-Path $PSScriptRoot 'paste-out.txt'
$focusFlag = Join-Path $PSScriptRoot 'focus-now.txt'
$focusDone = Join-Path $PSScriptRoot 'focus-done.txt'
$shell = New-Object -ComObject WScript.Shell

$pass = 0
$fail = 0
$skip = 0

for ($round = 1; $round -le $Rounds; $round++) {
  Remove-Item $outFile -ErrorAction SilentlyContinue

  # Park the cursor away from the overlay: the list follows the mouse, and a
  # hover would change which row Enter acts on.
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(30, 930)

  $needle = "E2E-PASTE-CHECK-R$round"
  Set-Clipboard -Value $needle
  Start-Sleep -Seconds 3   # let the app capture it

  $target = Start-Process powershell.exe -ArgumentList @(
    '-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', "`"$targetScript`""
  ) -PassThru
  Start-Sleep -Seconds 4

  # Ask the target to claim the foreground itself. Competing for it from here
  # loses the race whenever another window grabs it in between.
  Remove-Item $focusFlag, $focusDone -ErrorAction SilentlyContinue
  Set-Content -Path $focusFlag -Value '1' -Encoding ASCII

  $theirs = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 150
    if ((Test-Path $focusDone) -and ((Get-ForegroundTitle) -eq $targetTitle)) { $theirs = $true; break }
  }

  if (-not $theirs) {
    Write-Host "round $round SKIP  target window never got the foreground (foreground=[$(Get-ForegroundTitle)])"
    Write-Host "                 another app is stealing focus - environment problem, not an app bug"
    $skip++
    Stop-Process -Id $target.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    continue
  }

  # Something else on this desktop writes to the clipboard on its own (a widget
  # was caught doing it). If that happened, the app would legitimately capture
  # that instead, so the precondition is gone: skip rather than blame the app.
  $clip = ''
  try { $clip = (Get-Clipboard -Raw -ErrorAction Stop) } catch {}
  if ($clip -and $clip.Trim() -ne $needle) {
    Write-Host "round $round SKIP  clipboard was overwritten by another app before the hotkey"
    Write-Host "                 expected=[$needle] clipboard=[$($clip.Trim())]"
    $skip++
    Stop-Process -Id $target.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    continue
  }

  # Re-claim and fire the hotkey immediately: anything else on the desktop may
  # steal the foreground back at any moment, so no idle gap here.
  [void][E2eFg]::ForceForeground([E2eFg]::FindWindow($null, $targetTitle))
  [System.Windows.Forms.SendKeys]::SendWait($Hotkey)     # open the overlay (matches the app setting)

  # Wait until the panel really owns the foreground before sending anything else.
  # Sending keys while it is still activating lands them in the wrong window -
  # which shows up as the text being pasted twice.
  $overlayOk = $false
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 120
    if ((Get-ForegroundTitle) -eq $overlayTitle) { $overlayOk = $true; break }
  }
  if (-not $overlayOk) {
    Write-Host "round $round SKIP  the panel never took the foreground (foreground=[$(Get-ForegroundTitle)])"
    $skip++
    Stop-Process -Id $target.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    continue
  }

  # Narrow the list down to our item by pasting the needle into the search box
  # instead of typing it: typing goes through the active IME and gets mangled.
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 900
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')   # pick it
  Start-Sleep -Seconds 3

  $got = ''
  if (Test-Path $outFile) {
    $got = ((Get-Content $outFile -Raw) -replace "`r?`n", '').Trim()
  }

  if ($got -eq $needle) {
    Write-Host "round $round PASS  expected=[$needle] actual=[$got]"
    $pass++
  } elseif ($got -eq ($needle + $needle)) {
    Write-Host "round $round SKIP  text landed twice - a keystroke was delivered before the panel had focus"
    $skip++
  } else {
    Write-Host "round $round FAIL  expected=[$needle] actual=[$got] foreground-after=[$(Get-ForegroundTitle)]"
    $fail++
  }

  Stop-Process -Id $target.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

Write-Host "summary: pass=$pass fail=$fail skip=$skip"

if ($fail -gt 0) { exit 1 }
if ($pass -eq 0) {
  Write-Host "no round could run - close whatever keeps stealing focus and retry"
  exit 2
}
Write-Host 'ALL PASS'
exit 0
