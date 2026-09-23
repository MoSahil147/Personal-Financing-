# Budget Boxes — Design

## Goal

Turn the monthly budget plan (10,000 salary split 38/10/2/5/10/5/5/25) into
live "boxes" inside the tracker. Every incoming amount is split into the boxes
by percentage, every spend comes out of a box, and month-end leftovers flow
down the overflow chain automatically. Readable on phone and laptop.

## What the user asked for (verbatim intent)

- Separate boxes, one per category, like separate accounts.
- Any money received (salary included) is allocated by the plan's percentages.
- Current money (bank + cash together) is divided now: 3,800 goes straight to
  Rent first (rent can't be compromised), the rest is divided.
- No salary in September/October. The current money has to last until the end
  of October 2026. The October salary arrives in the first week of November.
- Spending auto-picks a box but asks before saving.
- Month-end leftovers move automatically.
- A pie chart of the boxes, like the existing monthly pie.

## Boxes

| Key | Name | % of income | Cap | Month-end behaviour |
|---|---|---|---|---|
| rent | Rent | 38 | — | Keeps its balance (never swept) |
| groceries | Groceries | 10 | — | Leftover/overspend swept (see chain) |
| transport | Transport | 2 | — | Leftover/overspend swept (see chain) |
| guilt_free | Guilt-free | 5 | 1,000 | Keeps up to 1,000; extra → Roaming |
| home_trips | Home trips | 10 | shared 10,000 | Travel total over cap → Emergency (Roaming trimmed first) |
| roaming | Roaming | 5 | shared 10,000 | as above |
| emergency | Emergency | 5 | 15,000 | Extra → Investing |
| investing | Investing | 25 | — | Keeps everything |
| buffer | Buffer | 0 | 300 | Only fed by grocery/transport leftovers |

Percentages and caps live in the `buckets` table, so they can be changed with
SQL without a code change.

## Money in

- **Salary and other income** (salary, gift, bonus, repayment): split by
  percentage. If Emergency is already at its 15,000 cap, its share goes to
  Investing. Rounding remainder goes to Investing so the split always sums
  exactly to the amount.
- **Refunds** (category `Refund`): go to one chosen box, defaulting to the box
  the parser suggests. They are not split.
- The confirm modal shows the split preview before saving.

## Starting allocation (one-time, from today 2026-09-24)

- Source: bank_balance + cash_balance − credit_outstanding. This is what the
  user actually has.
- 3,800 → Rent first. If the total is below 3,800, all of it goes to Rent.
- The remainder is split across the other seven boxes using their percentages
  scaled to 100% (weights 10/2/5/10/5/5/25 out of 62).
- Triggered by a "Set up my boxes" button, shown only while every box is empty.
  It shows a preview and applies on confirm. The amounts are never committed
  to git.

## Bridge period (Sep 24 → Oct 31, 2026)

- September and October are treated as one period funded by the starting
  allocation. There is no month-end close at the end of September.
- `settings.boxes_start_month` = `2026-10`. The first automatic close runs for
  October once November starts. Months before the start month are never
  closed.

## Money out

- The chat parser returns a `bucket` suggestion using the plan's rules:
  - Rent → rent
  - Groceries/household → groceries
  - city bus/errands → transport
  - food orders, dining and regular outings in Abu Dhabi → guilt_free
  - major ticketed outings in Abu Dhabi and anything outside Abu Dhabi → roaming
  - flights home, gifts for family and spending at home → home_trips
  - Investment → investing
- The confirm modal says "Taking this from **Guilt-free** — OK?" with a dropdown
  to change it. Nothing saves until confirmed.
- Credit card spends are deducted from the box at spend time. Settling the card
  does not touch the boxes again.
- The "Credit Card Payment" category and cash withdrawals don't touch the boxes.
  They are transfers.
- Boxes may go negative. A negative balance is shown in red.
- Deleting an entry reverses its box effect using the stored `entries.bucket`
  (and, for split income, the recorded moves).

## Month-end close (automatic)

Runs lazily: on any `/api/buckets` read, close every month from
`max(boxes_start_month, last_closed_month + 1)` up to the previous month,
in order. Idempotent via `settings.last_closed_month`.

A background timer isn't used because the Render backend sleeps when idle.

Order per month (plan section 12):
1. Net = groceries + transport balances. Both boxes are reset to 0.
   - If net > 0: fill the Buffer to 300, then Emergency up to 15,000, then
     Investing.
   - If net < 0: take it from the Buffer. Anything beyond the Buffer goes to
     Emergency.
2. Guilt-free above 1,000 → the extra goes to Roaming.
3. Home trips + Roaming above 10,000 → the extra goes to Emergency. It is taken
   from Roaming first, then Home trips.
4. Emergency above 15,000 → the extra goes to Investing.

Every movement is written to `bucket_moves` with reason `close:YYYY-MM`.

## Screen

- **"My Boxes" section** at the top of the dashboard: a 2-column grid on phone
  and 4 columns on laptop, with a Buffer strip below. Each card shows the name,
  the balance (red if negative) and a cap progress bar where a cap exists.
- **Totals line:** boxes total vs real money (bank + cash − credit). Shows an
  "Unallocated: X" chip when the two differ by more than 1.
- **Box pie chart:** uses the same Chart.js pie style and palette as the monthly
  chart, with a toggle between "Balances now" and "Spent this month by box".
  Negative balances are excluded from the pie.
- **Box history:** a collapsible list of recent moves (splits, spends, closes).

## Data

```sql
create table buckets (
  key text primary key,
  name text not null,
  balance numeric(12,2) not null default 0,
  percent numeric(5,2) not null default 0,
  cap numeric(12,2),            -- null = no cap; travel cap handled as shared
  sort smallint not null
);
create table bucket_moves (
  id uuid primary key default gen_random_uuid(),
  move_date date not null,
  from_bucket text references buckets(key),   -- null = money coming in
  to_bucket text references buckets(key),     -- null = money going out
  amount numeric(12,2) not null check (amount > 0),
  reason text not null,          -- 'income', 'spend', 'refund', 'setup', 'close:2026-10'
  entry_id uuid references entries(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table entries add column bucket text;
alter table settings add column last_closed_month text;          -- 'YYYY-MM'
alter table settings add column boxes_start_month text default '2026-10';
```

## Code units

- `backend/src/services/buckets.js`: `splitIncome`, `spend`, `refund`,
  `reverseEntry`, `setupFromCurrentMoney`, `closeMonth`, `closeDueMonths`.
  Pure calculation functions (e.g. `computeSplit`, `computeClose`) are
  separated from DB writes so they can be tested.
- `backend/src/routes/buckets.js`: `GET /api/buckets` (runs due closes first),
  `GET /api/buckets/moves`, `GET /api/buckets/setup-preview`,
  `POST /api/buckets/setup`.
- `entries.js` / `chat.js`: call the bucket service on create and delete.
- `groq.js`: adds a `bucket` field and the box rules to the prompt.
- Frontend: boxes grid, pie with toggle, confirm-modal box picker and split
  preview, setup button, and history list.

## Testing

Node's built-in `node:test` runs against the pure functions:
- Payday split of 10,000 gives exact plan amounts. When Emergency is full,
  Investing gets 3,000.
- Starting allocation: Rent 3,800 and the remainder split across the other
  seven boxes by 62 weights, with the parts summing to the total.
- Month close against plan examples A, C, E, F, G and H (H ends with Investing
  gaining 1,800 overflow and Emergency at 15,000).
- The bridge rule: no close for 2026-09, and the close for 2026-10 runs in
  November.
