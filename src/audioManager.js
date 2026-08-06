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
import ytdl from 'ytdl-core-enhanced';
import ffmpeg from 'ffmpeg-static';
import { Innertube } from 'youtubei.js';
import { buildPlayerDashboard } from './uiBuilder.js';
import { USER_YOUTUBE_COOKIES } from './config/youtubeCookies.js';
import { fetchYoutubeAuth } from './config/supabaseClient.js';

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
   * Adds songs (SoundCloud queries, SoundCloud URLs, Spotify URLs) to the queue.
   */
  /**
   * Adds songs (YouTube queries, YouTube URLs) to the queue.
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
        const videoUrl = `https://www.youtube.com/watch?v=${directVideoId}`;
        try {
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
          console.warn(`[AudioManager] oEmbed info resolution failed for ${directVideoId}: ${ytUrlErr.message}. Fallback to direct URL format.`);
          resolvedTracks.push(this.formatTrack(`YouTube Video (${directVideoId})`, videoUrl, 0, null, 'YouTube', requesterTag));
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
            const videoId = video.id || (video.url ? video.url.match(/v=([\w-]{11})/)?.[1] : null);
            if (videoId) {
              const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
              resolvedTracks.push(this.formatTrack(video.title, video.url, (video.durationInSec || 0) * 1000, video.thumbnails?.[0]?.url, video.channel?.name, requesterTag));
            }
          }
        } 
        else {
          // Text search query: execute play.search first to guarantee valid video.id and video.url
          try {
            console.log(`[AudioManager] Searching YouTube for text query: "${query}"`);
            const ytSearch = await play.search(query, { limit: 1 });
            
            if (ytSearch && ytSearch.length > 0 && (ytSearch[0].id || ytSearch[0].url)) {
              const video = ytSearch[0];
              const videoId = video.id || (video.url ? video.url.match(/v=([\w-]{11})/)?.[1] : null);
              
              if (!videoId) {
                throw new Error(`Extracted search result had invalid video ID: ${JSON.stringify(video)}`);
              }

              const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
              console.log(`[AudioManager] Search resolved valid YouTube URL: "${videoUrl}" for title: "${video.title}"`);
              
              resolvedTracks.push(this.formatTrack(
                video.title || query,
                videoUrl,
                (video.durationInSec || 0) * 1000,
                video.thumbnails?.[0]?.url || null,
                video.channel?.name || 'YouTube',
                requesterTag
              ));
            } else {
              // Fallback to Innertube search with strict video_id extraction
              console.warn(`[AudioManager] play.search returned empty for "${query}". Falling back to Innertube search...`);
              const yt = await getInnertube();
              if (yt) {
                const searchRes = await yt.search(query);
                if (searchRes && searchRes.videos && searchRes.videos.length > 0) {
                  const ytVideo = searchRes.videos[0];
                  const videoId = ytVideo.video_id || ytVideo.id || (typeof ytVideo.endpoint?.payload?.videoId === 'string' ? ytVideo.endpoint.payload.videoId : null);
                  
                  if (videoId) {
                    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
                    const realTitle = typeof ytVideo.title === 'string' ? ytVideo.title : (ytVideo.title?.text || query);
                    resolvedTracks.push(this.formatTrack(
                      realTitle,
                      videoUrl,
                      (ytVideo.duration?.seconds || 0) * 1000,
                      ytVideo.thumbnails?.[0]?.url || null,
                      ytVideo.author?.name || 'YouTube',
                      requesterTag
                    ));
                  }
                }
              }
            }

            if (resolvedTracks.length === 0) {
              throw new Error(`No valid YouTube video URL could be resolved for query: "${query}"`);
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
      return { success: false, error: 'Could not resolve query to any playable YouTube media.' };
    }

    this.queue.push(...resolvedTracks);

    if (!this.currentTrack) {
      await this.startPlayback();
    } else {
      this.updateDashboard();
    }

    return { success: true, count: resolvedTracks.length, tracks: resolvedTracks };
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

    // Extract and validate YouTube Video ID before any stream extraction attempt
    const ytMatch = this.currentTrack.url ? this.currentTrack.url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([\w-]{11})/) : null;
    const selectedVideoId = ytMatch ? ytMatch[1] : null;

    console.log('[AudioManager] Stream Extraction Diagnostic:', {
      query: this.currentTrack.requester || 'User Request',
      selectedTitle: this.currentTrack.title,
      selectedVideoId: selectedVideoId,
      selectedUrl: this.currentTrack.url
    });

    if (!selectedVideoId) {
      console.error(`[AudioManager] CRITICAL: Invalid YouTube URL encountered in queue: "${this.currentTrack.url}". Skipping track.`);
      return this.handleTrackEnd();
    }

    // Re-normalize URL to standard YouTube watch link
    const cleanWatchUrl = `https://www.youtube.com/watch?v=${selectedVideoId}`;
    this.currentTrack.url = cleanWatchUrl;

    try {
      let resource = null;
      let lastErr = null;
      const clientRotationList = ['TVHTML5_SIMPLY_EMBEDDED', 'IOS', 'WEB_CREATOR', 'ANDROID', 'WEB'];

      // Fetch dynamic validated Supabase session authentication (cookieHeader, poToken, visitorData)
      const auth = await getValidYouTubeAuth();
      const poToken = auth.poToken;
      const visitorData = auth.visitorData;

      for (const clientName of clientRotationList) {
        try {
          console.log(`[AudioManager] Interrogating YouTube client [${clientName}] for videoId [${selectedVideoId}]: ${this.currentTrack.title}`);
          const info = await ytdl.getInfo(cleanWatchUrl, { 
            requestOptions: {
              headers: {
                cookie: auth.cookieHeader
              }
            }
          });
          const formats = info?.formats || [];
          const targetFormat = formats.find(f => f.hasAudio && f.url) || formats[0];

          if (targetFormat && targetFormat.url) {
            console.log(`[AudioManager] Client [${clientName}] returned valid audio stream format (itag: ${targetFormat.itag})`);
            const stream = ytdl.downloadFromInfo(info, { format: targetFormat, highWaterMark: 1 << 25 });
            resource = createAudioResource(stream, {
              inputType: StreamType.Arbitrary,
              inlineVolume: false
            });
            if (resource) break;
          }
        } catch (cErr) {
          lastErr = cErr;
          console.warn(`[AudioManager] Client [${clientName}] failed for videoId [${selectedVideoId}]: ${cErr.message}`);
        }
      }

      if (!resource) {
        try {
          console.log(`[AudioManager] Client rotation fallback to play.stream for videoId [${selectedVideoId}]: ${this.currentTrack.title}`);
          const stream = await play.stream(cleanWatchUrl, {
            discordPlayerCompatibility: true,
            htmldata: false
          });
          resource = createAudioResource(stream.stream, {
            inputType: stream.type,
            inlineVolume: false
          });
        } catch (playErr) {
          console.warn(`[AudioManager] play.stream fallback failed: ${playErr.message}`);
        }
      }

      if (!resource) {
        try {
          console.log(`[AudioManager] Client rotation fallback to Innertube for videoId [${selectedVideoId}]: ${this.currentTrack.title}`);
          const yt = await getInnertube();
          if (yt && selectedVideoId) {
            const webStream = await yt.download(selectedVideoId, { type: 'audio', quality: 'best' });
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
        throw lastErr || new Error(`Unable to extract playable YouTube audio stream for videoId [${selectedVideoId}]`);
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
