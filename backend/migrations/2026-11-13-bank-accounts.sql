-- Separate the existing primary-account boxes from a new, empty secondary set.
-- Run once in the Supabase SQL editor before deploying the matching backend.

create table if not exists bank_accounts (
  id text primary key,
  name text not null,
  balance numeric(13,3) not null default 0,
  sort smallint not null
);

insert into bank_accounts (id, name, balance, sort)
select 'account_1', 'Account 1', bank_balance, 1
from settings
where id = 'main'
on conflict (id) do nothing;

insert into bank_accounts (id, name, balance, sort)
values ('account_2', 'Account 2', 0, 2)
on conflict (id) do nothing;

create table if not exists account_buckets (
  account_id text not null references bank_accounts(id),
  bucket_key text not null,
  name text not null,
  balance numeric(13,3) not null default 0,
  percent numeric(5,2) not null default 0,
  cap numeric(13,3),
  target numeric(13,3),
  sort smallint not null,
  primary key (account_id, bucket_key)
);

insert into account_buckets (account_id, bucket_key, name, balance, percent, cap, target, sort)
select 'account_1', key, name, balance, percent, cap, target, sort
from buckets
on conflict (account_id, bucket_key) do nothing;

-- The secondary account starts empty and uses the existing allocation settings.
insert into account_buckets (account_id, bucket_key, name, balance, percent, cap, target, sort)
select 'account_2', bucket_key, name, 0, percent, cap, target, sort
from account_buckets
where account_id = 'account_1'
on conflict (account_id, bucket_key) do nothing;

create table if not exists account_bucket_moves (
  id uuid primary key default gen_random_uuid(),
  move_date date not null,
  from_account text references bank_accounts(id),
  from_bucket text,
  to_account text references bank_accounts(id),
  to_bucket text,
  amount numeric(13,3) not null check (amount > 0),
  fee_amount numeric(13,3) not null default 0 check (fee_amount >= 0),
  reason text not null,
  entry_id uuid references entries(id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((from_account is null) = (from_bucket is null)),
  check ((to_account is null) = (to_bucket is null))
);

create index if not exists account_bucket_moves_entry_idx on account_bucket_moves (entry_id);
create index if not exists account_bucket_moves_date_idx on account_bucket_moves (move_date);

-- Preserve the existing primary-account activity timeline.
insert into account_bucket_moves (id, move_date, from_account, from_bucket, to_account, to_bucket, amount, reason, entry_id, created_at)
select id, move_date,
  case when from_bucket is null then null else 'account_1' end,
  from_bucket,
  case when to_bucket is null then null else 'account_1' end,
  to_bucket,
  amount, reason, entry_id, created_at
from bucket_moves
on conflict (id) do nothing;

alter table entries
  add column if not exists bank_account text not null default 'account_1' references bank_accounts(id);

create or replace function transfer_between_bank_accounts(
  p_from_account text,
  p_from_bucket text,
  p_to_account text,
  p_to_bucket text,
  p_amount numeric,
  p_fee numeric,
  p_move_date date
) returns uuid
language plpgsql
as $$
declare
  v_source_box numeric(13,3);
  v_target_box numeric(13,3);
  v_source_balance numeric(13,3);
  v_target_balance numeric(13,3);
  v_fee_entry uuid;
  v_transfer uuid;
  v_total numeric(13,3);
begin
  if p_from_account = p_to_account then
    raise exception 'Choose two different bank accounts for an inter-account transfer';
  end if;
  if p_amount <= 0 or p_fee < 0 then
    raise exception 'Transfer amount must be positive and fee cannot be negative';
  end if;

  v_total := round(p_amount + p_fee, 3);

  select balance into v_source_box
  from account_buckets
  where account_id = p_from_account and bucket_key = p_from_bucket
  for update;
  if not found then raise exception 'Source box not found'; end if;

  select balance into v_target_box
  from account_buckets
  where account_id = p_to_account and bucket_key = p_to_bucket
  for update;
  if not found then raise exception 'Destination box not found'; end if;
  if v_total > v_source_box then raise exception 'Source box balance is too low, including the fee'; end if;

  select balance into v_source_balance from bank_accounts where id = p_from_account for update;
  if not found then raise exception 'Source bank account not found'; end if;
  select balance into v_target_balance from bank_accounts where id = p_to_account for update;
  if not found then raise exception 'Destination bank account not found'; end if;
  if v_total > v_source_balance then raise exception 'Source bank account balance is too low, including the fee'; end if;

  update account_buckets
    set balance = round(balance - v_total, 3)
    where account_id = p_from_account and bucket_key = p_from_bucket;
  update account_buckets
    set balance = round(balance + p_amount, 3)
    where account_id = p_to_account and bucket_key = p_to_bucket;
  update bank_accounts
    set balance = round(balance - v_total, 3)
    where id = p_from_account;
  update bank_accounts
    set balance = round(balance + p_amount, 3)
    where id = p_to_account;

  if p_from_account = (select id from bank_accounts where sort = 1)
    or p_to_account = (select id from bank_accounts where sort = 1) then
    update settings set bank_balance = (select balance from bank_accounts where sort = 1) where id = 'main';
  end if;

  if p_fee > 0 then
    insert into entries (entry_date, type, amount, category, payment_method, bank_account, bucket, note)
    values (
      p_move_date, 'expense', p_fee, 'Other', 'debit', p_from_account, p_from_bucket,
      'Bank transfer fee (' || upper(p_from_account) || ' to ' || upper(p_to_account) || ')'
    ) returning id into v_fee_entry;

    insert into account_bucket_moves (
      move_date, from_account, from_bucket, amount, reason, entry_id
    ) values (p_move_date, p_from_account, p_from_bucket, p_fee, 'spend', v_fee_entry);
  end if;

  insert into account_bucket_moves (
    move_date, from_account, from_bucket, to_account, to_bucket, amount, reason
  ) values (p_move_date, p_from_account, p_from_bucket, p_to_account, p_to_bucket, p_amount, 'account_transfer')
  returning id into v_transfer;

  return v_transfer;
end;
$$;

revoke all on function transfer_between_bank_accounts(text, text, text, text, numeric, numeric, date) from public, anon, authenticated;
grant execute on function transfer_between_bank_accounts(text, text, text, text, numeric, numeric, date) to service_role;
