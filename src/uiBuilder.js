import { EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } from 'discord.js';

/**
 * Generates an ultra-stylish neon progress bar for the dashboard embed.
 */
export function createProgressBar(currentMs, totalMs, size = 16) {
  if (!totalMs || totalMs <= 0) return '`▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ ⚡`';
  const progress = Math.max(0, Math.min(1, currentMs / totalMs));
  const filledLength = Math.round(progress * size);
  const emptyLength = size - filledLength;
  
  const filledBar = '▰'.repeat(filledLength);
  const emptyBar = '▱'.repeat(emptyLength);
  
  return `\`${filledBar}${emptyBar} ⚡\``;
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
 * Builds the interactive Player Dashboard with large album covers and sleek aesthetics.
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
  const durationText = `${formatDuration(currentTime)} ┆ ${formatDuration(totalMs)}`;

  const loopAr = loopMode === 'none' ? '❌ معطل' : loopMode === 'track' ? '🔂 أغنية واحدة' : '🔁 القائمة كاملة';
  const volumeIcon = volume > 70 ? '🔊' : volume > 20 ? '🔉' : '🔈';
  const stateBadge = isPlaying ? '▶️ **يعرض الآن بحيوية**' : '⏸️ **موقوف مؤقتاً**';

  // Creative Neon Color: Electric Magenta when playing, Gold when paused
  const themeColor = isPlaying ? 0xFF0055 : 0xFFB300;

  const embed = new EmbedBuilder()
    .setColor(themeColor)
    .setAuthor({ 
      name: '🎵 شبكة المشغلات الذكية • DASHBOARD 🎵', 
      iconURL: 'https://cdn-icons-png.flaticon.com/512/3844/3844724.png' 
    })
    .setTitle(`✨ ${track.title}`)
    .setURL(track.url || null)
    .setDescription(
      `>>> ${stateBadge}\n\n` +
      `**⏱️ تقدم الأغنية:**\n${progressText}\n\`⏱️ [ ${durationText} ]\``
    )
    .addFields(
      { name: '🎤 الفنان / القناة', value: `\`${track.artist || 'غير معروف'}\``, inline: true },
      { name: '👤 طلب بواسطة', value: `${track.requester || 'النظام'}`, inline: true },
      { name: `${volumeIcon} مستوى الصوت`, value: `\`${volume}%\``, inline: true },
      { name: '🔄 نظام التكرار', value: `${loopAr}`, inline: true },
      { name: '📜 قادم في القائمة', value: `\`${queueLength} أغنية\``, inline: true },
      { name: '🌐 المصدر', value: `\`YouTube / Spotify HD\``, inline: true }
    )
    .setImage(track.thumbnail || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=800&auto=format&fit=crop')
    .setFooter({ 
      text: '🎧 تحكم كامل عبر الأزرار التفاعلية بالأسفل • شبكة الموسيقى الاحترافية',
      iconURL: 'https://cdn-icons-png.flaticon.com/512/461/461238.png'
    })
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
      .setLabel('التالي (سكب)')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('player_stop')
      .setLabel('إنهاء')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId('player_shuffle')
      .setLabel('خلط')
      .setEmoji('🔀')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('player_loop')
      .setLabel('التكرار')
      .setEmoji('🔁')
      .setStyle(loopMode === 'none' ? ButtonStyle.Secondary : ButtonStyle.Success)
  );

  // Action Row 2: Volume & Utilities
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('player_vol_down')
      .setLabel('خفض (-10)')
      .setEmoji('🔉')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('player_vol_up')
      .setLabel('رفع (+10)')
      .setEmoji('🔊')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('player_queue')
      .setLabel('قائمة الانتظار')
      .setEmoji('📜')
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId('player_dismiss')
      .setLabel('إخفاء اللوحة')
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
    .setColor(0x00F0FF)
    .setTitle('👋 أهلاً بك في شبكة الموسيقى المتطورة!')
    .setDescription('دليل الاستخدام السريع لبوتات الموسيقى الصوتية:')
    .addFields(
      { 
        name: '🎵 طريقة التشغيل', 
        value: '1. انضم للروم الصوتي الخاص بالبوت.\n' +
               '2. اكتب الأمر متبوعاً باسم الأغنية أو الرابط.\n' +
               '   *أمثلة:*\n' +
               '   `!ش اسم الاغنية` (بحث يوتيوب مباشر)\n' +
               '   `!ش <رابط يوتيوب>`\n' +
               '   `!ش <رابط سبوتيفاي>`', 
        inline: false 
      },
      { 
        name: '🎛️ أزرار التحكم باللوحة', 
        value: 'عند التشغيل، ستظهر لوحة تحكم تفاعلية مميزة بصورة كبيرة تمكنك من تغيير مستوى الصوت، التخطي، التكرار، وعرض القائمة بضغطة زر.', 
        inline: false 
      }
    )
    .setFooter({ text: 'دليل الاستخدام التفاعلي • يوتيوب وسبوتيفاي حصراً' })
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
 * Builds the interactive Song Enqueued Embed with large artwork.
 */
export function buildEnqueueEmbed(track, queueLength, currentTrack) {
  const embed = new EmbedBuilder()
    .setColor(0xFF0055)
    .setAuthor({ name: '📥 تم إضافة مقطع لقائمة الانتظار', iconURL: 'https://cdn-icons-png.flaticon.com/512/833/833446.png' })
    .setTitle(`✨ ${track.title}`)
    .setURL(track.url || null)
    .setImage(track.thumbnail || null)
    .addFields(
      { name: '👤 طلب بواسطة', value: `${track.requester}`, inline: true },
      { name: '⏳ ترتيب الانتظار', value: `#${queueLength}`, inline: true },
      { name: '🎧 يعمل الآن في الروم', value: currentTrack ? `[${currentTrack.title}](${currentTrack.url})` : 'لا يوجد', inline: false }
    )
    .setFooter({ text: 'انقر سكب بالأسفل لتخطي الأغنية الحالية فوراً' })
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
