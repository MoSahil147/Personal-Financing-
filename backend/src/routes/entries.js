const express = require('express');
const supabase = require('../services/supabase');
const { applyEntryBalanceEffect, getSettings } = require('../services/balances');
const buckets = require('../services/buckets');
const { PICKABLE_KEYS } = require('../services/bucketMath');

const router = express.Router();

// Save a confirmed entry (after the user reviews/edits the suggestion).
router.post('/', async (req, res) => {
  const { entry_date, type, amount, category, classification, payment_method, note, raw_input } = req.body || {};
  // Paying the card bill always comes out of the bank (debit), never cash, and
  // never touches the boxes - the boxes paid when the card was used.
  const isCardPayment = type === 'expense' && category === 'Credit Card Payment';
  const bucket = isCardPayment ? null : req.body?.bucket || null;
  // A salary starts a new month: run the month-end close before splitting it.
  const newMonth = type === 'income' && bucket === 'split' && req.body?.new_month === true;

  if (!entry_date || !type || !amount || !category) {
    return res.status(400).json({ error: 'entry_date, type, amount, category are required' });
  }
  if (!['income', 'expense'].includes(type)) {
    return res.status(400).json({ error: 'type must be income or expense' });
  }
  const method = isCardPayment ? 'debit'
    : payment_method === 'cash' ? 'cash' : type === 'expense' ? payment_method || 'debit' : null;
  if (type === 'expense' && !['debit', 'credit', 'cash'].includes(method)) {
    return res.status(400).json({ error: 'payment_method must be debit, credit, or cash' });
  }
  if (type === 'income' && method !== null && method !== 'cash') {
    return res.status(400).json({ error: 'income payment_method must be cash or omitted (bank)' });
  }
  if (isCardPayment) {
    try {
      const owed = Number((await getSettings()).credit_outstanding);
      if (Number(amount) > owed + 0.005) {
        return res.status(400).json({ error: `That's more than the ${owed.toFixed(2)} owed on the card` });
      }
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  // Expenses come out of one box; income is either split by % or goes into one box.
  const validBuckets = type === 'income' ? [...PICKABLE_KEYS, 'split'] : PICKABLE_KEYS;
  if (bucket !== null && !validBuckets.includes(bucket)) {
    return res.status(400).json({ error: `bucket must be one of: ${validBuckets.join(', ')}` });
  }

  const { data, error } = await supabase
    .from('entries')
    .insert({
      entry_date,
      type,
      amount,
      category,
      classification: classification || null,
      payment_method: method,
      note,
      raw_input,
      bucket,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  try {
    await applyEntryBalanceEffect(data, 1);
  } catch (err) {
    // Entry is saved but the balance update failed - surface it so it isn't silently wrong.
    return res.status(207).json({ ...data, balance_warning: err.message });
  }

  try {
    await buckets.applyEntry(data, bucket, { newMonth });
  } catch (err) {
    return res.status(207).json({ ...data, bucket_warning: err.message });
  }

  res.status(201).json(data);
});

// List entries, optionally filtered by month/year.
router.get('/', async (req, res) => {
  const { month, year } = req.query;
  let query = supabase.from('entries').select('*').order('entry_date', { ascending: false });

  if (year && month) {
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = new Date(Number(year), Number(month), 1).toISOString().slice(0, 10);
    query = query.gte('entry_date', start).lt('entry_date', endDate);
  } else if (year) {
    query = query.gte('entry_date', `${year}-01-01`).lt('entry_date', `${Number(year) + 1}-01-01`);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const { data: existing, error: fetchErr } = await supabase
    .from('entries')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (fetchErr) return res.status(404).json({ error: 'Entry not found' });

  // Read the box moves before deleting - the delete cascades them away.
  let boxMoves;
  try {
    boxMoves = await buckets.getEntryMoves(req.params.id);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const { error } = await supabase.from('entries').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  try {
    await applyEntryBalanceEffect(existing, -1);
  } catch (err) {
    return res.status(207).json({ deleted: true, balance_warning: err.message });
  }

  try {
    await buckets.reverseMoves(boxMoves);
  } catch (err) {
    return res.status(207).json({ deleted: true, bucket_warning: err.message });
  }

  res.status(204).end();
});

module.exports = router;
