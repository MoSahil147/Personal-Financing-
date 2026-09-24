-- Budget boxes (docs/superpowers/specs/2026-09-24-budget-boxes-design.md).
-- Run this ONCE in the Supabase SQL editor BEFORE deploying the backend that
-- uses it. Safe to re-run.

create table if not exists buckets (
  key text primary key,
  name text not null,
  balance numeric(12,2) not null default 0,
  percent numeric(5,2) not null default 0,
  cap numeric(12,2),            -- null = no cap
  sort smallint not null
);

insert into buckets (key, name, percent, cap, sort) values
  ('rent',       'Rent',       38, null,  1),
  ('groceries',  'Groceries',  10, null,  2),
  ('transport',  'Transport',   2, null,  3),
  ('guilt_free', 'Guilt-free',  5, 1000,  4),
  ('home_trips', 'Home / Other Trips', 10, 7500, 5),
  ('roaming',    'Roaming',     5, 2500,  6),
  ('emergency',  'Emergency',   5, 15000, 7),
  ('investing',  'Investing',  25, null,  8),
  ('buffer',     'Buffer',      0, 300,   9)
on conflict (key) do nothing;

create table if not exists bucket_moves (
  id uuid primary key default gen_random_uuid(),
  move_date date not null,
  from_bucket text references buckets(key),   -- null = money coming in
  to_bucket text references buckets(key),     -- null = money going out
  amount numeric(12,2) not null check (amount > 0),
  reason text not null,                       -- setup | income | salary | refund | spend | close (month-end, run by a salary)
  entry_id uuid references entries(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists bucket_moves_entry_idx on bucket_moves (entry_id);
create index if not exists bucket_moves_date_idx on bucket_moves (move_date);

alter table entries add column if not exists bucket text;  -- box key, 'split', or null
-- (An earlier version also added settings.last_closed_month and
-- settings.boxes_start_month for a calendar month-end. The month-end now runs
-- when a salary is logged, so those two columns are unused and harmless.)
