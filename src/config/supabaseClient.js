process.env.SUPABASE_DISABLE_DEPRECATION_WARNING = 'true';
process.env.SUPABASE_JS_DISABLE_WARNINGS = 'true';

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import WebSocket from 'ws';
import { logger } from '../utils/logger.js';

// Load environment variables
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  logger.error('[Supabase] CRITICAL ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables!');
}

// Polyfill WebSocket for Node versions without native WebSocket (Node < 22)
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocket;
}

// Initialize Supabase Client with service role permissions to bypass RLS for administrative backend operations
export const supabase = createClient(
  supabaseUrl || '', 
  supabaseServiceRoleKey || '', 
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

/**
 * Helper to check if a string contains placeholder/invalid credentials
 */
function isInvalidPlaceholder(str) {
  if (!str || typeof str !== 'string') return true;
  const lower = str.toLowerCase();
  return (
    lower.includes('your_cookie') ||
    lower.includes('your_po_token') ||
    lower.includes('your_visitor') ||
    lower.includes('placeholder') ||
    lower.includes('xxxx') ||
    lower.includes('ضع_هنا') ||
    str.trim().length < 15
  );
}

/**
 * Fetches YouTube authentication session parameters from Supabase (youtube_auth table).
 */
export async function fetchYoutubeAuth() {
  try {
    const { data, error } = await supabase
      .from('youtube_auth')
      .select('cookie_header, po_token, visitor_data')
      .eq('id', 1)
      .maybeSingle();

    if (error) {
      logger.debug('[Supabase] youtube_auth table query warning:', error.message);
      return null;
    }

    if (data && isInvalidPlaceholder(data.cookie_header)) {
      logger.debug('[Supabase] Detected invalid/placeholder YouTube cookie in youtube_auth table. Falling back to persistent session credentials.');
      return {
        cookie_header: null,
        po_token: isInvalidPlaceholder(data.po_token) ? null : data.po_token,
        visitor_data: isInvalidPlaceholder(data.visitor_data) ? null : data.visitor_data
      };
    }

    return data;
  } catch (err) {
    logger.debug('[Supabase] Failed to fetch youtube_auth session data:', err.message);
    return null;
  }
}

logger.info('[Supabase] Client initialized successfully.');
