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

    this.client.once(Events.ClientReady, async () => {
      logger.info(`[BotInstance] Bot connected: ${this.client.user.tag} (ID: ${this.config.id})`);
      
      // Instantiate and connect the audio manager
      this.audioManager = new AudioManager(this.client, this.config);
      await this.audioManager.connect();
      
      this.initialized = true;
    });

    try {
      await this.client.login(this.config.token);
    } catch (loginErr) {
      if (loginErr.code === 'DisallowedIntents' || loginErr.message?.toLowerCase().includes('disallowed intents')) {
        logger.error(`❌ [BotInstance] Login failed for Bot "${this.config.bot_name}" (ID: ${this.config.id}): Disallowed Gateway Intents.`);
        logger.error(`👉 ACTION REQUIRED: Enable "MESSAGE CONTENT INTENT" and "SERVER MEMBERS INTENT" in the Discord Developer Portal under Bot > Privileged Gateway Intents.`);
      } else {
        logger.error(`❌ [BotInstance] Login failed for Bot "${this.config.bot_name}": ${loginErr.message}`);
      }
    }

    this.client.on('messageCreate', async (message) => {
      if (message.author.bot || !message.guild) return;

      // Deduplication guard: ignore same message if processed already
      if (processedMessages.has(message.id)) return;
      processedMessages.add(message.id);
      if (processedMessages.size > 500) {
        const first = processedMessages.values().next().value;
        processedMessages.delete(first);
      }

      // Ensure message is in the bot's designated server (guild)
      if (message.guild.id !== this.config.guild_id) return;

      // Rule 1: Only allow commands in the main command channel OR the bot's voice channel text chat
      const allowedChannels = ['1457834089133637632', this.config.voice_channel_id];
      if (!allowedChannels.includes(message.channel.id)) return;

      // Rule 2: User must be in the same voice channel as the bot to control it
      const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
      const userVoiceChannelId = member?.voice?.channelId;
      if (userVoiceChannelId !== this.config.voice_channel_id) return;

      logger.debug(`[BotInstance] Message accepted by bot ${this.config.bot_name} in channel ${message.channel.id}: "${message.content}"`);

      const content = message.content.trim();
      const lowerContent = content.toLowerCase();

      // Fetch dynamic prefix
      const prefix = await getPrefix(this.config.id, this.config.prefix);

      // Check if command starts with the active prefix
      if (content.startsWith(prefix)) {
        const args = content.slice(prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        // 1. Play Command (Plays songs/Spotify)
        if (command === 'play' || command === 'p' || command === 'ش') {
          if (args.length === 0) {
            return message.reply(`❌ يرجى كتابة اسم الأغنية أو الرابط.`);
          }

          const query = args.join(' ');
          
          // Dynamically redirect the player dashboard to the text channel where the play command was typed
          this.audioManager.textChannelId = message.channel.id;
          
          const feedbackMsg = await message.reply('🔍 جاري البحث والتشغيل...');
          
          // Check if there's already a currentTrack playing BEFORE we add the new one
          const wasPlaying = this.audioManager.currentTrack !== null;
          
          const result = await this.audioManager.play(query, message.author.tag);
          
          if (result.success) {
            if (wasPlaying && result.tracks && result.tracks.length > 0) {
              const addedTrack = result.tracks[0];
              const { buildEnqueueEmbed } = await import('./uiBuilder.js');
              const enqueuePayload = buildEnqueueEmbed(addedTrack, this.audioManager.queue.length, this.audioManager.currentTrack);
              
              await feedbackMsg.edit(enqueuePayload);
              // Let the enqueued card stay for 12 seconds
              setTimeout(() => feedbackMsg.delete().catch(() => {}), 12000);
            } else {
              await feedbackMsg.edit(`✅ تم البدء في التشغيل.`);
              setTimeout(() => feedbackMsg.delete().catch(() => {}), 4000);
            }
          } else {
            await feedbackMsg.edit(`❌ خطأ: لم يتم العثور على المقطع الصوتي.`);
            setTimeout(() => feedbackMsg.delete().catch(() => {}), 4000);
          }
        } 

        // 1.5. Skip Command
        else if (command === 'skip' || command === 's' || command === 'س' || command === 'سكب' || command === 'سكيب') {
          if (!this.audioManager || !this.audioManager.currentTrack) {
            return message.reply('❌ لا يوجد شيء يعمل حالياً.');
          }
          this.audioManager.skip();
          return message.reply('⏭️ تم السكب.');
        }

        // 1.6. Pause / Resume Command
        else if (command === 'pause' || command === 't' || command === 'ت') {
          if (!this.audioManager || !this.audioManager.currentTrack) {
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
        
        // 2. Dynamic Help & Master Control Commands (Admins Only)
        else if (command === 'help' || command === 'admin-commands') {
          const userIsAdmin = await isAdmin(message.member);

          if (!userIsAdmin) {
            const reply = await message.reply('❌ هذا الأمر مخصص للمشرفين فقط.');
            setTimeout(() => {
              reply.delete().catch(() => {});
              message.delete().catch(() => {});
            }, 5000);
            return;
          }

          const adminEmbed = buildAdminHelpEmbed(this.config);
          return message.channel.send(adminEmbed);
        }

        // 3. Admin Dynamic Prefix commands via text
        else if (command === 'prefix') {
          const userIsAdmin = await isAdmin(message.member);
          if (!userIsAdmin) {
            const reply = await message.reply('❌ هذا الأمر مخصص للمشرفين فقط.');
            setTimeout(() => reply.delete().catch(() => {}), 5000);
            return;
          }

          if (args.length === 0) {
            return message.reply(`الاختصار الحالي للبوت هو: \`${prefix}\`. اكتب \`${prefix}prefix <الاختصار الجديد>\` لتغييره.`);
          }

          const newPrefix = args[0];
          const result = await setPrefix(this.config.id, newPrefix);
          if (result.success) {
            this.config.prefix = newPrefix;
            return message.reply(`✅ تم تحديث الاختصار إلى \`${newPrefix}\`.`);
          } else {
            return message.reply(`❌ فشل تحديث الاختصار: ${result.error}`);
          }
        }
      }
    });

    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isButton()) return;

      const { customId } = interaction;

      // Handle Tutorial Onboarding Button Clicks
      if (customId.startsWith('tutorial_')) {
        if (customId === 'tutorial_how_to_play') {
          return interaction.reply({
            content: `🎵 **طريقة التشغيل:**\n1. ادخل للروم الصوتي <#${this.config.voice_channel_id}>.\n2. اكتب \`${this.config.prefix}ش <الأغنية>\` في الروم الكتابي العام أو شات الروم الصوتي.\n3. يدعم روابط يوتيوب وسبوتيفاي وساوندكلاود!`,
            ephemeral: true
          });
        }
        
        if (customId === 'tutorial_buttons_guide') {
          return interaction.reply({
            content: `🎛️ **دليل الأزرار:**\n` +
                     `- ⏸️/▶️: إيقاف مؤقت / تشغيل الأغنية.\n` +
                     `- ⏭️: تخطي الأغنية الحالية.\n` +
                     `- ⏹️: إيقاف التشغيل كلياً ومغادرة الروم.\n` +
                     `- 🔀: ترتيب عشوائي للقائمة.\n` +
                     `- 🔁: تكرار الأغنية أو القائمة.\n` +
                     `- 🔉/🔊: خفض أو رفع مستوى الصوت.\n` +
                     `- 📜: عرض قائمة الانتظار.`,
            ephemeral: true
          });
        }

        if (customId === 'tutorial_queue_help') {
          return interaction.reply({
            content: `❓ **القائمة:**\nاضغط على زر 📜 لعرض الأغاني القادمة. يمكنك إضافة المزيد من الأغاني بمجرد البحث عنها في الشات.`,
            ephemeral: true
          });
        }
      }

      // Handle Dashboard Player Button Clicks
      if (customId.startsWith('player_')) {
        if (!this.audioManager || !this.audioManager.currentTrack) {
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
            return interaction.reply({ content: '⏹️ تم إيقاف التشغيل وتصفير القائمة.', ephemeral: true });

          case 'player_shuffle':
            const shuffled = this.audioManager.shuffle();
            return interaction.reply({ 
              content: shuffled ? '🔀 تم خلط القائمة عشوائياً!' : '❌ لا توجد أغاني كافية لخلط القائمة.', 
              ephemeral: true 
            });

          case 'player_loop':
            const mode = this.audioManager.toggleLoop();
            const modeAr = mode === 'none' ? 'معطل' : mode === 'track' ? 'أغنية' : 'قائمة';
            return interaction.reply({ content: `🔁 تم تحديث وضع التكرار إلى: **${modeAr}**`, ephemeral: true });

          case 'player_vol_down':
            const vDown = this.audioManager.setVolume(this.audioManager.volume - 10);
            return interaction.reply({ content: `🔉 تم خفض الصوت إلى **${vDown}%**`, ephemeral: true });

          case 'player_vol_up':
            const vUp = this.audioManager.setVolume(this.audioManager.volume + 10);
            return interaction.reply({ content: `🔊 تم رفع الصوت إلى **${vUp}%**`, ephemeral: true });

          case 'player_queue':
            const q = this.audioManager.queue;
            if (q.length === 0) {
              return interaction.reply({ content: '📜 قائمة الانتظار فارغة حالياً.', ephemeral: true });
            }
            const list = q.slice(0, 10).map((t, idx) => `${idx + 1}. **${t.title}** (بواسطة: *${t.requester}*)`).join('\n');
            const total = q.length > 10 ? `\n*...و ${q.length - 10} أغاني أخرى.*` : '';
            return interaction.reply({ 
              content: `📜 **الأغاني القادمة:**\n${list}${total}`, 
              ephemeral: true 
            });

          case 'player_dismiss':
            await this.audioManager.deleteDashboard();
            return interaction.reply({ content: '❌ تم إخفاء لوحة التحكم.', ephemeral: true });
        }
      }

      // Handle Admin Button Clicks
      if (customId.startsWith('admin_btn_')) {
        const userIsAdmin = await isAdmin(interaction.member);
        if (!userIsAdmin) {
          return interaction.reply({ 
            content: '❌ هذا الأمر مخصص للمشرفين فقط.', 
            ephemeral: true 
          });
        }

        if (customId === 'admin_btn_change_prefix') {
          return interaction.reply({
            content: `✏️ لتغيير الاختصار، اكتب \`${this.config.prefix}prefix <الاختصار الجديد>\` في هذا الشات.`,
            ephemeral: true
          });
        }

        if (customId === 'admin_btn_reboot') {
          await interaction.reply({ content: '🔄 جاري إعادة التشغيل...', ephemeral: true });
          if (this.audioManager) {
            this.audioManager.destroy();
          }
          this.audioManager = new AudioManager(this.client, this.config);
          await this.audioManager.connect();
          return interaction.followUp({ content: '✅ تم إعادة تشغيل البوت بنجاح.', ephemeral: true });
        }

        if (customId === 'admin_btn_sync') {
          return interaction.reply({
            content: `📥 التزامن التلقائي نشط. الروم الصوتي الحالي: <#${this.config.voice_channel_id}>`,
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
