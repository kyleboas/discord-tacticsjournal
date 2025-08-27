import { SlashCommandBuilder, ChannelType, PermissionsBitField } from 'discord.js';
import {
  addManualGuildMatch,
  addMatchReminder,
  getMatchReminders,
  setReminderChannel,
  getReminderChannel,
  listGuildUpcomingRemindersForGuild
} from '../db.js';

export default {
  data: new SlashCommandBuilder()
    .setName('match')
    .setDescription('Manage football match reminders')
    .addSubcommand(cmd => cmd
      .setName('set')
      .setDescription('Set a new match reminder')
      .addStringOption(opt =>
        opt.setName('day')
          .setDescription('Day of the week')
          .setRequired(true)
          .addChoices(
            { name: 'Today', value: 'today' },
            { name: 'Sunday', value: 'sunday' },
            { name: 'Monday', value: 'monday' },
            { name: 'Tuesday', value: 'tuesday' },
            { name: 'Wednesday', value: 'wednesday' },
            { name: 'Thursday', value: 'thursday' },
            { name: 'Friday', value: 'friday' },
            { name: 'Saturday', value: 'saturday' }
          )
      )
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
      const time = interaction.options.getString('time'); // UTC HH:mm
      const home = interaction.options.getString('home');
      const away = interaction.options.getString('away');

      const targetDate = getNextWeekdayDate(day, time); // returns a Date (UTC)
      const channelId = await getReminderChannel(interaction.guildId);
      if (!channelId) {
        return interaction.reply({ content: 'Please set the reminder channel first using `/match channel`.', ephemeral: true });
      }

      // Write to fixtures_cache (+) guild_match_reminders (is_manual)
      const { match_id } = await addManualGuildMatch({
        guild_id: interaction.guildId,
        channel_id: channelId,
        match_time: targetDate,
        home,
        away,
        league: 'Manual',
        source: 'manual'
      });

      return interaction.reply({
        content: `Manual match added: **${home} vs ${away}** on <t:${Math.floor(targetDate.getTime()/1000)}:F>\n(id: \`${match_id}\`)`,
        ephemeral: true
      });
    }

    if (sub === 'list') {
      const rows = await listGuildUpcomingRemindersForGuild(interaction.guildId, 100);
      if (!rows.length) return interaction.reply('No upcoming reminders.');

      const lines = rows.map(r => {
        const ts = Math.floor(new Date(r.match_time).getTime() / 1000);
        const tag = r.is_manual ? 'manual' : 'followed';
        return `• [${tag}] ${r.home} vs ${r.away} -- <t:${ts}:F>`;
      });

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

  // Create match time in EST (UTC-5 standard / UTC-4 daylight)
  const estOffset = now.getTimezoneOffset() === 240 ? 5 : 4; // crude DST detection
  const utcHour = hh + estOffset;

  const target = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    utcHour,
    mm,
    0
  ));

  if (weekday.toLowerCase() === 'today') {
    if (target < now) target.setUTCDate(target.getUTCDate() + 7);
    return target;
  }

  const targetDay = dayMap[weekday.toLowerCase()];
  const diff = (targetDay - now.getUTCDay() + 7) % 7 || 7;
  target.setUTCDate(now.getUTCDate() + diff);
  return target;
}