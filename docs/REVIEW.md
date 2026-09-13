# Repository bug fixes and UI refresh

Reviewed the Apps Script files and HTML screens against the repository's documented
data model and deployment constraints. All test records and preview data are synthetic.

## Fixed bugs

| Area | Failure before | Result now |
|---|---|---|
| Browser access | Public token generator and leading-underscore credential reader were browser-callable; admin actions had no context gate | Sensitive helpers are private; admin entry points require the configured spreadsheet plus UI access or a native installed clock event before side effects |
| Token diagnostics | Invalid submissions logged donor identity, supplied tokens, and valid expected tokens | Validation never logs token values or donor identity |
| Form submission | Malformed payloads threw; truthy nonboolean consent was accepted; a missing submissions sheet could leave partial donor updates | Defensive payload checks, explicit boolean consent, and storage preflight before writes |
| Import dates/files | Impossible or reversed dates passed server checks; upload size/type limits were client-only; XLSX used XLS MIME type | Server validates dates and upload limits; XLSX MIME type is preserved; temporary filenames are generated |
| Concurrent imports | Two imports could read the same receipt set and both append | Sheet read/dedup/append is locked and flushed together; network work stays outside the lock |
| PAN classification | Valid PAN with no email was excluded; invalid PAN could be propagated; repeat donors depended on import order | Validate PAN before classification and auto-fill; consider valid PANs throughout the current report |
| PAN storage/export | Source PAN copied unmasked into R; malformed legacy values could be exported | New imports mask source PAN; export only includes validated PAN values |
| Receipt mapping | A neighboring HTML row could supply the wrong receipt for an edit link | Only unambiguous receipt/ID pairs within the same row are mapped |
| Write-back preflight | Placeholders with nonempty values and blank-valued real labels passed required-field checks | Both are rejected; real `Non Course` with value `0` still passes |
| PAN repair | `id_type=PAN` caused unconditional skipping even with an invalid PAN | Donor-submitted valid PAN can repair invalid source PAN; valid live PAN still causes a safe skip |
| Donation Day | A tick at the exact expiry instant still ran | The deadline is inclusive |
| Form state | Any matching record could display “Already received” | That state requires a `have_pan` record |

The access changes follow Google's documented
[private-function convention](https://developers.google.com/apps-script/guides/html/communication#private_functions)
and [native trigger events](https://developers.google.com/apps-script/guides/triggers/events).
Live validation caught an incorrect initial assumption: anonymous callbacks retain
the active container, but cannot access the spreadsheet UI. The corrected gate
requires UI access or a native installed clock event in addition to matching the
configured Sheet. It adds no OAuth scopes and preserves installed handler names.
Regression mocks now reproduce the observed browser context and reject serialized
trigger-event lookalikes. A live invalid-date RPC was rejected before import, and a
temporary clock probe verified the native event passes the gate. The probe logged
its result and removed its trigger; it did not process donors or send messages.

## UI changes

- Shared green/cream styling, responsive donor details and form layout, and readable receipt amounts.
- Semantic forms, associated labels, keyboard submission, focus handling, inline validation, and announced status messages.
- Busy controls block duplicate requests; failed and empty responses restore a usable form.
- Success clears the PAN input and explains the next step without promising a certificate delivery time.
- Date/file import dialogs show progress and readable multiline totals, including records without email.
- Consistent already-received, no-pending, and invalid-link screens; mobile viewport set in Apps Script.

## Validation

```bash
node --test tests/*.test.cjs
node tests/preview.cjs
```

The offline suite includes the existing Apps Script tests and regression cases for
the changed boundaries, import processing, submission state, write-back preflight,
and HTML client handlers. Google services are mocked; no messages or live writes run.

Isolated Chrome checks covered six page states at 320, 375, 768, and 1200px widths:
no horizontal overflow or JavaScript errors. Also checked Enter-to-submit, single
request behavior, success with PAN clearing, imports/uploads, and failure recovery.
Local templates approximate Apps Script evaluation; this does not prove production
sandbox or Google service integration.

## Release and live validation

The review used local tests and synthetic data. Deployment is a separate release
step; the checks below exercise live integrations that the offline suite cannot
verify. Credential rotation, donor-data migration, and live dana write-back are
outside this review.

1. In a staging copy bound to its configured Sheet, run `runAllTests`, open both
   admin dialogs, and exercise an existing time trigger. Verify the context gate
   allows those paths and rejects admin RPCs from the anonymous donor web app.
2. Check a fresh signed donor link and its successful/duplicate submission states.
3. Validate receipt mapping against current portal markup using a dry run. Use
   `previewWriteBackToDana` before any real push; live notification field names
   still need confirmation as documented in `WriteBack.gs`.
4. Release with `clasp push` and a new web-app deployment version. Existing public
   versions retain the old code until updated or retired.

Old rows and historical logs may contain values written by earlier versions. These
fixes govern new writes; cleanup and any secret rotation require a separate plan,
especially because changing `TOKEN_SECRET` invalidates outstanding donor links.
