// commands/modcheck.js
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import fetch from 'node-fetch';
import { normalizeText, ATTRIBUTE_THRESHOLDS } from '../aiModeration.js';

const MODERATOR_ROLE_ID = '1100369095251206194';

export const data = new SlashCommandBuilder()
  .setName('modcheck')
  .setDescription('Test a message against moderation filters.')
  .addStringOption(option =>
    option.setName('message')
      .setDescription('Message to analyze')
      .setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages) // optional: restrict at default level
  .setDMPermission(false); // disallow in DMs
  
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

  const evasionPatterns = [
    /\bf+[\s._-]*[uuv]+[\s._-]*[c(kq)]+[\s._-]*k*\b/i,
    /\bf[a@]k\b/i,
    /\bf[\s]*u[\s]*k\b/i,
    /\bs+[\s._-]*[h]+[\s._-]*[i1!|]+[\s._-]*[t7]+\b/i,
    /\bs[\s]*h[\s]*e[e3]*[\s]*t/i,
    /\bb+[\s._-]*[i1!|]+[\s._-]*[t7]+[\s._-]*[c(kq)]+[\s._-]*h+\b/i,
    /\bb[e3]+[\s]*[t7]+[\s]*c[h]+/i,
    /\b[a@]+[\s._-]*[s$5]+[\s._-]*[s$5]+\b/i,
    /\bn+[\s._-]*[i1!|]+[\s._-]*g+[\s._-]*g+[\s._-]*[ae4@]+\b/i,
    /\br+[\s._-]*[ae4]+[\s._-]*p+[\s._-]*[e3]+\b/i,
    /\bk+[\s._-]*[i1!|]+[\s._-]*l+[\s._-]*l+\b/i,
    /\bg+[\s._-]*[a@]+[\s._-]*[y]+[\s._-]*[b]+[\s._-]*[o0]+[\s._-]*[i1!|]+\b/i,
    /\br+[\s._-]*[e3]+[\s._-]*[t7]+[\s._-]*[a@]+[\s._-]*[r]+[\s._-]*[d]+\b/i,
    /\bp+[\s._-]*[o0]+[\s._-]*[r]+[\s._-]*[n]+\b/i,
    /\b[s$5]+[\s._-]*[e3]+[\s._-]*[x]+/i
  ];
  const evasionMatched = evasionPatterns.some(p => p.test(normalized));

  const thresholds = ATTRIBUTE_THRESHOLDS;

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
        requestedAttributes: Object.fromEntries(Object.keys(thresholds).map(k => [k, {}]))
      })
    });

    const data = await res.json();

    if (data.attributeScores) {
      const entries = Object.entries(data.attributeScores);
      perspectiveResult = entries
        .map(([key, val]) => {
          const score = val.summaryScore.value;
          const hit = score >= (thresholds[key] || 0.85);
          if (hit) reasons.push(key);
          return `${key}: ${Math.round(score * 100)}%${hit ? ' ⚠️' : ''}`;
        })
        .join('\n');

      if (reasons.length > 0 || evasionMatched) {
        moderationTriggered = true;
        if (evasionMatched) reasons.push('EVASION_ATTEMPT');
      }
    } else {
      perspectiveResult = 'Perspective API returned no scores.';
    }

  } catch (err) {
    perspectiveResult = 'Perspective API error: ' + err.message;
  }

  await interaction.reply({
    content: `**Message:**\n\`${input}\`\n\n**Normalized:**\n\`${normalized}\`\n\n**Evasion Match:** ${evasionMatched ? 'Yes' : 'No'}\n\n**Perspective Scores:**\n${perspectiveResult}\n\n**Would Trigger Moderation:** ${moderationTriggered ? 'YES' : 'No'}${moderationTriggered ? `\nReasons: ${reasons.join(', ')}` : ''}`,
    ephemeral: true
  });
}