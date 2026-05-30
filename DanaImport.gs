// DanaImport.gs
// Pulls donation reports from the dana portal, parses, dedups, appends to donors_input.
//
// Requires: enable "Drive API" advanced service
// Requires Script Properties: DANA_URL, DANA_USER, DANA_PASS

// Reads a Script Property and base64-decodes it. Avoids plaintext in the
// Script Properties UI for screen-share scenarios. Not a security boundary.
function _readProp(key) {
  const raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return null;
  try {
    return Utilities.newBlob(Utilities.base64Decode(raw)).getDataAsString();
  } catch (_) {
    // Backward compat: if value isn't base64, return as-is
    return raw;
  }
}

const DANA_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Manual import - opens HTML dialog with pre-filled date pickers.
 */
function importFromDanaPortal() {
  const range = getDefaultRange_();
  const tmpl = HtmlService.createTemplateFromFile('ImportDialog');
  tmpl.defaultStart = range.start;
  tmpl.defaultEnd = range.end;
  tmpl.lastImport = range.lastImportEnd || 'never';

  const html = tmpl.evaluate().setWidth(420).setHeight(320);
  SpreadsheetApp.getUi().showModalDialog(html, 'Import from Dana Portal');
}

/**
 * Called from ImportDialog.html when user clicks "Import".
 */
function runImportFromDialog(startDate, endDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return { success: false, error: 'Invalid date format.' };
  }
  try {
    const result = runDanaImport_(startDate, endDate);
    return { success: true, result: result, startDate: startDate, endDate: endDate };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Time-triggered monthly auto-import.
 */
function autoImportMonthly() {
  const range = getDefaultRange_();
  try {
    const result = runDanaImport_(range.start, range.end);
    Logger.log('autoImportMonthly: ' + JSON.stringify(result));
    if (result.added > 0 && result.needPan > 0) {
      sendPendingEmails(true);
    }
  } catch (err) {
    Logger.log('autoImportMonthly failed: ' + err.message);
    const adminEmail = Session.getActiveUser().getEmail();
    if (adminEmail) {
      try {
        MailApp.sendEmail(adminEmail,
          '[80G System] Dana auto-import failed',
          'Error: ' + err.message + '\n\nCheck the Apps Script execution log.\n' +
          'Fallback: 80G Admin > Import from Uploaded XLS File');
      } catch (_) {}
    }
    throw err;
  }
}

/**
 * Fallback when Cloudflare blocks: user downloads XLS from dana, uploads to Drive,
 * pastes the file ID.
 */
function importFromUploadedFile() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Import from Uploaded File',
    'Paste the Google Drive file ID of the dana XLS export.\n\n' +
    '(Open the file in Drive, copy ID from URL between /d/ and /view)',
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const fileId = r.getResponseText().trim();
  if (!fileId) return;

  try {
    const result = processXlsFile_(fileId, false, {});
    showImportResult_(result, 'uploaded file');
  } catch (err) {
    ui.alert('Import failed: ' + err.message);
    Logger.log(err.stack);
  }
}

function showImportResult_(result, source) {
  SpreadsheetApp.getUi().alert(
    'Import complete (' + source + ').\n\n' +
    'Total rows:         ' + result.total + '\n' +
    'New rows added:     ' + result.added + '\n' +
    'Skipped (existing): ' + result.skipped + '\n' +
    'Need PAN:           ' + result.needPan + '\n' +
    'Have PAN (dana):    ' + result.havePan + '\n' +
    'Auto-filled (repeat donors): ' + result.autoFilled + '\n' +
    'No email:           ' + result.noEmail);
}

// ---------------------------------------------------------------------------
// Date defaults
// ---------------------------------------------------------------------------

function getDefaultRange_() {
  const lastImportEnd = getLastImportEnd_();
  const today = new Date();
  let start;

  if (lastImportEnd) {
    start = lastImportEnd;
  } else {
    // First day of previous month
    const firstOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    start = Utilities.formatDate(firstOfLastMonth, 'Asia/Kolkata', 'yyyy-MM-dd');
  }

  return {
    start: start,
    end: Utilities.formatDate(today, 'Asia/Kolkata', 'yyyy-MM-dd'),
    lastImportEnd: lastImportEnd
  };
}

// ---------------------------------------------------------------------------
// Core import flow
// ---------------------------------------------------------------------------

function runDanaImport_(startDate, endDate) {
  const baseUrl = PropertiesService.getScriptProperties().getProperty('DANA_URL');
  const user    = PropertiesService.getScriptProperties().getProperty('DANA_USER');
  const pass    = _readProp('DANA_PASS');
  if (!baseUrl || !user || !pass) {
    throw new Error('Missing Script Properties: DANA_URL, DANA_USER, DANA_PASS');
  }

  const sessionCookie = loginToDana_(baseUrl, user, pass, false);

  // Step 1: GET /donation-report to extract form_build_id and form_token
  const formResp = UrlFetchApp.fetch(baseUrl + '/donation-report', {
    headers: {
      Cookie: sessionCookie,
      'User-Agent': DANA_USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    muteHttpExceptions: true,
    followRedirects: true
  });
  if (formResp.getResponseCode() !== 200) {
    throw new Error('Failed to load /donation-report: HTTP ' + formResp.getResponseCode());
  }
  const formHtml = formResp.getContentText();
  const fbMatch = formHtml.match(/name="form_build_id"[^>]+value="([^"]+)"/);
  const ftMatch = formHtml.match(/name="form_token"[^>]+value="([^"]+)"/);
  if (!fbMatch) throw new Error('Could not find form_build_id in /donation-report');
  if (!ftMatch) throw new Error('Could not find form_token in /donation-report');
  const formBuildId = fbMatch[1];
  const formToken = ftMatch[1];
  Logger.log('form_build_id: ' + formBuildId.substring(0, 20) + '...');
  Logger.log('form_token: ' + formToken.substring(0, 20) + '...');

  const sessionCookie2 = extractCookies_(formResp, sessionCookie);

  // Step 2: POST the donation-report form to submit the date range query
  // This sets up the session state required for the excel export endpoint.
  const postResp = UrlFetchApp.fetch(baseUrl + '/donation-report', {
    method: 'post',
    payload: {
      form_build_id: formBuildId,
      form_token: formToken,
      form_id: 'donation_report_form',
      r_from: startDate,
      r_to: endDate,
      r_foreign: 'all',
      r_category: 'all',
      r_id_type: 'all',
      r_course: '',
      r_receipt: '',
      r_name: '',
      r_user: '',
      min_amount: '',
      max_amount: '',
      photo_id: '',
      op: 'Get Report'
    },
    headers: {
      Cookie: sessionCookie2,
      'User-Agent': DANA_USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': baseUrl + '/donation-report'
    },
    muteHttpExceptions: true,
    followRedirects: true
  });
  Logger.log('Report POST -> HTTP ' + postResp.getResponseCode());
  if (postResp.getResponseCode() !== 200) {
    throw new Error('Report POST failed: HTTP ' + postResp.getResponseCode());
  }
  const sessionCookie3 = extractCookies_(postResp, sessionCookie2);

  // Parse receipt_no -> donation_id from edit links in the HTML response
  const receiptToDonationId = parseReceiptToDonationIdMap_(postResp.getContentText());
  Logger.log('Parsed ' + Object.keys(receiptToDonationId).length + ' receipt -> donation_id mappings');

  // Step 3: GET the excel export with full param set (matches the link in the HTML)
  const reportUrl = baseUrl + '/donation-report/excel' +
    '?start=' + startDate + '&end=' + endDate +
    '&foreign=all&category=all&id_type=all' +
    '&txn_type&don_tags' +
    '&min_amount=&max_amount=&photo_id=' +
    '&synced&not_synced&deleted&with_logs' +
    '&course=&name=&receipt=&user=';

  Logger.log('Fetching excel: ' + reportUrl);
  const reportResp = UrlFetchApp.fetch(reportUrl, {
    headers: {
      Cookie: sessionCookie3,
      'User-Agent': DANA_USER_AGENT,
      'Accept': 'application/vnd.ms-excel,application/octet-stream,*/*',
      'Referer': baseUrl + '/donation-report'
    },
    muteHttpExceptions: true,
    followRedirects: true
  });

  const code = reportResp.getResponseCode();
  Logger.log('Excel fetch HTTP ' + code);
  if (code !== 200) {
    const body = reportResp.getContentText();
    Logger.log('Body (first 2000 chars): ' + body.substring(0, 2000));
    throw new Error('Excel fetch failed: HTTP ' + code +
      '. Check Apps Script execution log for full response.');
  }

  const ct = (reportResp.getHeaders()['Content-Type'] || '').toLowerCase();
  if (ct.indexOf('html') >= 0) {
    throw new Error('Got HTML instead of XLS. Likely Cloudflare/auth issue. ' +
      'Try: 80G Admin > Import from Uploaded XLS File');
  }

  const blob = reportResp.getBlob().setName('dana_import_' + new Date().getTime() + '.xls');
  const tempFile = Drive.Files.insert(
    { title: blob.getName(), mimeType: MimeType.GOOGLE_SHEETS },
    blob
  );

  try {
    const result = processXlsFile_(tempFile.id, true, receiptToDonationId);
    result.startDate = startDate;
    result.endDate = endDate;
    logImport_(startDate, endDate, result);
    return result;
  } finally {
    try { DriveApp.getFileById(tempFile.id).setTrashed(true); } catch (_) {}
  }
}

function processXlsFile_(fileId, isAlreadyGoogleSheet, receiptToDonationId) {
  let sheetId = fileId;
  let cleanup = false;

  if (!isAlreadyGoogleSheet) {
    const sourceFile = DriveApp.getFileById(fileId);
    const blob = sourceFile.getBlob();
    const converted = Drive.Files.insert(
      { title: 'dana_temp_' + new Date().getTime(), mimeType: MimeType.GOOGLE_SHEETS },
      blob
    );
    sheetId = converted.id;
    cleanup = true;
  }

  try {
    const ss = SpreadsheetApp.openById(sheetId);
    const sheet = ss.getSheets()[0];
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) throw new Error('Report is empty.');
    const headerMap = mapColumns_(data[0]);
    return processRows_(data, headerMap, receiptToDonationId || {});
  } finally {
    if (cleanup) {
      try { DriveApp.getFileById(sheetId).setTrashed(true); } catch (_) {}
    }
  }
}

// ---------------------------------------------------------------------------
// Login (Drupal 7) - with User-Agent and verbose mode
// ---------------------------------------------------------------------------

function loginToDana_(baseUrl, user, pass, verbose) {
  if (verbose) Logger.log('--- Dana login (verbose) ---');

  // Step 1: GET login page
  const loginPageUrl = baseUrl + '/user/login';
  const pageResp = UrlFetchApp.fetch(loginPageUrl, {
    headers: { 'User-Agent': DANA_USER_AGENT },
    muteHttpExceptions: true,
    followRedirects: false
  });

  const pageCode = pageResp.getResponseCode();
  if (verbose) {
    Logger.log('GET ' + loginPageUrl + ' -> HTTP ' + pageCode);
    Logger.log('Response headers: ' + JSON.stringify(pageResp.getAllHeaders()));
  }

  if (pageCode === 403 || pageCode === 503) {
    throw new Error('Cloudflare blocked the request (HTTP ' + pageCode + '). ' +
      'Use 80G Admin > Import from Uploaded XLS File.');
  }
  if (pageCode !== 200) throw new Error('Login page fetch failed: HTTP ' + pageCode);

  const html = pageResp.getContentText();
  const m = html.match(/name="form_build_id"[^>]+value="([^"]+)"/);
  if (!m) {
    if (verbose) Logger.log('HTML snippet: ' + html.substring(0, 500));
    throw new Error('Could not extract form_build_id from login page.');
  }
  const formBuildId = m[1];
  if (verbose) Logger.log('form_build_id: ' + formBuildId);

  const initialCookies = extractCookies_(pageResp);
  if (verbose) Logger.log('Initial cookies: ' + initialCookies);

  // Step 2: POST credentials
  const postResp = UrlFetchApp.fetch(
    baseUrl + '/user/login?destination=donation&autologout_timeout=1',
    {
      method: 'post',
      payload: {
        name: user,
        pass: pass,
        form_build_id: formBuildId,
        form_id: 'user_login',
        op: 'Log in'
      },
      headers: {
        Cookie: initialCookies,
        'User-Agent': DANA_USER_AGENT
      },
      followRedirects: false,
      muteHttpExceptions: true
    }
  );

  const postCode = postResp.getResponseCode();
  if (verbose) {
    Logger.log('POST login -> HTTP ' + postCode);
    Logger.log('Response headers: ' + JSON.stringify(postResp.getAllHeaders()));
  }

  // Successful Drupal login = 302 redirect
  if (postCode === 200) {
    // Probably got login form back = bad credentials
    const body = postResp.getContentText();
    if (body.indexOf('form_build_id') >= 0 || body.indexOf('user-login') >= 0) {
      const errMatch = body.match(/<div[^>]*class="[^"]*messages[^"]*error[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      const errMsg = errMatch ? errMatch[1].replace(/<[^>]*>/g, '').trim().substring(0, 200) : 'unknown';
      throw new Error('Login rejected (bad credentials?). Server message: ' + errMsg);
    }
  }
  if (postCode !== 302 && postCode !== 200) {
    throw new Error('Login POST failed: HTTP ' + postCode);
  }

  const sessionCookies = extractCookies_(postResp, initialCookies);
  if (verbose) Logger.log('Session cookies: ' + sessionCookies);

  // Drupal HTTPS session cookie is SSESS<hash>, HTTP is SESS<hash>
  if (!/(?:^|\s|;)S?SESS[a-f0-9]+=/i.test(sessionCookies)) {
    throw new Error('Login succeeded (HTTP ' + postCode + ') but no SESS/SSESS cookie returned. ' +
      'Cookies present: ' + sessionCookies.split(';').map(c => c.trim().split('=')[0]).join(', ') +
      '\nRun testDanaImportLogin (with verbose=true) to debug.');
  }
  return sessionCookies;
}

/**
 * Extract Set-Cookie headers (case-insensitive), merge with prior cookies.
 */
function extractCookies_(response, priorCookieHeader) {
  const allHeaders = response.getAllHeaders();

  // Find Set-Cookie header (case-insensitive)
  let setCookies = [];
  Object.keys(allHeaders).forEach(k => {
    if (k.toLowerCase() === 'set-cookie') {
      const v = allHeaders[k];
      if (Array.isArray(v)) setCookies = setCookies.concat(v);
      else if (v) setCookies.push(v);
    }
  });

  const cookieMap = {};
  if (priorCookieHeader) {
    priorCookieHeader.split(';').forEach(c => {
      // Split on the FIRST '=' only. A naive split('=') truncates values that
      // legitimately contain '=' (e.g. Cloudflare __cf_bm / cf_clearance, base64
      // padding), corrupting the session/clearance cookie on subsequent requests.
      const s = c.trim();
      const i = s.indexOf('=');
      if (i > 0) cookieMap[s.substring(0, i)] = s.substring(i + 1);
    });
  }
  setCookies.forEach(sc => {
    const firstPart = sc.split(';')[0].trim();
    const idx = firstPart.indexOf('=');
    if (idx > 0) {
      const k = firstPart.substring(0, idx);
      const v = firstPart.substring(idx + 1);
      cookieMap[k] = v;
    }
  });
  return Object.keys(cookieMap).map(k => k + '=' + cookieMap[k]).join('; ');
}

// ---------------------------------------------------------------------------
// Column mapping + row processing
// ---------------------------------------------------------------------------

function mapColumns_(headers) {
  const norm = headers.map(h => (h || '').toString().toLowerCase().replace(/[^a-z]/g, ''));
  const idx = {};
  const find = function(...names) {
    for (const n of names) {
      const i = norm.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  idx.txnDate     = find('txndate');
  idx.course      = find('course');
  idx.fullName    = find('fullname');
  idx.address     = find('address');
  idx.city        = find('city');
  idx.state       = find('state');
  idx.pin         = find('pin');
  idx.country     = find('country');
  idx.mobile      = find('mobile');
  idx.txnType     = find('txntype');
  idx.category    = find('category');
  idx.receiptNo   = find('receiptno');
  idx.idType      = find('idtype');
  idx.idValue     = find('passportid');
  idx.merchantRef = find('merchantrefno');
  idx.currency    = find('currency');
  idx.foreign     = find('foreign');
  idx.comment     = find('comment');
  idx.email       = find('email');
  idx.createdBy   = find('createdby');
  idx.createdOn   = find('createdon');

  const paymentNames = ['cash','cheque','banktransfer','razorpay','upisbi','upiib','upipnb','kind','card','icici','upi','dd'];
  idx.paymentCols = [];
  norm.forEach((n, i) => {
    if (paymentNames.indexOf(n) >= 0) idx.paymentCols.push({ col: i, name: headers[i] });
  });

  if (idx.receiptNo < 0) throw new Error('Could not find Receipt No column.');
  if (idx.email < 0) throw new Error('Could not find Email column.');
  if (idx.fullName < 0) throw new Error('Could not find Full Name column.');
  return idx;
}

function processRows_(data, idx, receiptToDonationId) {
  const ss = SpreadsheetApp.openById(
    PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  const donorsSheet = ss.getSheetByName('donors_input');
  if (!donorsSheet) throw new Error('donors_input sheet not found - run initSheets.');

  const existing = new Set();
  if (donorsSheet.getLastRow() > 1) {
    const rNos = donorsSheet.getRange(2, 1, donorsSheet.getLastRow() - 1, 1).getValues();
    rNos.forEach(r => { if (r[0]) existing.add(r[0].toString().trim()); });
  }

  const emailToPan = {};
  if (donorsSheet.getLastRow() > 1) {
    const allRows = donorsSheet.getDataRange().getValues();
    for (let i = 1; i < allRows.length; i++) {
      const row = allRows[i];
      const email = (row[4] || '').toString().toLowerCase().trim();
      if (!email) continue;
      if (row[18]) emailToPan[email] = { pan: row[18], pan_name: row[19] || '' };
      else if ((row[16] || '').toString().toUpperCase() === 'PAN' && row[17]) {
        emailToPan[email] = {
          pan: row[17].toString().toUpperCase().replace(/\s+/g, ''),
          pan_name: ''
        };
      }
    }
  }

  const now = new Date().toISOString();
  const stats = { total: 0, added: 0, skipped: 0, needPan: 0, havePan: 0, autoFilled: 0, noEmail: 0 };
  const newRows = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const receiptNo = idx.receiptNo >= 0 ? toStr_(row[idx.receiptNo]) : '';
    if (!receiptNo) continue;
    stats.total++;

    if (existing.has(receiptNo)) { stats.skipped++; continue; }

    const email = idx.email >= 0 ? toStr_(row[idx.email]).toLowerCase() : '';
    const idType = idx.idType >= 0 ? toStr_(row[idx.idType]) : '';
    const idValue = idx.idValue >= 0 ? toStr_(row[idx.idValue]) : '';

    let amount = 0, paymentMode = '';
    idx.paymentCols.forEach(p => {
      const v = parseFloat(row[p.col]);
      if (!isNaN(v) && v > 0) {
        amount += v;
        if (!paymentMode) paymentMode = p.name;
      }
    });

    let panCollected = '', panName = '', panStatus;
    if (!email) {
      panStatus = 'no_email'; stats.noEmail++;
    } else if (idType.toUpperCase() === 'PAN' && idValue) {
      panCollected = idValue.toUpperCase().replace(/\s+/g, '');
      panStatus = 'have_pan'; stats.havePan++;
    } else if (emailToPan[email]) {
      panCollected = emailToPan[email].pan;
      panName = emailToPan[email].pan_name;
      panStatus = 'have_pan'; stats.autoFilled++;
    } else {
      panStatus = 'need_pan'; stats.needPan++;
    }

    newRows.push([
      receiptNo,
      idx.txnDate >= 0 ? formatDate_(row[idx.txnDate]) : '',
      idx.createdOn >= 0 ? formatDateTime_(row[idx.createdOn]) : '',
      idx.fullName >= 0 ? toStr_(row[idx.fullName]) : '',
      email,
      idx.mobile >= 0 ? toStr_(row[idx.mobile]) : '',
      idx.address >= 0 ? toStr_(row[idx.address]) : '',
      idx.city >= 0 ? toStr_(row[idx.city]) : '',
      idx.state >= 0 ? toStr_(row[idx.state]) : '',
      idx.country >= 0 ? toStr_(row[idx.country]) : '',
      idx.course >= 0 ? toStr_(row[idx.course]) : '',
      idx.category >= 0 ? toStr_(row[idx.category]) : '',
      idx.txnType >= 0 ? toStr_(row[idx.txnType]) : '',
      paymentMode,
      amount,
      idx.merchantRef >= 0 ? toStr_(row[idx.merchantRef]) : '',
      idType,
      idValue,
      panCollected,
      panName,
      panStatus,
      idx.comment >= 0 ? toStr_(row[idx.comment]) : '',
      now,
      '',
      receiptToDonationId[receiptNo] || '',  // Y dana_donation_id
      ''                                      // Z dana_updated_at
    ]);
  }

  if (newRows.length > 0) {
    const startRow = donorsSheet.getLastRow() + 1;
    donorsSheet.getRange(startRow, 1, newRows.length, newRows[0].length).setValues(newRows);
    stats.added = newRows.length;
    auditLog(ss, 'danaImport', 'bulk_insert',
      'rows=' + stats.added, 'donors_input', '', stats.added, '');
  }

  return stats;
}

// ---------------------------------------------------------------------------
// import_log
// ---------------------------------------------------------------------------

function getLastImportEnd_() {
  const ss = SpreadsheetApp.openById(
    PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  const sheet = ss.getSheetByName('import_log');
  if (!sheet || sheet.getLastRow() < 2) return null;
  const lastEnd = sheet.getRange(sheet.getLastRow(), 2).getValue();
  return lastEnd ? Utilities.formatDate(new Date(lastEnd), 'Asia/Kolkata', 'yyyy-MM-dd') : null;
}

function logImport_(startDate, endDate, result) {
  const ss = SpreadsheetApp.openById(
    PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  const sheet = getOrCreateSheet(ss, 'import_log',
    ['import_start', 'import_end', 'imported_at', 'total', 'added', 'skipped',
     'need_pan', 'have_pan', 'auto_filled', 'no_email']);
  sheet.appendRow([
    startDate, endDate, new Date().toISOString(),
    result.total, result.added, result.skipped,
    result.needPan, result.havePan, result.autoFilled, result.noEmail
  ]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toStr_(v) {
  if (v === null || v === undefined) return '';
  return v.toString().trim();
}

function formatDate_(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Kolkata', 'yyyy-MM-dd');
  return toStr_(v);
}

function formatDateTime_(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss');
  return toStr_(v);
}

// ---------------------------------------------------------------------------
// Debug
// ---------------------------------------------------------------------------

/**
 * Verbose login test - prints diagnostic info to log.
 */
function testDanaImportLogin() {
  try {
    const cookie = loginToDana_(
      PropertiesService.getScriptProperties().getProperty('DANA_URL'),
      PropertiesService.getScriptProperties().getProperty('DANA_USER'),
      _readProp('DANA_PASS'),
      true  // verbose
    );
    Logger.log('=== LOGIN OK ===');
    Logger.log('Cookie length: ' + cookie.length);
    Logger.log('Cookie names: ' + cookie.split(';').map(c => c.trim().split('=')[0]).join(', '));
  } catch (err) {
    Logger.log('=== LOGIN FAILED ===');
    Logger.log(err.message);
    Logger.log(err.stack);
  }
}


/**
 * Test the full flow: login, get form tokens, POST report query, GET excel.
 */
function testDanaReportFetch() {
  try {
    const today = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
    const result = runDanaImport_('2026-04-01', today);
    Logger.log('=== TEST RESULT ===');
    Logger.log(JSON.stringify(result, null, 2));
  } catch (err) {
    Logger.log('=== TEST FAILED ===');
    Logger.log(err.message);
    Logger.log(err.stack);
  }
}


/**
 * Parse the /donation-report HTML response to build a map of receipt_no -> donation_id.
 * Looks for /donation/edit/{id} links and finds the nearest ER[\d]+ receipt before each.
 */
function parseReceiptToDonationIdMap_(html) {
  const map = {};
  const editRe = /\/donation\/edit\/(\d+)/g;
  let m;
  const positions = [];
  while ((m = editRe.exec(html)) !== null) {
    positions.push({ donationId: m[1], pos: m.index });
  }

  positions.forEach(p => {
    const start = Math.max(0, p.pos - 3000);
    const region = html.substring(start, p.pos);
    const localRe = /\b(ER-?\d+)\b/g;
    let lastMatch = null, lm;
    while ((lm = localRe.exec(region)) !== null) lastMatch = lm;
    if (lastMatch) map[lastMatch[1]] = p.donationId;
  });

  return map;
}
