// background.js - Service worker

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'STATE_UPDATE') {
    chrome.storage.local.set({
      isOn:      message.isOn      ?? false,
      fdOdds:    message.fdOdds    ?? null,
      dkOdds:    message.dkOdds    ?? null,
      base:      message.base      ?? 100,
    });
    broadcastToTabs(message);

  } else if (message.type === 'ODDS_UPDATE') {
    const key = message.book === 'fd' ? 'fdOdds' : 'dkOdds';
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
        [key]:       message.odds
      };
      chrome.storage.local.set({ [key]: message.odds, [suspendedKey]: !!message.suspended });
      broadcastToTabs({ type: 'STATE_UPDATE', ...updated });

      // If arb exists and neither side is suspended, fill the DK stake
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
  }
});

// Round up to nearest 5 if >= 20, nearest 1 if >= 5, else nearest 0.50
// Always rounds UP so the arb remains profitable
function roundStake(amount) {
  if (amount >= 20) return Math.ceil(amount / 5) * 5;
  if (amount >= 5)  return Math.ceil(amount);
  return Math.ceil(amount * 2) / 2;
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
  return { isArb: total < 1.0, profit: (base / total) - base, stake1: base * (p1 / total), stake2: base * (p2 / total) };
}

function broadcastToTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}
