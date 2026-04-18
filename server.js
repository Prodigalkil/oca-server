// ==UserScript==
// @name         HiveOC
// @namespace    hive-oc-advisor
// @version      0.25.2
// @author       Prodigal
// @description  Hive OC Advisor — The most powerful faction OC management tool for Torn City.
// @match        https://www.torn.com/factions.php*
// @grant        GM_xmlhttpRequest
// @connect      oca-server-production.up.railway.app
// @connect      tornstats.com
// @connect      api.torn.com
// @connect      *
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // CONSTANTS
  // ═══════════════════════════════════════════════════════════════

  const VERSION    = '0.25.2';
  const OCA_SERVER = 'https://oca-server-production.up.railway.app';

  console.log(`[HIVE OC] Loaded v${VERSION}`);

  // ═══════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════

  let _ocaKey      = localStorage.getItem('hive-oc-key')   || '';
  let _tsApiKey    = localStorage.getItem('hive-ts-key')   || '';
  let _memberOcaKey = localStorage.getItem('hive-moca-key') || '';
  let _optimMode    = localStorage.getItem('hive-optim-mode') || 'spread';
  let _optimObj     = localStorage.getItem('hive-optim-obj')  || 'aggressive'; // 'aggressive' | 'controlled'
  let _ocsRoles     = {};   // populated from /api/roles — server-side OCS_ROLES
  let _roleCPRRanges = {};  // populated from /api/roles — server-side ROLE_CPR_RANGES

  let _myName         = null;
  let _factionId      = null;
  let _isLeader       = false;
  let _factionMembers = [];
  let _notInOCMembers = [];
  let _tsLoaded       = false;
  let _roleColors     = {};
  let _roleContext    = {};
  let _payoutModel    = {};
  let _allMemberCPR   = {};
  let _factionRoster  = [];
  let _memberLevels   = {};  // name → level, built from Torn API roster
  let _tornKey        = localStorage.getItem('hive-torn-key') || '';

  let _scanResult  = null;
  let _optimResult = null;
  let _assignment  = null;
  let _assignments = {};

  let _pollTimer   = null;
  let _scanTimer   = null;
  let _optimTimer  = null;

  let _panelOpen   = false;
  let _activeTab   = 'advisor';
  let _selectedOC  = null;  // currently selected OC ocId in advisor list
  let _observer    = null;

  // ═══════════════════════════════════════════════════════════════
  // KEY PARSING
  // ═══════════════════════════════════════════════════════════════

  function parseKey(key) {
    const m = (key || '').match(/^OCA-([LMlm])(\d+)-(.+)$/i);
    if (!m) return null;
    return {
      keyType:   m[1].toUpperCase(),
      factionId: m[2],
      ownerName: m[3].trim(),
    };
  }

  function initKeyState() {
    const parsed = parseKey(_ocaKey);
    if (parsed) {
      _myName    = parsed.ownerName;
      _factionId = parsed.factionId;
      _isLeader  = parsed.keyType === 'L';
    } else {
      _myName    = null;
      _factionId = null;
      _isLeader  = false;
    }
    _tornKey      = localStorage.getItem('hive-torn-key') || '';
    _memberOcaKey = localStorage.getItem('hive-moca-key') || '';
  }

  // ═══════════════════════════════════════════════════════════════
  // DOM SELECTORS
  // ═══════════════════════════════════════════════════════════════

  const OC_ALIASES = {
    'Guardian Ángels':    'Guardian Angels',
    'Guardian Angels':    'Guardian Angels',
    'Market Force':       'Market Forces',
    'Cash Me if You Can': 'Cash Me If You Can',
    'Cash Me If You Can': 'Cash Me If You Can',
  };

  function normOCName(name) {
    if (!name) return name;
    return OC_ALIASES[name.trim()] || name.trim();
  }

  const SEL = {
    crimeCard:  '[class*="wrapper___U2Ap7"]',
    crimeTitle: '[class*="panelTitle___"]',
    slotWrap:   '[class*="wrapper___Lpz_D"]',   // slot container — unchanged, always correct
    slotTitle:  '[class*="title___"]',           // inside slotHeader within slotWrap
    slotCPR:    '[class*="successChance___"]',   // inside slotHeader within slotWrap
    hasJoin:    '[class*="joinContainer___"]',   // inside slotWrap when empty
    slotBody:   '[class*="slotBody___"]',        // sibling of slotHeader inside slotWrap
    validSlot:  '[class*="validSlot___"]',       // class on slotBody when filled
    slotMenu:   '[class*="slotMenuItem___"]',
  };

  function getPlayerName(slotEl) {
    if (!slotEl) return null;
    // slotEl is wrapper___Lpz_D — player name is in slotBody > badgeContainer
    const body = slotEl.querySelector('[class*="slotBody___"]');
    const badge = body?.querySelector('[class*="badgeContainer___"]');
    if (badge?.textContent?.trim()) return badge.textContent.trim();
    // Fallback: honor-text inside body
    const honor = body?.querySelector('.honor-text, [class*="honor-text"]');
    if (honor?.textContent?.trim()) return honor.textContent.trim();
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // DOM HELPERS
  // ═══════════════════════════════════════════════════════════════

  function textOnly(el) {
    if (!el) return '';
    let t = '';
    el.childNodes.forEach(n => { if (n.nodeType === 3) t += n.textContent; });
    return t.trim() || el.textContent.trim();
  }

  function normRole(r) {
    if (!r) return '';
    return String(r).replace(/#\s*/g, '').replace(/\s+/g, ' ').trim()
      .replace(/\b([A-Z]+)\b/g, w => w.charAt(0) + w.slice(1).toLowerCase());
  }

  function slotHasLeave(slot) {
    // slot is wrapper___Lpz_D — check if player name in slotBody matches _myName
    if (_myName) {
      const playerName = getPlayerName(slot);
      if (playerName && playerName.toLowerCase().includes(_myName.toLowerCase())) return true;
    }
    // Fallback: look for "Remove from Role" / "Leave" in slotMenu items
    const els = [...slot.querySelectorAll(SEL.slotMenu)];
    return els.some(el => /leave role|leave slot|remove from role/i.test(el.textContent.trim()));
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════

  const fmt = n => {
    if (!n) return '0';
    if (n >= 1e8) return (n / 1e6).toFixed(0) + 'M';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return n.toString();
  };

  const formatM = fmt;

  const levelColor = l =>
    l >= 9 ? '#e74c3c' :
    l >= 7 ? '#ff6d00' :
    l >= 5 ? '#ffd740' :
    l >= 3 ? '#29b6f6' : '#607d8b';

  const statusColor = pct =>
    pct >= 75 ? '#22d3ee' :
    pct >= 60 ? '#60a5fa' : '#e74c3c';

  function showToast(msg, duration = 2500) {
    let el = document.getElementById('hive-ui-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'hive-ui-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('visible');
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => el.classList.remove('visible'), duration);
  }

  function scrollToEl(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const orig = el.style.outline || '';
    el.style.outline = '2px solid #22d3ee';
    setTimeout(() => { el.style.outline = orig; }, 1500);
  }

  // ═══════════════════════════════════════════════════════════════
  // SCAN
  // ═══════════════════════════════════════════════════════════════

  function scan() {
    const ocs    = [];
    let mySlot   = null;

    document.querySelectorAll(SEL.crimeCard).forEach(card => {
      const ocName = normOCName(textOnly(card.querySelector(SEL.crimeTitle)));
      if (!ocName) return;

      const filledRoles        = {};
      const openRoles          = [];
      const existingPlacements = [];
      let   isPlanning         = false;

      card.querySelectorAll(SEL.slotWrap).forEach(slot => {
        const role = normRole(textOnly(slot.querySelector(SEL.slotTitle)));
        if (!role) return;

        const cpr      = parseInt(slot.querySelector(SEL.slotCPR)?.textContent) || 0;
        // Filled slot: slotBody has validSlot___ class
        // Empty slot: slotBody lacks validSlot___ OR joinContainer___ is present
        const slotBody  = slot.querySelector(SEL.slotBody);
        const isValid   = slotBody?.classList.toString().includes('validSlot');
        const hasJoin   = !!slot.querySelector(SEL.hasJoin);
        const isEmpty   = !isValid || hasJoin;
        const hasTimer  = /\d{2}:\d{2}:\d{2}/.test(card.innerText);

        if (hasTimer) isPlanning = true;

        if (!isEmpty) {
          if (cpr > 0) filledRoles[role] = cpr;
          if (slotHasLeave(slot)) {
            mySlot = { ocName, role, cpr, slotEl: slot, isPlanning: hasTimer };
          }
          const memberName = getPlayerName(slot);
          if (memberName && cpr > 0) {
            existingPlacements.push({ member: memberName, role, cpr });
          }
        } else {
          openRoles.push(role);
        }
      });

      if (openRoles.length > 0 || Object.keys(filledRoles).length > 0) {
        const levelText = card.innerText.match(/(\d+)\s*\/\s*10/);
        const domLevel  = levelText ? parseInt(levelText[1]) : null;
        ocs.push({ ocName, isPlanning, domLevel, filledRoles, openRoles, existingPlacements, cardEl: card });
      }
    });

    _notInOCMembers = [];
    const notInEl = document.querySelector('[class*="notInvolvedMembers"]');
    if (notInEl) {
      notInEl.querySelectorAll('a[href*="profiles.php"]').forEach(a => {
        const name   = a.textContent?.trim();
        const tornId = a.href?.match(/XID=(\d+)/)?.[1];
        if (name) _notInOCMembers.push({ name, tornId: tornId || null, status: 'available' });
      });
    }

    _scanResult = { ocs, mySlot };

    // Assign stable unique ocIds. All OCs get positional IDs (0-indexed)
    // so duplicates are clearly distinguishable to the server optimizer.
    // Format: "ocName||N" — the || separator avoids colliding with any OC name.
    ocs.forEach((oc, i) => { oc.ocId = oc.ocName + '||' + i; });

    return _scanResult;
  }

  // ═══════════════════════════════════════════════════════════════
  // SERVER REQUESTS
  // ═══════════════════════════════════════════════════════════════

  function serverRequest({ method, path, body, onSuccess, onError, ocaKey }) {
    const keyToUse = ocaKey || _ocaKey;
    if (!keyToUse) { if (onError) onError('No key'); return; }
    GM_xmlhttpRequest({
      method:  method || 'GET',
      url:     OCA_SERVER + path,
      headers: { 'Content-Type': 'application/json', 'x-oca-key': keyToUse },
      data:    body ? JSON.stringify(body) : undefined,
      timeout: 10000,
      onload(r) {
        try {
          const d = JSON.parse(r.responseText);
          if (r.status >= 400) { if (onError) onError(d.error || 'Server error ' + r.status); }
          else { if (onSuccess) onSuccess(d); }
        } catch(e) { if (onError) onError('Parse error'); }
      },
      onerror()   { if (onError) onError('Network error'); },
      ontimeout() { if (onError) onError('Timeout'); },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // TORNSTATS
  // ═══════════════════════════════════════════════════════════════

  function loadTornStats() {
    if (!_tsApiKey || !_ocaKey) return;
    console.log('[HIVE OC] Loading TornStats CPR + roster...');

    let cprData      = null;
    let rosterData   = null;
    let personalCPR  = null;
    let callsDone    = 0;
    const TOTAL_CALLS = 3;

    function tryProcess() {
      callsDone++;
      if (callsDone < TOTAL_CALLS) return;

      if (!rosterData) {
        console.warn('[HIVE OC] TornStats: missing roster data');
        _tsLoaded = false;
        if (_panelOpen) renderSettings();
        return;
      }

      const idToName = {};
      Object.entries(rosterData).forEach(([id, member]) => {
        if (member?.name) idToName[id] = member.name;
      });

      _factionMembers = Object.entries(rosterData).map(([id, member]) => ({
        name:   member.name || id,
        status: 'available',
      }));
      if (_myName && !_factionMembers.find(m => m.name === _myName)) {
        _factionMembers.push({ name: _myName, status: 'available' });
      }
      console.log('[HIVE OC] TornStats roster loaded:', _factionMembers.length, 'members');

      const namedCPR = {};
      if (cprData) {
        // Build live member name set from Torn API roster — source of truth for membership
        const liveMemberNames = new Set(
          _factionRoster.length > 0
            ? _factionRoster.map(m => m.name)
            : _factionMembers.map(m => m.name)
        );

        Object.entries(cprData).forEach(([id, ocData]) => {
          const name = idToName[id];
          if (!name) return;
          // Skip ex-members — only push CPR for current faction members
          if (liveMemberNames.size > 0 && !liveMemberNames.has(name)) {
            console.log('[HIVE OC] Skipping ex-member CPR push:', name);
            return;
          }
          namedCPR[name] = ocData;
        });
      }

      if (personalCPR && _myName) {
        namedCPR[_myName] = personalCPR;
      }

      if (Object.keys(namedCPR).length > 0) {
        serverRequest({
          method: 'POST', path: '/api/cpr/batch', body: { members: namedCPR },
          onSuccess(d) {
            console.log('[HIVE OC] TornStats CPR pushed:', d.updated, 'members updated');
            _tsLoaded = true;
            serverRequest({ method: 'POST', path: '/api/cpr/cleanup',
              onSuccess(c) { if (c.removed > 0) console.log('[HIVE OC] Cleaned', c.removed, 'old ID entries'); }
            });
            setTimeout(() => { if (_isLeader) loadAllCPR(); }, 1500);
            scheduleOptimize();
            if (_panelOpen) renderSettings();
          },
          onError(err) {
            console.warn('[HIVE OC] CPR batch push failed:', err);
            _tsLoaded = false;
            if (_panelOpen) renderSettings();
          },
        });
      } else {
        _tsLoaded = true;
        if (_panelOpen) renderSettings();
      }
    }

    GM_xmlhttpRequest({
      method: 'GET', url: `https://www.tornstats.com/api/v2/${_tsApiKey}/faction/cpr`, timeout: 10000,
      onload(r) {
        try { const d = JSON.parse(r.responseText); if (d?.members) cprData = d.members; } catch(e) {}
        tryProcess();
      },
      onerror()   { tryProcess(); },
      ontimeout() { tryProcess(); },
    });

    GM_xmlhttpRequest({
      method: 'GET', url: `https://www.tornstats.com/api/v2/${_tsApiKey}/faction/roster`, timeout: 10000,
      onload(r) {
        try { const d = JSON.parse(r.responseText); if (d?.members) rosterData = d.members; } catch(e) {}
        tryProcess();
      },
      onerror()   { tryProcess(); },
      ontimeout() { tryProcess(); },
    });

    GM_xmlhttpRequest({
      method: 'GET', url: `https://www.tornstats.com/api/v2/${_tsApiKey}/crime_pass_rates/show`, timeout: 10000,
      onload(r) {
        try {
          const d = JSON.parse(r.responseText);
          if (d?.status && d?.crimes) personalCPR = d.crimes;
        } catch(e) {}
        tryProcess();
      },
      onerror()   { tryProcess(); },
      ontimeout() { tryProcess(); },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // MEMBER API CPR PUSH
  // ═══════════════════════════════════════════════════════════════

  // Calls v2/faction/crimes with the member's own Torn API key.
  // Torn shows the calling user's checkpoint_pass_rate for every visible slot.
  // Extracts CPR per OC per role, pushes to /api/cpr/member.
  // The Torn key never leaves the browser.
  let _memberCPRPushed = false;

  function loadMemberAPICPR() {
    const activeKey = _memberOcaKey || (_ocaKey && !_isLeader ? _ocaKey : null);
    if (!activeKey || !_tornKey || _memberCPRPushed) return;

    // Determine member name from active key
    const parsed = parseKey(activeKey);
    if (!parsed || parsed.keyType !== 'M') return;
    const memberName = _myName || parsed.ownerName;
    const factionId  = parsed.factionId;

    console.log('[HIVE OC] Member CPR push starting for', memberName);

    const collectedCPR = {};
    let callsDone = 0;
    const cats = ['recruiting', 'planning'];

    function processSlots(crimes) {
      (crimes || []).forEach(crime => {
        const ocName = crime.name;
        if (!ocName) return;
        (crime.slots || []).forEach(slot => {
          const role = slot.position;
          const cpr  = slot.checkpoint_pass_rate;
          if (!role || typeof cpr !== 'number') return;
          // Normalize role name — strip trailing number suffix if Torn returns "Muscle #2"
          const normRole = role.replace(/\s*#\d+$/, '').trim();
          if (!collectedCPR[ocName]) collectedCPR[ocName] = {};
          // Keep highest CPR seen for this role (in case multiple slots exist)
          if (collectedCPR[ocName][normRole] === undefined || cpr > collectedCPR[ocName][normRole]) {
            collectedCPR[ocName][normRole] = cpr;
          }
        });
      });
    }

    function trySubmit() {
      callsDone++;
      if (callsDone < cats.length) return;
      if (!Object.keys(collectedCPR).length) {
        console.warn('[HIVE OC] Member CPR: no CPR data found in faction crimes');
        return;
      }
      console.log('[HIVE OC] Member CPR collected:', Object.keys(collectedCPR).length, 'OCs');
      serverRequest({
        method: 'POST',
        path: '/api/cpr/member',
        body: { memberName, factionId, cprs: collectedCPR },
        ocaKey: activeKey,
        onSuccess(d) {
          _memberCPRPushed = true;
          console.log('[HIVE OC] Member CPR pushed:', d.ocCount, 'OCs for', d.memberName);
          showToast('Your CPR data synced ✓');
        },
        onError(err) {
          console.warn('[HIVE OC] Member CPR push failed:', err);
        },
      });
    }

    cats.forEach(cat => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://api.torn.com/v2/faction/crimes?cat=${cat}&limit=100&key=${_tornKey}&comment=HiveOCA`,
        timeout: 15000,
        onload(r) {
          try {
            const d = JSON.parse(r.responseText);
            if (d?.crimes) processSlots(d.crimes);
          } catch(e) { console.warn('[HIVE OC] Member CPR parse error:', e.message); }
          trySubmit();
        },
        onerror()   { console.warn('[HIVE OC] Member CPR fetch error'); trySubmit(); },
        ontimeout() { console.warn('[HIVE OC] Member CPR fetch timeout'); trySubmit(); },
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // ROLE COLORS / ALL CPR / PAYOUT
  // ═══════════════════════════════════════════════════════════════

  function loadRoleColors() {
    if (!_ocaKey) return;
    serverRequest({
      method: 'GET', path: '/api/roles',
      onSuccess(d) {
        _roleColors    = d.roles        || {};
        _roleContext   = d.context      || {};
        _ocsRoles      = d.ocsRoles     || {};
        _roleCPRRanges = d.roleCPRRanges || {};
        console.log('[HIVE OC] Role data loaded from server:', Object.keys(_ocsRoles).length, 'OCs mapped');
        // Re-render if panel is open — role badges depend on this data
        if (_panelOpen && _activeTab === 'advisor') { renderOCList(); if (_selectedOC) renderDetailCol(_selectedOC); }
      },
    });
  }

  function loadAllCPR() {
    if (!_ocaKey || !_isLeader) return;
    serverRequest({
      method: 'GET', path: '/api/cpr',
      onSuccess(d) {
        _allMemberCPR = d.members || {};
        console.log('[HIVE OC] All faction CPR loaded:', Object.keys(_allMemberCPR).length, 'members');
        if (_panelOpen && _activeTab === 'advisor') renderQueue();
      },
    });
  }

  function loadPayoutModel() {
    if (!_ocaKey || !_isLeader) return;
    serverRequest({
      method: 'GET', path: '/api/payout/model',
      onSuccess(d) {
        _payoutModel = d.model || {};
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // OPTIMIZE
  // ═══════════════════════════════════════════════════════════════

  function runOptimize() {
    if (!_ocaKey || !_scanResult) return;
    const { ocs } = _scanResult;
    if (!ocs.length) return;

    let availableMembers = [];

    if (_factionMembers.length > 0) {
      const inPlanningOC = new Set();
      ocs.forEach(oc => {
        if (oc.isPlanning) oc.existingPlacements.forEach(p => inPlanningOC.add(p.member));
      });
      availableMembers = _factionMembers.filter(m => !inPlanningOC.has(m.name));
    } else {
      const memberPool = new Map();
      ocs.forEach(oc => {
        oc.existingPlacements.forEach(p => {
          if (!memberPool.has(p.member)) memberPool.set(p.member, { name: p.member, status: 'available' });
        });
      });
      if (_myName && !memberPool.has(_myName)) memberPool.set(_myName, { name: _myName, status: 'available' });
      availableMembers = [...memberPool.values()];
    }

    if (_notInOCMembers.length > 0) {
      const existingNames = new Set(availableMembers.map(m => m.name));
      _notInOCMembers.forEach(m => {
        if (!existingNames.has(m.name)) availableMembers.push({ name: m.name, status: 'available' });
      });
    }

    if (availableMembers.length === 0) return;

    // Filter out corrupt/fake member names (e.g. "17mProdigal" — starts with digits)
    availableMembers = availableMembers.filter(m => !/^\d/.test(m.name || ''));

    // Enrich each OC's availableMembers with inline CPR so the server optimizer
    // doesn't need to DB-lookup by name — it gets role CPR directly in the request.
    // This fixes the core sorting bug where DB name mismatches cause 0-CPR assignments.
    const ocsForOptimize = ocs.map(oc => {
      const enrichedMembers = availableMembers.map(m => {
        const memberCPR  = _allMemberCPR[m.name];
        const ocCPRs     = memberCPR?.cprs?.[oc.ocName] || {};
        // Build role→cpr map, stripping trailing numbers from role names
        const roleCPR = {};
        Object.entries(ocCPRs).forEach(([role, cpr]) => {
          roleCPR[role] = cpr;
          const base = role.replace(/\s+\d+$/, '').trim();
          if (base !== role) roleCPR[base] = cpr;
        });
        return { name: m.name, status: m.status, cprByRole: roleCPR };
      });
      return {
        ocId:               oc.ocId || oc.ocName,
        ocName:             oc.ocName,
        domLevel:           oc.domLevel || null,
        openRoles:          oc.openRoles,
        filledCPRs:         oc.filledRoles,
        existingPlacements: oc.existingPlacements,
        availableMembers:   enrichedMembers,
      };
    }).filter(oc => oc.openRoles.length > 0 || oc.existingPlacements.length > 0);

    if (!ocsForOptimize.length) return;

    serverRequest({
      method: 'POST', path: '/api/optimize',
      body: { ocs: ocsForOptimize, requestingMember: _myName, mode: _optimMode, objective: _optimObj },
      onSuccess(d) {
        _optimResult = d;
        console.log('[HIVE OC] Optimize complete:', d.meta);
        if (_panelOpen && _activeTab === 'advisor') {
          renderOCList();
          if (_selectedOC) renderDetailCol(_selectedOC);
          renderQueue();
        }
      },
      onError(err) { console.warn('[HIVE OC] Optimize error:', err); },
    });
  }

  function scheduleOptimize() {
    clearTimeout(_optimTimer);
    _optimTimer = setTimeout(runOptimize, 800);
  }

  // ═══════════════════════════════════════════════════════════════
  // TORN API — faction roster
  // ═══════════════════════════════════════════════════════════════

  function loadFactionRoster(onDone) {
    if (!_tornKey) { if (onDone) onDone([]); return; }
    GM_xmlhttpRequest({
      method: 'GET',
      url: `https://api.torn.com/faction/?selections=basic&key=${_tornKey}&comment=HiveOCA`,
      timeout: 8000,
      onload(r) {
        try {
          const data = JSON.parse(r.responseText);
          if (data?.error) { if (onDone) onDone([]); return; }
          const members = data.members || {};
          _factionRoster = Object.entries(members).map(([id, m]) => ({
            id, name: m.name, level: m.level || null,
            status: m.status?.state === 'Hospital' ? 'hospital' : 'available',
          }));
          // Build name → level lookup used everywhere avatars are shown
          _memberLevels = {};
          _factionRoster.forEach(m => { if (m.level) _memberLevels[m.name] = m.level; });
          if (_factionRoster.length > 0 && _factionMembers.length === 0) {
            _factionMembers = _factionRoster.map(m => ({ name: m.name, status: m.status }));
          }
          // Auto-purge ex-members from server DB — runs silently if roster is available
          if (_isLeader && _factionRoster.length > 0) {
            purgeExMembers(_factionRoster.map(m => m.name));
          }
          if (onDone) onDone(_factionRoster);
        } catch(e) { if (onDone) onDone([]); }
      },
      onerror()   { if (onDone) onDone([]); },
      ontimeout() { if (onDone) onDone([]); },
    });
  }

  function purgeExMembers(liveNames) {
    if (!_ocaKey || !_isLeader || !liveNames?.length) return;
    // Ask server which members are in DB but not in liveNames
    serverRequest({
      method: 'GET', path: '/api/cpr',
      onSuccess(d) {
        const dbNames   = Object.keys(d.members || {});
        const liveSet   = new Set(liveNames);
        const toRemove  = dbNames.filter(n => !liveSet.has(n));
        if (!toRemove.length) return;
        console.log('[HIVE OC] Purging ex-members from DB:', toRemove);
        serverRequest({
          method: 'POST', path: '/api/cpr/purge',
          body: { members: toRemove },
          onSuccess(r) {
            console.log('[HIVE OC] Purged', r.removed, 'ex-members:', toRemove.join(', '));
            // Reload CPR data with clean state
            if (_isLeader) setTimeout(() => loadAllCPR(), 500);
          },
        });
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // ASSIGNMENT POLLING
  // ═══════════════════════════════════════════════════════════════

  function pollAssignment() {
    if (!_ocaKey || !_myName) return;
    serverRequest({
      method: 'GET',
      path:   `/api/assignment?tornName=${encodeURIComponent(_myName)}`,
      onSuccess(d) {
        const prev    = _assignment;
        _assignment   = d.assignment || null;
        const changed = JSON.stringify(prev) !== JSON.stringify(_assignment);
        if (changed) {
          updateAssignmentBadge();
          if (_panelOpen && _activeTab === 'advisor') renderAdvisor();
        }
        if (_assignment && _scanResult?.mySlot) {
          const s = _scanResult.mySlot;
          if ((s.ocName || '').toLowerCase() === (_assignment.ocName || '').toLowerCase() &&
              (s.role   || '').toLowerCase() === (_assignment.role   || '').toLowerCase()) {
            clearAssignment();
          }
        }
      },
    });
  }

  function clearAssignment() {
    if (!_ocaKey || !_myName) return;
    serverRequest({
      method: 'DELETE', path: '/api/assign', body: { tornName: _myName },
      onSuccess() {
        _assignment = null;
        updateAssignmentBadge();
        document.getElementById('hive-toast')?.remove();
        if (_panelOpen && _activeTab === 'advisor') renderAdvisor();
      },
    });
  }

  function sendAssignment(tornName, role, ocName, ocLevel) {
    if (!_ocaKey || !_isLeader) return;
    serverRequest({
      method: 'POST', path: '/api/assign', body: { tornName, role, ocName, ocLevel },
      onSuccess() {
        console.log(`[HIVE OC] Assigned ${tornName} → ${role} in ${ocName}`);
        loadFactionAssignments();
      },
    });
  }

  function loadFactionAssignments() {
    if (!_ocaKey || !_isLeader) return;
    serverRequest({
      method: 'GET', path: '/api/assignments',
      onSuccess(d) {
        _assignments = d.assignments || {};
        updateAssignmentBadge();
        if (_panelOpen && _activeTab === 'roster') renderRoster();
      },
    });
  }

  function deleteAssignment(tornName) {
    if (!_ocaKey || !_isLeader) return;
    serverRequest({
      method: 'DELETE', path: '/api/assign', body: { tornName },
      onSuccess() { loadFactionAssignments(); },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  function updateAssignmentBadge() {
    // Update the pending button in top bar
    const btn = document.getElementById('hive-pending-btn');
    if (!btn) return;

    // Count pending assignments (leader) or own assignment (member)
    let count = 0;
    if (_isLeader) {
      count = Object.keys(_assignments || {}).length;
    } else {
      count = _assignment ? 1 : 0;
    }

    if (count > 0) {
      btn.style.display = 'flex';
      const countEl = btn.querySelector('.hive-pending-count');
      if (countEl) countEl.textContent = count;
    } else {
      btn.style.display = 'none';
    }

    // Legacy toggle button badge
    const toggleBtn = document.getElementById('hive-toggle-btn');
    let badge = document.getElementById('hive-assign-badge');
    if (count > 0) {
      if (!badge && toggleBtn) {
        badge = document.createElement('div');
        badge.id = 'hive-assign-badge';
        toggleBtn.appendChild(badge);
      }
    } else {
      badge?.remove();
    }
  }

  // Returns level number if known, otherwise initials fallback
  function memberAvatar(name) {
    const lvl = _memberLevels[name];
    return lvl != null ? lvl : (name || '?').slice(0, 2);
  }

  // ═══════════════════════════════════════════════════════════════
  // ROLE DATA — served from /api/roles, no client-side constants
  // ═══════════════════════════════════════════════════════════════

  function getRoleCPRRange(role) {
    const base = (role || '').replace(/\s+\d+$/, '');
    return _roleCPRRanges[role] || _roleCPRRanges[base]
      || { idealMin:58, idealMax:74, absMin:50, overQual:85, safe:false };
  }

  function getOCSRole(ocName, role) {
    if (!ocName || !role) return null;
    const base = (role || '').replace(/\s+\d+$/, '');
    const d = _ocsRoles[ocName];
    if (d) return d[role] || d[base] || null;
    // Fallback: check by normOCName
    for (const [k, v] of Object.entries(_ocsRoles)) {
      if (normOCName(k) === normOCName(ocName)) return v[role] || v[base] || null;
    }
    return null;
  }

  function roleColorDot(ocName, role) {
    const ocsRole = getOCSRole(ocName, role);
    if (ocsRole) {
      if (ocsRole.crit || ocsRole.tier === 'CRITICAL')   return '🔴';
      if (ocsRole.safe || ocsRole.tier === 'FREE')        return '🟢';
      return '🟡';
    }
    const base  = (role || '').replace(/\s+\d+$/, '');
    const color = _roleColors[ocName]?.[role] || _roleColors[ocName]?.[base];
    if (color === 'red')   return '🔴';
    if (color === 'green') return '🟢';
    return '🟡';
  }

  function getRoleContext(ocName, role) {
    const base = (role || '').replace(/\s+\d+$/, '');
    return _roleContext[ocName]?.[role] || _roleContext[ocName]?.[base] || null;
  }

  function buildRoleTooltip(ocName, role, memberCPR) {
    const ocsRole  = getOCSRole(ocName, role);
    const rc       = getRoleCPRRange(role);
    const isSafe   = ocsRole ? (ocsRole.safe || ocsRole.tier === 'FREE') : rc.safe;
    const isCrit   = ocsRole ? (ocsRole.crit || ocsRole.tier === 'CRITICAL') : false;
    const absMin   = ocsRole?.absMin  ?? rc.absMin;
    const idealMin = ocsRole?.idealMin ?? rc.idealMin;
    const idealMax = rc.idealMax ?? (idealMin + 10);
    const overQual = rc.overQual ?? 85;
    const lines    = [role + '  ·  ' + ocName];

    // Safety line — prefer server-generated safety text, fall back to flowchart context
    if (ocsRole?.safety) {
      lines.push(ocsRole.safety);
    } else {
      const ctx = getRoleContext(ocName, role);
      if (ctx?.desc) lines.push(ctx.desc);
    }

    if (!isSafe) {
      lines.push('Ideal: ' + idealMin + '–' + idealMax + '%    Min: ' + absMin + '%    Over-qual: ' + overQual + '%');
    }

    if (memberCPR > 0) {
      const status = (() => {
        if (isSafe)                                        return 'safe';
        if (memberCPR > overQual)                         return 'overqual';
        if (memberCPR >= idealMin && memberCPR <= idealMax) return 'ideal';
        if (memberCPR > idealMax)                         return 'strong';
        if (memberCPR >= absMin)                          return 'marginal';
        return isCrit ? 'belowmin' : 'risky';
      })();
      const labels = {
        safe:     'Any CPR — safe role',
        ideal:    '★ Ideal range — perfect fit',
        strong:   '✓ Strong CPR — good fit',
        overqual: '⚡ Over-qualified — consider lower OC',
        marginal: '⚠ Below ideal — risky if critical',
        risky:    '⚠ Below recommended minimum',
        belowmin: '🔴 Below minimum — high risk on critical role',
      };
      lines.push('Their ' + memberCPR + '% — ' + (labels[status] || ''));
    }

    return lines.join('\n');
  }

  function roleBadge(ocName, role, cpr) {
    const ocsRole = getOCSRole(ocName, role);
    const rc      = getRoleCPRRange(role);
    const isSafe  = ocsRole ? (ocsRole.safe || ocsRole.tier === 'FREE') : rc.safe;
    const isCrit  = ocsRole ? (ocsRole.crit || ocsRole.tier === 'CRITICAL') : false;
    const safety  = ocsRole?.safety || '';

    let tierLabel, tierCol;
    if (isSafe) {
      tierLabel = '🟢 free slot';    tierCol = '#22d3ee';
    } else if (/^💀/.test(safety)) {
      tierLabel = '💀 instant fail'; tierCol = '#ff6b6b';
    } else if (isCrit) {
      tierLabel = '🔴 critical';     tierCol = '#e74c3c88';
    } else {
      tierLabel = '🟠 important';    tierCol = '#ff9f4388';
    }

    if (!cpr || cpr <= 0) {
      return '<span style="font-size:8px;color:' + tierCol + ';opacity:0.7">' + tierLabel + '</span>';
    }

    // Use server absMin/idealMin if available, otherwise fall back to ROLE_CPR_RANGES
    const absMin  = ocsRole?.absMin  ?? rc.absMin;
    const idealMin = ocsRole?.idealMin ?? rc.idealMin;
    const idealMax = rc.idealMax ?? (idealMin + 10);
    const overQual = rc.overQual ?? 85;

    let statusLabel, statusCol;
    if (isSafe) {
      statusLabel = '✓ Safe'; statusCol = '#22d3ee';
    } else if (cpr > overQual) {
      statusLabel = '⚡ Over-qual'; statusCol = '#60a5fa';
    } else if (cpr >= idealMin && cpr <= idealMax) {
      statusLabel = '★ Ideal'; statusCol = '#22d3ee';
    } else if (cpr > idealMax) {
      statusLabel = '✓ Strong'; statusCol = '#22d3ee';
    } else if (cpr >= absMin) {
      statusLabel = '⚠ Marginal'; statusCol = '#60a5fa';
    } else {
      statusLabel = '🔴 Below min'; statusCol = '#e74c3c';
    }

    return '<span style="font-size:8px;color:' + statusCol + '">' + statusLabel
      + ' <span style="color:' + tierCol + '">&middot; ' + tierLabel + '</span></span>';
  }

  // ═══════════════════════════════════════════════════════════════
  // ROLE TIER HELPERS — for new UI slot rows
  // ═══════════════════════════════════════════════════════════════

  function roleTierClasses(ocName, role) {
    const ocsRole = getOCSRole(ocName, role);
    const rc      = getRoleCPRRange(role);
    const isSafe  = ocsRole ? (ocsRole.safe || ocsRole.tier === 'FREE') : rc.safe;
    const isCrit  = ocsRole ? (ocsRole.crit || ocsRole.tier === 'CRITICAL') : false;
    const safety  = ocsRole?.safety || '';

    if (isSafe) {
      return { stripe: 'ss-f', tier: 'st-f', label: 'Free' };
    } else if (/^💀/.test(safety) || isCrit) {
      return { stripe: 'ss-c', tier: 'st-c', label: 'Critical' };
    } else {
      return { stripe: 'ss-i', tier: 'st-i', label: 'Important' };
    }
  }

  function cprClass(cpr) {
    if (!cpr || cpr <= 0) return 'c-na';
    if (cpr >= 80) return 'c-hi';
    if (cpr >= 65) return 'c-ok';
    if (cpr >= 50) return 'c-lo';
    return 'c-lo';
  }

  function pctClass(pct) {
    if (!pct || pct <= 0) return 'pn';
    if (pct >= 80) return 'pg';
    if (pct >= 70) return 'pw';
    return 'pb';
  }

  function levelClass(l) {
    if (!l) return 'l1';
    if (l >= 9) return 'l9';
    if (l >= 7) return 'l7';
    if (l >= 5) return 'l5';
    if (l >= 3) return 'l3';
    return 'l1';
  }

  // ═══════════════════════════════════════════════════════════════
  // RENDER — NEW ADVISOR UI (3-column)
  // ═══════════════════════════════════════════════════════════════

  function renderAdvisor() {
    const view = document.getElementById('view-advisor');
    if (!view) return;

    // Render all three columns
    renderOCList();

    // Select first OC if none selected
    if (!_selectedOC) {
      const firstOC = getAdvisorOCList()[0];
      if (firstOC) _selectedOC = firstOC.ocId;
    }

    if (_selectedOC) renderDetailCol(_selectedOC);
    renderQueue();

    // Assignment banner (floating at bottom of advisor view)
    let bannerEl = document.getElementById('hive-advisor-banner');
    if (_assignment) {
      if (!bannerEl) {
        bannerEl = document.createElement('div');
        bannerEl.id = 'hive-advisor-banner';
        bannerEl.className = 'hive-advisor-banner';
        view.appendChild(bannerEl);
      }
      const lc = levelColor(_assignment.ocLevel || 1);
      bannerEl.innerHTML = `
        <div class="hive-advisor-banner-inner">
          <span class="hive-banner-dot" style="background:var(--amber)"></span>
          <span class="hive-advisor-banner-text">
            📌 <strong>${_assignment.role}</strong> in ${_assignment.ocName}
            <span style="color:${lc}">L${_assignment.ocLevel || '?'}</span>
            · from ${_assignment.assignedBy}
          </span>
          <button class="hive-banner-jump" id="hive-jump-assign">Jump ↗</button>
          <button class="hive-banner-dismiss" id="hive-dismiss-assign">✕</button>
        </div>`;
      document.getElementById('hive-jump-assign')?.addEventListener('click', () => {
        document.querySelectorAll(SEL.crimeCard).forEach(card => {
          if (textOnly(card.querySelector(SEL.crimeTitle))?.toLowerCase() !== _assignment.ocName?.toLowerCase()) return;
          card.querySelectorAll(SEL.slotWrap).forEach(slot => {
            if (normRole(textOnly(slot.querySelector(SEL.slotTitle))) === _assignment.role) scrollToEl(slot);
          });
        });
      });
      document.getElementById('hive-dismiss-assign')?.addEventListener('click', clearAssignment);
    } else {
      bannerEl?.remove();
    }
  }

  function getAdvisorOCList() {
    const list = [];

    // From optimizer results — use ocId if server returned it, else fall back to ocName
    if (_optimResult?.optimizedOCs?.length) {
      _optimResult.optimizedOCs.forEach(oc => {
        list.push({
          ocId:   oc.ocId || oc.ocName,
          ocName: oc.ocName,
          level: oc.level,
          pct: oc.projectedSuccess,
          status: oc.status,
          isPlanning: false,
          team: oc.team || [],
          unfilledRoles: oc.unfilledRoles || [],
        });
      });
    }

    // Planning OCs from scan — only add if ocName not already in optimizer results
    if (_scanResult?.ocs) {
      const optimizerOCNames = new Set(_optimResult?.optimizedOCs?.map(o => o.ocName) || []);
      _scanResult.ocs.filter(oc => oc.isPlanning && !optimizerOCNames.has(oc.ocName)).forEach(oc => {
        const ocId = oc.ocId || oc.ocName;
        if (!list.find(o => o.ocId === ocId)) {
          list.push({
            ocId,
            ocName: oc.ocName,
            level: oc.domLevel,
            pct: null,
            status: 'planning',
            isPlanning: true,
            team: oc.existingPlacements.map(p => ({ member: p.member, role: p.role, cpr: p.cpr })),
            unfilledRoles: [],
          });
        }
      });
    }

    return list;
  }

  function renderOCList() {
    const col = document.getElementById('hive-oc-col');
    if (!col) return;

    const ocList = getAdvisorOCList();
    const optimal  = ocList.filter(o => !o.isPlanning && o.status !== 'unfillable');
    const planning = ocList.filter(o => o.isPlanning);
    const unfill   = ocList.filter(o => !o.isPlanning && o.status === 'unfillable');

    const scroll = col.querySelector('.oc-scroll');
    if (!scroll) return;
    scroll.innerHTML = '';

    // Update count
    const countEl = col.querySelector('.col-hdr-count');
    if (countEl) countEl.textContent = optimal.length + ' active';

    const makeOCI = (oc) => {
      const lc   = levelClass(oc.level);
      const pc   = pctClass(oc.pct);
      const pct  = oc.pct != null ? oc.pct + '%' : '—';
      const sel  = _selectedOC === oc.ocId ? ' sel' : '';

      // Build pip dots from team slots
      let pips = '';
      if (oc.team) {
        oc.team.forEach(t => {
          const { stripe } = roleTierClasses(oc.ocName, t.role);
          const pipCls = stripe === 'ss-c' ? 'p-c' : stripe === 'ss-i' ? 'p-i' : 'p-f';
          // Check if this member has a pending assignment
          const isPending = _assignments && Object.values(_assignments).some(
            a => a.tornName === t.member && a.ocName === oc.ocName
          );
          pips += `<div class="pip ${isPending ? 'p-p' : pipCls}"></div>`;
        });
        oc.unfilledRoles.forEach(() => { pips += '<div class="pip p-e"></div>'; });
      }

      // Status sub-text
      let subText = '', subCol = 'rgba(125,211,252,.28)';
      const pendingCount = _assignments ? Object.values(_assignments).filter(a => a.ocName === oc.ocName).length : 0;
      if (oc.isPlanning) {
        subText = 'Planning'; subCol = 'rgba(125,211,252,.35)';
      } else if (oc.status === 'unfillable') {
        subText = 'Unfillable'; subCol = 'var(--red)';
      } else if (pendingCount > 0) {
        subText = pendingCount + ' pending'; subCol = 'var(--amber)';
      } else if (oc.team && oc.unfilledRoles.length === 0 && oc.team.length > 0) {
        subText = '✓ confirmed'; subCol = 'var(--green)';
      } else if (oc.unfilledRoles && oc.unfilledRoles.length > 0) {
        subText = oc.unfilledRoles.length + ' open'; subCol = 'var(--amber)';
      }

      const div = document.createElement('div');
      div.className = `oci${sel}`;
      div.dataset.ocid = oc.ocId;
      div.dataset.oc = oc.ocName;
      div.innerHTML = `
        <div class="oci-lvl ${lc}">${oc.level ? 'L' + oc.level : '?'}</div>
        <div class="oci-body">
          <div class="oci-name">${oc.ocName}</div>
          <div class="oci-pips">${pips}</div>
        </div>
        <div class="oci-right">
          <div class="oci-pct ${pc}">${pct}</div>
          <div class="oci-sub" style="color:${subCol}">${subText}</div>
        </div>`;
      div.addEventListener('click', () => selectOC(oc.ocId));
      return div;
    };

    if (optimal.length > 0) {
      const lbl = document.createElement('div');
      lbl.className = 'oc-sect-lbl';
      lbl.textContent = `Optimal Teams · ${optimal.length}`;
      scroll.appendChild(lbl);
      optimal.forEach(oc => scroll.appendChild(makeOCI(oc)));
    }

    if (planning.length > 0) {
      const lbl = document.createElement('div');
      lbl.className = 'oc-sect-lbl';
      lbl.style.marginTop = '6px';
      lbl.textContent = `Planning · ${planning.length}`;
      scroll.appendChild(lbl);
      planning.forEach(oc => scroll.appendChild(makeOCI(oc)));
    }

    if (unfill.length > 0) {
      const lbl = document.createElement('div');
      lbl.className = 'oc-sect-lbl';
      lbl.style.marginTop = '6px';
      lbl.textContent = `Unfillable · ${unfill.length}`;
      scroll.appendChild(lbl);
      unfill.forEach(oc => scroll.appendChild(makeOCI(oc)));
    }

    if (ocList.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:20px 12px;text-align:center;font-size:11px;color:rgba(125,211,252,.2)';
      empty.textContent = _optimResult ? 'No OCs found.' : 'Scanning OCs…';
      scroll.appendChild(empty);
    }
  }

  function selectOC(ocId) {
    _selectedOC = ocId;
    // Update selection highlight
    document.querySelectorAll('#hive-oc-col .oci').forEach(el => {
      el.classList.toggle('sel', el.dataset.ocid === ocId);
    });
    renderDetailCol(ocId);
  }

  function renderDetailCol(ocId) {
    const col = document.getElementById('hive-det-col');
    if (!col) return;

    const ocList = getAdvisorOCList();
    const oc = ocList.find(o => o.ocId === ocId);
    const ocName = oc?.ocName;

    const hdr = col.querySelector('.det-hdr');
    const slots = col.querySelector('.slots-area');
    if (!hdr || !slots) return;

    if (!oc) {
      hdr.innerHTML = '<div class="det-name" style="color:rgba(125,211,252,.3)">Select an OC</div>';
      slots.innerHTML = '<div style="padding:20px;font-size:11px;color:rgba(125,211,252,.2)">Select an OC from the list to see details.</div>';
      return;
    }

    const lc   = levelColor(oc.level || 1);
    const lcls = levelClass(oc.level);
    const pc   = pctClass(oc.pct);
    const pct  = oc.pct != null ? oc.pct + '%' : '—';
    const barW = oc.pct != null ? oc.pct : 0;
    const barCls = barW >= 80 ? 'dbg' : barW >= 70 ? 'dbw' : 'dbb';
    const isPlanning = oc.isPlanning;
    const statusBadge = isPlanning
      ? '<span class="det-badge db-plan">Planning</span>'
      : '<span class="det-badge db-rec">Recruiting</span>';

    const scanIdxForCount = parseInt((oc.ocId || '').split('||')[1] ?? '0');
    const scanOCsForName  = _scanResult?.ocs?.filter(o => o.ocName === ocName) || [];
    const scanOCForCount  = scanOCsForName[scanIdxForCount] || scanOCsForName[0];
    const scanFilledRoles = new Set((scanOCForCount?.existingPlacements || []).map(p => p.role));
    const teamRoles = new Set((oc.team || []).map(t => t.role));
    const extraFilled = [...scanFilledRoles].filter(r => !teamRoles.has(r)).length;
    const filled  = (oc.team || []).length + extraFilled;
    const unfilled = (oc.unfilledRoles || []).length;
    const total   = filled + unfilled;

    hdr.innerHTML = `
      <div class="det-name">${oc.ocName}</div>
      <div class="det-row2">
        <span class="det-badge ${lcls === 'l5' ? 'db-lv5' : lcls === 'l9' ? 'db-lv9' : 'db-lv5'}" style="color:${lc}">${oc.level ? 'L' + oc.level : '?'}</span>
        ${statusBadge}
        <span style="font-size:10px;color:rgba(125,211,252,.35)">${filled} of ${total} roles filled</span>
      </div>
      <div class="det-success">
        <div>
          <div class="det-pct ${pc}">${pct}</div>
          <div style="font-size:9px;color:rgba(125,211,252,.28);margin-top:3px;letter-spacing:.07em;text-transform:uppercase">Success chance</div>
        </div>
        <div class="det-bar-area">
          <div class="det-bar"><div class="det-bar-fill ${barCls}" style="width:${barW}%"></div></div>
          <div class="det-bar-lbl">${barW >= 80 ? 'Above scope threshold — looking good' : barW >= 75 ? 'Just above scope threshold' : barW > 0 ? 'Below scope threshold — at risk' : 'Cannot calculate — team incomplete'}</div>
        </div>
      </div>`;

    // Build slot rows
    let slotsHtml = `
      <div style="display:grid;grid-template-columns:3px 90px 1fr 46px 12px 28px;gap:0 10px;padding:0 8px 8px;font-family:'Rajdhani',sans-serif;font-size:9px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:rgba(125,211,252,.28);border-bottom:1px solid rgba(125,211,252,.06);margin-bottom:6px;">
        <div></div><div>Role</div><div>Member</div><div style="text-align:right">CPR</div><div></div><div></div>
      </div>`;

    // Filled slots from team
    (oc.team || []).forEach(t => {
      const { stripe, tier, label } = roleTierClasses(oc.ocName, t.role);
      const cc = cprClass(t.cpr);
      const isPending = _assignments && Object.values(_assignments).some(
        a => a.tornName === t.member && a.ocName === oc.ocName
      );
      const dotCls = isPending ? 'sd-pe' : 'sd-ok';
      const nameCls = isPending ? 'pend' : '';

      // Build swap dropdown options
      let swapHtml = '';
      if (_isLeader) {
        const base = t.role.replace(/\s+\d+$/, '').trim();
        const rosterNames = _factionRoster.length > 0
          ? _factionRoster.map(m => m.name)
          : Object.keys(_allMemberCPR);
        const alts = rosterNames
          .filter(name => name && name !== t.member && !/^\d/.test(name))
          .map(name => {
            const data = _allMemberCPR[name];
            // Try exact role, then base role, then search all OC entries for this OC name
            let cpr = data?.cprs?.[oc.ocName]?.[t.role]
                   ?? data?.cprs?.[oc.ocName]?.[base]
                   ?? null;
            // Fallback: search all stored OC keys for a case-insensitive match
            if (cpr == null && data?.cprs) {
              const ocKey = Object.keys(data.cprs).find(k =>
                k.toLowerCase() === oc.ocName.toLowerCase()
              );
              if (ocKey) {
                cpr = data.cprs[ocKey][t.role] ?? data.cprs[ocKey][base] ?? null;
              }
            }
            return { name, cpr };
          })
          .sort((a,b) => (b.cpr||0) - (a.cpr||0)).slice(0, 12);

        if (alts.length) {
          const dropId = 'hive-sw-' + (oc.ocId || oc.ocName).replace(/[^a-zA-Z0-9]/g,'_') + '-' + t.role.replace(/\W/g,'_');
          let opts = `<div class="sp-head"><span class="sp-head-lbl">Swap Member</span><span class="sp-head-role">${t.role} · ${label}</span></div><div class="sp-opts">`;
          // Current assignment first
          opts += `<div class="sp-opt curr"><div class="sp-av">${memberAvatar(t.member)}</div><div class="sp-info"><div class="sp-name">${t.member}</div><div class="sp-from">Currently assigned</div></div><div class="sp-cpr ${cc}">${t.cpr != null ? t.cpr + '%' : '?%'}</div><div class="sp-curr-tag">now</div></div>`;
          alts.forEach(a => {
            const ac = cprClass(a.cpr);
            opts += `<div class="sp-opt" data-member="${a.name}" data-role="${t.role}" data-oc="${oc.ocName}" data-level="${oc.level || ''}">`
              + `<div class="sp-av">${memberAvatar(a.name)}</div>`
              + `<div class="sp-info"><div class="sp-name">${a.name}</div><div class="sp-from">Available</div></div>`
              + `<div class="sp-cpr ${ac}">${a.cpr != null ? a.cpr + '%' : '?%'}</div></div>`;
          });
          opts += `</div><div class="sp-foot"><button class="sp-remove" data-member="${t.member}" data-role="${t.role}" data-oc="${oc.ocName}">Remove from Slot</button></div>`;
          swapHtml = `<div class="swap-pop" id="${dropId}" style="display:none">${opts}</div>`;
        }
      }

      const tipAttr = ' data-tip="' + buildRoleTooltip(oc.ocName, t.role, t.cpr || 0).replace(/"/g,'&quot;') + '"';
      slotsHtml += `
        <div class="slot-r hive-tip"${tipAttr} style="position:relative">
          <div class="sl-stripe ${stripe}"></div>
          <div class="sl-role"><div class="sl-role-name">${t.role}</div><span class="sl-tier ${tier}">${label}</span></div>
          <div class="sl-name ${nameCls}">${t.member}</div>
          <div class="sl-cpr ${cc}">${t.cpr != null ? t.cpr + '%' : '?%'}</div>
          <div class="sl-dot ${dotCls}"></div>
          <div class="sl-swap hive-swap-btn" data-dropid="${swapHtml ? 'hive-sw-' + (oc.ocId || oc.ocName).replace(/[^a-zA-Z0-9]/g,'_') + '-' + t.role.replace(/\W/g,'_') : ''}">⇄</div>
          ${swapHtml}
        </div>`;
    });

    // Unfilled roles
    (oc.unfilledRoles || []).forEach(r => {
      const { stripe, tier, label } = roleTierClasses(oc.ocName, r.role);
      const tipAttr = ' data-tip="' + buildRoleTooltip(oc.ocName, r.role, 0).replace(/"/g,'&quot;') + '"';

      // Assign dropdown for leader
      let assignHtml = '';
      if (_isLeader) {
        const base = r.role.replace(/\s+\d+$/, '').trim();
        const rosterNamesOpen = _factionRoster.length > 0
          ? _factionRoster.map(m => m.name)
          : Object.keys(_allMemberCPR);
        const alts = rosterNamesOpen
          .filter(name => name && !/^\d/.test(name))
          .map(name => {
            const data = _allMemberCPR[name];
            let cpr = data?.cprs?.[oc.ocName]?.[r.role]
                   ?? data?.cprs?.[oc.ocName]?.[base]
                   ?? null;
            if (cpr == null && data?.cprs) {
              const ocKey = Object.keys(data.cprs).find(k =>
                k.toLowerCase() === oc.ocName.toLowerCase()
              );
              if (ocKey) cpr = data.cprs[ocKey][r.role] ?? data.cprs[ocKey][base] ?? null;
            }
            return { name, cpr };
          }).sort((a,b) => (b.cpr||0) - (a.cpr||0)).slice(0, 12);

        if (alts.length) {
          const dropId = 'hive-sw-open-' + (oc.ocId || oc.ocName).replace(/[^a-zA-Z0-9]/g,'_') + '-' + r.role.replace(/\W/g,'_');
          let opts = `<div class="sp-head"><span class="sp-head-lbl">Assign Member</span><span class="sp-head-role">${r.role} · ${label}</span></div><div class="sp-opts">`;
          alts.forEach(a => {
            const ac = cprClass(a.cpr);
            opts += `<div class="sp-opt" data-member="${a.name}" data-role="${r.role}" data-oc="${oc.ocName}" data-level="${oc.level || ''}">`
              + `<div class="sp-av">${memberAvatar(a.name)}</div>`
              + `<div class="sp-info"><div class="sp-name">${a.name}</div><div class="sp-from">Available</div></div>`
              + `<div class="sp-cpr ${ac}">${a.cpr != null ? a.cpr + '%' : '?%'}</div></div>`;
          });
          opts += '</div>';
          assignHtml = `<div class="swap-pop" id="${dropId}" style="display:none">${opts}</div>`;
        }
      }

      slotsHtml += `
        <div class="slot-r hive-tip"${tipAttr} style="position:relative;opacity:.65">
          <div class="sl-stripe ${stripe}"></div>
          <div class="sl-role"><div class="sl-role-name">${r.role}</div><span class="sl-tier ${tier}">${label}</span></div>
          <div class="sl-name empty">${r.urgent ? '⚠ Critical gap' : '○ Open slot'}</div>
          <div class="sl-cpr c-na">—</div>
          <div class="sl-dot sd-no"></div>
          <div class="sl-swap hive-swap-btn" data-dropid="${assignHtml ? 'hive-sw-open-' + (oc.ocId || oc.ocName).replace(/[^a-zA-Z0-9]/g,'_') + '-' + r.role.replace(/\W/g,'_') : ''}">+</div>
          ${assignHtml}
        </div>`;
    });

    // Merge in filled slots from Torn page scan that the optimizer didn't include.
    // Use ocId index to match the right instance of duplicate OCs.
    const scanIdx = parseInt((oc.ocId || '').split('||')[1] ?? '0');
    const scanOCsWithName = _scanResult?.ocs?.filter(o => o.ocName === ocName) || [];
    const scanOC = scanOCsWithName[scanIdx] || scanOCsWithName[0];
    if (scanOC) {
      const shownRoles = new Set((oc.team || []).map(t => t.role));
      (scanOC.existingPlacements || []).forEach(p => {
        if (shownRoles.has(p.role)) return;
        const { stripe, tier, label } = roleTierClasses(ocName, p.role);
        const cc = cprClass(p.cpr);
        const tipAttr = ' data-tip="' + buildRoleTooltip(ocName, p.role, p.cpr || 0).replace(/"/g,'&quot;') + '"';
        slotsHtml += `
          <div class="slot-r hive-tip"${tipAttr} style="position:relative">
            <div class="sl-stripe ${stripe}"></div>
            <div class="sl-role"><div class="sl-role-name">${p.role}</div><span class="sl-tier ${tier}">${label}</span></div>
            <div class="sl-name">${p.member}</div>
            <div class="sl-cpr ${cc}">${p.cpr != null ? p.cpr + '%' : '?%'}</div>
            <div class="sl-dot sd-ok"></div>
            <div class="sl-swap" style="opacity:0">—</div>
          </div>`;
      });
    }

    slots.innerHTML = slotsHtml;

    // Wire swap buttons
    slots.querySelectorAll('.hive-swap-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const dropId = btn.dataset.dropid;
        if (!dropId) return;
        const drop = document.getElementById(dropId);
        if (!drop) return;
        // Close other open drops
        document.querySelectorAll('.swap-pop').forEach(d => { if (d !== drop) d.style.display = 'none'; });
        drop.style.display = drop.style.display === 'none' ? 'block' : 'none';
      });
    });

    // Wire swap/assign options
    slots.querySelectorAll('.sp-opt[data-member]').forEach(opt => {
      opt.addEventListener('click', () => {
        const { member, role, oc: ocName, level } = opt.dataset;
        sendAssignment(member, role, ocName, parseInt(level) || null);
        opt.closest('.swap-pop').style.display = 'none';
        opt.style.opacity = '0.5';
        // Re-render after short delay
        setTimeout(() => {
          if (_panelOpen && _activeTab === 'advisor') {
            renderOCList();
            renderDetailCol(_selectedOC);
          }
        }, 500);
      });
    });

    // Wire remove buttons
    slots.querySelectorAll('.sp-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const { member } = btn.dataset;
        deleteAssignment(member);
        btn.closest('.swap-pop').style.display = 'none';
        setTimeout(() => {
          if (_panelOpen && _activeTab === 'advisor') {
            renderOCList();
            renderDetailCol(_selectedOC);
          }
        }, 500);
      });
    });

    // Close swap pops on outside click
    document.addEventListener('click', e => {
      if (!e.target.closest('.swap-pop') && !e.target.closest('.hive-swap-btn')) {
        document.querySelectorAll('.swap-pop').forEach(d => { d.style.display = 'none'; });
      }
    }, { once: false });
  }

  function renderQueue() {
    const col = document.getElementById('hive-queue-col');
    if (!col) return;
    const scroll = col.querySelector('.q-scroll');
    if (!scroll) return;
    scroll.innerHTML = '';

    if (_isLeader) {
      // Show unassigned members sorted by best CPR
      const assignedMembers = new Set();
      if (_optimResult?.optimizedOCs) {
        _optimResult.optimizedOCs.forEach(oc => {
          (oc.team || []).forEach(t => assignedMembers.add(t.member));
        });
      }
      // Also treat members already sitting in a slot on the Torn page as assigned
      if (_scanResult?.ocs) {
        _scanResult.ocs.forEach(oc => {
          (oc.existingPlacements || []).forEach(p => assignedMembers.add(p.member));
        });
      }

      const allNames = new Set();
      _factionRoster.forEach(m => allNames.add(m.name));
      _factionMembers.forEach(m => allNames.add(m.name));
      Object.keys(_allMemberCPR).forEach(n => { if (!/^\d+$/.test(n)) allNames.add(n); });

      const unassigned = [...allNames]
        .filter(name => !assignedMembers.has(name))
        .map(name => {
          const data = _allMemberCPR[name];
          // Get best CPR — skip free/safe roles using both OCS_ROLES and ROLE_CPR_RANGES
          let bestCPR = null, bestOC = null, bestRole = null;
          if (data?.cprs) {
            // Only recommend OCs that are currently active in the scan
            const activeOCNames = new Set((_scanResult?.ocs || []).map(o => o.ocName));

            Object.entries(data.cprs).forEach(([ocN, roles]) => {
              // Skip OCs not currently spawned — recommendation must be actionable
              if (activeOCNames.size > 0 && !activeOCNames.has(ocN)) return;
              Object.entries(roles).forEach(([role, cpr]) => {
                const rc      = getRoleCPRRange(role);
                const ocsRole = getOCSRole(ocN, role);
                const isFree  = ocsRole?.tier === 'FREE' || rc.safe;
                if (isFree) return;
                if (bestCPR === null || cpr > bestCPR) {
                  bestCPR = cpr; bestOC = ocN; bestRole = role;
                }
              });
            });
            // Fallback: if no active OC match, show best available even if not spawned
            if (bestCPR === null) {
              Object.entries(data.cprs).forEach(([ocN, roles]) => {
                Object.entries(roles).forEach(([role, cpr]) => {
                  const ocsRole = getOCSRole(ocN, role);
                  const isFree  = ocsRole?.tier === 'FREE' || getRoleCPRRange(role).safe;
                  if (isFree) return;
                  if (bestCPR === null || cpr > bestCPR) {
                    bestCPR = cpr; bestOC = ocN; bestRole = role;
                  }
                });
              });
            }
          }
          return { name, bestCPR, bestOC, bestRole, hasData: !!data };
        })
        .sort((a,b) => (b.bestCPR || -1) - (a.bestCPR || -1));

      const withData    = unassigned.filter(m => m.hasData);
      const withoutData = unassigned.filter(m => !m.hasData);

      if (withData.length > 0) {
        const lbl = document.createElement('div'); lbl.className = 'q-sect'; lbl.textContent = 'Best available';
        scroll.appendChild(lbl);
        withData.forEach(m => {
          const cc = cprClass(m.bestCPR);
          const item = document.createElement('div');
          item.className = 'q-item';
          item.innerHTML = `
            <div class="q-av">${memberAvatar(m.name)}</div>
            <div class="q-info">
              <div class="q-name">${m.name}</div>
              <div class="q-role">${m.bestOC ? m.bestOC + ' · ' + m.bestRole : 'Available'}</div>
            </div>
            <div class="q-cpr ${cc}">${m.bestCPR != null ? m.bestCPR + '%' : '—'}</div>`;
          scroll.appendChild(item);
        });
      }

      if (withoutData.length > 0) {
        const lbl = document.createElement('div'); lbl.className = 'q-sect'; lbl.textContent = 'No CPR data';
        scroll.appendChild(lbl);
        withoutData.forEach(m => {
          const item = document.createElement('div');
          item.className = 'q-item';
          item.style.opacity = '0.5';
          item.innerHTML = `
            <div class="q-av" style="color:var(--red)">${memberAvatar(m.name)}</div>
            <div class="q-info">
              <div class="q-name">${m.name}</div>
              <div class="q-role" style="color:var(--red)">TornStats not sharing</div>
            </div>
            <div class="q-cpr c-na">—</div>`;
          scroll.appendChild(item);
        });
      }

      if (unassigned.length === 0) {
        scroll.innerHTML = '<div style="padding:12px 8px;font-size:11px;color:rgba(125,211,252,.2)">All members assigned.</div>';
      }

      // Update count
      const countEl = col.querySelector('.col-hdr-count');
      if (countEl) countEl.textContent = unassigned.length + ' free';

    } else {
      // Member view — show personal CPR data
      if (_myName && _allMemberCPR[_myName]) {
        const data = _allMemberCPR[_myName];
        // Best slot
        let bestCPR = null, bestOC = null, bestRole = null;
        const allRoles = [];
        if (data?.cprs) {
          Object.entries(data.cprs).forEach(([ocN, roles]) => {
            Object.entries(roles).forEach(([role, cpr]) => {
              allRoles.push({ ocN, role, cpr });
              if (bestCPR === null || cpr > bestCPR) { bestCPR = cpr; bestOC = ocN; bestRole = role; }
            });
          });
        }

        if (bestOC) {
          const lbl = document.createElement('div'); lbl.className = 'q-sect'; lbl.textContent = 'Your best slot';
          scroll.appendChild(lbl);
          const lcls = levelClass(null);
          const bw = document.createElement('div');
          bw.style.cssText = 'margin:6px 6px 8px;background:rgba(3,12,26,.6);border:1px solid rgba(125,211,252,.1);border-radius:10px;padding:11px 11px;';
          bw.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;">
              <div style="flex:1;min-width:0">
                <div style="font-size:12.5px;font-weight:600;color:#e8f4ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${bestOC}</div>
                <div style="font-size:10px;color:rgba(125,211,252,.4);margin-top:2px">${bestRole}</div>
              </div>
              <div style="text-align:right;flex-shrink:0">
                <div style="font-family:'Rajdhani',sans-serif;font-size:18px;font-weight:700;color:var(--amber);line-height:1">${bestCPR}%</div>
                <div style="font-size:8px;color:rgba(125,211,252,.28);text-transform:uppercase;letter-spacing:.1em">your CPR</div>
              </div>
            </div>`;
          scroll.appendChild(bw);
        }

        if (allRoles.length > 0) {
          const lbl = document.createElement('div'); lbl.className = 'q-sect'; lbl.textContent = 'Your CPR by OC';
          scroll.appendChild(lbl);
          allRoles.sort((a,b) => b.cpr - a.cpr).forEach(r => {
            const cc = cprClass(r.cpr);
            const item = document.createElement('div');
            item.className = 'q-item';
            item.innerHTML = `
              <div class="q-av" style="font-size:12px;color:var(--amber)">${r.cpr}%</div>
              <div class="q-info">
                <div class="q-name">${r.ocN}</div>
                <div class="q-role">${r.role}</div>
              </div>`;
            scroll.appendChild(item);
          });
        }
      } else {
        scroll.innerHTML = '<div style="padding:12px 8px;font-size:11px;color:rgba(125,211,252,.2)">No CPR data. Sync TornStats first.</div>';
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // RENDER — ROSTER (replaces old renderAssign)
  // ═══════════════════════════════════════════════════════════════

  function renderRoster() {
    const body = document.getElementById('view-roster-body');
    if (!body) return;

    // ── Show loading state immediately ──────────────────────────
    body.innerHTML = '<div style="padding:32px;text-align:center;font-size:11px;color:rgba(125,211,252,.25)">Loading roster…</div>';

    // ── Fetch from server — all ceiling logic is server-side ────
    serverRequest({
      method: 'GET',
      path: `/api/roster?key=${encodeURIComponent(_ocaKey)}&faction_id=${_factionId}`,
      onSuccess(data) {
        _buildRosterHTML(body, data.members || []);
      },
      onError(err) {
        body.innerHTML = `<div style="padding:24px;text-align:center;font-size:11px;color:var(--red)">Failed to load roster: ${err}</div>`;
      },
    });
  }

  function _buildRosterHTML(body, members) {
    const pending = Object.values(_assignments || {});
    let html = '';

    // ── Pending assignments banner ───────────────────────────────
    if (pending.length > 0) {
      html += `<div style="margin-bottom:16px"><div class="hive-sub-sect-title" style="margin-bottom:10px">📌 Pending Assignments (${pending.length})</div>`;
      pending.forEach(a => {
        const lc = levelColor(a.ocLevel || 1);
        html += `<div class="hive-assign-row">
          <div class="hive-assign-info">
            <div class="hive-assign-name">${a.tornName}</div>
            <div class="hive-assign-detail">${a.role} · ${a.ocName} <span style="color:${lc}">L${a.ocLevel||'?'}</span></div>
          </div>
          <div class="hive-assign-actions">
            <a href="https://www.torn.com/messages.php#/compose/to=${encodeURIComponent(a.tornName)}" target="_blank" class="hive-msg-btn" title="Message member">✉</a>
            <button class="hive-clear-btn" data-name="${a.tornName}">✕</button>
          </div>
        </div>`;
      });
      html += '</div>';
    }

    // ── Toolbar ──────────────────────────────────────────────────
    html += `<div class="r-toolbar">
      <input class="r-search" placeholder="Search members..." type="text" id="hive-roster-search">
      <select class="r-sort" id="hive-roster-sort">
        <option value="ceil">Ceiling ↓</option>
        <option value="name">Name ↑</option>
      </select>
    </div>
    <table class="r-tbl">
      <colgroup>
        <col style="width:36px">
        <col>
        <col style="width:70px">
        <col style="width:90px">
      </colgroup>
      <thead><tr>
        <th></th>
        <th>Member</th>
        <th>Ceiling</th>
        <th style="padding-left:16px">Status</th>
      </tr></thead>
      <tbody id="hive-roster-tbody">`;

    members.forEach(m => {
      const av    = memberAvatar(m.name);
      const avLvl = _memberLevels[m.name];
      const avCls = avLvl ? levelClass(avLvl) : 'l1';

      const inOC = _optimResult?.optimizedOCs?.some(oc => oc.team?.some(t => t.member === m.name))
                || _scanResult?.ocs?.some(oc => oc.existingPlacements?.some(p => p.member === m.name));
      const isPending = pending.some(a => a.tornName === m.name);

      const statusBadge = !m.ceiling
        ? '<span class="sbadge sb-nd">No data</span>'
        : inOC      ? '<span class="sbadge sb-in">In OC</span>'
        : isPending ? '<span class="sbadge sb-pe">Pending</span>'
        :             '<span class="sbadge sb-av">Available</span>';

      let ceilCell;
      if (!m.ceiling) {
        ceilCell = '<span style="font-size:10px;color:rgba(125,211,252,.2)">—</span>';
      } else {
        const lc  = levelColor(m.ceiling.level);
        const lcl = levelClass(m.ceiling.level);
        // Strong/marginal indicator dot
        const dot = m.ceiling.isStrong
          ? `<div style="width:6px;height:6px;border-radius:50%;background:var(--green);margin-top:1px" title="Strong (≥ idealMin)"></div>`
          : `<div style="width:6px;height:6px;border-radius:50%;background:var(--amber);margin-top:1px" title="Marginal (≥ absMin, below idealMin)"></div>`;
        ceilCell = `<div style="display:flex;flex-direction:column;align-items:center;gap:2px">
          <div class="oci-lvl ${lcl}" style="width:28px;height:20px;font-size:9px;border-radius:4px">L${m.ceiling.level}</div>
          <div style="display:flex;align-items:center;gap:3px">
            <div style="font-size:10px;font-weight:700;color:${lc}">${m.ceiling.cpr}%</div>
            ${dot}
          </div>
        </div>`;
      }

      html += `<tr class="r-row" data-name="${m.name.toLowerCase()}" data-ceil="${m.ceiling?.level||0}">
        <td><div class="r-av ${avCls}">${av}</div></td>
        <td><div class="r-nm">${m.name}</div></td>
        <td style="text-align:center">${ceilCell}</td>
        <td>${statusBadge}</td>
      </tr>`;
    });

    html += `</tbody></table>
    <button class="sync-btn" id="hive-sync-ts-roster"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M10 5.5A4 4 0 1 1 6 2M6 2l2 2M6 2l-2 2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg> Sync TornStats</button>`;

    body.innerHTML = html;

    // ── Event listeners ──────────────────────────────────────────
    body.querySelectorAll('.hive-clear-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        deleteAssignment(btn.dataset.name);
        btn.textContent = '✓'; btn.disabled = true;
        setTimeout(renderRoster, 800);
      });
    });
    body.querySelector('#hive-sync-ts-roster')?.addEventListener('click', () => {
      loadTornStats(); showToast('Syncing TornStats…');
      setTimeout(renderRoster, 4000);
    });

    const applyFilter = () => {
      const q     = (body.querySelector('#hive-roster-search')?.value || '').toLowerCase();
      const sort  = body.querySelector('#hive-roster-sort')?.value || 'ceil';
      const tbody = body.querySelector('#hive-roster-tbody');
      const rows  = [...tbody.querySelectorAll('.r-row')];
      rows.forEach(r => { r.style.display = r.dataset.name.includes(q) ? '' : 'none'; });
      rows.filter(r => r.style.display !== 'none')
          .sort((a,b) => sort === 'name'
            ? a.dataset.name.localeCompare(b.dataset.name)
            : parseInt(b.dataset.ceil||0) - parseInt(a.dataset.ceil||0))
          .forEach(r => tbody.appendChild(r));
    };
    body.querySelector('#hive-roster-search')?.addEventListener('input', applyFilter);
    body.querySelector('#hive-roster-sort')?.addEventListener('change', applyFilter);
  }


  // ═══════════════════════════════════════════════════════════════
  // RENDER — COVERAGE
  // ═══════════════════════════════════════════════════════════════

  function renderCoverage() {
    const body = document.getElementById('view-coverage-body');
    if (!body) return;

    // ── Show loading state immediately ──────────────────────────
    body.innerHTML = '<div style="padding:32px;text-align:center;font-size:11px;color:rgba(125,211,252,.25)">Loading coverage…</div>';

    // ── Fetch from server — all logic is server-side ────────────
    serverRequest({
      method: 'GET',
      path: `/api/coverage?key=${encodeURIComponent(_ocaKey)}&faction_id=${_factionId}`,
      onSuccess(data) {
        _buildCoverageHTML(body, data.levels || {}, data.maxLevel || 0);
      },
      onError(err) {
        body.innerHTML = `<div style="padding:24px;text-align:center;font-size:11px;color:var(--red)">Failed to load coverage: ${err}</div>`;
      },
    });
  }

  function _buildCoverageHTML(body, levels, maxLevel) {
    if (maxLevel === 0) {
      body.innerHTML = '<div style="padding:24px;text-align:center;font-size:12px;color:rgba(125,211,252,.2)">No CPR data loaded. Sync TornStats first.</div>';
      return;
    }

    // Level label lookup
    const LEVEL_NAMES = {
      1:'L1 — Basic', 2:'L2 — Standard', 3:'L3 — Skilled',
      4:'L4 — Advanced', 5:'L5 — Expert', 6:'L6 — Elite',
      7:'L7 — Master', 8:'L8 — Veteran', 9:'L9 — Legend', 10:'L10 — Apex',
    };

    // Build depth card rows — L1 up to maxLevel
    const TEAM_SIZE = 6; // full team needed
    const depthRows = [];
    const gapRows   = [];

    for (let lvl = maxLevel; lvl >= 1; lvl--) {
      const d = levels[lvl];
      if (!d) continue;
      const total   = d.strong + d.marginal;
      const lcls    = levelClass(lvl);
      const lc      = levelColor(lvl);
      const needed  = Math.max(0, TEAM_SIZE - d.strong);

      // Color code: red <4 total, amber 4-6, green 7+
      const totalCol = total < 4 ? 'var(--red)' : total < 7 ? 'var(--amber)' : 'var(--green)';
      const barPct   = Math.min(100, Math.round((total / 12) * 100));
      const barCol   = total < 4 ? 'var(--red)' : total < 7 ? 'var(--amber)' : 'var(--green)';

      depthRows.push(`<div class="cov-item">
        <div class="oci-lvl ${lcls}" style="width:26px;height:26px;font-size:10px">L${lvl}</div>
        <div style="flex:1;min-width:0">
          <div class="cov-oc">${LEVEL_NAMES[lvl] || 'L'+lvl}</div>
          <div class="cov-rl">
            <span style="color:var(--green)">${d.strong} strong</span>
            <span style="color:rgba(125,211,252,.3)"> · </span>
            <span style="color:var(--amber)">${d.marginal} marginal</span>
          </div>
        </div>
        <div class="cov-bar"><div class="cov-bar-f" style="width:${barPct}%;background:${barCol}"></div></div>
        <div class="cov-cnt" style="color:${totalCol}">${total}</div>
      </div>`);

      // Gap card: levels where strong < TEAM_SIZE
      if (d.strong < TEAM_SIZE) {
        gapRows.push(`<div class="cov-item">
          <div class="oci-lvl ${lcls}" style="width:26px;height:26px;font-size:10px">L${lvl}</div>
          <div style="flex:1;min-width:0">
            <div class="cov-oc">${LEVEL_NAMES[lvl] || 'L'+lvl}</div>
            <div class="cov-rl">Need ${needed} more strong member${needed !== 1 ? 's' : ''} for a full team</div>
          </div>
          <div class="cov-cnt" style="color:var(--red)">-${needed}</div>
        </div>`);
      }
    }

    // Depth card
    const depthCard = `<div class="cov-card">
      <div class="cov-hdr" style="color:var(--cyan)">
        Roster Depth
        <span style="font-size:9px;color:rgba(125,211,252,.3)">● strong  ● marginal</span>
      </div>
      ${depthRows.join('')}
    </div>`;

    // Recruiting gaps card
    const gapCard = gapRows.length === 0
      ? `<div class="cov-card"><div class="cov-hdr" style="color:var(--green)">Recruiting Gaps<span>All levels covered ✓</span></div></div>`
      : `<div class="cov-card">
          <div class="cov-hdr" style="color:var(--red)">Recruiting Gaps<span>${gapRows.length} level${gapRows.length !== 1 ? 's' : ''} thin</span></div>
          ${gapRows.join('')}
        </div>`;

    // Legend
    const legend = `<div style="margin-top:10px;display:flex;gap:14px;justify-content:center;font-size:10px;color:rgba(125,211,252,.3)">
      <span><span style="color:var(--green)">●</span> Strong = CPR ≥ idealMin</span>
      <span><span style="color:var(--amber)">●</span> Marginal = CPR ≥ absMin</span>
    </div>`;

    body.innerHTML = `<div class="cov-grid">${depthCard}${gapCard}</div>${legend}`;
  }


  // ═══════════════════════════════════════════════════════════════
  // RENDER — HISTORY
  // ═══════════════════════════════════════════════════════════════

  function renderHistory() {
    const body = document.getElementById('view-history-body');
    if (!body) return;

    // Fetch existing payout data from server to decide what to show
    serverRequest({
      method: 'GET', path: '/api/payout/model',
      onSuccess(d) { _buildHistoryHTML(body, d.model || {}); },
      onError()    { _buildHistoryHTML(body, {}); },
    });
  }

  function _buildHistoryHTML(body, model) {
    const ocNames   = Object.keys(model);
    const hasData   = ocNames.length > 0;

    // Aggregate stats
    let totalOCs = 0, totalEarnings = 0;
    ocNames.forEach(name => {
      const m = model[name];
      totalOCs      += m.samples || 0;
      totalEarnings += (m.meanPayout || 0) * (m.samples || 0);
    });
    const avgEarnings = totalOCs > 0 ? Math.round(totalEarnings / totalOCs) : 0;

    const fmt = (n) => {
      if (!n) return '—';
      if (n >= 1e9) return '$' + (n/1e9).toFixed(2) + 'B';
      if (n >= 1e6) return '$' + (n/1e6).toFixed(1) + 'M';
      if (n >= 1e3) return '$' + (n/1e3).toFixed(0) + 'K';
      return '$' + n;
    };

    // Stat tiles
    const statsHTML = `
      <div class="h-stats">
        <div class="hsc hg">
          <div class="hsc-num" style="color:var(--green)">${hasData ? totalOCs : '—'}</div>
          <div class="hsc-lbl">OCs Recorded</div>
          <div class="hsc-sub">${hasData ? ocNames.length + ' unique scenarios' : 'No data yet'}</div>
        </div>
        <div class="hsc hb">
          <div class="hsc-num" style="color:var(--cyan)">${hasData ? fmt(avgEarnings) : '—'}</div>
          <div class="hsc-lbl">Avg Payout</div>
          <div class="hsc-sub">${hasData ? 'Per completed OC' : 'Import to populate'}</div>
        </div>
        <div class="hsc ha">
          <div class="hsc-num" style="color:var(--amber)">${hasData ? fmt(totalEarnings) : '—'}</div>
          <div class="hsc-lbl">Total Recorded</div>
          <div class="hsc-sub">${hasData ? 'Combined earnings' : 'Awaiting data'}</div>
        </div>
      </div>`;

    // Import/refresh button
    const importBtnHTML = `
      <div class="hist-import-wrap">
        <button class="hist-import-btn" id="hive-hist-import">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 2v8M5 7l3 3 3-3M3 11v1a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          ${hasData ? 'Refresh History' : 'Import OC History'}
        </button>
        <div class="hist-import-sub">
          ${hasData
            ? `Last import: ${ocNames.length} OC types recorded<br>Click to pull any new completed OCs from Torn`
            : 'Pulls all completed OCs from Torn API<br>Uses your faction leader key — one-time backfill'}
        </div>
      </div>`;

    // OC breakdown table (if data exists)
    let tableHTML = '';
    if (hasData) {
      const sorted = ocNames
        .map(name => ({ name, ...model[name] }))
        .sort((a, b) => (b.meanPayout || 0) - (a.meanPayout || 0));

      const rows = sorted.map(oc => `
        <div class="hist-result-row">
          <div class="hist-oc-name">${oc.name}</div>
          <div style="font-family:'DM Mono',monospace;font-size:9px;color:rgba(125,211,252,.25);min-width:40px;text-align:center">${oc.samples}×</div>
          <div class="hist-oc-money">${fmt(oc.meanPayout)}</div>
        </div>`).join('');

      tableHTML = `
        <div class="chart-card">
          <div style="font-family:'Rajdhani',sans-serif;font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:rgba(125,211,252,.28);margin-bottom:12px">
            OC Breakdown — Avg Payout
          </div>
          ${rows}
        </div>`;
    }

    body.innerHTML = statsHTML + importBtnHTML + tableHTML;

    body.querySelector('#hive-hist-import')?.addEventListener('click', () => {
      if (!_isLeader) { showToast('Leader key required for history import'); return; }
      if (!_tornKey)  { showToast('Torn API key required — add in Settings'); return; }
      pushCompletedOCs(body);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // HISTORY — pushCompletedOCs
  // ═══════════════════════════════════════════════════════════════

  function pushCompletedOCs(historyBody) {
    const btn = historyBody?.querySelector('#hive-hist-import');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span style="font-size:12px">Fetching page 1…</span>'; }

    let allCrimes = [];
    let page = 1;

    function fetchPage(offset) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://api.torn.com/v2/faction/crimes?cat=completed&limit=100&offset=${offset}&sort=DESC&key=${_tornKey}&comment=HiveOCA`,
        timeout: 20000,
        onload(r) {
          let data;
          try { data = JSON.parse(r.responseText); } catch(e) {
            finishImport(allCrimes, historyBody, 'Parse error');
            return;
          }
          if (data.error) {
            finishImport(allCrimes, historyBody, data.error.error || 'API error');
            return;
          }

          const crimes = data.crimes || [];
          allCrimes = allCrimes.concat(crimes);

          const nextUrl = data._metadata?.links?.next;
          if (nextUrl && crimes.length === 100) {
            page++;
            if (btn) btn.innerHTML = `<span style="font-size:12px">Fetching page ${page}…</span>`;
            fetchPage(offset + 100);
          } else {
            finishImport(allCrimes, historyBody, null);
          }
        },
        onerror()   { finishImport(allCrimes, historyBody, 'Network error'); },
        ontimeout() { finishImport(allCrimes, historyBody, 'Timeout'); },
      });
    }

    function finishImport(crimes, body, err) {
      if (err) {
        console.warn('[HIVE OC] History import error:', err);
        if (btn) { btn.disabled = false; btn.innerHTML = 'Import OC History'; }
        showToast('Import failed: ' + err);
        return;
      }

      // Build records for /api/payout/record
      const records = crimes.map(crime => {
        const rewards = crime.rewards;
        const slotCPRs = {};
        (crime.slots || []).forEach(slot => {
          if (slot.position && slot.checkpoint_pass_rate != null) {
            const normRole = slot.position.replace(/\s*#\d+$/, '').trim();
            slotCPRs[normRole] = slot.checkpoint_pass_rate;
          }
        });
        return {
          ocName:      crime.name,
          executedAt:  crime.executed_at,
          status:      crime.status,
          money:       rewards?.money || 0,
          respect:     rewards?.respect || 0,
          itemIds:     (rewards?.items || []).map(i => i.id || i),
          slotCPRs,
          payoutPct:   rewards?.payout?.percentage || 100,
        };
      }).filter(r => r.executedAt); // only completed crimes

      if (!records.length) {
        if (btn) { btn.disabled = false; btn.innerHTML = 'Refresh History'; }
        showToast('No completed OCs found');
        return;
      }

      if (btn) btn.innerHTML = `<span style="font-size:12px">Saving ${records.length} OCs…</span>`;

      serverRequest({
        method: 'POST', path: '/api/payout/record',
        body: { records },
        onSuccess(d) {
          console.log('[HIVE OC] History import complete:', d.inserted, 'new,', records.length - d.inserted, 'already stored');
          showToast(`History imported — ${d.inserted} new OCs saved`);
          // Re-render history tab with fresh data
          renderHistory();
        },
        onError(err) {
          if (btn) { btn.disabled = false; btn.innerHTML = 'Refresh History'; }
          showToast('Save failed: ' + err);
        },
      });
    }

    fetchPage(0);
  }

  // ═══════════════════════════════════════════════════════════════
  // RENDER — FEEDBACK MODAL
  // ═══════════════════════════════════════════════════════════════

  function renderFeedback() {
    const body = document.getElementById('hive-fb-modal-body');
    if (!body) return;

    const from = _myName ? `${_myName} · The Hive [${_factionId || '50310'}]` : 'Unknown member';

    body.innerHTML = `
      <p class="fb-intro">Found a bug or have a suggestion? Sent directly to the developer — nobody else in the faction can see it.</p>
      <div class="fb-types" id="hive-fb-types">
        <button class="fb-type sel" onclick="this.closest('.fb-types').querySelectorAll('.fb-type').forEach(b=>b.classList.remove('sel'));this.classList.add('sel')">Bug Report</button>
        <button class="fb-type" onclick="this.closest('.fb-types').querySelectorAll('.fb-type').forEach(b=>b.classList.remove('sel'));this.classList.add('sel')">Suggestion</button>
        <button class="fb-type" onclick="this.closest('.fb-types').querySelectorAll('.fb-type').forEach(b=>b.classList.remove('sel'));this.classList.add('sel')">Other</button>
      </div>
      <textarea class="fb-ta" id="hive-fb-text" placeholder="Describe the issue or idea in detail…"></textarea>
      <div class="fb-footer">
        <span class="fb-from">from: ${from}</span>
        <button class="btn-prime" id="hive-fb-send">Send Feedback →</button>
      </div>
      <div id="hive-fb-confirm" style="display:none;margin-top:10px;padding:10px 14px;background:rgba(74,222,128,.06);border:1px solid rgba(74,222,128,.18);border-radius:9px;display:none;align-items:center;gap:10px;font-size:12px;color:var(--green)">
        ✓ Sent. Thanks — we'll look into it.
      </div>`;

    body.querySelector('#hive-fb-send')?.addEventListener('click', () => {
      const type = body.querySelector('.fb-type.sel')?.textContent || 'Bug Report';
      const text = body.querySelector('#hive-fb-text')?.value?.trim();
      if (!text) return;
      serverRequest({
        method: 'POST', path: '/api/feedback',
        body: { type, message: text, from: _myName, factionId: _factionId },
        onSuccess() {
          const conf = body.querySelector('#hive-fb-confirm');
          if (conf) { conf.style.display = 'flex'; }
          body.querySelector('#hive-fb-send').disabled = true;
        },
        onError() { showToast('Feedback send failed. Try again.'); },
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // RENDER — SETTINGS MODAL
  // ═══════════════════════════════════════════════════════════════

  function renderSettings() {
    const body = document.getElementById('hive-set-modal-body');
    if (!body) return;

    const parsed    = parseKey(_ocaKey);
    const keyValid  = !!parsed;

    body.innerHTML = `
      <div class="set-grid">

        <div class="set-card" style="grid-column:1/-1">
          <div class="set-card-hdr">API Key Usage — Transparency Disclosure</div>
          <div class="set-card-body" style="padding:10px 15px">
            <table style="width:100%;border-collapse:collapse;font-size:9.5px;color:rgba(125,211,252,.55)">
              <thead>
                <tr style="border-bottom:1px solid rgba(125,211,252,.1)">
                  <th style="text-align:left;padding:5px 8px;color:rgba(125,211,252,.3);font-weight:700;letter-spacing:.08em">DATA STORAGE</th>
                  <th style="text-align:left;padding:5px 8px;color:rgba(125,211,252,.3);font-weight:700;letter-spacing:.08em">DATA SHARING</th>
                  <th style="text-align:left;padding:5px 8px;color:rgba(125,211,252,.3);font-weight:700;letter-spacing:.08em">PURPOSE</th>
                  <th style="text-align:left;padding:5px 8px;color:rgba(125,211,252,.3);font-weight:700;letter-spacing:.08em">KEY STORAGE</th>
                  <th style="text-align:left;padding:5px 8px;color:rgba(125,211,252,.3);font-weight:700;letter-spacing:.08em">KEY ACCESS LEVEL</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style="padding:6px 8px">CPR data only — stored server-side for OC optimisation</td>
                  <td style="padding:6px 8px">Faction members only</td>
                  <td style="padding:6px 8px">OC assignment optimisation — competitive advantage for faction</td>
                  <td style="padding:6px 8px"><strong style="color:var(--green)">Not stored</strong> — API keys stay in your browser only and are never sent to our server</td>
                  <td style="padding:6px 8px">Limited access (Torn API) · Member OCA key (HiveOC only)</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="set-card">
          <div class="set-card-hdr">API Keys</div>
          <div class="set-card-body">
            <div class="key-row">
              <span class="key-tag kt-l">Leader</span>
              <input class="key-in" id="hive-key-in" type="password" placeholder="OCA-L50310-YourName" value="${_ocaKey}" autocomplete="off" spellcheck="false">
              <div class="key-dot ${keyValid && _isLeader ? 'kd-ok' : 'kd-no'}"></div>
            </div>
            <div class="key-row">
              <span class="key-tag kt-m">Member</span>
              <input class="key-in" id="hive-mkey-in" type="password" placeholder="OCA-M50310-YourName" value="${keyValid && !_isLeader ? _ocaKey : ''}" autocomplete="off" spellcheck="false">
              <div class="key-dot ${keyValid && !_isLeader ? 'kd-ok' : 'kd-no'}"></div>
            </div>
            <div style="font-size:10px;color:rgba(125,211,252,.28);margin-top:6px;line-height:1.5">Leader key unlocks full faction optimizer. Member key enables personal CPR sync.</div>
            <button class="hive-btn-primary" id="hive-key-save" style="margin-top:8px">Save Keys</button>
          </div>
        </div>

        <div class="set-card">
          <div class="set-card-hdr">TornStats</div>
          <div class="set-card-body">
            <div class="key-row" style="margin-bottom:0">
              <input class="key-in" id="hive-ts-in" type="password" placeholder="TS_..." value="${_tsApiKey}" style="flex:1" autocomplete="off" spellcheck="false">
              <div class="key-dot ${_tsLoaded ? 'kd-ok' : 'kd-no'}"></div>
            </div>
            <div style="font-size:10px;color:rgba(125,211,252,.28);margin-top:6px;line-height:1.5">${_tsLoaded ? `✓ Loaded · ${_factionMembers.length} members` : _tsApiKey ? '⟳ Loading…' : 'Used to sync faction CPR data.'}</div>
            <button class="hive-btn-primary" id="hive-ts-save" style="margin-top:8px">Save & Sync</button>
          </div>
        </div>

        <div class="set-card">
          <div class="set-card-hdr">Torn API Key</div>
          <div class="set-card-body">
            <div class="key-row" style="margin-bottom:0">
              <input class="key-in" id="hive-torn-in" type="password" placeholder="Limited Access key…" value="${_tornKey}" style="flex:1" autocomplete="off" spellcheck="false">
              <div class="key-dot ${_tornKey ? 'kd-ok' : 'kd-no'}"></div>
            </div>
            <div style="font-size:10px;color:rgba(125,211,252,.28);margin-top:6px;line-height:1.5">${_tornKey ? `✓ Set · ${_factionRoster.length} members` : 'Optional. Loads real names and hospital status.'}</div>
            <button class="hive-btn-primary" id="hive-torn-save" style="margin-top:8px">Save</button>
          </div>
        </div>

        <div class="set-card">
          <div class="set-card-hdr">Member OCA Key</div>
          <div class="set-card-body">
            <div class="key-row" style="margin-bottom:0">
              <input class="key-in" id="hive-moca-in" type="password" placeholder="OCA-M50310-…" value="${_memberOcaKey}" style="flex:1" autocomplete="off" spellcheck="false">
              <div class="key-dot ${_memberOcaKey ? 'kd-ok' : 'kd-no'}"></div>
            </div>
            <div style="font-size:10px;color:rgba(125,211,252,.28);margin-top:6px;line-height:1.5">${_memberOcaKey ? '✓ Set · CPR will sync on load' : 'Get your key from the faction leader. Submits your CPR data.'}</div>
            <button class="hive-btn-primary" id="hive-moca-save" style="margin-top:8px">Save & Sync</button>
          </div>
        </div>

        <div class="set-card">
          <div class="set-card-hdr">About</div>
          <div class="set-card-body">
            <div style="font-family:'DM Mono',monospace;font-size:10px;color:rgba(125,211,252,.22);line-height:2.2">
              <div>Hive OC Advisor · v${VERSION}</div>
              <div>The Hive [${_factionId || '50310'}]</div>
              <div style="word-break:break-all">oca-server-production.up.railway.app</div>
            </div>
          </div>
        </div>
      </div>`;

    // Wire save buttons
    body.querySelector('#hive-key-save')?.addEventListener('click', () => {
      const leaderVal = body.querySelector('#hive-key-in')?.value?.trim() || '';
      const memberVal = body.querySelector('#hive-mkey-in')?.value?.trim() || '';
      const val = leaderVal || memberVal;
      localStorage.setItem('hive-oc-key', val);
      _ocaKey = val;
      initKeyState();
      restartPolling();
      rebuildTabs();
      renderSettings();
      if (_panelOpen) switchTab(_activeTab);
    });

    body.querySelector('#hive-ts-save')?.addEventListener('click', () => {
      const val = body.querySelector('#hive-ts-in')?.value?.trim() || '';
      localStorage.setItem('hive-ts-key', val);
      _tsApiKey = val; _tsLoaded = false;
      if (val) loadTornStats();
      renderSettings();
    });

    body.querySelector('#hive-torn-save')?.addEventListener('click', () => {
      const val = body.querySelector('#hive-torn-in')?.value?.trim() || '';
      localStorage.setItem('hive-torn-key', val);
      _tornKey = val;
      if (val) loadFactionRoster(() => renderSettings());
      else renderSettings();
    });

    body.querySelector('#hive-moca-save')?.addEventListener('click', () => {
      const val = body.querySelector('#hive-moca-in')?.value?.trim() || '';
      const parsed = parseKey(val);
      if (val && (!parsed || parsed.keyType !== 'M')) {
        showToast('Invalid member key format. Expected OCA-M…');
        return;
      }
      localStorage.setItem('hive-moca-key', val);
      _memberOcaKey = val;
      _memberCPRPushed = false;
      if (val && _tornKey) {
        loadMemberAPICPR();
        showToast('Syncing your CPR data…');
      }
      renderSettings();
    });

    // Enter key on inputs
    body.querySelectorAll('.key-in').forEach(inp => {
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') inp.closest('.set-card').querySelector('button')?.click();
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // PANEL — FULL SCREEN OVERLAY
  // ═══════════════════════════════════════════════════════════════

  function buildToggleBtn() {
    if (document.getElementById('hive-toggle-btn')) return;
    const btn = document.createElement('button');
    btn.id    = 'hive-toggle-btn';
    btn.title = 'Hive OC Advisor';
    btn.innerHTML = `
      <div class="hive-tab-icon">
        <svg width="20" height="20" viewBox="0 0 26 26" fill="none">
          <polygon points="13,1.5 24.5,7.5 24.5,18.5 13,24.5 1.5,18.5 1.5,7.5" stroke="rgba(125,211,252,.65)" stroke-width="1.4" fill="rgba(0,30,100,.35)"/>
          <polygon points="13,6 20,10 20,16 13,20 6,16 6,10" stroke="rgba(125,211,252,.28)" stroke-width="0.8"/>
          <circle cx="13" cy="13" r="2.5" fill="#7dd3fc" opacity=".9"/>
        </svg>
      </div>
      <div class="hive-tab-label">HiveOC</div>`;
    document.body.appendChild(btn);
    btn.addEventListener('click', togglePanel);
  }

  function buildPanel() {
    if (document.getElementById('hive-panel')) return;

    const p = document.createElement('div');
    p.id = 'hive-panel';

    p.innerHTML = `
      <!-- Hex BG -->
      <div class="hive-hex-bg">
        <svg viewBox="0 0 700 900" preserveAspectRatio="xMidYMid slice">
          <defs>
            <pattern id="hive-hex-pat" x="0" y="0" width="60" height="52" patternUnits="userSpaceOnUse">
              <polygon points="30,2 55,15 55,37 30,50 5,37 5,15" fill="none" stroke="rgba(125,211,252,0.07)" stroke-width="0.8"/>
            </pattern>
            <radialGradient id="hive-hex-glow" cx="50%" cy="0%" r="70%">
              <stop offset="0%" stop-color="rgba(0,80,200,0.15)"/>
              <stop offset="100%" stop-color="transparent"/>
            </radialGradient>
          </defs>
          <rect width="700" height="900" fill="url(#hive-hex-pat)"/>
          <rect width="700" height="900" fill="url(#hive-hex-glow)"/>
        </svg>
      </div>

      <!-- TOP BAR -->
      <div class="hive-top-bar" id="hive-top-bar">
        <!-- Logo + wordmark -->
        <div class="hive-top-logo">
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
            <polygon points="13,1.5 24.5,7.5 24.5,18.5 13,24.5 1.5,18.5 1.5,7.5" stroke="rgba(125,211,252,.55)" stroke-width="1.4" fill="rgba(0,30,100,.28)"/>
            <polygon points="13,6 20,10 20,16 13,20 6,16 6,10" stroke="rgba(125,211,252,.22)" stroke-width="0.8"/>
            <circle cx="13" cy="13" r="2.2" fill="#7dd3fc" opacity=".85"/>
          </svg>
          <span style="font-family:'Rajdhani',sans-serif;font-size:16px;font-weight:700;letter-spacing:.06em;color:rgb(204,228,247);">HIVEOC</span>
        </div>

        <!-- Centered tabs -->
        <div id="hive-tabs"></div>

        <!-- Right: pending + gear + close -->
        <div id="hive-top-right">
          <!-- Pending pulse button -->
          <div class="hive-pending-btn" id="hive-pending-btn" style="display:none" title="Pending assignments">
            <div class="hive-pending-ring"></div>
            <div class="hive-pending-inner">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <circle cx="7" cy="7" r="6" stroke="rgba(248,113,113,.7)" stroke-width="1.2"/>
                <path d="M7 4v3.5l2 2" stroke="rgba(248,113,113,.9)" stroke-width="1.2" stroke-linecap="round"/>
              </svg>
            </div>
            <div class="hive-pending-count">0</div>
          </div>
          <div style="width:1px;height:16px;background:rgba(125,211,252,.07);margin:0 2px;"></div>
          <div class="hive-icon-btn" id="hive-gear-btn" title="Settings">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="2.2" stroke="currentColor" stroke-width="1.3"/><path d="M7 1v1.2M7 11.8V13M1 7h1.2M11.8 7H13M2.75 2.75l.85.85M10.4 10.4l.85.85M2.75 11.25l.85-.85M10.4 3.6l.85-.85" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          </div>
          <div class="hive-icon-btn" id="hive-close-btn" style="margin-left:2px;">✕</div>
        </div>
      </div>

      <!-- VIEWS CONTAINER -->
      <div class="hive-views" id="hive-views">

        <!-- ADVISOR VIEW (3-col grid) -->
        <div id="view-advisor" class="hive-advisor-view" style="display:none">
          <!-- OC List col -->
          <div class="oc-col" id="hive-oc-col">
            <div class="col-hdr">
              <span class="col-hdr-title">OC Teams</span>
              <span class="col-hdr-count">— active</span>
            </div>

            <!-- Objective control -->
            <div class="opt-ctrl-section" id="hive-obj-section">
              <div class="opt-ctrl-label">Objective</div>
              <div class="opt-obj-row">
                <button class="opt-obj-btn ${_optimObj === 'aggressive' ? 'obj-agg-active' : 'obj-inactive'}" data-obj="aggressive">
                  <div class="opt-obj-accent ${_optimObj === 'aggressive' ? 'acc-agg' : ''}"></div>
                  <span class="opt-obj-name ${_optimObj === 'aggressive' ? 'name-agg' : 'name-dim'}">Aggressive</span>
                  <span class="opt-obj-desc ${_optimObj === 'aggressive' ? 'desc-agg' : 'desc-dim'}">Push for higher-tier OCs</span>
                </button>
                <button class="opt-obj-btn ${_optimObj === 'controlled' ? 'obj-eff-active' : 'obj-inactive'}" data-obj="controlled">
                  <div class="opt-obj-accent ${_optimObj === 'controlled' ? 'acc-eff' : ''}"></div>
                  <span class="opt-obj-name ${_optimObj === 'controlled' ? 'name-eff' : 'name-dim'}">Controlled</span>
                  <span class="opt-obj-desc ${_optimObj === 'controlled' ? 'desc-eff' : 'desc-dim'}">Maximise success rate</span>
                </button>
              </div>
            </div>

            <!-- Fill Order control (Aggressive only) -->
            <div class="opt-ctrl-section opt-fill-section" id="hive-fill-section">
              <div class="opt-ctrl-label">Fill Order</div>
              <div class="opt-fill-row">
                <button class="opt-fill-btn ${_optimMode === 'spread' ? 'fill-active' : 'fill-inactive'}" data-mode="spread">
                  <span class="opt-fill-name ${_optimMode === 'spread' ? 'fill-name-active' : 'fill-name-dim'}">Spread</span>
                  <span class="opt-fill-desc ${_optimMode === 'spread' ? 'fill-desc-active' : 'fill-desc-dim'}">All OCs simultaneously</span>
                </button>
                <button class="opt-fill-btn ${_optimMode === 'stack' ? 'fill-active' : 'fill-inactive'}" data-mode="stack">
                  <span class="opt-fill-name ${_optimMode === 'stack' ? 'fill-name-active' : 'fill-name-dim'}">Stack</span>
                  <span class="opt-fill-desc ${_optimMode === 'stack' ? 'fill-desc-active' : 'fill-desc-dim'}">Top-down to completion</span>
                </button>
              </div>
            </div>

            <input class="oc-search" placeholder="Search OCs…" type="text" id="hive-oc-search">
            <div class="oc-scroll"></div>
          </div>

          <!-- Detail col -->
          <div class="det-col" id="hive-det-col">
            <div class="det-hdr">
              <div class="det-name" style="color:rgba(125,211,252,.3)">Select an OC</div>
            </div>
            <div class="slots-area"></div>
          </div>

          <!-- Queue col -->
          <div class="queue-col" id="hive-queue-col">
            <div class="col-hdr">
              <span class="col-hdr-title">${_isLeader ? 'Unassigned' : 'Your CPR'}</span>
              <span class="col-hdr-count">— free</span>
            </div>
            <div class="q-scroll"></div>
          </div>
        </div>

        <!-- ROSTER VIEW -->
        <div id="view-roster" class="hive-sub-view" style="display:none">
          <div class="hive-sub-body" id="view-roster-body"></div>
        </div>

        <!-- COVERAGE VIEW -->
        <div id="view-coverage" class="hive-sub-view" style="display:none">
          <div class="hive-sub-body" id="view-coverage-body"></div>
        </div>

        <!-- HISTORY VIEW -->
        <div id="view-history" class="hive-sub-view" style="display:none">
          <div class="hive-sub-body" id="view-history-body"></div>
        </div>

      </div>

      <!-- FEEDBACK MODAL -->
      <div class="hive-modal-bg" id="hive-fb-modal" style="display:none">
        <div class="hive-modal fb-modal" onclick="event.stopPropagation()">
          <div class="hive-modal-hdr">
            <span class="hive-modal-title">Send Feedback</span>
            <div class="hive-modal-x" id="hive-fb-modal-close">✕</div>
          </div>
          <div class="fb-body" id="hive-fb-modal-body"></div>
        </div>
      </div>

      <!-- SETTINGS MODAL -->
      <div class="hive-modal-bg" id="hive-set-modal" style="display:none">
        <div class="hive-modal set-modal" onclick="event.stopPropagation()">
          <div class="hive-modal-hdr" style="position:sticky;top:0;background:#040d1e;z-index:2">
            <span class="hive-modal-title">Settings</span>
            <div class="hive-modal-x" id="hive-set-modal-close">✕</div>
          </div>
          <div id="hive-set-modal-body"></div>
        </div>
      </div>
    `;

    document.body.appendChild(p);

    // Wire close/gear
    p.querySelector('#hive-close-btn').addEventListener('click', closePanel);
    p.querySelector('#hive-gear-btn').addEventListener('click', openSetModal);

    // Wire modal close
    p.querySelector('#hive-fb-modal-close').addEventListener('click', closeFbModal);
    p.querySelector('#hive-set-modal-close').addEventListener('click', closeSetModal);
    p.querySelector('#hive-fb-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeFbModal(); });
    p.querySelector('#hive-set-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeSetModal(); });

    // Wire pending btn → goes to roster (leader) or advisor (member)
    p.querySelector('#hive-pending-btn').addEventListener('click', () => {
      if (_isLeader) switchTab('roster');
      else switchTab('advisor');
    });

    // OC search
    p.querySelector('#hive-oc-search').addEventListener('input', function() {
      const q = this.value.toLowerCase();
      p.querySelectorAll('#hive-oc-col .oci').forEach(el => {
        const name = el.dataset.oc?.toLowerCase() || '';
        el.style.display = name.includes(q) ? '' : 'none';
      });
      p.querySelectorAll('#hive-oc-col .oc-sect-lbl').forEach(el => el.style.display = q ? 'none' : '');
    });

    // Objective control (Aggressive / Efficient)
    p.querySelector('#hive-obj-section')?.addEventListener('click', function(e) {
      const btn = e.target.closest('.opt-obj-btn');
      if (!btn) return;
      const newObj = btn.dataset.obj;
      if (newObj === _optimObj) return;
      _optimObj = newObj;
      localStorage.setItem('hive-optim-obj', newObj);

      // Update objective buttons
      p.querySelectorAll('.opt-obj-btn').forEach(b => {
        const isAgg  = b.dataset.obj === 'aggressive';
        const active = b.dataset.obj === newObj;
        b.className = `opt-obj-btn ${active ? (isAgg ? 'obj-agg-active' : 'obj-eff-active') : 'obj-inactive'}`;
        b.querySelector('.opt-obj-accent').className = `opt-obj-accent ${active ? (isAgg ? 'acc-agg' : 'acc-eff') : ''}`;
        b.querySelector('.opt-obj-name').className = `opt-obj-name ${active ? (isAgg ? 'name-agg' : 'name-eff') : 'name-dim'}`;
        b.querySelector('.opt-obj-desc').className = `opt-obj-desc ${active ? (isAgg ? 'desc-agg' : 'desc-eff') : 'desc-dim'}`;
      });

      scheduleOptimize();
    });

    // Fill Order control (Spread / Stack) — Aggressive only
    p.querySelector('#hive-fill-section')?.addEventListener('click', function(e) {
      const btn = e.target.closest('.opt-fill-btn');
      if (!btn) return;
      const newMode = btn.dataset.mode;
      if (newMode === _optimMode) return;
      _optimMode = newMode;
      localStorage.setItem('hive-optim-mode', newMode);

      p.querySelectorAll('.opt-fill-btn').forEach(b => {
        const active = b.dataset.mode === newMode;
        b.className = `opt-fill-btn ${active ? 'fill-active' : 'fill-inactive'}`;
        b.querySelector('.opt-fill-name').className = `opt-fill-name ${active ? 'fill-name-active' : 'fill-name-dim'}`;
        b.querySelector('.opt-fill-desc').className = `opt-fill-desc ${active ? 'fill-desc-active' : 'fill-desc-dim'}`;
      });

      scheduleOptimize();
    });

    rebuildTabs();
  }

  function rebuildTabs() {
    const tabsEl = document.getElementById('hive-tabs');
    if (!tabsEl) return;

    const leaderTabs = [
      { id: 'advisor',  label: 'Advisor'  },
      { id: 'roster',   label: 'Roster'   },
      { id: 'coverage', label: 'Coverage' },
      { id: 'history',  label: 'History'  },
      { id: 'feedback', label: 'Feedback' },
    ];
    const memberTabs = [
      { id: 'advisor',  label: 'Advisor'  },
      { id: 'history',  label: 'History'  },
      { id: 'feedback', label: 'Feedback' },
    ];

    const tabs = _isLeader ? leaderTabs : memberTabs;
    tabsEl.innerHTML = '';
    tabs.forEach(t => {
      const btn = document.createElement('div');
      btn.className = 'hive-tb-tab' + (_activeTab === t.id ? ' active' : '');
      btn.dataset.tab = t.id;
      btn.textContent = t.label;
      btn.addEventListener('click', () => {
        if (t.id === 'feedback') { openFbModal(); return; }
        switchTab(t.id);
      });
      tabsEl.appendChild(btn);
    });
  }

  function switchTab(tab) {
    _activeTab = tab;

    // Update tab bar highlight
    document.querySelectorAll('.hive-tb-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });

    // Hide all views
    ['view-advisor','view-roster','view-coverage','view-history'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });

    // Show target
    const target = document.getElementById('view-' + tab);
    if (target) {
      target.style.display = tab === 'advisor' ? 'grid' : 'flex';
    }

    // Render content
    if (tab === 'advisor')  { renderAdvisor(); }
    if (tab === 'roster')   { loadFactionAssignments(); renderRoster(); }
    if (tab === 'coverage') renderCoverage();
    if (tab === 'history')  renderHistory();
  }

  function openFbModal() {
    const m = document.getElementById('hive-fb-modal');
    if (!m) return;
    renderFeedback();
    m.style.display = 'flex';
    // Remove active from feedback tab
    document.querySelectorAll('.hive-tb-tab').forEach(t => {
      if (t.dataset.tab === 'feedback') t.classList.remove('active');
    });
  }

  function closeFbModal() {
    const m = document.getElementById('hive-fb-modal');
    if (m) m.style.display = 'none';
  }

  function openSetModal() {
    const m = document.getElementById('hive-set-modal');
    if (!m) return;
    renderSettings();
    m.style.display = 'flex';
  }

  function closeSetModal() {
    const m = document.getElementById('hive-set-modal');
    if (m) m.style.display = 'none';
  }

  // ── PANEL WIDTH — Option B ───────────────────────────────────────
  // Always 800px. Only shrinks if viewport is too small to give Torn
  // its content (976px) + left nav (160px) + 20px breathing room.
  function getPanelWidth() {
    const minTornSpace = 976 + 160 + 20;
    return Math.max(380, Math.min(800, window.innerWidth - minTornSpace));
  }

  // ── TORN PAGE PUSH ───────────────────────────────────────────────
  // Torn centres its .container elements with equal margin-left/right.
  // We shift them left by the panel width so content stays visible.
  function pushTornLeft(pw) {
    document.querySelectorAll('.container').forEach(el => {
      const ml = parseFloat(getComputedStyle(el).marginLeft) || 0;
      el.dataset.hiveOrigML = ml;
      el.style.marginLeft = Math.max(0, ml - pw) + 'px';
    });
    document.body.style.marginRight = pw + 'px';
  }

  function restoreTorn() {
    document.querySelectorAll('.container').forEach(el => {
      if (el.dataset.hiveOrigML != null) {
        el.style.marginLeft = el.dataset.hiveOrigML + 'px';
        delete el.dataset.hiveOrigML;
      }
    });
    document.body.style.marginRight = '';
  }

  function openPanel() {
    _panelOpen = true;
    buildPanel();
    const p = document.getElementById('hive-panel');
    if (p) {
      const pw = getPanelWidth();
      p.style.width   = pw + 'px';
      p.style.opacity = '0';
      p.style.display = 'flex';
      requestAnimationFrame(() => { p.style.opacity = '1'; });
      pushTornLeft(pw);
    }
    document.getElementById('hive-toggle-btn').style.display = 'none';
    if (!_ocaKey) openSetModal();
    else switchTab(_activeTab);
  }

  function closePanel() {
    _panelOpen = false;
    const p = document.getElementById('hive-panel');
    if (p) {
      p.style.opacity = '0';
      setTimeout(() => { p.style.display = 'none'; }, 280);
    }
    restoreTorn();
    document.getElementById('hive-toggle-btn').style.display = '';
  }

  function togglePanel() {
    if (_panelOpen) closePanel(); else openPanel();
  }

  // ═══════════════════════════════════════════════════════════════
  // REFRESH
  // ═══════════════════════════════════════════════════════════════

  let _domCPRPushed = false;

  function scrapeAndPushOwnCPR() {
    if (!_ocaKey || !_myName || _domCPRPushed) return;
    // Also push faction-wide CPR from planning/recruiting (leader key sees all filled slots)
    pushFactionPlanningCPR();
    const scraped = {};
    document.querySelectorAll(SEL.crimeCard).forEach(card => {
      const ocName = normOCName(textOnly(card.querySelector(SEL.crimeTitle)));
      if (!ocName) return;
      card.querySelectorAll(SEL.slotWrap).forEach(slot => {
        if (!slot.querySelector(SEL.hasJoin)) return;
        const roleRaw = textOnly(slot.querySelector(SEL.slotTitle));
        const cpr     = parseInt(slot.querySelector(SEL.slotCPR)?.textContent);
        if (!roleRaw || !cpr || cpr <= 0) return;
        const base = roleRaw.replace(/#\s*/g,'').replace(/\s+\d+$/,'').trim();
        if (!scraped[ocName]) scraped[ocName] = {};
        scraped[ocName][base] = cpr;
      });
    });
    if (Object.keys(scraped).length === 0) return;

    if (_tornKey) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://api.torn.com/v2/user/crimes?key=${_tornKey}&comment=HiveOCA`,
        timeout: 8000,
        onload(r) {
          try {
            const d = JSON.parse(r.responseText);
            if (d?.error) { pushOwnCPR(scraped); return; }
            const apiCPR = { ...scraped };
            (d.crimes || []).forEach(crime => {
              const ocName = normOCName(crime.name || crime.scenario || '');
              if (!ocName) return;
              (crime.slots || []).forEach(slot => {
                const roleRaw = slot.position || slot.role || '';
                const cpr     = slot.checkpoint_pass_rate ?? slot.cpr ?? null;
                if (!roleRaw || cpr === null) return;
                const base = roleRaw.replace(/#\s*/g,'').replace(/\s+\d+$/,'').trim();
                if (!apiCPR[ocName]) apiCPR[ocName] = {};
                if (cpr > 0) apiCPR[ocName][base] = cpr;
              });
            });
            pushOwnCPR(apiCPR);
          } catch(e) { pushOwnCPR(scraped); }
        },
        onerror()   { pushOwnCPR(scraped); },
        ontimeout() { pushOwnCPR(scraped); },
      });
    } else {
      pushOwnCPR(scraped);
    }
  }

  function pushOwnCPR(cprs) {
    if (!cprs || Object.keys(cprs).length === 0) return;
    serverRequest({
      method: 'POST', path: '/api/cpr/batch', body: { members: { [_myName]: cprs } },
      onSuccess() {
        _domCPRPushed = true;
        setTimeout(scheduleOptimize, 500);
      },
    });
  }

  // Push real CPR for ALL members visible in faction planning/recruiting OCs.
  // The faction crimes API returns checkpoint_pass_rate for every filled slot
  // using the calling user's key — this is Torn's own calculation, ground truth.
  // Called once per page load when the leader key is available.
  let _factionCPRPushed = false;
  function pushFactionPlanningCPR() {
    if (!_ocaKey || !_tornKey || _factionCPRPushed) return;
    _factionCPRPushed = true;
    const cats = ['planning', 'recruiting'];
    const allMemberCPRs = {}; // { memberName: { ocName: { role: cpr } } }

    let pending = cats.length;
    cats.forEach(cat => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://api.torn.com/v2/faction/crimes?cat=${cat}&key=${_tornKey}&comment=HiveOCA`,
        timeout: 10000,
        onload(r) {
          try {
            const d = JSON.parse(r.responseText);
            (d.crimes || []).forEach(crime => {
              const ocName = normOCName(crime.name || '');
              if (!ocName) return;
              (crime.slots || []).forEach(slot => {
                if (!slot.user?.id) return; // skip empty slots
                const cpr = slot.checkpoint_pass_rate;
                if (!cpr || cpr <= 0) return;
                const roleRaw = slot.position || '';
                const role = roleRaw.replace(/#\s*/g,'').replace(/\s+\d+$/,'').trim();
                if (!role) return;
                // Look up member name from our roster
                const memberName = _factionRoster.find(m => String(m.id) === String(slot.user.id))?.name
                               || _factionMembers.find(m => String(m.id) === String(slot.user.id))?.name
                               || String(slot.user.id);
                if (!memberName || /^\d+$/.test(memberName)) return;
                if (!allMemberCPRs[memberName]) allMemberCPRs[memberName] = {};
                if (!allMemberCPRs[memberName][ocName]) allMemberCPRs[memberName][ocName] = {};
                allMemberCPRs[memberName][ocName][role] = cpr;
              });
            });
          } catch(e) { /* silently skip */ }
          if (--pending === 0 && Object.keys(allMemberCPRs).length > 0) {
            serverRequest({
              method: 'POST', path: '/api/cpr/batch', body: { members: allMemberCPRs },
              onSuccess() { console.log('[HiveOC] Pushed faction CPR for', Object.keys(allMemberCPRs).length, 'members'); },
            });
          }
        },
        onerror()   { --pending; },
        ontimeout() { --pending; },
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // TORN PAGE INJECTIONS
  // ═══════════════════════════════════════════════════════════════

  function _upsertBadge(afterEl, className, text, cssText) {
    if (!afterEl) return;
    const existing = afterEl.nextElementSibling;
    if (existing && existing.classList.contains(className)) {
      if (existing.textContent !== text)      existing.textContent = text;
      if (existing.style.cssText !== cssText) existing.style.cssText = cssText;
      return;
    }
    const b = document.createElement('div');
    b.className   = className;
    b.textContent = text;
    b.style.cssText = cssText;
    afterEl.insertAdjacentElement('afterend', b);
  }

  function injectTornPageBadges() {
    document.querySelectorAll(SEL.crimeCard).forEach(card => {
      const ocName = normOCName(textOnly(card.querySelector(SEL.crimeTitle)));
      if (!ocName) return;
      card.querySelectorAll(SEL.slotWrap).forEach(slot => {
        const roleRaw = textOnly(slot.querySelector(SEL.slotTitle));
        const cpr     = parseInt(slot.querySelector(SEL.slotCPR)?.textContent) || 0;
        const role    = normRole(roleRaw);
        if (!role) return;

        const ocsRole  = getOCSRole(ocName, role);
        const rc       = getRoleCPRRange(role);

        // Use server-driven tier data — ocsRole.tier is 'CRITICAL'/'IMPORTANT'/'FREE'
        // Fall back to ROLE_CPR_RANGES global data if no ocsRole found
        const isSafe   = ocsRole ? (ocsRole.safe || ocsRole.tier === 'FREE') : rc.safe;
        const isCrit   = ocsRole ? (ocsRole.crit || ocsRole.tier === 'CRITICAL') : false;
        const safety   = ocsRole?.safety || '';
        // Use per-OC per-role absMin/idealMin from server — this is the key fix
        const absMin   = ocsRole?.absMin   ?? rc.absMin;
        const idealMin = ocsRole?.idealMin ?? rc.idealMin;
        const idealMax = rc.idealMax ?? (idealMin + 10);

        let tierTag, tierTagCol;
        if (isSafe) {
          tierTag = '🟢 free'; tierTagCol = '#22d3ee';
        } else if (/^💀/.test(safety)) {
          tierTag = '💀 instant fail'; tierTagCol = '#ff6b6b';
        } else if (isCrit) {
          tierTag = '🔴 critical'; tierTagCol = '#e74c3c';
        } else {
          tierTag = '🟠 important'; tierTagCol = '#ff9f43';
        }
        const displaySafe = isSafe;

        let label, col;
        if (displaySafe)         { label = '✓ Free Slot'; col = '#22d3ee'; }
        else if (!cpr)           { label = tierTag; col = tierTagCol; }
        else if (cpr < absMin)   { label = '⚠ Below Min'; col = '#e74c3c'; }
        else if (cpr < idealMin) { label = '~ Marginal';  col = '#60a5fa'; }
        else if (cpr <= idealMax){ label = '★ Ideal';     col = '#22d3ee'; }
        else                     { label = '↑ Strong';    col = '#22d3ee'; }

        const critTag = displaySafe ? '' : ' · ' + tierTag;
        const text    = label + critTag;
        const css     = `display:block;width:100%;box-sizing:border-box;text-align:center;`
                      + `font-size:8px;font-weight:700;padding:1px 4px;white-space:nowrap;`
                      + `background:${col}18;color:${col};border-top:1px solid ${col}22;`
                      + `font-family:system-ui,sans-serif;line-height:14px;pointer-events:none;`;
        const anchorEl = slot.querySelector('[class*="slotBody___"]') || slot;
        _upsertBadge(anchorEl, 'oca-torn-badge', text, css);
      });
    });
  }

  let _richTooltip = null;

  function getRichTooltip() {
    if (!_richTooltip) {
      _richTooltip = document.createElement('div');
      _richTooltip.className = 'oca-role-tooltip';
      _richTooltip.style.cssText = 'position:fixed;z-index:999999;pointer-events:none;'
        + 'background:#050d1a;border:1px solid rgba(100,180,255,0.15);border-radius:8px;'
        + 'padding:10px 12px;max-width:260px;min-width:200px;'
        + 'box-shadow:0 4px 20px rgba(0,0,0,.7);'
        + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
        + 'font-size:11px;line-height:1.5;color:rgba(180,220,255,0.6);'
        + 'opacity:0;transition:opacity .1s;';
      document.body.appendChild(_richTooltip);
    }
    return _richTooltip;
  }

  function showRichRoleTooltip(e, ocName, role, cpr, isEmpty) {
    const ocsRole  = getOCSRole(ocName, role);
    const rc       = getRoleCPRRange(role);
    const isSafe   = ocsRole ? (ocsRole.safe || ocsRole.tier === 'FREE') : rc.safe;
    const isCrit   = ocsRole ? (ocsRole.crit || ocsRole.tier === 'CRITICAL') : false;
    const safety   = ocsRole?.safety || '';
    const absMin   = ocsRole?.absMin   ?? rc.absMin;
    const idealMin = ocsRole?.idealMin ?? rc.idealMin;
    const idealMax = rc.idealMax ?? (idealMin + 10);
    const overQual = rc.overQual ?? 85;

    let tierLabel, tierBg, tierCol, displaySafe;
    if (isSafe) {
      tierLabel = '🟢 FREE SLOT';   tierBg = '#0a1f0f'; tierCol = '#22d3ee'; displaySafe = true;
    } else if (/^💀/.test(safety)) {
      tierLabel = '💀 INSTANT FAIL'; tierBg = '#1a0a1a'; tierCol = '#ff6b6b'; displaySafe = false;
    } else if (isCrit) {
      tierLabel = '🔴 CRITICAL';    tierBg = '#1f0a0a'; tierCol = '#e74c3c'; displaySafe = false;
    } else {
      tierLabel = '🟠 IMPORTANT';   tierBg = '#1a130a'; tierCol = '#ff9f43'; displaySafe = false;
    }
    const sweetRange = displaySafe ? 'Any CPR' : `${idealMin}–${idealMax}%`;

    let cprLine = '';
    if (cpr > 0) {
      let cl, ct;
      if (displaySafe)                              { ct = 'Any CPR — role barely affects outcome'; cl = '#22d3ee'; }
      else if (cpr > overQual)                      { ct = '⚡ Over-qualified — move to higher OC';  cl = '#60a5fa'; }
      else if (cpr >= idealMin && cpr <= idealMax)  { ct = '★ Ideal range';                          cl = '#22d3ee'; }
      else if (cpr > idealMax)                      { ct = '✓ Strong CPR';                            cl = '#22d3ee'; }
      else if (cpr >= absMin)                       { ct = '⚠ Below ideal — marginal';               cl = '#60a5fa'; }
      else                                          { ct = '🔴 Below minimum — high risk';            cl = '#e74c3c'; }
      cprLine = `<hr style="border:none;border-top:1px solid rgba(100,180,255,0.1);margin:5px 0">`
        + `<div style="display:flex;justify-content:space-between"><span style="color:#4a5a6a;font-size:10px">Your CPR</span><span style="color:${cl};font-size:10px;font-weight:600">${cpr}% — ${ct}</span></div>`;
    } else if (isEmpty) {
      cprLine = `<hr style="border:none;border-top:1px solid rgba(100,180,255,0.1);margin:5px 0">`
        + `<div style="display:flex;justify-content:space-between"><span style="color:#4a5a6a;font-size:10px">Min to join</span><span style="color:#cce4f7;font-size:10px;font-weight:600">${displaySafe ? 'Any' : absMin+'%+'}</span></div>`
        + `<div style="display:flex;justify-content:space-between"><span style="color:#4a5a6a;font-size:10px">Ideal range</span><span style="color:#22d3ee;font-size:10px;font-weight:600">${sweetRange}</span></div>`;
    }

    const failDesc = displaySafe
      ? 'This checkpoint has near-zero impact. Even failure here rarely affects the OC outcome.'
      : /^💀/.test(safety)
        ? '⚠️ Failure here ends the OC immediately with zero payout. No recovery possible.'
        : isCrit
          ? 'This is a main-path gate. Low CPR here significantly drops success chance.'
          : 'Affects success noticeably but has some recovery paths if this fails.';

    const t = getRichTooltip();
    t.innerHTML =
      `<div style="font-size:12px;font-weight:700;color:#e2e8f0;margin-bottom:3px">${role} · ${ocName}</div>`
      + `<span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px;display:inline-block;margin-bottom:5px;background:${tierBg};color:${tierCol};border:1px solid ${tierCol}44">${tierLabel}</span>`
      + (safety ? `<div style="font-size:10px;color:rgba(125,211,252,0.5);margin-bottom:5px">${safety}</div>` : '')
      + `<hr style="border:none;border-top:1px solid rgba(100,180,255,0.1);margin:5px 0">`
      + `<div style="display:flex;justify-content:space-between;margin-bottom:2px"><span style="color:#4a5a6a;font-size:10px">Ideal CPR</span><span style="color:#cce4f7;font-size:10px;font-weight:600">${sweetRange}</span></div>`
      + (minCPR > 0 && !displaySafe ? `<div style="display:flex;justify-content:space-between;margin-bottom:2px"><span style="color:#4a5a6a;font-size:10px">Minimum</span><span style="color:#cce4f7;font-size:10px;font-weight:600">${minCPR}%</span></div>` : '')
      + cprLine
      + `<hr style="border:none;border-top:1px solid rgba(100,180,255,0.1);margin:5px 0">`
      + `<div style="font-size:10px;color:rgba(125,211,252,0.35)"><span style="color:#607d8b">On failure: </span>${failDesc}</div>`;

    positionRichTooltip(e, t);
    t.style.opacity = '1';
  }

  function positionRichTooltip(e, t) {
    const x = e.clientX + 14, y = e.clientY - 10;
    t.style.left = (x + 260 > window.innerWidth  ? x - 274 : x) + 'px';
    t.style.top  = (y + 200 > window.innerHeight ? y - 200 : y) + 'px';
  }

  function injectTornPageTooltips() {
    document.querySelectorAll(SEL.slotWrap).forEach(slot => {
      if (slot._ocaTornTipBound) return;
      slot._ocaTornTipBound = true;
      const card   = slot.closest(SEL.crimeCard);
      if (!card) return;
      const ocName = normOCName(textOnly(card.querySelector(SEL.crimeTitle)));
      const role   = normRole(textOnly(slot.querySelector(SEL.slotTitle)));
      if (!role || !ocName) return;
      const cpr    = parseInt(slot.querySelector(SEL.slotCPR)?.textContent) || 0;
      const isEmpty = !!slot.querySelector(SEL.hasJoin);

      slot.addEventListener('mouseenter', e => showRichRoleTooltip(e, ocName, role, cpr, isEmpty));
      slot.addEventListener('mousemove',  e => {
        const t = getRichTooltip();
        if (t.style.opacity === '1') positionRichTooltip(e, t);
      });
      slot.addEventListener('mouseleave', () => { getRichTooltip().style.opacity = '0'; });
    });
  }

  function refresh() {
    scan();
    if (_ocaKey) scheduleOptimize();
    injectTornPageBadges();
    injectTornPageTooltips();
    _domCPRPushed = false;
    scrapeAndPushOwnCPR();
    if (_panelOpen) {
      if (_activeTab === 'advisor')  renderAdvisor();
      if (_activeTab === 'roster')   renderRoster();
      if (_activeTab === 'coverage') renderCoverage();
    }
  }

  function restartPolling() {
    clearInterval(_pollTimer);
    if (!_ocaKey) return;
    pollAssignment();
    _pollTimer = setInterval(pollAssignment, 30000);
  }

  // ═══════════════════════════════════════════════════════════════
  // TOOLTIP (panel tooltip for hive-tip elements)
  // ═══════════════════════════════════════════════════════════════

  function initTooltip() {
    const tip = document.createElement('div');
    tip.id = 'hive-tooltip';
    document.body.appendChild(tip);

    document.addEventListener('mouseover', e => {
      const el = e.target.closest('.hive-tip[data-tip]');
      if (!el) { tip.style.display = 'none'; return; }
      const raw = el.getAttribute('data-tip') || '';
      if (!raw) return;
      tip.innerHTML = raw.split('\n').map((ln, i) => {
        const cls = i === 0 ? 'tip-line0'
          : /🔴|CRITICAL|INSTANT/.test(ln) ? 'tip-crit'
          : /🟢|SAFE|JUNK|REWARD/.test(ln) ? 'tip-safe'
          : /🟡|FLEXIBLE/.test(ln) ? 'tip-mid'
          : /Ideal:|Their |CPR:|Min:|check/.test(ln) ? 'tip-cpr' : '';
        return '<div' + (cls ? ' class="' + cls + '"' : '') + '>' + ln + '</div>';
      }).join('');
      const x = Math.min(e.clientX + 14, window.innerWidth  - 285);
      const y = Math.min(e.clientY + 14, window.innerHeight - 220);
      tip.style.left = x + 'px'; tip.style.top = y + 'px'; tip.style.display = 'block';
    });

    document.addEventListener('mousemove', e => {
      if (tip.style.display === 'none') return;
      const x = Math.min(e.clientX + 14, window.innerWidth  - 285);
      const y = Math.min(e.clientY + 14, window.innerHeight - 220);
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    });

    document.addEventListener('mouseout', e => {
      if (e.target.closest && e.target.closest('.hive-tip')) return;
      tip.style.display = 'none';
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // OBSERVER
  // ═══════════════════════════════════════════════════════════════

  function observe() {
    let _lastFingerprint = '';

    _observer = new MutationObserver(mutations => {
      const meaningful = mutations.filter(m => {
        if (m.type === 'characterData') return false;
        const nodes = [...m.addedNodes, ...m.removedNodes];
        if (nodes.every(n => n.nodeType === 3)) return false;
        if (nodes.every(n =>
          n.nodeType !== 1 ||
          (typeof n.className === 'string' && n.className.startsWith('hive-')) ||
          (n.id && n.id.startsWith('hive-'))
        )) return false;
        return true;
      });
      if (!meaningful.length) return;

      clearTimeout(_scanTimer);
      _scanTimer = setTimeout(() => {
        const cards = document.querySelectorAll('[class*="wrapper___U2Ap7"]');
        const fp    = [...cards].map(c =>
          c.querySelector('[class*="panelTitle___"]')?.textContent
          + c.querySelectorAll('[class*="hasJoin___"]').length
        ).join('|');
        if (fp === _lastFingerprint) return;
        _lastFingerprint = fp;
        refresh();
      }, 1200);
    });

    _observer.observe(document.body, { childList: true, subtree: true, characterData: false });

    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        _lastFingerprint = '';
        clearTimeout(_scanTimer);
        _scanTimer = setTimeout(refresh, 1000);
      }
    }, 500);
  }

  // ═══════════════════════════════════════════════════════════════
  // STYLES
  // ═══════════════════════════════════════════════════════════════

  function injectStyles() {
    if (document.getElementById('hive-style')) return;
    const s = document.createElement('style');
    s.id = 'hive-style';
    s.textContent = `
@import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Inter:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');

:root {
  --navy: #030c1a; --navy2: #050f20; --navy3: #071526; --navy4: #0a1c30; --navy5: #0d2240;
  --cyan: #7dd3fc; --cyan2: rgba(125,211,252,0.6); --cyan3: rgba(125,211,252,0.3);
  --cyan4: rgba(125,211,252,0.12); --cyan5: rgba(125,211,252,0.06); --cyan6: rgba(125,211,252,0.04);
  --ctext: rgb(204,228,247);
  --green: #4ade80; --amber: #fbbf24; --red: #f87171; --gold: #ffd740;
  --blue: #60a5fa; --purple: #c084fc;
}

/* ── Toggle Button ── */
#hive-toggle-btn {
  position: fixed;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 999991;
  width: 38px;
  height: 160px;
  background: linear-gradient(180deg, rgba(3,10,26,.97) 0%, rgba(5,15,38,.97) 100%);
  border: 1px solid rgba(125,211,252,.28);
  border-right: none;
  border-radius: 12px 0 0 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  cursor: pointer;
  box-shadow: -4px 0 28px rgba(0,40,160,.3), inset 1px 0 0 rgba(125,211,252,.08);
  transition: width .18s ease, background .18s ease, box-shadow .18s ease, border-color .18s ease;
  overflow: hidden;
}
#hive-toggle-btn:hover {
  width: 48px;
  background: linear-gradient(180deg, rgba(4,14,34,.99) 0%, rgba(6,20,50,.99) 100%);
  border-color: rgba(125,211,252,.5);
  box-shadow: -6px 0 36px rgba(0,60,220,.4), inset 1px 0 0 rgba(125,211,252,.15);
}
#hive-toggle-btn .hive-tab-icon { flex-shrink: 0; }
#hive-toggle-btn .hive-tab-label {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  transform: rotate(180deg);
  font-family: 'Rajdhani', sans-serif;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .2em;
  text-transform: uppercase;
  color: rgba(125,211,252,.55);
  white-space: nowrap;
  transition: color .18s;
}
#hive-toggle-btn:hover .hive-tab-label { color: rgba(125,211,252,.85); }
#hive-assign-badge {
  position: absolute; top: 8px; left: 4px;
  width: 14px; height: 14px; background: var(--red);
  border-radius: 50%; border: 2px solid #1a1d24;
  font-family: 'DM Mono', monospace; font-size: 8px; color: #fff;
  display: flex; align-items: center; justify-content: center;
}

/* ── Panel — fixed right sidebar ── */
#hive-panel {
  position: fixed;
  right: 0; top: 44px;
  width: var(--hive-panel-w, 600px);
  height: calc(100vh - 44px - 42px);
  z-index: 999980;
  display: none; flex-direction: column;
  background: var(--navy);
  border-left: 1px solid rgba(125,211,252,.18);
  border-bottom: 1px solid rgba(125,211,252,.18);
  border-bottom-left-radius: 10px;
  font-family: 'Inter', sans-serif; color: var(--ctext);
  opacity: 0; transition: opacity .28s ease;
  overflow: hidden;
  box-shadow: -8px 0 40px rgba(0,0,0,.6);
}

/* ── Hex BG ── */
.hive-hex-bg {
  position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 0; opacity: 0.35;
}
.hive-hex-bg svg { width: 100%; height: 100%; }

/* ── Top Bar ── */
.hive-top-bar {
  height: 52px; background: var(--navy);
  border-bottom: 1px solid var(--cyan5);
  display: flex; align-items: center;
  padding: 0 12px 0 16px; gap: 8px; flex-shrink: 0;
  position: relative; z-index: 1;
  overflow: hidden;
}

/* Logo + wordmark — never shrink */
.hive-top-logo { display:flex; align-items:center; gap:9px; flex-shrink:0; margin-right:4px; }

/* Tabs — centred but constrained, never push right buttons off */
#hive-tabs {
  flex: 1; min-width: 0;
  display: flex; justify-content: center; height: 100%;
  overflow: hidden;
}

/* Right buttons — never shrink */
#hive-top-right { display:flex; align-items:center; gap:6px; flex-shrink:0; }

/* ── Tab Bar ── */
.hive-tb-tab {
  padding: 0 16px; height: 52px; line-height: 52px;
  font-family: 'Rajdhani', sans-serif; font-size: 11px; font-weight: 700;
  letter-spacing: .1em; text-transform: uppercase;
  color: rgba(125,211,252,.3); cursor: pointer;
  border-bottom: 2px solid transparent;
  display: inline-flex; align-items: center;
  transition: all .15s; white-space: nowrap;
}
.hive-tb-tab:hover { color: rgba(125,211,252,.65); }
.hive-tb-tab.active { color: #7dd3fc; border-bottom-color: #7dd3fc; }

/* ── Icon buttons (gear, close) ── */
.hive-icon-btn {
  width: 30px; height: 30px; background: var(--cyan5);
  border: 1px solid var(--cyan4); border-radius: 8px;
  color: var(--cyan3); font-size: 13px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: all .15s; flex-shrink: 0;
}
.hive-icon-btn:hover { background: var(--cyan4); color: var(--cyan); }

/* ── Pending pulse button ── */
.hive-pending-btn {
  position: relative; width: 36px; height: 36px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; flex-shrink: 0;
}
.hive-pending-inner {
  width: 36px; height: 36px;
  background: rgba(248,113,113,.1); border: 1px solid rgba(248,113,113,.4);
  border-radius: 9px; display: flex; align-items: center; justify-content: center;
  position: relative; z-index: 1; transition: all .15s;
}
.hive-pending-inner:hover { background: rgba(248,113,113,.18); border-color: rgba(248,113,113,.7); }
.hive-pending-ring {
  position: absolute; inset: -4px; border-radius: 13px;
  border: 1.5px solid rgba(248,113,113,.5);
  animation: hive-ring 1.8s ease-in-out infinite;
}
@keyframes hive-ring { 0%,100%{transform:scale(1);opacity:.7} 50%{transform:scale(1.12);opacity:.2} }
.hive-pending-count {
  position: absolute; top: -3px; right: -3px;
  width: 14px; height: 14px; background: #f87171;
  border-radius: 50%; border: 2px solid var(--navy);
  display: flex; align-items: center; justify-content: center;
  font-family: 'DM Mono', monospace; font-size: 8px; font-weight: 700; color: #fff; z-index: 2;
}

/* ── Views ── */
.hive-views {
  flex: 1; overflow: hidden; display: flex; flex-direction: column;
  min-height: 0; position: relative; z-index: 1;
}

/* ── ADVISOR VIEW (3-col, fixed) ── */
.hive-advisor-view {
  flex: 1; display: grid;
  grid-template-columns: 220px 1fr 200px;
  overflow: hidden; min-height: 0; height: 100%;
}

/* OC list column */
.oc-col {
  border-right: 1px solid rgba(125,211,252,.07);
  display: flex; flex-direction: column; overflow: hidden;
  background: rgba(3,12,26,.4);
}
.col-hdr {
  padding: 10px 12px 8px; border-bottom: 1px solid rgba(125,211,252,.07);
  display: flex; align-items: center; gap: 7px; flex-shrink: 0;
}
.col-hdr-title {
  font-family: 'Rajdhani', sans-serif; font-size: 10px; font-weight: 700;
  letter-spacing: .16em; text-transform: uppercase; color: rgba(125,211,252,.3); flex: 1;
}
.col-hdr-count {
  font-family: 'DM Mono', monospace; font-size: 9px; color: rgba(125,211,252,.2);
  border: 1px solid rgba(125,211,252,.07); padding: 1px 5px; border-radius: 4px;
}
.opt-ctrl-section {
  padding: 9px 12px 10px;
  border-bottom: 1px solid rgba(125,211,252,.07);
  flex-shrink: 0;
}
.opt-ctrl-label {
  font-family: 'Rajdhani', sans-serif; font-size: 8px; font-weight: 700;
  letter-spacing: .18em; text-transform: uppercase;
  color: rgba(125,211,252,.18); margin-bottom: 7px;
}
.opt-obj-row, .opt-fill-row {
  display: grid; grid-template-columns: 1fr 1fr; gap: 5px;
}
.opt-obj-btn, .opt-fill-btn {
  display: flex; flex-direction: column; align-items: flex-start;
  gap: 1px; border-radius: 8px; cursor: pointer; border: none;
  background: none; padding: 0; position: relative; overflow: hidden;
  width: 100%; text-align: left;
}
/* Objective button states */
.opt-obj-btn {
  padding: 7px 9px 8px; border: 1px solid rgba(125,211,252,.07);
  background: rgba(125,211,252,.02);
}
.obj-agg-active { background: rgba(251,146,60,.06) !important; border-color: rgba(251,146,60,.38) !important; }
.obj-eff-active { background: rgba(74,222,128,.05) !important; border-color: rgba(74,222,128,.32) !important; }
.obj-inactive   { background: rgba(125,211,252,.02); border-color: rgba(125,211,252,.07); }
.opt-obj-accent {
  position: absolute; top: 0; left: 0; right: 0; height: 2px;
  border-radius: 8px 8px 0 0;
}
.acc-agg { background: linear-gradient(90deg, rgba(251,146,60,.9) 0%, rgba(251,146,60,.15) 100%); }
.acc-eff { background: linear-gradient(90deg, rgba(74,222,128,.8) 0%, rgba(74,222,128,.12) 100%); }
.opt-obj-name {
  font-family: 'Rajdhani', sans-serif; font-size: 11px; font-weight: 700;
  letter-spacing: .06em; text-transform: uppercase; margin-top: 2px;
}
.name-agg { color: #fb923c; }
.name-eff { color: #4ade80; }
.name-dim { color: rgba(125,211,252,.2); }
.opt-obj-desc {
  font-family: 'Rajdhani', sans-serif; font-size: 8.5px; font-weight: 600;
  letter-spacing: .02em; line-height: 1.3;
}
.desc-agg { color: rgba(251,146,60,.5); }
.desc-eff { color: rgba(74,222,128,.42); }
.desc-dim { color: rgba(125,211,252,.1); }
/* Fill order button states */
.opt-fill-btn {
  padding: 6px 9px 7px; border-radius: 7px;
  border: 1px solid rgba(125,211,252,.07);
  background: rgba(125,211,252,.02); transition: all .12s;
}
.fill-active  { background: rgba(125,211,252,.07) !important; border-color: rgba(125,211,252,.2) !important; }
.fill-inactive { background: rgba(125,211,252,.02); border-color: rgba(125,211,252,.07); }
.opt-fill-name {
  font-family: 'Rajdhani', sans-serif; font-size: 10px; font-weight: 700;
  letter-spacing: .1em; text-transform: uppercase;
}
.fill-name-active { color: #7dd3fc; }
.fill-name-dim    { color: rgba(125,211,252,.2); }
.opt-fill-desc {
  font-family: 'Rajdhani', sans-serif; font-size: 8px; font-weight: 600;
  letter-spacing: .02em;
}
.fill-desc-active { color: rgba(125,211,252,.38); }
.fill-desc-dim    { color: rgba(125,211,252,.1); }
.oc-search {
  margin: 7px 9px 4px; height: 28px;
  background: rgba(125,211,252,.04); border: 1px solid rgba(125,211,252,.07);
  border-radius: 7px; padding: 0 10px; font-family: 'Inter', sans-serif; font-size: 11px;
  color: var(--ctext); outline: none; flex-shrink: 0;
}
.oc-search::placeholder { color: rgba(125,211,252,.2); }
.oc-search:focus { border-color: rgba(125,211,252,.28); }
.oc-sect-lbl {
  font-family: 'DM Mono', monospace; font-size: 9px; color: rgba(125,211,252,.22);
  letter-spacing: .12em; text-transform: uppercase; padding: 7px 11px 3px; flex-shrink: 0;
}
.oc-scroll { flex: 1; overflow-y: auto; padding: 2px 6px 4px; scrollbar-width: thin; scrollbar-color: rgba(125,211,252,.07) transparent; }
.oci {
  display: flex; align-items: center; gap: 8px; padding: 7px 7px; border-radius: 8px;
  cursor: pointer; transition: all .12s; border: 1px solid transparent; margin-bottom: 2px;
}
.oci:hover { background: rgba(125,211,252,.04); border-color: rgba(125,211,252,.07); }
.oci.sel  { background: rgba(0,50,160,.16); border-color: rgba(125,211,252,.18); }
.oci-lvl {
  width: 28px; height: 28px; border-radius: 7px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-family: 'Rajdhani', sans-serif; font-size: 11px; font-weight: 700;
}
.l1,.l2  { background:rgba(74,222,128,.08);  color:#4ade80; border:1px solid rgba(74,222,128,.18); }
.l3,.l4  { background:rgba(96,165,250,.08);  color:#60a5fa; border:1px solid rgba(96,165,250,.18); }
.l5,.l6  { background:rgba(251,191,36,.08);  color:#fbbf24; border:1px solid rgba(251,191,36,.18); }
.l7,.l8  { background:rgba(248,113,113,.08); color:#f87171; border:1px solid rgba(248,113,113,.18); }
.l9,.l10 { background:rgba(192,132,252,.08); color:#c084fc; border:1px solid rgba(192,132,252,.18); }
.oci-body { flex: 1; min-width: 0; }
.oci-name { font-size: 12px; font-weight: 500; color: var(--ctext); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.oci-pips { display: flex; gap: 2px; margin-top: 3px; }
.pip { width: 6px; height: 6px; border-radius: 2px; }
.p-c { background: var(--red); }
.p-i { background: var(--amber); opacity: .75; }
.p-f { background: rgba(125,211,252,.28); }
.p-p { background: var(--amber); animation: blink 1.6s ease-in-out infinite; }
.p-e { background: rgba(125,211,252,.06); border: 1px solid rgba(125,211,252,.15); }
.oci-right { flex-shrink: 0; text-align: right; }
.oci-pct { font-family: 'Rajdhani', sans-serif; font-size: 14px; font-weight: 700; line-height: 1; }
.pg { color: var(--green); } .pw { color: var(--amber); }
.pb { color: var(--red); opacity: .6; } .pn { color: rgba(125,211,252,.2); font-size: 11px; }
.oci-sub { font-size: 9px; margin-top: 2px; white-space: nowrap; }

/* Detail column */
.det-col { display: flex; flex-direction: column; overflow: hidden; background: var(--navy); }
.det-hdr {
  padding: 15px 20px 13px; border-bottom: 1px solid rgba(125,211,252,.07);
  flex-shrink: 0; background: rgba(3,12,26,.3);
}
.det-name { font-family: 'Rajdhani', sans-serif; font-size: 22px; font-weight: 800; color: #fff; letter-spacing: -.01em; line-height: 1; }
.det-row2 { display: flex; align-items: center; gap: 9px; margin-top: 7px; }
.det-badge {
  font-family: 'DM Mono', monospace; font-size: 9px; font-weight: 500;
  padding: 2px 7px; border-radius: 4px; text-transform: uppercase; letter-spacing: .07em;
}
.db-lv5  { background:rgba(251,191,36,.1);  color:#fbbf24; border:1px solid rgba(251,191,36,.2); }
.db-lv1  { background:rgba(74,222,128,.08); color:#4ade80; border:1px solid rgba(74,222,128,.15); }
.db-lv9  { background:rgba(192,132,252,.08);color:#c084fc; border:1px solid rgba(192,132,252,.15); }
.db-rec  { background:rgba(74,222,128,.07); color:#4ade80; border:1px solid rgba(74,222,128,.15); }
.db-plan { background:rgba(248,113,113,.07);color:#f87171; border:1px solid rgba(248,113,113,.15); }
.det-success { display: flex; align-items: center; gap: 16px; margin-top: 11px; }
.det-pct { font-family: 'Rajdhani', sans-serif; font-size: 34px; font-weight: 700; line-height: 1; letter-spacing: -.02em; flex-shrink: 0; }
.det-bar-area { flex: 1; }
.det-bar { height: 6px; background: rgba(125,211,252,.06); border-radius: 3px; overflow: hidden; }
.det-bar-fill { height: 100%; border-radius: 3px; transition: width .4s ease; }
.dbg { background: linear-gradient(90deg,#14532d,#4ade80); }
.dbw { background: linear-gradient(90deg,#78350f,#fbbf24); }
.dbb { background: linear-gradient(90deg,#7f1d1d,#f87171); }
.det-bar-lbl { font-size: 9px; color: rgba(125,211,252,.28); margin-top: 4px; letter-spacing: .05em; }
.slots-area { flex: 1; overflow-y: auto; padding: 13px 20px; scrollbar-width: thin; scrollbar-color: rgba(125,211,252,.07) transparent; }

/* Slot rows */
.slot-r {
  display: grid; grid-template-columns: 3px 90px 1fr 46px 12px 28px;
  align-items: center; gap: 0 10px; padding: 10px 8px; border-radius: 8px;
  background: rgba(3,10,22,.45); border: 1px solid rgba(125,211,252,.06);
  margin-bottom: 4px; transition: all .13s; cursor: pointer; position: relative;
}
.slot-r:hover { border-color: rgba(125,211,252,.14); }
.slot-r:hover .sl-swap { opacity: 1; }
.sl-stripe { width: 3px; height: 100%; border-radius: 2px; align-self: stretch; }
.ss-c { background: linear-gradient(180deg, var(--red), rgba(248,113,113,.15)); }
.ss-i { background: linear-gradient(180deg, var(--amber), rgba(251,191,36,.15)); }
.ss-f { background: rgba(125,211,252,.1); }
.sl-role { display: flex; flex-direction: column; gap: 3px; }
.sl-role-name { font-family: 'Rajdhani', sans-serif; font-size: 11px; font-weight: 700; color: rgba(125,211,252,.55); text-transform: uppercase; letter-spacing: .07em; white-space: nowrap; }
.sl-tier { font-family: 'DM Mono', monospace; font-size: 8px; padding: 1px 5px; border-radius: 3px; display: inline-block; width: fit-content; text-transform: uppercase; letter-spacing: .06em; }
.st-c { background:rgba(248,113,113,.1); color:var(--red); border:1px solid rgba(248,113,113,.2); }
.st-i { background:rgba(251,191,36,.1);  color:var(--amber); border:1px solid rgba(251,191,36,.18); }
.st-f { background:rgba(125,211,252,.05);color:rgba(125,211,252,.3); border:1px solid rgba(125,211,252,.08); }
.sl-name { font-size: 13px; font-weight: 500; color: #e8f4ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sl-name.empty { color: rgba(125,211,252,.22); font-style: italic; font-size: 11px; }
.sl-name.pend  { color: var(--amber); }
.sl-cpr { font-family: 'Rajdhani', sans-serif; font-size: 16px; font-weight: 700; text-align: right; line-height: 1; }
.c-hi { color: var(--green); } .c-ok { color: var(--cyan); } .c-lo { color: var(--amber); } .c-na { color: rgba(125,211,252,.2); font-size: 12px; }
.sl-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.sd-ok { background: var(--green); box-shadow: 0 0 6px rgba(74,222,128,.45); }
.sd-pe { background: var(--amber); animation: blink 1.6s infinite; }
.sd-no { background: rgba(125,211,252,.06); border: 1px solid rgba(125,211,252,.15); }
.sl-swap {
  width: 28px; height: 28px; border-radius: 7px;
  background: rgba(125,211,252,.05); border: 1px solid rgba(125,211,252,.08);
  color: rgba(125,211,252,.3); font-size: 12px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; opacity: 0; transition: all .12s;
}
.sl-swap:hover { background: rgba(125,211,252,.1); border-color: rgba(125,211,252,.28); color: var(--cyan); opacity: 1 !important; }

/* Swap popover */
.swap-pop {
  position: absolute; right: 0; top: calc(100% + 5px);
  width: 270px; background: #030c1a;
  border: 1px solid var(--cyan3); border-radius: 10px;
  box-shadow: 0 16px 50px rgba(0,0,0,.8); z-index: 500; overflow: hidden;
}
.sp-head { padding: 10px 14px 8px; border-bottom: 1px solid var(--cyan5); display: flex; align-items: center; justify-content: space-between; }
.sp-head-lbl { font-family: 'Rajdhani', sans-serif; font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--cyan3); }
.sp-head-role { font-family: 'DM Mono', monospace; font-size: 9px; color: var(--amber); }
.sp-opts { max-height: 185px; overflow-y: auto; padding: 4px; }
.sp-opt { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 7px; cursor: pointer; transition: background .1s; border: 1px solid transparent; }
.sp-opt:hover { background: var(--cyan6); border-color: var(--cyan5); }
.sp-opt.curr { background: rgba(0,50,160,.15); border-color: var(--cyan4); }
.sp-av { width: 28px; height: 28px; border-radius: 7px; background: var(--cyan5); border: 1px solid var(--cyan4); display: flex; align-items: center; justify-content: center; font-family: 'Rajdhani', sans-serif; font-size: 11px; font-weight: 700; color: var(--cyan); flex-shrink: 0; }
.sp-info { flex: 1; min-width: 0; }
.sp-name { font-size: 12.5px; font-weight: 500; color: var(--ctext); }
.sp-from { font-size: 10px; color: var(--cyan3); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp-cpr { font-family: 'Rajdhani', sans-serif; font-size: 15px; font-weight: 700; flex-shrink: 0; }
.sp-curr-tag { font-family: 'DM Mono', monospace; font-size: 8px; color: var(--cyan); background: var(--cyan5); padding: 1px 5px; border-radius: 3px; border: 1px solid var(--cyan4); }
.sp-foot { padding: 7px; border-top: 1px solid var(--cyan5); }
.sp-remove { width: 100%; padding: 7px; background: rgba(239,68,68,.06); border: 1px solid rgba(239,68,68,.15); border-radius: 7px; color: var(--red); font-family: 'Rajdhani', sans-serif; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; cursor: pointer; transition: all .12s; }
.sp-remove:hover { background: rgba(239,68,68,.14); }

/* Queue column */
.queue-col { border-left: 1px solid rgba(125,211,252,.07); display: flex; flex-direction: column; overflow: hidden; background: rgba(3,12,26,.4); }
.q-scroll  { flex: 1; overflow-y: auto; padding: 4px 7px; scrollbar-width: thin; scrollbar-color: rgba(125,211,252,.07) transparent; }
.q-sect    { font-family: 'DM Mono', monospace; font-size: 9px; color: rgba(125,211,252,.22); letter-spacing: .1em; text-transform: uppercase; padding: 8px 6px 4px; }
.q-item    { display: flex; align-items: center; gap: 8px; padding: 7px 7px; border-radius: 8px; cursor: pointer; transition: all .12s; border: 1px solid transparent; margin-bottom: 2px; }
.q-item:hover { background: rgba(125,211,252,.04); border-color: rgba(125,211,252,.07); }
.q-av  { width: 28px; height: 28px; border-radius: 7px; background: rgba(125,211,252,.1); border: 1px solid rgba(125,211,252,.18); display: flex; align-items: center; justify-content: center; font-family: 'Rajdhani', sans-serif; font-size: 11px; font-weight: 700; color: #7dd3fc; flex-shrink: 0; }
.q-info { flex: 1; min-width: 0; }
.q-name  { font-size: 12px; font-weight: 500; color: var(--ctext); }
.q-role  { font-size: 10px; color: rgba(125,211,252,.3); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.q-cpr   { font-family: 'Rajdhani', sans-serif; font-size: 14px; font-weight: 700; flex-shrink: 0; }

/* Sub views */
.hive-sub-view { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
.hive-sub-body { flex: 1; overflow-y: auto; padding: 20px 24px; scrollbar-width: thin; scrollbar-color: rgba(125,211,252,.07) transparent; }

/* History stats */
.h-stats { display: grid; grid-template-columns: repeat(3,1fr); gap: 10px; margin-bottom: 18px; }
.hsc { background: rgba(3,12,26,.5); border: 1px solid rgba(125,211,252,.07); border-radius: 11px; padding: 15px 17px; position: relative; overflow: hidden; }
.hsc::before { content:''; position:absolute; top:0; left:0; right:0; height:2px; border-radius:2px 2px 0 0; }
.hg::before { background:linear-gradient(90deg,transparent,#4ade80,transparent); }
.hb::before { background:linear-gradient(90deg,transparent,#60a5fa,transparent); }
.ha::before { background:linear-gradient(90deg,transparent,#fbbf24,transparent); }
.hsc-num { font-family:'Rajdhani',sans-serif; font-size:32px; font-weight:700; line-height:1; }
.hsc-lbl { font-family:'Rajdhani',sans-serif; font-size:10px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:rgba(125,211,252,.28); margin-top:4px; }
.hsc-sub { font-size:10px; color:rgba(125,211,252,.22); margin-top:2px; }
.chart-card { background:rgba(3,12,26,.5); border:1px solid rgba(125,211,252,.07); border-radius:11px; padding:15px 18px; margin-bottom:12px; }

/* Roster */
.hive-sub-sect-title { font-family:'Rajdhani',sans-serif; font-size:10px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:rgba(125,211,252,.28); }
.r-toolbar { display:flex; gap:8px; margin-bottom:14px; }
.r-search  { flex:1; height:34px; background:rgba(125,211,252,.04); border:1px solid rgba(125,211,252,.07); border-radius:8px; padding:0 12px; font-family:'Inter',sans-serif; font-size:12px; color:var(--ctext); outline:none; transition:border-color .13s; }
.r-search::placeholder { color:rgba(125,211,252,.22); }
.r-search:focus { border-color:rgba(125,211,252,.28); }
.r-sort  { height:34px; padding:0 10px; background:rgba(125,211,252,.04); border:1px solid rgba(125,211,252,.07); border-radius:8px; font-family:'Inter',sans-serif; font-size:11px; color:rgba(125,211,252,.5); cursor:pointer; outline:none; }
.r-tbl   { width:100%; border-collapse:collapse; }
.r-tbl th { font-family:'Rajdhani',sans-serif; font-size:10px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:rgba(125,211,252,.28); padding:0 10px 10px; text-align:left; border-bottom:1px solid rgba(125,211,252,.07); }
.r-row { cursor:pointer; transition:background .1s; border-bottom:1px solid rgba(125,211,252,.03); }
.r-row:hover td { background:rgba(125,211,252,.04); }
.r-row td { padding:9px 10px; vertical-align:middle; }
.r-row td:last-child { padding-left:20px; white-space:nowrap; }
.r-nm  { font-size:13px; font-weight:500; color:var(--ctext); }
.r-av  { width:32px; height:32px; border-radius:8px; display:flex; align-items:center; justify-content:center; font-family:'Rajdhani',sans-serif; font-size:12px; font-weight:700; }
/* r-av uses the same l1-l10 colour classes as oci-lvl */
.bar-w { display:flex; align-items:center; gap:7px; }
.bar   { flex:1; height:4px; background:rgba(125,211,252,.06); border-radius:2px; overflow:hidden; }
.bar-f { height:100%; border-radius:2px; }
.bar-v { font-family:'DM Mono',monospace; font-size:10px; min-width:28px; text-align:right; }
.sbadge { font-size:10px; padding:2px 7px; border-radius:4px; font-family:'DM Mono',monospace; white-space:nowrap; display:inline-block; }
.sb-in { background:rgba(74,222,128,.08); color:#4ade80; border:1px solid rgba(74,222,128,.18); }
.sb-av { background:rgba(125,211,252,.04); color:rgba(125,211,252,.5); border:1px solid rgba(125,211,252,.07); }
.sb-pe { background:rgba(251,191,36,.08); color:#fbbf24; border:1px solid rgba(251,191,36,.18); }
.sb-nd { background:rgba(248,113,113,.08); color:#f87171; border:1px solid rgba(248,113,113,.18); }
.sync-btn { display:flex; align-items:center; gap:8px; margin-top:14px; padding:8px 16px; background:rgba(125,211,252,.04); border:1px solid rgba(125,211,252,.1); border-radius:8px; color:rgba(125,211,252,.6); font-family:'Rajdhani',sans-serif; font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; cursor:pointer; transition:all .13s; width:fit-content; }
.sync-btn:hover { background:rgba(125,211,252,.08); border-color:rgba(125,211,252,.22); color:#7dd3fc; }

/* History import */
.hist-import-wrap { display:flex; flex-direction:column; align-items:center; gap:16px; padding:32px 20px; }
.hist-import-btn {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 28px;
  background: linear-gradient(135deg, rgba(0,50,180,.5), rgba(0,90,240,.3));
  border: 1px solid rgba(125,211,252,.3); border-radius: 10px;
  color: #7dd3fc; font-family: 'Rajdhani', sans-serif; font-size: 14px;
  font-weight: 700; letter-spacing: .12em; text-transform: uppercase;
  cursor: pointer; transition: all .16s;
  box-shadow: 0 4px 20px rgba(0,80,255,.15);
}
.hist-import-btn:hover {
  background: linear-gradient(135deg, rgba(0,70,200,.6), rgba(0,110,255,.4));
  border-color: rgba(125,211,252,.5); box-shadow: 0 6px 28px rgba(0,80,255,.25);
  transform: translateY(-1px);
}
.hist-import-btn:disabled {
  opacity: .5; cursor: not-allowed; transform: none;
}
.hist-import-sub { font-size:10px; color:rgba(125,211,252,.25); text-align:center; line-height:1.6; }
.hist-result-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 0; border-bottom: 1px solid rgba(125,211,252,.05);
  font-size: 11px;
}
.hist-result-row:last-child { border-bottom: none; }
.hist-oc-name { flex: 1; color: var(--ctext); font-weight: 500; }
.hist-oc-date { font-family: 'DM Mono', monospace; font-size: 9px; color: rgba(125,211,252,.25); }
.hist-oc-money { font-family: 'DM Mono', monospace; font-size: 10px; color: var(--green); min-width: 70px; text-align: right; }
.hist-status-pill {
  font-family: 'Rajdhani', sans-serif; font-size: 9px; font-weight: 700;
  letter-spacing: .07em; padding: 1px 7px; border-radius: 4px;
}
.hist-status-pill.ok  { background: rgba(74,222,128,.08); color: var(--green); border: 1px solid rgba(74,222,128,.18); }
.hist-status-pill.fail { background: rgba(239,68,68,.08); color: var(--red); border: 1px solid rgba(239,68,68,.18); }

/* Coverage */
.cov-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.cov-levels { display:flex; flex-direction:column; gap:8px; }
.cov-lvl-card { background:rgba(125,211,252,.04); border:1px solid rgba(125,211,252,.08); border-radius:8px; padding:10px 12px; }
.cov-lvl-hdr { display:flex; align-items:center; gap:10px; }
.cov-role-gaps { margin-top:6px; display:flex; flex-direction:column; gap:2px; }
.cov-role-row { display:flex; justify-content:space-between; align-items:center; padding:2px 4px; font-size:10px; }
.cov-role-name { color:rgba(125,211,252,.5); }
.cov-role-cnt { font-weight:600; min-width:20px; text-align:right; }
.cov-card { background:rgba(3,12,26,.5); border:1px solid rgba(125,211,252,.07); border-radius:10px; overflow:hidden; }
.cov-hdr  { padding:11px 14px; border-bottom:1px solid rgba(125,211,252,.07); font-family:'Rajdhani',sans-serif; font-size:11px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; display:flex; align-items:center; justify-content:space-between; }
.cov-hdr span { font-family:'DM Mono',monospace; font-size:10px; }
.cov-item { display:flex; align-items:center; gap:10px; padding:9px 14px; border-bottom:1px solid rgba(125,211,252,.04); transition:background .1s; cursor:pointer; }
.cov-item:hover { background:rgba(125,211,252,.03); }
.cov-item:last-child { border-bottom:none; }
.cov-oc  { font-size:12.5px; font-weight:500; color:var(--ctext); }
.cov-rl  { font-size:10px; color:rgba(125,211,252,.3); margin-top:2px; }
.cov-bar { width:60px; height:4px; background:rgba(125,211,252,.06); border-radius:2px; overflow:hidden; }
.cov-bar-f { height:100%; border-radius:2px; }
.cov-cnt { font-family:'Rajdhani',sans-serif; font-size:18px; font-weight:700; text-align:right; min-width:24px; }

/* Assignment banner floating */
.hive-advisor-banner {
  position: absolute; bottom: 0; left: 0; right: 0;
  background: rgba(245,158,11,.06); border-top: 1px solid rgba(245,158,11,.2);
  padding: 8px 16px; z-index: 5;
}
.hive-advisor-banner-inner { display:flex; align-items:center; gap:10px; }
.hive-banner-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
.hive-advisor-banner-text { flex:1; font-size:12px; color:var(--ctext); }
.hive-banner-jump { padding:5px 12px; background:rgba(34,211,238,.1); border:1px solid rgba(34,211,238,.25); border-radius:6px; color:var(--cyan); font-family:'Rajdhani',sans-serif; font-size:11px; font-weight:700; cursor:pointer; }
.hive-banner-dismiss { background:none; border:none; color:rgba(125,211,252,.35); font-size:13px; cursor:pointer; padding:0 4px; }

/* Assign rows */
.hive-assign-row { display:flex; justify-content:space-between; align-items:center; background:rgba(4,11,20,.6); border:1px solid rgba(100,180,255,.1); border-radius:8px; padding:8px 10px; margin-bottom:6px; }
.hive-assign-info .hive-assign-name { font-size:11px; font-weight:700; color:var(--ctext); }
.hive-assign-info .hive-assign-detail { font-size:9px; color:rgba(125,211,252,.35); margin-top:2px; }
.hive-assign-actions { display:flex; gap:5px; }
.hive-msg-btn { background:rgba(13,26,46,1); border:1px solid rgba(34,211,238,.33); border-radius:4px; color:var(--cyan); font-size:12px; padding:3px 7px; text-decoration:none; }
.hive-clear-btn { background:#1a0d0d; border:1px solid rgba(231,76,60,.44); border-radius:4px; color:var(--red); font-size:11px; padding:3px 7px; cursor:pointer; }

/* Feedback modal */
.fb-body { padding:20px 22px; }
.fb-intro { font-size:13px; color:rgba(125,211,252,.45); line-height:1.6; margin-bottom:18px; }
.fb-types { display:flex; gap:6px; margin-bottom:14px; }
.fb-type  { padding:7px 15px; font-family:'Rajdhani',sans-serif; font-size:11px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; background:rgba(125,211,252,.04); border:1px solid rgba(125,211,252,.07); border-radius:8px; color:rgba(125,211,252,.32); cursor:pointer; transition:all .13s; }
.fb-type:hover { color:rgba(125,211,252,.65); border-color:rgba(125,211,252,.18); }
.fb-type.sel { background:rgba(125,211,252,.08); border-color:rgba(125,211,252,.26); color:#7dd3fc; }
.fb-ta    { width:100%; background:rgba(125,211,252,.04); border:1px solid rgba(125,211,252,.07); border-radius:10px; padding:12px 14px; font-family:'Inter',sans-serif; font-size:12.5px; color:var(--ctext); resize:vertical; min-height:96px; outline:none; transition:border-color .13s; line-height:1.6; }
.fb-ta::placeholder { color:rgba(125,211,252,.2); }
.fb-ta:focus { border-color:rgba(125,211,252,.26); }
.fb-footer { display:flex; align-items:center; justify-content:space-between; margin-top:12px; padding-top:13px; border-top:1px solid rgba(125,211,252,.07); }
.fb-from  { font-family:'DM Mono',monospace; font-size:10px; color:rgba(125,211,252,.22); }
.btn-prime { padding:9px 20px; background:linear-gradient(135deg,rgba(0,60,200,.48),rgba(0,100,255,.28)); border:1px solid rgba(125,211,252,.26); border-radius:9px; color:#7dd3fc; font-family:'Rajdhani',sans-serif; font-size:13px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; cursor:pointer; transition:all .14s; }
.btn-prime:hover { background:linear-gradient(135deg,rgba(0,80,220,.58),rgba(0,120,255,.38)); }

/* Settings modal */
.set-grid  { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding:20px 22px; }
.set-card  { background:rgba(3,12,26,.55); border:1px solid rgba(125,211,252,.07); border-radius:10px; overflow:hidden; }
.set-card-hdr  { padding:11px 15px; border-bottom:1px solid rgba(125,211,252,.07); font-family:'Rajdhani',sans-serif; font-size:10px; font-weight:700; letter-spacing:.16em; text-transform:uppercase; color:rgba(125,211,252,.28); }
.set-card-body { padding:13px 15px; }
.key-row  { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
.key-tag  { font-family:'Rajdhani',sans-serif; font-size:9px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; padding:3px 8px; border-radius:4px; min-width:48px; text-align:center; }
.kt-l { background:rgba(125,211,252,.07); color:#7dd3fc; border:1px solid rgba(125,211,252,.17); }
.kt-m { background:rgba(74,222,128,.06); color:#4ade80; border:1px solid rgba(74,222,128,.17); }
.key-in   { flex:1; height:32px; background:rgba(125,211,252,.04); border:1px solid rgba(125,211,252,.07); border-radius:7px; padding:0 10px; font-family:'DM Mono',monospace; font-size:11px; color:rgba(125,211,252,.6); outline:none; transition:border-color .13s; }
.key-in:focus { border-color:rgba(125,211,252,.28); }
.key-dot  { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
.kd-ok { background:#4ade80; box-shadow:0 0 5px rgba(74,222,128,.4); }
.kd-no { background:rgba(125,211,252,.1); border:1px solid rgba(125,211,252,.18); }

/* Modal base */
.hive-modal-bg { position:fixed; inset:0; background:rgba(1,4,12,.8); backdrop-filter:blur(10px); z-index:2147483640; display:none; align-items:center; justify-content:center; }
.hive-modal-bg[style*="flex"] { display:flex !important; }
.hive-modal { background:#040d1e; border:1px solid rgba(125,211,252,.18); border-radius:14px; box-shadow:0 28px 80px rgba(0,0,0,.85); overflow:hidden; position:relative; }
.hive-modal::before { content:''; position:absolute; top:0; left:0; right:0; height:1px; background:linear-gradient(90deg,transparent,rgba(125,211,252,.28),transparent); }
.hive-modal-hdr { padding:17px 22px 13px; border-bottom:1px solid rgba(125,211,252,.07); display:flex; align-items:center; justify-content:space-between; }
.hive-modal-title { font-family:'Rajdhani',sans-serif; font-size:17px; font-weight:800; color:#fff; }
.hive-modal-x { width:28px; height:28px; background:rgba(125,211,252,.04); border:1px solid rgba(125,211,252,.07); border-radius:7px; color:rgba(125,211,252,.38); display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:13px; transition:all .13s; }
.hive-modal-x:hover { background:rgba(125,211,252,.08); color:#7dd3fc; }
.fb-modal { width:520px; }
.set-modal { width:600px; max-height:80vh; overflow-y:auto; scrollbar-width:thin; scrollbar-color:rgba(125,211,252,.07) transparent; }

/* Settings buttons */
.hive-btn-primary { background:rgba(13,30,58,1); border:1px solid rgba(34,211,238,.27); border-radius:5px; color:var(--cyan); font-size:10px; font-weight:700; padding:5px 12px; cursor:pointer; font-family:'Rajdhani',sans-serif; letter-spacing:.07em; transition:all .14s; }
.hive-btn-primary:hover { background:rgba(34,211,238,.15); }

/* Toast */
#hive-toast { position:fixed; bottom:80px; right:16px; z-index:9999999; background:linear-gradient(135deg,rgba(4,11,20,.98),rgba(5,14,28,.96)); border:1px solid rgba(34,211,238,.55); border-radius:10px; padding:12px 16px; min-width:240px; box-shadow:0 8px 32px rgba(0,0,0,.8); font-family:'DM Sans',system-ui,sans-serif; }
.hive-toast-label { font-size:9px; font-weight:700; letter-spacing:1.5px; color:var(--cyan); margin-bottom:6px; }
.hive-toast-role  { font-size:13px; font-weight:700; color:var(--ctext); margin-bottom:2px; }
.hive-toast-sub   { font-size:10px; color:rgba(125,211,252,.5); margin-bottom:8px; }
.hive-toast-actions { display:flex; gap:6px; }
#hive-toast-open { flex:1; background:rgba(13,30,58,1); border:1px solid rgba(34,211,238,.27); border-radius:6px; color:var(--cyan); font-size:10px; font-weight:700; padding:5px; cursor:pointer; }
#hive-toast-dismiss { background:#1a0d0d; border:1px solid rgba(231,76,60,.44); border-radius:6px; color:var(--red); font-size:10px; padding:5px 8px; cursor:pointer; }

/* UI toast */
#hive-ui-toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%) translateY(12px); z-index:9999999; background:rgba(4,14,28,.97); border:1px solid rgba(34,211,238,.55); border-radius:8px; padding:7px 18px; font-family:'DM Mono',monospace; font-size:11px; color:var(--cyan); pointer-events:none; opacity:0; transition:opacity .2s,transform .2s; white-space:nowrap; }
#hive-ui-toast.visible { opacity:1; transform:translateX(-50%) translateY(0); }

/* Panel tooltip */
.hive-tip { cursor:help; }
#hive-tooltip { position:fixed; z-index:2147483647; pointer-events:none; display:none; background:#070e1e; border:1px solid rgba(34,211,238,.4); border-radius:8px; color:var(--ctext); font-size:10px; padding:10px 13px; max-width:270px; line-height:1.65; box-shadow:0 8px 28px rgba(0,0,0,.9); }
#hive-tooltip .tip-line0 { font-weight:700; color:var(--cyan); font-size:11px; padding-bottom:5px; margin-bottom:5px; border-bottom:1px solid rgba(34,211,238,.2); }
#hive-tooltip .tip-crit { color:#ff6b6b; }
#hive-tooltip .tip-safe { color:#2ecc71; }
#hive-tooltip .tip-mid  { color:#ffd740; }
#hive-tooltip .tip-cpr  { color:rgba(125,211,252,.7); font-size:9px; }

@keyframes blink { 0%,100%{opacity:1} 50%{opacity:.2} }
@keyframes hive-pulse { 0%,100%{opacity:1}50%{opacity:.25} }
    `;
    document.head.appendChild(s);
  }

  // ═══════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════

  function init() {
    injectStyles();
    buildToggleBtn();

    _ocaKey   = localStorage.getItem('hive-oc-key') || '';
    _tsApiKey = localStorage.getItem('hive-ts-key') || '';
    initKeyState();

    setTimeout(() => {
      refresh();
      observe();
      initTooltip();
      loadRoleColors();

      if (_tornKey) loadFactionRoster(() => scheduleOptimize());
      if (_tsApiKey) loadTornStats();

      // Member CPR push — runs if member has both a member OCA key and a Torn key
      if (_memberOcaKey && _tornKey) loadMemberAPICPR();

      if (_isLeader) {
        loadFactionAssignments();
        loadAllCPR();
        loadPayoutModel();
      }

      restartPolling();
    }, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
