// commands/fixtures.js
import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ComponentType,
  MessageFlags
} from 'discord.js';

import {
  listCachedFixtures,
  getUpcomingRemindersWindow
} from '../db.js';

import { cleanTeamName } from '../providers/footballApi.js';

// ---------- utils (minimal set for upcoming) ----------
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
const toTs = d => Math.floor(new Date(d).getTime() / 1000);

function addDaysISO(dateISO, d) {
  const base = new Date(dateISO + 'T00:00:00Z');
  base.setUTCDate(base.getUTCDate() + d);
  return base.toISOString().slice(0, 10);
}

// ---------- slash command ----------
export const data = new SlashCommandBuilder()
  .setName('fixtures')
  .setDescription('Fixtures: upcoming reminders')
  .addSubcommand(sub =>
    sub
      .setName('upcoming')
      .setDescription('Show upcoming reminders (followed teams)')
      .addIntegerOption(o => o
        .setName('days')
        .setDescription('Days ahead (7–14). Default 7')
        .setMinValue(7).setMaxValue(14))
      .addStringOption(o => o
        .setName('team')
        .setDescription('Filter by team name (substring)'))
      .addStringOption(o => o
        .setName('league')
        .setDescription('Filter by league code (e.g., PL, CL, BL1)'))
  );

// ---------- command executor ----------
export async function execute(interaction) {
  try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch {}
  const sub = interaction.options.getSubcommand(false);
  // Default to upcoming if someone runs /fixtures with no sub (just in case)
  return handleUpcoming(interaction);
}

// ---------- /fixtures upcoming ----------
async function handleUpcoming(interaction) {
  const guildId = interaction.guildId;
  const days = interaction.options.getInteger('days') ?? 7; // 7–14 via builder
  const teamFilterRaw = (interaction.options.getString('team') || '').toLowerCase().trim();
  const leagueFilterRaw = (interaction.options.getString('league') || '').toLowerCase().trim();

  const startISO = new Date().toISOString().slice(0, 10);
  const endISO = addDaysISO(startISO, days - 1);

  // Pull all reminders in the window (all guilds), then filter this guild only
  const windowFrom = `${startISO}T00:00:00.000Z`;
  const windowTo   = `${endISO}T23:59:59.999Z`;
  let rows = await getUpcomingRemindersWindow({ fromISO: windowFrom, toISO: windowTo });
  rows = rows.filter(r => r.guild_id === guildId);

  // If user wants a league filter, enrich from fixtures_cache (league column)
  const leagueByMatchId = new Map();
  if (leagueFilterRaw) {
    for (let d = 0; d < days; d++) {
      const dateISO = addDaysISO(startISO, d);
      const cached = await listCachedFixtures({ dateISO });
      for (const r of cached) {
        if (!leagueByMatchId.has(r.match_id)) {
          leagueByMatchId.set(String(r.match_id), String(r.league || '').toLowerCase());
        }
      }
    }
  }

  // Apply filters
  let fixtures = rows.filter(r => {
    if (teamFilterRaw) {
      const h = cleanTeamName(r.home || '').toLowerCase();
      const a = cleanTeamName(r.away || '').toLowerCase();
      if (!h.includes(teamFilterRaw) && !a.includes(teamFilterRaw)) return false;
    }
    if (leagueFilterRaw) {
      const lk = leagueByMatchId.get(String(r.match_id)) || '';
      if (!lk.includes(leagueFilterRaw)) return false;
    }
    return true;
  });

  fixtures.sort((a, b) => new Date(a.match_time) - new Date(b.match_time));

  if (!fixtures.length) {
    const bits = [];
    bits.push(`No upcoming followed matches in the next **${days}** day(s).`);
    if (teamFilterRaw) bits.push(`team:${teamFilterRaw}`);
    if (leagueFilterRaw) bits.push(`league:${leagueFilterRaw}`);
    return interaction.editReply(bits.join(' '));
  }

  // Render (paged)
  const pages = chunk(fixtures, 25);
  let idx = 0;

  const render = async () => {
    const page = pages[idx];
    const lines = [];
    let currentDay = '';
    for (const m of page) {
      const dISO = new Date(m.match_time).toISOString().slice(0, 10);
      if (dISO !== currentDay) {
        currentDay = dISO;
        lines.push(`\n__**${currentDay}**__`);
      }
      lines.push(`• ${cleanTeamName(m.home)} vs ${cleanTeamName(m.away)} -- <t:${toTs(m.match_time)}:t>`);
    }

    const filterBadge =
      `${teamFilterRaw ? ` • team:${teamFilterRaw}` : ''}` +
      `${leagueFilterRaw ? ` • league:${leagueFilterRaw}` : ''}`;

    const embed = new EmbedBuilder()
      .setTitle(`Upcoming reminders ${startISO} → ${endISO}${filterBadge}`)
      .setDescription(lines.join('\n').trim())
      .setFooter({ text: `Page ${idx + 1}/${pages.length} • ${fixtures.length} total` });

    const nav = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('upcoming:prev').setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(idx === 0),
      new ButtonBuilder().setCustomId('upcoming:next').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(idx === pages.length - 1)
    );

    await interaction.editReply({ embeds: [embed], components: [nav] });
  };

  await render();

  const msg = await interaction.fetchReply();
  const collector = msg.createMessageComponentCollector({ time: 5 * 60 * 1000 });

  collector.on('collect', async i => {
    if (i.user.id !== interaction.user.id) {
      return i.reply({ content: 'This menu isn’t for you.', flags: MessageFlags.Ephemeral });
    }
    if (i.customId === 'upcoming:prev') {
      idx = Math.max(0, idx - 1);
      await i.deferUpdate();
      return render();
    }
    if (i.customId === 'upcoming:next') {
      idx = Math.min(pages.length - 1, idx + 1);
      await i.deferUpdate();
      return render();
    }
  });

  collector.on('end', async () => {
    try {
      const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('upcoming:prev').setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('upcoming:next').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(true)
      );
      await interaction.editReply({ components: [disabledRow] }).catch(() => {});
    } catch {}
  });
}