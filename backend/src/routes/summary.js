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
  const expenseByMethod = { debit: 0, credit: 0 };
  let investedThisMonth = 0;
  for (const e of entries.filter((e) => e.type === 'expense')) {
    byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount);
    if (e.classification && byClassification[e.classification] !== undefined) {
      byClassification[e.classification] += Number(e.amount);
    }
    if (e.classification === 'investment') investedThisMonth += Number(e.amount);
    expenseByMethod[e.payment_method === 'credit' ? 'credit' : 'debit'] += Number(e.amount);
  }

  const { data: yearEntries, error: yearErr } = await supabase
    .from('entries')
    .select('amount, classification')
    .eq('classification', 'investment')
    .gte('entry_date', `${year}-01-01`)
    .lt('entry_date', `${year + 1}-01-01`);
  if (yearErr) return res.status(500).json({ error: yearErr.message });
  const investedThisYear = yearEntries.reduce((s, e) => s + Number(e.amount), 0);

  const { data: budgets, error: budgetErr } = await supabase.from('budgets').select('*');
  if (budgetErr) return res.status(500).json({ error: budgetErr.message });

  // Savings target is a nice-to-have on top of the core numbers above - if the
  // settings row/column isn't there yet, don't take down the whole dashboard.
  const { data: settings } = await supabase
    .from('settings')
    .select('monthly_savings_target')
    .eq('id', 'main')
    .single();

  const savings = income - expense;
  const savingsTarget = Number(settings?.monthly_savings_target) || 0;
  const savingsPercent = savingsTarget > 0 ? Math.round((savings / savingsTarget) * 100) : null;

  // A budget's category can be a single name ("Groceries") or a comma-separated
  // group ("Groceries, Shopping, Clothing") that shares one combined cap.
  const budgetStatus = budgets.map((b) => {
    let spent;
    if (b.category === 'overall') {
      spent = expense;
    } else {
      const members = b.category.split(',').map((c) => c.trim().toLowerCase());
      spent = Object.entries(byCategory)
        .filter(([cat]) => members.includes(cat.toLowerCase()))
        .reduce((s, [, total]) => s + total, 0);
    }
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

  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;
  if (isCurrentMonth && savingsTarget > 0) {
    const daysInMonth = new Date(year, month, 0).getDate();
    const expectedPaceAmount = (savingsTarget / daysInMonth) * today.getDate();
    if (savings < expectedPaceAmount - savingsTarget * 0.1) {
      alerts.push({
        category: 'Savings goal',
        percent: savingsPercent,
        level: 'near',
        message: `You're behind pace on your ${savingsTarget.toFixed(2)} savings goal - saved ${savings.toFixed(2)} so far.`,
      });
    }
  }

  res.json({
    income,
    expense,
    expenseByMethod,
    savings,
    savingsTarget,
    savingsPercent,
    investedThisMonth,
    investedThisYear,
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

  const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, income: 0, expense: 0, invested: 0 }));
  const byCategory = {};
  const expenseByMethod = { debit: 0, credit: 0 };
  let investedThisYear = 0;
  let income = 0;
  let expense = 0;

  for (const e of entries) {
    const m = Number(e.entry_date.slice(5, 7)) - 1;
    const amount = Number(e.amount);
    if (e.type === 'income') {
      months[m].income += amount;
      income += amount;
    } else {
      months[m].expense += amount;
      expense += amount;
      byCategory[e.category] = (byCategory[e.category] || 0) + amount;
      expenseByMethod[e.payment_method === 'credit' ? 'credit' : 'debit'] += amount;
      if (e.classification === 'investment') {
        months[m].invested += amount;
        investedThisYear += amount;
      }
    }
  }

  const withSavings = months.map((m) => ({ ...m, savings: m.income - m.expense }));

  res.json({
    income,
    expense,
    savings: income - expense,
    expenseByMethod,
    months: withSavings,
    investedThisYear,
    byCategory: Object.entries(byCategory).map(([category, total]) => ({ category, total })),
  });
});

module.exports = router;
