// providers/footballApi.js
import fetch from 'node-fetch';

// --- football-data.org (v4) ---
const API_BASE = process.env.FOOTBALL_DATA_BASE || 'https://api.football-data.org/v4';
const API_TOKEN = process.env.FOOTBALL_DATA_TOKEN; // <-- use this env var

// Optional: pin a season year (e.g. 2025 for 2025/26 where supported)
const SEASON = process.env.FOOTBALL_SEASON ? Number(process.env.FOOTBALL_SEASON) : undefined;

if (!API_TOKEN) {
  console.warn('[football-data] Missing API token. Set FOOTBALL_DATA_TOKEN.');
}

// ----- helpers -----
function normalizeCompetitionCodes(input) {
  if (!input) return [];
  return String(input)
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
}

// FD caps ?competitions= to ~90 chars; batch if needed
function batchCompetitionCodes(codes, maxLen = 90) {
  if (!codes.length) return ['']; // empty string => omit competitions param
  const out = [];
  let cur = '';
  for (const code of codes) {
    if (!cur) { cur = code; continue; }
    const candidate = `${cur},${code}`;
    if (candidate.length <= maxLen) cur = candidate;
    else { out.push(cur); cur = code; }
  }
  if (cur) out.push(cur);
  return out;
}

function mapMatch(m) {
  return {
    match_id: String(m.id),
    match_time: m.utcDate,        // ISO from FD
    home: m.homeTeam?.name || 'TBD',
    away: m.awayTeam?.name || 'TBD',
    home_id: m.homeTeam?.id ?? null,
    away_id: m.awayTeam?.id ?? null,
    league: m.competition?.code || null,  // store code (PL, CL, …)
    league_name: m.competition?.name || null,
    source: 'football-data.org'
  };
}

// ----- API calls -----

/**
 * Fetch fixtures for a single date (YYYY-MM-DD).
 * - If leagueId provided (comma "PL,CL"), FD requires codes in `competitions=`.
 * - We batch when the query string would exceed ~90 chars.
 */
export async function fetchFixtures({ dateISO, leagueId }) {
  if (!API_TOKEN) throw new Error('FOOTBALL_DATA_TOKEN not set');

  const codes = normalizeCompetitionCodes(leagueId);
  const batches = batchCompetitionCodes(codes);

  const baseParams = new URLSearchParams({
    dateFrom: dateISO,
    dateTo: dateISO
  });

  // No competitions filter
  if (batches.length === 1 && batches[0] === '') {
    const url = `${API_BASE}/matches?${baseParams.toString()}`;
    const res = await fetch(url, { headers: { 'X-Auth-Token': API_TOKEN } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`football-data.org ${res.status}: ${text || res.statusText}`);
    }
    const json = await res.json();
    return (json.matches || []).map(mapMatch);
  }

  // With competitions filter (possibly batched)
  const merged = [];
  for (const batch of batches) {
    const params = new URLSearchParams(baseParams);
    params.set('competitions', batch);
    const url = `${API_BASE}/matches?${params.toString()}`;

    const res = await fetch(url, { headers: { 'X-Auth-Token': API_TOKEN } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`football-data.org ${res.status}: ${text || res.statusText}`);
    }
    const json = await res.json();
    merged.push(...(json.matches || []).map(mapMatch));
  }

  // Dedup by match_id (safety)
  const seen = new Set();
  const deduped = [];
  for (const r of merged) {
    if (seen.has(r.match_id)) continue;
    seen.add(r.match_id);
    deduped.push(r);
  }
  return deduped;
}

/**
 * Fetch teams for a competition (used by /fixtures follow).
 * league: a FD competition code like "PL", "CL", "SA", "BL1", …
 * Optionally pass season year if you set FOOTBALL_SEASON. FD supports ?season=YYYY.
 */
export async function fetchTeamsForLeague({ league, season = SEASON }) {
  if (!API_TOKEN) throw new Error('FOOTBALL_DATA_TOKEN not set');
  if (!league) throw new Error('Missing league code (e.g., PL)');

  const url = new URL(`${API_BASE}/competitions/${encodeURIComponent(String(league).toUpperCase())}/teams`);
  if (season && Number.isFinite(season)) url.searchParams.set('season', String(season));

  const res = await fetch(url.toString(), { headers: { 'X-Auth-Token': API_TOKEN } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`football-data.org ${res.status}: ${text || res.statusText}`);
  }
  const json = await res.json();
  const teams = Array.isArray(json?.teams) ? json.teams : [];
  return teams
    .map(t => ({ id: t.id, name: t.name }))
    .filter(x => x.id && x.name);
}

/**
 * Fetch fixtures for a team over a date range (inclusive).
 * FD: GET /teams/{id}/matches?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
 * (No season param here; FD returns matches in that window across comps.)
 */
export async function fetchTeamFixtures({ teamId, fromISO, toISO }) {
  if (!API_TOKEN) throw new Error('FOOTBALL_DATA_TOKEN not set');
  const url = new URL(`${API_BASE}/teams/${encodeURIComponent(teamId)}/matches`);
  url.searchParams.set('dateFrom', fromISO);
  url.searchParams.set('dateTo', toISO);

  const res = await fetch(url.toString(), { headers: { 'X-Auth-Token': API_TOKEN } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`football-data.org ${res.status}: ${text || res.statusText}`);
  }
  const json = await res.json();
  const matches = Array.isArray(json?.matches) ? json.matches : [];
  return matches.map(mapMatch);
}