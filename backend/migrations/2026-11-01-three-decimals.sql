-- Money is kept to 3 decimal places. Widening a numeric column keeps every
-- existing value exactly as it is. Safe to run more than once.
alter table entries alter column amount type numeric(13,3);

alter table settings
  alter column bank_balance type numeric(13,3),
  alter column cash_balance type numeric(13,3),
  alter column credit_outstanding type numeric(13,3),
  alter column monthly_savings_target type numeric(13,3),
  alter column credit_card_limit type numeric(13,3);

alter table budgets alter column limit_amount type numeric(13,3);

alter table buckets
  alter column balance type numeric(13,3),
  alter column cap type numeric(13,3),
  alter column target type numeric(13,3);

alter table bucket_moves alter column amount type numeric(13,3);

alter table purses alter column balance type numeric(13,3);
alter table purse_moves alter column amount type numeric(13,3);
