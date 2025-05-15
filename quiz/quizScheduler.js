// src/scheduler/quizScheduler.js
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events } from 'discord.js';
import { recordQuizAnswerDetailed } from '../db.js';


const CHANNEL_ID = '1372225536406978640';
const ROLE_ID = '1372372259812933642';
const QUESTIONS = JSON.parse(fs.readFileSync(path.resolve('quiz/questions.json')));
let todayMessageId = null;
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
  const questionText = options.map((opt, i) => `${labels[i]}: ${opt}`).join('\n');

  const now = new Date();
  const revealTime = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    17, 0, 0
  );
  const revealUnix = Math.floor(revealTime.getTime() / 1000);

  const embed = new EmbedBuilder()
    .setTitle('Question of the Day')
    .setDescription(`Question: ${question}\n\n${questionText}\n\nPoints: ${points}\n\nThe answer will be revealed <t:${revealUnix}:t> (<t:${revealUnix}:R>).`)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    options.map((opt, i) =>
      new ButtonBuilder()
        .setCustomId(`quiz:${i}`)
        .setLabel(labels[i])
        .setStyle(ButtonStyle.Primary)
    )
  );

  const channel = await client.channels.fetch(CHANNEL_ID);
  const msg = await channel.send({
    content: `<@&${ROLE_ID}> today's question has been posted.`,
    embeds: [embed],
    components: [row]
  });

  todayMessageId = msg.id;
}

export function setupQuizScheduler(client) {
  cron.schedule('0 8 * * *', async () => {
    await runDailyQuiz(client);
  }, { timezone: 'America/New_York' });

  cron.schedule('0 17 * * *', async () => {
    if (todayQuestionIndex === null || todayCorrectIndex === null || todayMessageId === null) return;

    const { question, options } = QUESTIONS[todayQuestionIndex];
    const correctAnswer = options[todayCorrectIndex];
    const answerLabel = ['A', 'B', 'C', 'D'][todayCorrectIndex];

    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.send({
      content: `<@&${ROLE_ID}> today's question has been posted.`,
      embeds: [
        new EmbedBuilder()
          .setTitle('Question of the Day')
          .setDescription(`Question: ${question}\n\nAnswer: ${answerLabel}) ${correctAnswer}`)
          .setTimestamp()
      ]
    });

    for (const [userId, selectedIndex] of userResponses.entries()) {
      const member = await client.users.fetch(userId);
      const isCorrect = selectedIndex === todayCorrectIndex;

      await interaction.reply({
      content: "Your answer has been recorded. The answer will be revealed later today. You can change your answer before the deadline.",
      ephemeral: true
    });

      await recordQuizAnswerDetailed(userId, member.username, isCorrect);
    }

    todayMessageId = null;
    todayQuestionIndex = null;
    todayCorrectIndex = null;
    todayPoints = 0;
    userResponses.clear();
  }, { timezone: 'America/New_York' });

  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('quiz:')) return;
    if (todayCorrectIndex === null || todayQuestionIndex === null) return;

    const selectedIndex = parseInt(interaction.customId.split(':')[1]);
    userResponses.set(interaction.user.id, selectedIndex);

    await interaction.reply({
      content: "Your answer has been recorded. You may change it before the deadline. The answer will be revealed later today.",
      ephemeral: true
    });

    await recordQuizAnswerDetailed({
      userId: interaction.user.id,
      username: interaction.user.username,
      selectedIndex,
      messageId: todayMessageId,
      isCorrect: false,
      points: 0
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