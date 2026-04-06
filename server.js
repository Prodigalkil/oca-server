'use strict';

const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════════════════════════════

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

async function query(sql, params) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// ═══════════════════════════════════════════════════════════════
// STARTUP — create tables + ensure all constraints exist
// ═══════════════════════════════════════════════════════════════

async function startup() {
  try {
    await query('SELECT 1');
    console.log('[DB] PostgreSQL connected');
  } catch(e) {
    console.error('[DB] Connection failed:', e.message);
  }

  // ── member_cpr ───────────────────────────────────────────────
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS member_cpr (
        id          SERIAL PRIMARY KEY,
        faction_id  TEXT NOT NULL DEFAULT '0',
        member_name TEXT NOT NULL,
        source      TEXT NOT NULL DEFAULT 'tornstats',
        cprs        JSONB NOT NULL DEFAULT '{}',
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch(e) { console.warn('[DB] member_cpr create:', e.message); }

  // THE FIX: ensure unique constraint exists — this is what ON CONFLICT requires.
  // CREATE UNIQUE INDEX IF NOT EXISTS is idempotent and safe on every deploy.
  try {
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_member_cpr_faction_name
        ON member_cpr(faction_id, member_name)
    `);
    console.log('[DB] member_cpr unique constraint ensured');
  } catch(e) { console.warn('[DB] member_cpr constraint:', e.message); }

  // ── api_keys ─────────────────────────────────────────────────
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id         SERIAL PRIMARY KEY,
        key        TEXT UNIQUE NOT NULL,
        owner_name TEXT NOT NULL,
        faction_id TEXT NOT NULL,
        key_type   TEXT NOT NULL DEFAULT 'M',
        active     BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch(e) { console.warn('[DB] api_keys create:', e.message); }

  // ── assignments ──────────────────────────────────────────────
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS assignments (
        id          SERIAL PRIMARY KEY,
        faction_id  TEXT NOT NULL,
        torn_name   TEXT NOT NULL,
        role        TEXT NOT NULL,
        oc_name     TEXT NOT NULL,
        oc_level    INT,
        assigned_by TEXT NOT NULL,
        assigned_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(faction_id, torn_name)
      )
    `);
  } catch(e) { console.warn('[DB] assignments create:', e.message); }

  // ── optimize_cache ───────────────────────────────────────────
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS optimize_cache (
        id         SERIAL PRIMARY KEY,
        faction_id TEXT NOT NULL,
        cache_key  TEXT NOT NULL,
        result     JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(faction_id, cache_key)
      )
    `);
  } catch(e) { console.warn('[DB] optimize_cache create:', e.message); }

  // ── oc_payouts ───────────────────────────────────────────────
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS oc_payouts (
        id          SERIAL PRIMARY KEY,
        faction_id  TEXT NOT NULL,
        oc_name     TEXT NOT NULL,
        executed_at BIGINT NOT NULL,
        money       BIGINT NOT NULL DEFAULT 0,
        respect     INT    NOT NULL DEFAULT 0,
        item_ids    JSONB  NOT NULL DEFAULT '[]',
        slot_cprs   JSONB  NOT NULL DEFAULT '{}',
        payout_pct  INT    NOT NULL DEFAULT 100,
        max_money   BIGINT NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_oc_payouts_faction_oc ON oc_payouts(faction_id, oc_name)`);
  } catch(e) { console.warn('[DB] oc_payouts create:', e.message); }

  await migrateKeysFromFile();
}

// ═══════════════════════════════════════════════════════════════
// CORS
// ═══════════════════════════════════════════════════════════════

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origin.includes('torn.com') || origin.includes('localhost')) cb(null, true);
    else cb(new Error('CORS blocked'));
  }
}));
app.use(express.json({ limit: '2mb' }));

// ═══════════════════════════════════════════════════════════════
// KEY MANAGEMENT
// ═══════════════════════════════════════════════════════════════

function parseKey(key) {
  const m = (key||'').match(/^OCA-([LMlm])(\d+)-(.+)$/i);
  if (!m) return null;
  return { key, keyType: m[1].toUpperCase(), factionId: m[2], ownerName: m[3].trim() };
}

function isLeaderKey(key) {
  const p = parseKey(key);
  return p ? p.keyType === 'L' : true;
}

function getFactionId(key) {
  const p = parseKey(key);
  return p ? p.factionId : '001';
}

function loadKeysFromFile() {
  try {
    const file = fs.readFileSync(path.join(__dirname, 'keys.txt'), 'utf8');
    const keys = {};
    file.split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const [k, ...rest] = line.split(/\s+/);
      if (k) keys[k] = rest.join(' ') || 'unknown';
    });
    return keys;
  } catch(e) { return {}; }
}

async function migrateKeysFromFile() {
  const fileKeys = loadKeysFromFile();
  if (!Object.keys(fileKeys).length) return;
  let migrated = 0;
  for (const [key, ownerName] of Object.entries(fileKeys)) {
    if (key.startsWith('#') || ownerName === 'unknown') continue;
    const parsed = parseKey(key);
    if (!parsed) continue;
    try {
      await query(
        `INSERT INTO api_keys (key, owner_name, faction_id, key_type)
         VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING`,
        [parsed.key, parsed.ownerName, parsed.factionId, parsed.keyType]
      );
      migrated++;
    } catch(e) {}
  }
  if (migrated > 0) console.log(`[KEYS] Migrated ${migrated} keys from keys.txt`);
}

async function validateKey(req, res) {
  const key = req.headers['x-oca-key'] || req.query.key;
  if (!key) { res.status(401).json({ error: 'Missing API key' }); return null; }
  try {
    const result = await query('SELECT owner_name FROM api_keys WHERE key = $1 AND active = TRUE', [key]);
    if (result.rows.length > 0) return result.rows[0].owner_name;
  } catch(e) { console.warn('[KEYS] DB lookup failed, trying keys.txt'); }
  const fileKeys = loadKeysFromFile();
  if (fileKeys[key]) return fileKeys[key];
  res.status(403).json({ error: 'Invalid API key' });
  return null;
}

// ═══════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════

const RATE_LIMITS = {
  score:       { max: 120, window: 60000 },
  score_batch: { max: 30,  window: 60000 },
  optimize:    { max: 20,  window: 60000 },
  cpr:         { max: 20,  window: 60000 },
  cpr_batch:   { max: 10,  window: 60000 },
  cpr_history: { max: 5,   window: 60000 },
  assign:      { max: 30,  window: 60000 },
  assignments: { max: 60,  window: 60000 },
  assignment:  { max: 60,  window: 60000 },
};

const _rateLimits = new Map();

function checkRateLimit(key, endpoint) {
  const config = RATE_LIMITS[endpoint] || { max: 60, window: 60000 };
  const mapKey = `${key}:${endpoint}`;
  const now = Date.now();
  if (!_rateLimits.has(mapKey)) _rateLimits.set(mapKey, []);
  const times = _rateLimits.get(mapKey).filter(t => now - t < config.window);
  if (times.length >= config.max) return false;
  times.push(now);
  _rateLimits.set(mapKey, times);
  return true;
}

function rateLimit(endpoint) {
  return (req, res, next) => {
    const key = req.headers['x-oca-key'] || req.query.key || 'anonymous';
    if (!checkRateLimit(key, endpoint)) return res.status(429).json({ error: `Rate limit exceeded for ${endpoint}` });
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, times] of _rateLimits.entries()) {
    const filtered = times.filter(t => now - t < 120000);
    if (filtered.length === 0) _rateLimits.delete(k);
    else _rateLimits.set(k, filtered);
  }
}, 300000);

// ═══════════════════════════════════════════════════════════════
// CACHE HELPERS
// ═══════════════════════════════════════════════════════════════

function hashObject(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 32);
}

async function getCachedOptimize(factionId, cacheKey) {
  try {
    const result = await query(
      `SELECT result FROM optimize_cache
       WHERE faction_id = $1 AND cache_key = $2
       AND created_at > NOW() - INTERVAL '5 minutes'`,
      [factionId, cacheKey]
    );
    if (result.rows.length > 0) return result.rows[0].result;
  } catch(e) { console.warn('[CACHE] Read error:', e.message); }
  return null;
}

async function setCachedOptimize(factionId, cacheKey, result) {
  try {
    await query(
      `INSERT INTO optimize_cache (faction_id, cache_key, result)
       VALUES ($1, $2, $3)
       ON CONFLICT (faction_id, cache_key)
       DO UPDATE SET result = $3, created_at = NOW()`,
      [factionId, cacheKey, JSON.stringify(result)]
    );
  } catch(e) { console.warn('[CACHE] Write error:', e.message); }
}

async function invalidateCache(factionId) {
  try { await query('DELETE FROM optimize_cache WHERE faction_id = $1', [factionId]); } catch(e) {}
}

setInterval(async () => {
  try { await query(`DELETE FROM optimize_cache WHERE created_at < NOW() - INTERVAL '10 minutes'`); } catch(e) {}
}, 600000);

// ═══════════════════════════════════════════════════════════════
// DAG FLOWCHART ENGINE
// ═══════════════════════════════════════════════════════════════

const SCOPE_BREAKEVEN = {1:0.50,2:0.60,3:0.67,4:0.72,5:0.77,6:0.80,7:0.83,8:0.86,9:0.90};
const SAFE_ROLES = ['Looter','Lookout','Arsonist','Decoy'];

const ROLE_CPR_RANGES = {
  'Looter':     {idealMin:0,  idealMax:99, absMin:0,  overQual:99, safe:true },
  'Lookout':    {idealMin:0,  idealMax:99, absMin:0,  overQual:99, safe:true },
  'Arsonist':   {idealMin:0,  idealMax:99, absMin:0,  overQual:99, safe:true },
  'Decoy':      {idealMin:0,  idealMax:99, absMin:0,  overQual:99, safe:true },
  'Driver':     {idealMin:58, idealMax:74, absMin:53, overQual:85, safe:false},
  'Muscle':     {idealMin:58, idealMax:75, absMin:50, overQual:86, safe:false},
  'Enforcer':   {idealMin:60, idealMax:75, absMin:52, overQual:87, safe:false},
  'Kidnapper':  {idealMin:58, idealMax:75, absMin:50, overQual:86, safe:false},
  'Negotiator': {idealMin:58, idealMax:74, absMin:55, overQual:85, safe:false},
  'Imitator':   {idealMin:58, idealMax:74, absMin:52, overQual:85, safe:false},
  'Hustler':    {idealMin:58, idealMax:74, absMin:52, overQual:85, safe:false},
  'Hacker':     {idealMin:60, idealMax:73, absMin:58, overQual:84, safe:false},
  'Techie':     {idealMin:60, idealMax:73, absMin:58, overQual:84, safe:false},
  'Engineer':   {idealMin:62, idealMax:73, absMin:60, overQual:84, safe:false},
  'Bomber':     {idealMin:60, idealMax:73, absMin:58, overQual:84, safe:false},
  'Thief':      {idealMin:58, idealMax:74, absMin:53, overQual:85, safe:false},
  'Robber':     {idealMin:58, idealMax:74, absMin:53, overQual:85, safe:false},
  'Sniper':     {idealMin:58, idealMax:74, absMin:55, overQual:85, safe:false},
  'Car Thief':  {idealMin:60, idealMax:74, absMin:55, overQual:85, safe:false},
  'Picklock':   {idealMin:55, idealMax:74, absMin:50, overQual:85, safe:false},
  'Pickpocket': {idealMin:55, idealMax:74, absMin:48, overQual:85, safe:false},
};

function getRoleBase(role) { return (role||'').replace(/\s+\d+$/,''); }
function getRoleCPRRange(role) {
  const base = getRoleBase(role);
  return ROLE_CPR_RANGES[role] || ROLE_CPR_RANGES[base] || {idealMin:58,idealMax:74,absMin:50,overQual:85,safe:false};
}

// Torn sometimes renders OC names with different capitalisation than our keys.
// Normalise on every inbound OC name before flowchart lookup.
const OC_NAME_ALIASES = {
  'cash me if you can': 'Cash Me If You Can',
  'guardian ángels':    'Guardian Angels',
  'market force':       'Market Forces',
};
function normOCName(name) {
  if (!name) return name;
  const trimmed = name.trim();
  return OC_NAME_ALIASES[trimmed.toLowerCase()] || trimmed;
}

// ── FLOWCHARTS (all 27 OCs) ──────────────────────────────────
const FLOWCHARTS = {
  'Bidding War':{level:6,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Bomber 1',pass:'_A2_C1_',fail:'_A1_C2_'},'_A1_C2_':{roles:['Bomber 1','Bomber 2'],pass:'_A2_C1_',fail:'_A1_C3_'},'_A2_C1_':{role:'Driver',pass:'_A3_C1_',fail:'_A2_C2_'},'_A2_C2_':{role:'Driver',pass:'_A3_C1_',fail:'_A2_C3_'},'_A3_C1_':{role:'Robber 1',pass:'_A4_C1_',fail:'_A3_C2_'},'_A3_C2_':{role:'Robber 2',pass:'_A4_C1_',fail:'_A3_C3_'},'_A4_C1_':{role:'Robber 3',pass:'_A5_C1_',fail:'_A4_C2_'},'_A5_C1_':{role:'Robber 3',pass:'_A6_C1_',fail:'_A5_C2_'},'_A5_C2_':{role:'Robber 2',pass:'_A6_C2_',fail:'_A5F_'},'_A4_C2_':{role:'Bomber 2',pass:'_A5_C1_',fail:'_A4_C3_'},'_A4_C3_':{role:'Robber 1',pass:'_A4F2_',fail:'_A4F_'},'_A6_C1_':{roles:['Driver','Robber 3'],pass:'_A7_C1_',fail:'_A6_C2_'},'_A7_C1_':{role:'Bomber 2',pass:'_A8S_',fail:'_A8S2_'},'_A3_C3_':{roles:['Robber 1','Robber 2'],pass:'_A4_C1_',fail:'_A3F_'},'_A6_C2_':{role:'Robber 2',pass:'_A6S_',fail:'_A6S2_'},'_A1_C3_':{roles:['Driver','Bomber 1'],pass:'_A2_C1_',fail:'_A1F_'},'_A2_C3_':{role:'Driver',pass:'_A3_C1_',fail:'_A2F_'},'_A8S_':{end:true,payout:1.0},'_A8S2_':{end:true,payout:0.7678},'_A6S_':{end:true,payout:0.6991},'_A6S2_':{end:true,payout:0.5954},'_A4F2_':{end:true,payout:0},'_A4F_':{end:true,payout:0},'_A5F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0}}},
  'No Reserve':{level:5,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Techie',pass:'_A2_C1_',fail:'_A1_C2_'},'_A2_C1_':{role:'Techie',pass:'_A3_C1_',fail:'_A2_C2_'},'_A3_C1_':{role:'Techie',pass:'_A4_C1_',fail:'_A3_C2_'},'_A4_C1_':{roles:['Car Thief','Thief'],pass:'_A5_C1_',fail:'_B4_C1_'},'_A5_C1_':{role:'Engineer',pass:'_A6_C1_',fail:'_B5_C1_'},'_B5_C1_':{roles:['Car Thief','Thief'],pass:'_B8_C1_',fail:'_B5_C2_'},'_B5_C2_':{role:'Techie',pass:'_B6_C1_',fail:'_B5F_'},'_B6_C1_':{roles:['Car Thief','Engineer','Thief'],pass:'_B7S_',fail:'_B6_C2_'},'_B6_C2_':{role:'Techie',pass:'_B7S_',fail:'_B6F_'},'_A3_C2_':{role:'Engineer',pass:'_A4_C1_',fail:'_A3_C3_'},'_B4_C1_':{role:'Engineer',pass:'_B5_C1_',fail:'_B4F_'},'_A2_C2_':{roles:['Car Thief','Techie','Thief'],pass:'_A3_C1_',fail:'_A2_C3_'},'_A3_C3_':{roles:['Car Thief','Thief'],pass:'_B4_C1_',fail:'_A3F_'},'_B8_C1_':{role:'Techie',pass:'_B9S_',fail:'_B8_C2_'},'_B8_C2_':{roles:['Car Thief','Engineer','Thief'],pass:'_B8S_',fail:'_B8F_'},'_A1_C2_':{roles:['Engineer','Techie'],pass:'_A2_C1_',fail:'_A1_C3_'},'_A1_C3_':{roles:['Car Thief','Techie','Thief'],pass:'_A2_C1_',fail:'_A1F_'},'_A2_C3_':{role:'Engineer',pass:'_A3_C1_',fail:'_A2F_'},'_A6_C1_':{role:'Techie',pass:'_A7S_',fail:'_B8_C1_'},'_B8S_':{end:true,payout:1.0},'_A7S_':{end:true,payout:1.0},'_B9S_':{end:true,payout:1.0},'_B6F_':{end:true,payout:0},'_B4F_':{end:true,payout:0},'_B8F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_B7S_':{end:true,payout:1.0},'_B5F_':{end:true,payout:0}}},
  'Blast from the Past':{level:7,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Muscle',pass:'_A2_C1_',fail:'_A1_C2_'},'_A1_C2_':{roles:['Picklock 1','Picklock 2'],pass:'_A2_C1_',fail:'_A1_C3_'},'_A2_C1_':{role:'Hacker',pass:'_A3_C1_',fail:'_A2_C2_'},'_A3_C1_':{role:'Muscle',pass:'_A4_C1_',fail:'_A3_C2_'},'_A3_C2_':{role:'Muscle',pass:'_A4_C1_',fail:'_A3F_'},'_A4_C1_':{role:'Engineer',pass:'_A5_C1_',fail:'_A4_C2_'},'_A4_C2_':{roles:['Engineer','Muscle'],pass:'_A5_C1_',fail:'_A4F_'},'_A5_C1_':{role:'Bomber',pass:'_A6_C1_',fail:'_A5_C2_'},'_A5_C2_':{roles:['Engineer','Bomber'],pass:'_B6_C1_',fail:'_A5F_'},'_B6_C1_':{role:'Picklock 2',pass:'_B7_C1_',fail:'_B7_C1_'},'_B7_C1_':{role:'Picklock 1',pass:'_B8_C1_',fail:'_B8_C1_'},'_B8_C1_':{role:'Hacker',pass:'_B8S1_',fail:'_B8S2_'},'_A2_C2_':{role:'Picklock 1',pass:'_A3_C1_',fail:'_A2_C3_'},'_A2_C3_':{roles:['Picklock 1','Hacker'],pass:'_A3_C1_',fail:'_A2F_'},'_A1_C3_':{role:'Hacker',pass:'_A2_C1_',fail:'_A1F_'},'_A6_C1_':{role:'Picklock 2',pass:'_A7_C1_',fail:'_A6_C2_'},'_A7_C1_':{role:'Picklock 1',pass:'_A8_C1_',fail:'_A7_C2_'},'_A7_C2_':{role:'Picklock 2',pass:'_A8_C1_',fail:'_B7_C1_'},'_A8_C1_':{role:'Hacker',pass:'_A9S_',fail:'_A10S_'},'_A6_C2_':{roles:['Picklock 2','Engineer'],pass:'_A7_C1_',fail:'_B6_C1_'},'_B8S1_':{end:true,payout:0.7493},'_A10S_':{end:true,payout:0.843},'_B8S2_':{end:true,payout:0.5922},'_A9S_':{end:true,payout:1.0},'_A5F_':{end:true,payout:0},'_A4F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0}}},
  'Break the Bank':{level:8,start:'_A1_C1_',nodes:{'_A1_C1_':{roles:['Robber','Muscle 1'],pass:'_A2_C1_',fail:'_A1_C2_'},'_A2_C1_':{roles:['Muscle 2','Thief 1'],pass:'_A3_C1_',fail:'_A2_C2_'},'_A3_C1_':{role:'Muscle 3',pass:'_A4_C1_',fail:'_A3_C2_'},'_A4_C1_':{role:'Thief 2',pass:'_A5_C1_',fail:'_A4_C2_'},'_A5_C1_':{role:'Muscle 3',pass:'_A6_C1_',fail:'_A5_C2_'},'_A6_C1_':{roles:['Robber','Muscle 1'],pass:'_A7_C1_',fail:'_A7_C2_'},'_A7_C1_':{roles:['Robber','Muscle 1'],pass:'_A8_C1_',fail:'_A7_C2_'},'_A7_C2_':{roles:['Robber','Muscle 1'],pass:'_A9S_',fail:'_A10S_'},'_A5_C2_':{roles:['Muscle 3','Muscle 1'],pass:'_A6_C1_',fail:'_A5F_'},'_A1_C2_':{role:'Muscle 2',pass:'_A2_C1_',fail:'_A1_C3_'},'_A1_C3_':{role:'Muscle 3',pass:'_A2_C1_',fail:'_A1F_'},'_A3_C2_':{roles:['Muscle 3','Thief 2'],pass:'_A4_C1_',fail:'_A4_C2_'},'_A8_C1_':{roles:['Robber','Thief 1'],pass:'_A8S_',fail:'_A8S2_'},'_A2_C2_':{roles:['Muscle 2','Thief 1'],pass:'_A3_C1_',fail:'_B1_C1_'},'_A4_C2_':{roles:['Robber','Thief 2'],pass:'_A5_C1_',fail:'_A4F_'},'_B1_C1_':{role:'Thief 2',pass:'_B2_C1_',fail:'_B1F_'},'_B2_C1_':{role:'Muscle 3',pass:'_B3S_',fail:'_B2_C2_'},'_B2_C2_':{role:'Muscle 1',pass:'_B3S_',fail:'_B2F_'},'_A9S_':{end:true,payout:0.8597},'_A10S_':{end:true,payout:0.7258},'_A8S_':{end:true,payout:1.0},'_B3S_':{end:true,payout:0.592},'_A8S2_':{end:true,payout:0.9874},'_B2F_':{end:true,payout:0},'_A4F_':{end:true,payout:0},'_A5F_':{end:true,payout:0},'_B1F_':{end:true,payout:0},'_A1F_':{end:true,payout:0}}},
  'Snow Blind':{level:4,start:'_A1_C1_',nodes:{'_A1_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_A2_C1_',fail:'_A1_C2_'},'_A1_C2_':{role:'Muscle 1',pass:'_A2_C1_',fail:'_A1_C3_'},'_A1_C3_':{role:'Muscle 2',pass:'_A2_C1_',fail:'_A1F_'},'_A2_C1_':{role:'Hustler',pass:'_A3_C1_',fail:'_A2_C2_'},'_A2_C2_':{role:'Imitator',pass:'_A3_C1_',fail:'_B1_C1_'},'_A3_C1_':{role:'Imitator',pass:'_A4_C1_',fail:'_A3_C2_'},'_A4_C1_':{role:'Hustler',pass:'_A5_C1_',fail:'_A4_C2_'},'_A4_C2_':{role:'Hustler',pass:'_A5_C1_',fail:'_A4_C3_'},'_A5_C1_':{role:'Hustler',pass:'_A6_C1_',fail:'_A5_C2_'},'_A5_C2_':{role:'Imitator',pass:'_A6_C1_',fail:'_A5F_'},'_A6_C1_':{role:'Imitator',pass:'_A7_C1_',fail:'_A6_C2_'},'_A7_C1_':{role:'Imitator',pass:'_A8S1_',fail:'_A8S2_'},'_A6_C2_':{role:'Hustler',pass:'_B7_C1_',fail:'_A6_C3_'},'_A6_C3_':{roles:['Muscle 1','Muscle 2'],pass:'_B8S_',fail:'_A6F_'},'_B7_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_B7S1_',fail:'_B7S2_'},'_A3_C2_':{role:'Hustler',pass:'_A4_C1_',fail:'_A4_C3_'},'_A4_C3_':{role:'Hustler',pass:'_A4S_',fail:'_A4F_'},'_B1_C1_':{role:'Muscle 1',pass:'_B1F3_',fail:'_B1_C2_'},'_B1_C2_':{role:'Muscle 2',pass:'_B1F2_',fail:'_B1F1_'},'_A8S1_':{end:true,payout:1.0},'_A8S2_':{end:true,payout:0.9528},'_B7S1_':{end:true,payout:0.8529},'_B7S2_':{end:true,payout:0.7983},'_B8S_':{end:true,payout:0.6593},'_A4S_':{end:true,payout:0.6136},'_B1F3_':{end:true,payout:0},'_B1F2_':{end:true,payout:0},'_A4F_':{end:true,payout:0},'_A6F_':{end:true,payout:0},'_A5F_':{end:true,payout:0},'_B1F1_':{end:true,payout:0},'_A1F_':{end:true,payout:0}}},
  'Counter Offer':{level:5,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Robber',pass:'_A2_C1_',fail:'_A1_C2_'},'_A2_C1_':{role:'Engineer',pass:'_A3_C1_',fail:'_A2_C2_'},'_A3_C1_':{role:'Hacker',pass:'_A4_C1_',fail:'_A3_C2_'},'_A4_C1_':{role:'Picklock',pass:'_A5_C1_',fail:'_A4_C2_'},'_A5_C1_':{role:'Looter',pass:'_A5S_',fail:'_A5S_'},'_A1_C2_':{role:'Engineer',pass:'_A2_C1_',fail:'_A1_C3_'},'_A2_C2_':{role:'Hacker',pass:'_A3_C1_',fail:'_A2_C3_'},'_A3_C2_':{role:'Picklock',pass:'_A4_C1_',fail:'_A3F_'},'_A4_C2_':{role:'Robber',pass:'_A5_C1_',fail:'_A4F_'},'_A1_C3_':{role:'Hacker',pass:'_A2_C1_',fail:'_A1F_'},'_A2_C3_':{role:'Picklock',pass:'_A3_C1_',fail:'_A2F_'},'_A5S_':{end:true,payout:1.0},'_A3F_':{end:true,payout:0},'_A4F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0}}},
  'Leave No Trace':{level:6,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Techie',pass:'_A2_C1_',fail:'_A1_C2_'},'_A2_C1_':{role:'Negotiator',pass:'_A3_C1_',fail:'_A2_C2_'},'_A2_C2_':{role:'Imitator',pass:'_A3_C1_',fail:'_B1_C1_'},'_B1_C1_':{role:'Imitator',pass:'_B2_C1_',fail:'_B1_C2_'},'_B1_C2_':{role:'Negotiator',pass:'_B2_C1_',fail:'_B1F_'},'_A1_C2_':{role:'Negotiator',pass:'_A2_C1_',fail:'_A1F_'},'_B2_C1_':{roles:['Negotiator','Techie'],pass:'_B3S_',fail:'_B2F_'},'_A3_C1_':{role:'Imitator',pass:'_A4_C1_',fail:'_A3_C2_'},'_A3_C2_':{role:'Negotiator',pass:'_A4_C1_',fail:'_A3_C3_'},'_A4_C1_':{role:'Imitator',pass:'_A5_C1_',fail:'_A4_C2_'},'_A4_C2_':{role:'Imitator',pass:'_A6_C1_',fail:'_A4F_'},'_A6_C1_':{role:'Techie',pass:'_A8_C1_',fail:'_A6_C2_'},'_A8_C1_':{role:'Negotiator',pass:'_A8S1_',fail:'_A8S2_'},'_A3_C3_':{role:'Techie',pass:'_A4_C1_',fail:'_A3F_'},'_A5_C1_':{role:'Techie',pass:'_A7_C1_',fail:'_A6_C1_'},'_A6_C2_':{role:'Negotiator',pass:'_A8_C1_',fail:'_A6_C3_'},'_A6_C3_':{role:'Imitator',pass:'_A6S_',fail:'_A6F_'},'_A7_C1_':{roles:['Imitator','Negotiator'],pass:'_A7S_',fail:'_A7S2_'},'_B3S_':{end:true,payout:0.5714},'_A8S2_':{end:true,payout:0.7435},'_A8S1_':{end:true,payout:0.749},'_A6S_':{end:true,payout:0.6662},'_A7S_':{end:true,payout:1.0},'_A7S2_':{end:true,payout:0.7754},'_B2F_':{end:true,payout:0},'_A4F_':{end:true,payout:0},'_A6F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},'_B1F_':{end:true,payout:0},'_A1F_':{end:true,payout:0}}},
  'Honey Trap':{level:5,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Enforcer',pass:'_A2_C1_',fail:'_A1_C2_'},'_A2_C1_':{role:'Muscle 1',pass:'_A3_C1_',fail:'_A2_C2_'},'_A2_C2_':{role:'Enforcer',pass:'_A3_C1_',fail:'_A2_C3_'},'_A2_C3_':{role:'Muscle 2',pass:'_A3_C1_',fail:'_A2F_'},'_A3_C1_':{role:'Enforcer',pass:'_A4_C1_',fail:'_B1_C1_'},'_B1_C1_':{role:'Muscle 2',pass:'_B2_C1_',fail:'_B1_C2_'},'_B1_C2_':{role:'Muscle 2',pass:'_B2_C1_',fail:'_B1F_'},'_B2_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_B2S_',fail:'_B2_C2_'},'_A1_C2_':{role:'Muscle 1',pass:'_A2_C1_',fail:'_A1_C3_'},'_A4_C1_':{role:'Enforcer',pass:'_A5_C1_',fail:'_A4_C2_'},'_A5_C1_':{role:'Muscle 2',pass:'_A6_C1_',fail:'_A5_C2_'},'_A5_C2_':{role:'Muscle 1',pass:'_A6_C2_',fail:'_A5F_'},'_A6_C2_':{role:'Muscle 2',pass:'_A7_C1_',fail:'_A6S_'},'_A7_C1_':{roles:['Enforcer','Muscle 1'],pass:'_A8S_',fail:'_A7S_'},'_A1_C3_':{role:'Muscle 2',pass:'_A2_C1_',fail:'_A1F_'},'_A6_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_A7_C1_',fail:'_A6_C2_'},'_B2_C2_':{role:'Muscle 2',pass:'_B2S_',fail:'_B2F_'},'_A4_C2_':{roles:['Muscle 1','Muscle 2'],pass:'_A5_C2_',fail:'_A4F_'},'_B2S_':{end:true,payout:0.6153},'_A8S_':{end:true,payout:1.0},'_A6S_':{end:true,payout:0.721},'_A7S_':{end:true,payout:0.9084},'_B2F_':{end:true,payout:0},'_A5F_':{end:true,payout:0},'_A4F_':{end:true,payout:0},'_B1F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0}}},
  'Guardian Angels':{level:5,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Hustler',pass:'_A2_C1_',fail:'_A1_C2_'},'_A2_C1_':{role:'Engineer',pass:'_A3_C1_',fail:'_A2_C2_'},'_A3_C1_':{role:'Enforcer',pass:'_A4_C1_',fail:'_A3_C2_'},'_A4_C1_':{role:'Engineer',pass:'_A5_C1_',fail:'_B4_C1_'},'_A5_C1_':{role:'Hustler',pass:'_A6_C1_',fail:'_A5_C2_'},'_A5_C2_':{role:'Enforcer',pass:'_A6_C2_',fail:'_A5_C3_'},'_A5_C3_':{role:'Enforcer',pass:'_A6_C2_',fail:'_A5F_'},'_A6_C2_':{role:'Engineer',pass:'_A8S_',fail:'_A6_C3_'},'_A6_C1_':{role:'Enforcer',pass:'_A7S_',fail:'_A6_C2_'},'_A6_C3_':{role:'Hustler',pass:'_A9S_',fail:'_A6F_'},'_B4_C1_':{roles:['Enforcer','Engineer'],pass:'_B5_C1_',fail:'_B4_C2_'},'_B5_C1_':{role:'Hustler',pass:'_B6S_',fail:'_B5F_'},'_A2_C2_':{roles:['Enforcer','Engineer'],pass:'_A3_C1_',fail:'_A2_C3_'},'_A3_C2_':{role:'Hustler',pass:'_A4_C1_',fail:'_B4_C1_'},'_A1_C2_':{role:'Enforcer',pass:'_A2_C1_',fail:'_A1_C3_'},'_B4_C2_':{roles:['Enforcer','Hustler'],pass:'_B5_C1_',fail:'_B4F_'},'_A2_C3_':{roles:['Enforcer','Engineer'],pass:'_A3_C1_',fail:'_A2F_'},'_A1_C3_':{roles:['Enforcer','Engineer'],pass:'_A2_C1_',fail:'_A1F_'},'_A8S_':{end:true,payout:0.8814},'_A7S_':{end:true,payout:1.0},'_B6S_':{end:true,payout:0.6069},'_A9S_':{end:true,payout:0.7363},'_A6F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_B4F_':{end:true,payout:0},'_A5F_':{end:true,payout:0},'_B5F_':{end:true,payout:0}}},
  'Clinical Precision':{level:8,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Cat Burglar',pass:'_A2_C1_',fail:'_A1_C2_'},'_A2_C1_':{role:'Assassin',pass:'_A3_C1_',fail:'_A2_C2_'},'_A3_C1_':{role:'Cleaner',pass:'_A4_C1_',fail:'_A3_C2_'},'_A4_C1_':{role:'Cleaner',pass:'_A5_C1_',fail:'_A4_C2_'},'_A5_C1_':{roles:['Assassin','Imitator'],pass:'_A6_C1_',fail:'_C5_C1_'},'_A6_C1_':{role:'Assassin',pass:'_A7_C1_',fail:'_A6_C2_'},'_A7_C1_':{roles:['Assassin','Cleaner'],pass:'_A8S_',fail:'_A9S_'},'_A1_C2_':{roles:['Cat Burglar','Assassin'],pass:'_A2_C1_',fail:'_A1_C3_'},'_A1_C3_':{roles:['Cat Burglar','Cleaner'],pass:'_A2_C1_',fail:'_A1F_'},'_A4_C2_':{role:'Cat Burglar',pass:'_A5_C1_',fail:'_A4F_'},'_A2_C2_':{role:'Assassin',pass:'_A3_C1_',fail:'_B3_C1_'},'_B3_C1_':{role:'Imitator',pass:'_B4_C1_',fail:'_B3_C2_'},'_B3_C2_':{roles:['Assassin','Cleaner'],pass:'_B4_C1_',fail:'_B3F_'},'_B4_C1_':{role:'Imitator',pass:'_B5_C1_',fail:'_B4F_'},'_B5_C1_':{roles:['Assassin','Cleaner'],pass:'_B6S_',fail:'_B5S_'},'_C5_C1_':{role:'Cleaner',pass:'_C6_C1_',fail:'_C5_C2_'},'_C6_C1_':{role:'Imitator',pass:'_C7S_',fail:'_C6F_'},'_A3_C2_':{role:'Cleaner',pass:'_A4_C1_',fail:'_B3_C1_'},'_C5_C2_':{roles:['Cat Burglar','Cleaner'],pass:'_C6_C1_',fail:'_C5F_'},'_A6_C2_':{role:'Assassin',pass:'_A7_C1_',fail:'_A6_C3_'},'_A6_C3_':{role:'Imitator',pass:'_A6S_',fail:'_A6F_'},'_A8S_':{end:true,payout:1.0},'_A9S_':{end:true,payout:0.9113},'_C7S_':{end:true,payout:0.7614},'_A6S_':{end:true,payout:0.7876},'_B6S_':{end:true,payout:0.6916},'_B5S_':{end:true,payout:0.5675},'_B3F_':{end:true,payout:0},'_C6F_':{end:true,payout:0},'_A4F_':{end:true,payout:0},'_B4F_':{end:true,payout:0},'_C5F_':{end:true,payout:0},'_A6F_':{end:true,payout:0},'_A1F_':{end:true,payout:0}}},
  'Sneaky Git Grab':{level:6,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Imitator',pass:'_A2_C1_',fail:'_A1_C2_'},'_A2_C1_':{role:'Pickpocket',pass:'_A3_C1_',fail:'_A2_C2_'},'_A2_C2_':{role:'Pickpocket',pass:'_A3_C1_',fail:'_A2F_'},'_A3_C1_':{roles:['Pickpocket','Imitator'],pass:'_A4_C1_',fail:'_A3_C2_'},'_A4_C1_':{role:'Techie',pass:'_A5_C1_',fail:'_A4_C2_'},'_A5_C1_':{role:'Hacker',pass:'_A6_C1_',fail:'_A5_C2_'},'_A5_C2_':{role:'Hacker',pass:'_A6_C1_',fail:'_A5_C3_'},'_A6_C1_':{role:'Techie',pass:'_A7_C1_',fail:'_A6_C2_'},'_A7_C1_':{role:'Imitator',pass:'_A7S_',fail:'_A7S2_'},'_A1_C2_':{role:'Imitator',pass:'_A2_C1_',fail:'_A1_C3_'},'_A6_C2_':{roles:['Imitator','Techie','Hacker'],pass:'_A8S_',fail:'_A9S_'},'_A4_C2_':{roles:['Pickpocket','Techie'],pass:'_A5_C1_',fail:'_A4F_'},'_A5_C3_':{roles:['Imitator','Hacker'],pass:'_B6_C1_',fail:'_A5F_'},'_B6_C1_':{role:'Hacker',pass:'_B7S_',fail:'_B6F_'},'_A1_C3_':{role:'Pickpocket',pass:'_A2_C1_',fail:'_A1F_'},'_A3_C2_':{role:'Imitator',pass:'_A4_C1_',fail:'_A3_C3_'},'_A3_C3_':{role:'Pickpocket',pass:'_A4_C1_',fail:'_A3F_'},'_A7S_':{end:true,payout:1.0},'_A8S_':{end:true,payout:0.7725},'_A7S2_':{end:true,payout:0.8727},'_A9S_':{end:true,payout:0.6827},'_B7S_':{end:true,payout:0.5948},'_A5F_':{end:true,payout:0},'_A4F_':{end:true,payout:0},'_B6F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0}}},
  'Stage Fright':{level:4,start:'_A1_C1_',nodes:{'_A1_C1_':{roles:['Lookout','Muscle 2'],pass:'_A2_C1_',fail:'_A1_C2_'},'_A2_C1_':{role:'Sniper',pass:'_A3_C1_',fail:'_A2_C2_'},'_A2_C2_':{roles:['Muscle 2','Muscle 1'],pass:'_A3_C1_',fail:'_A2F_'},'_A3_C1_':{roles:['Muscle 1','Muscle 3'],pass:'_A4_C1_',fail:'_B1_C1_'},'_B1_C1_':{role:'Enforcer',pass:'_B2_C1_',fail:'_B1_C2_'},'_B1_C2_':{role:'Sniper',pass:'_B2_C1_',fail:'_B1F_'},'_B2_C1_':{role:'Muscle 1',pass:'_B3_C1_',fail:'_B2_C2_'},'_B3_C1_':{role:'Sniper',pass:'_B4S_',fail:'_B3F_'},'_A1_C2_':{roles:['Lookout','Muscle 1'],pass:'_A2_C1_',fail:'_A1_C3_'},'_A1_C3_':{roles:['Enforcer','Muscle 3'],pass:'_A2_C1_',fail:'_A1F_'},'_A4_C1_':{role:'Enforcer',pass:'_A5_C1_',fail:'_B2_C1_'},'_A5_C1_':{roles:['Lookout','Sniper'],pass:'_A6S_',fail:'_A7S_'},'_B2_C2_':{roles:['Sniper','Driver'],pass:'_B2S_',fail:'_B2F_'},'_A6S_':{end:true,payout:1.0},'_B4S_':{end:true,payout:1.0},'_A7S_':{end:true,payout:1.0},'_B2S_':{end:true,payout:1.0},'_B3F_':{end:true,payout:0},'_B2F_':{end:true,payout:0},'_B1F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0}}},
  'Mob Mentality':{level:1,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Looter 1',pass:'_A2_C1_',fail:'_A1_C2_'},'_A1_C2_':{role:'Looter 2',pass:'_A2_C1_',fail:'_A1_C3_'},'_A2_C1_':{role:'Looter 2',pass:'_A3_C1_',fail:'_A2_C2_'},'_A3_C1_':{role:'Looter 3',pass:'_A4_C1_',fail:'_A3_C2_'},'_A3_C2_':{role:'Looter 4',pass:'_A4_C1_',fail:'_A3_C3_'},'_A4_C1_':{role:'Looter 2',pass:'_A5_C1_',fail:'_A4_C2_'},'_A4_C2_':{role:'Looter 1',pass:'_B1_C1_',fail:'_A4F_'},'_B1_C1_':{role:'Looter 4',pass:'_B2S_',fail:'_B3S_'},'_A1_C3_':{role:'Looter 3',pass:'_A2_C1_',fail:'_A1F_'},'_A2_C2_':{role:'Looter 4',pass:'_A3_C1_',fail:'_A2_C3_'},'_A2_C3_':{roles:['Looter 2','Looter 3'],pass:'_A3_C1_',fail:'_A2F_'},'_A5_C1_':{role:'Looter 4',pass:'_A7_C1_',fail:'_A5_C2_'},'_A7_C1_':{role:'Looter 2',pass:'_A7S_',fail:'_A7S2_'},'_A3_C3_':{role:'Looter 1',pass:'_D1_C1_',fail:'_A3_C4_'},'_D1_C1_':{role:'Looter 3',pass:'_D3S_',fail:'_D2F_'},'_A5_C2_':{role:'Looter 1',pass:'_A7S2_',fail:'_A5F_'},'_A3_C4_':{role:'Looter 2',pass:'_D1_C1_',fail:'_D1_C1_'},'_B2S_':{end:true,payout:0.8423},'_A7S2_':{end:true,payout:0.9279},'_A7S_':{end:true,payout:1.0},'_D3S_':{end:true,payout:0.524},'_B3S_':{end:true,payout:0.7518},'_A4F_':{end:true,payout:0},'_D2F_':{end:true,payout:0},'_A5F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0}}},
  'Gaslight the Way':{level:3,start:'_A1_C1_',nodes:{'_A1_C1_':{roles:['Imitator 1','Looter 1'],pass:'_A2_C1_',fail:'_A1_C2_'},'_A2_C1_':{role:'Imitator 2',pass:'_A3_C1_',fail:'_A2_C2_'},'_A3_C1_':{role:'Imitator 3',pass:'_A4_C1_',fail:'_A3_C2_'},'_A4_C1_':{role:'Looter 3',pass:'_A5_C1_',fail:'_A4_C2_'},'_A4_C2_':{role:'Looter 3',pass:'_A5_C1_',fail:'_A5_C1_'},'_A5_C1_':{roles:['Looter 2','Looter 3'],pass:'_A7_C1_',fail:'_B7_C1_'},'_A7_C1_':{role:'Imitator 2',pass:'_A7S_',fail:'_A7S2_'},'_A2_C2_':{role:'Imitator 2',pass:'_A3_C1_',fail:'_A2F_'},'_A3_C2_':{role:'Imitator 3',pass:'_B8_C1_',fail:'_A3F_'},'_A1_C2_':{roles:['Imitator 1','Looter 1'],pass:'_A2_C1_',fail:'_A1_C3_'},'_B7_C1_':{role:'Imitator 2',pass:'_B7S_',fail:'_B7S2_'},'_B8_C1_':{role:'Looter 3',pass:'_B9S_',fail:'_B8F_'},'_A1_C3_':{roles:['Imitator 1','Looter 1'],pass:'_A2_C1_',fail:'_A1F_'},'_A7S_':{end:true,payout:1.0},'_B7S_':{end:true,payout:1.0},'_B7S2_':{end:true,payout:1.0},'_A7S2_':{end:true,payout:1.0},'_B9S_':{end:true,payout:1.0},'_B8F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_A3F_':{end:true,payout:0}}},
  'Smoke and Wing Mirrors':{level:3,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Imitator',pass:'_A2_C1_',fail:'_A1_C2_'},'_A1_C2_':{roles:['Car Thief','Thief'],pass:'_A2_C1_',fail:'_A1_C3_'},'_A2_C1_':{role:'Imitator',pass:'_A3_C1_',fail:'_A2_C2_'},'_A3_C1_':{roles:['Car Thief','Thief'],pass:'_A4_C1_',fail:'_A3_C2_'},'_A4_C1_':{roles:['Hustler 1','Hustler 2'],pass:'_A5_C1_',fail:'_A4_C2_'},'_A5_C1_':{roles:['Car Thief','Thief'],pass:'_A6_C1_',fail:'_A5_C2_'},'_A6_C1_':{role:'Hustler 1',pass:'_A7S_',fail:'_A6_C2_'},'_A6_C2_':{roles:['Car Thief','Thief'],pass:'_A8S_',fail:'_A6_C3_'},'_A1_C3_':{role:'Imitator',pass:'_A2_C1_',fail:'_A1F_'},'_A6_C3_':{roles:['Car Thief','Thief'],pass:'_A9S_',fail:'_A6F_'},'_A2_C2_':{role:'Imitator',pass:'_A3_C1_',fail:'_A2_C3_'},'_A2_C3_':{roles:['Car Thief','Thief'],pass:'_A3_C1_',fail:'_A2F_'},'_A3_C2_':{roles:['Car Thief','Thief'],pass:'_A4_C1_',fail:'_A3F_'},'_A4_C2_':{role:'Hustler 2',pass:'_B2_C1_',fail:'_A4_C3_'},'_A4_C3_':{role:'Hustler 2',pass:'_B2_C1_',fail:'_A4F_'},'_A5_C2_':{role:'Imitator',pass:'_B3_C1_',fail:'_C1F_'},'_B2_C1_':{role:'Hustler 1',pass:'_B3_C1_',fail:'_B2_C2_'},'_B3_C1_':{role:'Imitator',pass:'_B3S_',fail:'_B3S2_'},'_B2_C2_':{role:'Hustler 2',pass:'_B3_C1_',fail:'_B2F_'},'_A8S_':{end:true,payout:1.0},'_A7S_':{end:true,payout:1.0},'_B3S2_':{end:true,payout:1.0},'_B3S_':{end:true,payout:1.0},'_A9S_':{end:true,payout:1.0},'_B2F_':{end:true,payout:0},'_A4F_':{end:true,payout:0},'_A6F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_C1F_':{end:true,payout:0}}},
  'Stacking the Deck':{level:8,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Cat Burglar',pass:'_A2_C1_',fail:'_A1_C2_'},'_A2_C1_':{role:'Driver',pass:'_A3_C1_',fail:'_A2_C2_'},'_A2_C2_':{role:'Driver',pass:'_A3_C1_',fail:'_B1_C1_'},'_A3_C1_':{role:'Cat Burglar',pass:'_A4_C1_',fail:'_B1_C1_'},'_B1_C1_':{role:'Imitator',pass:'_B2_C1_',fail:'_B1_C2_'},'_B1_C2_':{role:'Imitator',pass:'_B2_C1_',fail:'_B1F_'},'_A1_C2_':{roles:['Cat Burglar','Imitator'],pass:'_A2_C1_',fail:'_A1F_'},'_A4_C1_':{role:'Hacker',pass:'_A5_C1_',fail:'_B2_C1_'},'_B2_C1_':{role:'Hacker',pass:'_B3_C1_',fail:'_B2_C2_'},'_B2_C2_':{role:'Imitator',pass:'_B3_C1_',fail:'_B2F_'},'_B3_C1_':{role:'Imitator',pass:'_B4_C1_',fail:'_B3_C2_'},'_B4_C1_':{role:'Hacker',pass:'_B5S_',fail:'_B4S_'},'_A5_C1_':{role:'Hacker',pass:'_A6_C1_',fail:'_A5_C2_'},'_A5_C2_':{role:'Imitator',pass:'_A6S_',fail:'_A5F_'},'_A6_C1_':{role:'Imitator',pass:'_A7S_',fail:'_A6S_'},'_B3_C2_':{role:'Hacker',pass:'_B4S_',fail:'_B3F_'},'_A7S_':{end:true,payout:1.0},'_B3F_':{end:true,payout:0},'_B2F_':{end:true,payout:0},'_B5S_':{end:true,payout:1.0},'_A5F_':{end:true,payout:0},'_A6S_':{end:true,payout:1.0},'_B1F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_B4S_':{end:true,payout:1.0}}},
  'Best of the Lot':{level:2,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Picklock',pass:'_A2_C1_',fail:'_A1_C2_'},'_A2_C1_':{role:'Imitator',pass:'_A3_C1_',fail:'_A2_C2_'},'_A2_C2_':{role:'Muscle',pass:'_A3_C1_',fail:'_A2_C3_'},'_A2_C3_':{role:'Imitator',pass:'_A3_C1_',fail:'_A2F_'},'_A3_C1_':{roles:['Car Thief','Thief'],pass:'_A4_C1_',fail:'_A3_C2_'},'_A3_C2_':{role:'Muscle',pass:'_A4_C3_',fail:'_A3_C3_'},'_A4_C3_':{role:'Muscle',pass:'_B1_C1_',fail:'_A4F_'},'_B1_C1_':{role:'Imitator',pass:'_B2S_',fail:'_B1_C2_'},'_A3_C3_':{role:'Imitator',pass:'_A4_C3_',fail:'_A3F_'},'_B1_C2_':{roles:['Picklock','Muscle'],pass:'_B3S_',fail:'_B1F_'},'_A4_C1_':{role:'Picklock',pass:'_A5_C1_',fail:'_A4_C2_'},'_A4_C2_':{roles:['Car Thief','Picklock','Thief'],pass:'_B1_C1_',fail:'_A4_C3_'},'_A1_C2_':{role:'Muscle',pass:'_A2_C1_',fail:'_A1_C3_'},'_A5_C1_':{role:'Muscle',pass:'_A6S_',fail:'_A5_C2_'},'_A5_C2_':{role:'Imitator',pass:'_A7S_',fail:'_A8S_'},'_A1_C3_':{roles:['Car Thief','Muscle','Thief'],pass:'_A1F2_',fail:'_A1F1_'},'_B2S_':{end:true,payout:1.0},'_B3S_':{end:true,payout:1.0},'_A8S_':{end:true,payout:1.0},'_A7S_':{end:true,payout:1.0},'_A6S_':{end:true,payout:1.0},'_A4F_':{end:true,payout:0},'_A1F1_':{end:true,payout:1.0},'_A3F_':{end:true,payout:0},'_B1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_A1F2_':{end:true,payout:1.0}}},
  'Pet Project':{level:1,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Picklock',pass:'_A2_C1_',fail:'_A1_C2_'},'_A2_C1_':{role:'Kidnapper',pass:'_A3_C1_',fail:'_A2_C2_'},'_A3_C1_':{role:'Kidnapper',pass:'_A4_C1_',fail:'_A3_C2_'},'_A4_C1_':{role:'Muscle',pass:'_A5_C1_',fail:'_C1_C1_'},'_A5_C1_':{role:'Kidnapper',pass:'_A6_C1_',fail:'_A5_C2_'},'_A6_C1_':{role:'Muscle',pass:'_A7_C1_',fail:'_A6_C2_'},'_A6_C2_':{role:'Picklock',pass:'_A7_C1_',fail:'_A6_C3_'},'_A6_C3_':{role:'Muscle',pass:'_A8S_',fail:'_A6F_'},'_A2_C2_':{role:'Kidnapper',pass:'_A3_C1_',fail:'_B1_C1_'},'_A3_C2_':{role:'Muscle',pass:'_A4_C1_',fail:'_C1_C1_'},'_C1_C1_':{roles:['Picklock','Kidnapper'],pass:'_C3S_',fail:'_C1F_'},'_A1_C2_':{role:'Muscle',pass:'_B1_C1_',fail:'_A1_C3_'},'_A1_C3_':{role:'Picklock',pass:'_A2_C1_',fail:'_A1F_'},'_A7_C1_':{role:'Picklock',pass:'_A7S1_',fail:'_A7_C2_'},'_A5_C2_':{role:'Muscle',pass:'_A6_C1_',fail:'_C1_C1_'},'_B1_C1_':{role:'Muscle',pass:'_B2_C1_',fail:'_B1_C2_'},'_B1_C2_':{role:'Muscle',pass:'_B2_C1_',fail:'_B1F_'},'_A7_C2_':{role:'Muscle',pass:'_A7S2_',fail:'_A7F_'},'_B2_C1_':{role:'Kidnapper',pass:'_B3S_',fail:'_B2F_'},'_C3S_':{end:true,payout:0.6444},'_A7S1_':{end:true,payout:1.0},'_A7S2_':{end:true,payout:0.8871},'_B3S_':{end:true,payout:0.6142},'_A8S_':{end:true,payout:0.7874},'_A7F_':{end:true,payout:0},'_B2F_':{end:true,payout:0},'_A6F_':{end:true,payout:0},'_B1F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_C1F_':{end:true,payout:0}}},
  'Ace in the Hole':{level:9,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Imitator',pass:'_A2_C1_',fail:'_B2_C1_'},'_A2_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_A3_C1_',fail:'_A2_C2_'},'_A3_C1_':{role:'Hacker',pass:'_A4_C1_',fail:'_A3_C2_'},'_A3_C2_':{role:'Hacker',pass:'_A4_C1_',fail:'_A3_C3_'},'_A4_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_A5_C1_',fail:'_A4_C2_'},'_A4_C2_':{role:'Imitator',pass:'_A5_C1_',fail:'_A4_C3_'},'_A5_C1_':{role:'Driver',pass:'_A6_C1_',fail:'_A5_C2_'},'_A6_C1_':{role:'Hacker',pass:'_A7_C1_',fail:'_C6_C1_'},'_A7_C1_':{role:'Imitator',pass:'_A8S_',fail:'_A7_C2_'},'_A7_C2_':{roles:['Muscle 1','Muscle 2'],pass:'_A9S_',fail:'_A10S_'},'_C6_C1_':{role:'Imitator',pass:'_C7_C1_',fail:'_C6_C2_'},'_C7_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_C8S_',fail:'_C7F_'},'_B2_C1_':{role:'Muscle 2',pass:'_B3_C1_',fail:'_B2_C2_'},'_B3_C1_':{role:'Hacker',pass:'_B4_C1_',fail:'_B3_C2_'},'_B4_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_B5_C1_',fail:'_B4_C2_'},'_B5_C1_':{role:'Driver',pass:'_B6_C1_',fail:'_B5_C2_'},'_B5_C2_':{role:'Driver',pass:'_D6_C1_',fail:'_B5F_'},'_A4_C3_':{roles:['Imitator','Muscle 2'],pass:'_A5_C1_',fail:'_A4F_'},'_A5_C2_':{role:'Driver',pass:'_A6_C1_',fail:'_A5_C3_'},'_B3_C2_':{role:'Hacker',pass:'_B4_C1_',fail:'_B3F_'},'_A5_C3_':{role:'Driver',pass:'_A6_C1_',fail:'_C6_C1_'},'_C6_C2_':{roles:['Imitator','Muscle 2'],pass:'_C9S_',fail:'_C6F_'},'_B2_C2_':{roles:['Muscle 1','Muscle 2'],pass:'_B3_C1_',fail:'_B2F_'},'_D6_C1_':{role:'Hacker',pass:'_D7S_',fail:'_D6_C2_'},'_B6_C1_':{role:'Hacker',pass:'_B7S_',fail:'_B6_C2_'},'_A3_C3_':{role:'Hacker',pass:'_A4_C1_',fail:'_A3F_'},'_A2_C2_':{role:'Muscle 1',pass:'_A3_C1_',fail:'_A2_C3_'},'_B4_C2_':{role:'Muscle 1',pass:'_B5_C1_',fail:'_B4F_'},'_D6_C2_':{role:'Hacker',pass:'_D7S_',fail:'_D6F_'},'_B6_C2_':{role:'Hacker',pass:'_B7S_',fail:'_B6F_'},'_A2_C3_':{roles:['Muscle 2','Muscle 1'],pass:'_A3_C1_',fail:'_A2F_'},'_A10S_':{end:true,payout:0.7343},'_C8S_':{end:true,payout:0.6766},'_A8S_':{end:true,payout:1.0},'_D7S_':{end:true,payout:0.6101},'_B7S_':{end:true,payout:0.7793},'_C9S_':{end:true,payout:0.5883},'_A9S_':{end:true,payout:0.7904},'_D6F_':{end:true,payout:0},'_C7F_':{end:true,payout:0},'_B3F_':{end:true,payout:0},'_B2F_':{end:true,payout:0},'_C6F_':{end:true,payout:0},'_A4F_':{end:true,payout:0},'_B4F_':{end:true,payout:0},'_B6F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_B5F_':{end:true,payout:0}}},
  'Crane Reaction':{level:10,start:'_A1_C1_',nodes:{'_A1_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_A2_C1_',fail:'_A1_C2_'},'_A1_C2_':{roles:['Sniper','Muscle 2'],pass:'_A2_C1_',fail:'_A1_C3_'},'_A1_C3_':{roles:['Muscle 1','Muscle 2'],pass:'_A2_C1_',fail:'_A1F_'},'_A2_C1_':{roles:['Engineer','Lookout'],pass:'_A3_C1_',fail:'_A2_C2_'},'_A3_C1_':{role:'Bomber',pass:'_A4_C1_',fail:'_A3_C2_'},'_A3_C2_':{roles:['Sniper','Bomber'],pass:'_A4_C1_',fail:'_A3F_'},'_A4_C1_':{roles:['Lookout','Sniper','Muscle 1','Muscle 2'],pass:'_A5_C1_',fail:'_A4_C2_'},'_A4_C2_':{roles:['Lookout','Sniper'],pass:'_A5_C1_',fail:'_A4_C3_'},'_A5_C1_':{roles:['Engineer','Bomber'],pass:'_A6_C1_',fail:'_A5_C2_'},'_A5_C2_':{roles:['Engineer','Bomber'],pass:'_A6_C1_',fail:'_B5_C1_'},'_B5_C1_':{roles:['Engineer','Bomber'],pass:'_B6_C1_',fail:'_B5_C2_'},'_B5_C2_':{roles:['Engineer','Bomber'],pass:'_B6_C1_',fail:'_B5F_'},'_A2_C2_':{roles:['Sniper','Driver'],pass:'_A3_C1_',fail:'_A2F_'},'_A6_C1_':{roles:['Lookout','Sniper'],pass:'_A7_C1_',fail:'_A6_C2_'},'_A6_C2_':{roles:['Muscle 1','Muscle 2'],pass:'_B7_C1_',fail:'_B6_C1_'},'_B7_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_B7S_',fail:'_B7_C2_'},'_B7_C2_':{roles:['Lookout','Sniper'],pass:'_B7S2_',fail:'_B7F_'},'_A7_C1_':{roles:['Muscle 2','Muscle 1'],pass:'_A8S_',fail:'_A7_C2_'},'_A7_C2_':{role:'Bomber',pass:'_A8S2_',fail:'_A7_C3_'},'_A4_C3_':{roles:['Muscle 1','Muscle 2'],pass:'_A5_C1_',fail:'_A4F_'},'_B6_C1_':{roles:['Lookout','Sniper'],pass:'_B7_C1_',fail:'_B6_C2_'},'_B6_C2_':{role:'Lookout',pass:'_B7_C1_',fail:'_B6F_'},'_A7_C3_':{roles:['Engineer','Muscle 1','Muscle 2'],pass:'_A8S3_',fail:'_A7F_'},'_A8S_':{end:true,payout:1.0},'_A8S2_':{end:true,payout:1.0},'_B7S_':{end:true,payout:1.0},'_A8S3_':{end:true,payout:1.0},'_B7S2_':{end:true,payout:1.0},'_A7F_':{end:true,payout:0},'_A4F_':{end:true,payout:0},'_B7F_':{end:true,payout:0},'_B6F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_B5F_':{end:true,payout:0}}},
  'Gone Fission':{level:9,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Hijacker',pass:'_A2_C1_',fail:'_A1_C2_'},'_A2_C1_':{role:'Hijacker',pass:'_A3_C1_',fail:'_A2_C2_'},'_A2_C2_':{roles:['Hijacker','Engineer'],pass:'_A3_C1_',fail:'_A2F_'},'_A1_C2_':{roles:['Hijacker','Bomber'],pass:'_A2_C1_',fail:'_A1_C3_'},'_A3_C1_':{role:'Engineer',pass:'_A4_C1_',fail:'_A3_C2_'},'_A3_C2_':{roles:['Engineer','Bomber'],pass:'_A4_C1_',fail:'_A3_C3_'},'_A4_C1_':{role:'Imitator',pass:'_A5_C1_',fail:'_A4_C2_'},'_A4_C2_':{role:'Pickpocket',pass:'_A5_C1_',fail:'_A4_C3_'},'_A5_C1_':{roles:['Pickpocket','Imitator'],pass:'_A6_C1_',fail:'_A5_C2_'},'_A6_C1_':{role:'Bomber',pass:'_A7_C1_',fail:'_A6_C2_'},'_A6_C2_':{role:'Bomber',pass:'_A7_C1_',fail:'_A6_C3_'},'_A7_C1_':{role:'Imitator',pass:'_A8S_',fail:'_A7_C2_'},'_A4_C3_':{role:'Imitator',pass:'_A5_C1_',fail:'_A4F_'},'_A5_C2_':{roles:['Pickpocket','Imitator'],pass:'_A6_C1_',fail:'_A5F_'},'_A7_C2_':{role:'Engineer',pass:'_A8S2_',fail:'_A8S3_'},'_A1_C3_':{role:'Hijacker',pass:'_A2_C1_',fail:'_A1C3F_'},'_A6_C3_':{roles:['Pickpocket','Bomber'],pass:'_A7_C1_',fail:'_A6F_'},'_A3_C3_':{role:'Engineer',pass:'_A4_C1_',fail:'_A3F_'},'_A8S_':{end:true,payout:1.0},'_A8S2_':{end:true,payout:1.0},'_A1C3F_':{end:true,payout:0},'_A5F_':{end:true,payout:0},'_A4F_':{end:true,payout:0},'_A6F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_A8S3_':{end:true,payout:1.0}}},
  'Manifest Cruelty':{level:8,start:'_A1_C1_',nodes:{'_A1_C1_':{roles:['Cat Burglar','Interrogator'],pass:'_A2_C1_',fail:'_A1_C2_'},'_A2_C1_':{role:'Interrogator',pass:'_A3_C1_',fail:'_A2_C2_'},'_A3_C1_':{role:'Cat Burglar',pass:'_A4_C1_',fail:'_B4_C1_'},'_A4_C1_':{role:'Hacker',pass:'_A5_C1_',fail:'_B4_C1_'},'_A5_C1_':{roles:['Interrogator','Reviver'],pass:'_A6_C1_',fail:'_A5_C2_'},'_A5_C2_':{role:'Reviver',pass:'_A6_C1_',fail:'_A5F_'},'_A6_C1_':{role:'Hacker',pass:'_A7_C1_',fail:'_A6_C2_'},'_A7_C1_':{role:'Interrogator',pass:'_A8S_',fail:'_A7_C2_'},'_A7_C2_':{roles:['Interrogator','Reviver'],pass:'_A7S_',fail:'_A7F_'},'_A1_C2_':{roles:['Reviver','Hacker'],pass:'_A2_C1_',fail:'_A1_C3_'},'_A2_C2_':{role:'Interrogator',pass:'_A3_C1_',fail:'_A2_C3_'},'_A6_C2_':{role:'Cat Burglar',pass:'_A7_C1_',fail:'_A6_C3_'},'_B4_C1_':{role:'Interrogator',pass:'_B5_C1_',fail:'_B4_C2_'},'_B5_C1_':{role:'Reviver',pass:'_B6_C1_',fail:'_B5_C2_'},'_B6_C1_':{roles:['Cat Burglar','Hacker'],pass:'_B7S_',fail:'_B6_C2_'},'_B4_C2_':{role:'Reviver',pass:'_B5_C1_',fail:'_B4_C3_'},'_B4_C3_':{roles:['Interrogator','Reviver'],pass:'_B5_C1_',fail:'_B4F_'},'_A2_C3_':{roles:['Interrogator','Reviver'],pass:'_A3_C1_',fail:'_A2F_'},'_A1_C3_':{roles:['Reviver','Hacker'],pass:'_A2_C1_',fail:'_A1F_'},'_B5_C2_':{role:'Reviver',pass:'_B6_C1_',fail:'_B5F_'},'_B6_C2_':{roles:['Cat Burglar','Hacker'],pass:'_B7S_',fail:'_B6F_'},'_A6_C3_':{roles:['Cat Burglar','Hacker'],pass:'_A7_C1_',fail:'_A6F_'},'_A8S_':{end:true,payout:1.0},'_A7S_':{end:true,payout:1.0},'_A7F_':{end:true,payout:0},'_A5F_':{end:true,payout:0},'_A6F_':{end:true,payout:0},'_B4F_':{end:true,payout:0},'_B6F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_B7S_':{end:true,payout:1.0},'_B5F_':{end:true,payout:0}}},
  'Cash Me If You Can':{level:2,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Thief 1',pass:'_A2_C1_',fail:'_A1_C2_'},'_A1_C2_':{role:'Thief 1',pass:'_A2_C1_',fail:'_A1_C3_'},'_A2_C1_':{role:'Thief 2',pass:'_A3_C1_',fail:'_A2_C2_'},'_A2_C2_':{role:'Thief 1',pass:'_A3_C1_',fail:'_A2_C3_'},'_A3_C1_':{role:'Thief 1',pass:'_A4_C1_',fail:'_A3_C2_'},'_A4_C1_':{role:'Thief 2',pass:'_A5_C1_',fail:'_A4_C2_'},'_A5_C1_':{role:'Lookout',pass:'_A6_C1_',fail:'_B1_C1_'},'_B1_C1_':{role:'Thief 1',pass:'_B2_C1_',fail:'_B1F_'},'_B2_C1_':{role:'Lookout',pass:'_B3S_',fail:'_B2F_'},'_A4_C2_':{role:'Thief 1',pass:'_A4S_',fail:'_B1_C1_'},'_A3_C2_':{role:'Thief 1',pass:'_A4_C1_',fail:'_A3_C3_'},'_A2_C3_':{role:'Thief 2',pass:'_A3_C1_',fail:'_A2F_'},'_A1_C3_':{roles:['Thief 2','Thief 1'],pass:'_A2_C1_',fail:'_A1F_'},'_A3_C3_':{role:'Thief 2',pass:'_C1_C1_',fail:'_B1F_'},'_C1_C1_':{role:'Thief 1',pass:'_C2S_',fail:'_C1F_'},'_A6_C1_':{role:'Thief 2',pass:'_A7S_',fail:'_A8S_'},'_B3S_':{end:true,payout:0.751},'_A4S_':{end:true,payout:0.8739},'_A8S_':{end:true,payout:0.8977},'_A7S_':{end:true,payout:1.0},'_C2S_':{end:true,payout:0.5534},'_B2F_':{end:true,payout:0},'_B1F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_C1F_':{end:true,payout:0}}},
  'First Aid and Abet':{level:1,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Decoy',pass:'_A2_C1_',fail:'_A2_C1_'},'_A2_C1_':{role:'Picklock',pass:'_A3_C1_',fail:'_A2_C2_'},'_A3_C1_':{role:'Pickpocket',pass:'_A3S_',fail:'_A3_C2_'},'_A3_C2_':{role:'Picklock',pass:'_A3S_',fail:'_A3F_'},'_A2_C2_':{role:'Pickpocket',pass:'_A3_C1_',fail:'_A2F_'},'_A3S_':{end:true,payout:1.0},'_A3F_':{end:true,payout:0},'_A2F_':{end:true,payout:0}}},
  'Market Forces':{level:3,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Lookout',pass:'_A2_C1_',fail:'_A1_C2_'},'_A2_C1_':{role:'Negotiator',pass:'_A3_C1_',fail:'_A2_C2_'},'_A3_C1_':{role:'Enforcer',pass:'_A4_C1_',fail:'_A3_C2_'},'_A3_C2_':{role:'Negotiator',pass:'_A4_C1_',fail:'_A3_C3_'},'_A4_C1_':{role:'Arsonist',pass:'_A5_C1_',fail:'_A4_C2_'},'_A4_C2_':{role:'Arsonist',pass:'_B5_C1_',fail:'_A4S_'},'_B5_C1_':{role:'Muscle',pass:'_B5S_',fail:'_B5_C2_'},'_B5_C2_':{roles:['Enforcer','Lookout'],pass:'_B5S_',fail:'_B5F_'},'_A1_C2_':{role:'Enforcer',pass:'_A2_C1_',fail:'_A1F_'},'_A5_C1_':{role:'Muscle',pass:'_A7_C1_',fail:'_A5_C2_'},'_A7_C1_':{role:'Negotiator',pass:'_A8_C1_',fail:'_A7_C2_'},'_A7_C2_':{role:'Negotiator',pass:'_A8_C1_',fail:'_A7S_'},'_A8_C1_':{role:'Muscle',pass:'_A8S_',fail:'_A8S2_'},'_A2_C2_':{role:'Muscle',pass:'_A3_C1_',fail:'_A2F_'},'_A5_C2_':{roles:['Enforcer','Lookout'],pass:'_A7_C1_',fail:'_A5S_'},'_A3_C3_':{role:'Muscle',pass:'_B4_C1_',fail:'_A3F_'},'_B4_C1_':{role:'Arsonist',pass:'_B5_C1_',fail:'_B4F_'},'_B5S_':{end:true,payout:0.5587},'_A8S_':{end:true,payout:1.0},'_A8S2_':{end:true,payout:0.9145},'_A7S_':{end:true,payout:0.8427},'_A4S_':{end:true,payout:0.7022},'_A5S_':{end:true,payout:0.6345},'_B4F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_B5F_':{end:true,payout:0}}},
  'Plucking the Lotus Petal':{level:4,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Muscle',pass:'_A2_C1_',fail:'_A1_C2_'},'_A1_C2_':{role:'Hustler',pass:'_A2_C1_',fail:'_A1F_'},'_A2_C1_':{role:'Hustler',pass:'_A3_C1_',fail:'_A2_C2_'},'_A2_C2_':{role:'Muscle',pass:'_A3_C1_',fail:'_A2F_'},'_A3_C1_':{role:'Robber',pass:'_A4_C1_',fail:'_A3_C2_'},'_A3_C2_':{role:'Robber',pass:'_A4_C1_',fail:'_A3F_'},'_A4_C1_':{role:'Robber',pass:'_A5S_',fail:'_A4_C2_'},'_A4_C2_':{role:'Hustler',pass:'_A5S2_',fail:'_A4F_'},'_A5S_':{end:true,payout:1.0},'_A5S2_':{end:true,payout:0.75},'_A4F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0}}},
  'Window of Opportunity':{level:7,start:'_A1_C1_',nodes:{'_A1_C1_':{role:'Engineer',pass:'_A2_C1_',fail:'_A1_C2_'},'_A1_C2_':{roles:['Muscle 1','Muscle 2'],pass:'_A2_C1_',fail:'_A1F_'},'_A2_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_A3_C1_',fail:'_A2_C2_'},'_A2_C2_':{role:'Engineer',pass:'_A3_C1_',fail:'_A2F_'},'_A3_C1_':{role:'Looter 1',pass:'_A4_C1_',fail:'_A3_C2_'},'_A3_C2_':{role:'Looter 2',pass:'_A4_C1_',fail:'_A3F_'},'_A4_C1_':{role:'Looter 2',pass:'_A5_C1_',fail:'_A4_C2_'},'_A4_C2_':{roles:['Muscle 1','Muscle 2'],pass:'_A5_C1_',fail:'_A4F_'},'_A5_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_A5S_',fail:'_A5_C2_'},'_A5_C2_':{role:'Engineer',pass:'_A5S2_',fail:'_A5F_'},'_A5S_':{end:true,payout:1.0},'_A5S2_':{end:true,payout:1.0},'_A4F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_A5F_':{end:true,payout:0}}},
};

// ── OC METADATA ──────────────────────────────────────────────
const OC_METADATA = {
  'First Aid and Abet':       {rewardType:'items',maxPayout:0,         itemDesc:'Medical items + respect'},
  'Mob Mentality':            {rewardType:'cash', maxPayout:1500000,   itemDesc:''},
  'Pet Project':              {rewardType:'cash', maxPayout:806000,    itemDesc:''},
  'Cash Me If You Can':       {rewardType:'cash', maxPayout:1601000,   itemDesc:''},
  'Best of the Lot':          {rewardType:'items',maxPayout:0,         itemDesc:'Luxury car + respect'},
  'Smoke and Wing Mirrors':   {rewardType:'items',maxPayout:0,         itemDesc:'Luxury car + respect'},
  'Market Forces':            {rewardType:'cash', maxPayout:8575000,   itemDesc:''},
  'Gaslight the Way':         {rewardType:'items',maxPayout:0,         itemDesc:'Alcohol/energy drinks + respect'},
  'Snow Blind':               {rewardType:'cash', maxPayout:10565000,  itemDesc:''},
  'Plucking the Lotus Petal': {rewardType:'cash', maxPayout:8976000,   itemDesc:''},
  'Stage Fright':             {rewardType:'items',maxPayout:0,         itemDesc:'~30 Xanax + respect'},
  'Guardian Angels':          {rewardType:'cash', maxPayout:8883000,   itemDesc:''},
  'Counter Offer':            {rewardType:'items',maxPayout:0,         itemDesc:'Grey weapons (~$24M sell value) + respect'},
  'No Reserve':               {rewardType:'chain',maxPayout:0,         itemDesc:'Unlocks Bidding War'},
  'Honey Trap':               {rewardType:'cash', maxPayout:25671000,  itemDesc:''},
  'Bidding War':              {rewardType:'cash', maxPayout:133980000, itemDesc:''},
  'Leave No Trace':           {rewardType:'cash', maxPayout:13474000,  itemDesc:''},
  'Sneaky Git Grab':          {rewardType:'cash', maxPayout:38757000,  itemDesc:''},
  'Blast from the Past':      {rewardType:'cash', maxPayout:202382000, itemDesc:''},
  'Window of Opportunity':    {rewardType:'items',maxPayout:0,         itemDesc:'Rare art/weapons + respect'},
  'Break the Bank':           {rewardType:'cash', maxPayout:395980000, itemDesc:''},
  'Clinical Precision':       {rewardType:'cash', maxPayout:122565000, itemDesc:''},
  'Stacking the Deck':        {rewardType:'chain',maxPayout:0,         itemDesc:'Unlocks Ace in the Hole'},
  'Manifest Cruelty':         {rewardType:'chain',maxPayout:0,         itemDesc:'Unlocks Gone Fission'},
  'Ace in the Hole':          {rewardType:'cash', maxPayout:579919000, itemDesc:''},
  'Gone Fission':             {rewardType:'chain',maxPayout:0,         itemDesc:'Unlocks Crane Reaction'},
  'Crane Reaction':           {rewardType:'items',maxPayout:0,         itemDesc:'Cesium-137 + 2001 respect'},
};

// ── ROLE COLOURS ─────────────────────────────────────────────
const ROLE_COLORS = {};

function computeRoleColors() {
  Object.entries(FLOWCHARTS).forEach(([ocName, oc]) => {
    const nodes = oc.nodes;
    ROLE_COLORS[ocName] = {};
    const dead = new Map(), safe = new Map(), total = new Map();
    Object.entries(nodes).forEach(([nodeId, node]) => {
      if (node.end) return;
      const roles = node.roles || (node.role ? [node.role] : []);
      roles.forEach(r => {
        total.set(r, (total.get(r)||0) + 1);
        const failNode = nodes[node.fail];
        if (failNode?.end && failNode?.payout === 0) dead.set(r, (dead.get(r)||0) + 1);
        else safe.set(r, (safe.get(r)||0) + 1);
      });
    });
    total.forEach((_, role) => {
      const d = dead.get(role)||0, s = safe.get(role)||0;
      ROLE_COLORS[ocName][role] = d > 0 && s === 0 ? 'red' : d === 0 && s > 0 ? 'green' : 'yellow';
    });
  });
  console.log('[SERVER] Role colours computed for', Object.keys(ROLE_COLORS).length, 'OCs');
}

// ── SIMULATION ───────────────────────────────────────────────
const BASELINE = 68;

function simulateOC(ocName, cprs) {
  const fg = FLOWCHARTS[ocName];
  if (!fg) return null;
  function getCPR(role) {
    if (cprs[role] !== undefined) return cprs[role] / 100;
    const base = role.replace(/\s+\d+$/, '');
    if (cprs[base] !== undefined) return cprs[base] / 100;
    return BASELINE / 100;
  }
  function walkSuccess(nodeId, prob, visited) {
    if (prob < 0.0001 || visited.has(nodeId)) return 0;
    const node = fg.nodes[nodeId]; if (!node) return 0;
    if (node.end) return node.payout > 0 ? prob : 0;
    visited.add(nodeId);
    const p = node.roles ? node.roles.reduce((a,r) => a + getCPR(r), 0) / node.roles.length : getCPR(node.role);
    const r = walkSuccess(node.pass, prob*p, new Set(visited)) + walkSuccess(node.fail, prob*(1-p), new Set(visited));
    visited.delete(nodeId); return r;
  }
  function walkEV(nodeId, prob, visited) {
    if (prob < 0.0001 || visited.has(nodeId)) return 0;
    const node = fg.nodes[nodeId]; if (!node) return 0;
    if (node.end) return prob * node.payout;
    visited.add(nodeId);
    const p = node.roles ? node.roles.reduce((a,r) => a + getCPR(r), 0) / node.roles.length : getCPR(node.role);
    const r = walkEV(node.pass, prob*p, new Set(visited)) + walkEV(node.fail, prob*(1-p), new Set(visited));
    visited.delete(nodeId); return r;
  }
  return {
    successChance: Math.round(walkSuccess(fg.start, 1.0, new Set()) * 100),
    expectedValue: walkEV(fg.start, 1.0, new Set()),
  };
}

// ── ROLE CLASSIFICATION ──────────────────────────────────────
const _roleClassCache = {};
function classifyRoles(ocName) {
  if (_roleClassCache[ocName]) return _roleClassCache[ocName];
  const fg = FLOWCHARTS[ocName]; if (!fg) return {};
  const counts = {}, deadEnds = {}, atStart = {};
  Object.entries(fg.nodes).forEach(([nodeId, node]) => {
    if (node.end) return;
    const roles = node.roles || (node.role ? [node.role] : []);
    roles.forEach(role => {
      counts[role] = (counts[role]||0) + 1;
      const failNode = fg.nodes[node.fail];
      if (failNode?.end && failNode?.payout === 0) deadEnds[role] = true;
      if (nodeId === fg.start) atStart[role] = true;
    });
  });
  const result = {};
  Object.keys(counts).forEach(role => {
    const base = getRoleBase(role);
    if (SAFE_ROLES.includes(role) || SAFE_ROLES.includes(base)) result[role] = 'safe';
    else if (atStart[role] && deadEnds[role]) result[role] = 'gate';
    else if (deadEnds[role]) result[role] = 'bottleneck';
    else if (counts[role] >= 3) result[role] = 'bottleneck';
    else if (counts[role] >= 2) result[role] = 'recovery';
    else result[role] = 'support';
  });
  _roleClassCache[ocName] = result; return result;
}
function roleTypePriority(t) { return {gate:4,bottleneck:3,recovery:2,support:1,safe:0}[t]||0; }

// ═══════════════════════════════════════════════════════════════
// OPTIMIZE ENGINE
// ═══════════════════════════════════════════════════════════════

function getMemberCPR(memberCPRs, memberName, ocName, role) {
  const d = memberCPRs[memberName]; if (!d) return null;
  const base = getRoleBase(role);
  for (const variant of [ocName, ocName+'s', ocName.replace(/s$/,'')]) {
    const ocData = d.cprs?.[variant]; if (!ocData) continue;
    const cpr = ocData[role] ?? ocData[base] ?? null;
    if (cpr !== null) return cpr;
  }
  return null;
}

const STALE_MS = 7 * 24 * 60 * 60 * 1000;
function isCPRStale(updatedAt) { return !updatedAt || Date.now() - new Date(updatedAt).getTime() > STALE_MS; }

async function optimizeFaction(factionId, ocs, requestingMember) {
  // Load empirical model
  let empirical = {};
  try {
    const r = await query(`SELECT oc_name, AVG(max_money)::BIGINT AS mean, COUNT(*) AS n FROM oc_payouts WHERE faction_id=$1 AND max_money>0 GROUP BY oc_name`, [factionId]);
    r.rows.forEach(row => { empirical[row.oc_name] = {meanPayout: parseInt(row.mean), samples: parseInt(row.n)}; });
  } catch(e) {}

  // Load CPR
  let memberCPRMap = {};
  try {
    const r = await query('SELECT member_name, source, cprs, updated_at FROM member_cpr WHERE faction_id=$1', [factionId]);
    r.rows.forEach(row => { memberCPRMap[row.member_name] = {cprs: row.cprs, source: row.source, updatedAt: row.updated_at, isStale: isCPRStale(row.updated_at)}; });
  } catch(e) { console.error('[OPTIMIZE] CPR load error:', e.message); }

  const memberPool = ocs[0]?.availableMembers || [];
  const roleClassifications = {};
  ocs.forEach(oc => { roleClassifications[oc.ocName] = classifyRoles(oc.ocName); });

  // Build impact matrix
  const impactMatrix = {};
  for (const member of memberPool) {
    impactMatrix[member.name] = {};
    for (const oc of ocs) {
      impactMatrix[member.name][oc.ocName] = {};
      const baseline = simulateOC(oc.ocName, oc.filledCPRs || {});
      if (!baseline) continue;
      for (const role of (oc.openRoles || [])) {
        let cpr = getMemberCPR(memberCPRMap, member.name, oc.ocName, role);
        let flag = null;
        if (cpr === null && memberCPRMap[member.name]) flag = 'cpr_unknown';
        else if (cpr !== null && memberCPRMap[member.name]?.isStale) flag = 'cpr_stale';
        else if (!memberCPRMap[member.name]) flag = 'no_data';
        const rc = getRoleCPRRange(role);
        const effectiveCPR = cpr !== null ? cpr : (rc.safe ? 50 : null);
        let delta = 0;
        if (effectiveCPR !== null) {
          const withMember = simulateOC(oc.ocName, {...(oc.filledCPRs||{}), [role]: effectiveCPR});
          delta = withMember ? withMember.successChance - baseline.successChance : 0;
        }
        impactMatrix[member.name][oc.ocName][role] = {delta, cpr, flag, roleType: roleClassifications[oc.ocName][role]||'support'};
      }
    }
  }

  // Priority queue
  // Score = (ocLevel × 1000) + (roleTypePriority × 100) + delta
  // Members with no CPR data on critical roles get a -500 penalty so they
  // never displace a CPR-known member from a high-level slot.
  // Members with known CPR below absolute minimum on critical roles also get
  // a penalty proportional to how far below they are.
  const queue = [];
  for (const member of memberPool) {
    for (const oc of ocs) {
      const ocLevel = FLOWCHARTS[oc.ocName]?.level || 1;
      for (const role of (oc.openRoles || [])) {
        const impact = impactMatrix[member.name]?.[oc.ocName]?.[role];
        if (!impact) continue;

        const rc = getRoleCPRRange(role);
        let priorityScore = (ocLevel * 1000) + (roleTypePriority(impact.roleType) * 100) + impact.delta;

        // Penalise no-CPR-data members on non-safe critical roles heavily —
        // they should only fill a slot if nobody with known CPR is available.
        if (impact.flag === 'no_data' && !rc.safe && impact.roleType !== 'safe') {
          priorityScore -= 500;
        }
        // Penalise unknown CPR (member exists in DB but no data for this OC/role)
        // on gate/bottleneck roles — less severe than no_data
        if (impact.flag === 'cpr_unknown' && ['gate','bottleneck'].includes(impact.roleType)) {
          priorityScore -= 200;
        }

        queue.push({
          member: member.name, memberStatus: member.status||'available',
          ocName: oc.ocName, ocLevel, role,
          roleType: impact.roleType, cpr: impact.cpr,
          delta: impact.delta, flag: impact.flag,
          priorityScore,
        });
      }
    }
  }
  queue.sort((a,b) => b.priorityScore - a.priorityScore);

  // Greedy assignment
  const usedMembers = new Set(), filledRoles = {}, assignments = {};
  for (const item of queue) {
    if (usedMembers.has(item.member) || filledRoles[item.ocName]?.[item.role]) continue;
    if (!filledRoles[item.ocName]) filledRoles[item.ocName] = {};
    if (!assignments[item.ocName]) assignments[item.ocName] = [];
    filledRoles[item.ocName][item.role] = item.member;
    assignments[item.ocName].push({role: item.role, member: item.member, memberStatus: item.memberStatus, cpr: item.cpr, roleType: item.roleType, roleColor: ROLE_COLORS[item.ocName]?.[item.role]||'yellow', impact: parseFloat(item.delta.toFixed(1)), flag: item.flag});
    usedMembers.add(item.member);
  }

  // Score teams
  const optimizedOCs = [];
  for (const oc of ocs) {
    const ocLevel = FLOWCHARTS[oc.ocName]?.level || 1;
    const breakeven = SCOPE_BREAKEVEN[ocLevel] || 0.75;
    const baseline  = simulateOC(oc.ocName, oc.filledCPRs || {});
    const assembled = {...(oc.filledCPRs||{})};
    (assignments[oc.ocName]||[]).forEach(a => { if (a.cpr !== null) assembled[a.role] = a.cpr; });
    const projected = simulateOC(oc.ocName, assembled);
    const projectedSC = projected?.successChance || 0;
    const meta = OC_METADATA[oc.ocName] || {rewardType:'cash', maxPayout:0};
    const emp  = empirical[oc.ocName];
    const basis = (emp?.samples >= 5 ? emp.meanPayout : 0) || meta.maxPayout || (ocLevel * 1000000);
    const lvlBonus = 1 + (ocLevel - 1) * 0.05;
    const filledInOC = new Set((assignments[oc.ocName]||[]).map(a => a.role));
    const unfilledRoles = (oc.openRoles||[]).filter(r => !filledInOC.has(r));
    let status = projectedSC < breakeven*100-10 ? 'at_risk' : projectedSC < breakeven*100 ? 'marginal' : 'optimal';
    optimizedOCs.push({
      ocName: oc.ocName, level: ocLevel,
      rewardType: meta.rewardType, itemDesc: meta.itemDesc||'',
      empiricalPayout: emp?.meanPayout || null, empiricalSamples: emp?.samples || 0,
      projectedSuccess: projectedSC, currentSuccess: baseline?.successChance||0,
      improvement: projectedSC - (baseline?.successChance||0),
      scopeBreakeven: Math.round(breakeven*100), status,
      team: assignments[oc.ocName] || [],
      unfilledRoles: unfilledRoles.map(r => ({role:r, roleType: roleClassifications[oc.ocName]?.[r]||'support', urgent: ['gate','bottleneck'].includes(roleClassifications[oc.ocName]?.[r])})),
    });
  }
  optimizedOCs.sort((a,b) => b.level - a.level);

  // Suboptimal
  const suboptimalPlacements = [];
  for (const oc of ocs) {
    for (const placement of (oc.existingPlacements||[])) {
      for (const optOC of optimizedOCs) {
        const better = optOC.team.find(a => a.member === placement.member);
        if (!better) continue;
        if (optOC.ocName === oc.ocName && better.role === placement.role) continue;
        const currentImpact = impactMatrix[placement.member]?.[oc.ocName]?.[placement.role]?.delta || 0;
        const delta = (better.impact||0) - currentImpact;
        if (delta > 5) { suboptimalPlacements.push({member: placement.member, currentOC: oc.ocName, currentRole: placement.role, currentCPR: placement.cpr, betterOC: optOC.ocName, betterRole: better.role, betterCPR: better.cpr, improvementDelta: parseFloat(delta.toFixed(1))}); }
        break;
      }
    }
  }

  // Personal recommendation — find the best slot for this member.
  // Uses the priority queue (sorted by level desc) but skips any slot
  // already assigned to someone else in the greedy pass.
  let personalRecommendation = null;
  if (requestingMember) {
    const bestQueueEntry = queue.find(i =>
      i.member === requestingMember &&
      !filledRoles[i.ocName]?.[i.role]   // slot not already taken
    );

    if (bestQueueEntry) {
      const optOC = optimizedOCs.find(o => o.ocName === bestQueueEntry.ocName);
      personalRecommendation = {
        member:           requestingMember,
        ocName:           bestQueueEntry.ocName,
        level:            bestQueueEntry.ocLevel,
        role:             bestQueueEntry.role,
        cpr:              bestQueueEntry.cpr,
        roleType:         bestQueueEntry.roleType,
        projectedSuccess: optOC?.projectedSuccess ?? null,
        impact:           parseFloat(bestQueueEntry.delta.toFixed(1)),
        flag:             bestQueueEntry.flag,
      };
    }
  }

  return {
    optimizedOCs, suboptimalPlacements, personalRecommendation,
    unassignedMembers: memberPool.filter(m => !usedMembers.has(m.name)).map(m => ({name:m.name, status:m.status||'available', reason: m.status==='hospital' ? 'hospital' : 'no_slot_available'})),
    meta: {membersConsidered: memberPool.length, ocsOptimized: ocs.length, assignmentsMade: usedMembers.size},
  };
}

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.json({status:'ok', version:'2.8.2', ocs: Object.keys(FLOWCHARTS).length}));

app.post('/api/score', rateLimit('score'), async (req, res) => {
  const owner = await validateKey(req, res); if (!owner) return;
  const {ocName, cprs} = req.body;
  if (!ocName) return res.status(400).json({error:'Missing ocName'});
  const result = simulateOC(ocName, cprs || {});
  if (!result) return res.status(404).json({error:'Unknown OC: '+ocName});
  res.json({ocName, ...result});
});

app.post('/api/score/batch', rateLimit('score_batch'), async (req, res) => {
  const owner = await validateKey(req, res); if (!owner) return;
  const {requests} = req.body;
  if (!Array.isArray(requests)) return res.status(400).json({error:'requests must be array'});
  res.json({results: requests.map(({ocName, cprs}) => {
    if (!ocName || !cprs) return {error:'Missing ocName or cprs'};
    const r = simulateOC(ocName, cprs); if (!r) return {ocName, error:'Unknown OC'};
    return {ocName, ...r};
  })});
});

app.get('/api/ocs', async (req, res) => {
  const owner = await validateKey(req, res); if (!owner) return;
  res.json({ocs: Object.keys(FLOWCHARTS).map(name => ({name, level: FLOWCHARTS[name].level, ...OC_METADATA[name]}))});
});

app.post('/api/optimize', rateLimit('optimize'), async (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res); if (!owner) return;
  const {ocs, requestingMember} = req.body;
  if (!Array.isArray(ocs) || ocs.length === 0) return res.status(400).json({error:'ocs must be non-empty array'});
  const factionId = getFactionId(key);
  // Normalise OC names from client (Torn may send different capitalisation)
  const normalizedOCs = ocs.map(o => ({...o, ocName: normOCName(o.ocName)}));

  const cacheKey  = hashObject({ocs: normalizedOCs.map(o => ({ocName:o.ocName, openRoles:(o.openRoles||[]).sort(), filledCPRs:o.filledCPRs||{}, members:(o.availableMembers||[]).map(m=>m.name).sort()})), requestingMember});
  const cached = await getCachedOptimize(factionId, cacheKey);
  if (cached) return res.json({...cached, cached:true});
  try {
    const result = await optimizeFaction(factionId, normalizedOCs, requestingMember);
    await setCachedOptimize(factionId, cacheKey, result);
    res.json({...result, cached:false});
  } catch(e) {
    console.error('[OPTIMIZE] Error:', e.message);
    res.status(500).json({error:'Optimization failed: '+e.message});
  }
});

app.post('/api/cpr', rateLimit('cpr'), async (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res); if (!owner) return;
  const {memberName, cprs, source} = req.body;
  if (!memberName) return res.status(400).json({error:'Missing memberName'});
  if (!cprs) return res.status(400).json({error:'Missing cprs'});
  const factionId = getFactionId(key);
  try {
    await query(
      `INSERT INTO member_cpr (faction_id, member_name, source, cprs, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (faction_id, member_name)
       DO UPDATE SET cprs=$4, source=$3, updated_at=NOW()`,
      [factionId, memberName, source||'personal', JSON.stringify(cprs)]
    );
    await invalidateCache(factionId);
    res.json({ok:true, memberName, factionId});
  } catch(e) {
    console.error('[CPR] Error:', e.message);
    res.status(500).json({error:'Failed to store CPR'});
  }
});

app.post('/api/cpr/batch', rateLimit('cpr_batch'), async (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res); if (!owner) return;
  if (!isLeaderKey(key)) return res.status(403).json({error:'Leader key required'});
  const {members} = req.body;
  if (!members || typeof members !== 'object') return res.status(400).json({error:'Missing members'});
  const factionId = getFactionId(key);
  const entries = Object.entries(members).filter(([name]) => name && !/^\d+$/.test(name.trim()) && name.trim().length >= 2);
  if (!entries.length) return res.json({ok:true, updated:0, skipped:Object.keys(members).length});
  let updated = 0, skipped = Object.keys(members).length - entries.length;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [memberName, cprs] of entries) {
      await client.query(
        `INSERT INTO member_cpr (faction_id, member_name, source, cprs, updated_at)
         VALUES ($1,$2,'tornstats',$3,NOW())
         ON CONFLICT (faction_id, member_name)
         DO UPDATE SET
           cprs = CASE WHEN member_cpr.source='personal' THEN member_cpr.cprs||$3::jsonb ELSE $3::jsonb END,
           source = CASE WHEN member_cpr.source='personal' THEN 'personal' ELSE 'tornstats' END,
           updated_at = NOW()`,
        [factionId, memberName, JSON.stringify(cprs)]
      );
      updated++;
    }
    await client.query('COMMIT');
    await invalidateCache(factionId);
    res.json({ok:true, updated, skipped, factionId});
  } catch(e) {
    await client.query('ROLLBACK');
    console.error('[CPR BATCH] Error:', e.message);
    res.status(500).json({error:'Batch update failed: '+e.message});
  } finally { client.release(); }
});

app.get('/api/cpr', async (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res); if (!owner) return;
  if (!isLeaderKey(key)) return res.status(403).json({error:'Leader key required'});
  const factionId = getFactionId(key);
  try {
    const r = await query('SELECT member_name, source, cprs, updated_at FROM member_cpr WHERE faction_id=$1', [factionId]);
    const members = {};
    r.rows.forEach(row => { members[row.member_name] = {cprs:row.cprs, source:row.source, updatedAt:row.updated_at, isStale:isCPRStale(row.updated_at)}; });
    res.json({members, factionId});
  } catch(e) { res.status(500).json({error:'Failed to load CPR'}); }
});

app.post('/api/cpr/history', rateLimit('cpr_history'), async (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res); if (!owner) return;
  if (!isLeaderKey(key)) return res.status(403).json({error:'Leader key required'});
  const {records} = req.body;
  if (!Array.isArray(records) || records.length === 0) return res.status(400).json({error:'records must be non-empty array'});
  if (records.length > 500) return res.status(400).json({error:'Max 500 records'});
  const factionId = getFactionId(key);
  const byMember = {};
  records.forEach(({memberName, ocName, role, cpr}) => {
    if (!memberName || !ocName || !role || cpr === undefined) return;
    const normName = normOCName(ocName);
    if (!byMember[memberName]) byMember[memberName] = {};
    if (!byMember[memberName][normName]) byMember[memberName][normName] = {};
    const ex = byMember[memberName][normName][role];
    if (ex === undefined || cpr > ex) byMember[memberName][normName][role] = cpr;
  });
  let updated = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [memberName, cprs] of Object.entries(byMember)) {
      await client.query(
        `INSERT INTO member_cpr (faction_id, member_name, source, cprs, updated_at)
         VALUES ($1,$2,'history',$3,NOW())
         ON CONFLICT (faction_id, member_name)
         DO UPDATE SET cprs = member_cpr.cprs||$3::jsonb, updated_at=NOW()`,
        [factionId, memberName, JSON.stringify(cprs)]
      );
      updated++;
    }
    await client.query('COMMIT');
    await invalidateCache(factionId);
    res.json({ok:true, updated, recordsProcessed:records.length});
  } catch(e) {
    await client.query('ROLLBACK');
    console.error('[CPR HISTORY] Error:', e.message);
    res.status(500).json({error:'Failed to store history'});
  } finally { client.release(); }
});

app.get('/api/cpr/status', async (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res); if (!owner) return;
  if (!isLeaderKey(key)) return res.status(403).json({error:'Leader key required'});
  const factionId = getFactionId(key);
  try {
    const r = await query('SELECT member_name, source, cprs, updated_at FROM member_cpr WHERE faction_id=$1 ORDER BY member_name', [factionId]);
    res.json({members: r.rows.map(row => ({name:row.member_name, source:row.source, updatedAt:row.updated_at, isStale:isCPRStale(row.updated_at), ocCount:Object.keys(row.cprs||{}).length})), totalWithData:r.rows.length});
  } catch(e) { res.status(500).json({error:'Failed to load CPR status'}); }
});

app.post('/api/cpr/cleanup', async (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res); if (!owner) return;
  if (!isLeaderKey(key)) return res.status(403).json({error:'Leader key required'});
  const factionId = getFactionId(key);
  try {
    const r = await query(`DELETE FROM member_cpr WHERE faction_id=$1 AND member_name ~ '^[0-9]+$'`, [factionId]);
    await invalidateCache(factionId);
    res.json({ok:true, removed:r.rowCount});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/roles', async (req, res) => {
  const owner = await validateKey(req, res); if (!owner) return;
  const roleContext = {};
  Object.entries(FLOWCHARTS).forEach(([ocName, oc]) => {
    roleContext[ocName] = {};
    const roleInfo = {};
    Object.entries(oc.nodes).forEach(([nodeId, node]) => {
      if (node.end) return;
      const roles = node.roles || (node.role ? [node.role] : []);
      roles.forEach(role => {
        if (!roleInfo[role]) roleInfo[role] = {checkpoints:0, deadEnds:0, recoveries:0, isStart:false};
        roleInfo[role].checkpoints++;
        if (nodeId === oc.start) roleInfo[role].isStart = true;
        const fn = oc.nodes[node.fail];
        if (fn?.end && fn?.payout === 0) roleInfo[role].deadEnds++; else roleInfo[role].recoveries++;
      });
    });
    Object.entries(roleInfo).forEach(([role, info]) => {
      const color = ROLE_COLORS[ocName]?.[role] || 'yellow';
      let desc = color === 'red' ? 'Critical — failure always ends the OC'
        : info.deadEnds > 0 && info.recoveries > 0 ? `Mixed — ${info.deadEnds} dead-end${info.deadEnds>1?'s':''}, ${info.recoveries} recovery path${info.recoveries>1?'s':''}`
        : 'Safe — failure never kills the OC';
      if (info.isStart) desc = '⚡ Gate role. ' + desc;
      roleContext[ocName][role] = {color, checkpoints:info.checkpoints, deadEnds:info.deadEnds, recoveries:info.recoveries, isStart:info.isStart, desc};
    });
  });
  res.json({roles:ROLE_COLORS, context:roleContext});
});

app.post('/api/payout/record', rateLimit('cpr_history'), async (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res); if (!owner) return;
  if (!isLeaderKey(key)) return res.status(403).json({error:'Leader key required'});
  const {records} = req.body;
  if (!Array.isArray(records) || !records.length) return res.status(400).json({error:'records required'});
  const factionId = getFactionId(key);
  let inserted = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of records) {
      const {ocName, executedAt, money, respect, itemIds, slotCPRs, payoutPct} = r;
      if (!ocName || !executedAt) continue;
      const pct = payoutPct > 0 ? payoutPct : 100;
      const maxMoney = pct < 100 ? Math.round((money||0)/pct*100) : (money||0);
      const ex = await client.query('SELECT 1 FROM oc_payouts WHERE faction_id=$1 AND oc_name=$2 AND executed_at=$3', [factionId, ocName, executedAt]);
      if (ex.rows.length > 0) continue;
      await client.query(`INSERT INTO oc_payouts (faction_id,oc_name,executed_at,money,respect,item_ids,slot_cprs,payout_pct,max_money) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [factionId, ocName, executedAt, money||0, respect||0, JSON.stringify(itemIds||[]), JSON.stringify(slotCPRs||{}), pct, maxMoney]);
      inserted++;
    }
    await client.query('COMMIT');
    res.json({ok:true, inserted, total:records.length});
  } catch(e) {
    await client.query('ROLLBACK');
    console.error('[PAYOUT] Error:', e.message);
    res.status(500).json({error:'Failed to store payout'});
  } finally { client.release(); }
});

app.get('/api/payout/model', async (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res); if (!owner) return;
  const factionId = getFactionId(key);
  try {
    const r = await query(`SELECT oc_name, COUNT(*) AS samples, AVG(max_money)::BIGINT AS mean_payout, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY max_money)::BIGINT AS median_payout, MAX(max_money)::BIGINT AS max_observed, MIN(max_money)::BIGINT AS min_observed, AVG(respect) AS mean_respect, MAX(executed_at) AS last_seen FROM oc_payouts WHERE faction_id=$1 AND max_money>=0 GROUP BY oc_name ORDER BY mean_payout DESC`, [factionId]);
    const model = {};
    r.rows.forEach(row => { model[row.oc_name] = {samples:parseInt(row.samples), meanPayout:parseInt(row.mean_payout), medianPayout:parseInt(row.median_payout), maxObserved:parseInt(row.max_observed), minObserved:parseInt(row.min_observed), meanRespect:parseFloat(parseFloat(row.mean_respect).toFixed(1)), lastSeen:parseInt(row.last_seen)}; });
    res.json({model, factionId});
  } catch(e) { res.status(500).json({error:'Failed to load payout model'}); }
});

app.post('/api/assign', rateLimit('assign'), async (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res); if (!owner) return;
  if (!isLeaderKey(key)) return res.status(403).json({error:'Leader key required'});
  const {tornName, role, ocName, ocLevel} = req.body;
  if (!tornName || !role || !ocName) return res.status(400).json({error:'Missing fields'});
  const factionId = getFactionId(key);
  try {
    await query(`INSERT INTO assignments (faction_id,torn_name,role,oc_name,oc_level,assigned_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (faction_id,torn_name) DO UPDATE SET role=$3,oc_name=$4,oc_level=$5,assigned_by=$6,assigned_at=NOW()`, [factionId, tornName.toLowerCase(), role, ocName, ocLevel||null, owner]);
    res.json({ok:true});
  } catch(e) { console.error('[ASSIGN] Error:', e.message); res.status(500).json({error:'Failed to save assignment'}); }
});

app.get('/api/assignment', rateLimit('assignment'), async (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res); if (!owner) return;
  const tornName = (req.query.tornName||'').trim().toLowerCase();
  if (!tornName) return res.status(400).json({error:'Missing tornName'});
  const factionId = getFactionId(key);
  try {
    const r = await query('SELECT torn_name,role,oc_name,oc_level,assigned_by,assigned_at FROM assignments WHERE faction_id=$1 AND torn_name=$2', [factionId, tornName]);
    if (!r.rows.length) return res.json({assignment:null});
    const row = r.rows[0];
    res.json({assignment:{tornName:row.torn_name, role:row.role, ocName:row.oc_name, ocLevel:row.oc_level, assignedBy:row.assigned_by, assignedAt:row.assigned_at}});
  } catch(e) { res.status(500).json({error:'Failed to load assignment'}); }
});

app.delete('/api/assign', rateLimit('assign'), async (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res); if (!owner) return;
  const tornName = (req.body.tornName||req.query.tornName||'').trim().toLowerCase();
  if (!tornName) return res.status(400).json({error:'Missing tornName'});
  const factionId = getFactionId(key);
  if (!isLeaderKey(key)) {
    const parsed = parseKey(key);
    if (parsed?.ownerName?.toLowerCase() !== tornName) return res.status(403).json({error:'Can only clear own assignment'});
  }
  try {
    await query('DELETE FROM assignments WHERE faction_id=$1 AND torn_name=$2', [factionId, tornName]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:'Failed to delete assignment'}); }
});

app.get('/api/assignments', rateLimit('assignments'), async (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res); if (!owner) return;
  if (!isLeaderKey(key)) return res.status(403).json({error:'Leader key required'});
  const factionId = getFactionId(key);
  try {
    const r = await query('SELECT torn_name,role,oc_name,oc_level,assigned_by,assigned_at FROM assignments WHERE faction_id=$1 ORDER BY assigned_at DESC', [factionId]);
    const assignments = {};
    r.rows.forEach(row => { assignments[row.torn_name] = {tornName:row.torn_name, role:row.role, ocName:row.oc_name, ocLevel:row.oc_level, assignedBy:row.assigned_by, assignedAt:row.assigned_at}; });
    res.json({assignments});
  } catch(e) { res.status(500).json({error:'Failed to load assignments'}); }
});

app.post('/api/keys/migrate', async (req, res) => {
  const token = req.headers['x-migrate-token'];
  if (!token || token !== process.env.MIGRATE_TOKEN) return res.status(403).json({error:'Invalid token'});
  try {
    await migrateKeysFromFile();
    const r = await query('SELECT COUNT(*) as count FROM api_keys');
    res.json({ok:true, keysInDB:parseInt(r.rows[0].count)});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

computeRoleColors();
startup().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Hive OC Advisor v2.8.2 running on port ${PORT}`);
    console.log(`[SERVER] OCs loaded: ${Object.keys(FLOWCHARTS).length}`);
  });
}).catch(err => {
  console.error('[SERVER] Startup failed:', err.message);
  process.exit(1);
});
