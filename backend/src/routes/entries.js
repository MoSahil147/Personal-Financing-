const express = require('express');
const supabase = require('../services/supabase');

const router = express.Router();

// Positive delta = money added to the bank, negative = removed. Credit-card
// expenses never touch the bank balance until they're settled.
async function applyBalanceEffect({ type, amount, payment_method }, sign) {
  const { data: settings, error: getErr } = await supabase.from('settings').select('*').eq('id', 'main').single();
  if (getErr) throw new Error(getErr.message);

  const updates = {};
  if (type === 'income') {
    updates.bank_balance = Number(settings.bank_balance) + sign * Number(amount);
  } else if (payment_method === 'credit') {
    updates.credit_outstanding = Number(settings.credit_outstanding) + sign * Number(amount);
  } else {
    updates.bank_balance = Number(settings.bank_balance) - sign * Number(amount);
  }

  const { error: updErr } = await supabase.from('settings').update(updates).eq('id', 'main');
  if (updErr) throw new Error(updErr.message);
}

// Save a confirmed entry (after the user reviews/edits the suggestion).
router.post('/', async (req, res) => {
  const { entry_date, type, amount, category, classification, payment_method, note, raw_input } = req.body || {};

  if (!entry_date || !type || !amount || !category) {
    return res.status(400).json({ error: 'entry_date, type, amount, category are required' });
  }
  if (!['income', 'expense'].includes(type)) {
    return res.status(400).json({ error: 'type must be income or expense' });
  }
  const method = type === 'expense' ? payment_method || 'debit' : null;
  if (type === 'expense' && !['debit', 'credit'].includes(method)) {
    return res.status(400).json({ error: 'payment_method must be debit or credit' });
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
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  try {
    await applyBalanceEffect(data, 1);
  } catch (err) {
    // Entry is saved but the balance update failed - surface it so it isn't silently wrong.
    return res.status(207).json({ ...data, balance_warning: err.message });
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

  const { error } = await supabase.from('entries').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  try {
    await applyBalanceEffect(existing, -1);
  } catch (err) {
    return res.status(207).json({ deleted: true, balance_warning: err.message });
  }

  res.status(204).end();
});

module.exports = router;
