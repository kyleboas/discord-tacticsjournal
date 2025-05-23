import { SlashCommandBuilder, ChannelType, PermissionsBitField } from 'discord.js';
import {
  addMatchReminder,
  getMatchReminders,
  setReminderChannel,
  getReminderChannel
} from '../db.js';

export default {
  data: new SlashCommandBuilder()
    .setName('match')
    .setDescription('Manage football match reminders')
    .addSubcommand(cmd => cmd
      .setName('set')
      .setDescription('Set a new match reminder')
      .addStringOption(opt => opt.setName('day').setDescription('Day of the week').setRequired(true))
      .addStringOption(opt => opt.setName('time').setDescription('Time in UTC (HH:mm)').setRequired(true))
      .addStringOption(opt => opt.setName('home').setDescription('Home team').setRequired(true))
      .addStringOption(opt => opt.setName('away').setDescription('Away team').setRequired(true)))
    .addSubcommand(cmd => cmd
      .setName('list')
      .setDescription('List upcoming match reminders'))
    .addSubcommand(cmd => cmd
      .setName('channel')
      .setDescription('Set the channel to send match reminders to')
      .addChannelOption(opt => opt
        .setName('target')
        .setDescription('Target channel')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText))),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: 'Only admins can use this command.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
      const day = interaction.options.getString('day');
      const time = interaction.options.getString('time');
      const home = interaction.options.getString('home');
      const away = interaction.options.getString('away');

      const targetDate = getNextWeekdayDate(day, time);
      const channelId = await getReminderChannel(interaction.guildId);
      if (!channelId) return interaction.reply('Please set the reminder channel first using `/match channel`.');

      await addMatchReminder(home, away, targetDate, channelId);
      return interaction.reply(`Match reminder set: **${home} vs ${away}** on ${targetDate.toUTCString()}`);
    }

    if (sub === 'list') {
      const reminders = await getMatchReminders();
      if (!reminders.length) return interaction.reply('No upcoming reminders.');
      const lines = reminders.map(m => `${m.home} vs ${m.away} - <t:${Math.floor(new Date(m.match_time).getTime() / 1000)}:F>`);
      return interaction.reply(lines.join('\n'));
    }

    if (sub === 'channel') {
      const channel = interaction.options.getChannel('target');
      await setReminderChannel(interaction.guildId, channel.id);
      return interaction.reply(`Reminder channel set to <#${channel.id}>`);
    }
  }
};

function getNextWeekdayDate(weekday, timeStr) {
  const dayMap = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6
  };
  const [hh, mm] = timeStr.split(':').map(Number);
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(hh, mm, 0, 0);

  const day = dayMap[weekday.toLowerCase()];
  const diff = (day - now.getUTCDay() + 7) % 7 || 7;
  target.setUTCDate(now.getUTCDate() + diff);
  return target;
}