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

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    clearToken();
    showLogin();
    throw new Error('Session expired, please log in again');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
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
  try {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      errorEl.textContent = 'Wrong password';
      return;
    }
    const { token } = await res.json();
    setToken(token);
    showApp();
  } catch {
    errorEl.textContent = 'Could not reach server';
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

async function refreshReminders() {
  const reminders = await api('/api/reminders');
  const list = document.getElementById('reminders-list');
  list.innerHTML = '';
  for (const r of reminders) {
    const li = document.createElement('li');
    const due = r.due_date ? `<span class="reminder-due">${r.due_date}</span>` : '';
    li.innerHTML = `<input type="checkbox" data-id="${r.id}" /> <span>${escapeHtml(r.text)}</span> ${due}`;
    list.appendChild(li);
  }
  list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      await api(`/api/reminders/${cb.dataset.id}/done`, { method: 'PATCH' });
      refreshReminders();
    });
  });
}

document.getElementById('reminder-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('reminder-text');
  const text = input.value.trim();
  if (!text) return;
  await api('/api/reminders', { method: 'POST', body: JSON.stringify({ text }) });
  input.value = '';
  refreshReminders();
});

// ---------- balances ----------

async function refreshBalances() {
  const settings = await api('/api/settings');
  document.getElementById('bank-balance').textContent = `${Number(settings.bank_balance).toFixed(2)} AED`;
  document.getElementById('credit-outstanding').textContent = `${Number(settings.credit_outstanding).toFixed(2)} AED`;
  document.getElementById('settle-credit-btn').hidden = Number(settings.credit_outstanding) <= 0;
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

function updatePaymentFieldVisibility() {
  const isExpense = document.getElementById('confirm-type').value === 'expense';
  document.getElementById('confirm-payment-label').hidden = !isExpense;
  document.getElementById('confirm-payment-method').hidden = !isExpense;
}

document.getElementById('confirm-type').addEventListener('change', updatePaymentFieldVisibility);

function openConfirmModal(suggestion, raw_input) {
  state.pendingSuggestion = { ...suggestion, raw_input };
  document.getElementById('confirm-type').value = suggestion.type || 'expense';
  document.getElementById('confirm-amount').value = suggestion.amount ?? '';
  document.getElementById('confirm-category').value = suggestion.category || '';
  document.getElementById('confirm-classification').value = suggestion.classification || '';
  document.getElementById('confirm-payment-method').value = suggestion.payment_method || 'debit';
  document.getElementById('confirm-date').value = suggestion.date || new Date().toISOString().slice(0, 10);
  document.getElementById('confirm-note').value = suggestion.note || '';
  updatePaymentFieldVisibility();
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
    payment_method: type === 'expense' ? document.getElementById('confirm-payment-method').value : null,
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
  refreshReminders();
  refreshBalances();
  refreshMonthly();
  refreshLedger();
}

if (getToken()) {
  showApp();
} else {
  showLogin();
}
