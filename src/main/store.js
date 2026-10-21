'use strict';

/**
 * 存储层：SQLite（better-sqlite3）+ 图片文件落盘。
 * 所有剪贴板历史都在本地，不发网络请求。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DEFAULT_SETTINGS = {
  maxItems: 500, // 非收藏条目上限（收藏/置顶永不清理）
  maxImages: 100, // 图片条目额外上限（占地大）
  maxImageBytes: 10 * 1024 * 1024, // 单张图片上限 10MB
  hotkey: 'Control+Shift+V',
  autostart: false,
  pasteDelayMs: 140, // 关窗到按下 Ctrl+V 之间的等待，给焦点回归留时间
  filesAsText: false, // 文件记录回填方式：false=还原成文件列表，true=纯文本路径
  paused: false // 暂停监听
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT    NOT NULL,
  subtype      TEXT    NOT NULL DEFAULT 'other',
  text         TEXT,
  hash         TEXT    NOT NULL UNIQUE,
  blob_path    TEXT,
  bytes        INTEGER NOT NULL DEFAULT 0,
  meta         TEXT,
  pinned       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  use_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_order ON items (pinned DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_kind  ON items (kind, subtype);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS item_tags (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const SUBTYPE_FILTERS = new Set(['url', 'color', 'code', 'path', 'email', 'json', 'number']);

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m);
}

function hashText(text) {
  return 't:' + crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

function hashBuffer(buf, tag) {
  return (tag || 'b') + ':' + crypto.createHash('sha1').update(buf).digest('hex');
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.blobsDir = path.join(dir, 'blobs');
    fs.mkdirSync(this.blobsDir, { recursive: true });

    this.db = new Database(path.join(dir, 'paste.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);

    this._settings = {};
    this._loadSettings();

    const p = (sql) => this.db.prepare(sql);
    this.stFindByHash = p('SELECT * FROM items WHERE hash = ?');
    this.stInsert = p(`INSERT INTO items (kind, subtype, text, hash, blob_path, bytes, meta, pinned, created_at)
                       VALUES (@kind, @subtype, @text, @hash, @blob_path, @bytes, @meta, @pinned, @created_at)`);
    this.stBump = p('UPDATE items SET created_at = @now, last_used_at = @now, use_count = use_count + 1 WHERE id = @id');
    this.stGet = p('SELECT * FROM items WHERE id = ?');
    this.stTogglePin = p('UPDATE items SET pinned = CASE pinned WHEN 0 THEN 1 ELSE 0 END WHERE id = ?');
    this.stDelete = p('DELETE FROM items WHERE id = ?');
    this.stTagsOf = p(`SELECT it.item_id AS item_id, t.name AS name
                       FROM item_tags it JOIN tags t ON t.id = it.tag_id`);
    this.stTagsForItem = p(`SELECT t.name AS name
                            FROM item_tags it JOIN tags t ON t.id = it.tag_id
                            WHERE it.item_id = ?`);
    this.stUpsertTag = p('INSERT OR IGNORE INTO tags (name) VALUES (?)');
    this.stTagId = p('SELECT id FROM tags WHERE name = ?');
    this.stLinkTag = p('INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)');
    this.stUnlinkTag = p('DELETE FROM item_tags WHERE item_id = ? AND tag_id = ?');
    this.stDropUnusedTag = p('DELETE FROM tags WHERE id = ? AND NOT EXISTS (SELECT 1 FROM item_tags WHERE tag_id = ?)');
  }

  // ---------- 设置 ----------

  _loadSettings() {
    this._settings = { ...DEFAULT_SETTINGS };
    for (const row of this.db.prepare('SELECT key, value FROM settings').all()) {
      try {
        this._settings[row.key] = JSON.parse(row.value);
      } catch {
        /* 忽略坏值，用默认 */
      }
    }
  }

  settings() {
    return { ...this._settings };
  }

  /** 这个设置项是否被显式设置过（用来区分"从没设过"和"设成了 false"） */
  hasSetting(key) {
    return !!this.db.prepare('SELECT 1 AS x FROM settings WHERE key = ?').get(key);
  }

  setSetting(key, value) {
    this._settings[key] = value;
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
    return this._settings[key];
  }

  // ---------- 写入 ----------

  /**
   * 逻辑时钟：保证后写入的条目时间戳一定大于此前所有条目。
   * 只用 Date.now() 的话，同一毫秒内的连续粘贴会因为时间戳相同而排序错乱
   * （"刚用过的那条"顶不到最前）。
   */
  _nextStamp() {
    const max = this.db.prepare('SELECT COALESCE(MAX(created_at), 0) AS m FROM items').get().m;
    const now = Date.now();
    return now > max ? now : max + 1;
  }

  /** 落盘一张图片，返回 { blobPath, bytes } */
  saveImage(buffer, ext = 'png') {
    const safeExt = String(ext || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${safeExt}`;
    fs.writeFileSync(path.join(this.blobsDir, name), buffer);
    return { blobPath: name, bytes: buffer.length };
  }

  blobAbs(relPath) {
    return path.join(this.blobsDir, relPath);
  }

  /**
   * 新增一条记录。内容完全相同则只把旧记录顶到最前，不重复入库。
   * @returns {{id:number, duplicate:boolean}}
   */
  add(item) {
    const existing = this.stFindByHash.get(item.hash);
    if (existing) {
      this.stBump.run({ id: existing.id, now: this._nextStamp() });
      if (item.blobPath && item.blobPath !== existing.blob_path) {
        // 同图不同文件，清掉新落的盘
        try {
          fs.unlinkSync(this.blobAbs(item.blobPath));
        } catch {}
      }
      return { id: existing.id, duplicate: true };
    }
    const info = this.stInsert.run({
      kind: item.kind,
      subtype: item.subtype || 'other',
      text: item.text ?? null,
      hash: item.hash,
      blob_path: item.blobPath ?? null,
      bytes: item.bytes ?? 0,
      meta: item.meta ? JSON.stringify(item.meta) : null,
      pinned: 0,
      created_at: this._nextStamp()
    });
    return { id: Number(info.lastInsertRowid), duplicate: false };
  }

  touch(id) {
    this.stBump.run({ id, now: this._nextStamp() });
  }

  togglePin(id) {
    this.stTogglePin.run(id);
  }

  remove(id) {
    const row = this.stGet.get(id);
    if (row && row.blob_path) {
      try {
        fs.unlinkSync(this.blobAbs(row.blob_path));
      } catch {}
    }
    this.stDelete.run(id);
    return row;
  }

  // ---------- 读取 ----------

  _rowToItem(row, tagMap) {
    let meta = null;
    if (row.meta) {
      try {
        meta = JSON.parse(row.meta);
      } catch {}
    }
    return {
      id: row.id,
      kind: row.kind,
      subtype: row.subtype,
      hash: row.hash,
      blobPath: row.blob_path,
      text: row.text,
      bytes: row.bytes,
      meta,
      pinned: !!row.pinned,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      useCount: row.use_count,
      hasBlob: !!row.blob_path,
      tags: (tagMap && tagMap.get(row.id)) || []
    };
  }

  /**
   * @param {{q?:string, filter?:string, limit?:number, offset?:number}} opts
   */
  list(opts = {}) {
    const q = (opts.q || '').trim();
    const filter = opts.filter || 'all';
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);

    const where = [];
    const params = { limit, offset };

    if (filter === 'pinned') where.push('pinned = 1');
    else if (filter === 'image') where.push("kind = 'image'");
    else if (filter === 'files') where.push("kind = 'files'");
    else if (filter === 'text') where.push("kind = 'text'");
    else if (typeof filter === 'string' && filter.startsWith('tag:')) {
      where.push(
        'id IN (SELECT it.item_id FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE t.name = @tag)'
      );
      params.tag = filter.slice(4);
    } else if (SUBTYPE_FILTERS.has(filter)) {
      where.push('subtype = @subtype');
      params.subtype = filter;
    }

    if (q) {
      where.push("(text LIKE @like ESCAPE '\\' OR meta LIKE @like ESCAPE '\\')");
      params.like = '%' + escapeLike(q) + '%';
    }

    const sql = `SELECT * FROM items
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY pinned DESC, created_at DESC, id DESC
                 LIMIT @limit OFFSET @offset`;
    const rows = this.db.prepare(sql).all(params);

    const tagMap = new Map();
    for (const t of this.stTagsOf.all()) {
      if (!tagMap.has(t.item_id)) tagMap.set(t.item_id, []);
      tagMap.get(t.item_id).push(t.name);
    }
    return rows.map((r) => this._rowToItem(r, tagMap));
  }

  get(id) {
    const row = this.stGet.get(id);
    if (!row) return null;
    const tagMap = new Map([[id, this.stTagsForItem.all(id).map((r) => r.name)]]);
    return this._rowToItem(row, tagMap);
  }

  stats() {
    const one = (sql) => this.db.prepare(sql).get();
    const total = one('SELECT COUNT(*) AS n FROM items').n;
    const pinned = one('SELECT COUNT(*) AS n FROM items WHERE pinned = 1').n;
    const images = one("SELECT COUNT(*) AS n FROM items WHERE kind = 'image'").n;
    const bytes = one('SELECT COALESCE(SUM(bytes), 0) AS n FROM items').n;
    return { total, pinned, images, bytes };
  }

  // ---------- 容量治理 ----------

  /** 超限清理：只清非收藏条目。返回被删条目的 blob_path 已随之删除。 */
  enforceLimits() {
    const s = this.settings();
    const victims = new Map();
    const collect = (rows) => {
      for (const r of rows) victims.set(r.id, r);
    };

    collect(
      this.db
        .prepare(
          'SELECT id, blob_path FROM items WHERE pinned = 0 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET @max'
        )
        .all({ max: s.maxItems })
    );
    collect(
      this.db
        .prepare(
          "SELECT id, blob_path FROM items WHERE pinned = 0 AND kind = 'image' ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET @max"
        )
        .all({ max: s.maxImages })
    );
    collect(
      this.db
        .prepare("SELECT id, blob_path FROM items WHERE pinned = 0 AND kind = 'image' AND bytes > @max")
        .all({ max: s.maxImageBytes })
    );

    for (const r of victims.values()) this.remove(r.id);
    return victims.size;
  }

  /** 清理没有被任何记录引用的图片文件（异常退出后的遗物） */
  pruneOrphanBlobs() {
    const used = new Set(
      this.db
        .prepare('SELECT blob_path FROM items WHERE blob_path IS NOT NULL')
        .all()
        .map((r) => r.blob_path)
    );
    let removed = 0;
    for (const name of fs.readdirSync(this.blobsDir)) {
      if (!used.has(name)) {
        try {
          fs.unlinkSync(path.join(this.blobsDir, name));
          removed++;
        } catch {}
      }
    }
    return removed;
  }

  // ---------- 标签 ----------

  addTag(itemId, name) {
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) return;
    this.stUpsertTag.run(clean);
    const tag = this.stTagId.get(clean);
    this.stLinkTag.run(itemId, tag.id);
  }

  removeTag(itemId, name) {
    const clean = String(name || '').trim();
    if (!clean) return;
    const tag = this.stTagId.get(clean);
    if (!tag) return;
    this.stUnlinkTag.run(itemId, tag.id);
    this.stDropUnusedTag.run(tag.id, tag.id);
  }

  allTags() {
    return this.db
      .prepare(
        'SELECT t.name, COUNT(it.item_id) AS n FROM tags t LEFT JOIN item_tags it ON it.tag_id = t.id GROUP BY t.id ORDER BY n DESC, t.name'
      )
      .all();
  }

  // ---------- 备份 ----------

  exportData() {
    const items = this.db.prepare('SELECT * FROM items ORDER BY created_at DESC').all().map((r) => ({
      ...this._rowToItem(r),
      hash: r.hash,
      blobPath: r.blob_path
    }));
    return { app: 'paste-manager', version: 1, exportedAt: Date.now(), items, tags: this.allTags() };
  }

  /** 导入：按 hash 去重，已存在则跳过。返回 {added, skipped} */
  importData(payload) {
    if (!payload || !Array.isArray(payload.items)) throw new Error('不是有效的导出文件');
    let added = 0;
    let skipped = 0;
    const tx = this.db.transaction((rows) => {
      for (const it of rows) {
        if (!it || !it.hash) {
          skipped++;
          continue;
        }
        if (this.stFindByHash.get(it.hash)) {
          skipped++;
          continue;
        }
        this.stInsert.run({
          kind: it.kind || 'text',
          subtype: it.subtype || 'other',
          text: it.text ?? null,
          hash: it.hash,
          blob_path: null, // 跨机器导入不含图片文件本体
          bytes: it.bytes ?? 0,
          meta: it.meta ? JSON.stringify(it.meta) : null,
          pinned: it.pinned ? 1 : 0,
          created_at: it.createdAt || Date.now()
        });
        const id = Number(this.db.prepare('SELECT last_insert_rowid() AS id').get().id);
        for (const tag of it.tags || []) this.addTag(id, tag);
        added++;
      }
    });
    tx(payload.items);
    return { added, skipped };
  }

  close() {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {}
    this.db.close();
  }
}

module.exports = { Store, DEFAULT_SETTINGS, hashText, hashBuffer, escapeLike };
