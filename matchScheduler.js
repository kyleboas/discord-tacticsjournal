// matchScheduler.js
import {
  listGuildSubscribedTeams,
  getReminderChannel,
  upsertGuildMatchReminder,
  purgeOldReminders,
  getUpcomingRemindersWindow,
  pruneAllUpcomingForUnfollowedGlobal,
  pruneOrphanUpcomingReminders
} from './db.js';

import { fetchTeamFixtures, cleanTeamName } from './providers/footballApi.js';

// In-memory dedupe (resets on restart)
const sent60 = new Set();    // "guildId_matchId_60"
const sentKick = new Set();  // "guildId_matchId_kick"

// Simple GC so the sets don't grow unbounded
function gcSets(nowSec) {
  for (const set of [sent60, sentKick]) {
    for (const k of set) {
      const parts = k.split('_');
      const ts = Number(parts[parts.length - 2]); // timestamp just before tag
      if (!Number.isFinite(ts) || ts < nowSec - 2 * 60 * 60) set.delete(k);
    } 
  }
}

// Utility
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function toISODate(d) {
  return new Date(d).toISOString().slice(0, 10);
}
function addDaysISO(dateISO, d) {
  const base = new Date(dateISO + 'T00:00:00Z');
  base.setUTCDate(base.getUTCDate() + d);
  return base.toISOString().slice(0, 10);
}

/**
 * Refresh reminders for a single guild immediately.
 * Includes ANY match where at least one team is followed.
 *
 * @param {string} guild_id
 * @param {number} horizonDays
 * @param {number[]|string[]|null} onlyTeamIds - if provided, refresh only these team IDs (strings/numbers)
 * @returns {Promise<number>} count upserted
 */
export async function refreshRemindersForGuild(guild_id, horizonDays = 14, onlyTeamIds = null) {
  // Always send reminders to this fixed channel
  const channel_id = '1098742662040920074';
  
  let followed = await listGuildSubscribedTeams(guild_id);
  if (!followed.length) return 0;

  if (onlyTeamIds?.length) {
    const set = new Set(onlyTeamIds.map(String));
    followed = followed.filter(t => set.has(String(t.team_id)));
    if (!followed.length) return 0;
  }

  const followedIds = new Set(followed.map(t => String(t.team_id)));

  const todayISO = toISODate(new Date());
  const fromISO = todayISO;
  const toISO = addDaysISO(todayISO, horizonDays);

  const baseDelayMs = 1100;
  const maxRetries = 2;
  const allMatches = [];

  for (const t of followed) {
    let attempt = 0;
    while (true) {
      try {
        const rows = await fetchTeamFixtures({
          teamId: t.team_id,
          fromISO,
          toISO
        });
        allMatches.push(...rows);
        await sleep(baseDelayMs);
        break;
      } catch (err) {
        const msg = String(err?.message || '');
        const waitMatch = msg.match(/Wait\s+(\d+)\s+seconds/i);
        const waitSec = waitMatch ? Number(waitMatch[1]) : null;

        if (msg.includes('429')) {
          attempt++;
          if (attempt > maxRetries) {
            console.warn(`[refreshRemindersForGuild] giving up t=${t.team_id}:`, msg);
            break;
          }
          const delayMs = (waitSec ? (waitSec + 2) : 10) * 1000;
          console.warn(`[refreshRemindersForGuild] 429 backoff t=${t.team_id}, waiting ${delayMs}ms`);
          await sleep(delayMs);
          continue;
        }

        console.warn(`[refreshRemindersForGuild] fetchTeamFixtures failed t=${t.team_id}:`, msg);
        await sleep(500);
        break;
      }
    }
  }

  const seen = new Set();
  let upserts = 0;

  for (const m of allMatches) {
    if (!m?.match_id) continue;
    if (seen.has(m.match_id)) continue;
    seen.add(m.match_id);

    const h = m.home_id ? String(m.home_id) : null;
    const a = m.away_id ? String(m.away_id) : null;

    if ((h && followedIds.has(h)) || (a && followedIds.has(a))) {
      try {
        await upsertGuildMatchReminder({
          guild_id,
          channel_id, // fixed channel here
          match_id: m.match_id,
          match_time: m.match_time,
          home: cleanTeamName(m.home || 'TBD'),
          away: cleanTeamName(m.away || 'TBD')
        });
        upserts++;
      } catch (err) {
        console.warn(`[refreshRemindersForGuild] upsert failed match=${m.match_id} guild=${guild_id}:`, err?.message || err);
      }
    }
  }

  try { await purgeOldReminders(); } catch {}
  return upserts;
}

// --- Core: refresh reminders every 3 days ---
async function refreshFollowedReminders(client, horizonDays = 14) {
  for (const [, guild] of client.guilds.cache) {
    try {
      await refreshRemindersForGuild(guild.id, horizonDays);
    } catch (err) {
      console.warn(`[scheduler] guild refresh failed:`, err?.message || err);
    }
  }

  try {
    await purgeOldReminders();
  } catch (e) {
    console.warn('[scheduler] purgeOldReminders failed:', e?.message || e);
  }

  // Prune reminders for unfollowed teams across all guilds
  try {
    const removed = await pruneAllUpcomingForUnfollowedGlobal({ keepManual: true });
    if (removed > 0) {
      console.log(`[scheduler] Pruned ${removed} reminder(s) for unfollowed teams`);
    }
  } catch (e) {
    console.warn('[scheduler] pruneAllUpcomingForUnfollowedGlobal failed:', e?.message || e);
  }

  // Prune orphan reminders (no matching fixtures_cache entry)
  try {
    const removed = await pruneOrphanUpcomingReminders({ keepManual: true });
    if (removed > 0) {
      console.log(`[scheduler] Pruned ${removed} orphan reminder(s)`);
    }
  } catch (e) {
    console.warn('[scheduler] pruneOrphanUpcomingReminders failed:', e?.message || e);
  }
}

// --- Dispatcher: send reminders every minute ---
async function dispatchImminentReminders(client) {
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  gcSets(nowSec);

  // look ahead 2 hours
  const windowTo = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const matches = await getUpcomingRemindersWindow({
    fromISO: now.toISOString(),
    toISO: windowTo.toISOString()
  });

  // group by channel + kickoff time
  const grouped60 = new Map();     // key: channel_ts
  const groupedKick = new Map();

  for (const match of matches) {
    const matchTime = new Date(match.match_time);
    const ts = Math.floor(matchTime.getTime() / 1000);
    const diffMinutes = (matchTime - now) / 1000 / 60;

    const channel_id = match.channel_id;
    const guild_id = match.guild_id;
    const keyBase = `${guild_id}_${match.match_id}_${ts}`;

    // 60-minute reminder
    if (diffMinutes > 59 && diffMinutes < 61) {
      const key = `${keyBase}_60`;
      if (!sent60.has(key)) {
        sent60.add(key);
        const gk = `${channel_id}_${ts}`;
        if (!grouped60.has(gk)) {
          grouped60.set(gk, { channel_id, timestamp: ts, lines: [] });
        }
        grouped60.get(gk).lines.push(`${cleanTeamName(match.home)} vs ${cleanTeamName(match.away)}`);
      }
    }

    // 5-minute reminder
    if (diffMinutes > 4 && diffMinutes < 6) {
      const key = `${keyBase}_kick`;
      if (!sentKick.has(key)) {
        sentKick.add(key);
        const gk = `${channel_id}_${ts}`;
        if (!groupedKick.has(gk)) {
          groupedKick.set(gk, { channel_id, timestamp: ts, lines: [] });
        }
        groupedKick.get(gk).lines.push(`${cleanTeamName(match.home)} vs ${cleanTeamName(match.away)}`);
      }
    }
  }

  // send 60-minute
  for (const [, group] of grouped60) {
    try {
      const channel = await client.channels.fetch(group.channel_id);
      if (!channel) continue;
      await channel.send({
        embeds: [{
          title: '⚽️ Interesting Match',
          description: [
            ...group.lines,
            '',
            `Kickoff <t:${group.timestamp}:R>.`
          ].join('\n')
        }]
      });
    } catch (err) {
      console.error(`Failed to send 60-min reminder to channel ${group.channel_id}`, err);
    }
  }

  // send 5-minute
  for (const [, group] of groupedKick) {
    try {
      const channel = await client.channels.fetch(group.channel_id);
      if (!channel) continue;
      await channel.send({
        embeds: [{
          title: '⚽️ Kickoff!',
          description: group.lines.join('\n')
        }]
      });
    } catch (err) {
      console.error(`Failed to send 5-min reminder to channel ${group.channel_id}`, err);
    }
  }
}

// --- Public: wire up intervals ---
export function setupMatchReminderScheduler(client) {
  // 1) Dispatch reminders every minute
  setInterval(() => {
    dispatchImminentReminders(client).catch(err =>
      console.error('[scheduler] dispatch error:', err?.message || err)
    );
  }, 60 * 1000);

  // 2) Refresh followed matches every 3 days (and once at boot)
  const runRefresh = () =>
    refreshFollowedReminders(client).catch(err =>
      console.error('[scheduler] refresh error:', err?.message || err)
    );

  runRefresh(); // initial
  setInterval(runRefresh, 3 * 24 * 60 * 60 * 1000); // every 3 days
}