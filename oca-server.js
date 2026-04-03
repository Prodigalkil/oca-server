'use strict';

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    if(!origin || origin.includes('torn.com') || origin.includes('localhost')) cb(null, true);
    else cb(new Error('CORS blocked'));
  }
}));
app.use(express.json());

// ── KEY MANAGEMENT ────────────────────────────────────────────────────────────
function loadKeys() {
  try {
    const file = fs.readFileSync(path.join(__dirname, 'keys.txt'), 'utf8');
    const keys = {};
    file.split('\n').forEach(line => {
      line = line.trim();
      if(!line || line.startsWith('#')) return;
      const [key, ...rest] = line.split(/\s+/);
      if(key) keys[key] = rest.join(' ') || 'unknown';
    });
    return keys;
  } catch(e) {
    return {};
  }
}

function validateKey(req, res) {
  const key = req.headers['x-oca-key'] || req.query.key;
  if(!key) { res.status(401).json({ error: 'Missing API key' }); return null; }
  const keys = loadKeys();
  if(!keys[key]) { res.status(403).json({ error: 'Invalid API key' }); return null; }
  return keys[key];
}

// ── DAG ENGINE ────────────────────────────────────────────────────────────────
const FLOWCHARTS = {
  'Bidding War': {
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
      '_B7S1_':{end:true,payout:0.8529},'_A4S_':{end:true,payout:0.6136},
      '_B8S_':{end:true,payout:0.6593},'_B7S2_':{end:true,payout:0.7983},
      '_B1F3_':{end:true,payout:0},'_B1F2_':{end:true,payout:0},
      '_A4F_':{end:true,payout:0},'_A6F_':{end:true,payout:0},
      '_A5F_':{end:true,payout:0},'_B1F1_':{end:true,payout:0},'_A1F_':{end:true,payout:0},
    }
  },
  'Counter Offer': {
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Robber',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Engineer',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Hacker',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A3_C2_':{role:'Hacker',pass:'_A4_C1_',fail:'_B3_C1_'},
      '_A4_C1_':{role:'Hacker',pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A5_C1_':{roles:['Picklock','Robber'],pass:'_A6_C1_',fail:'_A5_C2_'},
      '_A6_C1_':{roles:['Engineer','Looter'],pass:'_A7S_',fail:'_A7S2_'},
      '_B3_C1_':{role:'Looter',pass:'_B4_C1_',fail:'_B3_C2_'},
      '_B4_C1_':{role:'Picklock',pass:'_B5S_',fail:'_B4_C2_'},
      '_A1_C2_':{roles:['Picklock','Robber'],pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A1_C3_':{roles:['Picklock','Looter'],pass:'_A2_C1_',fail:'_A1F_'},
      '_A4_C2_':{role:'Engineer',pass:'_A5_C1_',fail:'_A4F_'},
      '_A2_C2_':{role:'Robber',pass:'_A3_C1_',fail:'_A2F_'},
      '_A5_C2_':{role:'Looter',pass:'_A5S_',fail:'_A5_C3_'},
      '_B3_C2_':{roles:['Engineer','Looter'],pass:'_B4_C1_',fail:'_B3F_'},
      '_B4_C2_':{roles:['Picklock','Engineer'],pass:'_B5S_',fail:'_B4F_'},
      '_A5_C3_':{roles:['Robber','Looter'],pass:'_A5S_',fail:'_A5F_'},
      '_A7S_':{end:true,payout:0},'_B5S_':{end:true,payout:0},'_A5S_':{end:true,payout:0},
      '_A4F_':{end:true,payout:0},'_A7S2_':{end:true,payout:0},'_A5F_':{end:true,payout:0},
      '_B3F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_B4F_':{end:true,payout:0},
    }
  },
  'Honey Trap': {
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Enforcer',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Muscle 1',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A2_C2_':{role:'Enforcer',pass:'_A3_C1_',fail:'_A2_C3_'},
      '_A2_C3_':{role:'Muscle 2',pass:'_A3_C1_',fail:'_A2F_'},
      '_A3_C1_':{role:'Enforcer',pass:'_A4_C1_',fail:'_B1_C1_'},
      '_B1_C1_':{role:'Muscle 2',pass:'_B2_C1_',fail:'_B1_C2_'},
      '_B1_C2_':{role:'Muscle 2',pass:'_B2_C1_',fail:'_B1F_'},
      '_B2_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_B2S_',fail:'_B2_C2_'},
      '_A1_C2_':{role:'Muscle 1',pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A4_C1_':{role:'Enforcer',pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A5_C1_':{role:'Muscle 2',pass:'_A6_C1_',fail:'_A5_C2_'},
      '_A5_C2_':{role:'Muscle 1',pass:'_A6_C2_',fail:'_A5F_'},
      '_A6_C2_':{role:'Muscle 2',pass:'_A7_C1_',fail:'_A6S_'},
      '_A7_C1_':{roles:['Enforcer','Muscle 1'],pass:'_A8S_',fail:'_A7S_'},
      '_A1_C3_':{role:'Muscle 2',pass:'_A2_C1_',fail:'_A1F_'},
      '_A6_C1_':{roles:['Muscle 1','Muscle 2'],pass:'_A7_C1_',fail:'_A6_C2_'},
      '_B2_C2_':{role:'Muscle 2',pass:'_B2S_',fail:'_B2F_'},
      '_A4_C2_':{roles:['Muscle 1','Muscle 2'],pass:'_A5_C2_',fail:'_A4F_'},
      '_B2S_':{end:true,payout:0.6153},'_A8S_':{end:true,payout:1.0},
      '_A6S_':{end:true,payout:0.721},'_A7S_':{end:true,payout:0.9084},
      '_B2F_':{end:true,payout:0},'_A5F_':{end:true,payout:0},
      '_A4F_':{end:true,payout:0},'_B1F_':{end:true,payout:0},
      '_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},
    }
  },
  'Leave No Trace': {
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Techie',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Negotiator',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A2_C2_':{role:'Imitator',pass:'_A3_C1_',fail:'_B1_C1_'},
      '_B1_C1_':{role:'Imitator',pass:'_B2_C1_',fail:'_B1_C2_'},
      '_B1_C2_':{role:'Negotiator',pass:'_B2_C1_',fail:'_B1F_'},
      '_A1_C2_':{role:'Negotiator',pass:'_A2_C1_',fail:'_A1F_'},
      '_B2_C1_':{roles:['Negotiator','Techie'],pass:'_B3S_',fail:'_B2F_'},
      '_A3_C1_':{role:'Imitator',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A3_C2_':{role:'Negotiator',pass:'_A4_C1_',fail:'_A3_C3_'},
      '_A4_C1_':{role:'Imitator',pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A4_C2_':{role:'Imitator',pass:'_A6_C1_',fail:'_A4F_'},
      '_A6_C1_':{role:'Techie',pass:'_A8_C1_',fail:'_A6_C2_'},
      '_A8_C1_':{role:'Negotiator',pass:'_A8S1_',fail:'_A8S2_'},
      '_A3_C3_':{role:'Techie',pass:'_A4_C1_',fail:'_A3F_'},
      '_A5_C1_':{role:'Techie',pass:'_A7_C1_',fail:'_A6_C1_'},
      '_A6_C2_':{role:'Negotiator',pass:'_A8_C1_',fail:'_A6_C3_'},
      '_A6_C3_':{role:'Imitator',pass:'_A6S_',fail:'_A6F_'},
      '_A7_C1_':{roles:['Imitator','Negotiator'],pass:'_A7S_',fail:'_A7S2_'},
      '_B3S_':{end:true,payout:0.5714},'_A8S2_':{end:true,payout:0.7435},
      '_A8S1_':{end:true,payout:0.749},'_A6S_':{end:true,payout:0.6662},
      '_A7S_':{end:true,payout:1.0},'_A7S2_':{end:true,payout:0.7754},
      '_B2F_':{end:true,payout:0},'_A4F_':{end:true,payout:0},'_A6F_':{end:true,payout:0},
      '_A3F_':{end:true,payout:0},'_B1F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},
    }
  },
  'Market Force': {
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
  'Mob Mentality': {
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
      '_A7S_':{end:true,payout:0},'_B7S_':{end:true,payout:0},'_B7S2_':{end:true,payout:0},
      '_A7S2_':{end:true,payout:0},'_B9S_':{end:true,payout:0},'_B8F_':{end:true,payout:0},
      '_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},
    }
  },
  'Stage Fright': {
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
      '_A6S_':{end:true,payout:0},'_B4S_':{end:true,payout:0},'_A7S_':{end:true,payout:0},
      '_B2S_':{end:true,payout:0},'_B3F_':{end:true,payout:0},'_B2F_':{end:true,payout:0},
      '_B1F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},
    }
  },
  'Smoke and Wing Mirrors': {
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
      '_A8S_':{end:true,payout:0},'_A7S_':{end:true,payout:0},'_B3S2_':{end:true,payout:0},
      '_B3S_':{end:true,payout:0},'_A9S_':{end:true,payout:0},'_B2F_':{end:true,payout:0},
      '_A4F_':{end:true,payout:0},'_A6F_':{end:true,payout:0},'_A3F_':{end:true,payout:0},
      '_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_C1F_':{end:true,payout:0},
    }
  },
  'Stacking the Deck': {
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
      '_A7S_':{end:true,payout:0},'_B3F_':{end:true,payout:0},'_B2F_':{end:true,payout:0},
      '_B5S_':{end:true,payout:0},'_A5F_':{end:true,payout:0},'_A6S_':{end:true,payout:0},
      '_B1F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_B4S_':{end:true,payout:0},
    }
  },
  'Ace in the Hole': {
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
  'Cash Me If You Can': {
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Thief 1',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A1_C2_':{role:'Thief 1',pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A2_C1_':{role:'Thief 2',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A2_C2_':{role:'Thief 1',pass:'_A3_C1_',fail:'_A2_C3_'},
      '_A3_C1_':{role:'Thief 1',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A4_C1_':{role:'Thief 2',pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A5_C1_':{role:'Lookout',pass:'_A6_C1_',fail:'_B1_C1_'},
      '_B1_C1_':{role:'Thief 1',pass:'_B2_C1_',fail:'_B1F_'},
      '_B2_C1_':{role:'Lookout',pass:'_B3S_',fail:'_B2F_'},
      '_A4_C2_':{role:'Thief 1',pass:'_A4S_',fail:'_B1_C1_'},
      '_A3_C2_':{role:'Thief 1',pass:'_A4_C1_',fail:'_A3_C3_'},
      '_A2_C3_':{role:'Thief 2',pass:'_A3_C1_',fail:'_A2F_'},
      '_A1_C3_':{roles:['Thief 2','Thief 1'],pass:'_A2_C1_',fail:'_A1F_'},
      '_A3_C3_':{role:'Thief 2',pass:'_C1_C1_',fail:'_B1F_'},
      '_C1_C1_':{role:'Thief 1',pass:'_C2S_',fail:'_C1F_'},
      '_A6_C1_':{role:'Thief 2',pass:'_A7S_',fail:'_A8S_'},
      '_B3S_':{end:true,payout:0.751},'_A4S_':{end:true,payout:0.8739},
      '_A8S_':{end:true,payout:0.8977},'_A7S_':{end:true,payout:1.0},
      '_C2S_':{end:true,payout:0.5534},'_B2F_':{end:true,payout:0},
      '_B1F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},
      '_A2F_':{end:true,payout:0},'_C1F_':{end:true,payout:0},
    }
  },
  'Clinical Precision': {
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Cat Burglar',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Assassin',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Cleaner',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A4_C1_':{role:'Cleaner',pass:'_A5_C1_',fail:'_A4_C2_'},
      '_A5_C1_':{roles:['Assassin','Imitator'],pass:'_A6_C1_',fail:'_C5_C1_'},
      '_A6_C1_':{role:'Assassin',pass:'_A7_C1_',fail:'_A6_C2_'},
      '_A7_C1_':{roles:['Assassin','Cleaner'],pass:'_A8S_',fail:'_A9S_'},
      '_A1_C2_':{roles:['Cat Burglar','Assassin'],pass:'_A2_C1_',fail:'_A1_C3_'},
      '_A1_C3_':{roles:['Cat Burglar','Cleaner'],pass:'_A2_C1_',fail:'_A1F_'},
      '_A4_C2_':{role:'Cat Burglar',pass:'_A5_C1_',fail:'_A4F_'},
      '_A2_C2_':{role:'Assassin',pass:'_A3_C1_',fail:'_B3_C1_'},
      '_B3_C1_':{role:'Imitator',pass:'_B4_C1_',fail:'_B3_C2_'},
      '_B3_C2_':{roles:['Assassin','Cleaner'],pass:'_B4_C1_',fail:'_B3F_'},
      '_B4_C1_':{role:'Imitator',pass:'_B5_C1_',fail:'_B4F_'},
      '_B5_C1_':{roles:['Assassin','Cleaner'],pass:'_B6S_',fail:'_B5S_'},
      '_C5_C1_':{role:'Cleaner',pass:'_C6_C1_',fail:'_C5_C2_'},
      '_C6_C1_':{role:'Imitator',pass:'_C7S_',fail:'_C6F_'},
      '_A3_C2_':{role:'Cleaner',pass:'_A4_C1_',fail:'_B3_C1_'},
      '_C5_C2_':{roles:['Cat Burglar','Cleaner'],pass:'_C6_C1_',fail:'_C5F_'},
      '_A6_C2_':{role:'Assassin',pass:'_A7_C1_',fail:'_A6_C3_'},
      '_A6_C3_':{role:'Imitator',pass:'_A6S_',fail:'_A6F_'},
      '_A8S_':{end:true,payout:1.0},'_B6S_':{end:true,payout:0.6916},
      '_C7S_':{end:true,payout:0.7614},'_A9S_':{end:true,payout:0.9113},
      '_A6S_':{end:true,payout:0.7876},'_B5S_':{end:true,payout:0.5675},
      '_B3F_':{end:true,payout:0},'_C6F_':{end:true,payout:0},'_A4F_':{end:true,payout:0},
      '_B4F_':{end:true,payout:0},'_C5F_':{end:true,payout:0},'_A6F_':{end:true,payout:0},
      '_A1F_':{end:true,payout:0},
    }
  },
  'Crane Reaction': {
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
      '_A8S_':{end:true,payout:0},'_A8S2_':{end:true,payout:0},'_B7S_':{end:true,payout:0},
      '_A8S3_':{end:true,payout:0},'_B7S2_':{end:true,payout:0},'_A7F_':{end:true,payout:0},
      '_A4F_':{end:true,payout:0},'_B7F_':{end:true,payout:0},'_B6F_':{end:true,payout:0},
      '_A3F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},
      '_B5F_':{end:true,payout:0},
    }
  },
  'Gone Fission': {
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
      '_A8S_':{end:true,payout:0},'_A8S2_':{end:true,payout:0},'_A1C3F_':{end:true,payout:0},
      '_A5F_':{end:true,payout:0},'_A4F_':{end:true,payout:0},'_A6F_':{end:true,payout:0},
      '_A3F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_A8S3_':{end:true,payout:0},
    }
  },
  'Manifest Cruelty': {
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
      '_A8S_':{end:true,payout:0},'_A7S_':{end:true,payout:0},'_A7F_':{end:true,payout:0},
      '_A5F_':{end:true,payout:0},'_A6F_':{end:true,payout:0},'_B4F_':{end:true,payout:0},
      '_B6F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},
      '_B7S_':{end:true,payout:0},'_B5F_':{end:true,payout:0},
    }
  },
  'Best of the Lot': {
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
      '_B2S_':{end:true,payout:0},'_B3S_':{end:true,payout:0},'_A8S_':{end:true,payout:0},
      '_A7S_':{end:true,payout:0},'_A6S_':{end:true,payout:0},'_A4F_':{end:true,payout:0},
      '_A1F1_':{end:true,payout:0},'_A3F_':{end:true,payout:0},'_B1F_':{end:true,payout:0},
      '_A2F_':{end:true,payout:0},'_A1F2_':{end:true,payout:0},
    }
  },
  'Pet Project': {
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
  'Guardian Angel': {
    start:'_A1_C1_', nodes:{
      '_A1_C1_':{role:'Hustler',pass:'_A2_C1_',fail:'_A1_C2_'},
      '_A2_C1_':{role:'Engineer',pass:'_A3_C1_',fail:'_A2_C2_'},
      '_A3_C1_':{role:'Enforcer',pass:'_A4_C1_',fail:'_A3_C2_'},
      '_A4_C1_':{role:'Engineer',pass:'_A5_C1_',fail:'_B4_C1_'},
      '_A5_C1_':{role:'Hustler',pass:'_A6_C1_',fail:'_A5_C2_'},
      '_A5_C2_':{role:'Enforcer',pass:'_A6_C2_',fail:'_A5_C3_'},
      '_A5_C3_':{role:'Enforcer',pass:'_A6_C2_',fail:'_A5F_'},
      '_A6_C2_':{role:'Engineer',pass:'_A8S_',fail:'_A6_C3_'},
      '_A6_C1_':{role:'Enforcer',pass:'_A7S_',fail:'_A6_C2_'},
      '_A6_C3_':{role:'Hustler',pass:'_A9S_',fail:'_A6F_'},
      '_B4_C1_':{roles:['Enforcer','Engineer'],pass:'_B5_C1_',fail:'_B4_C2_'},
      '_B5_C1_':{role:'Hustler',pass:'_B6S_',fail:'_B5F_'},
      '_A2_C2_':{roles:['Enforcer','Engineer'],pass:'_A3_C1_',fail:'_A2_C3_'},
      '_A3_C2_':{role:'Hustler',pass:'_A4_C1_',fail:'_B4_C1_'},
      '_A1_C2_':{role:'Enforcer',pass:'_A2_C1_',fail:'_A1_C3_'},
      '_B4_C2_':{roles:['Enforcer','Hustler'],pass:'_B5_C1_',fail:'_B4F_'},
      '_A2_C3_':{roles:['Enforcer','Engineer'],pass:'_A3_C1_',fail:'_A2F_'},
      '_A1_C3_':{roles:['Enforcer','Engineer'],pass:'_A2_C1_',fail:'_A1F_'},
      '_A8S_':{end:true,payout:0.8814},'_A7S_':{end:true,payout:1.0},
      '_B6S_':{end:true,payout:0.6069},'_A9S_':{end:true,payout:0.7363},
      '_A6F_':{end:true,payout:0},'_A2F_':{end:true,payout:0},'_A1F_':{end:true,payout:0},
      '_B4F_':{end:true,payout:0},'_A5F_':{end:true,payout:0},'_B5F_':{end:true,payout:0},
    }
  },
  'Sneaky Git Grab': {
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
    expectedValue: walkExpected(fg.start, 1.0, new Set()),
  };
}

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
// Simple in-memory: max 60 requests per minute per key
const rateLimits = new Map();
function checkRateLimit(key) {
  const now = Date.now();
  const window = 60000;
  const max = 60;
  if(!rateLimits.has(key)) rateLimits.set(key, []);
  const times = rateLimits.get(key).filter(t => now - t < window);
  if(times.length >= max) return false;
  times.push(now);
  rateLimits.set(key, times);
  return true;
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Health check — no key required
app.get('/', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', ocs: Object.keys(FLOWCHARTS).length });
});

// Main scoring endpoint
// POST /api/score
// Headers: x-oca-key: YOUR_KEY
// Body: { "ocName": "Counter Offer", "cprs": { "Robber": 72, "Engineer": 68, ... } }
app.post('/api/score', (req, res) => {
  const owner = validateKey(req, res);
  if(!owner) return;

  if(!checkRateLimit(req.headers['x-oca-key'] || req.query.key)) {
    return res.status(429).json({ error: 'Rate limit exceeded (60/min)' });
  }

  const { ocName, cprs } = req.body;
  if(!ocName) return res.status(400).json({ error: 'Missing ocName' });
  if(!cprs || typeof cprs !== 'object') return res.status(400).json({ error: 'Missing cprs object' });

  const result = simulateOC(ocName, cprs);
  if(!result) return res.status(404).json({ error: 'Unknown OC: ' + ocName });

  res.json({
    ocName,
    successChance: result.successChance,
    expectedValue: result.expectedValue,
    owner,
  });
});

// Batch scoring — score multiple slots in one request
// POST /api/score/batch
// Body: { "requests": [{ "ocName": "...", "cprs": {...} }, ...] }
app.post('/api/score/batch', (req, res) => {
  const owner = validateKey(req, res);
  if(!owner) return;

  if(!checkRateLimit(req.headers['x-oca-key'] || req.query.key)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  const { requests } = req.body;
  if(!Array.isArray(requests)) return res.status(400).json({ error: 'requests must be an array' });
  if(requests.length > 50) return res.status(400).json({ error: 'Max 50 requests per batch' });

  const results = requests.map(({ ocName, cprs }) => {
    if(!ocName || !cprs) return { error: 'Missing ocName or cprs' };
    const r = simulateOC(ocName, cprs);
    if(!r) return { ocName, error: 'Unknown OC' };
    return { ocName, successChance: r.successChance, expectedValue: r.expectedValue };
  });

  res.json({ results, owner });
});

// List available OCs
app.get('/api/ocs', (req, res) => {
  const owner = validateKey(req, res);
  if(!owner) return;
  res.json({ ocs: Object.keys(FLOWCHARTS) });
});


// ── KEY PERMISSIONS ───────────────────────────────────────────────────────────
// Key format: OCA-L[FACTION_ID]-[NAME] = leader, OCA-M[FACTION_ID]-[NAME] = member
// Legacy keys (no L/M) default to leader.
function getKeyRole(key) {
  const m = key.match(/^OCA-([LMlm])(\d+)?/i);
  if(!m) return { role:'L', faction:'001' };
  return { role: m[1].toUpperCase(), faction: m[2] || '001' };
}
function isLeaderKey(key) { return getKeyRole(key).role === 'L'; }
function getFactionId(key) { return getKeyRole(key).faction; }

// ── ASSIGNMENT STORAGE ────────────────────────────────────────────────────────
// Stored in memory + persisted to assignments.json on Railway disk
const ASSIGN_FILE = path.join(__dirname, 'assignments.json');
let _assignments = {};
try {
  if(fs.existsSync(ASSIGN_FILE)) _assignments = JSON.parse(fs.readFileSync(ASSIGN_FILE, 'utf8'));
} catch(e) { _assignments = {}; }
function saveAssignments() {
  try { fs.writeFileSync(ASSIGN_FILE, JSON.stringify(_assignments, null, 2)); } catch(e) {}
}

// ── ASSIGNMENT ENDPOINTS ──────────────────────────────────────────────────────

// POST /api/assign — leader sets assignment for a member
// Body: { tornName, role, ocName, ocLevel }
app.post('/api/assign', (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = validateKey(req, res);
  if(!owner) return;
  if(!isLeaderKey(key)) return res.status(403).json({ error: 'Leader key required' });

  const { tornName, role, ocName, ocLevel } = req.body;
  if(!tornName || !role || !ocName) return res.status(400).json({ error: 'Missing tornName, role or ocName' });

  const faction = getFactionId(key);
  if(!_assignments[faction]) _assignments[faction] = {};
  _assignments[faction][tornName.toLowerCase()] = {
    tornName, role, ocName, ocLevel: ocLevel || null,
    assignedAt: Date.now(), assignedBy: owner
  };
  saveAssignments();
  console.log(`[ASSIGN] ${owner} assigned ${tornName} → ${role} in ${ocName} (L${ocLevel})`);
  res.json({ ok: true, assignment: _assignments[faction][tornName.toLowerCase()] });
});

// GET /api/assignment — member polls for their assignment
// Query: tornName (their Torn username)
app.get('/api/assignment', (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = validateKey(req, res);
  if(!owner) return;

  const tornName = (req.query.tornName || '').trim();
  if(!tornName) return res.status(400).json({ error: 'Missing tornName' });

  const faction = getFactionId(key);
  const assignment = _assignments[faction]?.[tornName.toLowerCase()] || null;
  res.json({ assignment });
});

// DELETE /api/assign — clear an assignment (leader clears, or member dismisses after joining)
app.delete('/api/assign', (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = validateKey(req, res);
  if(!owner) return;

  const tornName = (req.body.tornName || req.query.tornName || '').trim();
  if(!tornName) return res.status(400).json({ error: 'Missing tornName' });

  const faction = getFactionId(key);
  if(_assignments[faction]) {
    delete _assignments[faction][tornName.toLowerCase()];
    saveAssignments();
  }
  res.json({ ok: true });
});

// GET /api/assignments — leader gets all active assignments for their faction
app.get('/api/assignments', (req, res) => {
  const key = req.headers['x-oca-key'] || req.query.key;
  const owner = validateKey(req, res);
  if(!owner) return;
  if(!isLeaderKey(key)) return res.status(403).json({ error: 'Leader key required' });

  const faction = getFactionId(key);
  res.json({ assignments: _assignments[faction] || {} });
});

// ── START ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`OCA Server running on port ${PORT}`);
  console.log(`OCs loaded: ${Object.keys(FLOWCHARTS).length}`);
  const keys = loadKeys();
  console.log(`Keys loaded: ${Object.keys(keys).length}`);
});
