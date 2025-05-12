// watchlist.js
import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} from 'discord.js';
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  updateWatchlistPlayer,
  setPlayerScore,
  getAverageScores,
  ensureSchema
} from '../db.js';
import { isValidTeam, suggestTeamName } from '../teams.js';
import crypto from 'crypto';
import { MessageFlags } from 'discord-api-types/v10';

await ensureSchema();

const commandQueue = [];
let isProcessing = false;
export const confirmAddMap = new Map();

// Visibility config: true = ephemeral/private, false = public
const subcommandPrivacy = {
  add: true,
  remove: true,
  score: false,
  view: true,
  edit: true
};

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
        await interaction.reply({ content: 'An error occurred.', ephemeral: true });
      } else {
        await interaction.editReply('An error occurred.');
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
    await interaction.reply({ content: 'You must have the **Members** role.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const isEphemeral = subcommandPrivacy[sub] ?? true;

   enqueueCommand(interaction, async (interaction) => {
     await interaction.deferReply({ flags: isEphemeral ? MessageFlags.Ephemeral : undefined });

    if (sub === 'add') {
      const position = interaction.options.getString('position');
      const team = interaction.options.getString('team');
      const name = interaction.options.getString('name');
      const lowerName = name.toLowerCase();
      const score = interaction.options.getNumber('score');
      const suggestion = suggestTeamName(team);

      if (!isValidTeam(team)) {
        if (suggestion) {
          const confirmId = crypto.randomUUID(); // import crypto at top
          const userId = interaction.user.id;
          const username = interaction.user.username;

          confirmAddMap.set(confirmId, {
            suggestedTeam: suggestion,
            position,
            name,
            userId,
            username
          });

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`confirm_team:${confirmId}`)
              .setLabel(`Yes, use "${suggestion}"`)
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId('cancel_team')
              .setLabel('Cancel')
              .setStyle(ButtonStyle.Secondary)
          );

          await interaction.editReply({
            content: `**${team}** is not recognized. Did you mean **${suggestion}**?`,
            components: [row]
          });
        } else {
          await interaction.editReply(`**${team}** is not a recognized team name.`);
        }
        return;
      }

      const list = await getWatchlist();
      const isDuplicate = list.some(player => player.name.toLowerCase() === lowerName);
      if (isDuplicate) {
        await interaction.editReply(`Player **${name}** is already on the watchlist.`);
        return;
      }

      const userId = interaction.user.id;
      const username = interaction.user.username;
      await addToWatchlist(position, team, name, userId, username);
      const channel = await interaction.client.channels.fetch('1109240048920039494');

      const scores = await getAverageScores();
      const avgScore = scores[name.toLowerCase()] 
        ? `**${parseFloat(scores[name.toLowerCase()]).toFixed(1)}**/10`
        : '**--**/10';

      const scoreDropdown = new       ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`score:${name}`)
          .setPlaceholder('Select a score (1–10)')
          .addOptions(
          ...Array.from({ length: 10 }, (_, i) => {
            const val = `${i + 1}`;
            return new StringSelectMenuOptionBuilder()
              .setLabel(`${val}/10`)
              .setValue(val);
          })
        );

      await channel.send({
        content: `Added to watchlist: ${position} | ${team} | ${name} ${score ? `| ${score}/10` : ''} by <@${userId}>.\n` +
         `Select a score below:`,
        components: [scoreDropdown]
      });

      await interaction.editReply(`Added to watchlist: ${position} | ${team} | ${name} | ${score}/10`);
    } else {
      await interaction.editReply(`Added to watchlist: ${position} | ${team} | ${name}`);
    }
   }
   else if (sub === 'edit') {
      const original = interaction.options.getString('name');
      const newTeam = interaction.options.getString('team');
      const newPosition = interaction.options.getString('position');
      const userId = interaction.user.id;
      const username = interaction.user.username;
      const isAdmin = interaction.member.roles.cache.has('1120846837671268514');

      const list = await getWatchlist();
      const player = list.find(p => p.name.toLowerCase() === original.toLowerCase());

      if (!player) {
        await interaction.editReply(`Player **${original}** not found.`);
        return;
      }

      if (player.user_id !== userId && !isAdmin) {
        await interaction.editReply({ content: 'You can only edit players you added.', ephemeral: true });
        return;
      }

      const updates = {};
      if (newName) updates.name = newName;
      if (newTeam) {
        if (!isValidTeam(newTeam)) {
          await interaction.editReply(`**${newTeam}** is not a recognized team.`);
          return;
        }
        updates.team = newTeam;
      }
      if (newPosition) updates.position = newPosition;

      const success = await updateWatchlistPlayer(original, player.user_id, updates);
      if (success) {
        await interaction.editReply(`Player **${original}** updated.`);
      } else {
        await interaction.editReply('No changes were made.');
      }
    }

    else if (sub === 'remove') {
    const name = interaction.options.getString('name');
    const userId = interaction.user.id;
    const isAdmin = interaction.member.roles.cache.has('1120846837671268514');
    const list = await getWatchlist();
    const match = list.find(p => p.name.toLowerCase() === name.toLowerCase());

    if (!match) {
      await interaction.editReply(`Player **${name}** not found.`);
      return;
    }

    if (match.user_id !== userId && !isAdmin) {
      await interaction.editReply({ content: 'You can only remove players you added.', ephemeral: true });
      return;
    }

    const removed = await removeFromWatchlist(name);
    await interaction.editReply(removed ? `Removed: ${name}` : `Failed to remove ${name}.`);
  }

    else if (sub === 'score') {
      const nameInput = interaction.options.getString('name');
      const score = interaction.options.getNumber('score');
      
      if (!/^\d+(\.\d)?$/.test(score.toString())) {
        await interaction.editReply({ content: 'Score must be a number with **up to 1 decimal place**.', ephemeral: true });
        return;
      }
      const userId = interaction.user.id;
      const username = interaction.user.username;
      const list = await getWatchlist();
      const match = list.find(p => p.name.toLowerCase() === nameInput.toLowerCase());

      if (!match) {
        const alt = list.find(p => p.name.toLowerCase().includes(nameInput.toLowerCase()));
        if (!alt) {
          await interaction.editReply({ content: `Player **${nameInput}** not found.`, ephemeral: true });
          return;
        }
        await setPlayerScore(alt.name, userId, username, score);
        await interaction.editReply(`Scored **${alt.name}**: ${score}/10 (corrected from "${nameInput}")`);
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

      if (scope === 'your') list = list.filter(p => p.user_id === userId);
      if (!list.length) {
        await interaction.editReply(`The ${scope} watchlist is empty.`);
        return;
      }

      const positionOrder = ['GK','LB','CB','RB','DM','CM','CAM','LW','RW','SS','ST','CF'];
      const grouped = {};
      for (const pos of positionOrder) grouped[pos] = [];
      for (const player of list) grouped[player.position]?.push(player);

      let output = `**${scope === 'your' ? 'Your' : 'Community'} Watchlist**\n`;
      for (const pos of positionOrder) {
        const players = grouped[pos];
        if (players?.length) {
          players.sort((a, b) => parseFloat(scores[b.name.toLowerCase()] || 0) - parseFloat(scores[a.name.toLowerCase()] || 0));
          output += `\n**${pos}**\n`;
          for (const p of players) {
            const score = scores[p.name.toLowerCase()] ? parseFloat(scores[p.name.toLowerCase()]).toFixed(1) : '--';
            output += scope === 'your'
              ? `- ${score} ${p.name} (${p.team})\n`
              : `- ${score} ${p.name} (${p.team}) - ${p.username}\n`;
          }
        }
      }
      await interaction.editReply({ content: output });
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
            { name: 'GK', value: 'GK' }, { name: 'LB', value: 'LB' }, { name: 'CB', value: 'CB' },
            { name: 'RB', value: 'RB' }, { name: 'DM', value: 'DM' }, { name: 'CM', value: 'CM' },
            { name: 'CAM', value: 'CAM' }, { name: 'LW', value: 'LW' }, { name: 'RW', value: 'RW' },
            { name: 'SS', value: 'SS' }, { name: 'CF', value: 'CF' }
          )
      )
      .addStringOption(opt => opt.setName('team').setDescription('Team').setRequired(true))
      .addStringOption(opt => opt.setName('name').setDescription('Player name').setRequired(true))
      .addNumberOption(opt =>
        opt.setName('score')
          .setDescription('Initial score between 1.0 and 10.0 (optional)')
          .setMinValue(1)
          .setMaxValue(10)
          .setRequired(false)
      )
  )
  
    .addSubcommand(sub =>
    sub.setName('edit')
      .setDescription('Edit a player')
      .addStringOption(opt =>
        opt.setName('name')
          .setDescription('Current player name to edit')
          .setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName('team')
          .setDescription('New team (optional)')
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('position')
          .setDescription('New position (optional)')
          .setRequired(false)
          .addChoices(
            { name: 'GK', value: 'GK' }, { name: 'LB', value: 'LB' }, { name: 'CB', value: 'CB' },
            { name: 'RB', value: 'RB' }, { name: 'DM', value: 'DM' }, { name: 'CM', value: 'CM' },
            { name: 'CAM', value: 'CAM' }, { name: 'LW', value: 'LW' }, { name: 'RW', value: 'RW' },
            { name: 'SS', value: 'SS' }, { name: 'CF', value: 'CF' }
          )
      )
  )
      
  .addSubcommand(sub =>
    sub.setName('remove')
      .setDescription('Remove a player')
      .addStringOption(opt => opt.setName('name').setDescription('Player name').setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName('score')
      .setDescription('Rate a player (1-10)')
      .addStringOption(opt => opt.setName('name').setDescription('Player name').setRequired(true))
      .addNumberOption(opt =>
      opt.setName('score')
        .setDescription('Score between 1.0 and 10.0')
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
            { name: 'Community Watchlist', value: 'community' },
            { name: 'Your Watchlist', value: 'your' }
          )
      )
  );
  
export default { data, execute };