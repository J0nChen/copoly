const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${protocol}//${window.location.host}/ws`;
let ws;
let isConnected = false;
let totalTrades = 0;

const statusEl = document.getElementById('status-bar');
const tradesContainer = document.getElementById('trades-container');
const inputEl = document.getElementById('address-input');
const trackBtn = document.getElementById('track-btn');
const tradeCountEl = document.getElementById('trade-count');
const feedTitleBtn = document.getElementById('back-btn');
const feedTitleText = document.getElementById('feed-title');
let currentFilterKey = null;
let isMarketLevelFilter = false;

if (feedTitleBtn) {
    feedTitleBtn.addEventListener('click', () => filterFeed(null, null));
}

function filterFeed(key, marketTitle, isMarketLevel = false) {
    currentFilterKey = key;
    isMarketLevelFilter = isMarketLevel;
    if (key) {
        feedTitleText.textContent = "Historical Replay: " + marketTitle.substring(0, 30) + (marketTitle.length > 30 ? '...' : '');
        feedTitleBtn.style.display = "inline-block";
    } else {
        feedTitleText.textContent = "Live Feed";
        feedTitleBtn.style.display = "none";
    }

    let visibleCount = 0;
    const cards = tradesContainer.querySelectorAll('.trade-card');
    cards.forEach(card => {
        if (!key) {
            card.style.display = '';
            visibleCount++;
        } else {
            const cardKey = card.getAttribute('data-pos-key');
            if (isMarketLevel && cardKey.startsWith(key + '_')) {
                card.style.display = '';
                visibleCount++;
            } else if (!isMarketLevel && cardKey === key) {
                card.style.display = '';
                visibleCount++;
            } else {
                card.style.display = 'none';
            }
        }
    });
    tradeCountEl.textContent = key ? visibleCount : totalTrades;
}

function connect() {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        isConnected = true;
        statusEl.innerHTML = `<span style="color: var(--accent-green)">●</span> Connected to tracking server`;
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'info') {
            statusEl.textContent = data.message;
            if (data.target) {
                inputEl.value = data.target;
            }
        } else if (data.type === 'error') {
            statusEl.innerHTML = `<span style="color: var(--accent-red)">●</span> Error: ${data.message}`;
        } else if (data.type === 'clear') {
            tradesContainer.innerHTML = '';
            totalTrades = 0;
            aggregatedTrades = {}; // Clear map
            activePositions = {};
            closedPositions = {};
            renderPositions();
            renderClosedPositions();
            updateCount();
        } else if (data.type === 'trade') {
            addTrade(data);
        }
    };

    ws.onclose = () => {
        isConnected = false;
        statusEl.innerHTML = `<span style="color: var(--accent-red)">●</span> Disconnected. Reconnecting in 3s...`;
        setTimeout(connect, 3000);
    };
}

trackBtn.addEventListener('click', () => {
    const address = inputEl.value.trim();
    if (!address) return;

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            action: 'set_target',
            address: address
        }));
    } else {
        alert("Not connected to server yet.");
    }
});

inputEl.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        trackBtn.click();
    }
});

let aggregatedTrades = {};
let activePositions = {};
let closedPositions = {};

function hasMarketEnded(title) {
    const match = title.match(/([a-zA-Z]+) (\d+).*?(?:(?:1[0-2]|0?[1-9]):[0-5][0-9][a-zA-Z]*\s*-\s*)?((?:1[0-2]|0?[1-9]):[0-5][0-9][a-zA-Z]*)\s*ET/i);
    if (!match) return false;

    const monthStr = match[1];
    const day = parseInt(match[2]);
    const endTimeStr = match[3];

    const timeMatch = endTimeStr.match(/(\d+):(\d+)([AP]M)/i);
    if (!timeMatch) return false;
    let h = parseInt(timeMatch[1]);
    let m = parseInt(timeMatch[2]);
    let ampm = timeMatch[3].toUpperCase();
    if (ampm === 'PM' && h < 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;

    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
    let nyParts = {};
    for (let p of parts) { nyParts[p.type] = p.value; }

    const currentMonth = nyParts.month;
    const currentDay = parseInt(nyParts.day);
    const currentHour = parseInt(nyParts.hour);
    const currentMinute = parseInt(nyParts.minute) || 0;

    const mNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const idxTargetM = mNames.findIndex(x => x.toLowerCase() === monthStr.toLowerCase());
    const idxCurrentM = mNames.findIndex(x => x.toLowerCase() === currentMonth.toLowerCase());

    if (idxCurrentM > idxTargetM) return true;
    if (idxCurrentM < idxTargetM) return false;

    if (currentDay > day) return true;
    if (currentDay < day) return false;

    if (currentHour > h) return true;
    if (currentHour === h && currentMinute >= m) return true;

    return false;
}

setInterval(() => {
    let moved = false;
    for (const key in activePositions) {
        if (hasMarketEnded(activePositions[key].market)) {
            closedPositions[key] = activePositions[key];
            delete activePositions[key];
            moved = true;
        }
    }
    if (moved) {
        renderPositions();
        renderClosedPositions();
    }
}, 5000);

function processPosition(trade) {
    const key = trade.market + '_' + trade.outcome;
    let isClosed = hasMarketEnded(trade.market);

    // If trade comes through and market just closed but our 5-second interval didn't sweep it yet,
    // manually move the existing position now so the cost basis doesn't split!
    if (isClosed && activePositions[key]) {
        closedPositions[key] = activePositions[key];
        delete activePositions[key];
    }

    const targetMap = isClosed ? closedPositions : activePositions;

    if (!targetMap[key]) {
        targetMap[key] = { market: trade.market, outcome: trade.outcome, shares: 0, totalCost: 0 };
    }

    let pos = targetMap[key];

    if (trade.action === 'BUY' || trade.action === 'SPLIT') {
        pos.shares += trade.shares;
        pos.totalCost += (trade.shares * trade.price);
    } else if (trade.action === 'SELL' || trade.action === 'MERGE' || trade.action === 'REDEEM') {
        let avg = pos.shares > 0 ? pos.totalCost / pos.shares : 0;
        pos.shares -= trade.shares;
        if (pos.shares < 0) pos.shares = 0;
        pos.totalCost = pos.shares * avg;
    }

    if (pos.shares <= 0.0001) {
        delete targetMap[key];
    }

    if (isClosed) {
        renderClosedPositions();
    } else {
        renderPositions();
    }
}

function renderPositions() {
    renderPositionMap(activePositions, 'positions-container', 'No active positions from this session yet.');
}

function renderClosedPositions() {
    const container = document.getElementById('closed-container');
    if (!container) return;

    if (Object.keys(closedPositions).length === 0) {
        container.innerHTML = `<div class="empty-state">No closed positions yet.</div>`;
        return;
    }

    container.innerHTML = '';

    // Group closed positions by market
    let grouped = {};
    for (const key in closedPositions) {
        const pos = closedPositions[key];
        if (!grouped[pos.market]) {
            grouped[pos.market] = [];
        }
        grouped[pos.market].push(pos);
    }

    for (const market in grouped) {
        const positions = grouped[market];
        const card = document.createElement('div');
        card.className = 'position-card';
        card.style.opacity = '0.7';
        card.style.borderColor = 'rgba(255,100,100, 0.4)';

        let detailsHtml = '';
        positions.forEach(pos => {
            const avgPrice = pos.shares > 0 ? (pos.totalCost / pos.shares) : 0;
            const totalValue = pos.shares * avgPrice;
            const outLower = pos.outcome.toLowerCase();
            const isUp = outLower.includes('up') || outLower === 'yes';
            const isDown = outLower.includes('down') || outLower === 'no';
            let outcomeClass = '';
            if (isUp) outcomeClass = 'outcome-up';
            else if (isDown) outcomeClass = 'outcome-down';

            detailsHtml += `
                <div class="pos-details" style="margin-top: 8px;">
                    <span class="outcome-badge ${outcomeClass}">${pos.outcome}</span>
                    <span class="pos-avg">Avg @ ${(avgPrice * 100).toFixed(2)}¢</span>
                </div>
                <div class="pos-details">
                    <span class="pos-shares">${pos.shares.toLocaleString(undefined, { maximumFractionDigits: 1 })} shares</span>
                    <span class="pos-value">$${totalValue.toFixed(2)}</span>
                </div>
            `;
        });

        card.innerHTML = `
            <div class="pos-market">${market}</div>
            ${detailsHtml}
        `;

        card.style.cursor = 'pointer';
        card.addEventListener('click', () => filterFeed(market, market, true));

        container.appendChild(card);
    }
}

function renderPositionMap(mapObj, containerId, emptyText) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (Object.keys(mapObj).length === 0) {
        container.innerHTML = `<div class="empty-state">${emptyText}</div>`;
        return;
    }

    container.innerHTML = '';

    for (const key in mapObj) {
        const pos = mapObj[key];
        const card = document.createElement('div');
        card.className = 'position-card';
        if (containerId === 'closed-container') {
            card.style.opacity = '0.7';
            card.style.borderColor = 'rgba(255,100,100, 0.4)';
        }

        const avgPrice = pos.shares > 0 ? (pos.totalCost / pos.shares) : 0;
        const totalValue = pos.shares * avgPrice;

        const outLower = pos.outcome.toLowerCase();
        const isUp = outLower.includes('up') || outLower === 'yes';
        const isDown = outLower.includes('down') || outLower === 'no';
        let outcomeClass = '';
        if (isUp) outcomeClass = 'outcome-up';
        else if (isDown) outcomeClass = 'outcome-down';

        card.innerHTML = `
            <div class="pos-market">${pos.market}</div>
            <div class="pos-details">
                <span class="outcome-badge ${outcomeClass}">${pos.outcome}</span>
                <span class="pos-avg">Avg @ ${(avgPrice * 100).toFixed(2)}¢</span>
            </div>
            <div class="pos-details">
                <span class="pos-shares">${pos.shares.toLocaleString(undefined, { maximumFractionDigits: 1 })} shares</span>
                <span class="pos-value">$${totalValue.toFixed(2)}</span>
            </div>
        `;

        card.style.cursor = 'pointer';
        card.addEventListener('click', () => filterFeed(key, pos.market, false));

        container.appendChild(card);
    }
}

function addTrade(trade) {
    if (totalTrades === 0 && tradesContainer.querySelector('.empty-state')) {
        tradesContainer.innerHTML = '';
    }

    // Process the active position delta
    processPosition(trade);

    const tradeKey = trade.tx_hash + '_' + trade.outcome;

    if (aggregatedTrades[tradeKey]) {
        // Aggregate existing fragmented trade piece
        let existing = aggregatedTrades[tradeKey];

        let existingTotalVal = existing.shares * existing.price;
        let newTotalVal = trade.shares * trade.price;
        let newTotalShares = existing.shares + trade.shares;

        let newAvgPrice = newTotalShares > 0 ? ((existingTotalVal + newTotalVal) / newTotalShares) : 0;

        existing.shares = newTotalShares;
        existing.price = newAvgPrice;

        // Update DOM element
        updateTradeCardDom(existing);
        return;
    }

    totalTrades++;
    updateCount();

    const card = document.createElement('div');
    card.className = 'trade-card';
    const posKey = trade.market + '_' + trade.outcome;
    card.setAttribute('data-pos-key', posKey);

    if (currentFilterKey) {
        if (isMarketLevelFilter) {
            if (!posKey.startsWith(currentFilterKey + '_')) card.style.display = 'none';
        } else {
            if (currentFilterKey !== posKey) card.style.display = 'none';
        }
    }

    let existingInfo = {
        card: card,
        shares: trade.shares,
        price: trade.price,
        trade: trade
    };

    aggregatedTrades[tradeKey] = existingInfo;
    updateTradeCardDom(existingInfo);

    // Prepend to top
    if (tradesContainer.firstChild) {
        tradesContainer.insertBefore(card, tradesContainer.firstChild);
    } else {
        tradesContainer.appendChild(card);
    }
}

function updateTradeCardDom(existingInfo) {
    const trade = existingInfo.trade;
    const card = existingInfo.card;
    const shares = existingInfo.shares;
    const price = existingInfo.price;

    // Find if outcome is up or down
    const outLower = trade.outcome.toLowerCase();
    const isUp = outLower.includes('up') || outLower === 'yes';
    const isDown = outLower.includes('down') || outLower === 'no';

    let outcomeClass = '';
    if (isUp) outcomeClass = 'outcome-up';
    else if (isDown) outcomeClass = 'outcome-down';

    // Format shares nicely
    const formattedShares = shares.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
    });

    // Calculate total value
    const totalValue = price > 0 ? `$${(shares * price).toFixed(2)}` : 'N/A';

    // Calculate cents for badge
    const centsText = price > 0 ? ` ${Math.round(price * 100)}¢` : '';

    let actionText = 'Unknown';
    if (trade.action === 'BUY') actionText = 'Buy';
    else if (trade.action === 'SELL') actionText = 'Sell';
    else if (trade.action === 'REDEEM') actionText = 'Redeem';
    else if (trade.action === 'MERGE') actionText = 'Merge';
    else if (trade.action === 'SPLIT') actionText = 'Split';

    card.innerHTML = `
        <div class="trade-left-action">${actionText}</div>
        <div class="trade-icon ${trade.market.toLowerCase().includes('bitcoin') ? 'bitcoin-icon' : ''}">
            ${trade.market.toLowerCase().includes('bitcoin') ? '₿' : 'P'}
        </div>
        <div class="trade-main-details">
            <div class="market-title">${trade.market}</div>
            <div class="trade-meta">
                <span class="outcome-badge ${outcomeClass}">${trade.outcome}${centsText}</span>
                <span class="shares-text">${formattedShares} shares</span>
                ${!trade.resolved ? '<span title="API Timeout/No Price" style="color:#ef4444;font-size:0.8rem;margin-left:5px;">⚠️</span>' : ''}
            </div>
        </div>
        <div class="trade-right-financials">
            <div class="total-value">${totalValue}</div>
            <div class="time-link">
                ${trade.time} 
                <a href="https://polygonscan.com/tx/${trade.tx_hash}" target="_blank" title="View Transaction">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                </a>
            </div>
        </div>
    `;
}

function updateCount() {
    if (currentFilterKey) {
        let visibleCount = 0;
        const cards = tradesContainer.querySelectorAll('.trade-card');
        cards.forEach(card => {
            const cardKey = card.getAttribute('data-pos-key');
            if (isMarketLevelFilter) {
                if (cardKey.startsWith(currentFilterKey + '_')) visibleCount++;
            } else {
                if (cardKey === currentFilterKey) visibleCount++;
            }
        });
        tradeCountEl.textContent = visibleCount;
    } else {
        tradeCountEl.textContent = totalTrades;
    }
}

// Start connection
connect();
