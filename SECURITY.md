# Security Policy

This project handles donor identity and financial data. Use private disclosure
for vulnerabilities, leaked credentials or signed links, and suspected donor-data
exposure. Do not put sensitive evidence in public issues, PRs, discussions, or commits.

## Supported code and deployments

Security fixes are maintained on `main`. There are no maintained semantic-version
release lines or guaranteed backports to older commits.

A Git commit, Apps Script saved source, and a versioned web-app deployment are
separate states. Operators must deploy a fix: update saved source and each affected
active web-app deployment. Existing public URLs keep running their assigned version
until updated or retired. Preserve URLs when updating them so donor links keep working.

## Report privately

Use [Report a vulnerability](https://github.com/kapaggar/dhamma-sudha-80g/security/advisories/new)
on this repository's **Security → Advisories** page. Private vulnerability reporting
is enabled. Sign in to GitHub to submit the report; do not open a public bug report
with exploit details.

If that option is unavailable, open a public issue containing only a request for
a private security contact. Wait for the maintainer to establish a private channel
before sharing details. GitHub profile mentions are not private messages.

Include only what is needed to reproduce the problem safely:

- Affected file/function and commit; Apps Script version if known.
- Expected versus observed behavior and the access an attacker would need.
- Reproduction steps using synthetic records and placeholders.
- Impact and any suggested fix or regression test.

Do not send raw donor rows, full PAN/other identity values, working signed links,
Script Property values, passwords, session cookies, or OAuth tokens. Redact these
from logs and screenshots too. If the flaw involves real data, describe the data
category and access path without copying the records.

The maintainer will triage through the private report and coordinate validation,
remediation, and disclosure there. This small project has no fixed response-time
SLA or guaranteed bounty. Please keep details private while remediation is coordinated.

## Relevant security boundaries

- Donor forms run anonymously as the deployer, but `doGet` and `submitForm` require
  the email's HMAC token for donor records and updates. Tokens are deterministic
  and non-expiring; possession of a link is sensitive access to its form.
- `generateToken_`, `readProp_`, and `getSpreadsheet_` use the trailing `_`
  convention to remain inaccessible through `google.script.run`.
- Public admin entry points require `requireAdminContext_` before side effects.
  Matching `SHEET_ID` alone is insufficient: the invocation also needs spreadsheet
  UI access or the native `AuthMode.FULL` object from a matching installed clock
  trigger. String/JSON lookalikes must never grant that access.
- Full PAN is permitted only in `pan_collected`, `submissions.pan`, and the
  `ready_for_80g` export. PAN masking does not anonymize donor identifiers elsewhere.
- Project editors can access Script Properties through code. Restrict spreadsheet,
  script, log, export, and credential access to trusted operators.
- Drive conversion uses `drive.file` through REST; the manifest pins outbound hosts.
  Do not expand scopes or add arbitrary fetch destinations to work around a bug.

Implementation details and validation limits are in [AGENTS.md](AGENTS.md),
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/REVIEW.md](docs/REVIEW.md).

## Testing and incident handling

Use a separate bound development project and synthetic data. Do not probe donor
links, enumerate donors, send messages, or edit production donations without the
operator's explicit authorization. The MIT license does not authorize access to
production accounts or donor data.

If a deployment or credential is compromised, privately coordinate containment
with the operator: restrict affected access, pause affected schedules where needed,
rotate exposed credentials, deploy fixes, and verify the relevant access boundary.
Changing `TOKEN_SECRET` invalidates every outstanding donor link and requires a
replacement-link plan. Preserve necessary incident evidence in restricted storage;
do not publish it in the repository.

Code fixes do not clean historical rows, downloaded exports, old logs, or Git
history. `submissions.source_link_token` currently stores signed tokens, and there
is no automatic retention cleanup, per-donor token revocation, or form rate limiter.
Track any required data cleanup separately from the code release. This policy is
not a guarantee that all vulnerabilities have been found.
