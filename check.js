// Checks a list of Amul shop products for one pincode and sends an ntfy alert
// to each item's own topic when a product flips from sold out to in stock.
//
// Products live in items.json. Each item names the repo secret holding its
// ntfy topic, so topic names never appear in the repo.
//
// Env vars:
//   PINCODE       delivery pincode to check (required)
//   <topicSecret> one env var per item, named by its topicSecret in items.json (required)
//   NTFY_SERVER   ntfy server (optional, defaults to https://ntfy.sh)
//   TEST_NOTIFY   "true" sends a test notification to every topic

import { chromium } from 'playwright';
import fs from 'node:fs';

const PINCODE = (process.env.PINCODE || '').trim();
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const TEST_NOTIFY = process.env.TEST_NOTIFY === 'true';
const STATE_FILE = 'state.json';
const BASE = 'https://shop.amul.com/en/product/';

if (!/^\d{6}$/.test(PINCODE)) throw new Error('PINCODE must be a 6-digit pincode');

const items = JSON.parse(fs.readFileSync('items.json', 'utf8'));

// Resolve every topic up front so a missing secret fails loudly.
for (const item of items) {
  item.topic = (process.env[item.topicSecret] || '').trim();
  if (!item.topic) throw new Error(`Secret ${item.topicSecret} is not set (item "${item.label}")`);
}

async function notify(topic, title, message, clickUrl, priority = 'high') {
  const headers = { Title: title, Priority: priority, Tags: 'milk_glass' };
  if (clickUrl) headers.Click = clickUrl;
  const res = await fetch(`${NTFY_SERVER}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers,
    body: message,
  });
  if (!res.ok) throw new Error(`ntfy returned ${res.status}`);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function setPincode(page) {
  const input = page.locator('#locationWidgetModal input#search');
  // On a fresh session the pincode dialog normally opens by itself.
  // If it does not, open it from the header.
  try {
    await input.waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    await page.locator('.location_pin_wrap').first().click();
    await input.waitFor({ state: 'visible', timeout: 15000 });
  }
  await input.click();
  await input.pressSequentially(PINCODE, { delay: 120 });
  const suggestion = page
    .locator('#automatic .searchitem-name')
    .filter({ hasText: PINCODE })
    .first();
  await suggestion.waitFor({ state: 'visible', timeout: 15000 });
  await suggestion.click();
  await page
    .locator('#locationWidgetModal')
    .waitFor({ state: 'hidden', timeout: 20000 })
    .catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
}

async function readStock(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const addBtn = page.locator('a.add-to-cart').first();
  await addBtn.waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

  const headerText = await page.locator('.location_pin_wrap').first().innerText();
  if (!headerText.includes(PINCODE)) {
    throw new Error(`Pincode not applied, header shows "${headerText.trim()}"`);
  }

  const name = (await page.locator('h1').first().innerText().catch(() => 'Amul product')).trim();
  const soldOut = await page
    .locator('.alert-danger')
    .filter({ hasText: /sold out/i })
    .first()
    .isVisible()
    .catch(() => false);
  const disabled = await addBtn.getAttribute('disabled');
  const addEnabled = disabled === null || disabled === 'false';

  if (soldOut && !addEnabled) return { name, status: 'sold_out' };
  if (!soldOut && addEnabled) return { name, status: 'in_stock' };
  throw new Error(`Ambiguous page state (soldOut=${soldOut}, addEnabled=${addEnabled})`);
}

async function main() {
  if (TEST_NOTIFY) {
    for (const item of items) {
      await notify(
        item.topic,
        `Amul alert test: ${item.label}`,
        `Test notification, alerts for ${item.label} will arrive here.`,
        null,
        'default'
      );
    }
    console.log(`Test notification sent to ${items.length} topic(s)`);
  }

  const state = readState();
  const failures = [];

  const browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();

  try {
    await page.goto(BASE + items[0].products[0], { waitUntil: 'domcontentloaded', timeout: 60000 });
    await setPincode(page);

    for (const item of items) {
      for (const alias of item.products) {
        const url = BASE + alias;
        try {
          const { name, status } = await readStock(page, url);
          const previous = state[alias]?.status;
          console.log(`[${item.label}] ${name}: ${status} (previous: ${previous || 'none'})`);
          if (status === 'in_stock' && previous !== 'in_stock') {
            await notify(
              item.topic,
              'Amul: back in stock',
              `${name} is available for ${PINCODE}. Tap to open.`,
              url
            );
            console.log(`[${item.label}] alert sent`);
          }
          state[alias] = { status, checkedAt: new Date().toISOString() };
        } catch (err) {
          failures.push(`${alias}: ${err.message}`);
          console.error(`[${item.label}] ${alias} failed: ${err.message}`);
          await page.screenshot({ path: `debug-${alias}.png`, fullPage: true }).catch(() => {});
        }
      }
    }
  } catch (err) {
    await page.screenshot({ path: 'debug-setup.png', fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }

  if (failures.length) throw new Error(`${failures.length} product check(s) failed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
