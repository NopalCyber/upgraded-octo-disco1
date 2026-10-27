'use strict';

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;

function compile(sql) {
  const text = String(sql);
  let out = '';
  let positional = 0;
  const names = [];
  const nameIndex = new Map();
  let nativeDollar = false;
  let i = 0;
  const n = text.length;

  const take = (end) => { out += text.slice(i, end); i = end; };

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "'" && text[j + 1] === "'") { j += 2; continue; }
        if (text[j] === "'") { j += 1; break; }
        j += 1;
      }
      take(j);
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '"' && text[j + 1] === '"') { j += 2; continue; }
        if (text[j] === '"') { j += 1; break; }
        j += 1;
      }
      take(j);
      continue;
    }
    if (ch === '-' && next === '-') {
      const j = text.indexOf('\n', i);
      take(j === -1 ? n : j);
      continue;
    }
    if (ch === '/' && next === '*') {
      const j = text.indexOf('*/', i + 2);
      take(j === -1 ? n : j + 2);
      continue;
    }
    if (ch === '$') {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const close = text.indexOf(tag, i + tag.length);
        take(close === -1 ? n : close + tag.length);
        continue;
      }
      if (/[0-9]/.test(next || '')) {
        nativeDollar = true;
        let j = i + 1;
        while (j < n && /[0-9]/.test(text[j])) j += 1;
        take(j);
        continue;
      }
    }
    if (ch === '?') {
      positional += 1;
      out += `$${positional}`;
      i += 1;
      continue;
    }
    const prev = i > 0 ? text[i - 1] : '';
    if ((ch === '@' || ch === ':' || ch === '$') && NAME_START.test(next || '') && !(ch === ':' && prev === ':') && !NAME_CHAR.test(prev)) {
      let j = i + 1;
      while (j < n && NAME_CHAR.test(text[j])) j += 1;
      const name = text.slice(i + 1, j);
      if (!nameIndex.has(name)) { names.push(name); nameIndex.set(name, names.length); }
      out += `$${nameIndex.get(name)}`;
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }

  if (positional && names.length) throw new Error('A statement cannot mix ? and named parameters');
  if (nativeDollar && (positional || names.length)) throw new Error('A statement cannot mix $n with ? or named parameters');
  return { text: out, positional, names };
}

function toValue(value) {
  if (value === undefined) return null;
  if (value === true) return 1;
  if (value === false) return 0;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) throw new TypeError('Bind dates as text in the stored format, not Date objects');
  return value;
}

function bind(compiled, args) {
  if (compiled.names.length) {
    const source = args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) && !Buffer.isBuffer(args[0])
      ? args[0] : null;
    if (!source) throw new TypeError('Named parameters need one object argument');
    return compiled.names.map((name) => {
      if (!(name in source)) throw new RangeError(`Missing named parameter "${name}"`);
      return toValue(source[name]);
    });
  }
  const flat = [];
  for (const arg of args) {
    if (Array.isArray(arg)) flat.push(...arg);
    else flat.push(arg);
  }
  if (flat.length !== compiled.positional) {
    throw new RangeError(`Expected ${compiled.positional} parameter(s), got ${flat.length}`);
  }
  return flat.map(toValue);
}

function insertTarget(text) {
  const m = /^\s*(?:WITH\b[\s\S]*?\)\s*)?INSERT\s+INTO\s+("?)([A-Za-z_][A-Za-z0-9_]*)\1/i.exec(text);
  if (!m) return null;
  const stripped = text.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  if (/\bRETURNING\b/i.test(stripped)) return null;
  return m[2].toLowerCase();
}

module.exports = { compile, bind, insertTarget, toValue };
