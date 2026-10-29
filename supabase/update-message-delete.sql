-- MuseTalk update: soft-delete support for direct messages.
-- Run this ONCE in the Supabase SQL Editor (project "Muse Talk")
-- BEFORE pushing the code update that uses it.
-- Safe to run more than once.
alter table messages add column if not exists deleted_at timestamptz;
create index if not exists messages_alive_idx on messages(conversation_id, created_at desc) where deleted_at is null;
