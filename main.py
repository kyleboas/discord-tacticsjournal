import os
import discord
from discord import app_commands
from discord.ext import commands
from flask import Flask
from threading import Thread

intents = discord.Intents.default()
bot = commands.Bot(command_prefix='-', intents=intents)
tree = bot.tree

# In-memory watchlists
watchlists = {}

@bot.event
async def on_ready():
    await tree.sync()
    print(f"Bot is online as {bot.user}")

@tree.command(name="watchlist", description="Manage your football watchlist")
@app_commands.describe(
    action="Choose action: add, remove, or view",
    position="Player's position",
    team="Player's team",
    name="Player's name"
)
async def watchlist(interaction: discord.Interaction, action: str, position: str = None, team: str = None, name: str = None):
    user_id = str(interaction.user.id)
    if user_id not in watchlists:
        watchlists[user_id] = []

    if action == "add":
        if not all([position, team, name]):
            await interaction.response.send_message("Usage: /watchlist action:add position:<pos> team:<team> name:<name>")
            return
        player = f"{position.upper()} | {team.title()} | {name.title()}"
        watchlists[user_id].append(player)
        await interaction.response.send_message(f"Added: {player}")

    elif action == "remove":
        if not name:
            await interaction.response.send_message("Usage: /watchlist action:remove name:<player name>")
            return
        removed = False
        for player in watchlists[user_id]:
            if name.lower() in player.lower():
                watchlists[user_id].remove(player)
                await interaction.response.send_message(f"Removed: {player}")
                removed = True
                break
        if not removed:
            await interaction.response.send_message("Player not found in your watchlist.")

    elif action == "view":
        if not watchlists[user_id]:
            await interaction.response.send_message("Your watchlist is empty.")
        else:
            msg = "**Your Watchlist:**\n" + "\n".join(watchlists[user_id])
            await interaction.response.send_message(msg)
    else:
        await interaction.response.send_message("Invalid action. Use: add, remove, or view.")

# Flask ping server
app = Flask('')

@app.route('/')
def home():
    return "Bot is alive"

def keep_alive():
    Thread(target=app.run, kwargs={'host': '0.0.0.0', 'port': 8080}).start()

keep_alive()
bot.run(os.getenv("DISCORD_BOT_TOKEN"))