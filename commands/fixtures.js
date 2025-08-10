// commands/fixtures.js
import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder
} from 'discord.js';

import { fetchFixtures } from '../providers/footballApi.js'; // single-day fetch (we'll loop days)
import { upsertFixturesCache, listCachedFixtures, starMatch } from '../db.js';

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
const toTs = d => Math.floor(new Date(d).getTime() / 1000);

function addDaysISO(dateISO, d) {
  const base = new Date(dateISO + 'T00:00:00Z');
  base.setUTCDate(base.getUTCDate() + d);
  return base.toISOString().slice(0, 10); // YYYY-MM-DD
}

export const data = new SlashCommandBuilder()
  .setName('fixtures')
  .setDescription('Browse fixtures for a date range, filter, and star in bulk')
  .addStringOption(o => o.setName('date').setDescription('Start date YYYY-MM-DD').setRequired(true))
  .addIntegerOption(o =>
    o.setName('days')
      .setDescription('Number of days starting from date (default 7, max 14)')
      .setMinValue(1)
      .setMaxValue(14)
  )
  .addStringOption(o =>
    o.setName('league')
      .setDescription('Competition code(s) for football-data.org, e.g. PL or PL,CL')
  )
  .addStringOption(o =>
    o.setName('team')
      .setDescription('Filter by team substring')
  );

export async function execute(interaction) {
  // Acknowledge within 3s
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    console.error('fixtures.deferReply failed:', err);
    if (!interaction.deferred && !interaction.replied) return;
  }

  const startISO = interaction.options.getString('date');
  const days = interaction.options.getInteger('days') ?? 7; // default 7
  const league = interaction.options.getString('league') || undefined; // football-data competitions (e.g., PL,CL)
  const teamFilter = (interaction.options.getString('team') || '').toLowerCase();

  // 1) Fetch & cache best-effort for each day in the window (reduces API errors if one day fails)
  for (let d = 0; d < days; d++) {
    const dateISO = addDaysISO(startISO, d);
    try {
      const rows = await fetchFixtures({ dateISO, leagueId: league });
      await upsertFixturesCache(rows);
    } catch (e) {
      console.warn(`fetchFixtures failed for ${dateISO} (using cache):`, e?.message || e);
    }
  }

  // 2) Read back from cache for each day and aggregate
  const all = [];
  for (let d = 0; d < days; d++) {
    const dateISO = addDaysISO(startISO, d);
    /* listCachedFixtures reads by single day; re-use it for each day */
    const rows = await listCachedFixtures({ dateISO });
    all.push(...rows);
  }

  // 3) Apply filters (league/team)
  let fixtures = all;
  if (league) fixtures = fixtures.filter(f => (f.league || '').toLowerCase().includes(league.toLowerCase()));
  if (teamFilter) {
    fixtures = fixtures.filter(f =>
      f.home.toLowerCase().includes(teamFilter) || f.away.toLowerCase().includes(teamFilter)
    );
  }

  // 4) Sort (by match_time asc), then paginate
  fixtures.sort((a, b) => new Date(a.match_time) - new Date(b.match_time));

  if (!fixtures.length) {
    return interaction.editReply(
      `No fixtures found from ${startISO} for ${days} day(s)` +
      `${league ? ` • league: ${league}` : ''}` +
      `${teamFilter ? ` • team:${teamFilter}` : ''}.`
    );
  }

  const pages = chunk(fixtures, 25); // Discord select limit
  let idx = 0;

  const render = async () => {
    const page = pages[idx];

    // Build a grouped-by-date description for readability
    const lines = [];
    let currentDay = '';
    for (const m of page) {
      const dISO = new Date(m.match_time).toISOString().slice(0, 10);
      if (dISO !== currentDay) {
        currentDay = dISO;
        lines.push(`\n__**${currentDay}**__`);
      }
      lines.push(`• ${m.home} vs ${m.away} -- <t:${toTs(m.match_time)}:t>`);
    }

    const embed = new EmbedBuilder()
      .setTitle(`Fixtures ${startISO} → ${addDaysISO(startISO, days - 1)}` +
                `${league ? ` • ${league}` : ''}${teamFilter ? ` • team:${teamFilter}` : ''}`)
      .setDescription(lines.join('\n').trim())
      .setFooter({ text: `Page ${idx + 1}/${pages.length} • ${fixtures.length} total` });

    const select = new StringSelectMenuBuilder()
      .setCustomId(`fixtures:select:${idx}`)
      .setPlaceholder('Select matches to star')
      .setMinValues(1)
      .setMaxValues(Math.min(25, page.length))
      .addOptions(page.map(m => ({
        label: `${m.home} vs ${m.away}`,
        value: m.match_id,
        description: new Date(m.match_time).toLocaleString('en-US', {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
        })
      })));

    const nav = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('fixtures:prev').setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(idx === 0),
      new ButtonBuilder().setCustomId('fixtures:next').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(idx === pages.length - 1)
    );
    const row = new ActionRowBuilder().addComponents(select);

    await interaction.editReply({ embeds: [embed], components: [row, nav] });
  };

  await render();

  // 5) Collector for nav/select
  const msg = await interaction.fetchReply();
  const collector = msg.createMessageComponentCollector({ time: 5 * 60 * 1000 });

  collector.on('collect', async i => {
    if (i.user.id !== interaction.user.id) {
      return i.reply({ content: 'This menu isn’t for you.', ephemeral: true });
    }

    if (i.customId === 'fixtures:prev') {
      idx = Math.max(0, idx - 1);
      await i.deferUpdate();
      return render();
    }
    if (i.customId === 'fixtures:next') {
      idx = Math.min(pages.length - 1, idx + 1);
      await i.deferUpdate();
      return render();
    }

    if (i.customId.startsWith('fixtures:select:')) {
      const channel_id = interaction.channelId;
      const user_id = interaction.user.id;
      let ok = 0;

      for (const match_id of i.values) {
        try {
          await starMatch({ match_id, channel_id, user_id });
          ok++;
        } catch (_) {
          // ignore duplicates or cache misses
        }
      }
      return i.reply({ content: `⭐ Starred ${ok} match(es) for this channel.`, ephemeral: true });
    }
  });

  collector.on('end', async () => {
    // disable components when time’s up
    try {
      const disabledRows = msg.components.map(r => {
        const row = ActionRowBuilder.from(r.toJSON());
        row.components = row.components.map(c => {
          const b = ButtonBuilder.from(c);
          b.setDisabled(true);
          return b;
        });
        return row;
      });
      await interaction.editReply({ components: disabledRows }).catch(() => {});
    } catch (_) {}
  });
}