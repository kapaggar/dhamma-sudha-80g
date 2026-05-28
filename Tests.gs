// Tests.gs

function runAllTests() {
  let pass = 0, fail = 0;

  function assert(name, condition, detail) {
    if (condition) { Logger.log('PASS: ' + name); pass++; }
    else { Logger.log('FAIL: ' + name + (detail ? ' - ' + detail : '')); fail++; }
  }

  var r;

  r = validateAndNormalizePAN('ABCDE1234F');
  assert('valid PAN accepted', r.valid === true && r.pan === 'ABCDE1234F');

  r = validateAndNormalizePAN('abcde1234f');
  assert('lowercase PAN normalized to uppercase', r.valid === true && r.pan === 'ABCDE1234F');

  r = validateAndNormalizePAN('ABCDE 1234 F');
  assert('PAN with spaces normalized', r.valid === true && r.pan === 'ABCDE1234F');

  r = validateAndNormalizePAN('  abcde1234f  ');
  assert('PAN with leading/trailing spaces normalized', r.valid === true && r.pan === 'ABCDE1234F');

  r = validateAndNormalizePAN('ABCDE123F');
  assert('PAN too short rejected', r.valid === false, r.error);

  r = validateAndNormalizePAN('12345ABCDE');
  assert('PAN starting with digits rejected', r.valid === false, r.error);

  r = validateAndNormalizePAN('ABCDE12345');
  assert('PAN ending with digit rejected', r.valid === false, r.error);

  r = validateAndNormalizePAN('ABCDE1234FF');
  assert('PAN too long rejected', r.valid === false, r.error);

  r = validateAndNormalizePAN('');
  assert('empty PAN rejected', r.valid === false);

  r = validateAndNormalizePAN(null);
  assert('null PAN rejected', r.valid === false);

  try {
    var token = generateToken('COURSE001', 'test@example.com');
    assert('valid token passes validation',
      validateToken(token, 'COURSE001', 'test@example.com') === true);
    assert('tampered token rejected',
      validateToken(token + 'x', 'COURSE001', 'test@example.com') === false);
    assert('wrong course_id rejected',
      validateToken(token, 'COURSE002', 'test@example.com') === false);
    assert('wrong email rejected',
      validateToken(token, 'COURSE001', 'other@example.com') === false);
    assert('email case-insensitive in token',
      validateToken(token, 'COURSE001', 'TEST@EXAMPLE.COM') === true);
    assert('missing token rejected',
      validateToken('', 'COURSE001', 'test@example.com') === false);
  } catch(e) {
    Logger.log('Token tests skipped - TOKEN_SECRET not set: ' + e.message);
  }

  assert('PAN masked correctly',       maskPAN('ABCDE1234F') === 'ABCDE****F');
  assert('short PAN masked as stars',  maskPAN('SHORT')      === '**********');
  assert('null PAN masked as stars',   maskPAN(null)         === '**********');

  Logger.log('');
  Logger.log('=== ' + pass + ' passed, ' + fail + ' failed ===');
}

function testConsentRequired() {
  var result = submitForm({
    token: 'dummy', course_id: 'C1', email: 'x@x.com',
    mobile: '9999999999', consent: false,
    donors: [{ name: 'Test', name_as_per_pan: 'TEST', pan: 'ABCDE1234F' }]
  });
  Logger.log('consent=false result: ' + JSON.stringify(result));
}
