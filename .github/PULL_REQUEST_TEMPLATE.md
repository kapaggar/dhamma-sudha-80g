# Summary

<!-- What does this PR change, and why? Link the issue if one exists. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Docs only
- [ ] Refactor / cleanup

## Data-safety checklist (required — see CONTRIBUTING.md)

- [ ] No real donor data, PAN, or `id_value` anywhere in this PR (code, tests,
      commit messages, screenshots) — placeholders only (`<donor>`, `<pan>`,
      `ABCDE1234F`)
- [ ] No secrets: no `DANA_*` / `WA360_*` / `TOKEN_SECRET` values; config reads
      come from Script Properties
- [ ] Any new PAN display path uses `maskPAN` / `maskPanInText_`
- [ ] New state-changing actions append to `audit_log` via `auditLog(...)`

## Code checklist

- [ ] `runAllTests` passes in the Apps Script editor (paste pass count below)
- [ ] New pure logic has assertions in `Tests.gs`
- [ ] `donors_input` column order (A–Z) untouched — or `initSheets`,
      `migrateSchema`, `processRows_`, and all index-based readers updated
      together
- [ ] Docs updated where relevant: `CLAUDE.md`, `docs/ARCHITECTURE.md`,
      `docs/DECISIONS.md`, `README.md`
- [ ] If this touches `WriteBack.gs` / `DanaImport.gs`: manual verification
      described below (`previewWriteBackToDana` dry run, or
      `diagnoseDanaWriteBack` output — PAN-masked)

## Test evidence

<!-- runAllTests output summary, dry-run notes, manual verification steps.
     Placeholders only — never real donor rows. -->
