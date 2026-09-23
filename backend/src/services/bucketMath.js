// Pure money math for the budget boxes - no database calls here, so every
// rule from the budget plan (percentage splits, caps, month-end overflow)
// can be tested directly with plain numbers.
//
// A "boxes" map looks like { rent: { key, balance, percent, cap }, ... }.

const RENT_AMOUNT = 3800;

const BUCKET_KEYS = [
  'rent', 'groceries', 'transport', 'guilt_free', 'home_trips', 'roaming',
  'emergency', 'investing', 'buffer',
];
// The buffer is only fed by leftovers (grocery/transport at month end, rent's
// unused salary share), so it's never picked by hand for a spend or refund.
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

// Salary split: rent is topped up to 3,800 first (a box already holding 20
// only gets 3,780), every other box gets its normal % of the salary, and
// whatever rent didn't need goes buffer (to its cap) -> emergency (to its
// cap) -> investing. If a smaller salary can't cover rent plus everyone's
// share, the other boxes shrink in proportion - rent is never cut.
function computeSalarySplit(amount, boxes) {
  const shares = {};
  const add = (key, v) => {
    const x = round2(v);
    if (x !== 0) shares[key] = round2((shares[key] || 0) + x);
  };

  const topUp = round2(Math.min(amount, Math.max(0, RENT_AMOUNT - boxes.rent.balance)));
  add('rent', topUp);

  const others = Object.entries(boxes).filter(([key, box]) => key !== 'rent' && box.percent > 0);
  const wanted = others.reduce((s, [, box]) => s + (amount * box.percent) / 100, 0);
  const rest = round2(amount - topUp);
  const scale = wanted > rest ? rest / wanted : 1;
  const emergencyFull = boxes.emergency.cap != null && boxes.emergency.balance >= boxes.emergency.cap;
  for (const [key, box] of others) {
    const share = ((amount * box.percent) / 100) * scale;
    add(key === 'emergency' && emergencyFull ? 'investing' : key, share);
  }

  let surplus = round2(amount - total(shares));
  if (scale < 1 || surplus <= 0) {
    add('investing', surplus); // just rounding pennies
    return shares;
  }
  for (const key of ['buffer', 'emergency']) {
    const box = boxes[key];
    const room = Math.max(0, box.cap - box.balance - (shares[key] || 0));
    const x = Math.min(surplus, room);
    add(key, x);
    surplus = round2(surplus - x);
  }
  add('investing', surplus);
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

  // 3. Roaming and Home / Other Trips each keep up to their own cap; only the
  //    extra goes to emergency -> investing.
  for (const key of ['roaming', 'home_trips']) {
    if (bal[key] > cap(key)) pour(key, bal[key] - cap(key), ['emergency', 'investing']);
  }

  // 4. Emergency keeps up to its cap; the extra goes to investing.
  if (bal.emergency > cap('emergency')) move('emergency', 'investing', bal.emergency - cap('emergency'));

  return { balances: bal, moves };
}

module.exports = {
  BUCKET_KEYS,
  PICKABLE_KEYS,
  round2,
  defaultBucketFor,
  suggestBucket,
  computeSplit,
  computeSalarySplit,
  computeSetup,
  computeClose,
};
