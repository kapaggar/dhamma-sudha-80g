// Email.gs

/**
 * Send PAN request emails to all donors with pan_status='need_pan' who haven't been emailed yet.
 * Groups multiple receipts per donor into a single email.
 */
function sendPendingEmails() {
  const ss = getSpreadsheet();
  const donorsSheet = ss.getSheetByName('donors_input');
  if (!donorsSheet || donorsSheet.getLastRow() < 2) {
    try { SpreadsheetApp.getUi().alert('No donor records.'); } catch (_) {}
    return;
  }

  const webAppUrl = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  if (!webAppUrl) throw new Error('WEB_APP_URL script property not set.');
  const centerName = getCenterName();

  const logSheet = getOrCreateSheet(ss, 'email_log', [
    'email', 'receipt_nos_in_email', 'sent_at',
    'email_status', 'reminder_count', 'submitted_at', 'last_reminder_at'
  ]);

  // Build map: emails already sent
  const sentEmails = new Set();
  if (logSheet.getLastRow() > 1) {
    const logData = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, 1).getValues();
    logData.forEach(r => { if (r[0]) sentEmails.add(r[0].toString().toLowerCase().trim()); });
  }

  // Group need_pan rows by email
  const data = donorsSheet.getDataRange().getValues();
  const byEmail = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const email = (row[4] || '').toString().toLowerCase().trim();
    if (!email) continue;
    if (row[20] !== 'need_pan') continue;

    if (!byEmail[email]) {
      byEmail[email] = { name: row[3] || '', receipts: [] };
    }
    byEmail[email].receipts.push({
      receiptNo: row[0],
      amount: row[14],
      txnDate: row[1],
      course: row[10]
    });
  }

  let sent = 0, skipped = 0, failed = 0;

  for (const email in byEmail) {
    if (sentEmails.has(email)) { skipped++; continue; }

    const info = byEmail[email];
    const token = generateToken(email);
    const link = webAppUrl + '?email=' + encodeURIComponent(email) + '&token=' + encodeURIComponent(token);
    const body = buildInitialEmailBody_(info.name, info.receipts, link, centerName);
    const receiptList = info.receipts.map(r => r.receiptNo).join(',');

    try {
      GmailApp.sendEmail(email,
        'PAN Details Required for 80G Donation Certificate',
        body, { name: centerName });

      logSheet.appendRow([email, receiptList, new Date().toISOString(), 'sent', 0, '', '']);
      auditLog(ss, 'sendPendingEmails', 'email_sent', email, 'initial', '', 'sent', '');
      sent++;
    } catch (err) {
      Logger.log('Email failed ' + email + ': ' + err.message);
      logSheet.appendRow([email, receiptList, new Date().toISOString(), 'failed: ' + err.message, 0, '', '']);
      failed++;
    }
  }

  try {
    SpreadsheetApp.getUi().alert(
      'Sent:    ' + sent + '\n' +
      'Skipped: ' + skipped + ' (already emailed)\n' +
      'Failed:  ' + failed);
  } catch (_) {}
}

/**
 * Send reminders. 1st reminder: 3 days. 2nd: 7 days. Stops after 2 or on submission.
 */
function sendReminders() {
  const ss = getSpreadsheet();
  const logSheet = ss.getSheetByName('email_log');
  if (!logSheet || logSheet.getLastRow() < 2) return;

  const donorsSheet = ss.getSheetByName('donors_input');
  const webAppUrl = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  const centerName = getCenterName();
  if (!webAppUrl) return;

  const logData = logSheet.getDataRange().getValues();
  const donorData = donorsSheet && donorsSheet.getLastRow() > 1 ? donorsSheet.getDataRange().getValues() : [];
  const now = new Date();

  // Build map: email -> name (from latest donor row)
  const nameByEmail = {};
  for (let i = 1; i < donorData.length; i++) {
    const email = (donorData[i][4] || '').toString().toLowerCase().trim();
    if (email && donorData[i][3]) nameByEmail[email] = donorData[i][3];
  }

  // Build set: emails that still have need_pan rows
  const stillNeedPan = new Set();
  for (let i = 1; i < donorData.length; i++) {
    if (donorData[i][20] === 'need_pan') {
      const e = (donorData[i][4] || '').toString().toLowerCase().trim();
      if (e) stillNeedPan.add(e);
    }
  }

  let sent = 0;
  for (let i = 1; i < logData.length; i++) {
    const [email, , sentAt, , reminderCount, submittedAt, lastReminderAt] = logData[i];

    if (submittedAt) continue;
    if (!stillNeedPan.has((email || '').toString().toLowerCase().trim())) continue;

    const count = parseInt(reminderCount) || 0;
    if (count >= 2) continue;

    const lastContact = lastReminderAt ? new Date(lastReminderAt) : new Date(sentAt);
    const daysSince = (now - lastContact) / 86400000;
    const threshold = count === 0 ? 3 : 7;
    if (daysSince < threshold) continue;

    const donorName = nameByEmail[email] || 'Donor';
    const token = generateToken(email);
    const link = webAppUrl + '?email=' + encodeURIComponent(email) + '&token=' + encodeURIComponent(token);

    try {
      GmailApp.sendEmail(email,
        'Reminder ' + (count + 1) + '/2: PAN Details for 80G Certificate',
        buildReminderBody_(donorName, link, centerName, count + 1),
        { name: centerName });

      logSheet.getRange(i + 1, 5).setValue(count + 1);
      logSheet.getRange(i + 1, 7).setValue(now.toISOString());
      auditLog(ss, 'sendReminders', 'reminder_sent', email,
        'reminder_count', count, count + 1, '');
      sent++;
    } catch (err) {
      Logger.log('Reminder failed ' + email + ': ' + err.message);
    }
  }

  Logger.log('sendReminders: sent ' + sent);
}

// ---------------------------------------------------------------------------
// Email body templates
// ---------------------------------------------------------------------------

function buildInitialEmailBody_(name, receipts, link, centerName) {
  let receiptList = receipts.map(function(r) {
    const date = r.txnDate ? Utilities.formatDate(new Date(r.txnDate), 'Asia/Kolkata', 'dd MMM yyyy') : '';
    return '  - Receipt ' + r.receiptNo + (date ? ' (' + date + ')' : '') +
      (r.amount ? ' - Rs. ' + r.amount : '');
  }).join('\n');

  return 'Dear ' + name + ',\n\n' +
    'Thank you for your generous donation' + (receipts.length > 1 ? 's' : '') +
    ' to ' + centerName + '.\n\n' +
    'To issue your 80G donation certificate' + (receipts.length > 1 ? 's' : '') +
    ' for the following:\n\n' +
    receiptList + '\n\n' +
    'Please submit your PAN details using the secure form below:\n\n' +
    '  ' + link + '\n\n' +
    'Important:\n' +
    '- Please do NOT reply to this email with your PAN.\n' +
    '- Use only the link above, which is personalized for you.\n' +
    '- Your PAN will apply to all the donations listed above.\n\n' +
    'With Metta,\n' + centerName;
}

function buildReminderBody_(name, link, centerName, num) {
  return 'Dear ' + name + ',\n\n' +
    'This is a gentle reminder (' + num + ' of 2) - we still require your PAN details to issue your 80G donation certificate from ' + centerName + '.\n\n' +
    '  ' + link + '\n\n' +
    'If you have already submitted, please disregard this message.\n\n' +
    'With Metta,\n' + centerName;
}
