/**
 * ExtractionEngine  (v3 — yt-dlp download-first)
 *
 * NEW FLOW:
 *   extract(videoId, title)
 *     └── YtDlpDownloader.download(videoId) → temp/{videoId}.mp3
 *     └── createAudioResource(fs.createReadStream(path), { inputType: Opus/Arbitrary })
 *     └── Returns AudioResource  +  tempFilePath for cleanup
 *
 * WHY THIS IS MORE RELIABLE THAN STREAMING:
 *   • yt-dlp is maintained by a dedicated team and updated daily
 *   • Local file has no network stalls mid-playback
 *   • No bot-check, no poToken, no cookie-jar complexity at play time
 *   • mp3 plays via ffmpeg — zero codec negotiation issues
 *   • File is deleted automatically when AudioPlayer enters Idle
 *
 * AudioManager must call ExtractionEngine.cleanup(tempFilePath)
 * after the AudioPlayer enters Idle to delete the temp file.
 */

import { createAudioResource, StreamType } from '@discordjs/voice';
import { createReadStream } from 'fs';
import { ytDlpDownloader, YtDlpDownloader } from '../downloader/YtDlpDownloader.js';
import { logger } from '../../utils/logger.js';

export class ExtractionEngine {
  /**
   * Download and prepare an AudioResource for the given video ID.
   *
   * @param {string} videoId  YouTube video ID
   * @param {string} [title]  Track title (for logging only)
   * @returns {Promise<{ resource: AudioResource, tempFile: string }>}
   */
  async extract(videoId, title = '') {
    logger.debug(`[ExtractionEngine] Downloading "${title}" [${videoId}]`);

    const tempFile = await ytDlpDownloader.download(videoId, title);

    const stream   = createReadStream(tempFile);
    const resource = createAudioResource(stream, {
      inputType:    StreamType.Arbitrary,
      inlineVolume: false
    });

    return { resource, tempFile };
  }

  /**
   * Delete the temp file after playback.
   * Call this from AudioManager._onTrackEnd().
   */
  static cleanup(tempFile) {
    YtDlpDownloader.deleteFile(tempFile);
  }
}

export const extractionEngine = new ExtractionEngine();
