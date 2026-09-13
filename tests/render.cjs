// Local rendering of Apps Script templates with synthetic fixtures only.
const fs = require('node:fs');
const path = require('node:path');
const { root } = require('./helpers.cjs');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render(name, data) {
  const source = fs.readFileSync(path.join(root, name + '.html'), 'utf8');
  let code = 'let out = "";\n', offset = 0;
  for (const match of source.matchAll(/<\?( !=|!=|=)?([\s\S]*?)\?>/g)) {
    code += `out += ${JSON.stringify(source.slice(offset, match.index))};\n`;
    code += match[1] ? `out += ${match[1].trim() === '!=' ? '(' : 'escapeHtml('}${match[2]});\n` : match[2] + '\n';
    offset = match.index + match[0].length;
  }
  code += `out += ${JSON.stringify(source.slice(offset))}; return out;`;
  const HtmlService = { createHtmlOutputFromFile: file => ({ getContent: () => fs.readFileSync(path.join(root, file + '.html'), 'utf8') }) };
  return new Function(...Object.keys(data), 'HtmlService', 'escapeHtml', code)(...Object.values(data), HtmlService, escapeHtml);
}

function fixture(state = 'pending') {
  return {
    email: 'sample.donor@example.invalid', token: 'synthetic-preview-token', donorName: 'Sample Donor', mobile: '',
    centerName: 'Dhamma Sudha Vipassana Centre', alreadySubmitted: state === 'received',
    pendingReceipts: state === 'empty' ? [] : [
      { receiptNo: 'DEMO-001', txnDate: '01 Sep 2026', amount: 2500 },
      { receiptNo: 'DEMO-002', txnDate: '08 Sep 2026', amount: 1500 }
    ]
  };
}

module.exports = { render, fixture };
