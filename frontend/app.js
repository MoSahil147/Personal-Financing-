const API = window.API_BASE_URL;
const TOKEN_KEY = 'finance_token';

// toISOString() normalizes to UTC, which can report the wrong calendar date
// near midnight in the device's actual timezone - use local date parts instead.
function todayISO() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// Fixed palette so each category keeps the same color across refreshes/months
// instead of Chart.js's default set. Each entry is a genuinely distinct hue
// (based on the colorblind-safe Okabe-Ito set) rather than lighter/darker
// shades of the same handful of colors, so categories stay easy to tell apart
// even with many slices on one chart.
const CHART_COLORS = [
  '#e69f00', // orange
  '#56b4e9', // sky blue
  '#009e73', // teal green
  '#d55e00', // vermillion
  '#cc79a7', // pink/mauve
  '#0072b2', // blue
  '#f0e442', // yellow
  '#6a3d9a', // purple
  '#b15928', // brown
  '#999999', // gray
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
  yearlyPieChart: null,
  categoryBarChart: null,
  yearlyCategoryBarChart: null,
  pendingSuggestion: null,
  boxes: [],
  boxSpent: {},
  boxPieMode: 'balances',
  boxPieChart: null,
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

  monthSel.addEventListener('change', () => {
    state.month = Number(monthSel.value);
    loadSection(refreshMonthly, 'monthly summary');
    loadSection(refreshLedger, 'ledger');
  });
  yearSel.addEventListener('change', () => {
    state.year = Number(yearSel.value);
    loadSection(refreshMonthly, 'monthly summary');
    loadSection(refreshLedger, 'ledger');
    if (state.view === 'yearly') loadSection(refreshYearly, 'yearly summary');
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
  if (view === 'yearly') loadSection(refreshYearly, 'yearly summary');
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

// ---------- budget boxes ----------

function fmt(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Boxes get fixed colors by their position, so each box keeps the same color
// on its card and in the pie (no hash collisions between the 9 boxes).
function boxColor(key) {
  const i = state.boxes.findIndex((b) => b.key === key);
  return CHART_COLORS[Math.max(0, i) % CHART_COLORS.length];
}

function boxName(key) {
  return state.boxes.find((b) => b.key === key)?.name || key;
}

function capBar(key, filled, cap) {
  const pct = Math.max(0, Math.min(100, (filled / cap) * 100));
  return `<div class="box-cap-bar"><div style="width:${pct}%;background:${boxColor(key)}"></div></div>
    <div class="box-cap-label">Limit ${fmt(cap)}</div>`;
}

async function refreshBoxes() {
  const data = await api('/api/buckets');
  state.boxes = data.buckets.map((b) => ({ ...b, balance: Number(b.balance) }));
  state.boxSpent = data.spentThisMonth || {};

  document.getElementById('boxes-total').textContent = `${fmt(data.total)} AED`;
  document.getElementById('boxes-real').textContent = `${fmt(data.realMoney)} AED`;
  const chip = document.getElementById('boxes-unallocated');
  chip.hidden = data.needsSetup || Math.abs(data.unallocated) <= 1;
  chip.textContent = `Not in a box: ${fmt(data.unallocated)}`;
  chip.classList.toggle('bad', data.unallocated < 0);

  document.getElementById('boxes-setup').hidden = !data.needsSetup;
  if (data.needsSetup) await renderSetupPreview();

  const grid = document.getElementById('boxes-grid');
  grid.innerHTML = '';
  for (const b of state.boxes) {
    if (b.key === 'buffer') continue;
    const card = document.createElement('div');
    card.className = 'box-card';
    card.style.borderTopColor = boxColor(b.key);
    card.innerHTML = `
      <div class="box-name">${escapeHtml(b.name)}${Number(b.percent) > 0 ? ` <span class="box-percent">${Number(b.percent)}%</span>` : ''}</div>
      <div class="box-balance ${b.balance < 0 ? 'bad' : ''}">${fmt(b.balance)}</div>
      ${b.cap ? capBar(b.key, b.balance, Number(b.cap)) : ''}`;
    grid.appendChild(card);
  }

  const buffer = state.boxes.find((b) => b.key === 'buffer');
  document.getElementById('buffer-strip').innerHTML = buffer
    ? `<span>Buffer</span>
       <span class="buffer-value ${buffer.balance < 0 ? 'bad' : ''}">${fmt(buffer.balance)} / ${fmt(buffer.cap)}</span>
       <div class="box-cap-bar"><div style="width:${Math.max(0, Math.min(100, (buffer.balance / buffer.cap) * 100))}%;background:${boxColor('buffer')}"></div></div>`
    : '';

  renderBoxPie();
  await refreshBoxHistory();
}

async function renderSetupPreview() {
  const p = await api('/api/buckets/setup-preview');
  const el = document.getElementById('boxes-setup-preview');
  const btn = document.getElementById('boxes-setup-btn');
  btn.disabled = !(p.total > 0);
  if (!(p.total > 0)) {
    el.innerHTML = '<div class="setup-total">Set your bank/cash balance first - there\'s nothing to split yet.</div>';
    return;
  }
  el.innerHTML = `<div class="setup-total">From ${fmt(p.total)} AED (bank + cash − card owed):</div>`
    + state.boxes
      .filter((b) => p.shares[b.key])
      .map((b) => `<div class="eb-row"><span>${escapeHtml(b.name)}</span><span>${fmt(p.shares[b.key])}</span></div>`)
      .join('');
}

document.getElementById('boxes-setup-btn').addEventListener('click', async () => {
  if (!confirm('Split your current money into the boxes as shown?')) return;
  try {
    await api('/api/buckets/setup', { method: 'POST' });
    loadSection(refreshBoxes, 'boxes');
  } catch (err) {
    alert(err.message);
  }
});

function renderBoxPie() {
  const canvas = document.getElementById('box-pie-chart');
  if (state.boxPieChart) state.boxPieChart.destroy();
  state.boxPieChart = null;

  const values = state.boxPieMode === 'spent'
    ? state.boxes.map((b) => ({ b, v: state.boxSpent[b.key] || 0 }))
    : state.boxes.map((b) => ({ b, v: b.balance }));
  const slices = values.filter((x) => x.v > 0); // negative boxes can't be a pie slice

  canvas.parentElement.hidden = !slices.length;
  document.getElementById('box-pie-empty').hidden = slices.length > 0;
  if (!slices.length) return;

  state.boxPieChart = new Chart(canvas, {
    type: 'pie',
    data: {
      labels: slices.map((x) => x.b.name),
      datasets: [{ data: slices.map((x) => x.v), backgroundColor: slices.map((x) => boxColor(x.b.key)) }],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: '#e8eaed', boxWidth: 12, font: { size: 11 } } } },
    },
  });
}

function setBoxPieMode(mode) {
  state.boxPieMode = mode;
  document.getElementById('box-pie-balances').classList.toggle('active', mode === 'balances');
  document.getElementById('box-pie-spent').classList.toggle('active', mode === 'spent');
  renderBoxPie();
}

document.getElementById('box-pie-balances').addEventListener('click', () => setBoxPieMode('balances'));
document.getElementById('box-pie-spent').addEventListener('click', () => setBoxPieMode('spent'));

function moveReasonLabel(reason) {
  return {
    setup: 'Starting split', income: 'Income split', refund: 'Refund', spend: 'Spent', close: 'Month end (salary)',
  }[reason] || reason;
}

async function refreshBoxHistory() {
  const moves = await api('/api/buckets/moves');
  const list = document.getElementById('box-history-list');
  list.innerHTML = moves.length ? '' : '<li><span class="ledger-meta">No box moves yet.</span></li>';
  for (const m of moves) {
    const route = m.from_bucket && m.to_bucket
      ? `${boxName(m.from_bucket)} → ${boxName(m.to_bucket)}`
      : m.to_bucket ? `+ ${boxName(m.to_bucket)}` : `− ${boxName(m.from_bucket)}`;
    const li = document.createElement('li');
    li.innerHTML = `
      <span><strong>${escapeHtml(route)}</strong><span class="ledger-meta">${m.move_date} · ${escapeHtml(moveReasonLabel(m.reason))}</span></span>
      <span>${fmt(m.amount)}</span>`;
    list.appendChild(li);
  }
}

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
  state.pieChart = renderPieChart('pie-chart', state.pieChart, summary.byCategory);
  state.categoryBarChart = renderCategoryBarChart('category-bar-chart', state.categoryBarChart, summary.byCategory);
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

// Spending-by-category pie, shared by the monthly and yearly views so both use
// the same categories and colors. Returns the new chart (or null if empty).
function renderPieChart(canvasId, previous, byCategory) {
  const ctx = document.getElementById(canvasId);
  if (previous) previous.destroy();
  if (!byCategory.length) return null;

  return new Chart(ctx, {
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

// Same categories and colors as the pie, as bars (biggest first) so exact
// amounts can be read off the value axis on the left.
function renderCategoryBarChart(canvasId, previous, byCategory) {
  const ctx = document.getElementById(canvasId);
  if (previous) previous.destroy();
  if (!byCategory.length) return null;

  const sorted = [...byCategory].sort((a, b) => b.total - a.total);
  return new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sorted.map((c) => c.category),
      datasets: [{
        label: 'Spent',
        data: sorted.map((c) => c.total),
        backgroundColor: sorted.map((c) => colorForLabel(c.category)),
      }],
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (item) => `${Number(item.raw).toFixed(2)} AED` } },
      },
      scales: {
        x: { ticks: { color: '#9aa0ac', autoSkip: false, maxRotation: 60, font: { size: 11 } } },
        y: { beginAtZero: true, ticks: { color: '#9aa0ac' } },
      },
    },
  });
}

async function refreshYearly() {
  const summary = await api(`/api/summary/yearly?year=${state.year}`);

  document.getElementById('year-stat-income').textContent = summary.income.toFixed(2);
  document.getElementById('year-stat-expense').textContent = summary.expense.toFixed(2);
  const yearSavingsEl = document.getElementById('year-stat-savings');
  yearSavingsEl.textContent = summary.savings.toFixed(2);
  yearSavingsEl.className = 'value ' + (summary.savings >= 0 ? 'good' : 'bad');

  document.getElementById('year-eb-total').textContent = summary.expense.toFixed(2);
  document.getElementById('year-eb-credit').textContent = summary.expenseByMethod.credit.toFixed(2);
  document.getElementById('year-eb-debit').textContent = `-${summary.expenseByMethod.debit.toFixed(2)}`;

  document.getElementById('invested-year-tab').textContent = summary.investedThisYear.toFixed(2);

  state.yearlyPieChart = renderPieChart('yearly-pie-chart', state.yearlyPieChart, summary.byCategory);
  state.yearlyCategoryBarChart = renderCategoryBarChart('yearly-category-bar-chart', state.yearlyCategoryBarChart, summary.byCategory);

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
      loadSection(refreshBoxes, 'boxes');
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

document.getElementById('confirm-type').addEventListener('change', () => {
  updatePaymentMethodOptions();
  updateBucketOptions(undefined);
});

// Box picker in the confirm modal. The parser's pick is pre-selected and the
// hint asks the user to OK it or change it; income defaults to a % split.
function updateBucketOptions(selected) {
  const isExpense = document.getElementById('confirm-type').value === 'expense';
  const select = document.getElementById('confirm-bucket');
  const options = [];
  if (!isExpense) options.push({ value: 'split', label: 'Split by % across all boxes' });
  for (const b of state.boxes) {
    if (b.key !== 'buffer') options.push({ value: b.key, label: `${b.name} (${fmt(b.balance)})` });
  }
  options.push({ value: '', label: "Don't touch any box" });
  select.innerHTML = options.map((o) => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('');

  const fallback = isExpense ? 'guilt_free' : 'split';
  // undefined = no suggestion (use the default); null = parser said "no box".
  const wanted = selected === undefined ? fallback : (selected ?? '');
  select.value = options.some((o) => o.value === wanted) ? wanted : fallback;
  state.suggestedBucket = select.value;
  resetNewMonth();
}

// A salary starts a new month, so the tick is on by default for Salary; it can
// be unticked if a salary ever arrives in two parts.
function resetNewMonth() {
  document.getElementById('confirm-new-month').checked = categorySelect.value === 'Salary';
  updateBucketHint();
}

async function updateBucketHint() {
  const hint = document.getElementById('confirm-bucket-hint');
  const value = document.getElementById('confirm-bucket').value;
  const isExpense = document.getElementById('confirm-type').value === 'expense';
  const amount = Number(document.getElementById('confirm-amount').value) || 0;
  document.getElementById('confirm-new-month-row').hidden = isExpense || value !== 'split';

  if (!value) {
    hint.textContent = "This won't change any box.";
    return;
  }
  if (value === 'split') {
    if (!amount) {
      hint.textContent = 'Enter an amount to see how it will be split.';
      return;
    }
    const newMonth = document.getElementById('confirm-new-month').checked;
    const params = new URLSearchParams({ amount, category: categorySelect.value, new_month: newMonth ? '1' : '0' });
    try {
      const { closeMoves, shares } = await api(`/api/buckets/split-preview?${params}`);
      const splitText = Object.entries(shares)
        .map(([key, v]) => `${escapeHtml(boxName(key))} <strong>${fmt(v)}</strong>`)
        .join(' · ');
      const closeText = closeMoves.length
        ? closeMoves.map((m) => `${escapeHtml(boxName(m.from))} → ${escapeHtml(boxName(m.to))} <strong>${fmt(m.amount)}</strong>`).join(' · ')
        : 'nothing to move';
      hint.innerHTML = (newMonth ? `<div>Month-end first: ${closeText}</div>` : '')
        + `<div>${newMonth ? 'Then split' : 'Will be split'}: ${splitText}</div>`;
    } catch (err) {
      hint.textContent = `Couldn't preview the split: ${err.message}`;
    }
    return;
  }

  const box = state.boxes.find((b) => b.key === value);
  if (!box) return;
  const picked = value === state.suggestedBucket ? 'I picked' : 'You picked';
  if (!isExpense) {
    hint.innerHTML = `${picked} <strong>${escapeHtml(box.name)}</strong> to put this back into. OK? Change it above if not.`;
    return;
  }
  const after = box.balance - amount;
  hint.innerHTML = `${picked} <strong>${escapeHtml(box.name)}</strong> for this (has ${fmt(box.balance)}). OK? Change it above if it should come from another box.`
    + (amount && after < 0 ? ` <span class="bad">This takes it below zero (${fmt(after)}).</span>` : '');
}

document.getElementById('confirm-bucket').addEventListener('change', updateBucketHint);
document.getElementById('confirm-new-month').addEventListener('change', updateBucketHint);
document.getElementById('confirm-amount').addEventListener('change', updateBucketHint);

const categorySelect = document.getElementById('confirm-category');
categorySelect.innerHTML = CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('');
categorySelect.addEventListener('change', resetNewMonth);

function openConfirmModal(suggestion, raw_input) {
  state.pendingSuggestion = { ...suggestion, raw_input };
  document.getElementById('confirm-type').value = suggestion.type || 'expense';
  document.getElementById('confirm-amount').value = suggestion.amount ?? '';
  categorySelect.value = CATEGORIES.includes(suggestion.category) ? suggestion.category : 'Other';
  document.getElementById('confirm-classification').value = suggestion.classification || '';
  updatePaymentMethodOptions();
  document.getElementById('confirm-payment-method').value = suggestion.payment_method || (suggestion.type === 'expense' ? 'debit' : '');
  document.getElementById('confirm-date').value = suggestion.date || todayISO();
  document.getElementById('confirm-note').value = suggestion.note || '';
  updateBucketOptions(suggestion.bucket);
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
    bucket: document.getElementById('confirm-bucket').value || null,
    new_month: !document.getElementById('confirm-new-month-row').hidden
      && document.getElementById('confirm-new-month').checked,
  };

  if (!payload.amount || !payload.category || !payload.entry_date) {
    alert('Amount, category and date are required.');
    return;
  }

  try {
    const saved = await api('/api/entries', { method: 'POST', body: JSON.stringify(payload) });
    document.getElementById('confirm-modal').hidden = true;
    state.pendingSuggestion = null;
    if (saved?.bucket_warning) alert(`Saved, but the boxes weren't updated: ${saved.bucket_warning}`);

    refreshBalances();
    loadSection(refreshBoxes, 'boxes');
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
  loadSection(refreshBoxes, 'boxes');
  loadSection(refreshMonthly, 'monthly summary');
  loadSection(refreshLedger, 'ledger');
}

if (getToken()) {
  showApp();
} else {
  showLogin();
}
