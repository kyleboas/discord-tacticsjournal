import { getMatchReminders } from './db.js';

export function setupMatchReminderScheduler(client) {
  setInterval(async () => {
    const now = new Date();
    const matches = await getMatchReminders();

    // Filter matches within 59-61 minutes from now
    const matchesIn60 = matches.filter(match => {
      const matchTime = new Date(match.match_time);
      const diffMinutes = (matchTime - now) / 1000 / 60;
      return diffMinutes > 59 && diffMinutes < 61;
    });

    // Group by channelId + timestamp
    const grouped = {};

    for (const match of matchesIn60) {
      const matchTime = new Date(match.match_time);
      const timestamp = Math.floor(matchTime.getTime() / 1000);
      const key = `${match.channel_id}_${timestamp}`;

      if (!grouped[key]) {
        grouped[key] = {
          channel_id: match.channel_id,
          timestamp,
          matches: []
        };
      }

      grouped[key].matches.push(`${match.home} vs ${match.away}`);
    }

    for (const key in grouped) {
      const group = grouped[key];

      try {
        const channel = await client.channels.fetch(group.channel_id);
        if (!channel) continue;

        await channel.send({
          embeds: [{
            title: '⚽️ Match Reminder',
            description: [
              ...group.matches.map(line => `${line}`),
              '',
              `Starts <t:${group.timestamp}:R>.`
            ].join('\n')
          }]
        });
      } catch (err) {
        console.error(`Failed to send grouped reminder to channel ${group.channel_id}`, err);
      }
    }
  }, 60 * 1000);
}