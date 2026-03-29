// popup.js

const serverIpInput  = document.getElementById('serverIp');
const statusDot      = document.getElementById('statusDot');
const offBtn         = document.getElementById('offBtn');
const lightBtns      = document.querySelectorAll('.light-btn');
const btnFD          = document.getElementById('btnFD');
const btnDK          = document.getElementById('btnDK');
const arbCard        = document.getElementById('arbCard');
const arbStatus      = document.getElementById('arbStatus');
const arbDetail      = document.getElementById('arbDetail');
const fdOddsDisplay  = document.getElementById('fdOddsDisplay');
const dkOddsDisplay  = document.getElementById('dkOddsDisplay');
const baseStakeInput = document.getElementById('baseStake');

let ws = null;
let reconnectTimer = null;
let state = { isOn: false, fdOdds: null, dkOdds: null, base: 100, fdSuspended: false, dkSuspended: false };

// --- Arb math ---
function toImplied(american) {
  const n = parseInt(american);
  if (isNaN(n)) return null;
  return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
}

function calcArb(fd, dk, base) {
  const p1 = toImplied(fd);
  const p2 = toImplied(dk);
  if (p1 === null || p2 === null) return null;
  const total = p1 + p2;
  const profit = (base / total) - base;
  const stake1 = base * (p1 / total);
  const stake2 = base * (p2 / total);
  return { isArb: total < 1.0, total, profit, stake1, stake2 };
}

// --- Update arb UI ---
function updateArbUI() {
  const fd = state.fdOdds;
  const dk = state.dkOdds;
  const base = state.base || 100;

  fdOddsDisplay.textContent = fd || '—';
  dkOddsDisplay.textContent = dk || '—';

  arbCard.style.display = 'block';

  const suspended = state.fdSuspended || state.dkSuspended;
  const suspendedBook = state.fdSuspended ? 'FanDuel' : (state.dkSuspended ? 'DraftKings' : '');

  if (suspended) {
    arbCard.className = 'arb-card no-arb';
    arbStatus.textContent = `SUSPENDED`;
    arbDetail.innerHTML = `<span>${suspendedBook}</span> bet is closed or unavailable`;
    return;
  }

  if (!fd || !dk) {
    arbCard.className = 'arb-card wait';
    arbStatus.textContent = 'Waiting for both odds';
    arbDetail.innerHTML = '';
    return;
  }

  const arb = calcArb(fd, dk, base);
  if (!arb) return;

  if (arb.isArb) {
    arbCard.className = 'arb-card arb';
    arbStatus.textContent = 'ARB AVAILABLE';
    arbDetail.innerHTML =
      `Profit: <span>+$${arb.profit.toFixed(2)}</span> on $${base} total<br>` +
      `Bet <span>$${arb.stake1.toFixed(2)}</span> FD &nbsp;+&nbsp; <span>$${arb.stake2.toFixed(2)}</span> DK`;
  } else {
    arbCard.className = 'arb-card no-arb';
    arbStatus.textContent = 'No Arb';
    const edge = ((arb.total - 1) * 100).toFixed(2);
    arbDetail.innerHTML = `Book edge: <span>${edge}%</span> &nbsp;|&nbsp; FD: ${fd} &nbsp;DK: ${dk}`;
  }
}

// --- Book selector ---
function setBook(book) {
  chrome.storage.local.set({ myBook: book });
  btnFD.className = 'book-btn' + (book === 'FanDuel'    ? ' active-fd' : '');
  btnDK.className = 'book-btn' + (book === 'DraftKings' ? ' active-dk' : '');
}
btnFD.addEventListener('click', () => setBook('FanDuel'));
btnDK.addEventListener('click', () => setBook('DraftKings'));

// --- Load saved state ---
chrome.storage.local.get(['serverIp', 'isOn', 'fdOdds', 'dkOdds', 'base', 'myBook', 'fdSuspended', 'dkSuspended'], (data) => {
  if (data.serverIp) { serverIpInput.value = data.serverIp; connect(data.serverIp); }
  state.isOn        = data.isOn        ?? false;
  state.fdOdds      = data.fdOdds      ?? null;
  state.dkOdds      = data.dkOdds      ?? null;
  state.base        = data.base        ?? 100;
  state.fdSuspended = data.fdSuspended ?? false;
  state.dkSuspended = data.dkSuspended ?? false;
  baseStakeInput.value = state.base;
  setBook(data.myBook || null);
  updateArbUI();
  if (state.isOn) {
    const activeColor = data.lastColor;
    if (activeColor) setActiveButton(activeColor);
  }
});

// --- Base stake change ---
baseStakeInput.addEventListener('change', () => {
  const val = Math.max(1, parseInt(baseStakeInput.value) || 100);
  baseStakeInput.value = val;
  state.base = val;
  chrome.storage.local.set({ base: val });
  updateArbUI();
  // Send updated base to other browser
  sendCurrentState();
});

// --- WebSocket ---
function connect(ip) {
  if (ws) { ws.onclose = null; ws.onerror = null; ws.close(); ws = null; }
  if (!ip) return;
  setDot('connecting');
  try { ws = new WebSocket(`ws://${ip}:8765`); }
  catch (e) { setDot('disconnected'); return; }

  ws.onopen = () => setDot('connected');

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.ping) return;
      // Merge incoming state
      if (data.fdOdds      !== undefined) state.fdOdds      = data.fdOdds;
      if (data.dkOdds      !== undefined) state.dkOdds      = data.dkOdds;
      if (data.fdSuspended !== undefined) state.fdSuspended = data.fdSuspended;
      if (data.dkSuspended !== undefined) state.dkSuspended = data.dkSuspended;
      if (data.isOn        !== undefined) state.isOn        = data.isOn;
      if (data.base        !== undefined) { state.base = data.base; baseStakeInput.value = data.base; }
      chrome.runtime.sendMessage({ type: 'STATE_UPDATE', ...state });
      updateArbUI();
      if (state.isOn && data.color) setActiveButton(data.color);
    } catch (e) {}
  };

  ws.onclose = () => {
    setDot('disconnected'); ws = null;
    reconnectTimer = setTimeout(() => { const ip = serverIpInput.value.trim(); if (ip) connect(ip); }, 3000);
  };
  ws.onerror = () => setDot('disconnected');
}

function sendCurrentState() {
  const payload = { ...state };
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', ...payload });
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function setDot(s) {
  statusDot.className = 'status-dot';
  if (s === 'connected')    statusDot.classList.add('connected');
  if (s === 'disconnected') statusDot.classList.add('disconnected');
  if (s === 'connecting')   statusDot.style.background = '#f59e0b';
}

function setActiveButton(color) {
  lightBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.color === color));
}

serverIpInput.addEventListener('change', () => {
  const ip = serverIpInput.value.trim();
  chrome.storage.local.set({ serverIp: ip });
  connect(ip);
});
serverIpInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const ip = serverIpInput.value.trim();
    chrome.storage.local.set({ serverIp: ip });
    connect(ip);
  }
});

lightBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    state.isOn = true;
    setActiveButton(btn.dataset.color);
    const payload = { ...state, color: btn.dataset.color, colorName: btn.dataset.name };
    chrome.storage.local.set({ lastColor: btn.dataset.color, isOn: true });
    chrome.runtime.sendMessage({ type: 'STATE_UPDATE', ...payload });
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  });
});

offBtn.addEventListener('click', () => {
  state.isOn = false;
  lightBtns.forEach(b => b.classList.remove('active'));
  const payload = { ...state, isOn: false, color: null };
  chrome.storage.local.set({ isOn: false });
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', ...payload });
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
});

// Live updates from background (scraped odds from sportsbook tabs)
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'STATE_UPDATE') {
    if (message.fdOdds      !== undefined) state.fdOdds      = message.fdOdds;
    if (message.dkOdds      !== undefined) state.dkOdds      = message.dkOdds;
    if (message.fdSuspended !== undefined) state.fdSuspended = message.fdSuspended;
    if (message.dkSuspended !== undefined) state.dkSuspended = message.dkSuspended;
    updateArbUI();
  }
});

window.addEventListener('unload', () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) { ws.onclose = null; ws.close(); }
});
