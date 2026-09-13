const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, donor } = require('./helpers.cjs');

const email = 'sample@example.invalid';
const pan = 'ABCDE1234F'; // Synthetic format fixture, never donor data.
const tokenFor = c => (c.generateToken_ || c.generateToken)(email);
const reportHeader = ['Receipt No', 'Full Name', 'Email', 'ID Type', 'Passport ID', 'Cash'];
function importRows(h, rows) {
  return h.context.processRows_([reportHeader, ...rows], h.context.mapColumns_(reportHeader), {});
}

test('existing Apps Script unit suite passes without live services', () => {
  const h = harness();
  h.context.runAllTests();
  assert.ok(h.logs.some(s => /0 failed/.test(s)));
  assert.ok(!h.logs.some(s => /skipped|^FAIL/.test(s)));
});

test('token failures do not log donor identity or signed links', () => {
  const h = harness();
  assert.equal(h.context.validateToken('tampered', email), false);
  h.context.submitForm({ email, token: 'tampered' });
  const log = h.logs.join('\n');
  assert.ok(!log.includes(email));
  assert.ok(!log.includes(tokenFor(h.context)));
  assert.ok(!log.includes('tampered'));
});

test('token generation and property decoding are unavailable as browser RPCs', () => {
  const { context: c } = harness({ anonymous: true });
  // Apps Script only exposes global functions without a trailing underscore.
  const rpc = name => {
    if (name.endsWith('_') || typeof c[name] !== 'function') throw Error('Private function');
    return c[name](email);
  };
  assert.throws(() => rpc('generateToken'), /Private/);
  assert.throws(() => rpc('_readProp'), /Private/);
});

const adminActions = [
  'onOpen', 'initSheets', 'migrateSchema', 'runAllTests', 'testConsentRequired',
  'importFromDanaPortal', 'importXlsFromComputer', 'runImportFromDialog', 'runUploadImport',
  'autoImportMonthly', 'testDanaImportLogin', 'testDanaReportFetch',
  'sendPendingEmails', 'sendReminders', 'autoSendEmailsHourly', 'installHourlyEmailTrigger',
  'disableHourlyEmailTrigger', 'reconcileEmailLogs', 'previewWriteBackToDana', 'pushPANsToDana',
  'autoWriteBackHourly', 'installHourlyTrigger', 'disableHourlyTrigger',
  'diagnoseDanaWriteBack', 'promptDiagnoseDanaWriteBack', 'refreshAdminReview', 'exportReadyFor80G',
  'sendPendingWhatsApp', 'sendHighValuePendingWhatsApp', 'sendPendingWhatsAppNudge',
  'promptTestWhatsApp', 'promptTestWhatsAppNudge', 'autoSendWhatsAppHourly',
  'installHourlyWhatsAppTrigger', 'disableHourlyWhatsAppTrigger', 'autoSendWhatsAppNudgeHourly',
  'installHourlyWhatsAppNudgeTrigger', 'disableHourlyWhatsAppNudgeTrigger',
  'enableDonationDayMode', 'disableDonationDayMode', 'donationDayStatus', 'donationDayTick'
];
for (const action of adminActions) {
  test(`anonymous browser cannot invoke ${action}`, () => {
    const h = harness({ anonymous: true });
    assert.throws(() => h.context[action](), /bound spreadsheet/i);
    assert.equal(h.fetches.length, 0);
    assert.ok(!h.events.includes('write'));
  });
}

test('admin operations reject a different bound spreadsheet', () => {
  const h = harness({ activeId: 'wrong-sheet' });
  assert.throws(() => h.context.exportReadyFor80G(), /bound spreadsheet/i);
});

test('malformed submission returns a recoverable error', () => {
  const h = harness();
  assert.equal(h.context.submitForm(null).success, false);
  assert.equal(h.context.submitForm({}).success, false);
});

test('consent requires boolean true before updating records', () => {
  const h = harness({ donors: [donor()] });
  const result = h.context.submitForm({ email, token: tokenFor(h.context), pan, consent: 'false' });
  assert.equal(result.success, false);
  assert.equal(h.sheets.donors_input.rows[1][20], 'need_pan');
});

test('missing submissions sheet cannot partially save a PAN', () => {
  const h = harness({ donors: [donor()], noSubmissions: true });
  const result = h.context.submitForm({ email, token: tokenFor(h.context), pan, consent: true });
  assert.equal(result.success, false);
  assert.equal(h.sheets.donors_input.rows[1][20], 'need_pan');
  assert.equal(h.events.includes('write'), false);
});

test('submission updates pending receipts once and keeps PAN out of audit log', () => {
  const h = harness({ donors: [donor(), donor({ 0: 'TEST-2' })] });
  const data = { email, token: tokenFor(h.context), pan, consent: true };
  assert.equal(h.context.submitForm(data).count, 2);
  assert.equal(h.sheets.submissions.rows.length, 2);
  assert.ok(!JSON.stringify(h.sheets.audit_log.rows).includes(pan));
  h.context.submitForm(data);
  assert.equal(h.sheets.submissions.rows.length, 2);
  assert.equal(h.events.at(-1), 'unlock');
});

for (const range of [['2026-04-02', '2026-04-01'], ['2026-02-30', '2026-03-01'], ['2026-13-01', '2027-01-01']]) {
  test(`rejects invalid import range ${range.join(' to ')} before import`, () => {
    const h = harness();
    h.context.runDanaImport_ = () => { throw Error('Import should not start'); };
    const result = h.context.runImportFromDialog(...range);
    assert.equal(result.success, false);
    assert.match(result.error, /date/i);
  });
}

test('same-day and leap-day date ranges remain valid', () => {
  const h = harness();
  h.context.runDanaImport_ = () => ({ added: 0 });
  assert.equal(h.context.runImportFromDialog('2024-02-29', '2024-02-29').success, true);
});

test('imports a valid PAN without email as ready and masks its source column', () => {
  const h = harness();
  const result = importRows(h, [['TEST-1', 'Sample', '', 'PAN', pan, 100]]);
  assert.equal(result.havePan, 1);
  const row = h.sheets.donors_input.rows[1];
  assert.equal(row[20], 'have_pan');
  assert.equal(row[18], pan);
  assert.equal(row[17], 'ABCDE****F');
});

test('invalid imported PAN is requested again and never auto-filled', () => {
  const h = harness({ donors: [donor({ 0: 'OLD', 16: 'PAN', 18: 'INVALID' })] });
  const result = importRows(h, [['TEST-1', 'Sample', email, 'PAN', 'INVALID', 100]]);
  assert.equal(result.needPan, 1);
  assert.equal(h.sheets.donors_input.rows[2][18], '');
});

test('same-batch repeat donors use valid PAN regardless of row order', () => {
  const h = harness();
  const result = importRows(h, [
    ['TEST-1', 'Sample', email, 'No ID', '', 100],
    ['TEST-2', 'Sample', email, 'PAN', pan, 100]
  ]);
  assert.equal(result.autoFilled, 1);
  assert.equal(result.needPan, 0);
  assert.equal(h.sheets.donors_input.rows[1][18], pan);
});

test('import reads and writes shared rows while holding the lock', () => {
  const h = harness({ donors: [donor()] });
  importRows(h, [['TEST-2', 'Sample', email, '', '', 100]]);
  assert.ok(h.events.includes('lock'));
  assert.ok(!h.events.includes('read:unlocked'));
  assert.ok(h.events.indexOf('flush') < h.events.indexOf('unlock'));
  assert.equal(h.events.at(-1), 'unlock');
});

test('duplicate receipts and formatted amounts import correctly', () => {
  const h = harness();
  const result = importRows(h, [
    ['TEST-1', 'Sample', email, '', '', '1,250.50'],
    ['TEST-1', 'Sample', email, '', '', '1,250.50']
  ]);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  assert.equal(h.sheets.donors_input.rows[1][14], 1250.5);
});

test('required select rejects a placeholder even when its value is nonempty', () => {
  const c = harness().context;
  const values = c.extractFormValues_('<select name="d_course"><option value="0">- Select -</option></select>');
  assert.equal(c.findEmptyRequiredFields_(values).length, 1);
});

test('required select rejects a blank value with a real label', () => {
  const c = harness().context;
  const values = c.extractFormValues_('<select name="d_course"><option value="">Non Course</option></select>');
  assert.equal(c.findEmptyRequiredFields_(values).length, 1);
});

test('required select accepts real zero-valued browser default', () => {
  const c = harness().context;
  const values = c.extractFormValues_('<select name="d_course"><option value="0">Non Course</option></select>');
  assert.equal(values.d_course, '0');
  assert.equal(c.findEmptyRequiredFields_(values).length, 0);
});

test('export excludes malformed legacy PAN values', () => {
  const h = harness({ donors: [donor({ 18: 'INVALID', 20: 'have_pan' }), donor({ 0: 'TEST-2', 18: pan, 20: 'have_pan' })] });
  h.context.exportReadyFor80G();
  assert.equal(h.sheets.ready_for_80g.rows.length, 2);
  assert.equal(h.sheets.ready_for_80g.rows[1][0], 'TEST-2');
});

test('Donation Day expires at the exact deadline', () => {
  const c = harness().context;
  const deadline = '2026-04-01T10:00:00.000Z';
  assert.equal(c.donationDayExpired_(deadline, Date.parse(deadline)), true);
});

test('write-back can repair imported PAN records whose original PAN was invalid', () => {
  const h = harness({ donors: [donor({ 16: 'PAN', 17: '**********', 18: pan, 20: 'have_pan', 24: '100' })] });
  assert.equal(h.context.findWriteBackCandidates_().length, 1);
});

test('valid PAN already imported from dana is excluded from write-back', () => {
  for (const original of [pan, 'ABCDE****F']) {
    const h = harness({ donors: [donor({ 16: 'PAN', 17: original, 18: pan, 20: 'have_pan' })] });
    assert.equal(h.context.findWriteBackCandidates_().length, 0);
  }
});

test('receipt mapping never borrows the receipt from another table row', () => {
  const c = harness().context;
  const result = c.parseReceiptToDonationIdMap_(
    '<table><tr><td>ER0001</td><td><a href="/donation/edit/101">Edit</a></td></tr>' +
    '<tr><td>No receipt</td><td><a href="/donation/edit/202">Edit</a></td></tr></table>');
  assert.equal(result.ER0001, '101');
  assert.equal(Object.values(result).includes('202'), false);
});

test('receipt mapping supports an edit link before its receipt within a row', () => {
  const c = harness().context;
  const result = c.parseReceiptToDonationIdMap_('<tr><td><a href="/donation/edit/101">Edit</a></td><td>ER0001</td></tr>');
  assert.equal(result.ER0001, '101');
});

test('upload rejects empty, oversized and non-spreadsheet files before Drive access', () => {
  const h = harness();
  for (const [data, filename] of [['', 'report.xls'], ['YQ==', 'report.txt'], ['A'.repeat(13981017), 'report.xls']]) {
    assert.equal(h.context.runUploadImport(data, filename).success, false);
  }
  assert.equal(h.fetches.length, 0);
});

test('XLSX uploads use the correct MIME type and a generated filename', () => {
  const h = harness();
  let uploaded;
  h.context.driveCreateSheetFromBlob_ = blob => { uploaded = blob; return 'temporary'; };
  h.context.processXlsFile_ = () => ({ added: 0 });
  h.context.driveDeleteFile_ = () => {};
  assert.equal(h.context.runUploadImport('YQ==', 'sample-report.xlsx').success, true);
  assert.equal(uploaded.getContentType(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(uploaded.getName(), 'dana_upload.xlsx');
});

for (const [originalPan, course, expected] of [
  ['INVALID', '<option value="0">Non Course</option>', 'post'],
  [pan, '<option value="0">Non Course</option>', 'ALREADY_PAN'],
  ['INVALID', '<option value="0">- Select -</option>', 'SKIP:']
]) {
  test(`live write-back preflight: ${expected}`, () => {
    const h = harness();
    const requests = [];
    const html = '<input name="form_build_id" value="synthetic-build">' +
      '<input name="form_token" value="synthetic-token">' +
      '<input name="d_full_name" value="Sample &amp; Co">' +
      '<input name="d_id_no" value="' + originalPan + '">' +
      '<select name="d_id_type"><option value="1" selected>PAN</option></select>' +
      '<select name="d_course">' + course + '</select>';
    h.context.UrlFetchApp.fetch = (url, opts) => {
      requests.push(opts);
      return { getResponseCode: () => opts.method === 'post' ? 302 : 200, getContentText: () => html, getAllHeaders: () => ({}) };
    };
    const run = () => h.context.postDonationEdit_('https://example.invalid', 'synthetic-cookie', '100', pan);
    if (expected === 'post') {
      assert.equal(run().code, 302);
      const payload = requests[1].payload;
      assert.equal(payload.d_id_no, pan);
      assert.equal(payload.d_course, '0');
      assert.equal(payload.d_full_name, 'Sample & Co');
      assert.equal(payload.email, '0');
      assert.equal(payload.whatsapp, '0');
      assert.equal(payload.__selectMeta, undefined);
    } else {
      assert.throws(run, new RegExp(expected));
      assert.equal(requests.length, 1);
    }
  });
}

test('conflicting receipt mappings are omitted', () => {
  const c = harness().context;
  const result = c.parseReceiptToDonationIdMap_(
    '<tr><td>ER0001</td><td><a href="/donation/edit/101">Edit</a></td></tr>' +
    '<tr><td>ER0001</td><td><a href="/donation/edit/202">Edit</a></td></tr>');
  assert.equal(Object.keys(result).length, 0);
});
