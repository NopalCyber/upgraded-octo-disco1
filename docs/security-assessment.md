# Security assessment

Scope: this repository (ISO 27001 ISMS, third-party risk management and the client portal), assessed before handover. Every finding below was fixed or is listed under residual risk; nothing high or critical is open.

## How it was assessed

| Method | Tool and configuration | Where it runs |
|---|---|---|
| Static analysis (SAST) | Semgrep 1.136.0 with the `p/javascript`, `p/nodejs`, `p/expressjs`, `p/owasp-top-ten` and `p/secrets` rule packs | CI job `sast`: any finding fails the build |
| Dependency audit | `npm audit --omit=dev --audit-level=high` | CI job `test` |
| Dynamic analysis (DAST) | OWASP ZAP 2.17.0 baseline scan (spider plus passive rules) against the production container, rules in `.zap/rules.tsv` | CI job `container-smoke`: a FAIL rule breaks the build; the report is uploaded as an artifact |
| Manual review | Template output escaping, redirects, file serving, cryptography, session and cookie settings, authorisation boundaries, audit logging | This assessment |

## Findings and fixes

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Vulnerable dependencies: six high and two moderate advisories, including a sanitize-html bypass that could let script through document sanitisation, quadratic-time parsing in markdown-it, a body-parser denial of service and nodemailer address parsing | High | Fixed: updated within the existing version ranges; `npm audit` reports 0 |
| 2 | Stored XSS through inline scripts: 12 templates wrote server data into `<script>` with `JSON.stringify`, so a user name, control title, methodology label or report body containing `</script>` could run script | High | Fixed: `jsonForScript` (lib/http-helpers.js) escapes `<`, `>`, `&`, U+2028 and U+2029 and is used in every inline script |
| 3 | Stored XSS in the executive brief headline: the client name was written unescaped | Medium | Fixed: escaped |
| 4 | Open redirect after sign-in: `?next=//other-site` passed the "starts with /" check | Medium | Fixed: only same-site paths are honoured; regression test in tests/security.test.js |
| 5 | Back-redirects followed any `Referer` | Low | Fixed: same-site only, otherwise the dashboard |
| 6 | Evidence preview served SVG inline on the app's origin; SVG can carry script | Medium | Fixed: only passive types (images, PDF, text) render inline, under a `sandbox` Content-Security-Policy with `nosniff`; everything else downloads; filenames are RFC 6266 encoded |
| 7 | AES-256-GCM decryption accepted truncated authentication tags (field encryption, key rotation, backup restore checks) | Medium | Fixed: tag length pinned to 16 bytes; a truncated tag is now rejected |
| 8 | No `Permissions-Policy` header | Low | Fixed: camera, microphone, geolocation, payment and other device APIs denied |
| 9 | CI supply chain: GitHub Actions referenced by mutable tags | Low | Fixed: every action pinned to a commit SHA |
| 10 | Audit logging gaps: sign-in, password reset, user and tenant administration, and deletion of internal audits, management reviews, nonconformities and improvements left no audit record; tenant actions were never logged because the logger was not wired into that module | Medium | Fixed: see Audit logging below |
| 11 | Invitation and password-reset links were put in the redirect URL when the email failed to send, exposing them in browser history and access logs | Medium | Fixed: the link is held in the session and shown once on the user-management page |
| 12 | Audit records and document signatures took the client address from the first `X-Forwarded-For` entry, which the client controls, so a forged header could falsify the recorded IP | Medium | Fixed: the address Express resolves through the one trusted proxy (`req.ip`) is recorded; regression test in tests/security.test.js |
| 13 | The readiness probe ran the malware scanner's version check synchronously on every call, blocking the event loop | Low | Fixed: the result is reused for a minute |

## Audit logging

Every handler that changes data now writes an `audit_log` row (hash-chained, with IP, user agent and request id):

- Sign-in: `login_succeeded`, and `login_failed` with a reason (unknown account, inactive, wrong password, locked out); the password is never recorded and a failed attempt does not count as the account's activity. `logout`, `password_reset_requested` (the token is never recorded), `password_reset_completed`, `invitation_accepted`.
- User administration: `invite_user`, `deactivate_user`, `reactivate_user`, `send_password_reset`, `revoke_invitation`, alongside the existing `create_consultant` and `change_firm_role`.
- Tenants: `create_firm`, `rename_firm` (old and new name), `switch_firm`, `delete_firm` (written inside the deletion so it survives the sweep), `skip_onboarding`, `complete_onboarding`.
- Platform administration: `send_test_email`, `run_jobs`, `update_email_settings`.
- Governance: updates to internal audits, sampling, samples and findings, improvements; deletions of internal audits, samples, management reviews, nonconformities and improvements record what was deleted, in the same transaction as the delete.
- TPRM monitoring connectors additionally keep their own hash-chained trail (`tprm_monitoring_connector_audit`).

Tests in `tests/security.test.js` cover sign-in logging (no password stored, failed attempts on the chain), audit deletion, tenant rename and tenant deletion.

## Reviewed and accepted (false positives)

Twenty-one Semgrep findings were reviewed and marked in code with a `nosemgrep` comment and the reason:

- SQL built with template strings (8): seven interpolate only `?` placeholders, a fixed column or table name from a lookup map, or fixed SQL from `lib/client-work-policy`, with values always bound; the eighth is a hash input for an idempotency key, not SQL.
- `res-render-injection` (5): markdown or report placeholders rendered to HTML and then sanitised or escaped; none chooses a view name.
- Session cookie settings (4 rules on one statement): the cookie is `httpOnly`, `sameSite=lax`, `secure` in production, host-only with `Path=/`, and expires through `maxAge`.
- Inline HTML string (1): both values are escaped and the result is sanitised.
- `res.sendFile` on the evidence preview (1): the path comes from `resolveUploadPath`, which confines it to the firm's upload partition.
- A bcrypt hash literal (1): a deliberately invalid hash so unknown accounts still cost one comparison and response time does not reveal which emails exist.
- `path.join` with a firm id (1): the id is a parsed integer.

## Controls verified

- Authorisation: role-based permissions with per-user overrides; client accounts are confined to the client portal; tests cover role boundaries, cross-tenant access and evidence/export permissions.
- Tenant isolation: workspace-scoped queries throughout; cross-workspace access tests pass.
- Audit trail: append-only `audit_log` with a hash chain (`verifyAuditChain`); TPRM monitoring keeps its own hash-chained trail.
- Encryption: per-workspace AES-256-GCM keys derived with HKDF from a master key supplied by environment variable or key file.
- Uploads: extension allowlist, content-signature checks and ClamAV scanning (`UPLOAD_AV_MODE=required` in production).
- Headers: Content-Security-Policy, HSTS in production, `X-Content-Type-Options`, frame-ancestors `'self'`, Referrer-Policy and Permissions-Policy.

## Residual risk and recommendations

1. **CSP allows inline script.** The views use inline event handlers, so `script-src` includes `'unsafe-inline'` (ZAP rule 10055, kept as a warning). Moving handlers into script files and adding per-request nonces would remove it; the escaping fixes above close the known injection paths in the meantime.
2. **DAST covers the public surface only.** The CI scan is unauthenticated. An authenticated ZAP scan, ideally including active rules in a staging environment, is the next step.
3. **Cross-Origin-Embedder-Policy is off** on purpose, because `require-corp` would block the embedded PDF and editor resources (ZAP rule 90004, ignored).
4. **Single-instance database.** SQLite supports one application instance; the Postgres port removes that limit.
5. **Firm-level audit rows have no screen yet.** Sign-in, tenant and platform-administration rows are not tied to a client workspace, and every audit view filters by workspace, so they are only in the table for now. A firm-level activity view is a small follow-up.
6. **Deleting a firm breaks the audit hash chain.** The firm sweep removes that firm's workspace audit rows, so `verifyAuditChain` reports a broken link afterwards. Archiving instead of deleting, or re-anchoring the chain after a sweep, would fix it.
7. **Secrets.** `SESSION_SECRET` and `ISMS_MASTER_KEY` must come from a secrets manager in production; losing the master key makes encrypted fields unrecoverable, so back it up separately from the database.
