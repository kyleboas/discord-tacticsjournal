// matchScheduler.js
import {
  listGuildSubscribedTeams,
  getReminderChannel,
  upsertGuildMatchReminder,
  purgeOldReminders,
  getUpcomingRemindersWindow
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
function toISODate(d) {
  return new Date(d).toISOString().slice(0, 10);
}
function addDaysISO(dateISO, d) {
  const base = new Date(dateISO + 'T00:00:00Z');
  base.setUTCDate(base.getUTCDate() + d);
  return base.toISOString().slice(0, 10);
}

// --- Core: refresh reminders every 3 days ---
async function refreshFollowedVsFollowedReminders(client, horizonDays = 14) {
  const todayISO = toISODate(new Date());

  // traverse all guilds the bot is in
  for (const [, guild] of client.guilds.cache) {
    try {
      const guild_id = guild.id;
      const channel_id = await getReminderChannel(guild_id);
      if (!channel_id) continue; // no reminders channel set

      const followed = await listGuildSubscribedTeams(guild_id); // [{team_id, team_name}]
      if (!followed.length) continue;

      const followedIds = new Set(followed.map(t => String(t.team_id)));

      const fromISO = todayISO;
      const toISO = addDaysISO(todayISO, horizonDays);

      // Pull fixtures for each followed team in the window
      const allMatches = [];
      for (const t of followed) {
        try {
          const rows = await fetchTeamFixtures({
            teamId: t.team_id,
            fromISO,
            toISO
          });
          allMatches.push(...rows);
        } catch (err) {
          console.warn(`[scheduler] fetchTeamFixtures failed t=${t.team_id}:`, err?.message || err);
        }
      }

      // Keep only matches where BOTH sides are followed in this guild
      const bothFollowed = [];
      const seen = new Set(); // match_id dedupe
      for (const m of allMatches) {
        if (!m?.match_id) continue;
        if (seen.has(m.match_id)) continue;
        seen.add(m.match_id);

        const h = m.home_id ? String(m.home_id) : null;
        const a = m.away_id ? String(m.away_id) : null;

        // require both IDs to be present and followed
        if (h && a && followedIds.has(h) && followedIds.has(a)) {
          bothFollowed.push(m);
        }
      }

      // Upsert reminders
      for (const m of bothFollowed) {
        try {
          await upsertGuildMatchReminder({
            guild_id,
            channel_id,
            match_id: m.match_id,
            match_time: m.match_time,
            home: cleanTeamName(m.home || 'TBD'),
            away: cleanTeamName(m.away || 'TBD')
          });
        } catch (err) {
          console.warn(`[scheduler] upsert reminder failed match=${m.match_id} guild=${guild_id}:`, err?.message || err);
        }
      }
    } catch (err) {
      console.warn(`[scheduler] guild refresh failed:`, err?.message || err);
    }
  }

  // housekeeping
  try {
    await purgeOldReminders();
  } catch (e) {
    console.warn('[scheduler] purgeOldReminders failed:', e?.message || e);
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

    // 60‑minute reminder
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

    // 5‑minute reminder
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

  // send 60‑minute
  for (const [, group] of grouped60) {
    try {
      const channel = await client.channels.fetch(group.channel_id);
      if (!channel) continue;
      await channel.send({
        embeds: [{
          title: '⚽️ Match Reminder (60 min)',
          description: [
            ...group.lines,
            '',
            `Starts <t:${group.timestamp}:R>.`
          ].join('\n')
        }]
      });
    } catch (err) {
      console.error(`Failed to send 60‑min reminder to channel ${group.channel_id}`, err);
    }
  }

  // send 5‑minute
  for (const [, group] of groupedKick) {
    try {
      const channel = await client.channels.fetch(group.channel_id);
      if (!channel) continue;
      await channel.send({
        embeds: [{
          title: '⚽️ Kickoff in 5!',
          description: group.lines.join('\n')
        }]
      });
    } catch (err) {
      console.error(`Failed to send 5‑min reminder to channel ${group.channel_id}`, err);
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

  // 2) Refresh followed‑vs‑followed matches every 3 days (and once at boot)
  const runRefresh = () =>
    refreshFollowedVsFollowedReminders(client).catch(err =>
      console.error('[scheduler] refresh error:', err?.message || err)
    );

  runRefresh(); // initial
  setInterval(runRefresh, 3 * 24 * 60 * 60 * 1000); // every 3 days
}