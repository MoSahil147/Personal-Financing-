const express = require('express');
const supabase = require('../services/supabase');

const router = express.Router();

function clampPriority(value, fallback = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(5, Math.max(1, Math.round(n)));
}

router.get('/', async (_req, res) => {
  const { data, error } = await supabase
    .from('reminders')
    .select('*')
    .eq('done', false)
    .order('priority', { ascending: false })
    .order('due_date', { ascending: true, nullsFirst: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/', async (req, res) => {
  const { text, due_date, priority } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

  const { data, error } = await supabase
    .from('reminders')
    .insert({ text, due_date: due_date || null, priority: clampPriority(priority) })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// Change an existing reminder's priority (star rating).
router.patch('/:id/priority', async (req, res) => {
  const { priority } = req.body || {};
  if (priority === undefined) return res.status(400).json({ error: 'priority is required' });

  const { data, error } = await supabase
    .from('reminders')
    .update({ priority: clampPriority(priority) })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
