const express = require('express');
const supabase = require('../services/supabase');
const { classifyChat } = require('../services/groq');

const router = express.Router();

router.post('/', async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

  try {
    const [{ data: existing }, { data: activeReminders }] = await Promise.all([
      supabase.from('entries').select('category').limit(200),
      supabase.from('reminders').select('id, text').eq('done', false),
    ]);
    const knownCategories = [...new Set((existing || []).map((e) => e.category))];

    const result = await classifyChat(text, { knownCategories, activeReminders: activeReminders || [] });

    if (result.intent === 'add_reminder') {
      const reminderText = result.reminder_text || text;
      const { data, error } = await supabase
        .from('reminders')
        .insert({ text: reminderText, due_date: result.reminder_due_date || null })
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
      return res.json({ intent: 'log_entry', suggestion: result.entry, raw_input: text });
    }

    res.json({ intent: 'chat', reply: result.reply || "Not sure what you meant - try logging an amount or adding/removing a reminder." });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
