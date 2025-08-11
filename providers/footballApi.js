// providers/footballApi.js
import fetch from 'node-fetch';

const API_BASE =
  process.env.FOOTBALL_DATA_BASE || 'https://api.football-data.org/v4';
const API_TOKEN =
  process.env.FOOTBALL_DATA_TOKEN || process.env.FOOTBALL_DATA_API_KEY;

if (!API_TOKEN) {
  // Let callers still catch, but it’s helpful to have a loud hint in logs.
  console.warn('[football-data] API token env var not set (FOOTBALL_DATA_TOKEN or FOOTBALL_DATA_API_KEY)');
}

// --- helpers ---
function normalizeCompetitionCodes(input) {
  if (!input) return [];
  return String(input)
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
}

function batchCompetitionCodes(codes, maxLen = 90) {
  if (!codes.length) return ['']; // empty string => omit & fetch all comps
  const out = [];
  let cur = '';
  for (const code of codes) {
    if (!cur) {
      cur = code;
      continue;
    }
    const candidate = `${cur},${code}`;
    if (candidate.length <= maxLen) {
      cur = candidate;
    } else {
      out.push(cur);
      cur = code;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function mapMatch(m) {
  return {
    match_id: String(m.id),
    match_time: m.utcDate, // ISO string from API
    home: m.homeTeam?.name || 'TBD',
    away: m.awayTeam?.name || 'TBD',
    home_id: m.homeTeam?.id ?? null,
    away_id: m.awayTeam?.id ?? null,
    // Use competition code for filtering (PL, SA, etc.), keep name for display if needed
    league: m.competition?.code || null,
    league_name: m.competition?.name || null,
    source: 'football-data.org'
  };
}

/**
 * Fetch fixtures for a single day.
 * `leagueId` may be:
 *   - undefined/null/''  -> fetch all competitions for the day
 *   - 'PL,SA,BL1'        -> comma-separated competition codes (v4 API expects this)
 * If the competitions param exceeds 90 chars, the function will split into batches and merge.
 */
export async function fetchFixtures({ dateISO, leagueId }) {
  if (!API_TOKEN) throw new Error('FOOTBALL_DATA_TOKEN not set');

  const codes = normalizeCompetitionCodes(leagueId);
  const batches = batchCompetitionCodes(codes); // ['PL,SA', 'BL1', ...] OR [''] if none provided

  // Build the base search params for the day range
  const baseParams = new URLSearchParams({
    dateFrom: dateISO,
    dateTo: dateISO
  });

  // If there are no codes, we call once without the competitions param
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

  // Otherwise, fetch per batch and merge
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
    const rows = (json.matches || []).map(mapMatch);
    merged.push(...rows);
  }

  // Deduplicate by match_id in case a match appears in multiple batches (rare but safe)
  const seen = new Set();
  const deduped = [];
  for (const r of merged) {
    if (seen.has(r.match_id)) continue;
    seen.add(r.match_id);
    deduped.push(r);
  }
  return deduped;
}