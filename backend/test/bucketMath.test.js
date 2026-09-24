const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeSplit, computeSalarySplit, computeSetup, computeClose, suggestBucket,
} = require('../src/services/bucketMath');

// Builds a boxes map with the plan's percentages/caps and the given balances.
function boxes(balances = {}) {
  const defs = {
    rent: [38, null], groceries: [10, null], transport: [2, null], guilt_free: [5, 1000],
    home_trips: [10, 7500], roaming: [5, 2500], emergency: [5, 15000], investing: [25, null],
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

test('other income: a box at its limit passes its share down the chain', () => {
  const split = computeSplit(1000, boxes({ roaming: 2480, guilt_free: 1000 }));
  // guilt-free's 1,000 is a carry-over limit (checked at month-end), so it
  // keeps its 50; roaming only has room for 20, the other 30 goes to emergency
  assert.equal(split.guilt_free, 50);
  assert.equal(split.roaming, 20);
  assert.equal(split.emergency, 50 + 30);
  assert.equal(sum(split), 1000);
});

test('other income: home / other trips over its limit goes to emergency, then investing', () => {
  const split = computeSplit(1000, boxes({ home_trips: 7450, emergency: 14990 }));
  assert.equal(split.home_trips, 50);
  assert.equal(split.emergency, 10);
  assert.equal(split.investing, 250 + 40 + 50);
  assert.equal(sum(split), 1000);
});

test('salary: roaming near its limit keeps it at the limit, extra to emergency', () => {
  const split = computeSalarySplit(10000, boxes({ roaming: 2400 }));
  assert.equal(split.roaming, 100);
  assert.equal(split.emergency, 500 + 400);
  assert.equal(sum(split), 10000);
});

test('salary: guilt-free still gets its 500 on top of the carry-over', () => {
  const split = computeSalarySplit(10000, boxes({ guilt_free: 1000 }));
  assert.equal(split.guilt_free, 500);
});

test('rent paid before the salary: rent gets one month (3,800), not two', () => {
  const split = computeSalarySplit(10000, boxes({ rent: -3800 }));
  assert.equal(split.rent, 3800);
  assert.equal(split.groceries, 1000);
  assert.equal(split.investing, 2500);
  assert.equal(sum(split), 10000);
});

test('setup keeps every box within its limit', () => {
  const shares = computeSetup(60000, boxes());
  assert.equal(shares.roaming, 2500);
  assert.equal(shares.home_trips, 7500);
  assert.equal(sum(shares), 60000);
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

test('roaming over its own 2,500 cap sends only its extra to emergency', () => {
  const { balances } = computeClose(boxes({ home_trips: 7000, roaming: 3400, emergency: 2000 }));
  assert.equal(balances.home_trips, 7000);
  assert.equal(balances.roaming, 2500);
  assert.equal(balances.emergency, 2900);
});

test('home / other trips over 7,500 overflows on its own, roaming untouched', () => {
  const { balances } = computeClose(boxes({ home_trips: 8000, roaming: 1000, emergency: 2000 }));
  assert.equal(balances.home_trips, 7500);
  assert.equal(balances.roaming, 1000);
  assert.equal(balances.emergency, 2500);
});

test('a full roaming box does not spill into home / other trips', () => {
  const { balances } = computeClose(boxes({ guilt_free: 1300, roaming: 2500, home_trips: 100, emergency: 0 }));
  assert.equal(balances.roaming, 2500);
  assert.equal(balances.home_trips, 100);
  assert.equal(balances.emergency, 300);
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

test('salary with empty rent box gives exactly the plan amounts', () => {
  assert.deepEqual(computeSalarySplit(10000, boxes()), {
    rent: 3800, groceries: 1000, transport: 200, guilt_free: 500,
    home_trips: 1000, roaming: 500, emergency: 500, investing: 2500,
  });
});

test('salary tops rent up to 3,800 and the unused part goes to the buffer', () => {
  const split = computeSalarySplit(10000, boxes({ rent: 20 }));
  assert.equal(split.rent, 3780);
  assert.equal(split.buffer, 20);
  assert.equal(split.groceries, 1000);
  assert.equal(sum(split), 10000);
});

test('salary surplus fills buffer to 300, then emergency', () => {
  const split = computeSalarySplit(10000, boxes({ rent: 500, buffer: 250 }));
  assert.equal(split.rent, 3300);
  assert.equal(split.buffer, 50);
  assert.equal(split.emergency, 500 + 450);
  assert.equal(sum(split), 10000);
});

test('rent already full: its whole share flows buffer -> emergency', () => {
  const split = computeSalarySplit(10000, boxes({ rent: 3800, buffer: 300 }));
  assert.equal(split.rent, undefined);
  assert.equal(split.buffer, undefined);
  assert.equal(split.emergency, 4300);
});

test('smaller salary still covers rent in full, others shrink in proportion', () => {
  const split = computeSalarySplit(8000, boxes());
  assert.equal(split.rent, 3800);
  assert.equal(sum(split), 8000);
  assert.ok(split.groceries > 600 && split.groceries < 800); // normal share 800, shrunk to fit
  assert.equal(split.buffer, undefined);
});

test('salary with emergency full sends its share and any surplus to investing', () => {
  const split = computeSalarySplit(10000, boxes({ emergency: 15000, rent: 100, buffer: 300 }));
  assert.equal(split.emergency, undefined);
  assert.equal(split.investing, 3000 + 100);
  assert.equal(sum(split), 10000);
});

test('suggestBucket: keeps a valid parser pick, falls back by category', () => {
  assert.equal(suggestBucket({ type: 'expense', category: 'Dining', bucket: 'roaming' }), 'roaming');
  assert.equal(suggestBucket({ type: 'expense', category: 'Groceries', bucket: 'nonsense' }), 'groceries');
  assert.equal(suggestBucket({ type: 'expense', category: 'Rent', bucket: 'buffer' }), 'rent');
  assert.equal(suggestBucket({ type: 'income', category: 'Salary', bucket: 'rent' }), 'split');
  assert.equal(suggestBucket({ type: 'income', category: 'Refund', bucket: 'groceries' }), 'groceries');
  assert.equal(suggestBucket({ type: 'expense', category: 'Credit Card Payment' }), null);
});
