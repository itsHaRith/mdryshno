import { EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } from 'discord.js';

/**
 * Generates a dynamic progress bar for the dashboard embed.
 */
export function createProgressBar(currentMs, totalMs, size = 15) {
  if (!totalMs || totalMs <= 0) return '`[🔘▬▬▬▬▬▬▬▬▬▬▬▬▬▬]`';
  const progress = Math.max(0, Math.min(1, currentMs / totalMs));
  const index = Math.round(progress * size);
  let bar = '';
  for (let i = 0; i <= size; i++) {
    if (i === index) {
      bar += '🔘';
    } else {
      bar += '▬';
    }
  }
  return `\`[${bar}]\``;
}

/**
 * Formats milliseconds to human-readable duration (MM:SS or HH:MM:SS)
 */
export function formatDuration(ms) {
  if (!ms || isNaN(ms)) return '00:00';
  const sec = Math.floor((ms / 1000) % 60);
  const min = Math.floor((ms / 60000) % 60);
  const hrs = Math.floor(ms / 3600000);
  
  const fSec = sec < 10 ? `0${sec}` : sec;
  const fMin = min < 10 ? `0${min}` : min;
  
  return hrs > 0 ? `${hrs}:${fMin}:${fSec}` : `${fMin}:${fSec}`;
}

/**
 * Builds the interactive Player Dashboard.
 */
export function buildPlayerDashboard(track, statusInfo) {
  const { 
    isPlaying = true, 
    volume = 100, 
    loopMode = 'none', // 'none' | 'track' | 'queue'
    currentTime = 0,
    queueLength = 0
  } = statusInfo;

  const totalMs = track.durationMS || 0;
  const progressText = createProgressBar(currentTime, totalMs);
  const durationText = `${formatDuration(currentTime)} / ${formatDuration(totalMs)}`;

  const loopAr = loopMode === 'none' ? 'معطل' : loopMode === 'track' ? 'أغنية' : 'قائمة';

  const embed = new EmbedBuilder()
    .setColor(isPlaying ? 0x00FF87 : 0xFFB300)
    .setTitle(`🎶 المشغل الحالي: ${track.title}`)
    .setURL(track.url || null)
    .setThumbnail(track.thumbnail || null)
    .addFields(
      { name: '👤 الفنان', value: track.artist || 'غير معروف', inline: true },
      { name: '📥 بواسطة', value: track.requester || 'النظام', inline: true },
      { name: '🔊 الصوت', value: `${volume}%`, inline: true },
      { name: '🔄 التكرار', value: loopAr, inline: true },
      { name: '📜 القائمة', value: `${queueLength} أغنية`, inline: true },
      { name: '⏱️ الوقت', value: `${progressText}\n*${durationText}*`, inline: false }
    )
    .setFooter({ text: 'شبكة الموسيقى • أزرار تحكم تفاعلية' })
    .setTimestamp();

  // Action Row 1: Playback State Controls
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('player_play_pause')
      .setLabel(isPlaying ? 'إيقاف مؤقت' : 'تشغيل')
      .setEmoji(isPlaying ? '⏸️' : '▶️')
      .setStyle(isPlaying ? ButtonStyle.Primary : ButtonStyle.Success),
    
    new ButtonBuilder()
      .setCustomId('player_skip')
      .setLabel('سكب')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('player_stop')
      .setLabel('إيقاف')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId('player_shuffle')
      .setLabel('عشوائي')
      .setEmoji('🔀')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('player_loop')
      .setLabel(`تكرار: ${loopAr}`)
      .setEmoji('🔁')
      .setStyle(loopMode === 'none' ? ButtonStyle.Secondary : ButtonStyle.Success)
  );

  // Action Row 2: Volume & Utilities
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('player_vol_down')
      .setLabel('خفض الصوت')
      .setEmoji('🔉')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('player_vol_up')
      .setLabel('رفع الصوت')
      .setEmoji('🔊')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('player_queue')
      .setLabel('القائمة')
      .setEmoji('📜')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('player_dismiss')
      .setLabel('إخفاء')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

/**
 * Builds the interactive tutorial onboarding embed triggered by "HI!".
 */
export function buildTutorialEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0x7289DA)
    .setTitle('👋 أهلاً بك في شبكة الموسيقى!')
    .setDescription('دليل استخدام سريع لبوتات الموسيقى:')
    .addFields(
      { 
        name: '🎵 طريقة التشغيل', 
        value: '1. انضم للروم الصوتي الخاص بالبوت.\n' +
               '2. اكتب الأمر متبوعاً باسم الأغنية أو الرابط.\n' +
               '   *أمثلة:*\n' +
               '   `!ش حسين غزال`\n' +
               '   `!ش <رابط سبوتيفاي>`\n' +
               '   `!ش <رابط يوتيوب>`', 
        inline: false 
      },
      { 
        name: '🎛️ أزرار التحكم باللوحة', 
        value: 'عند التشغيل، ستظهر لوحة تحكم تفاعلية تمكنك من تغيير مستوى الصوت، التخطي، التكرار، وعرض القائمة بضغطة زر.', 
        inline: false 
      },
      { 
        name: '⚙️ خيارات الإدارة', 
        value: 'يمكن للمشرفين إعداد الاختصارات وتعديل الغرف البرمجية عبر الأمر `!help`.', 
        inline: false 
      }
    )
    .setFooter({ text: 'دليل الاستخدام التفاعلي' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('tutorial_how_to_play')
      .setLabel('طريقة التشغيل')
      .setStyle(ButtonStyle.Primary),
    
    new ButtonBuilder()
      .setCustomId('tutorial_buttons_guide')
      .setLabel('دليل الأزرار')
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId('tutorial_queue_help')
      .setLabel('مساعدة')
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Builds the Administrator-Only Help and configuration embed.
 */
export function buildAdminHelpEmbed(botConfig) {
  const statusAr = botConfig.status === 'online' ? 'نشط' : botConfig.status === 'busy' ? 'مشغول' : 'غير متصل';

  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('⚙️ لوحة تحكم الإدارة')
    .setDescription('إدارة وتعديل هذا البوت في الوقت الفعلي:')
    .addFields(
      { name: '🤖 معرف البوت', value: `\`${botConfig.id}\``, inline: true },
      { name: '🏷️ الاسم', value: `${botConfig.bot_name}`, inline: true },
      { name: '⚡ الاختصار', value: `\`${botConfig.prefix}\``, inline: true },
      { name: '📊 حالة المحرك', value: `\`${statusAr}\``, inline: true },
      { name: '🔊 الروم الصوتي', value: `<#${botConfig.voice_channel_id}>`, inline: true },
      { name: '💬 الروم الكتابي', value: `<#${botConfig.text_channel_id}>`, inline: true }
    )
    .setFooter({ text: 'لوحة التحكم الإدارية • تزامن Supabase' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('admin_btn_change_prefix')
      .setLabel('تغيير الاختصار')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId('admin_btn_reboot')
      .setLabel('إعادة التشغيل')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId('admin_btn_sync')
      .setLabel('تزامن قاعدة البيانات')
      .setEmoji('📥')
      .setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Builds the interactive Song Enqueued Embed.
 */
export function buildEnqueueEmbed(track, queueLength, currentTrack) {
  const embed = new EmbedBuilder()
    .setColor('#FF0055')
    .setTitle('📥 تم إضافة الأغنية لقائمة الانتظار')
    .setDescription(`**[${track.title}](${track.url})**\n⏱️ *انتظر تخلص الأغنية الفوق يلا تشتغل هاي.*`)
    .setThumbnail(track.thumbnail || null)
    .addFields(
      { name: '👤 طلب بواسطة', value: `${track.requester}`, inline: true },
      { name: '⏳ ترتيب الانتظار', value: `#${queueLength}`, inline: true },
      { name: '🎧 يعمل الآن', value: currentTrack ? `[${currentTrack.title}](${currentTrack.url})` : 'لا يوجد', inline: false }
    )
    .setFooter({ text: 'شبكة الموسيقى • انقر سكب لتخطي الأغنية الحالية' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('player_skip')
      .setLabel('سكب الأغنية الحالية')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row] };
}

