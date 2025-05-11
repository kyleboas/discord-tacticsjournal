// index.js
import { Client, GatewayIntentBits, Collection } from 'discord.js';
import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { addToWatchlist, getWatchlist } from './db.js';
import { isValidTeam } from './teams.js';

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
  const command = await import(`./commands/${file}`);
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
      await interaction.reply({ content: 'There was an error executing that command.', ephemeral: true });
    }
  }

  // Handle button clicks
  if (interaction.isButton()) {
    const [action, encodedData] = interaction.customId.split(':');
    if (action === 'confirm_team') {
      const payload = JSON.parse(decodeURIComponent(encodedData));
      const { position, name, suggestedTeam, userId, username } = payload;

      // Ensure only the user who invoked the command can click
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
      await interaction.update({
        content: `Added to watchlist: ${position} | ${suggestedTeam} | ${name}`,
        components: [] // remove buttons
      });
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);