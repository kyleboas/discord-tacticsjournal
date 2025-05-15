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
    sub.setName('test').setDescription('Post a test quiz')
  )
  .addSubcommand(sub =>
    sub.setName('open').setDescription('Start a new quiz manually')
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

  if (subcommand === 'test' || subcommand === 'open') {
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
      content: subcommand === 'test' ? 'Test quiz posted.' : 'New quiz started.',
      flags: MessageFlags.Ephemeral
    });
  }

  if (subcommand === 'close') {
    if (!todayMessageId || todayQuestionIndex === null || todayCorrectIndex === null) {
      return interaction.reply({
        content: 'There is no active quiz to close.',
        flags: MessageFlags.Ephemeral
      });
    }

    const { question, options } = QUESTIONS[todayQuestionIndex];
    const correctAnswer = options[todayCorrectIndex];
    const correctLabel = ['A', 'B', 'C', 'D'][todayCorrectIndex];
    const nextTime = new Date();
    nextTime.setDate(nextTime.getDate() + 1);
    nextTime.setHours(8, 0, 0, 0);
    const nextUnix = Math.floor(nextTime.getTime() / 1000);

    const embed = new EmbedBuilder()
      .setTitle('Question of the Day')
      .setDescription(`**Question:** ${question}\n\n**Answer:** ${correctLabel}) ${correctAnswer}\n\nThe next question will be posted <t:${nextUnix}:R>.`)
      .setTimestamp();

    try {
      const msg = await channel.messages.fetch(todayMessageId);
      await msg.delete();
    } catch (err) {
      console.warn('Could not delete quiz message:', err.message);
    }

    await channel.send({
      content: `<@&${POST_ROLE_ID}> today's answer has been posted.`,
      embeds: [embed]
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

    todayMessageId = null;
    todayQuestionIndex = null;
    todayCorrectIndex = null;
    todayPoints = 0;
    userResponses.clear();

    return interaction.reply({
      content: 'Quiz closed.',
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