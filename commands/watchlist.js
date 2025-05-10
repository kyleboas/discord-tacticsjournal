import { SlashCommandBuilder } from 'discord.js';
import fs from 'fs';

const WATCHLIST_FILE = 'watchlists.json';
const commandQueue = [];
let isProcessing = false;

async function processQueue() {
  if (isProcessing || commandQueue.length === 0) return;

  isProcessing = true;
  const { interaction, operation } = commandQueue.shift();

  try {
    await operation(interaction);
  } catch (error) {
    console.error('Error processing command:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: 'An error occurred while processing your command.',
          flags: 64, // EPHEMERAL
        });
      } else {
        await interaction.editReply('An error occurred while processing your command.');
      }
    } catch (replyError) {
      console.error('Failed to reply to interaction:', replyError);
    }
  }

  isProcessing = false;
  processQueue();
}

function enqueueCommand(interaction, operation) {
  commandQueue.push({ interaction, operation });
  processQueue();
}

async function loadWatchlist() {
  try {
    if (!fs.existsSync(WATCHLIST_FILE)) {
      console.warn('Watchlist file not found, returning empty watchlist.');
      return { shared: [] };
    }
    const data = fs.readFileSync(WATCHLIST_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading watchlist:', error);
    return { shared: [] };
  }
}

async function saveWatchlist(data) {
  try {
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error saving watchlist:', error);
  }
}

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  enqueueCommand(interaction, async (interaction) => {
    await interaction.deferReply();

    const watchlist = await loadWatchlist();

    if (sub === 'add') {
      const position = interaction.options.getString('position');
      const team = interaction.options.getString('team');
      const name = interaction.options.getString('name');
      const lowerName = name.toLowerCase();

      const isDuplicate = watchlist.shared.some(player =>
        player.toLowerCase().includes(lowerName)
      );

      if (isDuplicate) {
        await interaction.editReply(`Player **${name}** is already on the watchlist.`);
        return;
      }

      const entry = `${position} | ${team} | ${name}`;
      watchlist.shared.push(entry);
      await saveWatchlist(watchlist);
      await interaction.editReply(`Added to watchlist: ${entry}`);
    }

    else if (sub === 'remove') {
      const name = interaction.options.getString('name').toLowerCase();
      const playerToRemove = watchlist.shared.find(player =>
        player.toLowerCase().includes(name)
      );

      if (playerToRemove) {
        watchlist.shared = watchlist.shared.filter(player => player !== playerToRemove);
        await saveWatchlist(watchlist);
        await interaction.editReply(`Removed: ${playerToRemove}`);
      } else {
        await interaction.editReply('Player not found in the watchlist.');
      }
    }

    else if (sub === 'view') {
      const list = watchlist.shared;
      if (!list.length) {
        await interaction.editReply("The watchlist is empty.");
      } else {
        await interaction.editReply(`**Shared Watchlist:**\n${list.join('\n')}`);
      }
    }
  });
}

export const data = new SlashCommandBuilder()
  .setName('watchlist')
  .setDescription('Manage the shared football watchlist')
  .addSubcommand(sub =>
    sub.setName('add')
      .setDescription('Add a player')
      .addStringOption(opt =>
        opt.setName('position')
          .setDescription('Position')
          .setRequired(true)
          .addChoices(
            { name: 'GK', value: 'GK' },
            { name: 'LB', value: 'LB' },
            { name: 'CB', value: 'CB' },
            { name: 'RB', value: 'RB' },
            { name: 'DM', value: 'DM' },
            { name: 'CM', value: 'CM' },
            { name: 'CAM', value: 'CAM' },
            { name: 'LW', value: 'LW' },
            { name: 'RW', value: 'RW' },
            { name: 'SS', value: 'SS' },
            { name: 'ST', value: 'ST' }
          ))
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
      .setDescription('View the watchlist')
  );