import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('quiz')
  .setDescription('Quiz commands')
  .addSubcommand(sub => sub
    .setName('leaderboard')
    .setDescription('View the quiz leaderboard')
  );

export async function execute(interaction) {
  // handled in index.js
}