// Utils.gs

/**
 * Generate a signed token for (courseId, email).
 * Format: base64url(payload) + "." + HMAC-SHA256-hex(payload)
 * Token is deterministic - same input always produces same token.
 */
function generateToken(courseId, email) {
  const secret = PropertiesService.getScriptProperties().getProperty('TOKEN_SECRET');
  if (!secret) throw new Error('TOKEN_SECRET script property not configured.');
  const payload = courseId.trim() + '|' + email.toLowerCase().trim();
  const sigBytes = Utilities.computeHmacSha256Signature(payload, secret);
  const sigHex = sigBytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
  return Utilities.base64EncodeWebSafe(payload) + '.' + sigHex;
}

/**
 * Validate token against expected value for (courseId, email).
 */
function validateToken(token, courseId, email) {
  if (!token || !courseId || !email) return false;
  try {
    return token === generateToken(courseId, email);
  } catch (e) {
    Logger.log('validateToken error: ' + e.message);
    return false;
  }
}

/**
 * Normalize and validate PAN.
 * Trims, uppercases, removes internal spaces, validates [A-Z]{5}[0-9]{4}[A-Z].
 */
function validateAndNormalizePAN(raw) {
  if (!raw || raw.toString().trim() === '') {
    return { valid: false, error: 'PAN is required.' };
  }
  const normalized = raw.toString().trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(normalized)) {
    return {
      valid: false,
      error: 'PAN format invalid (expected ABCDE1234F - 5 letters, 4 digits, 1 letter). Got: ' + normalized
    };
  }
  return { valid: true, pan: normalized };
}

/**
 * Mask PAN for admin display: ABCDE****F
 */
function maskPAN(pan) {
  if (!pan || pan.length !== 10) return '**********';
  return pan.substring(0, 5) + '****' + pan.charAt(9);
}

/**
 * Find existing submission matching email + pan + course_id composite key.
 */
function findDuplicateSubmission(sheet, email, pan, courseId) {
  if (!sheet || sheet.getLastRow() < 2) return null;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (
      row[2] === email.toLowerCase().trim() &&
      row[6] === pan &&
      row[1] === courseId.trim()
    ) {
      return { rowIndex: i + 1, submissionId: row[0], status: row[12] };
    }
  }
  return null;
}

/**
 * Append a row to audit_log.
 */
function auditLog(ss, actor, action, recordKey, fieldChanged, oldValue, newValue, sourceSubId) {
  try {
    const sheet = ss.getSheetByName('audit_log');
    if (!sheet) return;
    sheet.appendRow([
      new Date().toISOString(),
      actor || 'system',
      action,
      recordKey || '',
      fieldChanged || '',
      oldValue !== undefined ? oldValue : '',
      newValue !== undefined ? newValue : '',
      sourceSubId || ''
    ]);
  } catch (e) {
    Logger.log('auditLog error: ' + e.message);
  }
}

/**
 * Get or create a sheet with headers if it does not exist.
 */
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
