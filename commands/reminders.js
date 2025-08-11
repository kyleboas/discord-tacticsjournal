// commands/reminders.js
import { SlashCommandBuilder, MessageFlags, ChannelType } from 'discord.js';
import { setReminderChannel } from '../db.js';

export const data = new SlashCommandBuilder()
  .setName('reminders')
  .setDescription('Reminder settings')
  .addSubcommand(sub =>
    sub
      .setName('set-channel')
      .setDescription('Set this server’s match reminder channel')
      .addChannelOption(opt =>
        opt
          .setName('channel')
          .setDescription('Channel to post reminders in (defaults to current channel)')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
  );

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub !== 'set-channel') {
    return interaction.reply({ content: 'Unknown subcommand.', flags: MessageFlags.Ephemeral });
  }

  const guildId = interaction.guildId;
  const ch = interaction.options.getChannel('channel') || interaction.channel;

  if (!guildId || !ch) {
    return interaction.reply({ content: '❌ You must run this inside a server text channel.', flags: MessageFlags.Ephemeral });
  }

  await setReminderChannel(guildId, ch.id);
  return interaction.reply({ content: `✅ Reminders will be posted in <#${ch.id}>.`, flags: MessageFlags.Ephemeral });
}