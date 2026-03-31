// content.js - Overlay renderer + sportsbook odds scraper

(function () {
  if (document.getElementById('race-light-overlay')) return;

  // --- Build overlay bar ---
  const overlay = document.createElement('div');
  overlay.id = 'race-light-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0; left: 0;
    width: 100%; height: 52px;
    z-index: 2147483647;
    pointer-events: none;
    display: none;
    align-items: center;
    justify-content: center;
    gap: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    transition: background-color 0.2s ease;
    opacity: 0.82;
    backdrop-filter: blur(2px);
  `;

  const SEP = () => {
    const d = document.createElement('div');
    d.style.cssText = `width:1px; height:36px; background:rgba(255,255,255,0.18); flex-shrink:0;`;
    return d;
  };

  // Left: FanDuel
  const fdBlock = document.createElement('div');
  fdBlock.style.cssText = `display:flex; flex-direction:column; align-items:center; padding:0 20px; min-width:100px;`;
  const fdLabel = document.createElement('div');
  fdLabel.style.cssText = `font-size:9px; font-weight:700; letter-spacing:0.12em; color:rgba(255,255,255,0.55); text-transform:uppercase; margin-bottom:1px;`;
  fdLabel.textContent = 'FanDuel';
  const fdOdds = document.createElement('div');
  fdOdds.style.cssText = `font-size:22px; font-weight:900; color:#fff; line-height:1; letter-spacing:0.02em; transition: color 0.3s;`;
  fdOdds.textContent = '—';
  const fdStake = document.createElement('div');
  fdStake.style.cssText = `font-size:10px; font-weight:600; color:rgba(255,255,255,0.5); margin-top:1px;`;
  fdBlock.appendChild(fdLabel);
  fdBlock.appendChild(fdOdds);
  fdBlock.appendChild(fdStake);

  // Center
  const centerBlock = document.createElement('div');
  centerBlock.style.cssText = `display:flex; flex-direction:column; align-items:center; padding:0 22px; min-width:160px;`;
  const arbStatus = document.createElement('div');
  arbStatus.style.cssText = `font-size:10px; font-weight:800; letter-spacing:0.12em; text-transform:uppercase; color:rgba(255,255,255,0.75);`;
  const arbProfit = document.createElement('div');
  arbProfit.style.cssText = `font-size:20px; font-weight:900; color:#fff; line-height:1.1; letter-spacing:0.02em;`;
  const arbSub = document.createElement('div');
  arbSub.style.cssText = `font-size:9px; font-weight:600; color:rgba(255,255,255,0.5); margin-top:1px;`;
  centerBlock.appendChild(arbStatus);
  centerBlock.appendChild(arbProfit);
  centerBlock.appendChild(arbSub);

  // Right: DraftKings
  const dkBlock = document.createElement('div');
  dkBlock.style.cssText = `display:flex; flex-direction:column; align-items:center; padding:0 20px; min-width:100px;`;
  const dkLabel = document.createElement('div');
  dkLabel.style.cssText = `font-size:9px; font-weight:700; letter-spacing:0.12em; color:rgba(255,255,255,0.55); text-transform:uppercase; margin-bottom:1px;`;
  dkLabel.textContent = 'DraftKings';
  const dkOdds = document.createElement('div');
  dkOdds.style.cssText = `font-size:22px; font-weight:900; color:#fff; line-height:1; letter-spacing:0.02em; transition: color 0.3s;`;
  dkOdds.textContent = '—';
  const dkStake = document.createElement('div');
  dkStake.style.cssText = `font-size:10px; font-weight:600; color:rgba(255,255,255,0.5); margin-top:1px;`;
  dkBlock.appendChild(dkLabel);
  dkBlock.appendChild(dkOdds);
  dkBlock.appendChild(dkStake);

  overlay.appendChild(fdBlock);
  overlay.appendChild(SEP());
  overlay.appendChild(centerBlock);
  overlay.appendChild(SEP());
  overlay.appendChild(dkBlock);
  document.documentElement.appendChild(overlay);

  // --- Math helpers ---
  function toImplied(american) {
    const n = parseInt(american);
    if (isNaN(n)) return null;
    return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
  }

  function roundStake(amount) { return Math.ceil(amount); }

  function oddsToDecimal(american) {
    const n = parseInt(american);
    return n > 0 ? (n / 100 + 1) : (100 / Math.abs(n) + 1);
  }

  function calcArb(fdVal, dkVal, base, fdMaxWager) {
    const p1 = toImplied(fdVal), p2 = toImplied(dkVal);
    if (!p1 || !p2) return null;
    const total = p1 + p2;

    const decFd = oddsToDecimal(fdVal);
    const decDk = oddsToDecimal(dkVal);

    // Exact equal-payout stakes
    let exactS1 = base * decDk / (decFd + decDk);
    let exactS2 = base * decFd / (decFd + decDk);

    if (fdMaxWager && exactS1 > fdMaxWager) {
      exactS1 = fdMaxWager;
      exactS2 = exactS1 * decFd / decDk;
    }

    const rStake1 = Math.floor(exactS1);
    const rStake2 = Math.floor(exactS2);
    const actualProfit = Math.min(rStake1 * decFd, rStake2 * decDk) - (rStake1 + rStake2);
    return { isArb: total < 1.0 && actualProfit > 0, total, rStake1, rStake2, actualProfit, totalStaked: rStake1 + rStake2 };
  }

  // Was the arb profitable before this odds change?
  function wasArb(prevFd, prevDk, base, fdMaxWager) {
    if (!prevFd || !prevDk) return false;
    const r = calcArb(prevFd, prevDk, base, fdMaxWager);
    return r && r.isArb;
  }

  // --- State tracking for odds-change detection ---
  let prevFdOdds = null;
  let prevDkOdds = null;
  let oddsChangedWarning = false; // currently showing a "line moved" warning
  let dkBetPlaced = null; // { wagered, payout } when DK bet is confirmed

  // Flash an odds element red briefly to signal it changed
  function flashOddsEl(el, newlyBad) {
    el.style.color = newlyBad ? '#f87171' : '#86efac'; // red if moved against, green if moved for
    setTimeout(() => { el.style.color = '#fff'; }, 1200);
  }

  // Clear both stake inputs on this page when odds move against us
  function clearStakeInputs() {
    if (isFanduel) {
      for (const span of document.querySelectorAll('span')) {
        if (span.textContent.trim().toLowerCase() === 'wager') {
          const label = span.closest('label');
          const input = label && label.querySelector('input[type="text"]');
          if (input) fillInput(input, '');
        }
      }
    }
    if (isDraftKings) {
      const betslip = document.querySelector('.dk-betslip-shell__container') || document.body;
      const input = betslip.querySelector('input[data-testid="betslip-wager-box-input"]');
      if (input) fillInput(input, '');
    }
  }

  // --- Apply full state ---
  function applyState(state) {
    if (!state.isOn) { overlay.style.display = 'none'; return; }
    overlay.style.display = 'flex';

    const fd   = state.fdOdds || null;
    const dk   = state.dkOdds || null;
    const base = state.base   || 100;

    // --- Odds change detection ---
    const fdChanged = fd && prevFdOdds && fd !== prevFdOdds;
    const dkChanged = dk && prevDkOdds && dk !== prevDkOdds;

    if (fdChanged || dkChanged) {
      const wasGood = wasArb(prevFdOdds, prevDkOdds, base, state.fdMaxWager);
      const isNowGood = fd && dk && (() => { const r = calcArb(fd, dk, base, state.fdMaxWager); return r && r.isArb; })();

      if (wasGood && !isNowGood) {
        // Arb was open, now it's gone — warn and clear stakes
        oddsChangedWarning = true;
        if (fdChanged) flashOddsEl(fdOdds, true);
        if (dkChanged) flashOddsEl(dkOdds, true);
        clearStakeInputs();
        // Show warning for 3 seconds then let normal state take over
        setTimeout(() => { oddsChangedWarning = false; }, 3000);
      } else if (!wasGood && isNowGood) {
        // Line moved IN our favour — flash green, let normal flow re-fill stakes
        if (fdChanged) flashOddsEl(fdOdds, false);
        if (dkChanged) flashOddsEl(dkOdds, false);
        oddsChangedWarning = false;
      }
    }

    if (fd) prevFdOdds = fd;
    if (dk) prevDkOdds = dk;

    fdOdds.textContent = fd || '—';
    dkOdds.textContent = dk || '—';

    // --- Suspended ---
    const suspended    = state.fdSuspended || state.dkSuspended;
    const suspendedBook = state.fdSuspended ? 'FanDuel' : (state.dkSuspended ? 'DraftKings' : '');

    if (suspended) {
      overlay.style.backgroundColor = '#78350f';
      arbStatus.textContent = `SUSPENDED — ${suspendedBook}`;
      arbProfit.textContent  = 'Unavailable';
      arbProfit.style.color  = '#fcd34d';
      arbSub.textContent     = 'Bet is closed';
      fdStake.textContent    = '';
      dkStake.textContent    = '';
      return;
    }

    // --- Line moved warning ---
    if (oddsChangedWarning) {
      overlay.style.backgroundColor = '#7c2d12';
      arbStatus.textContent = 'LINE MOVED — ARB LOST';
      arbProfit.textContent  = 'Stakes cleared';
      arbProfit.style.color  = '#fca5a5';
      arbSub.textContent     = 'Odds changed against you';
      fdStake.textContent    = '';
      dkStake.textContent    = '';
      return;
    }

    // --- DK bet already placed — show FD hedge ---
    const bp = state.dkBetPlaced;
    if (bp && fd) {
      // Use the receipt-derived DK odds if live odds are gone
      const effectiveDkOdds = (dk) || bp.impliedDkOdds;
      const decFd = oddsToDecimal(fd);
      const decDk = effectiveDkOdds ? oddsToDecimal(effectiveDkOdds) : (bp.payout / bp.wagered);

      // fdStake = dkPayout / decFd makes FD payout == DK payout, guaranteeing profit on FD win
      // But we also need DK win to profit: bp.payout - fdHedge - bp.wagered > 0
      // So fdHedge < bp.payout - bp.wagered (i.e. less than DK profit)
      const rawFdStake = bp.payout / decFd;
      const fdHedge = roundStake(rawFdStake);
      const fdPayout = fdHedge * decFd;
      const profitIfFdWins = fdPayout - fdHedge - bp.wagered;
      const profitIfDkWins = bp.payout - fdHedge - bp.wagered;
      const minProfit = Math.min(profitIfFdWins, profitIfDkWins);

      if (minProfit > 0) {
        overlay.style.backgroundColor = '#1d4ed8';
        arbStatus.textContent = 'DK BET PLACED — BET FD NOW';
        arbProfit.textContent  = `+$${minProfit.toFixed(2)} locked`;
        arbProfit.style.color  = '#93c5fd';
        arbSub.textContent     = `DK: $${bp.wagered.toFixed(2)} wagered · payout $${bp.payout.toFixed(2)}`;
        fdStake.textContent    = `Bet $${fdHedge} NOW`;
        dkStake.textContent    = `Placed $${bp.wagered.toFixed(2)}`;
      } else {
        overlay.style.backgroundColor = '#78350f';
        arbStatus.textContent = 'DK PLACED — NO HEDGE';
        arbProfit.textContent  = 'Can\'t lock profit';
        arbProfit.style.color  = '#fcd34d';
        arbSub.textContent     = `DK: $${bp.wagered.toFixed(2)} wagered · odds shifted`;
        fdStake.textContent    = '';
        dkStake.textContent    = `Placed $${bp.wagered.toFixed(2)}`;
      }
      return;
    }

    // --- Normal arb display ---
    if (fd && dk) {
      const arb = calcArb(fd, dk, base, state.fdMaxWager);
      if (arb) {
        if (arb.isArb) {
          overlay.style.backgroundColor = '#15803d';
          arbStatus.textContent = 'ARB AVAILABLE';
          arbProfit.textContent  = `+$${arb.actualProfit.toFixed(2)}`;
          arbProfit.style.color  = '#86efac';
          arbSub.textContent     = `on $${arb.totalStaked} staked`;
          fdStake.textContent    = `Bet $${arb.rStake1}`;
          dkStake.textContent    = `Bet $${arb.rStake2}`;
        } else {
          overlay.style.backgroundColor = '#991b1b';
          arbStatus.textContent = 'NO ARB';
          arbProfit.textContent  = `${((arb.total - 1) * 100).toFixed(1)}% edge`;
          arbProfit.style.color  = 'rgba(255,255,255,0.8)';
          arbSub.textContent     = 'Book overround';
          fdStake.textContent    = '';
          dkStake.textContent    = '';
        }
      }
    } else {
      overlay.style.backgroundColor = '#374151';
      arbStatus.textContent = 'Waiting for odds';
      arbProfit.textContent  = '—';
      arbProfit.style.color  = 'rgba(255,255,255,0.4)';
      arbSub.textContent     = '';
      fdStake.textContent    = '';
      dkStake.textContent    = '';
    }
  }

  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response) {
      dkBetPlaced = response.dkBetPlaced || null;
      if (response.fdMaxWager !== undefined) state.fdMaxWager = response.fdMaxWager;
      applyState(response);
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATE_UPDATE') {
      if (message.dkBetPlaced !== undefined) dkBetPlaced = message.dkBetPlaced;
      applyState(message);
    }
  });

  // --- Sportsbook detection ---
  const host = location.hostname;
  const isFanduel    = host.includes('fanduel.');
  const isDraftKings = host.includes('draftkings.');
  if (!isFanduel && !isDraftKings) return;

  const BOOK = isFanduel ? 'fd' : 'dk';
  let lastOdds      = null;
  let lastSuspended = false;

  // After stakes are filled, re-check odds 1.5s later to confirm line hasn't moved
  let reCheckTimer = null;
  function scheduleReCheck() {
    if (reCheckTimer) clearTimeout(reCheckTimer);
    reCheckTimer = setTimeout(() => {
      const currentOdds = scrapeOdds();
      if (currentOdds !== lastOdds) {
        // Odds moved since we filled — force an immediate update
        checkAndSendOdds();
      }
    }, 1500);
  }

  function isBetSuspended() {
    if (!isDraftKings) return false;
    const closedPath = 'M10.392 13.904C10.232 13.96';
    for (const path of document.querySelectorAll('path')) {
      if ((path.getAttribute('d') || '').startsWith(closedPath)) return true;
    }
    const betslip = document.querySelector('[data-testid="betslip"]') || document.body;
    for (const el of betslip.querySelectorAll('span, div, p')) {
      if (el.children.length === 0 && el.textContent.trim().toLowerCase() === 'suspended') return true;
    }
    return false;
  }

  function scrapeOdds() {
    if (isFanduel) {
      for (const span of document.querySelectorAll('span[aria-label^="Odds "]')) {
        const m = span.getAttribute('aria-label').match(/Odds\s+([+\-\u2212]?\d+)/);
        if (m) return m[1].replace('\u2212', '-');
      }
      return null;
    }
    if (isDraftKings) {
      const betslip = document.querySelector('.dk-betslip-shell__container') ||
                      document.querySelector('[data-testid="betslip-content-wrapper"]');
      if (!betslip) return null;
      const oddsEl = betslip.querySelector('[data-testid="betslip-odds"] span.sportsbook-odds');
      if (oddsEl) {
        const text = oddsEl.textContent.trim().replace(/\u2212/g, '-');
        if (/^[+-]?\d{2,4}$/.test(text)) return text;
      }
      return null;
    }
    return null;
  }

  function fillInput(input, amount) {
    if (!input) return;
    const val = amount === '' ? '' : parseFloat(amount).toFixed(2);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, val);
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur',   { bubbles: true }));
  }

  function fillDKStake(amount) {
    const betslip = document.querySelector('.dk-betslip-shell__container') || document.body;
    fillInput(betslip.querySelector('input[data-testid="betslip-wager-box-input"]'), amount);
    scheduleReCheck();
  }

  let fdFillTarget = null;
  function fillFDStake(amount) {
    const maxWager = scrapeFDMaxWager();
    const capped = maxWager ? maxWager : amount;
    fdFillTarget = capped;
    function doFill() {
      const fillAmount = fdFillTarget;
      for (const span of document.querySelectorAll('span')) {
        if (span.textContent.trim().toLowerCase() === 'wager') {
          const label = span.closest('label');
          const input = label && label.querySelector('input[type="text"]');
          if (input) {
            // Clear first so React sees a value change even if it held the old value in its state
            fillInput(input, '');
            fillInput(input, fillAmount);
            return true;
          }
        }
      }
      return false;
    }
    if (doFill()) {
      setTimeout(doFill, 300);
      setTimeout(doFill, 800);
      scheduleReCheck();
    }
  }

  function scrapeFDMaxWager() {
    if (!isFanduel) return null;
    for (const span of document.querySelectorAll('span')) {
      const t = span.textContent.trim().toLowerCase();
      if (t.startsWith('max wager')) {
        const m = t.match(/max wager\s*\$?([\d,.]+)/);
        if (m) return parseFloat(m[1].replace(/,/g, ''));
      }
    }
    return null;
  }

  let lastMaxWager = null;

  function checkAndSendOdds() {
    const suspended = isBetSuspended();
    const odds = suspended ? null : scrapeOdds();
    const maxWager = isFanduel ? scrapeFDMaxWager() : null;
    if (odds !== lastOdds || suspended !== lastSuspended || maxWager !== lastMaxWager) {
      lastOdds      = odds;
      lastSuspended = suspended;
      lastMaxWager  = maxWager;
      chrome.runtime.sendMessage({ type: 'ODDS_UPDATE', odds, book: BOOK, suspended, maxWager });
    }
  }

  // --- DK bet placed detection ---
  let lastBetPlacedState = false;

  function scrapeDKBetPlaced() {
    if (!isDraftKings) return;
    const titleEl = document.querySelector('[data-testid="betslip-header-title"]');
    if (!titleEl) return;
    const titleText = titleEl.textContent.trim().toLowerCase();
    const isBetPlaced = titleText.includes('bet placed') || titleText.includes('betplaced');

    if (isBetPlaced && !lastBetPlacedState) {
      lastBetPlacedState = true;
      // Scrape wagered and potential payout amounts
      // DK shows these in the bet receipt — look for currency amounts
      let wagered = null;
      let payout  = null;

      // Use exact data-testid attributes from the DK receipt
      const wageredEl = document.querySelector('[data-testid="receipt-total-wagered"]');
      const payoutEl  = document.querySelector('[data-testid="receipt-total-potential-payout"]');

      if (wageredEl) wagered = parseFloat(wageredEl.textContent.replace(/[^0-9.]/g, ''));
      if (payoutEl)  payout  = parseFloat(payoutEl.textContent.replace(/[^0-9.]/g, ''));

      // Fallback: scan labeled elements
      if (!wagered || !payout) {
        for (const el of document.querySelectorAll('[data-testid]')) {
          const tid  = el.getAttribute('data-testid') || '';
          const text = parseFloat(el.textContent.replace(/[^0-9.]/g, ''));
          if (!wagered && tid.includes('wager') && text)  wagered = text;
          if (!payout  && tid.includes('payout') && text) payout  = text;
        }
      }

      if (wagered && payout) {
        // Back-calculate DK odds from receipt so FD side can hedge even if odds disappeared
        const decimal = payout / wagered;
        let impliedDkOdds;
        if (decimal >= 2) {
          impliedDkOdds = '+' + Math.round((decimal - 1) * 100);
        } else {
          impliedDkOdds = '-' + Math.round(100 / (decimal - 1));
        }
        chrome.runtime.sendMessage({ type: 'DK_BET_PLACED', wagered, payout, impliedDkOdds });
      }
    } else if (!isBetPlaced && lastBetPlacedState) {
      lastBetPlacedState = false;
      chrome.runtime.sendMessage({ type: 'DK_BET_CLEARED' });
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'FILL_DK_STAKE' && isDraftKings) fillDKStake(message.amount);
    if (message.type === 'FILL_FD_STAKE' && isFanduel)    fillFDStake(message.amount);
  });

  setInterval(checkAndSendOdds, 1000);
  setTimeout(checkAndSendOdds, 500);
  setTimeout(checkAndSendOdds, 2000);
  setTimeout(checkAndSendOdds, 5000);

  if (isDraftKings) {
    setInterval(scrapeDKBetPlaced, 800);
  }

  // Clear betslip on tab close to prevent accidental parlays
  if (isFanduel) {
    window.addEventListener('beforeunload', () => {
      for (const span of document.querySelectorAll('span')) {
        if (span.textContent.trim() === 'Remove all selections') { span.click(); return; }
      }
    });
  }

  if (isDraftKings) {
    window.addEventListener('beforeunload', () => {
      document.querySelectorAll('[data-testid="betslip-selection-card-ex-button"]')
        .forEach(btn => btn.click());
    });
  }
})();
