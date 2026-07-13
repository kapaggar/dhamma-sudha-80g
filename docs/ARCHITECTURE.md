# Architecture Reference - Dhamma Sudha 80G

## Platform

Everything runs on **Google Apps Script** (GAS). There is no external server, no Docker, no cloud infrastructure to provision. The runtime is Google's V8-based Apps Script environment, deployed as a Web App.

```
┌────────────────────────────────────────────────────────────────────┐
│                         Google Account                             │
│                                                                    │
│  ┌─────────────────────┐       ┌─────────────────────────────────┐ │
│  │   Google Sheets     │       │     Apps Script Project         │ │
│  │                     │       │                                 │ │
│  │  donors_input       │◄─────►│  Code.gs      (web app + init)  │ │
│  │  submissions        │       │  DanaImport.gs (dana scraper)   │ │
│  │  email_log          │       │  WriteBack.gs  (dana editor)    │ │
│  │  audit_log          │       │  Email.gs      (MailApp)        │ │
│  │  import_log         │       │  Admin.gs      (menu + views)   │ │
│  │  ready_for_80g      │       │  Utils.gs      (shared)         │ │
│  │  admin_review       │       │  Tests.gs      (unit tests)     │ │
│  └─────────────────────┘       │                                 │ │
│                                │  Form.html     (donor UI)       │ │
│                                │  ImportDialog.html (admin UI)   │ │
│                                └────────────┬────────────────────┘ │
│                                             │                      │
└─────────────────────────────────────────────┼──────────────────────┘
                                              │
                    ┌─────────────────────────┼──────────────────────┐
                    │   External Services     │                      │
                    │                         ▼                      │
                    │  ┌─────────────────────────────────────────┐   │
                    │  │  Google Drive REST API                  │   │
                    │  │  (XLS → Google Sheet conversion)        │   │
                    │  └─────────────────────────────────────────┘   │
                    │                                                │
                    │  ┌─────────────────────────────────────────┐   │
                    │  │  dana portal (Drupal 7 / Cloudflare)    │   │
                    │  │  sudha.dana.vridhamma.org               │   │
                    │  │                                         │   │
                    │  │  /user/login          (Drupal auth)     │   │
                    │  │  /donation-report     (HTML + XLS)      │   │
                    │  │  /donation/edit/{id}  (write-back)      │   │
                    │  └─────────────────────────────────────────┘   │
                    │                                                │
                    │  ┌─────────────────────────────────────────┐   │
                    │  │  MailApp (Google)                       │   │
                    │  │  Sends HTML emails from GAS account     │   │
                    │  └─────────────────────────────────────────┘   │
                    └────────────────────────────────────────────────┘
```

## Web App

The Apps Script project is deployed as a **Web App** (`executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`). This means:
- The form URL is publicly accessible (no Google login required for donors)
- The script runs as the admin who deployed it (accesses their Sheets, sends from their email)
- Security is enforced by the HMAC-signed token in the URL

## Data Flow: Import

```
dana portal
    │
    │ 1. Login (GET + POST /user/login)
    │    → SSESS session cookie
    │
    │ 2. GET /donation-report
    │    → form_build_id, form_token
    │
    │ 3. POST /donation-report (r_from, r_to, op=Get Report)
    │    → HTML response with:
    │       - Receipt table (receipt_no + /donation/edit/{id} links)
    │       - "Download as Excel" link
    │
    │ 4. GET /donation-report/excel?start=...&end=...&id_type=all&...
    │    → XLS binary blob
    │
    ▼
Google Drive REST API (UrlFetchApp + OAuth token)
    │ Multipart upload as Google Sheets mimeType → auto-conversion
    │ Read sheet data
    │ Delete temp file
    ▼
processRows_()
    │ mapColumns_() - name-based column mapping
    │ Dedup by receipt_no
    │ Determine pan_status
    │ Auto-fill PAN for repeat donors (emailToPan lookup)
    ▼
donors_input sheet (append)
    │
    ▼
import_log sheet (append)
```

## Data Flow: Form Submission

```
Email (HTML + plaintext)
    │
    │ MailApp.sendEmail({ htmlBody, body, name })
    │ Link: /exec?email=...&token=HMAC(email)
    │
    ▼
Donor's inbox → clicks "Submit Your PAN Details"
    │
    ▼
Apps Script Web App (doGet)
    │ Validate HMAC token
    │ Look up need_pan rows for email
    │ Render Form.html (pending receipt list, PAN input)
    │
    ▼
Donor enters PAN → handleSubmit() → google.script.run.submitForm()
    │
    ▼
submitForm() (server-side)
    │ Re-validate token
    │ Normalize + validate PAN format
    │ Update all need_pan rows for email:
    │   pan_collected, pan_name, pan_status='have_pan', pan_submitted_at
    │ Append to submissions
    │ Update email_log.submitted_at
    │
    ▼
donors_input (have_pan rows)
```

## Data Flow: Write-back to Dana

```
donors_input
    │ Candidates: pan_status='have_pan' AND id_type≠PAN AND dana_updated_at=empty
    │
    ▼
fetchDonationIdsForCandidates_() [if donation_id missing]
    │ POST /donation-report HTML → parseReceiptToDonationIdMap_()
    │
    ▼
For each candidate (max 50/run):
    │
    │ GET /donation/edit/{donation_id}
    │   → extractFormValues_(html) - all current field values
    │
    │ POST /donation/edit/{donation_id}
    │   All fields unchanged except:
    │     d_id_type = '1' (PAN)
    │     d_id_no   = pan_collected
    │     email     = '0' (suppress notification)
    │     whatsapp  = '0' (suppress notification)
    │   → expect HTTP 302 redirect
    │
    │ Update donors_input: dana_donation_id, dana_updated_at
    │ Append to audit_log
    │ Sleep 800ms
    │
    ▼
donors_input (dana_updated_at set)
```

## OAuth Scopes

Defined in `appsscript.json`:

| Scope | Used by |
|-------|---------|
| `spreadsheets` | All sheet reads/writes |
| `script.container.ui` | Menu creation, showModalDialog |
| `script.send_mail` | MailApp.sendEmail |
| `script.scriptapp` | Trigger install/remove (hourly write-back, reminders, Donation Day) |
| `drive.file` | Temp XLS→Sheet conversion + deleting those temp files, via the Drive REST API (`driveCreateSheetFromBlob_`/`driveDeleteFile_`). App-created files only — the script cannot touch pre-existing Drive files, which is why the upload fallback sends file contents through the dialog instead of taking a Drive file ID |
| `script.external_request` | UrlFetchApp.fetch, pinned by `urlFetchWhitelist` to the dana portal, 360dialog, and `www.googleapis.com` hosts |

There is deliberately no `userinfo.email` scope (failure-alert recipients come from the
`ADMIN_EMAIL` Script Property via `getAdminEmail_` in `Utils.gs`, not `Session.getActiveUser()`),
no Drive advanced service, and no `DriveApp` — the latter two refuse to run without the
full `drive` scope, so Drive calls go through the REST API with `ScriptApp.getOAuthToken()`.

**Advanced Services:** none. (Drive API v2 was previously required for the XLS conversion; it was replaced by direct REST calls so the manifest can stay on `drive.file`.)

## Security Model

### Form Link Security

Token = `base64url(email) + "." + hex(HMAC-SHA256(email, TOKEN_SECRET))`

- Deterministic: same email → same token always
- Non-expiring: links are valid indefinitely (by design; donors may need to submit weeks after receiving email)
- Token validated server-side in both `doGet` and `submitForm`
- Changing `TOKEN_SECRET` invalidates all outstanding links

### PAN Data Security

- PAN is stored in `donors_input.pan_collected` and `submissions.pan` (plaintext in the Google Sheet)
- Admin views (`admin_review`) show masked PAN (`ABCDE****F`)
- Full PAN only shown in `ready_for_80g` export (which requires being logged into the Google account)
- PAN is never included in email body (link-based collection only)

### Dana Credentials

- `DANA_PASS` is base64-encoded in Script Properties for screen-share hygiene (not encryption)
- Script Properties are encrypted at rest by Google
- Access requires Google account owner or explicitly granted edit access

### Web App Access

- Web app is `ANYONE_ANONYMOUS` (donor form must be accessible without Google login)
- Security enforced entirely by the HMAC token
- No rate limiting (Apps Script limitation - UrlFetchApp calls are from Google IPs)

## Dana Portal Specifics

**Platform:** Drupal 7  
**Auth:** Session cookie (`SSESS{hash}`, HTTPS variant)  
**CDN/WAF:** Cloudflare (requires Chrome User-Agent string)  

**Edit form d_id_type values** (from HAR analysis, 2026-05-28):

| Value | Meaning |
|-------|---------|
| 1 | PAN |
| 2 | Aadhaar |
| 4 | Passport |
| 5 | Voter ID |
| 6 | Driving License |
| 7 | Ration Card |
| 99 | No ID |

**Important:** These values were determined by inspecting the live dana portal HTML. If dana is upgraded or these values change, `DANA_ID_TYPE_PAN` in `WriteBack.gs` must be updated.

## Time-Based Triggers

All triggers are installed at runtime, not defined in code at deploy-time.

| Trigger | Function | Installed via |
|---------|----------|---------------|
| Monthly import | `autoImportMonthly` | Manual (Apps Script Triggers UI) |
| Daily reminders | `sendReminders` | Manual (Apps Script Triggers UI) |
| Hourly PAN push | `autoWriteBackHourly` | `80G Admin → Enable Hourly Auto-Push` |
| Donation Day 10-min tick | `donationDayTick` | `80G Admin → 5. Donation Day → Enable` |

**Donation Day mode** (`DonationDay.gs`): the tick runs import → pending emails → WhatsApp nudges every 10 minutes and self-expires 3 hours after enable (expiry stored in the `DONATION_DAY_UNTIL` Script Property; past it, the tick uninstalls its own trigger, clears the property, audit-logs `donation_day_auto_off`, and emails the admin). Enabling removes the hourly `autoSendEmailsHourly` / `autoSendWhatsAppNudgeHourly` triggers for the window — neither send path takes a lock, so an hourly run overlapping a tick could double-send. They are not auto-restored; re-enable them from menus 2 and 4 afterwards if a backlog remains. Within the tick, sends run under `LockService` `tryLock(0)` (skipped if busy) while import runs lock-free (idempotent via `receipt_no` dedup), so a tick never starves `submitForm`'s 20s `waitLock` during peak donor traffic.

## Performance Notes

- Apps Script has a **6-minute execution timeout** per run
- Drive API XLS conversion adds ~5-10 seconds per import
- Write-back includes an 800ms sleep between edits to avoid overwhelming the dana server
- At 50 writes/run × 800ms = ~40 seconds minimum for a full batch
- Large imports (500+ rows) are theoretically possible within the 6-minute limit but untested

## Error Handling Patterns

All public functions (those called from menu items or triggers) follow this pattern:
- Try-catch at the outermost level
- `Logger.log` for diagnostics (visible in Apps Script Execution Log)
- `SpreadsheetApp.getUi().alert()` for user-facing messages (only works when called from spreadsheet UI, not triggers)
- Admin email on failure for trigger-driven functions (`autoImportMonthly`, `autoWriteBackHourly`)
- Circuit breaker in write-back: stop after `WRITEBACK_MAX_CONSECUTIVE_ERRORS` (3) consecutive failures
