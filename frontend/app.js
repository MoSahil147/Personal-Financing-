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

// Every expense category gets its own fixed color so no two share one in the
// pie/bar charts (hashing the name alone gave Investment, Groceries, Rent and
// Gifts the same gray). Anything not listed falls back to the hash below.
const CATEGORY_COLORS = {
  Rent: '#0072b2',                  // blue
  Groceries: '#009e73',             // teal green
  Dining: '#e69f00',                // orange
  Transport: '#6a3d9a',             // purple
  Shopping: '#cc79a7',              // pink
  Investment: '#f0e442',            // yellow
  Entertainment: '#d55e00',         // vermillion
  Travel: '#56b4e9',                // sky blue
  Health: '#b15928',                // brown
  Subscriptions: '#a6d854',         // lime
  Utilities: '#bc80bd',             // lavender
  Education: '#e7298a',             // magenta
  Fuel: '#d9b38c',                  // sand
  Gifts: '#fb8072',                 // salmon
  'Credit Card Payment': '#8b1a1a', // dark red
  Other: '#999999',                 // gray
};

function colorForLabel(label) {
  if (CATEGORY_COLORS[label]) return CATEGORY_COLORS[label];
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
  yearlyPieChart: null,
  categoryBarChart: null,
  yearlyCategoryBarChart: null,
  pendingSuggestion: null,
  boxes: [],
  boxSpent: {},
  boxPieMode: 'balances',
  boxPieChart: null,
  ccPieChart: null,
  openBox: null, // box whose activity is shown below the grid
  purses: [],
  openPurse: null, // card whose history is shown below the cards
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
  // The month picker only means something on the monthly tab.
  document.getElementById('month-select').hidden = view === 'yearly';
  if (view === 'yearly') loadSection(refreshYearly, 'yearly summary');
  loadSection(refreshLedger, 'ledger');
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
    loadSection(refreshCreditCard, 'credit card');
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
// on its card and in the pie (no hash collisions between the boxes).
function boxColor(key) {
  const i = state.boxes.findIndex((b) => b.key === key);
  return CHART_COLORS[Math.max(0, i) % CHART_COLORS.length];
}

function boxName(key) {
  return state.boxes.find((b) => b.key === key)?.name || key;
}

// Guilt-free's limit only caps what carries over at month-end (the new 500 is
// added on top), so it's labelled differently from the hard limits.
function capBar(key, filled, cap) {
  const pct = Math.max(0, Math.min(100, (filled / cap) * 100));
  const label = key === 'guilt_free' ? 'Carry-over limit' : 'Limit';
  return `<div class="box-cap-bar"><div style="width:${pct}%;background:${boxColor(key)}"></div></div>
    <div class="box-cap-label">${label} ${fmt(cap)}</div>`;
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
      <div class="box-spent">Spent this month: ${fmt(state.boxSpent[b.key] || 0)}</div>
      ${b.cap ? capBar(b.key, b.balance, Number(b.cap)) : ''}`;
    card.classList.toggle('open', state.openBox === b.key);
    card.addEventListener('click', () => toggleBoxDetail(b.key));
    grid.appendChild(card);
  }

  const buffer = state.boxes.find((b) => b.key === 'buffer');
  const bufferStrip = document.getElementById('buffer-strip');
  bufferStrip.classList.toggle('open', state.openBox === 'buffer');
  bufferStrip.onclick = buffer ? () => toggleBoxDetail('buffer') : null;
  bufferStrip.innerHTML = buffer
    ? `<div class="buffer-top">
         <span>Buffer <span class="box-percent">leftovers</span></span>
         <span class="buffer-value ${buffer.balance < 0 ? 'bad' : ''}">${fmt(buffer.balance)}</span>
       </div>
       <div class="box-cap-bar"><div style="width:${Math.max(0, Math.min(100, (buffer.balance / buffer.cap) * 100))}%;background:${boxColor('buffer')}"></div></div>
       <div class="buffer-meta">
         <span>Used this month: ${fmt(state.boxSpent.buffer || 0)}</span>
         <span>Limit ${fmt(buffer.cap)}</span>
       </div>`
    : '';

  renderBoxPie();
  await Promise.all([refreshBoxHistory(), renderBoxDetail()]);
}

// Clicking a box (or the buffer) opens its activity for this month below the
// grid; clicking the same one again closes it.
function toggleBoxDetail(key) {
  state.openBox = state.openBox === key ? null : key;
  document.querySelectorAll('#boxes-grid .box-card').forEach((card, i) => {
    const keys = state.boxes.filter((b) => b.key !== 'buffer').map((b) => b.key);
    card.classList.toggle('open', keys[i] === state.openBox);
  });
  document.getElementById('buffer-strip').classList.toggle('open', state.openBox === 'buffer');
  loadSection(renderBoxDetail, 'box activity');
}

async function renderBoxDetail() {
  const el = document.getElementById('box-detail');
  const key = state.openBox;
  el.hidden = !key;
  if (!key) return;
  el.style.borderColor = boxColor(key);
  el.innerHTML = `<div class="box-detail-head"><strong>${escapeHtml(boxName(key))}</strong><span class="ledger-meta">Loading…</span></div>`;

  const { since, moves } = await api(`/api/buckets/${encodeURIComponent(key)}/activity`);
  if (state.openBox !== key) return; // another box was opened while this loaded

  let spent = 0;
  let added = 0;
  const rows = moves.map((m) => {
    const out = m.from_bucket === key;
    if (out) spent += Number(m.amount); else added += Number(m.amount);
    const other = out ? m.to_bucket : m.from_bucket;
    // A spend/refund shows what it was for; a box-to-box move shows the other box.
    const title = m.entries?.category
      ? m.entries.category
      : other ? `${out ? 'To' : 'From'} ${boxName(other)}` : moveReasonLabel(m.reason);
    const meta = [m.move_date, moveReasonLabel(m.reason)];
    if (m.entries?.category && other) meta.push(`${out ? 'to' : 'from'} ${boxName(other)}`);
    if (m.entries?.payment_method === 'credit') meta.push('card');
    if (m.entries?.note) meta.push(m.entries.note);
    return `<li>
      <span><strong>${escapeHtml(title)}</strong><span class="ledger-meta">${escapeHtml(meta.join(' · '))}</span></span>
      <span class="${out ? 'bad' : 'good'}">${out ? '−' : '+'}${fmt(m.amount)}</span>
    </li>`;
  });

  el.innerHTML = `
    <div class="box-detail-head">
      <strong>${escapeHtml(boxName(key))}</strong>
      <span class="ledger-meta">${since ? `Since ${since.slice(0, 10)}` : 'All time'} · in ${fmt(added)} · out ${fmt(spent)}</span>
    </div>
    <ul class="box-detail-list">${rows.join('') || '<li><span class="ledger-meta">Nothing in or out of this box this month.</span></li>'}</ul>`;
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

  // Buffer usage isn't extra spending - it covers a grocery/lunch/transport
  // overspend already counted in those boxes - so it's left out here.
  const values = state.boxPieMode === 'spent'
    ? state.boxes.filter((b) => b.key !== 'buffer').map((b) => ({ b, v: state.boxSpent[b.key] || 0 }))
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
    setup: 'Starting split', income: 'Money in', salary: 'Salary', refund: 'Refund', spend: 'Spent', close: 'Month end (salary)',
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

// ---------- bus cards (prepaid purses) ----------

function purseName(id) {
  return state.purses.find((p) => p.id === id)?.name || 'card';
}

// The cards are optional (they need their own migration), so a failed load
// just hides the section instead of showing the connection banner.
async function refreshPurses() {
  const section = document.getElementById('purses-card');
  try {
    state.purses = (await api('/api/purses')).map((p) => ({ ...p, balance: Number(p.balance) }));
  } catch {
    state.purses = [];
    section.hidden = true;
    return;
  }
  section.hidden = !state.purses.length;
  document.getElementById('purses-total').textContent =
    `${fmt(state.purses.reduce((sum, p) => sum + p.balance, 0))} AED`;

  const grid = document.getElementById('purses-grid');
  grid.innerHTML = '';
  for (const p of state.purses) {
    const tile = document.createElement('div');
    tile.className = 'purse-tile';
    tile.classList.toggle('open', state.openPurse === p.id);
    tile.innerHTML = `
      <div class="purse-top">
        <span class="purse-name">${escapeHtml(p.name)}</span>
      </div>
      <div class="purse-balance">${fmt(p.balance)} <small>AED</small></div>
      <div class="purse-actions">
        <button type="button" class="primary" data-act="topup">Top up</button>
        <button type="button" data-act="ride">Fare / fix</button>
      </div>`;
    tile.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'topup') openTopUp(p);
      else if (act === 'ride') openCardModal(p.id, 'ride');
      else togglePurseDetail(p.id);
    });
    grid.appendChild(tile);
  }
  await renderPurseDetail();
}

// A top-up is a normal expense (bank/cash + Transport box) that also adds to the card.
function openTopUp(purse) {
  openConfirmModal({
    type: 'expense',
    amount: null,
    category: 'Transport',
    classification: 'need',
    payment_method: 'debit',
    bucket: 'transport',
    purse_id: purse.id,
    note: `Top up ${purse.name}`,
  }, null);
  document.getElementById('confirm-amount').focus();
}

function togglePurseDetail(id) {
  state.openPurse = state.openPurse === id ? null : id;
  document.querySelectorAll('#purses-grid .purse-tile').forEach((tile, i) => {
    tile.classList.toggle('open', state.purses[i]?.id === state.openPurse);
  });
  loadSection(renderPurseDetail, 'card history');
}

function purseReasonLabel(reason) {
  return { topup: 'Top up', ride: 'Fare', adjust: 'Balance fixed' }[reason] || reason;
}

async function renderPurseDetail() {
  const el = document.getElementById('purse-detail');
  const id = state.openPurse;
  el.hidden = !id || !state.purses.some((p) => p.id === id);
  if (el.hidden) return;
  el.innerHTML = `<div class="box-detail-head"><strong>${escapeHtml(purseName(id))}</strong><span class="ledger-meta">Loading…</span></div>`;

  const moves = await api(`/api/purses/${encodeURIComponent(id)}/moves`);
  if (state.openPurse !== id) return;
  const rows = moves.map((m) => {
    const amt = Number(m.amount);
    const meta = m.note ? `${m.move_date} · ${m.note}` : m.move_date;
    return `<li>
      <span><strong>${escapeHtml(purseReasonLabel(m.reason))}</strong><span class="ledger-meta">${escapeHtml(meta)}</span></span>
      <span class="${amt < 0 ? 'bad' : 'good'}">${amt < 0 ? '−' : '+'}${fmt(Math.abs(amt))}</span>
    </li>`;
  });
  el.innerHTML = `
    <div class="box-detail-head"><strong>${escapeHtml(purseName(id))}</strong><span class="ledger-meta">Last ${moves.length} moves</span></div>
    <ul class="box-detail-list">${rows.join('') || '<li><span class="ledger-meta">Nothing on this card yet.</span></li>'}</ul>`;
}

// Fare paid with a card, or the balance fixed to what the card reader shows.
function openCardModal(purseId, mode, { amount = null, note = '' } = {}) {
  const select = document.getElementById('card-modal-purse');
  select.innerHTML = state.purses.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (${fmt(p.balance)})</option>`).join('');
  if (purseId) select.value = purseId;
  document.getElementById('card-modal-mode').value = mode;
  document.getElementById('card-modal-amount').value = amount ?? '';
  document.getElementById('card-modal-note').value = note || '';
  updateCardModal();
  document.getElementById('card-modal').hidden = false;
}

function updateCardModal() {
  const purse = state.purses.find((p) => p.id === document.getElementById('card-modal-purse').value);
  const mode = document.getElementById('card-modal-mode').value;
  const amount = Number(document.getElementById('card-modal-amount').value) || 0;
  document.getElementById('card-modal-amount-label').textContent = mode === 'ride' ? 'Fare' : 'Balance the card shows';
  document.getElementById('card-modal-note-row').hidden = mode !== 'ride';
  const hint = document.getElementById('card-modal-hint');
  if (!purse) { hint.textContent = ''; return; }
  if (mode === 'ride') {
    const after = purse.balance - amount;
    hint.innerHTML = `Comes off the card only - your bank and boxes don't change (they paid at the top-up). Card: ${fmt(purse.balance)} → <strong>${fmt(after)}</strong>`
      + (after < 0 ? ' <span class="bad">That\'s more than the card has.</span>' : '');
  } else {
    hint.innerHTML = `Card: ${fmt(purse.balance)} → <strong>${fmt(amount)}</strong>. Use this if the card and the app don't match.`;
  }
}

['card-modal-purse', 'card-modal-mode'].forEach((id) => document.getElementById(id).addEventListener('change', updateCardModal));
document.getElementById('card-modal-amount').addEventListener('input', updateCardModal);
document.getElementById('card-modal-cancel').addEventListener('click', () => { document.getElementById('card-modal').hidden = true; });

document.getElementById('card-modal-save').addEventListener('click', async () => {
  const id = document.getElementById('card-modal-purse').value;
  const mode = document.getElementById('card-modal-mode').value;
  const raw = document.getElementById('card-modal-amount').value;
  const amount = Number(raw);
  if (raw === '' || !(mode === 'ride' ? amount > 0 : amount >= 0)) {
    alert(mode === 'ride' ? 'Enter the fare.' : 'Enter the balance the card shows.');
    return;
  }
  const btn = document.getElementById('card-modal-save');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    if (mode === 'ride') {
      const note = document.getElementById('card-modal-note').value.trim();
      await api(`/api/purses/${id}/ride`, { method: 'POST', body: JSON.stringify({ amount, note: note || null, date: todayISO() }) });
    } else {
      await api(`/api/purses/${id}`, { method: 'PATCH', body: JSON.stringify({ balance: amount }) });
    }
    document.getElementById('card-modal').hidden = true;
    loadSection(refreshPurses, 'bus cards');
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

// Card picker in the confirm modal: only for expenses, and only once cards exist.
function updatePurseOptions(selected) {
  const isExpense = document.getElementById('confirm-type').value === 'expense';
  const row = document.getElementById('confirm-purse-row');
  const select = document.getElementById('confirm-purse');
  row.hidden = !isExpense || !state.purses.length;
  select.innerHTML = '<option value="">No - not a card top-up</option>'
    + state.purses.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (${fmt(p.balance)})</option>`).join('');
  select.value = !row.hidden && state.purses.some((p) => p.id === selected) ? selected : '';
  updatePurseHint();
}

function updatePurseHint() {
  const hint = document.getElementById('confirm-purse-hint');
  const purse = state.purses.find((p) => p.id === document.getElementById('confirm-purse').value);
  const amount = Number(document.getElementById('confirm-amount').value) || 0;
  hint.innerHTML = purse
    ? `Adds ${fmt(amount)} to <strong>${escapeHtml(purse.name)}</strong>: ${fmt(purse.balance)} → <strong>${fmt(purse.balance + amount)}</strong>`
    : '';
}

document.getElementById('confirm-purse').addEventListener('change', () => {
  // A top-up comes out of the Transport box by default.
  if (document.getElementById('confirm-purse').value) {
    document.getElementById('confirm-bucket').value = 'transport';
    if (categorySelect.value === 'Other') categorySelect.value = 'Transport';
    updateBucketHint();
  }
  updatePurseHint();
});
document.getElementById('confirm-amount').addEventListener('input', updatePurseHint);

// ---------- credit card ----------

async function refreshCreditCard() {
  const [cc, settings] = await Promise.all([api('/api/settings/credit-card'), api('/api/settings')]);
  const limit = Number(settings.credit_card_limit) || 0;
  document.getElementById('cc-owed').textContent = `${fmt(cc.owed)} AED`;
  document.getElementById('cc-card').classList.toggle('over-limit', limit > 0 && cc.owed >= limit);
  document.getElementById('cc-empty').hidden = cc.owed > 0;
  document.getElementById('cc-details').hidden = !cc.entries.length;
  document.getElementById('cc-pie-box').hidden = !cc.byCategory.length;
  state.ccPieChart = renderPieChart('cc-pie-chart', state.ccPieChart, cc.byCategory);

  document.getElementById('cc-by-category').innerHTML = cc.byCategory.map((c) => `
    <div class="cc-row">
      <span class="cc-dot" style="background:${colorForLabel(c.category)}"></span>
      <span class="cc-cat">${escapeHtml(c.category)}</span>
      <span>${fmt(c.total)}</span>
    </div>`).join('');

  document.getElementById('cc-list').innerHTML = cc.entries.map((e) => `
    <li>
      <span><strong>${escapeHtml(e.category)}</strong>
        <span class="ledger-meta">${e.entry_date}${e.bucket ? ' · ' + escapeHtml(boxName(e.bucket)) + ' box' : ''}${e.note ? ' · ' + escapeHtml(e.note) : ''}</span></span>
      <span>${fmt(e.amount)}</span>
    </li>`).join('');
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
}

// ---------- ledger ----------

// The ledger follows the tab: the chosen month on Monthly, the whole chosen
// year on Yearly.
async function refreshLedger() {
  const yearly = state.view === 'yearly';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  document.getElementById('ledger-period').textContent = yearly
    ? `· ${state.year}`
    : `· ${months[state.month - 1]} ${state.year}`;
  const entries = await api(yearly
    ? `/api/entries?year=${state.year}`
    : `/api/entries?year=${state.year}&month=${state.month}`);
  const list = document.getElementById('ledger-list');
  list.innerHTML = '';
  for (const e of entries) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span>
        <strong>${escapeHtml(e.category)}</strong>
        <span class="ledger-meta">${e.entry_date}${e.classification ? ' · ' + e.classification : ''}${e.payment_method ? ' · ' + e.payment_method : ''}${e.purse_id ? ' · bus card top-up' : ''}</span>
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
      loadSection(refreshCreditCard, 'credit card');
      loadSection(refreshPurses, 'bus cards');
      if (state.view === 'yearly') loadSection(refreshYearly, 'yearly summary');
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
    } else if (result.intent === 'card_ride') {
      openCardModal(result.purse_id, 'ride', { amount: result.amount });
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
  updatePurseOptions(document.getElementById('confirm-purse').value);
});

// Box picker in the confirm modal. The parser's pick is pre-selected and the
// hint asks the user to OK it or change it; income defaults to a % split.
function updateBucketOptions(selected) {
  const isExpense = document.getElementById('confirm-type').value === 'expense';
  const select = document.getElementById('confirm-bucket');
  const options = [];
  if (!isExpense) options.push({ value: 'split', label: 'All boxes (split by %)' });
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
  // Any income can start a new month (normally the salary), split or into one box.
  document.getElementById('confirm-new-month-row').hidden = isExpense || !value;

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
    const intoBox = `All of it goes into <strong>${escapeHtml(box.name)}</strong> (has ${fmt(box.balance)}). Pick "All boxes" above to split it instead.`;
    if (!document.getElementById('confirm-new-month').checked || !amount) {
      hint.innerHTML = intoBox;
      return;
    }
    try {
      const params = new URLSearchParams({ amount, category: categorySelect.value, new_month: '1' });
      const { closeMoves } = await api(`/api/buckets/split-preview?${params}`);
      const closeText = closeMoves.length
        ? closeMoves.map((m) => `${escapeHtml(boxName(m.from))} → ${escapeHtml(boxName(m.to))} <strong>${fmt(m.amount)}</strong>`).join(' · ')
        : 'nothing to move';
      hint.innerHTML = `<div>Month-end first: ${closeText}</div><div>Then: ${intoBox}</div>`;
    } catch (err) {
      hint.textContent = `Couldn't preview the month-end: ${err.message}`;
    }
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
  updatePurseOptions(suggestion.purse_id || '');
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
    purse_id: (!document.getElementById('confirm-purse-row').hidden && document.getElementById('confirm-purse').value) || null,
  };

  if (!payload.amount || !payload.category || !payload.entry_date) {
    alert('Amount, category and date are required.');
    return;
  }

  // Block a double tap from saving the same entry (e.g. a salary) twice.
  const saveBtn = document.getElementById('confirm-save');
  if (saveBtn.disabled) return;
  saveBtn.disabled = true;
  try {
    const saved = await api('/api/entries', { method: 'POST', body: JSON.stringify(payload) });
    document.getElementById('confirm-modal').hidden = true;
    state.pendingSuggestion = null;
    if (saved?.bucket_warning) alert(`Saved, but the boxes weren't updated: ${saved.bucket_warning}`);

    refreshBalances();
    loadSection(refreshBoxes, 'boxes');
    loadSection(refreshCreditCard, 'credit card');
    if (payload.purse_id) loadSection(refreshPurses, 'bus cards');
    const entryMonth = Number(payload.entry_date.slice(5, 7));
    const entryYear = Number(payload.entry_date.slice(0, 4));
    if (entryMonth === state.month && entryYear === state.year) refreshMonthly();
    if (entryYear === state.year && (state.view === 'yearly' || entryMonth === state.month)) refreshLedger();
    if (entryYear === state.year && state.view === 'yearly') loadSection(refreshYearly, 'yearly summary');
  } catch (err) {
    alert(err.message);
  } finally {
    saveBtn.disabled = false;
  }
});

// ---------- excel export ----------

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const EXCELJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
// Pinned hash: the browser refuses the file if the CDN ever serves something else.
const EXCELJS_SRI = 'sha384-Pqp51FUN2/qzfxZxBCtF0stpc9ONI6MYZpVqmo8m20SoaQCzf+arZvACkLkirlPz';

// ExcelJS is big, so it's only loaded the first time a sheet is made.
let excelJsLoading = null;
function loadExcelJs() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  excelJsLoading ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = EXCELJS_URL;
    script.integrity = EXCELJS_SRI;
    script.crossOrigin = 'anonymous';
    script.onload = () => resolve(window.ExcelJS);
    script.onerror = () => { excelJsLoading = null; reject(new Error("Couldn't load the Excel library - check your connection.")); };
    document.head.appendChild(script);
  });
  return excelJsLoading;
}

function openExportModal() {
  const monthSel = document.getElementById('export-month');
  const yearSel = document.getElementById('export-year');
  const now = new Date();
  monthSel.innerHTML = MONTH_NAMES.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');
  const years = [];
  for (let y = 2026; y <= now.getFullYear() + 1; y++) years.push(y);
  yearSel.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');
  // Starts on the month being viewed (the current month unless you changed it).
  monthSel.value = state.month;
  yearSel.value = years.includes(state.year) ? state.year : now.getFullYear();
  updateExportHint();
  document.getElementById('export-modal').hidden = false;
}

function updateExportHint() {
  const year = Number(document.getElementById('export-year').value);
  const month = Number(document.getElementById('export-month').value);
  const cycle = document.getElementById('export-cycle').value;
  const name = MONTH_NAMES[month - 1];
  const now = new Date();
  const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;
  const isFuture = year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1);
  document.getElementById('export-month-label').textContent = cycle === 'salary' ? 'Month the salary came in' : 'Which month?';
  document.getElementById('export-hint').innerHTML = cycle === 'salary'
    ? `From the salary you logged in ${name} ${year} up to the day before the next salary - or up to today if it hasn't come yet.`
    : isCurrent ? `${name} isn't over yet - the sheet will have everything so far (1–${now.getDate()} ${name.slice(0, 3)}).`
      : isFuture ? `${name} ${year} hasn't started yet, so the sheet will be empty.`
        : `The whole of ${name} ${year}, 1st to the last day.`;
}

document.getElementById('export-btn').addEventListener('click', openExportModal);
['export-month', 'export-year', 'export-cycle'].forEach((id) => document.getElementById(id).addEventListener('change', updateExportHint));
document.getElementById('export-cancel').addEventListener('click', () => { document.getElementById('export-modal').hidden = true; });

document.getElementById('export-go').addEventListener('click', async () => {
  const btn = document.getElementById('export-go');
  if (btn.disabled) return;
  const year = Number(document.getElementById('export-year').value);
  const month = Number(document.getElementById('export-month').value);
  const cycle = document.getElementById('export-cycle').value;
  btn.disabled = true;
  btn.textContent = 'Making your sheet…';
  try {
    const params = new URLSearchParams({ year, month, cycle });
    const [ExcelJS, data] = await Promise.all([loadExcelJs(), api(`/api/summary/export?${params}`)]);
    const workbook = buildMonthWorkbook(ExcelJS, data);
    const buffer = await workbook.xlsx.writeBuffer();
    const label = cycle === 'salary' ? `Salary-month-${data.from}` : `${year}-${String(month).padStart(2, '0')}-${MONTH_NAMES[month - 1]}`;
    downloadFile(
      new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      `Finance-${label}${data.inProgress ? '-so-far' : ''}.xlsx`,
    );
    document.getElementById('export-modal').hidden = true;
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download';
  }
});

function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const XL = {
  navy: 'FF1F3A5F', white: 'FFFFFFFF', zebra: 'FFF4F6FA', band: 'FFE8EEF7',
  green: 'FF1E7B45', red: 'FFB3261E', muted: 'FF6B7280', line: 'FFD9DEE7',
};
const XL_MONEY = '#,##0.00;[Red]-#,##0.00';
const XL_PCT = '0.0%';
const XL_DATE = 'ddd dd mmm yyyy';

function paidWithLabel(e) {
  if (e.payment_method === 'cash') return 'Cash';
  if (e.type === 'income') return 'Bank';
  if (e.payment_method === 'credit') return 'Credit card';
  return 'Bank (debit)';
}

// What a line was for, like a bank statement's description: your note first,
// then what you typed in the chat, then just the category.
function describeEntry(e) {
  if (e.category === 'Credit Card Payment' && !e.note) return 'Credit card bill payment';
  return (e.note || e.raw_input || e.category || '').trim();
}

// Excel dates are stored without a timezone; building them in UTC keeps
// "2026-10-17" from turning into the 16th.
function xlDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function niceDate(iso) {
  return xlDate(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function datesBetween(from, to) {
  const out = [];
  for (let d = xlDate(from); d <= xlDate(to); d = new Date(d.getTime() + 86400000)) out.push(d.toISOString().slice(0, 10));
  return out;
}

function xlFill(cell, argb) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function xlHeader(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: XL.white } };
    xlFill(cell, XL.navy);
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  row.height = 20;
}

function xlZebra(row, index) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    if (index % 2) xlFill(cell, XL.zebra);
    cell.border = { bottom: { style: 'thin', color: { argb: XL.line } } };
  });
}

function xlTotal(row) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { ...(cell.font || {}), bold: true };
    cell.border = { top: { style: 'thin' }, bottom: { style: 'double' } };
  });
}

function xlTitle(ws, title, subtitle, lastCol) {
  ws.mergeCells(1, 1, 1, lastCol);
  ws.getCell(1, 1).value = title;
  ws.getCell(1, 1).font = { bold: true, size: 16, color: { argb: XL.navy } };
  ws.mergeCells(2, 1, 2, lastCol);
  ws.getCell(2, 1).value = subtitle;
  ws.getCell(2, 1).font = { italic: true, color: { argb: XL.muted } };
}

function colLetter(c) {
  let s = '';
  for (let n = c; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// A titled block of rows on the Summary sheet; returns the next free row.
// `rows` are arrays of [label, value, ...]; `formats` gives each column's numFmt.
function xlSection(ws, at, title, headers, rows, formats = [], { total } = {}) {
  ws.getCell(at, 1).value = title;
  ws.getCell(at, 1).font = { bold: true, size: 12, color: { argb: XL.navy } };
  at += 1;
  headers.forEach((h, i) => { ws.getCell(at, i + 1).value = h; });
  xlHeader(ws.getRow(at));
  const first = at + 1;
  rows.forEach((r, i) => {
    const row = ws.getRow(first + i);
    r.forEach((v, c) => {
      const cell = row.getCell(c + 1);
      cell.value = v;
      if (formats[c]) cell.numFmt = formats[c];
    });
    xlZebra(row, i);
  });
  let next = first + rows.length;
  if (!rows.length) {
    ws.getCell(next, 1).value = 'Nothing yet';
    ws.getCell(next, 1).font = { italic: true, color: { argb: XL.muted } };
    next += 1;
  } else if (total) {
    const row = ws.getRow(next);
    row.getCell(1).value = 'Total';
    for (const c of total) {
      const col = colLetter(c);
      const result = rows.reduce((s, r) => s + (Number(r[c - 1]) || 0), 0);
      row.getCell(c).value = { formula: `SUM(${col}${first}:${col}${next - 1})`, result };
      row.getCell(c).numFmt = formats[c - 1] || XL_MONEY;
    }
    xlTotal(row);
    next += 1;
  }
  return next + 1;
}

function buildMonthWorkbook(ExcelJS, data) {
  const { year, month, cycle, from, to, inProgress, entries, boxMoves, buckets, settings, purses, purseMoves } = data;
  const periodName = cycle === 'salary'
    ? `Salary month ${niceDate(from)} – ${niceDate(to)}`
    : `${MONTH_NAMES[month - 1]} ${year}`;
  const periodNote = `${niceDate(from)} to ${niceDate(to)}${inProgress ? ' · still in progress (everything so far)' : ''} · made ${new Date().toLocaleString('en-GB')}`;
  const days = datesBetween(from, to);
  const boxNames = Object.fromEntries(buckets.map((b) => [b.key, b.name]));
  const cardNames = Object.fromEntries(purses.map((p) => [p.id, p.name]));
  const entryById = Object.fromEntries(entries.map((e) => [e.id, e]));
  const boxLabel = (e) => (e.bucket === 'split' ? 'All boxes (split)' : e.bucket ? boxNames[e.bucket] || e.bucket : '');
  const amt = (e) => Number(e.amount);
  const sum = (list, f = amt) => list.reduce((s, x) => s + f(x), 0);

  const incomes = entries.filter((e) => e.type === 'income');
  const expenses = entries.filter((e) => e.type === 'expense');
  // Paying the card bill isn't new spending - the purchases were already counted.
  const isCardBill = (e) => e.category === 'Credit Card Payment';
  const spending = expenses.filter((e) => !isCardBill(e));
  const moneyIn = sum(incomes);
  const moneyOut = sum(spending);
  const cardBillPaid = sum(expenses.filter(isCardBill));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Personal Finance Tracker';
  wb.created = new Date();
  wb.calcProperties.fullCalcOnLoad = true;

  // ----- Summary -----
  const ws = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 36 }, { width: 16 }, { width: 12 }, { width: 10 }];
  xlTitle(ws, `Money report - ${periodName}`, periodNote, 4);

  let at = 4;
  const glance = at + 2; // first data row of the block below
  at = xlSection(ws, at, 'At a glance', ['', 'AED'], [
    ['Money in', moneyIn],
    ['Money out (spending)', moneyOut],
    ['Saved (in − out)', moneyIn - moneyOut],
    ['Savings rate', moneyIn > 0 ? (moneyIn - moneyOut) / moneyIn : 0],
    [`Average spent per day (${days.length} days)`, moneyOut / Math.max(1, days.length)],
    ['Biggest single spend', spending.length ? Math.max(...spending.map(amt)) : 0],
    ['Credit card bill paid', cardBillPaid],
    ['Number of entries', entries.length],
  ], [null, XL_MONEY]);
  ws.getCell(glance + 2, 2).font = { bold: true, color: { argb: moneyIn - moneyOut >= 0 ? XL.green : XL.red } };
  ws.getCell(glance + 3, 2).numFmt = XL_PCT;
  ws.getCell(glance + 7, 2).numFmt = '0';
  const biggest = spending.reduce((b, e) => (!b || amt(e) > amt(b) ? e : b), null);
  if (biggest) {
    ws.getCell(glance + 5, 3).value = describeEntry(biggest);
    ws.getCell(glance + 5, 3).font = { color: { argb: XL.muted } };
  }

  const byCat = {};
  for (const e of spending) {
    byCat[e.category] ||= { count: 0, total: 0 };
    byCat[e.category].count += 1;
    byCat[e.category].total += amt(e);
  }
  const catOrder = Object.entries(byCat).sort((a, b) => b[1].total - a[1].total);
  at = xlSection(ws, at, 'Where the money went (by category)', ['Category', 'Spent', 'Share', 'Times'],
    catOrder.map(([c, v]) => [c, v.total, moneyOut ? v.total / moneyOut : 0, v.count]),
    [null, XL_MONEY, XL_PCT, '0'], { total: [2, 3, 4] });

  const byBox = {};
  for (const e of spending) if (e.bucket) byBox[e.bucket] = (byBox[e.bucket] || 0) + amt(e);
  at = xlSection(ws, at, 'Spent from each box', ['Box', 'Spent', 'Share'],
    Object.entries(byBox).sort((a, b) => b[1] - a[1]).map(([k, v]) => [boxNames[k] || k, v, moneyOut ? v / moneyOut : 0]),
    [null, XL_MONEY, XL_PCT], { total: [2] });

  const classes = { need: 'Needs', want: 'Wants', luxury: 'Luxury', investment: 'Investing' };
  const byClass = {};
  for (const e of spending) {
    const label = classes[e.classification] || 'Not tagged';
    byClass[label] = (byClass[label] || 0) + amt(e);
  }
  at = xlSection(ws, at, 'Needs vs wants', ['Type', 'Spent', 'Share'],
    Object.entries(byClass).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v, moneyOut ? v / moneyOut : 0]),
    [null, XL_MONEY, XL_PCT]);

  const byMethod = {};
  for (const e of spending) byMethod[paidWithLabel(e)] = (byMethod[paidWithLabel(e)] || 0) + amt(e);
  at = xlSection(ws, at, 'How you paid', ['Paid with', 'Spent', 'Share'],
    Object.entries(byMethod).map(([k, v]) => [k, v, moneyOut ? v / moneyOut : 0]), [null, XL_MONEY, XL_PCT]);

  const bySource = {};
  for (const e of incomes) bySource[e.category] = (bySource[e.category] || 0) + amt(e);
  at = xlSection(ws, at, 'Money in (by source)', ['Source', 'Received'],
    Object.entries(bySource).sort((a, b) => b[1] - a[1]), [null, XL_MONEY], { total: [2] });

  const boxesTotal = sum(buckets, (b) => Number(b.balance));
  at = xlSection(ws, at, 'Balances right now', ['', 'AED'], [
    ['Bank', Number(settings.bank_balance)],
    ['Cash on hand', Number(settings.cash_balance)],
    ['Owed on credit card', Number(settings.credit_outstanding)],
    ['In all boxes', boxesTotal],
    ...(purses.length ? [['On bus cards', sum(purses, (p) => Number(p.balance))]] : []),
  ], [null, XL_MONEY]);
  ws.getCell(at, 1).value = 'Other sheets: Statement (every line, like a bank statement) · Spent On (each category with its items) · Daily · Boxes' + (purses.length ? ' · Bus Cards' : '');
  ws.getCell(at, 1).font = { italic: true, color: { argb: XL.muted } };
  ws.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  // ----- Statement: every line in date order, like a bank statement -----
  const st = wb.addWorksheet('Statement', { views: [{ state: 'frozen', ySplit: 4 }] });
  const stCols = [
    ['Date', 16], ['Description (your note)', 42], ['Money in', 12], ['Money out', 12], ['Net so far', 13],
    ['Category', 17], ['Box', 22], ['Paid with', 13], ['Need / want', 11], ['Bus card', 15], ['What you typed', 40],
  ];
  st.columns = stCols.map(([, width]) => ({ width }));
  xlTitle(st, `Statement - ${periodName}`, periodNote, stCols.length);
  stCols.forEach(([h], i) => { st.getCell(4, i + 1).value = h; });
  xlHeader(st.getRow(4));
  let net = 0;
  entries.forEach((e, i) => {
    const r = 5 + i;
    const isIn = e.type === 'income';
    net += isIn ? amt(e) : -amt(e);
    const row = st.getRow(r);
    row.values = [
      xlDate(e.entry_date),
      describeEntry(e),
      isIn ? amt(e) : null,
      isIn ? null : amt(e),
      { formula: i === 0 ? `C${r}-D${r}` : `E${r - 1}+C${r}-D${r}`, result: net },
      isCardBill(e) ? 'Card bill' : e.category,
      boxLabel(e),
      paidWithLabel(e),
      e.classification || '',
      e.purse_id ? `Top up ${cardNames[e.purse_id] || ''}`.trim() : '',
      e.raw_input || '',
    ];
    row.getCell(1).numFmt = XL_DATE;
    [3, 4, 5].forEach((c) => { row.getCell(c).numFmt = XL_MONEY; });
    row.getCell(2).font = { bold: true };
    row.getCell(3).font = { color: { argb: XL.green } };
    row.getCell(4).font = { color: { argb: XL.red } };
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(11).alignment = { wrapText: true, vertical: 'top' };
    xlZebra(row, i);
  });
  const stLast = 4 + entries.length;
  const stTotal = st.getRow(stLast + 1);
  stTotal.values = ['Total', `${entries.length} entries`,
    { formula: `SUM(C5:C${Math.max(5, stLast)})`, result: moneyIn },
    { formula: `SUM(D5:D${Math.max(5, stLast)})`, result: sum(expenses) },
    { formula: `C${stLast + 1}-D${stLast + 1}`, result: moneyIn - sum(expenses) }];
  [3, 4, 5].forEach((c) => { stTotal.getCell(c).numFmt = XL_MONEY; });
  xlTotal(stTotal);
  if (cardBillPaid) {
    st.getCell(stLast + 2, 1).value = `Money out includes ${fmt(cardBillPaid)} paid off the credit card bill - those purchases are already listed, so real spending is ${fmt(moneyOut)}.`;
    st.getCell(stLast + 2, 1).font = { italic: true, color: { argb: XL.muted } };
  }
  if (entries.length) st.autoFilter = { from: { row: 4, column: 1 }, to: { row: stLast, column: stCols.length } };
  st.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '4:4' };

  // ----- Spent On: each category with every item under it -----
  const so = wb.addWorksheet('Spent On', { views: [{ showGridLines: false }] });
  so.columns = [{ width: 16 }, { width: 44 }, { width: 14 }, { width: 22 }, { width: 13 }];
  xlTitle(so, `What the money was spent on - ${periodName}`, periodNote, 5);
  let sr = 4;
  const group = (title, items, total, share) => {
    const band = so.getRow(sr);
    band.values = [title, `${items.length} item${items.length === 1 ? '' : 's'}${share != null ? ` · ${(share * 100).toFixed(1)}% of spending` : ''}`, '', '', total];
    band.eachCell({ includeEmpty: true }, (c) => { xlFill(c, XL.band); c.font = { bold: true, color: { argb: XL.navy } }; });
    band.getCell(5).numFmt = XL_MONEY;
    sr += 1;
    ['Date', 'Description (your note)', 'Paid with', 'Box', 'Amount'].forEach((h, i) => { so.getCell(sr, i + 1).value = h; });
    xlHeader(so.getRow(sr));
    sr += 1;
    const first = sr;
    [...items].sort((a, b) => a.entry_date.localeCompare(b.entry_date)).forEach((e, i) => {
      const row = so.getRow(sr);
      row.values = [xlDate(e.entry_date), describeEntry(e), paidWithLabel(e), boxLabel(e), amt(e)];
      row.getCell(1).numFmt = XL_DATE;
      row.getCell(5).numFmt = XL_MONEY;
      row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
      xlZebra(row, i);
      sr += 1;
    });
    const sub = so.getRow(sr);
    sub.values = ['', `Total ${title}`, '', '', { formula: `SUM(E${first}:E${sr - 1})`, result: total }];
    sub.getCell(5).numFmt = XL_MONEY;
    xlTotal(sub);
    sr += 2;
  };
  for (const [cat, v] of catOrder) group(cat, spending.filter((e) => e.category === cat), v.total, moneyOut ? v.total / moneyOut : 0);
  if (incomes.length) {
    so.getCell(sr, 1).value = 'Money received';
    so.getCell(sr, 1).font = { bold: true, size: 13, color: { argb: XL.green } };
    sr += 1;
    for (const [src, total] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) group(src, incomes.filter((e) => e.category === src), total, null);
  }
  if (!entries.length) {
    so.getCell(sr, 1).value = 'Nothing logged in this period yet.';
    so.getCell(sr, 1).font = { italic: true, color: { argb: XL.muted } };
  }
  so.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  // ----- Daily -----
  const daily = wb.addWorksheet('Daily', { views: [{ state: 'frozen', ySplit: 1 }] });
  daily.columns = [
    { header: 'Date', width: 16 }, { header: 'Money in', width: 12 }, { header: 'Money out', width: 12 },
    { header: 'Spent so far', width: 13 }, { header: 'Entries', width: 9 }, { header: 'What on', width: 60 },
  ];
  xlHeader(daily.getRow(1));
  let running = 0;
  days.forEach((iso, i) => {
    const r = i + 2;
    const dayEntries = entries.filter((e) => e.entry_date === iso);
    const daySpend = dayEntries.filter((e) => e.type === 'expense' && !isCardBill(e));
    running += sum(daySpend);
    const row = daily.addRow([
      xlDate(iso),
      sum(dayEntries.filter((e) => e.type === 'income')) || null,
      sum(daySpend) || null,
      { formula: i === 0 ? `N(C${r})` : `D${r - 1}+N(C${r})`, result: running },
      dayEntries.length || null,
      dayEntries.map((e) => `${e.type === 'income' ? '+' : ''}${describeEntry(e)} ${fmt(e.amount)}`).join(' · '),
    ]);
    row.getCell(1).numFmt = XL_DATE;
    [2, 3, 4].forEach((c) => { row.getCell(c).numFmt = XL_MONEY; });
    row.getCell(2).font = { color: { argb: XL.green } };
    row.getCell(3).font = { color: { argb: XL.red } };
    row.getCell(6).alignment = { wrapText: true, vertical: 'top' };
    xlZebra(row, i);
  });

  // ----- Boxes -----
  const bx = wb.addWorksheet('Boxes', { views: [{ state: 'frozen', ySplit: 1 }] });
  bx.columns = [
    { header: 'Box', width: 30 }, { header: 'Balance now', width: 14 }, { header: 'Came in', width: 13 },
    { header: 'Went out', width: 13 }, { header: 'Of which spent', width: 14 }, { header: 'Limit', width: 12 },
  ];
  xlHeader(bx.getRow(1));
  buckets.forEach((b, i) => {
    const inMoves = boxMoves.filter((m) => m.to_bucket === b.key);
    const outMoves = boxMoves.filter((m) => m.from_bucket === b.key);
    const row = bx.addRow([
      b.name, Number(b.balance), sum(inMoves), sum(outMoves),
      sum(outMoves.filter((m) => m.reason === 'spend')), b.cap == null ? null : Number(b.cap),
    ]);
    [2, 3, 4, 5, 6].forEach((c) => { row.getCell(c).numFmt = XL_MONEY; });
    xlZebra(row, i);
  });
  const bxTotal = bx.addRow(['Total', { formula: `SUM(B2:B${buckets.length + 1})`, result: boxesTotal }]);
  bxTotal.getCell(2).numFmt = XL_MONEY;
  xlTotal(bxTotal);

  let bRow = buckets.length + 4;
  bx.getCell(bRow, 1).value = 'Every box move in this period';
  bx.getCell(bRow, 1).font = { bold: true, size: 12, color: { argb: XL.navy } };
  bRow += 1;
  ['Date', 'Out of', 'Into', 'Amount', 'Why', 'For'].forEach((h, i) => { bx.getCell(bRow, i + 1).value = h; });
  xlHeader(bx.getRow(bRow));
  bx.getColumn(7).width = 10;
  boxMoves.forEach((m, i) => {
    const e = m.entry_id ? entryById[m.entry_id] : null;
    const row = bx.getRow(bRow + 1 + i);
    row.values = [
      xlDate(m.move_date),
      m.from_bucket ? boxNames[m.from_bucket] || m.from_bucket : '(money in)',
      m.to_bucket ? boxNames[m.to_bucket] || m.to_bucket : '(spent)',
      Number(m.amount),
      moveReasonLabel(m.reason),
      e ? describeEntry(e) : '',
    ];
    row.getCell(1).numFmt = XL_DATE;
    row.getCell(4).numFmt = XL_MONEY;
    xlZebra(row, i);
  });

  // ----- Bus cards -----
  if (purses.length) {
    const pc = wb.addWorksheet('Bus Cards');
    pc.columns = [{ width: 18 }, { width: 18 }, { width: 14 }, { width: 14 }, { width: 30 }];
    ['Card', 'Balance now', 'Topped up', 'Fares'].forEach((h, i) => { pc.getCell(1, i + 1).value = h; });
    xlHeader(pc.getRow(1));
    purses.forEach((p, i) => {
      const moves = purseMoves.filter((m) => m.purse_id === p.id);
      const row = pc.addRow([
        p.name, Number(p.balance),
        sum(moves.filter((m) => m.reason === 'topup')),
        -sum(moves.filter((m) => m.reason === 'ride')),
      ]);
      [2, 3, 4].forEach((c) => { row.getCell(c).numFmt = XL_MONEY; });
      xlZebra(row, i);
    });
    const pRow = purses.length + 3;
    ['Date', 'Card', 'What', 'Amount', 'Note'].forEach((h, i) => { pc.getCell(pRow, i + 1).value = h; });
    xlHeader(pc.getRow(pRow));
    purseMoves.forEach((m, i) => {
      const row = pc.getRow(pRow + 1 + i);
      row.values = [xlDate(m.move_date), cardNames[m.purse_id] || '', purseReasonLabel(m.reason), Number(m.amount), m.note || ''];
      row.getCell(1).numFmt = XL_DATE;
      row.getCell(4).numFmt = XL_MONEY;
      row.getCell(4).font = { color: { argb: Number(m.amount) < 0 ? XL.red : XL.green } };
      xlZebra(row, i);
    });
  }

  return wb;
}

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
  loadSection(refreshCreditCard, 'credit card');
  loadSection(refreshPurses, 'bus cards');
  loadSection(refreshMonthly, 'monthly summary');
  loadSection(refreshLedger, 'ledger');
}

if (getToken()) {
  showApp();
} else {
  showLogin();
}
