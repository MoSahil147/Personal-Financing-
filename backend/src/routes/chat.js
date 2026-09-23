const express = require('express');
const supabase = require('../services/supabase');
const { classifyChat } = require('../services/groq');
const { suggestBucket } = require('../services/bucketMath');

const router = express.Router();

function clampPriority(value, fallback = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(5, Math.max(1, Math.round(n)));
}

router.post('/', async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

  try {
    const { data: activeReminders } = await supabase.from('reminders').select('id, text').eq('done', false);

    const result = await classifyChat(text, { activeReminders: activeReminders || [] });

    if (result.intent === 'add_reminder') {
      const reminderText = result.reminder_text || text;
      const { data, error } = await supabase
        .from('reminders')
        .insert({ text: reminderText, due_date: result.reminder_due_date || null, priority: clampPriority(result.reminder_priority) })
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ intent: 'add_reminder', reminder: data });
    }

    if (result.intent === 'remove_reminder') {
      if (!result.remove_reminder_id) {
        return res.json({ intent: 'remove_reminder', removed: null, reply: result.reply || "Couldn't tell which reminder you meant." });
      }
      const { data, error } = await supabase
        .from('reminders')
        .delete()
        .eq('id', result.remove_reminder_id)
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ intent: 'remove_reminder', removed: data });
    }

    if (result.intent === 'log_entry') {
      if (result.entry) result.entry.bucket = suggestBucket(result.entry);
      return res.json({ intent: 'log_entry', suggestion: result.entry, raw_input: text });
    }

    if (result.intent === 'cash_withdrawal') {
      if (!result.withdrawal_amount) {
        return res.json({ intent: 'chat', reply: "Couldn't tell how much you withdrew - try again with an amount." });
      }
      return res.json({ intent: 'cash_withdrawal', amount: result.withdrawal_amount });
    }

    res.json({ intent: 'chat', reply: result.reply || "Not sure what you meant - try logging an amount or adding/removing a reminder." });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
