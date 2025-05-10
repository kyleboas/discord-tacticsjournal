import { SlashCommandBuilder } from 'discord.js';
import fs from 'fs';

const watchlistFile = './watchlists.json';

function loadWatchlist() {
  if (!fs.existsSync(watchlistFile)) return {};
  return JSON.parse(fs.readFileSync(watchlistFile));
}

function saveWatchlist(data) {
  fs.writeFileSync(watchlistFile, JSON.stringify(data, null, 2));
}

export const data = new SlashCommandBuilder()
  .setName('watchlist')
  .setDescription('Manage your football watchlist')
  .addSubcommand(sub =>
    sub.setName('add')
      .setDescription('Add a player')
      .addStringOption(opt => opt.setName('position').setDescription('Position').setRequired(true))
      .addStringOption(opt => opt.setName('team').setDescription('Team').setRequired(true))
      .addStringOption(opt => opt.setName('name').setDescription('Player name').setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName('remove')
      .setDescription('Remove a player')
      .addStringOption(opt => opt.setName('name').setDescription('Player name').setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName('view')
      .setDescription('View your watchlist')
  );

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const userId = interaction.user.id;
  const watchlists = loadWatchlist();
  watchlists[userId] ||= [];

  if (sub === 'add') {
    const position = interaction.options.getString('position').toUpperCase();
    const team = interaction.options.getString('team');
    const name = interaction.options.getString('name');
    const entry = `${position} | ${team} | ${name}`;
    watchlists[userId].push(entry);
    saveWatchlist(watchlists);
    await interaction.reply(`Added to watchlist: ${entry}`);
  }

  else if (sub === 'remove') {
    const name = interaction.options.getString('name');
    const before = watchlists[userId].length;
    watchlists[userId] = watchlists[userId].filter(p => !p.toLowerCase().includes(name.toLowerCase()));
    const after = watchlists[userId].length;
    saveWatchlist(watchlists);
    const removed = before - after;
    await interaction.reply(removed ? `Removed ${removed} player(s).` : 'Player not found.');
  }

  else if (sub === 'view') {
    const list = watchlists[userId];
    if (!list.length) {
      await interaction.reply("Your watchlist is empty.");
    } else {
      await interaction.reply(`**Your Watchlist:**\n${list.join('\n')}`);
    }
  }
}