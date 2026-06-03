// Whatsapp.gs
// Outbound WhatsApp PAN-request via 360dialog (On-Premise / v1 API), called DIRECTLY
// from Apps Script. Mirrors the email flow: find need_pan donors, send each an
// approved template carrying the SAME signed PAN-collection link used in email,
// throttle, log to wa_log, retry failures on the next run.
//
// Why direct (not via dipi): send_whatsapp_360() in dipi_api.module is internal-only
// (the exposed /wa-hook endpoints are inbound webhooks). 360dialog's /messages is the
// only way to INITIATE an outbound template send, so we POST it ourselves.
//
// REQUIRED Script Properties (Project Settings > Script Properties):
//   WA360_URL        360dialog base, no trailing slash. This WABA is on the Cloud API:
//                    https://waba-v2.360dialog.io   (NOT the old waba.360dialog.io/v1)
//   WA360_API_KEY    360dialog API key (sent as D360-Api-Key). NEVER hardcode. ROTATE if leaked.
//   WA_TEMPLATE_NAME approved template name (link-in-body, 3 params: name, centre, link)
// OPTIONAL Script Properties:
//   WA_API_VERSION   'v2' (Cloud, default - matches the live VRI config) or 'v1' (On-Premise)
//   WA360_NAMESPACE  template namespace (only used when WA_API_VERSION=v1; record for reference)
//   WA_TEMPLATE_LANG language code, default 'en' (set 'hi' for a Hindi template)
//   WA_MAX_PER_RUN   per-invocation cap (default WA_MAX_PER_RUN_DEFAULT)
//
// See WHATSAPP_SETUP.md for the template to register and the property values.

// --- Throttling ------------------------------------------------------------
// 360dialog/Meta enforce a business-initiated messaging limit per 24h (tiered:
// commonly 250 / 1K / 10K depending on the number's quality tier). This is a daily
// ceiling, not hourly; pacing does not raise it. We cap per run and pace; run hourly
// to drain a large list safely. On a provider rate/limit error we stop the run.
const WA_MAX_PER_RUN_DEFAULT = 50;
const WA_SEND_SLEEP_MS = 1000;

function getWaMaxPerRun_() {
  const v = parseInt(PropertiesService.getScriptProperties().getProperty('WA_MAX_PER_RUN'), 10);
  return (!isNaN(v) && v > 0) ? v : WA_MAX_PER_RUN_DEFAULT;
}

// Normalize an Indian mobile to 91XXXXXXXXXX, or null if not a valid 10-digit mobile.
// Strips +, spaces, dashes, parentheses; drops a leading 91 (12 digits) or 0 (11).
function normalizePhoneIN_(raw) {
  if (raw === null || raw === undefined) return null;
  let d = raw.toString().replace(/[^\d]/g, '');
  if (d.length === 12 && d.indexOf('91') === 0) d = d.substring(2);
  if (d.length === 11 && d.indexOf('0') === 0) d = d.substring(1);
  if (d.length !== 10) return null;
  if (!/^[6-9]\d{9}$/.test(d)) return null; // Indian mobiles start 6-9
  return '91' + d;
}

// Mask a phone for logs/audit: 91XXXXX -> 91*****1234
function maskPhone_(p) {
  if (!p) return '';
  const s = p.toString();
  if (s.length <= 4) return s;
  return s.substring(0, 2) + '*****' + s.substring(s.length - 4);
}

// Build a template-message payload for the configured 360dialog API version.
// v2 (Cloud, waba-v2.360dialog.io) is the default and matches the live VRI config:
// Meta-passthrough shape (messaging_product, no namespace, language.code only).
// v1 (On-Premise, waba.360dialog.io/v1) kept as a fallback toggle.
function buildTemplatePayload_(apiVersion, to, templateName, lang, namespace, bodyParams) {
  const components = [];
  if (bodyParams && bodyParams.length) {
    components.push({
      type: 'body',
      parameters: bodyParams.map(t => ({ type: 'text', text: (t == null ? '' : String(t)) }))
    });
  }
  if (apiVersion === 'v1') {
    return {
      to: to,
      type: 'template',
      template: {
        namespace: namespace,
        language: { policy: 'deterministic', code: lang },
        name: templateName,
        components: components
      }
    };
  }
  // v2 Cloud
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: lang },
      components: components
    }
  };
}

// Low-level 360dialog template send (endpoint = {WA360_URL}/messages).
// opts: { to, templateName, lang, namespace, bodyParams: [str,...] }
// Returns { ok, code, messageId, error }.
function sendWhatsApp360_(opts) {
  const props = PropertiesService.getScriptProperties();
  const base = (props.getProperty('WA360_URL') || '').replace(/\/+$/, '');
  const key = props.getProperty('WA360_API_KEY');
  if (!base || !key) throw new Error('WA360_URL / WA360_API_KEY script properties not set.');
  const apiVersion = (props.getProperty('WA_API_VERSION') || 'v2').toLowerCase();
  const namespace = opts.namespace || props.getProperty('WA360_NAMESPACE') || '';
  const lang = opts.lang || 'en';

  const payload = buildTemplatePayload_(apiVersion, opts.to, opts.templateName, lang, namespace, opts.bodyParams);

  let resp;
  try {
    resp = UrlFetchApp.fetch(base + '/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'D360-Api-Key': key },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (e) {
    return { ok: false, code: 0, messageId: '', error: e.message };
  }

  const code = resp.getResponseCode();
  const body = resp.getContentText();
  let messageId = '', error = '';
  try {
    const j = JSON.parse(body);
    if (j && j.messages && j.messages[0] && j.messages[0].id) messageId = j.messages[0].id;
    if (j && j.error && j.error.message) error = String(j.error.message).substring(0, 200);        // v2 Cloud
    else if (j && j.errors) error = JSON.stringify(j.errors).substring(0, 200);                    // v1
    else if (j && j.meta && j.meta.developer_message) error = String(j.meta.developer_message).substring(0, 200);
  } catch (_) {
    error = body.substring(0, 160);
  }
  return { ok: (code < 300 && !!messageId), code: code, messageId: messageId, error: error };
}

// Send the PAN-request WhatsApp to every need_pan donor not already wa-sent.
// silent=true suppresses UI alerts (for triggers). Returns a stats object.
function sendPendingWhatsApp(silent) {
  const ss = getSpreadsheet();
  const donors = ss.getSheetByName('donors_input');
  if (!donors || donors.getLastRow() < 2) {
    if (!silent) { try { SpreadsheetApp.getUi().alert('No donor records.'); } catch (_) {} }
    return { sent: 0, failed: 0, skippedNoPhone: 0, pending: 0, remaining: null };
  }

  const props = PropertiesService.getScriptProperties();
  const webAppUrl = props.getProperty('WEB_APP_URL');
  if (!webAppUrl) throw new Error('WEB_APP_URL script property not set.');
  const templateName = props.getProperty('WA_TEMPLATE_NAME');
  if (!templateName) {
    throw new Error('WA_TEMPLATE_NAME not set. Register a 360dialog template and set ' +
      'WA_TEMPLATE_NAME, WA360_URL, WA360_API_KEY, WA360_NAMESPACE (see WHATSAPP_SETUP.md).');
  }
  const lang = props.getProperty('WA_TEMPLATE_LANG') || 'en';
  const namespace = props.getProperty('WA360_NAMESPACE') || '';
  const centerName = getCenterName();

  const waLog = getOrCreateSheet(ss, 'wa_log', [
    'phone', 'email', 'receipt_nos_in_wa', 'sent_at',
    'wa_status', 'wa_message_id', 'reminder_count', 'submitted_at', 'last_reminder_at'
  ]);

  // (a) emails already wa-sent (skip), and (b) email -> existing wa_log row, so a
  // previously-failed row is UPDATED in place rather than appended (one row per donor).
  const sentEmails = new Set();
  const waRowByEmail = {};
  if (waLog.getLastRow() > 1) {
    const rows = waLog.getRange(2, 1, waLog.getLastRow() - 1, 5).getValues(); // phone,email,receipts,sent_at,status
    for (let i = 0; i < rows.length; i++) {
      const e = (rows[i][1] || '').toString().toLowerCase().trim();
      if (!e) continue;
      waRowByEmail[e] = i + 2;
      const status = (rows[i][4] || '').toString().toLowerCase();
      if (status.indexOf('sent') === 0) sentEmails.add(e);
    }
  }

  // Group need_pan rows by email (token/link are email-keyed, same as the email flow).
  const data = donors.getDataRange().getValues();
  const byEmail = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const email = (row[4] || '').toString().toLowerCase().trim();
    if (!email) continue;
    if (row[20] !== 'need_pan') continue;
    if (!byEmail[email]) byEmail[email] = { name: row[3] || '', mobile: '', receipts: [] };
    if (!byEmail[email].mobile && row[5]) byEmail[email].mobile = row[5];
    byEmail[email].receipts.push(row[0]);
  }

  const eligible = Object.keys(byEmail).filter(e => !sentEmails.has(e)).sort();
  const maxPerRun = getWaMaxPerRun_();

  let sent = 0, failed = 0, skippedNoPhone = 0;
  let stopReason = '';

  for (const email of eligible) {
    if (sent >= maxPerRun) { stopReason = 'per-run cap (' + maxPerRun + ') reached'; break; }

    const info = byEmail[email];
    const nowIso = new Date().toISOString();
    const receiptList = info.receipts.join(',');
    const phone = normalizePhoneIN_(info.mobile);

    if (!phone) {
      Logger.log('No valid phone for ' + email + ' (raw="' + info.mobile + '")');
      writeWaLogRow_(waLog, waRowByEmail, '', email, receiptList, nowIso, 'failed: invalid_or_missing_phone', '');
      skippedNoPhone++;
      continue;
    }

    const token = generateToken(email);
    const link = webAppUrl + '?email=' + encodeURIComponent(email) + '&token=' + encodeURIComponent(token);

    const res = sendWhatsApp360_({
      to: phone,
      templateName: templateName,
      lang: lang,
      namespace: namespace,
      bodyParams: [ (info.name || 'Meditator'), centerName, link ]
    });

    if (res.ok) {
      // Write the durable audit row FIRST (same ordering rule as email): fail toward
      // "audit has it, wa_log doesn't" (re-send) rather than a silent gap.
      auditLog(ss, 'sendWhatsApp', 'whatsapp_sent', email, 'initial', '', 'sent:' + maskPhone_(phone), res.messageId || '');
      writeWaLogRow_(waLog, waRowByEmail, phone, email, receiptList, nowIso, 'sent', res.messageId || '');
      sent++;
      Utilities.sleep(WA_SEND_SLEEP_MS);
    } else {
      Logger.log('WA send FAILED ' + email + ' (' + maskPhone_(phone) + '): HTTP ' + res.code + ' ' + (res.error || ''));
      writeWaLogRow_(waLog, waRowByEmail, phone, email, receiptList, nowIso,
        'failed: HTTP ' + res.code + ' ' + (res.error || '').substring(0, 120), res.messageId || '');
      failed++;
      // Provider rate/limit -> every later send will also fail; stop now.
      if (res.code === 429 || /rate|limit|too many|throttl/i.test(res.error || '')) {
        stopReason = '360dialog rate/limit reached';
        break;
      }
    }
  }

  const pending = eligible.length - sent; // not-yet-sent this run (includes failed / no-phone)

  if (!silent) {
    try {
      SpreadsheetApp.getUi().alert(
        'WhatsApp sent:      ' + sent + '\n' +
        'Failed:             ' + failed + '\n' +
        'No valid phone:     ' + skippedNoPhone + '\n' +
        'Still pending:      ' + pending +
        (stopReason ? '\n\nStopped: ' + stopReason : '') +
        (pending > 0 ? '\n\nTip: 4. WhatsApp Donors > Enable Hourly WhatsApp Sending drains the rest automatically.' : ''));
    } catch (_) {}
  }

  return { sent: sent, failed: failed, skippedNoPhone: skippedNoPhone, pending: pending, stopReason: stopReason };
}

// Update an existing wa_log row for this email if present, else append. One row per
// donor; sent_at is stamped only on the FIRST successful send (never advanced on a
// retry/failure) so future WhatsApp reminders can anchor on it.
function writeWaLogRow_(waLog, waRowByEmail, phone, email, receiptList, nowIso, status, messageId) {
  const existing = waRowByEmail[email];
  const isSent = status === 'sent';
  if (existing) {
    if (phone) waLog.getRange(existing, 1).setValue(phone);
    waLog.getRange(existing, 3).setValue(receiptList);
    waLog.getRange(existing, 5).setValue(status);
    waLog.getRange(existing, 6).setValue(messageId || '');
    if (isSent) {
      const cur = waLog.getRange(existing, 4).getValue();
      if (!cur) waLog.getRange(existing, 4).setValue(nowIso);
    }
    // leave reminder_count (7), submitted_at (8), last_reminder_at (9) untouched
  } else {
    waLog.appendRow([phone, email, receiptList, (isSent ? nowIso : ''), status, messageId || '', 0, '', '']);
    waRowByEmail[email] = waLog.getLastRow();
  }
}

// ---------------------------------------------------------------------------
// Test send: prompt for one phone number and send the template (sample params).
// Use this to verify creds + template approval + delivery before a real run.
// ---------------------------------------------------------------------------
function promptTestWhatsApp() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('WA_TEMPLATE_NAME')) {
    ui.alert('Set WA360_URL, WA360_API_KEY, WA360_NAMESPACE and WA_TEMPLATE_NAME first (see WHATSAPP_SETUP.md).');
    return;
  }
  const resp = ui.prompt('Test WhatsApp send',
    'Enter a 10-digit mobile (or with 91/+91). A sample template message will be sent.',
    ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const phone = normalizePhoneIN_(resp.getResponseText());
  if (!phone) { ui.alert('Not a valid Indian mobile number.'); return; }

  const webAppUrl = props.getProperty('WEB_APP_URL') || '';
  const res = sendWhatsApp360_({
    to: phone,
    templateName: props.getProperty('WA_TEMPLATE_NAME'),
    lang: props.getProperty('WA_TEMPLATE_LANG') || 'en',
    namespace: props.getProperty('WA360_NAMESPACE') || '',
    bodyParams: ['Test', getCenterName(), webAppUrl]
  });
  ui.alert(res.ok
    ? 'Sent to ' + maskPhone_(phone) + '\nmessage id: ' + res.messageId
    : 'Send failed (HTTP ' + res.code + ')\n' + (res.error || ''));
}

// ---------------------------------------------------------------------------
// Hourly WhatsApp-sending trigger (drains a large list within the 24h limit)
// ---------------------------------------------------------------------------
function autoSendWhatsAppHourly() {
  try {
    const r = sendPendingWhatsApp(true);
    Logger.log('autoSendWhatsAppHourly: ' + JSON.stringify(r));
  } catch (err) {
    Logger.log('autoSendWhatsAppHourly failed: ' + err.message);
    try {
      const adminEmail = Session.getActiveUser().getEmail();
      if (adminEmail) {
        MailApp.sendEmail(adminEmail,
          '[80G System] Hourly WhatsApp sending failed',
          'Error: ' + err.message + '\n\nCheck the Apps Script execution log.');
      }
    } catch (_) {}
  }
}

function installHourlyWhatsAppTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'autoSendWhatsAppHourly') { ScriptApp.deleteTrigger(t); removed++; }
  });
  ScriptApp.newTrigger('autoSendWhatsAppHourly').timeBased().everyHours(1).create();
  SpreadsheetApp.getUi().alert(
    'Hourly WhatsApp sending enabled.\n\n' +
    'Removed: ' + removed + ' existing trigger(s).\n' +
    'Up to ' + getWaMaxPerRun_() + ' messages will be sent each hour, within the 24h limit. ' +
    'To stop, use "Disable Hourly WhatsApp Sending".');
}

function disableHourlyWhatsAppTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'autoSendWhatsAppHourly') { ScriptApp.deleteTrigger(t); removed++; }
  });
  SpreadsheetApp.getUi().alert('Removed ' + removed + ' hourly WhatsApp trigger(s).');
}
