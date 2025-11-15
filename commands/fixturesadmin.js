// commands/fixturesadmin.js
import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
  ComponentType,
  MessageFlags
} from 'discord.js';

import {
  fetchFixtures,
  fetchTeamFixtures,
  cleanTeamName
} from '../providers/footballApi.js';

import {
  upsertFixturesCache,
  listCachedFixtures,
  starMatch,
  listGuildSubscribedTeams,
  pruneUpcomingForUnfollowed
} from '../db.js';

// ---------- utils ----------
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

function normalizeLeagueTokens(str) {
  if (!str) return [];
  return String(str).split(',').map(s => s.trim()).filter(Boolean);
}
function splitLeagueTokens(tokens) {
  const ids = new Set();
  const alphas = new Set();
  for (const t of tokens) {
    if (/^\d+$/.test(t)) ids.add(t);
    else alphas.add(t.toLowerCase());
  }
  return { ids, alphas };
}

function isoStart(dateISO) {
  return `${dateISO}T00:00:00.000Z`;
}
function isoNextDay(dateISO, days = 1) {
  return `${addDaysISO(dateISO, days)}T00:00:00.000Z`;
}

// ---------- slash command ----------
export const data = new SlashCommandBuilder()
  .setName('fixturesadmin')
  .setDescription('Admin tools for fixtures (browse and refresh)')

  .addSubcommand(sub =>
    sub
      .setName('browse')
      .setDescription('Browse fixtures for a date range, filter, and star in bulk')
      .addStringOption(o => o.setName('date').setDescription('Start date YYYY-MM-DD (optional; defaults to today)'))
      .addIntegerOption(o => o.setName('days').setDescription('Number of days (default 7, max 14)').setMinValue(1).setMaxValue(14))
      .addStringOption(o => o.setName('league').setDescription('League(s) by code or id, e.g. PL or 39, or PL,CL'))
      .addStringOption(o => o.setName('team').setDescription('Filter by team substring (optional; applied after followed list)'))
  )

  .addSubcommand(sub =>
    sub
      .setName('refresh')
      .setDescription('Remove upcoming match reminders for teams that are not followed')
  );

// ---------- command executor ----------
export async function execute(interaction) {
  try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch {}
  const sub = interaction.options.getSubcommand();

  if (sub === 'refresh')  return handleRefresh(interaction);
  return handleBrowse(interaction);
}


// ---------- /fixturesadmin refresh ----------
async function handleRefresh(interaction) {
  const guildId = interaction.guildId;

  // Get followed team IDs (empty = remove everything upcoming)
  const followed = await listGuildSubscribedTeams(guildId);
  const keepIds = followed.map(t => Number(t.team_id)).filter(Number.isFinite);

  let removed = 0;
  try {
    removed = await pruneUpcomingForUnfollowed(guildId, keepIds);
  } catch (e) {
    return interaction.editReply(`❌ Failed to refresh upcoming: ${e.message || e}`);
  }

  const followedCount = keepIds.length;
  await interaction.editReply(
    `🔄 Refreshed upcoming for this server.\n` +
    `• Currently followed teams: **${followedCount}**\n` +
    `• Removed reminders: **${removed}**`
  );
}

// ---------- /fixturesadmin browse ----------
async function handleBrowse(interaction) {
  const guildId = interaction.guildId;

  const todayISO = new Date().toISOString().slice(0, 10);
  const inputDate = interaction.options.getString('date');
  let startISO = inputDate || todayISO;

  if (inputDate) {
    const isYMD = /^\d{4}-\d{2}-\d{2}$/.test(inputDate);
    const d = new Date(inputDate + 'T00:00:00Z');
    if (!isYMD || Number.isNaN(d.getTime())) {
      return interaction.editReply('❌ Invalid date. Use `YYYY-MM-DD` (e.g., `2025-08-11`).');
    }
    startISO = d.toISOString().slice(0, 10);
  }

  const days = interaction.options.getInteger('days') ?? 7;
  const leagueRaw = interaction.options.getString('league') || '';
  const teamFilter = (interaction.options.getString('team') || '').toLowerCase();

  const leagueTokens = normalizeLeagueTokens(leagueRaw);
  const leagueForTitle = leagueTokens.length ? leagueTokens.join(',') : undefined;
  const { ids: leagueIdTokens } = splitLeagueTokens(leagueTokens);

  const FOLLOW = await listGuildSubscribedTeams(guildId);
  const hasFollowList = FOLLOW.length > 0;
  const followIds = new Set(FOLLOW.map(x => String(x.team_id)));
  const followNameLower = FOLLOW.map(x => cleanTeamName(x.team_name || '').toLowerCase());

  const matchesTeamFilter = (f) => {
    if (!teamFilter) return true;
    const h = cleanTeamName(f.home || '').toLowerCase();
    const a = cleanTeamName(f.away || '').toLowerCase();
    return h.includes(teamFilter) || a.includes(teamFilter);
  };

  const endISO = addDaysISO(startISO, days - 1);

  if (hasFollowList && followIds.size) {
    for (const teamId of followIds) {
      try {
        let rows = await fetchTeamFixtures({ teamId, fromISO: isoStart(startISO), toISO: isoNextDay(endISO) });

        if (leagueIdTokens.size) {
          rows = rows.filter(r => r.league && leagueIdTokens.has(String(r.league)));
        }

        rows = rows.filter(matchesTeamFilter);
        if (rows.length) await upsertFixturesCache(rows);
      } catch (e) {
        console.warn(`team ${teamId} fetch failed (using cache):`, e?.message || e);
      }
    }
  } else {
    for (let d = 0; d < days; d++) {
      const dateISO = addDaysISO(startISO, d);
      try {
        const rows = await fetchFixtures({ dateISO, leagueId: leagueForTitle });
        const narrowed = rows.filter(matchesTeamFilter);
        if (narrowed.length) await upsertFixturesCache(narrowed);
      } catch (e) {
        console.warn(`fetchFixtures failed for ${dateISO} (using cache):`, e?.message || e);
      }
    }
  }

  const all = [];
  for (let d = 0; d < days; d++) {
    const dateISO = addDaysISO(startISO, d);
    const rows = await listCachedFixtures({ dateISO });
    all.push(...rows);
  }

  let fixtures = all;

  if (leagueIdTokens.size) {
    fixtures = fixtures.filter(f => f.league && leagueIdTokens.has(String(f.league)));
  }

  if (FOLLOW.length) {
    const followIds = new Set(FOLLOW.map(x => String(x.team_id)));
    fixtures = fixtures.filter(f =>
      (f.home_id && followIds.has(String(f.home_id))) ||
      (f.away_id && followIds.has(String(f.away_id))) ||
      followNameLower.some(t =>
        cleanTeamName(f.home || '').toLowerCase().includes(t) ||
        cleanTeamName(f.away || '').toLowerCase().includes(t)
      )
    );
  }

  if (teamFilter) {
    fixtures = fixtures.filter(matchesTeamFilter);
  }

  fixtures.sort((a, b) => new Date(a.match_time) - new Date(b.match_time));

  if (!fixtures.length) {
    const followBadge = FOLLOW.length ? ` • following:${FOLLOW.length} team(s)` : '';
    return interaction.editReply(
      `No fixtures found from **${startISO}** for **${days}** day(s)` +
      `${leagueForTitle ? ` • league:${leagueForTitle}` : ''}${followBadge}` +
      `${teamFilter ? ` • team:${teamFilter}` : ''}.`
    );
  }

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

    const followBadge = FOLLOW.length ? ` • following:${FOLLOW.length}` : '';
    const title =
      `Fixtures ${startISO} → ${addDaysISO(startISO, days - 1)}` +
      `${leagueForTitle ? ` • ${leagueForTitle}` : ''}` +
      `${teamFilter ? ` • team:${teamFilter}` : ''}${followBadge}`;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(lines.join('\n').trim())
      .setFooter({ text: `Page ${idx + 1}/${pages.length} • ${fixtures.length} total` });

    const select = new StringSelectMenuBuilder()
      .setCustomId(`fixtures:select:${idx}`)
      .setPlaceholder('Select matches to star')
      .setMinValues(1)
      .setMaxValues(Math.min(25, page.length))
      .addOptions(page.map(m => ({
        label: `${cleanTeamName(m.home)} vs ${cleanTeamName(m.away)}`,
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

  const msg = await interaction.fetchReply();
  const collector = msg.createMessageComponentCollector({ time: 5 * 60 * 1000 });

  collector.on('collect', async i => {
    if (i.user.id !== interaction.user.id) {
      return i.reply({ content: 'This menu isn’t for you.', flags: MessageFlags.Ephemeral });
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
        } catch {}
      }
      return i.reply({ content: `⭐ Starred ${ok} match(es) for this channel.`, flags: MessageFlags.Ephemeral });
    }
  });

  collector.on('end', async () => {
    try {
      const disabledRows = msg.components.map(r => {
        const row = ActionRowBuilder.from(r.toJSON());
        row.components = row.components.map(c => {
          const j = c.toJSON ? c.toJSON() : c;
          if (j.type === ComponentType.Button) return ButtonBuilder.from(j).setDisabled(true);
          if (j.type === ComponentType.StringSelect) return StringSelectMenuBuilder.from(j).setDisabled(true);
          try { return ButtonBuilder.from(j).setDisabled(true); } catch {}
          try { return StringSelectMenuBuilder.from(j).setDisabled(true); } catch {}
          return c;
        });
        return row;
      });
      await interaction.editReply({ components: disabledRows }).catch(() => {});
    } catch {}
  });
}