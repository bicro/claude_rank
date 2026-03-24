const BASE_URL = process.env.RANKING_API_BASE || "https://clauderank.com";

async function apiFetch(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return res.json();
}

export async function fetchUserProfile(hash) {
  return apiFetch(`/api/users/${hash}`);
}

export async function fetchLeaderboard(category = "weighted", limit = 20) {
  return apiFetch(`/api/leaderboard/${category}?scope=individual&limit=${limit}`);
}

export async function fetchBadges(hash) {
  return apiFetch(`/api/users/${hash}/badges`);
}

export async function fetchHistory(hash, days = 7) {
  return apiFetch(`/api/users/${hash}/history?days=${days}`);
}

export async function postSync(payload) {
  return apiFetch("/api/sync", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchConcurrency(hash, date) {
  const params = date ? `?date=${date}` : '';
  return apiFetch(`/api/users/${hash}/concurrency${params}`);
}

export async function fetchDailyRanks(hash, date) {
  const params = date ? `?period=day&date=${date}` : '?period=day';
  return apiFetch(`/api/users/${hash}/daily-ranks${params}`);
}

export async function fetchTeam(teamHash) {
  return apiFetch(`/api/teams/${teamHash}`);
}

export async function fetchTeamBurn(teamHash) {
  return apiFetch(`/api/teams/${teamHash}/burn`);
}
