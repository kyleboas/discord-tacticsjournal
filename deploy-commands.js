import { REST, Routes } from 'discord.js';
import { config } from 'dotenv';
import fs from 'fs';

config();

const commands = [];
const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const command = await import(`./commands/${file}`);
  commands.push(command.data.toJSON());
} 

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

try {
  console.log('Refreshing application commands...');
  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID.toString()),
    { body: commands }
  );
  console.log('Successfully registered commands.');
} catch (error) {
  console.error(error);
}