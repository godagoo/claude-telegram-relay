-- Migration: Add anon key RLS policies to all tables
-- Safe to run multiple times (idempotent via DROP IF EXISTS + CREATE)
-- Run this in Supabase SQL Editor if your database was created before anon policies were added

-- ============================================================
-- messages
-- ============================================================
DROP POLICY IF EXISTS "Allow anon read" ON messages;
DROP POLICY IF EXISTS "Allow anon insert" ON messages;
DROP POLICY IF EXISTS "Allow anon update" ON messages;
DROP POLICY IF EXISTS "Allow anon delete" ON messages;

CREATE POLICY "Allow anon read" ON messages FOR SELECT USING (true);
CREATE POLICY "Allow anon insert" ON messages FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update" ON messages FOR UPDATE USING (true);
CREATE POLICY "Allow anon delete" ON messages FOR DELETE USING (true);

-- ============================================================
-- memory
-- ============================================================
DROP POLICY IF EXISTS "Allow anon read" ON memory;
DROP POLICY IF EXISTS "Allow anon insert" ON memory;
DROP POLICY IF EXISTS "Allow anon update" ON memory;
DROP POLICY IF EXISTS "Allow anon delete" ON memory;

CREATE POLICY "Allow anon read" ON memory FOR SELECT USING (true);
CREATE POLICY "Allow anon insert" ON memory FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update" ON memory FOR UPDATE USING (true);
CREATE POLICY "Allow anon delete" ON memory FOR DELETE USING (true);

-- ============================================================
-- logs
-- ============================================================
DROP POLICY IF EXISTS "Allow anon read" ON logs;
DROP POLICY IF EXISTS "Allow anon insert" ON logs;
DROP POLICY IF EXISTS "Allow anon update" ON logs;
DROP POLICY IF EXISTS "Allow anon delete" ON logs;

CREATE POLICY "Allow anon read" ON logs FOR SELECT USING (true);
CREATE POLICY "Allow anon insert" ON logs FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update" ON logs FOR UPDATE USING (true);
CREATE POLICY "Allow anon delete" ON logs FOR DELETE USING (true);

-- ============================================================
-- authorized_users
-- ============================================================
DROP POLICY IF EXISTS "Allow anon read" ON authorized_users;
DROP POLICY IF EXISTS "Allow anon insert" ON authorized_users;
DROP POLICY IF EXISTS "Allow anon update" ON authorized_users;
DROP POLICY IF EXISTS "Allow anon delete" ON authorized_users;

CREATE POLICY "Allow anon read" ON authorized_users FOR SELECT USING (true);
CREATE POLICY "Allow anon insert" ON authorized_users FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update" ON authorized_users FOR UPDATE USING (true);
CREATE POLICY "Allow anon delete" ON authorized_users FOR DELETE USING (true);

-- ============================================================
-- cron_jobs
-- ============================================================
DROP POLICY IF EXISTS "Allow anon read" ON cron_jobs;
DROP POLICY IF EXISTS "Allow anon insert" ON cron_jobs;
DROP POLICY IF EXISTS "Allow anon update" ON cron_jobs;
DROP POLICY IF EXISTS "Allow anon delete" ON cron_jobs;

CREATE POLICY "Allow anon read" ON cron_jobs FOR SELECT USING (true);
CREATE POLICY "Allow anon insert" ON cron_jobs FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update" ON cron_jobs FOR UPDATE USING (true);
CREATE POLICY "Allow anon delete" ON cron_jobs FOR DELETE USING (true);

-- ============================================================
-- cron_executions
-- ============================================================
DROP POLICY IF EXISTS "Allow anon read" ON cron_executions;
DROP POLICY IF EXISTS "Allow anon insert" ON cron_executions;
DROP POLICY IF EXISTS "Allow anon update" ON cron_executions;
DROP POLICY IF EXISTS "Allow anon delete" ON cron_executions;

CREATE POLICY "Allow anon read" ON cron_executions FOR SELECT USING (true);
CREATE POLICY "Allow anon insert" ON cron_executions FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update" ON cron_executions FOR UPDATE USING (true);
CREATE POLICY "Allow anon delete" ON cron_executions FOR DELETE USING (true);

-- ============================================================
-- env_backups
-- ============================================================
DROP POLICY IF EXISTS "Allow anon read" ON env_backups;
DROP POLICY IF EXISTS "Allow anon insert" ON env_backups;
DROP POLICY IF EXISTS "Allow anon update" ON env_backups;
DROP POLICY IF EXISTS "Allow anon delete" ON env_backups;

CREATE POLICY "Allow anon read" ON env_backups FOR SELECT USING (true);
CREATE POLICY "Allow anon insert" ON env_backups FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update" ON env_backups FOR UPDATE USING (true);
CREATE POLICY "Allow anon delete" ON env_backups FOR DELETE USING (true);

-- ============================================================
-- google_tokens
-- ============================================================
DROP POLICY IF EXISTS "Allow anon read" ON google_tokens;
DROP POLICY IF EXISTS "Allow anon insert" ON google_tokens;
DROP POLICY IF EXISTS "Allow anon update" ON google_tokens;
DROP POLICY IF EXISTS "Allow anon delete" ON google_tokens;

CREATE POLICY "Allow anon read" ON google_tokens FOR SELECT USING (true);
CREATE POLICY "Allow anon insert" ON google_tokens FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update" ON google_tokens FOR UPDATE USING (true);
CREATE POLICY "Allow anon delete" ON google_tokens FOR DELETE USING (true);
