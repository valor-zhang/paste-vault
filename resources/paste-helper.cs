// 自动回填的原生助手进程（替代原来的 PowerShell 助手）。
//
// 为什么要有它：PowerShell 宿主常驻要占 54~77MB，而这个小程序只要十几 MB，
// 启动也快一个数量级。协议与 PowerShell 版完全一致，通过 stdin/stdout 收发：
//
//   capture          -> 输出当前前台窗口句柄
//   paste <hwnd> <ms> -> 把前台权交还给该窗口，等 ms 毫秒，按 Ctrl+V
//                        输出 "done <是否成功> <按键后的前台句柄>"
//
// 关键技术点是 AttachThreadInput：必须挂到"当前前台窗口"的线程上，
// 才能继承它修改前台窗口的权限；挂到目标窗口自己的线程上是无效的。
//
// 编译（C# 5，无需 SDK）：
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:exe /optimize+ ^
//     /out:resources\paste-helper.exe resources\paste-helper.cs

using System;
using System.Runtime.InteropServices;
using System.Threading;

internal static class PasteHelper
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const byte VK_MENU = 0x12;
    private const byte VK_CONTROL = 0x11;
    private const byte VK_V = 0x56;
    private const int SW_RESTORE = 9;

    private static bool TrySetForeground(IntPtr hWnd)
    {
        IntPtr fg = GetForegroundWindow();
        uint dummy;
        uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out dummy);
        uint myThread = GetCurrentThreadId();

        bool attached = false;
        if (fgThread != 0 && fgThread != myThread)
        {
            attached = AttachThreadInput(myThread, fgThread, true);
        }
        bool ok = SetForegroundWindow(hWnd);
        if (attached)
        {
            AttachThreadInput(myThread, fgThread, false);
        }
        return ok;
    }

    private static bool Activate(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero) return false;
        if (IsIconic(hWnd)) ShowWindow(hWnd, SW_RESTORE);

        TrySetForeground(hWnd);
        if (GetForegroundWindow() == hWnd) return true;

        // 前台锁兜底：轻敲一下 Alt，让系统认为刚发生过用户输入
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        TrySetForeground(hWnd);
        if (GetForegroundWindow() != hWnd) BringWindowToTop(hWnd);
        return GetForegroundWindow() == hWnd;
    }

    private static void SendCtrlV()
    {
        keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
        keybd_event(VK_V, 0, 0, UIntPtr.Zero);
        keybd_event(VK_V, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    private static int Main()
    {
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;

            if (line == "capture")
            {
                Console.Out.WriteLine(GetForegroundWindow().ToInt64());
            }
            else if (line.StartsWith("paste"))
            {
                string[] parts = line.Split(' ');
                long raw = 0;
                if (parts.Length < 2 || !long.TryParse(parts[1], out raw))
                {
                    Console.Out.WriteLine("done false 0");
                }
                else
                {
                    int delay = 80;
                    if (parts.Length > 2) int.TryParse(parts[2], out delay);

                    IntPtr target = new IntPtr(raw);
                    bool ok = Activate(target);
                    Thread.Sleep(delay);

                    // 后台程序可能在这期间又把焦点抢走，按键前再确认一次
                    if (GetForegroundWindow() != target)
                    {
                        ok = Activate(target);
                        Thread.Sleep(40);
                    }

                    SendCtrlV();
                    Console.Out.WriteLine("done " + (ok ? "true" : "false") + " " + GetForegroundWindow().ToInt64());
                }
            }
            else
            {
                Console.Out.WriteLine("unknown");
            }
            Console.Out.Flush();
        }
        return 0;
    }
}
