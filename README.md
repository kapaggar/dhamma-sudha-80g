# Dhamma Sudha 80G

Google Apps Script and Google Sheets automation for Dhamma Sudha Vipassana Centre.
It collects donor PAN details, updates the centre's dana portal, and prepares an
80G export. The dana portal generates and delivers certificates; this repository
does not generate PDFs or determine a donor's tax eligibility.

Production runs in a spreadsheet-bound Apps Script project. A small admin team
works through the **80G Admin** spreadsheet menu; donors use personal signed links.
There is no production Node server or separate hosting service.

- [Local development](#local-development) and [Google setup](#google-setup)
- [Data model](#data-model), [configuration](#configuration), and [deployment](#deployment)
- [Architecture](docs/ARCHITECTURE.md), [decisions](docs/DECISIONS.md), and [review evidence](docs/REVIEW.md)
- [Contributing](CONTRIBUTING.md), [security reporting](SECURITY.md), and [agent guidance](AGENTS.md)

## Workflow

1. **Import:** fetch a dana report or upload an XLS/XLSX file. Deduplicate by receipt
   number, validate PAN, and reuse a valid PAN for repeat donors with the same email.
2. **Contact:** group pending receipts by donor email and send one signed form link.
   Optional WhatsApp campaigns send a direct link or a separate email nudge.
3. **Collect:** display donor details and receipts, require explicit consent, and
   save a validated PAN for all pending receipts associated with that email.
4. **Write back:** preview eligible records, then update dana while preserving
   unrelated live edit-form fields and recording the result.
5. **Review/export:** refresh the masked admin review or generate `ready_for_80g`
   with validated, full PAN values for the centre's certificate workflow.

Row status follows validated PAN availability before email availability:

| Status | Meaning |
|---|---|
| `have_pan` | A valid-format PAN is available, including when email is absent |
| `need_pan` | PAN is missing or invalid and an email is available for collection |
| `no_email` | PAN is missing or invalid and there is no email for collection |

PAN validation checks format, not ownership or government records. Historical
rows are not automatically cleaned up by a code deployment.

## Repository map

| File | Responsibility |
|---|---|
| `Code.gs` | Web entry point, submission, sheet initialization and schema migration |
| `Utils.gs` | Admin authorization, HMAC tokens, PAN validation/masking, audit helpers |
| `DanaImport.gs` | Portal login/report fetch, REST XLS conversion, receipt mapping, import locking |
| `WriteBack.gs` | Candidate selection, live-form preflight, write-back and diagnostics |
| `Email.gs` | Initial email, reminders, per-run limits and email triggers |
| `Whatsapp.gs` | 360dialog link/nudge campaigns, limits and separate campaign logs |
| `Admin.gs` | Spreadsheet menu, admin review and 80G export |
| `DonationDay.gs` | Temporary import/email/nudge schedule with automatic expiry |
| `Form.html` / `Message.html` | Donor form and status/error screens |
| `ImportDialog.html` / `UploadDialog.html` | Admin date-range and file-import dialogs |
| `UiStyles.html` | Shared local, responsive styles |
| `Tests.gs` / `tests/*.cjs` | Editor tests, offline regressions and synthetic preview |
| `appsscript.json` | Apps Script runtime, scopes, web-app settings and fetch whitelist |
| `AGENTS.md` / `CLAUDE.md` | Shared agent guidance and Claude entry point |

## Local development

The offline suite and preview require Node.js 18+ and no npm dependencies. Use a
supported Node.js LTS release; current [clasp requires Node.js 22+](https://github.com/google/clasp#nodejs-version)
when working with Google deployments.

```bash
git clone https://github.com/kapaggar/dhamma-sudha-80g.git
cd dhamma-sudha-80g
node --test tests/*.test.cjs
node tests/preview.cjs
```

Open [the local preview](http://127.0.0.1:8787/). It uses synthetic fixtures and a
mock browser/server bridge; it cannot access Sheets or send messages.

| Preview route | State |
|---|---|
| `/` | Donor PAN form |
| `/?state=received` | Already-received screen |
| `/?state=empty` | No pending receipts |
| `/?outcome=failure` / `/?outcome=empty` | Submission error recovery |
| `/import` / `/upload` | Admin import dialogs |
| `/invalid` | Invalid-link screen |

The offline suite covers authorization boundaries, token/PAN logic, import and
write-back safeguards, and browser handlers. `runAllTests` also runs a smaller
suite in the bound Apps Script editor or **80G Admin → Run Tests**. Neither replaces
live integration validation. See [docs/REVIEW.md](docs/REVIEW.md) for evidence and
remaining checks; do not test releases by messaging real donors.

## Google setup

Use a separate development spreadsheet and bound Apps Script project with synthetic
data. A fresh clone may contain a `.clasp.json` project link: inspect and replace
it with your own project before any push.

1. Install [clasp](https://github.com/google/clasp) and run `clasp login`. Enable
   the Apps Script API in [user settings](https://script.google.com/home/usersettings).
2. In the target spreadsheet, open **Extensions → Apps Script**. Copy the script ID
   and set the local `.clasp.json` to `{"scriptId":"YOUR_SCRIPT_ID","rootDir":"."}`.
   The project must remain bound to this spreadsheet; a standalone project does
   not satisfy the admin authorization guard.
3. Run `clasp push` to upload the source. Review the manifest before accepting any
   overwrite prompt. Keep credentials outside git.
4. In **Project Settings → Script Properties**, set the required configuration
   below. For a new installation, generate a new `TOKEN_SECRET` with
   `openssl rand -hex 32` and paste the output privately. Preserve the existing
   secret when updating an installation.
5. Reload the spreadsheet and use **80G Admin → Initialize All Sheets** for a new
   installation. For an older schema missing Y/Z, use **Migrate Schema**. Never
   reorder existing columns.
6. Create a web-app deployment with **Execute as: Me** and **Who has access: Anyone**.
   Save its `/exec` URL as `WEB_APP_URL`. Future releases update this deployment.
7. Verify the developer/admin and anonymous donor contexts before enabling any
   sending or write-back schedules.

There is no Drive advanced service to enable. XLS conversion uses the Drive REST
API with the narrow `drive.file` scope; do not add `DriveApp` or `Drive.Files.*`.

## Configuration

All runtime configuration lives in Apps Script **Script Properties**. Project
editors can access those values through script code, so limit spreadsheet/script
edit access to trusted admins. No configuration values belong in git, screenshots,
issues, or logs. The tables list property names and source-code defaults only.

| Property | Requirement / purpose |
|---|---|
| `SHEET_ID` | Required: ID of the bound spreadsheet |
| `TOKEN_SECRET` | Required secret: HMAC signing key; changing it breaks existing donor links |
| `CENTER_NAME` | Optional display name; defaults to Dhamma Sudha Vipassana Centre |
| `WEB_APP_URL` | Required for sending links; existing versioned deployment's `/exec` URL |
| `DANA_URL` | Required for portal operations; host must be in `urlFetchWhitelist` |
| `DANA_USER` / `DANA_PASS` | Required for portal operations; username and base64-encoded password |
| `ADMIN_EMAIL` | Optional recipient for trigger-failure alerts; otherwise inspect execution logs |
| `EMAIL_MAX_PER_RUN` | Positive integer; default 10, with daily-quota checks |

`DANA_PASS` base64 encoding is only for screen-share hygiene, not encryption. Encode
the password without a trailing newline using a private local workflow; do not put
password literals into shell history or commit them as examples.

Optional WhatsApp configuration:

| Property | Purpose / source-code default |
|---|---|
| `WA360_URL` / `WA360_API_KEY` | Provider endpoint and secret API key; required for WhatsApp sends |
| `WA_API_VERSION` | `v2` by default; `v1` is also supported by the payload builder |
| `WA360_NAMESPACE` | Namespace for v1 templates, when required |
| `WA_TEMPLATE_NAME` / `WA_TEMPLATE_LANG` | Approved direct-link template; language defaults to `en` |
| `WA_NUDGE_TEMPLATE_NAME` / `WA_NUDGE_LANG` | Nudge template defaults to `status_update_2`; language `en` |
| `WA_NUDGE_SUBJECT` / `WA_NUDGE_STATUS` | Nudge text; defaults describe the 80G request and PAN pending |
| `WA_MAX_PER_RUN` | Positive integer; default 50 |
| `WA_MIN_AMOUNT` | High-value direct-link campaign threshold; default 10000 |

Confirm templates are approved for the configured WhatsApp account before sending.
`DONATION_DAY_UNTIL` and `DONATION_DAY_ERR_MAILED_AT` are maintained by Donation Day mode;
use its menu actions instead of manually changing those values.

## Data Model

### `donors_input` (26 columns, A-Z)

One row per dana transaction. Primary key: `receipt_no`.

| Col | Field | Notes |
|-----|-------|-------|
| A | receipt_no | Primary key; dana receipt number |
| B | txn_date | Date money received (YYYY-MM-DD) |
| C | created_on | Date donation slip created in dana |
| D | full_name | Donor name from dana |
| E | email | Lowercased |
| F | mobile | From dana |
| G | address | |
| H | city | |
| I | state | |
| J | country | |
| K | course | "10 Day Course", "Non Course", etc |
| L | category | "Construction Dhamma Sudha", "Camp Conducting", etc |
| M | txn_type | From dana |
| N | payment_mode | Cash/Cheque/Razorpay/UPI SBI/etc (first non-zero payment col) |
| O | amount | Sum of all payment columns |
| P | merchant_ref | UPI/Razorpay transaction reference |
| Q | id_type | As-is from dana: "PAN", "Aadhaar", "Passport", "" |
| R | id_value | The ID value from dana; PAN is masked on new imports |
| S | pan_collected | Validated PAN from submission, source PAN, or repeat-donor auto-fill |
| T | pan_name | Stored PAN-record name; submission uses existing full_name |
| U | pan_status | `need_pan` / `have_pan` / `no_email` |
| V | comment | From dana |
| W | imported_at | ISO timestamp of dana import |
| X | pan_submitted_at | ISO timestamp when donor submitted the form |
| Y | dana_donation_id | Dana's internal numeric ID (from HTML parsing of /donation-report) |
| Z | dana_updated_at | ISO timestamp when PAN was pushed back to dana portal |

### `submissions` (12 columns)

One row per PAN form submission. A submission can update multiple donors_input rows (all `need_pan` rows for that email).

| Field | Notes |
|-------|-------|
| submission_id | UUID |
| email | Submitting donor's email |
| mobile | |
| pan | Normalized PAN |
| pan_name | Donor name (from donors_input full_name, uppercased) |
| receipt_nos | Comma-separated list of receipt_nos updated |
| receipt_count | Count of receipts updated |
| consent_timestamp | ISO timestamp |
| source_link_token | The signed token from the form URL |
| created_at / updated_at | |
| notes | |

### `email_log` (7 columns)

One row per donor email address (not per receipt). Tracks whether an email was sent and whether the donor has submitted.

| Field | Notes |
|-------|-------|
| email | |
| receipt_nos_in_email | Comma-separated receipts included in the email |
| sent_at | |
| email_status | "sent" or "failed: {error}" |
| reminder_count | 0, 1, or 2 |
| submitted_at | Set when donor submits form |
| last_reminder_at | |

### `audit_log` (8 columns)

Operational audit trail. PAN is masked, but receipt/email references still make this sheet sensitive. Actor examples: `form_submit`, `danaImport`, `sendPendingEmails`, `sendReminders`, `writeBack`, `system`.

| Field | Notes |
|-------|-------|
| timestamp | ISO |
| actor | Function name |
| action | `pan_collected`, `email_sent`, `bulk_insert`, `dana_updated`, etc |
| record_key | receipt_no or email |
| field_changed | |
| old_value | PAN masked; prior identity values redacted during write-back |
| new_value | |
| source_id | submission_id, donation_id, etc |

### `import_log` (10 columns)

One row per dana import run (manual or auto).

### `ready_for_80g`

Generated export sheet. Regenerated on demand via `80G Admin → Export Ready for 80G`. Includes only `have_pan` rows whose PAN passes format validation, with full (unmasked) PAN. Restrict access to the sheet and downloaded exports.


### `wa_log` and `wa_nudge_log` (9 columns each)

Separate logs for direct PAN-link campaigns and email-nudge campaigns. Both store
`phone`, `email`, `receipt_nos_in_wa`, `sent_at`, `wa_status`, `wa_message_id`,
`reminder_count`, `submitted_at`, and `last_reminder_at`. A nudge must not suppress
an eligible direct-link message by sharing its campaign log.

### `admin_review`

Regenerated, color-coded review of ready, pending, overdue, and no-email records.
PAN is masked here. Refresh it through **80G Admin → Refresh Admin Review**.


## Operational safeguards

### Donor links and admin access

`generateToken_` signs the lowercased, trimmed email with HMAC-SHA256:

```text
base64url(email) + "." + hex(HMAC-SHA256(email, TOKEN_SECRET))
```

Tokens are deterministic and do not expire. `doGet` and `submitForm` validate them
on the server. Treat a signed link as sensitive access to that donor's form. Keep
`<?!= JSON.stringify(token) ?>` in the template, and never log supplied or expected
tokens. `submissions.source_link_token` currently retains the submitted token, so
submission-sheet access also requires protection.

Sensitive helpers (`generateToken_`, `readProp_`, `getSpreadsheet_`) use the
[private trailing-underscore convention](https://developers.google.com/apps-script/guides/html/communication#private_functions).
Every public admin action checks `requireAdminContext_` before side effects. The
active spreadsheet must match `SHEET_ID`, plus either spreadsheet UI access or a
native installed clock event must be present. An anonymous browser callback can
retain the bound container, so container lookup alone is not authorization.
Preserve native enum comparison and event forwarding in trigger handlers.

### Import and submission

- Server checks enforce real ordered dates, XLS/XLSX extensions, non-empty uploads,
  and a 10 MB limit. Uploaded content is converted through the Drive REST API and
  the temporary sheet is deleted after processing.
- The shared receipt read/dedup/append phase is locked and flushed together;
  portal fetch and conversion run outside the lock. Re-import skips known receipts.
- Valid PANs from existing rows or anywhere in the same report can fill repeat
  donors; malformed values are never propagated as valid PAN.
- A form submission requires boolean consent, preflights its storage, and locks
  updates across all matching pending receipts. Repeated submissions do not create
  another successful submission when no pending rows remain.

### Messaging and reminders

Initial email groups pending receipts by email, respects the configured per-run
cap and remaining MailApp quota, and retries failed initial sends. It does not
skip an address merely because a failed row exists in `email_log`.

At most two reminders are sent: the first after at least 3 days from the successful
initial email, and the second after at least 7 days from the first reminder. Actual
send times depend on the schedule and quota. Reminders stop when PAN is no longer
needed or a submission is recorded. Direct WhatsApp links and email nudges have
separate logs and provider limits.

### Dana write-back

Run **80G Admin → 3. Push PAN to Dana → Preview (dry run)** before a real push.
Preview does not edit dana or sheet records. It may log in and fetch a report to
resolve missing donation IDs; it does not validate each live edit form.

Candidates have `have_pan`, a collected PAN, and no `dana_updated_at`. Records
already imported with valid source PAN are excluded; invalid source PAN can be
repaired. Receipt mapping stays within one HTML table row; ambiguous/conflicting
mappings are omitted.

A real push locks candidate selection and updates, validates PAN, reads the live
edit form, and preserves unrelated fields. It sets `d_id_type=1`, `d_id_no=pan`,
and `email=0` / `whatsapp=0`. These notification-suppression field names remain an
assumption to verify before large batches. Required selects accept real defaults
such as `Non Course` with value `0`, but reject placeholder labels and empty values.

Valid live PAN produces `ALREADY_PAN`; missing required fields produce `SKIP:`.
These outcomes do not count as consecutive errors. The batch limit is 50 and the
circuit breaker stops after 3 consecutive real failures. A transient 5xx edit
response gets one fresh GET/POST retry; a 4xx or HTTP 200 validation rejection does
not. Successful edits expect HTTP 302 and record `dana_updated_at` plus an audit entry.

Use `diagnoseDanaWriteBack(donationId)` with its default behavior for GET-only,
PAN-masked diagnosis. The optional POST probe is a real write and is not part of
routine read-only diagnosis.

## Deployment

A Git push publishes repository changes; `clasp push` updates Google Apps Script.
They are separate actions. Before an authorized release:

1. Run offline checks and review the intended files. Compare Google's saved source
   with the repository baseline so direct editor changes are not overwritten.
2. Confirm the target project, then `clasp push`. `.claspignore` includes only root
   `*.gs`, `*.html`, and `appsscript.json`; docs and local tests are excluded.
3. Create a version and update each active web-app deployment to it through
   **Deploy → Manage deployments**. Updating existing deployments preserves URLs;
   older public deployments retain old code until separately updated or retired.
4. Verify saved/deployed source, anonymous access rejection for admin actions, and
   the appropriate spreadsheet/trigger contexts. Use synthetic data for tests.

Menu functions and installed triggers use saved source after `clasp push`; public
web-app URLs use their assigned versions. A security fix shared by these paths
needs both updates. Documentation-only commits need no Apps Script deployment.

Preserve the manifest's scopes and `urlFetchWhitelist`. External calls are limited
to the configured dana portal, 360dialog, and Google API hosts. Scope changes may
require reauthorization. Apps Script and provider quotas still apply; consult
[Google's current quotas](https://developers.google.com/apps-script/guides/services/quotas)
when planning batches.

### Time-based triggers

Triggers are installed explicitly and survive routine redeployments. Do not
recreate them on startup or reset schedules as part of a code-only release.

| Job | Handler | Installation |
|---|---|---|
| Monthly import | `autoImportMonthly` | Editor Triggers: time-driven, **Month timer**, chosen day/time |
| Daily reminders | `sendReminders` | Editor Triggers: time-driven, **Day timer**, chosen time |
| Hourly PAN push | `autoWriteBackHourly` | Menu 3 → Enable Hourly Auto-Push |
| Hourly initial email | `autoSendEmailsHourly` | Menu 2 → Enable Hourly Email Sending |
| Hourly WhatsApp links | `autoSendWhatsAppHourly` | Menu 4 → Enable Hourly Link Sending |
| Hourly email nudges | `autoSendWhatsAppNudgeHourly` | Menu 4 → Enable Hourly Nudge Sending |
| Donation Day | `donationDayTick` | Menu 5 → Enable (3h, every 10 min) |

The manifest time zone is `Asia/Kolkata`. Donation Day imports, sends pending
emails, and sends WhatsApp nudges every 10 minutes. It expires at its 3-hour
deadline and removes its trigger. Enabling it removes hourly email/nudge triggers;
those are not automatically restored. Re-enable them deliberately if needed.

## Known limitations

- Cloudflare challenges or changed Drupal markup can interrupt portal operations.
  The XLS upload dialog is the manual import fallback; uploaded reports do not
  include HTML receipt-to-donation-ID mappings, so write-back may fetch them later.
- Offline tests do not verify the complete live donor-to-portal workflow. The
  [review](docs/REVIEW.md) describes what has and has not been exercised.
- PAN is not encrypted at the application layer in its permitted storage columns.
  Masked logs and views can still contain donor identifiers and need restricted access.
- No automatic token expiry, per-donor link revocation, or donor-form rate limiter
  is implemented. Historical rows/logs and the stored submission token are not
  removed by deploying a fix. Retention and cleanup require a separate decision.
- Export currently includes all eligible rows; financial-year filtering and a
  monthly-trigger installer menu are not implemented.

## Troubleshooting

| Symptom | Check / action |
|---|---|
| Admin action says it requires the bound spreadsheet | Open the configured Sheet's menu/editor; verify `SHEET_ID`. Anonymous rejection is expected. Preserve native events for clock handlers. |
| Missing `SHEET_ID`, `TOKEN_SECRET`, or `WEB_APP_URL` | Configure Script Properties privately; preserve the signing secret on existing installations |
| Cloudflare 403/503 or HTML instead of XLS | Retry the import; use the XLS/XLSX upload fallback if it persists |
| Missing receipt column or donation-ID mapping | Check report headers/table structure; do not guess IDs across rows |
| Missing Y/Z columns | Use **80G Admin → Migrate Schema**; preserve A-Z order |
| Invalid donor link | Reopen the original link; check secret continuity and force-printed token template without logging token values |
| Already submitted / no pending requests | Check row status; one submission covers all pending receipts for that email |
| Edit POST returns 200 instead of 302 | Use masked GET-only diagnosis for live required-field/validation failures |
| Drive permission error | Use the REST conversion helpers, not the advanced service or `DriveApp` |
| Trigger fails silently | Inspect Apps Script executions; set `ADMIN_EMAIL` for supported failure alerts |

## Maintenance and community

Keep column indexes, token bytes, trigger handler names, and audit masking stable.
Update [AGENTS.md](AGENTS.md) for operational rules and
[docs/DECISIONS.md](docs/DECISIONS.md) for non-obvious changes. After committing,
refresh `graphify-out/` through the graphify skill with the `.gs` runtime patch.
Do not run bare `graphify update .` here. Preserve the cache; changed documents and
HTML need semantic extraction, which can consume tokens. See [docs/GRAPHIFY.md](docs/GRAPHIFY.md).

Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through
[SECURITY.md](SECURITY.md), not a public issue. The software is available under the
[MIT License](LICENSE); the license is not permission to access production donor data.
