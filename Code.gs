// Code.gs

function getSpreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID script property not set.');
  return SpreadsheetApp.openById(id);
}

function getCenterName() {
  return PropertiesService.getScriptProperties().getProperty('CENTER_NAME') ||
    'Dhamma Sudha Vipassana Centre';
}

// ---------------------------------------------------------------------------
// Web app entry point
// ---------------------------------------------------------------------------

function doGet(e) {
  const p = e.parameter;
  const token = p.token;
  const email = p.email;

  if (!token || !email) {
    return errorPage('Invalid Link', 'This link is missing required parameters. Please use the original link from your email.');
  }
  if (!validateToken(token, email)) {
    return errorPage('Invalid Link', 'This link appears to be invalid or tampered. Please use the original link from your email.');
  }

  const ss = getSpreadsheet();
  const donorsSheet = ss.getSheetByName('donors_input');

  if (!donorsSheet || donorsSheet.getLastRow() < 2) {
    return errorPage('No Records', 'No donation records found for this email.');
  }

  // Find all need_pan rows for this email
  const data = donorsSheet.getDataRange().getValues();
  const emailLower = email.toLowerCase().trim();
  const pendingReceipts = [];
  let donorName = '';

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if ((row[4] || '').toString().toLowerCase().trim() !== emailLower) continue;
    if (!donorName) donorName = row[3] || '';

    if (row[20] === 'need_pan') {
      pendingReceipts.push({
        receiptNo: row[0],
        txnDate: formatDateForDisplay_(row[1]),
        amount: row[14],
        course: row[10] || 'Donation'
      });
    }
  }

  // Already submitted? (no need_pan rows but some have_pan rows)
  const alreadySubmitted = pendingReceipts.length === 0 && data.some(r =>
    (r[4] || '').toString().toLowerCase().trim() === emailLower);

  // Get the first mobile we find for this email
  let mobile = '';
  for (let i = 1; i < data.length; i++) {
    if ((data[i][4] || '').toString().toLowerCase().trim() === emailLower && data[i][5]) {
      mobile = data[i][5]; break;
    }
  }

  const tmpl = HtmlService.createTemplateFromFile('Form');
  tmpl.email = email;
  tmpl.token = token;
  tmpl.donorName = donorName;
  tmpl.mobile = mobile;
  tmpl.pendingReceipts = pendingReceipts;
  tmpl.alreadySubmitted = alreadySubmitted;
  tmpl.centerName = getCenterName();

  return tmpl.evaluate()
    .setTitle('PAN Submission - 80G Certificate');
}

function errorPage(title, msg) {
  return HtmlService.createHtmlOutput(
    `<div style="font-family:sans-serif;max-width:500px;margin:60px auto;padding:20px">
       <h2 style="color:#c00">${title}</h2><p style="color:#555;margin-top:10px">${msg}</p></div>`
  ).setTitle(title);
}

function formatDateForDisplay_(d) {
  if (!d) return '';
  try {
    if (d instanceof Date) return Utilities.formatDate(d, 'Asia/Kolkata', 'dd MMM yyyy');
    return d.toString();
  } catch (_) { return d.toString(); }
}

// ---------------------------------------------------------------------------
// Form submission
// ---------------------------------------------------------------------------

function submitForm(data) {
  // Diagnostic logging for token issues
  Logger.log('submitForm called. email=' + JSON.stringify(data.email) +
    ' token length=' + (data.token ? data.token.length : 0));

  if (!validateToken(data.token, data.email)) {
    Logger.log('Token mismatch. Expected: ' + generateToken(data.email || ''));
    Logger.log('Got:              ' + data.token);
    return { success: false, error: 'Invalid or tampered submission token.' };
  }
  if (!data.consent) {
    return { success: false, error: 'Consent is required to proceed.' };
  }
  if (!data.pan) {
    return { success: false, error: 'PAN is required.' };
  }

  const r = validateAndNormalizePAN(data.pan);
  if (!r.valid) return { success: false, error: r.error };
  const pan = r.pan;

  // Serialize concurrent submissions (double-click, two tabs, repeat donor) so the
  // read-modify-write of donors_input + submissions cannot interleave.
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (lockErr) {
    return { success: false, error: 'The system is busy. Please try again in a moment.' };
  }

  try {
    const ss = getSpreadsheet();
    const donorsSheet = ss.getSheetByName('donors_input');
    if (!donorsSheet || donorsSheet.getLastRow() < 2) {
      return { success: false, error: 'No records found.' };
    }

    const emailLower = data.email.toLowerCase().trim();
    const allData = donorsSheet.getDataRange().getValues();
    const now = new Date().toISOString();
    const updatedReceipts = [];
    let donorName = '';
    let donorMobile = '';

    // Update all need_pan rows for this email; pan_name = existing full_name on file
    for (let i = 1; i < allData.length; i++) {
      const row = allData[i];
      if ((row[4] || '').toString().toLowerCase().trim() !== emailLower) continue;
      if (!donorName && row[3]) donorName = row[3];
      if (!donorMobile && row[5]) donorMobile = row[5];

      if (row[20] !== 'need_pan') continue;
      const rowNum = i + 1;
      donorsSheet.getRange(rowNum, 19).setValue(pan);                          // S pan_collected
      donorsSheet.getRange(rowNum, 20).setValue(donorName.toUpperCase());      // T pan_name (from existing record)
      donorsSheet.getRange(rowNum, 21).setValue('have_pan');                   // U pan_status
      donorsSheet.getRange(rowNum, 24).setValue(now);                          // X pan_submitted_at
      updatedReceipts.push(row[0]);
    }

    if (updatedReceipts.length === 0) {
      return { success: false, error: 'No pending PAN requests found. You may have already submitted.' };
    }

    const subSheet = ss.getSheetByName('submissions');
    const subId = Utilities.getUuid();
    subSheet.appendRow([
      subId, emailLower, donorMobile, pan, donorName.toUpperCase(),
      updatedReceipts.join(','), updatedReceipts.length,
      now, data.token, now, now, ''
    ]);

    auditLog(ss, 'form_submit', 'pan_collected',
      emailLower, 'pan', '', maskPAN(pan), subId);

    const logSheet = ss.getSheetByName('email_log');
    if (logSheet && logSheet.getLastRow() > 1) {
      const logData = logSheet.getDataRange().getValues();
      for (let i = 1; i < logData.length; i++) {
        if ((logData[i][0] || '').toString().toLowerCase().trim() === emailLower && !logData[i][5]) {
          logSheet.getRange(i + 1, 6).setValue(now); // submitted_at
          break;
        }
      }
    }

    return { success: true, count: updatedReceipts.length };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// One-time setup
// ---------------------------------------------------------------------------

function migrateSchema() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName('donors_input');
  if (!sheet) { SpreadsheetApp.getUi().alert('donors_input sheet not found.'); return; }
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  let added = 0;
  if (headers.indexOf('dana_donation_id') < 0) {
    sheet.getRange(1, sheet.getLastColumn() + 1).setValue('dana_donation_id')
      .setFontWeight('bold').setBackground('#3c6e47').setFontColor('#ffffff');
    added++;
  }
  if (headers.indexOf('dana_updated_at') < 0) {
    sheet.getRange(1, sheet.getLastColumn() + 1).setValue('dana_updated_at')
      .setFontWeight('bold').setBackground('#3c6e47').setFontColor('#ffffff');
    added++;
  }
  SpreadsheetApp.getUi().alert('Schema migration: added ' + added + ' column(s).');
}

function initSheets() {
  const ss = getSpreadsheet();

  getOrCreateSheet(ss, 'donors_input', [
    'receipt_no', 'txn_date', 'created_on',
    'full_name', 'email', 'mobile',
    'address', 'city', 'state', 'country',
    'course', 'category', 'txn_type',
    'payment_mode', 'amount', 'merchant_ref',
    'id_type', 'id_value',
    'pan_collected', 'pan_name', 'pan_status',
    'comment', 'imported_at', 'pan_submitted_at',
    'dana_donation_id', 'dana_updated_at'
  ]);

  getOrCreateSheet(ss, 'submissions', [
    'submission_id', 'email', 'mobile',
    'pan', 'pan_name',
    'receipt_nos', 'receipt_count',
    'consent_timestamp', 'source_link_token',
    'created_at', 'updated_at', 'notes'
  ]);

  getOrCreateSheet(ss, 'email_log', [
    'email', 'receipt_nos_in_email', 'sent_at',
    'email_status', 'reminder_count', 'submitted_at', 'last_reminder_at'
  ]);

  getOrCreateSheet(ss, 'audit_log', [
    'timestamp', 'actor', 'action', 'record_key',
    'field_changed', 'old_value', 'new_value', 'source_id'
  ]);

  getOrCreateSheet(ss, 'import_log', [
    'import_start', 'import_end', 'imported_at',
    'total', 'added', 'skipped',
    'need_pan', 'have_pan', 'auto_filled', 'no_email'
  ]);

  getOrCreateSheet(ss, 'wa_log', [
    'phone', 'email', 'receipt_nos_in_wa', 'sent_at',
    'wa_status', 'wa_message_id', 'reminder_count', 'submitted_at', 'last_reminder_at'
  ]);

  SpreadsheetApp.getUi().alert('All sheets initialized with new schema.');
}
