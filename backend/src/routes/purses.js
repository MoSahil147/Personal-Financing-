const express = require('express');
const purses = require('../services/purses');

const router = express.Router();

router.get('/', async (_req, res) => {
  try {
    res.json(await purses.listPurses());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/moves', async (req, res) => {
  try {
    res.json(await purses.recentMoves(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A bus fare paid with the card: comes off the card only.
router.post('/:id/ride', async (req, res) => {
  const amount = Number(req.body?.amount);
  if (!(amount > 0)) return res.status(400).json({ error: 'amount must be a positive number' });
  try {
    res.json(await purses.ride(req.params.id, amount, { note: req.body?.note || null, date: req.body?.date }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Correct the card to what the card reader / app shows.
router.patch('/:id', async (req, res) => {
  const balance = Number(req.body?.balance);
  if (!Number.isFinite(balance) || balance < 0) return res.status(400).json({ error: 'balance must be 0 or more' });
  try {
    res.json(await purses.setBalance(req.params.id, balance));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
