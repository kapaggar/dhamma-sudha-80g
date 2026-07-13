# Decisions & Design Patterns

Running log of non-obvious decisions and the patterns behind them, so a future
session (human or AI) doesn't re-derive or accidentally reverse them. Newest first.
Architecture depth lives in [`ARCHITECTURE.md`](ARCHITECTURE.md); gotchas in
[`../CLAUDE.md`](../CLAUDE.md).

## 2026-07 — Minimal OAuth scopes: `drive` → `drive.file`, `userinfo.email` dropped, fetch whitelist

`appsscript.json` now requests `drive.file` instead of full `drive` and no longer
requests `userinfo.email`. The remaining scopes map 1:1 to used services
(spreadsheets/openById, container.ui, send_mail, scriptapp triggers,
external_request) and cannot shrink further — `spreadsheets.currentonly` is
impossible because the web app and the temp XLS conversions open sheets by ID.

**Decisions:**

- **`userinfo.email` dropped: failure alerts go to the `ADMIN_EMAIL` Script
  Property** (`getAdminEmail_` in `Utils.gs`), not `Session.getActiveUser()`. If
  the property is unset the alert is silently skipped (failures still land in the
  execution log). Don't reintroduce `Session.getActiveUser()` without re-adding the
  scope — it throws under the explicit `oauthScopes` list.
- **`urlFetchWhitelist` pins UrlFetchApp to the dana portal, 360dialog, and
  `www.googleapis.com` hosts.** All were already documented in-repo, so the
  manifest leaks nothing new. If `DANA_URL`/`WA360_URL` ever point elsewhere,
  fetches fail with "URL not permitted" until the whitelist is updated and pushed.
- **`drive.file` only grants access to files the script itself created.** The
  temp XLS→Sheet conversions qualify; reading an arbitrary Drive file ID does not.
  The old fallback ("upload XLS to Drive, paste file ID") was therefore replaced
  with `UploadDialog.html`: the admin picks the file from their computer, it's sent
  as base64 via `google.script.run` (10 MB client-side cap), and `runUploadImport`
  creates the conversion itself. Menu item renamed to **Import XLS from Computer**
  (`importXlsFromComputer`). Don't "fix" a `File not found` here by restoring full
  `drive` — the file wasn't app-created.
- **Drive calls use the REST API, not `Drive.Files.*` or `DriveApp`.** Both the
  Drive advanced service and `DriveApp` hard-require the full `drive` scope and
  throw `You do not have permission to call drive.files.insert. Required
  permissions: .../auth/drive` under `drive.file` — even though the REST endpoints
  accept `drive.file` for app-created files. `driveCreateSheetFromBlob_` (multipart
  upload with conversion) and `driveDeleteFile_` in `DanaImport.gs` call
  `www.googleapis.com` directly with `ScriptApp.getOAuthToken()`. The Drive v2
  advanced service was removed from `appsscript.json` (no editor enable step
  anymore); temp files are now hard-deleted instead of trashed (donor data
  shouldn't linger in the bin).
- **Scope changes require re-authorization.** After `clasp push`, every admin must
  re-run a menu function and accept the new (smaller) consent screen; installed
  triggers keep running under the old grant until then. The web app deployer should
  re-authorize and cut a new deployment version.

## 2026-07 — Donation Day mode (`DonationDay.gs`, commit 61352ca)

One admin-menu toggle runs a 10-minute tick (dana import → PAN-request emails →
WhatsApp nudges) and self-expires 3 hours after enable.

**Decisions:**

- **Self-expiry via Script Property, not a second trigger.** `DONATION_DAY_UNTIL`
  holds an ISO expiry; each tick checks `donationDayExpired_()` first and, when past,
  uninstalls its own trigger, clears props, audit-logs `donation_day_auto_off`, and
  emails the admin. A missing/unparseable property counts as expired (fail-safe: the
  loop stops rather than runs forever). Pure predicate extracted for `Tests.gs`.
- **Enable removes the hourly email/nudge triggers; they are NOT auto-restored.**
  `sendPendingEmails` and the WA nudge sender take no lock, so an hourly run
  overlapping a tick could double-send. Removing `autoSendEmailsHourly` /
  `autoSendWhatsAppNudgeHourly` for the window eliminates the race; auto-restoring
  them on expiry risked silently resurrecting triggers the admin had deliberately
  disabled, so the admin re-enables from menus 2/4 if a backlog remains (disable
  alert + auto-off email say so).
- **Import runs lock-free; only sends take `tryLock(0)`.** Import is idempotent
  (receipt_no dedup in `processRows_`), and donor form submissions are the peak path
  on donation day — `submitForm` waits max 20 s on the script lock, so a tick must
  never hold it through a multi-minute import. If the lock is busy, sends are simply
  skipped that tick (next tick catches up via email_log/wa_nudge_log dedup).
- **Tick calls `runDanaImport_(range)` directly, not `autoImportMonthly`** — the
  latter emails admin, rethrows, and chains its own send, all wrong inside a loop.
  Range comes from `getDefaultRange_()` (resumes from last import_log end date, so
  it collapses to [today, today] after the first tick).
- **Error emails throttled to one per 30 min** (`DONATION_DAY_ERR_MAILED_AT` prop).
  A persistent Cloudflare block must not email the admin on all 18 ticks. Each stage
  has its own try/catch — a failed import never blocks sends.
- **Fresh dana login per tick** (~18 logins per 3 h window), consistent with every
  existing call site. If Cloudflare starts challenging, cache the SSESS cookie in
  `CacheService` (~25 min TTL) — noted as follow-up, deliberately not built.
- **Zero-row imports still write to `import_log`** — ~18 rows per event is cheap and
  is the run evidence; `getLastImportEnd_` reads only the last row.
- Quota math checked, no caps changed: 18 ticks × 20–40 s ≈ 6–12 min/day trigger
  runtime; `EMAIL_MAX_PER_RUN` (10) / `WA_MAX_PER_RUN` (50) remain overridable via
  Script Properties per event; quota/429 exhaustion already degrades gracefully.

**Patterns established:**

- **Trigger lifecycle**: `deleteTriggersByHandler_(name)` loop over
  `getProjectTriggers()` → delete by `getHandlerFunction()` → recreate. Copies exist
  in Email/Whatsapp/WriteBack; deliberately not refactored to shared code.
- **Mode-with-expiry**: menu toggle sets an ISO Script Property; the trigger handler
  is responsible for its own shutdown. First use of `setProperty` in the codebase
  (plain, not base64 — it's not a secret).
- Every state change audit-logged (`donation_day_enabled/disabled/auto_off`); one
  JSON `Logger.log` summary per tick.

## 2026-07 — Do NOT expose a WhatsApp-send API from this script

Question: can other projects call this Apps Script as a WhatsApp gateway? Decision:
**no — call 360dialog directly from those projects.** Reasons:

- The web app deploys as `ANYONE_ANONYMOUS` for the donor form; a send endpoint on
  the same deployment would be an unauthenticated relay. Apps Script also drops
  custom auth headers on `doPost`, so real authentication isn't achievable.
- It would put other projects' traffic inside this script's MailApp/UrlFetch quotas
  and its audit trail, and blur the NPI boundary (this sheet holds donor PAN data;
  other projects should never transit it). Sharing the `WA360_*` key means storing
  it in each project's own secret store, not proxying through here.

## 2026-07 — `.claspignore` is required (root allowlist)

`clasp push -f` uploaded `graphify-out/graph.html` into the Apps Script project
(clasp pushes every pushable file under the root by default). `.claspignore` now
allowlists only root `*.gs`, `*.html`, `appsscript.json`. Note clasp semantics: the
file **replaces** defaults entirely — the `**/**` deny + `!` includes are all
required. If you add a new source file type, extend the allowlist or it silently
won't push.

## 2026-07 — graphify needs a `.gs` runtime patch; bare CLI is unsafe here

Stock graphify doesn't recognise `.gs` (it's plain JS): the bare `graphify update .`
CLI silently drops every Apps Script file from the graph (observed: 303 → 111
edges). Rebuilds must patch before detect/extract:

```python
import graphify.detect as gd; gd.CODE_EXTENSIONS.add('.gs')
import graphify.extract as ge; ge._DISPATCH['.gs'] = ge._DISPATCH['.js']; ge._JS_CACHE_BYPASS_SUFFIXES.add('.gs')
```

If the bare CLI already ran and shrank the graph, re-run patched AST extraction and
merge with the cached semantic layer (the semantic cache makes this ~free). Details:
[`GRAPHIFY.md`](GRAPHIFY.md).

## Standing constraints (why things look the way they do)

- **NPI/PII**: donor names, emails, mobiles, PAN, amounts, `id_value` never leave
  the Google account — not in commits, filenames, logs, web searches, or summaries.
  PAN masked everywhere except `pan_collected`, `submissions.pan`, `ready_for_80g`.
- **Secrets** live only in Script Properties; nothing in git may contain one.
- **`donors_input` columns are index-addressed** — never reorder A–Z.
- **Token = HMAC(email), non-expiring** — changing `TOKEN_SECRET` or the format
  breaks all outstanding donor links.
- **dana = Drupal 7 + Cloudflare** — Chrome UA header on every request, 3-step
  login, POST-before-XLS; write-back replays the full edit form with only
  `d_id_type`/`d_id_no` changed and notification flags suppressed.
