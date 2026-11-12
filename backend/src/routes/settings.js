const express = require('express');
const supabase = require('../services/supabase');
const { getSettings, getAccountIdBySort, withdrawCash, depositCash } = require('../services/balances');
const { todayISO } = require('../services/date');
const { round3 } = require('../services/bucketMath');

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
    .update({ bank_balance: round3(bank_balance) })
    .eq('id', 'main')
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  let primaryAccountId;
  try {
    primaryAccountId = await getAccountIdBySort(1);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  const { error: accountError } = await supabase.from('bank_accounts')
    .update({ balance: round3(bank_balance) }).eq('id', primaryAccountId);
  if (accountError) return res.status(500).json({ error: accountError.message });
  res.json(data);
});

router.put('/account-balance/:id', async (req, res) => {
  const { id } = req.params;
  const balance = Number(req.body?.balance);
  let accounts;
  try {
    accounts = (await getSettings()).bank_accounts;
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!accounts.some((account) => account.id === id)) return res.status(404).json({ error: 'Bank account not found' });
  if (!Number.isFinite(balance) || balance < 0) {
    return res.status(400).json({ error: 'balance must be 0 or more' });
  }
  const rounded = round3(balance);
  const { data, error } = await supabase.from('bank_accounts')
    .update({ balance: rounded }).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (accounts.find((account) => account.id === id)?.sort === 1) {
    const { error: mirrorError } = await supabase.from('settings')
      .update({ bank_balance: rounded }).eq('id', 'main');
    if (mirrorError) return res.status(500).json({ error: mirrorError.message });
  }
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
    .update({ cash_balance: round3(cash_balance) })
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
    .update({ credit_card_limit: round3(credit_card_limit) })
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
      .select('id, entry_date, amount, category, bucket, bank_account, note')
      .eq('type', 'expense')
      .eq('payment_method', 'credit')
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);

    const entries = [];
    let covered = 0;
    for (const e of data) {
      if (covered >= owed - 0.0005) break;
      entries.push(e);
      covered = round3(covered + Number(e.amount));
    }

    const byCategory = {};
    for (const e of entries) byCategory[e.category] = round3((byCategory[e.category] || 0) + Number(e.amount));
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
    const accountId = req.body?.bank_account || await getAccountIdBySort(1);
    if (!(await getSettings()).bank_accounts.some((account) => account.id === accountId)) {
      return res.status(400).json({ error: 'Choose a valid bank account' });
    }
    const data = await withdrawCash(n, accountId);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deposit cash on hand into the bank: moves money from cash_balance to
// bank_balance. The reverse of a withdrawal - also a pure transfer.
router.post('/deposit-cash', async (req, res) => {
  const n = Number(req.body?.amount);
  if (!n || n <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
  try {
    const accountId = req.body?.bank_account || await getAccountIdBySort(1);
    if (!(await getSettings()).bank_accounts.some((account) => account.id === accountId)) {
      return res.status(400).json({ error: 'Choose a valid bank account' });
    }
    res.json(await depositCash(n, accountId));
  } catch (err) {
    res.status(400).json({ error: err.message });
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
    .update({ monthly_savings_target: round3(monthly_savings_target) })
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
    const accountId = req.body?.bank_account || settings.bank_accounts[0]?.id;
    if (!settings.bank_accounts.some((account) => account.id === accountId)) return res.status(400).json({ error: 'Choose a valid bank account' });
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
      bank_account: accountId,
      note: 'Monthly credit card settlement',
    });
    if (insertErr) throw new Error(insertErr.message);

    const account = settings.bank_accounts.find((a) => a.id === accountId);
    if (!account) throw new Error(`Unknown bank account: ${accountId}`);
    const { data, error: updateErr } = await supabase.from('bank_accounts')
      .update({ balance: round3(Number(account.balance) - amount) })
      .eq('id', accountId).select().single();
    if (updateErr) throw new Error(updateErr.message);
    const { error: settingsErr } = await supabase.from('settings')
      .update({ credit_outstanding: 0, ...(account.sort === 1 ? { bank_balance: round3(Number(account.balance) - amount) } : {}) })
      .eq('id', 'main')
    if (settingsErr) throw new Error(settingsErr.message);

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
