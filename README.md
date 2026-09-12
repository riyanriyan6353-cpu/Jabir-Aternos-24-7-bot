# v1.2.3 Private Admin / Geyser Fix

Private admin commands now reply using the Aternos/Geyser `.PlayerName` form when needed, and player lookup accepts both `PlayerName` and `.PlayerName`.

Commands: `/msg PerzaanLive !inv`, `/msg PerzaanLive !creative`, `/msg PerzaanLive !drop diamond 10`, `/msg PerzaanLive !give .CosmicEntity24 diamond 10`.

Replace the repository files with the files in this ZIP.

# Fixed Aternos AFK Bot

This is a cleaned replacement for the broken `index.js` shown in the Railway logs.

## Railway

- Build command: `npm install`
- Start command: `npm start`
- No custom PORT is required; Railway supplies `PORT`.

## Configure

Edit `settings.json`:

- `bot-account.username`
- `server.ip`
- `server.port`
- `server.version`
- `utils.auto-auth.password`

For Discord notifications, set the Railway variable:

`DISCORD_WEBHOOK_URL`

Do not put a Discord webhook URL directly in GitHub.

## Important

The bot uses `auth: "offline"`, so it is intended for a server configured to allow offline/cracked accounts. An online-mode server requires a different authentication setup.

The dashboard is available at `/` and the health endpoint at `/health`.

## Admin inventory / Creative commands (PRIVATE-ONLY)

Set your Minecraft username in `settings.json` under `admin.username`, or set the Railway environment variable `ADMIN_USERNAME` if your build supports it. The configured admin username is normalized so a leading Geyser `.` is ignored.

**Important:** Admin commands are accepted **only through a private message to the bot**. Public chat commands are intentionally ignored.

In Minecraft, privately message the bot:

```text
/msg PerzaanLive !help
/msg PerzaanLive !creative
/msg PerzaanLive !inv
/msg PerzaanLive !drop diamond 5
/msg PerzaanLive !give CosmicEntity24 diamond 10
```

The bot's replies are also private messages to the admin. Other players do not receive the command or the bot's response in normal public chat. Mineflayer supports the `whisper` event for incoming private messages and `/tell`/`/msg` for private replies.

Available commands:

- `!help` — show the commands
- `!creative` — send `/gamemode creative` to the bot
- `!inv` — show the bot's current inventory
- `!drop <item> [amount]` — drop an item from the bot's inventory
- `!give <player> <item> [amount]` — create the item in the bot's Creative inventory, walk to the target player, and drop it

### Important Creative requirement

Mineflayer's Creative inventory API assumes the bot is already in Creative mode. The `!creative` command sends `/gamemode creative`, so the bot must have permission to run that command (for example through the server's permissions/console). The bot does **not** automatically OP itself.

The `!give` command is intentionally admin-only. It does not expose an HTTP item-give endpoint.

If the target player is not online or not currently visible to the bot, delivery will fail rather than dropping the item somewhere random.


## v1.2.1 deployment note
This build is syntax-checked with `node --check index.js`. Replace the existing repository files with the files in this ZIP, especially `index.js`, `package.json`, and `settings.json`. Do not paste the JavaScript manually.

Admin commands are private-only and are received through Minecraft `/msg` or `/tell`. Public `!` commands are ignored.
