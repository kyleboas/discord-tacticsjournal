import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { recordQuizAnswer } from './db.js';

const CHANNEL_ID = '1372225536406978640';
const QUESTIONS = JSON.parse(fs.readFileSync(path.resolve('quiz/questions.json')));
let todayMessageId = null;
let todayAnswer = null;

export function setupQuizScheduler(client) {
  cron.schedule('0 8 * * *', async () => {
    const questionIndex = new Date().getDate() % QUESTIONS.length;
    const { question, options, answer } = QUESTIONS[questionIndex];
    todayAnswer = answer;

    const row = {
      type: 1,
      components: options.map((opt, i) => ({
        type: 2,
        style: 1,
        label: opt,
        custom_id: `quiz:${i}`
      }))
    };

    const channel = await client.channels.fetch(CHANNEL_ID);
    const msg = await channel.send({
      content: `**Daily Quiz:** ${question}`,
      components: [row]
    });

    todayMessageId = msg.id;
  }, { timezone: 'America/New_York' });

  cron.schedule('0 17 * * *', async () => {
    if (!todayAnswer || !todayMessageId) return;

    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.send(`**Quiz Closed!** The correct answer was: **${todayAnswer}**`);

    todayAnswer = null;
    todayMessageId = null;
  }, { timezone: 'America/New_York' });
}

export function getTodayAnswer() {
  return todayAnswer;
}