const fs = require('fs');
const path = require('path');

const COMPOSITE_TO_CLASS = {
  'display:flex;gap:6px':                                       'row',
  'align-items:center;display:flex;gap:6px':                    'row-center',
  'display:flex;flex-direction:column;gap:6px':                 'stack',
  'display:grid;gap:12px;grid-template-columns:1fr 1fr':        'grid-2',
  'display:grid;gap:12px;grid-template-columns:repeat(2,1fr)':  'grid-2'
};

const STYLE_TO_CLASS = {
  'color:#b91c1c':               'text-danger',
  'color:#a16207':               'text-warn',
  'color:#15803d':               'text-success',
  'color:#16a34a':               'text-success',
  'color:var(--text-secondary)': 'text-secondary',
  'color:var(--text-tertiary)':  'text-tertiary',
  'color:var(--ink)':            'text-ink',
  'color:var(--text)':           null,
  'grid-column:1/-1':            'col-full',
  'grid-column:1 / -1':          'col-full',
  'font-size:10px':              'text-xxs',
  'font-size:10.5px':            'text-eyebrow',
  'font-size:11px':              'text-xs',
  'font-size:11.5px':            'text-sm',
  'font-size:12px':              'text-base',
  'font-size:12.5px':            'text-md',
  'font-size:13px':              'text-lg',
  'font-size:14px':              'text-xl'
};

const TAG_OPEN = /<([a-zA-Z][a-zA-Z0-9-]*)\b/g;

function normalizeDecl(decl) {
  const colon = decl.indexOf(':');
  if (colon < 0) return decl.trim();
  const key = decl.slice(0, colon).trim();
  const value = decl.slice(colon + 1).trim();
  return `${key}:${value}`;
}

function splitDecls(styleValue) {
  return styleValue.split(';').map(s => s.trim()).filter(Boolean);
}

function rewriteTag(src, tagStart) {
  let i = tagStart;
  let inAttr = false;
  let attrQuote = null;
  while (i < src.length) {
    const c = src[i];
    if (inAttr) {
      if (c === attrQuote) { inAttr = false; attrQuote = null; }
    } else {
      if (c === '"' || c === "'") { inAttr = true; attrQuote = c; }
      else if (c === '>') break;
    }
    i++;
  }
  if (i >= src.length) return null;
  const tagEnd = i;
  const original = src.slice(tagStart, tagEnd + 1);

  const styleRe = /\sstyle="([^"]*)"/;
  const m = styleRe.exec(original);
  if (!m) return null;
  const rawValue = m[1];

  if (rawValue.includes('<%')) return null;

  const decls = splitDecls(rawValue);

  const normalizedAll = decls.map(normalizeDecl).slice().sort().join(';');
  if (Object.prototype.hasOwnProperty.call(COMPOSITE_TO_CLASS, normalizedAll)) {
    const compositeClass = COMPOSITE_TO_CLASS[normalizedAll];
    let rewritten = original.replace(styleRe, '');
    const classRe = /(\sclass=")([^"]*)(")/;
    const cm = classRe.exec(rewritten);
    if (cm) {
      const existing = cm[2].trim();
      const merged = existing ? `${existing} ${compositeClass}` : compositeClass;
      rewritten = rewritten.replace(classRe, `$1${merged}$3`);
    } else {
      const tagNameMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(rewritten);
      const insertAt = tagNameMatch[0].length;
      rewritten = rewritten.slice(0, insertAt) + ` class="${compositeClass}"` + rewritten.slice(insertAt);
    }
    rewritten = rewritten.replace(/\s{2,}/g, ' ').replace(/\s+>/, '>');
    return { original, rewritten, tagEnd };
  }

  const remaining = [];
  const newClasses = [];
  let matched = 0;
  for (const decl of decls) {
    const normalized = normalizeDecl(decl);
    if (Object.prototype.hasOwnProperty.call(STYLE_TO_CLASS, normalized)) {
      const cls = STYLE_TO_CLASS[normalized];
      if (cls) newClasses.push(cls);
      matched++;
    } else {
      remaining.push(decl);
    }
  }
  if (matched === 0) return null;

  let rewritten;
  if (remaining.length === 0) {
    rewritten = original.replace(styleRe, '');
  } else {
    const trailing = /;\s*$/.test(rawValue) ? ';' : '';
    rewritten = original.replace(styleRe, ` style="${remaining.join(';')}${trailing}"`);
  }

  if (newClasses.length) {
    const classRe = /(\sclass=")([^"]*)(")/;
    const cm = classRe.exec(rewritten);
    if (cm) {
      const existing = cm[2].trim();
      const merged = existing ? `${existing} ${newClasses.join(' ')}` : newClasses.join(' ');
      rewritten = rewritten.replace(classRe, `$1${merged}$3`);
    } else {
      const tagNameMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(rewritten);
      const insertAt = tagNameMatch[0].length;
      rewritten = rewritten.slice(0, insertAt) + ` class="${newClasses.join(' ')}"` + rewritten.slice(insertAt);
    }
  }

  rewritten = rewritten.replace(/\s{2,}/g, ' ').replace(/\s+>/, '>');

  return { original, rewritten, tagEnd };
}

function transform(src) {
  let out = '';
  let cursor = 0;
  let count = 0;
  let m;
  TAG_OPEN.lastIndex = 0;
  while ((m = TAG_OPEN.exec(src)) !== null) {
    const result = rewriteTag(src, m.index);
    if (result) {
      out += src.slice(cursor, m.index);
      out += result.rewritten;
      cursor = result.tagEnd + 1;
      TAG_OPEN.lastIndex = cursor;
      count++;
    }
  }
  out += src.slice(cursor);
  return { out, count };
}

function walk(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, files);
    else if (entry.isFile() && p.endsWith('.ejs')) files.push(p);
  }
}

function main() {
  const viewsDir = path.resolve(__dirname, '..', 'views');
  const files = [];
  walk(viewsDir, files);

  let totalSwaps = 0;
  let touched = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const { out, count } = transform(src);
    if (count > 0) {
      fs.writeFileSync(f, out);
      touched++;
      totalSwaps += count;
      console.log(`  ${path.relative(path.resolve(__dirname, '..'), f)}: ${count}`);
    }
  }
  console.log(`\n${totalSwaps} swap${totalSwaps === 1 ? '' : 's'} across ${touched} file${touched === 1 ? '' : 's'}`);
}

main();
