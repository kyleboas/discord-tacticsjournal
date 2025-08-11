// providers/footballApi.js
import fetch from 'node-fetch';

// --- API-FOOTBALL (v3) ---
const API_BASE = process.env.API_FOOTBALL_BASE || 'https://v3.football.api-sports.io';

// IMPORTANT: use FOOTBALL_DATA_TOKEN for the key (as requested)
const API_KEY = process.env.FOOTBALL_DATA_TOKEN;

// Header key for direct API-Football (not RapidAPI)
const AUTH_HEADER = 'x-apisports-key';

if (!API_KEY) {
  console.warn('[api-football] Missing API key. Set FOOTBALL_DATA_TOKEN to your API-Football key.');
}

// Minimal, commonly-used league code → API-Football league id
// (PL=39 verified by API-FOOTBALL docs)
const CODE_TO_LEAGUE_ID = {
  PL: 39,   // Premier League
  CL: 2,    // UEFA Champions League
  EL: 3,    // UEFA Europa League
  ECL: 848, // UEFA Europa Conference League
  FA: 45,   // FA Cup
  EFL: 48,  // EFL Cup (Carabao)
  SA: 135,  // Serie A
  BL1: 78,  // Bundesliga
  PD: 140,  // LaLiga
  FL1: 61   // Ligue 1
};

function isNumeric(str) {
  return /^\d+$/.test(String(str));
}

// Convert a comma list of codes/ids to an array of numeric league ids
function toLeagueIds(list) {
  if (!list) return [];
  return String(list)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(tok => (isNumeric(tok) ? Number(tok) : CODE_TO_LEAGUE_ID[tok.toUpperCase()] ))
    .filter(Boolean);
}

// API-Football seasons are the **start year** (e.g. 2025 for 2025/26)
export function currentSeasonYearUTC(d = new Date()) {
  const m = d.getUTCMonth() + 1; // 1..12
  const y = d.getUTCFullYear();
  // If July or later, the new season's start year is the current year
  // Otherwise we're still in the season that started last year
  return m >= 7 ? y : y - 1;
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
    // store league as API-Football numeric id (string) for consistent filtering
    league: lg.id ? String(lg.id) : null,
    league_name: lg.name || null,
    source: 'api-football'
  };
}

/**
 * Fetch fixtures for a single date.
 * If leagueId is provided (comma codes/ids), we issue one request per league id.
 * Otherwise, we call /fixtures?date=YYYY-MM-DD once.
 */
export async function fetchFixtures({ dateISO, leagueId }) {
  if (!API_KEY) throw new Error('FOOTBALL_DATA_TOKEN not set');

  const leagueIds = toLeagueIds(leagueId);
  const headers = { [AUTH_HEADER]: API_KEY };

  // No league filter → one request
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

  // With league filters → one request per league id (keeps within free limits)
  const season = currentSeasonYearUTC();
  const out = [];
  for (const lid of leagueIds) {
    const url = `${API_BASE}/fixtures?date=${encodeURIComponent(dateISO)}&league=${lid}&season=${season}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`api-football ${res.status} (league ${lid}): ${text || res.statusText}`);
    }
    const json = await res.json();
    out.push(...(json?.response || []).map(mapFixture));
  }

  // Deduplicate by match_id just in case
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
 * Fetch teams in a league for the current season (for /fixtures follow)
 */
export async function fetchTeamsForLeague({ league, season = currentSeasonYearUTC() }) {
  if (!API_KEY) throw new Error('FOOTBALL_DATA_TOKEN not set');
  const lid = isNumeric(league) ? Number(league) : CODE_TO_LEAGUE_ID[String(league).toUpperCase()];
  if (!lid) throw new Error(`Unknown league code/id: ${league}`);

  const headers = { [AUTH_HEADER]: API_KEY };
  const url = `${API_BASE}/teams?league=${lid}&season=${season}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`api-football ${res.status}: ${text || res.statusText}`);
  }
  const json = await res.json();
  const list = Array.isArray(json?.response) ? json.response : [];
  return list.map(t => ({
    id: t.team?.id,
    name: t.team?.name
  })).filter(x => x.id && x.name);
}

/**
 * Fetch fixtures for a **team** over a date range (inclusive).
 * /fixtures?team={id}&from=YYYY-MM-DD&to=YYYY-MM-DD
 */
export async function fetchTeamFixtures({ teamId, fromISO, toISO }) {
  if (!API_KEY) throw new Error('FOOTBALL_DATA_TOKEN not set');
  const headers = { [AUTH_HEADER]: API_KEY };
  const url = `${API_BASE}/fixtures?team=${encodeURIComponent(teamId)}&from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`api-football ${res.status}: ${text || res.statusText}`);
  }
  const json = await res.json();
  return (json?.response || []).map(mapFixture);
}