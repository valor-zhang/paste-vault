# Memory report for the running Paste Manager instance.
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI/GBK here, and a trailing
# double-byte character can swallow the next newline.
#
# The process name is Chinese, so it is built from code points instead of being
# written literally (keeps this file pure ASCII).
#
# Usage: powershell -ExecutionPolicy Bypass -File test\manual\mem-report.ps1
# Prints one row per process plus totals, so before/after numbers compare cleanly.

$appExe = [string]::Join('', [char[]](0x7C98, 0x8D34, 0x7BA1, 0x7406, 0x5668)) + '.exe'

$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq $appExe -or $_.Name -eq 'electron.exe' }
if (-not $procs) {
  Write-Host 'no running instance found'
  exit 1
}

# The root is the one without a --type= switch.
$root = $procs | Where-Object { $_.CommandLine -notmatch '--type=' } | Sort-Object ProcessId | Select-Object -First 1
if ($root) {
  $procs = $procs | Where-Object { $_.ProcessId -eq $root.ProcessId -or $_.ParentProcessId -eq $root.ProcessId }
} else {
  $root = $procs | Select-Object -First 1
}

$rows = @()
foreach ($p in $procs) {
  $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if (-not $gp) { continue }
  $type = 'main'
  if ($p.CommandLine -match '--type=([a-z-]+)') { $type = $Matches[1] }
  $rows += [pscustomobject]@{
    PID    = $p.ProcessId
    Type   = $type
    WSMB   = [math]::Round($gp.WorkingSet64 / 1MB, 1)
    PrivMB = [math]::Round($gp.PrivateMemorySize64 / 1MB, 1)
  }
}

# The paste helper is a child process of the app: the native paste-helper.exe,
# or (fallback) a powershell.exe running the generated helper script.
Get-CimInstance Win32_Process | Where-Object {
  $_.ParentProcessId -eq $root.ProcessId -and ($_.Name -eq 'powershell.exe' -or $_.Name -eq 'paste-helper.exe')
} | ForEach-Object {
  $gp = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  if ($gp) {
    $rows += [pscustomobject]@{
      PID    = $_.ProcessId
      Type   = 'paste-helper'
      WSMB   = [math]::Round($gp.WorkingSet64 / 1MB, 1)
      PrivMB = [math]::Round($gp.PrivateMemorySize64 / 1MB, 1)
    }
  }
}

$rows | Sort-Object WSMB -Descending | Format-Table -AutoSize
$ws = [math]::Round(($rows | Measure-Object WSMB -Sum).Sum, 1)
$pv = [math]::Round(($rows | Measure-Object PrivMB -Sum).Sum, 1)
$rootProc = Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue
Write-Host "TOTAL working set : $ws MB"
Write-Host "TOTAL private     : $pv MB"
if ($rootProc) {
  $up = (Get-Date) - $rootProc.StartTime
  Write-Host ("uptime            : {0:N0}h {1:N0}m" -f $up.TotalHours, $up.Minutes)
}
