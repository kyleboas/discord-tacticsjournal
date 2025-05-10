// watchlist.js
import { SlashCommandBuilder } from 'discord.js';
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  setPlayerScore,
  getAverageScores,
  ensureSchema
} from '../db.js';

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
  const memberRoleId = '1182838456720826460';
  const hasRole = interaction.member.roles.cache.has(memberRoleId);

  if (!hasRole) {
    await interaction.reply({
      content: 'You must have the **Members** role to use this command.',
      ephemeral: true
    });
    return;
  }

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

    else if (sub === 'score') {
      const nameInput = interaction.options.getString('name');
      const score = interaction.options.getInteger('score');
      const userId = interaction.user.id;
      const username = interaction.user.username;

      const list = await getWatchlist();
      const match = list.find(p => p.name.toLowerCase() === nameInput.toLowerCase());

      if (!match) {
      await interaction.reply({
          content: `Player **${nameInput}** is not on the watchlist. Add them using the /watchlist add command.`,
          ephemeral: true
        });
        return;
      }

      await setPlayerScore(match.name, userId, username, score);
      await interaction.editReply(`Scored **${match.name}**: ${score}/10`);
    }

    else if (sub === 'view') {
      const scope = interaction.options.getString('scope');
      const userId = interaction.user.id;

      let list = await getWatchlist();
      const scores = await getAverageScores();

      if (scope === 'your') {
        list = list.filter(player => player.user_id === userId);
      }

      if (!list.length) {
        await interaction.editReply(`The ${scope} watchlist is empty.`);
        return;
      }

      const positionOrder = ['GK', 'LB', 'CB', 'RB', 'DM', 'CM', 'CAM', 'LW', 'RW', 'SS', 'ST', 'CF'];
      const grouped = {};
      for (const pos of positionOrder) grouped[pos] = [];
      for (const player of list) {
        if (grouped[player.position]) grouped[player.position].push(player);
      }

      let output = `**${scope === 'your' ? 'Your' : 'Community'} Watchlist:**\n`;
      for (const pos of positionOrder) {
        let players = grouped[pos];

        if (players.length) {
          // Sort by average score descending
          players.sort((a, b) => {
            const scoreA = parseFloat(scores[a.name.toLowerCase()] || 0);
            const scoreB = parseFloat(scores[b.name.toLowerCase()] || 0);
            return scoreB - scoreA;
          });

          output += `\n**${pos}**\n`;
          for (const p of players) {
            const avg = scores[p.name.toLowerCase()];
            const score = avg ? parseFloat(avg).toFixed(1) : '--';

            output += scope === 'your'
              ? `- ${score} ${p.name} (${p.team})\n`
              : `- ${score} ${p.name} (${p.team}) - ${p.username}\n`;
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
            { name: 'CF', value: 'CF' }
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
    sub.setName('score')
      .setDescription('Rate a player (1-10)')
      .addStringOption(opt =>
        opt.setName('name')
          .setDescription('Player name')
          .setRequired(true)
      )
      .addIntegerOption(opt =>
        opt.setName('score')
          .setDescription('Score between 1 and 10')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(10)
      )
  )
  .addSubcommand(sub =>
    sub.setName('view')
      .setDescription('View the watchlist')
      .addStringOption(opt =>
        opt.setName('scope')
          .setDescription('Which watchlist to view')
          .setRequired(true)
          .addChoices(
            { name: 'Community', value: 'community' },
            { name: 'Your', value: 'your' }
          )
      )
  );