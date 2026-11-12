const express = require('express');
const buckets = require('../services/buckets');
const { exclusive } = require('../middleware/moneyLock');

const router = express.Router();

// All boxes + totals. Any money not in a box is first moved into Emergency.
router.get('/', async (_req, res) => {
  try {
    const accountId = _req.query.account;
    await exclusive(() => buckets.sweepUnallocated(accountId));
    res.json(await buckets.overview(accountId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/moves', async (_req, res) => {
  try {
    res.json(await buckets.recentMoves(_req.query.account));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One box's moves since the current month started (for the box detail view).
router.get('/:key/activity', async (req, res) => {
  try {
    res.json(await buckets.boxActivity(req.params.key, req.query.account));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Preview an income split for the confirm modal: the month-end moves first
// (when new_month=1, i.e. a salary starting a new month), then the split.
router.get('/split-preview', async (req, res) => {
  const amount = Number(req.query.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
  try {
    res.json(await buckets.splitPreview(amount, {
      category: req.query.category || null,
      newMonth: req.query.new_month === '1',
      accountId: req.query.account,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Move money from one box to another. `all: true` (or no amount) moves the
// whole balance as it is right now.
router.post('/transfer', async (req, res) => {
  const { from, to, amount, all, from_account, to_account, fee } = req.body || {};
  const n = all || amount == null || amount === '' ? null : Number(amount);
  if (n !== null && !(n > 0)) return res.status(400).json({ error: 'amount must be a positive number' });
  const feeAmount = fee === undefined || fee === '' ? 0 : Number(fee);
  if (!Number.isFinite(feeAmount) || feeAmount < 0) return res.status(400).json({ error: 'fee must be 0 or more' });
  try {
    if (from_account || to_account) {
      if (n === null) {
        const source = (await buckets.overview(from_account)).buckets.find((b) => b.bucket_key === from);
        const amount = source ? source.balance - (from_account === to_account ? 0 : feeAmount) : 0;
        if (!(amount > 0)) return res.status(400).json({ error: 'That source box has no transferable balance after the fee' });
        res.json(await buckets.transferBetweenAccounts({
          fromAccount: from_account,
          from,
          toAccount: to_account,
          to,
          amount,
          fee: feeAmount,
        }));
      } else {
        res.json(await buckets.transferBetweenAccounts({
          fromAccount: from_account,
          from,
          toAccount: to_account,
          to,
          amount: n,
          fee: feeAmount,
        }));
      }
    } else {
      res.json(await buckets.transfer(from, to, n, req.body?.account));
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// One-time starting allocation from current money (rent first, rest by %).
router.get('/setup-preview', async (_req, res) => {
  try {
    res.json(await buckets.setupPreview(_req.query.account));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/setup', async (req, res) => {
  try {
    res.json(await buckets.setupFromCurrentMoney(req.body?.account));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
