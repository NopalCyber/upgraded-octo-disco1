'use strict';

const HEADER_SHADE = '#F4F4F5';
const text = (inner) => String(inner).replace(/<[^>]*>/g, '').trim();

function normalise(html) {
  if (!html) return html;
  return String(html)
    .replace(/<\/thead>\s*<tbody[^>]*>/gi, '')
    .replace(/<thead[^>]*>/gi, '<tbody>')
    .replace(/<\/thead>/gi, '</tbody>')
    .replace(/<th(\s[^>]*)?>([\s\S]*?)<\/th>/gi, (_, attrs = '', inner) => {
      const shaded = /\bstyle\s*=/i.test(attrs) ? attrs : `${attrs} style="background-color:${HEADER_SHADE};"`;
      return `<td${shaded}>${/</.test(inner) || !inner.trim() ? inner : `<strong>${inner}</strong>`}</td>`;
    })
    .replace(/<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1>/gi, (_, level, attrs, inner) => (text(inner) ? `<p><strong>${text(inner)}</strong></p>` : ''))
    .replace(/<em(\s[^>]*)?>([\s\S]*?)<\/em>/gi, (_, attrs, inner) => (/</.test(inner) ? inner : `<i>${inner}</i>`))
    .replace(/<b(\s[^>]*)?>([\s\S]*?)<\/b>/gi, (_, attrs, inner) => (/</.test(inner) ? inner : `<strong>${inner}</strong>`));
}

module.exports = { normalise };
