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

// Node 18+ has global fetch; if not, install node-fetch and import it.
import fs from 'fs';

// --- CONFIG for football-data.org ---
const FD_API_BASE = 'https://api.football-data.org/v4';
const FD_TOKEN = process.env.FOOTBALL_DATA_API_KEY || process.env.FOOTBALL_DATA_TOKEN;

// --- Your existing providers/db ---
import { fetchFixtures } from '../providers/footballApi.js'; // single-day fetch (we'll loop days)
import {
  upsertFixturesCache,
  listCachedFixtures,
  starMatch,
  subscribeTeams,
  listSubscribedTeams
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
  return base.toISOString().slice(0, 10); // YYYY-MM-DD
}

// competitions helpers (FD cap: <= 90 chars for ?competitions=)
function normalizeCompetitionCodes(str) {
  if (!str) return [];
  return String(str)
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(s => s && /^[A-Z0-9]+$/.test(s));
}
function batchCompetitionCodes(codes, maxLen = 90) {
  if (!codes.length) return ['']; // empty => no competitions param
  const batches = [];
  let cur = '';
  for (const code of codes) {
    if (!cur) { cur = code; continue; }
    const candidate = `${cur},${code}`;
    if (candidate.length <= maxLen) cur = candidate;
    else { batches.push(cur); cur = code; }
  }
  if (cur) batches.push(cur);
  return batches;
}

// ---------- football-data.org teams fetch ----------
async function fetchTeamsForLeague(leagueCode) {
  if (!FD_TOKEN) {
    throw new Error('Missing FOOTBALL_DATA_API_KEY (or FOOTBALL_DATA_TOKEN) in env.');
  }
  const url = `${FD_API_BASE}/competitions/${encodeURIComponent(leagueCode)}/teams`;
  const res = await fetch(url, { headers: { 'X-Auth-Token': FD_TOKEN } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`football-data.org ${res.status}: ${text || res.statusText}`);
  }
  const json = await res.json();
  const teams = Array.isArray(json?.teams) ? json.teams : [];
  return teams.map(t => ({ id: t.id, name: t.name })); // e.g., "Liverpool FC"
}

// ---------- slash command ----------
export const data = new SlashCommandBuilder()
  .setName('fixtures')
  .setDescription('Fixtures tools')
  // /fixtures browse ...
  .addSubcommand(sub =>
    sub
      .setName('browse')
      .setDescription('Browse fixtures for a date range, filter, and star in bulk')
      .addStringOption(o =>
        o.setName('date')
          .setDescription('Start date YYYY-MM-DD (optional; defaults to today)')
      )
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
          .setDescription('Filter by team substring (optional; applied after followed list)')
      )
  )
  // /fixtures follow league:PL
  .addSubcommand(sub =>
    sub
      .setName('follow')
      .setDescription('List teams from a league and choose which to follow (saved per channel)')
      .addStringOption(o =>
        o.setName('league')
          .setDescription('Competition code, e.g., PL, BL1, SA')
          .setRequired(true)
      )
  );

// ---------- command executor ----------
export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  // Defer quickly (use flags, not deprecated ephemeral)
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error('fixtures.deferReply failed:', err);
    if (!interaction.deferred && !interaction.replied) return;
  }

  if (sub === 'follow') return handleFollow(interaction);
  return handleBrowse(interaction);
}

// ---------- /fixtures follow ----------
async function handleFollow(interaction) {
  const league = interaction.options.getString('league', true).toUpperCase();

  let teams;
  try {
    teams = await fetchTeamsForLeague(league);
  } catch (e) {
    return interaction.editReply(`❌ Failed to load teams for **${league}**: ${e.message}`);
  }
  if (!teams.length) {
    return interaction.editReply(`No teams returned for **${league}**.`);
  }

  // Build a multi-select of teams (value = ID to avoid ambiguity)
  const select = new StringSelectMenuBuilder()
    .setCustomId('fixtures:follow:select')
    .setPlaceholder(`Select teams to follow from ${league}`)
    .setMinValues(1)
    .setMaxValues(Math.min(25, teams.length))
    .addOptions(teams.map(t => ({
      label: t.name,
      value: String(t.id)
    })));

  const row = new ActionRowBuilder().addComponents(select);
  const current = await listSubscribedTeams(interaction.channelId);
  const embed = new EmbedBuilder()
    .setTitle(`Follow teams • ${league}`)
    .setDescription(`Pick one or more teams to follow in this channel.\nCurrently followed: **${current.length}**`);

  await interaction.editReply({ embeds: [embed], components: [row] });

  // Collector to capture the selection
  const msg = await interaction.fetchReply();
  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: 2 * 60 * 1000
  });

  collector.on('collect', async i => {
    if (i.user.id !== interaction.user.id) {
      return i.reply({ content: 'This menu isn’t for you.', flags: MessageFlags.Ephemeral });
    }

    const chosenIds = i.values.map(v => Number(v));
    const byId = new Map(teams.map(t => [t.id, t]));
    const chosen = chosenIds.map(id => ({ id, name: byId.get(id)?.name || String(id) }));

    const added = await subscribeTeams(interaction.channelId, chosen);
    const nowList = await listSubscribedTeams(interaction.channelId);

    await i.reply({
      content: `✅ Added **${added}** team(s). Now following **${nowList.length}** total in this channel.`,
      flags: MessageFlags.Ephemeral
    });

    const updated = EmbedBuilder.from(embed)
      .setDescription(`Pick one or more teams to follow.\nCurrently followed: **${nowList.length}**`);
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

// ---------- /fixtures browse ----------
async function handleBrowse(interaction) {
  // Default date: today (UTC) if user did not provide one
  const todayISO = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const inputDate = interaction.options.getString('date');
  let startISO = inputDate || todayISO;

  // Validate/normalize input date
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

  // competitions batching
  const leagueCodes = normalizeCompetitionCodes(leagueRaw); // ['PL','CL',...]
  const leagueBatches = batchCompetitionCodes(leagueCodes); // ['PL,CL', 'BL1,SA', ...]
  const leagueForTitle = leagueCodes.length ? leagueCodes.join(',') : undefined;

  // Load followed teams (per channel) from DB
  const FOLLOW = await listSubscribedTeams(interaction.channelId); // [{team_id, team_name}]
  const hasFollowList = FOLLOW.length > 0;
  const followIds = new Set(FOLLOW.map(x => String(x.team_id)));
  const followNameLower = FOLLOW.map(x => x.team_name.toLowerCase());

  // helpers
  const involvesFollowedTeam = (f) => {
    // prefer exact ID match if present
    if (f.home_id && followIds.has(String(f.home_id))) return true;
    if (f.away_id && followIds.has(String(f.away_id))) return true;
    if (!hasFollowList) return true;
    // fallback: substring name match
    const h = (f.home || '').toLowerCase();
    const a = (f.away || '').toLowerCase();
    return followNameLower.some(t => h.includes(t) || a.includes(t));
  };

  const matchesTeamFilter = (f) =>
    !teamFilter ||
    (f.home || '').toLowerCase().includes(teamFilter) ||
    (f.away || '').toLowerCase().includes(teamFilter);

  // 1) Fetch & cache best-effort for each day (per competitions batch)
  for (let d = 0; d < days; d++) {
    const dateISO = addDaysISO(startISO, d);
    try {
      let merged = [];
      if (!leagueCodes.length) {
        const rows = await fetchFixtures({ dateISO, leagueId: undefined });
        merged = rows;
      } else {
        for (const batch of leagueBatches) {
          const rows = await fetchFixtures({ dateISO, leagueId: batch });
          merged.push(...rows);
        }
      }

      // upsert only relevant rows; pass through team IDs if provider supplies them
      const pruned = merged
        .filter(r => involvesFollowedTeam(r) && matchesTeamFilter(r))
        .map(r => ({
          ...r,
          home_id: r.home_id ?? null,
          away_id: r.away_id ?? null
        }));

      if (pruned.length) await upsertFixturesCache(pruned);
    } catch (e) {
      console.warn(`fetchFixtures failed for ${dateISO} (using cache):`, e?.message || e);
    }
  }

  // 2) Read back from cache for each day and aggregate
  const all = [];
  for (let d = 0; d < days; d++) {
    const dateISO = addDaysISO(startISO, d);
    const rows = await listCachedFixtures({ dateISO });
    all.push(...rows);
  }

  // 3) Apply filters as safeguard
  let fixtures = all;

  if (leagueCodes.length) {
    const compSet = new Set(leagueCodes.map(c => c.toLowerCase()));
    fixtures = fixtures.filter(f => compSet.has((f.league || '').toLowerCase()));
  }

  if (hasFollowList) {
    fixtures = fixtures.filter(involvesFollowedTeam);
  }

  if (teamFilter) {
    fixtures = fixtures.filter(matchesTeamFilter);
  }

  // 4) Sort (by match_time asc), then paginate
  fixtures.sort((a, b) => new Date(a.match_time) - new Date(b.match_time));

  if (!fixtures.length) {
    const followBadge = hasFollowList ? ` • following:${FOLLOW.length} team(s)` : '';
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
      lines.push(`• ${m.home} vs ${m.away} -- <t:${toTs(m.match_time)}:t>`);
    }

    const followBadge = hasFollowList ? ` • following:${FOLLOW.length}` : '';
    const title =
      `Fixtures ${startISO} → ${addDaysISO(startISO, days - 1)}` +
      `${leagueForTitle ? ` • ${leagueForTitle}` : ''}${teamFilter ? ` • team:${teamFilter}` : ''}${followBadge}`;

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
        } catch {
          // ignore duplicates or cache misses
        }
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
          if (j.type === ComponentType.Button) {
            const b = ButtonBuilder.from(j);
            b.setDisabled(true);
            return b;
          }
          if (j.type === ComponentType.StringSelect) {
            const s = StringSelectMenuBuilder.from(j);
            s.setDisabled(true);
            return s;
          }
          try {
            const b = ButtonBuilder.from(j);
            b.setDisabled(true);
            return b;
          } catch {
            try {
              const s = StringSelectMenuBuilder.from(j);
              s.setDisabled(true);
              return s;
            } catch {
              return c;
            }
          }
        });
        return row;
      });
      await interaction.editReply({ components: disabledRows }).catch(() => {});
    } catch {}
  });
}