# AGENTS.md

Shared guidance for agents working in this repository. `CLAUDE.md` points here;
keep project rules in this file rather than maintaining duplicate copies.
Read [`README.md`](README.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
before non-trivial changes, and [`docs/DECISIONS.md`](docs/DECISIONS.md) before
changing authorization, triggers, imports, or sending behavior. Compare the commit
in `graphify-out/GRAPH_REPORT.md` with `git rev-parse HEAD` before using the graph
for orientation.

## Project

Google Apps Script + Google Sheets automation for Dhamma Sudha Vipassana Centre.
It collects donor PAN numbers and writes them to the centre's dana portal
(Drupal 7 behind Cloudflare) for 80G certificates. Production runs entirely in
Apps Script, bound to a Google Sheet. The admin team has 1-3 non-technical users.
The local Node preview is a synthetic development aid, not a production server.

## Sensitive data

Donor names, emails, mobiles, PAN, donation amounts, and identity-document values
are personal or financial data.

- Never put donor data, credentials, signed donor links, or Script Property values
  in searches, external tools, commits, filenames, or summaries. Use placeholders.
- Full PAN belongs only in `pan_collected`, `submissions.pan`, and the
  `ready_for_80g` export. Mask it elsewhere with `maskPAN` / `maskPanInText_`.
  New imports mask PAN in source column R; old rows may still need separate cleanup.
- Configuration and secrets stay in Apps Script **Script Properties**. Keep clasp
  authentication files outside git; never print their contents.
- Use synthetic records in local tests and previews. Deployment validation must
  not send donor messages or submit real PAN data merely to test a release.

## Authorization and tokens

- Sensitive server helpers end with `_`: `generateToken_`, `readProp_`, and
  `getSpreadsheet_`. A leading underscore does not hide a `google.script.run`
  function. See Google's [private-function rule](https://developers.google.com/apps-script/guides/html/communication#private_functions).
- Every public admin entry point checks `requireAdminContext_` before side effects.
  Matching the active spreadsheet to `SHEET_ID` alone is insufficient: anonymous
  browser callbacks can retain that container.
- The guard also requires spreadsheet UI access or a native installed clock event.
  Clock events must carry the actual `ScriptApp.AuthMode.FULL` enum object and a
  UID matching a project `CLOCK` trigger. Do not stringify or loosely compare the
  enum; browser JSON must not impersonate it. See Google's [event objects](https://developers.google.com/apps-script/guides/triggers/events).
- Preserve installed handler names and forward trigger events into the guard.
  `adminContextVerified_` allows nested calls within one execution; never persist
  that authorization in properties or a cache. Standalone/API execution is not
  an alternative admin entry point.
- Tokens remain `HMAC(email)`. Changing `TOKEN_SECRET` or the token format breaks
  outstanding links. Keep `<?!= JSON.stringify(token) ?>` in `Form.html`; normal
  `<?= ?>` printing corrupts the base64 token. Do not log tokens or expected values.

## Files and data model

| File | Role |
|---|---|
| `Code.gs` | `doGet`, `submitForm`, sheet initialization/migration, `getSpreadsheet_` |
| `Utils.gs` | Admin guard, `generateToken_` / `validateToken`, PAN validation/masking, audit helpers |
| `DanaImport.gs` | `readProp_`, dana login/report fetch, REST XLS conversion, receipt mapping, locked import |
| `WriteBack.gs` | Candidate selection, live-form preflight, PAN write-back, diagnosis, triggers |
| `Email.gs` / `Whatsapp.gs` | Donor messages, reminders, campaign logs, sending triggers |
| `Admin.gs` / `DonationDay.gs` | Spreadsheet menus, review/export, temporary Donation Day mode |
| `Form.html` / `Message.html` | Donor form and invalid-link/status screens |
| `ImportDialog.html` / `UploadDialog.html` | Admin date-range and XLS upload dialogs |
| `UiStyles.html` | Shared local styles for all HTML screens |
| `Tests.gs` / `tests/*.cjs` | Editor tests, offline regression suite, synthetic preview |
| `docs/REVIEW.md` | Fixed bugs, UI changes, validation evidence and live-test limits |

`donors_input` has 26 columns A-Z, keyed by `receipt_no`. Other sheets include
`submissions`, `email_log`, `audit_log`, `import_log`, `wa_log`, `wa_nudge_log`,
`admin_review`, and `ready_for_80g`. The complete layout is in README's Data Model.
Never reorder A-Z: readers use numeric indexes. Schema changes must update
`initSheets`, `migrateSchema`, import processing, and every index-based reader.
Key columns: Q=`id_type`, R=source ID value, S=`pan_collected`, U=`pan_status`,
Y=`dana_donation_id`, Z=`dana_updated_at`.

## Import and write-back constraints

- Portal requests need the `DANA_USER_AGENT` header. Login uses GET form token,
  POST credentials, then the SSESS cookie. POST the report form before fetching XLS.
- Validate import dates and upload limits on the server. Lock the shared sheet
  read/dedup/append phase and flush before releasing the lock; keep network fetch
  and conversion outside that lock. Validate PAN before classification/auto-fill;
  valid PAN remains ready even when email is missing.
- Map receipts to donation IDs only within the same HTML table row. Omit ambiguous
  or conflicting mappings instead of guessing across rows.
- Write-back preserves live edit-form fields while setting `d_id_type=1`,
  `d_id_no=pan`, and `email=0` / `whatsapp=0`. Notification suppression remains an
  assumption to confirm before large batches.
- Required selects preserve the browser's effective option. A real `Non Course`
  value `0` is valid; placeholder labels and empty values fail preflight.
- Skip rows already marked `dana_updated_at`, valid live PAN (`ALREADY_PAN`), or
  failed preflight (`SKIP:`). Invalid live PAN can be repaired. Skip outcomes do
  not count toward the consecutive-error circuit breaker.
- Use `diagnoseDanaWriteBack(donationId)` for GET-only, masked diagnosis. Run
  `previewWriteBackToDana` before a real dana write-back.

## Test and release

```bash
node --test tests/*.test.cjs   # offline; mocks Google services
node tests/preview.cjs        # synthetic UI preview at http://127.0.0.1:8787
clasp login                  # one-time authentication, if needed
clasp push                   # updates saved Apps Script source
```

- `runAllTests` is also available from the bound editor / 80G Admin menu. Offline
  tests and previews do not replace live Google/Drupal integration checks.
- `.claspignore` uploads only root `*.gs`, `*.html`, and `appsscript.json`.
  Documentation and local tests are not deployment files.
- Saved source takes effect for menu functions and installed triggers after push.
  Donor web-app changes require a new version assigned to each active deployment.
  Update existing deployments to preserve donor URLs; compare remote source with
  the baseline before overwriting edits made directly in Apps Script.
- No Drive advanced service or `DriveApp`. XLS conversion uses the Drive REST API
  under `drive.file`. Preserve the manifest's narrow scopes and fetch whitelist;
  add a host only when a required integration needs it.
- Install triggers through menu actions / editor Triggers, never at startup.
  Monthly import uses `autoImportMonthly`; hourly PAN write-back is a different job.
  Preserve existing schedules during routine redeployment.
- Donation Day installs a 10-minute `donationDayTick` trigger, expires after 3 hours,
  and removes hourly email/nudge triggers when enabled. Those are not auto-restored.
- Run relevant checks before committing. Stage only intended files; never include
  agent attribution, watermarks, session URLs, or `Co-Authored-By` trailers.

## Knowledge graph

After a commit, refresh the gitignored `graphify-out/` through the graphify skill
pipeline. Documentation/HTML changes need semantic extraction; an AST-only update
cannot refresh them. **Never run bare `graphify update .` here**: stock detection
ignores `.gs` and can drop Apps Script files. Apply this before detection/extraction:

```python
import graphify.detect as detect
import graphify.extract as extract
detect.CODE_EXTENSIONS.add('.gs')
extract._DISPATCH['.gs'] = extract._DISPATCH['.js']
```

Preserve `graphify-out/cache/`. AST extraction uses no LLM; changed semantic content
can consume tokens, so do not claim every update is free. Confirm all nine Apps
Script files remain represented and the report names the final commit. Details:
[`docs/GRAPHIFY.md`](docs/GRAPHIFY.md).

## Coding conventions

Keep changes terse and match the existing Apps Script V8 style (`const`, private
helpers ending in `_`). State-changing actions append an audit entry through
`auditLog(...)`; keep entries PAN-masked. Keep UI assets local, with associated
labels, keyboard submission, responsive layouts, and recoverable loading/errors.
