-- Run this once in the Supabase SQL editor for your project.
-- Single-user app: no auth/user_id columns needed, access is gated by the backend password.
--
-- If you already created these tables before, `create table if not exists`
-- below is a no-op for them - existing columns/constraints won't update.
-- Migrations needed for tables created before a given feature was added:
--   -- monthly_savings_target (savings goal tracking):
--   alter table settings add column if not exists monthly_savings_target numeric(12,2) not null default 0;
--   -- 'investment' classification (investment tracking):
--   alter table entries drop constraint if exists entries_classification_check;
--   alter table entries add constraint entries_classification_check
--     check (classification in ('need', 'want', 'luxury', 'savings', 'investment'));
--   -- cash tracking (cash_balance + 'cash' as a payment_method):
--   alter table settings add column if not exists cash_balance numeric(12,2) not null default 0;
--   alter table entries drop constraint if exists entries_payment_method_check;
--   alter table entries add constraint entries_payment_method_check
--     check (payment_method in ('debit', 'credit', 'cash'));
--   -- then privately seed your real cash-on-hand (never commit the number):
--   update settings set cash_balance = <your cash> where id = 'main';
--   -- priority stars on reminders:
--   alter table reminders add column if not exists priority smallint not null default 3 check (priority between 1 and 5);

create table if not exists entries (
  id uuid primary key default gen_random_uuid(),
  entry_date date not null,
  type text not null check (type in ('income', 'expense')),
  amount numeric(12,2) not null check (amount > 0),
  category text not null,
  classification text check (classification in ('need', 'want', 'luxury', 'savings', 'investment')),
  payment_method text check (payment_method in ('debit', 'credit', 'cash')), -- 'cash' applies to income too (someone paid you cash); null/'debit' income means it hit the bank directly
  note text,
  raw_input text,
  created_at timestamptz not null default now()
);

-- Single row holding live balances. Seed bank_balance and cash_balance with
-- your real starting numbers after creating this table, e.g.:
--   update settings set bank_balance = <your balance>, cash_balance = <your cash> where id = 'main';
create table if not exists settings (
  id text primary key default 'main',
  bank_balance numeric(12,2) not null default 0,
  credit_outstanding numeric(12,2) not null default 0,
  monthly_savings_target numeric(12,2) not null default 0,
  cash_balance numeric(12,2) not null default 0
);
insert into settings (id, bank_balance, credit_outstanding, monthly_savings_target, cash_balance)
values ('main', 0, 0, 0, 0)
on conflict (id) do nothing;

create table if not exists budgets (
  id uuid primary key default gen_random_uuid(),
  category text not null unique, -- use 'overall' for the whole-month cap
  limit_amount numeric(12,2) not null check (limit_amount > 0),
  created_at timestamptz not null default now()
);

create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  done boolean not null default false,
  due_date date,
  priority smallint not null default 3 check (priority between 1 and 5), -- 5 = most important
  created_at timestamptz not null default now()
);

create index if not exists entries_date_idx on entries (entry_date);
create index if not exists entries_category_idx on entries (category);