# CLAUDE.md

Guidance for AI agents working in this repo. Depth lives in [`README.md`](README.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — read those before non-trivial changes. This file is the short, must-know layer.

## What this is

Google Apps Script + Google Sheets automation for Dhamma Sudha Vipassana Centre. It collects donor PAN numbers and pushes them back to the centre's dana portal (Drupal 7 behind Cloudflare) so 80G tax-exemption certificates can be issued. No server, no hosting — everything runs in Apps Script. Audience: a 1–3 person non-technical admin team.

## Data is sensitive (NPI/PII)

Donor names, emails, mobiles, PAN, donation amounts, and `id_value` (Aadhaar/Passport/etc.) are personal/financial data.
- Never paste donor data, PAN, `DANA_*`/`WA360_*` credentials, or Script Property values into web searches, external tools, commits, filenames, or summaries. Use placeholders (`<donor>`, `<pan>`, `<donation_id>`).
- PAN is masked (`ABCDE****F`) everywhere except `pan_collected`, `submissions.pan`, and the `ready_for_80g` export. Keep it that way — see `maskPAN` / `maskPanInText_`.
- All config/secrets live in Apps Script **Script Properties**, never in git. Nothing in the repo should contain a secret.

## Build / deploy

```bash
clasp push                 # push code; runs immediately for non-web-app functions
clasp login                # one-time auth
```
- Web-app changes (`Code.gs` doGet/submitForm, `Form.html`): `clasp push` then Apps Script editor → Deploy → Manage deployments → New version. URL is stable across versions.
- Drive API v2 advanced service must be enabled in the editor (Services → Drive API v2).
- Triggers (hourly write-back, reminders, monthly import) are installed via the `80G Admin` menu / editor Triggers, not in code at startup. Donation Day mode (menu 5) installs a 10-min `donationDayTick` trigger that self-expires after 3h (`DONATION_DAY_UNTIL` Script Property) and removes the hourly email/nudge triggers at enable (not auto-restored).
- Tests: run `runAllTests` from the editor (PAN + token logic only; no live dana/network tests exist).
- **After any commit that changes code, refresh the knowledge graph** in `graphify-out/` (gitignored). ⚠️ Do NOT run the bare `graphify update .` CLI here — stock graphify doesn't recognise `.gs` and silently drops every Apps Script file from the graph. Rebuild via the graphify skill pipeline with the `.gs` runtime patch applied (`CODE_EXTENSIONS.add('.gs')` + `_DISPATCH['.gs'] = _DISPATCH['.js']`); see `docs/DECISIONS.md` → graphify entry. Incremental and free — only re-analyzes changed files. For doc-only commits, use `/graphify --update` in an AI assistant session instead (LLM pass; code-only update won't pick up markdown semantics). Never delete `graphify-out/cache/` (it's what makes updates cost 0 API tokens). For orientation, read `graphify-out/GRAPH_REPORT.md` (~6 KB whole-repo summary) before reading raw `.gs` files; it records the commit it was built from, so check staleness against `git rev-parse HEAD`. Details: `docs/GRAPHIFY.md`.

## File map

| File | Role |
|------|------|
| `Code.gs` | Web app entry (`doGet`), `submitForm`, `initSheets`, `migrateSchema`, `getSpreadsheet` |
| `Utils.gs` | `generateToken`/`validateToken` (HMAC), PAN validate/normalize/mask, `auditLog`, `getOrCreateSheet` |
| `DanaImport.gs` | All dana login + report fetch + XLS→Sheet parse + receipt→donation_id mapping + import |
| `WriteBack.gs` | Push PAN back to dana (`/donation/edit/{id}`), candidate selection, pre-flight safety, trigger mgmt |
| `Email.gs` | Donor emails + reminders via `MailApp` |
| `Whatsapp.gs` | Outbound WhatsApp via 360dialog (link campaign + email-nudge campaign); `wa_log`/`wa_nudge_log` |
| `Admin.gs` | `onOpen` menu, `refreshAdminReview`, `exportReadyFor80G` |
| `DonationDay.gs` | Donation Day mode: 10-min tick (import → emails → WA nudges), self-expires after 3h |
| `Tests.gs` | Unit tests |
| `Form.html` / `ImportDialog.html` | Donor PAN form / admin import modal |
| `docs/GRAPHIFY.md` | Knowledge-graph tooling: setup prompt, `graphify update .` workflow, token economics |
| `docs/DECISIONS.md` | Running log of non-obvious decisions & design patterns (read before changing trigger/send logic) |

Sheets: `donors_input` (26 cols A–Z, PK `receipt_no`), `submissions`, `email_log`, `audit_log`, `import_log`, `wa_log`, `wa_nudge_log`, `ready_for_80g`. Column layout in README → Data Model.

## Critical gotchas (do not relearn the hard way)

- **`donors_input` is referenced by column index everywhere.** Never reorder A–Z. To add a column, update `initSheets`, `migrateSchema`, `processRows_`, and every index-based reader (Admin/WriteBack/Code). Cols of note: Q=`id_type`, S=`pan_collected`, U=`pan_status`, Y=`dana_donation_id`, Z=`dana_updated_at`.
- **Token scheme is `HMAC(email)` only.** Changing `TOKEN_SECRET` or the format breaks every outstanding donor link. Use `<?!= JSON.stringify(token) ?>` (force-print) in `Form.html` — `<?= ?>` corrupts the base64 token.
- **dana is Drupal 7 + Cloudflare.** Every request needs the `DANA_USER_AGENT` Chrome UA header or Cloudflare 403/503s. Login is 3-step (GET form_build_id → POST creds → SSESS cookie). Report fetch needs a POST (`op=Get Report`) before the XLS URL is valid.
- **Write-back overrides `d_id_type=1`, `d_id_no=pan`, and posts `email=0`/`whatsapp=0`** (notification suppression — assumption flagged in code; verify field names before large batches). All other edit-form fields are read from the GET and re-POSTed unchanged.
- **Required `<select>` fields replay the browser default, not blanks.** For unset required selects (see `DANA_REQUIRED_FIELDS`, currently `d_course`), write-back submits the *first option's* value to match what a browser would POST — this fixed the `d_course` NOT-NULL `PDOException` (1048). A first option like `Non Course` (`value="0"`) is a real choice and is POSTed; only genuine placeholders (`- Select -`) count as unset and trip a `SKIP:` instead. Don't "fix" this by forcing `value=""`.
- **Write-back is idempotent and self-skipping**: skips rows with `dana_updated_at` set, rows where dana live-shows `id_type=PAN` (`ALREADY_PAN`), and rows failing the required-field pre-flight (`SKIP:`). `SKIP:`/`ALREADY_PAN` do not trip the consecutive-error circuit breaker; only real failures do.
- **Use `diagnoseDanaWriteBack(donationId)`** (GET-only, PAN-masked, no writes) to root-cause any single record's write-back behavior.

## Conventions

- Terse, no speculative abstraction. Match the existing `.gs` style (V8 runtime, `const`, trailing `_` for private functions).
- Every state-changing action appends to `audit_log` via `auditLog(...)`. Keep new writes auditable and PAN-masked.
- Run `previewWriteBackToDana` (dry run) before any real push.
