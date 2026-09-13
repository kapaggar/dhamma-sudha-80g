const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { render, fixture } = require('./render.cjs');
const { harness, donor } = require('./helpers.cjs');

function client(name, data = {}) {
  const html = render(name, data);
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const tag = match[0];
    const el = {
      value: tag.match(/\bvalue="([^"]*)"/)?.[1] || '',
      hidden: /\bhidden\b/.test(tag), disabled: false, checked: false,
      validity: { valid: true }, textContent: '', attributes: {}, listeners: {},
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(key, fn) { this.listeners[key] = fn; },
      focus() { document.activeElement = this; }
    };
    elements.set(match[1], el);
  }
  const document = { activeElement: null, getElementById: id => elements.get(id) || null };
  const requests = [];
  const rpc = {
    withSuccessHandler(fn) { this.success = fn; return this; },
    withFailureHandler(fn) { this.failure = fn; return this; },
    submitForm(data) { requests.push(data); },
    runImportFromDialog(start, end) { requests.push({ start, end }); },
    runUploadImport(data, filename) { requests.push({ data, filename }); }
  };
  const context = vm.createContext({ document, google: { script: { run: rpc, host: { close() {} } } } });
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(script[1], context);
  return { html, context, document, el: id => elements.get(id), rpc, requests };
}

test('donor form validates locally and focuses the field needing attention', () => {
  const c = client('Form', fixture());
  c.context.handleSubmit();
  assert.equal(c.requests.length, 0);
  assert.equal(c.document.activeElement, c.el('f_pan'));
  c.el('f_pan').value = 'abcde 1234 f';
  c.context.handleSubmit();
  assert.equal(c.el('f_pan').value, 'ABCDE1234F');
  assert.equal(c.document.activeElement, c.el('f_consent'));
  assert.equal(c.requests.length, 0);
});

test('donor submission prevents duplicate requests and clears PAN after success', () => {
  const c = client('Form', fixture());
  c.el('f_pan').value = 'ABCDE1234F';
  c.el('f_consent').checked = true;
  let prevented = false;
  c.el('panForm').listeners.submit({ preventDefault() { prevented = true; } });
  c.context.handleSubmit();
  assert.equal(prevented, true);
  assert.equal(c.requests.length, 1);
  assert.equal(c.el('submitBtn').disabled, true);
  assert.equal(c.el('f_pan').disabled, true);
  c.rpc.success({ success: true, count: 2 });
  assert.equal(c.el('f_pan').value, '');
  assert.equal(c.el('panForm').hidden, true);
  assert.equal(c.el('successPanel').hidden, false);
  assert.equal(c.document.activeElement, c.el('successPanel'));
  assert.match(c.el('successText').textContent, /2 donations/);
});

for (const outcome of ['empty', 'rejected', 'network', 'bridge']) {
  test(`donor form recovers from ${outcome} response`, () => {
    const c = client('Form', fixture());
    c.el('f_pan').value = 'ABCDE1234F';
    c.el('f_consent').checked = true;
    if (outcome === 'bridge') delete c.context.google;
    c.context.handleSubmit();
    if (outcome === 'empty') c.rpc.success(null);
    if (outcome === 'rejected') c.rpc.success({ success: false, error: 'Please retry.' });
    if (outcome === 'network') c.rpc.failure({ message: 'Internal server details' });
    assert.equal(c.el('submitBtn').disabled, false);
    assert.equal(c.el('f_pan').disabled, false);
    assert.equal(c.el('alertBox').hidden, false);
    assert.equal(c.el('f_pan').value, 'ABCDE1234F');
    assert.ok(!c.el('alertBox').textContent.includes('Internal server details'));
  });
}

test('completed and empty form pages load without input handlers', () => {
  for (const state of ['received', 'empty']) {
    const c = client('Form', fixture(state));
    assert.equal(c.el('panForm'), undefined);
    assert.equal(c.requests.length, 0);
  }
});

test('donor identity cannot break out of the script or its HTML context', () => {
  const c = client('Form', { ...fixture(), email: '</script><script>throw Error("injected")</script>', donorName: '<img src=x onerror=alert(1)>' });
  assert.ok(!c.html.includes('<img src=x'));
  assert.equal(c.context.EMAIL, '</script><script>throw Error("injected")</script>');
});

test('import dialog prevents duplicate imports and permits retry after failure', () => {
  const c = client('ImportDialog', { defaultStart: '2026-09-01', defaultEnd: '2026-09-12', lastImport: 'never' });
  c.context.runImport();
  c.context.runImport();
  assert.equal(c.requests.length, 1);
  assert.equal(c.el('start').disabled, true);
  assert.equal(c.el('cancelBtn').disabled, true);
  c.rpc.success(null);
  assert.equal(c.el('start').disabled, false);
  assert.equal(c.el('goBtn').disabled, false);
  c.context.runImport();
  assert.equal(c.requests.length, 2);
});

test('upload rejects empty, oversized and unsupported files on the client', () => {
  const c = client('UploadDialog');
  for (const file of [{ name: 'test.txt', size: 1 }, { name: 'test.xls', size: 0 }, { name: 'test.xlsx', size: 10485761 }]) {
    c.el('file').files = [file];
    c.context.runImport();
    assert.equal(c.el('status').className, 'status err');
    assert.equal(c.requests.length, 0);
    assert.equal(c.el('goBtn').disabled, false);
  }
});

test('upload handles an interrupted file read without leaving controls disabled', () => {
  const c = client('UploadDialog');
  c.el('file').files = [{ name: 'test.xlsx', size: 12 }];
  c.context.FileReader = class { readAsDataURL() { this.onabort(); } };
  c.context.runImport();
  assert.equal(c.el('goBtn').disabled, false);
  assert.equal(c.el('file').disabled, false);
  assert.equal(c.el('status').className, 'status err');
});

test('web app declares mobile viewport and does not call a no-email record submitted', () => {
  const h = harness({ donors: [donor({ 20: 'no_email' })] });
  const meta = {};
  let template;
  h.context.HtmlService = {
    createTemplateFromFile() {
      template = { evaluate: () => ({ setTitle() { return this; }, addMetaTag(k, v) { meta[k] = v; return this; } }) };
      return template;
    }
  };
  const email = 'sample@example.invalid';
  h.context.doGet({ parameter: { email, token: h.context.generateToken_(email) } });
  assert.equal(template.alreadySubmitted, false);
  assert.equal(meta.viewport, 'width=device-width, initial-scale=1');
  h.context.doGet();
});
