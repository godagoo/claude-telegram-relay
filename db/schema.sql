-- Supabase Schema for Persistent Memory
-- Run this in Supabase SQL Editor (or via Supabase MCP)
-- This enables: conversation history, semantic search, goals tracking
--
-- After running this, set up the embed Edge Function and database webhook
-- so embeddings are generated automatically on every INSERT.

-- Required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ============================================================
-- MESSAGES TABLE (Conversation History)
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  channel TEXT DEFAULT 'telegram',
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536) -- For semantic search (optional)
);

CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);

-- ============================================================
-- MEMORY TABLE (Facts & Goals)
-- ============================================================
CREATE TABLE IF NOT EXISTS memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  type TEXT NOT NULL CHECK (type IN ('fact', 'goal', 'completed_goal', 'preference')),
  content TEXT NOT NULL,
  deadline TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  priority INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536)
);

CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type);
CREATE INDEX IF NOT EXISTS idx_memory_created_at ON memory(created_at DESC);

-- ============================================================
-- LOGS TABLE (Observability - Optional)
-- ============================================================
CREATE TABLE IF NOT EXISTS logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  level TEXT DEFAULT 'info' CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event TEXT NOT NULL,
  message TEXT,
  metadata JSONB DEFAULT '{}',
  session_id TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs ENABLE ROW LEVEL SECURITY;

-- Allow all for service role (your bot uses service key)
CREATE POLICY "Allow all for service role" ON messages FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON memory FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON logs FOR ALL USING (true);

-- ============================================================
-- MULTI-USER: Add user_id to messages and memory
-- ============================================================
ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_memory_user_id ON memory(user_id);

-- ============================================================
-- AUTHORIZED USERS (owner + approved)
-- ============================================================
CREATE TABLE IF NOT EXISTS authorized_users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  telegram_id TEXT UNIQUE NOT NULL,
  username TEXT,
  role TEXT CHECK (role IN ('owner', 'user')) DEFAULT 'user',
  added_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE authorized_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON authorized_users FOR ALL USING (true);

-- ============================================================
-- CRON JOBS (managed from Telegram)
-- ============================================================
CREATE TABLE IF NOT EXISTS cron_jobs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  schedule TEXT NOT NULL,
  action TEXT NOT NULL,
  enabled BOOLEAN DEFAULT true,
  last_run TIMESTAMPTZ,
  next_run TIMESTAMPTZ,
  run_count INTEGER DEFAULT 0,
  last_result TEXT,
  execution_lock TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, name)
);

ALTER TABLE cron_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON cron_jobs FOR ALL USING (true);

-- Add target_type column if it doesn't exist (for group posting)
ALTER TABLE cron_jobs ADD COLUMN IF NOT EXISTS target_type TEXT DEFAULT 'user';

-- ============================================================
-- CRON EXECUTION AUDIT LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS cron_executions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID REFERENCES cron_jobs(id) ON DELETE CASCADE,
  executed_at TIMESTAMPTZ DEFAULT NOW(),
  execution_id TEXT UNIQUE NOT NULL,
  result TEXT,
  duration_ms INTEGER,
  status TEXT CHECK (status IN ('success', 'error', 'skipped'))
);

ALTER TABLE cron_executions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON cron_executions FOR ALL USING (true);

-- ============================================================
-- ENV BACKUPS
-- ============================================================
CREATE TABLE IF NOT EXISTS env_backups (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  source TEXT DEFAULT 'auto'
);

ALTER TABLE env_backups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON env_backups FOR ALL USING (true);

-- ============================================================
-- GOOGLE OAUTH TOKENS
-- ============================================================
CREATE TABLE IF NOT EXISTS google_tokens (
  user_id TEXT PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  expiry TIMESTAMPTZ,
  scopes TEXT[],
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE google_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON google_tokens FOR ALL USING (true);

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Get recent messages for context (scoped by user_id)
CREATE OR REPLACE FUNCTION get_recent_messages(p_user_id TEXT DEFAULT NULL, limit_count INTEGER DEFAULT 20)
RETURNS TABLE (
  id UUID,
  created_at TIMESTAMPTZ,
  role TEXT,
  content TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.created_at, m.role, m.content
  FROM messages m
  WHERE (p_user_id IS NULL OR m.user_id = p_user_id)
  ORDER BY m.created_at DESC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- Get active goals (scoped by user_id)
CREATE OR REPLACE FUNCTION get_active_goals(p_user_id TEXT DEFAULT NULL)
RETURNS TABLE (
  id UUID,
  content TEXT,
  deadline TIMESTAMPTZ,
  priority INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content, m.deadline, m.priority
  FROM memory m
  WHERE m.type = 'goal'
    AND (p_user_id IS NULL OR m.user_id = p_user_id)
  ORDER BY m.priority DESC, m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Get all facts (scoped by user_id)
CREATE OR REPLACE FUNCTION get_facts(p_user_id TEXT DEFAULT NULL)
RETURNS TABLE (
  id UUID,
  content TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content
  FROM memory m
  WHERE m.type = 'fact'
    AND (p_user_id IS NULL OR m.user_id = p_user_id)
  ORDER BY m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- SEMANTIC SEARCH
-- ============================================================
-- Embeddings are generated automatically by the embed Edge Function
-- via database webhook. The search Edge Function calls these RPCs.

-- Match messages by embedding similarity
CREATE OR REPLACE FUNCTION match_messages(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  role TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.role,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM messages m
  WHERE m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- Match memory entries by embedding similarity
CREATE OR REPLACE FUNCTION match_memory(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.type,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memory m
  WHERE m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;
