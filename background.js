// background.js - Service worker with persistent WebSocket

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ ping: true }));
    } else {
      tryReconnect();
    }
  }
});

// --- WebSocket state ---
let ws = null;
let reconnectTimer = null;
let currentIp = null;

function connect(ip) {
  if (!ip) return;
  currentIp = ip;
  if (ws) { ws.onclose = null; ws.onerror = null; ws.close(); ws = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  try { ws = new WebSocket(`ws://${ip}:8765`); }
  catch (e) { setWsStatus('disconnected'); scheduleReconnect(); return; }

  ws.onopen = () => {
    setWsStatus('connected');
  };

  ws.onmessage = (event) => {
    let parsed;
    try { parsed = JSON.parse(event.data); } catch (e) { return; }
    if (parsed.ping) return;

    // Merge into storage
    chrome.storage.local.get(['isOn', 'fdOdds', 'dkOdds', 'base', 'fdSuspended', 'dkSuspended', 'dkBetPlaced', 'fdMaxWager'], (data) => {
      const updated = {
        isOn:        parsed.isOn        !== undefined ? parsed.isOn        : (data.isOn        ?? false),
        fdOdds:      parsed.fdOdds      !== undefined ? parsed.fdOdds      : (data.fdOdds      ?? null),
        dkOdds:      parsed.dkOdds      !== undefined ? parsed.dkOdds      : (data.dkOdds      ?? null),
        base:        parsed.base        !== undefined ? parsed.base        : (data.base        ?? 100),
        fdSuspended: parsed.fdSuspended !== undefined ? parsed.fdSuspended : (data.fdSuspended ?? false),
        dkSuspended: parsed.dkSuspended !== undefined ? parsed.dkSuspended : (data.dkSuspended ?? false),
        dkBetPlaced: parsed.dkBetPlaced !== undefined ? parsed.dkBetPlaced : (data.dkBetPlaced ?? null),
        fdMaxWager:  parsed.fdMaxWager  !== undefined ? parsed.fdMaxWager  : (data.fdMaxWager  ?? null),
      };
      if (parsed.color !== undefined) updated.lastColor = parsed.color;
      chrome.storage.local.set(updated);
      broadcastToTabs({ type: 'STATE_UPDATE', ...updated, color: parsed.color });

      // Auto-fill stakes if arb — only fill FD once fdMaxWager is known to avoid filling uncapped amount
      const fd = updated.fdOdds;
      const dk = updated.dkOdds;
      if (fd && dk && !updated.fdSuspended && !updated.dkSuspended && updated.fdMaxWager !== null) {
        const arbResult = checkArb(fd, dk, updated.base, updated.fdMaxWager);
        if (arbResult && arbResult.total < 1.0 && arbResult.stake1 > 0 && arbResult.stake2 > 0) {
          chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
              if (!tab.url) continue;
              if (tab.url.includes('draftkings.'))
                chrome.tabs.sendMessage(tab.id, { type: 'FILL_DK_STAKE', amount: arbResult.stake2 }).catch(() => {});
              if (tab.url.includes('fanduel.'))
                chrome.tabs.sendMessage(tab.id, { type: 'FILL_FD_STAKE', amount: arbResult.stake1 }).catch(() => {});
            }
          });
        }
      }
    });
  };

  ws.onclose = () => {
    setWsStatus('disconnected');
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    setWsStatus('disconnected');
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (currentIp) connect(currentIp);
  }, 3000);
}

function tryReconnect() {
  if (!currentIp) {
    chrome.storage.local.get(['serverIp'], (data) => {
      if (data.serverIp) connect(data.serverIp);
    });
  } else {
    connect(currentIp);
  }
}

function setWsStatus(status) {
  chrome.storage.local.set({ wsStatus: status });
  // Notify any open popups
  chrome.runtime.sendMessage({ type: 'WS_STATUS', status }).catch(() => {});
}

function wsSend(payload) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
}

// --- Init: restore IP on startup ---
chrome.storage.local.get(['serverIp'], (data) => {
  if (data.serverIp) connect(data.serverIp);
});

// --- Message handler ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CONNECT') {
    connect(message.ip);
    chrome.storage.local.set({ serverIp: message.ip });

  } else if (message.type === 'STATE_UPDATE') {
    chrome.storage.local.set({
      isOn:      message.isOn      ?? false,
      fdOdds:    message.fdOdds    ?? null,
      dkOdds:    message.dkOdds    ?? null,
      base:      message.base      ?? 100,
    });
    broadcastToTabs(message);
    wsSend(message);

  } else if (message.type === 'ODDS_UPDATE') {
    const key          = message.book === 'fd' ? 'fdOdds'      : 'dkOdds';
    const suspendedKey = message.book === 'fd' ? 'fdSuspended' : 'dkSuspended';
    chrome.storage.local.get(['isOn', 'fdOdds', 'dkOdds', 'base', 'fdSuspended', 'dkSuspended', 'fdMaxWager'], (data) => {
      const fdSuspended = message.book === 'fd' ? !!message.suspended : !!data.fdSuspended;
      const dkSuspended = message.book === 'dk' ? !!message.suspended : !!data.dkSuspended;
      const fdMaxWager  = message.book === 'fd' ? (message.maxWager ?? null) : (data.fdMaxWager ?? null);
      const updated = {
        isOn:        data.isOn   ?? false,
        fdOdds:      data.fdOdds ?? null,
        dkOdds:      data.dkOdds ?? null,
        base:        data.base   ?? 100,
        fdSuspended, dkSuspended, fdMaxWager,
        [key]: message.odds,
      };
      chrome.storage.local.set({ [key]: message.odds, [suspendedKey]: !!message.suspended, fdMaxWager });
      broadcastToTabs({ type: 'STATE_UPDATE', ...updated });
      wsSend({ type: 'STATE_UPDATE', ...updated });

      const fd = updated.fdOdds;
      const dk = updated.dkOdds;
      if (fd && dk && !fdSuspended && !dkSuspended && fdMaxWager !== null) {
        const arbResult = checkArb(fd, dk, updated.base, fdMaxWager);
        if (arbResult && arbResult.total < 1.0 && arbResult.stake1 > 0 && arbResult.stake2 > 0) {
          chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
              if (!tab.url) continue;
              if (tab.url.includes('draftkings.'))
                chrome.tabs.sendMessage(tab.id, { type: 'FILL_DK_STAKE', amount: arbResult.stake2 }).catch(() => {});
              if (tab.url.includes('fanduel.'))
                chrome.tabs.sendMessage(tab.id, { type: 'FILL_FD_STAKE', amount: arbResult.stake1 }).catch(() => {});
            }
          });
        }
      }
    });

  } else if (message.type === 'DK_BET_PLACED') {
    const bp = { wagered: message.wagered, payout: message.payout, impliedDkOdds: message.impliedDkOdds };
    // Use the receipt-derived odds as dkOdds so FD side auto-fills even if live odds disappeared
    chrome.storage.local.get(['fdOdds', 'base', 'fdSuspended', 'isOn'], (data) => {
      chrome.storage.local.set({ dkBetPlaced: bp, dkOdds: message.impliedDkOdds });
      broadcastToTabs({ type: 'STATE_UPDATE', dkBetPlaced: bp, dkOdds: message.impliedDkOdds });
      wsSend({ type: 'STATE_UPDATE', dkBetPlaced: bp, dkOdds: message.impliedDkOdds });

      // Auto-fill FD stake based on receipt amounts — hedges the already-placed DK bet
      const fd = data.fdOdds;
      if (fd && !data.fdSuspended) {
        const decFd = toDecimal(fd);
        const fdHedge = roundStake(bp.payout / decFd);
        chrome.tabs.query({}, (tabs) => {
          for (const tab of tabs) {
            if (tab.url && tab.url.includes('fanduel.'))
              chrome.tabs.sendMessage(tab.id, { type: 'FILL_FD_STAKE', amount: fdHedge }).catch(() => {});
          }
        });
      }
    });

  } else if (message.type === 'DK_BET_CLEARED') {
    chrome.storage.local.remove('dkBetPlaced');
    broadcastToTabs({ type: 'STATE_UPDATE', dkBetPlaced: null });
    wsSend({ type: 'STATE_UPDATE', dkBetPlaced: null });

  } else if (message.type === 'GET_STATE') {
    chrome.storage.local.get(['isOn', 'fdOdds', 'dkOdds', 'base', 'fdSuspended', 'dkSuspended', 'dkBetPlaced', 'fdMaxWager'], (data) => {
      sendResponse({
        isOn:        data.isOn        ?? false,
        fdOdds:      data.fdOdds      ?? null,
        dkOdds:      data.dkOdds      ?? null,
        base:        data.base        ?? 100,
        fdSuspended: data.fdSuspended ?? false,
        dkSuspended: data.dkSuspended ?? false,
        dkBetPlaced: data.dkBetPlaced ?? null,
        fdMaxWager:  data.fdMaxWager  ?? null,
      });
    });
    return true;

  } else if (message.type === 'GET_WS_STATUS') {
    sendResponse({ status: ws ? (ws.readyState === 1 ? 'connected' : 'connecting') : 'disconnected' });
    return true;
  }
});

// --- Helpers ---
function roundStake(amount) { return Math.ceil(amount); }

function toDecimal(american) {
  const n = parseInt(american);
  return n > 0 ? (n / 100 + 1) : (100 / Math.abs(n) + 1);
}

function checkArb(fd, dk, base, fdMaxWager) {
  function toImplied(american) {
    const n = parseInt(american);
    if (isNaN(n)) return null;
    return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
  }
  const p1 = toImplied(fd), p2 = toImplied(dk);
  if (!p1 || !p2) return null;
  const total = p1 + p2;
  if (total >= 1.0) return { isArb: false, total };

  const decFd = toDecimal(fd);
  const decDk = toDecimal(dk);

  // Exact stakes that produce equal payouts on both sides
  // payout = stake1 * decFd = stake2 * decDk  => ratio stake1:stake2 = decDk:decFd
  // stake1 + stake2 = base  => stake1 = base * decDk / (decFd + decDk)
  let exactStake1 = base * decDk / (decFd + decDk);
  let exactStake2 = base * decFd / (decFd + decDk);

  // Cap FD stake to max wager if needed, rescale DK to match
  if (fdMaxWager && exactStake1 > fdMaxWager) {
    exactStake1 = fdMaxWager;
    exactStake2 = exactStake1 * decFd / decDk;
  }

  const s1 = Math.floor(exactStake1);
  const s2 = Math.floor(exactStake2);
  const profit = Math.min(s1 * decFd, s2 * decDk) - (s1 + s2);
  return { isArb: profit > 0, profit, stake1: s1, stake2: s2, total };
}

function broadcastToTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}
