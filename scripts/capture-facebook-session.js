import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ locale: 'en-US' });
const page = await context.newPage();

console.log('A browser window has opened.');
console.log('1) Log in to Facebook manually.');
console.log('2) Complete any 2FA/security checks yourself.');
console.log('3) When your Facebook home page is fully loaded, return to this terminal and press Enter.');

await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

const rl = readline.createInterface({ input, output });
await rl.question('\nPress Enter after you are fully logged in... ');
rl.close();

if (/login|checkpoint/i.test(page.url())) {
  console.error('Facebook still appears to be on a login/checkpoint page. Nothing was saved.');
  await browser.close();
  process.exit(1);
}

const state = await context.storageState();
const json = JSON.stringify(state);
const b64 = Buffer.from(json, 'utf8').toString('base64');

fs.writeFileSync('facebook-state.json', JSON.stringify(state, null, 2));
fs.writeFileSync('facebook-state.b64', b64);

console.log('\nSaved locally:');
console.log('  facebook-state.json');
console.log('  facebook-state.b64');
console.log('\nKeep both files private. Put ONLY the contents of facebook-state.b64 into the GitHub secret FACEBOOK_STORAGE_STATE_B64.');
console.log('Do not commit either file to GitHub and do not send them in chat.');

await browser.close();
