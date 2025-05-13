// aiModeration.js
import OpenAI from 'openai';

// Read OpenAI API key from Railway environment variable
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Set your moderation log channel ID here
const MOD_LOG_CHANNEL = '1099892476627669012';

// Toggle moderation system
const ENABLE_AI_MOD = true;

client.on('messageCreate', async (message) => {
  if (!ENABLE_AI_MOD) return;
  if (message.author.bot || message.system) return;

  try {
    // Send message content to OpenAI moderation API
    const result = await openai.moderations.create({ input: message.content });
    const flagged = result.results[0].flagged;

    // Gather flagged categories
    const reasons = Object.entries(result.results[0].categories)
      .filter(([_, isFlagged]) => isFlagged)
      .map(([category]) => category)
      .join(', ');

    if (flagged) {
      // Delete the flagged message
      await message.delete();

      // Notify the user via DM
      await message.author.send(
        `Your message was flagged and removed for violating community guidelines.\nReason: **${reasons}**`
      );

      // Log the incident to the moderation channel
      const modChannel = await client.channels.fetch(MOD_LOG_CHANNEL);
      await modChannel.send(
        `**Flagged Message Deleted**\nAuthor: <@${message.author.id}>\nReason: ${reasons}\nContent:\n${message.content}`
      );
    }
  } catch (err) {
    console.error('AI moderation error:', err);
  }
});