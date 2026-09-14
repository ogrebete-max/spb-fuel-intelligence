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
flows a second time against D1 (`npm run d1`), the storage the worker is meant to run on,
and a third time the way the club's own server runs them (`npm run server`): through
`server/http.mjs` on a SQLite file, with no KV.

Worker checks without a browser: `node worker/run-tests.mjs` runs every suite on KV and on D1.

To walk through the club by hand, `npm run audit` serves the built site with an in-process
worker on two origins — `http://localhost:8971/` and `http://127.0.0.1:8973/` — so one browser
can be the owner on one and a member on the other (owner key `audit-owner-key`).
`?geo=lat,lon,accuracy` fakes the phone's place, `/__audit/gate?mode=closed|invite|test`
switches the stage, `/__audit/state` shows what the worker stores.

Screenshots land in `e2e/shots/`, which is not committed.
