const express = require('express');
const supabase = require('../services/supabase');

const router = express.Router();

router.get('/', async (_req, res) => {
  const { data, error } = await supabase
    .from('reminders')
    .select('*')
    .eq('done', false)
    .order('due_date', { ascending: true, nullsFirst: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/', async (req, res) => {
  const { text, due_date } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

  const { data, error } = await supabase
    .from('reminders')
    .insert({ text, due_date: due_date || null })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// Mark done (and effectively remove it from the active list).
router.patch('/:id/done', async (req, res) => {
  const { data, error } = await supabase
    .from('reminders')
    .update({ done: true })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const { error } = await supabase.from('reminders').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

module.exports = router;
