const API_BASE = '';

async function apiFetch(path) {
    const resp = await fetch(`${API_BASE}${path}`);
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`API error ${resp.status}: ${text}`);
    }
    return resp.json();
}

export async function getLeaderboard(category, scope = 'individual', limit = 50, offset = 0) {
    return apiFetch(`/api/leaderboard/${category}?scope=${scope}&limit=${limit}&offset=${offset}`);
}

export async function getUserProfile(userHash) {
    return apiFetch(`/api/users/${userHash}`);
}

export async function getUserByUsername(username) {
    return apiFetch(`/api/users/by-username/${encodeURIComponent(username)}`);
}

export async function setDisplayName(userHash, displayName, syncSecret) {
    const headers = { 'Content-Type': 'application/json' };
    if (syncSecret) headers['X-Sync-Secret'] = syncSecret;
    const resp = await fetch(`${API_BASE}/api/users/${userHash}/display-name`, {
        method: 'PUT',
        credentials: 'include',
        headers,
        body: JSON.stringify({ display_name: displayName }),
    });
    if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.detail || `API error ${resp.status}`);
    }
    return resp.json();
}

export async function getUserBadges(userHash) {
    return apiFetch(`/api/users/${userHash}/badges`);
}

export async function getUserHistory(userHash, days = 30) {
    return apiFetch(`/api/users/${userHash}/history?days=${days}`);
}

export async function getTeam(teamHash) {
    return apiFetch(`/api/teams/${teamHash}`);
}

export async function getTeamHistory(teamHash, days = 30) {
    return apiFetch(`/api/teams/${teamHash}/history?days=${days}`);
}

export async function getAllBadges() {
    return apiFetch('/api/badges');
}

export function formatPercentile(p) {
    if (p == null) return null;
    if (p <= 0) return '0.001';
    return parseFloat(p.toFixed(3)).toString();
}

export function formatCost(n) {
    if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
    return '$' + n.toFixed(2);
}

export function formatNumber(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toLocaleString();
}

export function getCategoryLabel(cat) {
    const labels = {
        tokens: 'Token Burning',
        messages: 'Messages + Sessions',
        tools: 'Tool Calls',
        uniqueness: 'Prompt Uniqueness',
        weighted: 'Weighted Score',
        cost: 'Estimated Spend',
    };
    return labels[cat] || cat;
}

export function getCategoryIcon(cat) {
    const icons = { tokens: '\u{1f525}', messages: '\u{1f4ac}', tools: '\u{1f527}', uniqueness: '\u{2728}', weighted: '\u{1f3af}', cost: '\u{1f4b0}' };
    return icons[cat] || '';
}

export const CATEGORIES = ['cost', 'tokens', 'messages', 'tools', 'uniqueness', 'weighted'];

export const TIERS = [
    { id: 'bronze',   name: 'Bronze',   icon: '\u{1f944}', minScore: 0,    color: '#cd7f32', bg: 'rgba(205,127,50,0.15)' },
    { id: 'silver',   name: 'Silver',   icon: '\u{1fa99}', minScore: 50,   color: '#c0c0c0', bg: 'rgba(192,192,192,0.15)' },
    { id: 'gold',     name: 'Gold',     icon: '\u{1f3c6}', minScore: 200,  color: '#ffd700', bg: 'rgba(255,215,0,0.15)' },
    { id: 'platinum', name: 'Platinum', icon: '\u{1f48e}', minScore: 500,  color: '#e5e4e2', bg: 'rgba(229,228,226,0.15)' },
    { id: 'diamond',  name: 'Diamond',  icon: '\u{2b50}',  minScore: 1000, color: '#b9f2ff', bg: 'rgba(185,242,255,0.15)' },
];

export function getTier(weightedScore) {
    for (let i = TIERS.length - 1; i >= 0; i--) {
        if (weightedScore >= TIERS[i].minScore) return TIERS[i];
    }
    return TIERS[0];
}

export async function getHotUsers(limit = 20) {
    return apiFetch(`/api/hot?limit=${limit}`);
}

export async function getHotCards(limit = 3) {
    return apiFetch(`/api/hot/cards?limit=${limit}`);
}

export async function getUserHeatmap(userHash, days = 365) {
    return apiFetch(`/api/users/${userHash}/heatmap?days=${days}`);
}

export async function getUserHourlyHeatmap(userHash, hours = 24) {
    return apiFetch(`/api/users/${userHash}/heatmap/hourly?hours=${hours}`);
}

export async function getUserConcurrency(userHash) {
    return apiFetch(`/api/users/${userHash}/concurrency`);
}

export async function getUserConcurrencyByDate(userHash, dateStr) {
    return apiFetch(`/api/users/${userHash}/concurrency?date=${dateStr}`);
}

export async function getUserDailyRanks(userHash, dateStr, period = 'day') {
    let url = `/api/users/${userHash}/daily-ranks?period=${period}`;
    if (dateStr) url += `&date=${dateStr}`;
    return apiFetch(url);
}

const _animFrames = new WeakMap();

export function animateValue(element, fromVal, toVal, formatter, duration = 800) {
    if (_animFrames.has(element)) cancelAnimationFrame(_animFrames.get(element));
    if (fromVal === toVal) {
        element.textContent = formatter(toVal);
        return;
    }
    const start = performance.now();
    function tick(now) {
        let t = Math.min((now - start) / duration, 1);
        t = 1 - Math.pow(1 - t, 3); // easeOutCubic
        const current = Math.round(fromVal + (toVal - fromVal) * t);
        element.textContent = formatter(current);
        if (t < 1) {
            _animFrames.set(element, requestAnimationFrame(tick));
        } else {
            _animFrames.delete(element);
        }
    }
    _animFrames.set(element, requestAnimationFrame(tick));
}
