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
 * Displays title, artist, progress bar, thumbnail, requester tag, and control buttons.
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

  const embed = new EmbedBuilder()
    .setColor(isPlaying ? 0x00FF87 : 0xFFB300) // Vibrant teal green or amber warning
    .setTitle(`🎶 Now Playing: ${track.title}`)
    .setURL(track.url || null)
    .setThumbnail(track.thumbnail || null)
    .addFields(
      { name: '👤 Artist', value: track.artist || 'Unknown Artist', inline: true },
      { name: '📥 Requested By', value: track.requester || 'System', inline: true },
      { name: '🔊 Volume', value: `${volume}%`, inline: true },
      { name: '🔄 Loop Mode', value: loopMode.toUpperCase(), inline: true },
      { name: '📜 Remaining in Queue', value: `${queueLength} song(s)`, inline: true },
      { name: '⏱️ Progress', value: `${progressText}\n*${durationText}*`, inline: false }
    )
    .setFooter({ text: 'Discord Music Network • Clean Dynamic Controls' })
    .setTimestamp();

  // Action Row 1: Playback State Controls
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('player_play_pause')
      .setLabel(isPlaying ? 'Pause' : 'Resume')
      .setEmoji(isPlaying ? '⏸️' : '▶️')
      .setStyle(isPlaying ? ButtonStyle.Primary : ButtonStyle.Success),
    
    new ButtonBuilder()
      .setCustomId('player_skip')
      .setLabel('Skip')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('player_stop')
      .setLabel('Stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId('player_shuffle')
      .setLabel('Shuffle')
      .setEmoji('🔀')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('player_loop')
      .setLabel(`Loop: ${loopMode}`)
      .setEmoji('🔁')
      .setStyle(loopMode === 'none' ? ButtonStyle.Secondary : ButtonStyle.Success)
  );

  // Action Row 2: Volume & Utilities
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('player_vol_down')
      .setLabel('Vol -10%')
      .setEmoji('🔉')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('player_vol_up')
      .setLabel('Vol +10%')
      .setEmoji('🔊')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('player_queue')
      .setLabel('View Queue')
      .setEmoji('📜')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('player_dismiss')
      .setLabel('Dismiss UI')
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
    .setColor(0x7289DA) // Discord Blurple
    .setTitle('👋 Welcome to the Discord Music Network!')
    .setDescription(
      'This server runs high-performance dedicated bots connected directly to your voice channels. ' +
      'Here is a quick guide to getting started.'
    )
    .addFields(
      { 
        name: '🎵 How to Play Music', 
        value: '1. Join your designated Voice Channel.\n' +
               '2. Use the bot prefix (default `!play`) followed by a query or link.\n' +
               '   *Examples:*\n' +
               '   `!play lo-fi beats`\n' +
               '   `!play <Spotify Song/Playlist Link>`\n' +
               '   `!play <YouTube URL>`', 
        inline: false 
      },
      { 
        name: '🎛️ Dynamic Playback Controls', 
        value: 'When a track is playing, a live Dashboard is posted in this channel. You can control the volume, skip tracks, loop, and view queues using the interactive buttons.', 
        inline: false 
      },
      { 
        name: '⚙️ Administrative Setup', 
        value: 'Server Administrators can configure prefixes, assign voice channels, and reboot active bot nodes via the hidden control panel (`!help`).', 
        inline: false 
      }
    )
    .setFooter({ text: 'Interactive Onboarding Tutorial' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('tutorial_how_to_play')
      .setLabel('🎵 How to Play')
      .setStyle(ButtonStyle.Primary),
    
    new ButtonBuilder()
      .setCustomId('tutorial_buttons_guide')
      .setLabel('🎛️ Control Buttons Guide')
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId('tutorial_queue_help')
      .setLabel('❓ Show Queue Help')
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Builds the Administrator-Only Help and configuration embed.
 */
export function buildAdminHelpEmbed(botConfig) {
  const embed = new EmbedBuilder()
    .setColor(0xED4245) // Danger Red / Security Red
    .setTitle('⚙️ Admin Master Control Panel')
    .setDescription(
      'You are viewing this panel because you have administrator permissions. ' +
      'Manage this bot instance and coordinate updates live.'
    )
    .addFields(
      { name: '🤖 Bot Instance ID', value: `\`${botConfig.id}\``, inline: true },
      { name: '🏷️ Bot Name', value: `${botConfig.bot_name}`, inline: true },
      { name: '⚡ Active Prefix', value: `\`${botConfig.prefix}\``, inline: true },
      { name: '📊 Engine Status', value: `\`${botConfig.status.toUpperCase()}\``, inline: true },
      { name: '🔊 Bound Voice Channel', value: `<#${botConfig.voice_channel_id}>`, inline: true },
      { name: '💬 Bound Text Channel', value: `<#${botConfig.text_channel_id}>`, inline: true }
    )
    .setFooter({ text: 'Admin Controls • Realtime Supabase Hook' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('admin_btn_change_prefix')
      .setLabel('Edit Prefix')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId('admin_btn_reboot')
      .setLabel('Reboot Instance')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId('admin_btn_sync')
      .setLabel('Sync Supabase')
      .setEmoji('📥')
      .setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [row] };
}
