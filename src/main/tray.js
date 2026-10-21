'use strict';

const { Tray, Menu, nativeImage } = require('electron');

/**
 * 托盘常驻：左键唤出浮层，右键出菜单。
 * 菜单里直接给出两个最常改的开关：热键、开机自启 —— 不用先想起 Ctrl+, 才能找到。
 */
function createTray({
  trayIconPath,
  onToggle,
  onPauseToggle,
  onAutostartToggle,
  onHotkeySettings,
  onOpenDataDir,
  onQuit,
  isPaused,
  isAutostart,
  getHotkey,
  stats
}) {
  let image = nativeImage.createFromPath(trayIconPath);
  if (image.isEmpty()) {
    console.warn('[tray] 图标加载失败，托盘图标将不可见:', trayIconPath);
  } else {
    image = image.resize({ width: 16, height: 16 });
  }

  const tray = new Tray(image);

  function rebuild() {
    const paused = isPaused();
    const autostart = isAutostart();
    const hotkey = getHotkey() || '';
    const s = stats();

    const menu = Menu.buildFromTemplate([
      { label: '唤出面板', click: onToggle },
      { type: 'separator' },
      { label: hotkey ? `设置热键…（当前 ${hotkey}）` : '设置热键…（当前没有可用的热键）', click: onHotkeySettings },
      { type: 'checkbox', label: '开机自动启动', checked: autostart, click: onAutostartToggle },
      { type: 'separator' },
      { label: paused ? '继续记录剪贴板' : '暂停记录剪贴板', click: onPauseToggle },
      {
        label: `历史：${s.total} 条（收藏 ${s.pinned} · 图片 ${s.images} · ${(s.bytes / 1024).toFixed(0)} KB）`,
        enabled: false
      },
      { type: 'separator' },
      { label: '打开数据目录', click: onOpenDataDir },
      { label: '退出', click: onQuit }
    ]);
    tray.setContextMenu(menu);

    const status = [];
    if (paused) status.push('已暂停记录');
    if (autostart) status.push('开机自启');
    tray.setToolTip(
      `粘贴管理器${status.length ? '（' + status.join(' · ') + '）' : ''}${hotkey ? ' · ' + hotkey + ' 唤出' : ''}`
    );
  }

  tray.on('click', onToggle);
  tray.on('double-click', onToggle);
  rebuild();

  return { tray, rebuild, destroy: () => tray.destroy() };
}

module.exports = { createTray };
