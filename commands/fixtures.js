// commands/fixtures.js
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
  listCachedFixtures,
  getUpcomingRemindersWindow,
  subscribeGuildTeams,
  listGuildSubscribedTeams,
  unsubscribeGuildTeams,
  pruneUpcomingForUnfollowed,
  bulkUpsertGuildRemindersFromCache,
  upsertFixturesCache
} from '../db.js';

import {
  cleanTeamName,
  fetchTeamsForLeague,
  fetchTeamFixtures
} from '../providers/footballApi.js';

import { refreshRemindersForGuild } from '../matchScheduler.js';

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

function isoStart(dateISO) {
  return `${dateISO}T00:00:00.000Z`;
}
function isoNextDay(dateISO, days = 1) {
  return `${addDaysISO(dateISO, days)}T00:00:00.000Z`;
}

// ---------- slash command ----------
export const data = new SlashCommandBuilder()
  .setName('fixtures')
  .setDescription('Fixtures: upcoming reminders and team management')
  .addSubcommand(sub =>
    sub
      .setName('upcoming')
      .setDescription('Show upcoming reminders (followed teams)')
      .addIntegerOption(o => o
        .setName('days')
        .setDescription('Days ahead (7–14). Default 14')
        .setMinValue(7).setMaxValue(14))
      .addStringOption(o => o
        .setName('team')
        .setDescription('Filter by team name (substring)'))
      .addStringOption(o => o
        .setName('league')
        .setDescription('Filter by league code (e.g., PL, CL, BL1)'))
  )
  .addSubcommand(sub =>
    sub
      .setName('followed')
      .setDescription('Show teams followed in this server')
  )
  .addSubcommand(sub =>
    sub
      .setName('edit')
      .setDescription('Edit followed teams for a specific league (toggle adds/removals)')
      .addStringOption(o => o
        .setName('league')
        .setDescription('League code or id, e.g., PL or 39')
        .setRequired(true))
  );

// ---------- command executor ----------
export async function execute(interaction) {
  try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch {}
  const sub = interaction.options.getSubcommand(false);

  if (sub === 'followed') return handleFollowed(interaction);
  if (sub === 'edit') return handleEdit(interaction);
  // Default to upcoming if someone runs /fixtures with no sub (just in case)
  return handleUpcoming(interaction);
}

// ---------- /fixtures upcoming ----------
async function handleUpcoming(interaction) {
  const guildId = interaction.guildId;
  const days = interaction.options.getInteger('days') ?? 14; // 7–14 via builder, default 14
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

// Helper: backfill cache for team IDs over a window
async function backfillCacheForTeams(teamIds, fromISO, toISO) {
  if (!teamIds?.length) return 0;
  let total = 0;
  for (const teamId of teamIds) {
    try {
      const rows = await fetchTeamFixtures({ teamId, fromISO, toISO });
      if (rows?.length) {
        await upsertFixturesCache(rows);
        total += rows.length;
      }
    } catch (e) {
      console.warn(`[fixtures] fetchTeamFixtures failed for team ${teamId}:`, e?.message || e);
    }
  }
  return total;
}

// ---------- /fixtures followed ----------
async function handleFollowed(interaction) {
  const guildId = interaction.guildId;
  const list = await listGuildSubscribedTeams(guildId);

  if (!list.length) {
    return interaction.editReply('No teams are followed in this server yet. Use `/fixtures edit league:PL` to start.');
  }

  const names = list.map(t => `• ${cleanTeamName(t.team_name)} (${t.team_id})`).join('\n');
  const embed = new EmbedBuilder()
    .setTitle(`Followed teams (${list.length})`)
    .setDescription(names);

  return interaction.editReply({ embeds: [embed] });
}

// ---------- /fixtures edit ----------
async function handleEdit(interaction) {
  const guildId = interaction.guildId;
  const leagueInput = interaction.options.getString('league', true);

  // Load the full league's teams
  let teams;
  try {
    teams = await fetchTeamsForLeague({ league: leagueInput });
  } catch (e) {
    return interaction.editReply(`❌ Failed to load teams for **${leagueInput}**: ${e.message}`);
  }
  if (!teams.length) {
    return interaction.editReply(`No teams returned for **${leagueInput}**.`);
  }

  // Current follows
  const current = await listGuildSubscribedTeams(guildId);
  const followedIds = new Set(current.map(t => Number(t.team_id)));

  // Build options with defaults preselected for already-followed teams
  const options = teams.slice(0, 25).map(t => ({
    label: cleanTeamName(t.name),
    value: String(t.id),
    default: followedIds.has(Number(t.id)) // this shows as preselected
  }));

  const select = new StringSelectMenuBuilder()
    .setCustomId('fixtures:edit:select')
    .setPlaceholder(`Toggle followed teams in ${leagueInput}`)
    .setMinValues(0) // allow clearing all for this league
    .setMaxValues(options.length)
    .addOptions(options);

  const seasonUsed = teams.__seasonUsed ?? 'unknown';

  const embed = new EmbedBuilder()
    .setTitle(`Edit followed teams • ${leagueInput}`)
    .setDescription(
      `Season used for team list: **${seasonUsed}**\n` +
      `Select the teams to follow from this league. Deselected teams from this league will be unfollowed.\n` +
      `Currently following (all leagues): **${current.length}**`
    );

  await interaction.editReply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)]
  });

  const msg = await interaction.fetchReply();
  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: 2 * 60 * 1000
  });

  collector.on('collect', async i => {
    if (i.user.id !== interaction.user.id) {
      return i.reply({ content: 'This menu isn\'t for you.', flags: MessageFlags.Ephemeral });
    }

    await i.deferReply({ ephemeral: true });

    const chosenIds = new Set(i.values.map(v => Number(v)));
    const leagueIds = new Set(teams.map(t => Number(t.id)));

    // Compute diffs within this league only
    const toAdd = [];
    for (const id of chosenIds) {
      if (!followedIds.has(id)) toAdd.push(id);
    }
    const toRemove = [];
    for (const id of leagueIds) {
      if (followedIds.has(id) && !chosenIds.has(id)) toRemove.push(id);
    }

    // Apply changes
    let added = 0;
    if (toAdd.length) {
      const byId = new Map(teams.map(t => [Number(t.id), t]));
      const payload = toAdd.map(id => ({ id, name: cleanTeamName(byId.get(id)?.name || String(id)) }));
      try {
        added = await subscribeGuildTeams(guildId, payload);
      } catch (e) {
        await i.editReply(`❌ Failed to add: ${e.message || e}`);
        return;
      }
    }

    let removedTeams = 0;
    if (toRemove.length) {
      try {
        removedTeams = await unsubscribeGuildTeams(guildId, toRemove);
      } catch (e) {
        await i.editReply(`❌ Failed to remove: ${e.message || e}`);
        return;
      }
    }

    // Build window: today → +14 days
    const startISO = new Date().toISOString().slice(0, 10);
    const fromISO = isoStart(startISO);
    const toISO   = isoNextDay(addDaysISO(startISO, 14 - 1)); // exclusive

    // For newly followed teams, backfill cache and upsert reminders into this channel
    let cached = 0;
    let insertedFromCache = 0;
    if (toAdd.length) {
      cached = await backfillCacheForTeams(toAdd, fromISO, toISO);
      insertedFromCache = await bulkUpsertGuildRemindersFromCache({
        guild_id: guildId,
        channel_id: interaction.channelId,
        team_ids: toAdd,
        fromISO,
        toISO
      });
    }

    // Refresh reminders for newly added teams (scheduler path, if any)
    let upserts = 0;
    if (toAdd.length) {
      try {
        upserts = await refreshRemindersForGuild(guildId, 14, toAdd);
      } catch (err) {
        console.warn('[fixtures edit] refresh failed:', err?.message || err);
      }
    }

    // PRUNE after any change to follows
    const nowList = await listGuildSubscribedTeams(guildId);
    const keepIds = nowList.map(t => Number(t.team_id)).filter(Number.isFinite);
    const removedReminders = await pruneUpcomingForUnfollowed(guildId, keepIds);

    await i.editReply(
      `✅ Saved.\n` +
      `• Added teams: **${added}**\n` +
      `• Removed teams: **${removedTeams}**\n` +
      (toAdd.length ? `• Cached **${cached}** fixtures and upserted **${insertedFromCache}** reminders from cache.\n` : ``) +
      (upserts ? `• Scheduler refresh added **${upserts}** reminder(s).\n` : ``) +
      `• Pruned **${removedReminders}** upcoming reminder(s).\n` +
      `Now following **${nowList.length}** team(s) across all leagues.`
    );

    // Update header with new count
    const updated = EmbedBuilder.from(embed)
      .setDescription(
        `Season used for team list: **${seasonUsed}**\n` +
        `Select the teams to follow from this league. Deselected teams from this league will be unfollowed.\n` +
        `Currently following (all leagues): **${nowList.length}**`
      );
    await interaction.editReply({ embeds: [updated] });
  });

  collector.on('end', async () => {
    try {
      const disabledRow = new ActionRowBuilder().addComponents(
        StringSelectMenuBuilder.from(
          msg.components[0]?.components?.[0]?.toJSON?.() ?? select
        ).setDisabled(true)
      );
      await interaction.editReply({ components: [disabledRow] }).catch(() => {});
    } catch {}
  });
}