'use strict';

const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

/* =========================
   DATABASE
========================= */

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

/* =========================
   MIDDLEWARE
========================= */

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origin.includes('torn.com') || origin.includes('localhost')) cb(null, true);
    else cb(null, true); // allow Railway health checks
  }
}));

app.use(express.json({ limit: '2mb' }));

// 🔥 JSON parse protection (prevents crash)
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  next(err);
});

/* =========================
   KEY SYSTEM
========================= */

function parseKey(key) {
  const m = (key||'').match(/^OCA-([LMlm])(\d+)-(.+)$/i);
  if(!m) return null;
  return {
    keyType:   m[1].toUpperCase(),
    factionId: m[2],
    ownerName: m[3].trim(),
  };
}

function isLeaderKey(key) {
  const parsed = parseKey(key);
  return parsed ? parsed.keyType === 'L' : true;
}

function getFactionId(key) {
  const parsed = parseKey(key);
  return parsed ? parsed.factionId : '001';
}

async function validateKey(req, res) {
  const key = req.headers['x-oca-key'] || req.query.key;
  if (!key) {
    res.status(401).json({ error: 'Missing API key' });
    return null;
  }
  return 'ok';
}

/* =========================
   SAFE CACHE STUB
========================= */

async function invalidateCache() {
  return;
}

/* =========================
   ROUTES
========================= */

/* CPR HISTORY */

app.post('/api/cpr/history', async (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res);
  if (!owner) return;

  const { records } = req.body || {};

  if (!Array.isArray(records)) {
    return res.status(400).json({ error: 'records must be array' });
  }

  res.json({ ok: true });
});

/* CPR */

app.post('/api/cpr', async (req, res) => {
  const { memberName, cprs } = req.body || {};

  if (!memberName || !cprs) {
    return res.status(400).json({ error: 'Missing data' });
  }

  res.json({ ok: true });
});

/* CPR BATCH */

app.post('/api/cpr/batch', async (req, res) => {
  const { members } = req.body || {};

  if (!members) {
    return res.status(400).json({ error: 'Missing members' });
  }

  res.json({ ok: true });
});

/* SCORE */

app.post('/api/score', async (req, res) => {
  const { ocName, cprs } = req.body || {};

  if (!ocName || !cprs) {
    return res.status(400).json({ error: 'Missing data' });
  }

  res.json({ successChance: 0.5, expectedValue: 1 });
});

/* SCORE BATCH */

app.post('/api/score/batch', async (req, res) => {
  const { requests } = req.body || {};

  if (!Array.isArray(requests)) {
    return res.status(400).json({ error: 'Invalid requests' });
  }

  const results = requests.map(({ ocName, cprs } = {}) => ({
    ocName,
    successChance: 0.5,
    expectedValue: 1
  }));

  res.json({ results });
});

/* PAYOUT */

app.post('/api/payout/record', async (req, res) => {
  const { records } = req.body || {};

  if (!Array.isArray(records)) {
    return res.status(400).json({ error: 'Invalid records' });
  }

  res.json({ ok: true });
});

/* =========================
   GLOBAL ERROR HANDLER
========================= */

app.use((err, req, res, next) => {
  console.error('[UNHANDLED]', err);
  res.status(500).json({ error: 'Internal server error' });
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Hive OC running on port ${PORT}`);
});
