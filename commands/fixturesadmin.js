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
  fetchTeamsForLeague,
  fetchTeamFixtures,
  cleanTeamName
} from '../providers/footballApi.js';

import {
  upsertFixturesCache,
  listCachedFixtures,
  starMatch,
  subscribeGuildTeams,
  listGuildSubscribedTeams,
  unsubscribeGuildTeams
} from '../db.js';

import { refreshRemindersForGuild } from '../matchScheduler.js';

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

// ---------- slash command ----------
export const data = new SlashCommandBuilder()
  .setName('fixturesadmin')
  .setDescription('Admin tools for fixtures and follows')

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
      .setName('follow')
      .setDescription('List teams from a league and choose which to follow (server-wide)')
      .addStringOption(o => o.setName('league').setDescription('League code or id, e.g., PL or 39').setRequired(true))
  )

  .addSubcommand(sub =>
    sub
      .setName('followed')
      .setDescription('Show teams followed in this server')
  )

  .addSubcommand(sub =>
    sub
      .setName('unfollow')
      .setDescription('Unfollow one or more teams in this server')
  )

  // NEW: /fixturesadmin edit
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
  const sub = interaction.options.getSubcommand();

  if (sub === 'follow')   return handleFollow(interaction);
  if (sub === 'followed') return handleFollowed(interaction);
  if (sub === 'unfollow') return handleUnfollow(interaction);
  if (sub === 'edit')     return handleEdit(interaction);   // NEW
  return handleBrowse(interaction);
}

// ---------- /fixturesadmin follow ----------
async function handleFollow(interaction) {
  const guildId = interaction.guildId;
  const leagueInput = interaction.options.getString('league', true);

  let teams;
  try {
    teams = await fetchTeamsForLeague({ league: leagueInput });
  } catch (e) {
    return interaction.editReply(`❌ Failed to load teams for **${leagueInput}**: ${e.message}`);
  }
  if (!teams.length) {
    return interaction.editReply(`No teams returned for **${leagueInput}**.`);
  }

  const seasonUsed = teams.__seasonUsed ?? 'unknown';

  const select = new StringSelectMenuBuilder()
    .setCustomId('fixtures:follow:select')
    .setPlaceholder(`Select teams to follow from ${leagueInput}`)
    .setMinValues(1)
    .setMaxValues(Math.min(25, teams.length))
    .addOptions(teams.slice(0, 25).map(t => ({
      label: cleanTeamName(t.name),
      value: String(t.id)
    })));

  const row = new ActionRowBuilder().addComponents(select);
  const current = await listGuildSubscribedTeams(guildId);
  const embed = new EmbedBuilder()
    .setTitle(`Follow teams • ${leagueInput}`)
    .setDescription(
      `Season used for team list: **${seasonUsed}**\n` +
      `Pick one or more teams to follow in this channel.\n` +
      `Currently followed: **${current.length}**`
    );

  await interaction.editReply({ embeds: [embed], components: [row] });

  const msg = await interaction.fetchReply();
  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: 2 * 60 * 1000
  });

  collector.on('collect', async i => {
    if (i.user.id !== interaction.user.id) {
      return i.reply({ content: 'This menu isn’t for you.', flags: MessageFlags.Ephemeral });
    }

    await i.deferReply({ ephemeral: true });

    const chosenIds = i.values.map(v => Number(v));
    const byId = new Map(teams.map(t => [t.id, t]));
    const chosen = chosenIds.map(id => ({
      id,
      name: cleanTeamName(byId.get(id)?.name || String(id))
    }));

    let added = 0;
    try {
      added = await subscribeGuildTeams(guildId, chosen);
    } catch (e) {
      await i.editReply(`❌ Failed to save selection: ${e.message || e}`);
      return;
    }

    let upserts = 0;
    try {
      upserts = await refreshRemindersForGuild(guildId, 14, chosenIds);
    } catch (err) {
      console.warn('[fixtures follow] immediate refresh failed:', err?.message || err);
    }

    const nowList = await listGuildSubscribedTeams(guildId);

    await i.editReply(
      `✅ Added **${added}** team(s). Now following **${nowList.length}** total.\n` +
      (upserts ? `🔄 Refreshed reminders for **${upserts}** upcoming match(es).` : `⏳ Reminders will catch up shortly.`)
    );

    const updated = EmbedBuilder.from(embed)
      .setDescription(
        `Season used for team list: **${seasonUsed}**\n` +
        `Pick one or more teams to follow in this channel.\n` +
        `Currently followed: **${nowList.length}**`
      );
    await interaction.editReply({ embeds: [updated] });
  });

  collector.on('end', async () => {
    try {
      const disabledRow = new ActionRowBuilder().addComponents(
        StringSelectMenuBuilder.from(select).setDisabled(true)
      );
      await interaction.editReply({ components: [disabledRow] }).catch(() => {});
    } catch {}
  });
}

// ---------- /fixturesadmin followed ----------
async function handleFollowed(interaction) {
  const guildId = interaction.guildId;
  const list = await listGuildSubscribedTeams(guildId);

  if (!list.length) {
    return interaction.editReply('No teams are followed in this server yet. Use `/fixturesadmin follow league:PL` to start.');
  }

  const names = list.map(t => `• ${cleanTeamName(t.team_name)} (${t.team_id})`).join('\n');
  const embed = new EmbedBuilder()
    .setTitle(`Followed teams (${list.length})`)
    .setDescription(names);

  return interaction.editReply({ embeds: [embed] });
}

// ---------- /fixturesadmin unfollow ----------
async function handleUnfollow(interaction) {
  const guildId = interaction.guildId;
  const list = await listGuildSubscribedTeams(guildId);

  if (!list.length) {
    return interaction.editReply('No teams to unfollow. Use `/fixturesadmin follow` first.');
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('fixtures:unfollow:select')
    .setPlaceholder('Select teams to unfollow')
    .setMinValues(1)
    .setMaxValues(Math.min(25, list.length))
    .addOptions(list.slice(0, 25).map(t => ({
      label: cleanTeamName(t.team_name),
      value: String(t.team_id)
    })));

  const row = new ActionRowBuilder().addComponents(select);
  await interaction.editReply({ content: 'Choose teams to unfollow:', components: [row] });

  const msg = await interaction.fetchReply();
  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: 2 * 60 * 1000
  });

  collector.on('collect', async i => {
    if (i.user.id !== interaction.user.id) {
      return i.reply({ content: 'This menu isn’t for you.', flags: MessageFlags.Ephemeral });
    }

    const ids = i.values.map(v => Number(v));
    const removed = await unsubscribeGuildTeams(guildId, ids);
    await i.reply({ content: `🗑️ Removed **${removed}** team(s) from this server’s follow list.`, flags: MessageFlags.Ephemeral });

    const disabledRow = new ActionRowBuilder().addComponents(
      StringSelectMenuBuilder.from(select).setDisabled(true)
    );
    await interaction.editReply({ components: [disabledRow] }).catch(() => {});
  });

  collector.on('end', async () => {
    try {
      const disabledRow = new ActionRowBuilder().addComponents(
        StringSelectMenuBuilder.from(select).setDisabled(true)
      );
      await interaction.editReply({ components: [disabledRow] }).catch(() => {});
    } catch {}
  });
}

// ---------- NEW: /fixturesadmin edit ----------
async function handleEdit(interaction) {
  const guildId = interaction.guildId;
  const leagueInput = interaction.options.getString('league', true);

  // Load the full league’s teams
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
      return i.reply({ content: 'This menu isn’t for you.', flags: MessageFlags.Ephemeral });
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

    let removed = 0;
    if (toRemove.length) {
      try {
        removed = await unsubscribeGuildTeams(guildId, toRemove);
      } catch (e) {
        await i.editReply(`❌ Failed to remove: ${e.message || e}`);
        return;
      }
    }

    // Refresh reminders for newly added teams (removals are left to natural expiry)
    let upserts = 0;
    if (toAdd.length) {
      try {
        upserts = await refreshRemindersForGuild(guildId, 14, toAdd);
      } catch (err) {
        console.warn('[fixtures edit] refresh failed:', err?.message || err);
      }
    }

    const nowList = await listGuildSubscribedTeams(guildId);

    await i.editReply(
      `✅ Saved.\n` +
      `• Added: **${added}**\n` +
      `• Removed: **${removed}**\n` +
      (upserts ? `• Refreshed reminders for **${upserts}** upcoming match(es).` : `• Reminders will catch up shortly.`) +
      `\nNow following **${nowList.length}** team(s) across all leagues.`
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
        let rows = await fetchTeamFixtures({ teamId, fromISO: startISO, toISO: endISO });

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