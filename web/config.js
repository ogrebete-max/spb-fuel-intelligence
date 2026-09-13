// Address of the reports Worker. Marks made at the pump are shared through it,
// so everyone in the group sees what one of them saw. Setup and what it does
// and does not collect: docs/eyewitness-reports.md
window.SPBFI_REPORT_ENDPOINT = 'https://spbfi-reports.ogrebete.workers.dev';
// First-party, aggregate product and forecast-quality analytics. The same
// Worker accepts events; no advertising SDK or third-party tracker is loaded.
window.SPBFI_ANALYTICS_ENDPOINT = window.SPBFI_REPORT_ENDPOINT;
