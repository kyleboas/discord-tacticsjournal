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
import fs from 'fs';

// --- CONFIG for football-data.org ---
const FD_API_BASE = 'https://api.football-data.org/v4';
const FD_TOKEN = process.env.FOOTBALL_DATA_API_KEY || process.env.FOOTBALL_DATA_TOKEN;

// --- Your existing providers/db ---
import { fetchFixtures } from '../providers/footballApi.js'; // single-day fetch (we'll loop days)
import { upsertFixturesCache, listCachedFixtures, starMatch } from '../db.js';

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

function readTeamsJson() {
  try {
    const raw = fs.readFileSync('./teams.json', 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(Boolean).map(s => String(s));
  } catch {
    return [];
  }
}

function writeTeamsJson(names) {
  const unique = Array.from(
    new Map(
      names
        .filter(Boolean)
        .map(n => [String(n).toLowerCase(), String(n)])
    ).values()
  ).sort((a, b) => a.localeCompare(b));
  fs.writeFileSync('./teams.json', JSON.stringify(unique, null, 2));
  return unique;
}

// Case-insensitive membership
function includesTeam(list, name) {
  const lower = new Set(list.map(x => x.toLowerCase()));
  return lower.has(name.toLowerCase());
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
  // Normalize to minimal shape we need
  const teams = Array.isArray(json?.teams) ? json.teams : [];
  return teams.map(t => ({
    id: t.id,
    name: t.name // e.g., "Liverpool FC"
  }));
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
          .setDescription('Filter by team substring (optional; applied after teams.json)')
      )
  )
  // /fixtures follow league:PL
  .addSubcommand(sub =>
    sub
      .setName('follow')
      .setDescription('List teams from a league and choose which to follow')
      .addStringOption(o =>
        o.setName('league')
          .setDescription('Competition code, e.g., PL, BL1, SA')
          .setRequired(true)
      )
  );

// ---------- command executor ----------
export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  // Always defer quickly (use flags instead of deprecated `ephemeral`)
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error('fixtures.deferReply failed:', err);
    if (!interaction.deferred && !interaction.replied) return;
  }

  if (sub === 'follow') {
    return handleFollow(interaction);
  }
  // default to browse
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

  // Build a multi-select of teams
  const select = new StringSelectMenuBuilder()
    .setCustomId('fixtures:follow:select')
    .setPlaceholder(`Select teams to follow from ${league}`)
    .setMinValues(1)
    .setMaxValues(Math.min(25, teams.length))
    .addOptions(teams.map(t => ({
      label: t.name,
      value: t.name
    })));

  const row = new ActionRowBuilder().addComponents(select);
  const embed = new EmbedBuilder()
    .setTitle(`Follow teams • ${league}`)
    .setDescription(`Pick one or more teams to add to **teams.json**.\nCurrent followed: **${readTeamsJson().length}**`);

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

    const chosen = i.values; // array of team names (original case)
    const current = readTeamsJson();
    const merged = writeTeamsJson([...current, ...chosen]);

    await i.reply({
      content: `✅ Added **${chosen.length}** team(s). Now following **${merged.length}** total.`,
      flags: MessageFlags.Ephemeral
    });

    // Update the embed to reflect new count
    const updated = EmbedBuilder.from(embed)
      .setDescription(`Pick one or more teams to add to **teams.json**.\nCurrent followed: **${merged.length}**`);
    await interaction.editReply({ embeds: [updated] });
  });

  collector.on('end', async () => {
    try {
      // disable components when time’s up
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

  // Basic validation/normalization for user-supplied date
  if (inputDate) {
    const isYMD = /^\d{4}-\d{2}-\d{2}$/.test(inputDate);
    const d = new Date(inputDate + 'T00:00:00Z');
    if (!isYMD || Number.isNaN(d.getTime())) {
      return interaction.editReply('❌ Invalid date. Use `YYYY-MM-DD` (e.g., `2025-08-11`).');
    }
    startISO = d.toISOString().slice(0, 10);
  }

  const days = interaction.options.getInteger('days') ?? 7; // default 7
  const league = interaction.options.getString('league') || undefined; // e.g., PL,CL
  const teamFilter = (interaction.options.getString('team') || '').toLowerCase();

  // Load teams.json fresh each run (reflect changes from /fixtures follow)
  const FOLLOW = readTeamsJson();
  const hasFollowList = FOLLOW.length > 0;
  const followLower = new Set(FOLLOW.map(x => x.toLowerCase()));

  // Helper: does fixture involve a followed team?
  const involvesFollowedTeam = (f) =>
    !hasFollowList || followLower.has((f.home || '').toLowerCase()) || followLower.has((f.away || '').toLowerCase()) ||
    // also allow substring match for flexibility
    Array.from(followLower).some(t =>
      (f.home || '').toLowerCase().includes(t) || (f.away || '').toLowerCase().includes(t)
    );

  // Helper: does fixture match teamFilter?
  const matchesTeamFilter = (f) =>
    !teamFilter || (f.home || '').toLowerCase().includes(teamFilter) || (f.away || '').toLowerCase().includes(teamFilter);

  // 1) Fetch & cache best-effort for each day
  // We only upsert fixtures that match our follow list and (optionally) teamFilter
  for (let d = 0; d < days; d++) {
    const dateISO = addDaysISO(startISO, d);
    try {
      const rows = await fetchFixtures({ dateISO, leagueId: league });
      const pruned = rows.filter(r => involvesFollowedTeam(r) && matchesTeamFilter(r));
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

  // 3) Apply filters (league/team + teams.json) to the aggregate from cache as a safeguard
  let fixtures = all;

  if (league) {
    fixtures = fixtures.filter(f => (f.league || '').toLowerCase().includes(league.toLowerCase()));
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
      `${league ? ` • league:${league}` : ''}${followBadge}` +
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

    const followBadge = hasFollowList ? ` • following:${FOLLOW.length}` : '';
    const title =
      `Fixtures ${startISO} → ${addDaysISO(startISO, days - 1)}` +
      `${league ? ` • ${league}` : ''}${teamFilter ? ` • team:${teamFilter}` : ''}${followBadge}`;

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