const express = require('express');
const supabase = require('../services/supabase');

const router = express.Router();

async function getSettings() {
  const { data, error } = await supabase.from('settings').select('*').eq('id', 'main').single();
  if (error) throw new Error(error.message);
  return data;
}

router.get('/', async (_req, res) => {
  try {
    res.json(await getSettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual correction/seed of the bank balance (e.g. first-time setup).
router.put('/bank-balance', async (req, res) => {
  const { bank_balance } = req.body || {};
  if (bank_balance === undefined || bank_balance === null || isNaN(Number(bank_balance))) {
    return res.status(400).json({ error: 'bank_balance must be a number' });
  }

  const { data, error } = await supabase
    .from('settings')
    .update({ bank_balance: Number(bank_balance) })
    .eq('id', 'main')
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Set/update your monthly savings goal (e.g. 5000).
router.put('/savings-target', async (req, res) => {
  const { monthly_savings_target } = req.body || {};
  if (monthly_savings_target === undefined || isNaN(Number(monthly_savings_target))) {
    return res.status(400).json({ error: 'monthly_savings_target must be a number' });
  }

  const { data, error } = await supabase
    .from('settings')
    .update({ monthly_savings_target: Number(monthly_savings_target) })
    .eq('id', 'main')
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Pay off the credit card: logs a debit expense for the outstanding amount,
// reduces the bank balance by it, and resets credit_outstanding to 0.
router.post('/settle-credit-card', async (req, res) => {
  try {
    const settings = await getSettings();
    const amount = Number(settings.credit_outstanding);
    if (amount <= 0) return res.status(400).json({ error: 'Nothing owed on credit card' });

    const entry_date = req.body?.entry_date || new Date().toISOString().slice(0, 10);

    const { error: insertErr } = await supabase.from('entries').insert({
      entry_date,
      type: 'expense',
      amount,
      category: 'Credit Card Payment',
      classification: null,
      payment_method: 'debit',
      note: 'Monthly credit card settlement',
    });
    if (insertErr) throw new Error(insertErr.message);

    const { data, error: updateErr } = await supabase
      .from('settings')
      .update({
        bank_balance: Number(settings.bank_balance) - amount,
        credit_outstanding: 0,
      })
      .eq('id', 'main')
      .select()
      .single();
    if (updateErr) throw new Error(updateErr.message);

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
