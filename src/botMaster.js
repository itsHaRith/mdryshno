import { supabase } from './config/supabaseClient.js';
import { BotInstance } from './botInstance.js';
import { 
  initializePrefixCache, 
  initializeAdminRolesCache, 
  updateCachedPrefix, 
  updateCachedAdminRoles 
} from './adminMiddleware.js';
import dotenv from 'dotenv';
import express from 'express';

// Load environment variables
dotenv.config();

const botInstances = new Map(); // Store active bot instances in memory: botId -> BotInstance

// Initialize express web server to satisfy Render's port checks (enables free tier hosting)
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('🌐 Multi-Bot Music Network Master is Active.');
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', activeBots: botInstances.size });
});

app.listen(PORT, () => {
  console.log(`[Web Server] Ping listener active on port ${PORT}`);
});

/**
 * Initializes and boots the Discord Multi-Bot Engine.
 */
async function bootMasterEngine() {
  console.log('============================================');
  console.log('🚀 INITIALIZING MULTI-BOT MUSIC NETWORK ENGINE');
  console.log('============================================');

  // 1. Fetch bots config from database
  console.log('[Master] Fetching bot configurations from Supabase...');
  const { data: bots, error } = await supabase
    .from('bots')
    .select('*');

  if (error) {
    console.error('[Master] CRITICAL: Failed to load bots from Supabase:', error.message);
    process.exit(1);
  }

  if (!bots || bots.length === 0) {
    console.warn('[Master] WARNING: No bot configurations found in table public.bots!');
    console.log('[Master] Insert bot tokens and details into public.bots first, then launch the engine.');
  } else {
    console.log(`[Master] Found ${bots.length} configured bot(s).`);
  }

  // 2. Initialize in-memory cache for middleware prefix checking and administration settings
  console.log('[Master] Initializing permission and prefix caching layer...');
  await initializePrefixCache();
  await initializeAdminRolesCache();

  // 3. Spawn bot instances in parallel
  if (bots && bots.length > 0) {
    console.log('[Master] Booting bot instances simultaneously...');
    const spawnPromises = bots.map(async (botConfig) => {
      try {
        const bot = new BotInstance(botConfig);
        botInstances.set(botConfig.id, bot);
        
        // Update status to 'online' in Supabase
        await supabase
          .from('bots')
          .update({ status: 'online' })
          .eq('id', botConfig.id);

        await bot.start();
      } catch (err) {
        console.error(`[Master] Failed to spawn bot ID ${botConfig.id}:`, err.message);
      }
    });

    await Promise.all(spawnPromises);
    console.log('[Master] All active bots launched.');
  }

  // 4. Setup Supabase Realtime subscriptions for dynamic, zero-downtime updates
  console.log('[Master] Hooking up Supabase Realtime subscriptions...');
  
  // Realtime channel for bot config and voice/text channel live updates
  const botsChannel = supabase
    .channel('bots-realtime-changes')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'bots' },
      async (payload) => {
        const updatedBot = payload.new;
        console.log(`[Master] [Realtime UPDATE] public.bots updated: ID = ${updatedBot.id}`);
        
        const instance = botInstances.get(updatedBot.id);
        if (instance) {
          // Sync changes dynamically to the in-memory bot configuration
          await instance.updateConfiguration(updatedBot);
          updateCachedPrefix(updatedBot.id, updatedBot.prefix);
        }
      }
    )
    .subscribe((status) => {
      console.log(`[Master] Realtime subscription status [public.bots]: ${status}`);
    });

  // Realtime channel for dynamic prefix role configuration
  const adminChannel = supabase
    .channel('admin-realtime-changes')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'admin_settings' },
      (payload) => {
        const updatedSettings = payload.new;
        console.log(`[Master] [Realtime UPDATE] public.admin_settings updated: Guild = ${updatedSettings.guild_id}`);
        updateCachedAdminRoles(updatedSettings.guild_id, updatedSettings.admin_role_ids);
      }
    )
    .subscribe((status) => {
      console.log(`[Master] Realtime subscription status [public.admin_settings]: ${status}`);
    });
}

// 5. Handle graceful shutdown
const shutdown = async () => {
  console.log('\n[Master] Graceful shutdown initiated. Terminating connections...');
  
  const disconnectPromises = [];
  for (const [botId, instance] of botInstances.entries()) {
    console.log(`[Master] Disconnecting bot ID ${botId}...`);
    
    // Set status to 'offline' in database
    disconnectPromises.push(
      supabase
        .from('bots')
        .update({ status: 'offline' })
        .eq('id', botId)
        .then(() => {
          instance.destroy();
        })
        .catch(() => {
          instance.destroy();
        })
    );
  }

  await Promise.all(disconnectPromises);
  console.log('[Master] All connections cleared. Exiting.');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Boot the cluster
bootMasterEngine();
