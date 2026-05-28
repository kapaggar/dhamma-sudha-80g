# dhamma-sudha-80g (v2 - dana portal integration)

Automated 80G certificate workflow with dana portal integration.

## Files

| File | Purpose |
|------|---------|
| `Code.gs` | Web app, form handler, sheet init |
| `Utils.gs` | Tokens, PAN validation, audit log |
| `Email.gs` | Send emails grouped by donor, reminders |
| `Admin.gs` | Spreadsheet menu, admin review, exports |
| `DanaImport.gs` | Dana portal login, fetch, parse, import |
| `Tests.gs` | Unit tests |
| `Form.html` | Donor PAN submission form |
| `appsscript.json` | Manifest (with Drive API enabled) |

## Schema (v2)

### donors_input (24 columns)
1 row per dana transaction. Auto-populated from dana XLS imports.

| # | Column | Notes |
|---|--------|-------|
| A | receipt_no | Primary key |
| B | txn_date | |
| C | created_on | |
| D | full_name | |
| E | email | |
| F | mobile | |
| G-J | address, city, state, country | |
| K-M | course, category, txn_type | |
| N | payment_mode | Cash/Cheque/Razorpay/UPI etc |
| O | amount | Sum of payment columns |
| P | merchant_ref | |
| Q | id_type | PAN / Aadhaar / Passport / blank |
| R | id_value | Actual ID value |
| S | pan_collected | Filled from form OR copied from id_value if id_type=PAN |
| T | pan_name | Name as per PAN (from form) |
| U | pan_status | `need_pan` / `have_pan` / `no_email` |
| V | comment | |
| W | imported_at | |
| X | pan_submitted_at | |

### Flow

1. **Import** - 80G Admin > Import from Dana Portal
   - Logs into dana, fetches XLS, parses, dedupes by receipt_no
   - Auto-fills PAN for repeat donors (same email)
2. **Email** - 80G Admin > Send PAN Request Emails
   - One email per donor (grouped by email), lists all pending receipts
3. **Donor submits** - one PAN applies to all their pending receipts
4. **Export** - 80G Admin > Export Ready for 80G
   - All have_pan rows, full PAN visible

## Script Properties

| Property | Value |
|----------|-------|
| `SHEET_ID` | Google Spreadsheet ID |
| `TOKEN_SECRET` | HMAC secret |
| `CENTER_NAME` | Display name |
| `WEB_APP_URL` | Deployed web app URL |
| `DANA_URL` | `https://sudha.dana.vridhamma.org` |
| `DANA_USER` | Dana portal username |
| `DANA_PASS` | Dana portal password |

## Advanced services required

Drive API (v2) must be enabled in Apps Script:
- Open Apps Script editor
- Click Services (+ icon in left sidebar)
- Add Drive API, version v2

## Security

- PAN never sent over email
- Tokens HMAC-SHA256 signed
- Admin views show masked PAN (ABCDE****F)
- Full PAN only in `ready_for_80g` export
- All actions logged to `audit_log`
- Dana credentials in Script Properties (Google encrypted at rest)
