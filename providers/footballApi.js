import fetch from 'node-fetch';

const API_BASE = process.env.FOOTBALL_DATA_BASE || 'https://api.football-data.org/v4';
const API_TOKEN = process.env.FOOTBALL_DATA_TOKEN;

// leagueId should be a competition code like "PL", "CL", "SA" or comma separated: "PL,CL"
export async function fetchFixtures({ dateISO, leagueId }) {
  if (!API_TOKEN) throw new Error('FOOTBALL_DATA_TOKEN not set');

  const params = new URLSearchParams({
    dateFrom: dateISO,
    dateTo: dateISO
  });
  if (leagueId) params.set('competitions', leagueId);

  const url = `${API_BASE}/matches?${params.toString()}`;
  const res = await fetch(url, { headers: { 'X-Auth-Token': API_TOKEN } });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`football-data.org ${res.status}: ${text}`);
  }

  const json = await res.json();

  // Map into our internal format for caching/starring
  return (json.matches || []).map(m => ({
    match_id: String(m.id),
    match_time: m.utcDate, // already ISO
    home: m.homeTeam?.name,
    away: m.awayTeam?.name,
    league: m.competition?.name,
    source: 'football-data.org'
  }));
}