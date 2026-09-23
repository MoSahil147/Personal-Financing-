const supabase = require('./supabase');
const { todayISO } = require('./date');
const { getSettings } = require('./balances');
const math = require('./bucketMath');

async function loadBuckets() {
  const { data, error } = await supabase.from('buckets').select('*').order('sort');
  if (error) throw new Error(error.message);
  return data.map((b) => ({
    ...b,
    balance: Number(b.balance),
    percent: Number(b.percent),
    cap: b.cap == null ? null : Number(b.cap),
  }));
}

function toMap(rows) {
  return Object.fromEntries(rows.map((r) => [r.key, r]));
}

// What the user actually has right now - the boxes should add up to this.
async function realMoney() {
  const s = await getSettings();
  return math.round2(Number(s.bank_balance) + Number(s.cash_balance) - Number(s.credit_outstanding));
}

// Adds/removes each move's amount on the affected boxes. A move is
// { from, to, amount } where a null `from` is money coming in and a null
// `to` is money going out.
async function adjustBalances(moves) {
  const map = toMap(await loadBuckets());
  const touched = new Set();
  for (const m of moves) {
    for (const key of [m.from, m.to]) {
      if (key && !map[key]) throw new Error(`Unknown box: ${key}`);
    }
    if (m.from) { map[m.from].balance = math.round2(map[m.from].balance - m.amount); touched.add(m.from); }
    if (m.to) { map[m.to].balance = math.round2(map[m.to].balance + m.amount); touched.add(m.to); }
  }
  for (const key of touched) {
    const { error } = await supabase.from('buckets').update({ balance: map[key].balance }).eq('key', key);
    if (error) throw new Error(error.message);
  }
}

// Applies moves to the boxes and records them in the box history.
async function applyMoves(moves, { reason, entry_id = null, date = todayISO() }) {
  const real = moves.filter((m) => m.amount > 0);
  if (!real.length) return;
  await adjustBalances(real);
  const { error } = await supabase.from('bucket_moves').insert(real.map((m) => ({
    move_date: date,
    from_bucket: m.from || null,
    to_bucket: m.to || null,
    amount: m.amount,
    reason,
    entry_id,
  })));
  if (error) throw new Error(error.message);
}

// Moves money into/out of the boxes for a newly saved entry. `bucket` is a
// box key, 'split' (income split by percentage), or null (leave boxes alone).
async function applyEntry(entry, bucket) {
  if (!bucket) return;
  const amount = Number(entry.amount);
  const opts = { entry_id: entry.id, date: entry.entry_date };

  if (entry.type === 'expense') {
    return applyMoves([{ from: bucket, amount }], { ...opts, reason: 'spend' });
  }
  if (bucket === 'split') {
    const shares = math.computeSplit(amount, toMap(await loadBuckets()));
    return applyMoves(Object.entries(shares).map(([to, a]) => ({ to, amount: a })), { ...opts, reason: 'income' });
  }
  return applyMoves([{ to: bucket, amount }], { ...opts, reason: entry.category === 'Refund' ? 'refund' : 'income' });
}

// Read an entry's box moves BEFORE deleting the entry (the delete cascades
// them away), then pass them to reverseMoves afterwards.
async function getEntryMoves(entryId) {
  const { data, error } = await supabase.from('bucket_moves').select('*').eq('entry_id', entryId);
  if (error) throw new Error(error.message);
  return data;
}

async function reverseMoves(moves) {
  await adjustBalances(moves.map((m) => ({ from: m.to_bucket, to: m.from_bucket, amount: Number(m.amount) })));
}

function lastDayOf(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// Runs every month-end close that's due (lazily, whenever the boxes are read -
// the Render backend sleeps, so a timer can't be trusted). Each month is
// claimed on settings.last_closed_month first, so two requests arriving at
// once can't both close the same month.
async function closeDueMonths() {
  const settings = await getSettings();
  const current = todayISO().slice(0, 7);
  let last = settings.last_closed_month || null;
  const months = math.monthsToClose(settings.boxes_start_month || '2026-10', last, current);

  for (const month of months) {
    let claim = supabase.from('settings').update({ last_closed_month: month }).eq('id', 'main');
    claim = last ? claim.eq('last_closed_month', last) : claim.is('last_closed_month', null);
    const { data, error } = await claim.select();
    if (error) throw new Error(error.message);
    if (!data.length) return; // another request is already closing it

    const { moves } = math.computeClose(toMap(await loadBuckets()));
    await applyMoves(moves, { reason: `close:${month}`, date: lastDayOf(month) });
    last = month;
  }
}

async function hasAnyMoves() {
  const { count, error } = await supabase.from('bucket_moves').select('id', { count: 'exact', head: true });
  if (error) throw new Error(error.message);
  return count > 0;
}

async function setupPreview() {
  const [boxes, total, used] = await Promise.all([loadBuckets(), realMoney(), hasAnyMoves()]);
  return { total, shares: math.computeSetup(total, toMap(boxes)), alreadySetUp: used };
}

// One-time starting allocation from the money on hand today.
async function setupFromCurrentMoney() {
  const preview = await setupPreview();
  if (preview.alreadySetUp) throw new Error('Boxes are already set up');
  if (!(preview.total > 0)) throw new Error('No money to allocate yet - set your bank/cash balance first');
  await applyMoves(Object.entries(preview.shares).map(([to, amount]) => ({ to, amount })), { reason: 'setup' });
  return preview;
}

async function splitPreview(amount) {
  return math.computeSplit(amount, toMap(await loadBuckets()));
}

// Total spent from each box since the 1st of this month.
async function spentThisMonth() {
  const { data, error } = await supabase
    .from('bucket_moves')
    .select('from_bucket, amount')
    .eq('reason', 'spend')
    .gte('move_date', `${todayISO().slice(0, 7)}-01`);
  if (error) throw new Error(error.message);
  const spent = {};
  for (const m of data) spent[m.from_bucket] = math.round2((spent[m.from_bucket] || 0) + Number(m.amount));
  return spent;
}

async function overview() {
  await closeDueMonths();
  const [buckets, real, spent, used] = await Promise.all([loadBuckets(), realMoney(), spentThisMonth(), hasAnyMoves()]);
  const total = math.round2(buckets.reduce((s, b) => s + b.balance, 0));
  return {
    buckets,
    total,
    realMoney: real,
    unallocated: math.round2(real - total),
    spentThisMonth: spent,
    needsSetup: !used,
  };
}

async function recentMoves(limit = 40) {
  const { data, error } = await supabase
    .from('bucket_moves')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data;
}

module.exports = {
  applyEntry,
  getEntryMoves,
  reverseMoves,
  closeDueMonths,
  setupPreview,
  setupFromCurrentMoney,
  splitPreview,
  overview,
  recentMoves,
};
