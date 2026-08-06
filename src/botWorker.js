process.env.SUPABASE_DISABLE_DEPRECATION_WARNING = 'true';
process.env.SUPABASE_JS_DISABLE_WARNINGS = 'true';
process.removeAllListeners('warning');

import { supabase } from './config/supabaseClient.js';
import { BotInstance } from './botInstance.js';
import dotenv from 'dotenv';
import { logger } from './utils/logger.js';

// Load environment variables
dotenv.config();

// Production Safeguard: Catch leaked background rejections from play-dl or other libraries
process.on('unhandledRejection', (reason, promise) => {
  logger.warn('[Worker-Global] Caught Unhandled Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  logger.error('[Worker-Global] Caught Uncaught Exception:', err.message || err);
});

const botConfigId = process.argv[2];

if (!botConfigId) {
  logger.error('[Worker] Fatal: No bot configuration ID provided.');
  process.exit(1);
}

async function startWorker() {
  logger.debug(`[Worker-${botConfigId}] Fetching configuration from Supabase...`);
  
  const { data: botConfig, error } = await supabase
    .from('bots')
    .select('*')
    .eq('id', botConfigId)
    .single();

  if (error || !botConfig) {
    logger.error(`[Worker-${botConfigId}] Fatal: Failed to fetch configuration:`, error?.message || 'Not found');
    process.exit(1);
  }

  logger.info(`[Worker-${botConfigId}] Starting Bot Instance: ${botConfig.bot_name}...`);
  const bot = new BotInstance(botConfig);
  
  // Set status to 'online' in Supabase
  await supabase
    .from('bots')
    .update({ status: 'online' })
    .eq('id', botConfigId);

  await bot.start();

  // Listen to IPC messages from the master process
  process.on('message', async (msg) => {
    if (msg.type === 'UPDATE') {
      logger.info(`[Worker-${botConfigId}] IPC UPDATE received: updating configuration.`);
      await bot.updateConfiguration(msg.config);
    } else if (msg.type === 'TEST_PLAY') {
      logger.info(`[Worker-${botConfigId}] IPC TEST_PLAY received: playing test track.`);
      if (bot.audioManager) {
        const testTrackUrl = 'https://www.youtube.com/watch?v=8n5dJwWXrbo';
        const result = await bot.audioManager.play(testTrackUrl, 'Master Test');
        logger.debug(`[Worker-${botConfigId}] Test play result:`, result);
      }
    }
  });

  // Handle graceful shutdown from process events
  const handleShutdown = async () => {
    logger.info(`[Worker-${botConfigId}] Worker shutting down cleanly...`);
    try {
      await supabase
        .from('bots')
        .update({ status: 'offline' })
        .eq('id', botConfigId);
    } catch {}
    bot.destroy();
    process.exit(0);
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);
}

startWorker().catch(err => {
  logger.error(`[Worker-${botConfigId}] Uncaught Fatal Error: ${err.message}`);
  process.exit(1);
});
