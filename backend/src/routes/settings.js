const express = require('express');
const supabase = require('../services/supabase');
const { getSettings, withdrawCash } = require('../services/balances');
const { todayISO } = require('../services/date');

const router = express.Router();

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

// Manual correction/seed of the cash-on-hand balance (e.g. first-time setup).
router.put('/cash-balance', async (req, res) => {
  const { cash_balance } = req.body || {};
  if (cash_balance === undefined || cash_balance === null || isNaN(Number(cash_balance))) {
    return res.status(400).json({ error: 'cash_balance must be a number' });
  }

  const { data, error } = await supabase
    .from('settings')
    .update({ cash_balance: Number(cash_balance) })
    .eq('id', 'main')
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Set/update your credit card limit (drives the blue -> red color switch on
// the credit widget once you're at/over it).
router.put('/credit-card-limit', async (req, res) => {
  const { credit_card_limit } = req.body || {};
  if (credit_card_limit === undefined || isNaN(Number(credit_card_limit))) {
    return res.status(400).json({ error: 'credit_card_limit must be a number' });
  }

  const { data, error } = await supabase
    .from('settings')
    .update({ credit_card_limit: Number(credit_card_limit) })
    .eq('id', 'main')
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// What the current card bill is made of: the most recent card spends that add
// up to what's owed (payments clear the oldest spends first), grouped by
// category, plus the spends themselves.
router.get('/credit-card', async (_req, res) => {
  try {
    const owed = Number((await getSettings()).credit_outstanding);
    if (owed <= 0) return res.json({ owed: 0, byCategory: [], entries: [] });

    const { data, error } = await supabase
      .from('entries')
      .select('id, entry_date, amount, category, bucket, note')
      .eq('type', 'expense')
      .eq('payment_method', 'credit')
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);

    const entries = [];
    let covered = 0;
    for (const e of data) {
      if (covered >= owed - 0.005) break;
      entries.push(e);
      covered += Number(e.amount);
    }

    const byCategory = {};
    for (const e of entries) byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount);
    res.json({
      owed,
      byCategory: Object.entries(byCategory)
        .map(([category, total]) => ({ category, total }))
        .sort((a, b) => b.total - a.total),
      entries,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Withdraw cash from the bank (e.g. an ATM withdrawal): moves money from
// bank_balance to cash_balance. Not income or spending - a pure transfer.
router.post('/withdraw-cash', async (req, res) => {
  const { amount } = req.body || {};
  const n = Number(amount);
  if (!n || n <= 0) return res.status(400).json({ error: 'amount must be a positive number' });

  try {
    const data = await withdrawCash(n);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

    const entry_date = req.body?.entry_date || todayISO();

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
