function register(app, deps) {
  const { db, requireAuth, isFirmUser, listWorkspaces, onReady } = deps;

  const GLOSSARY = require('../data/glossary');

  let ISO_ITEM_IDS = new Set();
  onReady(async () => {
    ISO_ITEM_IDS = new Set((await db.prepare('SELECT id FROM iso_items').all()).map(r => r.id));
  });

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderClauseRefHtml(text, wsId) {
    const escaped = escapeHtml(text);
    if (!text || !wsId) return escaped;
    let html = escaped;
    html = html.replace(/A\.\d+(?:\.\d+)?/g, (m) => {
      const slug = 'annex-' + m.toLowerCase();
      if (ISO_ITEM_IDS.has(slug)) {
        return `<a href="/workspaces/${wsId}/controls/${slug}" style="color:var(--accent);text-decoration:none;border-bottom:1px dotted var(--accent);">${m}</a>`;
      }
      return m;
    });
    function linkClauseToken(token) {
      const digitMatch = token.match(/^\d+(?:\.\d+){0,2}/);
      if (!digitMatch) return token;
      const parts = digitMatch[0].split('.');
      while (parts.length > 0) {
        const candidate = 'clause-' + parts.join('.');
        if (ISO_ITEM_IDS.has(candidate)) {
          return `<a href="/workspaces/${wsId}/controls/${candidate}" style="color:var(--accent);text-decoration:none;border-bottom:1px dotted var(--accent);">${token}</a>`;
        }
        parts.pop();
      }
      return token;
    }
    html = html.replace(/(Clauses?\s+)(\d+(?:\.\d+){0,2}(?:\.[a-z](?:\.\d+)?)?(?:\s*,\s*\d+(?:\.\d+){0,2}(?:\.[a-z](?:\.\d+)?)?)*)/g,
      (whole, prefix, list) => prefix + list.replace(/\d+(?:\.\d+){0,2}(?:\.[a-z](?:\.\d+)?)?/g, linkClauseToken)
    );
    return html;
  }

  async function firstWorkspaceIdFor(user) {
    const ws = (await listWorkspaces(user))[0];
    return ws ? ws.id : null;
  }

  app.get('/glossary', requireAuth, async (req, res) => {
    if (!isFirmUser(req.user)) {
      return res.status(403).render('error', { user: req.user, message: 'This area is for firm staff only.' });
    }
    const q = (req.query.q || '').toString();
    const category = (req.query.category || 'all').toString();
    const letter = (req.query.letter || 'all').toString();
    const results = GLOSSARY.searchEntries(q, category, letter)
      .slice()
      .sort((a, b) => a.term.localeCompare(b.term));
    const letterCounts = {};
    for (const e of GLOSSARY.ENTRIES) {
      const first = /[A-Z]/.test(e.term[0]) ? e.term[0].toUpperCase() : '#';
      letterCounts[first] = (letterCounts[first] || 0) + 1;
    }
    const categoryCounts = {};
    for (const e of GLOSSARY.ENTRIES) categoryCounts[e.category] = (categoryCounts[e.category] || 0) + 1;
    const starter = GLOSSARY.STARTER_TERMS
      .map(slug => GLOSSARY.ENTRIES.find(e => e.slug === slug))
      .filter(Boolean);
    const linkWsId = await firstWorkspaceIdFor(req.user);
    res.render('glossary', {
      user: req.user,
      ws: null,
      title: 'Glossary',
      active: 'glossary',
      q, category, letter,
      results,
      total: GLOSSARY.ENTRIES.length,
      letterCounts,
      categoryCounts,
      categories: GLOSSARY.CATEGORIES,
      starter,
      renderClauseRef: (t) => renderClauseRefHtml(t, linkWsId)
    });
  });

  app.get('/glossary/:slug', requireAuth, async (req, res) => {
    const idx = GLOSSARY.indexBySlug();
    const entry = idx[req.params.slug];
    if (!entry) return res.status(404).render('error', { user: req.user, message: 'No glossary entry with that slug. The 168 terms shipped with the tool are listed at /glossary - try searching there.' });
    const related = (entry.related || []).map(s => idx[s]).filter(Boolean);
    const categoryLabel = (GLOSSARY.CATEGORIES.find(c => c.key === entry.category) || {}).label || entry.category;
    const linkWsId = await firstWorkspaceIdFor(req.user);
    res.render('glossary_detail', {
      user: req.user,
      ws: null,
      title: entry.term,
      active: 'glossary',
      entry,
      related,
      categoryLabel,
      categories: GLOSSARY.CATEGORIES,
      renderClauseRef: (t) => renderClauseRefHtml(t, linkWsId)
    });
  });
}

module.exports = { register };
