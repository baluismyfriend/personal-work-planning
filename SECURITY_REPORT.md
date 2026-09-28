# Security test report - Participant: Spaces & Time

Result: 45 passed, 0 failed (run: `npm i jsdom && node security-tests.js`, edit `dir` at top to point at the app folder)

## Static checks
- CSP: default-src 'self', connect-src 'none', object-src 'none', frame-ancestors 'none', no unsafe-inline / unsafe-eval in script-src or style-src
- No external URLs in HTML/CSS/JS/manifest; no fetch/XHR/WebSocket/beacon; no cookies, window.open, location writes
- No eval / new Function / document.write / innerHTML / outerHTML / insertAdjacentHTML / string timers
- No inline scripts, inline event handlers, or inline style attributes in index.html
- Manifest is local-scoped; all icons present

## Runtime checks
- XSS payloads (script, img onerror, svg onload, javascript:, template injection) stored in every page render as inert text
- Corrupt / malformed localStorage (7 variants) does not break the app
- Bad imports (non-JSON, null, number, string, 50k-deep nesting bomb, >2MB file) rejected without touching saved data
- __proto__ / constructor keys in imports cannot pollute Object.prototype
- Row cap (5000), cell cap (5000 chars), control characters stripped on import
- CSV export neutralizes formula injection (= + - @)
- Counter labels ("Time N of M") verified

## Issue found and fixed
Summary page used a plain object keyed by Space name. A Space named "__proto__", "constructor", "toString" or "hasOwnProperty" made that Space disappear/misbehave in Summary. Fixed with prototype-less maps (Object.create(null)). Confirmed the test failed on your original file and passes now.

## Notes / limits
- Data lives unencrypted in the device's localStorage (standard for a local PWA; protected by the iPhone passcode/sandbox). Exported JSON backups are plain text - store them somewhere safe.
- Tests run in jsdom, not on a real iPhone; the CSP is enforced by Safari itself, which jsdom does not emulate.
