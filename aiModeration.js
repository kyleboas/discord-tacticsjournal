// aiModeration.js
import fetch from 'node-fetch';
import { Collection, EmbedBuilder } from 'discord.js';

const PERSPECTIVE_API_KEY = process.env.PERSPECTIVE_API_KEY;
const WATCH_CHANNELS = ['1371677909902819360', '1371677909902819360', '1098742662040920074', '1325150809104842752', '1273974012774711397', '1371507335372996760'];
const MOD_LOG_CHANNEL = '1099892476627669012';

const userStrikes = new Collection();
const STRIKE_RESET_MS = 60 * 60 * 1000; // 1 hour reset window

export const ATTRIBUTE_THRESHOLDS = {
  TOXICITY: 0.93,
  INSULT: 0.95,
  PROFANITY: 0.95,
  THREAT: 0.70,
  IDENTITY_ATTACK: 0.50,
  SEVERE_TOXICITY: 0.65
};

const ATTRIBUTE_EXPLANATIONS = {
  TOXICITY: 'Toxic language that may cause harm or discomfort.',
  INSULT: 'Insulting or disparaging remarks toward others.',
  PROFANITY: 'Contains strong or offensive language.',
  THREAT: 'May be interpreted as threatening someone.',
  IDENTITY_ATTACK: 'Attacks based on race, gender, or other identity.',
  SEVERE_TOXICITY: 'Extremely harmful or abusive language.',
  SELF_HARM: 'Encourages or references self-harm or suicide.',
  LGTBQ_SLUR: 'Contains anti-LGBTQ+ slurs or hate speech.',
  ABLEIST_SLUR: 'Uses language offensive toward disabled individuals.',
  RACIAL_SLUR: 'Uses racially offensive or dehumanizing language targeting individuals or groups based on race or ethnicity.'
};

const TRIGGER_PATTERNS = {
  SELF_HARM: [
    /\bk[\W_]*y[\W_]*s\b/i,
    /\bkill[\W_]*your[\W_]*self(ves)?\b/i
  ],
  LGTBQ_SLUR: [
    /\bf[a@4](g{1,2}|qq)([e3il1o0]t{1,2}(ry|r[i1l]e)?)?\b/i,
    /\btr[a4]n{1,2}([i1l][e3]|y|[e3]r)s?\b/i
  ],
  ABLEIST_SLUR: [
    /\br[\W_]*e[\W_]*t[\W_]*a[\W_]*r[\W_]*d[\W_]*e?[\W_]*d?\b/i,
    /\bt[\W_]*a[\W_]*r[\W_]*d\b/i,
    /\bg[\W_]*i[\W_]*m[\W_]*p\b/i
  ], 
  RACIAL_SLUR: [
    // n-word variants
    /\b(s[a@4]nd[\W_]*)?n[i1l!|a@o0][gq]{1,2}(l[e3]t|[e3]r|[a@4]|n[o0]g)?s?\b/i,

    // kike
    /\bk[il1y]k[e3](ry|rie)?s?\b/i,

    // coon
    /\bc[o0]{2}ns?\b/i,

    // chink
    /\bch[i1l]nks?\b/i,

    // gook
    /\bg[o0]{2}ks?\b/i,

    // spic
    /\bsp[i1l][ckq]+\b/i,

    // wetback
    /\bw[e3]t[\W_]*b[a@]ck\b/i,

    // zipperhead
    /\bz[i1l]pp[e3]r[\W_]*h[e3]a[d]+\b/i,

    // paki
    /\bp[a@]k[i1l]s?\b/i,

    // towelhead / raghead
    /\bt[o0]w[e3]l[\W_]*h[e3]a[d]+\b/i,
    /\br[a@]g[\W_]*h[e3]a[d]+\b/i,

    // camel jockey
    /\bc[a@]m[e3]l[\W_]*j[o0]ck[e3]y\b/i
  ]
};

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds !== 1 ? 's' : ''}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''}`;
  const days = Math.round(hours / 24);
  return `${days} day${days !== 1 ? 's' : ''}`;
}

// Environment-aware configuration
const ENABLE_AI_MOD = process.env.ENABLE_AI_MOD !== 'false'; // Enable by default in production
const TOXICITY_THRESHOLD = parseFloat(process.env.TOXICITY_THRESHOLD || '0.85');
const MOD_SAMPLE_RATE = parseFloat(process.env.MOD_SAMPLE_RATE || '1.0');

// Rate limiting for Perspective API
const messageCache = new Collection();
const RATE_LIMIT = parseInt(process.env.PERSPECTIVE_RATE_LIMIT || '30'); // Max requests per minute
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
    const durationDisplay = formatDuration(timeoutMs);

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
      const scoreData = moderationCache.get(Buffer.from(content).toString('base64'))?.result || {};
      await logChannel.send({
        content: [
          `**Message:**\n\`${content}\``,
          `\n**Normalized:**\n\`${normalizeText(content)}\``,
          `\n**User:**\n<@${message.author.id}>`,
          `\n**Evasion Match:** ${violations.includes('EVASION_ATTEMPT') ? 'Yes' : 'No'}`,
          `\n**Perspective Scores:**`,
          ...Object.entries(scoreData).map(([key, val]) => {
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

    // Public embed notice instead of DM
    try {
      const visibleViolations = violations
        .split(', ')
        .filter(reason => reason !== 'EVASION_ATTEMPT');
      
      const explanationSet = new Set(
        visibleViolations.map(v => ATTRIBUTE_EXPLANATIONS[v]?.trim()).filter(Boolean)
      );

      const explanations = [...explanationSet].join('\n');
      const scoreData = moderationCache.get(Buffer.from(content).toString('base64'))?.result || {};
      const scoreLines = Object.entries(scoreData).map(([key, val]) => {
        const percent = Math.round(val * 100);
        const warn = ATTRIBUTE_THRESHOLDS[key] && val >= ATTRIBUTE_THRESHOLDS[key] ? ' ⚠️' : '';
        return `${key}: ${percent}%${warn}`;
      });

      const embed = new EmbedBuilder()
        .setTitle('**AutoMod Violation** ⚠️')
        .addFields(
          { name: 'Message', value: `\`${content}\``, inline: true },
          { name: 'User', value: `<@${message.author.id}>`, inline: true },
          { name: 'Reason', value: `Strike ${strikeCount} - ${visibleViolations.join(', ')}`, inline: true },
          { name: 'Explanation', value: explanations || 'Unspecified', inline: false },
          { name: 'Reason Scores', value: scoreLines.join('\n') || 'N/A', inline: false },
          { name: 'Punishment', value: durationDisplay, inline: false }
        )
        .setColor(0xff0000)
        .setTimestamp();

      await message.channel.send({ embeds: [embed] });
    } catch (err) {
      console.error('Failed to send public moderation embed:', err);
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
    const manualCategoryMatches = [];

    if (content) {
      const normalizedText = normalizeText(content);

      evasionTriggered = evasionPatterns.some(pattern => pattern.test(normalizedText));

      for (const [category, patterns] of Object.entries(TRIGGER_PATTERNS)) {
        if (patterns.some(p => p.test(normalizedText))) {
          manualCategoryMatches.push(category);
        }
      }
    }
    
    if (!PERSPECTIVE_API_KEY) {
      console.error('Missing PERSPECTIVE_API_KEY');
      return;
    }

    // Check cache first
    const cachedResult = getCachedResult(content);
    if (cachedResult) {
      const thresholds = ATTRIBUTE_THRESHOLDS;

      const detected = Object.entries(cachedResult)
      .filter(([key, val]) => val !== undefined && (thresholds[key] || TOXICITY_THRESHOLD) <= val)
      .map(([key]) => key);

    const rawViolations = detected.includes('THREAT') && !detected.includes('TOXICITY')
      ? detected.filter(v => v !== 'THREAT')
      : detected;

      if (evasionTriggered && rawViolations.length > 0) {
      rawViolations.push('EVASION_ATTEMPT');
    }
      rawViolations.push(...manualCategoryMatches);

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

      const detected = Object.entries(attributes)
     .filter(([key, val]) => val?.summaryScore?.value !== undefined && 
        (thresholds[key] || TOXICITY_THRESHOLD) <= val.summaryScore.value)
      .map(([key]) => key);

    const rawViolations = detected.includes('THREAT') && !detected.includes('TOXICITY')
      ? detected.filter(v => v !== 'THREAT')
      : detected; 

      if (evasionTriggered && rawViolations.length > 0) {
      rawViolations.push('EVASION_ATTEMPT');
    }

  rawViolations.push(...manualCategoryMatches);

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