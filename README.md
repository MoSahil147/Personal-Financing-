# Personal Finance Tracker

A private, password-gated finance tracker. Log income/expenses by typing
plain sentences into a chat bar ("spent 85 on vegetables"); Groq parses and
categorizes each entry (Need / Want / Luxury), Supabase stores it, and the
dashboard shows monthly + yearly charts, budget alerts, and reminders.

## Structure

- `backend/` — Express API on Render. Holds all secrets (password, JWT
  secret, Supabase service key, Groq key) as environment variables. Never
  commit `backend/.env`.
- `frontend/` — static site on Netlify. No secrets here — it just calls the
  backend.

## Setup

### 1. Supabase
1. Create a project at supabase.com.
2. Open the SQL editor and run `backend/schema.sql`.
3. Grab your Project URL and `service_role` key (Settings → API).
4. Seed your real starting bank balance (never commit this number to git —
   run it directly in the Supabase SQL editor, or use the app's PUT
   `/api/settings/bank-balance` endpoint once deployed):
   ```sql
   update settings set bank_balance = <your balance> where id = 'main';
   ```

### 2. Groq
1. Create an API key at console.groq.com.

### 3. Backend (Render)
1. Copy `backend/.env.example` to `backend/.env` locally for testing, or set
   the same variables directly in Render's dashboard for deployment:
   - `APP_PASSWORD` — the password you'll type to open the website (choose
     your own; it is never stored in code)
   - `JWT_SECRET` — any long random string
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
   - `GROQ_API_KEY`, `GROQ_MODEL` (defaults to `llama-3.3-70b-versatile`)
2. Deploy: Root directory `backend/`, build command `npm install`, start
   command `npm start`.
3. Locally: `cd backend && npm install && npm start` (runs on port 4000).

### 4. Frontend (Netlify)
1. Edit `frontend/config.js` and set `window.API_BASE_URL` to your deployed
   Render URL (e.g. `https://your-app.onrender.com`).
2. Deploy the `frontend/` folder to Netlify (drag-and-drop or connect the
   repo with publish directory `frontend`).

## Using it

- Open the site → enter the password you set as `APP_PASSWORD`.
- Set budgets first via the API (or we can add a small settings UI later),
  e.g. category `groceries` with a limit, or `overall` for a whole-month cap.
- Type entries into the chat bar at the bottom; confirm/edit the parsed
  suggestion before it saves — including whether an expense was paid by
  **debit** (cuts from your bank balance immediately) or **credit** (adds to
  the "owed on credit card" total shown top-right, without touching your
  bank balance).
- When you pay off the credit card bill, hit "Pay off now" next to the
  credit widget — it logs a debit expense for the full amount, reduces your
  bank balance, and resets the credit total to 0.
- Switch between Monthly (pie chart + budget alerts) and Yearly (bar chart)
  views at the top of the dashboard card.
- Add reminders at the top; check them off once done to remove them.

No personal financial figures (salary, rent, budget limits, etc.) are
hardcoded anywhere in this repo — they only ever live in your Supabase
database, entered through the app itself.
