import { PermissionsBitField } from 'discord.js';
import { supabase } from './config/supabaseClient.js';
import { logger } from './utils/logger.js';

// Memory cache for fast lookups (avoiding database querying on every single incoming message)
const prefixCache = new Map(); // Key: botId -> prefix
const adminRolesCache = new Map(); // Key: guildId -> Set of role IDs

/**
 * Loads and caches prefixes for all bots on startup
 */
export async function initializePrefixCache() {
  try {
    const { data, error } = await supabase
      .from('bots')
      .select('id, prefix');
      
    if (error) throw error;
    
    if (data) {
      for (const bot of data) {
        prefixCache.set(bot.id, bot.prefix);
      }
      logger.info(`[AdminMiddleware] Cached ${prefixCache.size} bot prefixes.`);
    }
  } catch (err) {
    logger.error('[AdminMiddleware] Error seeding prefix cache:', err.message);
  }
}

/**
 * Loads and caches admin roles for all guilds on startup
 */
export async function initializeAdminRolesCache() {
  try {
    const { data, error } = await supabase
      .from('admin_settings')
      .select('guild_id, admin_role_ids');

    if (error) throw error;

    if (data) {
      for (const setting of data) {
        adminRolesCache.set(setting.guild_id, new Set(setting.admin_role_ids || []));
      }
      logger.info(`[AdminMiddleware] Cached admin settings for ${adminRolesCache.size} guilds.`);
    }
  } catch (err) {
    logger.error('[AdminMiddleware] Error seeding admin roles cache:', err.message);
  }
}

/**
 * Updates prefix in cache (typically called by the Realtime listener)
 */
export function updateCachedPrefix(botId, newPrefix) {
  prefixCache.set(botId, newPrefix);
  logger.info(`[AdminMiddleware] Cache updated: Bot ${botId} prefix is now "${newPrefix}"`);
}

/**
 * Updates cached admin roles for a guild
 */
export function updateCachedAdminRoles(guildId, roleIds) {
  adminRolesCache.set(guildId, new Set(roleIds || []));
  console.log(`[AdminMiddleware] Cache updated: Guild ${guildId} custom admin roles: [${roleIds.join(', ')}]`);
}

/**
 * Resolves the active prefix for a specific bot.
 * Falls back to database query if not cached, then to a default prefix.
 */
export async function getPrefix(botId, defaultPrefix = '!play') {
  if (prefixCache.has(botId)) {
    return prefixCache.get(botId);
  }

  try {
    const { data, error } = await supabase
      .from('bots')
      .select('prefix')
      .eq('id', botId)
      .single();

    if (error || !data) {
      prefixCache.set(botId, defaultPrefix);
      return defaultPrefix;
    }

    prefixCache.set(botId, data.prefix);
    return data.prefix;
  } catch {
    return defaultPrefix;
  }
}

/**
 * Updates the prefix in Supabase database.
 * The Realtime subscription will receive this change and sync it to the cache.
 */
export async function setPrefix(botId, newPrefix) {
  try {
    const { error } = await supabase
      .from('bots')
      .update({ prefix: newPrefix })
      .eq('id', botId);

    if (error) throw error;
    
    // Proactively update local cache as well
    prefixCache.set(botId, newPrefix);
    return { success: true };
  } catch (err) {
    console.error(`[AdminMiddleware] Failed to update prefix for bot ${botId}:`, err);
    return { success: false, error: err.message };
  }
}

/**
 * Verifies if a user has Administrator privileges or possesses a custom admin role.
 */
export async function isAdmin(member) {
  if (!member) return false;

  // 1. Check standard Discord Administrator permission
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return true;
  }

  const guildId = member.guild.id;
  let adminRoles = adminRolesCache.get(guildId);

  // 2. Fetch if not cached
  if (!adminRoles) {
    try {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('admin_role_ids')
        .eq('guild_id', guildId)
        .single();

      if (!error && data) {
        const rolesSet = new Set(data.admin_role_ids || []);
        adminRolesCache.set(guildId, rolesSet);
        adminRoles = rolesSet;
      }
    } catch {
      // Ignore database errors, default to empty set
    }
  }

  if (adminRoles && adminRoles.size > 0) {
    // Check if member has any of the custom admin roles
    const memberRoleIds = member.roles.cache.keys();
    for (const roleId of memberRoleIds) {
      if (adminRoles.has(roleId)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Saves custom admin roles for a guild.
 */
export async function setAdminRoles(guildId, roleIds) {
  try {
    const { error } = await supabase
      .from('admin_settings')
      .upsert({ guild_id: guildId, admin_role_ids: roleIds }, { onConflict: 'guild_id' });

    if (error) throw error;

    adminRolesCache.set(guildId, new Set(roleIds));
    return { success: true };
  } catch (err) {
    logger.error(`[AdminMiddleware] Failed to set admin roles for guild ${guildId}: ${err.message}`);
    return { success: false, error: err.message };
  }
}
