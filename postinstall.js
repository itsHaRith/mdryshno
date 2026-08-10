#!/usr/bin/env node
/**
 * postinstall.js
 * Downloads the correct yt-dlp binary for the current platform
 * into bin/yt-dlp (Linux/Mac) or bin/yt-dlp.exe (Windows).
 *
 * Runs automatically after npm install.
 * Safe to re-run — skips download if binary already exists and is executable.
 */

import { existsSync, mkdirSync, chmodSync, createWriteStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_DIR   = join(__dirname, 'bin');
const IS_WIN    = process.platform === 'win32';
const BINARY    = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';
const BIN_PATH  = join(BIN_DIR, BINARY);

const DOWNLOAD_URLS = {
  win32:  'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp.exe',
  linux:  'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp',
  darwin: 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_macos'
};

const url = DOWNLOAD_URLS[process.platform] ?? DOWNLOAD_URLS.linux;



if (!existsSync(BIN_DIR)) mkdirSync(BIN_DIR, { recursive: true });

console.log(`[postinstall] Downloading yt-dlp from ${url} ...`);

function download(url, dest, redirects = 0) {
  if (redirects > 5) { console.error('[postinstall] Too many redirects'); process.exit(1); }
  https.get(url, { headers: { 'User-Agent': 'node-postinstall' } }, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302) {
      return download(res.headers.location, dest, redirects + 1);
    }
    if (res.statusCode !== 200) {
      console.error(`[postinstall] HTTP ${res.statusCode} — yt-dlp download failed.`);
      console.error('[postinstall] Bot will still start but download-based playback will not work.');
      process.exit(0); // don't block npm install
    }
    const file = createWriteStream(dest);
    res.pipe(file);
    file.on('finish', () => {
      file.close();
      if (!IS_WIN) chmodSync(dest, 0o755);
      console.log(`[postinstall] yt-dlp downloaded to ${dest}`);
    });
    file.on('error', (err) => {
      console.error('[postinstall] File write error:', err.message);
      process.exit(0);
    });
  }).on('error', (err) => {
    console.error('[postinstall] Download error:', err.message);
    process.exit(0); // don't block
  });
}

download(url, BIN_PATH);
