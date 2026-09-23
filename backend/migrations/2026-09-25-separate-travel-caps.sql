-- Home / Other Trips and Roaming are separate boxes with their own caps
-- (they used to share one 10,000 travel cap). Also sets the new box name.
-- Run once in the Supabase SQL editor. Balances are untouched.
update buckets set name = 'Home / Other Trips', cap = 7000 where key = 'home_trips';
update buckets set cap = 3000 where key = 'roaming';
