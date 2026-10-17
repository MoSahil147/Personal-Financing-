const supabase = require('./supabase');
const { todayISO } = require('./date');
const { round2 } = require('./bucketMath');

// Prepaid card purses (bus cards). A top-up is a saved expense that also adds
// to the card; a ride just takes money off the card - it was already counted
// as spending (from the bank and the Transport box) when the card was topped up.

async function listPurses() {
  const { data, error } = await supabase.from('purses').select('*').order('sort').order('name');
  if (error) throw new Error(error.message);
  return data.map((p) => ({ ...p, balance: Number(p.balance) }));
}

async function getPurse(id) {
  const { data, error } = await supabase.from('purses').select('*').eq('id', id).single();
  if (error) throw new Error('Unknown card');
  return { ...data, balance: Number(data.balance) };
}

// Changes a card's balance by `amount` (+ or -) and records why.
async function addMove(purseId, amount, { reason, note = null, entry_id = null, date = todayISO() }) {
  const amt = round2(Number(amount));
  if (!amt) return null;
  const purse = await getPurse(purseId);
  const balance = round2(purse.balance + amt);
  const { error } = await supabase.from('purses').update({ balance }).eq('id', purseId);
  if (error) throw new Error(error.message);
  const { error: moveErr } = await supabase.from('purse_moves').insert({
    purse_id: purseId, move_date: date, amount: amt, reason, note, entry_id,
  });
  if (moveErr) throw new Error(moveErr.message);
  return { ...purse, balance };
}

// A saved expense with a purse_id is a top-up of that card.
async function applyEntry(entry) {
  if (!entry.purse_id || entry.type !== 'expense') return;
  await addMove(entry.purse_id, Number(entry.amount), {
    reason: 'topup', note: entry.note || null, entry_id: entry.id, date: entry.entry_date,
  });
}

// Read an entry's card moves BEFORE deleting the entry (the delete cascades
// them away), then pass them to reverseMoves afterwards.
async function getEntryMoves(entryId) {
  const { data, error } = await supabase.from('purse_moves').select('*').eq('entry_id', entryId);
  if (error) throw new Error(error.message);
  return data;
}

async function reverseMoves(moves) {
  for (const m of moves) {
    const purse = await getPurse(m.purse_id);
    const { error } = await supabase.from('purses')
      .update({ balance: round2(purse.balance - Number(m.amount)) })
      .eq('id', m.purse_id);
    if (error) throw new Error(error.message);
  }
}

function ride(purseId, amount, { note, date } = {}) {
  return addMove(purseId, -Math.abs(Number(amount)), { reason: 'ride', note, date: date || todayISO() });
}

// Sets the card to what the card reader / app actually shows.
async function setBalance(purseId, balance) {
  const purse = await getPurse(purseId);
  const updated = await addMove(purseId, round2(Number(balance) - purse.balance), { reason: 'adjust', note: 'Balance corrected' });
  return updated || purse;
}

async function recentMoves(purseId, limit = 30) {
  const { data, error } = await supabase
    .from('purse_moves')
    .select('*')
    .eq('purse_id', purseId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data;
}

// Finds the card the user meant from a name or number ("1234", "bus card 5678").
// With only one card, any mention of a card means that one.
function matchPurse(purses, text) {
  if (!text) return purses.length === 1 ? purses[0] : null;
  const wanted = String(text).toLowerCase();
  const exact = purses.find((p) => p.name.toLowerCase() === wanted);
  if (exact) return exact;
  const digits = wanted.match(/\d{3,}/g) || [];
  const byDigits = purses.filter((p) => digits.some((d) => p.name.includes(d)));
  if (byDigits.length === 1) return byDigits[0];
  return purses.length === 1 ? purses[0] : null;
}

module.exports = {
  listPurses,
  applyEntry,
  getEntryMoves,
  reverseMoves,
  ride,
  setBalance,
  recentMoves,
  matchPurse,
};
