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
import { recordQuizAnswerDetailed } from '../db.js';

const CHANNEL_ID = '1372225536406978640';
const ROLE_ID = '1372372259812933642';
const QUESTIONS = JSON.parse(fs.readFileSync(path.resolve('quiz/questions.json')));
let todayMessageId = null;
let previousMessageId = null;
let todayQuestionIndex = null;
let todayCorrectIndex = null;
let todayPoints = 0;
let userResponses = new Map();
let testQuizTimeout = null;

export async function runTestQuiz(client) {
  // Clear any existing test quiz timeout
  if (testQuizTimeout) {
    clearTimeout(testQuizTimeout);
  }

  const questionIndex = Math.floor(Math.random() * QUESTIONS.length);
  const { question, options, answerIndex, points } = QUESTIONS[questionIndex];

  todayQuestionIndex = questionIndex;
  todayCorrectIndex = answerIndex;
  todayPoints = points;
  userResponses.clear();

  const labels = ['A', 'B', 'C', 'D'];
  const questionText = options.map((opt, i) => `${labels[i]}) ${opt}`).join('\n');

  const embed = new EmbedBuilder()
    .setTitle('Test Quiz')
    .setDescription(
      `**Question:** ${question}\n\n${questionText}\n\n**Points:** ${points}\n\n**This is a test quiz and will close automatically after 60 seconds.**`
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    options.map((_, i) =>
      new ButtonBuilder()
        .setCustomId(`quiz:${i}`)
        .setLabel(labels[i])
        .setStyle(ButtonStyle.Primary)
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
  
  // Set a timeout to close the quiz after 60 seconds
  testQuizTimeout = setTimeout(async () => {
    try {
      const quizMsg = await channel.messages.fetch(todayMessageId);
      await quizMsg.delete();
      
      // Reset quiz state
      todayMessageId = null;
      todayQuestionIndex = null;
      todayCorrectIndex = null;
      todayPoints = 0;
      userResponses.clear();
      
      // Notify that the test quiz has ended
      await channel.send({
        content: "The test quiz has ended. Thanks for participating!",
        flags: MessageFlags.Ephemeral
      });
    } catch (err) {
      console.warn('Error closing test quiz:', err.message);
    }
  }, 60000); // 60 seconds
}

export async function runDailyQuiz(client) {
  const questionIndex = new Date().getDate() % QUESTIONS.length;
  const { question, options, answerIndex, points } = QUESTIONS[questionIndex];

  todayQuestionIndex = questionIndex;
  todayCorrectIndex = answerIndex;
  todayPoints = points;
  userResponses.clear();

  const labels = ['A', 'B', 'C', 'D'];
  const questionText = options.map((opt, i) => `${labels[i]}) ${opt}`).join('\n');

  // Calculate time until 8AM EST tomorrow
  const now = new Date();
  const closesAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0, 0);
  const nextUnix = Math.floor(closesAt.getTime() / 1000);
  
  const embed = new EmbedBuilder()
    .setTitle('Question of the Day')
    .setDescription(
      `**Question:** ${question}\n\n${questionText}\n\n**Points:** ${points}\n\nThis quiz will close <t:${nextUnix}:R>.`
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    options.map((_, i) =>
      new ButtonBuilder()
        .setCustomId(`quiz:${i}`)
        .setLabel(labels[i])
        .setStyle(ButtonStyle.Primary)
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
    content: `<@&${ROLE_ID}> today's question has been posted.`,
    embeds: [embed],
    components: [row]
  });

  todayMessageId = msg.id;
  previousMessageId = msg.id;
}

export function setupQuizScheduler(client) {
  cron.schedule('1 2 * * *', async () => {
    // Close the previous quiz if it exists
    if (todayMessageId) {
      try {
        const channel = await client.channels.fetch(CHANNEL_ID);
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
    }
    
    // Start a new quiz
    await runDailyQuiz(client);
  }, { timezone: 'America/New_York' });

  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('quiz:')) return;
    if (todayCorrectIndex === null || todayQuestionIndex === null) return;

    if (userResponses.has(interaction.user.id)) {
      return interaction.reply({
        content: 'You have already answered.',
        flags: MessageFlags.Ephemeral
      });
    }

    const selectedIndex = parseInt(interaction.customId.split(':')[1]);
    const isCorrect = selectedIndex === todayCorrectIndex;

    userResponses.set(interaction.user.id, selectedIndex);

    await recordQuizAnswerDetailed({
      userId: interaction.user.id,
      username: interaction.user.username,
      selectedIndex,
      messageId: todayMessageId,
      isCorrect,
      points: isCorrect ? todayPoints : 0
    });

    const label = ['A', 'B', 'C', 'D'][todayCorrectIndex];
    const answer = QUESTIONS[todayQuestionIndex].options[todayCorrectIndex];

    await interaction.reply({
      content: isCorrect
        ? `Correct! You earned ${todayPoints} points.`
        : `Wrong. The correct answer was ${label}) ${answer}.`,
      flags: MessageFlags.Ephemeral
    });
  });
}

export {
  QUESTIONS,
  todayMessageId,
  todayQuestionIndex,
  todayCorrectIndex,
  todayPoints,
  userResponses
};