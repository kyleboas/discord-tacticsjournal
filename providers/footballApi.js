// providers/footballApi.js
import fetch from 'node-fetch';

// --- API-FOOTBALL (v3) ---
const API_BASE = process.env.API_FOOTBALL_BASE || 'https://v3.football.api-sports.io';

// IMPORTANT: use FOOTBALL_DATA_TOKEN for the key
const API_KEY = process.env.FOOTBALL_DATA_TOKEN;

// Lock the season to a single start-year (e.g., 2025 for 2025/26).
// You can override this via env: FOOTBALL_SEASON=2025
const SEASON = 2025;

// Header key for direct API-Football (not RapidAPI)
const AUTH_HEADER = 'x-apisports-key';

if (!API_KEY) {
  console.warn('[api-football] Missing API key. Set FOOTBALL_DATA_TOKEN to your API-Football key.');
}
if (!process.env.FOOTBALL_SEASON) {
  console.warn(`[api-football] Using hard-coded SEASON=${SEASON}. Set FOOTBALL_SEASON env to override.`);
}

// Common codes -> league ids (quick path)
const CODE_TO_LEAGUE_ID = {
  PL: 39,   // Premier League
  CL: 2,    // UEFA Champions League
  EL: 3,    // UEFA Europa League
  ECL: 848, // UEFA Europa Conference League
  FA: 45,   // FA Cup
  EFL: 48,  // EFL Cup
  SA: 135,  // Serie A
  BL1: 78,  // Bundesliga
  PD: 140,  // LaLiga
  FL1: 61   // Ligue 1
};

function isNumeric(str) {
  return /^\d+$/.test(String(str));
}

function mapFixture(respItem) {
  const fx = respItem?.fixture || {};
  const lg = respItem?.league || {};
  const th = respItem?.teams?.home || {};
  const ta = respItem?.teams?.away || {};
  return {
    match_id: String(fx.id),
    match_time: fx.date, // ISO
    home: th.name || 'TBD',
    away: ta.name || 'TBD',
    home_id: th.id ?? null,
    away_id: ta.id ?? null,
    league: lg.id ? String(lg.id) : null,   // numeric id stored as string
    league_name: lg.name || null,
    source: 'api-football'
  };
}

/** Resolve a user-supplied league token (code or id) to a numeric league id */
async function resolveLeagueId(token) {
  if (!token) return null;
  if (isNumeric(token)) return Number(token);

  const code = String(token).toUpperCase().trim();
  if (CODE_TO_LEAGUE_ID[code]) return CODE_TO_LEAGUE_ID[code];

  // Fallback: ask API-Football to resolve code → id
  const url = `${API_BASE}/leagues?code=${encodeURIComponent(code)}`;
  const headers = { [AUTH_HEADER]: API_KEY };
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`api-football ${res.status}: ${text || res.statusText}`);
    }
    const json = await res.json();
    const list = Array.isArray(json?.response) ? json.response : [];
    const first = list.find(x => x.league?.id);
    if (first?.league?.id) return Number(first.league.id);
  } catch (e) {
    console.warn(`[api-football] resolveLeagueId(${code}) failed:`, e?.message || e);
  }
  return null;
}

/** Convert a comma list of codes/ids to an array of numeric league ids (with API fallback) */
async function toLeagueIds(list) {
  if (!list) return [];
  const tokens = String(list)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const out = [];
  for (const tok of tokens) {
    if (isNumeric(tok)) {
      out.push(Number(tok));
      continue;
    }
    const code = tok.toUpperCase();
    if (CODE_TO_LEAGUE_ID[code]) {
      out.push(CODE_TO_LEAGUE_ID[code]);
      continue;
    }
    const resolved = await resolveLeagueId(code);
    if (resolved) out.push(resolved);
  }
  return Array.from(new Set(out));
}

export async function fetchLeagueFixturesRange({ league, fromISO, toISO, season = SEASON }) {
  if (!API_KEY) throw new Error('FOOTBALL_DATA_TOKEN not set');
  const lid = isNumeric(league) ? Number(league) : (await resolveLeagueId(String(league)));
  if (!lid) throw new Error(`Unknown league: ${league}`);
  const headers = { [AUTH_HEADER]: API_KEY };
  const url = `${API_BASE}/fixtures?league=${lid}&season=${season}&from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`api-football ${res.status}: ${text || res.statusText}`);
  }
  const json = await res.json();
  return (json?.response || []).map(mapFixture);
}

/**
 * Fetch fixtures for a single date.
 * If leagueId is provided (comma codes/ids), we issue one request per league id (with SEASON).
 * Otherwise, we call /fixtures?date=YYYY-MM-DD once (no season filter).
 */
export async function fetchFixtures({ dateISO, leagueId }) {
  if (!API_KEY) throw new Error('FOOTBALL_DATA_TOKEN not set');

  const headers = { [AUTH_HEADER]: API_KEY };
  const leagueIds = await toLeagueIds(leagueId);

  // No league filter → one request across all leagues for that date
  if (!leagueIds.length) {
    const url = `${API_BASE}/fixtures?date=${encodeURIComponent(dateISO)}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`api-football ${res.status}: ${text || res.statusText}`);
    }
    const json = await res.json();
    return (json?.response || []).map(mapFixture);
  }

  // With league filters → one request per league id using SEASON
  const out = [];
  for (const lid of leagueIds) {
    const url = `${API_BASE}/fixtures?date=${encodeURIComponent(dateISO)}&league=${lid}&season=${SEASON}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`api-football ${res.status} (league ${lid}, season ${SEASON}): ${text || res.statusText}`);
    }
    const json = await res.json();
    out.push(...(json?.response || []).map(mapFixture));
  }

  // Deduplicate by match_id
  const seen = new Set();
  const dedup = [];
  for (const r of out) {
    if (seen.has(r.match_id)) continue;
    seen.add(r.match_id);
    dedup.push(r);
  }
  return dedup;
}

/**
 * Fetch teams in a league (for /fixtures follow), pinned to SEASON.
 */
export async function fetchTeamsForLeague({ league, season = SEASON }) {
  if (!API_KEY) throw new Error('FOOTBALL_DATA_TOKEN not set');

  const lid = await resolveLeagueId(String(league).trim());
  if (!lid) throw new Error(`Unknown league code/id: ${league}`);

  const headers = { [AUTH_HEADER]: API_KEY };
  const url = `${API_BASE}/teams?league=${lid}&season=${season}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`api-football ${res.status} (league ${lid}, season ${season}): ${text || res.statusText}`);
  }
  const json = await res.json();
  const list = Array.isArray(json?.response) ? json.response : [];
  return list
    .map(t => ({ id: t.team?.id, name: t.team?.name }))
    .filter(x => x.id && x.name);
}

/**
 * Fetch fixtures for a team over a date range (inclusive).
 * Pin to SEASON as well for consistency (helps when ranges cross season boundary).
 */
export async function fetchTeamFixtures({ teamId, fromISO, toISO }) {
  if (!API_KEY) throw new Error('FOOTBALL_DATA_TOKEN not set');
  const headers = { [AUTH_HEADER]: API_KEY };
  const url = `${API_BASE}/fixtures?team=${encodeURIComponent(teamId)}&from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}&season=${SEASON}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`api-football ${res.status}: ${text || res.statusText}`);
  }
  const json = await res.json();
  return (json?.response || []).map(mapFixture);
}