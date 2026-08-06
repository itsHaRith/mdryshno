import { fork } from 'child_process';
import path from 'path';
import { supabase } from './config/supabaseClient.js';
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

const botProcesses = new Map(); // Store child processes: botId -> ChildProcess

// Initialize express web server to satisfy Render's port checks (enables free tier hosting)
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('🌐 Multi-Bot Music Network Master is Active.');
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', activeBots: botProcesses.size });
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

  console.log(`[Master] Found ${bots ? bots.length : 0} configured bot(s).`);

  // 2. Initialize in-memory cache for middleware prefix checking and administration settings
  console.log('[Master] Initializing permission and prefix caching layer...');
  await initializePrefixCache();
  await initializeAdminRolesCache();

  // 3. Spawn bot instances in separate processes
  if (bots && bots.length > 0) {
    console.log('[Master] Spawning bot instances in separate processes...');
    bots.forEach((botConfig) => {
      spawnBotWorker(botConfig.id);
    });
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
        
        updateCachedPrefix(updatedBot.id, updatedBot.prefix);
        
        // Forward the update message to the worker child process if alive
        const child = botProcesses.get(updatedBot.id);
        if (child && child.connected) {
          child.send({ type: 'UPDATE', config: updatedBot });
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

/**
 * Spawns a bot worker process for the given configuration ID.
 */
function spawnBotWorker(botId) {
  console.log(`[Master] Spawning child process for Bot ID: ${botId}...`);
  const workerPath = path.resolve('src/botWorker.js');
  
  // Fork a separate node process running src/botWorker.js with botId as parameter
  const child = fork(workerPath, [botId]);
  
  botProcesses.set(botId, child);
  
  child.on('message', (msg) => {
    // Handle any message from child processes if needed
  });
  
  child.on('exit', (code, signal) => {
    console.warn(`[Master] Bot worker ${botId} exited with code ${code} (signal: ${signal}). Auto-restarting in 5 seconds...`);
    botProcesses.delete(botId);
    
    // Auto restart child process if it crashes or exits
    setTimeout(() => {
      spawnBotWorker(botId);
    }, 5000);
  });

  child.on('error', (err) => {
    console.error(`[Master] Child process error for Bot ID ${botId}:`, err.message);
  });
}

// 5. Handle graceful shutdown
const shutdown = async () => {
  console.log('\n[Master] Graceful shutdown initiated. Terminating connections...');
  
  const offlinePromises = [];
  
  for (const [botId, child] of botProcesses.entries()) {
    console.log(`[Master] Terminating bot worker ID ${botId}...`);
    // Remove the exit listener to prevent auto-restart loop on shutdown
    child.removeAllListeners('exit');
    child.kill('SIGTERM');
    
    offlinePromises.push(
      supabase
        .from('bots')
        .update({ status: 'offline' })
        .eq('id', botId)
    );
  }

  await Promise.all(offlinePromises).catch(() => {});
  console.log('[Master] All child processes terminated. Exiting.');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Boot the cluster
bootMasterEngine();
