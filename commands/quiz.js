import { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { getQuizLeaderboard, recordQuizAnswerDetailed } from '../db.js';
import { runDailyQuiz } from '../quiz/quizScheduler.js';
import { QUESTIONS } from '../quiz/quizScheduler.js'; // assuming it's exported
import { todayQuestionIndex, todayCorrectIndex, todayMessageId, todayPoints, userResponses } from '../quiz/quizScheduler.js'; // also export these

const quizChannelId = '1372225536406978640';
const questionsPath = path.resolve('./quiz/questions.json');

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
  )
  .addSubcommand(sub =>
    sub.setName('close')
      .setDescription('Manually close the active quiz and award points')
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
      .map((user, index) => `**${index + 1}.** ${user.username} -- ${user.total_points} points`)
      .join('\n');

    await interaction.reply({ content: `**Question of the Day Leaderboard:**\n${leaderboardMsg}`, ephemeral: true });
  }

  if (subcommand === 'close') {
    if (
      todayQuestionIndex === null ||
      todayCorrectIndex === null ||
      todayMessageId === null
    ) {
      return interaction.reply({
        content: 'There is no active quiz to close.',
        ephemeral: true
      });
    }

    const { question, options } = QUESTIONS[todayQuestionIndex];
    const correctAnswer = options[todayCorrectIndex];
    const answerLabel = ['A', 'B', 'C', 'D'][todayCorrectIndex];

    const channel = await interaction.client.channels.fetch(quizChannelId);
    await channel.send({
      content: `**Question of the Day Answer:**`,
      embeds: [
        {
          title: 'Question of the Day',
          description: `Question: ${question}\n\nAnswer: ${answerLabel}) ${correctAnswer}`,
          timestamp: new Date().toISOString()
        }
      ]
    });

    for (const [userId, selectedIndex] of userResponses.entries()) {
      const member = await interaction.client.users.fetch(userId);
      const isCorrect = selectedIndex === todayCorrectIndex;

      if (isCorrect) {
        await member.send(`You answered ${['A', 'B', 'C', 'D'][selectedIndex]}, you have been awarded ${todayPoints} points.`);
      } else {
        await member.send(`You did not answer ${['A', 'B', 'C', 'D'][todayCorrectIndex]}, you have been awarded no points.`);
      }

      await recordQuizAnswerDetailed({
        userId,
        username: member.username,
        selectedIndex,
        messageId: todayMessageId,
        isCorrect,
        points: isCorrect ? todayPoints : 0
      });
    }

    // Reset state
    todayMessageId = null;
    todayQuestionIndex = null;
    todayCorrectIndex = null;
    todayPoints = 0;
    userResponses.clear();

    await interaction.reply({ content: 'The quiz has been closed and points awarded.', ephemeral: true });
  }
}