require('dotenv').config();
const express = require('express');
const cors = require('cors');

const requireAuth = require('./src/middleware/auth');
const authRoutes = require('./src/routes/auth');
const entryRoutes = require('./src/routes/entries');
const budgetRoutes = require('./src/routes/budgets');
const reminderRoutes = require('./src/routes/reminders');
const summaryRoutes = require('./src/routes/summary');
const settingsRoutes = require('./src/routes/settings');
const chatRoutes = require('./src/routes/chat');
const bucketRoutes = require('./src/routes/buckets');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/auth', authRoutes);

app.use('/api/entries', requireAuth, entryRoutes);
app.use('/api/budgets', requireAuth, budgetRoutes);
app.use('/api/reminders', requireAuth, reminderRoutes);
app.use('/api/summary', requireAuth, summaryRoutes);
app.use('/api/settings', requireAuth, settingsRoutes);
app.use('/api/chat', requireAuth, chatRoutes);
app.use('/api/buckets', requireAuth, bucketRoutes);

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Backend listening on port ${port}`));
