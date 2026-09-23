const express = require('express');
const buckets = require('../services/buckets');

const router = express.Router();

// All boxes + totals. Runs any month-end close that's due first.
router.get('/', async (_req, res) => {
  try {
    res.json(await buckets.overview());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/moves', async (_req, res) => {
  try {
    res.json(await buckets.recentMoves());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Preview how an income amount would be split, for the confirm modal.
router.get('/split-preview', async (req, res) => {
  const amount = Number(req.query.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
  try {
    res.json({ shares: await buckets.splitPreview(amount) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One-time starting allocation from current money (rent first, rest by %).
router.get('/setup-preview', async (_req, res) => {
  try {
    res.json(await buckets.setupPreview());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/setup', async (_req, res) => {
  try {
    res.json(await buckets.setupFromCurrentMoney());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
