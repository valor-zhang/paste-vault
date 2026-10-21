'use strict';

/**
 * 图标生成：不依赖任何图形库，启动时若 assets 里缺图标就用纯 Node 现画一张。
 * 这样仓库里不需要塞二进制文件，改配色改形状都在代码里。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function inRoundRect(u, v, x0, y0, x1, y1, r) {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const cx = Math.min(Math.max(u, x0 + r), x1 - r);
  const cy = Math.min(Math.max(v, y0 + r), y1 - r);
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= r * r + 1e-9;
}

/** 单位坐标 (0..1) 上的剪贴板图形；返回 null 表示透明 */
function sampleClipboard(u, v) {
  if (inRoundRect(u, v, 0.35, 0.01, 0.65, 0.19, 0.055)) return [27, 63, 160, 255]; // 顶部夹子
  if (inRoundRect(u, v, 0.13, 0.08, 0.87, 0.97, 0.13)) {
    if (inRoundRect(u, v, 0.25, 0.32, 0.75, 0.40, 0.04)) return [255, 255, 255, 240];
    if (inRoundRect(u, v, 0.25, 0.50, 0.75, 0.58, 0.04)) return [255, 255, 255, 240];
    if (inRoundRect(u, v, 0.25, 0.68, 0.59, 0.76, 0.04)) return [255, 255, 255, 240];
    return [47, 111, 237, 255]; // 板身
  }
  return null;
}

function render(size, sampler) {
  const ss = 3; // 3x3 超采样做抗锯齿
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          const c = sampler(u, v);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          covered++;
        }
      }
      const total = ss * ss;
      const i = (y * size + x) * 4;
      if (!covered) continue;
      rgba[i] = Math.round(r / covered);
      rgba[i + 1] = Math.round(g / covered);
      rgba[i + 2] = Math.round(b / covered);
      rgba[i + 3] = Math.round((covered / total) * 255);
    }
  }
  return encodePng(size, size, rgba);
}

/** 缺什么补什么；返回图标绝对路径 */
function ensureIcons(assetsDir) {
  fs.mkdirSync(assetsDir, { recursive: true });
  const iconPath = path.join(assetsDir, 'icon.png');
  const trayPath = path.join(assetsDir, 'tray.png');
  const jobs = [
    [iconPath, 256],
    [trayPath, 32]
  ];
  for (const [file, size] of jobs) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 0) continue;
      fs.writeFileSync(file, render(size, sampleClipboard));
    } catch (err) {
      console.error('[icon] 生成失败', file, err.message);
    }
  }
  return { iconPath, trayPath };
}

module.exports = { ensureIcons, encodePng, render, sampleClipboard };
