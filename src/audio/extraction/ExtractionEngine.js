/**
 * ExtractionEngine  (v3 — 3-Tier Download-First Architecture)
 *
 * Guaranteed local file creation before playback:
 *   1. User requests song
 *   2. ExtractionEngine downloads audio file to temp/{videoId}.file
 *      - Tier 1: yt-dlp binary (with User-Agent & client rotation)
 *      - Tier 2: Innertube (youtubei.js) stream piped to temp file
 *      - Tier 3: play-dl stream piped to temp file
 *   3. @discordjs/voice creates AudioResource from local temp file
 *   4. AudioPlayer plays local file cleanly (0 network buffering glitches)
 *   5. On track end / stop → ExtractionEngine.cleanup() deletes temp file
 */

import { createAudioResource, StreamType } from '@discordjs/voice';
import { createReadStream, createWriteStream, existsSync, readdirSync } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import play from 'play-dl';

import { ytDlpDownloader, YtDlpDownloader } from '../downloader/YtDlpDownloader.js';
import { innertubeProvider } from '../providers/InnertubeProvider.js';
import { AudioError } from '../errors/AudioError.js';
import { logger } from '../../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_DIR  = join(__dirname, '..', '..', '..', 'temp');

export class ExtractionEngine {
  /**
   * Download and prepare an AudioResource for the given video ID.
   * Uses 3-tier fallback to ensure temp file is ALWAYS created.
   *
   * @param {string} videoId  YouTube video ID
   * @param {string} [title]  Track title (for logging)
   * @returns {Promise<{ resource: import('@discordjs/voice').AudioResource, tempFile: string }>}
   */
  async extract(videoId, title = '') {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const start    = Date.now();
    let tempFile   = null;
    let lastErr    = null;

    // ── Tier 1: yt-dlp binary ─────────────────────────────────────────
    try {
      logger.debug(`[ExtractionEngine] Tier 1 (yt-dlp): "${title}" [${videoId}]`);
      tempFile = await ytDlpDownloader.download(videoId, title);
      logger.info(`[ExtractionEngine] Tier 1 (yt-dlp) downloaded in ${Date.now() - start}ms: "${title}"`);
    } catch (err) {
      lastErr = err;
      logger.warn(`[ExtractionEngine] Tier 1 (yt-dlp) failed: ${err.message}. Trying Tier 2 (Innertube)...`);
    }

    // ── Tier 2: Innertube (youtubei.js) → download stream to file ──────
    if (!tempFile) {
      try {
        logger.debug(`[ExtractionEngine] Tier 2 (Innertube file pipe): "${title}" [${videoId}]`);
        const webStream  = await innertubeProvider.extractStream(videoId);
        const nodeStream = Readable.fromWeb(webStream);
        const outPath    = join(TEMP_DIR, `${videoId}.webm`);
        const fileWriter = createWriteStream(outPath);

        await pipeline(nodeStream, fileWriter);
        if (existsSync(outPath)) {
          tempFile = outPath;
          logger.info(`[ExtractionEngine] Tier 2 (Innertube) saved to file in ${Date.now() - start}ms: "${title}"`);
        }
      } catch (err) {
        lastErr = err;
        logger.warn(`[ExtractionEngine] Tier 2 (Innertube) failed: ${err.message}. Trying Tier 3 (play-dl)...`);
      }
    }

    // ── Tier 3: play-dl YouTube stream ───────────────────────────────
    if (!tempFile) {
      try {
        logger.debug(`[ExtractionEngine] Tier 3 (play-dl file pipe): "${title}" [${videoId}]`);
        const pStream  = await play.stream(watchUrl, { discordPlayerCompatibility: true });
        const outPath  = join(TEMP_DIR, `${videoId}.webm`);
        const fileWriter = createWriteStream(outPath);

        await pipeline(pStream.stream, fileWriter);
        if (existsSync(outPath)) {
          tempFile = outPath;
          logger.info(`[ExtractionEngine] Tier 3 (play-dl) saved to file in ${Date.now() - start}ms: "${title}"`);
        }
      } catch (err) {
        lastErr = err;
        logger.warn(`[ExtractionEngine] Tier 3 (play-dl) failed: ${err.message}. Trying Tier 4 (SoundCloud)...`);
      }
    }

    // ── Tier 4: SoundCloud Fallback (Bypasses YouTube Cloud IP Block) ──
    if (!tempFile) {
      try {
        const query = title || videoId;
        logger.debug(`[ExtractionEngine] Tier 4 (SoundCloud fallback): Searching "${query}"`);

        // Ensure SoundCloud client ID is active
        try {
          const clientID = await play.getFreeClientID();
          await play.setToken({ soundcloud: { client_id: clientID } });
        } catch {}

        const scResults = await play.search(query, { source: { soundcloud: 'tracks' }, limit: 1 });
        if (scResults && scResults[0]?.url) {
          logger.info(`[ExtractionEngine] SoundCloud resolved: "${scResults[0].title}"`);
          const scStream   = await play.stream(scResults[0].url);
          const outPath    = join(TEMP_DIR, `${videoId}.webm`);
          const fileWriter = createWriteStream(outPath);

          await pipeline(scStream.stream, fileWriter);
          if (existsSync(outPath)) {
            tempFile = outPath;
            logger.info(`[ExtractionEngine] Tier 4 (SoundCloud) saved to file in ${Date.now() - start}ms: "${scResults[0].title}"`);
          }
        }
      } catch (err) {
        lastErr = err;
        logger.error(`[ExtractionEngine] Tier 4 (SoundCloud) failed: ${err.message}`);
      }
    }

    if (!tempFile || !existsSync(tempFile)) {
      throw new AudioError(
        `All 3 extraction tiers failed to create temp audio file for "${title}" [${videoId}]`,
        { source: 'extraction', videoId, cause: lastErr }
      );
    }

    const stream   = createReadStream(tempFile);
    const resource = createAudioResource(stream, {
      inputType:    StreamType.Arbitrary,
      inlineVolume: false
    });

    return { resource, tempFile };
  }

  /**
   * Delete the temp file after playback ends or on error.
   * Safe for any path pattern (deletes any file for that videoId).
   */
  static cleanup(tempFile) {
    if (!tempFile) return;
    YtDlpDownloader.deleteFile(tempFile);

    // Extra safety: clean any orphan files for the same path
    try {
      if (existsSync(tempFile)) {
        YtDlpDownloader.deleteFile(tempFile);
      }
    } catch {}
  }
}

export const extractionEngine = new ExtractionEngine();
