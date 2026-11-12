const supabase = require('./supabase');
const { round3, money } = require('./bucketMath');

async function getSettings() {
  const [{ data, error }, accounts] = await Promise.all([
    supabase.from('settings').select('*').eq('id', 'main').single(),
    supabase.from('bank_accounts').select('id, name, balance, sort').order('sort'),
  ]);
  if (error) throw new Error(error.message);
  if (accounts.error) throw new Error(accounts.error.message);
  return { ...data, bank_accounts: accounts.data.sort((a, b) => a.sort - b.sort) };
}

async function getAccountIdBySort(sort) {
  const { bank_accounts } = await getSettings();
  const account = bank_accounts.find((a) => a.sort === sort);
  if (!account) throw new Error(`Bank account with sort order ${sort} not found`);
  return account.id;
}

async function updateBankBalance(accountId, balance, accounts = null) {
  const rounded = round3(balance);
  const { error } = await supabase.from('bank_accounts').update({ balance: rounded }).eq('id', accountId);
  if (error) throw new Error(error.message);
  const bankAccounts = accounts || (await getSettings()).bank_accounts;
  if (bankAccounts.find((a) => a.id === accountId)?.sort === 1) {
    const { error: settingsError } = await supabase.from('settings').update({ bank_balance: rounded }).eq('id', 'main');
    if (settingsError) throw new Error(settingsError.message);
  }
}

// Applies (sign=1) or reverses (sign=-1) the balance impact of an entries row.
// Cash payments/income move the cash balance and never touch the bank -
// credit expenses only move the "owed" total until settled - paying the card
// bill moves money out of the bank AND cuts what's owed - everything else
// (debit expenses, bank income) moves the bank balance directly.
async function applyEntryBalanceEffect({ type, amount, payment_method, category, bank_account }, sign) {
  const settings = await getSettings();
  bank_account ||= settings.bank_accounts[0]?.id;
  const delta = sign * Number(amount);

  if (type === 'expense' && category === 'Credit Card Payment' && payment_method !== 'credit') {
    const account = settings.bank_accounts.find((a) => a.id === bank_account);
    if (!account) throw new Error(`Unknown bank account: ${bank_account}`);
    await updateBankBalance(bank_account, Number(account.balance) - delta, settings.bank_accounts);
    const { error } = await supabase.from('settings')
      .update({ credit_outstanding: round3(Number(settings.credit_outstanding) - delta) }).eq('id', 'main');
    if (error) throw new Error(error.message);
  } else if (payment_method === 'cash') {
    const { error } = await supabase.from('settings')
      .update({ cash_balance: round3(Number(settings.cash_balance) + (type === 'income' ? delta : -delta)) })
      .eq('id', 'main');
    if (error) throw new Error(error.message);
  } else if (type === 'income') {
    const account = settings.bank_accounts.find((a) => a.id === bank_account);
    if (!account) throw new Error(`Unknown bank account: ${bank_account}`);
    await updateBankBalance(bank_account, Number(account.balance) + delta, settings.bank_accounts);
  } else if (payment_method === 'credit') {
    const { error } = await supabase.from('settings')
      .update({ credit_outstanding: round3(Number(settings.credit_outstanding) + delta) }).eq('id', 'main');
    if (error) throw new Error(error.message);
  } else {
    const account = settings.bank_accounts.find((a) => a.id === bank_account);
    if (!account) throw new Error(`Unknown bank account: ${bank_account}`);
    await updateBankBalance(bank_account, Number(account.balance) - delta, settings.bank_accounts);
  }
}

// Moving your own money from the bank to cash-on-hand (an ATM withdrawal) -
// not income or spending, so it's a pure transfer between the two balances.
async function withdrawCash(amount, accountId) {
  const settings = await getSettings();
  accountId ||= settings.bank_accounts[0]?.id;
  const n = round3(amount);
  const account = settings.bank_accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`Unknown bank account: ${accountId}`);
  await updateBankBalance(accountId, Number(account.balance) - n, settings.bank_accounts);
  const { data, error } = await supabase
    .from('settings')
    .update({ cash_balance: round3(Number(settings.cash_balance) + n) })
    .eq('id', 'main')
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// Putting cash on hand into the bank (a cash deposit) - the reverse of a
// withdrawal, also a pure transfer, so the boxes don't change.
async function depositCash(amount, accountId) {
  const settings = await getSettings();
  accountId ||= settings.bank_accounts[0]?.id;
  const cash = Number(settings.cash_balance);
  const n = round3(amount);
  const account = settings.bank_accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`Unknown bank account: ${accountId}`);
  if (n > cash) throw new Error(`You only have ${money(cash)} cash on hand`);
  await updateBankBalance(accountId, Number(account.balance) + n, settings.bank_accounts);
  const { data, error } = await supabase
    .from('settings')
    .update({ cash_balance: round3(cash - n) })
    .eq('id', 'main')
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

module.exports = { getSettings, getAccountIdBySort, applyEntryBalanceEffect, withdrawCash, depositCash };
