// DonationDay.gs
//
// Donation Day mode: while enabled, a single 10-minute trigger runs
// import -> pending PAN-request emails -> WhatsApp email-nudges, then
// self-expires DONATION_DAY_HOURS after enable. All building blocks are
// idempotent (receipt_no dedup in processRows_, email_log / wa_nudge_log
// dedup), so re-running within the same day is safe.
//
// Enable removes the hourly email/nudge triggers for the window: neither
// sendPendingEmails nor runWaSend_ takes a lock, so an hourly run overlapping
// a tick could double-send (both read the log sheet before either writes).
// They are NOT auto-reinstalled on disable/expiry - admin decision.

const DONATION_DAY_UNTIL_PROP = 'DONATION_DAY_UNTIL';           // ISO-8601 expiry
const DONATION_DAY_ERRMAIL_PROP = 'DONATION_DAY_ERR_MAILED_AT'; // error-email throttle
const DONATION_DAY_HOURS = 3;
const DONATION_DAY_TICK_MINUTES = 10;   // must be a valid everyMinutes value: 1/5/10/15/30
const DONATION_DAY_ERRMAIL_GAP_MS = 30 * 60 * 1000;

// True if the mode is expired: missing, unparseable, or past expiry.
// Pure (now injected) so Tests.gs can exercise it.
function donationDayExpired_(untilIso, nowMs) {
  if (!untilIso) return true;
  const t = Date.parse(untilIso);
  if (isNaN(t)) return true;
  return nowMs > t;
}

// Delete every trigger whose handler is `name`; returns removed count.
function deleteTriggersByHandler_(name) {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === name) {
      ScriptApp.deleteTrigger(t); removed++;
    }
  });
  return removed;
}

function enableDonationDayMode() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.alert('Enable Donation Day mode?',
    'For the next ' + DONATION_DAY_HOURS + ' hours, every ' + DONATION_DAY_TICK_MINUTES +
    ' minutes the system will:\n' +
    '1. Import new donations from the dana portal\n' +
    '2. Send pending PAN-request emails\n' +
    '3. Send WhatsApp email-nudges\n\n' +
    'The hourly email and nudge triggers will be REMOVED for this window ' +
    '(re-enable them afterwards if a backlog remains).\n\n' +
    'Mode turns itself off after ' + DONATION_DAY_HOURS + ' hours.',
    ui.ButtonSet.OK_CANCEL);
  if (resp !== ui.Button.OK) return;

  const untilIso = new Date(Date.now() + DONATION_DAY_HOURS * 3600 * 1000).toISOString();
  PropertiesService.getScriptProperties().setProperty(DONATION_DAY_UNTIL_PROP, untilIso);

  deleteTriggersByHandler_('donationDayTick');
  ScriptApp.newTrigger('donationDayTick').timeBased()
    .everyMinutes(DONATION_DAY_TICK_MINUTES).create();

  const removedEmail = deleteTriggersByHandler_('autoSendEmailsHourly');
  const removedNudge = deleteTriggersByHandler_('autoSendWhatsAppNudgeHourly');

  auditLog(getSpreadsheet(), 'admin', 'donation_day_enabled', '', 'expires_at', '', untilIso, '');

  ui.alert('Donation Day mode enabled.\n\n' +
    'Runs every ' + DONATION_DAY_TICK_MINUTES + ' minutes until ' +
    Utilities.formatDate(new Date(untilIso), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm') + ' IST.\n' +
    'Removed hourly triggers: ' + removedEmail + ' email, ' + removedNudge + ' nudge.\n\n' +
    'To stop early, use "Disable Now".');
}

function disableDonationDayMode() {
  const removed = deleteTriggersByHandler_('donationDayTick');
  const props = PropertiesService.getScriptProperties();
  const untilIso = props.getProperty(DONATION_DAY_UNTIL_PROP) || '';
  props.deleteProperty(DONATION_DAY_UNTIL_PROP);
  props.deleteProperty(DONATION_DAY_ERRMAIL_PROP);

  auditLog(getSpreadsheet(), 'admin', 'donation_day_disabled', '', 'expires_at', untilIso, '', '');

  SpreadsheetApp.getUi().alert('Donation Day mode disabled.\n\n' +
    'Removed ' + removed + ' trigger(s).\n\n' +
    'The hourly email/nudge triggers were removed at enable and are NOT restored - ' +
    're-enable them from menus 2 and 4 if a backlog remains.');
}

function donationDayStatus() {
  const untilIso = PropertiesService.getScriptProperties().getProperty(DONATION_DAY_UNTIL_PROP);
  const triggers = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'donationDayTick').length;

  let msg;
  if (untilIso && triggers > 0) {
    msg = 'ON - expires ' +
      Utilities.formatDate(new Date(untilIso), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm') +
      ' IST (' + triggers + ' trigger installed).';
  } else if (!untilIso && triggers === 0) {
    msg = 'OFF.';
  } else {
    msg = 'INCONSISTENT - ' + (untilIso ? 'expiry set but no trigger' : 'trigger without expiry') +
      '. Run "Disable Now" then "Enable" to fix.';
  }
  SpreadsheetApp.getUi().alert('Donation Day mode: ' + msg);
}

// Trigger handler. Import runs lock-free (idempotent via receipt_no dedup);
// sends run under tryLock(0) so a tick never queues behind write-back and never
// starves submitForm's 20s waitLock - donor form submissions are the peak path
// on donation day.
function donationDayTick() {
  const props = PropertiesService.getScriptProperties();
  const untilIso = props.getProperty(DONATION_DAY_UNTIL_PROP);

  if (donationDayExpired_(untilIso, Date.now())) {
    deleteTriggersByHandler_('donationDayTick');
    props.deleteProperty(DONATION_DAY_UNTIL_PROP);
    props.deleteProperty(DONATION_DAY_ERRMAIL_PROP);
    try {
      auditLog(getSpreadsheet(), 'system', 'donation_day_auto_off', '', 'expired_at', untilIso || '', '', '');
    } catch (e) { Logger.log('donationDayTick auto-off audit failed: ' + e.message); }
    donationDayNotifyAdmin_('[80G System] Donation Day mode ended',
      'Donation Day mode expired and its trigger was removed.\n\n' +
      'The hourly email/nudge triggers were removed at enable - re-enable them ' +
      'from the 80G Admin menu if a backlog remains.');
    return;
  }

  const errors = [];
  const summary = { import: null, emails: null, nudges: null };

  try {
    const range = getDefaultRange_();
    summary.import = runDanaImport_(range.start, range.end);
  } catch (err) {
    errors.push('import: ' + err.message);
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log('donationDayTick: lock busy, sends skipped this tick');
    summary.sendsSkipped = 'lock busy';
  } else {
    try {
      try { summary.emails = sendPendingEmails(true); }
      catch (err) { errors.push('emails: ' + err.message); }
      try { summary.nudges = sendPendingWhatsAppNudge(true); }
      catch (err) { errors.push('nudges: ' + err.message); }
    } finally {
      lock.releaseLock();
    }
  }

  Logger.log('donationDayTick: ' + JSON.stringify(summary));

  if (errors.length) {
    Logger.log('donationDayTick errors: ' + errors.join(' | '));
    // Throttle: a persistent failure (e.g. Cloudflare block) must not email
    // the admin on every tick.
    const lastMailed = parseInt(props.getProperty(DONATION_DAY_ERRMAIL_PROP), 10);
    if (isNaN(lastMailed) || Date.now() - lastMailed > DONATION_DAY_ERRMAIL_GAP_MS) {
      props.setProperty(DONATION_DAY_ERRMAIL_PROP, String(Date.now()));
      donationDayNotifyAdmin_('[80G System] Donation Day tick failed',
        'Error(s):\n' + errors.join('\n') +
        '\n\nCheck the Apps Script execution log. Further error emails are ' +
        'suppressed for 30 minutes; ticks keep running until expiry or Disable Now.');
    }
  }
}

function donationDayNotifyAdmin_(subject, body) {
  try {
    const adminEmail = getAdminEmail_();
    if (adminEmail) MailApp.sendEmail(adminEmail, subject, body);
  } catch (_) {}
}
