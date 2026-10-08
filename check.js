// Checks one Amul shop product for a given pincode and sends an ntfy alert
// when it flips from sold out to in stock.
//
// Env vars:
//   PINCODE      delivery pincode to check (required)
//   NTFY_TOPIC   ntfy topic name (required)
//   PRODUCT_URL  product page (optional, defaults to High Protein Rose Lassi)
//   NTFY_SERVER  ntfy server (optional, defaults to https://ntfy.sh)
//   TEST_NOTIFY  "true" sends a test notification regardless of stock

import { chromium } from 'playwright';
import fs from 'node:fs';

const PINCODE = (process.env.PINCODE || '').trim();
const NTFY_TOPIC = (process.env.NTFY_TOPIC || '').trim();
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const PRODUCT_URL =
  process.env.PRODUCT_URL ||
  'https://shop.amul.com/en/product/amul-high-protein-rose-lassi-200-ml-or-pack-of-30';
const TEST_NOTIFY = process.env.TEST_NOTIFY === 'true';
const STATE_FILE = 'state.json';

if (!/^\d{6}$/.test(PINCODE)) throw new Error('PINCODE must be a 6-digit pincode');
if (!NTFY_TOPIC) throw new Error('NTFY_TOPIC is not set');

async function notify(title, message, priority = 'high') {
  const res = await fetch(`${NTFY_SERVER}/${encodeURIComponent(NTFY_TOPIC)}`, {
    method: 'POST',
    headers: { Title: title, Priority: priority, Tags: 'milk_glass', Click: PRODUCT_URL },
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

async function readStock(page) {
  await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
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
    await notify('Amul alert test', 'Test notification, the alert pipeline works.', 'default');
    console.log('Test notification sent');
  }

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
    await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await setPincode(page);
    const { name, status } = await readStock(page);

    const previous = readState().status;
    console.log(`${name}: ${status} (previous: ${previous || 'none'}) for ${PINCODE}`);

    if (status === 'in_stock' && previous !== 'in_stock') {
      await notify('Amul: back in stock', `${name} is available for ${PINCODE}. Tap to open.`);
      console.log('Alert sent');
    }
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ status, checkedAt: new Date().toISOString() }, null, 2)
    );
  } catch (err) {
    await page.screenshot({ path: 'debug.png', fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
