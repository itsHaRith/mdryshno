import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error('[Supabase] CRITICAL ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables!');
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

console.log('[Supabase] Client initialized successfully.');
