-- Migration: Add anon key RLS policies to all tables
-- Safe to run multiple times (idempotent)
-- Skips tables that don't exist yet (handles partial database setup)
-- Run this in Supabase SQL Editor

-- ============================================================
-- messages
-- ============================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'messages') THEN
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon read" ON messages';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon insert" ON messages';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon update" ON messages';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon delete" ON messages';
    EXECUTE 'CREATE POLICY "Allow anon read" ON messages FOR SELECT USING (true)';
    EXECUTE 'CREATE POLICY "Allow anon insert" ON messages FOR INSERT WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "Allow anon update" ON messages FOR UPDATE USING (true)';
    EXECUTE 'CREATE POLICY "Allow anon delete" ON messages FOR DELETE USING (true)';
    RAISE NOTICE 'messages: anon policies applied';
  ELSE
    RAISE NOTICE 'messages: table not found, skipping';
  END IF;
END $$;

-- ============================================================
-- memory
-- ============================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'memory') THEN
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon read" ON memory';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon insert" ON memory';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon update" ON memory';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon delete" ON memory';
    EXECUTE 'CREATE POLICY "Allow anon read" ON memory FOR SELECT USING (true)';
    EXECUTE 'CREATE POLICY "Allow anon insert" ON memory FOR INSERT WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "Allow anon update" ON memory FOR UPDATE USING (true)';
    EXECUTE 'CREATE POLICY "Allow anon delete" ON memory FOR DELETE USING (true)';
    RAISE NOTICE 'memory: anon policies applied';
  ELSE
    RAISE NOTICE 'memory: table not found, skipping';
  END IF;
END $$;

-- ============================================================
-- logs
-- ============================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'logs') THEN
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon read" ON logs';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon insert" ON logs';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon update" ON logs';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon delete" ON logs';
    EXECUTE 'CREATE POLICY "Allow anon read" ON logs FOR SELECT USING (true)';
    EXECUTE 'CREATE POLICY "Allow anon insert" ON logs FOR INSERT WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "Allow anon update" ON logs FOR UPDATE USING (true)';
    EXECUTE 'CREATE POLICY "Allow anon delete" ON logs FOR DELETE USING (true)';
    RAISE NOTICE 'logs: anon policies applied';
  ELSE
    RAISE NOTICE 'logs: table not found, skipping';
  END IF;
END $$;

-- ============================================================
-- authorized_users
-- ============================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'authorized_users') THEN
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon read" ON authorized_users';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon insert" ON authorized_users';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon update" ON authorized_users';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon delete" ON authorized_users';
    EXECUTE 'CREATE POLICY "Allow anon read" ON authorized_users FOR SELECT USING (true)';
    EXECUTE 'CREATE POLICY "Allow anon insert" ON authorized_users FOR INSERT WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "Allow anon update" ON authorized_users FOR UPDATE USING (true)';
    EXECUTE 'CREATE POLICY "Allow anon delete" ON authorized_users FOR DELETE USING (true)';
    RAISE NOTICE 'authorized_users: anon policies applied';
  ELSE
    RAISE NOTICE 'authorized_users: table not found, skipping';
  END IF;
END $$;

-- ============================================================
-- cron_jobs
-- ============================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'cron_jobs') THEN
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon read" ON cron_jobs';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon insert" ON cron_jobs';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon update" ON cron_jobs';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon delete" ON cron_jobs';
    EXECUTE 'CREATE POLICY "Allow anon read" ON cron_jobs FOR SELECT USING (true)';
    EXECUTE 'CREATE POLICY "Allow anon insert" ON cron_jobs FOR INSERT WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "Allow anon update" ON cron_jobs FOR UPDATE USING (true)';
    EXECUTE 'CREATE POLICY "Allow anon delete" ON cron_jobs FOR DELETE USING (true)';
    RAISE NOTICE 'cron_jobs: anon policies applied';
  ELSE
    RAISE NOTICE 'cron_jobs: table not found, skipping';
  END IF;
END $$;

-- ============================================================
-- cron_executions
-- ============================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'cron_executions') THEN
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon read" ON cron_executions';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon insert" ON cron_executions';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon update" ON cron_executions';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon delete" ON cron_executions';
    EXECUTE 'CREATE POLICY "Allow anon read" ON cron_executions FOR SELECT USING (true)';
    EXECUTE 'CREATE POLICY "Allow anon insert" ON cron_executions FOR INSERT WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "Allow anon update" ON cron_executions FOR UPDATE USING (true)';
    EXECUTE 'CREATE POLICY "Allow anon delete" ON cron_executions FOR DELETE USING (true)';
    RAISE NOTICE 'cron_executions: anon policies applied';
  ELSE
    RAISE NOTICE 'cron_executions: table not found, skipping';
  END IF;
END $$;

-- ============================================================
-- env_backups
-- ============================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'env_backups') THEN
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon read" ON env_backups';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon insert" ON env_backups';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon update" ON env_backups';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon delete" ON env_backups';
    EXECUTE 'CREATE POLICY "Allow anon read" ON env_backups FOR SELECT USING (true)';
    EXECUTE 'CREATE POLICY "Allow anon insert" ON env_backups FOR INSERT WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "Allow anon update" ON env_backups FOR UPDATE USING (true)';
    EXECUTE 'CREATE POLICY "Allow anon delete" ON env_backups FOR DELETE USING (true)';
    RAISE NOTICE 'env_backups: anon policies applied';
  ELSE
    RAISE NOTICE 'env_backups: table not found, skipping';
  END IF;
END $$;

-- ============================================================
-- google_tokens
-- ============================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'google_tokens') THEN
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon read" ON google_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon insert" ON google_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon update" ON google_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "Allow anon delete" ON google_tokens';
    EXECUTE 'CREATE POLICY "Allow anon read" ON google_tokens FOR SELECT USING (true)';
    EXECUTE 'CREATE POLICY "Allow anon insert" ON google_tokens FOR INSERT WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "Allow anon update" ON google_tokens FOR UPDATE USING (true)';
    EXECUTE 'CREATE POLICY "Allow anon delete" ON google_tokens FOR DELETE USING (true)';
    RAISE NOTICE 'google_tokens: anon policies applied';
  ELSE
    RAISE NOTICE 'google_tokens: table not found, skipping';
  END IF;
END $$;
