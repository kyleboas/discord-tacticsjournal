// watchlist.js
import { SlashCommandBuilder } from 'discord.js';
import { getWatchlist, addToWatchlist, removeFromWatchlist, ensureSchema } from '../db.js';

await ensureSchema();


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
          flags: 64,
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

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  enqueueCommand(interaction, async (interaction) => {
    await interaction.deferReply();

    if (sub === 'add') {
      const position = interaction.options.getString('position');
      const team = interaction.options.getString('team');
      const name = interaction.options.getString('name');
      const lowerName = name.toLowerCase();

      const list = await getWatchlist();
      const isDuplicate = list.some(player => player.name.toLowerCase() === lowerName);

      if (isDuplicate) {
        await interaction.editReply(`Player **${name}** is already on the watchlist.`);
        return;
      }

      // These must come BEFORE the call
      const userId = interaction.user.id;
      const username = interaction.user.username;

      await addToWatchlist(position, team, name, userId, username);

      await interaction.editReply(`Added to watchlist: ${position} | ${team} | ${name}`);
    }

    else if (sub === 'remove') {
      const name = interaction.options.getString('name');
      const removed = await removeFromWatchlist(name);
      await interaction.editReply(removed ? `Removed: ${name}` : `Player not found in the watchlist.`);
    }

    else if (sub === 'view') {
      const list = await getWatchlist();
      if (!list.length) {
        await interaction.editReply("The watchlist is empty.");
        return;
      }

      const positionOrder = ['GK', 'LB', 'CB', 'RB', 'DM', 'CM', 'CAM', 'LW', 'RW', 'SS', 'ST'];
      const grouped = {};

      for (const pos of positionOrder) {
        grouped[pos] = [];
      }

      for (const player of list) {
        if (grouped[player.position]) {
          grouped[player.position].push(player);
        }
      }

      let output = "**Shared Watchlist:**\n";

      for (const pos of positionOrder) {
        const players = grouped[pos];
        if (players && players.length) {
          output += `\n**${pos}**\n`;
          for (const p of players) {
            output += `${p.team.padEnd(10)} | ${p.name} (by ${p.username})\n`;
          }
        }
      }

      await interaction.editReply(output);
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