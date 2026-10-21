'use strict';

/**
 * 存储层自测：node test/store.test.js
 * 不依赖 Electron，纯 Node 跑，改完代码随时验证。
 */

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { Store, hashText, hashBuffer } = require('../src/main/store');
const { classify } = require('../src/main/classify');

const dir = path.join(__dirname, '..', '.tmp-test');
fs.rmSync(dir, { recursive: true, force: true });

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓', name);
  } catch (err) {
    console.log('  ✗', name);
    console.error('    ', err.message);
    process.exitCode = 1;
    throw err;
  }
}

const store = new Store(dir);
const addText = (s) => store.add({ kind: 'text', subtype: classify(s), text: s, hash: hashText(s), bytes: Buffer.byteLength(s) });

console.log('存储层');

ok('写入三条并倒序读出', () => {
  addText('第一条');
  addText('第二条');
  addText('第三条');
  const rows = store.list({ limit: 10 });
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].text, '第三条');
});

ok('重复内容不新增，只顶到最前', () => {
  addText('第一条');
  const rows = store.list({ limit: 10 });
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].text, '第一条');
});

ok('关键词搜索命中', () => {
  assert.strictEqual(store.list({ q: '第三条' }).length, 1);
  assert.strictEqual(store.list({ q: '不存在的内容' }).length, 0);
});

ok('搜索里的 % _ 被当成普通字符', () => {
  addText('100%_纯文本');
  assert.strictEqual(store.list({ q: '%_' }).length, 1);
  assert.strictEqual(store.list({ q: '%_纯文本' }).length, 1);
});

ok('按类型筛选', () => {
  addText('https://example.com/a');
  const urls = store.list({ filter: 'url' });
  assert.strictEqual(urls.length, 1);
  assert.strictEqual(urls[0].subtype, 'url');
});

ok('收藏后可筛出', () => {
  const target = store.list({ q: '第三条' })[0];
  store.togglePin(target.id);
  assert.strictEqual(store.list({ filter: 'pinned' }).length, 1);
  assert.strictEqual(store.list({ filter: 'pinned' })[0].pinned, true);
});

ok('打标签、按标签筛选、移除后回收空标签', () => {
  const target = store.list({ q: '第三条' })[0];
  store.addTag(target.id, '常用');
  store.addTag(target.id, '  常用  '); // 首尾空白应视为同一个标签
  store.addTag(target.id, '工作');
  assert.deepStrictEqual(
    store.allTags()
      .map((t) => t.name)
      .sort(),
    ['工作', '常用']
  );
  assert.deepStrictEqual(store.get(target.id).tags.slice().sort(), ['工作', '常用']);

  const byTag = store.list({ filter: 'tag:常用' });
  assert.strictEqual(byTag.length, 1);
  assert.strictEqual(byTag[0].id, target.id);
  assert.strictEqual(store.list({ filter: 'tag:不存在的标签' }).length, 0);

  store.removeTag(target.id, '工作');
  assert.deepStrictEqual(store.get(target.id).tags, ['常用']);
  assert.strictEqual(store.allTags().length, 1);

  store.removeTag(target.id, '常用');
  assert.strictEqual(store.allTags().length, 0, '没有条目再用的标签应被回收');
});

ok('超限清理不动收藏，只丢最旧的非收藏', () => {
  store.setSetting('maxItems', 3);
  const rows = store.list({ limit: 100 });
  const pinnedRow = rows.find((r) => r.pinned);
  store.enforceLimits();
  const after = store.list({ limit: 100 });
  assert.ok(after.length <= 4, `清理后应为 3 条非收藏 + 1 条收藏，实际 ${after.length}`);
  assert.ok(after.some((r) => r.id === pinnedRow.id), '收藏条目不能被杀');
  assert.ok(after.length >= 4, '非收藏应保留到上限');
});

ok('图片落盘、超限与超尺寸清理', () => {
  store.setSetting('maxItems', 500);
  const buf = Buffer.from('假装这是PNG数据');
  const saved = store.saveImage(buf);
  assert.ok(fs.existsSync(store.blobAbs(saved.blobPath)));
  const r = store.add({
    kind: 'image',
    subtype: 'image',
    hash: hashBuffer(buf, 'i:'),
    blobPath: saved.blobPath,
    bytes: saved.bytes,
    meta: { width: 10, height: 10 }
  });
  assert.ok(store.get(r.id).blobPath);

  store.setSetting('maxImageBytes', 3);
  store.enforceLimits();
  assert.ok(!store.get(r.id), '超尺寸图片应被清掉');
  assert.ok(!fs.existsSync(store.blobAbs(saved.blobPath)), '清条目要连带删掉图片文件');
  store.setSetting('maxImageBytes', 10 * 1024 * 1024);
});

ok('同图重复入库时清掉多余文件', () => {
  const png = Buffer.from('同一张图');
  const dup = store.saveImage(png);
  const a = store.add({ kind: 'image', subtype: 'image', hash: hashBuffer(png, 'i:'), blobPath: dup.blobPath, bytes: dup.bytes });
  const dup2 = store.saveImage(png);
  const b = store.add({ kind: 'image', subtype: 'image', hash: hashBuffer(png, 'i:'), blobPath: dup2.blobPath, bytes: dup2.bytes });
  assert.strictEqual(a.id, b.id);
  assert.ok(!fs.existsSync(store.blobAbs(dup2.blobPath)), '重复的图片文件应被删除');
  store.remove(a.id);
});

ok('孤立图片文件会被回收', () => {
  const orphan = store.saveImage(Buffer.from('没人引用的图'));
  assert.strictEqual(store.pruneOrphanBlobs(), 1);
  assert.ok(!fs.existsSync(store.blobAbs(orphan.blobPath)));
});

ok('导出后可原样导入到新库', () => {
  const dump = store.exportData();
  assert.ok(dump.items.length > 0);
  const dir2 = path.join(__dirname, '..', '.tmp-test2');
  fs.rmSync(dir2, { recursive: true, force: true });
  const store2 = new Store(dir2);
  const res = store2.importData(dump);
  assert.strictEqual(res.added, dump.items.length);
  assert.strictEqual(store2.list({ limit: 1000 }).length, dump.items.length);
  const again = store2.importData(dump);
  assert.strictEqual(again.added, 0, '重复导入应全部跳过');
  store2.close();
  fs.rmSync(dir2, { recursive: true, force: true });
});

ok('统计口径正确', () => {
  const s = store.stats();
  assert.strictEqual(s.total, store.list({ limit: 1000 }).length);
  assert.ok(s.bytes > 0);
});

console.log('类型识别');
ok('常见类型都能认出来', () => {
  assert.strictEqual(classify('https://a.com/x'), 'url');
  assert.strictEqual(classify('#5b8dff'), 'color');
  assert.strictEqual(classify('C:\\Users\\valor\\a.txt'), 'path');
  assert.strictEqual(classify('me@example.com'), 'email');
  assert.strictEqual(classify('{"a":1}'), 'json');
  assert.strictEqual(classify('function f(){\n  return 1;\n}'), 'code');
  assert.strictEqual(classify('这是一句普通的中文。'), 'text');
});

ok('形似但不是的不会误判', () => {
  assert.strictEqual(classify('看看 https://a.com 这个链接'), 'text');
  assert.strictEqual(classify('my-file.txt'), 'text');
  assert.strictEqual(classify('{不是合法json'), 'text');
});

store.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n全部通过：${passed} 项`);
