import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags
} from 'discord.js';
import {
  getQuizLeaderboard,
  recordQuizAnswerDetailed
} from '../db.js';
import {
  runDailyQuiz,
  runTestQuiz,
  QUESTIONS,
  todayQuestionIndex,
  todayCorrectIndex,
  todayMessageId,
  todayPoints,
  userResponses
} from '../quiz/quizScheduler.js';

const QUIZ_ROLE_ID = '1100369095251206194';
const QUIZ_CHANNEL_ID = '1372225536406978640';
const POST_ROLE_ID = '1372372259812933642';

export const data = new SlashCommandBuilder()
  .setName('quiz')
  .setDescription('Quiz commands')
  .addSubcommand(sub =>
    sub.setName('test').setDescription('Post a test quiz that lasts 60 seconds')
  )
  .addSubcommand(sub =>
    sub.setName('open').setDescription('Start a new quiz that closes at 8AM EST')
  )
  .addSubcommand(sub =>
    sub.setName('status').setDescription('Check current quiz status (admin only)')
  )
  .addSubcommand(sub =>
    sub.setName('close').setDescription('Manually close the active quiz')
  )
  .addSubcommand(sub =>
    sub.setName('leaderboard').setDescription('View the quiz leaderboard')
  );

export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();
  const hasQuizRole = interaction.member.roles.cache.has(QUIZ_ROLE_ID);
  const channel = await interaction.client.channels.fetch(QUIZ_CHANNEL_ID);

  if (subcommand !== 'leaderboard' && !hasQuizRole) {
    return interaction.reply({
      content: 'You must have the quiz role to use this command.',
      flags: MessageFlags.Ephemeral
    });
  }

  if (subcommand === 'test') {
    if (todayMessageId) {
      try {
        const prev = await channel.messages.fetch(todayMessageId);
        await prev.delete();
      } catch (err) {
        console.warn('Failed to delete quiz message:', err.message);
      }
    }

    await runTestQuiz(interaction.client);

    return interaction.reply({
      content: 'Test quiz posted. It will automatically close after 60 seconds.',
      flags: MessageFlags.Ephemeral
    });
  }
  
  if (subcommand === 'status') {
    if (!hasQuizRole) {
      return interaction.reply({
        content: 'You must have the quiz role to use this command.',
        flags: MessageFlags.Ephemeral
      });
    }

    if (todayQuestionIndex === null || todayCorrectIndex === null || todayMessageId === null) {
      return interaction.reply({
        content: 'No active quiz currently running.',
        flags: MessageFlags.Ephemeral
      });
    }

    const { question, options } = QUESTIONS[todayQuestionIndex];
    const total = userResponses.size;
    const correctCount = [...userResponses.values()].filter(i => i === todayCorrectIndex).length;
    const correctLabel = ['A', 'B', 'C', 'D'][todayCorrectIndex];
    const correctAnswer = options[todayCorrectIndex];

    const now = new Date();
    const nextTime = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0, 0);
    const nextUnix = Math.floor(nextTime.getTime() / 1000);

    const embed = new EmbedBuilder()
      .setTitle('Current Quiz Status')
      .setDescription(
        `**Question:** ${question}\n\n` +
        `**Correct Answer:** ${correctLabel}) ${correctAnswer}\n` +
        `**Participants:** ${total}\n` +
        `**Correct Responses:** ${correctCount}\n\n` +
        `**Closes:** <t:${nextUnix}:R>`
      )
      .setTimestamp();

    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } 

  if (subcommand === 'open') {
    if (todayMessageId) {
      try {
        const prev = await channel.messages.fetch(todayMessageId);
        await prev.delete();
      } catch (err) {
        console.warn('Failed to delete quiz message:', err.message);
      }
    }

    await runDailyQuiz(interaction.client);

    return interaction.reply({
      content: 'New quiz started. It will close at 8AM EST tomorrow.',
      flags: MessageFlags.Ephemeral
    });
  }

  if (subcommand === 'close') {
    if (!todayMessageId) {
      return interaction.reply({
        content: 'There is no active quiz to close.',
        flags: MessageFlags.Ephemeral
      });
    }

    try {
      const channel = await interaction.client.channels.fetch(QUIZ_CHANNEL_ID);
      const msg = await channel.messages.fetch(todayMessageId);
      await msg.delete();
    } catch (err) {
      console.warn('Could not delete quiz message:', err.message);
    }

    // Reset quiz state
    todayMessageId = null;
    todayQuestionIndex = null;
    todayCorrectIndex = null;
    todayPoints = 0;
    userResponses.clear();

    return interaction.reply({
      content: 'Quiz closed and deleted.',
      flags: MessageFlags.Ephemeral
    });
  }

  if (subcommand === 'leaderboard') {
    const leaderboard = await getQuizLeaderboard();
    if (!leaderboard.length) {
      return interaction.reply({ content: 'No leaderboard data yet.', flags: MessageFlags.Ephemeral });
    }

    const msg = leaderboard
      .map((user, index) => `**${index + 1}.** ${user.username} -- ${user.total_points} pts`)
      .join('\n');

    return interaction.reply({
      content: `**Question of the Day Leaderboard:**\n${msg}`,
      flags: MessageFlags.Ephemeral
    });
  }
}