# Dhamma Sudha 80G

Automated workflow to collect donor PAN details and push them back to the dana portal, enabling the generation of 80G donation certificates under the Indian Income Tax Act.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the detailed architecture reference.

---

## What This Project Does

**The problem:** Dhamma Sudha Vipassana Centre receives donations through their dana portal (Drupal 7, `sudha.dana.vridhamma.org`). Around 80-90% of donors submit Aadhaar, Passport, or no ID instead of a PAN card. Without PAN, the centre cannot issue 80G tax-exemption certificates to donors.

**Who it is for:** The centre's administrative team (1-3 people). Not a public-facing app in the traditional sense - the only public surface is the PAN submission form, which is locked to specific donors via signed links.

**What it does:**
1. **Imports** donation records automatically from the dana portal (scheduled or manual)
2. **Identifies** donors who need PAN - those without `id_type = PAN` in the dana export
3. **Emails** each donor a personalized, signed link to a secure PAN submission form
4. **Collects** PAN via a web form (Google Apps Script Web App), validating format on both client and server
5. **Pushes** the collected PAN back to the dana portal by programmatically editing each donation slip
6. **Exports** a clean dataset ready for 80G certificate generation

**What it does NOT do:** Generate the actual 80G PDF certificates. The dana portal handles certificate generation and delivery (PDF + WhatsApp/email) once the PAN is in the system.

---

## Current Status

**Prototype / partially production-ready.**

- Core flows (import, email, form submission) are working.
- Write-back to dana portal (`WriteBack.gs`) is implemented but should be dry-run tested on real data before enabling the hourly trigger.
- No automated tests for the dana integration (login, import, write-back) - these require live credentials.
- The dana portal runs behind Cloudflare, which may block Apps Script requests intermittently. A manual XLS upload fallback exists.
- 80G certificate generation is out of scope - the dana portal handles that.

**Known gaps:**
- `DANA_PASS` is base64-encoded in Script Properties for screen-share hygiene only; this is not encryption.
- `receipt_no → donation_id` mapping for old records (imported before `WriteBack.gs` was added) requires a re-fetch during write-back.
- No retry logic if a single write-back POST fails (circuit breaker stops after 3 consecutive errors).
- Monthly auto-import trigger must be manually installed via `80G Admin → Enable Hourly Auto-Push`.

---

## Architecture Overview

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full diagram and component breakdown.

**High-level:**

```
dana portal (Drupal 7)
  ├── import: POST /donation-report → XLS → Drive API convert → parse
  └── write-back: GET+POST /donation/edit/{id}

Google Apps Script
  ├── DanaImport.gs    — fetch, parse, dedup, import to Sheets
  ├── Email.gs         — send HTML emails via MailApp
  ├── Code.gs          — web app (doGet + submitForm)
  ├── WriteBack.gs     — push PAN back to dana
  ├── Admin.gs         — Sheets menu + admin review + export
  └── Utils.gs         — tokens, PAN validation, audit log

Google Sheets (6 active sheets)
  ├── donors_input     — one row per dana transaction (26 cols)
  ├── submissions      — one row per PAN form submission
  ├── email_log        — tracking initial emails and reminders
  ├── audit_log        — every action logged
  ├── import_log       — every dana import run
  └── ready_for_80g    — export view: have_pan rows with full PAN

Web App (Apps Script, anonymous access)
  └── Form.html + ImportDialog.html

External services
  ├── dana portal       — source of truth for donations
  └── Google Drive API  — XLS → Google Sheet conversion
```

---

## Repository Structure

```
dhamma-sudha-80g/
├── Code.gs            Web app entry point (doGet), form submit handler (submitForm),
│                      sheet init (initSheets), schema migration (migrateSchema)
├── Utils.gs           Shared utilities: HMAC token gen/validate, PAN validate/normalize,
│                      PAN masking, audit log append, getOrCreateSheet
├── DanaImport.gs      All dana portal interaction: login (Drupal 7 + Cloudflare),
│                      report fetch (POST form + XLS), XLS parsing via Drive API,
│                      receipt→donation_id mapping, dedup, insert to donors_input
├── WriteBack.gs       Push collected PAN back to dana: find candidates, GET+POST
│                      /donation/edit/{id}, HTML form extraction, hourly trigger mgmt
├── Email.gs           Send/remind donors: HTML+plaintext emails via MailApp,
│                      group by email, reminder schedule (3d/7d, max 2)
├── Admin.gs           Spreadsheet menu (onOpen), admin_review refresh (color-coded),
│                      exportReadyFor80G
├── Tests.gs           Unit tests for PAN validation, token logic (run via menu)
├── Form.html          Donor-facing PAN submission form (Apps Script Web App template)
├── ImportDialog.html  Admin modal for date-range dana import (shown via showModalDialog)
├── appsscript.json    Project manifest: scopes, Drive API advanced service, V8 runtime
├── .graphifyignore    Files excluded from the graphify knowledge graph
└── docs/
    ├── ARCHITECTURE.md  Full architecture reference
    └── GRAPHIFY.md      Code knowledge graph: setup, usage, token economics

(untracked: graphify-out/ — generated knowledge graph output, gitignored)
```

---

## Core Domain Concepts

**Donor** - A person who made a donation to the centre. Identified by email address in our system (one email = one form link, even if they have multiple donations).

**Receipt** - A single donation transaction in the dana portal. Has a unique `receipt_no` (format: `ER0010722`). Also has an internal `donation_id` (numeric, e.g. `10532`) used in the dana edit URL `/donation/edit/{donation_id}`.

**PAN** - Permanent Account Number. 10-character Indian tax identifier (`[A-Z]{5}[0-9]{4}[A-Z]`). Required for 80G certificates. Some donors provide Aadhaar/Passport/Voter ID instead.

**80G Certificate** - Income Tax Act certificate allowing donors to claim tax deduction on charitable donations. Requires donor PAN. Issued by the dana portal (PDF + WhatsApp/email) - not by this system.

**pan_status** - The lifecycle status of a donors_input row:
- `need_pan` - donor did not provide PAN; email should be sent
- `have_pan` - PAN is collected (either from dana or from our form)
- `no_email` - no email address; cannot be contacted

**dana_updated_at** - Timestamp set after PAN is successfully pushed back to dana portal. Prevents double-writes.

**Signed token** - HMAC-SHA256 of donor email, used in form URLs. One token per email address, deterministic, never expires. Format: `base64url(email).hex(hmac)`.

---

## Data Model

### `donors_input` (26 columns, A-Z)

One row per dana transaction. Primary key: `receipt_no`.

| Col | Field | Notes |
|-----|-------|-------|
| A | receipt_no | PK. Format: `ER0010722` |
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
| R | id_value | The ID value from dana (Aadhaar no, PAN, etc) |
| S | pan_collected | Normalized PAN (from form submission or copied from id_value if id_type=PAN) |
| T | pan_name | Donor name as used on PAN (from existing full_name; donors no longer re-enter) |
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

Append-only log of every action. Never deleted. Actor values: `form_submit`, `danaImport`, `sendPendingEmails`, `sendReminders`, `writeBack`, `system`.

| Field | Notes |
|-------|-------|
| timestamp | ISO |
| actor | Function name |
| action | `pan_collected`, `email_sent`, `bulk_insert`, `dana_updated`, etc |
| record_key | receipt_no or email |
| field_changed | |
| old_value | PAN masked in display contexts but full value here |
| new_value | |
| source_id | submission_id, donation_id, etc |

### `import_log` (10 columns)

One row per dana import run (manual or auto).

### `ready_for_80g`

View-only export sheet. Regenerated on demand via `80G Admin → Export Ready for 80G`. Contains only `have_pan` rows with full (unmasked) PAN. This is the final dataset for certificate generation.

---

## Main User Flows

### 1. Import from Dana Portal

```
Admin: 80G Admin → 1. Import from Dana → Auto Import
  → ImportDialog opens with pre-filled dates (last import end → today)
  → Admin confirms date range → runImportFromDialog(start, end)
  → Login to dana (Drupal 7: GET login page → extract form_build_id → POST creds → get SSESS cookie)
  → GET /donation-report → extract form_build_id + form_token
  → POST /donation-report with date range + op=Get Report
  → Parse HTML response → build receipt_no → donation_id map
  → GET /donation-report/excel?... → XLS binary
  → Upload XLS to Drive → convert to Google Sheet (Drive API v2)
  → Read converted sheet → map columns → process rows:
      id_type=PAN → pan_status='have_pan'
      email exists in emailToPan → pan_status='have_pan' (auto-filled repeat donor)
      email present, no PAN → pan_status='need_pan'
      no email → pan_status='no_email'
  → Dedup by receipt_no (skip existing)
  → Append new rows to donors_input (26 cols)
  → Delete temp Google Sheet
  → Append to import_log
```

**Fallback (Cloudflare blocks):** Admin downloads XLS manually from dana portal, uploads to Google Drive, pastes file ID into `80G Admin → Import from Uploaded XLS File`. Donation_id mapping will be empty (looked up lazily during write-back).

### 2. Email Donors

```
Admin: 80G Admin → 2. Email Donors → Send PAN Request Emails
  → Find all donors_input rows where pan_status='need_pan'
  → Group by email (one email per donor, even if multiple receipts)
  → Skip emails already in email_log
  → For each donor:
      generateToken(email) → HMAC-SHA256 signed link
      MailApp.sendEmail HTML email with "Submit Your PAN Details" button
      Append to email_log
```

**Reminders:** `sendReminders()` runs on a time-based trigger or manually. Sends up to 2 reminders (day 3, day 10 after initial). Stops if `submitted_at` is set in email_log.

### 3. Donor Submits PAN (Web Form)

```
Donor clicks link: /exec?email=...&token=...
  → doGet validates HMAC token
  → Looks up all need_pan rows for this email in donors_input
  → Renders Form.html with: name (read-only), email (read-only), receipt list (read-only), PAN input
  → Donor enters PAN, checks consent, clicks Submit
  → submitForm() server-side:
      Re-validate token
      Validate + normalize PAN ([A-Z]{5}[0-9]{4}[A-Z])
      Update ALL need_pan rows for this email:
        pan_collected = PAN
        pan_name = existing full_name (uppercased)
        pan_status = 'have_pan'
        pan_submitted_at = now
      Append to submissions
      Update email_log submitted_at
```

### 4. Push PAN to Dana Portal

```
Admin: 80G Admin → 3. Push PAN to Dana → Preview (dry run)
  → findWriteBackCandidates_(): donors_input where pan_status='have_pan'
      AND id_type != 'PAN' AND dana_updated_at is empty
  → For rows missing donation_id: fetch /donation-report HTML, parse edit links
  → [Dry run] log what would change, no writes

Admin: 80G Admin → 3. Push PAN to Dana → Push Now
  → Same candidate selection
  → For each (max 50 per run, circuit breaker at 3 consecutive errors):
      GET /donation/edit/{donation_id} → extract all current form values
      Override d_id_type=1 (PAN), d_id_no=pan_collected, email=0, whatsapp=0
      POST /donation/edit/{donation_id} → expect 302 redirect
      Update donors_input: dana_donation_id, dana_updated_at
      Append to audit_log
      Sleep 800ms
```

**Hourly auto-push:** `80G Admin → Enable Hourly Auto-Push` installs a time-based trigger calling `autoWriteBackHourly()`. Emails the admin if it fails.

### 5. Admin Review

```
Admin: 80G Admin → Refresh Admin Review
  → Reads all donors_input rows
  → Categorizes each:
      ready_for_80g      (have_pan) — green
      pending_need_pan   (need_pan, < 10 days) — yellow
      overdue_need_pan   (need_pan, > 10 days) — orange
      no_email_cannot_contact — red
  → Writes color-coded admin_review sheet
```

### 6. Export for Certificate Generation

```
Admin: 80G Admin → Export Ready for 80G
  → Filters donors_input: pan_status='have_pan'
  → Writes ready_for_80g sheet with full (unmasked) PAN
  → Admin downloads ready_for_80g as CSV/XLSX and hands off to dana operator
    (dana portal generates the 80G PDFs and sends via WhatsApp/email)
```

---

## Setup and Local Development

### Prerequisites

- macOS or Linux (Windows untested)
- Node.js ≥ 18 (install via `nvm install --lts`)
- `@google/clasp` ≥ 3.x (`npm install -g @google/clasp`)
- A Google account with Apps Script API enabled at https://script.google.com/home/usersettings

### Install

```bash
git clone https://github.com/kapaggar/dhamma-sudha-80g.git
cd dhamma-sudha-80g
clasp login
```

### Link to an Existing Script Project

If you're taking over an existing deployment:

```bash
# Get the script ID from the Apps Script URL:
# https://script.google.com/u/0/home/projects/{SCRIPT_ID}/edit
echo '{"scriptId":"YOUR_SCRIPT_ID","rootDir":"."}' > .clasp.json
```

### Create a New Deployment

1. Open the target Google Spreadsheet → **Extensions → Apps Script**
2. Copy the script ID from the URL
3. `echo '{"scriptId":"SCRIPT_ID","rootDir":"."}' > .clasp.json`

### Push Code

```bash
clasp push
# When asked "Manifest file has been updated. Overwrite?" → y
```

### Enable Drive API Advanced Service

In the Apps Script editor browser tab:
- Left sidebar → **Services** (+) → **Drive API** → version **v2** → Add

### Set Script Properties

Apps Script editor → ⚙ Project Settings → Script Properties:

| Property | Value | Notes |
|----------|-------|-------|
| `SHEET_ID` | Google Spreadsheet ID | From spreadsheet URL |
| `TOKEN_SECRET` | `$(openssl rand -hex 32)` | Required. Keep secret. |
| `CENTER_NAME` | `Dhamma Sudha Vipassana Centre` | Displayed in emails + form |
| `WEB_APP_URL` | Web app deploy URL | Set after first deploy (see below) |
| `DANA_URL` | `https://sudha.dana.vridhamma.org` | Dana portal base URL |
| `DANA_USER` | Dana portal username | Not email - plain username |
| `DANA_PASS` | `echo -n 'password' \| base64` | Base64-encoded. See note below. |

**`DANA_PASS` encoding:** The password is base64-encoded for screen-share hygiene (not encryption). Encode it: `echo -n 'YourPassword' | base64`. The `-n` flag is required to prevent a trailing newline from being encoded.

### Initialize Sheets

Reload the spreadsheet → **80G Admin → Initialize All Sheets**

If you already have a `donors_input` sheet from a prior version: **80G Admin → Migrate Schema (add new columns)**

### Deploy the Web App

Apps Script editor → **Deploy → New deployment**:
- Type: Web app
- Execute as: Me
- Who has access: Anyone
- Description: v1

Copy the Web app URL and set it as the `WEB_APP_URL` Script Property.

### Run Tests

In Apps Script editor: function dropdown → `runAllTests` → Run → View → Execution log

Tests cover PAN validation (valid, lowercase, spaces, too short, wrong format, null) and token generation/validation (match, tamper, wrong email, case-insensitive).

### Test Dana Login

Function dropdown → `testDanaImportLogin` → Run → View → Logs

Expected output: `=== LOGIN OK === Cookie length: NNN Cookie names: SSESS620a...`

### Refresh the Code Knowledge Graph (graphify)

A semantic knowledge graph of this repo lives in `graphify-out/` (gitignored, rebuildable).
After code or doc changes, refresh it — incremental and free (no API tokens):

```bash
graphify update .
```

See [docs/GRAPHIFY.md](docs/GRAPHIFY.md) for setup, token economics, and the
fresh-machine setup prompt. Never delete `graphify-out/cache/` — it's what makes
updates cost 0 tokens.

---

## Configuration and Environment Variables

All configuration lives in Apps Script **Script Properties** (encrypted at rest by Google, accessible only to script owner). Nothing is committed to git.

| Property | Required | Secret | Purpose |
|----------|----------|--------|---------|
| `SHEET_ID` | Yes | No | Google Spreadsheet ID |
| `TOKEN_SECRET` | Yes | **Yes** | HMAC key for signed form links. Changing this invalidates all existing links. |
| `CENTER_NAME` | No | No | Display name in emails and form header. Defaults to "Dhamma Sudha Vipassana Centre". |
| `WEB_APP_URL` | Yes | No | The deployed web app URL. Set after first Deploy. |
| `DANA_URL` | Yes | No | Dana portal base URL (`https://sudha.dana.vridhamma.org`) |
| `DANA_USER` | Yes | **Yes** | Dana portal username (not email) |
| `DANA_PASS` | Yes | **Yes** | Dana portal password, base64-encoded |

**What's safe to commit:** Nothing from Script Properties. The `appsscript.json` and all `.gs`/`.html` files are safe. `.clasp.json` contains only the script ID (not a secret) and is safe to commit.

---

## Deployment

This is a **Google Apps Script Web App**. There is no server to provision.

| Layer | Platform | Cost |
|-------|----------|------|
| Code runtime | Google Apps Script (Google's infra) | Free |
| Data storage | Google Sheets | Free |
| Email sending | MailApp (Google account's quota) | Free |
| XLS conversion | Google Drive API v2 | Free |
| Web app hosting | Apps Script deployment | Free |

### Deploy a New Version

After any code change that should go live for the web app (Form.html, Code.gs):

1. `clasp push`
2. Apps Script editor → **Deploy → Manage deployments** → pencil icon → Version: **New version** → Deploy
3. The URL does not change between versions.

### Push Code Only (no web app change needed)

For Admin.gs, Email.gs, etc.:
1. `clasp push` — changes take effect immediately (no new deployment needed for non-web-app functions)

### Time-Based Triggers

Installed via the Admin menu (not in code directly):
- **Monthly auto-import:** Apps Script Triggers → `autoImportMonthly` → Day timer, set preferred time
- **Daily reminders:** Apps Script Triggers → `sendReminders` → Day timer, 9-10am IST
- **Hourly PAN push:** `80G Admin → 3. Push PAN to Dana → Enable Hourly Auto-Push`

Triggers must be installed once after any new deployment. They survive re-deployments.

---

## Important Implementation Details

### Token Scheme

Tokens are HMAC-SHA256 signed. One token per email address, regardless of donation count.

```
token = base64url(email) + "." + hex(HMAC-SHA256(email, TOKEN_SECRET))
```

- The same email always produces the same token (deterministic). Tokens do not expire.
- Changing `TOKEN_SECRET` invalidates all outstanding links.
- `<?!= JSON.stringify(token) ?>` (force-print, no escaping) is used in Form.html to prevent Apps Script's contextual escaping from corrupting the token's `=` character in `<script>` tags.

### PAN Validation

Format: `[A-Z]{5}[0-9]{4}[A-Z]` - exactly 10 characters.

Normalization pipeline: `trim → uppercase → remove internal spaces`. Applied client-side (live feedback, `OK`/`X` badge) and server-side (in `submitForm` before any write).

PAN is stored full in `pan_collected` and `submissions.pan`. It is **masked** (`ABCDE****F`) in `admin_review` and in log messages. Full PAN is only shown in `ready_for_80g` export.

### Dana Portal Integration (Drupal 7)

The dana portal is a Drupal 7 site behind Cloudflare. Three-step login:

1. GET `/user/login` → extract `form_build_id` (CSRF token embedded in HTML)
2. POST `/user/login?destination=donation&autologout_timeout=1` with credentials + `form_build_id` → get `SSESS{hash}` session cookie in response
3. All subsequent requests include `Cookie: SSESS{hash}=...`

**Cloudflare:** A `Mozilla/5.0 Chrome/125` `User-Agent` header is sent on every request. Without it, Cloudflare returns HTTP 403/503.

**Report fetch** requires a 3-step flow:
1. GET `/donation-report` → extract `form_build_id` + `form_token`
2. POST `/donation-report` with date range and `op=Get Report` → HTML response containing both the report table and the `Download as Excel` link
3. GET `/donation-report/excel?start=...&end=...&id_type=all&txn_type&don_tags&...` → XLS binary

The exact query string for step 3 was determined by HAR analysis. It differs from the simpler `?start&end&category&txn_type=all` seen in URLs elsewhere - notably `id_type=all` (not `txn_type=all`), and several valueless params (`txn_type`, `don_tags`, `synced`, etc).

**XLS parsing:** `UrlFetchApp` returns a blob. The blob is uploaded to Google Drive with `mimeType: GOOGLE_SHEETS` which triggers automatic conversion. The resulting Google Sheet is read via `SpreadsheetApp.openById()`, then the temp file is trashed.

### Receipt → Donation ID Mapping

The dana XLS export does not include the donation_id (the internal numeric ID used in `/donation/edit/{id}`). The mapping is extracted from the HTML of the `/donation-report` POST response by:
1. Finding all `/donation/edit/(\d+)` patterns
2. For each, looking back up to 3000 chars in the HTML for the nearest `ER\d+` receipt number

This is stored in `donors_input.dana_donation_id` (column Y). For rows imported before this column was added, `WriteBack.gs` re-fetches the report HTML during write-back.

### Write-back Safety

`d_id_type=1` (PAN in dana's select options), `d_id_no={pan}`.

`email=0` and `whatsapp=0` are set explicitly to prevent dana from sending the donor a duplicate donation receipt/confirmation when we edit the slip.

All other form fields (donor name, address, course, amount, payment mode, etc.) are extracted from the GET response of the edit page and re-submitted unchanged. This is the safest approach - we don't need to maintain a separate copy of fields we're not changing.

### Repeat Donor Auto-Fill

During import, if a donor's email already has a `pan_collected` value in an existing row, new donations from the same email are automatically marked `have_pan` with the same PAN. This means the donor does not need to re-submit PAN for each course.

### Multi-Receipt Single Email

A donor with 3 pending receipts receives one email showing all 3 in a table. One PAN submission updates all 3 rows. This is enforced by grouping `byEmail` in `sendPendingEmails()` and updating all `need_pan` rows for the email in `submitForm()`.

---

## AI Memory / Project Context

### Original Goal

Build an automated system for Dhamma Sudha Vipassana Centre to:
1. Collect PAN from donors who donated with Aadhaar/Passport/other ID
2. Push the PAN back to their dana portal so 80G certificates can be issued
3. Run with minimal manual intervention

### Platform Choice

The entire system runs on Google Apps Script + Google Sheets. No servers, no hosting cost, no DevOps. The centre has a 3-4 person team with no dedicated technical staff. Maintainability and zero infrastructure overhead were the primary constraints.

### Key Design Decisions

**Token scheme:** HMAC(email) only - one link per donor regardless of donation count. Simpler than per-receipt tokens. Deterministic (re-sendable without invalidating the link).

**One form submission = all pending receipts:** Rather than one link per receipt, a single form visit collects PAN and updates all pending donations for that email. Reduces donor friction significantly.

**Name not re-collected on form:** We have the donor's name from the dana import. Re-asking them to type "Name as per PAN" was rejected as unnecessary friction.

**MailApp not GmailApp:** `GmailApp` requires a broader OAuth scope (`mail.google.com`) which caused permission errors in Apps Script context. `MailApp` (scope: `script.send_mail`) is sufficient for send-only use and was used instead.

**DANA_PASS base64-encoding:** Not cryptographic security - explicitly for screen-share hygiene during code review. `_readProp()` decodes it silently. Function is named generically to avoid broadcasting intent in a shared screen.

**XLS via Drive API:** Apps Script cannot natively parse binary XLS. Uploading to Drive and converting to Google Sheets is the most reliable method. A temp file is created and immediately trashed.

**No course codes:** The dana portal uses course type names ("10 Day Course", "Non Course"), not structured codes. The `course` field is stored as-is and not used for filtering.

### Things That Changed During Development

- Started with a Google Form + native Sheets approach; switched to an Apps Script Web App because Google Forms can't validate signed tokens or support dynamic multi-row input.
- Token scheme changed from `HMAC(course_id + email)` to `HMAC(email)` when we discovered the dana data has no course codes.
- `name_as_per_pan` field removed from form after user confirmed it's unnecessary - existing name on file is sufficient.
- Dana report fetch was initially assumed to be a simple GET with URL params; HAR analysis revealed it requires a POST first (`op=Get Report`) before the XLS download URL becomes valid.
- `User-Agent` header was missing initially, causing Cloudflare to block logins. Adding a Chrome UA string fixed it.
- `setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DENY)` removed - the constant is not valid in newer Apps Script runtimes.
- `<?= JSON.stringify(token) ?>` → `<?!= JSON.stringify(token) ?>` in Form.html to prevent contextual HTML escaping from corrupting the token string in `<script>` tags.

### Unfinished TODOs

- [ ] Monthly auto-import trigger must be manually installed (no code to install it via menu, unlike the hourly write-back trigger)
- [ ] `importFromUploadedFile` does not capture `donation_id` during import (no HAR parsing in the fallback path) - needs re-fetch during write-back
- [ ] No deduplication logic if the same donor submits PAN twice (second submission will find 0 `need_pan` rows and return an error, which is correct but the UX could be friendlier)
- [ ] `admin_review` sheet shows masked PAN; full PAN is only in `ready_for_80g`. If admin needs to verify a submitted PAN without exporting, there's no shortcut.
- [ ] No test for the write-back flow end-to-end (requires live dana credentials)

### Known Bugs / Fragile Areas

- **Receipt-to-donation_id parsing** (`parseReceiptToDonationIdMap_`) uses a heuristic: look back 3000 chars in HTML for the nearest `ER\d+` before each `/donation/edit/\d+` link. This breaks if the dana HTML structure changes significantly, or if a receipt number appears multiple times in the same region.
- **Cloudflare** can block the dana login at any time. There is no automated retry or fallback; the admin must use the manual XLS upload if this happens.
- **Apps Script 6-minute execution limit:** Large imports (hundreds of rows) with the Drive API conversion step could approach the limit. Not observed in practice but worth monitoring.
- **email and whatsapp = 0 in write-back:** Assumed this prevents dana from sending duplicate notifications. Not confirmed by testing with dana admins - verify before enabling hourly auto-push on a large batch.

### Warnings for Future AI Agents

1. **Do not change the token scheme** without invalidating all outstanding links (donors will get broken links in their inboxes).
2. **Do not add `import_log` or `admin_review` to `initSheets` as persistent sheets** - they are regenerated on demand or written-to on import. `admin_review` is a read-only view.
3. **The XLS column positions are fragile.** The dana export column order was determined by HAR analysis. If dana updates their export format, `mapColumns_` in `DanaImport.gs` will need updating. The function uses name-matching not position, so minor reordering is handled - but renamed columns will break it.
4. **Script Properties are the only config store.** Do not hardcode `SHEET_ID`, `TOKEN_SECRET`, or credentials. Do not commit `.clasp.json` with a production script ID if it points to prod data.
5. **`<?!= ?>` not `<?= ?>`** for JS variables in HTML templates. Apps Script's contextual escaping breaks base64 tokens. Always use force-print (`<?!= ?>`) for JS literals in `<script>` tags.
6. **Write-back posts `email=0&whatsapp=0`** to suppress donor notifications. If a future version of the dana edit form changes checkbox field names, the write-back will silently trigger notifications.

### Future Improvements

- Add a menu item to install the monthly import trigger (mirror of hourly write-back trigger install)
- Cache `receipt_no → donation_id` mapping during import so write-back never needs a re-fetch
- Add a simple status dashboard sheet (counts of need_pan / have_pan / dana_updated by import batch)
- Consider GCP Secret Manager for credentials if the project grows beyond 3-4 admins
- Financial year filtering in the 80G export (Indian FY: April 1 - March 31)

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `SHEET_ID script property not set` | Missing Script Property | Set `SHEET_ID` in ⚙ → Script Properties |
| `TOKEN_SECRET script property not configured` | Missing | Set `TOKEN_SECRET` (generate with `openssl rand -hex 32`) |
| `WEB_APP_URL script property not set` | Missing after deploy | Set `WEB_APP_URL` to the deployed web app URL |
| `Login appeared to succeed but no SESS/SSESS cookie` | Bad DANA_USER or DANA_PASS | Re-encode password: `echo -n 'pass' \| base64`. Verify username. |
| `Cloudflare blocked the request (HTTP 403/503)` | Cloudflare challenge | Use 80G Admin → Import from Uploaded XLS File as fallback |
| `Got HTML instead of XLS` | Session expired mid-flow or Cloudflare | Re-run import; if persists, use manual XLS upload |
| `Could not find Receipt No column` | Dana changed export column names | Update `mapColumns_()` in `DanaImport.gs` |
| `donors_input sheet is missing dana_donation_id / dana_updated_at columns` | Old schema | Run **80G Admin → Migrate Schema** |
| `Invalid or tampered submission token` | TOKEN_SECRET changed after email was sent; or HTML escaping corrupted token | Ensure `<?!= JSON.stringify(token) ?>` in Form.html (not `<?= ?>`). Check if TOKEN_SECRET changed. |
| `No pending PAN requests found` | Donor already submitted, or pan_status already updated | Check donors_input for email - all rows may already be `have_pan` |
| `Edit POST HTTP 200 (expected 302)` | Dana edit form validation failed (field value error) | Check audit_log; inspect the donation_id manually in dana portal |
| `Apps Script execution log: token mismatch expected/got lines` | See above | Both lines are logged when mismatch occurs - compare to diagnose |
| `Drive API advanced service not enabled` | Not yet activated | Apps Script editor → Services → Drive API v2 → Add |
| Gmail permission error | Wrong OAuth scope | Code uses `MailApp` (script.send_mail); if you see Gmail errors, check appsscript.json scopes |

---

## Maintenance Notes

### Safe to Change

- `Email.gs` - email templates, reminder thresholds (currently 3d/7d, max 2)
- `Admin.gs` - menu items, color scheme in admin_review
- `Form.html` - form UI/copy (do not change variable names `TOKEN`, `EMAIL`, or the `submitForm` call signature)
- `WRITEBACK_MAX_PER_RUN` and `WRITEBACK_MAX_CONSECUTIVE_ERRORS` constants in `WriteBack.gs`

### Change With Care

- `Utils.gs / generateToken()` - changing token format invalidates all outstanding links
- `Code.gs / submitForm()` - changing which columns are written affects donors_input schema
- `DanaImport.gs / mapColumns_()` - if dana adds/renames columns, update name-to-index mapping
- `appsscript.json / oauthScopes` - adding scopes requires user re-authorization

### Do Not Touch Without Full Review

- `TOKEN_SECRET` Script Property - changing it breaks all outstanding donor links
- `drivers_input` column order (A-Z) - all code references columns by index; reordering breaks everything
- `DANA_ID_TYPE_PAN = '1'` in `WriteBack.gs` - this constant came from HAR analysis of the dana edit form. Verify it still holds if dana is upgraded.

### Adding New Columns to `donors_input`

1. Add the column name to `initSheets()` in `Code.gs`
2. Add population logic in `processRows_()` in `DanaImport.gs` (append to the `newRows.push([...])` array)
3. Add the column header to `migrateSchema()` in `Code.gs` for existing users
4. Update any downstream functions that read by index (Admin.gs, WriteBack.gs, Code.gs submitForm)

### How to Validate Changes

1. `clasp push` to push code
2. Run `runAllTests` from the Apps Script editor (covers PAN + token logic)
3. Run `testDanaImportLogin` to verify dana credentials still work
4. Run `previewWriteBackToDana` (dry run) before any real write-back
5. Check Apps Script Execution Log (left sidebar, clock icon) for any errors
6. After committing, run `graphify update .` from the repo root to keep the
   knowledge graph fresh (incremental, no API cost — see [docs/GRAPHIFY.md](docs/GRAPHIFY.md))

### Credential Rotation

1. Change password in dana portal
2. `echo -n 'NewPassword' | base64` → copy output
3. Apps Script ⚙ → Script Properties → update `DANA_PASS`
4. Run `testDanaImportLogin` to confirm
