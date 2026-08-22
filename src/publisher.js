import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { google } from 'googleapis';
import { chromium } from 'playwright';

const required = ['GDRIVE_FOLDER_ID', 'FACEBOOK_STORAGE_STATE_B64'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

const statePath = path.resolve('state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const posted = new Set(state.postedFileIds || []);

const auth = new google.auth.GoogleAuth({
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

console.log('Found the next unpublished video.');

const tmpDir = path.resolve('.tmp');
fs.mkdirSync(tmpDir, { recursive: true });
const videoPath = path.join(tmpDir, next.name.replace(/[\\/:*?"<>|]/g, '_'));

const out = fs.createWriteStream(videoPath);
const download = await drive.files.get(
  { fileId: next.id, alt: 'media' },
  { responseType: 'stream' }
);

await new Promise((resolve, reject) => {
  download.data.pipe(out);
  download.data.on('error', reject);
  out.on('finish', resolve);
  out.on('error', reject);
});

console.log('Generating an AI caption from the video...');
let caption;
try {
  caption = execFileSync(
    'python3',
    ['scripts/generate_caption.py', videoPath],
    {
      encoding: 'utf8',
      timeout: 12 * 60 * 1000,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: process.env,
    }
  ).trim();
} catch (error) {
  throw new Error(`AI caption generation failed. Nothing was posted. ${error.message}`);
}

if (!caption) {
  throw new Error('AI caption was empty. Nothing was posted.');
}
console.log('AI caption passed the quality checks.');

const storageStatePath = path.join(tmpDir, 'facebook-state.json');
fs.writeFileSync(
  storageStatePath,
  Buffer.from(process.env.FACEBOOK_STORAGE_STATE_B64, 'base64').toString('utf8')
);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  storageState: storageStatePath,
  locale: 'en-US',
});
const page = await context.newPage();

async function clickNextIfVisible() {
  const button = page
    .getByRole('button', { name: /^(next|التالي|suivant|continuar)$/i })
    .last();

  if (await button.isVisible({ timeout: 12000 }).catch(() => false)) {
    await button.click();
    await page.waitForTimeout(1800);
    return true;
  }
  return false;
}

async function fillCaption(text) {
  const named = page.getByRole('textbox', {
    name: /caption|describe|description|say something|write something|وصف|اكتب|تعليق/i,
  }).first();

  if (await named.isVisible({ timeout: 5000 }).catch(() => false)) {
    await named.fill(text);
    return;
  }

  const editable = page
    .locator('div[contenteditable="true"][role="textbox"]:visible, textarea:visible')
    .first();

  if (await editable.isVisible({ timeout: 5000 }).catch(() => false)) {
    await editable.fill(text);
    return;
  }

  throw new Error('Could not find the Facebook Reel caption field. Nothing was posted.');
}

try {
  await page.goto('https://www.facebook.com/reels/create', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  if (/login|checkpoint|two_step_verification|authentication/i.test(page.url())) {
    throw new Error('Facebook session is invalid or requires a manual security check.');
  }

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 30000 });
  await fileInput.setInputFiles(videoPath);

  // Facebook's Reel creator commonly has two "Next" stages before the final share screen.
  await page.waitForTimeout(2500);
  await clickNextIfVisible();
  await clickNextIfVisible();

  await fillCaption(caption);

  const shareButton = page
    .getByRole('button', {
      name: /share reel|share|publish|نشر|مشاركة الريل|مشاركة/i,
    })
    .last();

  await shareButton.waitFor({ state: 'visible', timeout: 60000 });

  // Wait until Facebook finishes enough processing to enable Share.
  const shareDeadline = Date.now() + 3 * 60 * 1000;
  while (!(await shareButton.isEnabled().catch(() => false))) {
    if (Date.now() > shareDeadline) {
      throw new Error('Facebook did not enable the Share button in time. Nothing was posted.');
    }
    await page.waitForTimeout(2000);
  }

  await shareButton.click();

  // Never attempt to bypass a Facebook challenge.
  await page.waitForTimeout(8000);
  if (/checkpoint|two_step_verification|authentication/i.test(page.url())) {
    throw new Error('Facebook requested a manual security check. Publisher stopped.');
  }

  // Look for a success signal, while also accepting navigation away from the creator.
  let confirmed = false;
  const successText = page.getByText(
    /reel.*(shared|published|posted)|your reel|تم.*(نشر|مشاركة)|تم نشر الريل/i
  ).first();

  const confirmDeadline = Date.now() + 90 * 1000;
  while (Date.now() < confirmDeadline) {
    if (!/\/reels\/create/i.test(page.url())) {
      confirmed = true;
      break;
    }
    if (await successText.isVisible({ timeout: 1000 }).catch(() => false)) {
      confirmed = true;
      break;
    }
    await page.waitForTimeout(2000);
  }

  if (!confirmed) {
    throw new Error(
      'Facebook did not provide a clear success confirmation. The video was not marked complete to avoid a false success.'
    );
  }

  posted.add(next.id);
  fs.writeFileSync(
    statePath,
    JSON.stringify({ postedFileIds: [...posted] }, null, 2) + '\n'
  );
  console.log('Publish confirmed and video marked complete.');
} finally {
  await browser.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
