// aiModeration.js
import fetch from 'node-fetch';
import { Collection } from 'discord.js';

const PERSPECTIVE_API_KEY = process.env.PERSPECTIVE_API_KEY;
const WATCH_CHANNELS = ['1371677909902819360', '1371677909902819360', '1098742662040920074', '1325150809104842752', '1273974012774711397', '1371507335372996760'];
const MOD_LOG_CHANNEL = '1099892476627669012';

// Environment-aware configuration
const ENABLE_AI_MOD = process.env.ENABLE_AI_MOD !== 'false'; // Enable by default in production
const TOXICITY_THRESHOLD = parseFloat(process.env.TOXICITY_THRESHOLD || '0.85');
const MOD_SAMPLE_RATE = parseFloat(process.env.MOD_SAMPLE_RATE || '1.0'); // Only check 50% of messages

// Rate limiting for Perspective API
const messageCache = new Collection();
const RATE_LIMIT = parseInt(process.env.PERSPECTIVE_RATE_LIMIT || '10'); // Max requests per minute
let requestsThisMinute = 0;
let rateLimitReset = Date.now() + 60000;

function canMakeRequest() {
  if (Date.now() > rateLimitReset) {
    requestsThisMinute = 0;
    rateLimitReset = Date.now() + 60000;
  }
  
  return requestsThisMinute < RATE_LIMIT;
}

// Cache recent moderation results to avoid duplicate API calls
const moderationCache = new Collection();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function getCachedResult(content) {
  const contentHash = Buffer.from(content).toString('base64');
  const cached = moderationCache.get(contentHash);
  
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    return cached.result;
  }
  
  return null;
}

function setCachedResult(content, result) {
  // Don't let cache grow too large
  if (moderationCache.size > 100) {
    // Remove oldest entries
    const oldestKeys = Array.from(moderationCache.keys())
      .sort((a, b) => moderationCache.get(a).timestamp - moderationCache.get(b).timestamp)
      .slice(0, 20);
      
    for (const key of oldestKeys) {
      moderationCache.delete(key);
    }
  }
  
  const contentHash = Buffer.from(content).toString('base64');
  moderationCache.set(contentHash, {
    result,
    timestamp: Date.now()
  });
}

async function handleViolation(message, violations, content) {
  try {
    await message.delete();
    
    try {
      await message.author.send(
        `Your message was flagged and removed for violating community guidelines.\nReason: **${violations}**`
      );
    } catch (dmError) {
      console.log(`Could not DM user ${message.author.id} about moderation action`);
    }
    
    // Log the violation
    try {
      const logChannel = await message.client.channels.fetch(MOD_LOG_CHANNEL);
      await logChannel.send(
        `**Flagged Message Deleted**\nAuthor: <@${message.author.id}>\nReason: ${violations}\nContent:\n${content}`
      );
    } catch (logError) {
      console.error('Could not log moderation action:', logError);
    }
  } catch (err) {
    console.error('Failed to handle moderation violation:', err);
  }
}

export function setupModeration(client) {
  client.on('messageCreate', async (message) => {
    if (!ENABLE_AI_MOD) return;
    if (!WATCH_CHANNELS.includes(message.channel.id)) return;
    if (message.author.bot || message.system) return;

    if (message.member?.roles.cache.has('1100369095251206194')) return;
    
    const content = message.content?.trim();
    if (!content) return;
    
    // Sample rate - only process some messages to reduce API costs
    if (Math.random() > MOD_SAMPLE_RATE) return;
    
    if (!PERSPECTIVE_API_KEY) {
      console.error('Missing PERSPECTIVE_API_KEY');
      return;
    }

    // Check cache first
    const cachedResult = getCachedResult(content);
    if (cachedResult) {
      const violations = Object.entries(cachedResult)
        .filter(([_, score]) => score >= TOXICITY_THRESHOLD)
        .map(([attr]) => attr)
        .join(', ');

      if (violations.length > 0) {
        await handleViolation(message, violations, content);
      }
      return;
    }
    
    // Check rate limit
    if (!canMakeRequest()) {
      console.log('Perspective API rate limit reached, skipping moderation');
      return;
    }

    try {
      requestsThisMinute++;
      
      const result = await fetch(`https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${PERSPECTIVE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comment: { text: content },
          languages: ['en'],
          requestedAttributes: {
            TOXICITY: {},
            INSULT: {},
            THREAT: {},
            PROFANITY: {}
          }
        }),
        // Add timeout to prevent hanging requests
        timeout: 5000
      });

      const data = await result.json();

      if (!data.attributeScores) {
        console.error('Unexpected Perspective API response:', data);
        return;
      }

      const attributes = data.attributeScores;
      
      // Store scores in cache
      const scores = Object.fromEntries(
        Object.entries(attributes).map(([key, value]) => [key, value.summaryScore.value])
      );
      setCachedResult(content, scores);

      const violations = Object.entries(attributes)
        .filter(([_, v]) => v.summaryScore.value >= TOXICITY_THRESHOLD)
        .map(([attr]) => attr)
        .join(', ');

      if (violations.length > 0) {
        await handleViolation(message, violations, content);
      }
    } catch (err) {
      if (err.type === 'request-timeout') {
        console.error('Perspective API request timed out');
      } else {
        console.error('Perspective moderation error:', err);
      }
    }
  });
}