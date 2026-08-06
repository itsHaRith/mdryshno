# Discord Multi-Bot Music Network (Supabase Integrated)

A scalable Discord Music Engine designed to coordinate and stream audio across 20+ parallel bot instances concurrently inside a single Node.js process. Managed using a dynamic channel-based control dashboard, Spotify & YouTube playback support via `play-dl`, and live configuration sync via Supabase Realtime databases.

---

## 📂 Project Structure

```
BOT_SONGS/
├── .env                      # Database keys, Spotify credentials, and YouTube cookies
├── package.json              # Direct and peer dependencies
├── schema.sql                # Supabase database setup & Row Level Security (RLS) policies
└── src/
    ├── config/
    │   └── supabaseClient.js # Supabase connection client
    ├── botMaster.js          # Master controller & Supabase Realtime coordinator
    ├── botInstance.js        # Single bot client handler & message/button interaction router
    ├── audioManager.js       # play-dl & voice queue player (Spotify metadata resolver)
    ├── uiBuilder.js          # Interactive Player Dashboard, Tutorial Panel, & Admin Embeds
    └── adminMiddleware.js    # In-memory permissions checking & prefix updates
```

---

## 🛠️ Prereqs & Setup

### 1. Node.js & System Binaries
Ensure you have:
- **Node.js**: v18.x or v20.x installed.
- **FFmpeg**: Required for audio transcoding. The system automatically installs `ffmpeg-static` to supply the binary, but ensure your host OS has standard audio decoders enabled.

### 2. Supabase Integration Setup
1. Create a free project at [Supabase](https://supabase.com).
2. Go to the **SQL Editor** in your Supabase Dashboard and paste the contents of [`schema.sql`](file:///c:/Users/harit/Desktop/BOT_SONGS/schema.sql) and run it to create tables, constraints, triggers, and Row Level Security (RLS) configurations.
3. **CRITICAL STEP FOR REALTIME:**
   - By default, Supabase Postgres tables do not replicate to the realtime stream.
   - In the Supabase Dashboard, go to **Database** -> **Replication** (or Realtime section).
   - Under the `supabase_realtime` publication, click **Source** (or select tables) and enable replication for the `bots` and `admin_settings` tables. Without this, live prefix and channel modifications will not sync to the bot instances in real-time.

### 3. Registering Bot Credentials
In the `bots` table, insert row entries for each of your 20 bots. Minimum row contents required:
- `bot_name`: E.g. `Music Bot 1`
- `token`: The bot client token from the Discord Developer Portal
- `guild_id`: Target server ID
- `voice_channel_id`: The voice channel the bot must lock into upon boot
- `text_channel_id`: The designated text channel where playback buttons and dashboards reside
- `prefix`: Command prefix (e.g. `!play` or `?p`)

*Make sure your bot clients have **Server Members Intent** and **Message Content Intent** enabled in the Discord Developer Portal.*

---

## ⚙️ Environmental Configuration

Create a `.env` file in the root directory (based on [`template`](file:///c:/Users/harit/Desktop/BOT_SONGS/.env)):

```env
# Supabase Authentication Details
SUPABASE_URL=https://xxxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# Spotify credentials (highly recommended to prevent Spotify resolving rate limits)
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret

# YouTube Connection configuration (Only if play-dl throws "Sign in" exceptions)
# YOUTUBE_COOKIE=__Secure-3PSID=xxxx; __Secure-3PAPISID=yyyy; ...
```

> [!TIP]
> **To Get YouTube Cookies:**
> Install a browser extension like *EditThisCookie*, navigate to YouTube, export cookies as a string, and paste the values into `YOUTUBE_COOKIE` in your `.env`.

---

## 🚀 Installation & Running

1. Open your terminal in the `BOT_SONGS` workspace root.
2. Install all node packages:
   ```powershell
   npm install
   ```
3. Boot up the Master Engine:
   ```powershell
   npm start
   ```

Upon execution, `botMaster.js` will read configurations from your database, cache prefixes, boot all bot instances in parallel, join respective voice channels, and subscribe to Supabase Realtime changes.

---

## 📖 Feature Guide & Controls

### 1. Interactive Tutorial Onboarding (`HI!`)
- When any user types `HI!` or `hi` in the bot's bound text channel, the bot replies with the onboarding interactive embed.
- Pressing `🎵 How to Play`, `🎛️ Control Buttons Guide`, or `❓ Show Queue Help` displays custom guides to the user as **Ephemeral Messages** (only visible to them, maintaining zero channel clutter).

### 2. Live Dashboard Controller (2 Action Rows)
Whenever a song starts playing, a custom Embed with buttons will appear. It refreshes progress automatically every 10 seconds.
- **Row 1:**
  - ⏸️/▶️: Pause or Resume playback.
  - ⏭️: Skip current song.
  - ⏹️: Stop playback and disconnect from voice channel.
  - 🔀: Shuffle queue.
  - 🔁: Toggle loop modes (`NONE`, `TRACK`, `QUEUE`).
- **Row 2:**
  - 🔉 / 🔊: Decrease or increase player volume by 10%.
  - 📜: View the current queue list as an Ephemeral Message.
  - ❌: Delete the active player dashboard layout.

### 3. Dynamic Administrator Controls
- **Command Restricting:** Triggering `!help` or clicking restricted administrative buttons validates permissions:
  - **Non-Admin:** Receives a private DM or ephemeral warning containing the standard user guide.
  - **Administrator:** Receives the **Admin Master Control Panel Embed** containing options to change prefixes, reboot nodes, and check live synchronization variables.
- **Dynamic Prefix Editing:** Changing prefixes via command (e.g. `!play prefix ?`) or in Supabase updates the database. The Realtime subscription triggers a dynamic cache refresh and bot state updates immediately without needing to restart the Node.js master script.
