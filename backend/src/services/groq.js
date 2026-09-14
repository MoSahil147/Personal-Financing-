const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Fixed, closed category list - every entry (chat-parsed or manually edited)
// must use one of these exact names, so monthly and yearly views always show
// the same categories instead of near-duplicates like "Food" vs "Dining".
const CATEGORIES = [
  'Groceries', 'Shopping', 'Dining', 'Transport', 'Fuel', 'Utilities', 'Rent',
  'Entertainment', 'Subscriptions', 'Health', 'Travel', 'Education', 'Gifts',
  'Repayment', 'Refund', 'Salary', 'Investment', 'Credit Card Payment', 'Other',
];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Classifies a chat message into one of three things this app understands:
// logging a transaction, adding a reminder, or removing an existing one.
async function classifyChat(text, { activeReminders = [] } = {}) {
  const remindersList = activeReminders.length
    ? activeReminders.map((r) => `${r.id}: ${r.text}`).join('\n')
    : '(none)';

  const system = `You are the message router for a personal finance chat bar. Today's date is ${todayISO()}.
Classify the user's message into exactly one intent:
- "log_entry": they're logging money coming in or going out (salary, a purchase, a refund, a repayment, etc) - including cash purchases or someone paying them in cash.
- "cash_withdrawal": they took cash out of the bank (an ATM withdrawal, "withdrew 200 cash", "took out 500 from the bank"). This moves money from bank to cash - it is NOT income or an expense, so never use "log_entry" for it. Extract withdrawal_amount.
- "add_reminder": they want something remembered/tracked as a to-do (e.g. "remind me to pay rent on the 1st", "these are the reminders: pay internet bill", "add a reminder to renew visa"). Infer reminder_priority 1-5 (5 = most important) from urgency/importance language - "urgent"/"important"/"asap"/"critical" -> 4-5, plain/casual mentions -> 3, "whenever"/"low priority"/"not urgent" -> 1-2. Default to 3 if nothing suggests otherwise.
- "remove_reminder": they want an EXISTING reminder taken off the list (e.g. "remove the rent reminder", "done with the internet bill one", "delete that reminder about visa"). Match it against the ACTIVE REMINDERS list below by meaning and return its id. If nothing matches clearly, use remove_reminder_id: null.
- "chat": anything else that doesn't fit the above (a question, small talk, unclear input).

ACTIVE REMINDERS (id: text):
${remindersList}

For "log_entry", fill "entry" using these rules:
"category" MUST be exactly one of this fixed list (same spelling, same casing) - never invent a new one: ${CATEGORIES.join(', ')}.
Pick the closest specific match for what was actually bought/received - only use "Other" if truly nothing else fits. "Shopping" means discretionary retail purchases (clothes, electronics, home goods) - groceries/vegetables/food staples always go under "Groceries", not "Shopping". "Dining" is restaurants/cafes/takeout, separate from "Groceries".
Any money coming TO the user counts as type "income" - this includes salary, but also someone paying them back, a refund, a reimbursement, cashback, or a gift received.
Putting money into stocks, mutual funds, ETFs, crypto, or "the market" is type "expense" (it leaves the bank account) with category "Investment" and classification "investment" - it is NOT a need/want/luxury purchase.
Classify every other expense as exactly one of: need, want, luxury. Income entries have classification "savings" only if the note is explicitly about saving/transferring to savings, otherwise null.
Set payment_method to "cash" whenever the text says paid/received in cash. For expenses, otherwise set "credit" only if the text explicitly mentions credit card / credit, else default to "debit". Income entries default to payment_method null (money hit the bank) unless it was explicitly cash.
If the text mentions no explicit date, use today's date. If amount is missing or unclear, set amount to null.

Respond with ONLY a JSON object, no prose, matching this exact shape:
{
  "intent": "log_entry" | "cash_withdrawal" | "add_reminder" | "remove_reminder" | "chat",
  "entry": { "type": "income"|"expense", "amount": number|null, "category": string, "classification": "need"|"want"|"luxury"|"savings"|"investment"|null, "payment_method": "debit"|"credit"|"cash"|null, "date": "YYYY-MM-DD", "note": string } | null,
  "withdrawal_amount": number | null,
  "reminder_text": string | null,
  "reminder_due_date": "YYYY-MM-DD" | null,
  "reminder_priority": number | null,
  "remove_reminder_id": string | null,
  "reply": string
}
Only populate the fields relevant to the chosen intent; leave the rest null. "reply" is a short natural sentence confirming what you understood (used for the "chat" intent or to explain an unclear/ambiguous removal).`;

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq request failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Groq returned no content');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Groq returned invalid JSON');
  }

  if (parsed.entry && !parsed.entry.date) parsed.entry.date = todayISO();
  return parsed;
}

module.exports = { classifyChat, CATEGORIES };
