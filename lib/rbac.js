const PERMISSIONS = {
  'firm.manage':              'Edit firm settings (billing, branding, email config)',
  'firm.users.manage':        'Invite, create, deactivate firm-side users',
  'firm.cross_view':          'See the cross-engagement dashboard across all clients',
  'firm.library.manage':      'Create, edit, delete and reseed the firm risk library',
  'auditor_share.view':       'See auditor share links for a workspace',
  'auditor_share.manage':     'Mint and revoke external auditor share links',

  'workspace.create':         'Create a new client workspace',
  'workspace.update':         'Edit workspace settings',
  'workspace.delete':         'Delete workspace',
  'workspace.export':         'Export audit pack / CSVs',
  'workspace.users.manage':   'Invite, add, remove client-side workspace members',

  'members.view':             'View members and roles',
  'members.add':              'Add members',
  'members.remove':           'Remove members',
  'members.assign_role':      'Assign / change roles',
  'members.override_perms':   'Grant or revoke individual permissions per user',

  'entity.view':              'View entities',
  'entity.create':            'Create new entity',
  'entity.update':            'Update entity',
  'entity.delete':            'Delete entity',

  'control.view':             'View controls',
  'control.update':           'Update control state, applicability, evidence',
  'control.bulk_update':      'Bulk-update controls',

  'risk.view':                'View risks',
  'risk.create':              'Create risks',
  'risk.update':              'Edit risks',
  'risk.delete':              'Delete risks',
  'risk.methodology':         'Edit risk methodology',

  'asset.view':               'View asset inventory',
  'asset.create':             'Create assets',
  'asset.update':             'Edit assets',
  'asset.delete':             'Delete assets',

  'document.view':            'View documents',
  'document.create':          'Create documents',
  'document.edit':            'Edit document content',
  'document.submit_review':   'Submit document for review',
  'document.review':          'Review document (reviewer slot in approval chain)',
  'document.approve':         'Approve / reject document version (approver slot)',
  'document.publish':         'Publish approved documents',
  'document.retire':          'Retire published documents',
  'document.sign':            'Apply electronic signature',
  'document.delete':          'Delete documents',

  'audit.manage':             'Manage internal audits',
  'mrm.manage':               'Manage management reviews',
  'nc.manage':                'Manage nonconformities',
  'incident.manage':          'Manage incidents',

  'tprm.portfolio.view':       'View the third-party risk portfolio',
  'tprm.third_party.view':     'View third-party records and service relationships',
  'tprm.third_party.manage':   'Create and maintain third-party and service records',
  'tprm.intake.manage':        'Triage intake and complete inherent-risk tiering',
  'tprm.assessment.manage':    'Issue and administer third-party assessments',
  'tprm.assessment.review':    'Review questionnaire responses and supporting evidence',
  'tprm.finding.manage':       'Raise and maintain third-party findings',
  'tprm.recommendation.draft': 'Draft the consultancy recommendation',
  'tprm.recommendation.issue': 'Quality-review and issue the consultancy recommendation',
  'tprm.conditions.manage':    'Maintain recommendation and onboarding conditions',
  'tprm.monitoring.manage':    'Manage monitoring, reassessment, renewal and offboarding work',
  'tprm.methodology.manage':   'Draft and publish third-party risk methodologies',
  'tprm.assurance.view':       'View client-safe TPRM assurance records and decision history',
  'tprm.assurance.export':     'Export third-party assurance and audit packs',
  'tprm.client_portal.view':   'View the client-safe third-party risk portal',
  'tprm.client_comment':       'Comment on client-visible third-party assurance records',
  'tprm.client_decide':        'Record the client final onboarding decision',
  'tprm.client_risk_accept':   'Accept residual third-party risk for the client',

  'supplier.manage':          'Legacy alias for third-party record and assessment management',
  'supplier.approve':         'Legacy alias for issuing a consultancy recommendation',
  'supplier.risk_accept':     'Legacy firm-only supplier risk override',
  'supplier.export':          'Legacy alias for third-party assurance export',

  'report.view':              'View assurance report history and frozen previews',
  'report.generate':          'Generate immutable assurance report snapshots',
  'report.review':            'Review assurance reports and request changes',
  'report.approve':           'Approve assurance reports (maker-checker)',
  'report.publish':           'Publish approved assurance reports',
  'report.export':            'Download frozen assurance report artifacts',

  'task.manage':              'Manage tasks',
  'evidence.view':            'View the internal evidence library and metadata',
  'evidence.download':        'Download or preview internal evidence files',
  'evidence.export':          'Export bulk evidence packs',
  'evidence.upload':          'Upload evidence',
  'evidence.delete':          'Delete evidence',
  'comment.create':           'Add comments',
  'comment.delete':           'Delete comments',
  'audit_log.view':           'View activity / audit log',
  'audit_log.export':         'Export activity log',
  'ai.external_process':      'Send explicitly approved non-confidential trial data to an external AI provider',

  'client_portal.view':       'View the client collaboration portal',
  'client_request.manage':    'Legacy client request management bundle (consultancy)',
  'client_request.create':    'Create and release client requests (consultancy)',
  'client_request.cancel':    'Cancel or reopen client requests (consultancy)',
  'client_request.coordinate': 'Delegate released client work and respond on behalf of the client team',
  'client_request.review':     'Review and accept client evidence (consultancy)',
  'client_request.respond':   'Respond to assigned client requests and attach evidence',

  'assessment.start_pass':    'Start a new gap-assessment pass',
  'assessment.signoff':       'Finalise / sign off a gap-assessment pass',
};

const ROLE_PERMS = {
  manager: '*',
  senior_consultant: [
    'firm.cross_view','firm.library.manage','auditor_share.view',
    'workspace.create','workspace.update','workspace.export','workspace.users.manage',
    'members.view','members.add','members.remove','members.assign_role','members.override_perms',
    'entity.view','entity.create','entity.update','entity.delete',
    'control.view','control.update','control.bulk_update',
    'risk.view','risk.create','risk.update','risk.delete','risk.methodology',
    'asset.view','asset.create','asset.update','asset.delete',
    'document.view','document.create','document.edit','document.submit_review',
    'document.review','document.publish','document.retire','document.sign','document.delete',
    'audit.manage','mrm.manage','nc.manage','incident.manage',
    'tprm.portfolio.view','tprm.third_party.view','tprm.third_party.manage',
    'tprm.intake.manage','tprm.assessment.manage','tprm.assessment.review','tprm.finding.manage',
    'tprm.recommendation.draft','tprm.recommendation.issue','tprm.conditions.manage',
    'tprm.monitoring.manage','tprm.assurance.view','tprm.assurance.export',
    'tprm.client_portal.view','tprm.client_comment',
    'supplier.manage','supplier.approve','supplier.export',
    'report.view','report.generate','report.review','report.publish','report.export',
    'task.manage','evidence.view','evidence.download','evidence.export','evidence.upload','evidence.delete',
    'comment.create','comment.delete',
    'audit_log.view','audit_log.export',
    'client_portal.view','client_request.manage','client_request.create','client_request.cancel','client_request.coordinate','client_request.review','client_request.respond',
    'assessment.start_pass','assessment.signoff'
  ],
  consultant: [
    'workspace.update','workspace.export','auditor_share.view',
    'members.view',
    'entity.view','entity.create','entity.update','entity.delete',
    'control.view','control.update','control.bulk_update',
    'risk.view','risk.create','risk.update','risk.delete','risk.methodology',
    'asset.view','asset.create','asset.update','asset.delete',
    'document.view','document.create','document.edit','document.submit_review',
    'audit.manage','mrm.manage','nc.manage','incident.manage',
    'tprm.portfolio.view','tprm.third_party.view','tprm.third_party.manage',
    'tprm.intake.manage','tprm.assessment.manage','tprm.assessment.review','tprm.finding.manage',
    'tprm.recommendation.draft','tprm.conditions.manage','tprm.monitoring.manage',
    'tprm.assurance.view','tprm.assurance.export','tprm.client_portal.view','tprm.client_comment',
    'supplier.manage','supplier.export',
    'report.view','report.generate','report.export',
    'task.manage','evidence.view','evidence.download','evidence.export','evidence.upload','evidence.delete',
    'comment.create',
    'audit_log.view',
    'client_portal.view','client_request.manage','client_request.create','client_request.cancel','client_request.coordinate','client_request.review','client_request.respond',
    'assessment.start_pass'
  ],

  client_owner: [
    'client_portal.view','client_request.coordinate','client_request.respond',
    'document.review','document.approve','document.sign',
    'evidence.upload','comment.create',
    'tprm.client_portal.view','tprm.assurance.view','tprm.client_comment',
    'tprm.client_decide','tprm.client_risk_accept'
  ],
  isms_manager: [
    'client_portal.view','client_request.coordinate','client_request.respond',
    'document.review','document.approve','document.sign',
    'evidence.upload','comment.create',
    'tprm.client_portal.view','tprm.assurance.view','tprm.client_comment'
  ],
  contributor: [
    'client_portal.view','client_request.respond','evidence.upload','comment.create'
  ],
};

const ROLE_ALIASES = {
  firm_owner:       'manager',
  lead_consultant:  'senior_consultant',
  client_admin:     'client_owner',
  reviewer:         'contributor',
  auditor:          'contributor',
  read_only:        'contributor',
};

const ROLE_LABELS = {
  manager:            'Manager',
  senior_consultant:  'Senior consultant',
  consultant:         'Consultant',
  client_owner:       'Client sponsor',
  isms_manager:       'Client coordinator',
  contributor:        'Contributor',
};

const FIRM_ROLES   = ['manager', 'senior_consultant', 'consultant'];
const CLIENT_ROLES = ['client_owner', 'isms_manager', 'contributor'];

const PERMISSION_ALIASES = {
  'supplier.manage': ['tprm.third_party.manage'],
  'supplier.approve': ['tprm.recommendation.issue'],
  'supplier.export': ['tprm.assurance.export'],
  'tprm.third_party.manage': ['supplier.manage'],
  'tprm.recommendation.issue': ['supplier.approve'],
  'tprm.assurance.export': ['supplier.export']
};

function normalizeRole(role) {
  if (!role) return role;
  return ROLE_ALIASES[role] || role;
}

function rolePermissions(role) {
  const r = ROLE_PERMS[normalizeRole(role)];
  if (r === '*') return Object.keys(PERMISSIONS);
  return Array.isArray(r) ? r : [];
}

function parseOverrideExpiry(value) {
  if (value instanceof Date) return value.getTime();
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(raw)
    ? raw.replace(' ', 'T') + 'Z'
    : raw;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function isOverrideActive(override, now = new Date()) {
  if (!override || override.expires_at == null || override.expires_at === '') return true;
  const expiresAt = parseOverrideExpiry(override.expires_at);
  const nowAt = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Number.isFinite(expiresAt) && Number.isFinite(nowAt) && expiresAt > nowAt;
}

async function activeOverrides(connection, workspaceId, userId) {
  return await connection.prepare(`SELECT permission, granted, expires_at
    FROM workspace_role_overrides
    WHERE workspace_id=? AND user_id=?
      AND (expires_at IS NULL OR expires_at > utc_now_text())`).all(workspaceId, userId);
}

function permissionFamily(permission) {
  const family = new Set([permission]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [candidate, aliases] of Object.entries(PERMISSION_ALIASES)) {
      if (!family.has(candidate) && !aliases.some(alias => family.has(alias))) continue;
      for (const member of [candidate, ...aliases]) {
        if (family.has(member)) continue;
        family.add(member);
        changed = true;
      }
    }
  }
  return family;
}

function effectivePermissions(role, overrides = [], now = new Date()) {
  const base = new Set(rolePermissions(role));
  const active = overrides.filter(o => isOverrideActive(o, now));
  if (FIRM_ROLES.includes(normalizeRole(role))) {
    const legacyDenied = active.some(o => o.permission === 'client_request.manage' && !o.granted);
    const legacyGranted = base.has('client_request.manage') || active.some(o => o.permission === 'client_request.manage' && o.granted);
    for (const permission of ['client_request.create','client_request.cancel']) {
      if (legacyDenied) base.delete(permission);
      else if (legacyGranted) base.add(permission);
    }
  }
  for (const o of active) {
    if (o.granted) base.add(o.permission);
  }
  for (const o of active) {
    if (o.granted) continue;
    for (const member of permissionFamily(o.permission)) base.delete(member);
  }
  return base;
}

function hasPermission(perms, perm) {
  if (!perms) return false;
  if (perms === '*' || (perms.has && perms.has('*'))) return true;
  const owns = candidate => perms.has ? perms.has(candidate) : perms.includes(candidate);
  if (owns(perm)) return true;
  return (PERMISSION_ALIASES[perm] || []).some(owns);
}

function isManager(firmRole) {
  return normalizeRole(firmRole) === 'manager';
}

module.exports = {
  PERMISSIONS, ROLE_PERMS, ROLE_LABELS, ROLE_ALIASES, PERMISSION_ALIASES,
  FIRM_ROLES, CLIENT_ROLES,
  normalizeRole, rolePermissions, effectivePermissions, hasPermission, isManager, permissionFamily,
  isOverrideActive, activeOverrides
};
