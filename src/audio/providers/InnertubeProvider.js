/**
 * InnertubeProvider
 *
 * Wraps youtubei.js (Innertube) to provide:
 *  - YouTube text search
 *  - Video metadata resolution
 *  - Authenticated audio stream extraction
 *
 * One singleton Innertube instance is created with full auth
 * (cookie + poToken + visitorData) and reused across requests.
 * It is lazily initialized on first use and will never block the
 * process on startup.
 */

import { Innertube } from 'youtubei.js';
import { cookieManager } from '../cookies/CookieManager.js';
import { Track } from '../models/Track.js';
import { AudioError } from '../errors/AudioError.js';
import { logger } from '../../utils/logger.js';

class InnertubeProvider {
  constructor() {
    this._yt       = null;
    this._ready    = false;
    this._initProm = null;
  }

  /**
   * Returns the authenticated Innertube instance, initializing if needed.
   * Safe to call concurrently — coalesced to one initialization.
   */
  async getClient() {
    if (this._ready) return this._yt;
    if (this._initProm) return this._initProm;

    this._initProm = (async () => {
      try {
        const [cookie, poToken, visitorData] = await Promise.all([
          cookieManager.getCookieString(),
          cookieManager.getPoToken(),
          cookieManager.getVisitorData()
        ]);

        this._yt = await Innertube.create({
          cookie:                 cookie     || undefined,
          po_token:               poToken    || undefined,
          visitor_data:           visitorData || undefined,
          // Only auto-generate poToken when we have no stored one
          generate_session_locally: !poToken
        });

        this._ready = true;
        logger.info('[InnertubeProvider] Client initialized.');
      } catch (err) {
        this._yt       = null;
        this._ready    = false;
        this._initProm = null;
        throw new AudioError('Innertube client init failed', {
          source: 'innertube', provider: 'youtubei.js', cause: err
        });
      }
    })();

    return this._initProm;
  }

  /** Force recreation on next use (e.g. after cookie refresh) */
  invalidate() {
    this._yt       = null;
    this._ready    = false;
    this._initProm = null;
  }

  /**
   * Search YouTube for text queries.
   * Returns Track[] with valid video IDs only.
   */
  async search(query, limit = 1) {
    const yt = await this.getClient();
    const res = await yt.search(query);
    const videos = (res?.videos ?? []);
    const tracks = [];

    for (const v of videos) {
      const id = v.video_id ?? v.id ?? v.endpoint?.payload?.videoId;
      if (!id) continue;
      const title = typeof v.title === 'string' ? v.title : (v.title?.text ?? query);
      tracks.push(new Track({
        id,
        title,
        artist:     v.author?.name ?? v.author?.text ?? 'YouTube',
        durationMs: (v.duration?.seconds ?? 0) * 1000,
        thumbnail:  v.thumbnails?.[0]?.url ?? null
      }));
      if (tracks.length >= limit) break;
    }

    return tracks;
  }

  /**
   * Resolve a video ID to a Track using oEmbed (lightweight, no auth needed).
   * Falls back to a stub Track if oEmbed is unavailable.
   */
  async resolveId(id) {
    try {
      const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`oEmbed HTTP ${res.status}`);
      const data = await res.json();
      return new Track({
        id,
        title:     data.title,
        artist:    data.author_name,
        thumbnail: data.thumbnail_url
      });
    } catch {
      return new Track({ id, title: `YouTube Video (${id})` });
    }
  }

  /**
   * Extract an authenticated audio stream from a video ID.
   * Returns a ReadableStream (Web Streams API) or throws AudioError.
   */
  async extractStream(videoId) {
    const yt = await this.getClient();
    // type:'audio' makes Innertube request audio-only formats
    const stream = await yt.download(videoId, { type: 'audio', quality: 'best' });
    return stream; // Web ReadableStream — caller converts with Readable.fromWeb()
  }
}

export const innertubeProvider = new InnertubeProvider();
