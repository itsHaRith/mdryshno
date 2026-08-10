/**
 * YtDlpDownloader
 *
 * Downloads a YouTube video's audio track to a local temp file using yt-dlp,
 * then returns the file path for playback.
 *
 * Flow:
 *   download(videoId, title) → runs yt-dlp → returns '/tmp/ytdlp/{videoId}.mp3'
 *
 * yt-dlp flags used:
 *   -x                   → extract audio only (no video)
 *   --audio-format mp3   → convert to mp3 (works with ffmpeg-static)
 *   --audio-quality 5    → VBR ~128kbps (good quality, small file, fast download)
 *   --no-playlist        → never download full playlists accidentally
 *   --no-warnings        → suppress non-critical yt-dlp console noise
 *   --ffmpeg-location    → point to ffmpeg-static binary
 *   -o                   → output path template
 *
 * Cookie support:
 *   If YTDLP_COOKIE_FILE env var is set → passed as --cookies path
 *   Otherwise tries CookieManager and writes a temp netscape cookie file.
 *
 * Concurrency:
 *   Max 3 parallel downloads (configurable). Queue waits if at capacity.
 *   Each bot downloads its own file — no filename conflicts (uses videoId).
 */

import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import ffmpegStatic      from 'ffmpeg-static';
import { cookieManager } from '../cookies/CookieManager.js';
import { logger }        from '../../utils/logger.js';

// Prefer system ffmpeg (installed via replit.nix or apt) — fall back to ffmpeg-static
function resolveFfmpeg() {
  try {
    const sys = execSync('which ffmpeg 2>/dev/null || where ffmpeg 2>nul', { timeout: 2000 }).toString().trim().split('\n')[0].trim();
    if (sys && existsSync(sys)) return sys;
  } catch {}
  return ffmpegStatic;
}
const ffmpegPath = resolveFfmpeg();

const __dirname   = dirname(fileURLToPath(import.meta.url));
const BIN_DIR     = join(__dirname, '..', '..', '..', 'bin');
const TEMP_DIR    = join(__dirname, '..', '..', '..', 'temp');
const MAX_PARALLEL = 3;

// Locate yt-dlp binary: prefer bin/ next to project root, fall back to PATH
function findYtDlp() {
  const IS_WIN = process.platform === 'win32';
  const local  = join(BIN_DIR, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');
  if (existsSync(local)) return local;
  return IS_WIN ? 'yt-dlp.exe' : 'yt-dlp'; // hope it's on PATH
}

export class YtDlpDownloader {
  constructor() {
    this._active   = 0;
    this._queue    = [];
    this._cookieTmp = null;

    // Ensure temp dir exists
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
    if (!existsSync(BIN_DIR))  mkdirSync(BIN_DIR,  { recursive: true });
  }

  /**
   * Download audio for a YouTube video ID.
   * Returns the absolute path to the downloaded .mp3 file.
   * @param {string} videoId  11-character YouTube video ID
   * @param {string} [title]  Used only for logging
   * @returns {Promise<string>} absolute path to temp mp3 file
   */
  async download(videoId, title = '') {
    return new Promise((resolve, reject) => {
      const task = () => this._run(videoId, title, resolve, reject);

      if (this._active < MAX_PARALLEL) {
        this._active++;
        task();
      } else {
        this._queue.push(task);
        logger.debug(`[YtDlpDownloader] Queued (${this._queue.length} waiting): "${title}"`);
      }
    });
  }

  _dequeue() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._active = Math.max(0, this._active - 1);
    }
  }

  async _run(videoId, title, resolve, reject) {
    const outputTemplate = join(TEMP_DIR, `${videoId}.%(ext)s`);
    const ytdlpBin       = findYtDlp();
    const videoUrl       = `https://www.youtube.com/watch?v=${videoId}`;
    const start          = Date.now();

    const ffmpegArgs = ffmpegPath ? ['--ffmpeg-location', ffmpegPath] : [];
    const cookieArgs = await this._buildCookieArgs();

    // Helper to spawn yt-dlp process
    const executeYtDlp = (useCookies) => {
      return new Promise((res, rej) => {
        const cArgs = (useCookies && cookieArgs.length > 0) ? cookieArgs : [];
        const args = [
          '--no-playlist',
          '--no-warnings',
          '--js-runtimes', 'node',
          '-f', 'ba/b',
          '--no-post-overwrites',
          ...ffmpegArgs,
          '-o', outputTemplate,
          ...cArgs,
          '--', videoUrl
        ];

        logger.debug(`[YtDlpDownloader] Executing (cookies=${useCookies}): "${title}" [${videoId}]`);

        let stderr = '';
        const proc = spawn(ytdlpBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

        proc.stderr.on('data', chunk => {
          const line = chunk.toString().trim();
          if (line) {
            stderr += line + '\n';
            logger.debug(`[yt-dlp] ${line}`);
          }
        });

        proc.stdout.on('data', chunk => {
          const line = chunk.toString().trim();
          if (line) logger.debug(`[yt-dlp] ${line}`);
        });

        proc.on('close', (code) => {
          if (code !== 0) {
            return rej(new Error(stderr.slice(-500) || `yt-dlp exited with code ${code}`));
          }
          // Find actual output file
          let actualFile = null;
          try {
            const files = readdirSync(TEMP_DIR).filter(f => f.startsWith(videoId + '.'));
            if (files.length > 0) actualFile = join(TEMP_DIR, files[0]);
          } catch {}

          if (!actualFile || !existsSync(actualFile)) {
            return rej(new Error(`yt-dlp exited 0 but no output file found for ${videoId}`));
          }
          res(actualFile);
        });

        proc.on('error', (err) => rej(err));
      });
    };

    try {
      // If cookies are provided (e.g. Google One / Premium account), try with cookies first
      if (cookieArgs.length > 0) {
        try {
          const downloadedFile = await executeYtDlp(true);
          this._dequeue();
          const ms = Date.now() - start;
          logger.info(`[YtDlpDownloader] Cookie download succeeded in ${ms}ms: "${title}" → ${downloadedFile}`);
          return resolve(downloadedFile);
        } catch (cookieErr) {
          logger.warn(`[YtDlpDownloader] Cookie attempt failed ("${cookieErr.message}"). Retrying clean without cookies...`);
        }
      }

      // Fallback or default: clean download (no cookies)
      const downloadedFile = await executeYtDlp(false);
      this._dequeue();
      const ms = Date.now() - start;
      logger.info(`[YtDlpDownloader] Clean download succeeded in ${ms}ms: "${title}" → ${downloadedFile}`);
      resolve(downloadedFile);
    } catch (cleanErr) {
      this._dequeue();
      logger.warn(`[YtDlpDownloader] Download failed: "${cleanErr.message}"`);
      reject(cleanErr);
    }
  }

  async _buildCookieArgs() {
    // Priority 1: explicit cookie file path
    if (process.env.YTDLP_COOKIE_FILE && existsSync(process.env.YTDLP_COOKIE_FILE)) {
      return ['--cookies', process.env.YTDLP_COOKIE_FILE];
    }

    // Priority 2: YOUTUBE_COOKIE env var (cookie header string from .env / Replit Secrets)
    const envCookie = process.env.YOUTUBE_COOKIE;
    if (envCookie && envCookie.length > 20) {
      try {
        const netscape = this._cookieStringToNetscape(envCookie);
        if (netscape) {
          const tmpPath = join(TEMP_DIR, 'yt_cookies.txt');
          writeFileSync(tmpPath, netscape, 'utf8');
          logger.debug('[YtDlpDownloader] Using YOUTUBE_COOKIE env var for authentication.');
          return ['--cookies', tmpPath];
        }
      } catch {}
    }

    // Priority 3: CookieManager (Supabase → youtubeCookies.js)
    try {
      const cookieStr = await cookieManager.getCookieString();
      if (!cookieStr || cookieStr.length < 20) return [];

      const netscape = this._cookieStringToNetscape(cookieStr);
      if (!netscape) return [];

      const tmpPath = join(TEMP_DIR, 'yt_cookies.txt');
      writeFileSync(tmpPath, netscape, 'utf8');
      this._cookieTmp = tmpPath;
      return ['--cookies', tmpPath];
    } catch {
      return [];
    }

  }

  /** Convert "name=value; name2=value2" → Netscape cookie file format */
  _cookieStringToNetscape(cookieStr) {
    const header = '# Netscape HTTP Cookie File\n# https://curl.haxx.se/rfc/cookie_spec.html\n\n';
    const lines = cookieStr.split(';').map(pair => {
      const eq = pair.indexOf('=');
      if (eq < 0) return null;
      const name  = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name || !value) return null;
      // domain  domainIncluded  path  secure  expiry  name  value
      return `.youtube.com\tTRUE\t/\tTRUE\t2147483647\t${name}\t${value}`;
    }).filter(Boolean);

    if (lines.length === 0) return null;
    return header + lines.join('\n') + '\n';
  }

  /**
   * Delete a downloaded temp file.
   * Safe to call even if file doesn't exist.
   */
  static deleteFile(filePath) {
    if (!filePath) return;
    try {
      unlinkSync(filePath);
      logger.debug(`[YtDlpDownloader] Deleted temp file: ${filePath}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.debug(`[YtDlpDownloader] Could not delete ${filePath}: ${err.message}`);
      }
    }
  }
}

export const ytDlpDownloader = new YtDlpDownloader();
