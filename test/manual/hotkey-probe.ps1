# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI/GBK here.
# Probes whether a global hotkey is currently free, independently of the app.
# MOD_ALT=0x0001 MOD_CONTROL=0x0002 MOD_SHIFT=0x0004 ; VK_V=0x56
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class HotkeyProbe {
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
}
"@

function Probe($label, $mods, $vk) {
  $id = Get-Random -Minimum 1000 -Maximum 90000
  $ok = [HotkeyProbe]::RegisterHotKey([IntPtr]::Zero, $id, $mods, $vk)
  if ($ok) { [void][HotkeyProbe]::UnregisterHotKey([IntPtr]::Zero, $id) }
  Write-Host "$label register=$ok"
}

Probe 'Ctrl+Shift+V  ' (0x0002 -bor 0x0004) 0x56
Probe 'Ctrl+Alt+V    ' (0x0002 -bor 0x0001) 0x56
Probe 'Ctrl+Shift+F12' (0x0002 -bor 0x0004) 0x7B
