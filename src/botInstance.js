import { Client, GatewayIntentBits, Events } from 'discord.js';
import { AudioManager } from './audioManager.js';
import { getPrefix, setPrefix, isAdmin } from './adminMiddleware.js';
import { buildTutorialEmbed, buildAdminHelpEmbed } from './uiBuilder.js';
import { logger } from './utils/logger.js';

const processedMessages = new Set();

export class BotInstance {
  constructor(botConfig) {
    this.config = botConfig;
    this.client = null;
    this.audioManager = null;
    this.initialized = false;
  }

  /**
   * Logs in and starts the bot client instance.
   * Only ONE login() call — duplicate removed.
   * On ready: renames the voice channel to match bot_name.
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

    // ── Ready handler ────────────────────────────────────────────────────
    this.client.once(Events.ClientReady, async () => {
      logger.info(`[BotInstance] ✅ Bot connected: ${this.client.user.tag} | Bot: ${this.config.bot_name}`);

      // 1. Rename voice channel to match bot name
      await this._syncVoiceChannelName();

      // 2. Connect to voice
      this.audioManager = new AudioManager(this.client, this.config);
      await this.audioManager.connect();

      this.initialized = true;
    });

    // ── Register all event listeners before login ────────────────────────
    this._registerMessageHandler();
    this._registerInteractionHandler();

    // ── ONE login call — do NOT add another at the bottom ────────────────
    try {
      await this.client.login(this.config.token);
    } catch (loginErr) {
      if (
        loginErr.code === 'DisallowedIntents' ||
        loginErr.message?.toLowerCase().includes('disallowed intents')
      ) {
        logger.error(
          `❌ [BotInstance] Login failed for "${this.config.bot_name}": Disallowed Gateway Intents.\n` +
          `👉 Go to Discord Developer Portal → Bot → Privileged Gateway Intents → enable MESSAGE CONTENT INTENT.`
        );
      } else if (loginErr.message?.toLowerCase().includes('token')) {
        logger.error(
          `❌ [BotInstance] Login failed for "${this.config.bot_name}": Invalid token.\n` +
          `👉 Check the token in Supabase bots table for this bot.`
        );
      } else {
        logger.error(`❌ [BotInstance] Login failed for "${this.config.bot_name}": ${loginErr.message}`);
      }
      // Do NOT re-throw — botWorker auto-restarts after 5 seconds
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Rename voice channel to match bot_name
  // ─────────────────────────────────────────────────────────────────────

  async _syncVoiceChannelName() {
    const desiredName = this.config.bot_name;
    if (!desiredName || !this.config.voice_channel_id) return;

    try {
      const channel = await this.client.channels.fetch(this.config.voice_channel_id);
      if (!channel?.isVoiceBased()) return;

      if (channel.name === desiredName) {
        logger.debug(`[BotInstance] Voice channel name already matches: "${desiredName}"`);
        return;
      }

      await channel.setName(desiredName);
      logger.info(`[BotInstance] ✅ Voice channel renamed to: "${desiredName}"`);
    } catch (err) {
      // Missing permissions is common — warn but don't crash
      logger.warn(
        `[BotInstance] ⚠ Could not rename voice channel to "${desiredName}": ${err.message}\n` +
        `  → Give the bot "Manage Channels" permission in Discord.`
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Message handler
  // ─────────────────────────────────────────────────────────────────────

  _registerMessageHandler() {
    this.client.on('messageCreate', async (message) => {
      if (message.author.bot || !message.guild) return;

      // Deduplication guard
      if (processedMessages.has(message.id)) return;
      processedMessages.add(message.id);
      if (processedMessages.size > 500) {
        processedMessages.delete(processedMessages.values().next().value);
      }

      // Only respond in this bot's guild
      if (message.guild.id !== this.config.guild_id) return;

      // Only allow commands in the command channel OR the voice channel text chat
      const allowedChannels = ['1457834089133637632', this.config.voice_channel_id];
      if (!allowedChannels.includes(message.channel.id)) return;

      // User must be in the same voice channel as the bot
      const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
      const userVoiceChannelId = member?.voice?.channelId;
      if (userVoiceChannelId !== this.config.voice_channel_id) return;

      logger.debug(`[BotInstance:${this.config.bot_name}] Command: "${message.content}"`);

      const content = message.content.trim();
      const prefix  = await getPrefix(this.config.id, this.config.prefix);
      if (!content.startsWith(prefix)) return;

      const args    = content.slice(prefix.length).trim().split(/ +/);
      const command = args.shift().toLowerCase();

      // ── !play / !ش ──────────────────────────────────────────────────
      if (command === 'play' || command === 'p' || command === 'ش') {
        if (args.length === 0) {
          return message.reply('❌ يرجى كتابة اسم الأغنية أو الرابط.');
        }

        const query = args.join(' ');
        this.audioManager.textChannelId = message.channel.id;

        const feedbackMsg = await message.reply('🔍 جاري البحث والتحميل...');
        const wasPlaying  = this.audioManager.currentTrack !== null;
        const result      = await this.audioManager.play(query, message.author.tag);

        if (result.success) {
          if (wasPlaying && result.tracks?.length > 0) {
            const { buildEnqueueEmbed } = await import('./uiBuilder.js');
            const payload = buildEnqueueEmbed(result.tracks[0], this.audioManager.queue.length, this.audioManager.currentTrack);
            await feedbackMsg.edit(payload);
            setTimeout(() => feedbackMsg.delete().catch(() => {}), 12000);
          } else {
            await feedbackMsg.edit('✅ تم البدء في التشغيل.');
            setTimeout(() => feedbackMsg.delete().catch(() => {}), 4000);
          }
        } else {
          await feedbackMsg.edit(`❌ خطأ: ${result.error ?? 'لم يتم العثور على المقطع الصوتي.'}`);
          setTimeout(() => feedbackMsg.delete().catch(() => {}), 4000);
        }
      }

      // ── !skip / !س ──────────────────────────────────────────────────
      else if (['skip','s','س','سكب','سكيب'].includes(command)) {
        if (!this.audioManager?.currentTrack) {
          return message.reply('❌ لا يوجد شيء يعمل حالياً.');
        }
        this.audioManager.skip();
        return message.reply('⏭️ تم السكب.');
      }

      // ── !pause / !ت ─────────────────────────────────────────────────
      else if (['pause','t','ت'].includes(command)) {
        if (!this.audioManager?.currentTrack) {
          return message.reply('❌ لا يوجد شيء يعمل حالياً.');
        }
        if (this.audioManager.isPaused) {
          this.audioManager.resume();
          return message.reply('▶️ تم الاستئناف.');
        } else {
          this.audioManager.pause();
          return message.reply('⏸️ تم الإيقاف المؤقت.');
        }
      }

      // ── !help ────────────────────────────────────────────────────────
      else if (['help','admin-commands'].includes(command)) {
        const userIsAdmin = await isAdmin(message.member);
        if (!userIsAdmin) {
          const reply = await message.reply('❌ هذا الأمر مخصص للمشرفين فقط.');
          setTimeout(() => { reply.delete().catch(() => {}); message.delete().catch(() => {}); }, 5000);
          return;
        }
        return message.channel.send(buildAdminHelpEmbed(this.config));
      }

      // ── !prefix ──────────────────────────────────────────────────────
      else if (command === 'prefix') {
        const userIsAdmin = await isAdmin(message.member);
        if (!userIsAdmin) {
          const reply = await message.reply('❌ هذا الأمر مخصص للمشرفين فقط.');
          setTimeout(() => reply.delete().catch(() => {}), 5000);
          return;
        }
        if (args.length === 0) {
          return message.reply(`الاختصار الحالي: \`${prefix}\`. اكتب \`${prefix}prefix <الاختصار الجديد>\` لتغييره.`);
        }
        const newPrefix = args[0];
        const res = await setPrefix(this.config.id, newPrefix);
        if (res.success) {
          this.config.prefix = newPrefix;
          return message.reply(`✅ تم تحديث الاختصار إلى \`${newPrefix}\`.`);
        } else {
          return message.reply(`❌ فشل تحديث الاختصار: ${res.error}`);
        }
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Interaction (button) handler
  // ─────────────────────────────────────────────────────────────────────

  _registerInteractionHandler() {
    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isButton()) return;
      const { customId } = interaction;

      // Tutorial buttons
      if (customId.startsWith('tutorial_')) {
        if (customId === 'tutorial_how_to_play') {
          return interaction.reply({
            content:
              `🎵 **طريقة التشغيل:**\n` +
              `1. ادخل للروم الصوتي <#${this.config.voice_channel_id}>.\n` +
              `2. اكتب \`${this.config.prefix}ش <الأغنية>\` في الشات.\n` +
              `3. يدعم روابط يوتيوب وأسماء الأغاني!`,
            ephemeral: true
          });
        }
        if (customId === 'tutorial_buttons_guide') {
          return interaction.reply({
            content:
              `🎛️ **دليل الأزرار:**\n` +
              `- ⏸️/▶️: إيقاف مؤقت / تشغيل.\n` +
              `- ⏭️: تخطي الأغنية.\n` +
              `- ⏹️: إيقاف كلي.\n` +
              `- 🔀: خلط القائمة.\n` +
              `- 🔁: تكرار.\n` +
              `- 🔉/🔊: الصوت.\n` +
              `- 📜: قائمة الانتظار.`,
            ephemeral: true
          });
        }
        if (customId === 'tutorial_queue_help') {
          return interaction.reply({
            content: `❓ **القائمة:** اضغط 📜 لعرض الأغاني القادمة.`,
            ephemeral: true
          });
        }
      }

      // Player dashboard buttons
      if (customId.startsWith('player_')) {
        if (!this.audioManager?.currentTrack) {
          return interaction.reply({ content: '❌ لا يوجد شيء يعمل حالياً.', ephemeral: true });
        }

        switch (customId) {
          case 'player_play_pause':
            if (this.audioManager.isPaused) {
              this.audioManager.resume();
              return interaction.reply({ content: '▶️ تم الاستئناف!', ephemeral: true });
            } else {
              this.audioManager.pause();
              return interaction.reply({ content: '⏸️ تم الإيقاف المؤقت!', ephemeral: true });
            }

          case 'player_skip':
            this.audioManager.skip();
            return interaction.reply({ content: '⏭️ تم السكب.', ephemeral: true });

          case 'player_stop':
            this.audioManager.stop();
            return interaction.reply({ content: '⏹️ تم إيقاف التشغيل.', ephemeral: true });

          case 'player_shuffle': {
            const shuffled = this.audioManager.shuffle();
            return interaction.reply({
              content: shuffled ? '🔀 تم خلط القائمة!' : '❌ لا توجد أغاني كافية.',
              ephemeral: true
            });
          }

          case 'player_loop': {
            const mode = this.audioManager.toggleLoop();
            const modeAr = mode === 'none' ? 'معطل' : mode === 'track' ? 'أغنية' : 'قائمة';
            return interaction.reply({ content: `🔁 وضع التكرار: **${modeAr}**`, ephemeral: true });
          }

          case 'player_vol_down': {
            const v = this.audioManager.setVolume(this.audioManager.volume - 10);
            return interaction.reply({ content: `🔉 الصوت: **${v}%**`, ephemeral: true });
          }

          case 'player_vol_up': {
            const v = this.audioManager.setVolume(this.audioManager.volume + 10);
            return interaction.reply({ content: `🔊 الصوت: **${v}%**`, ephemeral: true });
          }

          case 'player_queue': {
            const q = this.audioManager.queue;
            if (q.length === 0) {
              return interaction.reply({ content: '📜 قائمة الانتظار فارغة.', ephemeral: true });
            }
            const list  = q.slice(0, 10).map((t, i) => `${i + 1}. **${t.title}** (${t.requester})`).join('\n');
            const extra = q.length > 10 ? `\n*...و ${q.length - 10} أغاني أخرى.*` : '';
            return interaction.reply({ content: `📜 **الأغاني القادمة:**\n${list}${extra}`, ephemeral: true });
          }

          case 'player_dismiss':
            await this.audioManager.deleteDashboard();
            return interaction.reply({ content: '❌ تم إخفاء لوحة التحكم.', ephemeral: true });
        }
      }

      // Admin buttons
      if (customId.startsWith('admin_btn_')) {
        const userIsAdmin = await isAdmin(interaction.member);
        if (!userIsAdmin) {
          return interaction.reply({ content: '❌ هذا الأمر للمشرفين فقط.', ephemeral: true });
        }

        if (customId === 'admin_btn_change_prefix') {
          return interaction.reply({
            content: `✏️ اكتب \`${this.config.prefix}prefix <الاختصار>\` لتغييره.`,
            ephemeral: true
          });
        }

        if (customId === 'admin_btn_reboot') {
          await interaction.reply({ content: '🔄 جاري إعادة التشغيل...', ephemeral: true });
          if (this.audioManager) this.audioManager.destroy();
          this.audioManager = new AudioManager(this.client, this.config);
          await this.audioManager.connect();
          return interaction.followUp({ content: '✅ تم إعادة التشغيل بنجاح.', ephemeral: true });
        }

        if (customId === 'admin_btn_sync') {
          return interaction.reply({
            content: `📥 الروم الصوتي الحالي: <#${this.config.voice_channel_id}>`,
            ephemeral: true
          });
        }
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Live config update (called by IPC from botMaster)
  // ─────────────────────────────────────────────────────────────────────

  async updateConfiguration(newConfig) {
    logger.info(`[BotInstance:${this.config.bot_name}] Live config update received.`);

    const voiceChanged = newConfig.voice_channel_id !== this.config.voice_channel_id;
    const nameChanged  = newConfig.bot_name !== this.config.bot_name;

    this.config = { ...this.config, ...newConfig };

    if (this.audioManager) {
      this.audioManager.botConfig    = this.config;
      this.audioManager.textChannelId = this.config.text_channel_id;

      if (voiceChanged) {
        logger.info(`[BotInstance:${this.config.bot_name}] Voice channel changed — reconnecting.`);
        this.audioManager.voiceChannelId = this.config.voice_channel_id;
        this.audioManager.stop();
        await this.audioManager.connect();
      }
    }

    // Re-sync voice channel name if bot_name or voice_channel_id changed
    if (nameChanged || voiceChanged) {
      await this._syncVoiceChannelName();
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Graceful cleanup
  // ─────────────────────────────────────────────────────────────────────

  destroy() {
    if (this.audioManager) this.audioManager.destroy();
    if (this.client) this.client.destroy();
  }
}
