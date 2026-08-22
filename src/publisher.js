import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import { chromium } from 'playwright';

const required = ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GDRIVE_FOLDER_ID', 'FACEBOOK_STORAGE_STATE_B64'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

const statePath = path.resolve('state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const posted = new Set(state.postedFileIds || []);

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});
const drive = google.drive({ version: 'v3', auth });

const res = await drive.files.list({
  q: `'${process.env.GDRIVE_FOLDER_ID}' in parents and trashed = false`,
  fields: 'files(id,name,mimeType,createdTime)',
  orderBy: 'name',
  pageSize: 1000,
});

const videos = (res.data.files || []).filter(f =>
  f.id && f.name && (f.mimeType?.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(f.name))
);
const next = videos.find(f => !posted.has(f.id));
if (!next) {
  console.log('No unpublished videos found.');
  process.exit(0);
}

console.log(`Next video: ${next.name}`);
const tmpDir = path.resolve('.tmp');
fs.mkdirSync(tmpDir, { recursive: true });
const videoPath = path.join(tmpDir, next.name.replace(/[\\/:*?"<>|]/g, '_'));

const out = fs.createWriteStream(videoPath);
const download = await drive.files.get({ fileId: next.id, alt: 'media' }, { responseType: 'stream' });
await new Promise((resolve, reject) => {
  download.data.pipe(out);
  download.data.on('error', reject);
  out.on('finish', resolve);
  out.on('error', reject);
});

const storageStatePath = path.join(tmpDir, 'facebook-state.json');
fs.writeFileSync(storageStatePath, Buffer.from(process.env.FACEBOOK_STORAGE_STATE_B64, 'base64').toString('utf8'));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: storageStatePath, locale: 'en-US' });
const page = await context.newPage();

try {
  await page.goto('https://www.facebook.com/reels/create', { waitUntil: 'domcontentloaded', timeout: 60000 });

  if (/login|checkpoint/i.test(page.url())) {
    throw new Error('Facebook session is no longer valid or requires a security check.');
  }

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 30000 });
  await fileInput.setInputFiles(videoPath);

  const nextButton = page.getByRole('button', { name: /next|التالي|suivant|continuar/i }).last();
  if (await nextButton.isVisible({ timeout: 15000 }).catch(() => false)) {
    await nextButton.click();
  }

  const shareButton = page.getByRole('button', { name: /share reel|share|نشر|مشاركة الريل|publish/i }).last();
  await shareButton.waitFor({ state: 'visible', timeout: 60000 });
  await shareButton.click();

  await page.waitForTimeout(8000);

  if (/checkpoint/i.test(page.url())) {
    throw new Error('Facebook requested a security check. Publisher stopped without bypassing it.');
  }

  posted.add(next.id);
  fs.writeFileSync(statePath, JSON.stringify({ postedFileIds: [...posted] }, null, 2) + '\n');
  console.log(`Published and marked complete: ${next.name}`);
} finally {
  await browser.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
