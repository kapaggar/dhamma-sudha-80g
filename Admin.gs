// Admin.gs

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('80G Admin')
    .addItem('Initialize All Sheets', 'initSheets')
    .addItem('Migrate Schema (add new columns)', 'migrateSchema')
    .addSeparator()
    .addSubMenu(ui.createMenu('1. Import from Dana')
      .addItem('Auto Import (last import to today)', 'importFromDanaPortal')
      .addItem('Import from Uploaded XLS File', 'importFromUploadedFile'))
    .addSubMenu(ui.createMenu('2. Email Donors')
      .addItem('Send PAN Request Emails', 'sendPendingEmails')
      .addItem('Send Reminders (3d/7d)', 'sendReminders'))
    .addSubMenu(ui.createMenu('3. Push PAN to Dana')
      .addItem('Preview (dry run)', 'previewWriteBackToDana')
      .addItem('Push Now', 'pushPANsToDana')
      .addSeparator()
      .addItem('Enable Hourly Auto-Push', 'installHourlyTrigger')
      .addItem('Disable Hourly Auto-Push', 'disableHourlyTrigger'))
    .addSeparator()
    .addItem('Refresh Admin Review', 'refreshAdminReview')
    .addItem('Export Ready for 80G (full PAN)', 'exportReadyFor80G')
    .addSeparator()
    .addItem('Run Tests', 'runAllTests')
    .addToUi();
}

/**
 * Admin review: categorize all donors_input rows.
 */
function refreshAdminReview() {
  const ss = getSpreadsheet();
  const donorsSheet = ss.getSheetByName('donors_input');
  if (!donorsSheet || donorsSheet.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert('No donor records.'); return;
  }

  const adminSheet = getOrCreateSheet(ss, 'admin_review', [
    'receipt_no', 'txn_date', 'full_name', 'email', 'amount',
    'pan_masked', 'pan_source', 'pan_status', 'days_since_import', 'category'
  ]);
  if (adminSheet.getLastRow() > 1) {
    adminSheet.deleteRows(2, adminSheet.getLastRow() - 1);
  }

  const data = donorsSheet.getDataRange().getValues();
  const now = new Date();
  const rows = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const receiptNo = row[0];
    const txnDate = row[1];
    const fullName = row[3];
    const email = row[4];
    const amount = row[14];
    const idType = (row[16] || '').toString();
    const idValue = row[17];
    const panCollected = row[18];
    const panStatus = row[20];
    const importedAt = row[22];

    let pan = '';
    let panSource = '';
    if (panCollected) {
      pan = panCollected;
      panSource = panStatus === 'have_pan' && idType.toUpperCase() !== 'PAN' ? 'form' : 'dana';
    } else if (idType.toUpperCase() === 'PAN' && idValue) {
      pan = idValue;
      panSource = 'dana';
    }

    let daysSince = '';
    if (importedAt) {
      try {
        daysSince = Math.floor((now - new Date(importedAt)) / 86400000);
      } catch (_) {}
    }

    let category;
    if (panStatus === 'have_pan') category = 'ready_for_80g';
    else if (panStatus === 'no_email') category = 'no_email_cannot_contact';
    else if (panStatus === 'need_pan') {
      category = daysSince > 10 ? 'overdue_need_pan' : 'pending_need_pan';
    } else category = panStatus || 'unknown';

    rows.push([receiptNo, txnDate, fullName, email, amount,
      maskPAN(pan), panSource, panStatus, daysSince, category]);
  }

  if (rows.length > 0) {
    adminSheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
    const colorMap = {
      'ready_for_80g':           '#d9ead3',
      'pending_need_pan':        '#fff2cc',
      'overdue_need_pan':        '#fce5cd',
      'no_email_cannot_contact': '#f4cccc'
    };
    for (let i = 0; i < rows.length; i++) {
      const color = colorMap[rows[i][9]] || '#ffffff';
      adminSheet.getRange(i + 2, 1, 1, rows[i].length).setBackground(color);
    }
  }

  // Summary
  const counts = {};
  rows.forEach(r => { counts[r[9]] = (counts[r[9]] || 0) + 1; });
  const summary = Object.keys(counts).map(k => '  ' + k + ': ' + counts[k]).join('\n');
  SpreadsheetApp.getUi().alert('Admin review refreshed.\n\n' + summary);
}

/**
 * Export all rows ready for 80G certificate generation (have_pan).
 * Full PAN shown (this is the merge/export step).
 */
function exportReadyFor80G() {
  const ss = getSpreadsheet();
  const donorsSheet = ss.getSheetByName('donors_input');
  if (!donorsSheet || donorsSheet.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert('No records.'); return;
  }

  const expSheet = getOrCreateSheet(ss, 'ready_for_80g', [
    'receipt_no', 'txn_date', 'full_name', 'email', 'mobile',
    'address', 'city', 'state',
    'course', 'category', 'payment_mode', 'amount', 'merchant_ref',
    'pan', 'pan_name', 'pan_source', 'exported_at'
  ]);
  if (expSheet.getLastRow() > 1) {
    expSheet.deleteRows(2, expSheet.getLastRow() - 1);
  }

  const data = donorsSheet.getDataRange().getValues();
  const now = new Date().toISOString();
  const rows = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[20] !== 'have_pan') continue;

    const idType = (row[16] || '').toString();
    const idValue = row[17];
    const panCollected = row[18];
    const panName = row[19];

    let pan, panSource;
    if (panCollected) {
      pan = panCollected;
      panSource = (idType.toUpperCase() === 'PAN') ? 'dana' : 'form';
    } else if (idType.toUpperCase() === 'PAN') {
      pan = idValue;
      panSource = 'dana';
    } else {
      continue; // shouldn't happen but skip
    }

    rows.push([
      row[0], row[1], row[3], row[4], row[5],
      row[6], row[7], row[8],
      row[10], row[11], row[13], row[14], row[15],
      pan, panName, panSource, now
    ]);
  }

  if (rows.length > 0) {
    expSheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }

  SpreadsheetApp.getUi().alert('Exported ' + rows.length + ' rows ready for 80G to "ready_for_80g" sheet.');
}
