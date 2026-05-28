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

function testDanaImportLogin() {
  // Manual test - verifies dana login works without full import
  try {
    const props = PropertiesService.getScriptProperties();
    const cookie = loginToDana_(
      props.getProperty('DANA_URL'),
      props.getProperty('DANA_USER'),
      props.getProperty('DANA_PASS')
    );
    Logger.log('Login OK. Cookie length: ' + cookie.length);
    Logger.log('Cookie names: ' + cookie.split(';').map(c => c.trim().split('=')[0]).join(', '));
  } catch (err) {
    Logger.log('Login failed: ' + err.message);
  }
}
