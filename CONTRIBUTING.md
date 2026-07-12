# Contributing

Thanks for helping improve the Dhamma Sudha 80G automation. This is a small
Google Apps Script project run by a 1–3 person non-technical admin team, so the
bar is: **simple, auditable, and safe with donor data**.

Read these first — most review feedback comes from them:

- [`CLAUDE.md`](CLAUDE.md) — must-know layer: gotchas, file map, conventions
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — data flows, triggers, security model
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — settled decisions; don't reverse them without discussion

## The one non-negotiable rule: donor data (NPI/PII)

Donor names, emails, mobiles, PAN, donation amounts, and `id_value` are
personal/financial data. In issues, PRs, commits, branch names, code comments,
tests, and screenshots:

- **Never include real donor data, PAN numbers, or `DANA_*`/`WA360_*`
  credentials or Script Property values.** Use placeholders: `<donor>`, `<pan>`,
  `<donation_id>`, `ABCDE1234F` (the standard fake PAN used in `Tests.gs`).
- PAN stays masked (`ABCDE****F`) in every view except `pan_collected`,
  `submissions.pan`, and the `ready_for_80g` export. If your change surfaces PAN
  anywhere new, mask it via `maskPAN` / `maskPanInText_`.
- All secrets live in Apps Script **Script Properties**. Nothing committed to
  git may contain a secret. If you accidentally commit one, rotate it — history
  rewrites are not sufficient.

PRs violating this are closed on sight, and the offending commits must be
purged before re-submission.

## Development setup

There is no local runtime — code executes only in Google Apps Script.

1. Install [clasp](https://github.com/google/clasp): `npm i -g @google/clasp`
2. `clasp login` (one-time), then work against your **own** Apps Script project
   + spreadsheet for development. Do not develop against the production sheet.
3. `clasp push` to deploy code. Web-app changes (`Code.gs` doGet/submitForm,
   `Form.html`) additionally need: Apps Script editor → Deploy → Manage
   deployments → New version.
4. Enable the Drive API v2 advanced service in the editor (Services → Drive API v2).
5. `.claspignore` allowlists root `*.gs`, `*.html`, `appsscript.json` only. If
   you add a new source file type, extend the allowlist or it silently won't push.

## Making changes

- **Style**: match the existing `.gs` code — V8 runtime, `const`, terse, no
  speculative abstraction, trailing `_` for private functions.
- **`donors_input` is index-addressed (columns A–Z).** Never reorder columns.
  Adding one means updating `initSheets`, `migrateSchema`, `processRows_`, and
  every index-based reader — see CLAUDE.md before touching this.
- **Auditability**: every state-changing action appends to `audit_log` via
  `auditLog(...)`, PAN-masked. Keep new writes consistent with that.
- **Write-back safety**: run `previewWriteBackToDana` (dry run) before any real
  push; use `diagnoseDanaWriteBack(donationId)` (GET-only) to debug a single
  record. Don't weaken the pre-flight skips or the circuit breaker.
- **Triggers** are installed via the `80G Admin` menu at runtime, never in code
  at startup. Follow the existing `deleteTriggersByHandler_`-style
  delete-then-recreate pattern.

## Testing

- Add assertions to `Tests.gs` for any new pure logic (see the
  `donationDayExpired_` and PAN/token tests for the pattern).
- Run `runAllTests` from the Apps Script editor and include the pass count in
  your PR. There are no live dana/network tests — changes to `DanaImport.gs` /
  `WriteBack.gs` need a manual verification note instead (what you ran, against
  what data — described with placeholders, never real donor rows).

## Submitting a PR

1. Branch from `main`.
2. Keep PRs small and single-purpose; commit messages follow the existing
   `type(scope): summary` style (`feat:`, `fix:`, `docs:`, …).
3. Update docs in the same PR: CLAUDE.md (if a gotcha/file changed),
   ARCHITECTURE.md (if a flow/trigger changed), DECISIONS.md (if you made a
   non-obvious call).
4. Fill in the PR template — the checklist mirrors this document.
5. One maintainer review is required. Expect questions about data handling
   before anything else.

## Questions / security issues

Open a GitHub issue for questions. For anything security-sensitive (e.g., a way
to bypass the HMAC token, or donor-data exposure), **do not open a public
issue** — contact the maintainer (@kapaggar) privately first.
