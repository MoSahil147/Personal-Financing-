// Pure money math for the budget boxes - no database calls here, so every
// rule from the budget plan (percentage splits, caps, month-end overflow)
// can be tested directly with plain numbers.
//
// A "boxes" map looks like { rent: { key, balance, percent, cap, target }, ... }.
// Every amount (percentages, limits, the rent amount) comes from the database -
// nothing personal is hard-coded here.

// The fixed monthly rent (buckets.target on the rent row). Without one, rent
// is simply its percentage share of the incoming amount.
function rentTarget(boxes, amount) {
  const target = boxes.rent.target;
  return target != null && target > 0 ? Number(target) : round3((amount * boxes.rent.percent) / 100);
}

const BUCKET_KEYS = [
  'rent', 'groceries', 'office_lunch', 'transport', 'guilt_free', 'home_trips',
  'roaming', 'emergency', 'investing', 'buffer',
];
// The buffer is only fed by leftovers (grocery/lunch/transport at month end, rent's
// unused salary share), so it's never picked by hand for a spend or refund.
const PICKABLE_KEYS = BUCKET_KEYS.filter((k) => k !== 'buffer');

// Fallback box for an expense when the chat parser's pick is missing/invalid.
// The parser's own pick wins, since it knows the home city vs elsewhere and a
// regular outing vs a major one - a category alone can't tell those apart.
const CATEGORY_BUCKETS = {
  Rent: 'rent',
  Groceries: 'groceries',
  Transport: 'transport',
  Fuel: 'transport',
  Dining: 'guilt_free',
  Entertainment: 'guilt_free',
  Shopping: 'guilt_free',
  Subscriptions: 'guilt_free',
  Travel: 'roaming',
  Health: 'emergency',
  Investment: 'investing',
};

// All money is kept to 3 decimal places. toPrecision first, so binary float
// noise can't tip a value the wrong way (1.0005 * 1000 is 1000.4999999999999).
function round3(n) {
  return Math.round(Number((Number(n) * 1000).toPrecision(15))) / 1000;
}

// An amount for messages: 12.50, 12.345.
function money(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
}

function total(shares) {
  return Object.values(shares).reduce((s, v) => s + v, 0);
}

function defaultBucketFor(category) {
  if (category === 'Credit Card Payment') return null;
  return CATEGORY_BUCKETS[category] || 'guilt_free';
}

// Which box a parsed entry should use: 'split' for income (except refunds,
// which go back into one box), a box key for expenses, or null for transfers.
function suggestBucket({ type, category, bucket }) {
  const valid = PICKABLE_KEYS.includes(bucket);
  if (type === 'income') {
    if (category !== 'Refund') return 'split';
    return valid ? bucket : 'guilt_free';
  }
  if (category === 'Credit Card Payment') return null;
  return valid ? bucket : defaultBucketFor(category);
}

// Where a box's money goes when it would go over its limit.
const OVERFLOW_TO = { roaming: 'emergency', home_trips: 'emergency', emergency: 'investing', buffer: 'emergency' };

// Guilt-free starts fresh every month (computeClose), so a limit on it is
// never used to trim incoming money.
const LIMIT_AT_MONTH_END_ONLY = ['guilt_free'];

// ----- Sub-boxes (pockets inside a box) -----
// A box's `subs` list partitions its balance. Each pocket has a monthly `share`
// (incoming money is split in proportion), an optional `cap`, `carries`
// (false = starts fresh, its leftover goes to `leftover_to`), `is_default`
// (used when no pocket is picked) and `takes_rest` (gets rounding pennies).

function defaultSub(subs) {
  return (subs.find((s) => s.is_default) || subs[0])?.sub_key || null;
}

// Splits money coming into a box across its pockets by their monthly shares.
// Rounding pennies go to the takes_rest pocket so the parts add up exactly.
function splitIntoSubs(amount, subs) {
  const amt = round3(amount);
  if (!subs?.length || amt === 0) return {};
  const weight = subs.reduce((s, x) => s + Math.max(0, Number(x.share) || 0), 0);
  const result = {};
  if (weight > 0) {
    for (const x of subs) {
      const v = round3((amt * Math.max(0, Number(x.share) || 0)) / weight);
      if (v !== 0) result[x.sub_key] = v;
    }
  }
  const rest = round3(amt - total(result));
  if (rest !== 0) {
    const key = (subs.find((x) => x.takes_rest) || subs.find((x) => x.is_default) || subs[0]).sub_key;
    result[key] = round3((result[key] || 0) + rest);
  }
  return result;
}

// Month-end for one box's pockets. Pockets that don't carry send their
// leftover to `leftover_to` (an overspend is covered from it instead); then
// any pocket over its cap gives up the extra, which leaves the box.
// Returns the pocket-to-pocket moves, the money leaving the box, and the
// pocket balances afterwards.
function computeSubClose(subs) {
  const bal = Object.fromEntries(subs.map((x) => [x.sub_key, Number(x.balance)]));
  const internal = [];
  const overflow = [];
  const shift = (fromSub, toSub, amount) => {
    const amt = round3(amount);
    if (amt <= 0 || fromSub === toSub) return;
    bal[fromSub] = round3(bal[fromSub] - amt);
    bal[toSub] = round3(bal[toSub] + amt);
    internal.push({ fromSub, toSub, amount: amt });
  };
  for (const x of subs) {
    if (x.carries !== false || !x.leftover_to || !(x.leftover_to in bal)) continue;
    if (bal[x.sub_key] > 0) shift(x.sub_key, x.leftover_to, bal[x.sub_key]);
    else if (bal[x.sub_key] < 0) shift(x.leftover_to, x.sub_key, -bal[x.sub_key]);
  }
  for (const x of subs) {
    if (x.cap == null) continue;
    const extra = round3(bal[x.sub_key] - Number(x.cap));
    if (extra > 0) {
      bal[x.sub_key] = round3(bal[x.sub_key] - extra);
      overflow.push({ fromSub: x.sub_key, amount: extra });
    }
  }
  return { internal, overflow, balances: bal };
}

// Keeps every box at or under its limit as money comes in: whatever a box
// has no room for moves down its overflow chain (ending in investing).
function fitToCaps(shares, boxes) {
  const result = {};
  const room = (key) => {
    const box = boxes[key];
    if (box.cap == null || LIMIT_AT_MONTH_END_ONLY.includes(key)) return Infinity;
    return Math.max(0, box.cap - box.balance - (result[key] || 0));
  };
  for (const [start, amount] of Object.entries(shares)) {
    let key = start;
    let left = round3(amount);
    while (left > 0) {
      const x = round3(Math.min(left, room(key)));
      if (x > 0) result[key] = round3((result[key] || 0) + x);
      left = round3(left - x);
      key = OVERFLOW_TO[key] || 'investing';
    }
    if (left < 0) result.investing = round3((result.investing || 0) + left);
  }
  return result;
}

// Splits incoming (non-salary) money by each box's percent, keeping every box
// within its limit. Rounding leftovers land in investing so the parts always
// add up to exactly `amount`.
function computeSplit(amount, boxes) {
  const shares = {};
  for (const [key, box] of Object.entries(boxes)) {
    if (box.percent > 0) shares[key] = round3((amount * box.percent) / 100);
  }
  shares.investing = round3((shares.investing || 0) + amount - total(shares));
  return fitToCaps(shares, boxes);
}

// Salary split: rent is topped up to its monthly amount first (a box already
// holding a little only gets the difference), every other box gets its normal
// % of the salary, and
// whatever rent didn't need goes buffer (to its cap) -> emergency (to its
// cap) -> investing. If a smaller salary can't cover rent plus everyone's
// share, the other boxes shrink in proportion - rent is never cut.
function computeSalarySplit(amount, boxes) {
  const shares = {};
  const add = (key, v) => {
    const x = round3(v);
    if (x !== 0) shares[key] = round3((shares[key] || 0) + x);
  };

  // Never more than one month's rent: if this month's rent was already paid
  // before the salary (box below zero), the salary covers that and stops there.
  const rent = rentTarget(boxes, amount);
  const topUp = round3(Math.min(amount, rent, Math.max(0, rent - boxes.rent.balance)));
  add('rent', topUp);

  const others = Object.entries(boxes).filter(([key, box]) => key !== 'rent' && box.percent > 0);
  const wanted = others.reduce((s, [, box]) => s + (amount * box.percent) / 100, 0);
  const rest = round3(amount - topUp);
  const scale = wanted > rest ? rest / wanted : 1;
  for (const [key, box] of others) add(key, ((amount * box.percent) / 100) * scale);

  // Whatever rent didn't need starts at the buffer; fitToCaps then walks it
  // (and any box that would go over its limit) down the chain.
  const surplus = round3(amount - total(shares));
  if (scale < 1 || surplus <= 0) add('investing', surplus); // just rounding pennies
  else add('buffer', surplus);
  return fitToCaps(shares, boxes);
}

// One-time starting allocation from the money already on hand: rent is
// covered first, the rest is split across the other boxes by their
// percentages scaled up to 100%.
function computeSetup(amount, boxes) {
  if (!(amount > 0)) return {};
  const shares = { rent: round3(Math.min(amount, rentTarget(boxes, amount))) };
  const rest = round3(amount - shares.rent);
  const others = Object.entries(boxes).filter(([key, box]) => key !== 'rent' && box.percent > 0);
  const weight = others.reduce((s, [, box]) => s + box.percent, 0);
  if (rest <= 0 || weight <= 0) return shares;

  for (const [key, box] of others) shares[key] = round3((rest * box.percent) / weight);
  shares.investing = round3((shares.investing || 0) + amount - total(shares));
  return fitToCaps(shares, boxes);
}

// Month-end close, in the plan's order (section 12). Returns the new balances
// plus every individual move so each one can be recorded in the history.
function computeClose(boxes) {
  const bal = Object.fromEntries(Object.entries(boxes).map(([k, b]) => [k, Number(b.balance)]));
  const cap = (key) => (boxes[key].cap == null ? Infinity : Number(boxes[key].cap));
  const moves = [];

  const move = (from, to, amount, extra = {}) => {
    const amt = round3(amount);
    if (amt <= 0) return;
    bal[from] = round3(bal[from] - amt);
    bal[to] = round3(bal[to] + amt);
    moves.push({ from, to, amount: amt, ...extra });
  };

  // Fills each box in `chain` up to its cap; the last one takes whatever's left.
  const pour = (from, amount, chain, extra = {}) => {
    let left = round3(amount);
    chain.forEach((key, i) => {
      if (left <= 0) return;
      const room = i === chain.length - 1 ? left : Math.max(0, cap(key) - bal[key]);
      const x = Math.min(left, room);
      move(from, key, x, extra);
      left = round3(left - x);
    });
  };

  // A box with pockets closes pocket by pocket (computeSubClose): moves
  // between its own pockets, then whatever is over a pocket's cap leaves
  // down `chain`. Without pockets, the box keeps up to its own cap.
  const subsOf = (key) => (boxes[key]?.subs?.length ? boxes[key].subs : null);
  const closeWithSubs = (key, chain) => {
    const sub = computeSubClose(subsOf(key));
    for (const m of sub.internal) moves.push({ from: key, to: key, fromSub: m.fromSub, toSub: m.toSub, amount: m.amount });
    for (const o of sub.overflow) pour(key, o.amount, chain, { fromSub: o.fromSub });
  };

  // 1. Groceries, office lunch + transport start fresh: net them against each
  //    other, sweep leftovers down buffer -> emergency -> investing, and cover
  //    overspending from the buffer first, then emergency (never investing).
  const fresh = ['groceries', 'office_lunch', 'transport'].filter((key) => key in bal);
  for (const short of fresh) {
    for (const spare of fresh) {
      if (bal[short] < 0 && bal[spare] > 0) move(spare, short, Math.min(bal[spare], -bal[short]));
    }
  }
  for (const key of fresh) {
    if (bal[key] > 0) {
      pour(key, bal[key], ['buffer', 'emergency', 'investing']);
    } else if (bal[key] < 0) {
      move('buffer', key, Math.min(-bal[key], Math.max(0, bal.buffer)));
      move('emergency', key, Math.min(-bal[key], Math.max(0, bal.emergency)));
    }
  }

  // 2. Guilt-free starts fresh: whatever is left goes to roaming, and an
  //    overspend is covered from roaming (as far as roaming has money).
  if ('guilt_free' in bal && 'roaming' in bal) {
    if (bal.guilt_free > 0) move('guilt_free', 'roaming', bal.guilt_free);
    else if (bal.guilt_free < 0) move('roaming', 'guilt_free', Math.min(-bal.guilt_free, Math.max(0, bal.roaming)));
  }

  // 3. Roaming and Home keep up to their cap (per pocket when they have
  //    pockets); only the extra goes to emergency -> investing.
  for (const key of ['roaming', 'home_trips']) {
    if (!(key in bal)) continue;
    if (subsOf(key)) closeWithSubs(key, ['emergency', 'investing']);
    else if (bal[key] > cap(key)) pour(key, bal[key] - cap(key), ['emergency', 'investing']);
  }

  // 4. Emergency keeps up to its cap; the extra goes to investing.
  if (bal.emergency > cap('emergency')) move('emergency', 'investing', bal.emergency - cap('emergency'));

  // 5. Investing's pockets: leftovers of the fresh-start pockets go to their
  //    leftover pocket (nothing leaves the box - it's the end of the chain).
  if (subsOf('investing')) {
    const sub = computeSubClose(subsOf('investing'));
    for (const m of sub.internal) moves.push({ from: 'investing', to: 'investing', fromSub: m.fromSub, toSub: m.toSub, amount: m.amount });
  }

  return { balances: bal, moves };
}

// Money that isn't in any box (real money minus what the boxes add up to)
// goes into Emergency up to its limit, then Investing. If the boxes say more
// than you actually have, the difference comes out of Emergency, then
// Investing, so the boxes always add up to your real money.
function computeSweep(gap, boxes) {
  const amount = round3(gap);
  if (Math.abs(amount) < 0.001) return [];
  const bal = (key) => Number(boxes[key].balance);
  const cap = (key) => (boxes[key].cap == null ? Infinity : Number(boxes[key].cap));
  const moves = [];
  if (amount > 0) {
    const toEmergency = round3(Math.min(amount, Math.max(0, cap('emergency') - bal('emergency'))));
    if (toEmergency > 0) moves.push({ to: 'emergency', amount: toEmergency });
    const rest = round3(amount - toEmergency);
    if (rest > 0) moves.push({ to: 'investing', amount: rest });
    return moves;
  }
  let missing = -amount;
  const fromEmergency = round3(Math.min(missing, Math.max(0, bal('emergency'))));
  missing = round3(missing - fromEmergency);
  const fromInvesting = round3(Math.min(missing, Math.max(0, bal('investing'))));
  missing = round3(missing - fromInvesting);
  const emergencyTotal = round3(fromEmergency + missing);
  if (emergencyTotal > 0) moves.push({ from: 'emergency', amount: emergencyTotal });
  if (fromInvesting > 0) moves.push({ from: 'investing', amount: fromInvesting });
  return moves;
}

// A move you asked for, from one box to another. A null amount means the
// whole balance of the `from` box.
// fromSub/toSub pick pockets; two pockets of the same box is a valid move.
function computeTransfer(from, to, amount, boxes, { fromSub = null, toSub = null } = {}) {
  if (!BUCKET_KEYS.includes(from)) throw new Error(`Unknown box: ${from}`);
  if (!BUCKET_KEYS.includes(to)) throw new Error(`Unknown box: ${to}`);
  const pocket = (key, sub) => (sub ? (boxes[key].subs || []).find((x) => x.sub_key === sub) : null);
  if (fromSub && !pocket(from, fromSub)) throw new Error(`Unknown pocket: ${fromSub}`);
  if (toSub && !pocket(to, toSub)) throw new Error(`Unknown pocket: ${toSub}`);
  if (from === to && (fromSub || null) === (toSub || null)) throw new Error('Pick two different boxes');
  if (from === to && !(fromSub && toSub)) throw new Error('Pick the two pockets to move between');
  const has = round3(Number(fromSub ? pocket(from, fromSub).balance : boxes[from].balance));
  const n = amount == null ? has : round3(Number(amount));
  if (!(n > 0)) throw new Error(amount == null ? 'That box is empty' : 'amount must be a positive number');
  if (n > has) throw new Error(`That box only has ${money(has)}`);
  return { from, to, amount: n, ...(fromSub ? { fromSub } : {}), ...(toSub ? { toSub } : {}) };
}

function computeInterAccountTransfer(from, to, amount, fee, fromAccount, toAccount, boxes, fromSub = null) {
  if (fromAccount === toAccount) throw new Error('Pick two different bank accounts');
  if (!BUCKET_KEYS.includes(from)) throw new Error(`Unknown box: ${from}`);
  if (!BUCKET_KEYS.includes(to)) throw new Error(`Unknown box: ${to}`);
  const pocket = fromSub ? (boxes[from]?.subs || []).find((x) => x.sub_key === fromSub) : null;
  if (fromSub && !pocket) throw new Error(`Unknown pocket: ${fromSub}`);
  const available = round3(Number(pocket ? pocket.balance : boxes[from]?.balance));
  const transferAmount = amount == null ? available : round3(Number(amount));
  if (!(transferAmount > 0)) throw new Error(amount == null ? 'That box is empty' : 'amount must be a positive number');
  if (transferAmount > available) throw new Error(`That box only has ${money(available)}`);
  const feeAmount = Number(fee);
  if (!Number.isFinite(feeAmount) || feeAmount < 0) throw new Error('Transfer fee must be 0 or more');
  const total = round3(transferAmount + feeAmount);
  if (total > available) {
    throw new Error(`The source box needs ${money(total)} including the fee`);
  }
  return { from, to, amount: transferAmount, fee: round3(feeAmount), sourceTotal: total };
}

module.exports = {
  BUCKET_KEYS,
  PICKABLE_KEYS,
  round3,
  money,
  defaultBucketFor,
  suggestBucket,
  computeSplit,
  computeSalarySplit,
  computeSetup,
  computeClose,
  computeSweep,
  computeTransfer,
  computeInterAccountTransfer,
  defaultSub,
  splitIntoSubs,
  computeSubClose,
};
