// Preview only: no Google credentials, Sheets access, or outbound requests.
// Run: node tests/preview.cjs; open http://127.0.0.1:8787
const http = require('node:http');
const { render, fixture } = require('./render.cjs');

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8787');
  let html;
  if (url.pathname === '/import') html = render('ImportDialog', { defaultStart: '2026-09-01', defaultEnd: '2026-09-12', lastImport: '01 Sep 2026' });
  else if (url.pathname === '/upload') html = render('UploadDialog', {});
  else if (url.pathname === '/invalid') html = render('Message', { centerName: fixture().centerName, title: 'Invalid link', message: 'Please open the original personal link from your email.' });
  else html = render('Form', fixture(url.searchParams.get('state')));
  const requestedOutcome = url.searchParams.get('outcome');
  const outcome = ['failure', 'empty'].includes(requestedOutcome) ? requestedOutcome : 'success';
  const bridge = `<script>
    window.previewCalls = 0;
    window.google = { script: { host: { close: function() { document.body.textContent = 'Preview closed. Refresh to start again.'; } }, run: {
      withSuccessHandler: function(fn) { this.success = fn; return this; },
      withFailureHandler: function(fn) { this.failure = fn; return this; },
      finish: function() {
        window.previewCalls++;
        var self = this;
        setTimeout(function() {
          var outcome = ${JSON.stringify(outcome)};
          if (outcome === 'failure') self.failure({message:'Preview: connection interrupted. Please retry.'});
          else if (outcome === 'empty') self.success(null);
          else self.success({success:true,count:2,startDate:'2026-09-01',endDate:'2026-09-12',result:{total:8,added:5,skipped:3,needPan:2,havePan:2,autoFilled:1,noEmail:0}});
        }, 800);
      },
      submitForm: function() { this.finish(); },
      runImportFromDialog: function() { this.finish(); },
      runUploadImport: function() { this.finish(); }
    } } };
  </script>`;
  html = html.replace('</head>', bridge + '</head>');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}).listen(8787, '127.0.0.1', () => console.log('Synthetic UI preview: http://127.0.0.1:8787 (also /import, /upload, /invalid)'));
