import { webkit, chromium, devices } from 'playwright';
const url = 'https://ogrebete-max.github.io/spb-fuel-intelligence/';
for (const [label, type, device] of [['iPhone 13 / WebKit', webkit, devices['iPhone 13']], ['Pixel 7 / Chromium', chromium, devices['Pixel 7']]]) {
  const browser = await type.launch();
  const context = await browser.newContext({ ...device });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.station-card', { timeout: 60000 });
  await page.waitForTimeout(5000);
  const info = await page.evaluate(() => ({
    build: window.SPBFI_BUILD,
    gate: !document.querySelector('#clubGate').hidden,
    clubEnabled: state.club.enabled,
    cards: document.querySelectorAll('.station-card').length,
    feed: !!document.querySelector('#groupFeed').textContent.trim(),
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }));
  console.log(label, JSON.stringify(info), 'page errors:', errors.length, errors.slice(0, 2).join(' | '));
  await browser.close();
}
