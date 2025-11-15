// quizScheduler.js
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags
} from 'discord.js';
import {
  recordQuizAnswerDetailed,
  getActiveQuizFromDB,
  setActiveQuizInDB,
  getWeeklyLeaderboard,
  getSeasonalLeaderboard,
  getLastTrackedSeason,
  setLastTrackedSeason
} from '../db.js';
import { getCurrentSeason, isTomorrowSeasonEnd, getTomorrowStartingSeason } from './seasonUtils.js';

const CHANNEL_ID = '1098771891898023947';
const ROLE_ID = '1372372259812933642';
const WINNER_ROLE_ID = '1439360908588482830';

// Load questions (can be reloaded)
let QUESTIONS = JSON.parse(fs.readFileSync(path.resolve('quiz/questions.json')));

// Reload questions from file (for hot-reloading when questions are auto-generated)
function reloadQuestions() {
  try {
    QUESTIONS = JSON.parse(fs.readFileSync(path.resolve('quiz/questions.json')));
    console.log(`📚 Reloaded ${QUESTIONS.length} questions from questions.json`);
    return QUESTIONS.length;
  } catch (err) {
    console.error('Failed to reload questions:', err);
    return -1;
  }
}

let todayMessageId = null;
let previousMessageId = null;
let todayQuestionIndex = null;
let todayCorrectIndex = null;
let todayPoints = 0;
let userResponses = new Map();
let testQuizTimeout = null;
let quizMessage = null;
let quizChannelId = CHANNEL_ID;

/**
 * Handle season end - congratulate winner and assign role
 */
async function handleSeasonEnd(client, endedSeason) {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    const { top10 } = await getSeasonalLeaderboard('bot-seasonal', endedSeason.id);

    if (!top10.length) {
      console.log(`No participants in season ${endedSeason.id}`);
      return;
    }

    const winner = top10[0];

    // Create congratulations embed
    const congratsEmbed = new EmbedBuilder()
      .setTitle(`${endedSeason.emoji} Season Winner! ${endedSeason.emoji}`)
      .setDescription(
        `**Congratulations to ${winner.username}!**\n\n` +
        `They won the **${endedSeason.theme}** season with **${winner.total_points} points**!\n\n` +
        `🏆 They've earned the Season Winner role!`
      )
      .setColor(16766720) // Gold color
      .setTimestamp();

    // Try to assign winner role
    try {
      const guild = channel.guild;
      const member = await guild.members.fetch(winner.user_id);
      const role = await guild.roles.fetch(WINNER_ROLE_ID);

      if (member && role) {
        await member.roles.add(role);
        console.log(`Assigned winner role to ${winner.username}`);
      }
    } catch (err) {
      console.error('Failed to assign winner role:', err);
    }

    // Post congratulations message
    await channel.send({
      content: `<@${winner.user_id}>`,
      embeds: [congratsEmbed]
    });

    // Post final season leaderboard
    const leaderboardText = top10
      .map((user, index) => `**${index + 1}.** ${user.username} -- ${user.total_points} pts`)
      .join('\n');

    const finalLeaderboardEmbed = new EmbedBuilder()
      .setTitle(`${endedSeason.emoji} ${endedSeason.theme} - Final Standings`)
      .setDescription(leaderboardText)
      .setColor(endedSeason.color)
      .setFooter({ text: `Season ended: ${endedSeason.endDate}` })
      .setTimestamp();

    await channel.send({
      embeds: [finalLeaderboardEmbed],
      allowedMentions: { parse: [] }
    });

  } catch (err) {
    console.error('Error handling season end:', err);
  }
}

/**
 * Announce new season starting
 */
export async function announceSeasonStart(client, newSeason) {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);

    const announceEmbed = new EmbedBuilder()
      .setTitle(`${newSeason.emoji} New Season Begins! ${newSeason.emoji}`)
      .setDescription(
        `**${newSeason.theme}** season is now live!\n\n` +
        `${newSeason.description}\n\n` +
        `📅 **Season Dates:** ${newSeason.startDate} to ${newSeason.endDate}\n\n` +
        `Good luck to all participants! 🎯`
      )
      .setColor(newSeason.color)
      .setTimestamp();

    await channel.send({
      content: `<@&${ROLE_ID}>`,
      embeds: [announceEmbed]
    });

    console.log(`Announced new season: ${newSeason.theme}`);
  } catch (err) {
    console.error('Error announcing season start:', err);
  }
}

/**
 * Announce season ending tomorrow
 */
async function announceSeasonEnding(client, endingSeason) {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);

    const warningEmbed = new EmbedBuilder()
      .setTitle(`${endingSeason.emoji} Season Ending Tomorrow! ${endingSeason.emoji}`)
      .setDescription(
        `**${endingSeason.theme}** season ends tomorrow!\n\n` +
        `This is your last chance to secure your position on the leaderboard!\n\n` +
        `📅 **Season Ends:** ${endingSeason.endDate}\n\n` +
        `Make every point count! 🎯`
      )
      .setColor(endingSeason.color)
      .setTimestamp();

    await channel.send({
      content: `<@&${ROLE_ID}>`,
      embeds: [warningEmbed]
    });

    console.log(`Announced season ending: ${endingSeason.theme}`);
  } catch (err) {
    console.error('Error announcing season ending:', err);
  }
}

/**
 * Clear all messages in the quiz channel
 */
async function clearQuizChannel(channel) {
  try {
    let deletedCount = 0;
    let fetched;

    // Fetch and delete messages in batches
    do {
      fetched = await channel.messages.fetch({ limit: 100 });

      if (fetched.size === 0) break;

      // Separate messages into bulk deletable (< 14 days) and old messages
      const now = Date.now();
      const twoWeeksAgo = now - (14 * 24 * 60 * 60 * 1000);

      const bulkDeletable = fetched.filter(msg => msg.createdTimestamp > twoWeeksAgo);
      const oldMessages = fetched.filter(msg => msg.createdTimestamp <= twoWeeksAgo);

      // Bulk delete recent messages
      if (bulkDeletable.size > 0) {
        if (bulkDeletable.size === 1) {
          await bulkDeletable.first().delete();
          deletedCount += 1;
        } else {
          await channel.bulkDelete(bulkDeletable, true);
          deletedCount += bulkDeletable.size;
        }
      }

      // Delete old messages individually
      for (const msg of oldMessages.values()) {
        try {
          await msg.delete();
          deletedCount += 1;
          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (err) {
          console.warn(`Failed to delete old message ${msg.id}:`, err.message);
        }
      }

    } while (fetched.size >= 100);

    if (deletedCount > 0) {
      console.log(`Cleared ${deletedCount} messages from quiz channel`);
    }
  } catch (err) {
    console.error('Error clearing quiz channel:', err);
  }
}

export async function runTestQuiz(client) {
  if (testQuizTimeout) clearTimeout(testQuizTimeout);

  const questionIndex = Math.floor(Math.random() * QUESTIONS.length);
  const { question, options, answerIndex, points } = QUESTIONS[questionIndex];

  todayQuestionIndex = questionIndex;
  todayCorrectIndex = answerIndex;
  todayPoints = points;
  userResponses.clear();

  const labels = ['A', 'B', 'C', 'D'];
  const questionText = options.map((opt, i) => `${labels[i]}) ${opt}`).join('\n');

  const currentSeason = getCurrentSeason();

  const embed = new EmbedBuilder()
    .setTitle('Test Quiz')
    .setDescription(
      `${question}\n\n${questionText}\n\n**Points:** ${points}\n\n**This is a test quiz and will close automatically after 60 seconds.**`
    )
    .setTimestamp();

  // Apply season theme to embed if a season is active
  if (currentSeason) {
    embed.setColor(currentSeason.color);
    embed.setFooter({ text: `${currentSeason.emoji} ${currentSeason.theme}` });
  }

  const row = new ActionRowBuilder().addComponents(
    options.map((_, i) =>
      new ButtonBuilder().setCustomId(`quiz:${i}`).setLabel(labels[i]).setStyle(ButtonStyle.Primary)
    )
  );

  const channel = await client.channels.fetch(CHANNEL_ID);

  if (previousMessageId) {
    try {
      const prev = await channel.messages.fetch(previousMessageId);
      await prev.delete();
    } catch (err) {
      console.warn('Failed to delete previous message:', err.message);
    }
  }

  const msg = await channel.send({
    content: `<@&${ROLE_ID}> A test quiz has been posted. You have 60 seconds to answer!`,
    embeds: [embed],
    components: [row]
  });

  todayMessageId = msg.id;
  previousMessageId = msg.id;
  quizMessage = msg;

  testQuizTimeout = setTimeout(async () => {
    try {
      const quizMsg = await channel.messages.fetch(todayMessageId);
      await quizMsg.delete();

      todayMessageId = null;
      todayQuestionIndex = null;
      todayCorrectIndex = null;
      todayPoints = 0;
      userResponses.clear();

      await channel.send({
        content: 'The test quiz has ended. Thanks for participating!',
        flags: MessageFlags.Ephemeral
      });
    } catch (err) {
      console.warn('Error closing test quiz:', err.message);
    }
  }, 60000);
}

export async function setActiveQuizState({ messageId, questionIndex, correctIndex, points, message }) {
  todayMessageId = messageId;
  todayQuestionIndex = questionIndex;
  todayCorrectIndex = correctIndex;
  todayPoints = points;
  quizMessage = message;

  await setActiveQuizInDB({
    messageId,
    questionIndex,
    correctIndex,
    points,
    channelId: quizChannelId
  });
}

export async function runDailyQuiz(client) {
  // Check for season transitions
  const currentSeason = getCurrentSeason();
  const lastTrackedSeason = await getLastTrackedSeason();

  // Handle season end (when we transition from a season to no season or a new season)
  if (lastTrackedSeason && (!currentSeason || currentSeason.id !== lastTrackedSeason)) {
    const { getSeasonById } = await import('./seasonUtils.js');
    const endedSeason = getSeasonById(lastTrackedSeason);
    if (endedSeason) {
      await handleSeasonEnd(client, endedSeason);
    }
  }

  // Announce new season start
  if (currentSeason && currentSeason.id !== lastTrackedSeason) {
    await announceSeasonStart(client, currentSeason);
    await setLastTrackedSeason(currentSeason.id);
  }

  // Update tracked season if it changed
  if (!currentSeason && lastTrackedSeason) {
    await setLastTrackedSeason(null);
  }

  // Announce if tomorrow is the last day of the season
  if (isTomorrowSeasonEnd() && currentSeason) {
    await announceSeasonEnding(client, currentSeason);
  }

  const questionIndex = new Date().getDate() % QUESTIONS.length;
  const { question, options, answerIndex, points } = QUESTIONS[questionIndex];

  todayQuestionIndex = questionIndex;
  todayCorrectIndex = answerIndex;
  todayPoints = points;
  userResponses.clear();

  const labels = ['A', 'B', 'C', 'D'];
  const questionText = options.map((opt, i) => `${labels[i]}) ${opt}`).join('\n');

  const now = new Date();
  const closesAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 12, 0, 0));
  const nextUnix = Math.floor(closesAt.getTime() / 1000);

  const embed = new EmbedBuilder()
    .setTitle('Question of the Day')
    .setDescription(`${question}\n\n${questionText}\n\n**Points:** ${points}\n\nThe next question will be posted <t:${nextUnix}:R>.`)
    .setTimestamp();

  // Apply season theme to embed if a season is active
  if (currentSeason) {
    embed.setColor(currentSeason.color);
    embed.setFooter({ text: `${currentSeason.emoji} ${currentSeason.theme} • ${currentSeason.description}` });
  }

  const row = new ActionRowBuilder().addComponents(
    options.map((_, i) =>
      new ButtonBuilder().setCustomId(`quiz:${i}`).setLabel(labels[i]).setStyle(ButtonStyle.Primary)
    )
  );

  const channel = await client.channels.fetch(CHANNEL_ID);

  // Clear all messages in the channel before posting the new quiz
  await clearQuizChannel(channel);

  const msg = await channel.send({
    content: `<@&${ROLE_ID}> today's question has been posted.`,
    embeds: [embed],
    components: [row]
  });

  todayMessageId = msg.id;
  previousMessageId = msg.id;
  quizMessage = msg;

  // Persist active quiz to database
  await setActiveQuizInDB({
    messageId: msg.id,
    questionIndex,
    correctIndex: answerIndex,
    points,
    channelId: CHANNEL_ID
  });

  // Always show weekly leaderboard
  const { top10: weeklyTop10 } = await getWeeklyLeaderboard('bot-weekly');

  if (weeklyTop10.length) {
    const weeklyLeaderboardText = weeklyTop10
      .map((user, index) => `**${index + 1}.** ${user.username} -- ${user.total_points} pts`)
      .join('\n');

    const weeklyLeaderboardEmbed = new EmbedBuilder()
      .setTitle('📆 Weekly Leaderboard')
      .setDescription(weeklyLeaderboardText)
      .setColor(0x2ecc71)
      .setTimestamp();

    await channel.send({
      embeds: [weeklyLeaderboardEmbed],
      allowedMentions: { parse: [] }
    });
  }

  // Show seasonal leaderboard if a season is active
  if (currentSeason) {
    const { top10: seasonTop10 } = await getSeasonalLeaderboard('bot-seasonal', currentSeason.id);

    if (seasonTop10.length) {
      const seasonLeaderboardText = seasonTop10
        .map((user, index) => `**${index + 1}.** ${user.username} -- ${user.total_points} pts`)
        .join('\n');

      const seasonLeaderboardEmbed = new EmbedBuilder()
        .setTitle(`${currentSeason.emoji} ${currentSeason.theme} Leaderboard`)
        .setDescription(seasonLeaderboardText)
        .setColor(currentSeason.color)
        .setFooter({ text: `Season runs from ${currentSeason.startDate} to ${currentSeason.endDate}` })
        .setTimestamp();

      await channel.send({
        embeds: [seasonLeaderboardEmbed],
        allowedMentions: { parse: [] }
      });
    }
  }
} 

export function setupQuizScheduler(client) {
  cron.schedule('0 12 * * *', async () => {
    // Clear state for new quiz (channel will be cleared by runDailyQuiz)
    todayMessageId = null;
    todayQuestionIndex = null;
    todayCorrectIndex = null;
    todayPoints = 0;
    userResponses.clear();

    await runDailyQuiz(client);
  });

  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('quiz:')) return;

    try {
      if (todayCorrectIndex === null || todayQuestionIndex === null) {
        return interaction.reply({ content: 'No active quiz found.', flags: MessageFlags.Ephemeral });
      }

      if (userResponses.has(interaction.user.id)) {
        return interaction.reply({
          content: 'You have already answered.',
          flags: MessageFlags.Ephemeral
        });
      }

      const selectedIndex = parseInt(interaction.customId.split(':')[1]);
      const isCorrect = selectedIndex === todayCorrectIndex;
      userResponses.set(interaction.user.id, selectedIndex);

      const currentSeason = getCurrentSeason();

      await recordQuizAnswerDetailed({
        userId: interaction.user.id,
        username: interaction.user.username,
        selectedIndex,
        messageId: todayMessageId,
        isCorrect,
        points: isCorrect ? todayPoints : 0,
        season: currentSeason ? currentSeason.id : null
      });

      const label = ['A', 'B', 'C', 'D'][todayCorrectIndex];
      const answer = QUESTIONS[todayQuestionIndex].options[todayCorrectIndex];

      await interaction.reply({
        content: isCorrect
          ? `Correct! You earned ${todayPoints} points.`
          : `Wrong. The correct answer was ${label}) ${answer}.`,
        flags: MessageFlags.Ephemeral
      });

      if (quizMessage) {
        const total = userResponses.size;
        const correct = [...userResponses.values()].filter(i => i === todayCorrectIndex).length;

        const { question, options } = QUESTIONS[todayQuestionIndex];
        const questionText = options.map((opt, i) => `${['A', 'B', 'C', 'D'][i]}) ${opt}`).join('\n');
        const now = new Date();
        const closesAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 12, 0, 0));
        const nextUnix = Math.floor(closesAt.getTime() / 1000);

        const updatedEmbed = new EmbedBuilder()
          .setTitle('Question of the Day')
          .setDescription(
            `${question}\n\n${questionText}\n\n**Points:** ${todayPoints}` +
            `\nThe next question will be posted <t:${nextUnix}:R>.`
          )
          .setTimestamp();

        try {
          const channel = await client.channels.fetch(quizChannelId);
          const liveMessage = await channel.messages.fetch(todayMessageId);
          await liveMessage.edit({ embeds: [updatedEmbed] });
          quizMessage = liveMessage;
        } catch (err) {
          console.warn('Failed to update quiz message:', err.message);
        }
      }
    } catch (err) {
      console.error('Quiz button interaction failed:', err);
      if (!interaction.replied) {
        await interaction.reply({
          content: 'Something went wrong while handling your answer.',
          flags: MessageFlags.Ephemeral
        });
      }
    }
  });

  // Rehydrate persisted active quiz on startup
  (async () => {
    try {
      const saved = await getActiveQuizFromDB();
      if (!saved) return;

      const channel = await client.channels.fetch(saved.channel_id);
      const msg = await channel.messages.fetch(saved.message_id).catch(() => null);

      if (!msg) {
        console.warn('Saved active quiz message not found in Discord.');
        return;
      }

      todayMessageId = saved.message_id;
      todayQuestionIndex = saved.question_index;
      todayCorrectIndex = saved.correct_index;
      todayPoints = saved.points;
      quizMessage = msg;
      quizChannelId = saved.channel_id;

      console.log('Restored active quiz from database.');
    } catch (err) {
      console.error('Failed to restore active quiz:', err);
    }
  })();
}

export {
  QUESTIONS,
  reloadQuestions,
  todayMessageId,
  todayQuestionIndex,
  todayCorrectIndex,
  todayPoints,
  userResponses
};