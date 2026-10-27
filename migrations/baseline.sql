CREATE TABLE IF NOT EXISTS firms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
, timezone TEXT DEFAULT 'UTC');

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  user_type TEXT NOT NULL CHECK(user_type IN ('firm','client')),
  firm_id INTEGER,
  firm_role TEXT,
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_active_at DATETIME, locale TEXT DEFAULT 'en', idp_subject TEXT, idp_kind TEXT, mfa_secret TEXT, mfa_enabled_at DATETIME, mfa_recovery_codes TEXT, mfa_last_counter INTEGER DEFAULT -1, email_notify TEXT DEFAULT 'immediate', auth_epoch INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (firm_id) REFERENCES firms(id)
);

CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER NOT NULL,
  client_name TEXT NOT NULL,
  industry TEXT,
  scope TEXT,
  target_cert_date DATE,
  stage TEXT DEFAULT 'gap_assessment',
  lead_consultant_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, timezone TEXT, encryption_enabled INTEGER DEFAULT 1, monthly_plan TEXT, scope_confirmed_at DATETIME, scope_confirmed_by INTEGER REFERENCES users(id), updated_at DATETIME, brand_display_name TEXT, brand_primary_color TEXT, brand_logo_path TEXT, sector TEXT, locale TEXT DEFAULT 'en', frameworks TEXT DEFAULT '["iso27001"]', engagement_outcome TEXT NOT NULL DEFAULT 'certification_support'
  CHECK(engagement_outcome IN ('gap_assessment_only','certification_support')),
  FOREIGN KEY (firm_id) REFERENCES firms(id),
  FOREIGN KEY (lead_consultant_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS workspace_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, user_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS iso_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  category TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  questions TEXT,
  evidence_needed TEXT,
  documentation_needed TEXT,
  sort_order INTEGER
, purpose TEXT, what_good_looks_like TEXT, common_pitfalls TEXT, evidence_to_look_for TEXT, scoping_notes TEXT, maturity_ladder TEXT, related_items TEXT, minimum_certifiable TEXT);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT,
  classification TEXT,
  owner_name TEXT,
  cia_c INTEGER DEFAULT 1,
  cia_i INTEGER DEFAULT 1,
  cia_a INTEGER DEFAULT 1,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL, business_criticality TEXT, rto_hours INTEGER, rpo_hours INTEGER, bia_notes TEXT, source_type TEXT, source_ref TEXT, version INTEGER NOT NULL DEFAULT 1, updated_at DATETIME, updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS risks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  asset_id INTEGER,
  threat TEXT,
  vulnerability TEXT,
  likelihood INTEGER DEFAULT 3,
  impact INTEGER DEFAULT 3,
  treatment TEXT DEFAULT 'modify',
  owner_name TEXT,
  status TEXT DEFAULT 'open',
  residual_likelihood INTEGER,
  residual_impact INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL, is_systemic INTEGER DEFAULT 0, is_dpia INTEGER DEFAULT 0, accepted_until DATE, last_acceptance_id INTEGER, management_system TEXT NOT NULL DEFAULT 'iso27001'
      CHECK(management_system IN ('iso27001')),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS risk_controls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  risk_id INTEGER NOT NULL,
  iso_item_id TEXT NOT NULL,
  UNIQUE(risk_id, iso_item_id),
  FOREIGN KEY (risk_id) REFERENCES risks(id) ON DELETE CASCADE,
  FOREIGN KEY (iso_item_id) REFERENCES iso_items(id)
);

CREATE TABLE IF NOT EXISTS supplier_controls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL,
  iso_item_id TEXT NOT NULL,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(supplier_id, iso_item_id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
  FOREIGN KEY (iso_item_id) REFERENCES iso_items(id)
);

CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  iso_item_id TEXT,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  sha256 TEXT,
  size_bytes INTEGER,
  uploaded_by INTEGER NOT NULL,
  description TEXT,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, retention_until DATE, retention_rule_id INTEGER, valid_from DATE, valid_until DATE, period_label TEXT, clause_section TEXT, supersedes_id INTEGER REFERENCES evidence(id) ON DELETE SET NULL, superseded_at TEXT, superseded_by_id INTEGER REFERENCES evidence(id) ON DELETE SET NULL, tags TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  iso_item_id TEXT,
  risk_id INTEGER,
  assignee_id INTEGER,
  due_date DATE,
  status TEXT DEFAULT 'todo',
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL, parent_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL, recurrence TEXT, recurrence_until DATE, depends_on_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL, estimated_minutes INTEGER, template_id INTEGER REFERENCES task_templates(id) ON DELETE SET NULL, nonconformity_id INTEGER REFERENCES nonconformities(id) ON DELETE SET NULL, priority TEXT DEFAULT 'normal', engagement_milestone_id INTEGER REFERENCES engagement_delivery_milestones(id) ON DELETE SET NULL, engagement_deliverable_id INTEGER REFERENCES engagement_delivery_deliverables(id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (assignee_id) REFERENCES users(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (risk_id) REFERENCES risks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  parent_type TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  internal_only INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, parent_comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE, has_mentions INTEGER DEFAULT 0,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER,
  entity_scope_id INTEGER,
  user_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  before_state TEXT,
  after_state TEXT,
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS doc_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER,
  name TEXT NOT NULL,
  category TEXT,
  description TEXT,
  content TEXT NOT NULL,
  is_system INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, tier TEXT DEFAULT 'recommended', controls TEXT, clauses TEXT, framework TEXT DEFAULT 'iso27001', requirement_refs TEXT,
  FOREIGN KEY (firm_id) REFERENCES firms(id)
);

CREATE TABLE IF NOT EXISTS generated_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  template_id INTEGER,
  name TEXT NOT NULL,
  category TEXT,
  content TEXT,
  status TEXT DEFAULT 'draft',
  version INTEGER DEFAULT 1,
  approved_by INTEGER,
  approved_at DATETIME,
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL, locked INTEGER DEFAULT 0, retired_at DATETIME, published_at DATETIME, approval_due DATETIME, review_period_months INTEGER DEFAULT 12, next_review_date DATE, current_version_id INTEGER REFERENCES doc_versions(id) ON DELETE SET NULL, parent_doc_id INTEGER REFERENCES generated_docs(id) ON DELETE SET NULL, doc_kind TEXT, reference_code TEXT, controlled_copy INTEGER DEFAULT 0, source_filename TEXT, source_stored_path TEXT, source_mime TEXT, source_size_bytes INTEGER, source_sha256 TEXT, requires_training INTEGER DEFAULT 0, training_audience TEXT, watermark TEXT, withdrawn_at TEXT, withdrawn_by INTEGER REFERENCES users(id), withdrawal_reason TEXT, retention_period TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES doc_templates(id)
);

CREATE TABLE IF NOT EXISTS audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  scope TEXT,
  audit_date DATE,
  auditor_name TEXT,
  status TEXT DEFAULT 'planned',
  summary TEXT,
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL, programme_id INTEGER REFERENCES audit_programmes(id) ON DELETE SET NULL, auditor_competence TEXT, auditor_independence TEXT, sample_size INTEGER, population_size INTEGER, lifecycle_stage TEXT DEFAULT 'planned', fieldwork_started_at DATETIME, report_issued_at DATETIME, closed_at DATETIME, sampling_justification TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id INTEGER NOT NULL,
  iso_item_id TEXT,
  finding_type TEXT,
  description TEXT NOT NULL,
  severity TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'open',
  nonconformity_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (audit_id) REFERENCES audits(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mrms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  meeting_date DATE,
  attendees TEXT,
  status TEXT DEFAULT 'planned',
  context_changes TEXT,
  prior_actions_status TEXT,
  performance_review TEXT,
  feedback_interested_parties TEXT,
  risk_treatment_status TEXT,
  improvement_opportunities TEXT,
  decisions TEXT,
  action_items TEXT,
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL, interested_party_changes TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS nonconformities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  source TEXT,
  source_ref TEXT,
  description TEXT,
  severity TEXT DEFAULT 'minor',
  iso_item_id TEXT,
  root_cause TEXT,
  corrective_action TEXT,
  responsible TEXT,
  due_date DATE,
  effectiveness_check TEXT,
  status TEXT DEFAULT 'open',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS framework_mappings (
  iso_item_id TEXT NOT NULL,
  framework TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  notes TEXT,
  PRIMARY KEY (iso_item_id, framework, external_ref)
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  category TEXT,
  severity TEXT DEFAULT 'medium',
  detected_at DATETIME,
  reported_by TEXT,
  status TEXT DEFAULT 'open',
  description TEXT,
  affected_assets TEXT,
  containment_actions TEXT,
  eradication_actions TEXT,
  recovery_actions TEXT,
  lessons_learned TEXT,
  external_notification TEXT,
  nonconformity_id INTEGER,
  closed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL, notification_required_by DATETIME, notification_sent_at DATETIME, pir_completed INTEGER DEFAULT 0, pir_summary TEXT, is_tabletop INTEGER DEFAULT 0, runbook_id INTEGER, contained_at DATETIME, eradicated_at DATETIME, recovered_at DATETIME, notify_who TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  service_provided TEXT,
  tier TEXT DEFAULT 'tier_2',
  data_access TEXT DEFAULT 'none',
  contract_start DATE,
  contract_end DATE,
  next_review_date DATE,
  attestations TEXT,
  contact TEXT,
  notes TEXT,
  status TEXT DEFAULT 'active',
  last_assessed DATE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL, termination_started_at DATETIME, termination_owner TEXT, lifecycle_stage TEXT DEFAULT 'active', inherent_risk_score INTEGER, residual_risk_score INTEGER, business_criticality TEXT DEFAULT 'medium', data_volume TEXT DEFAULT 'low', industry TEXT, location TEXT, parent_company TEXT, regulatory_exposure TEXT, dependency_type TEXT DEFAULT 'multi_source', annual_spend TEXT, renewal_notice_days INTEGER, auto_renew INTEGER DEFAULT 0, approved_by TEXT, approved_at DATETIME, terminated_at DATETIME, data_return_completed INTEGER DEFAULT 0, website TEXT, relationship_owner TEXT, business_owner TEXT, security_reviewer TEXT, privacy_owner TEXT, service_category TEXT, processing_purpose TEXT, data_categories TEXT, hosting_locations TEXT, critical_processes TEXT, system_access TEXT, rto_hours INTEGER, rpo_hours INTEGER, exit_strategy TEXT, archived_at TEXT, archived_by INTEGER REFERENCES users(id), archive_reason TEXT, risk_override_score INTEGER, risk_override_reason TEXT, risk_override_by INTEGER REFERENCES users(id), risk_override_at TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS training_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  user_name TEXT NOT NULL,
  user_role TEXT,
  training_name TEXT NOT NULL,
  assigned_date DATE,
  due_date DATE,
  completed_date DATE,
  score TEXT,
  status TEXT DEFAULT 'assigned',
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL, source_doc_id INTEGER REFERENCES generated_docs(id) ON DELETE SET NULL, course_id INTEGER REFERENCES training_courses(id) ON DELETE SET NULL, attestation_signed_at DATETIME, attestation_ip TEXT, quiz_score INTEGER, expiry_date DATE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS supplier_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  doc_type TEXT,
  name TEXT NOT NULL,
  filename TEXT,
  stored_path TEXT,
  sha256 TEXT,
  size_bytes INTEGER,
  effective_date DATE,
  expiry_date DATE,
  notes TEXT,
  uploaded_by INTEGER,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS supplier_subprocessors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  service_provided TEXT,
  data_access TEXT,
  location TEXT,
  approved INTEGER DEFAULT 0,
  approved_at DATETIME,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS supplier_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  review_date DATE,
  reviewer TEXT,
  outcome TEXT,
  inherent_risk INTEGER,
  residual_risk INTEGER,
  findings TEXT,
  action_items TEXT,
  next_review_date DATE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS supplier_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  user_name TEXT,
  body TEXT,
  internal_only INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS supplier_clauses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  clause_key TEXT NOT NULL,
  clause_label TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  notes TEXT,
  reviewed_at DATETIME,
  UNIQUE(supplier_id, clause_key),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS questionnaire_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER,
  name TEXT NOT NULL,
  description TEXT,
  is_system INTEGER DEFAULT 0,
  category TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS questionnaire_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  question_order INTEGER,
  section TEXT,
  question TEXT NOT NULL,
  question_type TEXT DEFAULT 'yes_no',
  options TEXT,
  weight INTEGER DEFAULT 1,
  expected_answer TEXT,
  iso_control_ref TEXT,
  FOREIGN KEY (template_id) REFERENCES questionnaire_templates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS supplier_questionnaires (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  template_id INTEGER NOT NULL,
  template_name TEXT,
  status TEXT DEFAULT 'draft',
  sent_at DATETIME,
  responded_at DATETIME,
  reviewed_at DATETIME,
  reviewer TEXT,
  total_questions INTEGER DEFAULT 0,
  answered_questions INTEGER DEFAULT 0,
  score INTEGER,
  risk_rating TEXT,
  reviewer_comments TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, external_token TEXT, external_email TEXT, external_completed_at DATETIME, external_expires_at DATETIME, invitation_status TEXT DEFAULT 'not_sent', external_contact_name TEXT, external_opened_at TEXT, external_last_saved_at TEXT, due_date TEXT, clarification_message TEXT, clarification_requested_at TEXT, reopened_at TEXT, reopened_by INTEGER REFERENCES users(id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES questionnaire_templates(id)
);

CREATE TABLE IF NOT EXISTS supplier_questionnaire_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  questionnaire_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  answer TEXT,
  comment TEXT,
  evidence_ref TEXT,
  UNIQUE(questionnaire_id, question_id),
  FOREIGN KEY (questionnaire_id) REFERENCES supplier_questionnaires(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  code TEXT,
  description TEXT,
  entity_type TEXT DEFAULT 'business_unit',
  region TEXT,
  scope_statement TEXT,
  contact TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, attributes TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_role_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  permission TEXT NOT NULL,
  granted INTEGER NOT NULL DEFAULT 1,
  granted_by INTEGER,
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME,
  UNIQUE(workspace_id, user_id, permission),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS doc_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  document_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  change_summary TEXT,
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  submitted_at DATETIME,
  approved_at DATETIME,
  published_at DATETIME,
  retired_at DATETIME,
  UNIQUE(document_id, version),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES generated_docs(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS doc_approvers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  document_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role_label TEXT,
  decision TEXT,
  decision_reason TEXT,
  decided_at DATETIME,
  notified_at DATETIME,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES generated_docs(id) ON DELETE CASCADE,
  FOREIGN KEY (version_id) REFERENCES doc_versions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS doc_signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  document_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_name TEXT NOT NULL,
  signature_role TEXT,
  intent TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  signed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES generated_docs(id) ON DELETE CASCADE,
  FOREIGN KEY (version_id) REFERENCES doc_versions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS risk_methodologies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  likelihood_scale TEXT NOT NULL,
  impact_scale TEXT NOT NULL,
  matrix TEXT NOT NULL,
  thresholds TEXT NOT NULL,
  is_active INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, management_system TEXT NOT NULL DEFAULT 'iso27001'
      CHECK(management_system IN ('iso27001')),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS risk_treatments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  risk_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  owner_name TEXT,
  owner_id INTEGER,
  due_date DATE,
  completed_date DATE,
  status TEXT DEFAULT 'planned',
  cost_estimate TEXT,
  expected_residual_l INTEGER,
  expected_residual_i INTEGER,
  iso_item_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (risk_id) REFERENCES risks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS kris (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  risk_id INTEGER,
  name TEXT NOT NULL,
  description TEXT,
  unit TEXT,
  green_max REAL,
  amber_max REAL,
  red_above_amber INTEGER DEFAULT 1,
  measurement_frequency TEXT DEFAULT 'monthly',
  owner_name TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (risk_id) REFERENCES risks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS kri_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kri_id INTEGER NOT NULL,
  value REAL NOT NULL,
  measured_at DATE NOT NULL,
  notes TEXT,
  recorded_by INTEGER,
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (kri_id) REFERENCES kris(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS soa_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  entity_id INTEGER,
  label TEXT,
  reason TEXT,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  control_count INTEGER,
  included_count INTEGER,
  excluded_count INTEGER,
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, version TEXT, owner TEXT, approved_by TEXT, approved_at TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS doc_ack_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  document_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  due_date DATE,
  status TEXT DEFAULT 'active',
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES generated_docs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS doc_ack_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_email TEXT,
  recipient_role TEXT,
  token TEXT UNIQUE NOT NULL,
  acknowledged_at DATETIME,
  signature_id INTEGER,
  ip_address TEXT,
  user_agent TEXT,
  reminded_count INTEGER DEFAULT 0,
  last_reminded_at DATETIME,
  FOREIGN KEY (campaign_id) REFERENCES doc_ack_campaigns(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_programmes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  year INTEGER NOT NULL,
  description TEXT,
  approved_by TEXT,
  approved_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS incident_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  incident_id INTEGER NOT NULL,
  phase TEXT NOT NULL,
  event_at DATETIME NOT NULL,
  description TEXT,
  actor TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runbooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER,
  name TEXT NOT NULL,
  category TEXT,
  trigger_severity TEXT,
  trigger_category TEXT,
  steps TEXT NOT NULL,
  is_system INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS supplier_monitoring (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  source TEXT,
  score REAL,
  grade TEXT,
  recorded_at DATE NOT NULL,
  notes TEXT,
  recorded_by INTEGER,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS supplier_termination_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  label TEXT NOT NULL,
  done INTEGER DEFAULT 0,
  done_at DATETIME,
  evidence TEXT,
  notes TEXT,
  UNIQUE(supplier_id, item_key),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS training_courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  duration_minutes INTEGER,
  validity_months INTEGER DEFAULT 12,
  required_for_roles TEXT,
  content_url TEXT,
  has_quiz INTEGER DEFAULT 0,
  passing_score INTEGER,
  iso_control_ref TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS phishing_simulations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  campaign_date DATE,
  recipients_count INTEGER,
  clicked_count INTEGER,
  reported_count INTEGER,
  credentials_entered_count INTEGER,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER,
  firm_id INTEGER,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  is_system INTEGER DEFAULT 0,
  steps TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  task_id INTEGER,
  date DATE NOT NULL,
  minutes INTEGER NOT NULL,
  description TEXT,
  billable INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS asset_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  parent_asset_id INTEGER NOT NULL,
  child_asset_id INTEGER NOT NULL,
  relation TEXT NOT NULL,
  notes TEXT,
  UNIQUE(parent_asset_id, child_asset_id, relation),
  FOREIGN KEY (parent_asset_id) REFERENCES assets(id) ON DELETE CASCADE,
  FOREIGN KEY (child_asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER,
  user_id INTEGER,
  category TEXT NOT NULL,
  severity TEXT DEFAULT 'info',
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read_at DATETIME,
  dismissed_at DATETIME,
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(notification_id, user_id),
  FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS permission_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER,
  name TEXT NOT NULL,
  description TEXT,
  permissions TEXT NOT NULL,
  is_system INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS access_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  period_start DATE,
  period_end DATE,
  status TEXT DEFAULT 'open',
  reviewer TEXT,
  outcome TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS access_review_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  current_role TEXT,
  decision TEXT,
  decision_reason TEXT,
  reviewer TEXT,
  decided_at DATETIME,
  FOREIGN KEY (review_id) REFERENCES access_reviews(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_chain (
  id INTEGER PRIMARY KEY,
  audit_log_id INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (audit_log_id) REFERENCES audit_log(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scopes TEXT NOT NULL,
  expires_at DATETIME,
  last_used_at DATETIME,
  ip_lock TEXT,
  revoked_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS custom_field_defs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL,
  options TEXT,
  required INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, entity_type, field_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS custom_field_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field_def_id INTEGER NOT NULL,
  value TEXT,
  UNIQUE(entity_type, entity_id, field_def_id),
  FOREIGN KEY (field_def_id) REFERENCES custom_field_defs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS risk_appetites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL UNIQUE,
  statement TEXT,
  appetite_low_max REAL,
  appetite_med_max REAL,
  auto_accept_below INTEGER DEFAULT 0,
  approver_role TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS risk_acceptances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  risk_id INTEGER NOT NULL,
  accepter_name TEXT NOT NULL,
  accepter_role TEXT,
  accepter_user_id INTEGER,
  rationale TEXT NOT NULL,
  residual_score INTEGER,
  expires_at DATE,
  signature TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  signed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (risk_id) REFERENCES risks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dpias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  entity_id INTEGER,
  title TEXT NOT NULL,
  processing_description TEXT,
  data_categories TEXT,
  data_subjects TEXT,
  lawful_basis TEXT,
  necessity_test TEXT,
  proportionality_test TEXT,
  data_flows TEXT,
  retention_period TEXT,
  international_transfers TEXT,
  consultations TEXT,
  identified_risks TEXT,
  mitigations TEXT,
  residual_risk_level TEXT,
  outcome TEXT,
  approver TEXT,
  approver_signature TEXT,
  approved_at DATETIME,
  status TEXT DEFAULT 'draft',
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id INTEGER NOT NULL,
  iso_item_id TEXT,
  description TEXT NOT NULL,
  recommendation TEXT,
  status TEXT DEFAULT 'open',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (audit_id) REFERENCES audits(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS retention_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  applies_to TEXT NOT NULL,
  pattern TEXT,
  retain_years INTEGER NOT NULL,
  reason TEXT,
  is_active INTEGER DEFAULT 1,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  widget_key TEXT NOT NULL,
  position INTEGER DEFAULT 0,
  config TEXT,
  UNIQUE(workspace_id, user_id, widget_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comment_mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL,
  mentioned_user_id INTEGER NOT NULL,
  read_at DATETIME,
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (mentioned_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS report_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER,
  firm_id INTEGER,
  name TEXT NOT NULL,
  description TEXT,
  body TEXT NOT NULL,
  is_system INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crisis_comms_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER,
  name TEXT NOT NULL,
  audience TEXT NOT NULL,
  channel TEXT,
  body TEXT NOT NULL,
  is_system INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ccm_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER,
  firm_id INTEGER,
  iso_item_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  rule_kind TEXT NOT NULL,
  rule_config TEXT NOT NULL,
  frequency TEXT DEFAULT 'daily',
  is_active INTEGER DEFAULT 1,
  is_system INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ccm_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  rule_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  measured_value TEXT,
  details TEXT,
  ran_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rule_id) REFERENCES ccm_rules(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS backup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes INTEGER,
  sha256 TEXT,
  encrypted INTEGER DEFAULT 1,
  status TEXT NOT NULL,
  error TEXT,
  ran_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS key_rotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prev_key_fp TEXT NOT NULL,
  new_key_fp TEXT NOT NULL,
  rotated_by INTEGER,
  rows_reencrypted INTEGER,
  status TEXT NOT NULL,
  notes TEXT,
  rotated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS onboarding_progress (
  workspace_id INTEGER PRIMARY KEY,
  step_workspace INTEGER DEFAULT 0,
  step_scope INTEGER DEFAULT 0,
  step_assets INTEGER DEFAULT 0,
  step_risk INTEGER DEFAULT 0,
  step_methodology INTEGER DEFAULT 0,
  step_policies INTEGER DEFAULT 0,
  step_team INTEGER DEFAULT 0,
  step_supplier INTEGER DEFAULT 0,
  dismissed INTEGER DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS external_approvers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  document_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role_label TEXT,
  token_hash TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  decision TEXT,
  decision_reason TEXT,
  decided_at DATETIME,
  ip_address TEXT,
  user_agent TEXT,
  notified_at DATETIME,
  revoked_at DATETIME,
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES generated_docs(id) ON DELETE CASCADE,
  FOREIGN KEY (version_id) REFERENCES doc_versions(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS firm_email_settings (
  firm_id INTEGER PRIMARY KEY,
  from_name TEXT,
  from_email TEXT,
  reply_to TEXT,
  enabled INTEGER DEFAULT 1,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER,
  workspace_id INTEGER,
  to_email TEXT NOT NULL,
  from_email TEXT,
  subject TEXT NOT NULL,
  body_html TEXT,
  body_text TEXT,
  related_type TEXT,
  related_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  provider TEXT,
  provider_message_id TEXT,
  error_message TEXT,
  sent_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  workspace_id UNINDEXED, entity_type UNINDEXED, entity_id UNINDEXED,
  title, body
);

CREATE TABLE IF NOT EXISTS auditor_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    label TEXT,
    expires_at DATETIME,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_accessed_at DATETIME,
    access_count INTEGER DEFAULT 0,
    revoked_at DATETIME, token_hash TEXT, token_last4 TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

CREATE TABLE IF NOT EXISTS competence_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      required_competences TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS competence_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      role_id INTEGER NOT NULL,
      person_name TEXT NOT NULL,
      person_email TEXT,
      competence TEXT NOT NULL,
      evidence_type TEXT,
      evidence_ref TEXT,
      recorded_at DATE,
      expires_on DATE,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, evidence_id INTEGER REFERENCES evidence(id) ON DELETE SET NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (role_id) REFERENCES competence_roles(id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS communication_plan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      what TEXT NOT NULL,
      audience TEXT,
      channel TEXT,
      frequency TEXT,
      owner_name TEXT,
      internal_external TEXT DEFAULT 'internal',
      last_sent_date DATE,
      next_due_date DATE,
      trigger_event TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS control_state_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    iso_item_id TEXT NOT NULL,
    snapshot_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    changed_by INTEGER,
    status TEXT,
    applicability TEXT,
    maturity INTEGER,
    scope_pct INTEGER,
    inclusion_justification TEXT,
    exclusion_justification TEXT,
    notes TEXT,
    assessment_answers TEXT, pass_id INTEGER REFERENCES assessment_passes(id) ON DELETE SET NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (iso_item_id) REFERENCES iso_items(id),
    FOREIGN KEY (changed_by) REFERENCES users(id)
  );

CREATE TABLE IF NOT EXISTS interested_parties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    party TEXT NOT NULL,
    party_type TEXT,
    needs TEXT,
    how_addressed TEXT,
    owner TEXT,
    review_cadence TEXT,
    last_reviewed TEXT,
    next_review TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, requirement_kind TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

CREATE TABLE IF NOT EXISTS security_objectives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    measurement TEXT,
    target_value TEXT,
    current_value TEXT,
    owner TEXT,
    due_date TEXT,
    status TEXT DEFAULT 'on_track',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, metric_id INTEGER REFERENCES isms_metrics(id) ON DELETE SET NULL, status_mode TEXT NOT NULL DEFAULT 'manual'
    CHECK(status_mode IN ('manual','metric')), plan_actions TEXT, resources TEXT, evaluation_method TEXT, communicated_on DATE, framework TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

CREATE TABLE IF NOT EXISTS soa_custom_controls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    source_framework TEXT,
    applicability TEXT DEFAULT 'included',
    inclusion_justification TEXT,
    exclusion_justification TEXT,
    status TEXT DEFAULT 'Not Assessed',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

CREATE TABLE IF NOT EXISTS assessment_passes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    pass_number INTEGER NOT NULL,
    label TEXT,
    notes TEXT,
    status TEXT DEFAULT 'in_progress',
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    started_by INTEGER,
    completed_by INTEGER,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (started_by) REFERENCES users(id),
    FOREIGN KEY (completed_by) REFERENCES users(id)
  );

CREATE TABLE IF NOT EXISTS risk_treatment_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    risk_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    owner_name TEXT,
    due_date DATE,
    status TEXT DEFAULT 'planned',
    residual_likelihood INTEGER,
    residual_impact INTEGER,
    closed_at DATETIME,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (risk_id) REFERENCES risks(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

CREATE TABLE IF NOT EXISTS cert_cycle_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    planned_date DATE,
    actual_date DATE,
    status TEXT DEFAULT 'planned',
    certification_body TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

CREATE TABLE IF NOT EXISTS tenant_onboarding (
    firm_id INTEGER PRIMARY KEY,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    current_step INTEGER DEFAULT 1,
    skipped INTEGER DEFAULT 0,
    FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
  );

CREATE TABLE IF NOT EXISTS engagement_intake (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    question_id TEXT NOT NULL,
    answer TEXT,
    answered_by INTEGER,
    answered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(workspace_id, question_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

CREATE TABLE IF NOT EXISTS engagement_plan_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    milestone_id TEXT NOT NULL,
    completed_at DATETIME,
    target_date DATE,
    notes TEXT,
    UNIQUE(workspace_id, milestone_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

CREATE TABLE IF NOT EXISTS firm_risk_library (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firm_id INTEGER NOT NULL,
    code TEXT,
    title TEXT NOT NULL,
    description TEXT,
    threat TEXT,
    vulnerability TEXT,
    suggested_likelihood INTEGER,
    suggested_impact INTEGER,
    suggested_treatment TEXT,
    suggested_controls TEXT,
    domain TEXT,
    sector TEXT,
    tags TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
  );

CREATE TABLE IF NOT EXISTS questionnaire_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    questionnaire_id INTEGER NOT NULL,
    question_id INTEGER,
    workspace_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    mime TEXT,
    size_bytes INTEGER,
    sha256 TEXT,
    source TEXT DEFAULT 'vendor',
    uploaded_by INTEGER,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (questionnaire_id) REFERENCES supplier_questionnaires(id) ON DELETE CASCADE
  );

CREATE TABLE IF NOT EXISTS improvements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    source TEXT,
    source_ref TEXT,
    owner_name TEXT,
    due_date DATE,
    status TEXT DEFAULT 'open',
    closed_at DATETIME,
    impact_notes TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

CREATE TABLE IF NOT EXISTS member_scopes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('control','risk','asset','document')),
      scope_id TEXT NOT NULL,
      granted_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workspace_id, user_id, scope_type, scope_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (granted_by) REFERENCES users(id)
    );

CREATE TABLE IF NOT EXISTS user_invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      name TEXT,
      firm_id INTEGER NOT NULL,
      user_type TEXT NOT NULL CHECK(user_type IN ('firm','client')),
      firm_role TEXT,
      workspace_id INTEGER,
      workspace_role TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      accepted_at DATETIME,
      accepted_user_id INTEGER,
      revoked_at DATETIME,
      invited_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (firm_id) REFERENCES firms(id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (accepted_user_id) REFERENCES users(id),
      FOREIGN KEY (invited_by) REFERENCES users(id)
    );

CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      requested_ip TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS bcp_processes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      owner_name TEXT,
      criticality TEXT DEFAULT 'medium',
      max_tolerable_downtime_hours REAL,
      rto_hours REAL,
      rpo_hours REAL,
      dependencies TEXT,
      peak_periods TEXT,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS bcp_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      plan_type TEXT DEFAULT 'bcp',
      recovery_steps TEXT,
      key_contacts TEXT,
      alternate_site TEXT,
      status TEXT DEFAULT 'draft',
      last_reviewed_at DATETIME,
      next_review_date DATE,
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

CREATE TABLE IF NOT EXISTS bcp_plan_processes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      process_id INTEGER NOT NULL,
      UNIQUE(plan_id, process_id),
      FOREIGN KEY (plan_id) REFERENCES bcp_plans(id) ON DELETE CASCADE,
      FOREIGN KEY (process_id) REFERENCES bcp_processes(id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS bcp_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      plan_id INTEGER NOT NULL,
      test_type TEXT DEFAULT 'tabletop',
      test_date DATE,
      participants TEXT,
      scenario_description TEXT,
      results TEXT,
      lessons_learned TEXT,
      rto_achieved_hours REAL,
      rpo_achieved_hours REAL,
      pass INTEGER,
      action_items TEXT,
      next_test_date DATE,
      conducted_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (plan_id) REFERENCES bcp_plans(id) ON DELETE CASCADE,
      FOREIGN KEY (conducted_by) REFERENCES users(id)
    );

CREATE TABLE IF NOT EXISTS changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    change_type TEXT DEFAULT 'normal',
    category TEXT,
    requester_name TEXT,
    requester_id INTEGER,
    risk_assessment TEXT,
    risk_level TEXT DEFAULT 'medium',
    impact_assessment TEXT,
    rollback_plan TEXT,
    status TEXT DEFAULT 'draft',
    submitted_at DATETIME,
    approved_at DATETIME,
    implemented_at DATETIME,
    closed_at DATETIME,
    implementation_notes TEXT,
    test_results TEXT,
    post_implementation_review TEXT,
    pir_date DATE,
    success INTEGER,
    linked_asset_ids TEXT,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (requester_id) REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

CREATE TABLE IF NOT EXISTS change_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    change_id INTEGER NOT NULL,
    workspace_id INTEGER NOT NULL,
    approver_id INTEGER,
    approver_name TEXT NOT NULL,
    sequence INTEGER DEFAULT 1,
    decision TEXT,
    reason TEXT,
    decided_at DATETIME,
    FOREIGN KEY (change_id) REFERENCES changes(id) ON DELETE CASCADE,
    FOREIGN KEY (approver_id) REFERENCES users(id)
  );

CREATE TABLE IF NOT EXISTS isms_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    metric_key TEXT NOT NULL,
    ref TEXT,
    name TEXT NOT NULL,
    category TEXT,
    unit TEXT,
    direction TEXT DEFAULT 'higher',
    formula TEXT,
    target_value REAL,
    target_text TEXT,
    frequency TEXT,
    owner_name TEXT,
    notes TEXT,
    is_active INTEGER DEFAULT 1,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, framework TEXT,
    UNIQUE(workspace_id, metric_key),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

CREATE TABLE IF NOT EXISTS isms_metric_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_id INTEGER NOT NULL,
    value REAL NOT NULL,
    measured_at DATE NOT NULL,
    status TEXT,
    notes TEXT,
    recorded_by INTEGER,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (metric_id) REFERENCES isms_metrics(id) ON DELETE CASCADE,
    FOREIGN KEY (recorded_by) REFERENCES users(id)
  );

CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now')),
    checksum TEXT
  );

CREATE TABLE IF NOT EXISTS migration_quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id TEXT,
  reason TEXT NOT NULL,
  raw_payload TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolution_note TEXT
);

CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT NOT NULL,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS frameworks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','transitional','retired')),
  is_canonical INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (code, version)
);

CREATE TABLE IF NOT EXISTS requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  framework_id INTEGER NOT NULL REFERENCES frameworks(id),
  ref TEXT NOT NULL,
  parent_ref TEXT,
  req_type TEXT NOT NULL
    CHECK (req_type IN ('clause','control','function','category','subcategory')),
  title TEXT NOT NULL,
  summary TEXT,
  guidance TEXT,
  sort_order INTEGER,
  UNIQUE (framework_id, ref)
);

CREATE TABLE IF NOT EXISTS requirement_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  mapped_requirement_id    INTEGER NOT NULL REFERENCES requirements(id),
  coverage TEXT NOT NULL CHECK (coverage IN ('full','partial','supporting')),
  residual_gap_note TEXT,
  mapped_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (canonical_requirement_id, mapped_requirement_id)
);

CREATE TABLE IF NOT EXISTS evidence_requirement_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_id INTEGER NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  relevance_note TEXT,
  section_ref TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (evidence_id, requirement_id)
);

CREATE TABLE IF NOT EXISTS control_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  entity_id INTEGER REFERENCES entities(id),
  applicability TEXT NOT NULL DEFAULT 'undecided'
    CHECK (applicability IN ('undecided','applicable','excluded')),
  inclusion_justification TEXT,
  exclusion_justification TEXT,
  status TEXT NOT NULL DEFAULT 'not_assessed',
  maturity INTEGER,
  scope_pct INTEGER,
  notes TEXT,
  internal_notes TEXT,
  local_override_text TEXT,
  owner_id INTEGER REFERENCES users(id),
  due_date TEXT,
  next_review TEXT,
  review_status TEXT DEFAULT 'none',
  last_verified_at TEXT,
  end_dated_at TEXT,
  last_updated TEXT DEFAULT (datetime('now')),
  migrated_from TEXT, review_requested_by INTEGER REFERENCES users(id), review_requested_at TEXT, review_reason TEXT, reviewed_by INTEGER REFERENCES users(id), reviewed_at TEXT, assessment_answers TEXT, record_version INTEGER NOT NULL DEFAULT 1 CHECK(record_version > 0),
  UNIQUE (workspace_id, requirement_id, entity_id)
);

CREATE TABLE IF NOT EXISTS proposed_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  instance_id INTEGER NOT NULL REFERENCES control_instances(id) ON DELETE CASCADE,
  proposed_status TEXT,
  proposed_maturity INTEGER,
  source TEXT NOT NULL CHECK (source IN
    ('assessment','audit','remediation','evidence','external_respondent','ai_suggestion')),
  source_ref TEXT,
  rationale TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  decided_by INTEGER REFERENCES users(id),
  decision TEXT CHECK (decision IN ('accepted','rejected','superseded')),
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS document_requirement_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES generated_docs(id) ON DELETE CASCADE,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  section_ref TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (document_id, requirement_id)
);

CREATE TABLE IF NOT EXISTS scoring_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER REFERENCES firms(id),
  name TEXT NOT NULL,
  model_type TEXT NOT NULL CHECK (model_type IN ('conformity','maturity','weighted_risk')),
  scale_def TEXT NOT NULL,
  rollup_rules TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS question_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER REFERENCES firms(id),
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  scoring_model_id INTEGER REFERENCES scoring_models(id),
  target_entity_type TEXT,
  created_at TEXT DEFAULT (datetime('now')), cloned_from INTEGER REFERENCES question_sets(id),
  UNIQUE (firm_id, name, version)
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_set_id INTEGER NOT NULL REFERENCES question_sets(id) ON DELETE CASCADE,
  stable_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  section TEXT,
  text TEXT NOT NULL,
  answer_type TEXT NOT NULL DEFAULT 'single_select'
    CHECK (answer_type IN ('single_select','multi_select','yes_no','free_text','evidence_required','na_with_justification')),
  options TEXT,
  weight REAL DEFAULT 1.0,
  expected_answer TEXT,
  guidance TEXT,
  conditional_on TEXT, tags TEXT,
  UNIQUE (question_set_id, stable_key)
);

CREATE TABLE IF NOT EXISTS question_requirement_map (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  PRIMARY KEY (question_id, requirement_id)
);

CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  question_set_id INTEGER NOT NULL REFERENCES question_sets(id),
  question_set_version INTEGER NOT NULL,
  label TEXT,
  pass_number INTEGER,
  period_start TEXT, period_end TEXT,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','in_progress','in_review','finalized')),
  propagation_done INTEGER NOT NULL DEFAULT 0,
  started_by INTEGER REFERENCES users(id), started_at TEXT,
  completed_by INTEGER REFERENCES users(id), finalized_at TEXT,
  migrated_from TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  answer TEXT,
  assessor_note TEXT,
  respondent_id INTEGER REFERENCES users(id),
  respondent_kind TEXT NOT NULL DEFAULT 'consultant'
    CHECK (respondent_kind IN ('consultant','client','external')),
  raw_source TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (assessment_id, question_id)
);

CREATE TABLE IF NOT EXISTS assessment_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  question_set_id INTEGER NOT NULL REFERENCES question_sets(id),
  cadence TEXT NOT NULL,
  next_run TEXT,
  trigger_rule TEXT,
  is_active INTEGER DEFAULT 1
, migrated_from TEXT);

CREATE TABLE IF NOT EXISTS assessment_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  version_number TEXT NOT NULL,
  published_at TEXT DEFAULT (datetime('now')),
  published_by INTEGER REFERENCES users(id),
  change_summary TEXT,
  is_current INTEGER DEFAULT 0,
  migrated_from TEXT,
  UNIQUE (assessment_id, version_number)
);

CREATE TABLE IF NOT EXISTS response_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES assessment_versions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  answer TEXT,
  assessor_note TEXT,
  weight REAL DEFAULT 1.0,
  UNIQUE (version_id, question_id)
);

CREATE TABLE IF NOT EXISTS external_assessment_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_id INTEGER REFERENCES assessments(id) ON DELETE CASCADE,
  entity_id INTEGER REFERENCES entities(id),
  email TEXT NOT NULL,
  name TEXT,
  token_hash TEXT NOT NULL,
  issued_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  revoked_at TEXT,
  created_by INTEGER REFERENCES users(id),
  migrated_from TEXT, questionnaire_id INTEGER REFERENCES supplier_questionnaires(id) ON DELETE CASCADE,
  UNIQUE (token_hash)
);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('assessment','audit','incident','risk','manual','migration')),
  source_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  severity TEXT NOT NULL DEFAULT 'medium',
  severity_scheme TEXT NOT NULL DEFAULT 'hml',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('draft','open','in_remediation','verified','closed','accepted_risk')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  migrated_from TEXT
);

CREATE TABLE IF NOT EXISTS finding_controls (
  finding_id INTEGER NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  instance_id INTEGER NOT NULL REFERENCES control_instances(id) ON DELETE CASCADE,
  PRIMARY KEY (finding_id, instance_id)
);

CREATE TABLE IF NOT EXISTS firm_recommendation_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT NOT NULL,
  domain TEXT, default_effort TEXT, tags TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  finding_id INTEGER REFERENCES findings(id) ON DELETE CASCADE,
  library_id INTEGER REFERENCES firm_recommendation_library(id),
  text TEXT NOT NULL,
  priority TEXT, effort_estimate TEXT,
  client_decision TEXT CHECK (client_decision IN ('accepted','rejected','deferred')),
  decided_at TEXT, decision_note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  migrated_from TEXT
);

CREATE TABLE IF NOT EXISTS roadmap_phases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, sort_order INTEGER, target_date TEXT
);

CREATE TABLE IF NOT EXISTS remediation_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  finding_id INTEGER REFERENCES findings(id),
  recommendation_id INTEGER REFERENCES recommendations(id),
  title TEXT NOT NULL, description TEXT,
  owner_kind TEXT CHECK (owner_kind IN ('consultant','client')),
  owner_user_id INTEGER REFERENCES users(id), owner_name TEXT,
  roadmap_phase_id INTEGER REFERENCES roadmap_phases(id),
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','in_progress','done_unverified','verified','closed','cancelled')),
  verification_evidence_id INTEGER REFERENCES evidence(id),
  verified_by INTEGER REFERENCES users(id), verified_at TEXT,
  closed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  migrated_from TEXT
);

CREATE TABLE IF NOT EXISTS control_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  instance_id INTEGER NOT NULL REFERENCES control_instances(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  compensating_controls TEXT,
  risk_acceptance_id INTEGER NOT NULL REFERENCES risk_acceptances(id),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  expiry TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active','under_review','expired','closed')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS client_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  request_type TEXT NOT NULL CHECK(request_type IN ('evidence','policy','control','action')),
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','submitted','accepted','changes_requested','cancelled')),
  assignee_id INTEGER,
  control_id TEXT,
  document_id INTEGER,
  due_date DATE,
  response_note TEXT,
  created_by INTEGER NOT NULL,
  reviewed_by INTEGER,
  submitted_at DATETIME,
  closed_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1, request_reason TEXT, acceptable_examples TEXT, evidence_period_start DATE, evidence_period_end DATE, confidentiality TEXT DEFAULT 'client_confidential'
  CHECK(confidentiality IN ('standard','client_confidential','restricted')), consultant_owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL, evidence_quality TEXT DEFAULT 'not_reviewed'
  CHECK(evidence_quality IN ('not_reviewed','insufficient','partially_sufficient','sufficient')), released_at DATETIME, released_by INTEGER REFERENCES users(id) ON DELETE SET NULL, responded_by INTEGER REFERENCES users(id) ON DELETE SET NULL, responded_for INTEGER REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (control_id) REFERENCES iso_items(id) ON DELETE SET NULL,
  FOREIGN KEY (document_id) REFERENCES generated_docs(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS client_request_evidence (
  request_id INTEGER NOT NULL,
  evidence_id INTEGER NOT NULL,
  linked_by INTEGER NOT NULL,
  linked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (request_id, evidence_id),
  FOREIGN KEY (request_id) REFERENCES client_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id) REFERENCES evidence(id) ON DELETE CASCADE,
  FOREIGN KEY (linked_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS client_request_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  actor_id INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('created','assigned','commented','evidence_linked','status_changed','response_updated','target_updated')),
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  metadata TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (request_id) REFERENCES client_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS supplier_risk_methodologies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  domain_weights TEXT NOT NULL,
  control_weights TEXT NOT NULL,
  thresholds TEXT NOT NULL,
  review_cadence TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')), definition_json TEXT, status TEXT NOT NULL DEFAULT 'published', content_hash TEXT, supersedes_id INTEGER REFERENCES supplier_risk_methodologies(id), published_by INTEGER REFERENCES users(id), published_at TEXT,
  UNIQUE(workspace_id, version)
);

CREATE TABLE IF NOT EXISTS supplier_risk_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  methodology_id INTEGER REFERENCES supplier_risk_methodologies(id),
  methodology_version INTEGER NOT NULL,
  inherent_score INTEGER NOT NULL,
  control_effectiveness INTEGER NOT NULL,
  calculated_residual_score INTEGER NOT NULL,
  effective_residual_score INTEGER NOT NULL,
  risk_band TEXT NOT NULL,
  components TEXT NOT NULL,
  rationale TEXT,
  event_type TEXT NOT NULL DEFAULT 'recalculation',
  recorded_by INTEGER REFERENCES users(id),
  recorded_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS supplier_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK(decision IN ('approved','conditional','rejected','renewed','offboard')),
  rationale TEXT NOT NULL,
  conditions TEXT,
  valid_until TEXT,
  residual_risk_score INTEGER NOT NULL,
  methodology_version INTEGER NOT NULL,
  decided_by INTEGER REFERENCES users(id),
  decider_name TEXT NOT NULL,
  decided_at TEXT DEFAULT (datetime('now')),
  superseded_at TEXT
, residual_risk_band TEXT, residual_risk_rationale TEXT, readiness_snapshot_json TEXT, inherent_assessment_id INTEGER REFERENCES supplier_inherent_assessments(id), ddq_assessment_id INTEGER REFERENCES supplier_ddq_assessments(id), contract_review_id INTEGER REFERENCES supplier_contract_reviews(id), idempotency_nonce TEXT, request_fingerprint TEXT, expected_current_decision_id INTEGER REFERENCES supplier_decisions(id), supersedes_id INTEGER REFERENCES supplier_decisions(id));

CREATE TABLE IF NOT EXISTS supplier_finding_links (
  finding_id INTEGER PRIMARY KEY REFERENCES findings(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  questionnaire_id INTEGER REFERENCES supplier_questionnaires(id) ON DELETE SET NULL,
  domain TEXT,
  due_date TEXT,
  owner_name TEXT,
  risk_acceptance_reason TEXT,
  risk_acceptance_expires_at TEXT,
  accepted_by INTEGER REFERENCES users(id),
  accepted_at TEXT
);

CREATE TABLE IF NOT EXISTS assurance_report_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  audience TEXT NOT NULL,
  default_sections TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assurance_report_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  definition_id INTEGER NOT NULL REFERENCES assurance_report_definitions(id),
  version_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  reporting_period_start TEXT,
  reporting_period_end TEXT,
  cutoff_at TEXT NOT NULL,
  scope_label TEXT,
  framework TEXT,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  audience TEXT,
  classification TEXT NOT NULL DEFAULT 'Confidential',
  watermark TEXT,
  prepared_for TEXT,
  prepared_by TEXT,
  executive_summary TEXT,
  selected_sections TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated'
    CHECK(status IN ('generated','in_review','changes_requested','approved','published','superseded')),
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  data_quality_json TEXT NOT NULL,
  source_manifest_json TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_by INTEGER REFERENCES users(id),
  submitted_at TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  approval_note TEXT,
  published_by INTEGER REFERENCES users(id),
  published_at TEXT,
  superseded_at TEXT,
  UNIQUE(workspace_id, definition_id, version_number)
);

CREATE TABLE IF NOT EXISTS assurance_report_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES assurance_report_runs(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_label TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_updated_at TEXT,
  UNIQUE(run_id, section_key, source_type, source_id)
);

CREATE TABLE IF NOT EXISTS assurance_report_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES assurance_report_runs(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assurance_report_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES assurance_report_runs(id) ON DELETE CASCADE,
  format TEXT NOT NULL CHECK(format IN ('pdf','docx','html','json')),
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  content_blob BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  generated_by INTEGER NOT NULL REFERENCES users(id),
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, format)
);

CREATE TABLE IF NOT EXISTS engagement_delivery_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'ISO 27001 delivery plan',
  objective TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('draft','active','on_hold','completed','cancelled')),
  target_start_date DATE,
  target_completion_date DATE,
  forecast_completion_date DATE,
  completion_criteria TEXT,
  baseline_version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS engagement_delivery_phases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES engagement_delivery_plans(id) ON DELETE CASCADE,
  phase_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK(status IN ('not_started','in_progress','blocked','complete','waived')),
  planned_start_date DATE,
  planned_end_date DATE,
  forecast_end_date DATE,
  actual_start_date DATE,
  actual_end_date DATE,
  is_continuous INTEGER NOT NULL DEFAULT 0,
  owner_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(plan_id, phase_key)
);

CREATE TABLE IF NOT EXISTS engagement_delivery_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES engagement_delivery_plans(id) ON DELETE CASCADE,
  phase_id INTEGER NOT NULL REFERENCES engagement_delivery_phases(id) ON DELETE CASCADE,
  milestone_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  acceptance_criteria TEXT,
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK(status IN ('not_started','in_progress','blocked','workspace_verified','complete','waived')),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK(priority IN ('low','normal','high','critical')),
  is_required INTEGER NOT NULL DEFAULT 1,
  completion_mode TEXT NOT NULL DEFAULT 'deliverable'
    CHECK(completion_mode IN ('manual','deliverable','workspace_record','gate')),
  owner_id INTEGER REFERENCES users(id),
  planned_start_date DATE,
  planned_end_date DATE,
  forecast_end_date DATE,
  actual_start_date DATE,
  actual_end_date DATE,
  completed_by INTEGER REFERENCES users(id),
  completed_at TEXT,
  completion_note TEXT,
  source_rule TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), minimum_duration_months INTEGER NOT NULL DEFAULT 0
  CHECK(minimum_duration_months >= 0 AND minimum_duration_months <= 36),
  UNIQUE(plan_id, milestone_key)
);

CREATE TABLE IF NOT EXISTS engagement_delivery_deliverables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES engagement_delivery_plans(id) ON DELETE CASCADE,
  milestone_id INTEGER NOT NULL REFERENCES engagement_delivery_milestones(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  acceptance_criteria TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','workspace_verified','submitted','changes_requested','accepted','rejected','superseded')),
  is_required INTEGER NOT NULL DEFAULT 1,
  owner_id INTEGER REFERENCES users(id),
  approver_id INTEGER REFERENCES users(id),
  due_date DATE,
  linked_record_type TEXT,
  linked_record_id TEXT,
  submitted_by INTEGER REFERENCES users(id),
  submitted_at TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  accepted_by INTEGER REFERENCES users(id),
  accepted_at TEXT,
  decision_note TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, client_visible INTEGER NOT NULL DEFAULT 1, requires_evidence INTEGER NOT NULL DEFAULT 1, revision_number INTEGER NOT NULL DEFAULT 1, supersedes_deliverable_id INTEGER REFERENCES engagement_delivery_deliverables(id) ON DELETE SET NULL, evidence_snapshot_json TEXT, client_title TEXT, client_description TEXT, framework_code TEXT NOT NULL DEFAULT 'iso27001', requirement_refs TEXT);

CREATE TABLE IF NOT EXISTS engagement_delivery_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES engagement_delivery_plans(id) ON DELETE CASCADE,
  predecessor_milestone_id INTEGER NOT NULL REFERENCES engagement_delivery_milestones(id) ON DELETE CASCADE,
  successor_milestone_id INTEGER NOT NULL REFERENCES engagement_delivery_milestones(id) ON DELETE CASCADE,
  dependency_type TEXT NOT NULL DEFAULT 'finish_to_start'
    CHECK(dependency_type IN ('finish_to_start','start_to_start','finish_to_finish')),
  lag_days INTEGER NOT NULL DEFAULT 0,
  is_mandatory INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(predecessor_milestone_id <> successor_milestone_id),
  UNIQUE(plan_id, predecessor_milestone_id, successor_milestone_id)
);

CREATE TABLE IF NOT EXISTS engagement_delivery_gate_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase_id INTEGER NOT NULL REFERENCES engagement_delivery_phases(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK(decision IN ('passed','waived','reopened')),
  criteria_snapshot TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  note TEXT,
  waiver_expires_at DATE,
  decided_by INTEGER NOT NULL REFERENCES users(id),
  decided_at TEXT NOT NULL DEFAULT (datetime('now'))
, evidence_snapshot_json TEXT);

CREATE TABLE IF NOT EXISTS engagement_delivery_baselines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES engagement_delivery_plans(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  label TEXT NOT NULL,
  reason TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  approved_by INTEGER NOT NULL REFERENCES users(id),
  approved_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(plan_id, version_number)
);

CREATE TABLE IF NOT EXISTS engagement_delivery_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES engagement_delivery_plans(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  details TEXT,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS engagement_delivery_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deliverable_id INTEGER NOT NULL REFERENCES engagement_delivery_deliverables(id) ON DELETE CASCADE,
  evidence_id INTEGER NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  linked_by INTEGER NOT NULL REFERENCES users(id),
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(deliverable_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS engagement_delivery_schedule_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES engagement_delivery_plans(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL,
  changed_milestones INTEGER NOT NULL DEFAULT 0,
  forecast_before DATE,
  forecast_after DATE,
  details_json TEXT,
  run_by INTEGER NOT NULL REFERENCES users(id),
  run_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS firm_methodologies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  framework_code TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','retired')),
  current_version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(firm_id,code)
);

CREATE TABLE IF NOT EXISTS firm_methodology_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  methodology_id INTEGER NOT NULL REFERENCES firm_methodologies(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  change_summary TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
  approved_by INTEGER NOT NULL REFERENCES users(id),
  approved_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(methodology_id,version_number)
);

CREATE TABLE IF NOT EXISTS gap_fieldwork_interviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_pass_id INTEGER REFERENCES assessment_passes(id) ON DELETE SET NULL,
  source_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  objective TEXT,
  participant_role TEXT NOT NULL,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  scheduled_at TEXT NOT NULL,
  duration_minutes INTEGER CHECK(duration_minutes IS NULL OR duration_minutes BETWEEN 5 AND 480),
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK(status IN ('scheduled','completed','rescheduled','cancelled')),
  completion_summary TEXT,
  completed_at TEXT,
  client_visible INTEGER NOT NULL DEFAULT 1 CHECK(client_visible IN (0,1)),
  row_version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,source_task_id)
);

CREATE TABLE IF NOT EXISTS gap_fieldwork_blockers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_pass_id INTEGER REFERENCES assessment_passes(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'high' CHECK(priority IN ('normal','high','critical')),
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','accepted_risk')),
  resolution_note TEXT,
  resolved_at TEXT,
  client_visible INTEGER NOT NULL DEFAULT 1 CHECK(client_visible IN (0,1)),
  row_version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gap_declared_defaults (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_pass_id INTEGER REFERENCES assessment_passes(id) ON DELETE SET NULL,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE RESTRICT,
  declaration TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','confirmed','withdrawn')),
  client_visible INTEGER NOT NULL DEFAULT 1 CHECK(client_visible IN (0,1)),
  row_version INTEGER NOT NULL DEFAULT 1,
  recorded_by INTEGER NOT NULL REFERENCES users(id),
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,assessment_pass_id,requirement_id)
);

CREATE TABLE IF NOT EXISTS gap_fieldwork_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_pass_id INTEGER REFERENCES assessment_passes(id) ON DELETE SET NULL,
  week_ending DATE NOT NULL,
  requirements_covered INTEGER NOT NULL,
  requirements_total INTEGER NOT NULL,
  interviews_completed INTEGER NOT NULL,
  interviews_planned INTEGER NOT NULL,
  requests_received INTEGER NOT NULL,
  requests_total INTEGER NOT NULL,
  active_blockers INTEGER NOT NULL,
  declared_defaults INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,assessment_pass_id,week_ending)
);

CREATE TABLE IF NOT EXISTS gap_assessment_phase_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_pass_id INTEGER NOT NULL REFERENCES assessment_passes(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK(phase IN ('mobilisation','fieldwork','validation','report','post_report','closure')),
  decision TEXT NOT NULL CHECK(decision IN ('complete','not_required','reopened')),
  rationale TEXT NOT NULL,
  decided_by INTEGER NOT NULL REFERENCES users(id),
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(workspace_id,assessment_pass_id,phase)
);

CREATE TABLE IF NOT EXISTS gap_assessment_phase_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase_decision_id INTEGER NOT NULL REFERENCES gap_assessment_phase_decisions(id) ON DELETE CASCADE,
  from_decision TEXT,
  to_decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS supplier_inherent_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  methodology_version TEXT NOT NULL,
  assessment_type TEXT NOT NULL DEFAULT 'onboarding' CHECK(assessment_type IN ('onboarding','periodic','triggered')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','superseded')),
  physical_data_centre_applicability TEXT NOT NULL DEFAULT 'unknown' CHECK(physical_data_centre_applicability IN ('yes','no','unknown')),
  weighted_score REAL,
  assigned_tier TEXT CHECK(assigned_tier IN ('tier_1','tier_2','tier_3','tier_4')),
  mandatory_floors_json TEXT NOT NULL DEFAULT '[]',
  module_applicability_json TEXT NOT NULL DEFAULT '[]',
  unknown_count INTEGER NOT NULL DEFAULT 25,
  due_date TEXT,
  submitted_at TEXT,
  approved_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  approval_rationale TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, methodology_id INTEGER REFERENCES supplier_risk_methodologies(id), methodology_snapshot_json TEXT, methodology_hash TEXT);

CREATE TABLE IF NOT EXISTS supplier_inherent_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES supplier_inherent_assessments(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  score INTEGER CHECK(score BETWEEN 0 AND 5),
  response_label TEXT,
  comment TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(assessment_id,question_id)
);

CREATE TABLE IF NOT EXISTS supplier_ddq_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  inherent_assessment_id INTEGER NOT NULL REFERENCES supplier_inherent_assessments(id),
  methodology_version TEXT NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('tier_1','tier_2','tier_3','tier_4')),
  assessment_type TEXT NOT NULL DEFAULT 'onboarding',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','issued','in_progress','submitted','under_review','complete','superseded')),
  modules_json TEXT NOT NULL DEFAULT '[]',
  vendor_contact_name TEXT,
  vendor_contact_email TEXT,
  due_date TEXT,
  token_hash TEXT,
  token_expires_at TEXT,
  issued_at TEXT,
  opened_at TEXT,
  submitted_at TEXT,
  completed_at TEXT,
  completed_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, methodology_id INTEGER REFERENCES supplier_risk_methodologies(id), methodology_snapshot_json TEXT, methodology_hash TEXT, delivery_status TEXT, delivery_provider TEXT, delivery_error TEXT, email_outbox_id INTEGER REFERENCES email_outbox(id), last_delivery_at TEXT);

CREATE TABLE IF NOT EXISTS supplier_ddq_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES supplier_ddq_assessments(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  response TEXT,
  detail TEXT,
  evidence_reference TEXT,
  evidence_date TEXT,
  evidence_owner TEXT,
  status TEXT NOT NULL DEFAULT 'Unanswered',
  reviewer_conclusion TEXT NOT NULL DEFAULT 'Not Reviewed',
  finding_id INTEGER REFERENCES findings(id) ON DELETE SET NULL,
  reviewer_comments TEXT,
  vendor_updated_at TEXT,
  reviewer_updated_at TEXT,
  reviewer_id INTEGER REFERENCES users(id),
  row_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(assessment_id,question_id)
);

CREATE TABLE IF NOT EXISTS supplier_ddq_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_id INTEGER NOT NULL REFERENCES supplier_ddq_assessments(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mime_type TEXT,
  source TEXT NOT NULL CHECK(source IN ('vendor','reviewer')),
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS supplier_contract_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  methodology_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','complete','superseded')),
  agreement_reference TEXT,
  agreement_date TEXT,
  reviewer_id INTEGER REFERENCES users(id),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, inherent_assessment_id INTEGER REFERENCES supplier_inherent_assessments(id), methodology_id INTEGER REFERENCES supplier_risk_methodologies(id), methodology_snapshot_json TEXT, methodology_hash TEXT);

CREATE TABLE IF NOT EXISTS supplier_contract_review_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES supplier_contract_reviews(id) ON DELETE CASCADE,
  clause_id TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'Not Reviewed',
  contract_reference TEXT,
  reviewer_comments TEXT,
  finding_id INTEGER REFERENCES findings(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(review_id,clause_id)
);

CREATE TABLE IF NOT EXISTS nonconformity_evidence_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  nonconformity_id INTEGER NOT NULL,
  evidence_id INTEGER NOT NULL,
  evidence_role TEXT NOT NULL CHECK(evidence_role IN ('remediation','validation')),
  linked_by INTEGER NOT NULL,
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,nonconformity_id,evidence_id,evidence_role),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,nonconformity_id)
    REFERENCES nonconformities(workspace_id,id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,evidence_id)
    REFERENCES evidence(workspace_id,id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(linked_by) REFERENCES users(id) ON DELETE NO ACTION
);

CREATE TABLE IF NOT EXISTS tprm_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  service_model TEXT CHECK(service_model IN ('assessment_only','programme_setup','managed_lifecycle')),
  status TEXT NOT NULL CHECK(status IN ('active','needs_classification','closed')),
  effective_from TEXT NOT NULL DEFAULT (datetime('now')),
  effective_to TEXT,
  activation_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  classified_by INTEGER REFERENCES users(id),
  classified_at TEXT,
  closed_by INTEGER REFERENCES users(id),
  close_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,id),
  CHECK(
    (status='needs_classification' AND service_model IS NULL)
    OR (status='active' AND service_model IS NOT NULL AND effective_to IS NULL)
    OR (status='closed' AND effective_to IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS tprm_assessment_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  module_id INTEGER NOT NULL,
  cycle_number INTEGER NOT NULL CHECK(cycle_number>0),
  cycle_type TEXT NOT NULL CHECK(cycle_type IN ('onboarding','periodic','triggered')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled')),
  trigger_reason TEXT,
  baseline_decision_id INTEGER,
  inherent_assessment_id INTEGER,
  ddq_assessment_id INTEGER,
  contract_review_id INTEGER,
  client_decision_authority_id INTEGER REFERENCES users(id),
  started_by INTEGER REFERENCES users(id),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  due_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(workspace_id,supplier_id,cycle_number),
  UNIQUE(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id) REFERENCES suppliers(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,module_id) REFERENCES tprm_modules(workspace_id,id),
  FOREIGN KEY (workspace_id,supplier_id,inherent_assessment_id)
    REFERENCES supplier_inherent_assessments(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,ddq_assessment_id)
    REFERENCES supplier_ddq_assessments(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,contract_review_id)
    REFERENCES supplier_contract_reviews(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,baseline_decision_id)
    REFERENCES tprm_client_decisions(workspace_id,supplier_id,id),
  CHECK((status='completed')=(completed_at IS NOT NULL)),
  CHECK((status='cancelled')=(cancelled_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS tprm_lifecycle_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER,
  module_id INTEGER NOT NULL,
  cycle_id INTEGER,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'module_enabled','module_classified','module_closed','cycle_started','cycle_cancelled',
    'artifact_linked','evidence_released','evidence_release_withdrawn','decision_authority_assigned','stage_transition','recommendation_issued','client_decision_recorded',
    'condition_completed','clarification_requested','clarification_responded','clarification_resolved',
    'monitoring_signal_recorded','monitoring_signal_triaged','reassessment_scheduled','legacy_history_linked'
  )),
  from_stage TEXT CHECK(from_stage IS NULL OR from_stage IN (
    'module_setup','intake','inherent_risk','due_diligence','contract_assurance',
    'consultancy_review','quality_review','client_decision','monitoring','deferred',
    'rejected','offboarding','closed'
  )),
  to_stage TEXT CHECK(to_stage IS NULL OR to_stage IN (
    'module_setup','intake','inherent_risk','due_diligence','contract_assurance',
    'consultancy_review','quality_review','client_decision','monitoring','deferred',
    'rejected','offboarding','closed'
  )),
  actor_user_id INTEGER REFERENCES users(id),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('consultant','consultancy_manager','client','external_provider','system','migration')),
  actor_name TEXT NOT NULL,
  reason TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
  idempotency_key TEXT,
  request_fingerprint TEXT,
  previous_event_hash TEXT,
  event_hash TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_hash),
  UNIQUE(idempotency_key),
  FOREIGN KEY (workspace_id,module_id) REFERENCES tprm_modules(workspace_id,id),
  FOREIGN KEY (workspace_id,supplier_id) REFERENCES suppliers(workspace_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
  CHECK((supplier_id IS NULL AND cycle_id IS NULL) OR supplier_id IS NOT NULL),
  CHECK(event_hash IS NULL OR (length(event_hash)=64 AND event_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK(previous_event_hash IS NULL OR (length(previous_event_hash)=64 AND previous_event_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK(request_fingerprint IS NULL OR (length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*')),
  CHECK(idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)))
);

CREATE TABLE IF NOT EXISTS tprm_recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  outcome TEXT NOT NULL CHECK(outcome IN (
    'recommend_onboard','recommend_with_conditions','do_not_recommend','insufficient_information'
  )),
  executive_summary TEXT NOT NULL,
  rationale TEXT NOT NULL,
  residual_risk_score INTEGER CHECK(residual_risk_score BETWEEN 0 AND 100),
  residual_risk_band TEXT CHECK(residual_risk_band IN ('low','moderate','high','critical','unknown')),
  valid_until TEXT,
  inherent_assessment_id INTEGER,
  ddq_assessment_id INTEGER,
  contract_review_id INTEGER,
  readiness_snapshot_json TEXT NOT NULL CHECK(json_valid(readiness_snapshot_json)),
  artifact_snapshot_json TEXT NOT NULL CHECK(json_valid(artifact_snapshot_json)),
  recommendation_hash TEXT NOT NULL,
  issued_by INTEGER NOT NULL REFERENCES users(id),
  issuer_name TEXT NOT NULL,
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  quality_reviewed_by INTEGER NOT NULL REFERENCES users(id),
  quality_reviewer_name TEXT NOT NULL,
  quality_reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
  quality_review_rationale TEXT NOT NULL,
  supersedes_id INTEGER,
  idempotency_key TEXT,
  request_fingerprint TEXT,
  UNIQUE(workspace_id,supplier_id,cycle_id,version),
  UNIQUE(workspace_id,supplier_id,cycle_id,id),
  UNIQUE(supersedes_id),
  UNIQUE(idempotency_key),
  UNIQUE(recommendation_hash),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,inherent_assessment_id)
    REFERENCES supplier_inherent_assessments(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,ddq_assessment_id)
    REFERENCES supplier_ddq_assessments(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,contract_review_id)
    REFERENCES supplier_contract_reviews(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id,supersedes_id)
    REFERENCES tprm_recommendations(workspace_id,supplier_id,cycle_id,id),
  CHECK(issued_by<>quality_reviewed_by),
  CHECK(length(recommendation_hash)=64 AND recommendation_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key))),
  CHECK(request_fingerprint IS NULL OR (length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'))
);

CREATE TABLE IF NOT EXISTS tprm_client_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  recommendation_id INTEGER NOT NULL,
  recommendation_version INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN (
    'onboard','onboard_with_conditions','do_not_onboard','defer_request_information'
  )),
  rationale TEXT NOT NULL,
  diverges_from_recommendation INTEGER NOT NULL CHECK(diverges_from_recommendation IN (0,1)),
  override_rationale TEXT,
  risk_acceptance_statement TEXT,
  risk_acceptance_expires_at TEXT,
  valid_until TEXT,
  client_actor_user_id INTEGER NOT NULL REFERENCES users(id),
  client_actor_name TEXT NOT NULL,
  client_actor_title TEXT NOT NULL,
  authority_basis TEXT NOT NULL,
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  decision_snapshot_json TEXT NOT NULL CHECK(json_valid(decision_snapshot_json)),
  decision_hash TEXT NOT NULL,
  supersedes_id INTEGER,
  idempotency_key TEXT,
  request_fingerprint TEXT,
  UNIQUE(workspace_id,supplier_id,version),
  UNIQUE(workspace_id,supplier_id,id),
  UNIQUE(supersedes_id),
  UNIQUE(idempotency_key),
  UNIQUE(decision_hash),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id,recommendation_id)
    REFERENCES tprm_recommendations(workspace_id,supplier_id,cycle_id,id),
  FOREIGN KEY (workspace_id,supplier_id,supersedes_id)
    REFERENCES tprm_client_decisions(workspace_id,supplier_id,id),
  CHECK(length(decision_hash)=64 AND decision_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key))),
  CHECK(request_fingerprint IS NULL OR (length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'))
);

CREATE TABLE IF NOT EXISTS tprm_conditions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('recommendation','client_decision')),
  recommendation_id INTEGER,
  client_decision_id INTEGER,
  finding_id INTEGER,
  condition_type TEXT NOT NULL CHECK(condition_type IN ('remediation','control','contract','evidence','monitoring','risk_acceptance','other')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('low','moderate','high','critical')),
  owner_type TEXT NOT NULL CHECK(owner_type IN ('client','third_party','consultancy')),
  owner_user_id INTEGER REFERENCES users(id),
  owner_name TEXT NOT NULL,
  due_date TEXT NOT NULL,
  verification_criteria TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','evidence_submitted','verified','waived','cancelled')),
  evidence_summary TEXT,
  completion_note TEXT,
  completed_at TEXT,
  completed_by INTEGER REFERENCES users(id),
  verified_at TEXT,
  verified_by INTEGER REFERENCES users(id),
  waiver_rationale TEXT,
  waiver_expires_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id,recommendation_id)
    REFERENCES tprm_recommendations(workspace_id,supplier_id,cycle_id,id),
  FOREIGN KEY (workspace_id,supplier_id,client_decision_id)
    REFERENCES tprm_client_decisions(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,finding_id) REFERENCES findings(workspace_id,id),
  CHECK(
    (source_type='recommendation' AND recommendation_id IS NOT NULL AND client_decision_id IS NULL)
    OR (source_type='client_decision' AND recommendation_id IS NULL AND client_decision_id IS NOT NULL)
  ),
  CHECK(status!='verified' OR (verified_at IS NOT NULL AND verified_by IS NOT NULL AND length(trim(COALESCE(completion_note,'')))>=5)),
  CHECK(status!='waived' OR (length(trim(COALESCE(waiver_rationale,'')))>=10 AND waiver_expires_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS tprm_evidence_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('supplier_document','ddq_evidence')),
  supplier_document_id INTEGER,
  ddq_evidence_id INTEGER,
  client_label TEXT NOT NULL,
  client_description TEXT,
  allow_download INTEGER NOT NULL DEFAULT 0 CHECK(allow_download IN (0,1)),
  expires_at TEXT,
  released_by INTEGER NOT NULL REFERENCES users(id),
  released_at TEXT NOT NULL DEFAULT (datetime('now')),
  release_hash TEXT NOT NULL,
  idempotency_key TEXT,
  UNIQUE(workspace_id,supplier_id,cycle_id,source_type,supplier_document_id,ddq_evidence_id),
  UNIQUE(workspace_id,supplier_id,id),
  UNIQUE(release_hash),
  UNIQUE(idempotency_key),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,supplier_document_id)
    REFERENCES supplier_documents(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,ddq_evidence_id)
    REFERENCES supplier_ddq_evidence(workspace_id,id),
  CHECK(
    (source_type='supplier_document' AND supplier_document_id IS NOT NULL AND ddq_evidence_id IS NULL)
    OR (source_type='ddq_evidence' AND supplier_document_id IS NULL AND ddq_evidence_id IS NOT NULL)
  ),
  CHECK(length(release_hash)=64 AND release_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(expires_at IS NULL OR (expires_at GLOB '????-??-??' AND strftime('%Y-%m-%d',expires_at||' 00:00:00','+0 days')=expires_at)),
  CHECK(idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)))
);

CREATE TABLE IF NOT EXISTS tprm_evidence_release_withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  release_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  withdrawn_by INTEGER NOT NULL REFERENCES users(id),
  withdrawn_at TEXT NOT NULL DEFAULT (datetime('now')),
  idempotency_key TEXT,
  request_fingerprint TEXT NOT NULL,
  UNIQUE(release_id),
  UNIQUE(idempotency_key),
  FOREIGN KEY (workspace_id,supplier_id,release_id)
    REFERENCES tprm_evidence_releases(workspace_id,supplier_id,id),
  CHECK(idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key))),
  CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*')
);

CREATE TABLE IF NOT EXISTS tprm_review_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  module_id INTEGER NOT NULL,
  client_decision_id INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  tier TEXT NOT NULL CHECK(tier IN ('tier_1','tier_2','tier_3','tier_4')),
  cadence_months INTEGER NOT NULL CHECK(cadence_months BETWEEN 1 AND 120),
  scheduled_from TEXT NOT NULL,
  next_review_date TEXT NOT NULL,
  schedule_basis TEXT NOT NULL,
  supersedes_id INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,supplier_id,version),
  UNIQUE(workspace_id,supplier_id,id),
  UNIQUE(client_decision_id),
  UNIQUE(supersedes_id),
  FOREIGN KEY (workspace_id,supplier_id) REFERENCES suppliers(workspace_id,id),
  FOREIGN KEY (workspace_id,module_id) REFERENCES tprm_modules(workspace_id,id),
  FOREIGN KEY (workspace_id,supplier_id,client_decision_id)
    REFERENCES tprm_client_decisions(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,supersedes_id)
    REFERENCES tprm_review_schedules(workspace_id,supplier_id,id)
);

CREATE TABLE IF NOT EXISTS tprm_clarifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  ddq_assessment_id INTEGER NOT NULL,
  question_id TEXT,
  request_text TEXT NOT NULL,
  requested_by INTEGER NOT NULL REFERENCES users(id),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','responded','resolved','withdrawn')),
  provider_response TEXT,
  provider_responder_name TEXT,
  provider_responder_email TEXT,
  responded_at TEXT,
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  resolution_note TEXT,
  UNIQUE(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,ddq_assessment_id)
    REFERENCES supplier_ddq_assessments(workspace_id,supplier_id,id),
  CHECK(status='open' OR status='withdrawn' OR provider_response IS NOT NULL),
  CHECK(status!='resolved' OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND length(trim(COALESCE(resolution_note,'')))>=5))
);

CREATE TABLE IF NOT EXISTS tprm_monitoring_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  module_id INTEGER NOT NULL,
  cycle_id INTEGER,
  source TEXT NOT NULL,
  source_reference TEXT,
  fingerprint TEXT NOT NULL,
  signal_type TEXT NOT NULL CHECK(signal_type IN ('security_incident','breach','financial','regulatory','availability','control_change','contract','concentration','news','other')),
  severity TEXT NOT NULL CHECK(severity IN ('info','low','moderate','high','critical')),
  title TEXT NOT NULL,
  detail TEXT,
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  requires_reassessment INTEGER NOT NULL DEFAULT 0 CHECK(requires_reassessment IN (0,1)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','triaged','dismissed','escalated')),
  triage_note TEXT,
  triaged_by INTEGER REFERENCES users(id),
  triaged_at TEXT,
  UNIQUE(workspace_id,source,fingerprint),
  UNIQUE(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id) REFERENCES suppliers(workspace_id,id),
  FOREIGN KEY (workspace_id,module_id) REFERENCES tprm_modules(workspace_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id)
);

CREATE TABLE IF NOT EXISTS tprm_legal_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL,
  legal_name TEXT NOT NULL,
  trading_name TEXT,
  entity_type TEXT NOT NULL DEFAULT 'unknown'
    CHECK(entity_type IN ('corporation','partnership','government','nonprofit','sole_trader','unknown')),
  registration_number TEXT,
  registration_country_code TEXT,
  lei TEXT,
  parent_entity_name TEXT,
  ultimate_parent_name TEXT,
  status TEXT NOT NULL DEFAULT 'unknown'
    CHECK(status IN ('active','inactive','merged','dissolved','unknown')),
  identity_source TEXT NOT NULL DEFAULT 'user_maintained'
    CHECK(identity_source IN ('legacy_supplier_backfill','user_maintained','verified_document')),
  identity_verified_at TEXT,
  identity_verified_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
  UNIQUE(workspace_id,supplier_id),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,supplier_id,id),
  FOREIGN KEY(workspace_id,supplier_id) REFERENCES suppliers(workspace_id,id),
  CHECK(length(trim(legal_name))>=1),
  CHECK(registration_country_code IS NULL OR (
    length(registration_country_code)=2
    AND registration_country_code=upper(registration_country_code)
    AND registration_country_code NOT GLOB '*[^A-Z]*'
  )),
  CHECK(lei IS NULL OR (length(lei)=20 AND lei=upper(lei) AND lei NOT GLOB '*[^A-Z0-9]*')),
  CHECK((identity_verified_at IS NULL AND identity_verified_by IS NULL)
     OR (identity_verified_at IS NOT NULL AND identity_verified_by IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS tprm_service_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL,
  legal_entity_id INTEGER NOT NULL,
  relationship_key TEXT NOT NULL,
  relationship_name TEXT NOT NULL,
  service_category TEXT,
  service_description TEXT NOT NULL,
  provision_model TEXT NOT NULL DEFAULT 'other'
    CHECK(provision_model IN ('saas','paas','iaas','managed_service','professional_service','data_provider','physical_service','other')),
  status TEXT NOT NULL DEFAULT 'intake'
    CHECK(status IN ('intake','active','suspended','offboarding','terminated','rejected')),
  criticality TEXT NOT NULL DEFAULT 'unknown'
    CHECK(criticality IN ('low','moderate','high','critical','unknown')),
  data_access TEXT NOT NULL DEFAULT 'unknown'
    CHECK(data_access IN ('none','internal','confidential','restricted','mixed','unknown')),
  privileged_access INTEGER NOT NULL DEFAULT 0 CHECK(privileged_access IN (0,1)),
  annual_spend_minor INTEGER CHECK(annual_spend_minor IS NULL OR annual_spend_minor>=0),
  currency TEXT,
  relationship_owner TEXT,
  business_owner TEXT,
  security_owner TEXT,
  procurement_owner TEXT,
  start_date TEXT,
  target_end_date TEXT,
  rto_hours INTEGER CHECK(rto_hours IS NULL OR rto_hours>=0),
  rpo_hours INTEGER CHECK(rpo_hours IS NULL OR rpo_hours>=0),
  max_tolerable_disruption_hours INTEGER
    CHECK(max_tolerable_disruption_hours IS NULL OR max_tolerable_disruption_hours>=0),
  substitutability TEXT NOT NULL DEFAULT 'unknown'
    CHECK(substitutability IN ('readily_substitutable','substitutable_with_effort','difficult','not_substitutable','unknown')),
  alternate_provider_relationship_id INTEGER,
  estimated_exit_days INTEGER CHECK(estimated_exit_days IS NULL OR estimated_exit_days>=0),
  exit_plan_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK(exit_plan_status IN ('not_started','documented','tested','needs_update','not_applicable')),
  last_exit_tested_at TEXT,
  exit_owner TEXT,
  exit_strategy TEXT,
  transition_assistance TEXT,
  data_return_deletion_requirements TEXT,
  sole_source INTEGER NOT NULL DEFAULT 0 CHECK(sole_source IN (0,1)),
  material_outsourcing INTEGER NOT NULL DEFAULT 0 CHECK(material_outsourcing IN (0,1)),
  regulated_service INTEGER NOT NULL DEFAULT 0 CHECK(regulated_service IN (0,1)),
  legacy_annual_spend_text TEXT,
  legacy_location_text TEXT,
  legacy_hosting_locations_text TEXT,
  legacy_data_categories_text TEXT,
  legacy_critical_processes_text TEXT,
  source TEXT NOT NULL DEFAULT 'user_maintained'
    CHECK(source IN ('legacy_supplier_backfill','user_maintained','import')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  idempotency_key TEXT,
  request_fingerprint TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
  offboarding_started_at TEXT,
  terminated_at TEXT,
  UNIQUE(workspace_id,relationship_key),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,supplier_id,id),
  UNIQUE(workspace_id,idempotency_key),
  FOREIGN KEY(workspace_id,supplier_id,legal_entity_id)
    REFERENCES tprm_legal_entities(workspace_id,supplier_id,id),
  FOREIGN KEY(workspace_id,alternate_provider_relationship_id)
    REFERENCES tprm_service_relationships(workspace_id,id),
  CHECK(length(trim(relationship_key)) BETWEEN 3 AND 100),
  CHECK(length(trim(relationship_name))>=1),
  CHECK(length(trim(service_description))>=1),
  CHECK(currency IS NULL OR (
    length(currency)=3 AND currency=upper(currency) AND currency NOT GLOB '*[^A-Z]*'
  )),
  CHECK(annual_spend_minor IS NULL OR currency IS NOT NULL),
  CHECK(alternate_provider_relationship_id IS NULL OR alternate_provider_relationship_id<>id),
  CHECK(start_date IS NULL OR length(start_date)=10),
  CHECK(target_end_date IS NULL OR length(target_end_date)=10),
  CHECK(request_fingerprint IS NULL OR (
    length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  )),
  CHECK(idempotency_key IS NULL OR (
    length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)
  )),
  CHECK((status='offboarding')=(offboarding_started_at IS NOT NULL) OR status='terminated'),
  CHECK((status='terminated')=(terminated_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS tprm_relationship_contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  relationship_id INTEGER NOT NULL,
  contract_family_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  supersedes_id INTEGER,
  contract_type TEXT NOT NULL
    CHECK(contract_type IN ('msa','order_form','dpa','sla','licence','statement_of_work','other')),
  status TEXT NOT NULL
    CHECK(status IN ('draft','under_review','executed','expired','terminated')),
  title TEXT NOT NULL,
  reference TEXT,
  effective_date TEXT,
  end_date TEXT,
  renewal_date TEXT,
  notice_deadline TEXT,
  auto_renew INTEGER NOT NULL DEFAULT 0 CHECK(auto_renew IN (0,1)),
  committed_spend_minor INTEGER CHECK(committed_spend_minor IS NULL OR committed_spend_minor>=0),
  currency TEXT,
  termination_rights TEXT,
  transition_assistance TEXT,
  data_return_deletion_terms TEXT,
  audit_rights TEXT,
  incident_notification_hours INTEGER
    CHECK(incident_notification_hours IS NULL OR incident_notification_hours>=0),
  subprocessor_controls TEXT,
  governing_law_country_code TEXT,
  document_sha256 TEXT,
  contract_hash TEXT NOT NULL,
  previous_contract_hash TEXT,
  idempotency_key TEXT,
  request_fingerprint TEXT NOT NULL,
  recorded_by INTEGER NOT NULL REFERENCES users(id),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,relationship_id,contract_family_key,version),
  UNIQUE(workspace_id,relationship_id,id),
  UNIQUE(supersedes_id),
  UNIQUE(workspace_id,idempotency_key),
  UNIQUE(contract_hash),
  FOREIGN KEY(workspace_id,relationship_id)
    REFERENCES tprm_service_relationships(workspace_id,id),
  FOREIGN KEY(workspace_id,relationship_id,supersedes_id)
    REFERENCES tprm_relationship_contracts(workspace_id,relationship_id,id),
  CHECK(length(trim(contract_family_key)) BETWEEN 3 AND 100),
  CHECK(length(trim(title))>=2),
  CHECK(status NOT IN ('executed','expired','terminated') OR (
    length(trim(COALESCE(reference,'')))>=2 AND effective_date IS NOT NULL
  )),
  CHECK(currency IS NULL OR (
    length(currency)=3 AND currency=upper(currency) AND currency NOT GLOB '*[^A-Z]*'
  )),
  CHECK(committed_spend_minor IS NULL OR currency IS NOT NULL),
  CHECK(governing_law_country_code IS NULL OR (
    length(governing_law_country_code)=2
    AND governing_law_country_code=upper(governing_law_country_code)
    AND governing_law_country_code NOT GLOB '*[^A-Z]*'
  )),
  CHECK(document_sha256 IS NULL OR (
    length(document_sha256)=64 AND document_sha256 NOT GLOB '*[^0-9a-f]*'
  )),
  CHECK(length(contract_hash)=64 AND contract_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(previous_contract_hash IS NULL OR (
    length(previous_contract_hash)=64 AND previous_contract_hash NOT GLOB '*[^0-9a-f]*'
  )),
  CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  CHECK(idempotency_key IS NULL OR (
    length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)
  ))
);

CREATE TABLE IF NOT EXISTS tprm_business_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  service_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  owner_name TEXT,
  criticality TEXT NOT NULL DEFAULT 'moderate'
    CHECK(criticality IN ('low','moderate','high','critical')),
  impact_tolerance_hours INTEGER CHECK(impact_tolerance_hours IS NULL OR impact_tolerance_hours>=0),
  rto_hours INTEGER CHECK(rto_hours IS NULL OR rto_hours>=0),
  rpo_hours INTEGER CHECK(rpo_hours IS NULL OR rpo_hours>=0),
  regulatory_designations_json TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(regulatory_designations_json) AND json_type(regulatory_designations_json)='array'),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
  UNIQUE(workspace_id,service_key),
  UNIQUE(workspace_id,id),
  CHECK(length(trim(service_key)) BETWEEN 3 AND 100),
  CHECK(length(trim(name))>=2)
);

CREATE TABLE IF NOT EXISTS tprm_relationship_business_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  relationship_id INTEGER NOT NULL,
  business_service_id INTEGER NOT NULL,
  dependency_type TEXT NOT NULL
    CHECK(dependency_type IN ('essential','significant','supporting')),
  criticality TEXT NOT NULL
    CHECK(criticality IN ('low','moderate','high','critical')),
  minimum_capacity_percent INTEGER
    CHECK(minimum_capacity_percent IS NULL OR minimum_capacity_percent BETWEEN 0 AND 100),
  maximum_outage_hours INTEGER CHECK(maximum_outage_hours IS NULL OR maximum_outage_hours>=0),
  manual_workaround TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended')),
  effective_from TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,relationship_id)
    REFERENCES tprm_service_relationships(workspace_id,id),
  FOREIGN KEY(workspace_id,business_service_id)
    REFERENCES tprm_business_services(workspace_id,id),
  CHECK((status='ended')=(ended_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS tprm_dependency_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_key TEXT NOT NULL,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL
    CHECK(entity_type IN ('subprocessor','fourth_party','infrastructure_provider','other')),
  legal_country_code TEXT,
  registration_number TEXT,
  parent_entity_name TEXT,
  known_supplier_id INTEGER,
  source TEXT NOT NULL DEFAULT 'user_disclosed'
    CHECK(source IN ('user_disclosed','provider_disclosed','contractual','import')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,entity_key),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,known_supplier_id) REFERENCES suppliers(workspace_id,id),
  CHECK(length(trim(entity_key)) BETWEEN 3 AND 100),
  CHECK(length(trim(name))>=2),
  CHECK(legal_country_code IS NULL OR (
    length(legal_country_code)=2 AND legal_country_code=upper(legal_country_code)
      AND legal_country_code NOT GLOB '*[^A-Z]*'
  ))
);

CREATE TABLE IF NOT EXISTS tprm_dependency_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  source_relationship_id INTEGER NOT NULL,
  edge_key TEXT NOT NULL,
  target_relationship_id INTEGER,
  dependency_entity_id INTEGER,
  dependency_type TEXT NOT NULL
    CHECK(dependency_type IN ('subprocessor','fourth_party','cloud','infrastructure','payment','identity','data','other')),
  service_description TEXT NOT NULL,
  data_access TEXT NOT NULL DEFAULT 'unknown'
    CHECK(data_access IN ('none','internal','confidential','restricted','mixed','unknown')),
  countries_json TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(countries_json) AND json_type(countries_json)='array'),
  criticality TEXT NOT NULL DEFAULT 'moderate'
    CHECK(criticality IN ('low','moderate','high','critical')),
  concentration_key TEXT,
  single_point_of_failure INTEGER NOT NULL DEFAULT 0 CHECK(single_point_of_failure IN (0,1)),
  substitutability TEXT NOT NULL DEFAULT 'unknown'
    CHECK(substitutability IN ('readily_substitutable','substitutable_with_effort','difficult','not_substitutable','unknown')),
  due_diligence_required INTEGER NOT NULL DEFAULT 1 CHECK(due_diligence_required IN (0,1)),
  evidence_summary TEXT,
  status TEXT NOT NULL DEFAULT 'disclosed'
    CHECK(status IN ('disclosed','under_review','approved','rejected','ended')),
  effective_from TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  idempotency_key TEXT,
  request_fingerprint TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
  UNIQUE(workspace_id,source_relationship_id,edge_key),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,idempotency_key),
  FOREIGN KEY(workspace_id,source_relationship_id)
    REFERENCES tprm_service_relationships(workspace_id,id),
  FOREIGN KEY(workspace_id,target_relationship_id)
    REFERENCES tprm_service_relationships(workspace_id,id),
  FOREIGN KEY(workspace_id,dependency_entity_id)
    REFERENCES tprm_dependency_entities(workspace_id,id),
  CHECK((target_relationship_id IS NOT NULL)+(dependency_entity_id IS NOT NULL)=1),
  CHECK(target_relationship_id IS NULL OR target_relationship_id<>source_relationship_id),
  CHECK(length(trim(edge_key)) BETWEEN 3 AND 100),
  CHECK(length(trim(service_description))>=2),
  CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  CHECK(idempotency_key IS NULL OR (
    length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)
  )),
  CHECK((status='ended')=(ended_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS tprm_relationship_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  relationship_id INTEGER NOT NULL,
  location_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  supersedes_id INTEGER,
  exposure_type TEXT NOT NULL
    CHECK(exposure_type IN ('legal_entity','service_delivery','data_processing','data_storage','backup','support','administration')),
  country_code TEXT NOT NULL,
  region TEXT,
  site_reference TEXT,
  data_categories_json TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(data_categories_json) AND json_type(data_categories_json)='array'),
  transfer_mechanism TEXT NOT NULL DEFAULT 'unknown'
    CHECK(transfer_mechanism IN ('adequacy','scc','bcr','derogation','local_only','not_applicable','unknown')),
  criticality TEXT NOT NULL DEFAULT 'moderate'
    CHECK(criticality IN ('low','moderate','high','critical')),
  status TEXT NOT NULL DEFAULT 'current' CHECK(status IN ('planned','current','exited')),
  effective_from TEXT,
  effective_to TEXT,
  assertion_source TEXT NOT NULL DEFAULT 'user_maintained'
    CHECK(assertion_source IN ('user_maintained','contract','provider_disclosure','evidence','import')),
  assertion_hash TEXT NOT NULL,
  previous_assertion_hash TEXT,
  recorded_by INTEGER NOT NULL REFERENCES users(id),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,relationship_id,location_key,version),
  UNIQUE(workspace_id,relationship_id,id),
  UNIQUE(supersedes_id),
  UNIQUE(assertion_hash),
  FOREIGN KEY(workspace_id,relationship_id)
    REFERENCES tprm_service_relationships(workspace_id,id),
  FOREIGN KEY(workspace_id,relationship_id,supersedes_id)
    REFERENCES tprm_relationship_locations(workspace_id,relationship_id,id),
  CHECK(length(trim(location_key)) BETWEEN 3 AND 100),
  CHECK(length(country_code)=2 AND country_code=upper(country_code) AND country_code NOT GLOB '*[^A-Z]*'),
  CHECK(status!='exited' OR effective_to IS NOT NULL),
  CHECK(length(assertion_hash)=64 AND assertion_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(previous_assertion_hash IS NULL OR (
    length(previous_assertion_hash)=64 AND previous_assertion_hash NOT GLOB '*[^0-9a-f]*'
  ))
);

CREATE TABLE IF NOT EXISTS tprm_cycle_relationship_scopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  relationship_id INTEGER NOT NULL,
  scope_role TEXT NOT NULL DEFAULT 'in_scope'
    CHECK(scope_role IN ('primary','in_scope','supporting')),
  scope_rationale TEXT,
  linked_by INTEGER REFERENCES users(id),
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,cycle_id,relationship_id),
  UNIQUE(workspace_id,supplier_id,id),
  FOREIGN KEY(workspace_id,supplier_id,cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
  FOREIGN KEY(workspace_id,supplier_id,relationship_id)
    REFERENCES tprm_service_relationships(workspace_id,supplier_id,id)
);

CREATE TABLE IF NOT EXISTS tprm_relationship_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  relationship_id INTEGER,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'legacy_relationship_backfilled','relationship_created','relationship_updated','relationship_status_changed',
    'contract_version_added','dependency_edge_added','dependency_status_changed',
    'business_dependency_added','business_dependency_ended','location_version_added','cycle_scope_linked'
  )),
  actor_user_id INTEGER REFERENCES users(id),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('consultant','consultancy_manager','client','system','migration')),
  actor_name TEXT NOT NULL,
  reason TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
  idempotency_key TEXT,
  previous_event_hash TEXT,
  event_hash TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,idempotency_key),
  UNIQUE(event_hash),
  FOREIGN KEY(workspace_id,relationship_id)
    REFERENCES tprm_service_relationships(workspace_id,id),
  CHECK(idempotency_key IS NULL OR (
    length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)
  )),
  CHECK(event_hash IS NULL OR (length(event_hash)=64 AND event_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK(previous_event_hash IS NULL OR (
    length(previous_event_hash)=64 AND previous_event_hash NOT GLOB '*[^0-9a-f]*'
  ))
);

CREATE TABLE IF NOT EXISTS tprm_monitoring_connectors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  module_id INTEGER NOT NULL,
  provider_type TEXT NOT NULL CHECK(provider_type IN (
    'securityscorecard','bitsight','riskrecon','generic_webhook','csv_import'
  )),
  capability_mode TEXT NOT NULL CHECK(capability_mode IN ('webhook','csv','poll')),
  name TEXT NOT NULL,
  ingress_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','disabled')),
  secret_reference TEXT,
  adapter_config_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(adapter_config_json)),
  failure_mode TEXT NOT NULL DEFAULT 'fail_closed' CHECK(failure_mode='fail_closed'),
  external_provisioning_confirmed INTEGER NOT NULL DEFAULT 0
    CHECK(external_provisioning_confirmed IN (0,1)),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,name),
  FOREIGN KEY(workspace_id,module_id) REFERENCES tprm_modules(workspace_id,id),
  CHECK(length(trim(name)) BETWEEN 3 AND 120),
  CHECK(name=trim(name)),
  CHECK(length(ingress_key)=32 AND ingress_key NOT GLOB '*[^0-9a-f]*'),
  CHECK(
    (provider_type='csv_import' AND capability_mode='csv' AND secret_reference IS NULL)
    OR (provider_type='generic_webhook' AND capability_mode='webhook' AND secret_reference IS NOT NULL)
    OR (provider_type IN ('securityscorecard','bitsight','riskrecon')
        AND capability_mode IN ('webhook','poll') AND secret_reference IS NOT NULL)
  ),
  CHECK(secret_reference IS NULL OR (
    length(secret_reference) BETWEEN 8 AND 512
    AND secret_reference=trim(secret_reference)
    AND (
      secret_reference LIKE 'vault://%'
      OR secret_reference LIKE 'aws-secretsmanager://%'
      OR secret_reference LIKE 'azure-keyvault://%'
      OR secret_reference LIKE 'gcp-secretmanager://%'
      OR secret_reference LIKE 'env://%'
      OR secret_reference LIKE 'keychain://%'
    )
  )),
  CHECK(status!='active' OR provider_type IN ('generic_webhook','csv_import')
        OR external_provisioning_confirmed=1)
);

CREATE TABLE IF NOT EXISTS tprm_monitoring_connector_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'connector_created','connector_activated','connector_paused','connector_resumed',
    'connector_disabled','secret_reference_rotated','configuration_updated',
    'mapping_created','mapping_retired','rule_created','rule_disabled'
  )),
  actor_user_id INTEGER REFERENCES users(id),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('consultancy','system')),
  actor_name TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json)),
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,connector_id,id),
  FOREIGN KEY(workspace_id,connector_id)
    REFERENCES tprm_monitoring_connectors(workspace_id,id),
  CHECK(length(event_hash)=64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(previous_event_hash IS NULL OR (
    length(previous_event_hash)=64 AND previous_event_hash NOT GLOB '*[^0-9a-f]*'
  ))
);

CREATE TABLE IF NOT EXISTS tprm_connector_supplier_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  provider_entity_id TEXT NOT NULL,
  supplier_id INTEGER NOT NULL,
  mapping_note TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  valid_to TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  retired_by INTEGER REFERENCES users(id),
  UNIQUE(workspace_id,connector_id,id),
  UNIQUE(workspace_id,connector_id,id,supplier_id),
  FOREIGN KEY(workspace_id,connector_id)
    REFERENCES tprm_monitoring_connectors(workspace_id,id),
  FOREIGN KEY(workspace_id,supplier_id) REFERENCES suppliers(workspace_id,id),
  CHECK(length(trim(provider_entity_id)) BETWEEN 1 AND 240),
  CHECK(provider_entity_id=trim(provider_entity_id)),
  CHECK((active=1 AND valid_to IS NULL AND retired_by IS NULL)
     OR (active=0 AND valid_to IS NOT NULL AND retired_by IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS tprm_monitoring_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  rule_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  metric_path TEXT NOT NULL,
  operator TEXT NOT NULL CHECK(operator IN ('gt','gte','lt','lte','eq','neq','contains','exists')),
  threshold_json TEXT NOT NULL CHECK(json_valid(threshold_json)),
  signal_type TEXT NOT NULL CHECK(signal_type IN (
    'security_incident','breach','financial','regulatory','availability',
    'control_change','contract','concentration','news','other'
  )),
  severity TEXT NOT NULL CHECK(severity IN ('info','low','moderate','high','critical')),
  requires_reassessment INTEGER NOT NULL DEFAULT 0 CHECK(requires_reassessment IN (0,1)),
  missing_behavior TEXT NOT NULL DEFAULT 'quarantine' CHECK(missing_behavior IN ('quarantine','ignore')),
  title TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  supersedes_id INTEGER,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  disabled_by INTEGER REFERENCES users(id),
  disabled_at TEXT,
  UNIQUE(workspace_id,connector_id,rule_key,version),
  UNIQUE(workspace_id,connector_id,id),
  FOREIGN KEY(workspace_id,connector_id)
    REFERENCES tprm_monitoring_connectors(workspace_id,id),
  FOREIGN KEY(workspace_id,connector_id,supersedes_id)
    REFERENCES tprm_monitoring_rules(workspace_id,connector_id,id),
  CHECK(length(trim(rule_key)) BETWEEN 2 AND 100),
  CHECK(length(trim(metric_path)) BETWEEN 1 AND 240),
  CHECK(length(trim(title)) BETWEEN 3 AND 240),
  CHECK((enabled=1 AND disabled_by IS NULL AND disabled_at IS NULL)
     OR (enabled=0 AND disabled_by IS NOT NULL AND disabled_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS tprm_monitoring_received_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  mapping_id INTEGER,
  supplier_id INTEGER,
  provider_event_id TEXT NOT NULL,
  provider_entity_id TEXT,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  normalized_hash TEXT NOT NULL,
  normalized_summary_json TEXT NOT NULL CHECK(json_valid(normalized_summary_json)),
  signature_timestamp INTEGER,
  signature_digest TEXT,
  observed_at TEXT,
  received_at TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE,
  UNIQUE(workspace_id,connector_id,id),
  UNIQUE(workspace_id,supplier_id,id),
  UNIQUE(workspace_id,connector_id,provider_event_id),
  UNIQUE(workspace_id,connector_id,idempotency_key),
  FOREIGN KEY(workspace_id,connector_id)
    REFERENCES tprm_monitoring_connectors(workspace_id,id),
  FOREIGN KEY(workspace_id,connector_id,mapping_id,supplier_id)
    REFERENCES tprm_connector_supplier_mappings(workspace_id,connector_id,id,supplier_id),
  FOREIGN KEY(workspace_id,supplier_id) REFERENCES suppliers(workspace_id,id),
  CHECK(length(provider_event_id) BETWEEN 1 AND 240),
  CHECK(length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)),
  CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(normalized_hash)=64 AND normalized_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(event_hash)=64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(previous_event_hash IS NULL OR (
    length(previous_event_hash)=64 AND previous_event_hash NOT GLOB '*[^0-9a-f]*'
  )),
  CHECK((signature_timestamp IS NULL AND signature_digest IS NULL)
     OR (signature_timestamp IS NOT NULL AND length(signature_digest)=64
         AND signature_digest NOT GLOB '*[^0-9a-f]*')),
  CHECK((mapping_id IS NULL AND supplier_id IS NULL) OR (mapping_id IS NOT NULL AND supplier_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS tprm_monitoring_rule_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  received_event_id INTEGER NOT NULL,
  rule_id INTEGER NOT NULL,
  matched INTEGER NOT NULL CHECK(matched IN (0,1)),
  observed_value_json TEXT CHECK(observed_value_json IS NULL OR json_valid(observed_value_json)),
  observed_value_hash TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('matched','not_matched','missing_ignored','quarantined')),
  evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(received_event_id,rule_id),
  FOREIGN KEY(workspace_id,connector_id,received_event_id)
    REFERENCES tprm_monitoring_received_events(workspace_id,connector_id,id),
  FOREIGN KEY(workspace_id,connector_id,rule_id)
    REFERENCES tprm_monitoring_rules(workspace_id,connector_id,id),
  CHECK(observed_value_hash IS NULL OR (
    length(observed_value_hash)=64 AND observed_value_hash NOT GLOB '*[^0-9a-f]*'
  ))
);

CREATE TABLE IF NOT EXISTS tprm_monitoring_processing_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  received_event_id INTEGER NOT NULL,
  attempt_number INTEGER NOT NULL CHECK(attempt_number>0),
  status TEXT NOT NULL CHECK(status IN ('processed','duplicate','quarantined','failed')),
  supplier_id INTEGER,
  signal_id INTEGER,
  error_code TEXT,
  error_redacted TEXT,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0,1)),
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  UNIQUE(received_event_id,attempt_number),
  FOREIGN KEY(workspace_id,connector_id,received_event_id)
    REFERENCES tprm_monitoring_received_events(workspace_id,connector_id,id),
  FOREIGN KEY(workspace_id,supplier_id) REFERENCES suppliers(workspace_id,id),
  FOREIGN KEY(workspace_id,supplier_id,signal_id)
    REFERENCES tprm_monitoring_signals(workspace_id,supplier_id,id),
  CHECK((status='processed' AND supplier_id IS NOT NULL AND signal_id IS NOT NULL AND error_code IS NULL)
     OR (status IN ('duplicate','quarantined','failed') AND signal_id IS NULL)),
  CHECK(error_redacted IS NULL OR length(error_redacted)<=1000)
);

CREATE TABLE IF NOT EXISTS tprm_monitoring_connector_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  run_type TEXT NOT NULL CHECK(run_type IN ('webhook','csv','poll','healthcheck','retry','manual')),
  status TEXT NOT NULL CHECK(status IN ('succeeded','partial','failed','rate_limited','quarantined','rejected')),
  received_count INTEGER NOT NULL DEFAULT 0 CHECK(received_count>=0),
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK(processed_count>=0),
  duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK(duplicate_count>=0),
  quarantined_count INTEGER NOT NULL DEFAULT 0 CHECK(quarantined_count>=0),
  error_code TEXT,
  error_redacted TEXT,
  retry_after TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  UNIQUE(workspace_id,connector_id,id),
  FOREIGN KEY(workspace_id,connector_id)
    REFERENCES tprm_monitoring_connectors(workspace_id,id),
  CHECK(processed_count+duplicate_count+quarantined_count<=received_count),
  CHECK(error_redacted IS NULL OR length(error_redacted)<=1000)
);

CREATE TABLE IF NOT EXISTS tprm_monitoring_connector_state (
  workspace_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count>=0),
  circuit_state TEXT NOT NULL DEFAULT 'closed' CHECK(circuit_state IN ('closed','open','half_open')),
  next_allowed_at TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_run_id INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
  PRIMARY KEY(workspace_id,connector_id),
  FOREIGN KEY(workspace_id,connector_id)
    REFERENCES tprm_monitoring_connectors(workspace_id,id),
  FOREIGN KEY(workspace_id,connector_id,last_run_id)
    REFERENCES tprm_monitoring_connector_runs(workspace_id,connector_id,id)
);

CREATE TABLE IF NOT EXISTS tprm_reassessment_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  module_id INTEGER NOT NULL,
  signal_id INTEGER NOT NULL,
  received_event_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  priority TEXT NOT NULL CHECK(priority IN ('low','moderate','high','critical')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','completed','manual_review')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 20),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  completed_at TEXT,
  resulting_cycle_id INTEGER,
  last_error_code TEXT,
  last_error_redacted TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
  UNIQUE(workspace_id,signal_id),
  UNIQUE(workspace_id,supplier_id,id),
  FOREIGN KEY(workspace_id,module_id) REFERENCES tprm_modules(workspace_id,id),
  FOREIGN KEY(workspace_id,supplier_id,module_id,signal_id)
    REFERENCES tprm_monitoring_signals(workspace_id,supplier_id,module_id,id),
  FOREIGN KEY(workspace_id,supplier_id,resulting_cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
  FOREIGN KEY(workspace_id,supplier_id,received_event_id)
    REFERENCES tprm_monitoring_received_events(workspace_id,supplier_id,id),
  CHECK(length(trim(reason))>=5),
  CHECK((status='pending' AND claimed_at IS NULL AND completed_at IS NULL AND resulting_cycle_id IS NULL)
     OR (status='processing' AND claimed_at IS NOT NULL AND completed_at IS NULL AND resulting_cycle_id IS NULL)
     OR (status='completed' AND claimed_at IS NOT NULL AND completed_at IS NOT NULL AND resulting_cycle_id IS NOT NULL)
     OR (status='manual_review' AND claimed_at IS NULL AND completed_at IS NULL
         AND last_error_code IS NOT NULL)),
  CHECK(last_error_redacted IS NULL OR length(last_error_redacted)<=1000)
);

CREATE TABLE IF NOT EXISTS tprm_recommendation_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN (
    'draft','in_review','changes_requested','issued','withdrawn'
  )),
  author_id INTEGER NOT NULL REFERENCES users(id),
  reviewer_id INTEGER REFERENCES users(id),
  current_revision_number INTEGER NOT NULL DEFAULT 0 CHECK(current_revision_number>=0),
  submitted_revision_number INTEGER,
  submitted_at TEXT,
  changes_requested_note TEXT,
  issued_recommendation_id INTEGER,
  issued_at TEXT,
  withdrawn_at TEXT,
  withdrawal_reason TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,supplier_id,cycle_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id)
    REFERENCES tprm_assessment_cycles(workspace_id,supplier_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id,issued_recommendation_id)
    REFERENCES tprm_recommendations(workspace_id,supplier_id,cycle_id,id),
  CHECK(status!='in_review' OR (submitted_at IS NOT NULL AND submitted_revision_number IS NOT NULL)),
  CHECK((status='issued')=(issued_recommendation_id IS NOT NULL AND issued_at IS NOT NULL)),
  CHECK((status='withdrawn')=(withdrawn_at IS NOT NULL AND length(trim(COALESCE(withdrawal_reason,'')))>=10)),
  CHECK(reviewer_id IS NULL OR reviewer_id<>author_id)
);

CREATE TABLE IF NOT EXISTS tprm_recommendation_draft_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  draft_id INTEGER NOT NULL,
  revision_number INTEGER NOT NULL CHECK(revision_number>0),
  outcome TEXT NOT NULL CHECK(outcome IN (
    'recommend_onboard','recommend_with_conditions','do_not_recommend','insufficient_information'
  )),
  executive_summary TEXT NOT NULL,
  rationale TEXT NOT NULL,
  residual_risk_score INTEGER CHECK(residual_risk_score BETWEEN 0 AND 100),
  residual_risk_band TEXT CHECK(residual_risk_band IN ('low','moderate','high','critical','unknown')),
  valid_until TEXT,
  conditions_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(conditions_json) AND json_type(conditions_json)='array'),
  revision_hash TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(draft_id,revision_number),
  UNIQUE(workspace_id,supplier_id,cycle_id,draft_id,revision_number),
  UNIQUE(revision_hash),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id,draft_id)
    REFERENCES tprm_recommendation_drafts(workspace_id,supplier_id,cycle_id,id),
  CHECK(length(trim(executive_summary))>=20),
  CHECK(length(trim(rationale))>=20),
  CHECK(length(revision_hash)=64 AND revision_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(valid_until IS NULL OR (valid_until GLOB '????-??-??' AND strftime('%Y-%m-%d',valid_until||' 00:00:00','+0 days')=valid_until))
);

CREATE TABLE IF NOT EXISTS tprm_recommendation_draft_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  draft_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('created','revision_saved','submitted','changes_requested','issued','withdrawn')),
  from_status TEXT,
  to_status TEXT,
  revision_number INTEGER,
  note TEXT,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  request_fingerprint TEXT,
  idempotency_key TEXT,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_hash),
  UNIQUE(idempotency_key),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id,draft_id)
    REFERENCES tprm_recommendation_drafts(workspace_id,supplier_id,cycle_id,id),
  CHECK(request_fingerprint IS NULL OR (length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*')),
  CHECK(previous_event_hash IS NULL OR (length(previous_event_hash)=64 AND previous_event_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK(length(event_hash)=64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)))
);

CREATE TABLE IF NOT EXISTS tprm_condition_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  condition_id INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'work_started','evidence_submitted','changes_requested','verified','waived'
  )),
  from_status TEXT NOT NULL CHECK(from_status IN (
    'open','in_progress','evidence_submitted','verified','waived','cancelled'
  )),
  to_status TEXT NOT NULL CHECK(to_status IN (
    'open','in_progress','evidence_submitted','verified','waived','cancelled'
  )),
  completion_statement TEXT,
  review_note TEXT,
  waiver_expires_at TEXT,
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('client_owner','consultant','consultancy_manager')),
  actor_name TEXT NOT NULL,
  expected_row_version INTEGER NOT NULL CHECK(expected_row_version>0),
  resulting_row_version INTEGER NOT NULL CHECK(resulting_row_version=expected_row_version+1),
  idempotency_key TEXT,
  request_fingerprint TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,supplier_id,cycle_id,condition_id,id),
  UNIQUE(idempotency_key),
  UNIQUE(event_hash),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id,condition_id)
    REFERENCES tprm_conditions(workspace_id,supplier_id,cycle_id,id),
  CHECK(length(trim(actor_name))>=2),
  CHECK(completion_statement IS NULL OR length(trim(completion_statement))>=10),
  CHECK(review_note IS NULL OR length(trim(review_note))>=10),
  CHECK(waiver_expires_at IS NULL OR (
    waiver_expires_at GLOB '????-??-??'
    AND strftime('%Y-%m-%d',waiver_expires_at||' 00:00:00','+0 days')=waiver_expires_at
  )),
  CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  CHECK(previous_event_hash IS NULL OR (
    length(previous_event_hash)=64 AND previous_event_hash NOT GLOB '*[^0-9a-f]*'
  )),
  CHECK(length(event_hash)=64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(idempotency_key IS NULL OR (
    length(idempotency_key) BETWEEN 32 AND 128 AND idempotency_key=trim(idempotency_key)
  )),
  CHECK(
    (event_type='work_started' AND from_status='open' AND to_status='in_progress'
      AND completion_statement IS NULL AND review_note IS NULL AND waiver_expires_at IS NULL)
    OR (event_type='evidence_submitted' AND from_status='in_progress' AND to_status='evidence_submitted'
      AND completion_statement IS NOT NULL AND review_note IS NULL AND waiver_expires_at IS NULL)
    OR (event_type='changes_requested' AND from_status='evidence_submitted' AND to_status='in_progress'
      AND completion_statement IS NULL AND review_note IS NOT NULL AND waiver_expires_at IS NULL)
    OR (event_type='verified' AND from_status='evidence_submitted' AND to_status='verified'
      AND completion_statement IS NULL AND review_note IS NOT NULL AND waiver_expires_at IS NULL)
    OR (event_type='waived' AND from_status IN ('open','in_progress','evidence_submitted') AND to_status='waived'
      AND completion_statement IS NULL AND review_note IS NOT NULL AND waiver_expires_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS tprm_condition_evidence_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  condition_id INTEGER NOT NULL,
  condition_event_id INTEGER NOT NULL,
  original_filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  mime_type TEXT,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes>=0 AND size_bytes<=52428800),
  inspection_result TEXT NOT NULL CHECK(inspection_result IN ('inspected_upload_facade')),
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  evidence_hash TEXT NOT NULL,
  UNIQUE(condition_event_id),
  UNIQUE(evidence_hash),
  UNIQUE(workspace_id,supplier_id,cycle_id,condition_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id,condition_id)
    REFERENCES tprm_conditions(workspace_id,supplier_id,cycle_id,id),
  FOREIGN KEY (workspace_id,supplier_id,cycle_id,condition_id,condition_event_id)
    REFERENCES tprm_condition_events(workspace_id,supplier_id,cycle_id,condition_id,id),
  CHECK(length(trim(original_filename)) BETWEEN 1 AND 500),
  CHECK(length(trim(stored_path)) BETWEEN 1 AND 500),
  CHECK(instr(stored_path,'/')=0 AND instr(stored_path,char(92))=0),
  CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(evidence_hash)=64 AND evidence_hash NOT GLOB '*[^0-9a-f]*')
);

CREATE TABLE IF NOT EXISTS tprm_module_closure_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  module_id INTEGER NOT NULL,
  retention_until TEXT NOT NULL,
  legal_hold INTEGER NOT NULL DEFAULT 0 CHECK(legal_hold IN (0,1)),
  retention_policy TEXT NOT NULL,
  closure_reason TEXT NOT NULL,
  closed_by INTEGER NOT NULL REFERENCES users(id),
  closed_at TEXT NOT NULL,
  closure_hash TEXT NOT NULL,
  UNIQUE(module_id),
  UNIQUE(closure_hash),
  UNIQUE(workspace_id,module_id,id),
  FOREIGN KEY (workspace_id,module_id) REFERENCES tprm_modules(workspace_id,id),
  CHECK(retention_until GLOB '????-??-??'
    AND strftime('%Y-%m-%d',retention_until||' 00:00:00','+0 days')=retention_until),
  CHECK(length(trim(retention_policy))>=10),
  CHECK(length(trim(closure_reason))>=10),
  CHECK(length(closure_hash)=64 AND closure_hash NOT GLOB '*[^0-9a-f]*')
);

CREATE TABLE IF NOT EXISTS tprm_webhook_ingress_buckets (
  workspace_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  source_key_hash TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK(request_count>=0),
  rejected_count INTEGER NOT NULL DEFAULT 0 CHECK(rejected_count>=0),
  last_rejection_code TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,connector_id,source_key_hash),
  FOREIGN KEY(workspace_id,connector_id)
    REFERENCES tprm_monitoring_connectors(workspace_id,id),
  CHECK(length(source_key_hash)=64 AND source_key_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(last_rejection_code IS NULL OR (
    length(last_rejection_code) BETWEEN 3 AND 100
    AND last_rejection_code NOT GLOB '*[^A-Z0-9_]*'
  ))
);

CREATE TABLE IF NOT EXISTS tprm_review_schedule_closures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  schedule_id INTEGER NOT NULL,
  superseded_by_decision_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  closed_by INTEGER NOT NULL REFERENCES users(id),
  closed_at TEXT NOT NULL,
  closure_hash TEXT NOT NULL,
  UNIQUE(schedule_id),
  UNIQUE(superseded_by_decision_id),
  UNIQUE(closure_hash),
  FOREIGN KEY(workspace_id,supplier_id,schedule_id)
    REFERENCES tprm_review_schedules(workspace_id,supplier_id,id),
  FOREIGN KEY(workspace_id,supplier_id,superseded_by_decision_id)
    REFERENCES tprm_client_decisions(workspace_id,supplier_id,id),
  CHECK(length(trim(reason))>=10),
  CHECK(length(closure_hash)=64 AND closure_hash NOT GLOB '*[^0-9a-f]*')
);

CREATE TABLE IF NOT EXISTS framework_catalog_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  framework_id INTEGER NOT NULL REFERENCES frameworks(id),
  framework_code TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  catalog_hash TEXT NOT NULL,
  requirement_count INTEGER NOT NULL CHECK(requirement_count >= 0),
  source_reference TEXT NOT NULL,
  catalog_manifest_json TEXT NOT NULL CHECK(json_valid(catalog_manifest_json)),
  is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0,1)),
  locked_at TEXT NOT NULL DEFAULT (datetime('now')),
  superseded_at TEXT,
  UNIQUE(framework_id, catalog_version, catalog_hash),
  CHECK(length(catalog_hash)=64 AND catalog_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(is_current=1 OR superseded_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS evidence_ai_indexes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  evidence_id INTEGER NOT NULL,

  source_sha256 TEXT NOT NULL,
  source_size_bytes INTEGER NOT NULL CHECK(source_size_bytes >= 0),
  extracted_text_sha256 TEXT,
  extractor_version TEXT NOT NULL,
  chunker_version TEXT NOT NULL,

  embedding_provider TEXT NOT NULL,
  embedding_model_requested TEXT NOT NULL,
  embedding_model_canonical TEXT,
  embedding_dimensions INTEGER NOT NULL CHECK(embedding_dimensions = 2048),
  vector_format TEXT NOT NULL CHECK(vector_format = 'float32le-v1'),
  pipeline_key TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','processing','ready','failed','stale','unsupported')),
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK(chunk_count >= 0),
  extracted_character_count INTEGER NOT NULL DEFAULT 0
    CHECK(extracted_character_count >= 0),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0,1)),

  external_processing_acknowledged INTEGER NOT NULL DEFAULT 1
    CHECK(external_processing_acknowledged = 1),
  disclosure_version TEXT NOT NULL,
  authorization_scope TEXT NOT NULL
    CHECK(authorization_scope IN ('single_upload','bulk_upload','manual_index','workspace_auto_index')),
  authorized_by INTEGER NOT NULL,
  authorized_at TEXT NOT NULL,

  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count IN (0,1)),
  claimed_at TEXT,
  lease_expires_at TEXT,
  ready_at TEXT,
  failed_at TEXT,
  stale_at TEXT,
  last_error_code TEXT,
  last_error_redacted TEXT,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(workspace_id,evidence_id,id),
  FOREIGN KEY(workspace_id,evidence_id)
    REFERENCES evidence(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(authorized_by) REFERENCES users(id) ON DELETE NO ACTION,

  CHECK(length(source_sha256) = 64
    AND source_sha256 = lower(source_sha256)
    AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK(extracted_text_sha256 IS NULL OR (
    length(extracted_text_sha256) = 64
    AND extracted_text_sha256 = lower(extracted_text_sha256)
    AND extracted_text_sha256 NOT GLOB '*[^0-9a-f]*'
  )),
  CHECK(length(pipeline_key) = 64
    AND pipeline_key = lower(pipeline_key)
    AND pipeline_key NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(trim(extractor_version)) BETWEEN 1 AND 120),
  CHECK(length(trim(chunker_version)) BETWEEN 1 AND 120),
  CHECK(length(trim(embedding_provider)) BETWEEN 1 AND 120),
  CHECK(length(trim(embedding_model_requested)) BETWEEN 1 AND 300),
  CHECK(embedding_model_canonical IS NULL
    OR length(trim(embedding_model_canonical)) BETWEEN 1 AND 300),
  CHECK(length(trim(disclosure_version)) BETWEEN 1 AND 160),
  CHECK(length(trim(authorized_at)) >= 10),
  CHECK(last_error_code IS NULL OR length(last_error_code) <= 160),
  CHECK(last_error_redacted IS NULL OR length(last_error_redacted) <= 1000),

  CHECK(
    (status = 'queued'
      AND attempt_count = 0
      AND claimed_at IS NULL
      AND lease_expires_at IS NULL
      AND ready_at IS NULL
      AND failed_at IS NULL
      AND stale_at IS NULL)
    OR
    (status = 'processing'
      AND attempt_count = 1
      AND claimed_at IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND ready_at IS NULL
      AND failed_at IS NULL
      AND stale_at IS NULL)
    OR
    (status = 'ready'
      AND attempt_count = 1
      AND claimed_at IS NOT NULL
      AND lease_expires_at IS NULL
      AND ready_at IS NOT NULL
      AND failed_at IS NULL
      AND stale_at IS NULL
      AND extracted_text_sha256 IS NOT NULL
      AND embedding_model_canonical IS NOT NULL
      AND extracted_character_count > 0
      AND chunk_count > 0
      AND last_error_code IS NULL
      AND last_error_redacted IS NULL)
    OR
    (status IN ('failed','unsupported')
      AND attempt_count = 1
      AND claimed_at IS NOT NULL
      AND lease_expires_at IS NULL
      AND ready_at IS NULL
      AND failed_at IS NOT NULL
      AND stale_at IS NULL
      AND last_error_code IS NOT NULL)
    OR
    (status = 'stale'
      AND lease_expires_at IS NULL
      AND stale_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS evidence_ai_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  evidence_id INTEGER NOT NULL,
  index_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  chunk_sha256 TEXT NOT NULL,
  embedding BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(index_id,ordinal),
  FOREIGN KEY(workspace_id,evidence_id,index_id)
    REFERENCES evidence_ai_indexes(workspace_id,evidence_id,id)
    ON DELETE CASCADE,

  CHECK(length(chunk_sha256) = 64
    AND chunk_sha256 = lower(chunk_sha256)
    AND chunk_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK(typeof(embedding) = 'blob' AND length(embedding) = 8192)
);

CREATE TABLE IF NOT EXISTS form_drafts (
      id TEXT PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      record_id TEXT NOT NULL,
      context_key TEXT NOT NULL DEFAULT '',
      generation INTEGER NOT NULL DEFAULT 1,
      draft_version INTEGER NOT NULL DEFAULT 1,
      base_version TEXT NOT NULL,
      payload TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','consumed','discarded')),
      last_save_id TEXT,
      saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(workspace_id,actor_id,kind,record_id,context_key)
    );

CREATE TABLE IF NOT EXISTS form_mutations (
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      record_id TEXT NOT NULL,
      mutation_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(workspace_id,actor_id,kind,record_id,mutation_key)
    );

CREATE TABLE IF NOT EXISTS notification_receipts (
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at DATETIME,
  dismissed_at DATETIME,
  PRIMARY KEY(notification_id,user_id)
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_at DATETIME,
  last_error TEXT,
  sent_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_key,recipient_id)
);

CREATE TABLE IF NOT EXISTS assessment_review_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  framework_code TEXT NOT NULL CHECK(framework_code IN ('iso27001')),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  prepared_by INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK(action IN ('request','approve','send_back','clear')),
  request_event_id INTEGER REFERENCES assessment_review_events(id),
  source_record_version INTEGER NOT NULL,
  result_record_version INTEGER NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  note TEXT,
  source_snapshot TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS experience_rollouts (
  firm_id INTEGER PRIMARY KEY REFERENCES firms(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  wave INTEGER NOT NULL DEFAULT 1 CHECK(wave BETWEEN 1 AND 6),
  cohort TEXT NOT NULL DEFAULT 'pilot',
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS experience_workspace_overrides (
  workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS "audit_samples" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id INTEGER NOT NULL,
  iso_item_id TEXT,
  description TEXT NOT NULL,
  sample_taken_at DATE,
  population_size INTEGER,
  sample_size INTEGER,
  finding TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (audit_id) REFERENCES audits(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS risk_assessment_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      scope TEXT NOT NULL DEFAULT 'all' CHECK(scope IN ('all','ai')),
      label TEXT NOT NULL,
      performed_on DATE NOT NULL,
      methodology_name TEXT,
      notes TEXT,
      risk_count INTEGER NOT NULL,
      above_appetite INTEGER NOT NULL,
      payload TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      recorded_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE IF NOT EXISTS context_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('internal','external')),
      issue TEXT NOT NULL,
      effect TEXT,
      response TEXT,
      owner TEXT,
      next_review DATE,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE IF NOT EXISTS template_values (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, key)
);

CREATE INDEX IF NOT EXISTS idx_sup_ctrl_sup ON supplier_controls(supplier_id);

CREATE INDEX IF NOT EXISTS idx_sup_ctrl_iso ON supplier_controls(iso_item_id);

CREATE INDEX IF NOT EXISTS idx_risks_workspace ON risks(workspace_id);

CREATE INDEX IF NOT EXISTS idx_assets_workspace ON assets(workspace_id);

CREATE INDEX IF NOT EXISTS idx_evidence_workspace ON evidence(workspace_id);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);

CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(workspace_id, parent_type, parent_id);

CREATE INDEX IF NOT EXISTS idx_audit_workspace ON audit_log(workspace_id);

CREATE INDEX IF NOT EXISTS idx_workspace_members ON workspace_members(workspace_id, user_id);

CREATE INDEX IF NOT EXISTS idx_docs_workspace ON generated_docs(workspace_id);

CREATE INDEX IF NOT EXISTS idx_audits_workspace ON audits(workspace_id);

CREATE INDEX IF NOT EXISTS idx_findings_audit ON audit_findings(audit_id);

CREATE INDEX IF NOT EXISTS idx_mrms_workspace ON mrms(workspace_id);

CREATE INDEX IF NOT EXISTS idx_nc_workspace ON nonconformities(workspace_id);

CREATE INDEX IF NOT EXISTS idx_incidents_workspace ON incidents(workspace_id);

CREATE INDEX IF NOT EXISTS idx_suppliers_workspace ON suppliers(workspace_id);

CREATE INDEX IF NOT EXISTS idx_training_workspace ON training_records(workspace_id);

CREATE INDEX IF NOT EXISTS idx_supdocs_supplier ON supplier_documents(supplier_id);

CREATE INDEX IF NOT EXISTS idx_subproc_supplier ON supplier_subprocessors(supplier_id);

CREATE INDEX IF NOT EXISTS idx_supreviews_supplier ON supplier_reviews(supplier_id);

CREATE INDEX IF NOT EXISTS idx_supnotes_supplier ON supplier_notes(supplier_id);

CREATE INDEX IF NOT EXISTS idx_supclauses_supplier ON supplier_clauses(supplier_id);

CREATE INDEX IF NOT EXISTS idx_supq_supplier ON supplier_questionnaires(supplier_id);

CREATE INDEX IF NOT EXISTS idx_supq_responses ON supplier_questionnaire_responses(questionnaire_id);

CREATE INDEX IF NOT EXISTS idx_entities_workspace ON entities(workspace_id);

CREATE INDEX IF NOT EXISTS idx_role_overrides ON workspace_role_overrides(workspace_id, user_id);

CREATE INDEX IF NOT EXISTS idx_doc_versions_doc ON doc_versions(document_id);

CREATE INDEX IF NOT EXISTS idx_doc_approvers ON doc_approvers(document_id, version_id, sequence);

CREATE INDEX IF NOT EXISTS idx_doc_sig_doc ON doc_signatures(document_id, version_id);

CREATE INDEX IF NOT EXISTS idx_methodology_ws ON risk_methodologies(workspace_id);

CREATE INDEX IF NOT EXISTS idx_audit_user_action ON audit_log(user_id, action);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_treatments_risk ON risk_treatments(risk_id);

CREATE INDEX IF NOT EXISTS idx_kri_readings ON kri_readings(kri_id, measured_at);

CREATE INDEX IF NOT EXISTS idx_soa_ws ON soa_snapshots(workspace_id);

CREATE INDEX IF NOT EXISTS idx_ack_campaign ON doc_ack_recipients(campaign_id);

CREATE INDEX IF NOT EXISTS idx_inc_events ON incident_events(incident_id);

CREATE INDEX IF NOT EXISTS idx_supmon ON supplier_monitoring(supplier_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_time_user ON time_entries(workspace_id, user_id, date);

CREATE INDEX IF NOT EXISTS idx_asset_rels ON asset_relationships(parent_asset_id, child_asset_id);

CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);

CREATE INDEX IF NOT EXISTS idx_chain_log ON audit_chain(audit_log_id);

CREATE INDEX IF NOT EXISTS idx_api_tokens ON api_tokens(workspace_id, user_id);

CREATE INDEX IF NOT EXISTS idx_cfv ON custom_field_values(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_ccm_results ON ccm_results(rule_id, ran_at);

CREATE INDEX IF NOT EXISTS idx_external_approvers_token ON external_approvers(token_hash);

CREATE INDEX IF NOT EXISTS idx_external_approvers_version ON external_approvers(version_id, sequence);

CREATE INDEX IF NOT EXISTS idx_email_outbox_firm ON email_outbox(firm_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_outbox_workspace ON email_outbox(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auditor_shares_ws ON auditor_shares(workspace_id);

CREATE INDEX IF NOT EXISTS idx_auditor_shares_token ON auditor_shares(token);

CREATE INDEX IF NOT EXISTS idx_competence_roles_ws ON competence_roles(workspace_id);

CREATE INDEX IF NOT EXISTS idx_competence_records_ws ON competence_records(workspace_id, role_id);

CREATE INDEX IF NOT EXISTS idx_communication_plan_ws ON communication_plan(workspace_id, next_due_date);

CREATE INDEX IF NOT EXISTS idx_csh_ws_item ON control_state_history(workspace_id, iso_item_id, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_ip_ws ON interested_parties(workspace_id);

CREATE INDEX IF NOT EXISTS idx_so_ws ON security_objectives(workspace_id);

CREATE INDEX IF NOT EXISTS idx_scc_ws ON soa_custom_controls(workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_passes_ws_num ON assessment_passes(workspace_id, pass_number);

CREATE INDEX IF NOT EXISTS idx_passes_ws_status ON assessment_passes(workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_rta_risk ON risk_treatment_actions(risk_id);

CREATE INDEX IF NOT EXISTS idx_rta_workspace ON risk_treatment_actions(workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_ccev_workspace ON cert_cycle_events(workspace_id, planned_date);

CREATE INDEX IF NOT EXISTS idx_qattach_q ON questionnaire_attachments(questionnaire_id);

CREATE INDEX IF NOT EXISTS idx_qattach_question ON questionnaire_attachments(question_id);

CREATE INDEX IF NOT EXISTS idx_imp_ws ON improvements(workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_member_scopes_lookup ON member_scopes(workspace_id, user_id, scope_type);

CREATE INDEX IF NOT EXISTS idx_user_invitations_firm ON user_invitations(firm_id);

CREATE INDEX IF NOT EXISTS idx_user_invitations_email ON user_invitations(email);

CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_bcp_proc_ws ON bcp_processes(workspace_id);

CREATE INDEX IF NOT EXISTS idx_bcp_plan_ws ON bcp_plans(workspace_id);

CREATE INDEX IF NOT EXISTS idx_bcp_test_ws ON bcp_tests(workspace_id);

CREATE INDEX IF NOT EXISTS idx_bcp_test_plan ON bcp_tests(plan_id);

CREATE INDEX IF NOT EXISTS idx_changes_ws ON changes(workspace_id);

CREATE INDEX IF NOT EXISTS idx_change_approvals ON change_approvals(change_id);

CREATE INDEX IF NOT EXISTS idx_isms_metrics_ws ON isms_metrics(workspace_id);

CREATE INDEX IF NOT EXISTS idx_isms_metric_readings ON isms_metric_readings(metric_id, measured_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_flags_global
  ON feature_flags(key) WHERE workspace_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_flags_ws
  ON feature_flags(key, workspace_id) WHERE workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_requirements_fw ON requirements(framework_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_evreq_ev ON evidence_requirement_links(evidence_id);

CREATE INDEX IF NOT EXISTS idx_evreq_req ON evidence_requirement_links(requirement_id);

CREATE INDEX IF NOT EXISTS idx_ci_ws ON control_instances(workspace_id);

CREATE INDEX IF NOT EXISTS idx_ci_req ON control_instances(requirement_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ci_wholeorg
  ON control_instances(workspace_id, requirement_id) WHERE entity_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_pc_inst ON proposed_changes(instance_id);

CREATE INDEX IF NOT EXISTS idx_pc_ws_open ON proposed_changes(workspace_id, decision);

CREATE INDEX IF NOT EXISTS idx_docreq_doc ON document_requirement_links(document_id);

CREATE INDEX IF NOT EXISTS idx_docreq_req ON document_requirement_links(requirement_id);

CREATE INDEX IF NOT EXISTS idx_assessments_ws ON assessments(workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_av_assessment ON assessment_versions(assessment_id);

CREATE INDEX IF NOT EXISTS idx_extok_assessment ON external_assessment_tokens(assessment_id);

CREATE INDEX IF NOT EXISTS idx_extok_ws ON external_assessment_tokens(workspace_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_findings_ws ON findings(workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_recs_finding ON recommendations(finding_id);

CREATE INDEX IF NOT EXISTS idx_remact_ws ON remediation_actions(workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_remact_finding ON remediation_actions(finding_id);

CREATE INDEX IF NOT EXISTS idx_exceptions_ws ON control_exceptions(workspace_id, expiry);

CREATE INDEX IF NOT EXISTS idx_client_requests_workspace_status
  ON client_requests(workspace_id, status, due_date);

CREATE INDEX IF NOT EXISTS idx_client_requests_assignee
  ON client_requests(workspace_id, assignee_id, status);

CREATE INDEX IF NOT EXISTS idx_client_requests_control
  ON client_requests(workspace_id, control_id);

CREATE INDEX IF NOT EXISTS idx_client_requests_document
  ON client_requests(workspace_id, document_id);

CREATE INDEX IF NOT EXISTS idx_client_request_evidence_evidence
  ON client_request_evidence(evidence_id);

CREATE INDEX IF NOT EXISTS idx_client_request_events_request
  ON client_request_events(request_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_extok_questionnaire ON external_assessment_tokens(questionnaire_id, revoked_at, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_method_active
  ON supplier_risk_methodologies(workspace_id) WHERE is_active=1;

CREATE INDEX IF NOT EXISTS idx_supplier_risk_history
  ON supplier_risk_snapshots(supplier_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_supplier_decisions
  ON supplier_decisions(supplier_id, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_supplier_findings
  ON supplier_finding_links(supplier_id, due_date);

CREATE INDEX IF NOT EXISTS idx_assurance_runs_workspace
  ON assurance_report_runs(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_assurance_runs_status
  ON assurance_report_runs(workspace_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_assurance_sources_run
  ON assurance_report_sources(run_id, section_key);

CREATE INDEX IF NOT EXISTS idx_assurance_events_run
  ON assurance_report_events(run_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_assurance_artifacts_run
  ON assurance_report_artifacts(run_id, format);

CREATE INDEX IF NOT EXISTS idx_delivery_phases_plan ON engagement_delivery_phases(plan_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_delivery_milestones_phase ON engagement_delivery_milestones(phase_id, status, planned_end_date);

CREATE INDEX IF NOT EXISTS idx_delivery_milestones_plan ON engagement_delivery_milestones(plan_id, status);

CREATE INDEX IF NOT EXISTS idx_delivery_deliverables_milestone ON engagement_delivery_deliverables(milestone_id, status);

CREATE INDEX IF NOT EXISTS idx_delivery_deliverables_workspace ON engagement_delivery_deliverables(workspace_id, due_date, status);

CREATE INDEX IF NOT EXISTS idx_delivery_dependencies_successor ON engagement_delivery_dependencies(successor_milestone_id);

CREATE INDEX IF NOT EXISTS idx_delivery_gate_decisions_phase ON engagement_delivery_gate_decisions(phase_id, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_baselines_plan ON engagement_delivery_baselines(plan_id, version_number DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_events_plan ON engagement_delivery_events(plan_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_delivery_milestone ON tasks(workspace_id, engagement_milestone_id, status);

CREATE INDEX IF NOT EXISTS idx_delivery_evidence_deliverable ON engagement_delivery_evidence(deliverable_id, linked_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_evidence_workspace ON engagement_delivery_evidence(workspace_id, evidence_id);

CREATE INDEX IF NOT EXISTS idx_delivery_schedule_runs_plan ON engagement_delivery_schedule_runs(plan_id, run_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_deliverables_approver ON engagement_delivery_deliverables(workspace_id, approver_id, status);

CREATE INDEX IF NOT EXISTS idx_delivery_deliverables_owner ON engagement_delivery_deliverables(workspace_id, owner_id, status);

CREATE INDEX IF NOT EXISTS idx_delivery_deliverables_framework
  ON engagement_delivery_deliverables(workspace_id, framework_code, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_workspace_source
  ON assets(workspace_id, source_type, source_ref)
  WHERE source_type IS NOT NULL AND source_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gap_interviews_workspace
  ON gap_fieldwork_interviews(workspace_id,assessment_pass_id,status,scheduled_at);

CREATE INDEX IF NOT EXISTS idx_gap_blockers_workspace
  ON gap_fieldwork_blockers(workspace_id,assessment_pass_id,status,due_date);

CREATE INDEX IF NOT EXISTS idx_gap_defaults_workspace
  ON gap_declared_defaults(workspace_id,assessment_pass_id,status,requirement_id);

CREATE INDEX IF NOT EXISTS idx_gap_snapshots_workspace
  ON gap_fieldwork_snapshots(workspace_id,assessment_pass_id,week_ending DESC);

CREATE INDEX IF NOT EXISTS idx_supplier_inherent_current ON supplier_inherent_assessments(supplier_id,status,created_at DESC);

CREATE INDEX IF NOT EXISTS idx_supplier_ddq_current ON supplier_ddq_assessments(supplier_id,status,created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_ddq_token ON supplier_ddq_assessments(token_hash) WHERE token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_supplier_ddq_response_status ON supplier_ddq_responses(assessment_id,status);

CREATE INDEX IF NOT EXISTS idx_supplier_ddq_evidence_question ON supplier_ddq_evidence(assessment_id,question_id,uploaded_at);

CREATE INDEX IF NOT EXISTS idx_supplier_contract_review_current ON supplier_contract_reviews(supplier_id,status,created_at DESC);

CREATE INDEX IF NOT EXISTS idx_supplier_contract_inherent
  ON supplier_contract_reviews(inherent_assessment_id,status);

CREATE INDEX IF NOT EXISTS idx_security_objectives_metric
  ON security_objectives(workspace_id,metric_id);

CREATE INDEX IF NOT EXISTS idx_supplier_methodology_status
  ON supplier_risk_methodologies(workspace_id,status,version DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auditor_shares_token_hash
  ON auditor_shares(token_hash)
  WHERE token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_supplier_decisions_supersedes
  ON supplier_decisions(supersedes_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_decisions_supersession_lineage
  ON supplier_decisions(supersedes_id)
  WHERE supersedes_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_decisions_idempotency
  ON supplier_decisions(idempotency_nonce)
  WHERE idempotency_nonce IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_decisions_one_active
  ON supplier_decisions(workspace_id,supplier_id)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_supplier_decisions_expected_current
  ON supplier_decisions(expected_current_decision_id);

CREATE INDEX IF NOT EXISTS idx_generated_docs_workspace_status
  ON generated_docs(workspace_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_workspaces_engagement_outcome
  ON workspaces(firm_id, engagement_outcome);

CREATE UNIQUE INDEX IF NOT EXISTS uq_nonconformities_workspace_id
  ON nonconformities(workspace_id,id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_workspace_id
  ON evidence(workspace_id,id);

CREATE INDEX IF NOT EXISTS idx_nc_evidence_finding_role
  ON nonconformity_evidence_links(workspace_id,nonconformity_id,evidence_role,linked_at);

CREATE INDEX IF NOT EXISTS idx_nc_evidence_evidence
  ON nonconformity_evidence_links(workspace_id,evidence_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_workspace_id
  ON suppliers(workspace_id,id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_inherent_workspace_supplier_id
  ON supplier_inherent_assessments(workspace_id,supplier_id,id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_ddq_workspace_supplier_id
  ON supplier_ddq_assessments(workspace_id,supplier_id,id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_contract_workspace_supplier_id
  ON supplier_contract_reviews(workspace_id,supplier_id,id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_findings_workspace_id
  ON findings(workspace_id,id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_documents_workspace_supplier_id
  ON supplier_documents(workspace_id,supplier_id,id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_ddq_evidence_workspace_id
  ON supplier_ddq_evidence(workspace_id,id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_module_open_workspace
  ON tprm_modules(workspace_id) WHERE status IN ('active','needs_classification');

CREATE INDEX IF NOT EXISTS idx_tprm_modules_workspace_history
  ON tprm_modules(workspace_id,effective_from DESC,id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_cycle_active_supplier
  ON tprm_assessment_cycles(workspace_id,supplier_id) WHERE status='active';

CREATE INDEX IF NOT EXISTS idx_tprm_cycles_module_status
  ON tprm_assessment_cycles(module_id,status,due_at);

CREATE INDEX IF NOT EXISTS idx_tprm_events_supplier_time
  ON tprm_lifecycle_events(workspace_id,supplier_id,occurred_at,id);

CREATE INDEX IF NOT EXISTS idx_tprm_events_cycle_time
  ON tprm_lifecycle_events(cycle_id,occurred_at,id);

CREATE INDEX IF NOT EXISTS idx_tprm_recommendations_cycle_version
  ON tprm_recommendations(cycle_id,version DESC);

CREATE INDEX IF NOT EXISTS idx_tprm_client_decisions_supplier_version
  ON tprm_client_decisions(workspace_id,supplier_id,version DESC);

CREATE INDEX IF NOT EXISTS idx_tprm_client_decisions_cycle
  ON tprm_client_decisions(cycle_id,decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_tprm_conditions_supplier_status
  ON tprm_conditions(workspace_id,supplier_id,status,due_date);

CREATE INDEX IF NOT EXISTS idx_tprm_conditions_cycle
  ON tprm_conditions(cycle_id,status,severity);

CREATE INDEX IF NOT EXISTS idx_tprm_evidence_releases_cycle
  ON tprm_evidence_releases(cycle_id,released_at,id);

CREATE INDEX IF NOT EXISTS idx_tprm_review_schedule_due
  ON tprm_review_schedules(workspace_id,next_review_date);

CREATE INDEX IF NOT EXISTS idx_tprm_clarifications_cycle_status
  ON tprm_clarifications(cycle_id,status,due_date);

CREATE INDEX IF NOT EXISTS idx_tprm_monitoring_signal_queue
  ON tprm_monitoring_signals(workspace_id,status,severity,observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_tprm_legal_entities_name
  ON tprm_legal_entities(workspace_id,legal_name);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_relationship_primary_supplier
  ON tprm_service_relationships(workspace_id,supplier_id) WHERE is_primary=1;

CREATE INDEX IF NOT EXISTS idx_tprm_relationship_portfolio
  ON tprm_service_relationships(workspace_id,status,criticality,service_category);

CREATE INDEX IF NOT EXISTS idx_tprm_relationship_legal_entity
  ON tprm_service_relationships(workspace_id,legal_entity_id,status);

CREATE INDEX IF NOT EXISTS idx_tprm_contract_current
  ON tprm_relationship_contracts(workspace_id,relationship_id,contract_family_key,version DESC);

CREATE INDEX IF NOT EXISTS idx_tprm_contract_renewal
  ON tprm_relationship_contracts(workspace_id,renewal_date,notice_deadline);

CREATE INDEX IF NOT EXISTS idx_tprm_business_service_criticality
  ON tprm_business_services(workspace_id,status,criticality);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_business_dependency_active
  ON tprm_relationship_business_dependencies(workspace_id,relationship_id,business_service_id,dependency_type)
  WHERE status='active';

CREATE INDEX IF NOT EXISTS idx_tprm_business_dependency_service
  ON tprm_relationship_business_dependencies(workspace_id,business_service_id,status,criticality);

CREATE INDEX IF NOT EXISTS idx_tprm_dependency_entity_name
  ON tprm_dependency_entities(workspace_id,name);

CREATE INDEX IF NOT EXISTS idx_tprm_dependency_edge_target
  ON tprm_dependency_edges(workspace_id,target_relationship_id,status,criticality);

CREATE INDEX IF NOT EXISTS idx_tprm_dependency_edge_entity
  ON tprm_dependency_edges(workspace_id,dependency_entity_id,status,criticality);

CREATE INDEX IF NOT EXISTS idx_tprm_dependency_edge_concentration
  ON tprm_dependency_edges(workspace_id,concentration_key,status);

CREATE INDEX IF NOT EXISTS idx_tprm_location_country
  ON tprm_relationship_locations(workspace_id,country_code,exposure_type,status);

CREATE INDEX IF NOT EXISTS idx_tprm_cycle_relationship_scope
  ON tprm_cycle_relationship_scopes(workspace_id,relationship_id,cycle_id);

CREATE INDEX IF NOT EXISTS idx_tprm_relationship_event_history
  ON tprm_relationship_events(workspace_id,relationship_id,occurred_at,id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_module_workspace_id
  ON tprm_modules(workspace_id,id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_signal_workspace_supplier_id
  ON tprm_monitoring_signals(workspace_id,supplier_id,id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_signal_workspace_supplier_module_id
  ON tprm_monitoring_signals(workspace_id,supplier_id,module_id,id);

CREATE INDEX IF NOT EXISTS idx_tprm_connectors_workspace_status
  ON tprm_monitoring_connectors(workspace_id,status,provider_type);

CREATE INDEX IF NOT EXISTS idx_tprm_connector_audit_chain
  ON tprm_monitoring_connector_audit(workspace_id,connector_id,id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_connector_mapping_active
  ON tprm_connector_supplier_mappings(workspace_id,connector_id,provider_entity_id)
  WHERE active=1;

CREATE INDEX IF NOT EXISTS idx_tprm_connector_mapping_supplier
  ON tprm_connector_supplier_mappings(workspace_id,supplier_id,active);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_monitoring_rule_enabled
  ON tprm_monitoring_rules(workspace_id,connector_id,rule_key) WHERE enabled=1;

CREATE INDEX IF NOT EXISTS idx_tprm_monitoring_rules_connector
  ON tprm_monitoring_rules(workspace_id,connector_id,enabled);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_received_signature_replay
  ON tprm_monitoring_received_events(workspace_id,connector_id,signature_digest)
  WHERE signature_digest IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tprm_received_event_supplier
  ON tprm_monitoring_received_events(workspace_id,supplier_id,received_at DESC);

CREATE INDEX IF NOT EXISTS idx_tprm_processing_failures
  ON tprm_monitoring_processing_attempts(workspace_id,status,completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_tprm_connector_runs_health
  ON tprm_monitoring_connector_runs(workspace_id,connector_id,completed_at DESC,id DESC);

CREATE INDEX IF NOT EXISTS idx_tprm_reassessment_queue_work
  ON tprm_reassessment_queue(status,next_attempt_at,priority,created_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_recommendation_draft_open_cycle
  ON tprm_recommendation_drafts(workspace_id,supplier_id,cycle_id)
  WHERE status NOT IN ('issued','withdrawn');

CREATE INDEX IF NOT EXISTS idx_tprm_recommendation_drafts_review
  ON tprm_recommendation_drafts(workspace_id,status,reviewer_id,updated_at);

CREATE INDEX IF NOT EXISTS idx_tprm_recommendation_revisions_draft
  ON tprm_recommendation_draft_revisions(draft_id,revision_number DESC);

CREATE INDEX IF NOT EXISTS idx_tprm_recommendation_draft_events
  ON tprm_recommendation_draft_events(draft_id,occurred_at,id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tprm_conditions_workspace_supplier_cycle_id
  ON tprm_conditions(workspace_id,supplier_id,cycle_id,id);

CREATE INDEX IF NOT EXISTS idx_tprm_condition_events_condition
  ON tprm_condition_events(workspace_id,condition_id,occurred_at,id);

CREATE INDEX IF NOT EXISTS idx_tprm_condition_evidence_condition
  ON tprm_condition_evidence_links(workspace_id,condition_id,uploaded_at,id);

CREATE INDEX IF NOT EXISTS idx_tprm_module_closure_retention
  ON tprm_module_closure_records(workspace_id,retention_until,legal_hold);

CREATE INDEX IF NOT EXISTS idx_tprm_webhook_ingress_bucket_retention
  ON tprm_webhook_ingress_buckets(updated_at);

CREATE INDEX IF NOT EXISTS idx_tprm_review_schedule_closures_supplier
  ON tprm_review_schedule_closures(workspace_id,supplier_id,closed_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_requirements_framework_id
  ON requirements(framework_id,id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_control_instances_workspace_requirement_id
  ON control_instances(workspace_id,requirement_id,id);

CREATE INDEX IF NOT EXISTS idx_framework_catalog_releases_current
  ON framework_catalog_releases(framework_code, is_current);

CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_ai_indexes_active_identity
  ON evidence_ai_indexes(workspace_id,evidence_id,source_sha256,pipeline_key)
  WHERE status IN ('queued','processing','ready');

CREATE INDEX IF NOT EXISTS idx_evidence_ai_indexes_work
  ON evidence_ai_indexes(status,lease_expires_at,created_at);

CREATE INDEX IF NOT EXISTS idx_evidence_ai_indexes_workspace_ready
  ON evidence_ai_indexes(workspace_id,status,pipeline_key,evidence_id);

CREATE INDEX IF NOT EXISTS idx_evidence_ai_indexes_evidence
  ON evidence_ai_indexes(workspace_id,evidence_id,status,created_at);

CREATE INDEX IF NOT EXISTS idx_evidence_ai_chunks_workspace_index
  ON evidence_ai_chunks(workspace_id,index_id,ordinal);

CREATE INDEX IF NOT EXISTS idx_client_requests_released ON client_requests(workspace_id,released_at,assignee_id,status);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_ready ON notification_outbox(status,available_at);

CREATE INDEX IF NOT EXISTS idx_assessment_review_source ON assessment_review_events(workspace_id,requirement_id,id);

CREATE INDEX IF NOT EXISTS idx_audsamp_audit ON audit_samples(audit_id);

CREATE INDEX IF NOT EXISTS idx_risk_assessment_records_ws ON risk_assessment_records(workspace_id, performed_on);

CREATE INDEX IF NOT EXISTS idx_context_issues_ws ON context_issues(workspace_id);

CREATE INDEX IF NOT EXISTS idx_risks_ws_system ON risks(workspace_id, management_system);

CREATE INDEX IF NOT EXISTS idx_risk_methodologies_active ON risk_methodologies(workspace_id, management_system, is_active);

CREATE VIEW IF NOT EXISTS v_iso_items AS
SELECT r.ref AS id,
       r.req_type AS type,
       json_extract(r.guidance,'$.category') AS category,
       r.title AS title,
       r.summary AS summary,
       json_extract(r.guidance,'$.questions') AS questions,
       json_extract(r.guidance,'$.evidence_needed') AS evidence_needed,
       json_extract(r.guidance,'$.documentation_needed') AS documentation_needed,
       r.sort_order AS sort_order,
       json_extract(r.guidance,'$.purpose') AS purpose,
       json_extract(r.guidance,'$.what_good_looks_like') AS what_good_looks_like,
       json_extract(r.guidance,'$.common_pitfalls') AS common_pitfalls,
       json_extract(r.guidance,'$.evidence_to_look_for') AS evidence_to_look_for,
       json_extract(r.guidance,'$.scoping_notes') AS scoping_notes,
       json_extract(r.guidance,'$.maturity_ladder') AS maturity_ladder,
       json_extract(r.guidance,'$.related_items') AS related_items,
       json_extract(r.guidance,'$.minimum_certifiable') AS minimum_certifiable
FROM requirements r
JOIN frameworks f ON f.id = r.framework_id
WHERE f.code = 'iso27001' AND f.version = '2022';

CREATE VIEW IF NOT EXISTS v_control_states AS
SELECT
  ci.id                       AS id,
  ci.workspace_id             AS workspace_id,
  rq.ref                      AS iso_item_id,
  CASE ci.status
    WHEN 'implemented'           THEN 'Implemented'
    WHEN 'partially_implemented' THEN 'Partially Implemented'
    WHEN 'work_in_progress'      THEN 'Work In Progress'
    WHEN 'not_implemented'       THEN 'Not Implemented'
    WHEN 'not_applicable'        THEN 'Not Applicable'
    WHEN 'not_assessed'          THEN 'Not Assessed'
    ELSE '!!UNMAPPED:' || ci.status
  END                         AS status,
  CASE ci.applicability
    WHEN 'applicable' THEN 'included'
    WHEN 'excluded'   THEN 'excluded'
    WHEN 'undecided'  THEN 'undecided'
    ELSE '!!UNMAPPED:' || ci.applicability
  END                         AS applicability,
  ci.inclusion_justification  AS inclusion_justification,
  ci.exclusion_justification  AS exclusion_justification,
  ci.maturity                 AS maturity,
  ci.notes                    AS notes,
  ci.internal_notes           AS internal_notes,
  ci.owner_id                 AS owner_id,
  ci.due_date                 AS due_date,
  ci.last_updated             AS last_updated,
  ci.last_verified_at         AS last_verified_at,
  ci.scope_pct                AS scope_pct,
  ci.review_status            AS review_status,
  ci.assessment_answers AS assessment_answers,
  ci.review_requested_by      AS review_requested_by,
  ci.review_requested_at      AS review_requested_at,
  ci.review_reason            AS review_reason,
  ci.reviewed_by              AS reviewed_by,
  ci.reviewed_at AS reviewed_at, ci.record_version AS record_version
FROM control_instances ci
JOIN requirements rq ON rq.id = ci.requirement_id
JOIN frameworks f ON f.id = rq.framework_id AND f.code = 'iso27001'
WHERE ci.entity_id IS NULL;

CREATE TRIGGER IF NOT EXISTS trg_method_versions_no_update BEFORE UPDATE ON firm_methodology_versions
BEGIN SELECT RAISE(ABORT,'methodology versions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_method_versions_no_delete BEFORE DELETE ON firm_methodology_versions
BEGIN SELECT RAISE(ABORT,'methodology versions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_gap_snapshot_no_update BEFORE UPDATE ON gap_fieldwork_snapshots
BEGIN SELECT RAISE(ABORT,'fieldwork snapshots are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_gap_snapshot_no_delete BEFORE DELETE ON gap_fieldwork_snapshots
BEGIN SELECT RAISE(ABORT,'fieldwork snapshots are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_gap_phase_events_no_update BEFORE UPDATE ON gap_assessment_phase_events
BEGIN SELECT RAISE(ABORT,'phase decision events are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_gap_phase_events_no_delete BEFORE DELETE ON gap_assessment_phase_events
BEGIN SELECT RAISE(ABORT,'phase decision events are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_methodology_published_definition_immutable
BEFORE UPDATE OF name,domain_weights,control_weights,thresholds,review_cadence,definition_json,content_hash
ON supplier_risk_methodologies
WHEN OLD.status='published'
BEGIN
  SELECT RAISE(ABORT,'published supplier methodology is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_decision_governed_insert
BEFORE INSERT ON supplier_decisions
FOR EACH ROW
WHEN (
   NEW.idempotency_nonce IS NOT NULL
   OR NEW.request_fingerprint IS NOT NULL
   OR NEW.expected_current_decision_id IS NOT NULL
   OR NEW.supersedes_id IS NOT NULL
 )
 AND (
   length(COALESCE(NEW.idempotency_nonce,''))<32
   OR length(NEW.idempotency_nonce)>128
   OR NEW.idempotency_nonce<>trim(NEW.idempotency_nonce)
   OR length(COALESCE(NEW.request_fingerprint,''))<>64
   OR COALESCE(NEW.request_fingerprint,'') GLOB '*[^0-9a-f]*'
   OR NEW.expected_current_decision_id IS NOT NEW.supersedes_id
   OR (
     NEW.supersedes_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM supplier_decisions prior
        WHERE prior.id=NEW.supersedes_id
          AND prior.workspace_id=NEW.workspace_id
          AND prior.supplier_id=NEW.supplier_id
     )
   )
 )
BEGIN
  SELECT RAISE(ABORT,'invalid governed supplier decision concurrency metadata');
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_decision_concurrency_immutable
BEFORE UPDATE OF idempotency_nonce,request_fingerprint,expected_current_decision_id,supersedes_id
ON supplier_decisions
BEGIN
  SELECT RAISE(ABORT,'supplier decision concurrency metadata is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_contract_agreement_complete
BEFORE UPDATE OF status ON supplier_contract_reviews
FOR EACH ROW
WHEN NEW.status='complete' AND (
  trim(COALESCE(NEW.agreement_reference,''))=''
  OR NEW.agreement_reference<>trim(NEW.agreement_reference)
  OR length(COALESCE(NEW.agreement_date,''))!=10
  OR COALESCE(NEW.agreement_date,'') NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  OR strftime('%Y-%m-%d',NEW.agreement_date||' 00:00:00','+0 days') IS NOT NEW.agreement_date
)
BEGIN
  SELECT RAISE(ABORT,'completed supplier contract review requires an agreement reference and valid ISO agreement date');
END;

CREATE TRIGGER IF NOT EXISTS trg_doc_approver_workspace_guard
BEFORE INSERT ON doc_approvers
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM generated_docs d
  JOIN doc_versions dv
    ON dv.id = NEW.version_id
   AND dv.document_id = NEW.document_id
   AND dv.workspace_id = NEW.workspace_id
  JOIN workspaces w
    ON w.id = NEW.workspace_id
   AND d.workspace_id = w.id
   AND d.id = NEW.document_id
  JOIN users u
    ON u.id = NEW.user_id
   AND u.active = 1
  LEFT JOIN workspace_members wm
    ON wm.workspace_id = NEW.workspace_id
   AND wm.user_id = u.id
  WHERE (u.user_type = 'firm' AND u.firm_id = w.firm_id)
     OR (u.user_type = 'client' AND wm.user_id IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'internal document approver is outside the workspace boundary');
END;

CREATE TRIGGER IF NOT EXISTS trg_doc_internal_rejection_reason_insert
BEFORE INSERT ON doc_approvers
FOR EACH ROW
WHEN NEW.decision = 'rejected' AND trim(COALESCE(NEW.decision_reason, '')) = ''
BEGIN
  SELECT RAISE(ABORT, 'document rejection reason is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_doc_internal_rejection_reason_update
BEFORE UPDATE OF decision, decision_reason ON doc_approvers
FOR EACH ROW
WHEN NEW.decision = 'rejected' AND trim(COALESCE(NEW.decision_reason, '')) = ''
BEGIN
  SELECT RAISE(ABORT, 'document rejection reason is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_doc_external_rejection_reason_insert
BEFORE INSERT ON external_approvers
FOR EACH ROW
WHEN NEW.decision = 'rejected' AND trim(COALESCE(NEW.decision_reason, '')) = ''
BEGIN
  SELECT RAISE(ABORT, 'document rejection reason is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_doc_external_rejection_reason_update
BEFORE UPDATE OF decision, decision_reason ON external_approvers
FOR EACH ROW
WHEN NEW.decision = 'rejected' AND trim(COALESCE(NEW.decision_reason, '')) = ''
BEGIN
  SELECT RAISE(ABORT, 'document rejection reason is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_generated_doc_withdrawal_metadata
BEFORE UPDATE OF status ON generated_docs
FOR EACH ROW
WHEN NEW.status = 'withdrawn'
 AND (NEW.withdrawn_at IS NULL
   OR NEW.withdrawn_by IS NULL
   OR trim(COALESCE(NEW.withdrawal_reason, '')) = '')
BEGIN
  SELECT RAISE(ABORT, 'document withdrawal requires actor, time, and reason');
END;

CREATE TRIGGER IF NOT EXISTS trg_nc_evidence_link_no_update
BEFORE UPDATE ON nonconformity_evidence_links
BEGIN
  SELECT RAISE(ABORT,'nonconformity evidence lineage is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_nc_evidence_link_no_delete
BEFORE DELETE ON nonconformity_evidence_links
WHEN EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id)
BEGIN
  SELECT RAISE(ABORT,'nonconformity evidence lineage is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_certification_finding_lineage_immutable
BEFORE UPDATE OF workspace_id,source,source_ref ON nonconformities
FOR EACH ROW
WHEN (
  EXISTS (
    SELECT 1 FROM cert_cycle_events ce
    WHERE ce.workspace_id=OLD.workspace_id
      AND ce.event_type IN ('stage_1','stage_2')
      AND OLD.source_ref='cert_cycle_event:' || ce.id
      AND lower(COALESCE(OLD.source,''))='external_audit'
  )
  AND (
    NEW.workspace_id IS NOT OLD.workspace_id
    OR lower(COALESCE(NEW.source,'')) IS NOT lower(COALESCE(OLD.source,''))
    OR NEW.source_ref IS NOT OLD.source_ref
  )
) OR (
  NOT EXISTS (
    SELECT 1 FROM cert_cycle_events ce
    WHERE ce.workspace_id=OLD.workspace_id
      AND ce.event_type IN ('stage_1','stage_2')
      AND OLD.source_ref='cert_cycle_event:' || ce.id
      AND lower(COALESCE(OLD.source,''))='external_audit'
  )
  AND EXISTS (
    SELECT 1 FROM cert_cycle_events ce
    WHERE ce.workspace_id=NEW.workspace_id
      AND ce.event_type IN ('stage_1','stage_2')
      AND NEW.source_ref='cert_cycle_event:' || ce.id
      AND lower(COALESCE(NEW.source,''))='external_audit'
  )
)
BEGIN
  SELECT RAISE(ABORT,'certification finding lineage is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_certification_finding_no_delete
BEFORE DELETE ON nonconformities
FOR EACH ROW
WHEN lower(COALESCE(OLD.source,''))='external_audit'
 AND EXISTS (
   SELECT 1 FROM cert_cycle_events ce
   WHERE ce.workspace_id=OLD.workspace_id
     AND ce.event_type IN ('stage_1','stage_2')
     AND OLD.source_ref='cert_cycle_event:' || ce.id
 )
BEGIN
  SELECT RAISE(ABORT,'certification findings are retained audit history');
END;

CREATE TRIGGER IF NOT EXISTS trg_certification_event_with_findings_no_delete
BEFORE DELETE ON cert_cycle_events
FOR EACH ROW
WHEN OLD.event_type IN ('stage_1','stage_2')
 AND EXISTS (
   SELECT 1 FROM nonconformities n
   WHERE n.workspace_id=OLD.workspace_id
     AND lower(COALESCE(n.source,''))='external_audit'
     AND n.source_ref='cert_cycle_event:' || OLD.id
 )
BEGIN
  SELECT RAISE(ABORT,'certification events with retained findings cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_certification_finding_closure_insert
BEFORE INSERT ON nonconformities
FOR EACH ROW
WHEN lower(COALESCE(NEW.status,'')) IN ('closed','verified')
 AND lower(COALESCE(NEW.source,''))='external_audit'
 AND EXISTS (
   SELECT 1 FROM cert_cycle_events ce
   WHERE ce.workspace_id=NEW.workspace_id
     AND ce.event_type IN ('stage_1','stage_2')
     AND NEW.source_ref='cert_cycle_event:' || ce.id
 )
 AND (
   trim(COALESCE(NEW.corrective_action,''))=''
   OR trim(COALESCE(NEW.effectiveness_check,''))=''
   OR (lower(COALESCE(NEW.severity,'')) IN ('major','minor') AND trim(COALESCE(NEW.root_cause,''))='')
   OR NOT EXISTS (
     SELECT 1 FROM nonconformity_evidence_links l
     WHERE l.workspace_id=NEW.workspace_id
       AND l.nonconformity_id=NEW.id
       AND l.evidence_role='validation'
   )
 )
BEGIN
  SELECT RAISE(ABORT,'certification finding closure requires CAPA and validation evidence');
END;

CREATE TRIGGER IF NOT EXISTS trg_certification_finding_closure_update
BEFORE UPDATE OF status,severity,root_cause,corrective_action,effectiveness_check,workspace_id,source,source_ref
ON nonconformities
FOR EACH ROW
WHEN lower(COALESCE(NEW.status,'')) IN ('closed','verified')
 AND lower(COALESCE(NEW.source,''))='external_audit'
 AND EXISTS (
   SELECT 1 FROM cert_cycle_events ce
   WHERE ce.workspace_id=NEW.workspace_id
     AND ce.event_type IN ('stage_1','stage_2')
     AND NEW.source_ref='cert_cycle_event:' || ce.id
 )
 AND (
   trim(COALESCE(NEW.corrective_action,''))=''
   OR trim(COALESCE(NEW.effectiveness_check,''))=''
   OR (lower(COALESCE(NEW.severity,'')) IN ('major','minor') AND trim(COALESCE(NEW.root_cause,''))='')
   OR NOT EXISTS (
     SELECT 1 FROM nonconformity_evidence_links l
     WHERE l.workspace_id=NEW.workspace_id
       AND l.nonconformity_id=NEW.id
       AND l.evidence_role='validation'
   )
 )
BEGIN
  SELECT RAISE(ABORT,'certification finding closure requires CAPA and validation evidence');
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_contract_agreement_complete_insert
BEFORE INSERT ON supplier_contract_reviews
FOR EACH ROW
WHEN NEW.status='complete' AND (
  trim(COALESCE(NEW.agreement_reference,''))=''
  OR NEW.agreement_reference<>trim(NEW.agreement_reference)
  OR length(COALESCE(NEW.agreement_date,''))!=10
  OR COALESCE(NEW.agreement_date,'') NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  OR strftime('%Y-%m-%d',NEW.agreement_date||' 00:00:00','+0 days') IS NOT NEW.agreement_date
)
BEGIN
  SELECT RAISE(ABORT,'completed supplier contract review requires an agreement reference and valid ISO agreement date');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_module_identity_immutable
BEFORE UPDATE OF workspace_id,effective_from,activation_reason,created_by,created_at
ON tprm_modules
BEGIN
  SELECT RAISE(ABORT,'TPRM module activation identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_module_service_model_transition
BEFORE UPDATE OF service_model ON tprm_modules
WHEN NOT (
  OLD.status='needs_classification'
  AND OLD.service_model IS NULL
  AND NEW.service_model IN ('assessment_only','programme_setup','managed_lifecycle')
  AND NEW.status='active'
)
BEGIN
  SELECT RAISE(ABORT,'TPRM service model is immutable after classification');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_module_status_transition
BEFORE UPDATE OF status ON tprm_modules
WHEN NOT (
  (OLD.status='needs_classification' AND NEW.status IN ('active','closed'))
  OR (OLD.status='active' AND NEW.status='closed')
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM module status transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_module_no_delete
BEFORE DELETE ON tprm_modules
BEGIN
  SELECT RAISE(ABORT,'TPRM module history cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_cycle_identity_immutable
BEFORE UPDATE OF workspace_id,supplier_id,module_id,cycle_number,cycle_type,trigger_reason,
  baseline_decision_id,started_by,started_at
ON tprm_assessment_cycles
BEGIN
  SELECT RAISE(ABORT,'TPRM assessment cycle identity and baseline are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_cycle_artifact_lineage_immutable
BEFORE UPDATE OF inherent_assessment_id,ddq_assessment_id,contract_review_id
ON tprm_assessment_cycles
WHEN (OLD.inherent_assessment_id IS NOT NULL AND NEW.inherent_assessment_id IS NOT OLD.inherent_assessment_id)
  OR (OLD.ddq_assessment_id IS NOT NULL AND NEW.ddq_assessment_id IS NOT OLD.ddq_assessment_id)
  OR (OLD.contract_review_id IS NOT NULL AND NEW.contract_review_id IS NOT OLD.contract_review_id)
BEGIN
  SELECT RAISE(ABORT,'linked TPRM assessment artifacts cannot be replaced');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_cycle_status_transition
BEFORE UPDATE OF status ON tprm_assessment_cycles
WHEN NOT (OLD.status='active' AND NEW.status IN ('completed','cancelled'))
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM assessment cycle status transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_cycle_no_delete
BEFORE DELETE ON tprm_assessment_cycles
BEGIN
  SELECT RAISE(ABORT,'TPRM assessment cycle history cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_actor_governance
BEFORE INSERT ON tprm_recommendations
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces w
  JOIN users author ON author.id=NEW.issued_by
  JOIN users reviewer ON reviewer.id=NEW.quality_reviewed_by
  WHERE w.id=NEW.workspace_id
    AND author.user_type='firm' AND reviewer.user_type='firm'
    AND author.firm_id=w.firm_id AND reviewer.firm_id=w.firm_id
    AND author.active=1 AND reviewer.active=1
    AND author.id<>reviewer.id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation requires distinct active firm author and quality reviewer');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_lineage
BEFORE INSERT ON tprm_recommendations
WHEN (
  (NEW.supersedes_id IS NULL AND NEW.version<>1)
  OR (NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tprm_recommendations prior
    WHERE prior.id=NEW.supersedes_id
      AND prior.workspace_id=NEW.workspace_id
      AND prior.supplier_id=NEW.supplier_id
      AND prior.cycle_id=NEW.cycle_id
      AND NEW.version=prior.version+1
  ))
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM recommendation version lineage');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_no_update
BEFORE UPDATE ON tprm_recommendations
BEGIN
  SELECT RAISE(ABORT,'issued TPRM recommendations are immutable; issue a successor version');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_no_delete
BEFORE DELETE ON tprm_recommendations
BEGIN
  SELECT RAISE(ABORT,'issued TPRM recommendations cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_client_decision_recommendation
BEFORE INSERT ON tprm_client_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM tprm_recommendations r
  WHERE r.id=NEW.recommendation_id
    AND r.workspace_id=NEW.workspace_id
    AND r.supplier_id=NEW.supplier_id
    AND r.cycle_id=NEW.cycle_id
    AND r.version=NEW.recommendation_version
)
BEGIN
  SELECT RAISE(ABORT,'client decision must reference the exact recommendation version');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_client_decision_divergence
BEFORE INSERT ON tprm_client_decisions
WHEN NEW.diverges_from_recommendation IS NOT (
  SELECT CASE
    WHEN (r.outcome='recommend_onboard' AND NEW.decision='onboard')
      OR (r.outcome='recommend_with_conditions' AND NEW.decision='onboard_with_conditions')
      OR (r.outcome='do_not_recommend' AND NEW.decision='do_not_onboard')
      OR (r.outcome='insufficient_information' AND NEW.decision='defer_request_information')
    THEN 0 ELSE 1 END
  FROM tprm_recommendations r WHERE r.id=NEW.recommendation_id
)
BEGIN
  SELECT RAISE(ABORT,'client decision divergence flag does not match the recommendation');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_client_decision_override_acceptance
BEFORE INSERT ON tprm_client_decisions
WHEN NEW.diverges_from_recommendation=1
 AND NEW.decision IN ('onboard','onboard_with_conditions')
 AND (
   length(trim(COALESCE(NEW.override_rationale,'')))<10
   OR length(trim(COALESCE(NEW.risk_acceptance_statement,'')))<10
   OR NEW.risk_acceptance_expires_at IS NULL
 )
BEGIN
  SELECT RAISE(ABORT,'divergent onboarding requires explicit client override rationale and expiring risk acceptance');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_client_decision_lineage
BEFORE INSERT ON tprm_client_decisions
WHEN (
  (NEW.supersedes_id IS NULL AND NEW.version<>1)
  OR (NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tprm_client_decisions prior
    WHERE prior.id=NEW.supersedes_id
      AND prior.workspace_id=NEW.workspace_id
      AND prior.supplier_id=NEW.supplier_id
      AND NEW.version=prior.version+1
  ))
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM client-decision version lineage');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_client_decision_no_update
BEFORE UPDATE ON tprm_client_decisions
BEGIN
  SELECT RAISE(ABORT,'client onboarding decisions are immutable; record a successor version');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_client_decision_no_delete
BEFORE DELETE ON tprm_client_decisions
BEGIN
  SELECT RAISE(ABORT,'client onboarding decisions cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_no_delete
BEFORE DELETE ON tprm_conditions
BEGIN
  SELECT RAISE(ABORT,'TPRM conditions cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_review_schedule_positive_decision
BEFORE INSERT ON tprm_review_schedules
WHEN NOT EXISTS (
  SELECT 1 FROM tprm_client_decisions d
  WHERE d.id=NEW.client_decision_id
    AND d.workspace_id=NEW.workspace_id
    AND d.supplier_id=NEW.supplier_id
    AND d.decision IN ('onboard','onboard_with_conditions')
)
BEGIN
  SELECT RAISE(ABORT,'review cadence requires a positive client onboarding decision');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_review_schedule_no_update
BEFORE UPDATE ON tprm_review_schedules
BEGIN
  SELECT RAISE(ABORT,'TPRM review schedules are immutable; create a successor schedule');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_review_schedule_no_delete
BEFORE DELETE ON tprm_review_schedules
BEGIN
  SELECT RAISE(ABORT,'TPRM review schedules cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_clarification_request_immutable
BEFORE UPDATE OF workspace_id,supplier_id,cycle_id,ddq_assessment_id,question_id,request_text,
  requested_by,requested_at,due_date
ON tprm_clarifications
BEGIN
  SELECT RAISE(ABORT,'TPRM clarification request is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_clarification_response_immutable
BEFORE UPDATE OF provider_response,provider_responder_name,provider_responder_email,responded_at
ON tprm_clarifications
WHEN OLD.provider_response IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'provider clarification response is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_clarification_status_transition
BEFORE UPDATE OF status ON tprm_clarifications
WHEN NOT (
  (OLD.status='open' AND NEW.status IN ('responded','withdrawn'))
  OR (OLD.status='responded' AND NEW.status='resolved')
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM clarification status transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_clarification_no_delete
BEFORE DELETE ON tprm_clarifications
BEGIN
  SELECT RAISE(ABORT,'TPRM clarifications cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_monitoring_signal_definition_immutable
BEFORE UPDATE OF workspace_id,supplier_id,module_id,cycle_id,source,source_reference,fingerprint,
  signal_type,severity,title,detail,observed_at,received_at,requires_reassessment,metadata_json
ON tprm_monitoring_signals
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring signal facts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_monitoring_signal_status_transition
BEFORE UPDATE OF status ON tprm_monitoring_signals
WHEN NOT (OLD.status='new' AND NEW.status IN ('triaged','dismissed','escalated'))
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM monitoring signal status transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_monitoring_signal_no_delete
BEFORE DELETE ON tprm_monitoring_signals
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring signals cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_legal_entity_identity_immutable
BEFORE UPDATE OF workspace_id,supplier_id,identity_source,created_by,created_at
ON tprm_legal_entities
BEGIN
  SELECT RAISE(ABORT,'TPRM legal entity tenant identity and provenance are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_legal_entity_version
BEFORE UPDATE ON tprm_legal_entities
WHEN NEW.row_version<>OLD.row_version+1
BEGIN
  SELECT RAISE(ABORT,'TPRM legal entity update requires the next row version');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_legal_entity_status_transition
BEFORE UPDATE OF status ON tprm_legal_entities
WHEN NOT (
  (OLD.status='unknown' AND NEW.status IN ('active','inactive','merged','dissolved'))
  OR (OLD.status='active' AND NEW.status IN ('inactive','merged','dissolved'))
  OR (OLD.status='inactive' AND NEW.status IN ('active','merged','dissolved'))
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM legal entity status transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_legal_entity_no_delete
BEFORE DELETE ON tprm_legal_entities
BEGIN
  SELECT RAISE(ABORT,'TPRM legal entity history cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_relationship_identity_immutable
BEFORE UPDATE OF workspace_id,supplier_id,legal_entity_id,relationship_key,source,is_primary,
  idempotency_key,request_fingerprint,created_by,created_at
ON tprm_service_relationships
BEGIN
  SELECT RAISE(ABORT,'TPRM service relationship tenant identity and provenance are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_relationship_version
BEFORE UPDATE ON tprm_service_relationships
WHEN NEW.row_version<>OLD.row_version+1
BEGIN
  SELECT RAISE(ABORT,'TPRM service relationship update requires the next row version');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_relationship_status_transition
BEFORE UPDATE OF status ON tprm_service_relationships
WHEN NOT (
  (OLD.status='intake' AND NEW.status IN ('active','rejected','offboarding'))
  OR (OLD.status='active' AND NEW.status IN ('suspended','offboarding'))
  OR (OLD.status='suspended' AND NEW.status IN ('active','offboarding'))
  OR (OLD.status='offboarding' AND NEW.status IN ('active','terminated'))
  OR (OLD.status='rejected' AND NEW.status='intake')
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM service relationship status transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_relationship_no_delete
BEFORE DELETE ON tprm_service_relationships
BEGIN
  SELECT RAISE(ABORT,'TPRM service relationship history cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_contract_lineage
BEFORE INSERT ON tprm_relationship_contracts
WHEN (
  (NEW.supersedes_id IS NULL AND NEW.version<>1)
  OR (NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tprm_relationship_contracts prior
    WHERE prior.id=NEW.supersedes_id
      AND prior.workspace_id=NEW.workspace_id
      AND prior.relationship_id=NEW.relationship_id
      AND prior.contract_family_key=NEW.contract_family_key
      AND NEW.version=prior.version+1
      AND NEW.previous_contract_hash=prior.contract_hash
  ))
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM contract version lineage');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_contract_no_update
BEFORE UPDATE ON tprm_relationship_contracts
BEGIN
  SELECT RAISE(ABORT,'TPRM contract snapshots are immutable; add a successor version');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_contract_no_delete
BEFORE DELETE ON tprm_relationship_contracts
BEGIN
  SELECT RAISE(ABORT,'TPRM contract snapshots cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_business_service_identity_immutable
BEFORE UPDATE OF workspace_id,service_key,created_by,created_at ON tprm_business_services
BEGIN
  SELECT RAISE(ABORT,'TPRM business service identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_business_service_version
BEFORE UPDATE ON tprm_business_services
WHEN NEW.row_version<>OLD.row_version+1
BEGIN
  SELECT RAISE(ABORT,'TPRM business service update requires the next row version');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_business_service_status_transition
BEFORE UPDATE OF status ON tprm_business_services
WHEN NOT (OLD.status='active' AND NEW.status='retired')
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM business service status transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_business_service_no_delete
BEFORE DELETE ON tprm_business_services
BEGIN
  SELECT RAISE(ABORT,'TPRM business service history cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_business_dependency_identity_immutable
BEFORE UPDATE OF workspace_id,relationship_id,business_service_id,dependency_type,effective_from,created_by
ON tprm_relationship_business_dependencies
BEGIN
  SELECT RAISE(ABORT,'TPRM business dependency identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_business_dependency_version
BEFORE UPDATE ON tprm_relationship_business_dependencies
WHEN NEW.row_version<>OLD.row_version+1
BEGIN
  SELECT RAISE(ABORT,'TPRM business dependency update requires the next row version');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_business_dependency_status_transition
BEFORE UPDATE OF status ON tprm_relationship_business_dependencies
WHEN NOT (OLD.status='active' AND NEW.status='ended')
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM business dependency status transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_business_dependency_no_delete
BEFORE DELETE ON tprm_relationship_business_dependencies
BEGIN
  SELECT RAISE(ABORT,'TPRM business dependency history cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_dependency_entity_no_update
BEFORE UPDATE ON tprm_dependency_entities
BEGIN
  SELECT RAISE(ABORT,'TPRM dependency entity identity is immutable; create a corrected record');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_dependency_entity_no_delete
BEFORE DELETE ON tprm_dependency_entities
BEGIN
  SELECT RAISE(ABORT,'TPRM dependency entity history cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_dependency_edge_identity_immutable
BEFORE UPDATE OF workspace_id,source_relationship_id,edge_key,target_relationship_id,
  dependency_entity_id,dependency_type,effective_from,idempotency_key,request_fingerprint,created_by,created_at
ON tprm_dependency_edges
BEGIN
  SELECT RAISE(ABORT,'TPRM dependency edge identity and provenance are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_dependency_edge_version
BEFORE UPDATE ON tprm_dependency_edges
WHEN NEW.row_version<>OLD.row_version+1
BEGIN
  SELECT RAISE(ABORT,'TPRM dependency edge update requires the next row version');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_dependency_edge_status_transition
BEFORE UPDATE OF status ON tprm_dependency_edges
WHEN NOT (
  (OLD.status='disclosed' AND NEW.status IN ('under_review','approved','rejected','ended'))
  OR (OLD.status='under_review' AND NEW.status IN ('approved','rejected','ended'))
  OR (OLD.status='approved' AND NEW.status='ended')
  OR (OLD.status='rejected' AND NEW.status='under_review')
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM dependency edge status transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_dependency_edge_no_delete
BEFORE DELETE ON tprm_dependency_edges
BEGIN
  SELECT RAISE(ABORT,'TPRM dependency edge history cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_location_lineage
BEFORE INSERT ON tprm_relationship_locations
WHEN (
  (NEW.supersedes_id IS NULL AND NEW.version<>1)
  OR (NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tprm_relationship_locations prior
    WHERE prior.id=NEW.supersedes_id
      AND prior.workspace_id=NEW.workspace_id
      AND prior.relationship_id=NEW.relationship_id
      AND prior.location_key=NEW.location_key
      AND NEW.version=prior.version+1
      AND NEW.previous_assertion_hash=prior.assertion_hash
  ))
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM location assertion lineage');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_location_no_update
BEFORE UPDATE ON tprm_relationship_locations
BEGIN
  SELECT RAISE(ABORT,'TPRM location assertions are immutable; add a successor version');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_location_no_delete
BEFORE DELETE ON tprm_relationship_locations
BEGIN
  SELECT RAISE(ABORT,'TPRM location assertions cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_cycle_relationship_scope_no_update
BEFORE UPDATE ON tprm_cycle_relationship_scopes
BEGIN
  SELECT RAISE(ABORT,'TPRM assessment relationship scope is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_cycle_relationship_scope_no_delete
BEFORE DELETE ON tprm_cycle_relationship_scopes
BEGIN
  SELECT RAISE(ABORT,'TPRM assessment relationship scope cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_relationship_event_no_update
BEFORE UPDATE ON tprm_relationship_events
BEGIN
  SELECT RAISE(ABORT,'TPRM relationship events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_relationship_event_no_delete
BEFORE DELETE ON tprm_relationship_events
BEGIN
  SELECT RAISE(ABORT,'TPRM relationship events cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_actor_insert
BEFORE INSERT ON tprm_monitoring_connectors
WHEN NOT EXISTS (
  SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
  WHERE u.id=NEW.created_by AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM connector creator must be an active consultancy user for this workspace');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_active_module_insert
BEFORE INSERT ON tprm_monitoring_connectors
WHEN NEW.status='active' AND NOT EXISTS (
  SELECT 1 FROM tprm_modules m
  WHERE m.workspace_id=NEW.workspace_id AND m.id=NEW.module_id AND m.status='active'
)
BEGIN
  SELECT RAISE(ABORT,'TPRM connector cannot be active unless its module is active');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_active_module_update
BEFORE UPDATE OF status ON tprm_monitoring_connectors
WHEN NEW.status='active' AND NOT EXISTS (
  SELECT 1 FROM tprm_modules m
  WHERE m.workspace_id=NEW.workspace_id AND m.id=NEW.module_id AND m.status='active'
)
BEGIN
  SELECT RAISE(ABORT,'TPRM connector cannot be active unless its module is active');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_status_transition
BEFORE UPDATE OF status ON tprm_monitoring_connectors
WHEN NOT (
  (OLD.status='draft' AND NEW.status IN ('active','disabled'))
  OR (OLD.status='active' AND NEW.status IN ('paused','disabled'))
  OR (OLD.status='paused' AND NEW.status IN ('active','disabled'))
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM connector status transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_no_delete
BEFORE DELETE ON tprm_monitoring_connectors
BEGIN
  SELECT RAISE(ABORT,'TPRM connector history cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_audit_no_update
BEFORE UPDATE ON tprm_monitoring_connector_audit
BEGIN
  SELECT RAISE(ABORT,'TPRM connector audit history is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_audit_no_delete
BEFORE DELETE ON tprm_monitoring_connector_audit
BEGIN
  SELECT RAISE(ABORT,'TPRM connector audit history cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_mapping_actor_insert
BEFORE INSERT ON tprm_connector_supplier_mappings
WHEN NOT EXISTS (
  SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
  WHERE u.id=NEW.created_by AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM connector mapping creator must be an active consultancy user');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_mapping_identity_immutable
BEFORE UPDATE OF workspace_id,connector_id,provider_entity_id,supplier_id,mapping_note,valid_from,created_by
ON tprm_connector_supplier_mappings
BEGIN
  SELECT RAISE(ABORT,'TPRM connector supplier mapping history is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_mapping_retire_only
BEFORE UPDATE OF active,valid_to,retired_by ON tprm_connector_supplier_mappings
WHEN NOT (OLD.active=1 AND NEW.active=0 AND NEW.valid_to IS NOT NULL AND NEW.retired_by IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT,'TPRM connector mappings can only transition from active to retired');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_mapping_no_delete
BEFORE DELETE ON tprm_connector_supplier_mappings
BEGIN
  SELECT RAISE(ABORT,'TPRM connector supplier mapping history cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_monitoring_rule_identity_immutable
BEFORE UPDATE OF workspace_id,connector_id,rule_key,version,metric_path,operator,threshold_json,
  signal_type,severity,requires_reassessment,missing_behavior,title,supersedes_id,created_by,created_at
ON tprm_monitoring_rules
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring rule definition and lineage are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_monitoring_rule_disable_only
BEFORE UPDATE OF enabled,disabled_by,disabled_at ON tprm_monitoring_rules
WHEN NOT (OLD.enabled=1 AND NEW.enabled=0 AND NEW.disabled_by IS NOT NULL AND NEW.disabled_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring rules can only transition from enabled to disabled');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_monitoring_rule_no_delete
BEFORE DELETE ON tprm_monitoring_rules
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring rule history cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_received_event_no_update
BEFORE UPDATE ON tprm_monitoring_received_events
BEGIN
  SELECT RAISE(ABORT,'TPRM received monitoring events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_received_event_no_delete
BEFORE DELETE ON tprm_monitoring_received_events
BEGIN
  SELECT RAISE(ABORT,'TPRM received monitoring events cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_rule_evaluation_no_update
BEFORE UPDATE ON tprm_monitoring_rule_evaluations
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring rule evaluations are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_rule_evaluation_no_delete
BEFORE DELETE ON tprm_monitoring_rule_evaluations
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring rule evaluations cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_processing_attempt_no_update
BEFORE UPDATE ON tprm_monitoring_processing_attempts
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring processing attempts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_processing_attempt_no_delete
BEFORE DELETE ON tprm_monitoring_processing_attempts
BEGIN
  SELECT RAISE(ABORT,'TPRM monitoring processing attempts cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_state_identity
BEFORE UPDATE OF workspace_id,connector_id ON tprm_monitoring_connector_state
BEGIN
  SELECT RAISE(ABORT,'TPRM connector runtime-state identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_state_version
BEFORE UPDATE ON tprm_monitoring_connector_state
WHEN NEW.row_version<>OLD.row_version+1
BEGIN
  SELECT RAISE(ABORT,'TPRM connector runtime-state update requires the next row version');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_state_no_delete
BEFORE DELETE ON tprm_monitoring_connector_state
BEGIN
  SELECT RAISE(ABORT,'TPRM connector runtime state cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_reassessment_queue_identity
BEFORE UPDATE OF workspace_id,supplier_id,module_id,signal_id,received_event_id,reason,priority,
  max_attempts,created_at
ON tprm_reassessment_queue
BEGIN
  SELECT RAISE(ABORT,'TPRM reassessment request identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_reassessment_queue_transition
BEFORE UPDATE OF status ON tprm_reassessment_queue
WHEN NOT (
  (OLD.status='pending' AND NEW.status='processing')
  OR (OLD.status='processing' AND NEW.status IN ('pending','completed','manual_review'))
  OR (OLD.status='manual_review' AND NEW.status='pending')
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM reassessment queue transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_reassessment_queue_version
BEFORE UPDATE ON tprm_reassessment_queue
WHEN NEW.row_version<>OLD.row_version+1
BEGIN
  SELECT RAISE(ABORT,'TPRM reassessment queue update requires the next row version');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_reassessment_queue_no_delete
BEFORE DELETE ON tprm_reassessment_queue
BEGIN
  SELECT RAISE(ABORT,'TPRM reassessment queue history cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_draft_actor_insert
BEFORE INSERT ON tprm_recommendation_drafts
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces w JOIN users u ON u.id=NEW.author_id
  WHERE w.id=NEW.workspace_id AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation draft author must be an active consultancy user');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_draft_reviewer
BEFORE UPDATE OF reviewer_id ON tprm_recommendation_drafts
WHEN NEW.reviewer_id IS NOT NULL AND (
  NEW.reviewer_id=NEW.author_id OR NOT EXISTS (
    SELECT 1 FROM workspaces w JOIN users u ON u.id=NEW.reviewer_id
    WHERE w.id=NEW.workspace_id AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
  )
)
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation reviewer must be a distinct active consultancy user');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_draft_identity
BEFORE UPDATE OF workspace_id,supplier_id,cycle_id,author_id,created_at
ON tprm_recommendation_drafts
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation draft identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_draft_status
BEFORE UPDATE OF status ON tprm_recommendation_drafts
WHEN NOT (
  (OLD.status IN ('draft','changes_requested') AND NEW.status='in_review')
  OR (OLD.status='in_review' AND NEW.status IN ('changes_requested','issued','withdrawn'))
  OR (OLD.status IN ('draft','changes_requested') AND NEW.status='withdrawn')
)
BEGIN
  SELECT RAISE(ABORT,'invalid TPRM recommendation draft status transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_draft_no_delete
BEFORE DELETE ON tprm_recommendation_drafts
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation drafts cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_revision_scope
BEFORE INSERT ON tprm_recommendation_draft_revisions
WHEN NOT EXISTS (
  SELECT 1 FROM tprm_recommendation_drafts d
  JOIN workspaces w ON w.id=d.workspace_id
  JOIN users u ON u.id=NEW.created_by
  WHERE d.id=NEW.draft_id AND d.workspace_id=NEW.workspace_id
    AND d.supplier_id=NEW.supplier_id AND d.cycle_id=NEW.cycle_id
    AND d.status IN ('draft','changes_requested')
    AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation revision is outside an editable consultancy draft');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_revision_no_update
BEFORE UPDATE ON tprm_recommendation_draft_revisions
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation draft revisions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_revision_no_delete
BEFORE DELETE ON tprm_recommendation_draft_revisions
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation draft revisions cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_draft_event_actor
BEFORE INSERT ON tprm_recommendation_draft_events
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces w JOIN users u ON u.id=NEW.actor_id
  WHERE w.id=NEW.workspace_id AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
)
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation draft event requires an active consultancy actor');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_draft_event_no_update
BEFORE UPDATE ON tprm_recommendation_draft_events
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation draft events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_draft_event_no_delete
BEFORE DELETE ON tprm_recommendation_draft_events
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation draft events cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_event_scope_and_version
BEFORE INSERT ON tprm_condition_events
WHEN NOT EXISTS (
  SELECT 1 FROM tprm_conditions c
  WHERE c.id=NEW.condition_id AND c.workspace_id=NEW.workspace_id
    AND c.supplier_id=NEW.supplier_id AND c.cycle_id=NEW.cycle_id
    AND c.status=NEW.from_status AND c.row_version=NEW.expected_row_version
)
BEGIN
  SELECT RAISE(ABORT,'TPRM condition event is stale or outside its tenant and cycle');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_event_actor
BEFORE INSERT ON tprm_condition_events
WHEN (
  (NEW.actor_type='client_owner' AND (
    NEW.event_type NOT IN ('work_started','evidence_submitted')
    OR NOT EXISTS (
      SELECT 1 FROM tprm_conditions c
      JOIN users u ON u.id=NEW.actor_user_id
      JOIN workspace_members wm ON wm.workspace_id=NEW.workspace_id AND wm.user_id=u.id
      WHERE c.id=NEW.condition_id AND c.workspace_id=NEW.workspace_id
        AND c.supplier_id=NEW.supplier_id AND c.owner_type='client'
        AND c.owner_user_id=u.id AND u.user_type='client' AND u.active=1
        AND wm.role IN ('client_owner','client_admin')
    )
  ))
  OR (NEW.actor_type IN ('consultant','consultancy_manager') AND (
    NEW.event_type NOT IN ('changes_requested','verified','waived')
    OR NOT EXISTS (
      SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
      WHERE u.id=NEW.actor_user_id AND u.user_type='firm' AND u.active=1
        AND u.firm_id=w.firm_id
        AND (NEW.actor_type!='consultancy_manager' OR u.firm_role IN ('manager','firm_owner'))
    )
  ))
  OR (NEW.event_type='waived' AND NEW.actor_type!='consultancy_manager')
)
BEGIN
  SELECT RAISE(ABORT,'TPRM condition action is not authorized for this actor');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_event_hash_chain
BEFORE INSERT ON tprm_condition_events
WHEN COALESCE(NEW.previous_event_hash,'')<>COALESCE((
  SELECT event_hash FROM tprm_condition_events
  WHERE workspace_id=NEW.workspace_id AND condition_id=NEW.condition_id
  ORDER BY id DESC LIMIT 1
),'')
BEGIN
  SELECT RAISE(ABORT,'TPRM condition event hash chain does not match current history');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_event_no_update
BEFORE UPDATE ON tprm_condition_events
BEGIN
  SELECT RAISE(ABORT,'TPRM condition events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_event_no_delete
BEFORE DELETE ON tprm_condition_events
BEGIN
  SELECT RAISE(ABORT,'TPRM condition events cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_evidence_scope
BEFORE INSERT ON tprm_condition_evidence_links
WHEN NOT EXISTS (
  SELECT 1 FROM tprm_condition_events e
  JOIN tprm_conditions c
    ON c.workspace_id=e.workspace_id AND c.supplier_id=e.supplier_id
      AND c.cycle_id=e.cycle_id AND c.id=e.condition_id
  WHERE e.id=NEW.condition_event_id AND e.workspace_id=NEW.workspace_id
    AND e.supplier_id=NEW.supplier_id AND e.cycle_id=NEW.cycle_id
    AND e.condition_id=NEW.condition_id AND e.event_type='evidence_submitted'
    AND e.actor_type='client_owner' AND e.actor_user_id=NEW.uploaded_by
    AND c.owner_type='client' AND c.owner_user_id=NEW.uploaded_by
)
BEGIN
  SELECT RAISE(ABORT,'TPRM condition evidence is outside the authorized client submission');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_evidence_no_update
BEFORE UPDATE ON tprm_condition_evidence_links
BEGIN
  SELECT RAISE(ABORT,'TPRM condition evidence links are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_evidence_no_delete
BEFORE DELETE ON tprm_condition_evidence_links
BEGIN
  SELECT RAISE(ABORT,'TPRM condition evidence links cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_projection_guard
BEFORE UPDATE OF evidence_summary,completion_note,completed_at,completed_by,
  verified_at,verified_by,waiver_rationale,waiver_expires_at,row_version
ON tprm_conditions
WHEN NEW.status=OLD.status
BEGIN
  SELECT RAISE(ABORT,'TPRM condition fulfilment projection changes only with a governed status event');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_webhook_bucket_identity
BEFORE UPDATE OF workspace_id,connector_id,source_key_hash
ON tprm_webhook_ingress_buckets
BEGIN
  SELECT RAISE(ABORT,'TPRM webhook ingress bucket identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_review_schedule_closure_negative_decision
BEFORE INSERT ON tprm_review_schedule_closures
WHEN NOT EXISTS (
  SELECT 1 FROM tprm_client_decisions d
  WHERE d.id=NEW.superseded_by_decision_id
    AND d.workspace_id=NEW.workspace_id
    AND d.supplier_id=NEW.supplier_id
    AND d.decision='do_not_onboard'
)
BEGIN
  SELECT RAISE(ABORT,'review schedule closure requires a final negative client decision');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_review_schedule_closure_client_actor
BEFORE INSERT ON tprm_review_schedule_closures
WHEN NOT EXISTS (
  SELECT 1 FROM users u
  JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=NEW.workspace_id
  WHERE u.id=NEW.closed_by AND u.user_type='client' AND u.active=1
    AND wm.role IN ('client_owner','client_admin')
)
BEGIN
  SELECT RAISE(ABORT,'review schedule closure requires an authorised active client decision-maker');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_review_schedule_closure_no_update
BEFORE UPDATE ON tprm_review_schedule_closures
BEGIN
  SELECT RAISE(ABORT,'TPRM review schedule closures are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_review_schedule_closure_no_delete
BEFORE DELETE ON tprm_review_schedule_closures
BEGIN
  SELECT RAISE(ABORT,'TPRM review schedule closures cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_relationship_event_hash_required
BEFORE INSERT ON tprm_relationship_events
WHEN NEW.event_hash IS NULL
BEGIN
  SELECT RAISE(ABORT,'TPRM relationship event hash is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_relationship_event_chain_predecessor
BEFORE INSERT ON tprm_relationship_events
WHEN NEW.previous_event_hash IS NOT (
  SELECT event_hash FROM tprm_relationship_events
  WHERE workspace_id=NEW.workspace_id
    AND relationship_id IS NEW.relationship_id
    AND event_hash IS NOT NULL
  ORDER BY id DESC LIMIT 1
)
BEGIN
  SELECT RAISE(ABORT,'TPRM relationship event hash-chain predecessor is invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_recommendation_draft_event_chain_predecessor
BEFORE INSERT ON tprm_recommendation_draft_events
WHEN NEW.previous_event_hash IS NOT (
  SELECT event_hash FROM tprm_recommendation_draft_events
  WHERE workspace_id=NEW.workspace_id AND draft_id=NEW.draft_id
  ORDER BY id DESC LIMIT 1
)
BEGIN
  SELECT RAISE(ABORT,'TPRM recommendation draft event hash-chain predecessor is invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_cycle_authority_insert
    BEFORE INSERT ON tprm_assessment_cycles
    WHEN NEW.client_decision_authority_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM users u JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=NEW.workspace_id
      WHERE u.id=NEW.client_decision_authority_id AND u.user_type='client' AND u.active=1
        AND wm.role IN ('client_owner','client_admin')
    )
    BEGIN SELECT RAISE(ABORT,'TPRM decision authority must be an active client workspace member'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_cycle_authority_update
    BEFORE UPDATE OF client_decision_authority_id ON tprm_assessment_cycles
    WHEN (OLD.client_decision_authority_id IS NOT NULL AND NEW.client_decision_authority_id IS NOT OLD.client_decision_authority_id)
      OR (NEW.client_decision_authority_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM users u JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=NEW.workspace_id
        WHERE u.id=NEW.client_decision_authority_id AND u.user_type='client' AND u.active=1
          AND wm.role IN ('client_owner','client_admin')
      ))
    BEGIN SELECT RAISE(ABORT,'TPRM decision authority is immutable once assigned and must be an active client workspace member'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_client_decision_actor
    BEFORE INSERT ON tprm_client_decisions
    WHEN NOT EXISTS (
      SELECT 1 FROM users u JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=NEW.workspace_id
      WHERE u.id=NEW.client_actor_user_id AND u.user_type='client' AND u.active=1
        AND wm.role IN ('client_owner','client_admin')
    ) OR EXISTS (
      SELECT 1 FROM tprm_assessment_cycles c
      WHERE c.id=NEW.cycle_id AND c.client_decision_authority_id IS NOT NULL
        AND c.client_decision_authority_id<>NEW.client_actor_user_id
    )
    BEGIN SELECT RAISE(ABORT,'TPRM onboarding decision requires the assigned active client decision authority'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_owner_tenant
    BEFORE INSERT ON tprm_conditions
    WHEN (
      (NEW.owner_type='client' AND (NEW.owner_user_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM users u JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=NEW.workspace_id
        WHERE u.id=NEW.owner_user_id AND u.user_type='client' AND u.active=1
          AND wm.role IN ('client_owner','client_admin')
      )))
      OR (NEW.owner_type='consultancy' AND (NEW.owner_user_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
        WHERE u.id=NEW.owner_user_id AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
      )))
      OR (NEW.owner_type='third_party' AND NEW.owner_user_id IS NOT NULL)
    )
    BEGIN SELECT RAISE(ABORT,'TPRM condition owner does not match the owner type and tenant'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_status_transition
    BEFORE UPDATE OF status ON tprm_conditions
    WHEN NOT (
      (OLD.status='open' AND NEW.status IN ('in_progress','waived'))
      OR (OLD.status='in_progress' AND NEW.status IN ('evidence_submitted','waived'))
      OR (OLD.status='evidence_submitted' AND NEW.status IN ('in_progress','verified','waived'))
    )
    BEGIN SELECT RAISE(ABORT,'invalid governed TPRM condition status transition'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_status_requires_event
    BEFORE UPDATE OF status ON tprm_conditions
    WHEN NEW.status<>OLD.status AND (
      NEW.row_version<>OLD.row_version+1 OR NOT EXISTS (
        SELECT 1 FROM tprm_condition_events e
        WHERE e.workspace_id=OLD.workspace_id AND e.supplier_id=OLD.supplier_id
          AND e.cycle_id=OLD.cycle_id AND e.condition_id=OLD.id
          AND e.from_status=OLD.status AND e.to_status=NEW.status
          AND e.expected_row_version=OLD.row_version AND e.resulting_row_version=NEW.row_version
        ORDER BY e.id DESC LIMIT 1
      )
    )
    BEGIN SELECT RAISE(ABORT,'TPRM condition status requires its append-only governed event'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_evidence_release_actor
    BEFORE INSERT ON tprm_evidence_releases
    WHEN NOT EXISTS (
      SELECT 1 FROM workspaces w JOIN users u ON u.id=NEW.released_by
      WHERE w.id=NEW.workspace_id AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
    )
    BEGIN SELECT RAISE(ABORT,'TPRM evidence release requires an active consultancy user'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_evidence_release_ddq_scope
    BEFORE INSERT ON tprm_evidence_releases
    WHEN NEW.source_type='ddq_evidence' AND NOT EXISTS (
      SELECT 1 FROM supplier_ddq_evidence e
      JOIN supplier_ddq_assessments a ON a.id=e.assessment_id
      JOIN tprm_assessment_cycles c ON c.id=NEW.cycle_id
      WHERE e.id=NEW.ddq_evidence_id AND e.workspace_id=NEW.workspace_id
        AND a.workspace_id=NEW.workspace_id AND a.supplier_id=NEW.supplier_id
        AND c.workspace_id=NEW.workspace_id AND c.supplier_id=NEW.supplier_id
        AND c.ddq_assessment_id=a.id
    )
    BEGIN SELECT RAISE(ABORT,'released DDQ evidence is outside this governed assessment cycle'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_evidence_release_no_update BEFORE UPDATE ON tprm_evidence_releases
    BEGIN SELECT RAISE(ABORT,'TPRM evidence releases are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_evidence_release_no_delete BEFORE DELETE ON tprm_evidence_releases
    BEGIN SELECT RAISE(ABORT,'TPRM evidence releases cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_evidence_withdrawal_actor
    BEFORE INSERT ON tprm_evidence_release_withdrawals
    WHEN NOT EXISTS (
      SELECT 1 FROM workspaces w JOIN users u ON u.id=NEW.withdrawn_by
      WHERE w.id=NEW.workspace_id AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
    )
    BEGIN SELECT RAISE(ABORT,'TPRM evidence withdrawal requires an active consultancy user'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_evidence_withdrawal_no_update BEFORE UPDATE ON tprm_evidence_release_withdrawals
    BEGIN SELECT RAISE(ABORT,'TPRM evidence-release withdrawals are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_evidence_withdrawal_no_delete BEFORE DELETE ON tprm_evidence_release_withdrawals
    BEGIN SELECT RAISE(ABORT,'TPRM evidence-release withdrawals cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_module_closure_actor
    BEFORE INSERT ON tprm_module_closure_records
    WHEN NOT EXISTS (
      SELECT 1 FROM tprm_modules m JOIN workspaces w ON w.id=m.workspace_id JOIN users u ON u.id=NEW.closed_by
      WHERE m.id=NEW.module_id AND m.workspace_id=NEW.workspace_id AND m.status='closed'
        AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
        AND u.firm_role IN ('manager','firm_owner')
    )
    BEGIN SELECT RAISE(ABORT,'TPRM closure policy requires the manager who closed the service period'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_module_closure_no_update BEFORE UPDATE ON tprm_module_closure_records
    BEGIN SELECT RAISE(ABORT,'TPRM module closure policy is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_module_closure_no_delete BEFORE DELETE ON tprm_module_closure_records
    BEGIN SELECT RAISE(ABORT,'TPRM module closure policy cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_event_no_update BEFORE UPDATE ON tprm_lifecycle_events
    BEGIN SELECT RAISE(ABORT,'TPRM lifecycle events are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_event_no_delete BEFORE DELETE ON tprm_lifecycle_events
    BEGIN SELECT RAISE(ABORT,'TPRM lifecycle events cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_lifecycle_event_hash_required
    BEFORE INSERT ON tprm_lifecycle_events WHEN NEW.event_hash IS NULL
    BEGIN SELECT RAISE(ABORT,'TPRM lifecycle event hash is required'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_lifecycle_event_chain_predecessor
    BEFORE INSERT ON tprm_lifecycle_events
    WHEN NEW.previous_event_hash IS NOT (
      SELECT event_hash FROM tprm_lifecycle_events
      WHERE workspace_id=NEW.workspace_id AND module_id=NEW.module_id
        AND supplier_id IS NEW.supplier_id AND event_hash IS NOT NULL
      ORDER BY id DESC LIMIT 1
    )
    BEGIN SELECT RAISE(ABORT,'TPRM lifecycle event hash-chain predecessor is invalid'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_actor_update
    BEFORE UPDATE ON tprm_monitoring_connectors
    WHEN NEW.updated_by IS NULL OR NOT EXISTS (
      SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
      WHERE u.id=NEW.updated_by AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
    )
    BEGIN SELECT RAISE(ABORT,'TPRM connector updates require an active consultancy user for this workspace'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_identity_immutable
    BEFORE UPDATE OF workspace_id,module_id,provider_type,capability_mode,name,ingress_key,created_by,created_at
    ON tprm_monitoring_connectors
    BEGIN SELECT RAISE(ABORT,'TPRM connector tenant identity and adapter type are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_version
    BEFORE UPDATE ON tprm_monitoring_connectors
    WHEN NEW.row_version<>OLD.row_version+1
    BEGIN SELECT RAISE(ABORT,'TPRM connector update requires the next row version'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_no_secret_config_insert
    BEFORE INSERT ON tprm_monitoring_connectors
    WHEN EXISTS (
      SELECT 1 FROM json_tree(NEW.adapter_config_json) j
      WHERE lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) IN (
        'secret','password','passphrase','api_key','apikey','access_token','refresh_token',
        'accesstoken','refreshtoken','authorization','credential','credentials','private_key','privatekey',
        'client_secret','clientsecret','webhook_secret','webhooksecret'
      )
      OR lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) GLOB '*_secret'
      OR lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) GLOB '*_token'
      OR lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) GLOB '*_password'
      OR lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) GLOB '*_credential'
    )
    BEGIN SELECT RAISE(ABORT,'connector configuration cannot contain secret material; store a secret reference'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_no_secret_config_update
    BEFORE UPDATE OF adapter_config_json ON tprm_monitoring_connectors
    WHEN EXISTS (
      SELECT 1 FROM json_tree(NEW.adapter_config_json) j
      WHERE lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) IN (
        'secret','password','passphrase','api_key','apikey','access_token','refresh_token',
        'accesstoken','refreshtoken','authorization','credential','credentials','private_key','privatekey',
        'client_secret','clientsecret','webhook_secret','webhooksecret'
      )
      OR lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) GLOB '*_secret'
      OR lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) GLOB '*_token'
      OR lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) GLOB '*_password'
      OR lower(replace(replace(COALESCE(j.key,''),'-','_'),' ','_')) GLOB '*_credential'
    )
    BEGIN SELECT RAISE(ABORT,'connector configuration cannot contain secret material; store a secret reference'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_audit_actor
    BEFORE INSERT ON tprm_monitoring_connector_audit
    WHEN (NEW.actor_type='system' AND NEW.actor_user_id IS NOT NULL)
      OR (NEW.actor_type='consultancy' AND NOT EXISTS (
        SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
        WHERE u.id=NEW.actor_user_id AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
      ))
    BEGIN SELECT RAISE(ABORT,'TPRM connector audit actor is outside this consultancy workspace'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_audit_chain_predecessor
    BEFORE INSERT ON tprm_monitoring_connector_audit
    WHEN NEW.previous_event_hash IS NOT (
      SELECT event_hash FROM tprm_monitoring_connector_audit
      WHERE workspace_id=NEW.workspace_id AND connector_id=NEW.connector_id ORDER BY id DESC LIMIT 1
    )
    BEGIN SELECT RAISE(ABORT,'TPRM connector audit hash-chain predecessor is invalid'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_mapping_actor_retire
    BEFORE UPDATE OF retired_by ON tprm_connector_supplier_mappings
    WHEN NOT EXISTS (
      SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
      WHERE u.id=NEW.retired_by AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
    )
    BEGIN SELECT RAISE(ABORT,'TPRM connector mapping retirement requires an active consultancy user'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_monitoring_rule_actor_insert
    BEFORE INSERT ON tprm_monitoring_rules
    WHEN NOT EXISTS (
      SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
      WHERE u.id=NEW.created_by AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
    )
    BEGIN SELECT RAISE(ABORT,'TPRM monitoring rule creator must be an active consultancy user'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_monitoring_rule_actor_disable
    BEFORE UPDATE OF disabled_by ON tprm_monitoring_rules
    WHEN NOT EXISTS (
      SELECT 1 FROM users u JOIN workspaces w ON w.id=NEW.workspace_id
      WHERE u.id=NEW.disabled_by AND u.user_type='firm' AND u.active=1 AND u.firm_id=w.firm_id
    )
    BEGIN SELECT RAISE(ABORT,'TPRM monitoring rule disablement requires an active consultancy user'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_received_event_chain_predecessor
    BEFORE INSERT ON tprm_monitoring_received_events
    WHEN NEW.previous_event_hash IS NOT (
      SELECT event_hash FROM tprm_monitoring_received_events
      WHERE workspace_id=NEW.workspace_id AND connector_id=NEW.connector_id ORDER BY id DESC LIMIT 1
    )
    BEGIN SELECT RAISE(ABORT,'TPRM received-event hash-chain predecessor is invalid'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_run_no_update BEFORE UPDATE ON tprm_monitoring_connector_runs
    BEGIN SELECT RAISE(ABORT,'TPRM connector run history is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_connector_run_no_delete BEFORE DELETE ON tprm_monitoring_connector_runs
    BEGIN SELECT RAISE(ABORT,'TPRM connector run history cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_definition_immutable
    BEFORE UPDATE OF workspace_id,supplier_id,cycle_id,source_type,recommendation_id,client_decision_id,
      finding_id,condition_type,title,description,severity,owner_type,owner_user_id,owner_name,due_date,
      verification_criteria,created_by,created_at
    ON tprm_conditions
    BEGIN
      SELECT RAISE(ABORT,'issued TPRM condition definition is immutable');
    END;

CREATE TRIGGER IF NOT EXISTS trg_tprm_condition_supplier_finding
    BEFORE INSERT ON tprm_conditions
    WHEN NEW.finding_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM supplier_finding_links l
      WHERE l.finding_id=NEW.finding_id AND l.supplier_id=NEW.supplier_id
    )
    BEGIN
      SELECT RAISE(ABORT,'TPRM condition finding is not linked to this third party');
    END;

CREATE TRIGGER IF NOT EXISTS trg_evidence_ai_index_identity_immutable
BEFORE UPDATE OF
  workspace_id,evidence_id,source_sha256,source_size_bytes,
  extractor_version,chunker_version,embedding_provider,
  embedding_model_requested,embedding_dimensions,vector_format,pipeline_key,
  external_processing_acknowledged,disclosure_version,authorization_scope,
  authorized_by,authorized_at,created_at
ON evidence_ai_indexes
BEGIN
  SELECT RAISE(ABORT,'evidence AI index identity and authorization are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_evidence_ai_index_transition
BEFORE UPDATE OF status ON evidence_ai_indexes
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'queued' AND NEW.status IN ('processing','stale'))
  OR (OLD.status = 'processing' AND NEW.status IN ('ready','failed','stale','unsupported'))
  OR (OLD.status = 'ready' AND NEW.status = 'stale')
)
BEGIN
  SELECT RAISE(ABORT,'invalid evidence AI index status transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_evidence_ai_index_version
BEFORE UPDATE ON evidence_ai_indexes
WHEN NEW.row_version <> OLD.row_version + 1
BEGIN
  SELECT RAISE(ABORT,'evidence AI index update requires the next row version');
END;

CREATE TRIGGER IF NOT EXISTS trg_evidence_ai_index_ready_chunks
BEFORE UPDATE OF status ON evidence_ai_indexes
WHEN NEW.status = 'ready'
 AND OLD.status <> 'ready'
 AND NEW.chunk_count <> (
   SELECT COUNT(*) FROM evidence_ai_chunks c
   WHERE c.workspace_id = NEW.workspace_id
     AND c.evidence_id = NEW.evidence_id
     AND c.index_id = NEW.id
 )
BEGIN
  SELECT RAISE(ABORT,'evidence AI index chunk count is incomplete');
END;

CREATE TRIGGER IF NOT EXISTS trg_evidence_ai_chunk_processing_parent
BEFORE INSERT ON evidence_ai_chunks
WHEN NOT EXISTS (
  SELECT 1 FROM evidence_ai_indexes i
  WHERE i.workspace_id = NEW.workspace_id
    AND i.evidence_id = NEW.evidence_id
    AND i.id = NEW.index_id
    AND i.status = 'processing'
)
BEGIN
  SELECT RAISE(ABORT,'evidence AI chunks require a processing parent index');
END;

CREATE TRIGGER IF NOT EXISTS trg_evidence_ai_chunk_no_update
BEFORE UPDATE ON evidence_ai_chunks
BEGIN
  SELECT RAISE(ABORT,'evidence AI chunks are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_evidence_ai_source_stale
AFTER UPDATE OF workspace_id,stored_path,sha256,size_bytes,superseded_at ON evidence
FOR EACH ROW
WHEN NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.stored_path IS NOT OLD.stored_path
  OR NEW.sha256 IS NOT OLD.sha256
  OR NEW.size_bytes IS NOT OLD.size_bytes
  OR NEW.superseded_at IS NOT OLD.superseded_at
BEGIN
  UPDATE evidence_ai_indexes
     SET status = 'stale',
         lease_expires_at = NULL,
         stale_at = datetime('now'),
         last_error_code = COALESCE(last_error_code,'evidence_source_changed'),
         last_error_redacted = COALESCE(last_error_redacted,
           'The evidence source changed or was superseded; this derived index is no longer queryable.'),
         updated_at = datetime('now'),
         row_version = row_version + 1
   WHERE workspace_id = OLD.workspace_id
     AND evidence_id = OLD.id
     AND status IN ('queued','processing','ready');
END;

CREATE TRIGGER IF NOT EXISTS control_record_version AFTER UPDATE ON control_instances
    WHEN NEW.record_version = OLD.record_version
    BEGIN UPDATE control_instances SET record_version = OLD.record_version + 1 WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS client_request_release_on_insert AFTER INSERT ON client_requests
WHEN NEW.assignee_id IS NOT NULL AND NEW.released_at IS NULL
BEGIN UPDATE client_requests SET released_at=CURRENT_TIMESTAMP,released_by=NEW.created_by WHERE id=NEW.id; END;

CREATE TRIGGER IF NOT EXISTS client_request_release_on_assignment AFTER UPDATE OF assignee_id ON client_requests
WHEN NEW.assignee_id IS NOT NULL AND NEW.released_at IS NULL
BEGIN UPDATE client_requests SET released_at=CURRENT_TIMESTAMP,released_by=NEW.created_by WHERE id=NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_assessment_review_event_scope BEFORE INSERT ON assessment_review_events
WHEN NOT EXISTS (SELECT 1 FROM requirements r JOIN frameworks f ON f.id=r.framework_id
  WHERE r.id=NEW.requirement_id AND f.code=NEW.framework_code)
 OR (NEW.request_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assessment_review_events e
  WHERE e.id=NEW.request_event_id AND e.workspace_id=NEW.workspace_id AND e.requirement_id=NEW.requirement_id AND e.action='request'))
BEGIN SELECT RAISE(ABORT,'assessment review source does not match'); END;

CREATE TRIGGER IF NOT EXISTS trg_assessment_review_events_no_update BEFORE UPDATE ON assessment_review_events BEGIN SELECT RAISE(ABORT,'assessment review history is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_assessment_review_events_no_delete BEFORE DELETE ON assessment_review_events BEGIN SELECT RAISE(ABORT,'assessment review history is immutable'); END;

CREATE TRIGGER IF NOT EXISTS risk_assessment_records_sealed_update
    BEFORE UPDATE ON risk_assessment_records
    BEGIN SELECT RAISE(ABORT, 'A recorded risk assessment cannot be changed.'); END