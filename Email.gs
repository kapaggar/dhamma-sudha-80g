// Email.gs

// --- Email send throttling -------------------------------------------------
// Google enforces a DAILY email quota from Apps Script (~100 recipients/day on
// consumer Gmail, ~1500/day on Workspace). It is a DAILY cap, not hourly - pacing
// per hour does NOT raise the ceiling. We cap per run, and refuse to spend the last
// EMAIL_QUOTA_BUFFER of the live remaining quota (read via getRemainingDailyQuota).
// Run hourly (80G Admin > 2. Email Donors > Enable Hourly Email Sending) to drain a
// large backlog safely; it resumes automatically after the quota resets each day.
// Override the per-run cap with a Script Property "EMAIL_MAX_PER_RUN".
const EMAIL_MAX_PER_RUN_DEFAULT = 10;  // emails per invocation
const EMAIL_QUOTA_BUFFER = 5;          // keep this many of the daily quota in reserve
const EMAIL_SEND_SLEEP_MS = 1000;      // gentle pause between sends

function getEmailMaxPerRun_() {
  const v = parseInt(PropertiesService.getScriptProperties().getProperty('EMAIL_MAX_PER_RUN'), 10);
  return (!isNaN(v) && v > 0) ? v : EMAIL_MAX_PER_RUN_DEFAULT;
}

function sendPendingEmails(silent) {
  const ss = getSpreadsheet();
  const donorsSheet = ss.getSheetByName('donors_input');
  if (!donorsSheet || donorsSheet.getLastRow() < 2) {
    if (!silent) { try { SpreadsheetApp.getUi().alert('No donor records.'); } catch (_) {} }
    return { sent: 0, skipped: 0, failed: 0, pending: 0, remainingQuota: null };
  }

  const webAppUrl = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  if (!webAppUrl) throw new Error('WEB_APP_URL script property not set.');
  const centerName = getCenterName();

  const logSheet = getOrCreateSheet(ss, 'email_log', [
    'email', 'receipt_nos_in_email', 'sent_at',
    'email_status', 'reminder_count', 'submitted_at', 'last_reminder_at'
  ]);

  // (a) emails already sent (skip), and (b) email -> existing log row number, so a
  // previously-failed row is UPDATED in place rather than appended. Appending caused
  // duplicate email_log rows, which in turn caused duplicate reminders.
  const sentEmails = new Set();
  const logRowByEmail = {};
  if (logSheet.getLastRow() > 1) {
    const logData = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, 4).getValues();
    for (let i = 0; i < logData.length; i++) {
      const e = (logData[i][0] || '').toString().toLowerCase().trim();
      if (!e) continue;
      logRowByEmail[e] = i + 2; // sheet row number
      const status = (logData[i][3] || '').toString().toLowerCase();
      if (status.indexOf('sent') === 0) sentEmails.add(e);
    }
  }

  const data = donorsSheet.getDataRange().getValues();
  const byEmail = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const email = (row[4] || '').toString().toLowerCase().trim();
    if (!email) continue;
    if (row[20] !== 'need_pan') continue;
    if (!byEmail[email]) byEmail[email] = { name: row[3] || '', receipts: [] };
    byEmail[email].receipts.push({
      receiptNo: row[0], amount: row[14], txnDate: row[1], course: row[10]
    });
  }

  // Eligible = need_pan emails not already sent. Sorted for deterministic ordering
  // across hourly runs so the backlog drains predictably.
  const eligible = Object.keys(byEmail).filter(e => !sentEmails.has(e)).sort();

  const maxPerRun = getEmailMaxPerRun_();
  let remaining;
  try { remaining = MailApp.getRemainingDailyQuota(); }
  catch (_) { remaining = maxPerRun; } // if quota lookup unavailable, fall back to cap

  let sent = 0, failed = 0;
  let stopReason = '';

  for (const email of eligible) {
    if (sent >= maxPerRun) { stopReason = 'per-run cap (' + maxPerRun + ') reached'; break; }
    if (remaining - EMAIL_QUOTA_BUFFER <= 0) { stopReason = 'daily email quota nearly exhausted'; break; }

    const info = byEmail[email];
    const token = generateToken(email);
    const link = webAppUrl + '?email=' + encodeURIComponent(email) + '&token=' + encodeURIComponent(token);
    const receiptList = info.receipts.map(r => r.receiptNo).join(',');
    const nowIso = new Date().toISOString();

    try {
      MailApp.sendEmail({
        to: email,
        subject: 'PAN Details Required for 80G Donation Certificate',
        htmlBody: buildInitialHtml_(info.name, info.receipts, link, centerName),
        body: buildInitialPlainText_(info.name, info.receipts, link, centerName),
        name: centerName
      });
      writeEmailLogRow_(logSheet, logRowByEmail, email, receiptList, nowIso, 'sent');
      auditLog(ss, 'sendPendingEmails', 'email_sent', email, 'initial', '', 'sent', '');
      sent++;
      remaining--;
      Utilities.sleep(EMAIL_SEND_SLEEP_MS);
    } catch (err) {
      Logger.log('Email failed ' + email + ': ' + err.message);
      writeEmailLogRow_(logSheet, logRowByEmail, email, receiptList, nowIso, 'failed: ' + err.message);
      failed++;
      // A quota error mid-run means every later send will also fail - stop now.
      if (/too many times|quota|limit/i.test(err.message)) { stopReason = 'daily email quota reached'; break; }
    }
  }

  const pending = eligible.length - sent; // not-yet-sent this run (includes any failed)

  if (!silent) {
    try {
      SpreadsheetApp.getUi().alert(
        'Sent:             ' + sent + '\n' +
        'Failed:           ' + failed + '\n' +
        'Still pending:    ' + pending + '\n' +
        'Quota left today: ' + remaining +
        (stopReason ? '\n\nStopped: ' + stopReason : '') +
        (pending > 0 ? '\n\nTip: 2. Email Donors > Enable Hourly Email Sending drains the backlog automatically.' : ''));
    } catch (_) {}
  }

  return {
    sent: sent, skipped: sentEmails.size, failed: failed,
    pending: pending, remainingQuota: remaining, stopReason: stopReason
  };
}

// Update an existing email_log row for this email if present, else append one.
// Keeps exactly one row per email so failed -> sent transitions cleanly and
// reminder bookkeeping stays single-row.
function writeEmailLogRow_(logSheet, logRowByEmail, email, receiptList, nowIso, status) {
  const existing = logRowByEmail[email];
  if (existing) {
    logSheet.getRange(existing, 2).setValue(receiptList);
    logSheet.getRange(existing, 3).setValue(nowIso);
    logSheet.getRange(existing, 4).setValue(status);
    // leave reminder_count (5), submitted_at (6), last_reminder_at (7) untouched
  } else {
    logSheet.appendRow([email, receiptList, nowIso, status, 0, '', '']);
    logRowByEmail[email] = logSheet.getLastRow();
  }
}

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

  const nameByEmail = {};
  for (let i = 1; i < donorData.length; i++) {
    const email = (donorData[i][4] || '').toString().toLowerCase().trim();
    if (email && donorData[i][3]) nameByEmail[email] = donorData[i][3];
  }

  const stillNeedPan = new Set();
  for (let i = 1; i < donorData.length; i++) {
    if (donorData[i][20] === 'need_pan') {
      const e = (donorData[i][4] || '').toString().toLowerCase().trim();
      if (e) stillNeedPan.add(e);
    }
  }

  const maxPerRun = getEmailMaxPerRun_();
  let remaining;
  try { remaining = MailApp.getRemainingDailyQuota(); } catch (_) { remaining = maxPerRun; }

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

    // Respect the same per-run cap and daily-quota buffer as initial sends.
    if (sent >= maxPerRun) break;
    if (remaining - EMAIL_QUOTA_BUFFER <= 0) break;

    const donorName = nameByEmail[email] || 'Donor';
    const token = generateToken(email);
    const link = webAppUrl + '?email=' + encodeURIComponent(email) + '&token=' + encodeURIComponent(token);
    const num = count + 1;

    try {
      MailApp.sendEmail({
        to: email,
        subject: 'Reminder ' + num + '/2: PAN Details for 80G Certificate',
        htmlBody: buildReminderHtml_(donorName, link, centerName, num),
        body: buildReminderPlainText_(donorName, link, centerName, num),
        name: centerName
      });
      logSheet.getRange(i + 1, 5).setValue(num);
      logSheet.getRange(i + 1, 7).setValue(now.toISOString());
      auditLog(ss, 'sendReminders', 'reminder_sent', email, 'reminder_count', count, num, '');
      sent++;
      remaining--;
      Utilities.sleep(EMAIL_SEND_SLEEP_MS);
    } catch (err) {
      Logger.log('Reminder failed ' + email + ': ' + err.message);
      if (/too many times|quota|limit/i.test(err.message)) break;
    }
  }

  Logger.log('sendReminders: sent ' + sent);
}

// ---------------------------------------------------------------------------
// Email body templates - HTML + plain text fallback
// ---------------------------------------------------------------------------

function buildInitialHtml_(name, receipts, link, centerName) {
  const receiptRows = receipts.map(function(r) {
    const date = r.txnDate ? Utilities.formatDate(new Date(r.txnDate), 'Asia/Kolkata', 'dd MMM yyyy') : '';
    return '<tr>' +
      '<td style="padding:6px 12px;border-bottom:1px solid #e0e0e0;font-family:monospace;font-size:13px"><strong>' + r.receiptNo + '</strong></td>' +
      '<td style="padding:6px 12px;border-bottom:1px solid #e0e0e0;font-size:13px;color:#555">' + date + '</td>' +
      '<td style="padding:6px 12px;border-bottom:1px solid #e0e0e0;font-size:13px;text-align:right;color:#333"><strong>Rs. ' + (r.amount || '') + '</strong></td>' +
      '</tr>';
  }).join('');

  return '' +
'<!DOCTYPE html>' +
'<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#333">' +
'<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f5;padding:30px 0">' +
'<tr><td align="center">' +
'<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden">' +
'<tr><td style="background:#3c6e47;padding:24px 28px;color:#ffffff">' +
'<div style="font-size:18px;font-weight:600">' + escapeHtml_(centerName) + '</div>' +
'<div style="font-size:12px;opacity:0.85;margin-top:4px">80G Donation Certificate</div>' +
'</td></tr>' +
'<tr><td style="padding:28px">' +
'<p style="margin:0 0 16px 0;font-size:15px">Dear <strong>' + escapeHtml_(name) + '</strong>,</p>' +
'<p style="margin:0 0 18px 0;font-size:14px;line-height:1.5">Thank you for your generous donation' + (receipts.length > 1 ? 's' : '') + ' to ' + escapeHtml_(centerName) + '. To issue your 80G certificate' + (receipts.length > 1 ? 's' : '') + ', we need your PAN details.</p>' +

'<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#eef4ee;border-radius:6px;margin-bottom:24px">' +
'<tr><td style="padding:14px 16px">' +
'<div style="font-size:11px;font-weight:600;color:#3c6e47;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">Pending Donations</div>' +
'<table cellpadding="0" cellspacing="0" border="0" width="100%">' + receiptRows + '</table>' +
'</td></tr></table>' +

'<table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 24px auto">' +
'<tr><td align="center" style="border-radius:6px;background:#3c6e47">' +
'<a href="' + link + '" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px">Submit Your PAN Details</a>' +
'</td></tr></table>' +

'<p style="margin:0 0 8px 0;font-size:13px;color:#666;text-align:center">Your PAN will apply to all the donations listed above.</p>' +

'<div style="border-top:1px solid #e0e0e0;margin:24px 0;padding-top:18px">' +
'<p style="margin:0 0 6px 0;font-size:12px;color:#999"><strong>Please do NOT reply to this email with your PAN.</strong></p>' +
'<p style="margin:0;font-size:12px;color:#999">Use only the secure link above, which is personalized for you.</p>' +
'</div>' +

'<p style="margin:24px 0 0 0;font-size:14px;color:#555">With Metta,<br><strong>' + escapeHtml_(centerName) + '</strong></p>' +
'</td></tr></table>' +
'</td></tr></table>' +
'</body></html>';
}

function buildInitialPlainText_(name, receipts, link, centerName) {
  const receiptList = receipts.map(function(r) {
    const date = r.txnDate ? Utilities.formatDate(new Date(r.txnDate), 'Asia/Kolkata', 'dd MMM yyyy') : '';
    return '  - ' + r.receiptNo + (date ? ' (' + date + ')' : '') + (r.amount ? ' - Rs. ' + r.amount : '');
  }).join('\n');

  return 'Dear ' + name + ',\n\n' +
    'Thank you for your generous donation' + (receipts.length > 1 ? 's' : '') +
    ' to ' + centerName + '.\n\n' +
    'To issue your 80G certificate' + (receipts.length > 1 ? 's' : '') + ' for:\n\n' +
    receiptList + '\n\n' +
    'Submit your PAN: ' + link + '\n\n' +
    'Please do NOT reply to this email with your PAN.\n\n' +
    'With Metta,\n' + centerName;
}

function buildReminderHtml_(name, link, centerName, num) {
  return '' +
'<!DOCTYPE html>' +
'<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#333">' +
'<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f5;padding:30px 0">' +
'<tr><td align="center">' +
'<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden">' +
'<tr><td style="background:#c98745;padding:24px 28px;color:#ffffff">' +
'<div style="font-size:18px;font-weight:600">' + escapeHtml_(centerName) + '</div>' +
'<div style="font-size:12px;opacity:0.9;margin-top:4px">Reminder ' + num + ' of 2 - PAN Details Required</div>' +
'</td></tr>' +
'<tr><td style="padding:28px">' +
'<p style="margin:0 0 16px 0;font-size:15px">Dear <strong>' + escapeHtml_(name) + '</strong>,</p>' +
'<p style="margin:0 0 24px 0;font-size:14px;line-height:1.5">This is a gentle reminder that we still need your PAN details to issue your 80G donation certificate.</p>' +
'<table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 24px auto">' +
'<tr><td align="center" style="border-radius:6px;background:#3c6e47">' +
'<a href="' + link + '" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px">Submit Your PAN Details</a>' +
'</td></tr></table>' +
'<p style="margin:0;font-size:12px;color:#999;text-align:center">If you have already submitted, please disregard this message.</p>' +
'<p style="margin:24px 0 0 0;font-size:14px;color:#555">With Metta,<br><strong>' + escapeHtml_(centerName) + '</strong></p>' +
'</td></tr></table>' +
'</td></tr></table>' +
'</body></html>';
}

function buildReminderPlainText_(name, link, centerName, num) {
  return 'Dear ' + name + ',\n\n' +
    'Gentle reminder (' + num + ' of 2) - we still need your PAN details to issue your 80G certificate from ' + centerName + '.\n\n' +
    'Submit your PAN: ' + link + '\n\n' +
    'If you have already submitted, please disregard.\n\n' +
    'With Metta,\n' + centerName;
}

function escapeHtml_(s) {
  if (!s) return '';
  return s.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Hourly email-sending trigger (drains a large backlog within the daily quota)
// ---------------------------------------------------------------------------

function autoSendEmailsHourly() {
  try {
    const r = sendPendingEmails(true);
    Logger.log('autoSendEmailsHourly: ' + JSON.stringify(r));
  } catch (err) {
    Logger.log('autoSendEmailsHourly failed: ' + err.message);
    try {
      const adminEmail = Session.getActiveUser().getEmail();
      if (adminEmail) {
        MailApp.sendEmail(adminEmail,
          '[80G System] Hourly email sending failed',
          'Error: ' + err.message + '\n\nCheck the Apps Script execution log.');
      }
    } catch (_) {}
  }
}

function installHourlyEmailTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'autoSendEmailsHourly') {
      ScriptApp.deleteTrigger(t); removed++;
    }
  });
  ScriptApp.newTrigger('autoSendEmailsHourly').timeBased().everyHours(1).create();
  SpreadsheetApp.getUi().alert(
    'Hourly email sending enabled.\n\n' +
    'Removed: ' + removed + ' existing trigger(s).\n' +
    'Up to ' + getEmailMaxPerRun_() + ' emails will be sent each hour, within the daily ' +
    'quota. To stop, use "Disable Hourly Email Sending".');
}

function disableHourlyEmailTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'autoSendEmailsHourly') {
      ScriptApp.deleteTrigger(t); removed++;
    }
  });
  SpreadsheetApp.getUi().alert('Removed ' + removed + ' hourly email trigger(s).');
}
