import { getStarredMatchesWindow } from './db.js';
import { markAndCheck } from './remindersDedupe.js';

export function setupMatchReminderScheduler(client) {
  setInterval(async () => {
    const now = new Date();
    const windowTo = new Date(now.getTime() + 2 * 60 * 60 * 1000); // next 2h
    const matches = await getStarredMatchesWindow({
      fromISO: now.toISOString(),
      toISO: windowTo.toISOString()
    });

    const grouped60 = {};
    const groupedKickoff = {};

    for (const match of matches) {
      const matchTime = new Date(match.match_time);
      const timestamp = Math.floor(matchTime.getTime() / 1000);
      const diffMinutes = (matchTime - now) / 1000 / 60;
      const groupKey = `${match.channel_id}_${timestamp}`;

      // 60-min reminder
      if (diffMinutes > 59 && diffMinutes < 61) {
        const k = `rem60:${groupKey}`;
        if (await markAndCheck(k, 7200)) {
          if (!grouped60[groupKey]) {
            grouped60[groupKey] = { channel_id: match.channel_id, timestamp, matches: [] };
          }
          grouped60[groupKey].matches.push(`${match.home} vs ${match.away}`);
        }
      }

      // 5-min kickoff
      if (diffMinutes > 4 && diffMinutes < 6) {
        const k = `kick:${groupKey}`;
        if (await markAndCheck(k, 3600)) {
          if (!groupedKickoff[groupKey]) {
            groupedKickoff[groupKey] = { channel_id: match.channel_id, timestamp, matches: [] };
          }
          groupedKickoff[groupKey].matches.push(`${match.home} vs ${match.away}`);
        }
      }
    } // <-- CLOSES the matches loop

    // Send 60-min reminders
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

    // Send kickoff alerts
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
  }, 60 * 1000); // <-- closes setInterval
} // <-- closes function