// Pure money math for the budget boxes - no database calls here, so every
// rule from the budget plan (percentage splits, caps, month-end overflow)
// can be tested directly with plain numbers.
//
// A "boxes" map looks like { rent: { key, balance, percent, cap }, ... }.
// Home trips + roaming share one travel cap, read from roaming.cap.

const RENT_AMOUNT = 3800;

const BUCKET_KEYS = [
  'rent', 'groceries', 'transport', 'guilt_free', 'home_trips', 'roaming',
  'emergency', 'investing', 'buffer',
];
// The buffer is only fed by grocery/transport leftovers at month end, so it's
// never picked by hand for a spend or refund.
const PICKABLE_KEYS = BUCKET_KEYS.filter((k) => k !== 'buffer');

// Fallback box for an expense when the chat parser's pick is missing/invalid.
// The parser's own pick wins, since it knows Abu Dhabi vs outside and a
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

function round2(n) {
  return Math.round(n * 100) / 100;
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

// Splits incoming money by each box's percent. Once emergency is full its
// share goes to investing instead. Rounding leftovers land in investing so
// the parts always add up to exactly `amount`.
function computeSplit(amount, boxes) {
  const shares = {};
  for (const [key, box] of Object.entries(boxes)) {
    if (box.percent > 0) shares[key] = round2((amount * box.percent) / 100);
  }
  const emergency = boxes.emergency;
  if (shares.emergency && emergency.cap != null && emergency.balance >= emergency.cap) {
    shares.investing = (shares.investing || 0) + shares.emergency;
    delete shares.emergency;
  }
  shares.investing = round2((shares.investing || 0) + amount - total(shares));
  return shares;
}

// One-time starting allocation from the money already on hand: rent is
// covered first, the rest is split across the other boxes by their
// percentages scaled up to 100%.
function computeSetup(amount, boxes) {
  if (!(amount > 0)) return {};
  const shares = { rent: round2(Math.min(amount, RENT_AMOUNT)) };
  const rest = round2(amount - shares.rent);
  const others = Object.entries(boxes).filter(([key, box]) => key !== 'rent' && box.percent > 0);
  const weight = others.reduce((s, [, box]) => s + box.percent, 0);
  if (rest <= 0 || weight <= 0) return shares;

  for (const [key, box] of others) shares[key] = round2((rest * box.percent) / weight);
  shares.investing = round2((shares.investing || 0) + amount - total(shares));
  return shares;
}

// Month-end close, in the plan's order (section 12). Returns the new balances
// plus every individual move so each one can be recorded in the history.
function computeClose(boxes) {
  const bal = Object.fromEntries(Object.entries(boxes).map(([k, b]) => [k, Number(b.balance)]));
  const cap = (key) => (boxes[key].cap == null ? Infinity : Number(boxes[key].cap));
  const moves = [];

  const move = (from, to, amount) => {
    const amt = round2(amount);
    if (amt <= 0) return;
    bal[from] = round2(bal[from] - amt);
    bal[to] = round2(bal[to] + amt);
    moves.push({ from, to, amount: amt });
  };

  // Fills each box in `chain` up to its cap; the last one takes whatever's left.
  const pour = (from, amount, chain) => {
    let left = round2(amount);
    chain.forEach((key, i) => {
      if (left <= 0) return;
      const room = i === chain.length - 1 ? left : Math.max(0, cap(key) - bal[key]);
      const x = Math.min(left, room);
      move(from, key, x);
      left = round2(left - x);
    });
  };

  // 1. Groceries + transport start fresh: net them against each other, sweep
  //    leftovers down buffer -> emergency -> investing, and cover overspending
  //    from the buffer first, then emergency (never investing).
  const pair = ['groceries', 'transport'];
  const [g, t] = pair;
  if (bal[g] < 0 && bal[t] > 0) move(t, g, Math.min(bal[t], -bal[g]));
  if (bal[t] < 0 && bal[g] > 0) move(g, t, Math.min(bal[g], -bal[t]));
  for (const key of pair) {
    if (bal[key] > 0) {
      pour(key, bal[key], ['buffer', 'emergency', 'investing']);
    } else if (bal[key] < 0) {
      move('buffer', key, Math.min(-bal[key], Math.max(0, bal.buffer)));
      move('emergency', key, Math.min(-bal[key], Math.max(0, bal.emergency)));
    }
  }

  // 2. Guilt-free keeps up to its cap; only the extra goes to roaming.
  if (bal.guilt_free > cap('guilt_free')) move('guilt_free', 'roaming', bal.guilt_free - cap('guilt_free'));

  // 3. Travel (home trips + roaming) over the shared cap: trim roaming first so
  //    trips home stay protected, extra goes to emergency -> investing.
  const excess = round2(bal.home_trips + bal.roaming - cap('roaming'));
  if (excess > 0) {
    const fromRoaming = Math.min(excess, Math.max(0, bal.roaming));
    pour('roaming', fromRoaming, ['emergency', 'investing']);
    pour('home_trips', excess - fromRoaming, ['emergency', 'investing']);
  }

  // 4. Emergency keeps up to its cap; the extra goes to investing.
  if (bal.emergency > cap('emergency')) move('emergency', 'investing', bal.emergency - cap('emergency'));

  return { balances: bal, moves };
}

function nextMonth(ym) {
  let [y, m] = ym.split('-').map(Number);
  m += 1;
  if (m > 12) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

// Months ('YYYY-MM') that have ended but not been closed yet, oldest first.
// Nothing before `startMonth` is ever closed - that's how Sep + Oct 2026 run
// as one period on the starting money, with the first close for October.
function monthsToClose(startMonth, lastClosed, currentMonth) {
  let month = lastClosed && lastClosed >= startMonth ? nextMonth(lastClosed) : startMonth;
  const months = [];
  while (month < currentMonth) {
    months.push(month);
    month = nextMonth(month);
  }
  return months;
}

module.exports = {
  BUCKET_KEYS,
  PICKABLE_KEYS,
  round2,
  defaultBucketFor,
  suggestBucket,
  computeSplit,
  computeSetup,
  computeClose,
  monthsToClose,
};
