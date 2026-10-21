'use strict';

/**
 * 自动回填：替用户按下 Ctrl+V。
 *
 * 这条路线上有三个坑，都不是靠 sleep 能绕过去的：
 *
 * 1) Windows 前台锁。Electron 的 hide() 之后前台权不会自动回到原窗口，
 *    必须显式 SetForegroundWindow 还回去，否则 Ctrl+V 打进空气。
 * 2) SetForegroundWindow 会被系统拒绝。标准解法是 AttachThreadInput——
 *    而且必须挂到"当前前台窗口"的线程上，挂目标窗口自己的线程没用。
 * 3) 后台程序可能反复抢焦点（实测这台机器上的汽水音乐就在抢），
 *    所以按键前要再确认一次前台窗口，被抢走就夺回来。
 *
 * 因此常驻一个隐藏的 PowerShell 助手进程，用 stdin/stdout 收发命令：
 *   capture           -> 返回当前前台窗口句柄
 *   paste <hwnd> <ms> -> 激活该窗口，等 ms 毫秒，按 Ctrl+V，返回结果
 * 常驻是为了避免每次粘贴都重新 Add-Type 编译 C#（省 300~500ms）。
 *
 * 注意：助手脚本必须**纯 ASCII**。这里落盘的是 .ps1，Windows PowerShell 5.1
 * 按 ANSI(GBK) 解码，任何非 ASCII 字节都会把后面的内容读乱（C# 会编译失败）。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEBUG = process.env.PASTE_MANAGER_DEBUG === '1';

function powershellPath() {
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const full = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    if (fs.existsSync(full)) return full;
  } catch {}
  return 'powershell.exe';
}

const HELPER_SOURCE = String.raw`
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PmNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

  // Attach to the thread that currently owns the foreground window: that is the
  // thread whose right to change the foreground window we need to borrow.
  // Attaching to the target window's own thread does not help.
  public static bool TrySetForeground(IntPtr hWnd) {
    uint dummy;
    IntPtr fg = GetForegroundWindow();
    uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out dummy);
    uint myThread = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != myThread) attached = AttachThreadInput(myThread, fgThread, true);
    bool ok = SetForegroundWindow(hWnd);
    if (attached) AttachThreadInput(myThread, fgThread, false);
    return ok;
  }

  public static bool Activate(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return false;
    if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
    TrySetForeground(hWnd);
    if (GetForegroundWindow() == hWnd) return true;
    // Foreground lock fallback: tap Alt so the system believes a user input
    // just happened, which unlocks SetForegroundWindow for us.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 0x0002, UIntPtr.Zero);
    TrySetForeground(hWnd);
    if (GetForegroundWindow() != hWnd) BringWindowToTop(hWnd);
    return GetForegroundWindow() == hWnd;
  }
}
"@

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  if ($line -eq 'capture') {
    [Console]::Out.WriteLine([PmNative]::GetForegroundWindow().ToInt64())
  }
  elseif ($line.StartsWith('paste')) {
    $parts = $line.Split(' ')
    $hwnd = [IntPtr][int64]$parts[1]
    $delay = 80
    if ($parts.Length -gt 2) { $delay = [int]$parts[2] }
    $activated = [PmNative]::Activate($hwnd)
    Start-Sleep -Milliseconds $delay
    # Re-claim the foreground right before typing: background apps sometimes
    # steal it back in the meantime.
    if ([PmNative]::GetForegroundWindow() -ne $hwnd) {
      $activated = [PmNative]::Activate($hwnd)
      Start-Sleep -Milliseconds 40
    }
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    $now = [PmNative]::GetForegroundWindow().ToInt64()
    [Console]::Out.WriteLine("done $activated $now")
  }
  else {
    [Console]::Out.WriteLine('unknown')
  }
}
`;

class PasteHelper {
  constructor({ dir, helperExe }) {
    this.scriptPath = path.join(dir, 'paste-helper.ps1');
    this.helperExe = helperExe || ''; // 原生助手优先；没有才退回 PowerShell
    this.child = null;
    this.buf = '';
    this.pending = null;
    this.queue = [];
    this.ready = false;
    this.kind = '';
  }

  /** 原生助手存在就用它：常驻只占十几 MB，启动也快一个数量级 */
  hasNativeHelper() {
    if (!this.helperExe) return false;
    try {
      return fs.existsSync(this.helperExe);
    } catch {
      return false;
    }
  }

  /** 把助手脚本写到数据目录（内容变了才重写） */
  ensureScript() {
    if (/[^\x00-\x7F]/.test(HELPER_SOURCE)) {
      console.error('[paste] 助手脚本含非 ASCII 字符，PowerShell 5.1 会读乱，拒绝写入');
      return false;
    }
    try {
      let current = null;
      try {
        current = fs.readFileSync(this.scriptPath, 'utf8');
      } catch {}
      if (current !== HELPER_SOURCE) fs.writeFileSync(this.scriptPath, HELPER_SOURCE, 'ascii');
      return true;
    } catch (err) {
      console.error('[paste] 写入助手脚本失败:', err.message);
      return false;
    }
  }

  start() {
    if (this.child) return true;

    const useNative = this.hasNativeHelper();
    if (!useNative && !this.ensureScript()) return false;

    try {
      this.child = useNative
        ? spawn(this.helperExe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn(
            powershellPath(),
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
            { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
          );
      this.kind = useNative ? 'native' : 'powershell';
    } catch (err) {
      console.error('[paste] 助手启动失败:', err.message);
      this.child = null;
      return false;
    }

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.error('[paste] 助手 stderr:', text.split('\n')[0]);
    });
    this.child.on('error', (err) => {
      console.error('[paste] 助手异常:', err.message);
      this.ready = false;
      this.child = null;
      this._fail('助手异常');
    });
    this.child.on('exit', (code) => {
      this.ready = false;
      this.child = null;
      this._fail(`助手退出 code=${code}`);
    });

    this.ready = true;
    if (DEBUG) {
      console.log(`[paste] 助手已启动（${this.kind}）: ${useNative ? this.helperExe : this.scriptPath}`);
    }
    return true;
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      const p = this.pending;
      this.pending = null;
      if (p) {
        clearTimeout(p.timer);
        p.resolve(line);
      } else if (DEBUG) {
        console.log('[paste] 助手多余输出:', line);
      }
      this._drain();
    }
  }

  _fail(reason) {
    const p = this.pending;
    this.pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    while (this.queue.length) {
      this.queue.shift().reject(new Error(reason));
    }
  }

  /** 一次只发一条命令，其余排队 —— 连按两次回车也不会互相挤掉 */
  _drain() {
    if (this.pending || !this.queue.length) return;
    if (!this.child || !this.ready) {
      if (!this.start()) {
        const job = this.queue.shift();
        job.reject(new Error('助手不可用'));
        return this._drain();
      }
    }
    const job = this.queue.shift();
    const timer = setTimeout(() => {
      if (this.pending && this.pending.job === job) {
        this.pending = null;
        job.reject(new Error('助手响应超时'));
        this._drain();
      }
    }, job.timeoutMs);
    this.pending = { job, resolve: job.resolve, reject: job.reject, timer };
    try {
      this.child.stdin.write(job.command + '\n');
    } catch (err) {
      clearTimeout(timer);
      this.pending = null;
      job.reject(err);
      this._drain();
    }
  }

  _request(command, timeoutMs) {
    return new Promise((resolve, reject) => {
      this.queue.push({ command, timeoutMs, resolve, reject });
      this._drain();
    });
  }

  /** 取当前前台窗口句柄；失败返回 0 */
  async captureForeground() {
    try {
      const raw = await this._request('capture', 1500);
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    } catch (err) {
      if (DEBUG) console.warn('[paste] 取前台窗口失败:', err.message);
      return 0;
    }
  }

  /** 激活目标窗口并粘贴；按键已发出返回 true */
  async pasteTo(hwnd, delayMs = 80) {
    const h = Math.max(0, Math.trunc(Number(hwnd) || 0));
    const d = Math.max(0, Math.trunc(Number(delayMs) || 0));
    if (!h) {
      console.warn('[paste] 没有可还原的前台窗口，跳过激活');
      return false;
    }
    try {
      const res = await this._request(`paste ${h} ${d}`, 5000);
      const parts = String(res).trim().split(/\s+/);
      if (parts[0] !== 'done') {
        if (DEBUG) console.warn('[paste] 助手返回异常:', res);
        return false;
      }
      const activated = parts[1] === 'true' || parts[1] === 'True';
      const foreground = Number(parts[2]) || 0;
      if (DEBUG) console.log(`[paste] 助手: 已激活=${activated} 目标=${h} 按键后前台=${foreground}`);
      if (!activated) {
        console.warn(`[paste] 前台权没能交还给原窗口（当前前台 ${foreground}），这次粘贴可能落空`);
      }
      return true;
    } catch (err) {
      console.warn('[paste] 助手粘贴失败:', err.message);
      return false;
    }
  }

  stop() {
    try {
      if (this.child && this.child.stdin.writable) this.child.stdin.end();
    } catch {}
    try {
      if (this.child) this.child.kill();
    } catch {}
    this.child = null;
    this.ready = false;
    this._fail('助手已停止');
  }
}

/** 兜底方案：直接朝当前前台窗口发 Ctrl+V（不做窗口激活） */
function sendPaste(opts = {}) {
  const delayMs = Math.max(0, Number(opts.delayMs) || 0);
  const key = opts.key || '^v';
  const script = [
    '$ErrorActionPreference = "Continue"',
    'Add-Type -AssemblyName System.Windows.Forms',
    `Start-Sleep -Milliseconds ${delayMs}`,
    `[System.Windows.Forms.SendKeys]::SendWait('${key}')`
  ].join('; ');

  try {
    if (DEBUG) console.log(`[paste] 兜底模拟按键 key=${key} 等待=${delayMs}ms`);
    const child = spawn(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, stdio: 'ignore', detached: false }
    );
    child.on('error', (err) => console.error('[paste] 兜底按键启动失败:', err.message));
    child.unref();
    return true;
  } catch (err) {
    console.error('[paste] 兜底按键异常:', err.message);
    return false;
  }
}

module.exports = { PasteHelper, sendPaste, powershellPath, HELPER_SOURCE };
