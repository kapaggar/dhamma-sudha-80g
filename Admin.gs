// Admin.gs

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('80G Admin')
    .addItem('Initialize All Sheets', 'initSheets')
    .addSeparator()
    .addItem('Send Emails for Course...', 'promptSendEmails')
    .addItem('Send Reminders (all pending)', 'sendReminders')
    .addItem('Generate Links for Course...', 'promptGenerateLinks')
    .addSeparator()
    .addItem('Refresh Admin Review', 'refreshAdminReview')
    .addItem('Export Validated for Merge', 'exportValidatedForMerge')
    .addItem('Merge to Master', 'mergeToMaster')
    .addSeparator()
    .addItem('Run Tests', 'runAllTests')
    .addToUi();
}

function promptSendEmails() {
  const ui = SpreadsheetApp.getUi();
  const r  = ui.prompt('Send Emails', 'Enter Course ID:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() === ui.Button.OK && r.getResponseText().trim()) {
    sendCourseEmails(r.getResponseText().trim());
  }
}

function promptGenerateLinks() {
  const ui = SpreadsheetApp.getUi();
  const r  = ui.prompt('Generate Links', 'Enter Course ID:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() === ui.Button.OK && r.getResponseText().trim()) {
    generateLinks(r.getResponseText().trim());
  }
}

function generateLinks(courseId) {
  const ss        = getSpreadsheet();
  const donorSheet = ss.getSheetByName('donors_input');
  const webAppUrl  = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  if (!webAppUrl) { SpreadsheetApp.getUi().alert('WEB_APP_URL not set.'); return; }

  const sheetName = 'links_' + courseId.replace(/[^a-zA-Z0-9_]/g, '_');
  const linksSheet = getOrCreateSheet(ss, sheetName,
    ['email', 'donor_name', 'course_id', 'personalized_link', 'generated_at']);
  if (linksSheet.getLastRow() > 1) linksSheet.deleteRows(2, linksSheet.getLastRow() - 1);

  const donors = donorSheet.getDataRange().getValues();
  const now    = new Date().toISOString();
  let count    = 0;

  for (let i = 1; i < donors.length; i++) {
    const row = donors[i];
    if (row[0] !== courseId) continue;
    const [, , , donorName, email] = row;
    if (!email) continue;
    const emailLower = email.toLowerCase().trim();
    const token = generateToken(courseId, emailLower);
    const link  = buildLink(webAppUrl, courseId, emailLower, token);
    linksSheet.appendRow([emailLower, donorName, courseId, link, now]);
    count++;
  }
  SpreadsheetApp.getUi().alert('Generated ' + count + ' links in sheet: ' + sheetName);
}

function refreshAdminReview() {
  const ss   = getSpreadsheet();
  const subSheet = ss.getSheetByName('submissions');
  if (!subSheet || subSheet.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert('No submissions yet.'); return;
  }

  const adminSheet = getOrCreateSheet(ss, 'admin_review', [
    'submission_id', 'course_id', 'donor_email', 'name',
    'name_as_per_pan', 'pan_masked', 'donation_amount',
    'status', 'category', 'created_at', 'notes'
  ]);
  if (adminSheet.getLastRow() > 1) adminSheet.deleteRows(2, adminSheet.getLastRow() - 1);

  const data = subSheet.getDataRange().getValues();

  const panEmails  = {};
  const emailPans  = {};
  for (let i = 1; i < data.length; i++) {
    const [, courseId, email, , , , pan] = data[i];
    if (!panEmails[pan]) panEmails[pan] = [];
    panEmails[pan].push(email);
    const k = email + '|' + courseId;
    if (!emailPans[k]) emailPans[k] = [];
    emailPans[k].push(pan);
  }

  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const [subId, courseId, email, , name, nameAsPan, pan, donAmt, , , , , status, createdAt, , notes] = data[i];

    let category;
    if (status === 'merged')        category = 'merged';
    else if (status === 'duplicate') category = 'duplicate_pan';
    else if (status === 'invalid')   category = 'invalid_pan';
    else if (!pan || !nameAsPan)     category = 'missing_required';
    else if (panEmails[pan] && [...new Set(panEmails[pan])].length > 1) category = 'same_pan_multi_email';
    else if (emailPans[email + '|' + courseId] && emailPans[email + '|' + courseId].length > 1) category = 'multi_pan_same_email';
    else category = 'valid_pending';

    rows.push([subId, courseId, email, name, nameAsPan, maskPAN(pan), donAmt, status, category, createdAt, notes]);
  }

  if (rows.length > 0) {
    adminSheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
    const colorMap = {
      valid_pending:        '#d9ead3',
      duplicate_pan:        '#fff2cc',
      same_pan_multi_email: '#fce5cd',
      multi_pan_same_email: '#fce5cd',
      missing_required:     '#f4cccc',
      invalid_pan:          '#f4cccc',
      merged:               '#c9daf8'
    };
    for (let i = 0; i < rows.length; i++) {
      const color = colorMap[rows[i][8]] || '#ffffff';
      adminSheet.getRange(i + 2, 1, 1, rows[i].length).setBackground(color);
    }
  }
  SpreadsheetApp.getUi().alert('Admin review refreshed: ' + rows.length + ' rows.');
}

function exportValidatedForMerge() {
  const ss       = getSpreadsheet();
  const subSheet = ss.getSheetByName('submissions');
  if (!subSheet || subSheet.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert('No submissions.'); return;
  }

  const expSheet = getOrCreateSheet(ss, 'validated_for_merge', [
    'submission_id', 'course_id', 'donor_email', 'donor_mobile',
    'name', 'name_as_per_pan', 'pan_normalized',
    'donation_amount', 'donation_date', 'payment_reference',
    'consent_timestamp', 'status', 'exported_at'
  ]);
  if (expSheet.getLastRow() > 1) expSheet.deleteRows(2, expSheet.getLastRow() - 1);

  const data = subSheet.getDataRange().getValues();
  const now  = new Date().toISOString();
  const rows = [];

  for (let i = 1; i < data.length; i++) {
    const row    = data[i];
    const status = row[12];
    if (status !== 'pending_review' && status !== 'validated') continue;
    rows.push([row[0], row[1], row[2], row[3], row[4], row[5], row[6],
               row[7], row[8], row[9], row[10], status, now]);
  }

  if (rows.length > 0) expSheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  SpreadsheetApp.getUi().alert('Exported ' + rows.length + ' rows to validated_for_merge.');
}

function mergeToMaster() {
  const ss      = getSpreadsheet();
  const expSheet = ss.getSheetByName('validated_for_merge');
  if (!expSheet || expSheet.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert('Run "Export Validated for Merge" first.'); return;
  }

  const masterSheet = getOrCreateSheet(ss, 'master', [
    'donor_id', 'email', 'mobile', 'name', 'name_as_per_pan', 'pan',
    'course_id', 'donation_amount', 'donation_date', 'payment_reference',
    'status', 'certificate_number', 'certificate_issued_at', 'created_at', 'updated_at'
  ]);
  const subSheet = ss.getSheetByName('submissions');

  const expData    = expSheet.getDataRange().getValues();
  const masterData = masterSheet.getDataRange().getValues();
  const now        = new Date().toISOString();
  let inserted = 0, updated = 0, conflicts = 0;

  for (let i = 1; i < expData.length; i++) {
    const src = expData[i];
    const [subId, courseId, email, mobile, name, nameAsPan, pan, donAmt, donDate, payRef] = src;
    const key = email + '|' + courseId + '|' + pan;

    let foundRow = -1;
    for (let j = 1; j < masterData.length; j++) {
      if (masterData[j][1] === email && masterData[j][6] === courseId && masterData[j][5] === pan) {
        foundRow = j; break;
      }
    }

    if (foundRow === -1) {
      const donorId = Utilities.getUuid();
      masterSheet.appendRow([
        donorId, email, mobile, name, nameAsPan, pan,
        courseId, donAmt, donDate, payRef,
        'active', '', '', now, now
      ]);
      masterData.push([donorId, email, mobile, name, nameAsPan, pan,
        courseId, donAmt, donDate, payRef, 'active', '', '', now, now]);
      auditLog(ss, 'mergeToMaster', 'insert', key, 'new_record', '', donorId, subId);
      markSubmissionStatus(subSheet, subId, 'merged');
      inserted++;
    } else {
      const mRow = masterData[foundRow];
      const fields = [
        { col: 2, src: mobile,    label: 'mobile' },
        { col: 3, src: name,      label: 'name' },
        { col: 4, src: nameAsPan, label: 'name_as_per_pan' },
        { col: 7, src: donAmt,    label: 'donation_amount' },
        { col: 8, src: donDate,   label: 'donation_date' },
        { col: 9, src: payRef,    label: 'payment_reference' }
      ];
      let hasConflict = false;
      for (const f of fields) {
        if (f.src && mRow[f.col] && mRow[f.col].toString() !== f.src.toString()) {
          auditLog(ss, 'mergeToMaster', 'conflict', key, f.label, mRow[f.col], f.src, subId);
          hasConflict = true;
        }
      }
      if (hasConflict) {
        conflicts++;
      } else {
        for (const f of fields) {
          if (f.src && !mRow[f.col]) {
            masterSheet.getRange(foundRow + 1, f.col + 1).setValue(f.src);
            auditLog(ss, 'mergeToMaster', 'field_updated', key, f.label, '', f.src, subId);
          }
        }
        masterSheet.getRange(foundRow + 1, 15).setValue(now);
        updated++;
      }
    }
  }

  SpreadsheetApp.getUi().alert(
    'Merge complete.\n' +
    'Inserted: ' + inserted + '\n' +
    'Updated:  ' + updated  + '\n' +
    'Conflicts (see audit_log): ' + conflicts
  );
}

function markSubmissionStatus(subSheet, submissionId, status) {
  if (!subSheet || subSheet.getLastRow() < 2) return;
  const data = subSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === submissionId) {
      subSheet.getRange(i + 1, 13).setValue(status);
      subSheet.getRange(i + 1, 15).setValue(new Date().toISOString());
      return;
    }
  }
}
