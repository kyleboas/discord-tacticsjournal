// aiModeration.js
import fetch from 'node-fetch';
import { Collection } from 'discord.js';

const PERSPECTIVE_API_KEY = process.env.PERSPECTIVE_API_KEY;
const WATCH_CHANNELS = ['1371677909902819360', '1371677909902819360', '1098742662040920074', '1325150809104842752', '1273974012774711397', '1371507335372996760'];
const MOD_LOG_CHANNEL = '1099892476627669012';

const userStrikes = new Collection();
const STRIKE_RESET_MS = 60 * 60 * 1000; // 1 hour reset window

export const ATTRIBUTE_THRESHOLDS = {
  TOXICITY: 0.85,
  INSULT: 0.75,
  PROFANITY: 0.90,
  THREAT: 0.45,
  IDENTITY_ATTACK: 0.30,
  SEVERE_TOXICITY: 0.45
};

const ATTRIBUTE_EXPLANATIONS = {
  TOXICITY: 'Toxic language that may cause harm or discomfort.',
  INSULT: 'Insulting or disparaging remarks toward others.',
  PROFANITY: 'Contains strong or offensive language.',
  THREAT: 'May be interpreted as threatening someone.',
  IDENTITY_ATTACK: 'Attacks based on race, gender, or other identity.',
  SEVERE_TOXICITY: 'Extremely harmful or abusive language.'
};

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

    const strikeCount = incrementStrikes(message.author.id);
    const timeoutMs = getTimeoutDuration(strikeCount);

    // Timeout the user (if guild member)
    if (message.guild && message.member) {
      try {
        await message.member.timeout(timeoutMs, `AI moderation strike ${strikeCount}: ${violations}`);
      } catch (err) {
        console.error('Failed to timeout user:', err);
      }
    }

    // Send log message
    try {
      const logChannel = await message.client.channels.fetch(MOD_LOG_CHANNEL);
      await logChannel.send({
        content: [
          `**Message:**\n\`${content}\``,
          `\n**Normalized:**\n\`${normalizeText(content)}\``,
          `\n**User:**\n<@${message.author.id}>`,
          `\n**Evasion Match:** ${violations.includes('EVASION_ATTEMPT') ? 'Yes' : 'No'}`,
          `\n**Perspective Scores:**`,
          ...Object.entries(moderationCache.get(Buffer.from(content).toString('base64'))?.result || {})
            .map(([key, val]) => {
              const percent = Math.round(val * 100);
              const warn = ATTRIBUTE_THRESHOLDS[key] && val >= ATTRIBUTE_THRESHOLDS[key] ? ' ⚠️' : '';
              return `${key}: ${percent}%${warn}`;
            }),
          `\n\n**Would Trigger Moderation:** YES`,
          `Reasons: ${violations}`
        ].join('\n')
      });
    } catch (logErr) {
      console.error('Could not log moderation action:', logErr);
    }

    // Temporary public reply (auto-deletes)
    // DM user strike info
    try {
      const visibleViolations = violations
      .split(', ')
      .filter(reason => reason !== 'EVASION_ATTEMPT')
      .join(', ') || 'unspecified violation';
      
      const explanations = visibleViolations
      .split(', ')
      .map(v => ATTRIBUTE_EXPLANATIONS[v]?.trim())
      .filter(Boolean)
      .join('\n');
  
      await message.author.send(
      `You received strike ${strikeCount} for a removed message.\nReason: **${visibleViolations}**\n${explanations ? `\n\n**Explanation:**\n${explanations}` : ''}\nTimeout: ${timeoutMs / 1000}s`
    );
    } catch (dmError) {
      console.warn(`Failed to DM user ${message.author.id} about timeout.`);
    }
  } catch (err) {
    console.error('Failed to handle moderation violation:', err);
  }
}

export function normalizeText(text) {
  // Replace common evasion tactics with normal characters
  return text
    .replace(/\s+/g, ' ')               // Normalize spaces
    .replace(/[0@\*\(\)\[\]{}]/g, 'o')  // Replace 0, @, *, etc. with 'o'
    .replace(/[$5]/g, 's')              // $ and 5 to 's'
    .replace(/[1!|]/g, 'i')             // 1, !, | to 'i'
    .replace(/[4@]/g, 'a')              // 4, @ to 'a'
    .replace(/3/g, 'e')                 // 3 to 'e'
    .replace(/7/g, 't')                 // 7 to 't'
    .replace(/0/g, 'o')                 // 0 to 'o'
    .replace(/\+/g, 't')                // + to 't'
    .replace(/\./g, '')                 // Remove dots (s.h.i.t)
    .toLowerCase();                     // Make lowercase
}

function incrementStrikes(userId) {
  const now = Date.now();
  const current = userStrikes.get(userId) || { count: 0, last: now };
  const recent = now - current.last < STRIKE_RESET_MS;
  const updated = {
    count: recent ? current.count + 1 : 1,
    last: now
  };
  userStrikes.set(userId, updated);
  return updated.count;
}

function getTimeoutDuration(strikeCount) {
  if (strikeCount === 1) return 30 * 1000;
  if (strikeCount === 2) return 60 * 1000;
  if (strikeCount === 3) return 5 * 60 * 1000;
  return 10 * 60 * 1000; // escalated timeout
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
    
    const evasionPatterns = [
      // fuck variations
      /\bf+[\s._-]*[uuv]+[\s._-]*[c(kq)]+[\s._-]*k*\b/i,
      /\bf[a@]k\b/i,
      /\bf[\s]*u[\s]*k\b/i,

      // shit variations
      /\bs+[\s._-]*[h]+[\s._-]*[i1!|]+[\s._-]*[t7]+\b/i,
      /\bs[\s]*h[\s]*e[e3]*[\s]*t/i,

      // bitch variations
      /\bb+[\s._-]*[i1!|]+[\s._-]*[t7]+[\s._-]*[c(kq)]+[\s._-]*h+\b/i,
      /\bb[e3]+[\s]*[t7]+[\s]*c[h]+/i,

      // ass / a55 variations
      /\b[a@]+[\s._-]*[s$5]+[\s._-]*[s$5]+\b/i,

      // n-word slur variations
      /\bn+[\s._-]*[i1!|]+[\s._-]*g+[\s._-]*g+[\s._-]*[ae4@]+\b/i,

      // rape
      /\br+[\s._-]*[ae4]+[\s._-]*p+[\s._-]*[e3]+\b/i,

      // kill
      /\bk+[\s._-]*[i1!|]+[\s._-]*l+[\s._-]*l+\b/i,

      // gay insult use
      /\bg+[\s._-]*[a@]+[\s._-]*[y]+[\s._-]*[b]+[\s._-]*[o0]+[\s._-]*[i1!|]+\b/i,

      // retard
      /\br+[\s._-]*[e3]+[\s._-]*[t7]+[\s._-]*[a@]+[\s._-]*[r]+[\s._-]*[d]+\b/i,

      // porn/sex/explicit slang
      /\bp+[\s._-]*[o0]+[\s._-]*[r]+[\s._-]*[n]+\b/i,
      /\b[s$5]+[\s._-]*[e3]+[\s._-]*[x]+/i
    ];
    
    let evasionTriggered = false;

    if (content) {
      const normalizedText = normalizeText(content);
      evasionTriggered = evasionPatterns.some(pattern => pattern.test(normalizedText));
    }
    
    if (!PERSPECTIVE_API_KEY) {
      console.error('Missing PERSPECTIVE_API_KEY');
      return;
    }

    // Check cache first
    const cachedResult = getCachedResult(content);
    if (cachedResult) {
      const thresholds = ATTRIBUTE_THRESHOLDS;

      const detected = Object.entries(attributes)
      .filter(([key, val]) => (thresholds[key] || TOXICITY_THRESHOLD) <= val.summaryScore.value)
      .map(([key]) => key);

    const rawViolations = detected.includes('THREAT') && !detected.includes('TOXICITY')
      ? detected.filter(v => v !== 'THREAT')
      : detected;

      if (evasionTriggered && rawViolations.length > 0) {
        rawViolations.push('EVASION_ATTEMPT');
      }

      const violations = rawViolations.join(', ');

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
          PROFANITY: {},
          THREAT: {},
          IDENTITY_ATTACK: {},
          SEVERE_TOXICITY: {}
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

      const thresholds = ATTRIBUTE_THRESHOLDS;

      const detected = 
      Object.entries(attributes)
      .filter(([key, val]) => (thresholds[key] || TOXICITY_THRESHOLD) <= val.summaryScore.value)
      .map(([key]) => key);

    const rawViolations = detected.includes('THREAT') && !detected.includes('TOXICITY')
      ? detected.filter(v => v !== 'THREAT')
      : detected; 

      if (evasionTriggered && rawViolations.length > 0) {
        rawViolations.push('EVASION_ATTEMPT');
      }

      const violations = rawViolations.join(', ');

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