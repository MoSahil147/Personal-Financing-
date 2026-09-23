# Budget Boxes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the 8 budget boxes and the 300 Buffer to the tracker. Incoming money is split by %, spends come out of a picked box, and month-end overflow runs automatically starting with the October 2026 close.

**Architecture:** Pure calculation module (`bucketMath.js`, no DB) holds every plan rule and is unit-tested. A thin DB service (`buckets.js`) applies the results to a `buckets` table and records each move in `bucket_moves`. Entry save/delete and the chat parser call that service. The frontend adds a boxes card, a box pie chart, box history, and a box picker in the confirm modal.

**Tech Stack:** Node 20 + Express, Supabase (Postgres), `node:test`, vanilla JS + Chart.js 4 on the frontend.

**Spec:** `docs/superpowers/specs/2026-09-24-budget-boxes-design.md`

## Global Constraints

- Box keys: `rent, groceries, transport, guilt_free, home_trips, roaming, emergency, investing, buffer`.
- Percentages: 38/10/2/5/10/5/5/25/0. Caps: buffer 300, guilt_free 1000, travel (home_trips + roaming shared) 10000, emergency 15000.
- Starting allocation: 3,800 to Rent first. The rest is split by the other boxes' percentages over a weight of 62.
- `boxes_start_month = '2026-10'`. September is never closed, and October is closed in November.
- No real balances are ever committed to git.
- Existing bank/cash/credit balance behaviour is unchanged.

## Review Focus

- Deleting an income entry that was split must reverse every part of the split. It is pinned by a ledger-based reversal (moves are read before the entry is deleted).
- Two tabs opening the app on the 1st must not close the month twice. It is pinned by a conditional claim on `last_closed_month`.
- A split with rounding (e.g. 333.33) must still add up exactly. It is pinned by a test.
- Groceries overspent beyond the buffer is covered from Emergency, never from Investing. It is pinned by a test.
- Multiple missed months close in order. It is pinned by a `monthsToClose` test.

---

### Task 1: `bucketMath.js` + tests
Files: create `backend/src/services/bucketMath.js`, `backend/test/bucketMath.test.js`; modify `backend/package.json` (add `"test": "node --test"`).
Produces: `computeSplit(amount, boxes)`, `computeSetup(total, boxes)`, `computeClose(boxes) -> {balances, moves}`, `monthsToClose(start, lastClosed, current)`, `suggestBucket(entry)`, `defaultBucketFor(category)`, `round2`, `BUCKET_KEYS`, `PICKABLE_KEYS`.
- [ ] Write tests for plan examples A, C, E, F, G, H, for the split, the setup and the bridge months → run, expect FAIL
- [ ] Implement → run `cd backend && npm test`, expect PASS → commit

### Task 2: schema + `buckets.js` service + `/api/buckets` routes
Files: create `backend/migrations/2026-09-24-budget-boxes.sql`, `backend/src/services/buckets.js`, `backend/src/routes/buckets.js`; modify `backend/schema.sql`, `backend/server.js`.
Produces: `GET /api/buckets`, `GET /api/buckets/moves`, `GET /api/buckets/setup-preview`, `POST /api/buckets/setup`, `GET /api/buckets/split-preview?amount=`; service `applyEntry(entry, bucket)`, `getEntryMoves(id)`, `reverseMoves(moves)`, `closeDueMonths()`.
- [ ] Implement, `node -e "require('./server-free modules')"` load check, commit

### Task 3: entries + chat + parser integration
Files: modify `backend/src/routes/entries.js`, `backend/src/routes/chat.js`, `backend/src/services/groq.js`.
- [ ] POST stores `bucket` and applies the box effect. DELETE reads the moves, deletes the entry, then reverses the moves. The parser returns `bucket` and chat normalises it with `suggestBucket`. Commit.

### Task 4: frontend
Files: modify `frontend/index.html`, `frontend/app.js`, `frontend/styles.css`.
- [ ] Boxes card (grid of 2 columns on phone and 4 on laptop, buffer strip, totals and unallocated chip, setup preview and button), box pie with "Balances now" / "Spent this month" toggle, box history, and a confirm-modal box picker with an "I picked X — OK?" hint and a split preview. Commit.

### Task 5: verification
- [ ] `npm test`, then `node --check` on every JS file, then check that the HTML ids match the ids the JS looks up. Whole-branch review.
