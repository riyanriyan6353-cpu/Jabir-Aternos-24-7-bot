# Aternos AFK Bot v1.3.0

This version fixes the problems found in the previous build:

- reconnects after ECONNRESET / socketClosed / Aternos server restarts
- keeps admin commands private-only
- accepts Geyser/Floodgate usernames with or without the leading dot
- removes the old undefined-variable delivery bug
- removes the Creative `updateSlot:36` dependency from `!give`
- `!give` uses the server's `/give` command directly, so the bot does not need to create an inventory slot and walk to the player
- `!drop` still drops an item that is already in the bot inventory at the bot's location
- `!inv` reports the bot inventory privately
- `!creative` sends `/gamemode creative`

## Commands

Send these as a private message to the bot from the configured admin account:

- `!help`
- `!inv`
- `!creative`
- `!give .CosmicEntity24 diamond 15`
- `!give CosmicEntity24 diamond 15`
- `!drop diamond 15`

`!give` requires the bot to have permission to run `/give` on the server (for example, OP). It gives the item directly to the target rather than physically throwing it.

## Railway

You can keep server details in `settings.json`, or set these Railway variables:

- `MC_HOST`
- `MC_PORT`
- `MC_VERSION` (optional)
- `BOT_USERNAME`
- `BOT_PASSWORD` (optional)
- `BOT_AUTH` (default `offline`)
- `ADMIN_USERNAME`
- `AUTH_PASSWORD` (only if auto-auth is enabled)
- `DISCORD_WEBHOOK_URL` (optional; do not commit a webhook into GitHub)

Run `npm run check` before deployment. Railway runs `npm start` automatically.
