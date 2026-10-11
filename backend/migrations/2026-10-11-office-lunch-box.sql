-- Adds the Office Lunch box, right after Groceries. Run once in the Supabase
-- SQL editor BEFORE deploying the backend that uses it. Safe to re-run.
-- Its percentage is set privately afterwards (taken out of Groceries' share) -
-- like every other personal number, it is never kept in this repo.
with added as (
  insert into buckets (key, name, sort) values ('office_lunch', 'Office Lunch', 3)
  on conflict (key) do nothing
  returning key
)
update buckets set sort = sort + 1
where sort >= 3 and key <> 'office_lunch' and exists (select 1 from added);
