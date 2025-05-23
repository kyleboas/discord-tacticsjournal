export function setupMatchReminderScheduler(client) {
  setInterval(async () => {
    const now = new Date();
    const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
    const timestamp = Math.floor(inOneHour.getTime() / 1000);

    const res = await pool.query(`
      SELECT * FROM match_reminders
      WHERE match_time BETWEEN NOW() AND NOW() + INTERVAL '1 hour'
    `);

    for (const match of res.rows) {
      const channel = await client.channels.fetch(match.channel_id);
      if (!channel) continue;
      await channel.send({
        embeds: [{
          title: '⚽️ Match Reminder',
          description: `${match.home} vs ${match.away} in <t:${timestamp}:R>.`
        }]
      });
    }
  }, 60 * 1000);
}