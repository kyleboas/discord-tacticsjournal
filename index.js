import { Client, GatewayIntentBits, Collection, Options } from 'discord.js';
import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { addToWatchlist, getWatchlist, setPlayerScore, getAverageScores } from './db.js';
import { isValidTeam } from './teams.js';
import { confirmAddMap } from './commands/watchlist.js';
import { MessageFlags } from 'discord-api-types/v10';

import { setupModeration } from './aiModeration.js';

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Optimized client with reduced cache settings
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  makeCache: Options.cacheWithLimits({
    MessageManager: {
      maxSize: 100, // Only cache 100 messages
      sweepInterval: 300 // Clear cache every 5 minutes
    },
    GuildMemberManager: {
      maxSize: 200,
      sweepInterval: 600
    },
    ChannelManager: {
      maxSize: 50
    }
  })
});
client.commands = new Collection();

setupModeration(client);

const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));
for (const file of commandFiles) {
  const commandModule = await import(`./commands/${file}`);
  const command = commandModule.default || commandModule;

  if (!command?.data?.name) {
    console.warn(`[WARN] Skipping ${file}: missing 'data.name'`);
    continue;
  }

  client.commands.set(command.data.name, command);
}

client.once('ready', async () => {
  console.log(`Bot is online as ${client.user.tag}`);
  const commandData = client.commands.map(cmd => cmd.data.toJSON());
  const guild = client.guilds.cache.get('YOUR_GUILD_ID'); // replace with actual guild/server ID
  if (!guild) {
    console.error('Guild not found.');
    return;
  }

  // Role-limited: only show /modcheck to this role
  const moderatorRoleId = '1100369095251206194';

  const modcheckCommand = commandData.find(cmd => cmd.name === 'modcheck');
  if (modcheckCommand) {
    const registered = await guild.commands.create(modcheckCommand);
    await registered.permissions.set({
      permissions: [{
        id: moderatorRoleId,
        type: 1, // 1 = ROLE
        permission: true
      }]
    });
  }

  // Register other commands normally
  for (const cmd of commandData.filter(c => c.name !== 'modcheck')) {
    await guild.commands.create(cmd);
  }
  console.log('Slash commands synced');
});
// Cache for lazy loading commands
const commandCache = new Collection();

// Lazy load commands only when needed
client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    const commandName = interaction.commandName;
    let command;
    
    // Check cache first
    if (commandCache.has(commandName)) {
      command = commandCache.get(commandName);
    } else {
      try {
        // Only import if not in cache
        const commandModule = await import(`./commands/${commandName}.js`);
        command = commandModule.default || commandModule;
        
        if (!command?.data?.name) {
          console.warn(`[WARN] Command module ${commandName} is missing 'data.name'`);
          return;
        }
        
        // Cache for future use
        commandCache.set(commandName, command);
      } catch (error) {
        console.error(`Failed to import command ${commandName}:`, error);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'Command not found.', flags: MessageFlags.Ephemeral });
        }
        return;
      }
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(`Error executing command ${commandName}:`, error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'There was an error executing that command.', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.editReply({ content: 'There was an error executing that command.' });
      }
    }
  }
  
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('score:')) {
    const [, name] = interaction.customId.split(':');
    const selected = interaction.values[0];
    const score = Number(selected);

    const userId = interaction.user.id;
    const username = interaction.user.username;

    await setPlayerScore(name, userId, username, score);
    const scores = await getAverageScores();
    const avg = scores[name.toLowerCase()] 
      ? parseFloat(scores[name.toLowerCase()]).toFixed(1) 
      : '--';

    // Get the latest player data from the database
    const list = await getWatchlist();
    const match = list.find(p => p.name.toLowerCase() === name.toLowerCase());

    // Update the original message if we can find it in the database
    if (match?.channel_id && match?.message_id) {
      try {
        const msgChannel = await interaction.client.channels.fetch(match.channel_id);
        const msg = await msgChannel.messages.fetch(match.message_id);

        await msg.edit({
          content: `Added to watchlist by <@${match.user_id}>\n**${avg}** | ${match.position} | ${match.name} (${match.team})`,
          components: msg.components
        });
      } catch (err) {
        console.error('Failed to edit message for score update from database:', err);
      }
    } 
    // Fallback to the cached reference if database doesn't have message IDs
    else {
      const ref = confirmAddMap.get(name.toLowerCase());
      if (ref && ref.messageId && ref.channelId) {
        try {
          const msgChannel = await interaction.client.channels.fetch(ref.channelId);
          const msg = await msgChannel.messages.fetch(ref.messageId);

          await msg.edit({
            content: `Added to watchlist by <@${ref.userId}>\n**${avg}** | ${ref.position} | ${name} (${ref.team})`,
            components: msg.components
          });
        } catch (err) {
          console.error('Failed to edit message for score update from cache:', err);
        }
      }
    }

    await interaction.reply({
      content: `You rated **${name}** ${score}/10. New avg: **${avg}**`,
      flags: MessageFlags.Ephemeral
    });
  }

  if (interaction.isButton()) {
    const [action, id] = interaction.customId.split(':');

    if (action === 'confirm_team') {
      const payload = confirmAddMap.get(id);
      if (!payload) {
        await interaction.reply({ content: 'This confirmation has expired or is invalid.', flags: MessageFlags.Ephemeral });
        return;
      }

      const { position, name, suggestedTeam, userId, username } = payload;

      if (interaction.user.id !== userId) {
        await interaction.reply({
          content: `Only <@${userId}> can confirm this team name.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (!isValidTeam(suggestedTeam)) {
        await interaction.reply({ content: 'That team is no longer valid.', flags: MessageFlags.Ephemeral });
        return;
      }

      const list = await getWatchlist();
      const isDuplicate = list.some(player => player.name.toLowerCase() === name.toLowerCase());
      if (isDuplicate) {
        await interaction.reply({ content: `Player **${name}** is already on the watchlist.`, flags: MessageFlags.Ephemeral });
        return;
      }

      await addToWatchlist(position, suggestedTeam, name, userId, username);
      confirmAddMap.delete(id);

      await interaction.update({
        content: `Added to watchlist: ${position} | ${suggestedTeam} | ${name}`,
        components: []
      });
    }

    if (action === 'cancel_team') {
      await interaction.update({
        content: 'Team selection cancelled.',
        components: []
      });
    }
  }
});

client.once('ready', async () => {
  console.log(`Bot is online as ${client.user.tag}`);
  
  // Load all commands for startup registration
  const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));
  for (const file of commandFiles) {
    const commandModule = await import(`./commands/${file}`);
    const command = commandModule.default || commandModule;

    if (!command?.data?.name) {
      console.warn(`[WARN] Skipping ${file}: missing 'data.name'`);
      continue;
    }

    client.commands.set(command.data.name, command);
    commandCache.set(command.data.name, command);
  }
  
  const commandData = client.commands.map(cmd => cmd.data.toJSON());
  const guild = client.guilds.cache.get('YOUR_GUILD_ID'); // replace with actual guild/server ID
  if (!guild) {
    console.error('Guild not found.');
    return;
  }

  // Role-limited: only show /modcheck to this role
  const moderatorRoleId = '1100369095251206194';

  const modcheckCommand = commandData.find(cmd => cmd.name === 'modcheck');
  if (modcheckCommand) {
    const registered = await guild.commands.create(modcheckCommand);
    await registered.permissions.set({
      permissions: [{
        id: moderatorRoleId,
        type: 1, // 1 = ROLE
        permission: true
      }]
    });
  }

  // Register other commands normally
  for (const cmd of commandData.filter(c => c.name !== 'modcheck')) {
    await guild.commands.create(cmd);
  }
  console.log('Slash commands synced');
});

// Graceful shutdown handler
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  // Give time to finish pending operations
  setTimeout(() => {
    console.log('Shutting down');
    client.destroy();
    process.exit(0);
  }, 1500);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  // Keep running despite errors
});

client.login(process.env.DISCORD_BOT_TOKEN);