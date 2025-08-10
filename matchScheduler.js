// matchScheduler.js
import { getStarredMatchesWindow } from './db.js';

// In-memory dedupe (resets on restart)
const sent60 = new Set();    // keys like "channelId_unixTs"
const sentKick = new Set();  // keys like "channelId_unixTs"

// Simple GC so the sets don't grow unbounded
function gcSets(nowSec) {
  for (const k of sent60) {
    const ts = Number(k.split('_').pop());
    if (!Number.isFinite(ts) || ts < nowSec - 2 * 60 * 60) sent60.delete(k); // drop older than 2h ago
  }
  for (const k of sentKick) {
    const ts = Number(k.split('_').pop());
    if (!Number.isFinite(ts) || ts < nowSec - 2 * 60 * 60) sentKick.delete(k);
  }
}

export function setupMatchReminderScheduler(client) {
  setInterval(async () => {
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    gcSets(nowSec);

    // Look ahead 2h
    const windowTo = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const matches = await getStarredMatchesWindow({
      fromISO: now.toISOString(),
      toISO: windowTo.toISOString(),
    });

    const grouped60 = {};
    const groupedKickoff = {};

    for (const match of matches) {
      const matchTime = new Date(match.match_time);
      const ts = Math.floor(matchTime.getTime() / 1000);
      const diffMinutes = (matchTime - now) / 1000 / 60;
      const groupKey = `${match.channel_id}_${ts}`;

      // 60‑min reminder window
      if (diffMinutes > 59 && diffMinutes < 61) {
        if (!sent60.has(groupKey)) {
          sent60.add(groupKey);
          if (!grouped60[groupKey]) {
            grouped60[groupKey] = { channel_id: match.channel_id, timestamp: ts, matches: [] };
          }
          grouped60[groupKey].matches.push(`${match.home} vs ${match.away}`);
        }
      }

      // 5‑min kickoff window
      if (diffMinutes > 4 && diffMinutes < 6) {
        if (!sentKick.has(groupKey)) {
          sentKick.add(groupKey);
          if (!groupedKickoff[groupKey]) {
            groupedKickoff[groupKey] = { channel_id: match.channel_id, timestamp: ts, matches: [] };
          }
          groupedKickoff[groupKey].matches.push(`${match.home} vs ${match.away}`);
        }
      }
    }

    // Send 60‑min reminders (grouped by channel + kickoff time)
    for (const [, group] of Object.entries(grouped60)) {
      try {
        const channel = await client.channels.fetch(group.channel_id);
        if (!channel) continue;
        await channel.send({
          embeds: [{
            title: '⚽️ Match Reminder',
            description: [
              ...group.matches,
              '',
              `Starts <t:${group.timestamp}:R>.`
            ].join('\n')
          }]
        });
      } catch (err) {
        console.error(`Failed to send 60 min reminder to channel ${group.channel_id}`, err);
      }
    }

    // Send kickoff alerts (T‑5)
    for (const [, group] of Object.entries(groupedKickoff)) {
      try {
        const channel = await client.channels.fetch(group.channel_id);
        if (!channel) continue;
        await channel.send({
          embeds: [{
            title: '⚽️ Kickoff!',
            description: group.matches.join('\n')
          }]
        });
      } catch (err) {
        console.error(`Failed to send kickoff alert to channel ${group.channel_id}`, err);
      }
    }
  }, 60 * 1000);
}