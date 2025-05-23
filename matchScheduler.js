// matchScheduler.js
import { getMatchReminders } from './db.js';

export function setupMatchReminderScheduler(client) {
  setInterval(async () => {
    const now = new Date();
    const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);

    // Get matches from DB
    const matches = await getMatchReminders();

    for (const match of matches) {
      const matchTime = new Date(match.match_time);
      const diffMinutes = (matchTime - now) / 1000 / 60;

      if (diffMinutes > 59 && diffMinutes < 61) {
        const timestamp = Math.floor(matchTime.getTime() / 1000);

        try {
          const channel = await client.channels.fetch(match.channel_id);
          if (!channel) continue;

          await channel.send({
            embeds: [{
              title: '⚽️ Match Reminder',
              description: `${match.home} vs ${match.away} in <t:${timestamp}:R>.`
            }]
          });
        } catch (err) {
          console.error(`Failed to send reminder to channel ${match.channel_id}`, err);
        }
      }
    }
  }, 60 * 1000);
}