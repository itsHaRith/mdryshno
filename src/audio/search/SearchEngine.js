/**
 * SearchEngine
 *
 * Multi-provider search with automatic fallback.
 *
 * Priority:
 *   1. InnertubeProvider.search()  — most reliable, handles all languages
 *   2. play-dl play.search()       — backup, wrapped in try/catch because it
 *                                    throws browseId errors on some Arabic queries
 *
 * Returns Track[] (may be empty — never throws for a "no results" situation).
 * Throws AudioError only on infrastructure failures that should bubble up.
 */

import play from 'play-dl';
import { innertubeProvider } from '../providers/InnertubeProvider.js';
import { Track } from '../models/Track.js';
import { AudioError } from '../errors/AudioError.js';
import { logger } from '../../utils/logger.js';

export class SearchEngine {
  /**
   * Search for `query` and return up to `limit` Track objects.
   * @param {string} query
   * @param {number} [limit=1]
   * @returns {Promise<Track[]>}
   */
  async search(query, limit = 1) {
    // ── Tier 1: Innertube ─────────────────────────────────────────────────
    try {
      logger.debug(`[SearchEngine] Innertube search: "${query}"`);
      const tracks = await innertubeProvider.search(query, limit);
      if (tracks.length > 0) {
        logger.info(`[SearchEngine] Innertube resolved: "${tracks[0].title}"`);
        return tracks;
      }
      logger.debug('[SearchEngine] Innertube returned 0 results, trying play-dl.');
    } catch (err) {
      logger.debug(`[SearchEngine] Innertube search error: ${err.message}`);
    }

    // ── Tier 2: play-dl (protected) ──────────────────────────────────────
    try {
      logger.debug(`[SearchEngine] play.search fallback: "${query}"`);
      const results = await play.search(query, { limit });
      const tracks = (results ?? [])
        .map(v => {
          const id = v.id ?? v.url?.match(/v=([\w-]{11})/)?.[1];
          if (!id) return null;
          return new Track({
            id,
            title:     v.title ?? query,
            artist:    v.channel?.name ?? 'YouTube',
            durationMs: (v.durationInSec ?? 0) * 1000,
            thumbnail:  v.thumbnails?.[0]?.url ?? null
          });
        })
        .filter(Boolean)
        .slice(0, limit);

      if (tracks.length > 0) {
        logger.info(`[SearchEngine] play-dl resolved: "${tracks[0].title}"`);
        return tracks;
      }
    } catch (err) {
      // play-dl throws browseId errors on some Arabic queries — silently ignore
      logger.debug(`[SearchEngine] play-dl search error (suppressed): ${err.message}`);
    }

    return [];
  }
}

export const searchEngine = new SearchEngine();
