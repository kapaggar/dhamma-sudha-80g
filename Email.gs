// Email.gs

/**
 * Send initial personalized emails for a course.
 * Reads donors_input, skips already-sent, writes to email_log.
 */
function sendCourseEmails(courseId) {
  const ss         = getSpreadsheet();
  const donorSheet = ss.getSheetByName('donors_input');
  if (!donorSheet) throw new Error('donors_input sheet not found');

  const webAppUrl    = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  const centerName   = getCenterName();
  if (!webAppUrl) throw new Error('WEB_APP_URL script property not set.');

  const logSheet = getOrCreateSheet(ss, 'email_log', [
    'email', 'course_id', 'sent_at', 'email_status',
    'reminder_count', 'last_reminder_at', 'submitted_at'
  ]);

  const donors   = donorSheet.getDataRange().getValues();
  const logData  = logSheet.getLastRow() > 1 ? logSheet.getDataRange().getValues() : [[]];
  const sentKeys = new Set(logData.slice(1).map(r => r[0] + '|' + r[1]));

  let sent = 0, skipped = 0;

  for (let i = 1; i < donors.length; i++) {
    const [rowCourseId, , , donorName, email, mobile] = donors[i];
    if (rowCourseId !== courseId) continue;
    if (!email || !donorName) { skipped++; continue; }

    const emailLower = email.toLowerCase().trim();
    const key = emailLower + '|' + courseId;
    if (sentKeys.has(key)) { skipped++; continue; }

    const token = generateToken(courseId, emailLower);
    const link  = buildLink(webAppUrl, courseId, emailLower, token);

    try {
      GmailApp.sendEmail(emailLower, 'PAN Details Required for 80G Donation Certificate',
        buildInitialEmailBody(donorName, link, centerName), { name: centerName });

      logSheet.appendRow([emailLower, courseId, new Date().toISOString(), 'sent', 0, '', '']);
      sentKeys.add(key);
      auditLog(ss, 'sendCourseEmails', 'email_sent', key, 'initial_email', '', 'sent', '');
      sent++;
    } catch (err) {
      Logger.log('sendCourseEmails: failed ' + emailLower + ' - ' + err.message);
      logSheet.appendRow([emailLower, courseId, new Date().toISOString(), 'failed: ' + err.message, 0, '', '']);
      skipped++;
    }
  }

  SpreadsheetApp.getUi().alert('Sent: ' + sent + '  Skipped/failed: ' + skipped);
}

/**
 * Send reminders to unsubmitted donors. Intended for daily time-based trigger.
 * - 1st reminder: 3 days after initial send
 * - 2nd reminder: 7 days after 1st reminder
 * - Stops after 2 reminders or on submission.
 */
function sendReminders() {
  const ss       = getSpreadsheet();
  const logSheet = ss.getSheetByName('email_log');
  if (!logSheet || logSheet.getLastRow() < 2) return;

  const donorSheet = ss.getSheetByName('donors_input');
  const webAppUrl  = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  const centerName = getCenterName();
  if (!webAppUrl) return;

  const logData    = logSheet.getDataRange().getValues();
  const donorData  = donorSheet && donorSheet.getLastRow() > 1 ? donorSheet.getDataRange().getValues() : [];
  const now        = new Date();

  for (let i = 1; i < logData.length; i++) {
    const [email, courseId, sentAt, , reminderCount, lastReminderAt, submittedAt] = logData[i];

    if (submittedAt) continue;
    const count = parseInt(reminderCount) || 0;
    if (count >= 2) continue;

    const lastContact = lastReminderAt ? new Date(lastReminderAt) : new Date(sentAt);
    const daysSince   = (now - lastContact) / 86400000;
    const threshold   = count === 0 ? 3 : 7;
    if (daysSince < threshold) continue;

    let donorName = 'Donor';
    for (let j = 1; j < donorData.length; j++) {
      if (donorData[j][0] === courseId && donorData[j][4].toLowerCase().trim() === email) {
        donorName = donorData[j][3]; break;
      }
    }

    const token = generateToken(courseId, email);
    const link  = buildLink(webAppUrl, courseId, email, token);
    const subj  = 'Reminder ' + (count + 1) + '/2: PAN Details for 80G Certificate';

    try {
      GmailApp.sendEmail(email, subj,
        buildReminderBody(donorName, link, centerName, count + 1), { name: centerName });
      logSheet.getRange(i + 1, 5).setValue(count + 1);
      logSheet.getRange(i + 1, 6).setValue(now.toISOString());
      auditLog(ss, 'sendReminders', 'reminder_sent', email + '|' + courseId,
        'reminder_count', count, count + 1, '');
    } catch (err) {
      Logger.log('Reminder failed ' + email + ': ' + err.message);
    }
  }
}

// --- helpers ---

function buildLink(webAppUrl, courseId, email, token) {
  return webAppUrl +
    '?course_id=' + encodeURIComponent(courseId) +
    '&email='     + encodeURIComponent(email) +
    '&token='     + encodeURIComponent(token);
}

function buildInitialEmailBody(name, link, centerName) {
  return 'Dear ' + name + ',\n\n' +
    'Thank you for your generous donation to ' + centerName + '.\n\n' +
    'To issue your 80G donation certificate, please submit your PAN details using the secure form below:\n\n' +
    '  ' + link + '\n\n' +
    'Important:\n' +
    '- Please do NOT reply to this email with your PAN.\n' +
    '- Use only the link above, which is personalized for you.\n\n' +
    'If you have any questions, please contact the center directly.\n\n' +
    'With Metta,\n' + centerName;
}

function buildReminderBody(name, link, centerName, num) {
  return 'Dear ' + name + ',\n\n' +
    'This is a gentle reminder (' + num + ' of 2) - we still require your PAN details to issue your 80G donation certificate from ' + centerName + '.\n\n' +
    '  ' + link + '\n\n' +
    'If you have already submitted, please disregard this message.\n\n' +
    'With Metta,\n' + centerName;
}
