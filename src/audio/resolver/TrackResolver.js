/**
 * TrackResolver
 *
 * Converts any user input (URL, search query, video ID, playlist URL) into
 * an ordered array of Track objects ready for the queue.
 *
 * Supported input types:
 *  - YouTube watch URL (youtu.be or youtube.com/watch)
 *  - YouTube Shorts URL
 *  - YouTube playlist URL  (limited to first 100 tracks)
 *  - Text search query     (routed through SearchEngine)
 */

import play from 'play-dl';
import { searchEngine } from '../search/SearchEngine.js';
import { innertubeProvider } from '../providers/InnertubeProvider.js';
import { Track } from '../models/Track.js';
import { AudioError } from '../errors/AudioError.js';
import { logger } from '../../utils/logger.js';

const YT_VIDEO_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/|live\/))([a-zA-Z0-9_-]{11})/;
const YT_PLAYLIST_RE = /[?&]list=([a-zA-Z0-9_-]+)/;

export class TrackResolver {
  /**
   * Resolve user input to Track[].
   * @param {string} query       Raw user input
   * @param {string} requester   Discord user tag
   * @returns {Promise<Track[]>}
   */
  async resolve(query, requester = 'Unknown') {
    query = query.trim();

    const videoMatch    = query.match(YT_VIDEO_RE);
    const playlistMatch = query.match(YT_PLAYLIST_RE);

    // ── Playlist ────────────────────────────────────────────────────────
    if (playlistMatch && !videoMatch) {
      return this._resolvePlaylist(query, requester);
    }

    // ── Direct video URL / ID ────────────────────────────────────────────
    if (videoMatch) {
      const id = videoMatch[1];
      logger.debug(`[TrackResolver] Direct video ID: ${id}`);
      const track = await innertubeProvider.resolveId(id);
      track.requester = requester;
      return [track];
    }

    // ── Text search ──────────────────────────────────────────────────────
    logger.debug(`[TrackResolver] Text search: "${query}"`);
    const tracks = await searchEngine.search(query, 1);
    if (tracks.length === 0) {
      throw new AudioError(`لم يتم العثور على نتائج في يوتيوب لـ: "${query}"`, {
        source: 'resolver', provider: 'SearchEngine'
      });
    }
    tracks[0].requester = requester;
    return [tracks[0]];
  }

  async _resolvePlaylist(url, requester) {
    try {
      const playlist = await play.playlist_info(url, { incomplete: true });
      const videos   = await playlist.all_videos();
      const tracks   = [];
      for (const v of videos) {
        const id = v.id ?? v.url?.match(/v=([\w-]{11})/)?.[1];
        if (!id) continue;
        tracks.push(new Track({
          id,
          title:     v.title ?? `YouTube Video`,
          artist:    v.channel?.name ?? 'YouTube',
          durationMs: (v.durationInSec ?? 0) * 1000,
          thumbnail:  v.thumbnails?.[0]?.url ?? null,
          requester
        }));
        if (tracks.length >= 100) break; // Safety cap
      }
      logger.info(`[TrackResolver] Playlist loaded: ${tracks.length} tracks`);
      return tracks;
    } catch (err) {
      throw new AudioError(`Failed to load playlist: ${err.message}`, {
        source: 'resolver', provider: 'play-dl', cause: err
      });
    }
  }
}

export const trackResolver = new TrackResolver();
