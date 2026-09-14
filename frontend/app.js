const API = window.API_BASE_URL;
const TOKEN_KEY = 'finance_token';

// Fixed palette so each category keeps the same color across refreshes/months
// instead of Chart.js's default set, which repeats after a handful of slices.
const CHART_COLORS = [
  '#4f8dfd', '#4fbf7a', '#ef5a5a', '#e0a94e', '#a78bfa',
  '#38bdf8', '#fb7185', '#34d399', '#f59e0b', '#c084fc',
];

function colorForLabel(label) {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return CHART_COLORS[hash % CHART_COLORS.length];
}

// Must match CATEGORIES in backend/src/services/groq.js so the categories the
// LLM assigns and the ones pickable here are always the same closed set,
// which keeps monthly and yearly views consistent.
const CATEGORIES = [
  'Groceries', 'Shopping', 'Dining', 'Transport', 'Fuel', 'Utilities', 'Rent',
  'Entertainment', 'Subscriptions', 'Health', 'Travel', 'Education', 'Gifts',
  'Repayment', 'Refund', 'Salary', 'Investment', 'Credit Card Payment', 'Other',
];

const state = {
  month: new Date().getMonth() + 1,
  year: new Date().getFullYear(),
  view: 'monthly',
  pieChart: null,
  yearlyChart: null,
  pendingSuggestion: null,
};

// ---------- auth ----------

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function showConnectionBanner(text) {
  const el = document.getElementById('connection-banner');
  el.textContent = text;
  el.hidden = false;
}

function hideConnectionBanner() {
  document.getElementById('connection-banner').hidden = true;
}

// Render's free tier spins the backend down after inactivity, so ANY request
// (loading data, adding a reminder, logging an entry, ...) can hit a network
// error or a 502/503/504 gateway error for a bit while it wakes up. Retry
// every call here instead of only the initial page load, so actions taken
// during a cold start don't just fail silently.
const RETRY_DELAYS_MS = [2000, 4000, 8000, 8000];

async function api(path, options = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
          ...(options.headers || {}),
        },
      });
    } catch (err) {
      if (attempt < RETRY_DELAYS_MS.length) {
        showConnectionBanner('Waking up the server, please wait...');
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new Error('Could not reach the server. Check your connection and try again.');
    }

    if (res.status === 401) {
      clearToken();
      showLogin();
      throw new Error('Session expired, please log in again');
    }

    if ([502, 503, 504].includes(res.status) && attempt < RETRY_DELAYS_MS.length) {
      showConnectionBanner('Waking up the server, please wait...');
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }

    hideConnectionBanner();
    if (res.status === 204) return null;
    return res.json();
  }
}

async function loadSection(fn, label) {
  try {
    await fn();
  } catch (err) {
    showConnectionBanner(`Couldn't load ${label}: ${err.message}`);
  }
}

function showLogin() {
  document.getElementById('login-screen').hidden = false;
  document.getElementById('app').hidden = true;
  document.getElementById('chat-bar').hidden = true;
}

function showApp() {
  document.getElementById('login-screen').hidden = true;
  document.getElementById('app').hidden = false;
  document.getElementById('chat-bar').hidden = false;
  initApp();
}

document.getElementById('login-submit').addEventListener('click', login);
document.getElementById('login-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') login();
});

async function login() {
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.status === 401) {
        errorEl.textContent = 'Wrong password';
        return;
      }
      if ([502, 503, 504].includes(res.status) && attempt < RETRY_DELAYS_MS.length) {
        errorEl.textContent = 'Waking up the server, please wait...';
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      if (!res.ok) {
        errorEl.textContent = 'Wrong password';
        return;
      }
      const { token } = await res.json();
      setToken(token);
      errorEl.textContent = '';
      showApp();
      return;
    } catch {
      if (attempt < RETRY_DELAYS_MS.length) {
        errorEl.textContent = 'Waking up the server, please wait...';
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      errorEl.textContent = 'Could not reach server. Check your connection and try again.';
      return;
    }
  }
}

// ---------- period selectors ----------

function populateSelectors() {
  const monthSel = document.getElementById('month-select');
  const yearSel = document.getElementById('year-select');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  monthSel.innerHTML = months.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');
  monthSel.value = state.month;

  const years = [];
  for (let y = 2026; y <= 2099; y++) years.push(y);
  yearSel.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');
  yearSel.value = state.year;

  monthSel.addEventListener('change', () => { state.month = Number(monthSel.value); refreshMonthly(); refreshLedger(); });
  yearSel.addEventListener('change', () => {
    state.year = Number(yearSel.value);
    refreshMonthly(); refreshLedger(); refreshYearly();
  });
}

document.getElementById('tab-monthly').addEventListener('click', () => setView('monthly'));
document.getElementById('tab-yearly').addEventListener('click', () => setView('yearly'));

function setView(view) {
  state.view = view;
  document.getElementById('tab-monthly').classList.toggle('active', view === 'monthly');
  document.getElementById('tab-yearly').classList.toggle('active', view === 'yearly');
  document.getElementById('monthly-view').hidden = view !== 'monthly';
  document.getElementById('yearly-view').hidden = view !== 'yearly';
  if (view === 'yearly') refreshYearly();
}

// ---------- reminders ----------

// Renders 5 hoverable stars into `container`. Starts blank/white up to
// `initial`, fills gold on hover preview, and calls onSelect(value) on click.
function buildStarPicker(container, initial, onSelect) {
  container.innerHTML = '';
  let selected = initial;

  const paint = (upTo) => {
    stars.forEach((star, i) => {
      star.textContent = i < upTo ? '★' : '☆';
      star.classList.toggle('filled', i < upTo);
    });
  };

  const stars = [1, 2, 3, 4, 5].map((value) => {
    const star = document.createElement('span');
    star.className = 'star';
    star.dataset.value = value;
    star.addEventListener('mouseenter', () => paint(value));
    star.addEventListener('mouseleave', () => paint(selected));
    star.addEventListener('click', () => {
      selected = value;
      paint(selected);
      onSelect(value);
    });
    container.appendChild(star);
    return star;
  });

  paint(selected);
  return { get value() { return selected; } };
}

let newReminderStars = buildStarPicker(document.getElementById('new-reminder-stars'), 3, () => {});

async function refreshReminders() {
  const reminders = await api('/api/reminders');
  const list = document.getElementById('reminders-list');
  list.innerHTML = '';
  for (const r of reminders) {
    const li = document.createElement('li');
    const due = r.due_date ? `<span class="reminder-due">${r.due_date}</span>` : '';
    li.innerHTML = `<input type="checkbox" data-id="${r.id}" /> <span>${escapeHtml(r.text)}</span> ${due} <span class="star-picker" data-id="${r.id}"></span>`;
    list.appendChild(li);

    const starContainer = li.querySelector('.star-picker');
    buildStarPicker(starContainer, r.priority || 3, async (value) => {
      try {
        await api(`/api/reminders/${r.id}/priority`, { method: 'PATCH', body: JSON.stringify({ priority: value }) });
      } catch (err) {
        alert(err.message);
      }
    });
  }
  list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      try {
        await api(`/api/reminders/${cb.dataset.id}/done`, { method: 'PATCH' });
        refreshReminders();
      } catch (err) {
        cb.checked = false;
        alert(err.message);
      }
    });
  });
}

document.getElementById('reminder-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('reminder-text');
  const text = input.value.trim();
  if (!text) return;
  try {
    await api('/api/reminders', { method: 'POST', body: JSON.stringify({ text, priority: newReminderStars.value }) });
    input.value = '';
    newReminderStars = buildStarPicker(document.getElementById('new-reminder-stars'), 3, () => {});
    refreshReminders();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- balances ----------

async function refreshBalances() {
  const settings = await api('/api/settings');
  const bank = Number(settings.bank_balance);
  const cash = Number(settings.cash_balance);
  document.getElementById('bank-balance').textContent = `${bank.toFixed(2)} AED`;
  document.getElementById('cash-balance').textContent = `${cash.toFixed(2)} AED`;
  const owed = Number(settings.credit_outstanding);
  const limit = Number(settings.credit_card_limit) || 0;
  document.getElementById('credit-outstanding').textContent = `${owed.toFixed(2)} AED`;
  document.getElementById('settle-credit-btn').hidden = owed <= 0;
  document.getElementById('credit-box').classList.toggle('over-limit', limit > 0 && owed >= limit);
  document.getElementById('total-capital').textContent = `${(bank + cash).toFixed(2)} AED`;
}

document.getElementById('settle-credit-btn').addEventListener('click', async () => {
  if (!confirm('Log a payment for the full credit card balance from your bank account?')) return;
  try {
    await api('/api/settings/settle-credit-card', { method: 'POST' });
    refreshBalances();
    refreshLedger();
    refreshMonthly();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- alerts + monthly summary ----------

async function refreshMonthly() {
  const summary = await api(`/api/summary/monthly?year=${state.year}&month=${state.month}`);

  document.getElementById('stat-income').textContent = summary.income.toFixed(2);
  const expenseEl = document.getElementById('stat-expense');
  expenseEl.textContent = summary.expense.toFixed(2);
  const savingsEl = document.getElementById('stat-savings');
  savingsEl.textContent = summary.savings.toFixed(2);
  savingsEl.className = 'value ' + (summary.savings >= 0 ? 'good' : 'bad');

  document.getElementById('eb-total').textContent = summary.expense.toFixed(2);
  document.getElementById('eb-credit').textContent = summary.expenseByMethod.credit.toFixed(2);
  document.getElementById('eb-debit').textContent = `-${summary.expenseByMethod.debit.toFixed(2)}`;

  document.getElementById('invested-month').textContent = summary.investedThisMonth.toFixed(2);
  document.getElementById('invested-year').textContent = summary.investedThisYear.toFixed(2);

  const alertsEl = document.getElementById('alerts');
  alertsEl.innerHTML = '';
  if (summary.alerts.length === 0) {
    alertsEl.innerHTML = '<div style="color: var(--muted); font-size: 14px;">No budget alerts this month.</div>';
  } else {
    for (const a of summary.alerts) {
      const div = document.createElement('div');
      div.className = `alert ${a.level}`;
      div.textContent = a.message;
      alertsEl.appendChild(div);
    }
  }

  renderSavingsGoal(summary.savingsTarget, summary.savings, summary.savingsPercent);
  renderBudgets(summary.budgetStatus);
  renderPieChart(summary.byCategory);
}

function renderBudgets(budgetStatus) {
  const list = document.getElementById('budgets-list');
  list.innerHTML = '';
  for (const b of budgetStatus) {
    const clamped = Math.max(0, Math.min(100, b.percent));
    const close = b.percent >= 80;
    const item = document.createElement('div');
    item.className = 'budget-item';
    item.innerHTML = `
      <div class="budget-item-labels">
        <span class="category">${escapeHtml(b.category)}</span>
        <span>${b.spent.toFixed(2)} / ${b.limit.toFixed(2)}</span>
      </div>
      <div class="budget-item-bar"><div class="${close ? 'close' : ''}" style="width:${clamped}%"></div></div>`;
    list.appendChild(item);
  }
}

function renderSavingsGoal(target, savings, percent) {
  const row = document.getElementById('savings-goal-row');
  if (!target || target <= 0) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  document.getElementById('savings-goal-amount').textContent = `${target.toFixed(2)}`;
  document.getElementById('savings-goal-percent').textContent = `${percent}%`;
  const fill = document.getElementById('savings-goal-fill');
  const clamped = Math.max(0, Math.min(100, percent));
  fill.style.width = `${clamped}%`;
  fill.className = percent < 60 ? 'behind' : '';
}

function renderPieChart(byCategory) {
  const ctx = document.getElementById('pie-chart');
  if (state.pieChart) state.pieChart.destroy();
  if (!byCategory.length) return;

  state.pieChart = new Chart(ctx, {
    type: 'pie',
    data: {
      labels: byCategory.map((c) => c.category),
      datasets: [{ data: byCategory.map((c) => c.total), backgroundColor: byCategory.map((c) => colorForLabel(c.category)) }],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: '#e8eaed', boxWidth: 12, font: { size: 11 } } } },
    },
  });
}

async function refreshYearly() {
  const summary = await api(`/api/summary/yearly?year=${state.year}`);
  document.getElementById('invested-year-tab').textContent = summary.investedThisYear.toFixed(2);

  const ctx = document.getElementById('yearly-chart');
  if (state.yearlyChart) state.yearlyChart.destroy();

  const labels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  state.yearlyChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Income', data: summary.months.map((m) => m.income), backgroundColor: '#4fbf7a' },
        { label: 'Expense', data: summary.months.map((m) => m.expense), backgroundColor: '#ef5a5a' },
        { label: 'Invested', data: summary.months.map((m) => m.invested), backgroundColor: '#38bdf8' },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#e8eaed', boxWidth: 12, font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: '#9aa0ac' } },
        y: { ticks: { color: '#9aa0ac' } },
      },
    },
  });
}

// ---------- ledger ----------

async function refreshLedger() {
  const entries = await api(`/api/entries?year=${state.year}&month=${state.month}`);
  const list = document.getElementById('ledger-list');
  list.innerHTML = '';
  for (const e of entries) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span>
        <strong>${escapeHtml(e.category)}</strong>
        <span class="ledger-meta">${e.entry_date}${e.classification ? ' · ' + e.classification : ''}${e.payment_method ? ' · ' + e.payment_method : ''}</span>
      </span>
      <span>
        <span class="ledger-amount ${e.type}">${e.type === 'income' ? '+' : '-'}${Number(e.amount).toFixed(2)}</span>
        <button class="ledger-del" data-id="${e.id}">✕</button>
      </span>`;
    list.appendChild(li);
  }
  list.querySelectorAll('.ledger-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/entries/${btn.dataset.id}`, { method: 'DELETE' });
      refreshLedger();
      refreshMonthly();
      refreshBalances();
    });
  });
}

// ---------- chat input -> parse -> confirm -> save ----------

document.getElementById('chat-send').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

async function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  try {
    const result = await api('/api/chat', { method: 'POST', body: JSON.stringify({ text }) });

    if (result.intent === 'log_entry') {
      openConfirmModal(result.suggestion, result.raw_input);
    } else if (result.intent === 'cash_withdrawal') {
      if (confirm(`Withdraw ${Number(result.amount).toFixed(2)} from the bank to cash?`)) {
        await api('/api/settings/withdraw-cash', { method: 'POST', body: JSON.stringify({ amount: result.amount }) });
        refreshBalances();
      }
    } else if (result.intent === 'add_reminder') {
      refreshReminders();
    } else if (result.intent === 'remove_reminder') {
      if (result.removed) {
        refreshReminders();
      } else {
        alert(result.reply || "Couldn't find that reminder.");
      }
    } else {
      alert(result.reply || 'Not sure what you meant.');
    }
  } catch (err) {
    alert(err.message);
  }
}

const EXPENSE_METHODS = [
  { value: 'debit', label: 'Debit (bank account)' },
  { value: 'credit', label: 'Credit card' },
  { value: 'cash', label: 'Cash' },
];
const INCOME_METHODS = [
  { value: '', label: 'Bank' },
  { value: 'cash', label: 'Cash' },
];

function updatePaymentMethodOptions() {
  const isExpense = document.getElementById('confirm-type').value === 'expense';
  const select = document.getElementById('confirm-payment-method');
  const methods = isExpense ? EXPENSE_METHODS : INCOME_METHODS;
  select.innerHTML = methods.map((m) => `<option value="${m.value}">${m.label}</option>`).join('');
}

document.getElementById('confirm-type').addEventListener('change', updatePaymentMethodOptions);

const categorySelect = document.getElementById('confirm-category');
categorySelect.innerHTML = CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('');

function openConfirmModal(suggestion, raw_input) {
  state.pendingSuggestion = { ...suggestion, raw_input };
  document.getElementById('confirm-type').value = suggestion.type || 'expense';
  document.getElementById('confirm-amount').value = suggestion.amount ?? '';
  categorySelect.value = CATEGORIES.includes(suggestion.category) ? suggestion.category : 'Other';
  document.getElementById('confirm-classification').value = suggestion.classification || '';
  updatePaymentMethodOptions();
  document.getElementById('confirm-payment-method').value = suggestion.payment_method || (suggestion.type === 'expense' ? 'debit' : '');
  document.getElementById('confirm-date').value = suggestion.date || new Date().toISOString().slice(0, 10);
  document.getElementById('confirm-note').value = suggestion.note || '';
  document.getElementById('confirm-modal').hidden = false;
}

document.getElementById('confirm-cancel').addEventListener('click', () => {
  document.getElementById('confirm-modal').hidden = true;
  state.pendingSuggestion = null;
});

document.getElementById('confirm-save').addEventListener('click', async () => {
  const type = document.getElementById('confirm-type').value;
  const payload = {
    type,
    amount: Number(document.getElementById('confirm-amount').value),
    category: document.getElementById('confirm-category').value.trim(),
    classification: document.getElementById('confirm-classification').value || null,
    payment_method: document.getElementById('confirm-payment-method').value || null,
    entry_date: document.getElementById('confirm-date').value,
    note: document.getElementById('confirm-note').value.trim(),
    raw_input: state.pendingSuggestion?.raw_input || null,
  };

  if (!payload.amount || !payload.category || !payload.entry_date) {
    alert('Amount, category and date are required.');
    return;
  }

  try {
    await api('/api/entries', { method: 'POST', body: JSON.stringify(payload) });
    document.getElementById('confirm-modal').hidden = true;
    state.pendingSuggestion = null;

    refreshBalances();
    const entryMonth = Number(payload.entry_date.slice(5, 7));
    const entryYear = Number(payload.entry_date.slice(0, 4));
    if (entryMonth === state.month && entryYear === state.year) {
      refreshMonthly();
      refreshLedger();
    }
  } catch (err) {
    alert(err.message);
  }
});

// ---------- utils ----------

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- boot ----------

function initApp() {
  populateSelectors();
  loadSection(refreshReminders, 'reminders');
  loadSection(refreshBalances, 'balances');
  loadSection(refreshMonthly, 'monthly summary');
  loadSection(refreshLedger, 'ledger');
}

if (getToken()) {
  showApp();
} else {
  showLogin();
}
