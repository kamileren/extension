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
    chrome.storage.local.get(['isOn', 'fdOdds', 'dkOdds', 'base', 'fdSuspended', 'dkSuspended'], (data) => {
      const updated = {
        isOn:        parsed.isOn        !== undefined ? parsed.isOn        : (data.isOn        ?? false),
        fdOdds:      parsed.fdOdds      !== undefined ? parsed.fdOdds      : (data.fdOdds      ?? null),
        dkOdds:      parsed.dkOdds      !== undefined ? parsed.dkOdds      : (data.dkOdds      ?? null),
        base:        parsed.base        !== undefined ? parsed.base        : (data.base        ?? 100),
        fdSuspended: parsed.fdSuspended !== undefined ? parsed.fdSuspended : (data.fdSuspended ?? false),
        dkSuspended: parsed.dkSuspended !== undefined ? parsed.dkSuspended : (data.dkSuspended ?? false),
      };
      if (parsed.color !== undefined) updated.lastColor = parsed.color;
      chrome.storage.local.set(updated);
      broadcastToTabs({ type: 'STATE_UPDATE', ...updated, color: parsed.color });

      // Auto-fill stakes if arb
      const fd = updated.fdOdds;
      const dk = updated.dkOdds;
      if (fd && dk && !updated.fdSuspended && !updated.dkSuspended) {
        const arbResult = checkArb(fd, dk, updated.base);
        if (arbResult && arbResult.isArb) {
          const fdAmount = roundStake(arbResult.stake1);
          const dkAmount = roundStake(arbResult.stake2);
          chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
              if (!tab.url) continue;
              if (tab.url.includes('draftkings.'))
                chrome.tabs.sendMessage(tab.id, { type: 'FILL_DK_STAKE', amount: dkAmount }).catch(() => {});
              if (tab.url.includes('fanduel.'))
                chrome.tabs.sendMessage(tab.id, { type: 'FILL_FD_STAKE', amount: fdAmount }).catch(() => {});
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
    chrome.storage.local.get(['isOn', 'fdOdds', 'dkOdds', 'base', 'fdSuspended', 'dkSuspended'], (data) => {
      const fdSuspended = message.book === 'fd' ? !!message.suspended : !!data.fdSuspended;
      const dkSuspended = message.book === 'dk' ? !!message.suspended : !!data.dkSuspended;
      const updated = {
        isOn:        data.isOn   ?? false,
        fdOdds:      data.fdOdds ?? null,
        dkOdds:      data.dkOdds ?? null,
        base:        data.base   ?? 100,
        fdSuspended, dkSuspended,
        [key]: message.odds,
      };
      chrome.storage.local.set({ [key]: message.odds, [suspendedKey]: !!message.suspended });
      broadcastToTabs({ type: 'STATE_UPDATE', ...updated });
      wsSend({ type: 'STATE_UPDATE', ...updated });

      const fd = updated.fdOdds;
      const dk = updated.dkOdds;
      if (fd && dk && !fdSuspended && !dkSuspended) {
        const arbResult = checkArb(fd, dk, updated.base);
        if (arbResult && arbResult.isArb) {
          const fdAmount = roundStake(arbResult.stake1);
          const dkAmount = roundStake(arbResult.stake2);
          chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
              if (!tab.url) continue;
              if (tab.url.includes('draftkings.'))
                chrome.tabs.sendMessage(tab.id, { type: 'FILL_DK_STAKE', amount: dkAmount }).catch(() => {});
              if (tab.url.includes('fanduel.'))
                chrome.tabs.sendMessage(tab.id, { type: 'FILL_FD_STAKE', amount: fdAmount }).catch(() => {});
            }
          });
        }
      }
    });

  } else if (message.type === 'GET_STATE') {
    chrome.storage.local.get(['isOn', 'fdOdds', 'dkOdds', 'base', 'fdSuspended', 'dkSuspended'], (data) => {
      sendResponse({
        isOn:        data.isOn        ?? false,
        fdOdds:      data.fdOdds      ?? null,
        dkOdds:      data.dkOdds      ?? null,
        base:        data.base        ?? 100,
        fdSuspended: data.fdSuspended ?? false,
        dkSuspended: data.dkSuspended ?? false,
      });
    });
    return true;

  } else if (message.type === 'GET_WS_STATUS') {
    sendResponse({ status: ws ? (ws.readyState === 1 ? 'connected' : 'connecting') : 'disconnected' });
    return true;
  }
});

// --- Helpers ---
function roundStake(amount) {
  if (amount >= 20) return Math.ceil(amount / 5) * 5;
  if (amount >= 5)  return Math.ceil(amount);
  return Math.ceil(amount * 2) / 2;
}

function toDecimal(american) {
  const n = parseInt(american);
  return n > 0 ? (n / 100 + 1) : (100 / Math.abs(n) + 1);
}

function checkArb(fd, dk, base) {
  function toImplied(american) {
    const n = parseInt(american);
    if (isNaN(n)) return null;
    return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
  }
  const p1 = toImplied(fd), p2 = toImplied(dk);
  if (!p1 || !p2) return null;
  const total = p1 + p2;
  if (total >= 1.0) return { isArb: false };

  const decDk = toDecimal(dk);
  const rStake1 = roundStake(base * (p1 / total));
  const rStake2 = roundStake(rStake1 / (decDk - 1));
  const payout1 = rStake1 * toDecimal(fd);
  const payout2 = rStake2 * decDk;
  const totalStaked = rStake1 + rStake2;
  const profit = Math.min(payout1, payout2) - totalStaked;
  return { isArb: profit > 0, profit, stake1: rStake1, stake2: rStake2 };
}

function broadcastToTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}
