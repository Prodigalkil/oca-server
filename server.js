'use strict';

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ================= DB =================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function query(sql, params) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// ================= MIDDLEWARE =================
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// prevent crash from bad JSON
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  next(err);
});

// ================= ROUTES =================

// CPR batch (SAFE + MERGE)
app.post('/api/cpr/batch', async (req, res) => {
  const { members } = req.body || {};

  if (!members || typeof members !== 'object') {
    return res.status(400).json({ error: 'Missing members' });
  }

  try {
    for (const [name, cprs] of Object.entries(members)) {
      await query(
        `INSERT INTO member_cpr (member_name, cprs)
         VALUES ($1, $2)
         ON CONFLICT (member_name)
         DO UPDATE SET cprs = member_cpr.cprs || $2::jsonb`,
        [name, JSON.stringify(cprs)]
      );
    }

    res.json({ ok: true, updated: Object.keys(members).length });
  } catch (e) {
    console.error('[CPR BATCH ERROR]', e);
    res.status(500).json({ error: 'DB error' });
  }
});

// OPTIMIZE (stable response)
app.post('/api/optimize', async (req, res) => {
  const { ocs } = req.body || {};

  if (!Array.isArray(ocs)) {
    return res.status(400).json({ error: 'Invalid OCs' });
  }

  const result = {
    ocs,
    meta: { processed: ocs.length }
  };

  res.json({ ...result, cached: false });
});

// HEALTH CHECK (IMPORTANT FOR RAILWAY)
app.get('/', (req, res) => {
  res.send('HiveOC server running');
});

// GLOBAL ERROR HANDLER
app.use((err, req, res, next) => {
  console.error('[UNHANDLED ERROR]', err);
  res.status(500).json({ error: 'Internal error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Running on port ${PORT}`);
});
