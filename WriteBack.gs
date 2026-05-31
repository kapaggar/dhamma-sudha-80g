// WriteBack.gs
// Pushes collected PAN values back to the dana portal by editing donation slips.
//
// Safety:
// - Dry-run mode for preview without writes
// - Max writes per run (circuit breaker on volume)
// - Stops after N consecutive errors
// - Skips records already pushed (dana_updated_at)
// - Skips records where dana already has id_type=PAN
// - Audit log for every write

const WRITEBACK_MAX_PER_RUN = 50;
const WRITEBACK_MAX_CONSECUTIVE_ERRORS = 3;
const DANA_ID_TYPE_PAN = '1';   // From dana edit form HTML (1=PAN, 2=Aadhaar, 4=Passport, etc)

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

function previewWriteBackToDana() {
  const result = writeBackPANs_(true);
  showWriteBackResult_(result, true);
}

function pushPANsToDana() {
  const result = writeBackPANs_(false);
  showWriteBackResult_(result, false);
}

function autoWriteBackHourly() {
  // For time-trigger - no UI alerts, just logs
  try {
    const result = writeBackPANs_(false);
    Logger.log('autoWriteBackHourly: ' + JSON.stringify(result));
  } catch (err) {
    Logger.log('autoWriteBackHourly failed: ' + err.message);
    const adminEmail = Session.getActiveUser().getEmail();
    if (adminEmail) {
      try {
        MailApp.sendEmail(adminEmail,
          '[80G System] Hourly dana write-back failed',
          'Error: ' + err.message + '\n\nCheck Apps Script execution log.');
      } catch (_) {}
    }
  }
}

function showWriteBackResult_(r, dryRun) {
  const tag = dryRun ? '[DRY RUN] ' : '';
  SpreadsheetApp.getUi().alert(
    tag + 'Write-back to dana complete.\n\n' +
    'Eligible candidates:  ' + r.total_candidates + '\n' +
    'Processed this run:   ' + r.processed + '\n' +
    'Succeeded:            ' + r.succeeded + '\n' +
    'Failed:               ' + r.failed + '\n' +
    'Skipped (no map):     ' + r.skipped +
    (r.circuit_break ? '\n\nCircuit breaker tripped: ' + r.circuit_break : '')
  );
}

// ---------------------------------------------------------------------------
// Core flow
// ---------------------------------------------------------------------------

function writeBackPANs_(dryRun) {
  const candidates = findWriteBackCandidates_();
  if (candidates.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0, skipped: 0, total_candidates: 0 };
  }

  // Serialize real write-backs: a manual "Push Now" and the hourly trigger both
  // read candidates then write per-row; running them concurrently could double-POST
  // the same donation_id. Dry-run does no writes, so it stays lock-free.
  let lock = null;
  if (!dryRun) {
    lock = LockService.getScriptLock();
    try {
      lock.waitLock(30000);
    } catch (lockErr) {
      return {
        total_candidates: candidates.length,
        processed: 0, succeeded: 0, failed: 0, skipped: 0,
        circuit_break: 'Another write-back is already running (could not acquire lock).'
      };
    }
  }

  try {
    const batch = candidates.slice(0, WRITEBACK_MAX_PER_RUN);
    Logger.log('Writeback: ' + candidates.length + ' eligible, processing ' + batch.length);

    const baseUrl = PropertiesService.getScriptProperties().getProperty('DANA_URL');
    const user    = PropertiesService.getScriptProperties().getProperty('DANA_USER');
    const pass    = _readProp('DANA_PASS');

    const sessionCookie = loginToDana_(baseUrl, user, pass, false);

    // For rows missing donation_id, try to look it up from dana now
    const needLookup = batch.filter(c => !c.donationId);
    if (needLookup.length > 0) {
      Logger.log(needLookup.length + ' rows missing donation_id - fetching from dana');
      const lookedUp = fetchDonationIdsForCandidates_(baseUrl, sessionCookie, needLookup);
      needLookup.forEach(c => {
        if (lookedUp[c.receiptNo]) c.donationId = lookedUp[c.receiptNo];
      });
    }

    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName('donors_input');
    let succeeded = 0, failed = 0, skipped = 0, consec = 0;
    let circuitBreak = null;

    for (const c of batch) {
      if (!c.donationId) {
        Logger.log('Skip ' + c.receiptNo + ' - no donation_id mapping');
        skipped++;
        continue;
      }

      if (dryRun) {
        Logger.log('[DRY RUN] Would update donation_id=' + c.donationId +
          ' receipt=' + c.receiptNo +
          ' (' + c.currentIdType + ' -> PAN ' + maskPAN(c.pan) + ')');
        succeeded++;
        consec = 0;
        continue;
      }

      try {
        updateDonationSlip_(baseUrl, sessionCookie, c.donationId, c.pan);

        // Mark in sheet: column Y = dana_donation_id, Z = dana_updated_at
        sheet.getRange(c.rowIndex, 25).setValue(c.donationId);
        sheet.getRange(c.rowIndex, 26).setValue(new Date().toISOString());

        auditLog(ss, 'writeBack', 'dana_updated',
          c.receiptNo, 'd_id_type+d_id_no',
          c.currentIdType + ':' + (c.currentIdValue || ''),
          'PAN:' + maskPAN(c.pan),
          c.donationId);

        succeeded++;
        consec = 0;
        // Small delay to avoid hammering the dana server
        Utilities.sleep(800);
      } catch (err) {
        Logger.log('Update FAILED for ' + c.receiptNo + ' (donation_id=' + c.donationId + '): ' + err.message);
        auditLog(ss, 'writeBack', 'dana_update_failed',
          c.receiptNo, '', '', err.message.substring(0, 400), c.donationId);
        failed++;
        consec++;
        if (consec >= WRITEBACK_MAX_CONSECUTIVE_ERRORS) {
          circuitBreak = consec + ' consecutive failures - stopping';
          Logger.log(circuitBreak);
          break;
        }
      }
    }

    return {
      total_candidates: candidates.length,
      processed: succeeded + failed + skipped,
      succeeded, failed, skipped,
      circuit_break: circuitBreak
    };
  } finally {
    if (lock) lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

function findWriteBackCandidates_() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName('donors_input');
  if (!sheet || sheet.getLastRow() < 2) return [];
  if (sheet.getLastColumn() < 26) {
    throw new Error('donors_input sheet is missing dana_donation_id / dana_updated_at columns. Run "Migrate Schema" first.');
  }

  const data = sheet.getDataRange().getValues();
  const candidates = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const panStatus = row[20];                       // U
    const idType = (row[16] || '').toString().toUpperCase().trim(); // Q
    const idValue = row[17];                         // R
    const pan = row[18];                             // S pan_collected
    const danaDonationId = (row[24] || '').toString().trim();  // Y
    const danaUpdatedAt = row[25];                   // Z

    if (panStatus !== 'have_pan') continue;          // Need PAN collected
    if (!pan) continue;                              // Belt-and-suspenders
    if (idType === 'PAN') continue;                  // Dana already has PAN
    if (danaUpdatedAt) continue;                     // Already pushed

    candidates.push({
      rowIndex: i + 1,
      receiptNo: row[0],
      txnDate: row[1],
      pan: pan,
      currentIdType: idType || '(none)',
      currentIdValue: idValue,
      donationId: danaDonationId
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Lookup donation_id for receipts missing the mapping (re-fetch report HTML)
// ---------------------------------------------------------------------------

function fetchDonationIdsForCandidates_(baseUrl, sessionCookie, candidates) {
  // Determine date range
  let minDate = null, maxDate = null;
  candidates.forEach(c => {
    if (!c.txnDate) return;
    const d = (c.txnDate instanceof Date) ? c.txnDate : new Date(c.txnDate);
    if (isNaN(d.getTime())) return;
    if (!minDate || d < minDate) minDate = d;
    if (!maxDate || d > maxDate) maxDate = d;
  });
  if (!minDate || !maxDate) {
    Logger.log('No valid txn dates - cannot fetch donation_ids');
    return {};
  }

  const startDate = Utilities.formatDate(minDate, 'Asia/Kolkata', 'yyyy-MM-dd');
  const endDate = Utilities.formatDate(maxDate, 'Asia/Kolkata', 'yyyy-MM-dd');
  Logger.log('Lookup donation_ids for date range: ' + startDate + ' to ' + endDate);

  // GET /donation-report for form tokens
  const formResp = UrlFetchApp.fetch(baseUrl + '/donation-report', {
    headers: {
      Cookie: sessionCookie,
      'User-Agent': DANA_USER_AGENT,
      'Accept': 'text/html'
    },
    muteHttpExceptions: true
  });
  if (formResp.getResponseCode() !== 200) throw new Error('GET donation-report: HTTP ' + formResp.getResponseCode());
  const formHtml = formResp.getContentText();
  const fb = formHtml.match(/name="form_build_id"[^>]+value="([^"]+)"/);
  const ft = formHtml.match(/name="form_token"[^>]+value="([^"]+)"/);
  if (!fb || !ft) throw new Error('No form tokens on /donation-report');
  const cookie2 = extractCookies_(formResp, sessionCookie);

  // POST report query
  const postResp = UrlFetchApp.fetch(baseUrl + '/donation-report', {
    method: 'post',
    payload: {
      form_build_id: fb[1], form_token: ft[1],
      form_id: 'donation_report_form',
      r_from: startDate, r_to: endDate,
      r_foreign: 'all', r_category: 'all', r_id_type: 'all',
      r_course: '', r_receipt: '', r_name: '', r_user: '',
      min_amount: '', max_amount: '', photo_id: '',
      op: 'Get Report'
    },
    headers: {
      Cookie: cookie2,
      'User-Agent': DANA_USER_AGENT,
      'Referer': baseUrl + '/donation-report',
      'Accept': 'text/html'
    },
    followRedirects: true,
    muteHttpExceptions: true
  });
  if (postResp.getResponseCode() !== 200) throw new Error('POST donation-report: HTTP ' + postResp.getResponseCode());

  return parseReceiptToDonationIdMap_(postResp.getContentText());
}

// ---------------------------------------------------------------------------
// Edit a single donation slip
// ---------------------------------------------------------------------------

function updateDonationSlip_(baseUrl, sessionCookie, donationId, newPan) {
  // The edit is idempotent (we always set the same d_id_type/d_id_no), so a fresh
  // GET+POST retry is safe. Retry once on a transient 5xx - Drupal DB deadlock / OOM
  // surface as HTTP 500 (this is what ER0010472 / donation_id 10555 hit). A 4xx or a
  // 200 re-render is a real rejection and is NOT retried; it is surfaced with a
  // sanitized snippet of dana's response so the audit_log is diagnostic.
  let last;
  for (let attempt = 1; attempt <= 2; attempt++) {
    last = postDonationEdit_(baseUrl, sessionCookie, donationId, newPan);
    if (last.code === 302) return;

    const snippet = sanitizeDanaError_(last.body);
    Logger.log('Edit POST HTTP ' + last.code + ' (attempt ' + attempt + '/2) donation_id=' +
      donationId + (snippet ? ' :: ' + snippet : ''));

    if (last.code >= 500 && attempt < 2) {
      Utilities.sleep(1500);
      continue;
    }
    throw new Error('Edit POST HTTP ' + last.code + ' (expected 302 redirect)' +
      (snippet ? ' - ' + snippet : ''));
  }
}

// One GET (read current field values) + one POST (submit the PAN edit).
// Returns { code, body }; throws only if the GET or token extraction fails.
function postDonationEdit_(baseUrl, sessionCookie, donationId, newPan) {
  const editUrl = baseUrl + '/donation/edit/' + donationId;

  const getResp = UrlFetchApp.fetch(editUrl, {
    headers: { Cookie: sessionCookie, 'User-Agent': DANA_USER_AGENT, 'Accept': 'text/html' },
    muteHttpExceptions: true
  });
  if (getResp.getResponseCode() !== 200) {
    throw new Error('GET edit form HTTP ' + getResp.getResponseCode());
  }
  const html = getResp.getContentText();
  const cookie2 = extractCookies_(getResp, sessionCookie);

  const values = extractFormValues_(html);
  if (!values.form_build_id || !values.form_token) {
    throw new Error('Could not extract form tokens from edit page');
  }

  // Override id_type and id_no with PAN
  values.d_id_type = DANA_ID_TYPE_PAN;
  values.d_id_no = newPan;
  values.form_id = 'donation_main_form';

  // Do NOT trigger another email/whatsapp confirmation to the donor.
  // NOTE (B6): assumes dana's notification toggles are named email/whatsapp and are
  // NOT the donor contact fields. Verify on a live edit form before a large batch -
  // posting email=0 to a contact field would corrupt donor data in the source.
  values.email = '0';
  values.whatsapp = '0';

  const postResp = UrlFetchApp.fetch(editUrl, {
    method: 'post',
    payload: values,
    headers: { Cookie: cookie2, 'User-Agent': DANA_USER_AGENT, 'Referer': editUrl },
    followRedirects: false,
    muteHttpExceptions: true
  });
  return { code: postResp.getResponseCode(), body: postResp.getContentText() };
}

// Strip a dana HTML error page down to a short, log-safe, single-line snippet.
// Drupal 7 renders unhandled exceptions as a boilerplate page; the useful part
// (PDOException: SQLSTATE[...] + offending column/constraint) appears AFTER the
// "Error message" label. We start there so a short snippet still carries the
// diagnostic payload, and we redact PAN-shaped tokens - a duplicate-key DB error
// echoes the raw value, which would otherwise leak NPI into audit_log.
function sanitizeDanaError_(html) {
  if (!html) return '';
  let text = html.toString()
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Jump to Drupal's "Error message" label if present (the real PDO text follows it).
  const idx = text.search(/Error message/i);
  if (idx >= 0) text = text.substring(idx + 'Error message'.length).trim();
  return maskPanInText_(text).substring(0, 300);
}

// Redact any PAN-shaped token ([A-Z]{5}[0-9]{4}[A-Z]) from free text before logging.
function maskPanInText_(s) {
  if (!s) return '';
  return s.toString().replace(/\b[A-Za-z]{5}\d{4}[A-Za-z]\b/g, 'PAN_REDACTED');
}

// ---------------------------------------------------------------------------
// HTML form value extraction
// ---------------------------------------------------------------------------

function extractFormValues_(html) {
  const values = {};
  let m;

  // Input tags
  const inputRe = /<input\b[^>]*>/gi;
  while ((m = inputRe.exec(html)) !== null) {
    const tag = m[0];
    const nameM = tag.match(/\bname="([^"]+)"/);
    if (!nameM) continue;
    const name = nameM[1];
    const valueM = tag.match(/\bvalue="([^"]*)"/);
    const value = valueM ? decodeHtml_(valueM[1]) : '';
    const typeM = tag.match(/\btype="([^"]+)"/);
    const type = typeM ? typeM[1].toLowerCase() : 'text';

    if (type === 'radio' || type === 'checkbox') {
      // Only take value if 'checked' attribute is present
      if (/\bchecked\b/i.test(tag)) values[name] = value;
    } else if (type !== 'submit' && type !== 'button' && type !== 'image') {
      // For other input types, keep first occurrence
      if (!(name in values)) values[name] = value;
    }
  }

  // Textareas
  const taRe = /<textarea\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/gi;
  while ((m = taRe.exec(html)) !== null) {
    values[m[1]] = decodeHtml_(m[2]);
  }

  // Selects - find the selected option
  const selRe = /<select\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi;
  while ((m = selRe.exec(html)) !== null) {
    const optsHtml = m[2];
    let opt = optsHtml.match(/<option\b[^>]*\bselected\b[^>]*\bvalue="([^"]*)"/);
    if (!opt) opt = optsHtml.match(/<option\b[^>]*\bvalue="([^"]*)"[^>]*\bselected\b/);
    if (opt) values[m[1]] = decodeHtml_(opt[1]);
  }

  return values;
}

function decodeHtml_(s) {
  if (!s) return '';
  return s.toString()
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// ---------------------------------------------------------------------------
// Trigger management
// ---------------------------------------------------------------------------

function installHourlyTrigger() {
  // Remove existing triggers for autoWriteBackHourly
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'autoWriteBackHourly') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });

  ScriptApp.newTrigger('autoWriteBackHourly')
    .timeBased().everyHours(1).create();

  SpreadsheetApp.getUi().alert(
    'Hourly auto-push trigger installed.\n\n' +
    'Removed: ' + removed + ' existing trigger(s).\n' +
    'autoWriteBackHourly will run every hour.\n\n' +
    'To disable, use "Disable Hourly Auto-Push".');
}

function disableHourlyTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'autoWriteBackHourly') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  SpreadsheetApp.getUi().alert('Removed ' + removed + ' auto-push trigger(s).');
}

// ---------------------------------------------------------------------------
// Diagnostics: dump the edit-form field set for one donation_id
// ---------------------------------------------------------------------------
// Root-causes record-specific write-back failures (e.g. HTTP 500 / PDOException).
// GET-only by default: logs every field name+value we WOULD POST, flags blanks and
// unselected <select>s (the usual cause - an omitted/blank field hits a NOT NULL or
// typed DB column on save). PAN-shaped values are masked. No sheet writes.
// Pass doPost=true to also attempt the POST and capture dana's full response
// (still masked, still no sheet write) when you need the exact SQLSTATE/column.
function diagnoseDanaWriteBack(donationId, doPost) {
  const baseUrl = PropertiesService.getScriptProperties().getProperty('DANA_URL');
  const user    = PropertiesService.getScriptProperties().getProperty('DANA_USER');
  const pass    = _readProp('DANA_PASS');
  const cookie  = loginToDana_(baseUrl, user, pass, false);

  const editUrl = baseUrl + '/donation/edit/' + donationId;
  const getResp = UrlFetchApp.fetch(editUrl, {
    headers: { Cookie: cookie, 'User-Agent': DANA_USER_AGENT, 'Accept': 'text/html' },
    muteHttpExceptions: true
  });
  Logger.log('GET ' + editUrl + ' -> HTTP ' + getResp.getResponseCode());
  if (getResp.getResponseCode() !== 200) {
    Logger.log('Body: ' + sanitizeDanaError_(getResp.getContentText()));
    return { ok: false, stage: 'get', code: getResp.getResponseCode() };
  }

  const html = getResp.getContentText();
  const values = extractFormValues_(html);
  const names = Object.keys(values);
  Logger.log('Extracted ' + names.length + ' fields:');
  const blanks = [];
  names.sort().forEach(n => {
    const raw = (values[n] == null) ? '' : values[n].toString();
    const shown = maskPanInText_(raw).substring(0, 80);
    if (raw === '') blanks.push(n);
    Logger.log('  ' + n + ' = ' + (raw === '' ? '(EMPTY)' : '"' + shown + '"'));
  });

  // Flag <select>s present in the HTML but with no value extracted (no selected
  // option) - these get dropped from the POST and are the prime PDOException suspect.
  const selectNames = [];
  const selRe = /<select\b[^>]*\bname="([^"]+)"/gi;
  let sm;
  while ((sm = selRe.exec(html)) !== null) selectNames.push(sm[1]);
  const unselected = selectNames.filter(n => !(n in values) || values[n] === '');
  if (unselected.length) Logger.log('SELECTS WITH NO SELECTED OPTION (dropped from POST): ' + unselected.join(', '));
  if (blanks.length)     Logger.log('EMPTY FIELDS (submitted as ""): ' + blanks.join(', '));

  let post = null;
  if (doPost) {
    // Mirror the real write-back overrides, but DO NOT touch the sheet.
    const probe = postDonationEdit_(baseUrl, cookie, donationId, 'ABCDE1234F'); // dummy PAN, redacted in logs
    post = { code: probe.code, body: sanitizeDanaError_(probe.body) };
    Logger.log('POST probe -> HTTP ' + probe.code + ' :: ' + post.body);
    Logger.log('NOTE: probe used a DUMMY PAN and did not update the sheet. Re-run a real push to persist.');
  }

  return {
    ok: true, donationId: donationId, fieldCount: names.length,
    unselectedSelects: unselected, emptyFields: blanks, post: post
  };
}

// Menu wrapper: prompt for a donation_id and run the GET-only field dump.
function promptDiagnoseDanaWriteBack() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt('Diagnose write-back',
    'Enter the dana donation_id to inspect (e.g. 10592). Field values are logged to the Apps Script execution log; PAN is masked. No data is written.',
    ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const id = resp.getResponseText().trim();
  if (!/^\d+$/.test(id)) { ui.alert('Not a valid numeric donation_id.'); return; }
  try {
    const r = diagnoseDanaWriteBack(id, false);
    ui.alert('Diagnosis complete for donation_id ' + id + '.\n\n' +
      'Fields: ' + r.fieldCount + '\n' +
      'Unselected selects: ' + (r.unselectedSelects.length ? r.unselectedSelects.join(', ') : 'none') + '\n' +
      'Empty fields: ' + (r.emptyFields.length ? r.emptyFields.join(', ') : 'none') + '\n\n' +
      'See View > Execution log for the full field dump.');
  } catch (err) {
    ui.alert('Diagnosis failed: ' + err.message);
  }
}
