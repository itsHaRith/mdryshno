import { Client, GatewayIntentBits, MessageFlags } from 'discord.js';
import { AudioManager } from './audioManager.js';
import { getPrefix, setPrefix, isAdmin } from './adminMiddleware.js';
import { buildTutorialEmbed, buildAdminHelpEmbed } from './uiBuilder.js';

export class BotInstance {
  constructor(botConfig) {
    this.config = botConfig;
    this.client = null;
    this.audioManager = null;
    this.initialized = false;
  }

  /**
   * Logs in and starts the bot client instance.
   */
  async start() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ]
    });

    this.client.once('ready', async () => {
      console.log(`[BotInstance] Bot logged in: ${this.client.user.tag} (ID: ${this.config.id})`);
      
      // Instantiate and connect the audio manager
      this.audioManager = new AudioManager(this.client, this.config);
      await this.audioManager.connect();
      
      this.initialized = true;
    });

    this.client.on('messageCreate', async (message) => {
      if (message.author.bot || !message.guild) return;

      console.log(`[Debug] Message received from ${message.author.tag} in channel ${message.channel.id} (Config Guild: ${this.config.guild_id}): "${message.content}"`);

      // Ensure message is in the bot's designated server (guild)
      if (message.guild.id !== this.config.guild_id) return;

      const content = message.content.trim();
      const lowerContent = content.toLowerCase();

      // Requirement 1: Interactive Onboarding Tutorial "HI!" / "hi" listener
      if (lowerContent === 'hi' || lowerContent === 'hi!') {
        const payload = buildTutorialEmbed();
        return message.channel.send(payload);
      }

      // Fetch dynamic prefix
      const prefix = await getPrefix(this.config.id, this.config.prefix);

      // Check if command starts with the active prefix
      if (content.startsWith(prefix)) {
        const args = content.slice(prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        // 1. Play Command (Plays songs/Spotify)
        if (command === 'play' || command === 'p') {
          if (args.length === 0) {
            return message.reply(`❌ Please provide a song title or link. Example: \`${prefix}play lo-fi\``);
          }

          const query = args.join(' ');
          
          // Dynamically redirect the player dashboard to the text channel where the play command was typed
          this.audioManager.textChannelId = message.channel.id;
          
          const feedbackMsg = await message.reply('🔍 Searching and resolving audio track...');
          
          const result = await this.audioManager.play(query, message.author.tag);
          
          if (result.success) {
            await feedbackMsg.edit(`✅ Enqueued **${result.count}** song(s) successfully!`);
            // Auto delete enqueued notification after 5s to keep chat clean
            setTimeout(() => feedbackMsg.delete().catch(() => {}), 5000);
          } else {
            await feedbackMsg.edit(`❌ Error enqueuing track: ${result.error}`);
          }
        } 
        
        // 2. Dynamic Help & Master Control Commands
        else if (command === 'help' || command === 'admin-commands') {
          const userIsAdmin = await isAdmin(message.member);

          if (userIsAdmin) {
            // Requirement 2: Administrators see the Master Admin panel
            const adminEmbed = buildAdminHelpEmbed(this.config);
            return message.channel.send(adminEmbed);
          } else {
            // Non-admin triggers: Send user guide in channel but delete quickly, or direct message (private ephemeral helper)
            try {
              await message.author.send(
                `👋 **Music Network Guide for ${this.client.user.username}**\n\n` +
                `• Use \`${prefix}play <song>\` to queue Spotify tracks, playlists, or YouTube links.\n` +
                `• Live controls (Pause, Skip, Volume, etc.) are available on the dashboard in <#${this.config.text_channel_id}>.\n` +
                `• Normal users cannot access admin tools or prefixes.`
              );
              const notify = await message.reply('📬 A basic user guide has been sent to your Direct Messages!');
              setTimeout(() => {
                notify.delete().catch(() => {});
                message.delete().catch(() => {});
              }, 6000);
            } catch {
              // Direct Messages are blocked, reply with warning
              const warn = await message.reply('❌ Could not DM you the guide. Please enable direct messages from server members.');
              setTimeout(() => warn.delete().catch(() => {}), 8000);
            }
          }
        }

        // 3. Admin Dynamic Prefix commands via text
        else if (command === 'prefix') {
          const userIsAdmin = await isAdmin(message.member);
          if (!userIsAdmin) {
            return message.reply({ 
              content: '❌ This command directory is restricted to Administrators only.', 
              flags: MessageFlags.Ephemeral 
            }).catch(async () => {
              // Fallback if message flags are not supported in standard text replies
              const reply = await message.reply('❌ This command directory is restricted to Administrators only.');
              setTimeout(() => reply.delete().catch(() => {}), 8000);
            });
          }

          if (args.length === 0) {
            return message.reply(`Current prefix is: \`${prefix}\`. Use \`${prefix}prefix <newPrefix>\` to change it.`);
          }

          const newPrefix = args[0];
          const result = await setPrefix(this.config.id, newPrefix);
          if (result.success) {
            this.config.prefix = newPrefix;
            return message.reply(`✅ Prefix updated to \`${newPrefix}\`. Re-caching across instances.`);
          } else {
            return message.reply(`❌ Failed to update prefix: ${result.error}`);
          }
        }
      }
    });

    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isButton()) return;

      const { customId } = interaction;

      // Handle Tutorial Onboarding Button Clicks (Requirement 1 - Ephemeral responses)
      if (customId.startsWith('tutorial_')) {
        if (customId === 'tutorial_how_to_play') {
          return interaction.reply({
            content: `🎵 **How to Play:**\n1. Connect to voice channel <#${this.config.voice_channel_id}>.\n2. Type \`${this.config.prefix}play <song title or URL>\` in <#${this.config.text_channel_id}>.\n3. Works with Spotify songs, albums, playlists, and YouTube!`,
            ephemeral: true
          });
        }
        
        if (customId === 'tutorial_buttons_guide') {
          return interaction.reply({
            content: `🎛️ **Dashboard Buttons Guide:**\n` +
                     `- ⏸️/▶️: Toggle between Pause and Resume.\n` +
                     `- ⏭️: Skip current song.\n` +
                     `- ⏹️: Stop stream and clear queue.\n` +
                     `- 🔀: Shuffle songs currently in queue.\n` +
                     `- 🔁: Toggle loop modes (Track, Queue, Off).\n` +
                     `- 🔉/🔊: Decrease / Increase volume levels.\n` +
                     `- 📜: View tracks pending execution.`,
            ephemeral: true
          });
        }

        if (customId === 'tutorial_queue_help') {
          return interaction.reply({
            content: `❓ **Queue Management:**\nPress the 📜 button on the Dashboard at any time to get a transient list of upcoming tracks. Add tracks in queue by simply querying more music!`,
            ephemeral: true
          });
        }
      }

      // Handle Dashboard Player Button Clicks (Requirement 3 - Ephemeral feedback)
      if (customId.startsWith('player_')) {
        if (!this.audioManager || !this.audioManager.currentTrack) {
          return interaction.reply({ content: '❌ No music is currently playing.', ephemeral: true });
        }

        switch (customId) {
          case 'player_play_pause':
            if (this.audioManager.isPaused) {
              this.audioManager.resume();
              return interaction.reply({ content: '▶️ Playback resumed!', ephemeral: true });
            } else {
              this.audioManager.pause();
              return interaction.reply({ content: '⏸️ Playback paused!', ephemeral: true });
            }

          case 'player_skip':
            this.audioManager.skip();
            return interaction.reply({ content: '⏭️ Skipped current song.', ephemeral: true });

          case 'player_stop':
            this.audioManager.stop();
            return interaction.reply({ content: '⏹️ Playback stopped and disconnected.', ephemeral: true });

          case 'player_shuffle':
            const shuffled = this.audioManager.shuffle();
            return interaction.reply({ 
              content: shuffled ? '🔀 Queue shuffled!' : '❌ Not enough tracks to shuffle.', 
              ephemeral: true 
            });

          case 'player_loop':
            const mode = this.audioManager.toggleLoop();
            return interaction.reply({ content: `🔁 Loop mode updated to: **${mode.toUpperCase()}**`, ephemeral: true });

          case 'player_vol_down':
            const vDown = this.audioManager.setVolume(this.audioManager.volume - 10);
            return interaction.reply({ content: `🔉 Volume reduced to **${vDown}%**`, ephemeral: true });

          case 'player_vol_up':
            const vUp = this.audioManager.setVolume(this.audioManager.volume + 10);
            return interaction.reply({ content: `🔊 Volume increased to **${vUp}%**`, ephemeral: true });

          case 'player_queue':
            const q = this.audioManager.queue;
            if (q.length === 0) {
              return interaction.reply({ content: '📜 Queue is currently empty.', ephemeral: true });
            }
            const list = q.slice(0, 10).map((t, idx) => `${idx + 1}. **${t.title}** (Requested by: *${t.requester}*)`).join('\n');
            const total = q.length > 10 ? `\n*...and ${q.length - 10} more tracks.*` : '';
            return interaction.reply({ 
              content: `📜 **Upcoming Songs:**\n${list}${total}`, 
              ephemeral: true 
            });

          case 'player_dismiss':
            await this.audioManager.deleteDashboard();
            return interaction.reply({ content: '❌ Player Dashboard dismissed from chat.', ephemeral: true });
        }
      }

      // Handle Admin Button Clicks
      if (customId.startsWith('admin_btn_')) {
        const userIsAdmin = await isAdmin(interaction.member);
        if (!userIsAdmin) {
          return interaction.reply({ 
            content: '❌ This command directory is restricted to Administrators only.', 
            ephemeral: true 
          });
        }

        if (customId === 'admin_btn_change_prefix') {
          return interaction.reply({
            content: `✏️ To change prefix, type \`${this.config.prefix}prefix <newPrefix>\` in this channel.`,
            ephemeral: true
          });
        }

        if (customId === 'admin_btn_reboot') {
          await interaction.reply({ content: '🔄 Re-initializing connection nodes...', ephemeral: true });
          if (this.audioManager) {
            this.audioManager.destroy();
          }
          this.audioManager = new AudioManager(this.client, this.config);
          await this.audioManager.connect();
          return interaction.followUp({ content: '✅ Bot instance re-booted and connected.', ephemeral: true });
        }

        if (customId === 'admin_btn_sync') {
          return interaction.reply({
            content: `📥 Realtime updates are active. Local details: VC=<#${this.config.voice_channel_id}>, TC=<#${this.config.text_channel_id}>`,
            ephemeral: true
          });
        }
      }
    });

    try {
      await this.client.login(this.config.token);
    } catch (err) {
      console.error(`[BotInstance] Login failed for bot ID ${this.config.id}:`, err.message);
    }
  }

  /**
   * Triggers live reconfiguration of properties (called by the Realtime listener)
   */
  async updateConfiguration(newConfig) {
    console.log(`[BotInstance] Dynamic update triggered for Bot ${this.config.id}`);
    
    const voiceChanged = newConfig.voice_channel_id !== this.config.voice_channel_id;
    const textChanged = newConfig.text_channel_id !== this.config.text_channel_id;

    // Apply config overrides
    this.config = { ...this.config, ...newConfig };

    if (this.audioManager) {
      this.audioManager.botConfig = this.config;
      this.audioManager.textChannelId = this.config.text_channel_id;

      if (voiceChanged) {
        console.log(`[BotInstance] Voice channel target changed. Relocating bot...`);
        this.audioManager.voiceChannelId = this.config.voice_channel_id;
        
        // Stop current resource and join new voice channel
        this.audioManager.stop();
        await this.audioManager.connect();
      }
    }
  }

  /**
   * Graceful cleanup
   */
  destroy() {
    if (this.audioManager) {
      this.audioManager.destroy();
    }
    if (this.client) {
      this.client.destroy();
    }
  }
}
