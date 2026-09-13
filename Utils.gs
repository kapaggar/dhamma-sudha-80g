// Utils.gs

// Verify spreadsheet UI or a native installed clock event before admin effects.
// Active-container lookup alone also succeeds in anonymous browser callbacks.
// https://developers.google.com/apps-script/guides/triggers/events
// This flag is local to one Apps Script execution, never stored between requests.
let adminContextVerified_ = false;

function requireAdminContext_(event) {
  if (adminContextVerified_) return;
  let active = null;
  try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (_) {}
  const message = 'This action is available only from the bound spreadsheet. Open the 80G Admin menu.';
  if (!active || active.getId() !== PropertiesService.getScriptProperties().getProperty('SHEET_ID')) {
    throw new Error(message);
  }

  // google.script.run can retain the bound container, but cannot obtain its UI
  // from the public web app. Menus, editor runs and sheet dialogs have the UI.
  let hasUi = false;
  try { hasUi = !!SpreadsheetApp.getUi(); } catch (_) {}
  if (!hasUi) {
    // Clock events carry a native Enum object. A browser-supplied string or JSON
    // object cannot equal this value. Never coerce authMode to a string here.
    const nativeClockEvent = event && typeof event.authMode === 'object' &&
      event.authMode === ScriptApp.AuthMode.FULL && event.triggerUid &&
      ScriptApp.getProjectTriggers().some(trigger =>
        trigger.getUniqueId() === String(event.triggerUid) &&
        trigger.getTriggerSource() === ScriptApp.TriggerSource.CLOCK);
    if (!nativeClockEvent) throw new Error(message);
  }
  // Scheduled handlers call other guarded operations within the same invocation.
  adminContextVerified_ = true;
}

/**
 * Recipient for trigger-failure alert emails. Reads the ADMIN_EMAIL Script
 * Property; returns '' (alert silently skipped) when unset. Replaces
 * Session.getActiveUser() so the manifest doesn't need the userinfo.email scope.
 */
function getAdminEmail_() {
  const email = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL');
  return email ? email.trim() : '';
}

/**
 * Generate a signed token for email.
 * One donor = one form link = one token (regardless of how many donations).
 */
function generateToken_(email) {
  const secret = PropertiesService.getScriptProperties().getProperty('TOKEN_SECRET');
  if (!secret) throw new Error('TOKEN_SECRET script property not configured.');
  const payload = email.toLowerCase().trim();
  const sigBytes = Utilities.computeHmacSha256Signature(payload, secret);
  const sigHex = sigBytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
  return Utilities.base64EncodeWebSafe(payload) + '.' + sigHex;
}

function validateToken(token, email) {
  if (typeof token !== 'string' || typeof email !== 'string' || !token || !email.trim()) return false;
  try {
    return token === generateToken_(email);
  } catch (_) {
    return false;
  }
}

function validateAndNormalizePAN(raw) {
  if (!raw || raw.toString().trim() === '') {
    return { valid: false, error: 'PAN is required.' };
  }
  const normalized = raw.toString().trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(normalized)) {
    return { valid: false, error: 'PAN must contain 5 letters, 4 digits, then 1 letter.' };
  }
  return { valid: true, pan: normalized };
}

function maskPAN(pan) {
  if (!pan || pan.length !== 10) return '**********';
  return pan.substring(0, 5) + '****' + pan.charAt(9);
}

function auditLog(ss, actor, action, recordKey, fieldChanged, oldValue, newValue, sourceId) {
  try {
    const sheet = ss.getSheetByName('audit_log');
    if (!sheet) return;
    sheet.appendRow([
      new Date().toISOString(),
      actor || 'system', action,
      recordKey || '', fieldChanged || '',
      oldValue !== undefined ? oldValue : '',
      newValue !== undefined ? newValue : '',
      sourceId || ''
    ]);
  } catch (e) { Logger.log('auditLog error: ' + e.message); }
}

function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    const range = sheet.getRange(1, 1, 1, headers.length);
    range.setValues([headers]);
    range.setFontWeight('bold');
    range.setBackground('#3c6e47');
    range.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  return sheet;
}
