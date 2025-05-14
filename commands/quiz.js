// commands/quiz.js
import { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';

const questionsPath = path.resolve('./quiz/questions.json');
const quizChannelId = '1372225536406978640';

export const data = new SlashCommandBuilder()
  .setName('quiz')
  .setDescription('Quiz commands')
  .addSubcommand(sub => sub
    .setName('leaderboard')
    .setDescription('View the quiz leaderboard')
  );

export const data = new SlashCommandBuilder()
  .setName('quiz')
  .setDescription('Quiz system controller')
  .addSubcommand(sub =>
    sub.setName('test')
      .setDescription('Post a test quiz to verify functionality')
  );

export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'test') {
    const raw = fs.readFileSync(questionsPath, 'utf-8');
    const questions = JSON.parse(raw);
    const random = questions[Math.floor(Math.random() * questions.length)];

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`quiz_answer:${random.question}`)
      .setPlaceholder('Select your answer...')
      .addOptions(random.options.map(opt => ({
        label: opt,
        value: opt
      })));

    const row = new ActionRowBuilder().addComponents(menu);
    const quizMsg = `**Quiz Time!**\n${random.question}`;

    const channel = await interaction.client.channels.fetch(quizChannelId);
    await channel.send({ content: quizMsg, components: [row] });

    await interaction.reply({ content: 'Test quiz sent!', ephemeral: true });
  }
}
