// index.js
import { Client, GatewayIntentBits, Collection } from 'discord.js';
import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { addToWatchlist, getWatchlist } from './db.js';
import { isValidTeam } from './teams.js';
import { confirmAddMap } from './commands/watchlist.js';

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
client.commands = new Collection();

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
  await client.application.commands.set(commandData);
  console.log('Slash commands synced');
});

client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'There was an error executing that command.', ephemeral: true });
      } else {
        await interaction.editReply({ content: 'There was an error executing that command.' });
      }
    }
  }

  if (interaction.isButton()) {
    const [action, id] = interaction.customId.split(':');

    if (action === 'confirm_team') {
      const payload = confirmAddMap.get(id);
      if (!payload) {
        await interaction.reply({ content: 'This confirmation has expired or is invalid.', ephemeral: true });
        return;
      }

      const { position, name, suggestedTeam, userId, username } = payload;

      if (interaction.user.id !== userId) {
        await interaction.reply({
          content: `Only <@${userId}> can confirm this team name.`,
          ephemeral: true
        });
        return;
      }

      if (!isValidTeam(suggestedTeam)) {
        await interaction.reply({ content: 'That team is no longer valid.', ephemeral: true });
        return;
      }

      const list = await getWatchlist();
      const isDuplicate = list.some(player => player.name.toLowerCase() === name.toLowerCase());
      if (isDuplicate) {
        await interaction.reply({ content: `Player **${name}** is already on the watchlist.`, ephemeral: true });
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

client.login(process.env.DISCORD_BOT_TOKEN);