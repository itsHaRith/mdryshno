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
import play from 'play-dl';
import { buildPlayerDashboard } from './uiBuilder.js';

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

// Initialize SoundCloud free client ID on module load
play.getFreeClientID().then((clientId) => {
  play.setToken({
    soundcloud: {
      client_id: clientId
    }
  });
  console.log('[AudioManager] SoundCloud Client ID registered successfully.');
}).catch((err) => {
  console.warn('[AudioManager] Failed to initialize SoundCloud Client ID:', err.message);
});

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
   * Adds songs (YouTube queries, YouTube URLs, Spotify URLs) to the queue.
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
        console.warn(`[AudioManager] play.validate failed: ${validateErr.message}. Fallback to text search...`);
        type = 'search';
      }

      if (type === 'yt_video') {
        const info = await play.video_basic_info(query);
        const video = info.video_details;
        resolvedTracks.push(this.formatTrack(video.title, video.url, video.durationInSec * 1000, video.thumbnails[0]?.url, video.channel?.name, requesterTag));
      } 
      else if (type === 'yt_playlist') {
        const playlist = await play.playlist_info(query, { incomplete: true });
        const videos = await playlist.all_videos();
        for (const video of videos) {
          resolvedTracks.push(this.formatTrack(video.title, video.url, video.durationInSec * 1000, video.thumbnails[0]?.url, video.channel?.name, requesterTag));
        }
      } 
      else if (type === 'sp_track') {
        const spotifyData = await play.spotify(query);
        const ytTrack = await this.searchAndResolveSpotify(spotifyData, requesterTag);
        if (ytTrack) resolvedTracks.push(ytTrack);
      } 
      else if (type === 'sp_album' || type === 'sp_playlist') {
        const spotifyData = await play.spotify(query);
        const fetchedTracks = await spotifyData.all_tracks();
        
        // Resolve tracks in parallel chunks to optimize search speed
        const chunk = fetchedTracks.slice(0, 15); // Limit batch size to protect API
        const promises = chunk.map(track => this.searchAndResolveSpotify(track, requesterTag));
        const results = await Promise.all(promises);
        for (const track of results) {
          if (track) resolvedTracks.push(track);
        }
      } 
      else {
        // Assume text query, try YouTube search first
        try {
          const ytSearch = await play.search(query, { limit: 1 });
          if (ytSearch && ytSearch.length > 0) {
            const video = ytSearch[0];
            resolvedTracks.push(this.formatTrack(video.title, video.url, video.durationInSec * 1000, video.thumbnails[0]?.url, video.channel?.name, requesterTag));
          } else {
            throw new Error('No results on YouTube');
          }
        } catch (ytSearchErr) {
          console.warn(`[AudioManager] YouTube search failed: ${ytSearchErr.message}. Trying SoundCloud search...`);
          // Fallback to SoundCloud search directly
          const scSearch = await play.search(query, {
            source: { soundcloud: 'tracks' },
            limit: 1
          });
          if (scSearch && scSearch.length > 0) {
            const track = scSearch[0];
            resolvedTracks.push(this.formatTrack(
              track.title || 'SoundCloud Audio', 
              track.url, 
              (track.duration || 0) * 1000, 
              track.artwork_url, 
              track.publisher?.name || 'SoundCloud Artist', 
              requesterTag
            ));
          } else {
            throw new Error(`Both YouTube and SoundCloud search failed. YouTube error: ${ytSearchErr.message}`);
          }
        }
      }
    } catch (err) {
      console.error(`[AudioManager] Error resolving play query "${query}":`, err.message);
      return { success: false, error: err.message };
    }

    if (resolvedTracks.length === 0) {
      return { success: false, error: 'Could not resolve query to any playable media.' };
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
   * Resolves Spotify metadata into an equivalent streamable YouTube video object.
   */
  async searchAndResolveSpotify(spTrack, requesterTag) {
    const searchString = `${spTrack.name} ${spTrack.artists?.[0]?.name || ''}`;
    try {
      const ytSearch = await play.search(searchString, { limit: 1 });
      if (ytSearch && ytSearch.length > 0) {
        const video = ytSearch[0];
        return this.formatTrack(
          spTrack.name, 
          video.url, 
          spTrack.durationInMs || (video.durationInSec * 1000), 
          spTrack.thumbnail?.url || video.thumbnails[0]?.url, 
          spTrack.artists?.map(a => a.name).join(', ') || video.channel?.name, 
          requesterTag
        );
      }
    } catch (err) {
      console.warn(`[AudioManager] Failed Spotify translation for "${searchString}":`, err.message);
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
      let resource;
      try {
        console.log(`[AudioManager] Attempting play-dl stream for: ${this.currentTrack.title}`);
        const stream = await play.stream(this.currentTrack.url);
        resource = createAudioResource(stream.stream, {
          inputType: stream.type,
          inlineVolume: true
        });
      } catch (streamErr) {
        console.warn(`[AudioManager] play-dl stream failed: ${streamErr.message}. Attempting SoundCloud fallback for: ${this.currentTrack.title}`);
        try {
          const scSearch = await play.search(this.currentTrack.title, { 
            source: { soundcloud: 'tracks' }, 
            limit: 1 
          });
          
          if (scSearch && scSearch.length > 0) {
            const track = scSearch[0];
            console.log(`[AudioManager] Found SoundCloud fallback track: ${track.title || 'SoundCloud Audio'} (${track.url})`);
            const stream = await play.stream(track.url);
            resource = createAudioResource(stream.stream, {
              inputType: stream.type,
              inlineVolume: true
            });
            // Update current track details for the dashboard
            this.currentTrack.title = track.title || this.currentTrack.title;
            this.currentTrack.url = track.url;
            this.currentTrack.artist = track.publisher?.name || 'SoundCloud Artist';
            if (track.artwork_url) {
              this.currentTrack.thumbnail = track.artwork_url;
            }
          } else {
            throw new Error('No results on SoundCloud');
          }
        } catch (scErr) {
          console.error('[AudioManager] SoundCloud fallback failed:', scErr.message);
          throw new Error(`Both YouTube and SoundCloud failed. YouTube error: ${streamErr.message}`);
        }
      }

      this.audioResource = resource;
      this.audioResource.volume.setVolume(this.volume / 100);
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
