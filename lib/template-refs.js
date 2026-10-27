'use strict';

function extractAnnexRefs(text) {
  if (!text) return [];
  const refs = new Set();

  const parenRe = /\(([^)]+)\)/g;
  let p;
  while ((p = parenRe.exec(text)) !== null) {
    let currentMajor = null;
    p[1].split(/[,/]/).forEach(tok => {
      tok = tok.trim();
      let m = tok.match(/^A\.(\d+)\.(\d+)(?:\s*[-–-]\s*(?:A\.)?(?:(\d+)\.)?(\d+))?$/);
      if (m) {
        currentMajor = parseInt(m[1], 10);
        addRange(refs, currentMajor, parseInt(m[2], 10),
          m[3] !== undefined ? parseInt(m[3], 10) : currentMajor,
          m[4] !== undefined ? parseInt(m[4], 10) : parseInt(m[2], 10));
        return;
      }
      m = tok.match(/^(\d+)\.(\d+)(?:\s*[-–-]\s*(?:\d+\.)?(\d+))?$/);
      if (m && currentMajor !== null) {
        const major = parseInt(m[1], 10);
        if (major !== currentMajor) {
          currentMajor = major;
        }
        const start = parseInt(m[2], 10);
        const end = m[3] !== undefined ? parseInt(m[3], 10) : start;
        addRange(refs, currentMajor, start, currentMajor, end);
      }
    });
  }

  const stripParens = text.replace(/\([^)]*\)/g, '');
  const absRe = /A\.(\d+)\.(\d+)(?:\s*[-–-]\s*(?:A\.)?(?:(\d+)\.)?(\d+))?/g;
  let m;
  while ((m = absRe.exec(stripParens)) !== null) {
    const major = parseInt(m[1], 10);
    const startMinor = parseInt(m[2], 10);
    const endMajor = m[3] !== undefined ? parseInt(m[3], 10) : major;
    const endMinor = m[4] !== undefined ? parseInt(m[4], 10) : startMinor;
    addRange(refs, major, startMinor, endMajor, endMinor);
  }

  return [...refs].sort(compareAnnexRefs);
}

function addRange(refs, startMajor, startMinor, endMajor, endMinor) {
  if (endMajor !== startMajor) {
    refs.add(`annex-a.${startMajor}.${startMinor}`);
    refs.add(`annex-a.${endMajor}.${endMinor}`);
    return;
  }
  for (let n = startMinor; n <= endMinor; n++) refs.add(`annex-a.${startMajor}.${n}`);
}

function compareAnnexRefs(a, b) {
  const pa = a.replace('annex-a.', '').split('.').map(Number);
  const pb = b.replace('annex-a.', '').split('.').map(Number);
  return pa[0] - pb[0] || pa[1] - pb[1];
}

function extractClauseRefs(text) {
  if (!text) return [];
  const refs = new Set();
  const blockRe = /Clauses?\s+([0-9.\s,/&]+(?:and\s+[0-9.]+)?)/gi;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const list = m[1];
    list.split(/[\s,/&]+|and/i).forEach(tok => {
      const t = tok.trim().replace(/[.,]$/, '');
      if (/^\d+(\.\d+){1,2}$/.test(t)) refs.add(`clause-${t}`);
    });
  }
  return [...refs].sort(compareClauseRefs);
}

function compareClauseRefs(a, b) {
  const pa = a.replace('clause-', '').split('.').map(Number);
  const pb = b.replace('clause-', '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const av = pa[i] || 0, bv = pb[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function extractRefs(description) {
  return {
    controls: extractAnnexRefs(description),
    clauses: extractClauseRefs(description)
  };
}

module.exports = { extractRefs, extractAnnexRefs, extractClauseRefs };
