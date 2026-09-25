// Address of the club's server. Marks made at the pump are shared through it,
// so everyone in the group sees what one of them saw. It is a server of our
// own in Moscow, reached by its IP address, because phones in Russia no longer
// reach Cloudflare: docs/club-server.md. What it does and does not collect:
// docs/eyewitness-reports.md
window.SPBFI_REPORT_ENDPOINT = 'https://195.133.61.136';
// First-party, aggregate product and forecast-quality analytics. The same
// Worker accepts events; no advertising SDK or third-party tracker is loaded.
window.SPBFI_ANALYTICS_ENDPOINT = window.SPBFI_REPORT_ENDPOINT;
// The work log (web/log.js) and «Сообщить о проблеме»: the club's server
// passes /applog/* to the owner's log receiver (server/Caddyfile). What is
// recorded and how to switch it off: docs/work-log.md
window.SPBFI_LOG_ENDPOINT = window.SPBFI_REPORT_ENDPOINT;
