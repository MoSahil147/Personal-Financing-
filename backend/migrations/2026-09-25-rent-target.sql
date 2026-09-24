-- Adds the rent row's fixed monthly amount (buckets.target), so it lives in
-- the database instead of the code. Run once, then set the value privately:
--   update buckets set target = <your monthly rent> where key = 'rent';
alter table buckets add column if not exists target numeric(12,2);
