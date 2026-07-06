# PhyFit Report Receiver

Static mobile report receiver for PhyFit-QT dynamic QR report transfer.

## What It Does

- Scans `PFRT1` QR frames from the PhyFit-QT report transfer screen.
- Verifies checksums, collects missing frames, and decodes the Qt `qCompress()` payload.
- Renders the training report on the phone.
- Copies report text and downloads raw JSON.
- Exports a recoverable PNG report card with embedded `pfRt` archive data.
- Imports an original exported PNG to restore the full report.

All report data is handled locally in the browser. No report payload is uploaded.

## Cloudflare Pages

Use these settings:

- Framework preset: `None`
- Build command: leave empty
- Build output directory: `/`

The site entrypoint is `index.html`.

## Local Check

```bash
node --check app.js
node --check protocol_test.js
node protocol_test.js
```

For camera scanning, serve the directory over HTTPS or use a browser/device setup
that allows camera access for localhost.
