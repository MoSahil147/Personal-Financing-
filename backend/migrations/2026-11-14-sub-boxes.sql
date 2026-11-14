-- Sub-boxes: a box (e.g. Investing) can hold its money in named pockets.
-- The pockets always add up to their box's balance. Every amount (monthly
-- share, limits) and every name is set privately in the SQL editor - none of
-- it is kept in this repo. Run once in Supabase before deploying. Safe to re-run.

create table if not exists account_sub_buckets (
  account_id text not null,
  parent_key text not null,
  sub_key text not null,
  name text not null,
  balance numeric(13,3) not null default 0,
  share numeric(13,3) not null default 0,     -- monthly amount; incoming money is split in proportion
  cap numeric(13,3),                           -- null = no limit; the extra leaves at month end
  carries boolean not null default true,       -- false = starts fresh each month
  leftover_to text,                            -- where a non-carrying pocket's leftover goes (same box)
  is_default boolean not null default false,   -- used when no pocket is picked
  takes_rest boolean not null default false,   -- gets the rounding pennies of a split
  sort smallint not null default 0,
  primary key (account_id, parent_key, sub_key),
  foreign key (account_id, parent_key) references account_buckets(account_id, bucket_key)
);

alter table account_bucket_moves add column if not exists from_sub text;
alter table account_bucket_moves add column if not exists to_sub text;
alter table entries add column if not exists sub_bucket text;

drop function if exists transfer_between_bank_accounts(text, text, text, text, numeric, numeric, date);

create or replace function transfer_between_bank_accounts(
  p_from_account text,
  p_from_bucket text,
  p_to_account text,
  p_to_bucket text,
  p_amount numeric,
  p_fee numeric,
  p_move_date date,
  p_from_sub text default null,
  p_to_sub text default null
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
  v_from_sub text;
  v_to_sub text;
  v_sub_balance numeric(13,3);
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

  -- Pockets: the picked one, or the box's default pocket when it has pockets.
  v_from_sub := coalesce(p_from_sub, (select sub_key from account_sub_buckets
    where account_id = p_from_account and parent_key = p_from_bucket and is_default limit 1));
  v_to_sub := coalesce(p_to_sub, (select sub_key from account_sub_buckets
    where account_id = p_to_account and parent_key = p_to_bucket and is_default limit 1));
  if v_from_sub is not null then
    select balance into v_sub_balance from account_sub_buckets
    where account_id = p_from_account and parent_key = p_from_bucket and sub_key = v_from_sub
    for update;
    if not found then raise exception 'Source pocket not found'; end if;
    if p_from_sub is not null and v_total > v_sub_balance then
      raise exception 'Source pocket balance is too low, including the fee';
    end if;
  end if;
  if v_to_sub is not null then
    perform 1 from account_sub_buckets
    where account_id = p_to_account and parent_key = p_to_bucket and sub_key = v_to_sub
    for update;
    if not found then raise exception 'Destination pocket not found'; end if;
  end if;

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
  if v_from_sub is not null then
    update account_sub_buckets set balance = round(balance - v_total, 3)
      where account_id = p_from_account and parent_key = p_from_bucket and sub_key = v_from_sub;
  end if;
  if v_to_sub is not null then
    update account_sub_buckets set balance = round(balance + p_amount, 3)
      where account_id = p_to_account and parent_key = p_to_bucket and sub_key = v_to_sub;
  end if;
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
    insert into entries (entry_date, type, amount, category, payment_method, bank_account, bucket, sub_bucket, note)
    values (
      p_move_date, 'expense', p_fee, 'Other', 'debit', p_from_account, p_from_bucket, v_from_sub,
      'Bank transfer fee (' || upper(p_from_account) || ' to ' || upper(p_to_account) || ')'
    ) returning id into v_fee_entry;

    insert into account_bucket_moves (
      move_date, from_account, from_bucket, from_sub, amount, reason, entry_id
    ) values (p_move_date, p_from_account, p_from_bucket, v_from_sub, p_fee, 'spend', v_fee_entry);
  end if;

  insert into account_bucket_moves (
    move_date, from_account, from_bucket, from_sub, to_account, to_bucket, to_sub, amount, reason
  ) values (p_move_date, p_from_account, p_from_bucket, v_from_sub, p_to_account, p_to_bucket, v_to_sub, p_amount, 'account_transfer')
  returning id into v_transfer;

  return v_transfer;
end;
$$;

revoke all on function transfer_between_bank_accounts(text, text, text, text, numeric, numeric, date, text, text) from public, anon, authenticated;
grant execute on function transfer_between_bank_accounts(text, text, text, text, numeric, numeric, date, text, text) to service_role;
