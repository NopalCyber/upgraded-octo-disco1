'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ctlReads = require('./control-reads');

let _serifDataUri = null;
function getSerifDataUri() {
  if (_serifDataUri !== null) return _serifDataUri;
  try {
    const fontPath = path.join(__dirname, '..', 'public', 'fonts', 'source-serif-4', 'SourceSerif4-VF.woff2');
    const buf = fs.readFileSync(fontPath);
    _serifDataUri = 'data:font/woff2;base64,' + buf.toString('base64');
  } catch (_) {
    _serifDataUri = '';
  }
  return _serifDataUri;
}

function fmtDate(d) {
  if (!d) return '';
  const s = String(d);
  return s.slice(0, 10);
}

function safe(v) { return v == null ? '' : String(v); }

function defaultOpts() {
  return {
    sections: {
      cover: true,
      summary: true,
      soa: true,
      risks: true,
      evidence: true,
      ncs: true,
      improvements: true,
      audits: true,
      mrms: true,
      audit_trail: true
    },
    snapshotId: null,
    brand: {},
    preparedBy: null,
    preparedFor: null
  };
}

async function gatherAuditPackData(deps, wsId, opts) {
  const { db, enc, methodologyBand, getActiveMethodology } = deps;
  opts = Object.assign(defaultOpts(), opts || {});
  opts.sections = Object.assign(defaultOpts().sections, opts.sections || {});

  const workspace = await db.prepare(`SELECT * FROM workspaces WHERE id = ?`).get(wsId);
  if (!workspace) throw new Error('workspace_not_found');
  const firm = (await db.prepare(`SELECT * FROM firms WHERE id = ?`).get(workspace.firm_id)) || { name: '' };

  const brand = {
    displayName: opts.brand.displayName || workspace.brand_display_name || firm.name || 'ISMS Consultancy',
    primaryColor: opts.brand.primaryColor || workspace.brand_primary_color || '#5C0A0A',
    logoPath: opts.brand.logoPath || workspace.brand_logo_path || null,
    confidentialityLabel: opts.brand.confidentialityLabel || 'CONFIDENTIAL · For audit and management review purposes only'
  };

  const data = {
    workspace,
    firm,
    brand,
    generatedAt: new Date(),
    preparedFor: opts.preparedFor || workspace.client_name,
    preparedBy: opts.preparedBy || firm.name || brand.displayName,
    sections: opts.sections,
    serifDataUri: getSerifDataUri()
  };

  if (opts.sections.soa) {
    let snapshot = opts.snapshotId
      ? await db.prepare(`SELECT * FROM soa_snapshots WHERE id=? AND workspace_id=?`).get(opts.snapshotId, wsId)
      : await db.prepare(`SELECT * FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1`).get(wsId);
    let soaRows = [];
    if (snapshot) {
      try { soaRows = JSON.parse(enc.decryptIfNeeded(snapshot.payload, wsId)); }
      catch (e) { snapshot = null; }
    }
    if (!snapshot) {
      soaRows = await db.prepare(`SELECT i.id, i.title, i.category,
            COALESCE(cs.applicability,'undecided') AS applicability,
            COALESCE(cs.status,'Not Assessed') AS status,
            cs.inclusion_justification, cs.exclusion_justification
          FROM iso_items i
          LEFT JOIN ${ctlReads.tables(db, wsId).cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
          WHERE i.type='control'
          ORDER BY i.sort_order`).all(wsId);
    }
    data.soa = {
      snapshot,
      rows: soaRows,
      counts: {
        total: soaRows.length,
        included: soaRows.filter(r => r.applicability === 'included').length,
        excluded: soaRows.filter(r => r.applicability === 'excluded').length,
        undecided: soaRows.filter(r => !['included','excluded'].includes(r.applicability)).length
      }
    };
  }

  if (opts.sections.risks) {
    const m = getActiveMethodology ? await getActiveMethodology(wsId, 'iso27001') : null;
    const risks = await db.prepare(`SELECT r.*, a.name AS asset_name
      FROM risks r LEFT JOIN assets a ON a.id = r.asset_id
      WHERE r.workspace_id = ? AND r.management_system = 'iso27001'
      ORDER BY (COALESCE(r.likelihood,0) * COALESCE(r.impact,0)) DESC, r.id`).all(wsId);
    const enriched = risks.map(r => ({
      ...r,
      band: (m && methodologyBand) ? methodologyBand(m, r.likelihood, r.impact) : '',
      residual_band: (m && methodologyBand && r.residual_likelihood && r.residual_impact)
        ? methodologyBand(m, r.residual_likelihood, r.residual_impact) : ''
    }));
    const bandCounts = {};
    enriched.forEach(r => { if (r.band) bandCounts[r.band] = (bandCounts[r.band] || 0) + 1; });
    data.risks = {
      methodology: m,
      rows: enriched,
      bandCounts,
      open: enriched.filter(r => r.status === 'open').length,
      treated: enriched.filter(r => r.status === 'treated' || r.status === 'closed').length
    };
  }

  if (opts.sections.evidence) {
    const rows = await db.prepare(`SELECT e.id, e.filename, e.sha256, e.size_bytes, e.iso_item_id,
        e.uploaded_at, e.description, u.name AS uploader
      FROM evidence e
      LEFT JOIN users u ON u.id = e.uploaded_by
      WHERE e.workspace_id = ?
      ORDER BY e.uploaded_at DESC`).all(wsId);
    data.evidence = {
      rows,
      count: rows.length,
      totalBytes: rows.reduce((a, r) => a + (r.size_bytes || 0), 0)
    };
  }

  if (opts.sections.ncs) {
    const rows = await db.prepare(`SELECT * FROM nonconformities WHERE workspace_id = ?
      ORDER BY (status='open') DESC NULLS LAST, created_at DESC`).all(wsId);
    data.ncs = {
      rows,
      open: rows.filter(r => r.status === 'open').length,
      closed: rows.filter(r => r.status === 'closed').length,
      majorOpen: rows.filter(r => r.status === 'open' && r.severity === 'major').length
    };
  }

  if (opts.sections.improvements) {
    const rows = await db.prepare(`SELECT * FROM improvements WHERE workspace_id = ?
      ORDER BY (status='open' OR status='in_progress') DESC NULLS LAST, due_date ASC NULLS FIRST`).all(wsId);
    data.improvements = {
      rows,
      open: rows.filter(r => r.status === 'open' || r.status === 'in_progress').length,
      done: rows.filter(r => r.status === 'done').length
    };
  }

  if (opts.sections.audits) {
    const audits = await db.prepare(`SELECT * FROM audits WHERE workspace_id = ?
      ORDER BY audit_date DESC NULLS LAST, id DESC`).all(wsId);
    const findingsByAudit = {};
    if (audits.length) {
      const findings = await db.prepare(`SELECT f.*, a.workspace_id FROM audit_findings f
        INNER JOIN audits a ON a.id = f.audit_id
        WHERE a.workspace_id = ?
        ORDER BY f.created_at`).all(wsId);
      findings.forEach(f => { (findingsByAudit[f.audit_id] = findingsByAudit[f.audit_id] || []).push(f); });
    }
    data.audits = {
      rows: audits.map(a => ({ ...a, findings: findingsByAudit[a.id] || [] })),
      count: audits.length
    };
  }

  if (opts.sections.mrms) {
    const rows = await db.prepare(`SELECT * FROM mrms WHERE workspace_id = ?
      ORDER BY meeting_date DESC NULLS LAST, id DESC`).all(wsId);
    data.mrms = {
      rows,
      held: rows.filter(r => r.status === 'held' || r.status === 'completed' || r.status === 'closed').length,
      lastMeetingDate: rows.find(r => r.meeting_date) ? rows.find(r => r.meeting_date).meeting_date : null
    };
  }

  if (opts.sections.audit_trail) {
    const trail = await db.prepare(`SELECT al.created_at, al.action, al.entity_type, al.entity_id, u.name AS actor
      FROM audit_log al
      LEFT JOIN users u ON u.id = al.user_id
      WHERE al.workspace_id = ?
      ORDER BY al.created_at DESC LIMIT 50`).all(wsId);
    const totalCount = (await db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE workspace_id = ?`).get(wsId)).c;
    data.audit_trail = { recent: trail, total: totalCount };
  }

  return data;
}

let _puppeteer = null;
function getPuppeteer() {
  if (!_puppeteer) _puppeteer = require('puppeteer');
  return _puppeteer;
}

const BROWSER_BINARIES = new Set(['chrome-headless-shell', 'chrome', 'chromium', 'Google Chrome for Testing']);
const SYSTEM_BROWSERS = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  ],
};

function accountHomeDir() {
  try { return os.userInfo().homedir || null; } catch (_) { return null; }
}

function browserCacheRoots() {
  const roots = [process.env.PUPPETEER_CACHE_DIR, path.join(__dirname, '..', 'node_modules', '.cache', 'puppeteer')];
  for (const home of [os.homedir(), accountHomeDir()]) if (home) roots.push(path.join(home, '.cache', 'puppeteer'));
  return [...new Set(roots.filter(Boolean))];
}

function findBrowserUnder(dir, depth = 4) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  const dirs = [];
  for (const entry of entries) {
    if (entry.isDirectory()) { dirs.push(path.join(dir, entry.name)); continue; }
    if (!entry.isFile() || !BROWSER_BINARIES.has(entry.name)) continue;
    const candidate = path.join(dir, entry.name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch (_) { }
  }
  if (depth <= 0) return null;
  for (const child of dirs.sort().reverse()) {
    const found = findBrowserUnder(child, depth - 1);
    if (found) return found;
  }
  return null;
}

let _fallbackExecutable;
function fallbackExecutablePath() {
  if (_fallbackExecutable !== undefined) return _fallbackExecutable;
  const explicit = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (explicit && fs.existsSync(explicit)) return (_fallbackExecutable = explicit);
  for (const root of browserCacheRoots()) {
    const found = findBrowserUnder(root);
    if (found) return (_fallbackExecutable = found);
  }
  for (const candidate of SYSTEM_BROWSERS[process.platform] || []) {
    if (fs.existsSync(candidate)) return (_fallbackExecutable = candidate);
  }
  return (_fallbackExecutable = null);
}

function isBrowserMissing(err) {
  return /Could not find Chrome|Could not find Chromium|Could not find browser|browsers install|ENOENT/i.test(String(err && err.message));
}

async function launchBrowser(puppeteer) {
  const args = ['--no-sandbox', '--disable-setuid-sandbox'];
  try {
    return await puppeteer.launch({ headless: 'shell', args });
  } catch (err) {
    const executablePath = isBrowserMissing(err) ? fallbackExecutablePath() : null;
    if (!executablePath) throw err;
    const headless = path.basename(executablePath) === 'chrome-headless-shell' ? 'shell' : true;
    console.warn(`[audit-pack] puppeteer could not find its own browser; using ${executablePath}`);
    return puppeteer.launch({ headless, executablePath, args });
  }
}

let pdfChain = Promise.resolve();
function renderPDF(html, opts) {
  const next = pdfChain.then(async () => await renderPDFNow(html, opts));
  pdfChain = next.catch(() => {});
  return next;
}

async function renderPDFNow(html, opts) {
  opts = opts || {};
  const browser = await launchBrowser(getPuppeteer());
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.emulateMediaType('print');

    const headerTemplate = `
      <div style="font-size:8px;color:#999;width:100%;padding:0 16mm;">
        <span style="float:left">${escapeForHeader(opts.headerLeft || '')}</span>
        <span style="float:right">${escapeForHeader(opts.headerRight || '')}</span>
      </div>`;
    const footerTemplate = `
      <div style="font-size:8px;color:#999;width:100%;padding:0 16mm;">
        <span style="float:left">${escapeForHeader(opts.footerLeft || '')}</span>
        <span style="float:right">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>`;

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '22mm', bottom: '20mm', left: '14mm', right: '14mm' },
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate,
      preferCSSPageSize: false
    });
    return pdf;
  } finally {
    await browser.close();
  }
}

function escapeForHeader(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

module.exports = {
  gatherAuditPackData,
  renderPDF,
  defaultOpts,
  fmtDate,
  safe,
  browserCacheRoots,
  fallbackExecutablePath,
  findBrowserUnder
};
