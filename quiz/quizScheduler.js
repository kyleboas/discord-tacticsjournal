// src/scheduler/quizScheduler.js
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events
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

export async function runDailyQuiz(client) {
  const questionIndex = new Date().getDate() % QUESTIONS.length;
  const { question, options, answerIndex, points } = QUESTIONS[questionIndex];

  todayQuestionIndex = questionIndex;
  todayCorrectIndex = answerIndex;
  todayPoints = points;
  userResponses = new Map();

  const labels = ['A', 'B', 'C', 'D'];
  const questionText = options.map((opt, i) => `${labels[i]}) ${opt}`).join('\n');

  const now = new Date();
  const nextQuestionTime = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0, 0);
  const nextUnix = Math.floor(nextQuestionTime.getTime() / 1000);

  const embed = new EmbedBuilder()
    .setTitle('Question of the Day')
    .setDescription(
      `**Question:** ${question}\n\n${questionText}\n\n**Points:** ${points}\n\nThe next question will be posted <t:${nextUnix}:R>.`
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
  cron.schedule('0 8 * * *', async () => {
    await runDailyQuiz(client);
  }, { timezone: 'America/New_York' });

  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('quiz:')) return;
    if (todayCorrectIndex === null || todayQuestionIndex === null) return;

    if (userResponses.has(interaction.user.id)) {
      return interaction.reply({
        content: 'You have already answered today\'s quiz. Come back tomorrow!',
        ephemeral: true
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

    const answerLabel = ['A', 'B', 'C', 'D'][todayCorrectIndex];
    const correctAnswer = QUESTIONS[todayQuestionIndex].options[todayCorrectIndex];

    await interaction.reply({
      content: isCorrect
        ? `Correct! You earned ${todayPoints} point(s).`
        : `Wrong. The correct answer was ${answerLabel}) ${correctAnswer}.`,
      ephemeral: true
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