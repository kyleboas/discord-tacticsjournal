// commands/quiz.js
import { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { getQuizLeaderboard } from '../db.js';
import { runDailyQuiz } from '../quiz/quizScheduler.js';

const questionsPath = path.resolve('./quiz/questions.json');
const quizChannelId = '1372225536406978640';

export const data = new SlashCommandBuilder()
  .setName('quiz')
  .setDescription('Quiz commands')
  .addSubcommand(sub =>
    sub.setName('test')
      .setDescription('Post a test quiz to verify functionality')
  )
  .addSubcommand(sub =>
    sub.setName('leaderboard')
      .setDescription('View the quiz leaderboard')
  );

export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'test') {
    await runDailyQuiz(interaction.client);
    await interaction.reply({ content: 'Test quiz sent!', ephemeral: true });
  }

  if (subcommand === 'leaderboard') {
    const leaderboard = await getQuizLeaderboard();

    if (!leaderboard.length) {
      return interaction.reply({ content: 'No leaderboard data yet.', ephemeral: true });
    }

    const leaderboardMsg = leaderboard
      .map((user, index) => `**${index + 1}.** ${user.username} -- ${user.correct_count} correct`)
      .join('\n');

    await interaction.reply({ content: `**Question of the Day Leaderboard:**\n${leaderboardMsg}`, ephemeral: true });
  }
}