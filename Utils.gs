// Utils.gs

/**
 * Generate a signed token for email.
 * One donor = one form link = one token (regardless of how many donations).
 */
function generateToken(email) {
  const secret = PropertiesService.getScriptProperties().getProperty('TOKEN_SECRET');
  if (!secret) throw new Error('TOKEN_SECRET script property not configured.');
  const payload = email.toLowerCase().trim();
  const sigBytes = Utilities.computeHmacSha256Signature(payload, secret);
  const sigHex = sigBytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
  return Utilities.base64EncodeWebSafe(payload) + '.' + sigHex;
}

function validateToken(token, email) {
  if (!token || !email) return false;
  try { return token === generateToken(email); }
  catch (e) { Logger.log('validateToken error: ' + e.message); return false; }
}

function validateAndNormalizePAN(raw) {
  if (!raw || raw.toString().trim() === '') {
    return { valid: false, error: 'PAN is required.' };
  }
  const normalized = raw.toString().trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(normalized)) {
    return { valid: false, error: 'PAN format invalid (expected ABCDE1234F). Got: ' + normalized };
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
