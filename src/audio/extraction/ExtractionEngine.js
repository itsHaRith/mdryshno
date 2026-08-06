/**
 * ExtractionEngine
 *
 * Three-tier, fault-tolerant audio stream extraction pipeline.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  Tier 1: ytdl-core-enhanced                                        │
 * │    • options.agent = ytdl.createAgent(cookieArray)                 │
 * │      ← This is the ONLY correct way. Using requestOptions.headers  │
 * │        triggers "old cookie format" and falls back to anonymous.   │
 * │    • ytdl.setPoTokenAndVisitorData() called at build time          │
 * │    • Prefers opus/webm audio-only for lowest latency               │
 * ├────────────────────────────────────────────────────────────────────┤
 * │  Tier 2: youtubei.js (Innertube)                                   │
 * │    • Already has full auth from Innertube.create(cookie, poToken)  │
 * │    • yt.download(videoId, { type:'audio', quality:'best' })        │
 * │    • Web ReadableStream → Node Readable via Readable.fromWeb()     │
 * ├────────────────────────────────────────────────────────────────────┤
 * │  Tier 3: play-dl                                                   │
 * │    • play.stream() with cookie set via play.setToken()             │
 * │    • Last resort; least control over format selection              │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Returns a @discordjs/voice AudioResource or throws AudioError.
 */

import { createAudioResource, StreamType } from '@discordjs/voice';
import { Readable } from 'stream';
import ytdl from 'ytdl-core-enhanced';
import play from 'play-dl';
import { innertubeProvider } from '../providers/InnertubeProvider.js';
import { cookieManager } from '../cookies/CookieManager.js';
import { AudioError } from '../errors/AudioError.js';
import { logger } from '../../utils/logger.js';

// Seed play-dl cookie once at module load
cookieManager.getCookieString().then(cookie => {
  if (!cookie) return;
  play.setToken({ youtube: { cookie } }).catch(() => {});
});

export class ExtractionEngine {
  /**
   * Extract a playable AudioResource for the given YouTube video ID.
   *
   * @param {string} videoId   11-character YouTube video ID
   * @param {string} [title]   Track title for logging
   * @returns {Promise<import('@discordjs/voice').AudioResource>}
   */
  async extract(videoId, title = '') {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const start    = Date.now();
    let lastErr    = null;

    // ── Tier 1: ytdl-core-enhanced ────────────────────────────────────
    try {
      logger.debug(`[ExtractionEngine] Tier 1 (ytdl): "${title}" [${videoId}]`);
      const resource = await this._extractYtdl(videoId, watchUrl);
      logger.info(`[ExtractionEngine] Tier 1 OK in ${Date.now() - start}ms: "${title}"`);
      return resource;
    } catch (err) {
      lastErr = err;
      logger.debug(`[ExtractionEngine] Tier 1 failed: ${err.message}`);

      // "Sign in" or 403 → cookies likely expired, invalidate cache
      if (/sign in|bot|403|429/i.test(err.message)) {
        cookieManager.invalidate();
        innertubeProvider.invalidate();
        logger.warn('[ExtractionEngine] Bot-check / 403 detected — cookie cache invalidated.');
      }
    }

    // ── Tier 2: youtubei.js ───────────────────────────────────────────
    try {
      logger.debug(`[ExtractionEngine] Tier 2 (Innertube): "${title}" [${videoId}]`);
      const resource = await this._extractInnertube(videoId);
      logger.info(`[ExtractionEngine] Tier 2 OK in ${Date.now() - start}ms: "${title}"`);
      return resource;
    } catch (err) {
      lastErr = err;
      logger.debug(`[ExtractionEngine] Tier 2 failed: ${err.message}`);
    }

    // ── Tier 3: play-dl ───────────────────────────────────────────────
    try {
      logger.debug(`[ExtractionEngine] Tier 3 (play-dl): "${title}" [${videoId}]`);
      const resource = await this._extractPlayDl(watchUrl);
      logger.info(`[ExtractionEngine] Tier 3 OK in ${Date.now() - start}ms: "${title}"`);
      return resource;
    } catch (err) {
      lastErr = err;
      logger.debug(`[ExtractionEngine] Tier 3 failed: ${err.message}`);
    }

    throw new AudioError(
      `All extraction tiers exhausted for "${title}" [${videoId}]`,
      { source: 'extraction', videoId, retryCount: 3, cause: lastErr }
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // Private extraction methods
  // ─────────────────────────────────────────────────────────────────────

  async _extractYtdl(videoId, watchUrl) {
    // Build a fresh authenticated agent from current cookies
    // MUST be passed as options.agent — NOT via requestOptions.headers.cookie
    // Passing via headers triggers "old cookie format" + anonymous fallback
    const cookieArray = await cookieManager.getCookieArray();
    const poToken     = await cookieManager.getPoToken();
    const visitorData = await cookieManager.getVisitorData();

    // Inject poToken + visitorData into ytdl's global InnerTube client context
    if (poToken && visitorData) {
      ytdl.setPoTokenAndVisitorData(poToken, visitorData);
    }

    const agent = ytdl.createAgent(cookieArray);

    const info = await ytdl.getInfo(watchUrl, {
      agent,                         // ← correct: agent carries the cookie jar
      requestOptions: { headers: {} } // empty headers so we don't trigger old-format path
    });

    const formats = info?.formats ?? [];

    // Prefer: opus audio-only → any audio-only → any with audio
    const format =
      formats.find(f => f.hasAudio && !f.hasVideo && f.codecs?.includes('opus') && f.url) ??
      formats.find(f => f.hasAudio && !f.hasVideo && f.url) ??
      formats.find(f => f.hasAudio && f.url);

    if (!format?.url) {
      throw new AudioError('No audio format with URL in ytdl response', {
        source: 'extraction', provider: 'ytdl-core-enhanced', videoId
      });
    }

    logger.debug(`[ExtractionEngine] ytdl format: itag=${format.itag} mime="${format.mimeType}" bitrate=${format.audioBitrate}kbps`);

    const stream = ytdl.downloadFromInfo(info, {
      format,
      agent,            // ← agent required here too for authenticated chunk requests
      highWaterMark: 1 << 25
    });

    return createAudioResource(stream, {
      inputType: StreamType.Arbitrary,
      inlineVolume: false
    });
  }

  async _extractInnertube(videoId) {
    const webStream  = await innertubeProvider.extractStream(videoId);
    const nodeStream = Readable.fromWeb(webStream);
    return createAudioResource(nodeStream, {
      inputType: StreamType.Arbitrary,
      inlineVolume: false
    });
  }

  async _extractPlayDl(watchUrl) {
    // Re-seed cookie in case it was refreshed
    const cookie = await cookieManager.getCookieString();
    if (cookie) {
      try { await play.setToken({ youtube: { cookie } }); } catch {}
    }

    const stream = await play.stream(watchUrl, { discordPlayerCompatibility: true });
    return createAudioResource(stream.stream, {
      inputType: stream.type,
      inlineVolume: false
    });
  }
}

export const extractionEngine = new ExtractionEngine();
