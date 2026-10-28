-- ============================================================
-- MuseTalk — 31 Oct 2026 update (ONE-TIME migration)
-- Run ONCE: Supabase Dashboard → SQL Editor → paste → Run.
-- Adds: bookmarks (save a post), reposts (reshare), a pinned
-- post per profile, and an edited marker on posts.
-- Everything is additive and safe to run — existing data is
-- untouched, and each statement is idempotent.
-- ============================================================

create table if not exists bookmarks (
  post_id uuid not null references posts(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists reposts (
  post_id uuid not null references posts(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index if not exists reposts_created_idx on reposts(created_at desc);

alter table users add column if not exists pinned_post_id uuid references posts(id) on delete set null;
alter table posts add column if not exists edited_at timestamptz;

-- Same lockdown as the rest of the schema: service-role only.
alter table bookmarks enable row level security;
alter table reposts enable row level security;
