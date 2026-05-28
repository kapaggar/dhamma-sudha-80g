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
          c.receiptNo, '', '', err.message.substring(0, 200), c.donationId);
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
  const editUrl = baseUrl + '/donation/edit/' + donationId;

  // GET current form
  const getResp = UrlFetchApp.fetch(editUrl, {
    headers: {
      Cookie: sessionCookie,
      'User-Agent': DANA_USER_AGENT,
      'Accept': 'text/html'
    },
    muteHttpExceptions: true
  });
  if (getResp.getResponseCode() !== 200) {
    throw new Error('GET edit form HTTP ' + getResp.getResponseCode());
  }
  const html = getResp.getContentText();
  const cookie2 = extractCookies_(getResp, sessionCookie);

  // Extract all current form values
  const values = extractFormValues_(html);
  if (!values.form_build_id || !values.form_token) {
    throw new Error('Could not extract form tokens from edit page');
  }

  // Override id_type and id_no with PAN
  values.d_id_type = DANA_ID_TYPE_PAN;
  values.d_id_no = newPan;
  values.form_id = 'donation_main_form';

  // Do NOT trigger another email/whatsapp confirmation to the donor
  // (they already got their original receipt; we're just changing the ID type)
  values.email = '0';
  values.whatsapp = '0';

  // POST the edit
  const postResp = UrlFetchApp.fetch(editUrl, {
    method: 'post',
    payload: values,
    headers: {
      Cookie: cookie2,
      'User-Agent': DANA_USER_AGENT,
      'Referer': editUrl
    },
    followRedirects: false,
    muteHttpExceptions: true
  });

  const code = postResp.getResponseCode();
  if (code !== 302) {
    Logger.log('Edit POST HTTP ' + code);
    Logger.log('Body: ' + postResp.getContentText().substring(0, 500));
    throw new Error('Edit POST HTTP ' + code + ' (expected 302 redirect)');
  }
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
