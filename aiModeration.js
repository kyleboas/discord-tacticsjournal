// perspectiveModeration.js
import fetch from 'node-fetch';

// Your Google Perspective API key (store in Railway as PERSPECTIVE_API_KEY)
const PERSPECTIVE_API_KEY = process.env.PERSPECTIVE_API_KEY;

// Only scan messages from this channel
const WATCH_CHANNEL = '1371677909902819360';
const MOD_LOG_CHANNEL = '1099892476627669012';

const ENABLE_AI_MOD = true;
const TOXICITY_THRESHOLD = 0.85;

export function setupModeration(client) {
  client.on('messageCreate', async (message) => {
    if (!ENABLE_AI_MOD) return;
    if (message.channel.id !== WATCH_CHANNEL) return;
    if (message.author.bot || message.system) return;

    try {
      const result = await fetch(`https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${PERSPECTIVE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comment: { text: message.content },
          languages: ['en'],
          requestedAttributes: {
            TOXICITY: {}, INSULT: {}, THREAT: {}, PROFANITY: {}
          }
        })
      });

      const data = await result.json();
      const attributes = data.attributeScores;

      const violations = Object.entries(attributes)
        .filter(([_, v]) => v.summaryScore.value >= TOXICITY_THRESHOLD)
        .map(([attr]) => attr)
        .join(', ');

      if (violations.length > 0) {
        await message.delete();
        await message.author.send(
          `Your message was flagged and removed for violating community guidelines.\nReason: **${violations}**`
        );
        const logChannel = await client.channels.fetch(MOD_LOG_CHANNEL);
        await logChannel.send(
          `**Flagged Message Deleted**\nAuthor: <@${message.author.id}>\nReason: ${violations}\nContent:\n${message.content}`
        );
      }
    } catch (err) {
      console.error('Perspective moderation error:', err);
    }
  });
}