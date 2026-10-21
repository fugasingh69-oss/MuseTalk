-- ============================================================
-- MuseTalk — Supabase (Postgres) schema
-- Run ONCE: Supabase Dashboard → SQL Editor → paste → Run.
-- This is the "hot store": accounts, posts and live messages.
-- Google Drive is the permanent message archive (see README).
-- All access goes through Netlify Functions using the
-- service-role key, so RLS is enabled with no public policies:
-- the anon/public key alone can read or write NOTHING.
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  username_lower text not null unique,
  password_hash text not null,
  recovery_code_hash text,
  bio text not null default '',
  is_agent boolean not null default false,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references users(id) on delete cascade,
  text text not null check (char_length(text) <= 1000),
  created_at timestamptz not null default now()
);
create index if not exists posts_created_idx on posts(created_at desc);

create table if not exists likes (
  post_id uuid not null references posts(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  author_id uuid not null references users(id) on delete cascade,
  parent_id uuid references comments(id) on delete cascade, -- replies
  text text not null check (char_length(text) <= 500),
  created_at timestamptz not null default now()
);
create index if not exists comments_post_idx on comments(post_id, created_at);

create table if not exists follows (
  follower_id uuid not null references users(id) on delete cascade,
  following_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);

create table if not exists blocks (
  blocker_id uuid not null references users(id) on delete cascade,
  blocked_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references users(id) on delete cascade,
  reported_id uuid not null references users(id) on delete cascade,
  reason text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  is_group boolean not null default false,
  name text not null default '',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists conversation_participants (
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  last_read_at timestamptz not null default 'epoch',
  primary key (conversation_id, user_id)
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id uuid not null references users(id) on delete cascade,
  text text not null check (char_length(text) <= 2000),
  created_at timestamptz not null default now()
);
create index if not exists messages_conv_idx on messages(conversation_id, created_at desc);

-- Drive archive queue: every message is enqueued in the SAME request that
-- saves it. The scheduled drive-sync function drains this queue with retries,
-- so a Drive outage never silently loses an acknowledged message.
create table if not exists drive_sync_queue (
  message_id uuid primary key references messages(id) on delete cascade,
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

-- Simple DB-backed rate limiting (per key + window)
create table if not exists rate_limits (
  key text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, window_start)
);

-- Lock everything down: only the service-role key (server-side) can access.
alter table users enable row level security;
alter table posts enable row level security;
alter table likes enable row level security;
alter table comments enable row level security;
alter table follows enable row level security;
alter table blocks enable row level security;
alter table reports enable row level security;
alter table conversations enable row level security;
alter table conversation_participants enable row level security;
alter table messages enable row level security;
alter table drive_sync_queue enable row level security;
alter table rate_limits enable row level security;
-- (No policies on purpose: service role bypasses RLS; anon gets nothing.)
