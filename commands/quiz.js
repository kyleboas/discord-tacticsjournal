// commands/quiz.js
import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder
} from 'discord.js';
import fs from 'fs';
import path from 'path';
import {
  getQuizLeaderboard,
  recordQuizAnswerDetailed
} from '../db.js';
import {
  runDailyQuiz,
  QUESTIONS,
  todayQuestionIndex,
  todayCorrectIndex,
  todayMessageId,
  todayPoints,
  userResponses
} from '../quiz/quizScheduler.js';

const ROLE_ID = '1372372259812933642';
const quizChannelId = '1372225536406978640';

export const data = new SlashCommandBuilder()
  .setName('quiz')
  .setDescription('Quiz commands')
  .addSubcommand(sub =>
    sub.setName('test').setDescription('Post a test quiz to verify functionality')
  )
  .addSubcommand(sub =>
    sub.setName('leaderboard').setDescription('View the quiz leaderboard')
  )
  .addSubcommand(sub =>
    sub.setName('close').setDescription('Manually close the active quiz and award points')
  );

export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'test') {
    await runDailyQuiz(interaction.client);
    return interaction.reply({ content: 'Test quiz sent!', ephemeral: true });
  }

  if (subcommand === 'leaderboard') {
    const leaderboard = await getQuizLeaderboard();

    if (!leaderboard.length) {
      return interaction.reply({ content: 'No leaderboard data yet.', ephemeral: true });
    }

    const leaderboardMsg = leaderboard
      .map((user, index) => `**${index + 1}.** ${user.username} -- ${user.total_points} pts`)
      .join('\n');

    return interaction.reply({
      content: `**Question of the Day Leaderboard:**\n${leaderboardMsg}`,
      ephemeral: true
    });
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
    const correctLabel = ['A', 'B', 'C', 'D'][todayCorrectIndex];

    const channel = await interaction.client.channels.fetch(quizChannelId);

    const answerEmbed = new EmbedBuilder()
      .setTitle('Question of the Day -- Answer')
      .setDescription(`**Question:** ${question}\n\n**Answer:** ${correctLabel}) ${correctAnswer}`)
      .setTimestamp();

    // Delete original question message
    try {
      const msg = await channel.messages.fetch(todayMessageId);
      await msg.delete();
    } catch (err) {
      console.warn('Could not delete quiz message:', err.message);
    }

    await channel.send({
      content: `<@&${ROLE_ID}> today's answer has been posted.`,
      embeds: [answerEmbed]
    });

    for (const [userId, selectedIndex] of userResponses.entries()) {
      const member = await interaction.client.users.fetch(userId);
      const isCorrect = selectedIndex === todayCorrectIndex;

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

    return interaction.reply({
      content: 'Quiz closed and results posted.',
      ephemeral: true
    });
  }
}