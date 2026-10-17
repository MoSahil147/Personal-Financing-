-- Prepaid card purses (e.g. bus cards). Run once in the Supabase SQL editor
-- BEFORE deploying the backend that uses them. Safe to re-run.
-- A top-up is a normal expense (out of the bank/cash and a box, usually
-- Transport) that also adds to the card; a ride only takes money off the card,
-- since that money was already counted when the card was topped up.
-- The cards themselves (names, starting balances) are added privately
-- afterwards - like every other personal number, they are never kept in this repo.
create table if not exists purses (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  balance numeric(12,2) not null default 0,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists purse_moves (
  id uuid primary key default gen_random_uuid(),
  purse_id uuid not null references purses(id) on delete cascade,
  move_date date not null,
  amount numeric(12,2) not null check (amount <> 0),  -- + top-up, - ride
  reason text not null,                                -- topup | ride | adjust
  note text,
  entry_id uuid references entries(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists purse_moves_purse_idx on purse_moves (purse_id);
create index if not exists purse_moves_entry_idx on purse_moves (entry_id);

alter table entries add column if not exists purse_id uuid references purses(id) on delete set null;
