const express = require('express');
const supabase = require('../services/supabase');

const router = express.Router();

router.get('/', async (_req, res) => {
  const { data, error } = await supabase.from('budgets').select('*').order('category');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Upsert by category so setting the same category again just updates the limit.
router.post('/', async (req, res) => {
  const { category, limit_amount } = req.body || {};
  if (!category || !limit_amount) {
    return res.status(400).json({ error: 'category and limit_amount are required' });
  }

  const { data, error } = await supabase
    .from('budgets')
    .upsert({ category, limit_amount }, { onConflict: 'category' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.delete('/:id', async (req, res) => {
  const { error } = await supabase.from('budgets').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

module.exports = router;
