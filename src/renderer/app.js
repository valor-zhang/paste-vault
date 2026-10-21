'use strict';

const $ = (sel) => document.querySelector(sel);
const listEl = $('#list');
const qEl = $('#q');
const chipsEl = $('#chips');
const countEl = $('#count');
const statusEl = $('#status');
const settingsEl = $('#settings');
const tagbarEl = $('#tagbar');
const tagListEl = $('#taglist');
const tagInputEl = $('#taginput');

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'pinned', label: '收藏' },
  { key: 'text', label: '文本' },
  { key: 'url', label: '链接' },
  { key: 'code', label: '代码' },
  { key: 'color', label: '颜色' },
  { key: 'path', label: '路径' },
  { key: 'image', label: '图片' },
  { key: 'files', label: '文件' }
];

const SUBTYPE_LABEL = {
  text: '文本',
  url: '链接',
  color: '颜色',
  email: '邮箱',
  path: '路径',
  json: 'JSON',
  code: '代码',
  number: '数字',
  image: '图片',
  other: '其它'
};

const state = {
  items: [],
  total: 0,
  q: '',
  filter: 'all',
  index: 0,
  settings: {},
  paused: false,
  view: 'list', // list | settings
  tagTarget: null // 正在打标签的条目
};

let allTags = [];

// 一次最多往 DOM 里塞多少行。几百条全渲染既费内存也拖慢每次重绘，
// 实际只渲染选中项附近这一段窗口。
const RENDER_LIMIT = 60;

// ---------- 工具 ----------

function esc(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function mark(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  const needle = esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return safe.replace(new RegExp(needle, 'gi'), (m) => `<mark>${m}</mark>`);
  } catch {
    return safe;
  }
}

function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  const d = new Date(ts);
  const today = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === today.toDateString()) return `今天 ${hm}`;
  const y = new Date(today.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}

function humanBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function collapse(s) {
  return String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// ---------- 渲染 ----------

function renderChips() {
  const base = FILTERS.map(
    (f) => `<span class="chip${f.key === state.filter ? ' on' : ''}" data-filter="${f.key}">${f.label}</span>`
  ).join('');
  const tags = allTags.length
    ? `<span class="chip-sep"></span>` +
      allTags
        .map((t) => {
          const key = `tag:${t.name}`;
          return `<span class="chip tag${key === state.filter ? ' on' : ''}" data-filter="${esc(key)}">#${esc(
            t.name
          )} <i>${t.n}</i></span>`;
        })
        .join('')
    : '';
  chipsEl.innerHTML = base + tags;
}

function rowHtml(item, idx) {
  const kindClass = item.kind === 'image' ? 't-image' : item.kind === 'files' ? 't-files' : `t-${item.subtype}`;
  const badge = item.kind === 'image' ? '图片' : item.kind === 'files' ? '文件' : SUBTYPE_LABEL[item.subtype] || '文本';

  let content = '';
  if (item.kind === 'image') {
    const dims = item.meta && item.meta.width ? `${item.meta.width}×${item.meta.height}` : '';
    // loading=lazy：只有滚到可见位置才解码。截图一张解码后可能十几 MB，
    // 一屏几十张全解码就是上百 MB —— 这是渲染进程内存的大头。
    content = `<img class="thumb" loading="lazy" decoding="async" src="${item.blobUrl}" alt="图片 ${esc(dims)}" />`;
  } else if (item.kind === 'files') {
    const files = (item.meta && item.meta.files) || [];
    const names = files.map((f) => f.name || f.path);
    const shown = names.slice(0, 3).map((n) => mark(collapse(n), state.q)).join('<br>');
    const more = names.length > 3 ? `<br>… 另有 ${names.length - 3} 个` : '';
    content = `<div class="text">${shown}${more}</div>`;
  } else {
    content = `<div class="text${/[\r\n]/.test(item.text || '') ? '' : ' one-line'}">${mark(
      collapse(item.text).slice(0, 600),
      state.q
    )}</div>`;
  }

  const tags = (item.tags || []).length
    ? `<span class="tags">${item.tags.map((t) => `#${esc(t)}`).join(' ')}</span>`
    : '';
  const dup = item.useCount > 1 ? `<span>用过 ${item.useCount} 次</span>` : '';
  const size = item.bytes ? `<span>${humanBytes(item.bytes)}</span>` : '';

  return `<div class="row${idx === state.index ? ' sel' : ''}${item.pinned ? ' pinned' : ''}" data-idx="${idx}">
      <span class="badge ${kindClass}">${badge}</span>
      <div class="body">
        ${content}
        <div class="sub"><span>${relTime(item.createdAt)}</span>${tags}${size}${dup}</div>
      </div>
      <span class="star">★</span>
    </div>`;
}

function render() {
  if (!state.items.length) {
    const msg = state.q
      ? `<b>没找到「${esc(state.q)}」</b>换个关键词，或者按 Tab 换个类型筛选。`
      : state.filter.startsWith('tag:')
        ? `<b>这个标签下还没有条目</b>选中某条按 <kbd>Ctrl</kbd>+<kbd>T</kbd> 可以打标签。`
        : `<b>这里还是空的</b>复制任意文字、图片或文件，它就会出现在这里。<br>按 <kbd>Esc</kbd> 收起面板。`;
    listEl.innerHTML = `<div class="empty">${msg}</div>`;
  } else {
    // 只渲染选中项附近的一段窗口：几百条全塞进 DOM 既费内存也费渲染时间。
    const total = state.items.length;
    const limit = Math.min(total, RENDER_LIMIT);
    let start = 0;
    if (total > limit) {
      start = Math.min(Math.max(state.index - Math.floor(limit / 2), 0), total - limit);
    }
    const end = start + limit;
    const rows = state.items.slice(start, end).map((it, i) => rowHtml(it, start + i)).join('');
    const more =
      end < total ? `<div class="empty more">下面还有 ${total - end} 条，输入关键词缩小范围</div>` : '';
    listEl.innerHTML = rows + more;
  }
  countEl.textContent = state.total ? `${state.items.length} / ${state.total}` : '';
}

function scrollToSelected() {
  const el = listEl.querySelector('.row.sel');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

// ---------- 数据加载 ----------

let reloadTimer = null;
function scheduleReload() {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => load(true), 120);
}

async function load(keepIndex) {
  const [items, stats, tags] = await Promise.all([
    window.api.list({ q: state.q, filter: state.filter, limit: 300 }),
    window.api.stats(),
    window.api.tags()
  ]);
  state.items = items;
  state.total = stats.total;
  allTags = tags || [];
  if (!keepIndex) state.index = 0;
  state.index = Math.min(state.index, Math.max(0, state.items.length - 1));
  renderChips();
  render();
  scrollToSelected();
}

function select(idx) {
  if (!state.items.length) return;
  const n = state.items.length;
  state.index = ((idx % n) + n) % n;

  // 只改两个 class，不重建 DOM：按住方向键翻列表时不再反复重排几百行
  const target = listEl.querySelector(`.row[data-idx="${state.index}"]`);
  if (target) {
    const prev = listEl.querySelector('.row.sel');
    if (prev) prev.classList.remove('sel');
    target.classList.add('sel');
    target.scrollIntoView({ block: 'nearest' });
  } else {
    // 选中项滑出了当前渲染窗口，才需要重画
    render();
    scrollToSelected();
  }
}

function current() {
  return state.items[state.index];
}

let flashTimer = null;

/** 空闲时底栏常驻显示的提示 */
function idleStatus() {
  if (state.paused) return '已暂停记录';
  const s = state.settings || {};
  if (s.hotkeyFallbackFrom && s.hotkeyActive) {
    return `热键：${s.hotkeyActive}（${s.hotkeyFallbackFrom} 被占用，下次启动会再试）`;
  }
  return '';
}

function flash(text) {
  statusEl.textContent = text;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    statusEl.textContent = idleStatus();
  }, 1800);
}

// ---------- 条目操作 ----------

async function pasteIdx(idx) {
  const item = state.items[idx];
  if (!item) return;
  const res = await window.api.paste(item.id);
  if (!res || !res.ok) flash(res && res.reason === 'unsupported' ? '这条内容暂时无法回填' : '粘贴失败');
}

async function pinIdx(idx) {
  const item = state.items[idx];
  if (!item) return;
  await window.api.pin(item.id);
  flash(item.pinned ? '已取消收藏' : '已收藏，永久保留');
  await load(true);
  const at = state.items.findIndex((it) => it.id === item.id);
  if (at >= 0) select(at);
}

async function deleteIdx(idx) {
  const item = state.items[idx];
  if (!item) return;
  await window.api.remove(item.id);
  flash('已删除');
  await load(true);
}

function cycleFilter(step) {
  const keys = FILTERS.map((f) => f.key).concat(allTags.map((t) => `tag:${t.name}`));
  const i = keys.indexOf(state.filter);
  state.filter = keys[(((i + step) % keys.length) + keys.length) % keys.length];
  state.index = 0;
  renderChips();
  load();
}

// ---------- 标签 ----------

function renderTagbar() {
  const item = state.tagTarget;
  if (!item) return;
  const tags = item.tags || [];
  tagListEl.innerHTML = tags.length
    ? tags.map((t) => `<span class="tag-chip" data-tag="${esc(t)}">#${esc(t)} ×</span>`).join('')
    : `<span class="tag-empty">还没有标签</span>`;
}

function openTagbar() {
  const item = current();
  if (!item) return;
  state.tagTarget = item;
  tagbarEl.classList.remove('hidden');
  renderTagbar();
  tagInputEl.value = '';
  tagInputEl.focus();
}

function closeTagbar() {
  state.tagTarget = null;
  tagbarEl.classList.add('hidden');
  qEl.focus();
}

async function addTag(name) {
  const item = state.tagTarget;
  const clean = String(name || '').trim();
  if (!item || !clean) return;
  const res = await window.api.tagAdd(item.id, clean);
  allTags = res.tags || [];
  item.tags = res.itemTags || [];
  renderTagbar();
  renderChips();
  tagInputEl.value = '';
  flash(`已加标签 #${clean}`);
}

async function removeTag(name) {
  const item = state.tagTarget;
  if (!item) return;
  const res = await window.api.tagRemove(item.id, name);
  allTags = res.tags || [];
  item.tags = res.itemTags || [];
  renderTagbar();
  renderChips();
  flash(`已移除标签 #${name}`);
}

// ---------- 设置面板 ----------

let filling = false;

function setMsg(text, isError) {
  const el = $('#set-msg');
  el.textContent = text || '';
  el.classList.toggle('err', !!isError);
}

function fillSettings(s) {
  filling = true;
  // 输入框里显示"用户想要的那个键"，即使本次没抢到 —— 下次启动还会再试它
  $('#set-hotkey').value = s.hotkey || '';
  $('#set-maxItems').value = s.maxItems;
  $('#set-maxImages').value = s.maxImages;
  $('#set-maxImageMB').value = Math.round((s.maxImageBytes || 0) / 1024 / 1024);
  $('#set-pasteDelay').value = s.pasteDelayMs;
  $('#set-filesAsText').checked = !!s.filesAsText;
  // 自启以注册表实际状态为准（数据库里是"意愿"，开机自启项才是"事实"）
  $('#set-autostart').checked = s.autostartActive !== undefined ? !!s.autostartActive : !!s.autostart;
  $('#set-datadir').textContent = s.dataDir || '';
  filling = false;
}

async function openSettings() {
  const s = await window.api.settings();
  state.settings = s;
  fillSettings(s);
  if (s.hotkeyFallbackFrom) {
    setMsg(`「${s.hotkeyFallbackFrom}」这次没抢到（被别的软件占用），本次先用 ${s.hotkeyActive}`, true);
  } else {
    setMsg('');
  }
  state.view = 'settings';
  settingsEl.classList.remove('hidden');
  listEl.classList.add('hidden');
  closeTagbar();
  await window.api.setView('settings');
}

function closeSettings() {
  state.view = 'list';
  settingsEl.classList.add('hidden');
  listEl.classList.remove('hidden');
  window.api.setView('list');
  qEl.focus();
}

function accelFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  const code = e.code || '';
  let key = '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) key = e.key;
  if (!key || !mods.length) return null;
  return `${mods.join('+')}+${key}`;
}

async function applyHotkey(accel) {
  const res = await window.api.setSetting('hotkey', accel);
  const s = await window.api.settings();
  state.settings = s;
  $('#set-hotkey').value = s.hotkey || accel;
  if (res && res.hotkeyOk) {
    setMsg(`热键已生效：${accel}`);
  } else if (s.hotkeyActive) {
    setMsg(`「${accel}」被别的软件占用了，本次先用 ${s.hotkeyActive}；下次启动会自动再试一次`, true);
  } else {
    setMsg(`「${accel}」注册失败，当前没有可用的全局热键`, true);
  }
}

// ---------- 事件 ----------

chipsEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.filter = chip.dataset.filter;
  state.index = 0;
  renderChips();
  load();
});

listEl.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  pasteIdx(Number(row.dataset.idx));
});

listEl.addEventListener('contextmenu', async (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  e.preventDefault();
  select(Number(row.dataset.idx));
  const item = current();
  await window.api.contextMenu(item.id);
  await load(true);
});

listEl.addEventListener('mousemove', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const idx = Number(row.dataset.idx);
  if (idx !== state.index) select(idx);
});

qEl.addEventListener('input', () => {
  state.q = qEl.value;
  scheduleReload();
});

// 设置面板
$('#btn-settings').addEventListener('click', openSettings);
$('#set-close').addEventListener('click', closeSettings);
$('#set-opendir').addEventListener('click', () => window.api.openDataDir());

const hotkeyInput = $('#set-hotkey');
hotkeyInput.addEventListener('keydown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') {
    hotkeyInput.blur();
    return;
  }
  const accel = accelFromEvent(e);
  if (!accel) {
    setMsg('热键必须带 Ctrl / Alt / Shift / Win 这类修饰键，避免把普通打字全吃掉', true);
    return;
  }
  applyHotkey(accel);
});

async function commitNumber(sel, key, transform) {
  const raw = Number($(sel).value);
  if (!Number.isFinite(raw)) return;
  const value = transform ? transform(raw) : raw;
  const res = await window.api.setSetting(key, value);
  setMsg(`${key} 已更新为 ${res && res.value !== undefined ? res.value : value}`);
  await load(true);
}

$('#set-maxItems').addEventListener('change', () => commitNumber('#set-maxItems', 'maxItems'));
$('#set-maxImages').addEventListener('change', () => commitNumber('#set-maxImages', 'maxImages'));
$('#set-maxImageMB').addEventListener('change', () =>
  commitNumber('#set-maxImageMB', 'maxImageBytes', (mb) => Math.max(1, Math.round(mb)) * 1024 * 1024)
);
$('#set-pasteDelay').addEventListener('change', () => commitNumber('#set-pasteDelay', 'pasteDelayMs'));

$('#set-filesAsText').addEventListener('change', async (e) => {
  if (filling) return;
  await window.api.setSetting('filesAsText', e.target.checked);
  setMsg(e.target.checked ? '文件将回填成纯文本路径' : '文件将还原成文件列表');
});

$('#set-autostart').addEventListener('change', async (e) => {
  if (filling) return;
  const res = await window.api.setSetting('autostart', e.target.checked);
  const on = res && res.autostartActive;
  e.target.checked = !!on;
  setMsg(
    on
      ? '已设为开机自启：下次开机自动在托盘里启动（不会弹面板抢你焦点）'
      : '已取消开机自启'
  );
});

$('#set-export').addEventListener('click', async () => {
  const res = await window.api.exportData();
  if (!res || res.canceled) return setMsg('已取消导出');
  setMsg(res.ok ? `已导出 ${res.count} 条到 ${res.file}` : `导出失败：${res.error}`, !res.ok);
});

$('#set-import').addEventListener('click', async () => {
  const res = await window.api.importData();
  if (!res || res.canceled) return setMsg('已取消导入');
  if (!res.ok) return setMsg(`导入失败：${res.error}`, true);
  setMsg(`导入完成：新增 ${res.added} 条，跳过重复 ${res.skipped} 条`);
  await load();
});

// 标签栏
tagInputEl.addEventListener('keydown', (e) => {
  // 只拦自己处理的那几个键。全拦的话 Ctrl+, / Ctrl+P 这类全局快捷键
  // 会被这里吃掉，标签栏开着的时候按什么都不灵。
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    addTag(tagInputEl.value);
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeTagbar();
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (!e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation(); // 普通打字别触发列表快捷键
});

tagListEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.tag-chip');
  if (!chip) return;
  removeTag(chip.dataset.tag);
});

// 全局键盘
document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;

  // 标签输入框里只处理自己的键
  if (document.activeElement === tagInputEl) return;

  if (state.view === 'settings') {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSettings();
    }
    return;
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    if (!tagbarEl.classList.contains('hidden')) {
      closeTagbar();
    } else if (state.q) {
      qEl.value = '';
      state.q = '';
      load();
    } else {
      window.api.hide();
    }
    return;
  }

  if (ctrl && e.key === ',') {
    e.preventDefault();
    openSettings();
    return;
  }

  if (ctrl && (e.key === 't' || e.key === 'T')) {
    e.preventDefault();
    if (tagbarEl.classList.contains('hidden')) openTagbar();
    else closeTagbar();
    return;
  }

  if (e.key === 'Tab') {
    e.preventDefault();
    cycleFilter(e.shiftKey ? -1 : 1);
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    select(state.index + 1);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    select(state.index - 1);
    return;
  }
  if (e.key === 'PageDown') {
    e.preventDefault();
    select(state.index + 10);
    return;
  }
  if (e.key === 'PageUp') {
    e.preventDefault();
    select(state.index - 10);
    return;
  }
  if (e.key === 'Home' && ctrl) {
    e.preventDefault();
    select(0);
    return;
  }
  if (e.key === 'End' && ctrl) {
    e.preventDefault();
    select(state.items.length - 1);
    return;
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    pasteIdx(state.index);
    return;
  }

  if (ctrl && (e.key === 'p' || e.key === 'P')) {
    e.preventDefault();
    pinIdx(state.index);
    return;
  }

  if (ctrl && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault();
    deleteIdx(state.index);
    return;
  }

  if (ctrl && (e.key === 'c' || e.key === 'C') && document.activeElement !== qEl) {
    e.preventDefault();
    const item = current();
    if (item) window.api.copy(item.id).then(() => flash('已复制本文'));
  }
});

// ---------- 启动 ----------

/** 托盘菜单点了"设置热键…"时，等面板复位完再进设置页 */
let pendingSettingsOpen = null;

async function enterPendingSettings() {
  if (!pendingSettingsOpen) return;
  const payload = pendingSettingsOpen;
  pendingSettingsOpen = null;
  await openSettings();
  if (payload.focus === 'hotkey') {
    const el = $('#set-hotkey');
    el.focus();
    setMsg('直接按你想用的组合键（必须带 Ctrl / Alt / Shift / Win 中的一个）');
  }
}

window.api.onOpenSettings((payload) => {
  pendingSettingsOpen = payload || {};
  setTimeout(enterPendingSettings, 150);
});

window.api.onShown(async () => {
  // 每次唤出都回到干净状态：上次的搜索词和类型筛选留着，
  // 下次按热键就会看到"没找到"的空列表，很容易被当成数据丢了。
  if (state.view === 'settings') closeSettings();
  closeTagbar();
  state.q = '';
  qEl.value = '';
  state.filter = 'all';
  state.index = 0;
  try {
    state.settings = await window.api.settings();
  } catch {}
  statusEl.textContent = idleStatus();
  await load();
  qEl.focus();
  qEl.select();
  enterPendingSettings();
});

window.api.onChanged(() => {
  if (state.view === 'list') load(true);
});

// 面板收起时把列表 DOM 清空：隐藏着的窗口不会自己释放解码后的图片位图，
// 清掉之后这些内存马上就能回收，下次唤出会重新加载。
window.api.onHidden(() => {
  listEl.innerHTML = '';
  state.items = [];
});

window.api.onStatus((payload) => {
  state.paused = !!(payload && payload.paused);
  flash(state.paused ? '已暂停记录' : '已恢复记录');
});

(async function boot() {
  const s = await window.api.settings();
  state.settings = s || {};
  state.paused = !!s.paused;
  statusEl.textContent = idleStatus();
  renderChips();
  await load();
  qEl.focus();
})();
