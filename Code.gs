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
  const token    = p.token;
  const courseId = p.course_id;
  const email    = p.email;

  if (!token || !courseId || !email) {
    return errorPage('Invalid Link', 'This link is missing required parameters. Please use the original link from your email.');
  }
  if (!validateToken(token, courseId, email)) {
    return errorPage('Invalid Link', 'This link appears to be invalid or tampered. Please use the original link from your email.');
  }

  const ss = getSpreadsheet();

  // Check for existing submission
  let alreadySubmitted = false;
  const submissionsSheet = ss.getSheetByName('submissions');
  if (submissionsSheet && submissionsSheet.getLastRow() > 1) {
    const data = submissionsSheet.getDataRange().getValues();
    alreadySubmitted = data.slice(1).some(row =>
      row[2] === email.toLowerCase().trim() &&
      row[1] === courseId.trim() &&
      ['pending_review', 'validated', 'merged'].includes(row[12])
    );
  }

  // Prefill from donors_input
  let prefillName = '', prefillMobile = '', courseStart = '', courseEnd = '';
  const donorsSheet = ss.getSheetByName('donors_input');
  if (donorsSheet && donorsSheet.getLastRow() > 1) {
    const donors = donorsSheet.getDataRange().getValues();
    for (let i = 1; i < donors.length; i++) {
      const row = donors[i];
      if (row[0] === courseId.trim() && row[4].toLowerCase().trim() === email.toLowerCase().trim()) {
        prefillName   = row[3] || '';
        prefillMobile = row[5] || '';
        try {
          if (row[1]) courseStart = Utilities.formatDate(new Date(row[1]), 'Asia/Kolkata', 'dd MMM yyyy');
          if (row[2]) courseEnd   = Utilities.formatDate(new Date(row[2]), 'Asia/Kolkata', 'dd MMM yyyy');
        } catch (_) {}
        break;
      }
    }
  }

  const tmpl = HtmlService.createTemplateFromFile('Form');
  tmpl.courseId        = courseId;
  tmpl.email           = email;
  tmpl.token           = token;
  tmpl.prefillName     = prefillName;
  tmpl.prefillMobile   = prefillMobile;
  tmpl.courseStart     = courseStart;
  tmpl.courseEnd       = courseEnd;
  tmpl.centerName      = getCenterName();
  tmpl.alreadySubmitted = alreadySubmitted;

  return tmpl.evaluate()
    .setTitle('PAN Submission - 80G Certificate')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DENY);
}

function errorPage(title, msg) {
  return HtmlService.createHtmlOutput(
    `<div style="font-family:sans-serif;max-width:500px;margin:60px auto;padding:20px">
       <h2 style="color:#c00">${title}</h2><p style="color:#555;margin-top:10px">${msg}</p></div>`
  ).setTitle(title);
}

// ---------------------------------------------------------------------------
// Form submission - called via google.script.run from Form.html
// ---------------------------------------------------------------------------

function submitForm(data) {
  // Server-side re-validation of token
  if (!validateToken(data.token, data.course_id, data.email)) {
    return { success: false, error: 'Invalid or tampered submission token.' };
  }
  if (!data.consent) {
    return { success: false, error: 'Consent is required to proceed.' };
  }
  if (!data.donors || data.donors.length === 0) {
    return { success: false, error: 'No donor information provided.' };
  }

  // Validate all PANs before writing (fail-fast)
  for (const d of data.donors) {
    const r = validateAndNormalizePAN(d.pan);
    if (!r.valid) return { success: false, error: 'Donor "' + (d.name || 'unnamed') + '": ' + r.error };
    if (!d.name_as_per_pan || !d.name_as_per_pan.trim()) {
      return { success: false, error: 'Name as per PAN is required for: ' + (d.name || 'unnamed') };
    }
    d.pan_normalized = r.pan;
  }

  const ss = getSpreadsheet();
  const subSheet = getOrCreateSheet(ss, 'submissions', [
    'submission_id', 'course_id', 'donor_email', 'donor_mobile',
    'name', 'name_as_per_pan', 'pan_normalized',
    'donation_amount', 'donation_date', 'payment_reference',
    'consent_timestamp', 'source_link_token', 'status',
    'created_at', 'updated_at', 'notes'
  ]);

  const now = new Date().toISOString();

  for (const donor of data.donors) {
    const dup    = findDuplicateSubmission(subSheet, data.email, donor.pan_normalized, data.course_id);
    const status = dup ? 'duplicate' : 'pending_review';
    const subId  = Utilities.getUuid();

    subSheet.appendRow([
      subId,
      data.course_id.trim(),
      data.email.toLowerCase().trim(),
      (data.mobile || '').trim(),
      (donor.name || '').trim(),
      donor.name_as_per_pan.trim().toUpperCase(),
      donor.pan_normalized,
      donor.donation_amount  || '',
      donor.donation_date    || '',
      donor.payment_reference || '',
      now,         // consent_timestamp
      data.token,  // source_link_token
      status,
      now,         // created_at
      now,         // updated_at
      (donor.notes || '').trim()
    ]);

    auditLog(ss, 'form_submit', 'insert',
      data.email + '|' + donor.pan_normalized + '|' + data.course_id,
      'new_submission', '', subId, subId);
  }

  // Update email_log: mark submitted
  const logSheet = ss.getSheetByName('email_log');
  if (logSheet && logSheet.getLastRow() > 1) {
    const logData = logSheet.getDataRange().getValues();
    for (let i = 1; i < logData.length; i++) {
      if (logData[i][0] === data.email.toLowerCase().trim() && logData[i][1] === data.course_id.trim()) {
        logSheet.getRange(i + 1, 7).setValue(now); // submitted_at
        break;
      }
    }
  }

  return { success: true };
}

// ---------------------------------------------------------------------------
// One-time setup
// ---------------------------------------------------------------------------

function initSheets() {
  const ss = getSpreadsheet();

  getOrCreateSheet(ss, 'donors_input', [
    'course_id', 'course_start_date', 'course_end_date',
    'donor_name', 'email', 'mobile',
    'donation_amount', 'donation_date', 'payment_reference'
  ]);
  getOrCreateSheet(ss, 'submissions', [
    'submission_id', 'course_id', 'donor_email', 'donor_mobile',
    'name', 'name_as_per_pan', 'pan_normalized',
    'donation_amount', 'donation_date', 'payment_reference',
    'consent_timestamp', 'source_link_token', 'status',
    'created_at', 'updated_at', 'notes'
  ]);
  getOrCreateSheet(ss, 'email_log', [
    'email', 'course_id', 'sent_at', 'email_status',
    'reminder_count', 'last_reminder_at', 'submitted_at'
  ]);
  getOrCreateSheet(ss, 'audit_log', [
    'timestamp', 'actor', 'action', 'record_key',
    'field_changed', 'old_value', 'new_value', 'source_submission_id'
  ]);
  getOrCreateSheet(ss, 'validated_for_merge', [
    'submission_id', 'course_id', 'donor_email', 'donor_mobile',
    'name', 'name_as_per_pan', 'pan_normalized',
    'donation_amount', 'donation_date', 'payment_reference',
    'consent_timestamp', 'status', 'exported_at'
  ]);
  getOrCreateSheet(ss, 'master', [
    'donor_id', 'email', 'mobile', 'name', 'name_as_per_pan', 'pan',
    'course_id', 'donation_amount', 'donation_date', 'payment_reference',
    'status', 'certificate_number', 'certificate_issued_at',
    'created_at', 'updated_at'
  ]);

  SpreadsheetApp.getUi().alert('All sheets initialized.');
}
