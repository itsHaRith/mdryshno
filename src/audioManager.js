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

// Ensure ffmpeg binary path is registered for @discordjs/voice audio probing and transcoding
if (ffmpeg) {
  process.env.FFMPEG_PATH = ffmpeg;
}

// Create authenticated ytdl agent using user session cookies
let ytdlCookieAgent = null;
try {
  ytdlCookieAgent = ytdl.createAgent(USER_YOUTUBE_COOKIES);
  console.log('[AudioManager] Authenticated YouTube Cookie Agent initialized successfully.');
} catch (agentErr) {
  console.warn('[AudioManager] Failed to initialize ytdl Cookie Agent:', agentErr.message);
}

let innertubeInstance = null;
async function getInnertube() {
  if (!innertubeInstance) {
    try {
      innertubeInstance = await Innertube.create();
    } catch (e) {
      console.warn('[AudioManager] Failed to initialize Innertube YouTube client:', e.message);
    }
  }
  return innertubeInstance;
}

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
   * Adds songs (YouTube queries, YouTube URLs, Spotify URLs) to the queue.
   */
  async play(query, requesterTag) {
    if (!this.voiceConnection) {
      await this.connect();
    }

    const resolvedTracks = [];

    try {
      const ytMatch = query.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([\w-]{11})/);
      const directVideoId = ytMatch ? ytMatch[1] : null;

      if (directVideoId) {
        try {
          const videoUrl = `https://www.youtube.com/watch?v=${directVideoId}`;
          const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`);
          if (oembedRes.ok) {
            const data = await oembedRes.json();
            console.log(`[AudioManager] oEmbed resolved title for ${directVideoId}: "${data.title}"`);
            resolvedTracks.push(this.formatTrack(
              data.title || 'YouTube Video',
              videoUrl,
              0,
              data.thumbnail_url || null,
              data.author_name || 'YouTube',
              requesterTag
            ));
          } else {
            throw new Error(`oEmbed status ${oembedRes.status}`);
          }
        } catch (ytUrlErr) {
          console.warn(`[AudioManager] oEmbed video info resolution failed for ${directVideoId}: ${ytUrlErr.message}. Fallback to Innertube...`);
          try {
            const yt = await getInnertube();
            const info = await yt.getBasicInfo(directVideoId);
            const details = info.basic_info;
            const realTitle = typeof details.title === 'string' ? details.title : (details.title?.text || `YouTube Video (${directVideoId})`);
            resolvedTracks.push(this.formatTrack(
              realTitle,
              `https://www.youtube.com/watch?v=${directVideoId}`,
              (details.duration || 0) * 1000,
              details.thumbnail?.[0]?.url,
              details.author || 'YouTube',
              requesterTag
            ));
          } catch (e2) {
            resolvedTracks.push(this.formatTrack(`YouTube Video (${directVideoId})`, `https://www.youtube.com/watch?v=${directVideoId}`, 0, null, 'YouTube', requesterTag));
          }
        }
      } 
      else {
        let type;
        try {
          type = await play.validate(query);
        } catch (validateErr) {
          type = 'search';
        } 

        if (type === 'yt_playlist') {
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
        // Text query: search YouTube ONLY (Innertube first, then play.search fallback)
        try {
          const yt = await getInnertube();
          let ytVideo = null;

          if (yt) {
            const searchRes = await yt.search(query);
            if (searchRes && searchRes.videos && searchRes.videos.length > 0) {
              ytVideo = searchRes.videos[0];
            }
          }

          if (ytVideo) {
            const title = typeof ytVideo.title === 'string' ? ytVideo.title : (ytVideo.title?.text || query);
            const videoUrl = `https://www.youtube.com/watch?v=${ytVideo.id}`;
            const durationMs = (ytVideo.duration?.seconds || 0) * 1000;
            const thumbnail = ytVideo.thumbnails?.[0]?.url;
            const author = ytVideo.author?.name || 'YouTube';
            resolvedTracks.push(this.formatTrack(title, videoUrl, durationMs, thumbnail, author, requesterTag));
          } else {
            const ytSearch = await play.search(query, { limit: 1 });
            if (ytSearch && ytSearch.length > 0) {
              const video = ytSearch[0];
              resolvedTracks.push(this.formatTrack(video.title, video.url, video.durationInSec * 1000, video.thumbnails[0]?.url, video.channel?.name, requesterTag));
            } else {
              throw new Error('No video found on YouTube.');
            }
          }
        } catch (ytSearchErr) {
          console.error(`[AudioManager] YouTube search failed for "${query}":`, ytSearchErr.message);
          throw new Error(`لم يتم العثور على نتائج في يوتيوب لـ: "${query}"`);
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
      const yt = await getInnertube();
      if (yt) {
        const searchRes = await yt.search(searchString);
        if (searchRes && searchRes.videos && searchRes.videos.length > 0) {
          const video = searchRes.videos[0];
          const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;
          return this.formatTrack(
            spTrack.name, 
            videoUrl, 
            spTrack.durationInMs || ((video.duration?.seconds || 0) * 1000), 
            spTrack.thumbnail?.url || video.thumbnails?.[0]?.url, 
            spTrack.artists?.map(a => a.name).join(', ') || video.author?.name, 
            requesterTag
          );
        }
      }

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
      let resource = null;
      let lastErr = null;
      const clientRotationList = ['ANDROID', 'IOS', 'WEB_CREATOR', 'TVHTML5_SIMPLY_EMBEDDED', 'WEB'];

      for (const clientName of clientRotationList) {
        try {
          console.log(`[AudioManager] Streaming YouTube audio via client [${clientName}] for: ${this.currentTrack.title}`);
          const stream = ytdl(this.currentTrack.url, {
            client: clientName,
            agent: ytdlCookieAgent || undefined,
            highWaterMark: 1 << 25
          });

          resource = createAudioResource(stream, {
            inputType: StreamType.Arbitrary,
            inlineVolume: false
          });

          if (resource) break;
        } catch (cErr) {
          lastErr = cErr;
          console.warn(`[AudioManager] Client [${clientName}] stream failed: ${cErr.message}`);
        }
      }

      if (!resource) {
        try {
          console.log(`[AudioManager] Client rotation exhausted. Trying Innertube stream fallback for: ${this.currentTrack.title}`);
          const yt = await getInnertube();
          const ytMatch = this.currentTrack.url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([\w-]{11})/);
          const videoId = ytMatch ? ytMatch[1] : null;

          if (yt && videoId) {
            const webStream = await yt.download(videoId, { type: 'audio', quality: 'best' });
            const nodeStream = Readable.fromWeb(webStream);
            resource = createAudioResource(nodeStream, {
              inputType: StreamType.Arbitrary,
              inlineVolume: false
            });
          }
        } catch (inErr) {
          console.warn(`[AudioManager] Innertube download fallback failed: ${inErr.message}`);
        }
      }

      if (!resource) {
        throw lastErr || new Error('Unable to extract playable YouTube audio stream');
      }

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
