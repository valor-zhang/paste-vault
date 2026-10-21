'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  clipboard,
  ClipboardItem,
  dialog,
  globalShortcut,
  Menu,
  shell,
  screen,
  protocol,
  net
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const { Store } = require('./store');
const { createCapture, pathsToUriList } = require('./capture');
const { sendPaste, PasteHelper } = require('./paste');
const { createTray } = require('./tray');
const { ensureIcons } = require('./icon');

const ROOT = path.join(__dirname, '..', '..');

let store = null;
let overlay = null;
let capture = null;
let trayCtl = null;
let dataDir = null;
let quitting = false;
let lastMenuAt = 0;
let pasteHelper = null;
let lastForegroundHwnd = 0; // 唤出浮层之前的前台窗口，粘贴时要把前台权还给它
let blurSuppressUntil = 0; // 打开系统对话框期间不要因为失焦把面板收起来
let currentHotkey = ''; // 当前真正注册成功的热键
let hotkeyFallbackFrom = ''; // 想用的热键被占用时，记下它，好在界面上说明
let focusClaimUntil = 0; // 刚弹出的这一小段时间内，允许把被抢走的焦点夺回来
let focusClaimTimer = null;
let overlayReadyPromise = null; // 窗口创建→首帧就绪
let overlayIdleTimer = null; // 空闲销毁定时器
// 面板收起多久之后把窗口整个销毁。销毁后渲染进程（实测 100~200MB）会被回收，
// 代价是下次唤出要多花 ~200ms 重建窗口。两分钟是个折中：
// 连续使用时窗口一直是热的，真正闲置了才回收。调试时可用环境变量改小。
const OVERLAY_IDLE_DESTROY_MS = Number(process.env.PASTE_MANAGER_IDLE_DESTROY_MS) || 120000;

function cancelOverlayIdleDestroy() {
  if (overlayIdleTimer) {
    clearTimeout(overlayIdleTimer);
    overlayIdleTimer = null;
  }
}

function scheduleOverlayIdleDestroy() {
  cancelOverlayIdleDestroy();
  overlayIdleTimer = setTimeout(() => {
    overlayIdleTimer = null;
    if (!overlay || overlay.isDestroyed() || overlay.isVisible()) return;
    try {
      overlay.destroy();
    } catch {}
    overlay = null;
    overlayReadyPromise = null;
    console.log(`[overlay] 已空闲 ${OVERLAY_IDLE_DESTROY_MS / 1000}s，销毁窗口以回收渲染进程内存`);
  }, OVERLAY_IDLE_DESTROY_MS);
}

/** 系统对话框/右键菜单会抢焦点，这期间不收起面板 */
function suppressBlurHide(ms = 10000) {
  blurSuppressUntil = Date.now() + ms;
}

// 调试开关：PASTE_MANAGER_KEEP_OPEN=1 时，面板失去焦点也不收起，方便截图/排错
const KEEP_OPEN = process.env.PASTE_MANAGER_KEEP_OPEN === '1';

app.setAppUserModelId('com.local.pastemanager');

// 内存优化：这个界面只有列表和表单，没有视频/WebGL，用不着独立的 GPU 进程。
// 关掉硬件加速能省掉一个常驻 80~100MB 的 gpu-process（实测），代价只是纯软件合成。
app.disableHardwareAcceleration();

// 便携/调试模式：把数据目录（含 Chromium 自己的缓存）整体改到指定位置。
// 正式运行时用 %APPDATA%\粘贴管理器。
if (process.env.PASTE_MANAGER_DATA) {
  try {
    app.setPath('userData', process.env.PASTE_MANAGER_DATA);
  } catch (err) {
    console.error('[app] 数据目录覆盖失败:', err.message);
  }
}

// 图片缩略图走自定义协议，渲染进程不需要任何文件系统权限
protocol.registerSchemesAsPrivileged([
  { scheme: 'pmblob', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

// ---------- 单实例 ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showOverlay());
}

// ---------- 窗口 ----------

function createOverlayWindow() {
  overlay = new BrowserWindow({
    width: 700,
    height: 470,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#12141a',
    roundedCorners: true,
    title: '粘贴管理器',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  overlay.setMenuBarVisibility(false);
  // 记录"窗口可以显示了"：空闲销毁后重建时，showOverlay 要等它，
  // 否则用户会看到一闪而过的空白窗口。
  //
  // 注意不能用 ready-to-show 当唯一信号：隐藏窗口会被后台节流、迟迟不首帧，
  // 那个事件可能要很久才来（实测会一直等到兜底超时，唤起像卡了 3 秒）。
  // did-finish-load 只等 DOM 就绪，稳定在 100~200ms。
  overlayReadyPromise = new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    overlay.webContents.once('did-finish-load', done);
    overlay.once('ready-to-show', done);
    setTimeout(done, 2000); // 兜底
  });

  overlay.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 界面里的报错要能回到终端，否则渲染层出问题只能靠肉眼猜
  overlay.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const msg = (event && event.message) || message;
    const src = (event && event.sourceId) || sourceId;
    console.log(`[renderer] ${msg}${src ? ` (${src}:${line})` : ''}`);
  });
  overlay.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] 进程退出:', JSON.stringify(details));
  });
  overlay.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] 页面加载失败 ${code} ${desc} ${url}`);
  });

  overlay.on('blur', () => {
    if (KEEP_OPEN) return;
    if (Date.now() < blurSuppressUntil) return; // 系统对话框开着
    if (Date.now() - lastMenuAt < 1500) return; // 右键菜单抢焦点，不算失焦
    if (Date.now() < focusClaimUntil) {
      // 刚弹出来就被别的程序（实测常见）抢走焦点：先夺回来；
      // 过了这个窗口期还拿不到，说明用户是主动点到别处去了，那就收起。
      setTimeout(() => {
        if (!overlay || overlay.isDestroyed() || !overlay.isVisible()) return;
        if (overlay.isFocused()) return;
        if (Date.now() < focusClaimUntil) {
          overlay.focus();
          overlay.moveTop();
        } else {
          hideOverlay();
        }
      }, 160);
      return;
    }
    if (overlay && overlay.webContents.isDevToolsOpened()) return;
    hideOverlay();
  });

  overlay.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hideOverlay();
    }
  });

  overlay.on('closed', () => {
    overlay = null;
  });
}

/** 本窗口自己的句柄，用来避免把"前台权"还给自己 */
function ownHwnd() {
  try {
    const buf = overlay.getNativeWindowHandle();
    if (!buf || !buf.length) return 0;
    return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
  } catch {
    return 0;
  }
}

async function showOverlay() {
  if (!overlay) createOverlayWindow();
  if (!overlay) return;
  cancelOverlayIdleDestroy();

  // 先把"现在谁在前台"记下来，粘贴时再还回去。
  // 必须在 show() 之前取，否则取到的就是我们自己。
  // 取值和"等窗口首帧就绪"并行做，省掉一次串行等待。
  const needCapture = !overlay.isVisible();
  const capturePromise = needCapture ? pasteHelper.captureForeground() : Promise.resolve(0);

  if (overlayReadyPromise) {
    try {
      await overlayReadyPromise;
    } catch {}
    overlayReadyPromise = null;
  }
  if (!overlay || overlay.isDestroyed()) return;

  if (needCapture) {
    const hwnd = await capturePromise;
    if (hwnd && hwnd !== ownHwnd()) lastForegroundHwnd = hwnd;
  }

  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const [w, h] = overlay.getSize();
  overlay.setPosition(
    Math.round(area.x + (area.width - w) / 2),
    Math.round(area.y + Math.max(0, (area.height - h) / 2 - 70))
  );

  // Windows 有"前台锁"：不是当前前台进程时，SetForegroundWindow 可能被拒。
  // 抬到 screen-saver 层级 + moveTop 能显著提高一次命中的概率，
  // 万一还是没拿到焦点，50ms 后补一次（此时窗口已在前台，第二次必成）。
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.show();
  overlay.focus();
  overlay.moveTop();

  // 弹出的头 1 秒里盯着焦点：某些后台程序会立刻把焦点抢走，
  // 那会让用户接下来的回车落到别的窗口里（面板看着是开着的，其实没焦点）。
  focusClaimUntil = Date.now() + 1000;
  if (focusClaimTimer) clearInterval(focusClaimTimer);
  focusClaimTimer = setInterval(() => {
    if (!overlay || overlay.isDestroyed() || !overlay.isVisible() || Date.now() > focusClaimUntil) {
      clearInterval(focusClaimTimer);
      focusClaimTimer = null;
      return;
    }
    if (!overlay.isFocused()) {
      overlay.focus();
      overlay.moveTop();
    }
  }, 120);

  setTimeout(() => {
    if (overlay && !overlay.isDestroyed() && overlay.isVisible() && !overlay.isFocused()) {
      overlay.focus();
      overlay.moveTop();
    }
  }, 50);

  overlay.webContents.send('overlay:shown');

  if (process.env.PASTE_MANAGER_DEBUG === '1') {
    console.log(
      `[overlay] shown bounds=${JSON.stringify(overlay.getBounds())} focused=${overlay.isFocused()} 待还原前台=${lastForegroundHwnd}`
    );
  }
}

function hideOverlay() {
  if (overlay && overlay.isVisible()) {
    // Windows 上只调 hide() 的话，本窗口即使不可见仍然是"前台窗口"，
    // 随后模拟的 Ctrl+V 会打进一个隐藏窗口里丢掉。先把焦点交出去再隐藏。
    try {
      overlay.blur();
    } catch {}
    overlay.hide();
    // 让界面把列表 DOM 清空：否则隐藏着的窗口会一直扣着解码后的图片位图
    try {
      overlay.webContents.send('overlay:hidden');
    } catch {}
    scheduleOverlayIdleDestroy();
    if (process.env.PASTE_MANAGER_DEBUG === '1' && pasteHelper) {
      pasteHelper.captureForeground().then((h) => console.log(`[overlay] hidden 此时前台窗口=${h} 本窗口=${ownHwnd()}`));
    }
  }
}

/**
 * 等焦点真正离开浮层再按键。
 * 固定 sleep 靠不住：系统把焦点还给原窗口需要多久不确定，
 * 按早了 Ctrl+V 就落进我们自己的搜索框里。
 */
function waitUntilFocusLeft(timeoutMs = 600) {
  return new Promise((resolve) => {
    if (!overlay || overlay.isDestroyed() || !overlay.isFocused()) return resolve(true);
    const started = Date.now();
    const timer = setInterval(() => {
      const done = overlay.isDestroyed() || !overlay.isFocused() || Date.now() - started > timeoutMs;
      if (done) {
        clearInterval(timer);
        resolve(!overlay.isDestroyed() && !overlay.isFocused());
      }
    }, 20);
  });
}

function toggleOverlay() {
  if (overlay && overlay.isVisible()) hideOverlay();
  else showOverlay();
}

/** 从托盘菜单直接进设置页（focus 指定要聚焦的字段） */
async function openSettingsView(focus) {
  await showOverlay();
  if (overlay && !overlay.isDestroyed()) {
    overlay.webContents.send('settings:open', { focus: focus || '' });
  }
}

// ---------- 剪贴板写回 ----------

/**
 * 把一条历史写回剪贴板（Electron 44 的 W3C 风格异步接口）。
 * 图片走 image/* 的 Blob；文件走 text/uri-list —— 在 Windows 上就是 CF_HDROP，
 * 所以粘到资源管理器里是真的把那几个文件复制过去。
 */
async function writeItemToClipboard(item) {
  if (!item) return false;

  if (item.kind === 'text') {
    await clipboard.writeText(item.text || '');
    return true;
  }

  if (item.kind === 'image') {
    if (!item.blobPath) return false;
    const abs = store.blobAbs(item.blobPath);
    if (!fs.existsSync(abs)) return false;
    const buf = fs.readFileSync(abs);
    const ext = (path.extname(abs).slice(1) || 'png').toLowerCase();
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    await clipboard.write([new ClipboardItem({ [mime]: new Blob([buf], { type: mime }) })]);
    return true;
  }

  if (item.kind === 'files') {
    const paths = ((item.meta && item.meta.files) || []).map((f) => f && f.path).filter(Boolean);
    if (!paths.length) return false;
    if (store.settings().filesAsText) {
      await clipboard.writeText(paths.join('\r\n'));
      return true;
    }
    try {
      await clipboard.write([new ClipboardItem({ 'text/uri-list': pathsToUriList(paths) })]);
      return true;
    } catch (err) {
      console.warn('[paste] 文件列表写回失败，退化为文本路径:', err.message);
      await clipboard.writeText(paths.join('\r\n'));
      return true;
    }
  }

  return false;
}

async function pasteItem(id) {
  const item = store.get(id);
  if (!item) return { ok: false, reason: 'not-found' };
  if (!(await writeItemToClipboard(item))) return { ok: false, reason: 'unsupported' };

  capture.noteSelfWrite(item.hash);
  store.touch(id);
  hideOverlay();

  const wait = Math.max(0, Number(store.settings().pasteDelayMs) || 140);
  const target = lastForegroundHwnd;

  // 让助手把前台权交还给唤出前的那个窗口，再按 Ctrl+V。
  // 步骤 1：隐藏浮层（否则前台权一直在我们自己手里，按键会打进空气）
  // 步骤 2：SetForegroundWindow(原窗口) → 等焦点稳住 → SendKeys ^v
  const done = await pasteHelper.pasteTo(target, wait);
  if (process.env.PASTE_MANAGER_DEBUG === '1') {
    const now = await pasteHelper.captureForeground();
    console.log(`[paste] 按键后前台窗口=${now} 目标=${target} 助手可用=${done}`);
  }
  if (!done) {
    console.warn('[paste] 助手不可用，退回直接模拟按键（焦点可能不在原窗口）');
    await waitUntilFocusLeft();
    sendPaste({ delayMs: wait });
  }
  return { ok: true };
}

async function copyItemOnly(id) {
  const item = store.get(id);
  if (!item) return { ok: false };
  if (!(await writeItemToClipboard(item))) return { ok: false, reason: 'unsupported' };
  capture.noteSelfWrite(item.hash);
  store.touch(id);
  return { ok: true };
}

// ---------- 渲染进程数据 ----------

function decorate(item) {
  return {
    ...item,
    blobUrl: item.blobPath ? 'pmblob://local/' + encodeURIComponent(item.blobPath) : null
  };
}

function listItems(opts) {
  return store.list(opts).map(decorate);
}

function notifyChanged() {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('items:changed');
}

// ---------- 托盘 / 热键 ----------

function rebuildTray() {
  if (trayCtl) trayCtl.rebuild();
}

function registerHotkey(accel) {
  globalShortcut.unregisterAll();
  currentHotkey = '';
  if (!accel) return false;
  let ok = false;
  try {
    ok = globalShortcut.register(accel, toggleOverlay);
  } catch (err) {
    console.error('[hotkey] 注册异常:', err.message);
  }
  if (ok) currentHotkey = accel;
  else console.error('[hotkey] 注册失败（可能被别的软件占用）:', accel);
  return ok;
}

/** 热键被占用时退回一个大概率可用的组合；两个都不行返回 '' */
function registerHotkeyWithFallback(accel) {
  if (registerHotkey(accel)) return accel;
  const fallback = 'Control+Alt+V';
  if (fallback !== accel && registerHotkey(fallback)) {
    console.warn(`[hotkey] ${accel} 暂时不可用（可能被别的软件占用），本次先用 ${fallback}`);
    return fallback;
  }
  return '';
}

function applyPause(paused) {
  store.setSetting('paused', !!paused);
  rebuildTray();
  notifyChanged();
}

/**
 * 自启项必须指向"用户实际双击的那个 exe"：
 *  - 安装版：process.execPath（安装目录里的 exe）
 *  - 免安装单文件版：真正运行的是解压到临时目录的副本，process.execPath 每次都不一样。
 *    这种构建下 electron-builder 会设 PORTABLE_EXECUTABLE_FILE 指向用户双击的原始 exe，
 *    必须用它，否则自启项会指向一个下次开机就不存在的临时路径。
 *  - 开发模式：electron.exe + 项目路径
 */
function autostartTarget() {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portable) return { path: portable, args: [] };
  return { path: process.execPath, args: app.isPackaged ? [] : [ROOT] };
}

/** 以注册表里的实际状态为准，而不是数据库里的意愿值 */
function autostartEnabled() {
  try {
    return !!app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

function applyAutostart(enabled) {
  try {
    const target = autostartTarget();
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: target.path,
      args: target.args
    });
    const actual = autostartEnabled();
    console.log(
      `[autostart] 开机自启 → ${actual ? '已开启' : '已关闭'}（${target.path}${target.args.length ? ' ' + target.args.join(' ') : ''}）`
    );
    return actual;
  } catch (err) {
    console.error('[autostart] 设置失败:', err.message);
    return false;
  }
}

function quitApp() {
  quitting = true;
  app.quit();
}

// ---------- 启动 ----------

app.whenReady().then(() => {
  dataDir = process.env.PASTE_MANAGER_DATA || app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });
  store = new Store(dataDir);
  store.enforceLimits();
  const orphans = store.pruneOrphanBlobs();

  pasteHelper = new PasteHelper({
    dir: dataDir,
    // 原生助手（十几 MB、启动几十毫秒）优先；找不到才退回 PowerShell 版
    helperExe: app.isPackaged
      ? path.join(process.resourcesPath, 'paste-helper.exe')
      : path.join(ROOT, 'resources', 'paste-helper.exe')
  });
  pasteHelper.start();

  // 打包后 app 目录是只读的 asar，图标改放用户数据目录
  const assetsDir = app.isPackaged ? path.join(app.getPath('userData'), 'assets') : path.join(ROOT, 'assets');
  const { iconPath, trayPath } = ensureIcons(assetsDir);

  protocol.handle('pmblob', async (request) => {
    try {
      const url = new URL(request.url);
      const name = path.basename(decodeURIComponent(url.pathname).replace(/^\/+/, ''));
      const abs = path.join(store.blobsDir, name);
      if (!abs.startsWith(store.blobsDir) || !fs.existsSync(abs)) {
        return new Response('not found', { status: 404 });
      }
      const res = await net.fetch(pathToFileURL(abs).toString());
      const ext = (path.extname(abs).slice(1) || 'png').toLowerCase();
      const mime =
        { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[
          ext
        ] || 'application/octet-stream';
      return new Response(res.body, { status: res.status, headers: { 'content-type': mime } });
    } catch (err) {
      return new Response('error', { status: 500 });
    }
  });

  capture = createCapture({
    store,
    onCaptured: () => notifyChanged()
  });

  createOverlayWindow();

  trayCtl = createTray({
    trayIconPath: trayPath,
    onToggle: toggleOverlay,
    onPauseToggle: () => applyPause(!store.settings().paused),
    onOpenDataDir: () => shell.openPath(dataDir),
    onQuit: quitApp,
    isPaused: () => !!store.settings().paused,
    isAutostart: () => autostartEnabled(),
    getHotkey: () => currentHotkey,
    onHotkeySettings: () => openSettingsView('hotkey'),
    onAutostartToggle: () => {
      // 托盘里以"注册表实际状态"为准来取反，避免界面显示和真实状态不一致
      const next = !autostartEnabled();
      store.setSetting('autostart', next);
      const actual = applyAutostart(next);
      rebuildTray();
      console.log(`[autostart] 托盘切换：${next ? '开启' : '关闭'} → ${actual ? '已开启' : '已关闭'}`);
    },
    stats: () => store.stats()
  });

  const accel = store.settings().hotkey;
  const effective = registerHotkeyWithFallback(accel);
  // 关键：回退只作用于本次运行，**不写回数据库**。
  // 否则一次偶发占用（比如启动瞬间和别的程序撞上）就永久改掉了用户设的热键，
  // 下次启动再也回不到他想要的那个键。
  hotkeyFallbackFrom = effective && effective !== accel ? accel : '';
  if (!effective) console.error('[hotkey] 没有可用的全局热键，请到托盘菜单里唤出面板');

  // 打包版首次运行默认打开开机自启（这是用户明确要的能力）。
  // 用 hasSetting 区分"从没设置过"和"设置过但关掉了"：用户手动关一次就永久记住，
  // 不会被下次启动又偷偷打开。
  if (app.isPackaged && !store.hasSetting('autostart')) {
    store.setSetting('autostart', true);
    console.log('[autostart] 首次运行：默认开启开机自启（可在托盘菜单或设置里关掉）');
  }
  applyAutostart(store.settings().autostart);
  capture.start();

  console.log(`[paste-manager] 数据目录: ${dataDir}`);
  console.log(`[paste-manager] 图标: ${iconPath}`);
  console.log(`[paste-manager] 已清理越界条目 ${orphans} 个废弃图片文件`);

  if (process.argv.includes('--dev')) overlay.webContents.openDevTools({ mode: 'detach' });

  // 是"开机自启拉起来的"还是"用户自己双击启动的"？
  // 开机自启不该抢焦点；用户手动启动则要亮一次面板，否则他会以为程序没起来。
  let openedAtLogin = false;
  try {
    openedAtLogin = !!app.getLoginItemSettings().wasOpenedAtLogin;
  } catch {}
  if (KEEP_OPEN || !openedAtLogin) showOverlay();

  console.log(
    `[paste-manager] 已就绪，按 ${currentHotkey || '（无可用热键，请点托盘图标）'} 唤出面板；托盘图标也可点击`
  );
});

// ---------- IPC ----------

ipcMain.handle('items:list', (_e, opts) => listItems(opts || {}));
ipcMain.handle('app:stats', () => store.stats());
ipcMain.handle('settings:get', () => ({
  ...store.settings(),
  dataDir,
  autostartActive: autostartEnabled(),
  hotkeyActive: currentHotkey,
  hotkeyFallbackFrom
}));

ipcMain.handle('settings:set', (_e, key, value) => {
  const saved = store.setSetting(key, value);
  const result = { value: saved };

  if (key === 'hotkey') {
    // 用户明确选的热键原样存下来，本次是否生效另说
    const effective = registerHotkeyWithFallback(saved);
    hotkeyFallbackFrom = effective && effective !== saved ? saved : '';
    result.hotkeyActive = currentHotkey;
    result.hotkeyOk = effective === saved;
    result.hotkeyFallbackFrom = hotkeyFallbackFrom;
  }
  if (key === 'autostart') {
    result.autostartActive = applyAutostart(saved);
    rebuildTray();
  }
  if (key === 'paused') rebuildTray();
  if (key === 'maxItems' || key === 'maxImages' || key === 'maxImageBytes') {
    store.enforceLimits();
    notifyChanged();
    rebuildTray();
  }
  if (key === 'pasteDelayMs' || key === 'filesAsText') notifyChanged();

  return result;
});

// ---------- 标签 ----------

ipcMain.handle('tags:list', () => store.allTags());

ipcMain.handle('tag:add', (_e, id, name) => {
  store.addTag(id, name);
  notifyChanged();
  return { tags: store.allTags(), itemTags: (store.get(id) || {}).tags || [] };
});

ipcMain.handle('tag:remove', (_e, id, name) => {
  store.removeTag(id, name);
  notifyChanged();
  return { tags: store.allTags(), itemTags: (store.get(id) || {}).tags || [] };
});

// ---------- 备份 ----------

ipcMain.handle('data:export', async () => {
  suppressBlurHide();
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const { canceled, filePath } = await dialog.showSaveDialog(overlay, {
    title: '导出剪贴板历史',
    defaultPath: path.join(app.getPath('documents'), `paste-manager-${stamp}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    const dump = store.exportData();
    fs.writeFileSync(filePath, JSON.stringify(dump, null, 2), 'utf8');
    return { ok: true, file: filePath, count: dump.items.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('data:import', async () => {
  suppressBlurHide();
  const { canceled, filePaths } = await dialog.showOpenDialog(overlay, {
    title: '导入剪贴板历史',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    const res = store.importData(parsed);
    notifyChanged();
    rebuildTray();
    return { ok: true, ...res };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('item:paste', (_e, id) => pasteItem(id));
ipcMain.handle('item:copy', (_e, id) => copyItemOnly(id));

ipcMain.handle('item:pin', (_e, id) => {
  store.togglePin(id);
  notifyChanged();
  rebuildTray();
  return true;
});

ipcMain.handle('item:delete', (_e, id) => {
  store.remove(id);
  notifyChanged();
  rebuildTray();
  return true;
});

ipcMain.handle('app:togglePause', () => {
  applyPause(!store.settings().paused);
  return store.settings().paused;
});

ipcMain.handle('app:openDataDir', () => shell.openPath(dataDir));
ipcMain.handle('overlay:hide', () => hideOverlay());
ipcMain.handle('app:quit', () => quitApp());

/** 设置页比列表长，进设置时把面板撑高，免得内容被截断 */
ipcMain.handle('view:set', (_e, view) => {
  if (!overlay || overlay.isDestroyed()) return false;
  const bounds = overlay.getBounds();
  const height = view === 'settings' ? 660 : 470;
  if (bounds.height === height) return true;
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea;
  const y = Math.round(display.y + Math.max(8, (display.height - height) / 2 - 70));
  overlay.setBounds({ x: bounds.x, y, width: bounds.width, height });
  return true;
});

ipcMain.handle('item:menu', (_e, id) => {
  const item = store.get(id);
  if (!item) return false;
  lastMenuAt = Date.now();

  const template = [
    { label: '粘贴到当前窗口', click: () => pasteItem(id) },
    { label: '只复制到剪贴板', click: () => copyItemOnly(id) },
    { type: 'separator' },
    {
      label: item.pinned ? '取消收藏' : '收藏（永久保留）',
      click: () => {
        store.togglePin(id);
        notifyChanged();
        rebuildTray();
      }
    },
    {
      label: '删除',
      click: () => {
        store.remove(id);
        notifyChanged();
        rebuildTray();
      }
    },
    { type: 'separator' },
    { label: '打开数据目录', click: () => shell.openPath(dataDir) }
  ];

  const menu = Menu.buildFromTemplate(template);
  menu.popup({
    window: overlay,
    callback: () => {
      lastMenuAt = Date.now();
    }
  });
  return true;
});

app.on('before-quit', () => {
  quitting = true;
  if (capture) capture.stop();
  if (pasteHelper) pasteHelper.stop();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (store) {
    try {
      store.close();
    } catch {}
  }
});

// 托盘常驻：不因为窗口隐藏而退出
app.on('window-all-closed', () => {
  if (quitting) app.quit();
});
