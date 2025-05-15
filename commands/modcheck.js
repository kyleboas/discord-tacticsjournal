import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import fetch from 'node-fetch';
import {
  normalizeText,
  ATTRIBUTE_THRESHOLDS,
  TRIGGER_PATTERNS,
  EVASION_ATTRIBUTE_PATTERNS
} from '../aiModeration.js';

const MODERATOR_ROLE_ID = '1100369095251206194';

export const data = new SlashCommandBuilder()
  .setName('modcheck')
  .setDescription('Test a message against moderation filters.')
  .addStringOption(option =>
    option.setName('message')
      .setDescription('Message to analyze')
      .setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .setDMPermission(false);

export async function execute(interaction) {
  const memberRoles = interaction.member.roles;
  if (!memberRoles.cache.has(MODERATOR_ROLE_ID)) {
    return interaction.reply({
      content: 'You do not have permission to use this command.',
      ephemeral: true
    });
  }

  const input = interaction.options.getString('message');
  const normalized = normalizeText(input);

  const patternMatches = new Set();
  const validViolations = new Set();

  // Only store pattern matches initially, don't add to validViolations yet
  for (const { attribute, pattern } of EVASION_ATTRIBUTE_PATTERNS) {
    if (pattern.test(normalized)) patternMatches.add(attribute);
  }

  // Trigger patterns (slurs, etc.) are added directly to validViolations
  for (const [category, patterns] of Object.entries(TRIGGER_PATTERNS)) {
    if (patterns.some(p => p.test(normalized))) validViolations.add(category);
  }

  let reasons = [];
  let perspectiveResult = '';
  let moderationTriggered = false;

  try {
    const res = await fetch(`https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${process.env.PERSPECTIVE_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        comment: { text: normalized },
        languages: ['en'],
        requestedAttributes: Object.fromEntries(Object.keys(ATTRIBUTE_THRESHOLDS).map(k => [k, {}]))
      })
    });

    const data = await res.json();

    if (data.attributeScores) {
      const entries = Object.entries(data.attributeScores);
      const scores = {};
      
      perspectiveResult = entries
        .map(([key, val]) => {
          const score = val.summaryScore.value;
          scores[key] = score;
          const hit = score >= ATTRIBUTE_THRESHOLDS[key];
          if (hit) reasons.push(key);
          return `${key}: ${Math.round(score * 100)}%${hit ? ' ⚠️' : ''}`;
        })
        .join('\n');
      
      // Only add pattern matches to violations if they also meet score thresholds
      for (const attribute of patternMatches) {
        if (scores[attribute] !== undefined && 
            scores[attribute] >= (ATTRIBUTE_THRESHOLDS[attribute] || 0.85)) {
          validViolations.add(attribute);
          validViolations.add('EVASION_ATTEMPT');
        }
      }
    } else {
      perspectiveResult = 'Perspective API returned no scores.';
    }
  } catch (err) {
    perspectiveResult = 'Perspective API error: ' + err.message;
  }

  if (validViolations.size || reasons.length > 0) {
    moderationTriggered = true;
    reasons.push(...validViolations);
  }

  await interaction.reply({
    content: [
      `**Message:**\n\`${input}\``,
      `\n**Normalized:**\n\`${normalized}\``,
      `\n**Perspective Scores:**\n${perspectiveResult}`,
      `\n**Pattern Matches:** ${[...patternMatches].join(', ') || 'None'}`,
      `\n**Valid Violations:** ${[...validViolations].join(', ') || 'None'}`,
      `\n**Would Trigger Moderation:** ${moderationTriggered ? 'YES' : 'No'}`,
      moderationTriggered ? `Reasons: ${[...new Set(reasons)].join(', ')}` : ''
    ].join('\n'),
    ephemeral: true
  });
}