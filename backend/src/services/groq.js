const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function parseEntry(text, knownCategories = []) {
  const system = `You convert a short freeform note about personal money into structured JSON.
Today's date is ${todayISO()}.
Known categories already used by this user: ${knownCategories.join(', ') || '(none yet)'}.
Reuse a known category when it clearly matches instead of inventing a near-duplicate.
Classify every expense as exactly one of: need, want, luxury. Income entries have classification "savings" only if the note is explicitly about saving/transferring to savings, otherwise null.
For expenses, set payment_method to "credit" only if the text explicitly mentions credit card / credit; otherwise default to "debit" (assume paid straight from the bank account). Income entries have payment_method null.
Respond with ONLY a JSON object, no prose, matching this shape:
{
  "type": "income" | "expense",
  "amount": number,
  "category": string,
  "classification": "need" | "want" | "luxury" | "savings" | null,
  "payment_method": "debit" | "credit" | null,
  "date": "YYYY-MM-DD",
  "note": string
}
If the text mentions no explicit date, use today's date. If amount is missing or unclear, set amount to null.`;

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

  if (!parsed.date) parsed.date = todayISO();
  return parsed;
}

module.exports = { parseEntry };
