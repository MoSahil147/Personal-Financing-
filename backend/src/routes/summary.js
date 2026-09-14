const express = require('express');
const supabase = require('../services/supabase');

const router = express.Router();

function monthRange(year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = new Date(Number(year), Number(month), 1).toISOString().slice(0, 10);
  return { start, end };
}

router.get('/monthly', async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!year || !month) return res.status(400).json({ error: 'year and month are required' });

  const { start, end } = monthRange(year, month);
  const { data: entries, error } = await supabase
    .from('entries')
    .select('*')
    .gte('entry_date', start)
    .lt('entry_date', end);

  if (error) return res.status(500).json({ error: error.message });

  const income = entries.filter((e) => e.type === 'income').reduce((s, e) => s + Number(e.amount), 0);
  const expense = entries.filter((e) => e.type === 'expense').reduce((s, e) => s + Number(e.amount), 0);

  const byCategory = {};
  const byClassification = { need: 0, want: 0, luxury: 0 };
  for (const e of entries.filter((e) => e.type === 'expense')) {
    byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount);
    if (e.classification && byClassification[e.classification] !== undefined) {
      byClassification[e.classification] += Number(e.amount);
    }
  }

  const { data: budgets, error: budgetErr } = await supabase.from('budgets').select('*');
  if (budgetErr) return res.status(500).json({ error: budgetErr.message });

  const budgetStatus = budgets.map((b) => {
    const spent = b.category === 'overall' ? expense : byCategory[b.category] || 0;
    const percent = Math.round((spent / Number(b.limit_amount)) * 100);
    return { category: b.category, limit: Number(b.limit_amount), spent, percent };
  });

  const alerts = budgetStatus
    .filter((b) => b.percent >= 80)
    .map((b) => ({
      category: b.category,
      percent: b.percent,
      level: b.percent >= 100 ? 'over' : 'near',
      message:
        b.percent >= 100
          ? `You've gone over your ${b.category} budget by ${(b.spent - b.limit).toFixed(2)}.`
          : `You're at ${b.percent}% of your ${b.category} budget.`,
    }));

  res.json({
    income,
    expense,
    savings: income - expense,
    byCategory: Object.entries(byCategory).map(([category, total]) => ({ category, total })),
    byClassification,
    budgetStatus,
    alerts,
  });
});

router.get('/yearly', async (req, res) => {
  const year = Number(req.query.year);
  if (!year) return res.status(400).json({ error: 'year is required' });

  const { data: entries, error } = await supabase
    .from('entries')
    .select('*')
    .gte('entry_date', `${year}-01-01`)
    .lt('entry_date', `${year + 1}-01-01`);

  if (error) return res.status(500).json({ error: error.message });

  const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, income: 0, expense: 0 }));
  const byCategory = {};

  for (const e of entries) {
    const m = Number(e.entry_date.slice(5, 7)) - 1;
    if (e.type === 'income') months[m].income += Number(e.amount);
    else {
      months[m].expense += Number(e.amount);
      byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount);
    }
  }

  const withSavings = months.map((m) => ({ ...m, savings: m.income - m.expense }));

  res.json({
    months: withSavings,
    byCategory: Object.entries(byCategory).map(([category, total]) => ({ category, total })),
  });
});

module.exports = router;
