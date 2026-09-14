const supabase = require('./supabase');

async function getSettings() {
  const { data, error } = await supabase.from('settings').select('*').eq('id', 'main').single();
  if (error) throw new Error(error.message);
  return data;
}

// Applies (sign=1) or reverses (sign=-1) the balance impact of an entries row.
// Cash payments/income move the cash balance and never touch the bank -
// credit expenses only move the "owed" total until settled - everything
// else (debit expenses, bank income) moves the bank balance directly.
async function applyEntryBalanceEffect({ type, amount, payment_method }, sign) {
  const settings = await getSettings();
  const updates = {};
  const delta = sign * Number(amount);

  if (payment_method === 'cash') {
    updates.cash_balance = Number(settings.cash_balance) + (type === 'income' ? delta : -delta);
  } else if (type === 'income') {
    updates.bank_balance = Number(settings.bank_balance) + delta;
  } else if (payment_method === 'credit') {
    updates.credit_outstanding = Number(settings.credit_outstanding) + delta;
  } else {
    updates.bank_balance = Number(settings.bank_balance) - delta;
  }

  const { error } = await supabase.from('settings').update(updates).eq('id', 'main');
  if (error) throw new Error(error.message);
}

// Moving your own money from the bank to cash-on-hand (an ATM withdrawal) -
// not income or spending, so it's a pure transfer between the two balances.
async function withdrawCash(amount) {
  const settings = await getSettings();
  const { data, error } = await supabase
    .from('settings')
    .update({
      bank_balance: Number(settings.bank_balance) - Number(amount),
      cash_balance: Number(settings.cash_balance) + Number(amount),
    })
    .eq('id', 'main')
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

module.exports = { getSettings, applyEntryBalanceEffect, withdrawCash };
