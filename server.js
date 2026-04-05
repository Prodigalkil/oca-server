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
  max: 20,                // max pool connections
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
// STARTUP — verify DB connection and migrate keys.txt if needed
// ═══════════════════════════════════════════════════════════════

async function startup() {
  try {
    await query('SELECT 1');
    console.log('[DB] PostgreSQL connected');
    await migrateKeysFromFile();
  } catch(e) {
    console.error('[DB] Connection failed:', e.message);
    console.error('[DB] Falling back to keys.txt for key validation');
  }
}

// ═══════════════════════════════════════════════════════════════
// CORS
// ═══════════════════════════════════════════════════════════════

app.use(cors({
  origin: (origin, cb) => {
    if(!origin || origin.includes('torn.com') || origin.includes('localhost')) cb(null, true);
    else cb(new Error('CORS blocked'));
  }
}));
app.use(express.json({ limit: '2mb' }));

// ═══════════════════════════════════════════════════════════════
// KEY MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// Parse key format: OCA-L50310-Prodigal or OCA-M50310-UncleLeeLee
function parseKey(key) {
  const m = (key||'').match(/^OCA-([LMlm])(\d+)-(.+)$/i);
  if(!m) return null;
  return {
    key,
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

// Load keys from keys.txt as fallback
function loadKeysFromFile() {
  try {
    const file = fs.readFileSync(path.join(__dirname, 'keys.txt'), 'utf8');
    const keys = {};
    file.split('\n').forEach(line => {
      line = line.trim();
      if(!line || line.startsWith('#')) return;
      const [k, ...rest] = line.split(/\s+/);
      if(k) keys[k] = rest.join(' ') || 'unknown';
    });
    return keys;
  } catch(e) {
    return {};
  }
}

// Migrate keys.txt into DB (runs once on startup)
async function migrateKeysFromFile() {
  const fileKeys = loadKeysFromFile();
  if(!Object.keys(fileKeys).length) return;

  let migrated = 0;
  for(const [key, ownerName] of Object.entries(fileKeys)) {
    // Skip example/comment keys
    if(key.startsWith('#') || ownerName === 'unknown') continue;

    const parsed = parseKey(key);
    if(!parsed) continue;

    try {
      await query(
        `INSERT INTO api_keys (key, owner_name, faction_id, key_type)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO NOTHING`,
        [parsed.key, parsed.ownerName, parsed.factionId, parsed.keyType]
      );
      migrated++;
    } catch(e) {
      // ignore individual key errors
    }
  }
  if(migrated > 0) console.log(`[KEYS] Migrated ${migrated} keys from keys.txt to DB`);
}

// Validate key — checks DB first, falls back to keys.txt
async function validateKey(req, res) {
  const key = req.headers['x-oca-key'] || req.query.key;
  if(!key) { res.status(401).json({ error: 'Missing API key' }); return null; }

  // Try DB first
  try {
    const result = await query(
      'SELECT owner_name FROM api_keys WHERE key = $1 AND active = TRUE',
      [key]
    );
    if(result.rows.length > 0) return result.rows[0].owner_name;
  } catch(e) {
    // DB unavailable — fall through to file fallback
    console.warn('[KEYS] DB lookup failed, trying keys.txt fallback');
  }

  // File fallback
  const fileKeys = loadKeysFromFile();
  if(fileKeys[key]) return fileKeys[key];

  res.status(403).json({ error: 'Invalid API key' });
  return null;
}

// ═══════════════════════════════════════════════════════════════
// RATE LIMITING — in-memory sliding window per endpoint per key
// ═══════════════════════════════════════════════════════════════

const RATE_LIMITS = {
  'score':          { max: 120, window: 60000 },
  'score_batch':    { max: 30,  window: 60000 },
  'optimize':       { max: 6,   window: 60000 },
  'cpr':            { max: 20,  window: 60000 },
  'cpr_batch':      { max: 10,  window: 60000 },
  'assign':         { max: 30,  window: 60000 },
  'assignments':    { max: 60,  window: 60000 },
  'assignment':     { max: 60,  window: 60000 },
};

const _rateLimits = new Map();

function checkRateLimit(key, endpoint) {
  const config = RATE_LIMITS[endpoint] || { max: 60, window: 60000 };
  const mapKey = `${key}:${endpoint}`;
  const now = Date.now();

  if(!_rateLimits.has(mapKey)) _rateLimits.set(mapKey, []);
  const times = _rateLimits.get(mapKey).filter(t => now - t < config.window);

  if(times.length >= config.max) return false;
  times.push(now);
  _rateLimits.set(mapKey, times);
  return true;
}

function rateLimit(endpoint) {
  return (req, res, next) => {
    const key = req.headers['x-oca-key'] || req.query.key || 'anonymous';
    if(!checkRateLimit(key, endpoint)) {
      return res.status(429).json({ error: `Rate limit exceeded for ${endpoint}` });
    }
    next();
  };
}

// Clean up rate limit maps every 5 minutes
setInterval(() => {
  const now = Date.now();
  for(const [k, times] of _rateLimits.entries()) {
    const filtered = times.filter(t => now - t < 120000);
    if(filtered.length === 0) _rateLimits.delete(k);
    else _rateLimits.set(k, filtered);
  }
}, 300000);

// ═══════════════════════════════════════════════════════════════
// DAG FLOWCHART ENGINE
// ═══════════════════════════════════════════════════════════════

const SCOPE_BREAKEVEN = {1:0.50,2:0.60,3:0.67,4:0.72,5:0.77,6:0.80,7:0.83,8:0.86,9:0.90};

const SAFE_ROLES = ['Looter','Lookout','Arsonist','Decoy'];

const ROLE_CPR_RANGES = {
  'Looter':     { idealMin:0,  idealMax:99, absMin:0,  overQual:99, safe:true  },
  'Lookout':    { idealMin:0,  idealMax:99, absMin:0,  overQual:99, safe:true  },
  'Arsonist':   { idealMin:0,  idealMax:99, absMin:0,  overQual:99, safe:true  },
  'Decoy':      { idealMin:0,  idealMax:99, absMin:0,  overQual:99, safe:true  },
  'Driver':     { idealMin:58, idealMax:74, absMin:53, overQual:85, safe:false },
  'Muscle':     { idealMin:58, idealMax:75, absMin:50, overQual:86, safe:false },
  'Enforcer':   { idealMin:60, idealMax:75, absMin:52, overQual:87, safe:false },
  'Kidnapper':  { idealMin:58, idealMax:75, absMin:50, overQual:86, safe:false },
  'Negotiator': { idealMin:58, idealMax:74, absMin:55, overQual:85, safe:false },
  'Imitator':   { idealMin:58, idealMax:74, absMin:52, overQual:85, safe:false },
  'Hustler':    { idealMin:58, idealMax:74, absMin:52, overQual:85, safe:false },
  'Hacker':     { idealMin:60, idealMax:73, absMin:58, overQual:84, safe:false },
  'Techie':     { idealMin:60, idealMax:73, absMin:58, overQual:84, safe:false },
  'Engineer':   { idealMin:62, idealMax:73, absMin:60, overQual:84, safe:false },
  'Bomber':     { idealMin:60, idealMax:73, absMin:58, overQual:84, safe:false },
  'Thief':      { idealMin:58, idealMax:74, absMin:53, overQual:85, safe:false },
  'Robber':     { idealMin:58, idealMax:74, absMin:53, overQual:85, safe:false },
  'Sniper':     { idealMin:58, idealMax:74, absMin:55, overQual:85, safe:false },
  'Car Thief':  { idealMin:60, idealMax:74, absMin:55, overQual:85, safe:false },
  'Picklock':   { idealMin:55, idealMax:74, absMin:50, overQual:85, safe:false },
  'Pickpocket': { idealMin:55, idealMax:74, absMin:48, overQual:85, safe:false },
};

function getRoleBase(role) {
  return (role||'').replace(/\s+\d+$/,'');
}

function getRoleCPRRange(role) {
  const base = getRoleBase(role);
  return ROLE_CPR_RANGES[role] || ROLE_CPR_RANGES[base] || {
    idealMin:58, idealMax:74, absMin:50, overQual:85, safe:false
  };
}

// ── FLOWCHARTS ───────────────────────────────────────────────────────────────

const FLOWCHARTS = {
  'Bidding War': {
    level: 8,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Bomber 1',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A1_C2_':{roles:['Bomber 1','Bomber 2'],pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A2_C1_':{role:'Driver',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A2_C2_':{role:'Driver',pass:'_A3_C1_',fail:'_A2_C3_'},
      '_A3_C1_':{role:'Robber 1',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A3_C2_':{role:'Robber 2',pass:'_A4_C1_',fail:'_A3_C3_'},
      '_A4_C1_':{role:'Robber 3',pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A5_C1_':{role:'Robber 3',pass:'_A6_C1_',fail:'_A5_C2_'},
      '_A5_C2_':{role:'Robber 2',pass:'_A6_C2_',fail:'_A5F_'},
      '_A4_C2_':{role:'Bomber 2',pass:'_A5_C1_',fail:'_A4_C3_'},
      '_A4_C3_':{role:'Robber 1',pass:'_A4F2_',fail:'_A4F_'},
      '_A6_C1_':{roles:['Driver','Robber 3'],pass:'_A7_C1_',fail:'_A6_C2_'},
      '_A7_C1_':{role:'Bomber 2',pass:'_A8S_',fail:'_A8S2_'},
      '_A3_C3_':{roles:['Robber 1','Robber 2'],pass:'_A4_C1_',fail:'_A3F_'},
      '_A6_C2_':{role:'Robber 2',pass:'_A6S_',fail:'_A6S2_'},
      '_A1_C3_':{roles:['Driver','Bomber 1'],pass:'_A2_C1_',fail:'_A1F_'},
      '_A2_C3_':{role:'Driver',pass:'_A3_C1_',fail:'_A2F_'},
      '_A8S_':{end:true,payout:1.0},'_A8S2_':{end:true,payout:0.7678},
      '_A6S_':{end:true,payout:0.6991},'_A6S2_':{end:true,payout:0.5954},
      '_A4F2_':{end:true,payout:0},'_A4F_':{end:true,payout:0},
      '_A5F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},
      '_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},
    }
  },
  'No Reserve': {
    level: 6,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Techie',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Techie',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Techie',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A4_C1_':{roles:['Car Thief','Thief'],pass:'_A5_C1_',fail:'_B4_C1_'},
      '_A5_C1_':{role:'Engineer',pass:'_A6_C1_',fail:'_B5_C1_'},
      '_B5_C1_':{roles:['Car Thief','Thief'],pass:'_B8_C1_',fail:'_B5_C2_'},
      '_B5_C2_':{role:'Techie',pass:'_B6_C1_',fail:'_B5F_'},
      '_B6_C1_':{roles:['Car Thief','Engineer','Thief'],pass:'_B7S_',fail:'_B6_C2_'},
      '_B6_C2_':{role:'Techie',pass:'_B7S_',fail:'_B6F_'},
      '_A3_C2_':{role:'Engineer',pass:'_A4_C1_',fail:'_A3_C3_'},
      '_B4_C1_':{role:'Engineer',pass:'_B5_C1_',fail:'_B4F_'},
      '_A2_C2_':{roles:['Car Thief','Techie','Thief'],pass:'_A3_C1_',fail:'_A2_C3_'},
      '_A3_C3_':{roles:['Car Thief','Thief'],pass:'_B4_C1_',fail:'_A3F_'},
      '_B8_C1_':{role:'Techie',pass:'_B9S_',fail:'_B8_C2_'},
      '_B8_C2_':{roles:['Car Thief','Engineer','Thief'],pass:'_B8S_',fail:'_B8F_'},
      '_A1_C2_':{roles:['Engineer','Techie'],pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A1_C3_':{roles:['Car Thief','Techie','Thief'],pass:'_A2_C1_',fail:'_A1F_'},
      '_A2_C3_':{role:'Engineer',pass:'_A3_C1_',fail:'_A2F_'},
      '_A6_C1_':{role:'Techie',pass:'_A7S_',fail:'_B8_C1_'},
      '_B8S_':{end:true,payout:0},'_A7S_':{end:true,payout:0},'_B9S_':{end:true,payout:0},
      '_B6F_':{end:true,payout:0},'_B4F_':{end:true,payout:0},'_B8F_':{end:true,payout:0},
      '_A3F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},
      '_B7S_':{end:true,payout:0},'_B5F_':{end:true,payout:0},
    }
  },
  'Blast from the Past': {
    level: 8,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Muscle',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A1_C2_':{roles:['Picklock 1','Picklock 2'],pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A2_C1_':{role:'Hacker',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Muscle',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A3_C2_':{role:'Muscle',pass:'_A4_C1_',fail:'_A3F_'},
      '_A4_C1_':{role:'Engineer',pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A4_C2_':{roles:['Engineer','Muscle'],pass:'_A5_C1_',fail:'_A4F_'},
      '_A5_C1_':{role:'Bomber',pass:'_A6_C1_',fail:'_A5_C2_'},
      '_A5_C2_':{roles:['Engineer','Bomber'],pass:'_B6_C1_',fail:'_A5F_'},
      '_B6_C1_':{role:'Picklock 2',pass:'_B7_C1_',fail:'_B7_C1_'},
      '_B7_C1_':{role:'Picklock 1',pass:'_B8_C1_',fail:'_B8_C1_'},
      '_B8_C1_':{role:'Hacker',pass:'_B8S1_',fail:'_B8S2_'},
      '_A2_C2_':{role:'Picklock 1',pass:'_A3_C1_',fail:'_A2_C3_'},
      '_A2_C3_':{roles:['Picklock 1','Hacker'],pass:'_A3_C1_',fail:'_A2F_'},
      '_A1_C3_':{role:'Hacker',pass:'_A2_C1_',fail:'_A1F_'},
      '_A6_C1_':{role:'Picklock 2',pass:'_A7_C1_',fail:'_A6_C2_'},
      '_A7_C1_':{role:'Picklock 1',pass:'_A8_C1_',fail:'_A7_C2_'},
      '_A7_C2_':{role:'Picklock 2',pass:'_A8_C1_',fail:'_B7_C1_'},
      '_A8_C1_':{role:'Hacker',pass:'_A9S_',fail:'_A10S_'},
      '_A6_C2_':{roles:['Picklock 2','Engineer'],pass:'_A7_C1_',fail:'_B6_C1_'},
      '_B8S1_':{end:true,payout:0.7493},'_A10S_':{end:true,payout:0.843},
      '_B8S2_':{end:true,payout:0.5922},'_A9S_':{end:true,payout:1.0},
      '_A5F_':{end:true,payout:0},'_A4F_':{end:true,payout:0},
      '_A3F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},
    }
  },
  'Break the Bank': {
    level: 9,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{roles:['Robber','Muscle 1'],pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{roles:['Muscle 2','Thief 1'],pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Muscle 3',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A4_C1_':{role:'Thief 2',pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A5_C1_':{role:'Muscle 3',pass:'_A6_C1_',fail:'_A5_C2_'},
      '_A6_C1_':{roles:['Robber','Muscle 1'],pass:'_A7_C1_',fail:'_A7_C2_'},
      '_A7_C1_':{roles:['Robber','Muscle 1'],pass:'_A8_C1_',fail:'_A7_C2_'},
      '_A7_C2_':{roles:['Robber','Muscle 1'],pass:'_A9S_',fail:'_A10S_'},
      '_A5_C2_':{roles:['Muscle 3','Muscle 1'],pass:'_A6_C1_',fail:'_A5F_'},
      '_A1_C2_':{role:'Muscle 2',pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A1_C3_':{role:'Muscle 3',pass:'_A2_C1_',fail:'_A1F_'},
      '_A3_C2_':{roles:['Muscle 3','Thief 2'],pass:'_A4_C1_',fail:'_A4_C2_'},
      '_A8_C1_':{roles:['Robber','Thief 1'],pass:'_A8S_',fail:'_A8S2_'},
      '_A2_C2_':{roles:['Muscle 2','Thief 1'],pass:'_A3_C1_',fail:'_B1_C1_'},
      '_A4_C2_':{roles:['Robber','Thief 2'],pass:'_A5_C1_',fail:'_A4F_'},
      '_B1_C1_':{role:'Thief 2',pass:'_B2_C1_',fail:'_B1F_'},
      '_B2_C1_':{role:'Muscle 3',pass:'_B3S_',fail:'_B2_C2_'},
      '_B2_C2_':{role:'Muscle 1',pass:'_B3S_',fail:'_B2F_'},
      '_A9S_':{end:true,payout:0.8597},'_A10S_':{end:true,payout:0.7258},
      '_A8S_':{end:true,payout:1.0},'_B3S_':{end:true,payout:0.592},
      '_A8S2_':{end:true,payout:0.9874},'_B2F_':{end:true,payout:0},
      '_A4F_':{end:true,payout:0},'_A5F_':{end:true,payout:0},
      '_B1F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},
    }
  },
  'Snow Blind': {
    level: 5,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A1_C2_':{role:'Muscle 1',pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A1_C3_':{role:'Muscle 2',pass:'_A2_C1_',fail:'_A1F_'},
      '_A2_C1_':{role:'Hustler',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A2_C2_':{role:'Imitator',pass:'_A3_C1_',fail:'_B1_C1_'},
      '_A3_C1_':{role:'Imitator',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A4_C1_':{role:'Hustler',pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A4_C2_':{role:'Hustler',pass:'_A5_C1_',fail:'_A4_C3_'},
      '_A5_C1_':{role:'Hustler',pass:'_A6_C1_',fail:'_A5_C2_'},
      '_A5_C2_':{role:'Imitator',pass:'_A6_C1_',fail:'_A5F_'},
      '_A6_C1_':{role:'Imitator',pass:'_A7_C1_',fail:'_A6_C2_'},
      '_A7_C1_':{role:'Imitator',pass:'_A8S1_',fail:'_A8S2_'},
      '_A6_C2_':{role:'Hustler',pass:'_B7_C1_',fail:'_A6_C3_'},
      '_A6_C3_':{roles:['Muscle 1','Muscle 2'],pass:'_B8S_',fail:'_A6F_'},
      '_B7_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_B7S1_',fail:'_B7S2_'},
      '_A3_C2_':{role:'Hustler',pass:'_A4_C1_',fail:'_A4_C3_'},
      '_A4_C3_':{role:'Hustler',pass:'_A4S_',fail:'_A4F_'},
      '_B1_C1_':{role:'Muscle 1',pass:'_B1F3_',fail:'_B1_C2_'},
      '_B1_C2_':{role:'Muscle 2',pass:'_B1F2_',fail:'_B1F1_'},
      '_A8S1_':{end:true,payout:1.0},'_A8S2_':{end:true,payout:0.9528},
      '_B7S1_':{end:true,payout:0.7317},'_B7S2_':{end:true,payout:0.6364},
      '_B8S_':{end:true,payout:0.5609},'_A4S_':{end:true,payout:0.4697},
      '_B1F3_':{end:true,payout:0},'_B1F2_':{end:true,payout:0},'_B1F1_':{end:true,payout:0},
      '_A4F_':{end:true,payout:0},'_A5F_':{end:true,payout:0},'_A6F_':{end:true,payout:0},
      '_A1F_':{end:true,payout:0},
    }
  },
  'Counter Offer': {
    level: 5,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Robber',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Engineer',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Hacker',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A4_C1_':{role:'Picklock',pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A5_C1_':{role:'Looter',pass:'_A5S_',fail:'_A5S_'},
      '_A1_C2_':{role:'Engineer',pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A2_C2_':{role:'Hacker',pass:'_A3_C1_',fail:'_A2_C3_'},
      '_A3_C2_':{role:'Picklock',pass:'_A4_C1_',fail:'_A3F_'},
      '_A4_C2_':{role:'Robber',pass:'_A5_C1_',fail:'_A4F_'},
      '_A1_C3_':{role:'Hacker',pass:'_A2_C1_',fail:'_A1F_'},
      '_A2_C3_':{role:'Picklock',pass:'_A3_C1_',fail:'_A2F_'},
      '_A5S_':{end:true,payout:1.0},'_A3F_':{end:true,payout:0},
      '_A4F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},
    }
  },
  'Leave No Trace': {
    level: 6,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Techie',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Negotiator',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Techie',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A4_C1_':{role:'Imitator',pass:'_A4S_',fail:'_A4_C2_'},
      '_A4_C2_':{role:'Negotiator',pass:'_A4S2_',fail:'_A4F_'},
      '_A1_C2_':{role:'Negotiator',pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A2_C2_':{role:'Techie',pass:'_A3_C1_',fail:'_A2_C3_'},
      '_A3_C2_':{role:'Negotiator',pass:'_A4_C1_',fail:'_A3F_'},
      '_A1_C3_':{role:'Techie',pass:'_A2_C1_',fail:'_A1F_'},
      '_A2_C3_':{role:'Negotiator',pass:'_A3_C1_',fail:'_A2F_'},
      '_A4S_':{end:true,payout:1.0},'_A4S2_':{end:true,payout:0.7692},
      '_A4F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},
      '_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},
    }
  },
  'Honey Trap': {
    level: 5,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Enforcer',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Muscle 1',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Muscle 2',pass:'_A3S_',fail:'_A3_C2_'},
      '_A3_C2_':{role:'Enforcer',pass:'_A3S2_',fail:'_A3F_'},
      '_A1_C2_':{role:'Muscle 1',pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A2_C2_':{role:'Muscle 2',pass:'_A3_C1_',fail:'_A2F_'},
      '_A1_C3_':{role:'Muscle 2',pass:'_A2_C1_',fail:'_A1F_'},
      '_A3S_':{end:true,payout:1.0},'_A3S2_':{end:true,payout:0.7246},
      '_A3F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},
    }
  },
  'Guardian Angel': {
    level: 5,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Hustler',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Engineer',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Enforcer',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A4_C1_':{roles:['Enforcer','Engineer'],pass:'_A4S_',fail:'_A4_C2_'},
      '_A4_C2_':{role:'Hustler',pass:'_A4S2_',fail:'_A4F_'},
      '_A1_C2_':{role:'Engineer',pass:'_A2_C1_',fail:'_A1F_'},
      '_A2_C2_':{role:'Enforcer',pass:'_A3_C1_',fail:'_A2F_'},
      '_A3_C2_':{roles:['Enforcer','Engineer'],pass:'_A4_C1_',fail:'_A3F_'},
      '_A4S_':{end:true,payout:1.0},'_A4S2_':{end:true,payout:0.6923},
      '_A4F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},
      '_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},
    }
  },
  'Clinical Precision': {
    level: 7,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Cat Burglar',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Assassin',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Assassin',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A4_C1_':{role:'Cleaner',pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A5_C1_':{role:'Assassin',pass:'_A5S_',fail:'_A5_C2_'},
      '_A5_C2_':{role:'Imitator',pass:'_A5S2_',fail:'_A5F_'},
      '_A4_C2_':{role:'Imitator',pass:'_A5_C1_',fail:'_A4F_'},
      '_A3_C2_':{role:'Cleaner',pass:'_A4_C1_',fail:'_A3F_'},
      '_A2_C2_':{role:'Assassin',pass:'_A3_C1_',fail:'_A2F_'},
      '_A1_C2_':{role:'Assassin',pass:'_A2_C1_',fail:'_A1F_'},
      '_A5S_':{end:true,payout:1.0},'_A5S2_':{end:true,payout:0.75},
      '_A5F_':{end:true,payout:0},'_A4F_':{end:true,payout:0},
      '_A3F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},
    }
  },
  'Sneaky Git Grab': {
    level: 6,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Imitator',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Pickpocket',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A2_C2_':{role:'Pickpocket',pass:'_A3_C1_',fail:'_A2F_'},
      '_A3_C1_':{roles:['Pickpocket','Imitator'],pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A4_C1_':{role:'Techie',pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A5_C1_':{role:'Hacker',pass:'_A6_C1_',fail:'_A5_C2_'},
      '_A5_C2_':{role:'Hacker',pass:'_A6_C1_',fail:'_A5_C3_'},
      '_A6_C1_':{role:'Techie',pass:'_A7_C1_',fail:'_A6_C2_'},
      '_A7_C1_':{role:'Imitator',pass:'_A7S_',fail:'_A7S2_'},
      '_A1_C2_':{role:'Imitator',pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A6_C2_':{roles:['Imitator','Techie','Hacker'],pass:'_A8S_',fail:'_A9S_'},
      '_A4_C2_':{roles:['Pickpocket','Techie'],pass:'_A5_C1_',fail:'_A4F_'},
      '_A5_C3_':{roles:['Imitator','Hacker'],pass:'_B6_C1_',fail:'_A5F_'},
      '_B6_C1_':{role:'Hacker',pass:'_B7S_',fail:'_B6F_'},
      '_A1_C3_':{role:'Pickpocket',pass:'_A2_C1_',fail:'_A1F_'},
      '_A3_C2_':{role:'Imitator',pass:'_A4_C1_',fail:'_A3_C3_'},
      '_A3_C3_':{role:'Pickpocket',pass:'_A4_C1_',fail:'_A3F_'},
      '_A7S_':{end:true,payout:1.0},'_A8S_':{end:true,payout:0.7725},
      '_A7S2_':{end:true,payout:0.8727},'_A9S_':{end:true,payout:0.6827},
      '_B7S_':{end:true,payout:0.5948},'_A5F_':{end:true,payout:0},
      '_A4F_':{end:true,payout:0},'_B6F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},
      '_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},
    }
  },
  'Stage Fright': {
    level: 4,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{roles:['Lookout','Muscle 2'],pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Sniper',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A2_C2_':{roles:['Muscle 2','Muscle 1'],pass:'_A3_C1_',fail:'_A2F_'},
      '_A3_C1_':{roles:['Muscle 1','Muscle 3'],pass:'_A4_C1_',fail:'_B1_C1_'},
      '_B1_C1_':{role:'Enforcer',pass:'_B2_C1_',fail:'_B1_C2_'},
      '_B1_C2_':{role:'Sniper',pass:'_B2_C1_',fail:'_B1F_'},
      '_B2_C1_':{role:'Muscle 1',pass:'_B3_C1_',fail:'_B2_C2_'},
      '_B3_C1_':{role:'Sniper',pass:'_B4S_',fail:'_B3F_'},
      '_A1_C2_':{roles:['Lookout','Muscle 1'],pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A1_C3_':{roles:['Enforcer','Muscle 3'],pass:'_A2_C1_',fail:'_A1F_'},
      '_A4_C1_':{role:'Enforcer',pass:'_A5_C1_',fail:'_B2_C1_'},
      '_A5_C1_':{roles:['Lookout','Sniper'],pass:'_A6S_',fail:'_A7S_'},
      '_B2_C2_':{roles:['Sniper','Driver'],pass:'_B2S_',fail:'_B2F_'},
      '_A6S_':{end:true,payout:1.0},'_B4S_':{end:true,payout:0.7},'_A7S_':{end:true,payout:0.85},
      '_B2S_':{end:true,payout:0.6},'_B3F_':{end:true,payout:0},'_B2F_':{end:true,payout:0},
      '_B1F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},
    }
  },
  'Mob Mentality': {
    level: 1,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Looter 1',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A1_C2_':{role:'Looter 2',pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A2_C1_':{role:'Looter 2',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Looter 3',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A3_C2_':{role:'Looter 4',pass:'_A4_C1_',fail:'_A3_C3_'},
      '_A4_C1_':{role:'Looter 2',pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A4_C2_':{role:'Looter 1',pass:'_B1_C1_',fail:'_A4F_'},
      '_B1_C1_':{role:'Looter 4',pass:'_B2S_',fail:'_B3S_'},
      '_A1_C3_':{role:'Looter 3',pass:'_A2_C1_',fail:'_A1F_'},
      '_A2_C2_':{role:'Looter 4',pass:'_A3_C1_',fail:'_A2_C3_'},
      '_A2_C3_':{roles:['Looter 2','Looter 3'],pass:'_A3_C1_',fail:'_A2F_'},
      '_A5_C1_':{role:'Looter 4',pass:'_A7_C1_',fail:'_A5_C2_'},
      '_A7_C1_':{role:'Looter 2',pass:'_A7S_',fail:'_A7S2_'},
      '_A3_C3_':{role:'Looter 1',pass:'_D1_C1_',fail:'_A3_C4_'},
      '_D1_C1_':{role:'Looter 3',pass:'_D3S_',fail:'_D2F_'},
      '_A5_C2_':{role:'Looter 1',pass:'_A7S2_',fail:'_A5F_'},
      '_A3_C4_':{role:'Looter 2',pass:'_D1_C1_',fail:'_D1_C1_'},
      '_B2S_':{end:true,payout:0.8423},'_A7S2_':{end:true,payout:0.9279},
      '_A7S_':{end:true,payout:1.0},'_D3S_':{end:true,payout:0.524},
      '_B3S_':{end:true,payout:0.7518},'_A4F_':{end:true,payout:0},
      '_D2F_':{end:true,payout:0},'_A5F_':{end:true,payout:0},
      '_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},
    }
  },
  'Gaslight the Way': {
    level: 3,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{roles:['Imitator 1','Looter 1'],pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Imitator 2',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Imitator 3',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A4_C1_':{role:'Looter 3',pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A4_C2_':{role:'Looter 3',pass:'_A5_C1_',fail:'_A5_C1_'},
      '_A5_C1_':{roles:['Looter 2','Looter 3'],pass:'_A7_C1_',fail:'_B7_C1_'},
      '_A7_C1_':{role:'Imitator 2',pass:'_A7S_',fail:'_A7S2_'},
      '_A2_C2_':{role:'Imitator 2',pass:'_A3_C1_',fail:'_A2F_'},
      '_A3_C2_':{role:'Imitator 3',pass:'_B8_C1_',fail:'_A3F_'},
      '_A1_C2_':{roles:['Imitator 1','Looter 1'],pass:'_A2_C1_',fail:'_A1_C3_'},
      '_B7_C1_':{role:'Imitator 2',pass:'_B7S_',fail:'_B7S2_'},
      '_B8_C1_':{role:'Looter 3',pass:'_B9S_',fail:'_B8F_'},
      '_A1_C3_':{roles:['Imitator 1','Looter 1'],pass:'_A2_C1_',fail:'_A1F_'},
      '_A7S_':{end:true,payout:1.0},'_B7S_':{end:true,payout:0.8},'_B7S2_':{end:true,payout:0.7},
      '_A7S2_':{end:true,payout:0.85},'_B9S_':{end:true,payout:0.6},'_B8F_':{end:true,payout:0},
      '_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},
    }
  },
  'Smoke and Wing Mirrors': {
    level: 5,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Imitator',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A1_C2_':{roles:['Car Thief','Thief'],pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A2_C1_':{role:'Imitator',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{roles:['Car Thief','Thief'],pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A4_C1_':{roles:['Hustler 1','Hustler 2'],pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A5_C1_':{roles:['Car Thief','Thief'],pass:'_A6_C1_',fail:'_A5_C2_'},
      '_A6_C1_':{role:'Hustler 1',pass:'_A7S_',fail:'_A6_C2_'},
      '_A6_C2_':{roles:['Car Thief','Thief'],pass:'_A8S_',fail:'_A6_C3_'},
      '_A1_C3_':{role:'Imitator',pass:'_A2_C1_',fail:'_A1F_'},
      '_A6_C3_':{roles:['Car Thief','Thief'],pass:'_A9S_',fail:'_A6F_'},
      '_A2_C2_':{role:'Imitator',pass:'_A3_C1_',fail:'_A2_C3_'},
      '_A2_C3_':{roles:['Car Thief','Thief'],pass:'_A3_C1_',fail:'_A2F_'},
      '_A3_C2_':{roles:['Car Thief','Thief'],pass:'_A4_C1_',fail:'_A3F_'},
      '_A4_C2_':{role:'Hustler 2',pass:'_B2_C1_',fail:'_A4_C3_'},
      '_A4_C3_':{role:'Hustler 2',pass:'_B2_C1_',fail:'_A4F_'},
      '_A5_C2_':{role:'Imitator',pass:'_B3_C1_',fail:'_C1F_'},
      '_B2_C1_':{role:'Hustler 1',pass:'_B3_C1_',fail:'_B2_C2_'},
      '_B3_C1_':{role:'Imitator',pass:'_B3S_',fail:'_B3S2_'},
      '_B2_C2_':{role:'Hustler 2',pass:'_B3_C1_',fail:'_B2F_'},
      '_A8S_':{end:true,payout:0.9},'_A7S_':{end:true,payout:1.0},'_B3S2_':{end:true,payout:0.6},
      '_B3S_':{end:true,payout:0.7},'_A9S_':{end:true,payout:0.8},'_B2F_':{end:true,payout:0},
      '_A4F_':{end:true,payout:0},'_A6F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},
      '_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_C1F_':{end:true,payout:0},
    }
  },
  'Stacking the Deck': {
    level: 6,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Cat Burglar',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Driver',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A2_C2_':{role:'Driver',pass:'_A3_C1_',fail:'_B1_C1_'},
      '_A3_C1_':{role:'Cat Burglar',pass:'_A4_C1_',fail:'_B1_C1_'},
      '_B1_C1_':{role:'Imitator',pass:'_B2_C1_',fail:'_B1_C2_'},
      '_B1_C2_':{role:'Imitator',pass:'_B2_C1_',fail:'_B1F_'},
      '_A1_C2_':{roles:['Cat Burglar','Imitator'],pass:'_A2_C1_',fail:'_A1F_'},
      '_A4_C1_':{role:'Hacker',pass:'_A5_C1_',fail:'_B2_C1_'},
      '_B2_C1_':{role:'Hacker',pass:'_B3_C1_',fail:'_B2_C2_'},
      '_B2_C2_':{role:'Imitator',pass:'_B3_C1_',fail:'_B2F_'},
      '_B3_C1_':{role:'Imitator',pass:'_B4_C1_',fail:'_B3_C2_'},
      '_B4_C1_':{role:'Hacker',pass:'_B5S_',fail:'_B4S_'},
      '_A5_C1_':{role:'Hacker',pass:'_A6_C1_',fail:'_A5_C2_'},
      '_A5_C2_':{role:'Imitator',pass:'_A6S_',fail:'_A5F_'},
      '_A6_C1_':{role:'Imitator',pass:'_A7S_',fail:'_A6S_'},
      '_B3_C2_':{role:'Hacker',pass:'_B4S_',fail:'_B3F_'},
      '_A7S_':{end:true,payout:1.0},'_B3F_':{end:true,payout:0},'_B2F_':{end:true,payout:0},
      '_B5S_':{end:true,payout:0.8},'_A5F_':{end:true,payout:0},'_A6S_':{end:true,payout:0.85},
      '_B1F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_B4S_':{end:true,payout:0.7},
    }
  },
  'Best of the Lot': {
    level: 2,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Picklock',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Imitator',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A2_C2_':{role:'Muscle',pass:'_A3_C1_',fail:'_A2_C3_'},
      '_A2_C3_':{role:'Imitator',pass:'_A3_C1_',fail:'_A2F_'},
      '_A3_C1_':{roles:['Car Thief','Thief'],pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A3_C2_':{role:'Muscle',pass:'_A4_C3_',fail:'_A3_C3_'},
      '_A4_C3_':{role:'Muscle',pass:'_B1_C1_',fail:'_A4F_'},
      '_B1_C1_':{role:'Imitator',pass:'_B2S_',fail:'_B1_C2_'},
      '_A3_C3_':{role:'Imitator',pass:'_A4_C3_',fail:'_A3F_'},
      '_B1_C2_':{roles:['Picklock','Muscle'],pass:'_B3S_',fail:'_B1F_'},
      '_A4_C1_':{role:'Picklock',pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A4_C2_':{roles:['Car Thief','Picklock','Thief'],pass:'_B1_C1_',fail:'_A4_C3_'},
      '_A1_C2_':{role:'Muscle',pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A5_C1_':{role:'Muscle',pass:'_A6S_',fail:'_A5_C2_'},
      '_A5_C2_':{role:'Imitator',pass:'_A7S_',fail:'_A8S_'},
      '_A1_C3_':{roles:['Car Thief','Muscle','Thief'],pass:'_A1F2_',fail:'_A1F1_'},
      '_B2S_':{end:true,payout:0.85},'_B3S_':{end:true,payout:0.75},'_A8S_':{end:true,payout:0.7},
      '_A7S_':{end:true,payout:0.9},'_A6S_':{end:true,payout:1.0},'_A4F_':{end:true,payout:0},
      '_A1F1_':{end:true,payout:0},'_A3F_':{end:true,payout:0},'_B1F_':{end:true,payout:0},
      '_A2F_':{end:true,payout:0},'_A1F2_':{end:true,payout:0},
    }
  },
  'Pet Project': {
    level: 1,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Picklock',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Kidnapper',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Kidnapper',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A4_C1_':{role:'Muscle',pass:'_A5_C1_',fail:'_C1_C1_'},
      '_A5_C1_':{role:'Kidnapper',pass:'_A6_C1_',fail:'_A5_C2_'},
      '_A6_C1_':{role:'Muscle',pass:'_A7_C1_',fail:'_A6_C2_'},
      '_A6_C2_':{role:'Picklock',pass:'_A7_C1_',fail:'_A6_C3_'},
      '_A6_C3_':{role:'Muscle',pass:'_A8S_',fail:'_A6F_'},
      '_A2_C2_':{role:'Kidnapper',pass:'_A3_C1_',fail:'_B1_C1_'},
      '_A3_C2_':{role:'Muscle',pass:'_A4_C1_',fail:'_C1_C1_'},
      '_C1_C1_':{roles:['Picklock','Kidnapper'],pass:'_C3S_',fail:'_C1F_'},
      '_A1_C2_':{role:'Muscle',pass:'_B1_C1_',fail:'_A1_C3_'},
      '_A1_C3_':{role:'Picklock',pass:'_A2_C1_',fail:'_A1F_'},
      '_A7_C1_':{role:'Picklock',pass:'_A7S1_',fail:'_A7_C2_'},
      '_A5_C2_':{role:'Muscle',pass:'_A6_C1_',fail:'_C1_C1_'},
      '_B1_C1_':{role:'Muscle',pass:'_B2_C1_',fail:'_B1_C2_'},
      '_B1_C2_':{role:'Muscle',pass:'_B2_C1_',fail:'_B1F_'},
      '_A7_C2_':{role:'Muscle',pass:'_A7S2_',fail:'_A7F_'},
      '_B2_C1_':{role:'Kidnapper',pass:'_B3S_',fail:'_B2F_'},
      '_C3S_':{end:true,payout:0.6444},'_A7S1_':{end:true,payout:1.0},
      '_A7S2_':{end:true,payout:0.8871},'_B3S_':{end:true,payout:0.6142},
      '_A8S_':{end:true,payout:0.7874},'_A7F_':{end:true,payout:0},
      '_B2F_':{end:true,payout:0},'_A6F_':{end:true,payout:0},
      '_B1F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_C1F_':{end:true,payout:0},
    }
  },
  'Ace in the Hole': {
    level: 7,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Imitator',pass:'_A2_C1_',fail:'_B2_C1_'},
      '_A2_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Hacker',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A3_C2_':{role:'Hacker',pass:'_A4_C1_',fail:'_A3_C3_'},
      '_A4_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A4_C2_':{role:'Imitator',pass:'_A5_C1_',fail:'_A4_C3_'},
      '_A5_C1_':{role:'Driver',pass:'_A6_C1_',fail:'_A5_C2_'},
      '_A6_C1_':{role:'Hacker',pass:'_A7_C1_',fail:'_C6_C1_'},
      '_A7_C1_':{role:'Imitator',pass:'_A8S_',fail:'_A7_C2_'},
      '_A7_C2_':{roles:['Muscle 1','Muscle 2'],pass:'_A9S_',fail:'_A10S_'},
      '_C6_C1_':{role:'Imitator',pass:'_C7_C1_',fail:'_C6_C2_'},
      '_C7_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_C8S_',fail:'_C7F_'},
      '_B2_C1_':{role:'Muscle 2',pass:'_B3_C1_',fail:'_B2_C2_'},
      '_B3_C1_':{role:'Hacker',pass:'_B4_C1_',fail:'_B3_C2_'},
      '_B4_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_B5_C1_',fail:'_B4_C2_'},
      '_B5_C1_':{role:'Driver',pass:'_B6_C1_',fail:'_B5_C2_'},
      '_B5_C2_':{role:'Driver',pass:'_D6_C1_',fail:'_B5F_'},
      '_A4_C3_':{roles:['Imitator','Muscle 2'],pass:'_A5_C1_',fail:'_A4F_'},
      '_A5_C2_':{role:'Driver',pass:'_A6_C1_',fail:'_A5_C3_'},
      '_B3_C2_':{role:'Hacker',pass:'_B4_C1_',fail:'_B3F_'},
      '_A5_C3_':{role:'Driver',pass:'_A6_C1_',fail:'_C6_C1_'},
      '_C6_C2_':{roles:['Imitator','Muscle 2'],pass:'_C9S_',fail:'_C6F_'},
      '_B2_C2_':{roles:['Muscle 1','Muscle 2'],pass:'_B3_C1_',fail:'_B2F_'},
      '_D6_C1_':{role:'Hacker',pass:'_D7S_',fail:'_D6_C2_'},
      '_B6_C1_':{role:'Hacker',pass:'_B7S_',fail:'_B6_C2_'},
      '_A3_C3_':{role:'Hacker',pass:'_A4_C1_',fail:'_A3F_'},
      '_A2_C2_':{role:'Muscle 1',pass:'_A3_C1_',fail:'_A2_C3_'},
      '_B4_C2_':{role:'Muscle 1',pass:'_B5_C1_',fail:'_B4F_'},
      '_D6_C2_':{role:'Hacker',pass:'_D7S_',fail:'_D6F_'},
      '_B6_C2_':{role:'Hacker',pass:'_B7S_',fail:'_B6F_'},
      '_A2_C3_':{roles:['Muscle 2','Muscle 1'],pass:'_A3_C1_',fail:'_A2F_'},
      '_A10S_':{end:true,payout:0.7343},'_C8S_':{end:true,payout:0.6766},
      '_A8S_':{end:true,payout:1.0},'_D7S_':{end:true,payout:0.6101},
      '_B7S_':{end:true,payout:0.7793},'_C9S_':{end:true,payout:0.5883},
      '_A9S_':{end:true,payout:0.7904},'_D6F_':{end:true,payout:0},
      '_C7F_':{end:true,payout:0},'_B3F_':{end:true,payout:0},'_B2F_':{end:true,payout:0},
      '_C6F_':{end:true,payout:0},'_A4F_':{end:true,payout:0},'_B4F_':{end:true,payout:0},
      '_B6F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},
      '_B5F_':{end:true,payout:0},
    }
  },
  'Crane Reaction': {
    level: 7,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A1_C2_':{roles:['Sniper','Muscle 2'],pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A1_C3_':{roles:['Muscle 1','Muscle 2'],pass:'_A2_C1_',fail:'_A1F_'},
      '_A2_C1_':{roles:['Engineer','Lookout'],pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Bomber',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A3_C2_':{roles:['Sniper','Bomber'],pass:'_A4_C1_',fail:'_A3F_'},
      '_A4_C1_':{roles:['Lookout','Sniper','Muscle 1','Muscle 2'],pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A4_C2_':{roles:['Lookout','Sniper'],pass:'_A5_C1_',fail:'_A4_C3_'},
      '_A5_C1_':{roles:['Engineer','Bomber'],pass:'_A6_C1_',fail:'_A5_C2_'},
      '_A5_C2_':{roles:['Engineer','Bomber'],pass:'_A6_C1_',fail:'_B5_C1_'},
      '_B5_C1_':{roles:['Engineer','Bomber'],pass:'_B6_C1_',fail:'_B5_C2_'},
      '_B5_C2_':{roles:['Engineer','Bomber'],pass:'_B6_C1_',fail:'_B5F_'},
      '_A2_C2_':{roles:['Sniper','Driver'],pass:'_A3_C1_',fail:'_A2F_'},
      '_A6_C1_':{roles:['Lookout','Sniper'],pass:'_A7_C1_',fail:'_A6_C2_'},
      '_A6_C2_':{roles:['Muscle 1','Muscle 2'],pass:'_B7_C1_',fail:'_B6_C1_'},
      '_B7_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_B7S_',fail:'_B7_C2_'},
      '_B7_C2_':{roles:['Lookout','Sniper'],pass:'_B7S2_',fail:'_B7F_'},
      '_A7_C1_':{roles:['Muscle 2','Muscle 1'],pass:'_A8S_',fail:'_A7_C2_'},
      '_A7_C2_':{role:'Bomber',pass:'_A8S2_',fail:'_A7_C3_'},
      '_A4_C3_':{roles:['Muscle 1','Muscle 2'],pass:'_A5_C1_',fail:'_A4F_'},
      '_B6_C1_':{roles:['Lookout','Sniper'],pass:'_B7_C1_',fail:'_B6_C2_'},
      '_B6_C2_':{role:'Lookout',pass:'_B7_C1_',fail:'_B6F_'},
      '_A7_C3_':{roles:['Engineer','Muscle 1','Muscle 2'],pass:'_A8S3_',fail:'_A7F_'},
      '_A8S_':{end:true,payout:1.0},'_A8S2_':{end:true,payout:0.9},'_B7S_':{end:true,payout:0.75},
      '_A8S3_':{end:true,payout:0.8},'_B7S2_':{end:true,payout:0.65},'_A7F_':{end:true,payout:0},
      '_A4F_':{end:true,payout:0},'_B7F_':{end:true,payout:0},'_B6F_':{end:true,payout:0},
      '_A3F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},
      '_B5F_':{end:true,payout:0},
    }
  },
  'Gone Fission': {
    level: 6,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Hijacker',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Hijacker',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A2_C2_':{roles:['Hijacker','Engineer'],pass:'_A3_C1_',fail:'_A2F_'},
      '_A1_C2_':{roles:['Hijacker','Bomber'],pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A3_C1_':{role:'Engineer',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A3_C2_':{roles:['Engineer','Bomber'],pass:'_A4_C1_',fail:'_A3_C3_'},
      '_A4_C1_':{role:'Imitator',pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A4_C2_':{role:'Pickpocket',pass:'_A5_C1_',fail:'_A4_C3_'},
      '_A5_C1_':{roles:['Pickpocket','Imitator'],pass:'_A6_C1_',fail:'_A5_C2_'},
      '_A6_C1_':{role:'Bomber',pass:'_A7_C1_',fail:'_A6_C2_'},
      '_A6_C2_':{role:'Bomber',pass:'_A7_C1_',fail:'_A6_C3_'},
      '_A7_C1_':{role:'Imitator',pass:'_A8S_',fail:'_A7_C2_'},
      '_A4_C3_':{role:'Imitator',pass:'_A5_C1_',fail:'_A4F_'},
      '_A5_C2_':{roles:['Pickpocket','Imitator'],pass:'_A6_C1_',fail:'_A5F_'},
      '_A7_C2_':{role:'Engineer',pass:'_A8S2_',fail:'_A8S3_'},
      '_A1_C3_':{role:'Hijacker',pass:'_A2_C1_',fail:'_A1C3F_'},
      '_A6_C3_':{roles:['Pickpocket','Bomber'],pass:'_A7_C1_',fail:'_A6F_'},
      '_A3_C3_':{role:'Engineer',pass:'_A4_C1_',fail:'_A3F_'},
      '_A8S_':{end:true,payout:1.0},'_A8S2_':{end:true,payout:0.85},'_A1C3F_':{end:true,payout:0},
      '_A5F_':{end:true,payout:0},'_A4F_':{end:true,payout:0},'_A6F_':{end:true,payout:0},
      '_A3F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_A8S3_':{end:true,payout:0.7},
    }
  },
  'Manifest Cruelty': {
    level: 9,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{roles:['Cat Burglar','Interrogator'],pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Interrogator',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Cat Burglar',pass:'_A4_C1_',fail:'_B4_C1_'},
      '_A4_C1_':{role:'Hacker',pass:'_A5_C1_',fail:'_B4_C1_'},
      '_A5_C1_':{roles:['Interrogator','Reviver'],pass:'_A6_C1_',fail:'_A5_C2_'},
      '_A5_C2_':{role:'Reviver',pass:'_A6_C1_',fail:'_A5F_'},
      '_A6_C1_':{role:'Hacker',pass:'_A7_C1_',fail:'_A6_C2_'},
      '_A7_C1_':{role:'Interrogator',pass:'_A8S_',fail:'_A7_C2_'},
      '_A7_C2_':{roles:['Interrogator','Reviver'],pass:'_A7S_',fail:'_A7F_'},
      '_A1_C2_':{roles:['Reviver','Hacker'],pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A2_C2_':{role:'Interrogator',pass:'_A3_C1_',fail:'_A2_C3_'},
      '_A6_C2_':{role:'Cat Burglar',pass:'_A7_C1_',fail:'_A6_C3_'},
      '_B4_C1_':{role:'Interrogator',pass:'_B5_C1_',fail:'_B4_C2_'},
      '_B5_C1_':{role:'Reviver',pass:'_B6_C1_',fail:'_B5_C2_'},
      '_B6_C1_':{roles:['Cat Burglar','Hacker'],pass:'_B7S_',fail:'_B6_C2_'},
      '_B4_C2_':{role:'Reviver',pass:'_B5_C1_',fail:'_B4_C3_'},
      '_B4_C3_':{roles:['Interrogator','Reviver'],pass:'_B5_C1_',fail:'_B4F_'},
      '_A2_C3_':{roles:['Interrogator','Reviver'],pass:'_A3_C1_',fail:'_A2F_'},
      '_A1_C3_':{roles:['Reviver','Hacker'],pass:'_A2_C1_',fail:'_A1F_'},
      '_B5_C2_':{role:'Reviver',pass:'_B6_C1_',fail:'_B5F_'},
      '_B6_C2_':{roles:['Cat Burglar','Hacker'],pass:'_B7S_',fail:'_B6F_'},
      '_A6_C3_':{roles:['Cat Burglar','Hacker'],pass:'_A7_C1_',fail:'_A6F_'},
      '_A8S_':{end:true,payout:1.0},'_A7S_':{end:true,payout:0.9},'_A7F_':{end:true,payout:0},
      '_A5F_':{end:true,payout:0},'_A6F_':{end:true,payout:0},'_B4F_':{end:true,payout:0},
      '_B6F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},
      '_B7S_':{end:true,payout:0.75},'_B5F_':{end:true,payout:0},
    }
  },
  'Cash Me if You Can': {
    level: 2,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Lookout',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Thief 1',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Thief 2',pass:'_A3S_',fail:'_A3_C2_'},
      '_A3_C2_':{role:'Thief 1',pass:'_A3S_',fail:'_A3F_'},
      '_A1_C2_':{role:'Thief 1',pass:'_A2_C1_',fail:'_A1F_'},
      '_A2_C2_':{role:'Thief 2',pass:'_A3_C1_',fail:'_A2F_'},
      '_A3S_':{end:true,payout:1.0},
      '_A3F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},
    }
  },
  'First Aid and Abet': {
    level: 1,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Decoy',pass:'_A2_C1_',fail:'_A2_C1_'},
      '_A2_C1_':{role:'Picklock',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Pickpocket',pass:'_A3S_',fail:'_A3_C2_'},
      '_A3_C2_':{role:'Picklock',pass:'_A3S_',fail:'_A3F_'},
      '_A2_C2_':{role:'Pickpocket',pass:'_A3_C1_',fail:'_A2F_'},
      '_A3S_':{end:true,payout:1.0},
      '_A3F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},
    }
  },
  'Market Forces': {
    level: 3,
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Lookout',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Negotiator',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Enforcer',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A3_C2_':{role:'Negotiator',pass:'_A4_C1_',fail:'_A3_C3_'},
      '_A4_C1_':{role:'Arsonist',pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A4_C2_':{role:'Arsonist',pass:'_B5_C1_',fail:'_A4S_'},
      '_B5_C1_':{role:'Muscle',pass:'_B5S_',fail:'_B5_C2_'},
      '_B5_C2_':{roles:['Enforcer','Lookout'],pass:'_B5S_',fail:'_B5F_'},
      '_A1_C2_':{role:'Enforcer',pass:'_A2_C1_',fail:'_A1F_'},
      '_A5_C1_':{role:'Muscle',pass:'_A7_C1_',fail:'_A5_C2_'},
      '_A7_C1_':{role:'Negotiator',pass:'_A8_C1_',fail:'_A7_C2_'},
      '_A7_C2_':{role:'Negotiator',pass:'_A8_C1_',fail:'_A7S_'},
      '_A8_C1_':{role:'Muscle',pass:'_A8S_',fail:'_A8S2_'},
      '_A2_C2_':{role:'Muscle',pass:'_A3_C1_',fail:'_A2F_'},
      '_A5_C2_':{roles:['Enforcer','Lookout'],pass:'_A7_C1_',fail:'_A5S_'},
      '_A3_C3_':{role:'Muscle',pass:'_B4_C1_',fail:'_A3F_'},
      '_B4_C1_':{role:'Arsonist',pass:'_B5_C1_',fail:'_B4F_'},
      '_B5S_':{end:true,payout:0.5587},'_A8S_':{end:true,payout:1.0},
      '_A8S2_':{end:true,payout:0.9145},'_A7S_':{end:true,payout:0.8427},
      '_A4S_':{end:true,payout:0.7022},'_A5S_':{end:true,payout:0.6345},
      '_B4F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},
      '_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_B5F_':{end:true,payout:0},
    }
  },
};

// ── SIMULATION ────────────────────────────────────────────────────────────────
const BASELINE = 68;

function simulateOC(ocName, cprs) {
  const fg = FLOWCHARTS[ocName];
  if(!fg) return null;

  function getCPR(role) {
    if(cprs[role] !== undefined) return cprs[role] / 100;
    const base = role.replace(/\s+\d+$/, '');
    if(cprs[base] !== undefined) return cprs[base] / 100;
    return BASELINE / 100;
  }

  function walkSuccess(nodeId, prob, visited) {
    if(prob < 0.0001 || visited.has(nodeId)) return 0;
    const node = fg.nodes[nodeId];
    if(!node) return 0;
    if(node.end) return node.payout > 0 ? prob : 0;
    visited.add(nodeId);
    const p = node.roles
      ? node.roles.reduce((a, r) => a + getCPR(r), 0) / node.roles.length
      : getCPR(node.role);
    const r = walkSuccess(node.pass, prob * p, new Set(visited)) +
              walkSuccess(node.fail, prob * (1 - p), new Set(visited));
    visited.delete(nodeId);
    return r;
  }

  function walkExpected(nodeId, prob, visited) {
    if(prob < 0.0001 || visited.has(nodeId)) return 0;
    const node = fg.nodes[nodeId];
    if(!node) return 0;
    if(node.end) return prob * node.payout;
    visited.add(nodeId);
    const p = node.roles
      ? node.roles.reduce((a, r) => a + getCPR(r), 0) / node.roles.length
      : getCPR(node.role);
    const r = walkExpected(node.pass, prob * p, new Set(visited)) +
              walkExpected(node.fail, prob * (1 - p), new Set(visited));
    visited.delete(nodeId);
    return r;
  }

  return {
    successChance: Math.round(walkSuccess(fg.start, 1.0, new Set()) * 100),
    expectedValue:  walkExpected(fg.start, 1.0, new Set()),
  };
}

// ── ROLE CLASSIFICATION FROM FLOWCHART ──────────────────────────────────────

// Cache role classifications so we don't recompute every request
const _roleClassCache = {};

function classifyRoles(ocName) {
  if(_roleClassCache[ocName]) return _roleClassCache[ocName];

  const flowchart = FLOWCHARTS[ocName];
  if(!flowchart) return {};

  const nodes = flowchart.nodes;

  // Count appearances and check dead ends for each role
  const roleCounts    = {};
  const roleDeadEnds  = {};
  const roleAtStart   = {};

  Object.entries(nodes).forEach(([nodeId, node]) => {
    if(node.end) return;
    const roles = node.roles || (node.role ? [node.role] : []);
    roles.forEach(role => {
      const base = getRoleBase(role);
      roleCounts[role] = (roleCounts[role] || 0) + 1;

      // Check if fail leads to payout:0 end node
      const failNode = nodes[node.fail];
      if(failNode?.end && failNode?.payout === 0) {
        roleDeadEnds[role] = true;
      }

      // Check if this is the start node
      if(nodeId === flowchart.start) {
        roleAtStart[role] = true;
      }
    });
  });

  const classifications = {};
  Object.keys(roleCounts).forEach(role => {
    const base = getRoleBase(role);
    if(SAFE_ROLES.includes(role) || SAFE_ROLES.includes(base)) {
      classifications[role] = 'safe';
    } else if(roleAtStart[role] && roleDeadEnds[role]) {
      classifications[role] = 'gate';        // first checkpoint AND dead end on fail
    } else if(roleDeadEnds[role]) {
      classifications[role] = 'bottleneck';  // dead end on fail
    } else if(roleCounts[role] >= 3) {
      classifications[role] = 'bottleneck';  // appears many times
    } else if(roleCounts[role] >= 2) {
      classifications[role] = 'recovery';    // appears multiple times but has recovery
    } else {
      classifications[role] = 'support';     // appears once with recovery path
    }
  });

  _roleClassCache[ocName] = classifications;
  return classifications;
}

// Priority value for role type (higher = fill first)
function roleTypePriority(type) {
  return { gate:4, bottleneck:3, recovery:2, support:1, safe:0 }[type] || 0;
}

// ═══════════════════════════════════════════════════════════════
// OPTIMIZE ENGINE
// ═══════════════════════════════════════════════════════════════

// Get a member's CPR for a specific OC and role
// Handles numbered roles (Muscle 1 → Muscle) and OC name variants
function getMemberCPR(memberCPRs, memberName, ocName, role) {
  const memberData = memberCPRs[memberName];
  if(!memberData) return null;

  const base = getRoleBase(role);

  // Try exact OC name first, then common variants
  const ocVariants = [
    ocName,
    ocName + 's',             // "Market Force" → "Market Forces"
    ocName.replace(/s$/, ''), // "Market Forces" → "Market Force"
  ];

  for(const variant of ocVariants) {
    const ocData = memberData.cprs?.[variant];
    if(!ocData) continue;
    const cpr = ocData[role] ?? ocData[base] ?? null;
    if(cpr !== null) return cpr;
  }
  return null;
}

// Staleness threshold: 7 days in milliseconds
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

function isCPRStale(updatedAt) {
  if(!updatedAt) return true;
  return Date.now() - new Date(updatedAt).getTime() > STALE_THRESHOLD_MS;
}

// Hash function for cache keys
function hashObject(obj) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(obj))
    .digest('hex')
    .slice(0, 32);
}

// Core optimization function
async function optimizeFaction(factionId, ocs, requestingMember) {

  // ── Step 1: Load all faction CPR from DB ──────────────────────────────────
  let memberCPRRows = [];
  try {
    const result = await query(
      'SELECT member_name, source, cprs, updated_at FROM member_cpr WHERE faction_id = $1',
      [factionId]
    );
    memberCPRRows = result.rows;
  } catch(e) {
    console.error('[OPTIMIZE] DB error loading CPR:', e.message);
  }

  // Build member CPR map: { memberName: { cprs, source, updatedAt, isStale } }
  const memberCPRMap = {};
  memberCPRRows.forEach(row => {
    memberCPRMap[row.member_name] = {
      cprs:      row.cprs,
      source:    row.source,
      updatedAt: row.updated_at,
      isStale:   isCPRStale(row.updated_at),
    };
  });

  // Get all available member names (union of provided members + CPR data)
  const allMemberNames = new Set();
  ocs.forEach(oc => {
    (oc.availableMembers || []).forEach(m => allMemberNames.add(m.name));
  });
  // Use first OC's member list as the global pool
  const memberPool = ocs[0]?.availableMembers || [];

  // ── Step 2: Classify roles per OC ─────────────────────────────────────────
  const roleClassifications = {};
  ocs.forEach(oc => {
    roleClassifications[oc.ocName] = classifyRoles(oc.ocName);
  });

  // ── Step 3: Build impact matrix ───────────────────────────────────────────
  // impact[memberName][ocName][role] = { delta, cpr, flag }
  // delta = how much this member improves success chance in this role

  const impactMatrix = {};

  for(const member of memberPool) {
    impactMatrix[member.name] = {};

    for(const oc of ocs) {
      impactMatrix[member.name][oc.ocName] = {};

      // Baseline: simulate with only currently filled CPRs
      const baseline = simulateOC(oc.ocName, oc.filledCPRs || {});
      if(!baseline) continue;

      for(const role of (oc.openRoles || [])) {
        // Get member's CPR for this role
        let cpr = getMemberCPR(memberCPRMap, member.name, oc.ocName, role);
        let flag = null;
        let stale = false;

        if(cpr === null && memberCPRMap[member.name]) {
          flag = 'cpr_unknown';
        } else if(cpr !== null && memberCPRMap[member.name]?.isStale) {
          stale = true;
          flag = 'cpr_stale';
        } else if(!memberCPRMap[member.name]) {
          flag = 'no_data';
        }

        // For unknown CPR — estimate using pessimistic value for non-safe roles
        const rc = getRoleCPRRange(role);
        const effectiveCPR = cpr !== null ? cpr : (rc.safe ? 50 : null);

        let delta = 0;
        if(effectiveCPR !== null) {
          const withMember = simulateOC(oc.ocName, {
            ...(oc.filledCPRs || {}),
            [role]: effectiveCPR,
          });
          delta = withMember ? withMember.successChance - baseline.successChance : 0;
        }

        impactMatrix[member.name][oc.ocName][role] = {
          delta,
          cpr,
          flag,
          stale,
          roleType: roleClassifications[oc.ocName][role] || 'support',
        };
      }
    }
  }

  // ── Step 4: Build priority queue ──────────────────────────────────────────
  // Every (member, oc, role) triple gets a priority score
  // Priority = OC level (×1000) + role type priority (×100) + impact delta

  const queue = [];

  for(const member of memberPool) {
    for(const oc of ocs) {
      const ocLevel = FLOWCHARTS[oc.ocName]?.level || 1;
      for(const role of (oc.openRoles || [])) {
        const impact = impactMatrix[member.name]?.[oc.ocName]?.[role];
        if(!impact) continue;

        const rType = impact.roleType;
        const priorityScore =
          (ocLevel * 1000) +
          (roleTypePriority(rType) * 100) +
          impact.delta;

        queue.push({
          member:        member.name,
          memberStatus:  member.status || 'available',
          ocName:        oc.ocName,
          ocLevel,
          role,
          roleType:      rType,
          cpr:           impact.cpr,
          delta:         impact.delta,
          flag:          impact.flag,
          stale:         impact.stale,
          priorityScore,
        });
      }
    }
  }

  // Sort by priority descending
  queue.sort((a, b) => b.priorityScore - a.priorityScore);

  // ── Step 5: Global greedy assignment ──────────────────────────────────────
  const usedMembers  = new Set(); // members already assigned
  const filledRoles  = {};        // { ocName: { role: assignment } }
  const assignments  = {};        // final assignments

  for(const item of queue) {
    // Skip if member already assigned
    if(usedMembers.has(item.member)) continue;

    // Skip if role already filled
    if(filledRoles[item.ocName]?.[item.role]) continue;

    // Assign
    if(!filledRoles[item.ocName]) filledRoles[item.ocName] = {};
    if(!assignments[item.ocName]) assignments[item.ocName] = [];

    filledRoles[item.ocName][item.role] = item.member;
    assignments[item.ocName].push({
      role:         item.role,
      member:       item.member,
      memberStatus: item.memberStatus,
      cpr:          item.cpr,
      roleType:     item.roleType,
      impact:       parseFloat(item.delta.toFixed(1)),
      flag:         item.flag,
      stale:        item.stale,
    });

    usedMembers.add(item.member);
  }

  // ── Step 6: Score assembled teams ─────────────────────────────────────────
  const optimizedOCs = [];

  for(const oc of ocs) {
    const ocLevel    = FLOWCHARTS[oc.ocName]?.level || 1;
    const breakeven  = SCOPE_BREAKEVEN[ocLevel] || 0.75;
    const baseline   = simulateOC(oc.ocName, oc.filledCPRs || {});

    // Build assembled CPRs (filled + optimal assignments with known CPR)
    const assembledCPRs = { ...(oc.filledCPRs || {}) };
    (assignments[oc.ocName] || []).forEach(a => {
      if(a.cpr !== null) assembledCPRs[a.role] = a.cpr;
    });

    const projected  = simulateOC(oc.ocName, assembledCPRs);
    const projectedSC = projected?.successChance || 0;
    const baselineSC  = baseline?.successChance  || 0;

    // Determine status
    let status = 'optimal';
    if(projectedSC < breakeven * 100 - 10) status = 'at_risk';
    else if(projectedSC < breakeven * 100)  status = 'marginal';

    // List unfilled open roles
    const filledInThisOC = new Set((assignments[oc.ocName] || []).map(a => a.role));
    const unfilledRoles = (oc.openRoles || []).filter(r => !filledInThisOC.has(r));

    optimizedOCs.push({
      ocName:           oc.ocName,
      level:            ocLevel,
      projectedSuccess: projectedSC,
      currentSuccess:   baselineSC,
      improvement:      projectedSC - baselineSC,
      scopeBreakeven:   Math.round(breakeven * 100),
      status,
      team:             assignments[oc.ocName] || [],
      unfilledRoles:    unfilledRoles.map(r => ({
        role:     r,
        roleType: roleClassifications[oc.ocName]?.[r] || 'support',
        urgent:   ['gate','bottleneck'].includes(roleClassifications[oc.ocName]?.[r]),
      })),
    });
  }

  // Sort by level descending
  optimizedOCs.sort((a, b) => b.level - a.level);

  // ── Step 7: Detect suboptimal existing placements ──────────────────────────
  const suboptimalPlacements = [];

  for(const oc of ocs) {
    const existingPlacements = oc.existingPlacements || [];
    for(const placement of existingPlacements) {
      // Find if this member has a better assignment in our optimization
      for(const optOC of optimizedOCs) {
        const betterAssignment = optOC.team.find(a => a.member === placement.member);
        if(!betterAssignment) continue;
        if(optOC.ocName === oc.ocName && betterAssignment.role === placement.role) continue;

        // Calculate improvement delta
        const currentImpact = impactMatrix[placement.member]?.[oc.ocName]?.[placement.role]?.delta || 0;
        const betterImpact  = betterAssignment.impact || 0;
        const delta = betterImpact - currentImpact;

        if(delta > 5) { // Only flag meaningful improvements
          suboptimalPlacements.push({
            member:        placement.member,
            currentOC:     oc.ocName,
            currentRole:   placement.role,
            currentCPR:    placement.cpr,
            betterOC:      optOC.ocName,
            betterRole:    betterAssignment.role,
            betterCPR:     betterAssignment.cpr,
            improvementDelta: parseFloat(delta.toFixed(1)),
          });
        }
        break; // Only report the best alternative per member
      }
    }
  }

  // ── Step 8: Personal recommendation ──────────────────────────────────────
  let personalRecommendation = null;

  if(requestingMember) {
    // Find this member's assignment in the optimal solution
    for(const optOC of optimizedOCs) {
      const myAssignment = optOC.team.find(a => a.member === requestingMember);
      if(myAssignment) {
        personalRecommendation = {
          member:           requestingMember,
          ocName:           optOC.ocName,
          level:            optOC.level,
          role:             myAssignment.role,
          cpr:              myAssignment.cpr,
          roleType:         myAssignment.roleType,
          projectedSuccess: optOC.projectedSuccess,
          impact:           myAssignment.impact,
          flag:             myAssignment.flag,
        };
        break;
      }
    }

    // If not found in optimal (e.g. all OCs have enough members), find best available slot
    if(!personalRecommendation) {
      let bestItem = null;
      for(const item of queue) {
        if(item.member === requestingMember) {
          bestItem = item;
          break;
        }
      }
      if(bestItem) {
        personalRecommendation = {
          member:           requestingMember,
          ocName:           bestItem.ocName,
          level:            bestItem.ocLevel,
          role:             bestItem.role,
          cpr:              bestItem.cpr,
          roleType:         bestItem.roleType,
          projectedSuccess: null,
          impact:           parseFloat(bestItem.delta.toFixed(1)),
          flag:             bestItem.flag,
          note:             'All slots optimally filled — this is your best remaining option',
        };
      }
    }
  }

  // ── Step 9: Unassigned members ────────────────────────────────────────────
  const unassignedMembers = memberPool
    .filter(m => !usedMembers.has(m.name))
    .map(m => ({
      name:   m.name,
      status: m.status || 'available',
      reason: m.status === 'hospital' ? 'hospital' : 'no_slot_available',
    }));

  return {
    optimizedOCs,
    suboptimalPlacements,
    personalRecommendation,
    unassignedMembers,
    meta: {
      membersConsidered: memberPool.length,
      ocsOptimized:      ocs.length,
      assignmentsMade:   usedMembers.size,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// OPTIMIZE CACHE
// ═══════════════════════════════════════════════════════════════

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getCachedOptimize(factionId, cacheKey) {
  try {
    const result = await query(
      `SELECT result, created_at FROM optimize_cache
       WHERE faction_id = $1 AND cache_key = $2
       AND created_at > NOW() - INTERVAL '5 minutes'`,
      [factionId, cacheKey]
    );
    if(result.rows.length > 0) return result.rows[0].result;
  } catch(e) {
    console.warn('[CACHE] Cache read error:', e.message);
  }
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
  } catch(e) {
    console.warn('[CACHE] Cache write error:', e.message);
  }
}

async function invalidateCache(factionId) {
  try {
    await query('DELETE FROM optimize_cache WHERE faction_id = $1', [factionId]);
  } catch(e) {}
}

// Clean old cache entries every 10 minutes
setInterval(async () => {
  try {
    await query(`DELETE FROM optimize_cache WHERE created_at < NOW() - INTERVAL '10 minutes'`);
  } catch(e) {}
}, 600000);

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:  'ok',
    version: '2.1.0',
    ocs:     Object.keys(FLOWCHARTS).length,
  });
});

// ── Score single OC ───────────────────────────────────────────────────────────
app.post('/api/score', rateLimit('score'), async (req, res) => {
  const owner = await validateKey(req, res);
  if(!owner) return;

  const { ocName, cprs } = req.body;
  if(!ocName) return res.status(400).json({ error: 'Missing ocName' });
  if(!cprs || typeof cprs !== 'object') return res.status(400).json({ error: 'Missing cprs object' });

  const result = simulateOC(ocName, cprs);
  if(!result) return res.status(404).json({ error: 'Unknown OC: ' + ocName });

  res.json({ ocName, successChance: result.successChance, expectedValue: result.expectedValue });
});

// ── Score batch ───────────────────────────────────────────────────────────────
app.post('/api/score/batch', rateLimit('score_batch'), async (req, res) => {
  const owner = await validateKey(req, res);
  if(!owner) return;

  const { requests } = req.body;
  if(!Array.isArray(requests)) return res.status(400).json({ error: 'requests must be an array' });
  if(requests.length > 50) return res.status(400).json({ error: 'Max 50 requests per batch' });

  const results = requests.map(({ ocName, cprs }) => {
    if(!ocName || !cprs) return { error: 'Missing ocName or cprs' };
    const r = simulateOC(ocName, cprs);
    if(!r) return { ocName, error: 'Unknown OC' };
    return { ocName, successChance: r.successChance, expectedValue: r.expectedValue };
  });

  res.json({ results });
});

// ── List OCs ──────────────────────────────────────────────────────────────────
app.get('/api/ocs', async (req, res) => {
  const owner = await validateKey(req, res);
  if(!owner) return;
  res.json({ ocs: Object.keys(FLOWCHARTS) });
});

// ── Store member CPR (personal push from member script) ───────────────────────
// POST /api/cpr
// Body: { memberName, cprs: { "OC Name": { "Role": number } }, source: "personal"|"tornstats" }
app.post('/api/cpr', rateLimit('cpr'), async (req, res) => {
  const key   = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res);
  if(!owner) return;

  const { memberName, cprs, source } = req.body;
  if(!memberName) return res.status(400).json({ error: 'Missing memberName' });
  if(!cprs || typeof cprs !== 'object') return res.status(400).json({ error: 'Missing cprs' });

  const factionId  = getFactionId(key);
  const srcName    = source === 'tornstats' ? 'tornstats' : 'personal';

  try {
    await query(
      `INSERT INTO member_cpr (faction_id, member_name, source, cprs, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (faction_id, member_name)
       DO UPDATE SET cprs = $4, source = $3, updated_at = NOW()`,
      [factionId, memberName, srcName, JSON.stringify(cprs)]
    );
    await invalidateCache(factionId);
    res.json({ ok: true, memberName, factionId });
  } catch(e) {
    console.error('[CPR] Store error:', e.message);
    res.status(500).json({ error: 'Failed to store CPR data' });
  }
});

// ── Bulk CPR push from TornStats (leader script) ──────────────────────────────
// POST /api/cpr/batch
// Body: { members: { "memberName": { "OC Name": { "Role": number } } } }
app.post('/api/cpr/batch', rateLimit('cpr_batch'), async (req, res) => {
  const key   = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res);
  if(!owner) return;

  const leaderKey = req.headers['x-oca-key'] || req.query.key;
  if(!isLeaderKey(leaderKey)) return res.status(403).json({ error: 'Leader key required' });

  const { members } = req.body;
  if(!members || typeof members !== 'object') return res.status(400).json({ error: 'Missing members object' });

  const factionId = getFactionId(leaderKey);
  const entries   = Object.entries(members);
  if(entries.length === 0) return res.json({ ok: true, updated: 0 });
  if(entries.length > 200) return res.status(400).json({ error: 'Max 200 members per batch' });

  let updated = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for(const [memberName, cprs] of entries) {
      await client.query(
        `INSERT INTO member_cpr (faction_id, member_name, source, cprs, updated_at)
         VALUES ($1, $2, 'tornstats', $3, NOW())
         ON CONFLICT (faction_id, member_name)
         DO UPDATE SET
           cprs = CASE
             WHEN member_cpr.source = 'personal'
               THEN member_cpr.cprs || $3::jsonb
             ELSE $3::jsonb
           END,
           source = CASE
             WHEN member_cpr.source = 'personal' THEN 'personal'
             ELSE 'tornstats'
           END,
           updated_at = NOW()`,
        [factionId, memberName, JSON.stringify(cprs)]
      );
      updated++;
    }
    await client.query('COMMIT');
    await invalidateCache(factionId);
    res.json({ ok: true, updated, factionId });
  } catch(e) {
    await client.query('ROLLBACK');
    console.error('[CPR BATCH] Error:', e.message);
    res.status(500).json({ error: 'Batch update failed' });
  } finally {
    client.release();
  }
});

// ── Get all faction CPR (leader only) ────────────────────────────────────────
app.get('/api/cpr', async (req, res) => {
  const key   = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res);
  if(!owner) return;
  if(!isLeaderKey(key)) return res.status(403).json({ error: 'Leader key required' });

  const factionId = getFactionId(key);
  try {
    const result = await query(
      'SELECT member_name, source, cprs, updated_at FROM member_cpr WHERE faction_id = $1',
      [factionId]
    );
    const members = {};
    result.rows.forEach(row => {
      members[row.member_name] = {
        cprs:      row.cprs,
        source:    row.source,
        updatedAt: row.updated_at,
        isStale:   isCPRStale(row.updated_at),
      };
    });
    res.json({ members, factionId });
  } catch(e) {
    res.status(500).json({ error: 'Failed to load CPR data' });
  }
});

// ── Optimize ──────────────────────────────────────────────────────────────────
// POST /api/optimize
// Body: {
//   ocs: [{ ocName, openRoles, filledCPRs, existingPlacements, availableMembers }],
//   requestingMember: "MemberName"
// }
app.post('/api/optimize', rateLimit('optimize'), async (req, res) => {
  const key   = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res);
  if(!owner) return;

  const { ocs, requestingMember } = req.body;
  if(!Array.isArray(ocs) || ocs.length === 0) {
    return res.status(400).json({ error: 'ocs must be a non-empty array' });
  }

  const factionId = getFactionId(key);

  // Build cache key from input
  const cacheInput = { ocs: ocs.map(o => ({
    ocName:    o.ocName,
    openRoles: (o.openRoles || []).sort(),
    filledCPRs: o.filledCPRs || {},
    members:   (o.availableMembers || []).map(m => m.name).sort(),
  })), requestingMember };
  const cacheKey = hashObject(cacheInput);

  // Check cache
  const cached = await getCachedOptimize(factionId, cacheKey);
  if(cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const result = await optimizeFaction(factionId, ocs, requestingMember);
    await setCachedOptimize(factionId, cacheKey, result);
    res.json({ ...result, cached: false });
  } catch(e) {
    console.error('[OPTIMIZE] Error:', e.message, e.stack);
    res.status(500).json({ error: 'Optimization failed: ' + e.message });
  }
});

// ── Assignment endpoints ──────────────────────────────────────────────────────

// POST /api/assign — leader sets assignment
app.post('/api/assign', rateLimit('assign'), async (req, res) => {
  const key   = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res);
  if(!owner) return;
  if(!isLeaderKey(key)) return res.status(403).json({ error: 'Leader key required' });

  const { tornName, role, ocName, ocLevel } = req.body;
  if(!tornName || !role || !ocName) {
    return res.status(400).json({ error: 'Missing tornName, role or ocName' });
  }

  const factionId = getFactionId(key);
  try {
    await query(
      `INSERT INTO assignments (faction_id, torn_name, role, oc_name, oc_level, assigned_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (faction_id, torn_name)
       DO UPDATE SET role = $3, oc_name = $4, oc_level = $5, assigned_by = $6, assigned_at = NOW()`,
      [factionId, tornName.toLowerCase(), role, ocName, ocLevel || null, owner]
    );
    console.log(`[ASSIGN] ${owner} → ${tornName}: ${role} in ${ocName} (L${ocLevel})`);
    res.json({ ok: true });
  } catch(e) {
    console.error('[ASSIGN] Error:', e.message);
    res.status(500).json({ error: 'Failed to save assignment' });
  }
});

// GET /api/assignment — member polls for their assignment
app.get('/api/assignment', rateLimit('assignment'), async (req, res) => {
  const key   = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res);
  if(!owner) return;

  const tornName = (req.query.tornName || '').trim().toLowerCase();
  if(!tornName) return res.status(400).json({ error: 'Missing tornName' });

  const factionId = getFactionId(key);
  try {
    const result = await query(
      `SELECT torn_name, role, oc_name, oc_level, assigned_by, assigned_at
       FROM assignments WHERE faction_id = $1 AND torn_name = $2`,
      [factionId, tornName]
    );
    if(result.rows.length === 0) return res.json({ assignment: null });

    const row = result.rows[0];
    res.json({
      assignment: {
        tornName:   row.torn_name,
        role:       row.role,
        ocName:     row.oc_name,
        ocLevel:    row.oc_level,
        assignedBy: row.assigned_by,
        assignedAt: row.assigned_at,
      }
    });
  } catch(e) {
    console.error('[ASSIGNMENT] Error:', e.message);
    res.status(500).json({ error: 'Failed to load assignment' });
  }
});

// DELETE /api/assign — clear assignment (member joined or leader cancels)
app.delete('/api/assign', rateLimit('assign'), async (req, res) => {
  const key   = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res);
  if(!owner) return;

  const tornName = (req.body.tornName || req.query.tornName || '').trim().toLowerCase();
  if(!tornName) return res.status(400).json({ error: 'Missing tornName' });

  const factionId = getFactionId(key);

  // Members can only delete their own assignment
  // Leaders can delete any assignment in their faction
  if(!isLeaderKey(key)) {
    const parsed = parseKey(key);
    if(parsed?.ownerName?.toLowerCase() !== tornName) {
      return res.status(403).json({ error: 'Members can only clear their own assignment' });
    }
  }

  try {
    await query(
      'DELETE FROM assignments WHERE faction_id = $1 AND torn_name = $2',
      [factionId, tornName]
    );
    res.json({ ok: true });
  } catch(e) {
    console.error('[ASSIGN DELETE] Error:', e.message);
    res.status(500).json({ error: 'Failed to delete assignment' });
  }
});

// GET /api/assignments — leader gets all active assignments
app.get('/api/assignments', rateLimit('assignments'), async (req, res) => {
  const key   = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res);
  if(!owner) return;
  if(!isLeaderKey(key)) return res.status(403).json({ error: 'Leader key required' });

  const factionId = getFactionId(key);
  try {
    const result = await query(
      `SELECT torn_name, role, oc_name, oc_level, assigned_by, assigned_at
       FROM assignments WHERE faction_id = $1
       ORDER BY assigned_at DESC`,
      [factionId]
    );
    const assignments = {};
    result.rows.forEach(row => {
      assignments[row.torn_name] = {
        tornName:   row.torn_name,
        role:       row.role,
        ocName:     row.oc_name,
        ocLevel:    row.oc_level,
        assignedBy: row.assigned_by,
        assignedAt: row.assigned_at,
      };
    });
    res.json({ assignments });
  } catch(e) {
    console.error('[ASSIGNMENTS] Error:', e.message);
    res.status(500).json({ error: 'Failed to load assignments' });
  }
});

// ── Key migration endpoint (one-time use) ────────────────────────────────────
app.post('/api/keys/migrate', async (req, res) => {
  // Simple security: require a migration token in header
  const token = req.headers['x-migrate-token'];
  if(!token || token !== process.env.MIGRATE_TOKEN) {
    return res.status(403).json({ error: 'Invalid migration token' });
  }

  try {
    await migrateKeysFromFile();
    const result = await query('SELECT COUNT(*) as count FROM api_keys');
    res.json({ ok: true, keysInDB: parseInt(result.rows[0].count) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Debug: cache status (leader only) ────────────────────────────────────────
app.get('/api/optimize/cache', async (req, res) => {
  const key   = req.headers['x-oca-key'] || req.query.key;
  const owner = await validateKey(req, res);
  if(!owner) return;
  if(!isLeaderKey(key)) return res.status(403).json({ error: 'Leader key required' });

  const factionId = getFactionId(key);
  try {
    const result = await query(
      `SELECT cache_key, created_at FROM optimize_cache
       WHERE faction_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [factionId]
    );
    res.json({ entries: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

startup().then(() => {
  app.listen(PORT, () => {
    console.log(`[SERVER] Hive OC Advisor v2.0.0 running on port ${PORT}`);
    console.log(`[SERVER] OCs loaded: ${Object.keys(FLOWCHARTS).length}`);
  });
});
