const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeSplit, computeSetup, computeClose, monthsToClose, suggestBucket,
} = require('../src/services/bucketMath');

// Builds a boxes map with the plan's percentages/caps and the given balances.
function boxes(balances = {}) {
  const defs = {
    rent: [38, null], groceries: [10, null], transport: [2, null], guilt_free: [5, 1000],
    home_trips: [10, 10000], roaming: [5, 10000], emergency: [5, 15000], investing: [25, null],
    buffer: [0, 300],
  };
  return Object.fromEntries(Object.entries(defs).map(([key, [percent, cap]]) => (
    [key, { key, percent, cap, balance: balances[key] || 0 }]
  )));
}

const sum = (obj) => Math.round(Object.values(obj).reduce((s, v) => s + v, 0) * 100) / 100;

test('payday split of 10,000 matches the plan', () => {
  assert.deepEqual(computeSplit(10000, boxes()), {
    rent: 3800, groceries: 1000, transport: 200, guilt_free: 500,
    home_trips: 1000, roaming: 500, emergency: 500, investing: 2500,
  });
});

test('full emergency fund sends its share to investing (3,000)', () => {
  const split = computeSplit(10000, boxes({ emergency: 15000 }));
  assert.equal(split.emergency, undefined);
  assert.equal(split.investing, 3000);
});

test('odd amounts still add up exactly', () => {
  const split = computeSplit(333.33, boxes());
  assert.equal(sum(split), 333.33);
});

test('setup puts 3,800 in rent and splits the rest by 62 weights', () => {
  const shares = computeSetup(10000, boxes());
  assert.equal(shares.rent, 3800);
  assert.equal(shares.buffer, undefined);
  assert.equal(shares.groceries, 1000); // 6200 * 10/62
  assert.equal(shares.investing, 2500); // 6200 * 25/62
  assert.equal(sum(shares), 10000);
});

test('setup with less than rent puts everything in rent', () => {
  assert.deepEqual(computeSetup(2000, boxes()), { rent: 2000 });
  assert.deepEqual(computeSetup(0, boxes()), {});
});

test('setup rounding still adds up exactly', () => {
  assert.equal(sum(computeSetup(12345.67, boxes())), 12345.67);
});

test('example A: 230 leftover with a full buffer goes to emergency', () => {
  const { balances } = computeClose(boxes({ groceries: 150, transport: 80, buffer: 300, emergency: 4500, home_trips: 5000, roaming: 2500, guilt_free: 150 }));
  assert.equal(balances.groceries, 0);
  assert.equal(balances.transport, 0);
  assert.equal(balances.emergency, 4730);
  assert.equal(balances.guilt_free, 150);
  assert.equal(balances.home_trips + balances.roaming, 7500);
});

test('buffer fills to 300 first, then emergency', () => {
  const { balances } = computeClose(boxes({ groceries: 200, buffer: 250, emergency: 1000 }));
  assert.equal(balances.buffer, 300);
  assert.equal(balances.emergency, 1150);
});

test('example C: travel over 10,000 sends 900 to emergency, roaming trimmed first', () => {
  const { balances } = computeClose(boxes({ home_trips: 7000, roaming: 3900, emergency: 2000 }));
  assert.equal(balances.home_trips, 7000);
  assert.equal(balances.roaming, 3000);
  assert.equal(balances.emergency, 2900);
});

test('example E: groceries overspent, transport under, buffer covers net 100', () => {
  const { balances } = computeClose(boxes({ groceries: -150, transport: 50, buffer: 300, emergency: 5000 }));
  assert.equal(balances.groceries, 0);
  assert.equal(balances.transport, 0);
  assert.equal(balances.buffer, 200);
  assert.equal(balances.emergency, 5000);
});

test('overspend beyond the buffer comes from emergency, never investing', () => {
  const { balances } = computeClose(boxes({ groceries: -500, buffer: 300, emergency: 1000, investing: 9000 }));
  assert.equal(balances.groceries, 0);
  assert.equal(balances.buffer, 0);
  assert.equal(balances.emergency, 800);
  assert.equal(balances.investing, 9000);
});

test('example F: guilt-free 1,150 keeps 1,000, 150 to roaming', () => {
  const { balances } = computeClose(boxes({ guilt_free: 1150, roaming: 500 }));
  assert.equal(balances.guilt_free, 1000);
  assert.equal(balances.roaming, 650);
});

test('example G: emergency 15,200 + 200 leftover -> 400 to investing', () => {
  const { balances } = computeClose(boxes({ emergency: 15200, groceries: 200, buffer: 300, investing: 1000 }));
  assert.equal(balances.emergency, 15000);
  assert.equal(balances.investing, 1400);
});

test('example H: everything overflows, investing gains 1,800', () => {
  const { balances, moves } = computeClose(boxes({
    groceries: 150, transport: 50, buffer: 300, guilt_free: 1300,
    home_trips: 8000, roaming: 3300, emergency: 15000, investing: 2500,
  }));
  assert.equal(balances.guilt_free, 1000);
  assert.equal(balances.home_trips + balances.roaming, 10000);
  assert.equal(balances.emergency, 15000);
  assert.equal(balances.investing, 4300);
  assert.ok(moves.every((m) => m.amount > 0));
});

test('close never moves rent', () => {
  const { balances } = computeClose(boxes({ rent: 3800 }));
  assert.equal(balances.rent, 3800);
});

test('bridge: nothing closes in Sep/Oct 2026, October closes in November', () => {
  assert.deepEqual(monthsToClose('2026-10', null, '2026-09'), []);
  assert.deepEqual(monthsToClose('2026-10', null, '2026-10'), []);
  assert.deepEqual(monthsToClose('2026-10', null, '2026-11'), ['2026-10']);
  assert.deepEqual(monthsToClose('2026-10', '2026-10', '2026-11'), []);
  assert.deepEqual(monthsToClose('2026-10', '2026-11', '2027-02'), ['2026-12', '2027-01']);
});

test('suggestBucket: keeps a valid parser pick, falls back by category', () => {
  assert.equal(suggestBucket({ type: 'expense', category: 'Dining', bucket: 'roaming' }), 'roaming');
  assert.equal(suggestBucket({ type: 'expense', category: 'Groceries', bucket: 'nonsense' }), 'groceries');
  assert.equal(suggestBucket({ type: 'expense', category: 'Rent', bucket: 'buffer' }), 'rent');
  assert.equal(suggestBucket({ type: 'income', category: 'Salary', bucket: 'rent' }), 'split');
  assert.equal(suggestBucket({ type: 'income', category: 'Refund', bucket: 'groceries' }), 'groceries');
  assert.equal(suggestBucket({ type: 'expense', category: 'Credit Card Payment' }), null);
});
