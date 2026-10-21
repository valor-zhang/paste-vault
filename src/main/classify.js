'use strict';

/**
 * 类型识别：只负责"这是什么类型"，用于出图标和一键筛选。
 * 标签由用户手动打，这里不生成标签。
 */

const URL_RE = /^(?:https?:\/\/|ftp:\/\/|www\.)\S+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const COLOR_RE = /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i;
const WIN_PATH_RE = /^(?:[a-zA-Z]:\\|\\\\[^\\]|\/\/)[^\r\n]*$/;
const UNIX_PATH_RE = /^(?:~\/|\/)[^\s\r\n]+$/;
const NUMBER_RE = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
const CODE_HINT_RE =
  /(?:^|\n)\s*(?:function\s|const\s|let\s|var\s|class\s|def\s|import\s|from\s|export\s|package\s|public\s|private\s|#include\s|SELECT\s|INSERT\s|UPDATE\s|CREATE\s)|=>|\{\s*\n|<\/?[a-z][\w-]*>|;\s*\n/;

/**
 * @param {string} text
 * @returns {'url'|'color'|'email'|'path'|'json'|'code'|'number'|'text'}
 */
function classify(text) {
  const raw = typeof text === 'string' ? text : '';
  const s = raw.trim();
  if (!s) return 'text';

  const singleLine = !/[\r\n]/.test(s);
  if (singleLine && s.length <= 2048) {
    if (URL_RE.test(s)) return 'url';
    if (EMAIL_RE.test(s)) return 'email';
    if (COLOR_RE.test(s)) return 'color';
    if (WIN_PATH_RE.test(s) || UNIX_PATH_RE.test(s)) return 'path';
    if (NUMBER_RE.test(s)) return 'number';
  }

  if (s.length < 100000 && /^[[{]/.test(s)) {
    try {
      JSON.parse(s);
      return 'json';
    } catch {
      /* 不是合法 JSON，继续往下判断 */
    }
  }

  if (!singleLine && CODE_HINT_RE.test(s)) return 'code';
  if (singleLine && /^(?:\w+\s*=>|\s*(?:function|def|class|const|let|var)\s)/.test(s)) return 'code';

  return 'text';
}

const SUBTYPE_LABEL = {
  text: '文本',
  url: '链接',
  color: '颜色',
  email: '邮箱',
  path: '路径',
  json: 'JSON',
  code: '代码',
  number: '数字',
  other: '其它'
};

const KIND_LABEL = { text: '文本', image: '图片', files: '文件' };

module.exports = { classify, SUBTYPE_LABEL, KIND_LABEL };
