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

// ── OCS_ROLES — authoritative role classification (three-tier system) ──────────
// Derived from: CrimesHub simulator testing (all 22 available OCs, Apr 2026),
// scoring engine DAG analysis, and 1-year faction history validation (373 OCs).
//
// tier:'CRITICAL'  — role has independent bad-end exposure; hard CPR floor enforced.
//                    Member blocked if CPR < absMin. Optimizer strongly prefers ≥ idealMin.
// tier:'IMPORTANT' — role affects success rate but has structural protection (recovery paths
//                    or shared checkpoints). Gradient penalty applied below idealMin; absMin
//                    is lenient to allow developing members through.
// tier:'FREE'      — CPR has negligible impact on outcome (delta < 4% at L1-7, < 2% at L8+).
//                    Any member accepted; no CPR check. CE development opportunity.
//
// absMin / idealMin are level-scaled:
//   L1-2  CRIT 50/65  IMP 40/60
//   L3-4  CRIT 55/68  IMP 45/62
//   L5-6  CRIT 58/70  IMP 50/65
//   L7    CRIT 60/72  IMP 52/66
//   L8    CRIT 60/72  IMP 52/66
//   L9-10 CRIT 62/74  IMP 55/68
//
// Goal: push members into higher OCs while maintaining acceptable success rates.
// IMPORTANT roles have lenient absMin so developing members can participate.
// CRITICAL roles enforce a floor to protect against bad ends.
// FREE roles are left open so anyone can gain CE.

const C  = (abs,idl) => ({ tier:'CRITICAL',  absMin:abs, idealMin:idl });
const I  = (abs,idl) => ({ tier:'IMPORTANT', absMin:abs, idealMin:idl });
const F  = ()        => ({ tier:'FREE',       absMin:0,   idealMin:0  });

const OCS_ROLES = {
  // ── L1 ──────────────────────────────────────────────────────────
  // CRIT: absMin=50 idealMin=65  |  IMP: absMin=40 idealMin=60
  'First Aid and Abet': {
    'Decoy':      C(50,65),   // delta=39 — strongest real signal in 1yr dataset
    'Pickpocket': C(50,65),   // delta=18.7 confirmed CRITICAL
    'Picklock':   C(50,65),   // delta=7 moderate — CRITICAL given L1 stakes
  },
  'Mob Mentality': {
    'Looter 1':   C(50,65),   // delta=10.09 CRITICAL confirmed
    'Looter 2':   I(40,60),   // delta=7.52
    'Looter 3':   I(40,60),   // delta=5.76
    'Looter 4':   I(40,60),   // delta=5.60
  },
  'Pet Project': {
    'Kidnapper':  C(50,65),   // score=100 dominant role; real delta=2.6 (RNG on strong)
    'Picklock':   C(50,65),   // real delta=20.8 CRITICAL confirmed
    'Muscle':     C(50,65),   // real delta=15.9 CRITICAL confirmed
  },

  // ── L2 ──────────────────────────────────────────────────────────
  // CRIT: absMin=50 idealMin=65  |  IMP: absMin=40 idealMin=60
  'Best of the Lot': {
    'Muscle':     C(50,65),   // score=100 dominant
    'Imitator':   I(40,60),   // score=65.5
    'Picklock':   F(),        // score=30.6 FREE
    'Car Thief':  F(),        // score=5.7  FREE
    'Thief':      F(),        // score=5.7  FREE
  },
  'Cash Me If You Can': {
    'Thief 1':    C(50,65),   // delta=14.7 CRITICAL confirmed; real failAvg=60
    'Thief 2':    C(50,65),   // delta=12.63 CRITICAL; real delta=2.0 (low CPRs still 65+)
    'Lookout':    C(50,65),   // delta=11.46 CRITICAL; real failAvg=63.5
  },

  // ── L3 ──────────────────────────────────────────────────────────
  // CRIT: absMin=55 idealMin=68  |  IMP: absMin=45 idealMin=62
  'Gaslight the Way': {
    'Imitator 2': C(55,68),   // delta=13.19 CRITICAL confirmed
    'Imitator 3': C(55,68),   // delta=15.23 CRITICAL confirmed
    'Looter 3':   F(),        // delta=3.72 FREE
    'Imitator 1': F(),        // delta=2.86 FREE
    'Looter 1':   F(),        // delta=2.86 FREE
    'Looter 2':   F(),        // delta=0.00 FREE confirmed
  },
  'Smoke and Wing Mirrors': {
    'Car Thief':  C(55,68),   // delta=19.24 CRITICAL — biggest miss, now corrected
    'Imitator':   C(55,68),   // delta=10.50 CRITICAL confirmed
    'Hustler 2':  I(45,62),   // delta=7.11 IMPORTANT
    'Hustler 1':  F(),        // delta=3.07 FREE
  },
  'Market Forces': {
    'Enforcer':   I(45,62),   // delta=8.17 IMPORTANT (not CRITICAL — all roles shared)
    'Muscle':     I(45,62),   // delta=7.02 IMPORTANT confirmed
    'Negotiator': I(45,62),   // delta=7.58 IMPORTANT (was FREE — corrected)
    'Lookout':    I(45,62),   // delta=5.64 IMPORTANT (was FREE — corrected)
    'Arsonist':   F(),        // delta=1.22 FREE confirmed
  },

  // ── L4 ──────────────────────────────────────────────────────────
  // CRIT: absMin=55 idealMin=68  |  IMP: absMin=45 idealMin=62
  'Snow Blind': {
    'Hustler':    C(55,68),   // delta=17.79 CRITICAL confirmed
    'Imitator':   C(55,68),   // delta=10.54 CRITICAL confirmed
    'Muscle 1':   F(),        // delta=3.15 FREE confirmed
    'Muscle 2':   F(),        // delta=3.15 FREE confirmed
  },
  'Stage Fright': {
    'Sniper':     C(55,68),   // delta=13.57 CRITICAL confirmed; real failAvg=63
    'Muscle 1':   I(45,62),   // delta=7.09 IMPORTANT (was FREE — corrected)
    'Enforcer':   I(45,62),   // delta=5.47 IMPORTANT (was FREE — corrected)
    'Lookout':    F(),        // delta=3.61 FREE
    'Muscle 3':   F(),        // delta=3.07 FREE
    'Muscle 2':   F(),        // delta=0.00 FREE confirmed by simulator
    'Driver':     F(),        // not in simulator — score=4.8 FREE
  },
  'Plucking the Lotus Petal': {
    'Hustler':    C(55,68),   // score=100 dominant role
    'Muscle':     I(45,62),   // score=60.5
    'Robber':     I(45,62),   // score=48.4
  },

  // ── L5 ──────────────────────────────────────────────────────────
  // CRIT: absMin=58 idealMin=70  |  IMP: absMin=50 idealMin=65
  'No Reserve': {
    'Techie':     C(58,70),   // delta=14.92 CRITICAL confirmed
    'Engineer':   C(58,70),   // delta=12.32 CRITICAL confirmed
    'Car Thief':  C(58,70),   // delta=12.16 CRITICAL (was FREE — major correction)
  },
  'Counter Offer': {
    'Engineer':   I(50,65),   // delta=9.93 IMPORTANT (was FREE then CRITICAL — simulator correct)
    'Robber':     I(50,65),   // delta=9.00 IMPORTANT
    'Hacker':     I(50,65),   // delta=4.69 IMPORTANT confirmed
    'Picklock':   F(),        // delta=3.11 FREE confirmed
    'Looter':     F(),        // delta=3.91 FREE
  },
  'Honey Trap': {
    'Muscle 2':   C(58,70),   // delta=13.03 CRITICAL (CrimesHub weight 42% — dominant)
    'Muscle 1':   I(50,65),   // delta=9.84 IMPORTANT
    'Enforcer':   I(50,65),   // delta=5.80 IMPORTANT confirmed
  },
  'Guardian Angels': {
    'Hustler':    C(58,70),   // delta=13.61 CRITICAL confirmed; real failAvg=61
    'Engineer':   C(58,70),   // delta=12.24 CRITICAL (was IMPORTANT — corrected)
    'Enforcer':   C(58,70),   // delta=10.23 CRITICAL (was IMPORTANT — corrected)
  },

  // ── L6 ──────────────────────────────────────────────────────────
  // CRIT: absMin=58 idealMin=70  |  IMP: absMin=50 idealMin=65
  'Bidding War': {
    'Robber 3':   I(50,65),   // delta=9.73 IMPORTANT confirmed — highest weight role (31.7%)
    'Driver':     I(50,65),   // delta=8.95 IMPORTANT (was CRITICAL — corrected)
    'Robber 2':   I(50,65),   // delta=7.44 IMPORTANT (was CRITICAL — corrected)
    'Bomber 2':   I(50,65),   // delta=5.69 IMPORTANT (was FREE — corrected)
    'Bomber 1':   I(50,65),   // delta=2.59 IMPORTANT (was FREE — blocks low CPR same-level fallback)
    'Robber 1':   I(50,65),   // delta=2.59 IMPORTANT (was FREE — corrected)
  },
  'Leave No Trace': {
    'Imitator':   C(58,70),   // delta=15.44 CRITICAL; real failAvg=52.4 — strong confirmation
    'Negotiator': I(50,65),   // delta=9.64 IMPORTANT (was CRITICAL — corrected)
    'Techie':     I(50,65),   // delta=8.09 IMPORTANT; real delta=9.7 near-CRITICAL but keep IMP
  },
  'Sneaky Git Grab': {
    'Pickpocket': C(58,70),   // delta=18.27 CRITICAL confirmed
    'Hacker':     C(58,70),   // delta=10.12 CRITICAL (was FREE — major correction)
    'Techie':     I(50,65),   // delta=9.04 IMPORTANT (was FREE); real delta=13 but n=2
    'Imitator':   I(50,65),   // delta=6.56 IMPORTANT (was FREE — corrected)
  },

  // ── L7 ──────────────────────────────────────────────────────────
  // CRIT: absMin=60 idealMin=72  |  IMP: absMin=52 idealMin=66
  'Blast from the Past': {
    'Muscle':     I(52,66),   // delta=7.44 IMPORTANT (was CRITICAL — corrected for L7 baseline)
    'Engineer':   I(52,66),   // delta=5.16 IMPORTANT confirmed
    'Bomber':     I(52,66),   // delta=4.02 IMPORTANT (was FREE — corrected)
    'Picklock 1': F(),        // delta=2.43 FREE
    'Hacker':     F(),        // delta=1.76 FREE (was IMPORTANT — corrected)
    'Picklock 2': F(),        // delta=0.45 FREE confirmed
  },
  'Window of Opportunity': {
    'Engineer':   C(60,72),   // score=100 dominant — no simulator data, engine only
    'Looter 2':   I(52,66),   // score=50.5
    'Muscle 1':   I(52,66),   // score=41.6
    'Muscle 2':   I(52,66),   // score=41.6
    'Looter 1':   F(),        // score=13.4 FREE
  },

  // ── L8 ──────────────────────────────────────────────────────────
  // CRIT: absMin=60 idealMin=72  |  IMP: absMin=52 idealMin=66
  'Break the Bank': {
    'Muscle 3':   I(52,66),   // delta=5.99 IMPORTANT (was CRITICAL — L8 threshold corrected)
    'Thief 2':    I(52,66),   // delta=5.99 IMPORTANT (was CRITICAL — corrected)
    'Robber':     I(52,66),   // delta=2.14 IMPORTANT confirmed
    'Muscle 1':   I(52,66),   // delta=2.12 IMPORTANT confirmed
    'Muscle 2':   I(52,66),   // delta=2.05 IMPORTANT (was FREE — corrected)
    'Thief 1':    F(),        // delta=0.32 FREE confirmed
  },
  'Clinical Precision': {
    'Imitator':   C(60,72),   // delta=8.04 CRITICAL confirmed
    'Cat Burglar': I(52,66),  // delta=4.42 IMPORTANT (was CRITICAL — corrected)
    'Cleaner':    I(52,66),   // delta=4.37 IMPORTANT confirmed
    'Assassin':   I(52,66),   // delta=2.92 IMPORTANT confirmed
  },
  'Stacking the Deck': {
    'Imitator':   C(60,72),   // delta=8.04 CRITICAL confirmed
    'Cat Burglar': I(52,66),  // delta=5.75 IMPORTANT (was CRITICAL — corrected)
    'Hacker':     I(52,66),   // delta=5.10 IMPORTANT confirmed
    'Driver':     F(),        // delta=0.88 FREE confirmed
  },
  'Manifest Cruelty': {
    'Reviver':    C(60,72),   // delta=9.32 CRITICAL confirmed
    'Interrogator':I(52,66),  // delta=5.22 IMPORTANT (was CRITICAL — corrected)
    'Hacker':     I(52,66),   // delta=3.54 IMPORTANT confirmed
    'Cat Burglar': I(52,66),  // delta=3.00 IMPORTANT confirmed
  },

  // ── L9 ──────────────────────────────────────────────────────────
  // CRIT: absMin=62 idealMin=74  |  IMP: absMin=55 idealMin=68
  'Ace in the Hole': {
    'Hacker':     C(62,74),   // delta=7.76 CRITICAL confirmed
    'Muscle 2':   I(55,68),   // delta=4.56 IMPORTANT (was CRITICAL — corrected)
    'Imitator':   I(55,68),   // delta=3.95 IMPORTANT (was CRITICAL — corrected)
    'Muscle 1':   I(55,68),   // delta=3.78 IMPORTANT (was CRITICAL — corrected)
    'Driver':     I(55,68),   // delta=2.51 IMPORTANT confirmed
  },
  'Gone Fission': {
    'Hijacker':   C(62,74),   // delta=6.11 CRITICAL confirmed
    'Imitator':   I(55,68),   // delta=4.72 IMPORTANT confirmed
    'Bomber':     I(55,68),   // delta=4.12 IMPORTANT confirmed
    'Pickpocket': I(55,68),   // delta=4.05 IMPORTANT confirmed
    'Engineer':   I(55,68),   // delta=4.03 IMPORTANT confirmed
  },

  // ── L10 ─────────────────────────────────────────────────────────
  // CRIT: absMin=62 idealMin=74  |  IMP: absMin=55 idealMin=68
  'Crane Reaction': {
    'Sniper':     C(62,74),   // delta=8.06 CRITICAL confirmed
    'Lookout':    I(55,68),   // delta=4.55 IMPORTANT confirmed
    'Bomber':     I(55,68),   // delta=3.96 IMPORTANT (was CRITICAL — corrected)
    'Muscle 1':   I(55,68),   // delta=2.49 IMPORTANT confirmed
    'Engineer':   I(55,68),   // delta=2.31 IMPORTANT confirmed
    'Muscle 2':   F(),        // delta=1.53 FREE (was IMPORTANT — corrected)
  },
};

// ── OC_PATH_DATA — derived from full DAG analysis of all flowcharts ──────────
// mainPath: the sequence of roles on the best-payout path (following 'pass' at every node).
//   Used for path dependency detection: two consecutive weak members on the main
//   path cause back-to-back checkpoint failures, which is the primary OC failure mode.
//   (Community-confirmed by Andyman and Emforus independently.)
//   Dual-role checkpoints are stored as "Role A+Role B".
// roleWeights: normalized frequency of each role across the ENTIRE DAG (0–1).
//   Higher = more checkpoints assigned to this role = more impact on success.
//   This is the continuous weight system replacing the coarse 3/2/0 priority tiers.
//   Derived from Allenone's regression data: role frequency ∝ slope of CPR→success curve.
const OC_PATH_DATA = {
  'Mob Mentality':           {level:1, mainPath:['Looter 1','Looter 2','Looter 3','Looter 2','Looter 4','Looter 2'], roleWeights:{'Looter 2':0.333,'Looter 1':0.222,'Looter 3':0.222,'Looter 4':0.222}},
  'Pet Project':             {level:1, mainPath:['Picklock','Kidnapper','Kidnapper','Muscle','Kidnapper','Muscle','Picklock'], roleWeights:{'Muscle':0.45,'Kidnapper':0.3,'Picklock':0.25}},
  'First Aid and Abet':      {level:1, mainPath:['Decoy','Picklock','Pickpocket'], roleWeights:{'Picklock':0.4,'Pickpocket':0.4,'Decoy':0.2}},
  'Best of the Lot':         {level:2, mainPath:['Picklock','Imitator','Car Thief+Thief','Picklock','Muscle'], roleWeights:{'Muscle':0.375,'Imitator':0.312,'Picklock':0.188,'Car Thief':0.062,'Thief':0.062}},
  'Cash Me If You Can':      {level:2, mainPath:['Thief 1','Thief 2','Thief 1','Thief 2','Lookout','Thief 2'], roleWeights:{'Thief 1':0.529,'Thief 2':0.353,'Lookout':0.118}},
  'Gaslight the Way':        {level:3, mainPath:['Imitator 1+Looter 1','Imitator 2','Imitator 3','Looter 3','Looter 2+Looter 3','Imitator 2'], roleWeights:{'Imitator 2':0.235,'Looter 3':0.235,'Imitator 1':0.176,'Looter 1':0.176,'Imitator 3':0.118,'Looter 2':0.059}},
  'Smoke and Wing Mirrors':  {level:3, mainPath:['Imitator','Imitator','Car Thief+Thief','Hustler 1+Hustler 2','Car Thief+Thief','Hustler 1'], roleWeights:{'Car Thief':0.259,'Thief':0.259,'Imitator':0.222,'Hustler 2':0.148,'Hustler 1':0.111}},
  'Market Forces':           {level:3, mainPath:['Lookout','Negotiator','Enforcer','Arsonist','Muscle','Negotiator','Muscle'], roleWeights:{'Muscle':0.263,'Negotiator':0.211,'Enforcer':0.211,'Lookout':0.158,'Arsonist':0.158}},
  'Snow Blind':              {level:4, mainPath:['Muscle 1+Muscle 2','Hustler','Imitator','Hustler','Hustler','Imitator','Imitator'], roleWeights:{'Hustler':0.318,'Muscle 1':0.227,'Muscle 2':0.227,'Imitator':0.227}},
  'Stage Fright':            {level:4, mainPath:['Lookout+Muscle 2','Sniper','Muscle 1+Muscle 3','Enforcer','Lookout+Sniper'], roleWeights:{'Sniper':0.25,'Muscle 1':0.2,'Enforcer':0.15,'Lookout':0.15,'Muscle 2':0.1,'Muscle 3':0.1,'Driver':0.05}},
  'Plucking the Lotus Petal':{level:4, mainPath:['Muscle','Hustler','Robber','Robber'], roleWeights:{'Hustler':0.375,'Robber':0.375,'Muscle':0.25}},
  'No Reserve':              {level:5, mainPath:['Techie','Techie','Techie','Car Thief+Thief','Engineer','Techie'], roleWeights:{'Techie':0.421,'Engineer':0.263,'Car Thief':0.158,'Thief':0.158}},
  'Counter Offer':           {level:5, mainPath:['Robber','Engineer','Hacker','Picklock','Looter'], roleWeights:{'Hacker':0.273,'Picklock':0.273,'Robber':0.182,'Engineer':0.182,'Looter':0.091}},
  'Honey Trap':              {level:5, mainPath:['Enforcer','Muscle 1','Enforcer','Enforcer','Muscle 2','Muscle 1+Muscle 2','Enforcer+Muscle 1'], roleWeights:{'Muscle 2':0.455,'Muscle 1':0.318,'Enforcer':0.227}},
  'Guardian Angels':         {level:5, mainPath:['Hustler','Engineer','Enforcer','Engineer','Hustler','Enforcer'], roleWeights:{'Enforcer':0.435,'Engineer':0.304,'Hustler':0.261}},
  'Bidding War':             {level:6, mainPath:['Bomber 1','Driver','Robber 1','Robber 3','Robber 3','Driver+Robber 3','Bomber 2'], roleWeights:{'Driver':0.238,'Robber 2':0.19,'Bomber 1':0.143,'Robber 1':0.143,'Robber 3':0.143,'Bomber 2':0.143}},
  'Leave No Trace':          {level:6, mainPath:['Techie','Negotiator','Imitator','Imitator','Techie','Imitator+Negotiator'], roleWeights:{'Negotiator':0.4,'Imitator':0.35,'Techie':0.25}},
  'Sneaky Git Grab':         {level:6, mainPath:['Imitator','Pickpocket','Pickpocket+Imitator','Techie','Hacker','Techie','Imitator'], roleWeights:{'Imitator':0.316,'Pickpocket':0.316,'Hacker':0.211,'Techie':0.158}},
  'Blast from the Past':     {level:7, mainPath:['Muscle','Hacker','Muscle','Engineer','Bomber','Picklock 2','Picklock 1','Hacker'], roleWeights:{'Hacker':0.2,'Picklock 2':0.2,'Picklock 1':0.2,'Muscle':0.16,'Engineer':0.16,'Bomber':0.08}},
  'Window of Opportunity':   {level:7, mainPath:['Engineer','Muscle 1+Muscle 2','Looter 1','Looter 2','Muscle 1+Muscle 2'], roleWeights:{'Muscle 1':0.286,'Muscle 2':0.286,'Engineer':0.214,'Looter 2':0.143,'Looter 1':0.071}},
  'Break the Bank':          {level:8, mainPath:['Robber+Muscle 1','Muscle 2+Thief 1','Muscle 3','Thief 2','Muscle 3','Robber+Muscle 1','Robber+Muscle 1','Robber+Thief 1'], roleWeights:{'Muscle 3':0.214,'Muscle 1':0.214,'Robber':0.214,'Thief 2':0.143,'Muscle 2':0.107,'Thief 1':0.107}},
  'Clinical Precision':      {level:8, mainPath:['Cat Burglar','Assassin','Cleaner','Cleaner','Assassin+Imitator','Assassin','Assassin+Cleaner'], roleWeights:{'Assassin':0.321,'Cleaner':0.321,'Cat Burglar':0.179,'Imitator':0.179}},
  'Stacking the Deck':       {level:8, mainPath:['Cat Burglar','Driver','Cat Burglar','Hacker','Hacker','Imitator'], roleWeights:{'Imitator':0.412,'Hacker':0.294,'Cat Burglar':0.176,'Driver':0.118}},
  'Manifest Cruelty':        {level:8, mainPath:['Cat Burglar+Interrogator','Interrogator','Cat Burglar','Hacker','Interrogator+Reviver','Hacker','Interrogator'], roleWeights:{'Reviver':0.312,'Interrogator':0.281,'Hacker':0.219,'Cat Burglar':0.188}},
  'Ace in the Hole':         {level:9, mainPath:['Imitator','Muscle 1+Muscle 2','Hacker','Muscle 1+Muscle 2','Driver','Hacker','Imitator'], roleWeights:{'Hacker':0.25,'Muscle 2':0.25,'Muscle 1':0.225,'Imitator':0.15,'Driver':0.125}},
  'Gone Fission':            {level:9, mainPath:['Hijacker','Hijacker','Engineer','Imitator','Pickpocket+Imitator','Bomber','Imitator'], roleWeights:{'Hijacker':0.208,'Engineer':0.208,'Imitator':0.208,'Bomber':0.208,'Pickpocket':0.167}},
  'Crane Reaction':          {level:10,mainPath:['Muscle 1+Muscle 2','Engineer+Lookout','Bomber','Engineer+Bomber','Lookout+Sniper','Muscle 2+Muscle 1'], roleWeights:{'Bomber':0.179,'Muscle 2':0.179,'Sniper':0.179,'Lookout':0.154,'Muscle 1':0.154,'Engineer':0.128,'Driver':0.026}},
};

// Get the DAG role weight for a specific role in a specific OC.
// Falls back to tier-based weight if OC not in table.
function getOCRoleWeight(ocName, role) {
  const pd = OC_PATH_DATA[ocName];
  if (!pd) return null;
  const base = (role||'').replace(/\s+\d+$/,'');
  return pd.roleWeights[role] ?? pd.roleWeights[base] ?? null;
}

// Extract the main-path role sequence for an OC (single roles only, no dual-role strings).
// Used for consecutive-weakness path penalty detection.
function getMainPathRoles(ocName) {
  const pd = OC_PATH_DATA[ocName];
  if (!pd) return [];
  const roles = [];
  for (const step of pd.mainPath) {
    // Dual-role steps like "Enforcer+Muscle 1" — add both
    if (step.includes('+')) {
      step.split('+').forEach(r => roles.push(r.trim()));
    } else {
      roles.push(step);
    }
  }
  return roles;
}

function getOCSRole(ocName, role) {
  const d = OCS_ROLES[ocName];
  if (!d) return null;
  const base = (role || '').replace(/\s+\d+$/, '');
  return d[role] || d[base] || null;
}

// Role priority for queue scoring: CRITICAL > IMPORTANT > FREE
function ocsRolePriority(ocName, role) {
  const r = getOCSRole(ocName, role);
  if (!r)                     return 1;   // unknown — treat as important
  if (r.tier === 'CRITICAL')  return 3;
  if (r.tier === 'IMPORTANT') return 2;
  return 0;                               // FREE — lowest priority
}

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


// ═══════════════════════════════════════════════════════════════
// OPTIMIZE ENGINE
// ═══════════════════════════════════════════════════════════════

function getMemberCPR(memberCPRs, memberName, ocName, role) {
  const d = memberCPRs[memberName]; if (!d) return null;
  const base = getRoleBase(role);

  // Candidate OC name variants to try:
  // 1. Exact ocName (already normalised by optimizer e.g. "Cash Me If You Can")
  // 2. normOCName applied to each DB key — handles mismatches like
  //    DB "Cash Me if You Can" → normOCName → "Cash Me If You Can" ✓
  //    DB "Guardian Ángels"    → normOCName → "Guardian Angels"    ✓
  // Try exact match first for speed, then scan all keys with normalisation.
  const tryKey = (key) => {
    const ocData = d.cprs?.[key]; if (!ocData) return null;
    return ocData[role] ?? ocData[base] ?? null;
  };

  // Fast path: exact key match
  for (const variant of [ocName, ocName + 's', ocName.replace(/s$/, '')]) {
    const r = tryKey(variant);
    if (r !== null) return r;
  }

  // Slow path: scan all stored OC keys, normalising each one
  if (d.cprs) {
    for (const storedKey of Object.keys(d.cprs)) {
      if (normOCName(storedKey) === ocName) {
        const r = tryKey(storedKey);
        if (r !== null) return r;
      }
    }
  }

  // Same-level fallback: same difficulty level = same CPR regardless of OC
  if (d.cprs) {
    const ocLevel = Object.entries(FLOWCHARTS).find(([n]) => n === ocName)?.[1]?.level;
    if (ocLevel != null) {
      for (const [storedKey, ocData] of Object.entries(d.cprs)) {
        const storedLevel = FLOWCHARTS[normOCName(storedKey)]?.level ?? FLOWCHARTS[storedKey]?.level;
        if (storedLevel !== ocLevel) continue;
        const r = ocData[role] ?? ocData[base] ?? null;
        if (r !== null) return r;
      }
    }
  }

  return null;
}

const STALE_MS = 7 * 24 * 60 * 60 * 1000;
function isCPRStale(updatedAt) { return !updatedAt || Date.now() - new Date(updatedAt).getTime() > STALE_MS; }

async function optimizeFaction(factionId, ocs, requestingMember, mode = 'spread') {
  // ── Load data ─────────────────────────────────────────────────
  let empirical = {};
  try {
    const er = await query(`SELECT oc_name, AVG(max_money)::BIGINT AS mean, COUNT(*) AS n FROM oc_payouts WHERE faction_id=$1 AND max_money>0 GROUP BY oc_name`, [factionId]);
    er.rows.forEach(row => { empirical[row.oc_name] = { meanPayout: parseInt(row.mean), samples: parseInt(row.n) }; });
  } catch(e) {}

  let memberCPRMap = {};
  try {
    const r = await query('SELECT member_name, source, cprs, updated_at FROM member_cpr WHERE faction_id=$1', [factionId]);
    r.rows.forEach(row => {
      memberCPRMap[row.member_name] = {
        cprs: row.cprs, source: row.source,
        updatedAt: row.updated_at, isStale: isCPRStale(row.updated_at),
      };
    });
  } catch(e) { console.error('[OPTIMIZE] CPR load error:', e.message); }

  const ocList    = ocs.map((oc, idx) => ({ ...oc, ocId: `${oc.ocName}__${idx}` }));
  const memberPool = ocList[0]?.availableMembers || [];

  // ══════════════════════════════════════════════════════════════
  // IMPROVEMENT 1 — Continuous role weight priority score
  // ──────────────────────────────────────────────────────────────
  // Old system: coarse 3/2/0 tiers (critical / high-impact / safe).
  // New system: normalized DAG frequency weight per role per OC.
  //   weight = (times this role appears in DAG) / (total role appearances)
  //   Range: 0.05–0.53. Scaled to 0–300 for priority score.
  //   Source: Allenone's regression data — slope of CPR→success = role frequency.
  // ══════════════════════════════════════════════════════════════
  function computeRolePriorityScore(ocName, role) {
    const ocsR = getOCSRole(ocName, role);
    if (ocsR?.tier === 'FREE') return 0; // FREE slots always lowest priority

    // Try DAG weight first — continuous score
    const dagWeight = getOCRoleWeight(ocName, role);
    if (dagWeight !== null) {
      return Math.round(dagWeight * 600);
    }
    // Fallback: tier-based if OC not in table
    if (ocsR?.tier === 'CRITICAL')  return 200;
    if (ocsR?.tier === 'IMPORTANT') return 100;
    return 100;
  }

  // ══════════════════════════════════════════════════════════════
  // IMPROVEMENT 2 — idealMin gradient penalty on CRITICAL roles
  // ──────────────────────────────────────────────────────────────
  // Old: hard block at absMin only. A member at 53% (just above absMin 52%)
  //   was treated the same as a member at 73% in queue ordering except delta.
  // New: members between absMin and idealMin on CRITICAL roles get their
  //   priority score penalised. They're still allowed (not blocked), but they
  //   rank much lower so better members are preferred.
  // Community confirmed: "lower than 65 needs two green members to carry them."
  // ══════════════════════════════════════════════════════════════
  function applyIdealMinPenalty(priorityScore, cpr, role, ocName) {
    const ocsR = getOCSRole(ocName, role);
    const tier = ocsR?.tier;
    if (!tier || tier === 'FREE' || cpr === null) return priorityScore;
    // Use per-role absMin/idealMin from OCS_ROLES if present, else ROLE_CPR_RANGES
    const absMin  = ocsR.absMin  ?? getRoleCPRRange(role).absMin;
    const idealMin = ocsR.idealMin ?? getRoleCPRRange(role).idealMin;
    if (cpr >= idealMin) return priorityScore; // at or above ideal — no penalty
    if (cpr < absMin)    return priorityScore; // blocked elsewhere — irrelevant
    // In the absMin–idealMin gap: apply graduated penalty
    // CRITICAL: up to 60% penalty. IMPORTANT: up to 40% penalty (more lenient).
    const gap         = idealMin - absMin;
    const shortfall   = idealMin - cpr;
    const maxPenalty  = tier === 'CRITICAL' ? 0.60 : 0.40;
    const penaltyFrac = (shortfall / gap) * maxPenalty;
    return Math.round(priorityScore * (1 - penaltyFrac));
  }

  // ══════════════════════════════════════════════════════════════
  // IMPROVEMENT 3 — Path dependency penalty
  // ──────────────────────────────────────────────────────────────
  // Community confirmed by Andyman: "back-to-back checkpoint fails on the
  //   same branch cause failure." Our flowchart data confirms the mechanism.
  // This function checks: if a proposed lineup has two consecutive roles on
  //   the main path both below idealMin, it penalises the second assignment.
  // Called AFTER Pass 1 to re-score the queue for subsequent passes.
  // ══════════════════════════════════════════════════════════════
  function computePathPenalty(ocName, role, currentAssignments, memberCPRMap) {
    const mainPath = getMainPathRoles(ocName);
    if (mainPath.length === 0) return 0;

    const rc     = getRoleCPRRange(role);
    const base   = (role||'').replace(/\s+\d+$/,'');

    // Find this role's position(s) in the main path
    const roleIdx = mainPath.reduce((idxs, r, i) => {
      if (r === role || r === base) idxs.push(i);
      return idxs;
    }, []);
    if (roleIdx.length === 0) return 0;

    // Check whether any adjacent main-path role is already assigned weakly
    let penalty = 0;
    for (const idx of roleIdx) {
      // Check predecessor and successor on main path
      for (const neighborIdx of [idx - 1, idx + 1]) {
        if (neighborIdx < 0 || neighborIdx >= mainPath.length) continue;
        const neighborRole = mainPath[neighborIdx];
        if (!neighborRole || neighborRole.includes('+')) continue;

        // Find who is assigned to this neighbor role
        const neighborAssignment = (currentAssignments||[]).find(a => {
          const aBase = (a.role||'').replace(/\s+\d+$/,'');
          return a.role === neighborRole || aBase === neighborRole;
        });
        if (!neighborAssignment) continue;

        const neighborCPR = neighborAssignment.cpr;
        const neighborRc  = getRoleCPRRange(neighborRole);
        if (neighborCPR !== null && neighborCPR < neighborRc.idealMin) {
          // Neighbor is already weak — penalise placing another weak member adjacent
          // Penalty scales with how far below idealMin both members are
          const neighborShortfall = neighborRc.idealMin - neighborCPR;
          penalty += neighborShortfall * 8; // 8 pts per CPR point of shortfall
        }
      }
    }
    return penalty;
  }

  // ── Build impact matrix ───────────────────────────────────────
  const impactMatrix = {};
  for (const member of memberPool) {
    impactMatrix[member.name] = {};
    for (const oc of ocList) {
      impactMatrix[member.name][oc.ocId] = {};
      const baseline = simulateOC(oc.ocName, oc.filledCPRs || {});
      if (!baseline) continue;

      for (const role of (oc.openRoles || [])) {
        const ocsRole  = getOCSRole(oc.ocName, role);
        const tier     = ocsRole?.tier ?? 'IMPORTANT'; // default to IMPORTANT if unknown
        const isFree   = tier === 'FREE';
        const isCrit   = tier === 'CRITICAL';
        // Use per-role CPR floors from OCS_ROLES, fallback to global ROLE_CPR_RANGES
        const absMin   = isFree ? 0 : (ocsRole?.absMin ?? getRoleCPRRange(role).absMin);

        let cpr  = getMemberCPR(memberCPRMap, member.name, oc.ocName, role);
        let flag = null;
        if (!memberCPRMap[member.name])             flag = 'no_data';
        else if (cpr === null)                      flag = 'cpr_unknown';
        else if (memberCPRMap[member.name].isStale) flag = 'cpr_stale';

        // ── BLOCKING RULES ───────────────────────────────────────
        const ocLevel_ = FLOWCHARTS[oc.ocName]?.level || 1;
        if (isFree || ocLevel_ === 1) {
          // FREE slots and L1 OCs: accept everyone
        } else if (isCrit) {
          // CRITICAL roles: must have known CPR ≥ absMin
          if (flag === 'no_data' || flag === 'cpr_unknown') {
            impactMatrix[member.name][oc.ocId][role] = { cpr: null, flag, delta: 0, ocsRole, blocked: true };
            continue;
          }
          if (cpr !== null && cpr < absMin) {
            impactMatrix[member.name][oc.ocId][role] = { cpr, flag: 'below_min', delta: 0, ocsRole, blocked: true };
            continue;
          }
        } else {
          // IMPORTANT roles: block no_data AND cpr_unknown (unknown CPR = don't place)
          if (flag === 'no_data' || flag === 'cpr_unknown') {
            impactMatrix[member.name][oc.ocId][role] = { cpr: null, flag, delta: 0, ocsRole, blocked: true };
            continue;
          }
          if (cpr !== null && cpr < absMin) {
            impactMatrix[member.name][oc.ocId][role] = { cpr, flag: 'below_min', delta: 0, ocsRole, blocked: true };
            continue;
          }
        }

        let effectiveCPR = cpr !== null ? cpr : isFree ? 50 : absMin;

        const withMember = simulateOC(oc.ocName, { ...(oc.filledCPRs||{}), [role]: effectiveCPR });
        const delta = withMember ? withMember.successChance - baseline.successChance : 0;

        impactMatrix[member.name][oc.ocId][role] = { cpr, flag, delta, ocsRole, blocked: false };
      }
    }
  }

  // ── Build priority queue with new scoring ────────────────────
  // Score = (ocLevel * 1000)             — higher level always wins globally
  //       + computeRolePriorityScore()   — continuous DAG weight (replaces 3/2/0)
  //       + applyIdealMinPenalty()       — penalise below-idealMin on CRITICAL
  //       + (delta * 10)                 — flowchart simulation delta as tiebreaker
  const queue = [];
  for (const member of memberPool) {
    for (const oc of ocList) {
      const ocLevel = FLOWCHARTS[oc.ocName]?.level || 1;
      for (const role of (oc.openRoles || [])) {
        const impact = impactMatrix[member.name]?.[oc.ocId]?.[role];
        if (!impact || impact.blocked) continue;

        const baseRolePri = computeRolePriorityScore(oc.ocName, role);
        const penalised   = applyIdealMinPenalty(baseRolePri, impact.cpr, role, oc.ocName);

        queue.push({
          member:        member.name,
          memberStatus:  member.status || 'available',
          ocName:        oc.ocName,
          ocId:          oc.ocId,
          ocLevel,
          role,
          roleType:      impact.ocsRole?.tier === 'CRITICAL' ? 'critical' : impact.ocsRole?.tier === 'FREE' ? 'free' : 'important',
          cpr:           impact.cpr,
          delta:         impact.delta,
          flag:          impact.flag,
          basePri:       baseRolePri,
          ...((() => {
            if (impact.ocsRole?.tier === 'FREE') return { priorityScore: ocLevel * 100 };
            let levelMult = 1000;
            if (impact.cpr !== null) {
              const ocsR     = impact.ocsRole;
              const absMin   = ocsR?.absMin  ?? getRoleCPRRange(role).absMin;
              const idealMin = ocsR?.idealMin ?? getRoleCPRRange(role).idealMin;
              const gap = idealMin - absMin;
              if (gap > 0) {
                const frac = Math.min(1, Math.max(0, (impact.cpr - absMin) / gap));
                levelMult = Math.round(500 + 500 * frac);
              }
            }
            return { priorityScore: (ocLevel * levelMult) + penalised + (impact.delta * 10) };
          })()),
        });
      }
    }
  }
  queue.sort((a, b) => b.priorityScore - a.priorityScore);

  // ── Pass 1: greedy assignment ─────────────────────────────────
  // spread mode: assign each member to their highest qualifying OC (current default)
  // stack mode:  fill OCs to scope-breakeven viability before moving to next.
  //              Sort OCs by level desc, complete each one before starting the next.
  //              Better for small factions that can't staff multiple L5/L6 teams.
  const usedMembers = new Set();
  const filledRoles = {};
  const assignments = {};

  function tryAssign(item) {
    if (usedMembers.has(item.member))        return false;
    if (filledRoles[item.ocId]?.[item.role]) return false;
    if (!filledRoles[item.ocId])  filledRoles[item.ocId] = {};
    if (!assignments[item.ocId]) assignments[item.ocId]  = [];
    filledRoles[item.ocId][item.role] = item.member;
    assignments[item.ocId].push({
      role: item.role, member: item.member, memberStatus: item.memberStatus,
      cpr: item.cpr, roleType: item.roleType,
      roleColor: ROLE_COLORS[item.ocName]?.[item.role] || 'yellow',
      impact: parseFloat(item.delta.toFixed(1)), flag: item.flag,
    });
    usedMembers.add(item.member);
    return true;
  }

  if (mode === 'stack') {
    // Sort OCs by level desc — fill highest-value OCs first
    const sortedOCs = [...ocList].sort((a, b) => {
      const la = FLOWCHARTS[a.ocName]?.level || 1;
      const lb = FLOWCHARTS[b.ocName]?.level || 1;
      return lb - la;
    });

    for (const oc of sortedOCs) {
      const ocLevel   = FLOWCHARTS[oc.ocName]?.level || 1;
      const breakeven = (SCOPE_BREAKEVEN[ocLevel] || 0.75) * 100;

      // Get all queue items for this OC, sorted by priority
      const ocQueue = queue
        .filter(item => item.ocId === oc.ocId && !usedMembers.has(item.member))
        .sort((a, b) => b.priorityScore - a.priorityScore);

      // Fill this OC completely before moving to the next
      for (const item of ocQueue) {
        tryAssign(item);
      }
    }
  } else {
    // spread mode — original greedy assignment across all OCs simultaneously
    for (const item of queue) { tryAssign(item); }
  }

  // ── Pass 1b: path-penalty re-sort ────────────────────────────
  // After the first greedy pass, we know who was assigned to each OC.
  // Re-score remaining queue items using path dependency data from assignments
  // so that subsequent passes don't stack weak members on the same branch.
  for (const item of queue) {
    if (usedMembers.has(item.member)) continue; // already assigned
    if (!item.cpr || item.cpr === null) continue;
    const ocsR    = getOCSRole(item.ocName, item.role);
    const idealMin = ocsR?.idealMin ?? getRoleCPRRange(item.role).idealMin;
    if (item.cpr >= idealMin) continue; // strong enough — no path concern
    const pathPenalty = computePathPenalty(item.ocName, item.role, assignments[item.ocId], memberCPRMap);
    if (pathPenalty > 0) {
      item.priorityScore = Math.max(0, item.priorityScore - pathPenalty);
    }
  }
  queue.sort((a, b) => b.priorityScore - a.priorityScore);

  // ── Pass 2: viability check (disabled — members stay at highest OC) ──
  const unfillableOCIds = new Set();
  const releasedMembers = new Set();

  // ── Pass 4: fill FREE slots of unfillable OCs ────────────────
  // FREE slots accept ANY member — even zero CPR.
  // Use lowest-CPR available members to preserve strong ones for viable OCs.
  for (const oc of ocList) {
    if (!unfillableOCIds.has(oc.ocId)) continue;
    for (const role of (oc.openRoles || [])) {
      const ocsR  = getOCSRole(oc.ocName, role);
      const isFree = ocsR?.tier === 'FREE';
      if (!isFree) continue;
      if (filledRoles[oc.ocId]?.[role]) continue;
      const candidates = memberPool
        .filter(m => !usedMembers.has(m.name))
        .map(m => ({
          member: m.name, memberStatus: m.status || 'available',
          ocName: oc.ocName, ocId: oc.ocId,
          ocLevel: FLOWCHARTS[oc.ocName]?.level || 1,
          role, roleType: 'free',
          cpr: getMemberCPR(memberCPRMap, m.name, oc.ocName, role), delta: 0,
          flag: !memberCPRMap[m.name] ? 'no_data' : null, priorityScore: 0,
        }))
        .sort((a,b) => (a.cpr||0) - (b.cpr||0));
      if (candidates.length > 0) tryAssign(candidates[0]);
    }
  }

  // ── Score final teams ─────────────────────────────────────────
  const optimizedOCs = [];
  for (const oc of ocList) {
    const ocLevel   = FLOWCHARTS[oc.ocName]?.level || 1;
    const breakeven = (SCOPE_BREAKEVEN[ocLevel] || 0.75) * 100;
    const baseline  = simulateOC(oc.ocName, oc.filledCPRs || {});

    if (unfillableOCIds.has(oc.ocId)) {
      // OC can't reach scope breakeven — but safe-role members may still be retained.
      // Show them in the team so the leader can see who is assigned to safe slots.
      const retainedTeam = (assignments[oc.ocId] || []).map(a => ({
        role:         a.role,
        member:       a.member,
        memberStatus: a.memberStatus,
        cpr:          a.cpr,
        roleType:     a.roleType,
        roleColor:    a.roleColor,
        impact:       a.impact,
        flag:         a.flag,
      }));
      const retainedRoles = new Set(retainedTeam.map(a => a.role));
      optimizedOCs.push({
        ocName:           oc.ocName, ocId: oc.ocId, level: ocLevel,
        rewardType:       OC_METADATA[oc.ocName]?.rewardType || 'cash',
        itemDesc:         OC_METADATA[oc.ocName]?.itemDesc   || '',
        empiricalPayout:  null, empiricalSamples: 0,
        projectedSuccess: 0, currentSuccess: baseline?.successChance || 0,
        improvement:      0, scopeBreakeven: Math.round(breakeven),
        status:           'unfillable',
        team:             retainedTeam,
        unfilledRoles:    (oc.openRoles||[])
          .filter(r => !retainedRoles.has(r))
          .map(r => ({
            role:     r,
            roleType: getOCSRole(oc.ocName, r)?.tier === 'CRITICAL' ? 'critical' : getOCSRole(oc.ocName, r)?.tier === 'FREE' ? 'free' : 'important',
            urgent:   getOCSRole(oc.ocName, r)?.tier === 'CRITICAL',
            reason:   'insufficient_qualified_members',
          })),
      });
      continue;
    }

    // Conservative simulation for display (same logic as viability check)
    const assembledCPRs = { ...(oc.filledCPRs||{}) };
    (assignments[oc.ocId]||[]).forEach(a => {
      assembledCPRs[a.role] = a.cpr !== null ? a.cpr : (getOCSRole(oc.ocName, a.role)?.absMin ?? getRoleCPRRange(a.role).absMin);
    });
    const projected   = simulateOC(oc.ocName, assembledCPRs);
    const projectedSC = projected?.successChance || 0;

    const filledInOC    = new Set((assignments[oc.ocId]||[]).map(a => a.role));
    const unfilledRoles = (oc.openRoles||[]).filter(r => !filledInOC.has(r));
    const emp           = empirical[oc.ocName];
    const status        = projectedSC < breakeven - 10 ? 'at_risk'
                        : projectedSC < breakeven      ? 'marginal'
                        : 'optimal';

    optimizedOCs.push({
      ocName:           oc.ocName, ocId: oc.ocId, level: ocLevel,
      rewardType:       OC_METADATA[oc.ocName]?.rewardType || 'cash',
      itemDesc:         OC_METADATA[oc.ocName]?.itemDesc   || '',
      empiricalPayout:  emp?.meanPayout || null, empiricalSamples: emp?.samples || 0,
      projectedSuccess: projectedSC,
      currentSuccess:   baseline?.successChance || 0,
      improvement:      projectedSC - (baseline?.successChance||0),
      scopeBreakeven:   Math.round(breakeven),
      status,
      team:             assignments[oc.ocId] || [],
    unfilledRoles:    unfilledRoles.map(r => ({
        role:     r,
        roleType: getOCSRole(oc.ocName, r)?.tier === 'CRITICAL' ? 'critical' : getOCSRole(oc.ocName, r)?.tier === 'FREE' ? 'free' : 'important',
        urgent:   getOCSRole(oc.ocName, r)?.tier === 'CRITICAL',
      })),
    });
  }
  optimizedOCs.sort((a, b) => b.level - a.level);

  // ── Suboptimal existing placements ───────────────────────────
  const suboptimalPlacements = [];
  for (const oc of ocList) {
    for (const placement of (oc.existingPlacements||[])) {
      for (const optOC of optimizedOCs) {
        const better = optOC.team.find(a => a.member === placement.member);
        if (!better) continue;
        if (optOC.ocName === oc.ocName && better.role === placement.role) continue;
        const currentImpact = impactMatrix[placement.member]?.[oc.ocId]?.[placement.role]?.delta || 0;
        const delta = (better.impact||0) - currentImpact;
        if (delta > 5) suboptimalPlacements.push({
          member: placement.member, currentOC: oc.ocName, currentRole: placement.role,
          currentCPR: placement.cpr, betterOC: optOC.ocName, betterRole: better.role,
          betterCPR: better.cpr, improvementDelta: parseFloat(delta.toFixed(1)),
        });
        break;
      }
    }
  }

  // ── Personal recommendation ───────────────────────────────────
  // Best slot for the requesting member — either their assigned slot or
  // the next best available slot if they weren't assigned anywhere.
  // Always returned (even if already assigned) so members on member keys
  // see their recommendation regardless of whether they can see all OCs.
  let personalRecommendation = null;
  if (requestingMember) {
    const bestEntry = queue.find(i =>
      i.member === requestingMember &&
      !unfillableOCIds.has(i.ocId) && (
        !filledRoles[i.ocId]?.[i.role] ||
        filledRoles[i.ocId][i.role] === requestingMember
      )
    );
    if (bestEntry) {
      const optOC = optimizedOCs.find(o => o.ocId === bestEntry.ocId);
      personalRecommendation = {
        member:           requestingMember,
        ocName:           bestEntry.ocName,
        level:            bestEntry.ocLevel,
        role:             bestEntry.role,
        cpr:              bestEntry.cpr,
        roleType:         bestEntry.roleType,
        projectedSuccess: optOC?.projectedSuccess ?? null,
        impact:           parseFloat(bestEntry.delta.toFixed(1)),
        flag:             bestEntry.flag,
      };
    }
  }

  return {
    optimizedOCs, suboptimalPlacements, personalRecommendation,
    unassignedMembers: memberPool
      .filter(m => !usedMembers.has(m.name))
      .map(m => ({ name: m.name, status: m.status||'available', reason: m.status==='hospital' ? 'hospital' : 'no_slot_available' })),
    meta: {
      membersConsidered: memberPool.length,
      ocsOptimized:      ocList.length,
      assignmentsMade:   usedMembers.size,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.json({status:'ok', version:'3.0.0', ocs: Object.keys(FLOWCHARTS).length}));

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
  const {ocs, requestingMember, mode = 'spread'} = req.body;
  if (!Array.isArray(ocs) || ocs.length === 0) return res.status(400).json({error:'ocs must be non-empty array'});
  const factionId = getFactionId(key);
  // Normalise OC names from client (Torn may send different capitalisation)
  const normalizedOCs = ocs.map(o => ({...o, ocName: normOCName(o.ocName)}));

  const cacheKey  = hashObject({ocs: normalizedOCs.map(o => ({ocName:o.ocName, openRoles:(o.openRoles||[]).sort(), filledCPRs:o.filledCPRs||{}, members:(o.availableMembers||[]).map(m=>m.name).sort()})), requestingMember, mode});
  const cached = await getCachedOptimize(factionId, cacheKey);
  if (cached) return res.json({...cached, cached:true});
  try {
    const result = await optimizeFaction(factionId, normalizedOCs, requestingMember, mode);
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
       DO UPDATE SET
         cprs = member_cpr.cprs || $4::jsonb,
         source = $3,
         updated_at = NOW()`,
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
  const entries = Object.entries(members).filter(([name]) => name && !/^\d/.test(name.trim()) && name.trim().length >= 2);
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
           cprs = member_cpr.cprs || $3::jsonb,
           source = 'tornstats',
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

app.post('/api/cpr/cleanup', rateLimit('cpr'), async (req, res) => {
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

// ── /api/cpr/purge ────────────────────────────────────────────
// Leader only. Removes specific named members from member_cpr.
// Used to purge ex-members whose data persists after they leave.
app.post('/api/cpr/purge', rateLimit('cpr'), async (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res); if (!owner) return;
  if (!isLeaderKey(key)) return res.status(403).json({error:'Leader key required'});
  const factionId = getFactionId(key);
  const { members } = req.body;
  if (!Array.isArray(members) || !members.length) return res.status(400).json({error:'members array required'});
  try {
    let removed = 0;
    for (const name of members) {
      if (typeof name !== 'string' || !name.trim()) continue;
      const r = await query('DELETE FROM member_cpr WHERE faction_id=$1 AND member_name=$2', [factionId, name.trim()]);
      removed += r.rowCount;
    }
    await invalidateCache(factionId);
    console.log(`[CPR PURGE] Removed ${removed} ex-members from faction ${factionId}`);
    res.json({ok:true, removed, requested:members.length});
  } catch(e) {
    console.error('[CPR PURGE] Error:', e.message);
    res.status(500).json({error:'Purge failed: '+e.message});
  }
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

  // Build OCS_ROLES display data — tier, absMin, idealMin, safe flag, safety text
  // Generated from server OCS_ROLES so UI always matches optimizer
  const ocsRolesDisplay = {};
  Object.entries(OCS_ROLES).forEach(([ocName, roles]) => {
    ocsRolesDisplay[ocName] = {};
    Object.entries(roles).forEach(([role, r]) => {
      const isCrit = r.tier === 'CRITICAL';
      const isFree = r.tier === 'FREE';
      const safetyIcon = isFree ? '🟢' : isCrit ? '🔴' : '🟠';
      const tierLabel  = isFree ? 'FREE SLOT' : isCrit ? 'CRITICAL' : 'IMPORTANT';
      const rangeStr   = isFree ? 'Any CPR — free role' : `Needs ${r.absMin}–${Math.min(r.idealMin+6,99)}%`;
      const safety = isFree
        ? `${safetyIcon} FREE SLOT — CPR has negligible impact. Any member accepted.`
        : `${safetyIcon} ${tierLabel} — ${rangeStr}`;
      ocsRolesDisplay[ocName][role] = {
        tier:     r.tier,
        absMin:   r.absMin,
        idealMin: r.idealMin,
        safe:     isFree,
        crit:     isCrit,
        safety,
      };
    });
  });

  res.json({
    roles:        ROLE_COLORS,
    context:      roleContext,
    ocsRoles:     ocsRolesDisplay,
    roleCPRRanges: ROLE_CPR_RANGES,
  });
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

// ── /api/cpr/member ───────────────────────────────────────────
// Accepts CPR data submitted by a member using their own member OCA key.
// The member's Torn API key is used client-side to pull CPR — it never
// reaches this server. Only the extracted CPR payload is sent here.
// member_api data wins over tornstats at the OC level on conflict.
app.post('/api/cpr/member', rateLimit('cpr'), async (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res); if (!owner) return;

  const { memberName, cprs } = req.body;
  if (!memberName || typeof memberName !== 'string' || !memberName.trim()) {
    return res.status(400).json({ error: 'memberName required' });
  }
  if (!cprs || typeof cprs !== 'object' || !Object.keys(cprs).length) {
    return res.status(400).json({ error: 'cprs required' });
  }

  const factionId = getFactionId(key);
  const name      = memberName.trim();

  // Validate CPR values — each must be a number 0-100
  for (const [ocName, roles] of Object.entries(cprs)) {
    if (typeof roles !== 'object') return res.status(400).json({ error: `Invalid cprs for OC: ${ocName}` });
    for (const [role, val] of Object.entries(roles)) {
      if (typeof val !== 'number' || val < 0 || val > 100) {
        return res.status(400).json({ error: `Invalid CPR value for ${ocName}/${role}: ${val}` });
      }
    }
  }

  try {
    // member_api data wins over tornstats — merge incoming on top of existing
    await query(
      `INSERT INTO member_cpr (faction_id, member_name, source, cprs, updated_at)
       VALUES ($1, $2, 'member_api', $3, NOW())
       ON CONFLICT (faction_id, member_name)
       DO UPDATE SET
         cprs       = member_cpr.cprs || $3::jsonb,
         source     = 'member_api',
         updated_at = NOW()`,
      [factionId, name, JSON.stringify(cprs)]
    );
    await invalidateCache(factionId);
    console.log(`[CPR MEMBER] Updated ${name} in faction ${factionId} — ${Object.keys(cprs).length} OCs`);
    res.json({ ok: true, memberName: name, factionId, ocCount: Object.keys(cprs).length });
  } catch(e) {
    console.error('[CPR MEMBER] Error:', e.message);
    res.status(500).json({ error: 'Failed to save member CPR' });
  }
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
// ROSTER / COVERAGE HELPERS
// ═══════════════════════════════════════════════════════════════

// OC level → absMin and idealMin thresholds (mirrors OCS_ROLES comments)
const LEVEL_ABSMIN  = {1:50,2:50,3:55,4:55,5:58,6:58,7:60,8:62,9:64,10:66};
const LEVEL_IDEALMIN = {1:65,2:65,3:68,4:68,5:70,6:70,7:72,8:74,9:76,10:78};

// OC name → level lookup (derived from FLOWCHARTS)
function getOCLevel(ocName) {
  return FLOWCHARTS[ocName]?.level ?? FLOWCHARTS[normOCName(ocName)]?.level ?? null;
}

// Compute member ceiling: highest OC level where member has ≥1 non-FREE role ≥ absMin.
// Returns { level, cpr, isStrong } or null.
// isStrong = CPR ≥ idealMin for that level (community 2-to-1 threshold).
function getMemberCeiling(memberData) {
  if (!memberData?.cprs) return null;
  let ceiling = 0, ceilingCPR = null;

  Object.entries(memberData.cprs).forEach(([storedOC, roles]) => {
    const level = getOCLevel(storedOC);
    if (!level) return;
    const am = LEVEL_ABSMIN[level] || 50;

    Object.entries(roles).forEach(([role, cpr]) => {
      const rc = getRoleCPRRange(role);
      if (rc.safe) return;                                    // skip FREE roles
      if (typeof cpr !== 'number') return;
      if (cpr >= am && (level > ceiling || (level === ceiling && cpr > (ceilingCPR || 0)))) {
        ceiling = level;
        ceilingCPR = cpr;
      }
    });
  });

  if (ceiling === 0) return null;
  const im = LEVEL_IDEALMIN[ceiling] || 65;
  return { level: ceiling, cpr: ceilingCPR, isStrong: ceilingCPR >= im };
}

// ── /api/roster ──────────────────────────────────────────────
// Returns per-member ceiling level, CPR, strong/marginal flag.
// Leader key only — business logic stays server-side.
app.get('/api/roster', rateLimit('roster'), async (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res); if (!owner) return;
  if (!isLeaderKey(key)) return res.status(403).json({error:'Leader key required'});
  const factionId = getFactionId(key);

  try {
    const r = await query(
      'SELECT member_name, source, cprs, updated_at FROM member_cpr WHERE faction_id=$1',
      [factionId]
    );

    const members = r.rows.map(row => {
      const data = { cprs: row.cprs, source: row.source, updatedAt: row.updated_at };
      const ceiling = getMemberCeiling(data);
      return {
        name:     row.member_name,
        ceiling,                          // { level, cpr, isStrong } or null
        source:   row.source,
        isStale:  isCPRStale(row.updated_at),
        updatedAt: row.updated_at,
      };
    });

    // Sort ceiling desc, then name asc
    members.sort((a, b) =>
      (b.ceiling?.level || 0) - (a.ceiling?.level || 0) ||
      a.name.localeCompare(b.name)
    );

    res.json({ members, factionId });
  } catch(e) {
    console.error('[ROSTER] Error:', e.message);
    res.status(500).json({ error: 'Failed to compute roster' });
  }
});

// ── /api/coverage ─────────────────────────────────────────────
// Returns per-level depth counts (strong / marginal) for every level
// the faction is currently capable of running (L1 up to highest member ceiling).
// Strong  = ceilingCPR ≥ idealMin for that level
// Marginal = ceilingCPR ≥ absMin but below idealMin
// A member with ceiling Lx counts for Lx AND all lower levels.
// Leader key only.
app.get('/api/coverage', rateLimit('coverage'), async (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res); if (!owner) return;
  if (!isLeaderKey(key)) return res.status(403).json({error:'Leader key required'});
  const factionId = getFactionId(key);

  try {
    const r = await query(
      'SELECT member_name, cprs, updated_at FROM member_cpr WHERE faction_id=$1',
      [factionId]
    );

    // Compute ceiling for every member in DB
    const ceilings = r.rows.map(row => {
      const ceiling = getMemberCeiling({ cprs: row.cprs });
      return { name: row.member_name, ceiling };
    }).filter(m => m.ceiling !== null);

    // Find max level to cap our range dynamically
    const maxLevel = ceilings.reduce((max, m) => Math.max(max, m.ceiling.level), 0);
    if (maxLevel === 0) return res.json({ levels: {}, maxLevel: 0, factionId });

    // Build per-level depth counts
    // Each member counts for their ceiling level AND every level below it
    const levels = {};
    for (let lvl = 1; lvl <= maxLevel; lvl++) {
      levels[lvl] = { strong: 0, marginal: 0, members: [] };
    }

    for (const { name, ceiling } of ceilings) {
      const im = LEVEL_IDEALMIN[ceiling.level] || 65;
      const isStrong = ceiling.cpr >= im;

      // Count this member for their ceiling level and all levels below
      for (let lvl = 1; lvl <= ceiling.level; lvl++) {
        if (isStrong) {
          levels[lvl].strong++;
        } else {
          levels[lvl].marginal++;
        }
        levels[lvl].members.push({ name, cpr: ceiling.cpr, isStrong, ceilingLevel: ceiling.level });
      }
    }

    res.json({ levels, maxLevel, factionId });
  } catch(e) {
    console.error('[COVERAGE] Error:', e.message);
    res.status(500).json({ error: 'Failed to compute coverage' });
  }
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

computeRoleColors();
startup().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Hive OC Advisor v3.6.0 running on port ${PORT}`);
    console.log(`[SERVER] OCs loaded: ${Object.keys(FLOWCHARTS).length}`);
  });
}).catch(err => {
  console.error('[SERVER] Startup failed:', err.message);
  process.exit(1);
});
