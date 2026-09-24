-- Home trips box now also covers other trips outside the UAE.
-- Run once in the Supabase SQL editor. Only renames the label; balances are untouched.
update buckets set name = 'Home Trips / Other Trips / Home Needs' where key = 'home_trips';
