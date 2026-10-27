'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const rbac = require('../lib/rbac');

const partials = path.join(__dirname, '..', 'views', 'partials');

function render(role, { experienceEnabled = true, active = '', userRole } = {}) {
  return ejs.renderFile(path.join(partials, 'client_navigation.ejs'), {
    ws: {
      id: 9, frameworks: ['iso27001'], tprm_enabled: 1,
      engagement_outcome: 'certification_support', ...(userRole ? { _userRole: userRole } : {}),
    },
    user: { user_type: 'firm', firm_role: role },
    rbac, active, openReviewCount: 2, experienceEnabled,
  });
}

function renderShell(role, { experienceEnabled = true, active = 'work', view = 'queue' } = {}) {
  return ejs.renderFile(path.join(partials, 'header.ejs'), {
    user: { id: 1, user_type: 'firm', firm_role: role, name: 'Test', email: 'test@example.test' },
    rbac, experienceEnabled, active, view, csrfToken: 'token',
  }).then(html => html.split('<nav class="sidebar-nav"')[1].split('</nav>')[0]);
}

const hrefs = html => new Set([...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]));
const moreTools = html => {
  const start = html.indexOf('aria-label="More tools"');
  return start < 0 ? '' : html.slice(start);
};
const rail = html => {
  const start = html.indexOf('aria-label="More tools"');
  return start < 0 ? html : html.slice(0, start);
};

const LEFT_OUT = ['/data-quality', '/team', '/activity-log', '/intake', '/auditor-access'];

for (const experienceEnabled of [true, false]) {
  const mode = experienceEnabled ? 'new' : 'classic';

  test(`${mode} sidebar: consultants keep delivery tools in the rail and lead tools under More tools`, async () => {
    const html = await render('consultant', { experienceEnabled });
    for (const route of ['/tasks', '/gap-assessment', '/controls', '/soa',
      '/tprm/third-parties', '/risks', '/documents', '/evidence', '/audits', '/nonconformities']) {
      assert.match(rail(html), new RegExp(`href="/workspaces/9${route}"`), `${route} stays in the rail`);
    }
    for (const route of ['/engagement-plan', '/readiness', '/assurance',
      '/cert-cycle', '/setup']) {
      assert.doesNotMatch(rail(html), new RegExp(`href="/workspaces/9${route}"`), `${route} leaves the rail`);
      assert.match(moreTools(html), new RegExp(`href="/workspaces/9${route}"`), `${route} is under More tools`);
    }
    assert.match(moreTools(html), /ISO 27001 certification cycle/);
  });

  test(`${mode} sidebar: consultants lose exactly the oversight and admin pages`, async () => {
    const consultant = hrefs(await render('consultant', { experienceEnabled }));
    const senior = hrefs(await render('senior_consultant', { experienceEnabled }));
    const missing = [...senior].filter(href => !consultant.has(href)).sort();
    assert.deepEqual(missing, LEFT_OUT.map(route => `/workspaces/9${route}`).sort());
  });

  test(`${mode} sidebar: senior consultants and managers keep the full menu`, async () => {
    for (const role of ['senior_consultant', 'manager']) {
      const html = await render(role, { experienceEnabled });
      assert.equal(moreTools(html), '', `${role} has no More tools group`);
      for (const route of LEFT_OUT) assert.match(html, new RegExp(`href="/workspaces/9${route}"`), `${role} keeps ${route}`);
    }
  });

  test(`${mode} sidebar: the role held on this client decides, not the firm role`, async () => {
    const html = await render('consultant', { experienceEnabled, userRole: 'senior_consultant' });
    assert.equal(moreTools(html), '');
    assert.match(html, /href="\/workspaces\/9\/team"/);
  });

  test(`${mode} sidebar: opening a moved page expands More tools`, async () => {
    const html = await render('consultant', { experienceEnabled, active: 'setup' });
    assert.match(html, /<details class="nav-domain is-active" open>\s*<summary class="nav-domain-summary" aria-label="More tools">/);
    assert.match(moreTools(html), /class="nav-subitem active"[^>]*aria-current="page"/);
  });

  test(`${mode} firm menu: consultants get a short menu, seniors and managers keep theirs`, async () => {
    const consultant = await renderShell('consultant', { experienceEnabled });
    for (const route of ['/tprm', '/portfolio', '/calendar', '/admin/users']) {
      assert.doesNotMatch(consultant, new RegExp(`href="${route.replace(/[?]/g, '\\?')}"`), `consultant has no ${route}`);
    }
    for (const route of ['/playbooks', '/firm/library', '/glossary']) {
      assert.match(moreTools(consultant), new RegExp(`href="${route}"`), `${route} is under More tools`);
    }
    assert.match(rail(consultant), /href="\/dashboard"/);
    for (const role of ['senior_consultant', 'manager']) {
      const html = await renderShell(role, { experienceEnabled });
      assert.equal(moreTools(html), '', `${role} has no More tools group`);
      assert.match(html, /href="\/tprm"/);
      assert.match(html, /Reference/);
    }
  });
}

test('firm menu: More tools opens on the page the consultant is on', async () => {
  const html = await renderShell('consultant', { active: 'playbooks', view: '' });
  assert.match(html, /<details class="nav-domain is-active" open>\s*<summary class="nav-domain-summary" aria-label="More tools"/);
  assert.match(moreTools(html), /class="nav-subitem active" href="\/playbooks" aria-current="page"/);
});
