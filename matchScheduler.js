import { getStarredMatchesWindow } from './db.js';
import { markAndCheck } from './remindersDedupe.js';

    export function setupMatchReminderScheduler(client) {
      setInterval(async () => {
        const now = new Date();
        const windowTo = new Date(now.getTime() + 2 * 60 * 60 * 1000); // next 2h
        const matches = await getStarredMatchesWindow({ fromISO: now.toISOString(), toISO: windowTo.toISOString() });

        const grouped60 = {};
        const groupedKickoff = {};

        for (const match of matches) {
          const matchTime = new Date(match.match_time);
          const timestamp = Math.floor(matchTime.getTime() / 1000);
          const diffMinutes = (matchTime - now) / 1000 / 60;
          const key = `${match.channel_id}_${timestamp}`;
          
      // 60-min reminder
      if (diffMinutes > 59 && diffMinutes < 61) {
        const k = `rem60:${match.channel_id}:${timestamp}`;
        if (await markAndCheck(k, 7200)) {
        }
      }

      // 5-min kickoff
      if (diffMinutes > 4 && diffMinutes < 6) {
        const k = `kick:${match.channel_id}:${timestamp}`;
        if (await markAndCheck(k, 3600)) {
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