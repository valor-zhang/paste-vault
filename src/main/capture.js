'use strict';

/**
 * 剪贴板监听：轮询取样（Electron 在 Windows 上没有剪贴板变更事件）。
 *
 * Electron 44 起剪贴板模块换成了 W3C 风格的新接口：
 *   clipboard.read()  -> Promise<ClipboardItem[]>（每项有 types / getType()）
 *   clipboard.readText() / writeText() -> Promise
 * 旧的 availableFormats / readBuffer / readImage 全部已删除。
 * 原生格式用 `electron application/osclipboard;format="名字"` 这种 MIME 访问；
 * 文件列表用 `text/uri-list`，在 Windows 上就是 CF_HDROP。
 *
 * 取样优先级：文件 > 文本 > 图片。
 * 节奏自适应：文本每轮只做一次廉价的 readText；只有剪贴板装着图片时才去取图，
 * 且同一张图连续多次没变化就自动降频，长时间挂着截图也不会烧 CPU。
 */

const { clipboard } = require('electron');
const { fileURLToPath } = require('url');
const { classify } = require('./classify');
const { hashText, hashBuffer } = require('./store');

const TICK_MS = 700; // 取样间隔
const IMAGE_SLOWDOWN_AFTER = 3; // 同一张图连续 N 次无变化后降频
const IMAGE_SLOWDOWN_FACTOR = 8; // 降频倍数
const DEBUG = process.env.PASTE_MANAGER_DEBUG === '1'; // 排错用：把每轮取样结果打到终端

/** Windows 上表示"这条别记录"的剪贴板格式（密码管理器会用） */
const CONCEAL_HARD = ['Clipboard Viewer Ignore', 'ExcludeClipboardContentFromMonitorProcessing'];
const CONCEAL_DWORD = ['CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard'];

const osFormat = (name) => `electron application/osclipboard;format="${name}"`;

/** `file:///C:/a/b.txt` → `C:\a\b.txt` */
function uriToPath(uri) {
  try {
    return fileURLToPath(uri);
  } catch {
    return decodeURIComponent(String(uri).replace(/^file:\/\/\/?/, ''));
  }
}

function pathToUri(p) {
  const normalized = String(p).replace(/\\/g, '/');
  const withRoot = /^[a-zA-Z]:/.test(normalized) ? '/' + normalized : normalized;
  return 'file://' + encodeURI(withRoot).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

function pathsToUriList(paths) {
  return paths.map(pathToUri).join('\r\n');
}

function parseUriList(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(uriToPath)
    .filter(Boolean);
}

function findType(item, predicate) {
  return (item.types || []).find((t) => predicate(String(t)));
}

async function blobBytes(item, type) {
  const blob = await item.getType(type);
  return Buffer.from(await blob.arrayBuffer());
}

/** 文件列表：优先 text/uri-list（Windows 上即 CF_HDROP） */
async function readFileListFrom(items) {
  for (const item of items) {
    const type = findType(item, (t) => t === 'text/uri-list');
    if (!type) continue;
    try {
      const blob = await item.getType(type);
      const text = await blob.text();
      const paths = parseUriList(text);
      if (paths.length) return paths;
    } catch {
      /* 换下一种格式 */
    }
  }
  return [];
}

/**
 * 图片：优先 image/png，退回任意 image/*。
 * 传入 maxBytes 时先用 blob.size 预判：超限的内容不再整块读入内存。
 * 旧实现会把超限大图整个拉进 Buffer、算完哈希再丢弃 —— 一张 30MB 截图
 * 挂在剪贴板上时，主进程每隔几秒（降频后）就要重复分配 30MB。
 * 返回 { type, buf } = 正常图片；{ type, oversize } = 超限；null = 没有图片。
 */
async function readImageFrom(items, maxBytes) {
  const rank = (t) => (t === 'image/png' ? 0 : 1);
  const candidates = [];
  for (const item of items) {
    for (const type of item.types || []) {
      if (/^image\//i.test(String(type))) candidates.push({ item, type });
    }
  }
  candidates.sort((a, b) => rank(a.type) - rank(b.type));
  for (const { item, type } of candidates) {
    try {
      const blob = await item.getType(type);
      const size = typeof blob.size === 'number' ? blob.size : -1;
      if (size === 0) continue; // 空内容换下一个候选（与旧行为一致）
      if (maxBytes > 0 && size > maxBytes) {
        // 与旧实现语义一致：第一个能取到内容的候选超限，整张图就跳过，
        // 不再继续尝试其它格式
        return { type, oversize: size };
      }
      const buf = Buffer.from(await blob.arrayBuffer());
      if (buf.length) return { type, buf };
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
}

/**
 * 敏感内容判定：命中"排除监控"标志就整条跳过。
 * @param {Electron.ClipboardItem[]} items
 * @param {string[]} types 所有条目展开后的类型列表
 */
async function isConcealed(items, types) {
  const lower = types.map((t) => String(t).toLowerCase());
  const present = (name) => {
    const target = name.toLowerCase();
    return lower.some((t) => t === target || t.endsWith(`format="${target}"`));
  };

  for (const name of CONCEAL_HARD) if (present(name)) return true;

  for (const name of CONCEAL_DWORD) {
    if (!present(name)) continue;
    const wanted = osFormat(name).toLowerCase();
    let decided = false;
    for (const item of items) {
      const type = findType(item, (t) => t.toLowerCase() === wanted);
      if (!type) continue;
      try {
        const buf = await blobBytes(item, type);
        if (buf.length >= 4) return buf.readUInt32LE(0) === 0; // 值为 0 = 不要记录
        decided = true;
      } catch {
        return true; // 读不到就保守跳过
      }
    }
    if (!decided) return true;
  }
  return false;
}

/**
 * @param {{store: import('./store').Store, onCaptured?: (r:{id:number,kind:string,item:any})=>void}} deps
 */
function createCapture({ store, onCaptured }) {
  let timer = null;
  let busy = false;
  let tickCount = 0;
  let lastTextHash = null; // 只存 SHA1 指纹：旧实现把整段剪贴板文本扣在主进程里，
  // 复制过大文档（可达数 MB，UTF-16 再翻倍）后会一直常驻到剪贴板变成别的内容
  let lastFilesKey = null;
  let lastImageHash = null;
  let lastOversizeKey = null; // 超限图片的指纹（格式:大小）：超限内容不读正文，没法用内容哈希记账
  let imageIdleTicks = 0;
  const selfWrites = new Set(); // 自己写进剪贴板的内容，不再当新条目收一遍

  function noteSelfWrite(hash) {
    if (!hash) return;
    selfWrites.add(hash);
    if (selfWrites.size > 20) selfWrites.clear();
  }

  function commit(payload) {
    const res = store.add(payload);
    if (res.duplicate) return;
    store.enforceLimits();
    const item = store.get(res.id);
    if (typeof onCaptured === 'function') onCaptured({ id: res.id, kind: payload.kind, item });
  }

  async function sample() {
    tickCount++;
    if (store.settings().paused) return;

    let items;
    try {
      items = await clipboard.read();
    } catch (err) {
      if (DEBUG) console.error('[capture] clipboard.read 失败:', err.message);
      return; // 剪贴板正被别的进程占用，下一轮再来
    }
    if (!Array.isArray(items) || !items.length) {
      if (DEBUG && tickCount % 10 === 1) console.log('[capture] tick#%d 空剪贴板', tickCount);
      return;
    }

    const types = items.flatMap((it) => it.types || []);

    const concealed = await isConcealed(items, types);
    if (DEBUG && tickCount % 10 === 1) {
      console.log(`[capture] tick#${tickCount} types=${JSON.stringify(types)} concealed=${concealed}`);
    }
    if (concealed) return;

    // 1) 文件
    const files = await readFileListFrom(items);
    if (files.length) {
      const key = hashBuffer(Buffer.from(files.join('\0'), 'utf8'), 'f:paths');
      if (key !== lastFilesKey && !selfWrites.has(key)) {
        lastFilesKey = key;
        lastTextHash = null;
        lastImageHash = null;
        commit({
          kind: 'files',
          subtype: 'path',
          text: files.join('\n'),
          hash: key,
          meta: { files: files.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() || p })) },
          bytes: files.reduce((n, p) => n + Buffer.byteLength(p, 'utf8'), 0)
        });
      }
      return;
    }
    lastFilesKey = null;

    // 2) 文本
    let text = '';
    try {
      text = await clipboard.readText();
    } catch {
      text = '';
    }
    if (text && text.length) {
      // 指纹相同视为内容未变：与原字符串全等比对的判重语义一致（SHA1 碰撞可忽略）。
      // 大文本常驻剪贴板时每轮多一次哈希（sha1 ~GB/s，5MB 约 5ms），换掉的是
      // 主进程里长期扣着的整段大字符串。
      const hash = hashText(text);
      if (hash !== lastTextHash) {
        lastTextHash = hash;
        lastImageHash = null;
        if (!selfWrites.has(hash)) {
          commit({
            kind: 'text',
            subtype: classify(text),
            text,
            hash,
            bytes: Buffer.byteLength(text, 'utf8')
          });
        }
      }
      return;
    }
    lastTextHash = null;

    // 3) 图片
    if (imageIdleTicks >= IMAGE_SLOWDOWN_AFTER && tickCount % IMAGE_SLOWDOWN_FACTOR !== 0) return;

    const limit = store.settings().maxImageBytes;
    const image = await readImageFrom(items, limit);
    if (!image) {
      lastImageHash = null;
      lastOversizeKey = null;
      imageIdleTicks = 0;
      return;
    }

    if (image.oversize) {
      // 超限图片：不读内容，用「格式:大小」指纹保持与旧实现一致的记账节奏 ——
      // 首次发现警告一次并清零降频计数，之后无变化则累计计数、进入降频
      lastImageHash = null;
      const key = `${image.type}:${image.oversize}`;
      if (key !== lastOversizeKey) {
        lastOversizeKey = key;
        imageIdleTicks = 0;
        console.warn(`[capture] 图片 ${Math.round(image.oversize / 1024)}KB 超过上限 ${Math.round(limit / 1024)}KB，已跳过`);
      } else {
        imageIdleTicks++;
      }
      return;
    }

    lastOversizeKey = null;
    const hash = hashBuffer(image.buf, 'i:');
    if (hash === lastImageHash) {
      imageIdleTicks++;
      return;
    }
    lastImageHash = hash;
    imageIdleTicks = 0;

    if (image.buf.length > limit) {
      // 兜底：blob.size 与实际字节数理论上不会不一致，保留旧的超限检查
      console.warn(`[capture] 图片 ${Math.round(image.buf.length / 1024)}KB 超过上限 ${Math.round(limit / 1024)}KB，已跳过`);
      return;
    }
    if (selfWrites.has(hash)) return;

    const ext = (image.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const saved = store.saveImage(image.buf, ext);
    commit({
      kind: 'image',
      subtype: 'image',
      text: null,
      hash,
      blobPath: saved.blobPath,
      bytes: saved.bytes,
      meta: { mime: image.type }
    });
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (busy) return; // 上一轮还没跑完（比如图很大），跳过这一拍
        busy = true;
        sample()
          .catch((err) => console.error('[capture] 取样异常:', err && err.message ? err.message : err))
          .finally(() => {
            busy = false;
          });
      }, TICK_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    noteSelfWrite,
    /** 供其它模块复用 */
    readFileList: readFileListFrom,
    isConcealed
  };
}

module.exports = {
  createCapture,
  isConcealed,
  parseUriList,
  pathsToUriList,
  pathToUri,
  uriToPath,
  TICK_MS
};
