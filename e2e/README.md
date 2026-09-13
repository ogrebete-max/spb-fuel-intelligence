# Browser checks

Each script starts the built site and an in-process copy of `worker/spbfi-reports.js`
on localhost, then drives WebKit (iPhone) and Chromium (Android or a laptop).
`live-open.mjs` opens the published site instead.

```bash
python scripts/build_static_site.py --output site
cd e2e
npm install
npx playwright install webkit chromium
npm run all
```

`npm run all` also drives a mark made without signal (`outbox-ui.mjs`) and runs the club
flows a second time against D1 (`npm run d1`), the storage the worker is meant to run on.

Worker checks without a browser: `node worker/run-tests.mjs` runs every suite on KV and on D1.

Screenshots land in `e2e/shots/`, which is not committed.
