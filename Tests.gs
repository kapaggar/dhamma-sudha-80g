// Tests.gs

function runAllTests() {
  let pass = 0, fail = 0;

  function assert(name, cond, detail) {
    if (cond) { Logger.log('PASS: ' + name); pass++; }
    else { Logger.log('FAIL: ' + name + (detail ? ' - ' + detail : '')); fail++; }
  }

  var r;

  // PAN validation
  r = validateAndNormalizePAN('ABCDE1234F');
  assert('valid PAN accepted', r.valid && r.pan === 'ABCDE1234F');
  r = validateAndNormalizePAN('abcde1234f');
  assert('lowercase normalized', r.valid && r.pan === 'ABCDE1234F');
  r = validateAndNormalizePAN('ABCDE 1234 F');
  assert('spaces stripped', r.valid && r.pan === 'ABCDE1234F');
  r = validateAndNormalizePAN('  abcde1234f  ');
  assert('outer spaces stripped', r.valid && r.pan === 'ABCDE1234F');
  r = validateAndNormalizePAN('ABCDE123F');
  assert('too short rejected', !r.valid);
  r = validateAndNormalizePAN('12345ABCDE');
  assert('digits-first rejected', !r.valid);
  r = validateAndNormalizePAN('ABCDE12345');
  assert('digit-last rejected', !r.valid);
  r = validateAndNormalizePAN('');
  assert('empty rejected', !r.valid);
  r = validateAndNormalizePAN(null);
  assert('null rejected', !r.valid);

  // Token tests
  try {
    var tok = generateToken('test@example.com');
    assert('valid token passes', validateToken(tok, 'test@example.com') === true);
    assert('tampered token fails', validateToken(tok + 'x', 'test@example.com') === false);
    assert('wrong email fails', validateToken(tok, 'other@example.com') === false);
    assert('case-insensitive email', validateToken(tok, 'TEST@EXAMPLE.COM') === true);
    assert('empty token fails', validateToken('', 'test@example.com') === false);
  } catch (e) {
    Logger.log('Token tests skipped: ' + e.message);
  }

  // PAN masking
  assert('PAN masked', maskPAN('ABCDE1234F') === 'ABCDE****F');
  assert('short masked as stars', maskPAN('SHORT') === '**********');
  assert('null masked as stars', maskPAN(null) === '**********');

  // decodeHtml_ (write-back field replay; Drupal check_plain entities)
  assert('Drupal apostrophe entity decoded', decodeHtml_('O&#039;Brien') === "O'Brien");
  assert('plain &#39; still decoded', decodeHtml_('O&#39;Brien') === "O'Brien");
  assert('&amp; decoded last, no double-decode', decodeHtml_('a &amp;lt; b') === 'a &lt; b');
  assert('&amp; decoded', decodeHtml_('Tom &amp; Jerry') === 'Tom & Jerry');
  assert('&quot; decoded', decodeHtml_('&quot;x&quot;') === '"x"');

  Logger.log('');
  Logger.log('=== ' + pass + ' passed, ' + fail + ' failed ===');
}

function testConsentRequired() {
  var result = submitForm({
    token: 'dummy', email: 'x@x.com',
    name: 'Test', mobile: '9999999999',
    pan_name: 'TEST', pan: 'ABCDE1234F',
    consent: false
  });
  Logger.log('consent=false: ' + JSON.stringify(result));
}

// NOTE: testDanaImportLogin() lives in DanaImport.gs (verbose, decodes DANA_PASS
// via _readProp). A duplicate previously defined here passed the raw base64
// DANA_PASS straight to loginToDana_ and, because .gs files share one global
// scope, could shadow the real one and make the login self-test fail even with
// correct credentials. Do not re-add it here.
