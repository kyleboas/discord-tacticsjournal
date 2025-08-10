import {
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, EmbedBuilder
} from 'discord.js';
import { fetchFixtures } from '../providers/footballApi.js';
import { upsertFixturesCache, listCachedFixtures, starMatch } from '../db.js';
import { fetchFixtures } from '../providers/footballApi.js';

function chunk(arr, size){const o=[];for(let i=0;i<arr.length;i+=size)o.push(arr.slice(i,i+size));return o;}
const toTs = d => Math.floor(new Date(d).getTime()/1000);

export const data = new SlashCommandBuilder()
  .setName('fixtures')
  .setDescription('Browse fixtures for a date, filter, and star in bulk')
  .addStringOption(o => o.setName('date').setDescription('YYYY-MM-DD').setRequired(true))
  .addStringOption(o => o.setName('league').setDescription('Optional league id/code'))
  .addStringOption(o => o.setName('team').setDescription('Filter by team substring'));

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const dateISO = interaction.options.getString('date');
  const league = interaction.options.getString('league') || undefined;
  const team = (interaction.options.getString('team') || '').toLowerCase();

  // fetch & cache (best-effort; fall back to cache on failure)
  try {
    const rows = await fetchFixtures({ dateISO, leagueId: league });
    await upsertFixturesCache(rows);
  } catch (e) { /* ignore; list from cache below */ }

  let fixtures = await listCachedFixtures({ dateISO });
  if (league) fixtures = fixtures.filter(f => (f.league || '').toLowerCase().includes(league.toLowerCase()));
  if (team) fixtures = fixtures.filter(f => f.home.toLowerCase().includes(team) || f.away.toLowerCase().includes(team));
  if (!fixtures.length) return interaction.editReply('No fixtures match those filters.');

  const pages = chunk(fixtures, 25); // select menu hard limit
  let idx = 0;

  const render = async () => {
    const page = pages[idx];
    const embed = new EmbedBuilder()
      .setTitle(`Fixtures ${dateISO}${league ? ` · ${league}`:''}${team?` · team:${team}`:''}`)
      .setDescription(page.map((m,i)=>`**${i+1}.** ${m.home} vs ${m.away} -- <t:${toTs(m.match_time)}:f>`).join('\n'))
      .setFooter({ text: `Page ${idx+1}/${pages.length} • ${fixtures.length} total` });

    const select = new StringSelectMenuBuilder()
      .setCustomId(`fixtures:select:${idx}`)
      .setPlaceholder('Select matches to star')
      .setMinValues(1)
      .setMaxValues(Math.min(25, page.length))
      .addOptions(page.map(m => ({
        label: `${m.home} vs ${m.away}`,
        value: m.match_id,
        description: new Date(m.match_time).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false})
      })));

    const nav = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('fixtures:prev').setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(idx===0),
      new ButtonBuilder().setCustomId('fixtures:next').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(idx===pages.length-1)
    );
    const row = new ActionRowBuilder().addComponents(select);
    await interaction.editReply({ embeds:[embed], components:[row, nav] });
  };

  await render();

  const msg = await interaction.fetchReply();
  const collector = msg.createMessageComponentCollector({ time: 5*60*1000 });

  collector.on('collect', async i => {
    if (i.user.id !== interaction.user.id) return i.reply({ content: 'This menu isn’t for you.', ephemeral: true });

    if (i.customId === 'fixtures:prev') { idx=Math.max(0,idx-1); await i.deferUpdate(); return render(); }
    if (i.customId === 'fixtures:next') { idx=Math.min(pages.length-1,idx+1); await i.deferUpdate(); return render(); }

    if (i.customId.startsWith('fixtures:select:')) {
      // bulk star selected matchIds for the current channel
      const channel_id = interaction.channelId;
      const user_id = interaction.user.id;
      for (const match_id of i.values) { try { await starMatch({ match_id, channel_id, user_id }); } catch {} }
      return i.reply({ content: `⭐ Starred ${i.values.length} match(es) for this channel.`, ephemeral: true });
    }
  });
}