-- Supabase Database Schema for Discord Music Network

-- Enable UUID generation extension if not enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Table: bots
-- Stores configurations and statuses for all 20+ bot instances
CREATE TABLE IF NOT EXISTS public.bots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_name TEXT NOT NULL,
    token TEXT NOT NULL, -- Encrypted or plain text token (decrypted/read by backend client)
    guild_id TEXT NOT NULL,
    voice_channel_id TEXT NOT NULL,
    text_channel_id TEXT NOT NULL,
    prefix TEXT NOT NULL DEFAULT '!play',
    status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'busy', 'offline')),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Table: admin_settings
-- Stores custom guild administration configurations (e.g., restricted roles, prefixes)
CREATE TABLE IF NOT EXISTS public.admin_settings (
    guild_id TEXT PRIMARY KEY,
    admin_role_ids TEXT[] NOT NULL DEFAULT '{}',
    custom_prefixes JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Auto-update updated_at helper function
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = timezone('utc'::text, now());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for bots table
DROP TRIGGER IF EXISTS trigger_bots_updated_at ON public.bots;
CREATE TRIGGER trigger_bots_updated_at
    BEFORE UPDATE ON public.bots
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- Trigger for admin_settings table
DROP TRIGGER IF EXISTS trigger_admin_settings_updated_at ON public.admin_settings;
CREATE TRIGGER trigger_admin_settings_updated_at
    BEFORE UPDATE ON public.admin_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- Enable Row Level Security (RLS)
ALTER TABLE public.bots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_settings ENABLE ROW LEVEL SECURITY;

-- RLS Policies (For Next.js dashboard / client apps)
-- The Backend Bot Master uses the Service Role Key which bypasses RLS automatically.

-- Policies for 'bots'
CREATE POLICY "Allow public read access to bot status" 
    ON public.bots FOR SELECT 
    USING (true);

CREATE POLICY "Allow service role full access to bots" 
    ON public.bots FOR ALL 
    USING (true) 
    WITH CHECK (true);

-- Policies for 'admin_settings'
CREATE POLICY "Allow read access to admin settings" 
    ON public.admin_settings FOR SELECT 
    USING (true);

CREATE POLICY "Allow service role full access to admin_settings" 
    ON public.admin_settings FOR ALL 
    USING (true) 
    WITH CHECK (true);
