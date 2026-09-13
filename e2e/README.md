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

Screenshots land in `e2e/shots/`, which is not committed.
