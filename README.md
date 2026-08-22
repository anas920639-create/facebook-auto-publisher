# facebook-auto-publisher

Publishes the next video from a Google Drive folder to a Facebook Professional Mode profile using Playwright in GitHub Actions.

## Required GitHub Secrets

- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `GDRIVE_FOLDER_ID`
- `FACEBOOK_STORAGE_STATE_B64`

## Schedule

The workflow currently runs at 13:00, 18:00, and 22:00 in `Asia/Amman`.

## Safety

The automation does not bypass CAPTCHA, checkpoints, or other Facebook security challenges. If Facebook requests a security check, the run fails and stops.
