import { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource, 
  AudioPlayerStatus, 
  VoiceConnectionStatus,
  entersState,
  StreamType,
  getVoiceConnection
} from '@discordjs/voice';
import { Readable } from 'stream';
import play from 'play-dl';
import ytdl from '@distube/ytdl-core';
import ffmpeg from 'ffmpeg-static';
import { Innertube } from 'youtubei.js';
import { buildPlayerDashboard } from './uiBuilder.js';
import { USER_YOUTUBE_COOKIES } from './config/youtubeCookies.js';
import { fetchYoutubeAuth } from './config/supabaseClient.js';

// Ensure ffmpeg binary path is registered for @discordjs/voice audio probing and transcoding
if (ffmpeg) {
  process.env.FFMPEG_PATH = ffmpeg;
}

// Register SoundCloud Client ID on startup
play.getFreeClientID().then((id) => {
  play.setToken({
    soundcloud: {
      client_id: id
    }
  });
  console.log('[AudioManager] SoundCloud free Client ID registered successfully.');
}).catch((err) => {
  console.warn('[AudioManager] Failed to register SoundCloud Client ID:', err.message);
});

const isPlaceholder = (val) => typeof val === 'string' && (
  val.includes('YOUR_COOKIE') || 
  val.includes('YOUR_PO_TOKEN') || 
  val.includes('YOUR_VISITOR') || 
  val.includes('ضع_هنا') || 
  val.trim().length === 0
);

async function getValidYouTubeAuth() {
  const dbAuth = await fetchYoutubeAuth();
  const fallbackCookieString = USER_YOUTUBE_COOKIES.map(c => `${c.name}=${c.value}`).join('; ');
  
  const cookieHeader = (dbAuth?.cookie_header && !isPlaceholder(dbAuth.cookie_header))
    ? dbAuth.cookie_header
    : fallbackCookieString;

  const poToken = (dbAuth?.po_token && !isPlaceholder(dbAuth.po_token))
    ? dbAuth.po_token
    : undefined;

  const visitorData = (dbAuth?.visitor_data && !isPlaceholder(dbAuth.visitor_data))
    ? dbAuth.visitor_data
    : undefined;

  return { cookieHeader, poToken, visitorData };
}

let innertubeInstance = null;
async function getInnertube() {
  if (!innertubeInstance) {
    try {
      const auth = await getValidYouTubeAuth();
      innertubeInstance = await Innertube.create({
        cookie: auth.cookieHeader,
        po_token: auth.poToken,
        visitor_data: auth.visitorData,
        generate_session_locally: true
      });
      console.log('[AudioManager] Authenticated Innertube instance created with local session generation.');
    } catch (e) {
      console.warn('[AudioManager] Failed to initialize Innertube YouTube client:', e.message);
    }
  }
  return innertubeInstance;
}

// Register YouTube session cookie in play-dl engine
getValidYouTubeAuth().then((auth) => {
  play.setToken({
    youtube: {
      cookie: auth.cookieHeader
    }
  }).then(() => {
    console.log('[AudioManager] Registered YouTube session cookie in play-dl.');
  }).catch((err) => {
    console.warn('[AudioManager] Failed to set play-dl youtube cookie:', err.message);
  });
});

// Initialize Spotify client if credentials exist in environment variables
if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
  play.setToken({
    spotify: {
      client_id: process.env.SPOTIFY_CLIENT_ID,
      client_secret: process.env.SPOTIFY_CLIENT_SECRET,
      market: 'US'
    }
  }).then(() => {
    console.log('[AudioManager] Spotify credentials registered successfully.');
  }).catch((err) => {
    console.warn('[AudioManager] Spotify credential initialization failed. Falling back to public scraper:', err.message);
  });
}

// Initialize YouTube cookies if present in environment variables (required to bypass bot validation)
if (process.env.YOUTUBE_COOKIE) {
  play.setToken({
    youtube: {
      cookie: process.env.YOUTUBE_COOKIE
    }
  }).then(() => {
    console.log('[AudioManager] YouTube cookies registered successfully.');
  }).catch((err) => {
    console.warn('[AudioManager] Failed to register YouTube cookies:', err.message);
  });
}



export class AudioManager {
  constructor(client, botConfig) {
    this.client = client;
    this.botConfig = botConfig;
    this.guildId = botConfig.guild_id;
    this.voiceChannelId = botConfig.voice_channel_id;
    this.textChannelId = botConfig.text_channel_id;

    this.queue = [];
    this.currentTrack = null;
    this.volume = 100;
    this.loopMode = 'none'; // 'none' | 'track' | 'queue'
    this.isPaused = false;

    this.voiceConnection = null;
    this.audioPlayer = null;
    this.audioResource = null;
    this.dashboardMessage = null;
    this.dashboardInterval = null;

    this.initializeAudioPlayer();
  }

  /**
   * Initializes the discord.js voice audio player and its event listeners.
   */
  initializeAudioPlayer() {
    this.audioPlayer = createAudioPlayer();

    this.audioPlayer.on('stateChange', (oldState, newState) => {
      console.log(`[Debug Player] Bot ${this.botConfig.bot_name} state changed from ${oldState.status} to ${newState.status}`);
    });

    this.audioPlayer.on(AudioPlayerStatus.Playing, () => {
      this.isPaused = false;
      this.startDashboardUpdates();
    });

    this.audioPlayer.on(AudioPlayerStatus.Paused, () => {
      this.isPaused = true;
      this.updateDashboard();
    });

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      this.stopDashboardUpdates();
      this.handleTrackEnd();
    });

    this.audioPlayer.on('error', (error) => {
      console.error(`[AudioManager] Error on bot ${this.botConfig.bot_name}:`, error.message);
      this.stopDashboardUpdates();
      this.handleTrackEnd();
    });
  }

  /**
   * Connects the bot to its designated voice channel.
   */
  async connect() {
    try {
      const channel = await this.client.channels.fetch(this.voiceChannelId);
      if (!channel || !channel.isVoiceBased()) {
        throw new Error(`Channel ${this.voiceChannelId} is not a valid voice channel.`);
      }

      // Disconnect any server-side ghost session on Discord before initializing local voice connection
      const guild = channel.guild;
      const me = guild.members.me || await guild.members.fetch(this.client.user.id).catch(() => null);
      if (me && me.voice.channelId) {
        console.log(`[AudioManager] Bot is already registered in voice channel ${me.voice.channelId} on Discord servers. Disconnecting to reset session...`);
        try {
          await me.voice.disconnect();
          await new Promise(resolve => setTimeout(resolve, 1500));
        } catch (e) {
          console.warn('[AudioManager] Failed to disconnect server voice session:', e.message);
        }
      }

      this.voiceConnection = joinVoiceChannel({
        channelId: this.voiceChannelId,
        guildId: this.guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false
      });

      this.voiceConnection.on('stateChange', (oldState, newState) => {
        console.log(`[Debug Connection] Bot ${this.botConfig.bot_name} state changed from ${oldState.status} to ${newState.status}`);
      });

      this.voiceConnection.on('error', (error) => {
        console.error(`[AudioManager] VoiceConnection error on bot ${this.botConfig.bot_name}:`, error.message);
      });

      this.voiceConnection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          // Attempt reconnection if disconnected
          await Promise.race([
            entersState(this.voiceConnection, VoiceConnectionStatus.Signalling, 5000),
            entersState(this.voiceConnection, VoiceConnectionStatus.Connecting, 5000)
          ]);
        } catch {
          // Reconnection failed, cleanup
          this.destroy();
        }
      });

      this.voiceConnection.subscribe(this.audioPlayer);
      console.log(`[AudioManager] Bot ${this.botConfig.bot_name} joined and locked Voice Channel: ${channel.name}`);
    } catch (err) {
      console.error(`[AudioManager] Bot ${this.botConfig.bot_name} failed to join Voice Channel:`, err.message);
    }
  }

  /**
   * Adds songs (SoundCloud queries, SoundCloud URLs, Spotify URLs, YouTube links) to the queue.
   */
  async play(query, requesterTag) {
    if (!this.voiceConnection) {
      await this.connect();
    }

    const resolvedTracks = [];

    try {
      let type;
      try {
        type = await play.validate(query);
      } catch (validateErr) {
        type = 'search';
      }

      if (type === 'so_track') {
        const scData = await play.soundcloud(query);
        resolvedTracks.push(this.formatTrack(
          scData.name,
          scData.url || query,
          scData.durationInMs || 0,
          scData.thumbnail || null,
          scData.user?.name || 'SoundCloud',
          requesterTag
        ));
      }
      else if (type === 'sp_track') {
        const spotifyData = await play.spotify(query);
        const scTrack = await this.searchAndResolveSoundCloud(`${spotifyData.name} ${spotifyData.artists?.[0]?.name || ''}`, requesterTag);
        if (scTrack) resolvedTracks.push(scTrack);
      }
      else if (type === 'sp_album' || type === 'sp_playlist') {
        const spotifyData = await play.spotify(query);
        const fetchedTracks = await spotifyData.all_tracks();
        
        const chunk = fetchedTracks.slice(0, 15);
        const promises = chunk.map(track => this.searchAndResolveSoundCloud(`${track.name} ${track.artists?.[0]?.name || ''}`, requesterTag));
        const results = await Promise.all(promises);
        for (const track of results) {
          if (track) resolvedTracks.push(track);
        }
      }
      else if (query.includes('youtube.com') || query.includes('youtu.be')) {
        try {
          const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(query)}&format=json`);
          if (oembedRes.ok) {
            const data = await oembedRes.json();
            const scTrack = await this.searchAndResolveSoundCloud(data.title, requesterTag);
            if (scTrack) resolvedTracks.push(scTrack);
          } else {
            const scTrack = await this.searchAndResolveSoundCloud(query, requesterTag);
            if (scTrack) resolvedTracks.push(scTrack);
          }
        } catch (e) {
          const scTrack = await this.searchAndResolveSoundCloud(query, requesterTag);
          if (scTrack) resolvedTracks.push(scTrack);
        }
      }
      else {
        // Text query: Search SoundCloud directly
        const scTrack = await this.searchAndResolveSoundCloud(query, requesterTag);
        if (scTrack) resolvedTracks.push(scTrack);
      }
    } catch (err) {
      console.error(`[AudioManager] Error resolving play query "${query}":`, err.message);
      return { success: false, error: err.message };
    }

    if (resolvedTracks.length === 0) {
      return { success: false, error: 'Could not resolve query on SoundCloud.' };
    }

    this.queue.push(...resolvedTracks);

    if (!this.currentTrack) {
      await this.startPlayback();
    } else {
      this.updateDashboard();
    }

    return { success: true, count: resolvedTracks.length, tracks: resolvedTracks };
  }

  /**
   * Resolves search query metadata into an equivalent streamable SoundCloud track object.
   */
  async searchAndResolveSoundCloud(searchString, requesterTag) {
    try {
      const scSearch = await play.search(searchString, { source: { soundcloud: 'tracks' }, limit: 1 });
      if (scSearch && scSearch.length > 0) {
        const track = scSearch[0];
        const streamUrl = track.url || track.permalink_url || track.permalink;
        return this.formatTrack(
          track.name,
          streamUrl,
          track.durationInMs || ((track.durationInSec || 0) * 1000),
          track.thumbnail || null,
          track.user?.name || track.publisher?.artist || 'SoundCloud',
          requesterTag
        );
      }
    } catch (err) {
      console.warn(`[AudioManager] SoundCloud search failed for "${searchString}":`, err.message);
    }
    return null;
  }

  formatTrack(title, url, durationMS, thumbnail, artist, requester) {
    return { title, url, durationMS, thumbnail, artist, requester };
  }

  /**
   * Begins streaming the first item in the queue.
   */
  async startPlayback() {
    if (this.queue.length === 0) {
      this.currentTrack = null;
      this.deleteDashboard();
      return;
    }

    this.currentTrack = this.queue.shift();

    if (this.audioPlayer) {
      this.audioPlayer.stop(true);
    }

    try {
      console.log(`[AudioManager] Streaming SoundCloud audio for: ${this.currentTrack.title} (${this.currentTrack.url})`);
      const stream = await play.stream(this.currentTrack.url);
      
      const resource = createAudioResource(stream.stream, {
        inputType: stream.type,
        inlineVolume: false
      });

      this.audioResource = resource;
      if (this.audioResource.volume) {
        this.audioResource.volume.setVolume(this.volume / 100);
      }
      this.audioPlayer.play(this.audioResource);

      await this.updateDashboard(true);
    } catch (err) {
      console.error('[AudioManager] Stream creation error:', err.message);
      this.handleTrackEnd();
    }
  }

  /**
   * Handles track ending: supports skip, loopModes (track / queue), or starts next song.
   */
  handleTrackEnd() {
    if (this.loopMode === 'track' && this.currentTrack) {
      // Loop the active track: put it back at the front of queue
      this.queue.unshift(this.currentTrack);
    } else if (this.loopMode === 'queue' && this.currentTrack) {
      // Loop queue: put it back at the end of queue
      this.queue.push(this.currentTrack);
    }

    this.startPlayback();
  }

  // Controls
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
      this.audioPlayer.stop(); // Stops current resource, triggers Idle and starts next track
      return true;
    }
    return false;
  }

  stop() {
    this.queue = [];
    this.currentTrack = null;
    if (this.audioPlayer) {
      this.audioPlayer.stop(true);
    }
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
    const nextIndex = (modes.indexOf(this.loopMode) + 1) % modes.length;
    this.loopMode = modes[nextIndex];
    this.updateDashboard();
    return this.loopMode;
  }

  setVolume(vol) {
    const nextVol = Math.max(0, Math.min(150, vol));
    this.volume = nextVol;
    if (this.audioResource && this.audioResource.volume) {
      this.audioResource.volume.setVolume(nextVol / 100);
    }
    this.updateDashboard();
    return nextVol;
  }

  /**
   * Refreshes or creates the interactive Embed dashboard.
   */
  async updateDashboard(forceNew = false) {
    if (!this.currentTrack) return;

    const channel = await this.client.channels.fetch(this.textChannelId);
    if (!channel) return;

    const payload = buildPlayerDashboard(this.currentTrack, {
      isPlaying: !this.isPaused,
      volume: this.volume,
      loopMode: this.loopMode,
      currentTime: this.audioResource ? this.audioResource.playbackDuration : 0,
      queueLength: this.queue.length
    });

    try {
      if (this.dashboardMessage && !forceNew) {
        await this.dashboardMessage.edit(payload);
      } else {
        // Delete old UI before posting new
        this.deleteDashboard();
        this.dashboardMessage = await channel.send(payload);
      }
    } catch (err) {
      // In case message was deleted or channels missing
      this.dashboardMessage = null;
    }
  }

  async deleteDashboard() {
    this.stopDashboardUpdates();
    if (this.dashboardMessage) {
      try {
        await this.dashboardMessage.delete();
      } catch {
        // Message already deleted
      }
      this.dashboardMessage = null;
    }
  }

  startDashboardUpdates() {
    this.stopDashboardUpdates();
    // Update progress bar every 10 seconds to reduce rate limits
    this.dashboardInterval = setInterval(() => {
      this.updateDashboard();
    }, 10000);
  }

  stopDashboardUpdates() {
    if (this.dashboardInterval) {
      clearInterval(this.dashboardInterval);
      this.dashboardInterval = null;
    }
  }

  destroy() {
    this.stop();
  }
}
