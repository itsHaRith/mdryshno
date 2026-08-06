/**
 * AudioManager  (v2 — new architecture)
 *
 * Public API is IDENTICAL to v1 so botInstance.js requires zero changes.
 *
 * Internals delegate to the new modular pipeline:
 *   trackResolver  → converts any user input to Track[]
 *   extractionEngine → three-tier authenticated stream extraction
 *   @discordjs/voice → AudioPlayer + VoiceConnection (unchanged)
 *
 * What changed vs v1:
 *   ✓ Cookie handling moved to CookieManager (Supabase → local fallback)
 *   ✓ Search moved to SearchEngine (Innertube primary, play-dl protected fallback)
 *   ✓ Extraction moved to ExtractionEngine (ytdl agent-correct → Innertube → play-dl)
 *   ✓ ytdl agent passed via options.agent — eliminates "old cookie format" warning
 *   ✓ ytdl.setPoTokenAndVisitorData() called on every extraction with fresh values
 *   ✓ On bot-check/403 → cookie cache invalidated, Innertube client reset, then retry
 *   ✓ No global mutable auth state scattered across the file
 *   ✓ No raw console.* calls — all through logger
 */

import {
  joinVoiceChannel,
  createAudioPlayer,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection
} from '@discordjs/voice';

import { trackResolver }    from './audio/resolver/TrackResolver.js';
import { extractionEngine } from './audio/extraction/ExtractionEngine.js';
import { buildPlayerDashboard } from './uiBuilder.js';
import { logger }           from './utils/logger.js';

export class AudioManager {
  constructor(client, botConfig) {
    this.client        = client;
    this.botConfig     = botConfig;
    this.guildId       = botConfig.guild_id;
    this.voiceChannelId = botConfig.voice_channel_id;
    this.textChannelId  = botConfig.text_channel_id;

    this.queue         = [];
    this.currentTrack  = null;
    this.volume        = 100;
    this.loopMode      = 'none'; // 'none' | 'track' | 'queue'
    this.isPaused      = false;

    this.voiceConnection  = null;
    this.audioPlayer      = null;
    this.audioResource    = null;
    this.dashboardMessage = null;
    this.dashboardInterval = null;

    this._initPlayer();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Player initialisation
  // ─────────────────────────────────────────────────────────────────────

  _initPlayer() {
    this.audioPlayer = createAudioPlayer();

    this.audioPlayer.on('stateChange', (old, next) => {
      logger.debug(`[AudioPlayer:${this.botConfig.bot_name}] ${old.status} → ${next.status}`);
    });

    this.audioPlayer.on(AudioPlayerStatus.Playing, () => {
      this.isPaused = false;
      logger.info(`[AudioPlayer:${this.botConfig.bot_name}] ▶ "${this.currentTrack?.title}"`);
      this._startDashboardUpdates();
    });

    this.audioPlayer.on(AudioPlayerStatus.Paused, () => {
      this.isPaused = true;
      this.updateDashboard();
    });

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      this._stopDashboardUpdates();
      this._onTrackEnd();
    });

    this.audioPlayer.on('error', err => {
      logger.error(`[AudioPlayer:${this.botConfig.bot_name}] Error: ${err.message}`);
      this._stopDashboardUpdates();
      this._onTrackEnd();
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Voice connection
  // ─────────────────────────────────────────────────────────────────────

  async connect() {
    try {
      const channel = await this.client.channels.fetch(this.voiceChannelId);
      if (!channel?.isVoiceBased()) {
        throw new Error(`Channel ${this.voiceChannelId} is not voice-based.`);
      }

      const guild = channel.guild;
      const me    = guild.members.me ?? await guild.members.fetch(this.client.user.id).catch(() => null);

      // Reuse if already connected to the same channel and healthy
      if (
        this.voiceConnection &&
        this.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed &&
        this.voiceConnection.state.status !== VoiceConnectionStatus.Disconnected &&
        me?.voice?.channelId === this.voiceChannelId
      ) {
        logger.info(`[VoiceManager:${this.botConfig.bot_name}] Reusing active connection.`);
        return;
      }

      // Disconnect ghost session if we're in a different channel
      if (me?.voice?.channelId && me.voice.channelId !== this.voiceChannelId) {
        await me.voice.disconnect().catch(() => {});
        await new Promise(r => setTimeout(r, 800));
      }

      this.voiceConnection = joinVoiceChannel({
        channelId:      this.voiceChannelId,
        guildId:        this.guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf:  true,
        selfMute:  false
      });

      this.voiceConnection.on('stateChange', (old, next) => {
        logger.debug(`[VoiceConn:${this.botConfig.bot_name}] ${old.status} → ${next.status}`);
      });

      this.voiceConnection.on('error', err => {
        logger.error(`[VoiceConn:${this.botConfig.bot_name}] ${err.message}`);
      });

      // Auto-reconnect on disconnect (network blips)
      this.voiceConnection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(this.voiceConnection, VoiceConnectionStatus.Signalling,  5_000),
            entersState(this.voiceConnection, VoiceConnectionStatus.Connecting,  5_000)
          ]);
        } catch {
          this.destroy();
        }
      });

      this.voiceConnection.subscribe(this.audioPlayer);
      logger.info(`[VoiceManager:${this.botConfig.bot_name}] Connected to #${channel.name}`);
    } catch (err) {
      logger.error(`[VoiceManager:${this.botConfig.bot_name}] Connect failed: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Public play() entry point  (called by botInstance.js)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Resolve `query`, enqueue resolved tracks, start playback if idle.
   * @param {string} query        User input (URL or search text)
   * @param {string} requesterTag Discord user tag
   * @returns {{ success: boolean, count?: number, tracks?: Track[], error?: string }}
   */
  async play(query, requesterTag) {
    if (!this.voiceConnection) {
      await this.connect();
    }

    let tracks;
    try {
      tracks = await trackResolver.resolve(query, requesterTag);
    } catch (err) {
      logger.warn(`[AudioManager:${this.botConfig.bot_name}] Resolve failed: ${err.message}`);
      return { success: false, error: err.message };
    }

    if (!tracks || tracks.length === 0) {
      return { success: false, error: `لم يتم العثور على نتائج لـ: "${query}"` };
    }

    this.queue.push(...tracks);

    if (!this.currentTrack) {
      await this._startPlayback();
    } else {
      this.updateDashboard();
    }

    return { success: true, count: tracks.length, tracks };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Internal playback
  // ─────────────────────────────────────────────────────────────────────

  async _startPlayback() {
    if (this.queue.length === 0) {
      this.currentTrack = null;
      this.deleteDashboard();
      return;
    }

    this.currentTrack = this.queue.shift();

    if (!this.currentTrack?.id) {
      logger.error(`[AudioManager] Track has no ID — skipping.`);
      return this._onTrackEnd();
    }

    // Stop current player resource cleanly (don't trigger Idle → _onTrackEnd)
    if (this.audioPlayer) {
      this.audioPlayer.stop(true);
    }

    logger.debug(`[AudioManager:${this.botConfig.bot_name}] Extracting: "${this.currentTrack.title}" [${this.currentTrack.id}]`);
    const start = Date.now();

    try {
      const resource = await extractionEngine.extract(
        this.currentTrack.id,
        this.currentTrack.title
      );

      this.audioResource = resource;
      this.audioPlayer.play(resource);
      await this.updateDashboard(true);

      logger.info(`[AudioManager:${this.botConfig.bot_name}] Playback started in ${Date.now() - start}ms: "${this.currentTrack.title}"`);
    } catch (err) {
      logger.error(`[AudioManager:${this.botConfig.bot_name}] Extraction failed: ${err.message}`);
      // Skip to next track automatically
      this._onTrackEnd();
    }
  }

  _onTrackEnd() {
    if (this.loopMode === 'track' && this.currentTrack) {
      this.queue.unshift(this.currentTrack);
    } else if (this.loopMode === 'queue' && this.currentTrack) {
      this.queue.push(this.currentTrack);
    }
    this._startPlayback();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Controls  (unchanged signatures — botInstance.js calls these)
  // ─────────────────────────────────────────────────────────────────────

  pause() {
    if (this.audioPlayer && !this.isPaused) {
      this.audioPlayer.pause();
      return true;
    }
    return false;
  }

  resume() {
    if (this.audioPlayer && this.isPaused) {
      this.audioPlayer.unpause();
      return true;
    }
    return false;
  }

  skip() {
    if (this.audioPlayer) {
      this.audioPlayer.stop(); // Triggers Idle → _onTrackEnd → next track
      return true;
    }
    return false;
  }

  stop() {
    this.queue        = [];
    this.currentTrack = null;
    if (this.audioPlayer) this.audioPlayer.stop(true);
    this.deleteDashboard();
    return true;
  }

  shuffle() {
    if (this.queue.length <= 1) return false;
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    this.updateDashboard();
    return true;
  }

  toggleLoop() {
    const modes = ['none', 'track', 'queue'];
    this.loopMode = modes[(modes.indexOf(this.loopMode) + 1) % modes.length];
    this.updateDashboard();
    return this.loopMode;
  }

  setVolume(vol) {
    const v = Math.max(0, Math.min(150, vol));
    this.volume = v;
    if (this.audioResource?.volume) {
      this.audioResource.volume.setVolume(v / 100);
    }
    this.updateDashboard();
    return v;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Dashboard
  // ─────────────────────────────────────────────────────────────────────

  async updateDashboard(forceNew = false) {
    if (!this.currentTrack) return;
    try {
      const channel = await this.client.channels.fetch(this.textChannelId);
      if (!channel) return;
      const payload = buildPlayerDashboard(this.currentTrack, {
        isPlaying:   !this.isPaused,
        volume:      this.volume,
        loopMode:    this.loopMode,
        currentTime: this.audioResource?.playbackDuration ?? 0,
        queueLength: this.queue.length
      });
      if (this.dashboardMessage && !forceNew) {
        await this.dashboardMessage.edit(payload);
      } else {
        await this.deleteDashboard();
        this.dashboardMessage = await channel.send(payload);
      }
    } catch {
      this.dashboardMessage = null;
    }
  }

  async deleteDashboard() {
    this._stopDashboardUpdates();
    if (this.dashboardMessage) {
      await this.dashboardMessage.delete().catch(() => {});
      this.dashboardMessage = null;
    }
  }

  _startDashboardUpdates() {
    this._stopDashboardUpdates();
    this.dashboardInterval = setInterval(() => this.updateDashboard(), 10_000);
  }

  _stopDashboardUpdates() {
    if (this.dashboardInterval) {
      clearInterval(this.dashboardInterval);
      this.dashboardInterval = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────

  destroy() {
    this.stop();
    if (this.voiceConnection) {
      try { this.voiceConnection.destroy(); } catch {}
      this.voiceConnection = null;
    }
  }
}
