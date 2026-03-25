const API_BASE = '';

async function apiFetch(path) {
    const resp = await fetch(`${API_BASE}${path}`);
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`API error ${resp.status}: ${text}`);
    }
    return resp.json();
}

export async function getLeaderboard(category, period = 'alltime', limit = 50, offset = 0, date = null) {
    let url = `/api/leaderboard/${category}?period=${period}&limit=${limit}&offset=${offset}`;
    if (date) url += `&date=${date}`;
    return apiFetch(url);
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

export async function getTeamBurn(teamHash, dateStr, days = 1) {
    let url = `/api/teams/${teamHash}/burn?date=${dateStr}`;
    if (days > 1) url += `&days=${days}`;
    return apiFetch(url);
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
        tokens: 'Token Spend',
        concurrent_agents: 'Concurrent Agents',
        agent_hours: 'Agent Hours',
        consistency: 'Consistency',
        messages: 'Messages',
        hourly_streak: 'Hourly Streak',
    };
    return labels[cat] || cat;
}

export function getCategoryIcon(cat) {
    const icons = {
        tokens: '\u{1f525}',
        concurrent_agents: '\u{26a1}',
        agent_hours: '\u{23f1}\u{fe0f}',
        consistency: '\u{1f4c5}',
        messages: '\u{1f4ac}',
        hourly_streak: '\u{23f1}\u{fe0f}',
    };
    return icons[cat] || '';
}

export const CATEGORIES = ['tokens', 'concurrent_agents', 'agent_hours', 'consistency', 'messages', 'hourly_streak'];

export function getCategoryTooltip(cat) {
    const tips = {
        tokens: 'Total tokens consumed across all Claude models, with estimated dollar cost based on per-model pricing.',
        concurrent_agents: 'Peak number of Claude Code sessions running simultaneously in a single hour.',
        agent_hours: 'Total minutes of active Claude Code agent time, converted to hours.',
        consistency: 'Current daily usage streak \u2014 consecutive days with at least one sync.',
        messages: 'Total prompts you sent to Claude across all sessions.',
        hourly_streak: 'Current consecutive hours of unbroken Claude Code usage.',
    };
    return tips[cat] || '';
}

export function formatAgentHours(mins) {
    const h = mins / 60;
    if (h >= 100) return h.toFixed(0) + 'h';
    if (h >= 10) return h.toFixed(1) + 'h';
    return h.toFixed(1) + 'h';
}

export function formatConcurrencyTime(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
}

export function formatConcurrentAgents(n) {
    return n + '\u{00d7}';
}

export function formatConsistency(days) {
    return days + (days === 1 ? ' day' : ' days');
}

export function formatHourlyStreak(hours) {
    return hours + (hours === 1 ? ' hour' : ' hours');
}

export function formatMessages(n) {
    return formatNumber(n);
}

export function formatLeaderboardValue(category, value, cost) {
    if (category === 'tokens') {
        return formatNumber(value);
    }
    if (category === 'concurrent_agents') return formatConcurrentAgents(value);
    if (category === 'agent_hours') return formatAgentHours(value);
    if (category === 'concurrency_time') return formatConcurrencyTime(value);
    if (category === 'consistency') return formatConsistency(value);
    if (category === 'hourly_streak') return formatHourlyStreak(value);
    if (category === 'messages') return formatMessages(value);
    return formatNumber(value);
}

export function formatLeaderboardValueHtml(category, value, cost) {
    const main = formatLeaderboardValue(category, value, cost);
    if (category === 'tokens' && cost != null && cost > 0) {
        return main + `<span class="value-sub">${formatCost(cost)}</span>`;
    }
    return main;
}

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

export async function getUserRewards(userHash, dateStr) {
    let url = `/api/users/${userHash}/rewards`;
    if (dateStr) url += `?date=${dateStr}`;
    return apiFetch(url);
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
