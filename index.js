// ============================================================
// ATERNOS AFK BOT - COMPLETE INDEX.JS
// Railway + Mineflayer
// AFK + Reconnect + Movement + Admin Creative + Item Delivery
// ============================================================

const express = require("express");
const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const Item = require("prismarine-item");

// ============================================================
// LOAD SETTINGS
// ============================================================

const config = require("./settings.json");

// ============================================================
// EXPRESS WEB SERVER
// ============================================================

const app = express();

const PORT = Number(process.env.PORT || 8080);

app.get("/", (req, res) => {
  res.send("Aternos AFK Bot is running.");
});

app.get("/health", (req, res) => {
  res.json({
    status: "running",
    botConnected: Boolean(bot && bot.entity),
    username: bot ? bot.username : null,
    server: `${config.server.host}:${config.server.port}`,
    reconnectAttempt,
    deliveryInProgress
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Web] Server listening on port ${PORT}`);
});

// ============================================================
// BOT VARIABLES
// ============================================================

let bot = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let deliveryInProgress = false;

let movementTimer = null;
let lookTimer = null;

// ============================================================
// BASIC CONFIG
// ============================================================

const SERVER_HOST = config.server.host;
const SERVER_PORT = Number(config.server.port);

const BOT_USERNAME =
  process.env.MINECRAFT_USERNAME ||
  config.bot.username;

const BOT_PASSWORD =
  process.env.MINECRAFT_PASSWORD ||
  config.bot.password;

// ============================================================
// ADMIN
// ============================================================

function getAdminUsername() {
  return String(config.admin?.username || "")
    .trim()
    .toLowerCase();
}

function isAdmin(username) {
  const admin = getAdminUsername();

  if (!admin) {
    return false;
  }

  return String(username || "")
    .trim()
    .toLowerCase() === admin;
}

function tell(username, message) {
  if (!bot) return;

  try {
    bot.whisper(username, String(message));
  } catch (_) {
    try {
      bot.chat(String(message));
    } catch (_) {}
  }
}

// ============================================================
// DISCORD WEBHOOK
// ============================================================

async function sendDiscord(message) {
  const webhook =
    process.env.DISCORD_WEBHOOK_URL ||
    config.discord?.webhookUrl;

  if (!webhook) return;

  try {
    await fetch(webhook, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        content: String(message)
      })
    });
  } catch (error) {
    console.log("[Discord] Webhook error:", error.message);
  }
}

// ============================================================
// SERVER CONNECTION
// ============================================================

function connectBot() {
  if (bot) {
    try {
      bot.quit("Reconnecting");
    } catch (_) {}
  }

  bot = null;

  console.log(
    `[Bot] Connecting to ${SERVER_HOST}:${SERVER_PORT} as ${BOT_USERNAME}`
  );

  const options = {
    host: SERVER_HOST,
    port: SERVER_PORT,
    username: BOT_USERNAME,

    // Use the version from settings.json if supplied.
    // If omitted, Mineflayer attempts automatic detection.
    version: config.server.version || false,

    auth: config.bot.auth || "offline",

    hideErrors: false
  };

  if (BOT_PASSWORD) {
    options.password = BOT_PASSWORD;
  }

  try {
    bot = mineflayer.createBot(options);
  } catch (error) {
    console.log("[Bot] Create error:", error.message);
    scheduleReconnect();
    return;
  }

  // ==========================================================
  // PATHFINDER
  // ==========================================================

  bot.loadPlugin(pathfinder);

  // ==========================================================
  // LOGIN
  // ==========================================================

  bot.once("login", () => {
    console.log("[Bot] Login successful.");
  });

  // ==========================================================
  // SPAWN
  // ==========================================================

  bot.once("spawn", async () => {
    reconnectAttempt = 0;

    console.log("[Bot] Connected and spawned.");

    await sendDiscord(
      `🟢 Bot connected: ${bot.username}`
    );

    startAntiAFK();

    // Optional automatic authentication
    await autoAuth();

    // Start simple movement
    startMovement();
  });

// ==========================================================
// CHAT
// ==========================================================

bot.on("message", (jsonMsg) => {
  try {
    console.log("[SERVER MESSAGE]", jsonMsg.toString());
  } catch (error) {
    console.log("[SERVER MESSAGE] Could not parse message");
  }
});

bot.on("chat", async (username, message) => {
  if (!username) return;

  // Ignore own messages
  if (
    bot &&
    username.toLowerCase() === bot.username.toLowerCase()
  ) {
    return;
  }

  console.log(`[Chat] ${username}: ${message}`);

  // Admin commands
  await handleAdminCommand(username, message);
});

  // ==========================================================
  // KICK
  // ==========================================================

  bot.on("kicked", (reason) => {
    console.log("[Bot] Kicked:", reason);

    sendDiscord(
      `🟠 Bot kicked: ${String(reason)}`
    );
  });

  // ==========================================================
  // ERROR
  // ==========================================================

  bot.on("error", (error) => {
    console.log("[Bot] Error:", error.message);
  });

  // ==========================================================
  // END / DISCONNECT
  // ==========================================================

  bot.on("end", (reason) => {
    console.log("[Bot] Disconnected:", reason);

    stopAntiAFK();
    stopMovement();

    sendDiscord(
      `🔴 Bot disconnected: ${String(reason)}`
    );

    scheduleReconnect();
  });
}

// ============================================================
// RECONNECT
// ============================================================

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectAttempt++;

  const delay = Math.min(
    5000 * reconnectAttempt,
    60000
  );

  console.log(
    `[Bot] Reconnecting in ${delay / 1000}s ` +
    `(attempt ${reconnectAttempt})`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBot();
  }, delay);
}

// ============================================================
// AUTO AUTH
// ============================================================

async function autoAuth() {
  if (!bot) return;

  const authConfig = config.autoAuth;

  if (!authConfig || !authConfig.enabled) {
    return;
  }

  const password =
    process.env.MINECRAFT_AUTH_PASSWORD ||
    authConfig.password;

  if (!password) {
    console.log("[Auth] No password configured.");
    return;
  }

  try {
    await sleep(1500);

    if (authConfig.command) {
      const command = authConfig.command
        .replace("{password}", password);

      bot.chat(command);

      console.log("[Auth] Authentication command sent.");
    }
  } catch (error) {
    console.log("[Auth] Error:", error.message);
  }
}

// ============================================================
// ANTI-AFK
// ============================================================

function startAntiAFK() {
  stopAntiAFK();

  if (!config.antiAfk?.enabled) {
    return;
  }

  const interval =
    Number(config.antiAfk.intervalSeconds || 30) * 1000;

  lookTimer = setInterval(() => {
    if (!bot || !bot.entity) return;

    try {
      const yaw =
        bot.entity.yaw +
        (Math.random() - 0.5) * 0.8;

      const pitch =
        (Math.random() - 0.5) * 0.3;

      bot.look(yaw, pitch, false);
    } catch (_) {}
  }, interval);

  console.log(
    `[AFK] Anti-AFK enabled every ${interval / 1000}s`
  );
}

function stopAntiAFK() {
  if (lookTimer) {
    clearInterval(lookTimer);
    lookTimer = null;
  }
}

// ============================================================
// SIMPLE MOVEMENT
// ============================================================

function startMovement() {
  stopMovement();

  if (!config.movement?.enabled) {
    return;
  }

  const interval =
    Number(config.movement.intervalSeconds || 60) * 1000;

  movementTimer = setInterval(() => {
    if (!bot || !bot.entity) return;

    try {
      performSmallMovement();
    } catch (error) {
      console.log(
        "[Movement] Error:",
        error.message
      );
    }
  }, interval);

  console.log(
    `[Movement] Enabled every ${interval / 1000}s`
  );
}

function stopMovement() {
  if (movementTimer) {
    clearInterval(movementTimer);
    movementTimer = null;
  }

  if (bot) {
    try {
      bot.clearControlStates();
    } catch (_) {}
  }
}

function performSmallMovement() {
  if (!bot) return;

  const actions = [
    "forward",
    "back",
    "left",
    "right"
  ];

  const action =
    actions[Math.floor(Math.random() * actions.length)];

  bot.setControlState(action, true);

  setTimeout(() => {
    if (!bot) return;

    try {
      bot.setControlState(action, false);
    } catch (_) {}
  }, 1000 + Math.random() * 1500);
}

// ============================================================
// INVENTORY HELPERS
// ============================================================

function inventorySummary() {
  if (!bot || !bot.inventory) {
    return "Inventory is unavailable.";
  }

  const items = bot.inventory.items();

  if (!items.length) {
    return "Inventory is empty.";
  }

  return items
    .map(item => `${item.name} x${item.count}`)
    .join(", ");
}

function findInventoryItem(itemName) {
  if (!bot || !bot.inventory) {
    return null;
  }

  const normalized = String(itemName)
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, "");

  return (
    bot.inventory
      .items()
      .find(item => item.name.toLowerCase() === normalized) ||
    null
  );
}

// ============================================================
// CREATIVE MODE
// ============================================================

async function setCreativeMode() {
  if (!bot) {
    throw new Error("Bot is not connected.");
  }

  console.log("[Creative] Requesting Creative mode.");

  try {
    bot.chat("/gamemode creative");
  } catch (error) {
    throw new Error(
      `Could not send gamemode command: ${error.message}`
    );
  }

  await sleep(1000);

  if (
    bot.game &&
    bot.game.gameMode &&
    bot.game.gameMode !== "creative"
  ) {
    console.log(
      `[Creative] Current detected mode: ${bot.game.gameMode}`
    );
  }

  return true;
}

// ============================================================
// CREATE CREATIVE ITEM
// ============================================================

async function createCreativeItem(itemName, amount) {
  if (!bot) {
    throw new Error("Bot is not connected.");
  }

  if (
    !bot.creative ||
    typeof bot.creative.setInventorySlot !== "function"
  ) {
    throw new Error(
      "Creative inventory API is unavailable."
    );
  }

  let normalized = String(itemName)
    .trim()
    .toLowerCase();

  normalized = normalized.replace(
    /^minecraft:/,
    ""
  );

  const itemType =
    bot.registry.itemsByName[normalized];

  if (!itemType) {
    throw new Error(
      `Unknown item: ${normalized}`
    );
  }

  let count = Number(amount || 1);

  if (!Number.isFinite(count)) {
    count = 1;
  }

  count = Math.max(
    1,
    Math.min(64, Math.floor(count))
  );

  const PrismarineItem =
    Item(bot.registry);

  const item = new PrismarineItem(
    itemType.id,
    count,
    0,
    null
  );

  // Slot 36 = first hotbar slot.
  await bot.creative.setInventorySlot(
    36,
    item
  );

  await sleep(500);

  return {
    name: normalized,
    count
  };
}

// ============================================================
// GIVE ITEM TO PLAYER
// ============================================================

async function deliverItem(
  targetUsername,
  itemName,
  amount
) {
  if (!bot || !bot.entity) {
    throw new Error("Bot is not connected.");
  }

  if (deliveryInProgress) {
    throw new Error(
      "Another item delivery is already in progress."
    );
  }

  deliveryInProgress = true;

  try {
    const targetPlayer =
      bot.players[targetUsername];

    if (!targetPlayer || !targetPlayer.entity) {
      throw new Error(
        `Player "${targetUsername}" is not currently visible to the bot.`
      );
    }

    // Create the requested item in the first hotbar slot.
    const created =
      await createCreativeItem(
        itemName,
        amount
      );

    console.log(
      `[Give] Created ${created.name} x${created.count}`
    );

    // Pathfinder movements.
    const movements =
      new Movements(bot);

    movements.canDig = false;

    bot.pathfinder.setMovements(movements);

    const target =
      targetPlayer.entity.position;

    console.log(
      `[Give] Walking to ${targetUsername}...`
    );

    await bot.pathfinder.goto(
      new goals.GoalNear(
        target.x,
        target.y,
        target.z,
        2
      )
    );

    await sleep(500);

    const updatedTarget =
      bot.players[targetUsername]?.entity;

    if (!updatedTarget) {
      throw new Error(
        `Player "${targetUsername}" disappeared.`
      );
    }

    const distance =
      bot.entity.position.distanceTo(
        updatedTarget.position
      );

    console.log(
      `[Give] Distance to ${targetUsername}: ${distance.toFixed(2)} blocks`
    );

    if (distance > 4.5) {
      throw new Error(
        "Could not get close enough to the player."
      );
    }

    // Toss the item from slot 36.
    const item =
      bot.inventory.slots[36];

    if (!item) {
      throw new Error(
        "The requested item was not found in the bot's inventory."
      );
    }

    await bot.tossStack(item);

    console.log(
      `[Give] Dropped ${created.name} x${created.count} for ${targetUsername}`
    );

    return created;
  } finally {
    deliveryInProgress = false;
  }
}

// ============================================================
// ADMIN COMMANDS
// ============================================================

async function handleAdminCommand(
  username,
  message
) {
  if (!message) return;

  const text = String(message).trim();

  if (!text.startsWith("!")) {
    return;
  }

  // Only configured admin can use commands.
  if (!isAdmin(username)) {
    tell(
      username,
      "You are not authorized to use bot commands."
    );
    return;
  }

  const parts = text.split(/\s+/);

  const command =
    parts[0].toLowerCase();

  // ==========================================================
  // !HELP
  // ==========================================================

  if (command === "!help") {
    tell(
      username,
      "!creative | !inv | !drop <item> [amount] | !give <player> <item> [amount]"
    );

    return;
  }

  // ==========================================================
  // !CREATIVE
  // ==========================================================

  if (command === "!creative") {
    try {
      await setCreativeMode();

      tell(
        username,
        "Creative mode command sent."
      );
    } catch (error) {
      tell(
        username,
        `Creative error: ${error.message}`
      );
    }

    return;
  }

  // ==========================================================
  // !INV
  // ==========================================================

  if (command === "!inv") {
    const summary =
      inventorySummary();

    tell(
      username,
      summary.slice(0, 250)
    );

    return;
  }

  // ==========================================================
  // !DROP
  // ==========================================================

  if (command === "!drop") {
    const itemName = parts[1];
    const amount = parts[2] || "1";

    if (!itemName) {
      tell(
        username,
        "Usage: !drop <item> [amount]"
      );

      return;
    }

    try {
      const item =
        findInventoryItem(itemName);

      if (!item) {
        tell(
          username,
          `I don't have ${itemName}.`
        );

        return;
      }

      let count =
        Number(amount);

      if (!Number.isFinite(count)) {
        count = 1;
      }

      count = Math.max(
        1,
        Math.min(item.count, Math.floor(count))
      );

      await bot.toss(
        item.type,
        item.metadata ?? null,
        count
      );

      tell(
        username,
        `Dropped ${item.name} x${count}.`
      );
    } catch (error) {
      tell(
        username,
        `Drop error: ${error.message}`
      );
    }

    return;
  }

  // ==========================================================
  // !GIVE
  // ==========================================================

  if (command === "!give") {
    const targetUsername = parts[1];
    const itemName = parts[2];
    const amount = parts[3] || "1";

    if (!targetUsername || !itemName) {
      tell(
        username,
        "Usage: !give <player> <item> [amount]"
      );

      return;
    }

    try {
      const result =
        await deliverItem(
          targetUsername,
          itemName,
          amount
        );

      tell(
        username,
        `Delivered ${result.name} x${result.count} to ${targetUsername}.`
      );
    } catch (error) {
      console.log(
        "[Give] Error:",
        error.message
      );

      tell(
        username,
        `Give error: ${error.message}`
      );
    }

    return;
  }

  // ==========================================================
  // UNKNOWN COMMAND
  // ==========================================================

  tell(
    username,
    "Unknown command. Use !help"
  );
}

// ============================================================
// UTILITY
// ============================================================

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

// ============================================================
// GLOBAL ERROR PROTECTION
// ============================================================

process.on("uncaughtException", error => {
  console.error(
    "[Process] Uncaught exception:",
    error
  );
});

process.on("unhandledRejection", error => {
  console.error(
    "[Process] Unhandled rejection:",
    error
  );
});

// ============================================================
// START BOT
// ============================================================

console.log("==============================================");
console.log("       ATERNOS AFK BOT STARTING");
console.log("==============================================");
console.log(`Username: ${BOT_USERNAME}`);
console.log(`Server: ${SERVER_HOST}:${SERVER_PORT}`);
console.log("Admin commands: ENABLED");
console.log("==============================================");

connectBot();
