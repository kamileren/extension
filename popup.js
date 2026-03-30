// popup.js - UI only, no WebSocket (background owns the connection)

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

let state = { isOn: false, fdOdds: null, dkOdds: null, base: 100, fdSuspended: false, dkSuspended: false, fdMaxWager: null };

// --- Arb math ---
function toImplied(american) {
  const n = parseInt(american);
  if (isNaN(n)) return null;
  return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
}

function toDecimal(american) {
  const n = parseInt(american);
  return n > 0 ? (n / 100 + 1) : (100 / Math.abs(n) + 1);
}

function roundStake(amount) {
  return Math.ceil(amount);
}

function calcArb(fd, dk, base, fdMaxWager) {
  const p1 = toImplied(fd);
  const p2 = toImplied(dk);
  if (p1 === null || p2 === null) return null;
  const total = p1 + p2;

  const decDk = toDecimal(dk);
  let stake1 = roundStake(base * (p1 / total));
  if (fdMaxWager && stake1 > fdMaxWager) stake1 = fdMaxWager;

  const stake2 = roundStake(stake1 / (decDk - 1));
  const payout1 = stake1 * toDecimal(fd);
  const payout2 = stake2 * decDk;
  const totalStaked = stake1 + stake2;
  const profit = Math.min(payout1, payout2) - totalStaked;
  return { isArb: total < 1.0 && profit > 0, total, profit, stake1, stake2 };
}

// --- Update arb UI ---
function updateArbUI() {
  const fd   = state.fdOdds;
  const dk   = state.dkOdds;
  const base = state.base || 100;

  fdOddsDisplay.textContent = fd || '—';
  dkOddsDisplay.textContent = dk || '—';
  arbCard.style.display = 'block';

  const suspended     = state.fdSuspended || state.dkSuspended;
  const suspendedBook = state.fdSuspended ? 'FanDuel' : (state.dkSuspended ? 'DraftKings' : '');

  if (suspended) {
    arbCard.className = 'arb-card no-arb';
    arbStatus.textContent = 'SUSPENDED';
    arbDetail.innerHTML = `<span>${suspendedBook}</span> bet is closed or unavailable`;
    return;
  }

  if (!fd || !dk) {
    arbCard.className = 'arb-card wait';
    arbStatus.textContent = 'Waiting for both odds';
    arbDetail.innerHTML = '';
    return;
  }

  const arb = calcArb(fd, dk, base, state.fdMaxWager);
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

// --- WS status dot ---
function setDot(s) {
  statusDot.className = 'status-dot';
  if (s === 'connected')    statusDot.classList.add('connected');
  if (s === 'disconnected') statusDot.classList.add('disconnected');
  if (s === 'connecting')   statusDot.style.background = '#f59e0b';
}

// --- Book selector ---
function setBook(book) {
  chrome.storage.local.set({ myBook: book });
  btnFD.className = 'book-btn' + (book === 'FanDuel'    ? ' active-fd' : '');
  btnDK.className = 'book-btn' + (book === 'DraftKings' ? ' active-dk' : '');
}
btnFD.addEventListener('click', () => setBook('FanDuel'));
btnDK.addEventListener('click', () => setBook('DraftKings'));

// --- Load saved state on open ---
chrome.storage.local.get(['serverIp', 'isOn', 'fdOdds', 'dkOdds', 'base', 'myBook', 'fdSuspended', 'dkSuspended', 'lastColor', 'fdMaxWager'], (data) => {
  if (data.serverIp) serverIpInput.value = data.serverIp;
  state.isOn        = data.isOn        ?? false;
  state.fdOdds      = data.fdOdds      ?? null;
  state.dkOdds      = data.dkOdds      ?? null;
  state.base        = data.base        ?? 100;
  state.fdSuspended = data.fdSuspended ?? false;
  state.dkSuspended = data.dkSuspended ?? false;
  state.fdMaxWager  = data.fdMaxWager  ?? null;
  baseStakeInput.value = state.base;
  setBook(data.myBook || null);
  updateArbUI();
  if (state.isOn && data.lastColor) setActiveButton(data.lastColor);
});

// Get current WS status from background
chrome.runtime.sendMessage({ type: 'GET_WS_STATUS' }, (res) => {
  if (res) setDot(res.status);
});

// --- Server IP input ---
serverIpInput.addEventListener('change', () => {
  const ip = serverIpInput.value.trim();
  chrome.runtime.sendMessage({ type: 'CONNECT', ip });
  setDot('connecting');
});
serverIpInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const ip = serverIpInput.value.trim();
    chrome.runtime.sendMessage({ type: 'CONNECT', ip });
    setDot('connecting');
  }
});

// --- Base stake change ---
baseStakeInput.addEventListener('change', () => {
  const val = Math.max(1, parseInt(baseStakeInput.value) || 100);
  baseStakeInput.value = val;
  state.base = val;
  chrome.storage.local.set({ base: val });
  updateArbUI();
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', ...state });
});

// --- Light buttons ---
function setActiveButton(color) {
  lightBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.color === color));
}

lightBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    state.isOn = true;
    setActiveButton(btn.dataset.color);
    const payload = { type: 'STATE_UPDATE', ...state, color: btn.dataset.color, colorName: btn.dataset.name };
    chrome.storage.local.set({ lastColor: btn.dataset.color, isOn: true });
    chrome.runtime.sendMessage(payload);
  });
});

offBtn.addEventListener('click', () => {
  state.isOn = false;
  lightBtns.forEach(b => b.classList.remove('active'));
  chrome.storage.local.set({ isOn: false });
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', ...state, isOn: false, color: null });
});

// --- Live updates pushed from background ---
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'WS_STATUS') {
    setDot(message.status);
  }
  if (message.type === 'STATE_UPDATE') {
    if (message.fdOdds      !== undefined) state.fdOdds      = message.fdOdds;
    if (message.dkOdds      !== undefined) state.dkOdds      = message.dkOdds;
    if (message.fdSuspended !== undefined) state.fdSuspended = message.fdSuspended;
    if (message.dkSuspended !== undefined) state.dkSuspended = message.dkSuspended;
    if (message.fdMaxWager  !== undefined) state.fdMaxWager  = message.fdMaxWager;
    if (message.base        !== undefined) { state.base = message.base; baseStakeInput.value = message.base; }
    if (message.isOn        !== undefined) state.isOn = message.isOn;
    updateArbUI();
    if (state.isOn && message.color) setActiveButton(message.color);
  }
});
