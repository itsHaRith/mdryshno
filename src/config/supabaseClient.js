process.env.SUPABASE_DISABLE_DEPRECATION_WARNING = 'true';
process.env.SUPABASE_JS_DISABLE_WARNINGS = 'true';

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import WebSocket from 'ws';

// Load environment variables
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error('[Supabase] CRITICAL ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables!');
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
      console.warn('[Supabase] youtube_auth table query warning:', error.message);
      return null;
    }
    return data;
  } catch (err) {
    console.warn('[Supabase] Failed to fetch youtube_auth session data:', err.message);
    return null;
  }
}

console.log('[Supabase] Client initialized successfully.');
