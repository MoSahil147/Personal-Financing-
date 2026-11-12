const supabase = require('./supabase');
const { todayISO } = require('./date');
const { getSettings } = require('./balances');
const math = require('./bucketMath');

async function accountIds() {
  const settings = await getSettings();
  return settings.bank_accounts.map((account) => account.id);
}

async function resolveAccountId(accountId) {
  const ids = await accountIds();
  const resolved = accountId || ids[0];
  if (!ids.includes(resolved)) throw new Error(`Unknown bank account: ${resolved}`);
  return resolved;
}

async function loadBuckets(accountId) {
  accountId = await resolveAccountId(accountId);
  const { data, error } = await supabase.from('account_buckets').select('*').eq('account_id', accountId).order('sort');
  if (error) throw new Error(error.message);
  return data.map((b) => ({
    ...b,
    key: b.bucket_key,
    balance: Number(b.balance),
    percent: Number(b.percent),
    cap: b.cap == null ? null : Number(b.cap),
    target: b.target == null ? null : Number(b.target),
  }));
}

function toMap(rows) {
  return Object.fromEntries(rows.map((r) => [r.bucket_key, {
    ...r,
    key: r.bucket_key,
  }]));
}

function accountBucketId(accountId, key) {
  return `${accountId}:${key}`;
}

async function realMoney(accountId) {
  accountId = await resolveAccountId(accountId);
  const settings = await getSettings();
  const account = settings.bank_accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`Unknown bank account: ${accountId}`);
  return math.round3(account.sort === 1
    ? Number(account.balance) + Number(settings.cash_balance) - Number(settings.credit_outstanding)
    : Number(account.balance));
}

async function adjustBalances(moves) {
  const accountIds = [...new Set(moves.flatMap((m) => [m.from_account, m.to_account].filter(Boolean)))];
  if (!accountIds.length) return;
  const { data, error } = await supabase.from('account_buckets').select('*').in('account_id', accountIds);
  if (error) throw new Error(error.message);
  const map = new Map(data.map((b) => [accountBucketId(b.account_id, b.bucket_key), {
    ...b,
    balance: Number(b.balance),
  }]));
  const touched = new Set();

  for (const m of moves) {
    if (m.from_account && m.from_bucket) {
      const id = accountBucketId(m.from_account, m.from_bucket);
      const box = map.get(id);
      if (!box) throw new Error(`Unknown box: ${m.from_bucket} (${m.from_account.toUpperCase()})`);
      box.balance = math.round3(box.balance - m.amount);
      touched.add(id);
    }
    if (m.to_account && m.to_bucket) {
      const id = accountBucketId(m.to_account, m.to_bucket);
      const box = map.get(id);
      if (!box) throw new Error(`Unknown box: ${m.to_bucket} (${m.to_account.toUpperCase()})`);
      box.balance = math.round3(box.balance + m.amount);
      touched.add(id);
    }
  }

  for (const id of touched) {
    const box = map.get(id);
    const { error: updateError } = await supabase.from('account_buckets')
      .update({ balance: box.balance })
      .eq('account_id', box.account_id)
      .eq('bucket_key', box.bucket_key);
    if (updateError) throw new Error(updateError.message);
  }
}

async function applyMoves(moves, { reason, entry_id = null, date = todayISO(), accountId }) {
  const real = moves.filter((m) => m.amount > 0);
  if (!real.length) return;
  accountId = await resolveAccountId(accountId);
  const rows = real.map((m) => ({
    move_date: date,
    from_account: m.from ? accountId : null,
    from_bucket: m.from || null,
    to_account: m.to ? accountId : null,
    to_bucket: m.to || null,
    amount: m.amount,
    reason,
    entry_id,
  }));
  await adjustBalances(rows);
  const { error } = await supabase.from('account_bucket_moves').insert(rows);
  if (error) throw new Error(error.message);
}

function splitFor(category, amount, boxes) {
  return category === 'Salary' ? math.computeSalarySplit(amount, boxes) : math.computeSplit(amount, boxes);
}

function planIncome(amount, category, newMonth, boxes) {
  let closeMoves = [];
  let after = boxes;
  if (newMonth) {
    const closed = math.computeClose(boxes);
    closeMoves = closed.moves;
    after = Object.fromEntries(Object.entries(boxes).map(([k, b]) => [k, { ...b, balance: closed.balances[k] }]));
  }
  return { closeMoves, shares: splitFor(category, amount, after) };
}

async function applyEntry(entry, bucket, { newMonth = false } = {}) {
  if (!bucket) return;
  const amount = Number(entry.amount);
  const accountId = await resolveAccountId(entry.bank_account);
  const opts = { entry_id: entry.id, date: entry.entry_date, accountId };

  if (entry.type === 'expense') {
    return applyMoves([{ from: bucket, amount }], { ...opts, reason: 'spend' });
  }
  if (newMonth) {
    const { moves } = math.computeClose(toMap(await loadBuckets(accountId)));
    await applyMoves(moves, { ...opts, reason: 'close' });
  }
  if (bucket === 'split') {
    const shares = splitFor(entry.category, amount, toMap(await loadBuckets(accountId)));
    return applyMoves(Object.entries(shares).map(([to, a]) => ({ to, amount: a })), {
      ...opts,
      reason: newMonth ? 'salary' : 'income',
    });
  }
  const reason = newMonth ? 'salary' : entry.category === 'Refund' ? 'refund' : 'income';
  return applyMoves([{ to: bucket, amount }], { ...opts, reason });
}

async function getEntryMoves(entryId) {
  const { data, error } = await supabase.from('account_bucket_moves').select('*').eq('entry_id', entryId);
  if (error) throw new Error(error.message);
  return data;
}

async function reverseMoves(moves) {
  await adjustBalances(moves.map((m) => ({
    from_account: m.to_account,
    from_bucket: m.to_bucket,
    to_account: m.from_account,
    to_bucket: m.from_bucket,
    amount: Number(m.amount),
  })));
}

async function hasAnyMoves(accountId) {
  accountId = await resolveAccountId(accountId);
  const { count, error } = await supabase.from('account_bucket_moves')
    .select('id', { count: 'exact', head: true })
    .or(`from_account.eq.${accountId},to_account.eq.${accountId}`);
  if (error) throw new Error(error.message);
  return count > 0;
}

async function setupPreview(accountId) {
  accountId = await resolveAccountId(accountId);
  const [boxes, total, used] = await Promise.all([loadBuckets(accountId), realMoney(accountId), hasAnyMoves(accountId)]);
  return { total, shares: math.computeSetup(total, toMap(boxes)), alreadySetUp: used };
}

async function setupFromCurrentMoney(accountId) {
  accountId = await resolveAccountId(accountId);
  const preview = await setupPreview(accountId);
  if (preview.alreadySetUp) throw new Error('Boxes are already set up');
  if (!(preview.total > 0)) throw new Error('No money to allocate yet - set the account balance first');
  await applyMoves(Object.entries(preview.shares).map(([to, amount]) => ({ to, amount })), { reason: 'setup', accountId });
  return preview;
}

async function splitPreview(amount, { category, newMonth, accountId }) {
  accountId = await resolveAccountId(accountId);
  return planIncome(amount, category, newMonth, toMap(await loadBuckets(accountId)));
}

async function monthStartedAt(accountId) {
  accountId = await resolveAccountId(accountId);
  const { data, error } = await supabase.from('account_bucket_moves')
    .select('created_at, entry_id')
    .in('reason', ['salary', 'close', 'setup'])
    .or(`from_account.eq.${accountId},to_account.eq.${accountId}`)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const latest = data[0];
  if (!latest) return null;
  if (!latest.entry_id) return latest.created_at;

  const { data: first, error: firstErr } = await supabase.from('account_bucket_moves')
    .select('created_at')
    .eq('entry_id', latest.entry_id)
    .or(`from_account.eq.${accountId},to_account.eq.${accountId}`)
    .order('created_at', { ascending: true })
    .limit(1);
  if (firstErr) throw new Error(firstErr.message);
  return first[0]?.created_at || latest.created_at;
}

async function spentThisMonth(accountId) {
  accountId = await resolveAccountId(accountId);
  const since = await monthStartedAt(accountId);
  let query = supabase.from('account_bucket_moves').select('from_bucket, amount, reason')
    .eq('from_account', accountId).in('reason', ['spend', 'close']);
  if (since) query = query.gte('created_at', since);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const spent = {};
  for (const m of data) {
    if (m.reason === 'close' && m.from_bucket !== 'buffer') continue;
    spent[m.from_bucket] = math.round3((spent[m.from_bucket] || 0) + Number(m.amount));
  }
  return spent;
}

async function boxActivity(key, accountId) {
  accountId = await resolveAccountId(accountId);
  if (!math.BUCKET_KEYS.includes(key)) throw new Error(`Unknown box: ${key}`);
  const since = await monthStartedAt(accountId);
  let query = supabase.from('account_bucket_moves').select('*, entries(category, note, payment_method)')
    .or(`and(from_account.eq.${accountId},from_bucket.eq.${key}),and(to_account.eq.${accountId},to_bucket.eq.${key})`)
    .order('created_at', { ascending: false });
  if (since) query = query.gte('created_at', since);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return { since, moves: data };
}

async function sweepUnallocated(accountId) {
  accountId = await resolveAccountId(accountId);
  if (!(await hasAnyMoves(accountId))) return;
  const [boxes, real] = await Promise.all([loadBuckets(accountId), realMoney(accountId)]);
  const total = boxes.reduce((s, b) => s + b.balance, 0);
  await applyMoves(math.computeSweep(real - total, toMap(boxes)), { reason: 'sweep', accountId });
}

async function transfer(from, to, amount, accountId) {
  accountId = await resolveAccountId(accountId);
  const move = math.computeTransfer(from, to, amount, toMap(await loadBuckets(accountId)));
  await applyMoves([move], { reason: 'transfer', accountId });
  return move;
}

async function transferBetweenAccounts({ fromAccount, from, toAccount, to, amount, fee = 0 }) {
  const ids = await accountIds();
  if (!ids.includes(fromAccount) || !ids.includes(toAccount)) {
    throw new Error('Pick valid source and destination accounts');
  }
  const feeAmount = math.round3(fee);
  if (!Number.isFinite(feeAmount) || feeAmount < 0) throw new Error('Transfer fee must be 0 or more');
  const boxes = toMap(await loadBuckets(fromAccount));
  if (fromAccount === toAccount) {
    if (feeAmount) throw new Error('A transfer fee is only available between different bank accounts');
    const move = math.computeTransfer(from, to, amount, boxes);
    await applyMoves([move], { reason: 'transfer', accountId: fromAccount });
    return move;
  }
  const move = math.computeInterAccountTransfer(from, to, amount, feeAmount, fromAccount, toAccount, boxes);

  const { data: id, error } = await supabase.rpc('transfer_between_bank_accounts', {
    p_from_account: fromAccount,
    p_from_bucket: from,
    p_to_account: toAccount,
    p_to_bucket: to,
    p_amount: move.amount,
    p_fee: move.fee,
    p_move_date: todayISO(),
  });
  if (error) throw new Error(error.message);
  const { data, error: fetchError } = await supabase.from('account_bucket_moves').select('*').eq('id', id).single();
  if (fetchError) throw new Error(fetchError.message);
  return data;
}

async function overview(accountId) {
  accountId = await resolveAccountId(accountId);
  const [buckets, real, spent, used] = await Promise.all([
    loadBuckets(accountId), realMoney(accountId), spentThisMonth(accountId), hasAnyMoves(accountId),
  ]);
  const total = math.round3(buckets.reduce((s, b) => s + b.balance, 0));
  return {
    accountId,
    buckets,
    total,
    realMoney: real,
    unallocated: math.round3(real - total),
    spentThisMonth: spent,
    needsSetup: !used && real > 0,
  };
}

async function recentMoves(accountId, limit = 40) {
  accountId = await resolveAccountId(accountId);
  const { data, error } = await supabase.from('account_bucket_moves').select('*')
    .or(`from_account.eq.${accountId},to_account.eq.${accountId}`)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return data;
}

module.exports = {
  accountIds,
  resolveAccountId,
  applyEntry,
  getEntryMoves,
  reverseMoves,
  setupPreview,
  setupFromCurrentMoney,
  splitPreview,
  overview,
  sweepUnallocated,
  transfer,
  transferBetweenAccounts,
  recentMoves,
  boxActivity,
};
