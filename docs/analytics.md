# Usage analytics

Usage analytics is mandatory for the deployed application, but must not turn
fuel searches into personal tracking.

## What the owner sees

- privacy-preserving visitors and page views;
- installations of the web app;
- searches near a place, opening the map, and refresh success/failure;
- aggregate demand only for `spb`, `lo`, and `spb_lo`.

Exact address text, GPS coordinates, IP addresses and advertising identifiers
are not product analytics fields.

## Free deployment

Cloudflare Pages Web Analytics is the default for visitors/page views. It is
enabled from the Pages dashboard and is privacy-first. Product events will be
sent to a small Cloudflare Worker and stored as daily aggregates in D1 or
Analytics Engine. This avoids a paid third-party analytics service and gives a
clear capacity signal before any plan change.

For 10–20 users the free tier has ample capacity. Review the dashboard weekly:
daily unique visitors, searches per visitor, refresh failure rate, and Worker
requests. Do not automatically upgrade; only do so from measured use.
