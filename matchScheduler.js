import { getMatchReminders } from './db.js';

const sentReminderKeys = new Set();     // 60 min reminder
const sentKickoffKeys = new Set();      // match start

export function setupMatchReminderScheduler(client) {
  setInterval(async () => {
    const now = new Date();
    const matches = await getMatchReminders();

    const grouped60 = {};
    const groupedKickoff = {};

    for (const match of matches) {
      const matchTime = new Date(match.match_time);
      const timestamp = Math.floor(matchTime.getTime() / 1000);
      const diffMinutes = (matchTime - now) / 1000 / 60;
      const key = `${match.channel_id}_${timestamp}`;

      if (diffMinutes > 59 && diffMinutes < 61 && !sentReminderKeys.has(key)) {
        if (!grouped60[key]) {
          grouped60[key] = { channel_id: match.channel_id, timestamp, matches: [] };
        }
        grouped60[key].matches.push(`${match.home} vs ${match.away}`);
      }

      if (diffMinutes > 4 && diffMinutes < 6 && !sentKickoffKeys.has(key)) {
        if (!groupedKickoff[key]) {
          groupedKickoff[key] = { channel_id: match.channel_id, timestamp, matches: [] };
        }
        groupedKickoff[key].matches.push(`${match.home} vs ${match.away}`);
      }
    }

    for (const key in grouped60) {
      const group = grouped60[key];
      sentReminderKeys.add(key);
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

    for (const key in groupedKickoff) {
      const group = groupedKickoff[key];
      sentKickoffKeys.add(key);
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