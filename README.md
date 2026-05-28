# dhamma-sudha-80g

Google Apps Script system for collecting donor PAN details for 80G donation certificates.

## Files

| File | Purpose |
|------|---------|
| `Code.gs` | Web app entry point, form submission handler, sheet init |
| `Utils.gs` | Token generation/validation, PAN normalize/validate, audit log |
| `Email.gs` | Send initial emails, send reminders |
| `Admin.gs` | Spreadsheet menu, admin review, export, merge to master |
| `Tests.gs` | Unit tests for PAN validation and token logic |
| `Form.html` | Donor-facing PAN submission form |
| `appsscript.json` | Apps Script project manifest |

## Setup

See the full setup guide in the project documentation.

## Script Properties Required

| Property | Description |
|----------|-------------|
| `SHEET_ID` | Google Spreadsheet ID |
| `TOKEN_SECRET` | HMAC secret - generate with `openssl rand -hex 32` |
| `CENTER_NAME` | Center display name |
| `WEB_APP_URL` | Deployed web app URL (set after first deploy) |

## Workflow

1. Add donors to `donors_input` sheet
2. Run **80G Admin > Send Emails for Course**
3. Donors submit via personalized link
4. Run **80G Admin > Refresh Admin Review** to see categorized submissions
5. Run **80G Admin > Export Validated for Merge**
6. Run **80G Admin > Merge to Master**
7. Download master sheet for certificate generation

## Security Notes

- PAN never sent over email
- Tokens are HMAC-SHA256 signed
- `TOKEN_SECRET` stored only in Script Properties, never in code
- Admin sheet shows masked PAN (ABCDE****F)
- All actions logged to `audit_log` sheet
