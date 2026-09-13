# Contributing

This project supports a small centre admin team. Changes should be simple to
operate, auditable, and careful with donor data.

Read [AGENTS.md](AGENTS.md) for shared project rules, [README.md](README.md) for
setup and the data model, and [docs/DECISIONS.md](docs/DECISIONS.md) before changing
an established workflow. Participation follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Report security problems using [SECURITY.md](SECURITY.md), not a public issue.

## Protect donor data

- Use synthetic fixtures and placeholders in code, tests, issues, PRs, screenshots,
  branches, and commit messages. Never include donor records, signed links,
  credentials, or Script Property values.
- Full PAN belongs only in `pan_collected`, `submissions.pan`, and the `ready_for_80g`
  export. Use `maskPAN` / `maskPanInText_` elsewhere. Other donor identifiers remain
  sensitive even when PAN is masked.
- Keep clasp authentication outside the repository. Inspect the target in
  `.clasp.json` before a push; a fresh clone must not accidentally target production.
- If sensitive content is exposed, stop sharing it and report privately. Removing
  a visible line does not remove existing copies. Coordinate credential rotation
  and history cleanup with the maintainer; changing `TOKEN_SECRET` also invalidates
  outstanding donor links.

## Local development

The offline suite and preview use Node.js 18+ with no npm dependencies. Use a
supported Node.js LTS release; current [clasp requires Node.js 22+](https://github.com/google/clasp#nodejs-version).

```bash
git clone https://github.com/kapaggar/dhamma-sudha-80g.git
cd dhamma-sudha-80g
node --test tests/*.test.cjs
node tests/preview.cjs
```

Open [the synthetic preview](http://127.0.0.1:8787/). The README lists its donor,
import, upload, success, and error routes. It mocks Google services and cannot send
messages or save donor data.

For Google integration work, create your own spreadsheet and its bound Apps Script
project through **Extensions → Apps Script**. Configure a local `.clasp.json` for
that project, run `clasp login`, and follow [Google setup](README.md#google-setup).
Use synthetic data and test recipients you control. Production deployment is a
separate maintainer action.

Preserve the narrow manifest scopes. XLS conversion uses Drive REST under
`drive.file`, not `DriveApp` or the Drive advanced service. `.claspignore` uploads
only root `*.gs`, `*.html`, and `appsscript.json`.

## Implementation requirements

- Match the existing V8 Apps Script style: `const`, concise functions, and `_` at
  the end of private helper names. A leading underscore is not browser privacy.
- Keep `requireAdminContext_` before admin side effects. Anonymous callbacks can
  retain the bound spreadsheet. Preserve the additional UI/native-clock-event
  checks, strict enum identity, event forwarding, and per-execution authorization.
- Preserve the HMAC token format and signing secret. Never log expected or supplied
  tokens or turn token generation/property readers into public browser functions.
- `donors_input` is addressed by column indexes. Never reorder A-Z; a schema change
  must update initialization, migration, import processing, and every indexed reader.
- Keep receipt deduplication and append in the same lock, with network work outside
  it. Validate PAN before classification, auto-fill, export, and write-back.
- Preserve live-form fields, receipt mapping boundaries, required-field skips,
  notification controls, and the write-back circuit breaker. Audit state changes
  using `auditLog(...)` without raw PAN or previous identity-document values.
- Keep UI assets local. Preserve labels, keyboard submission, focus handling,
  mobile layouts, duplicate-request prevention, and recovery after failed responses.
- Preserve trigger handler names and schedules. Install/remove schedules through
  deliberate menu/editor actions, not startup code or routine redeployment.

## Verification

Run `node --test tests/*.test.cjs` for application changes. Add focused regressions
for bugs or new behavior in `tests/*.test.cjs`; use `Tests.gs` when the assertion is
also useful inside Apps Script. Documentation-only edits need link, command, and
source-consistency checks rather than new implementation-mirroring tests.

For UI changes, use the preview to check narrow/mobile layouts, keyboard operation,
loading/duplicate submission, success, and failure recovery. For Google integration,
exercise the relevant paths in a development sheet and distinguish those checks
from the offline mocks. `runAllTests` in the bound editor is a smaller suite.

For dana changes, describe any controlled manual verification with placeholders.
`previewWriteBackToDana` makes no donation edits but may fetch report mappings;
`diagnoseDanaWriteBack(donationId)` is GET-only by default. Its optional POST probe
is a real write. Do not send donor messages or alter live donations just to obtain
test evidence. Document any live behavior that remains unverified.

## Commit and pull request

1. Branch from current `main`; keep the change focused and avoid generated/local
   files. Use concise `fix:`, `feat:`, or `docs:` commit subjects.
2. Update relevant documentation with the implementation: `AGENTS.md` for shared
   rules, README for operations, architecture for flows, and decisions for rationale.
   `CLAUDE.md` delegates to `AGENTS.md`; do not copy rules back into it.
3. State the problem, resulting behavior, tests run, and material validation limits
   in the PR. Fill in the template; mark irrelevant checks as not applicable and
   never claim a live check that was only mocked.
4. Keep attribution trailers, agent watermarks, and session URLs out of commits and
   PRs. Preserve copyright/license notices in source material.
5. Obtain a maintainer review before merging contributions.

After committing, refresh the gitignored knowledge graph through the graphify
skill with the `.gs` runtime patch. Changed documentation and HTML need the semantic
pass. Never use bare `graphify update .` or delete its cache; see
[docs/GRAPHIFY.md](docs/GRAPHIFY.md).

## Release responsibilities

A Git merge/push does not update Google. Authorized releases compare saved Google
source with the baseline, run `clasp push`, and assign a new version to existing
active web-app deployments while preserving URLs. Menu/trigger source updates at
push time; donor URLs keep their assigned versions until updated. Documentation-only
changes do not need a Google deployment. See [deployment](README.md#deployment).

Contributions are distributed under the repository's [MIT License](LICENSE).
