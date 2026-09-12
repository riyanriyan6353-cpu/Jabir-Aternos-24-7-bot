const mineflayer = require("mineflayer");
const express = require("express");
const http = require("http");
const https = require("https");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");

const config = require("./settings.json");

let bot = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let intentionalStop = false;
let startTime = Date.now();
let activityTimer = null;
let lookTimer = null;
let chatTimer = null;
let positionTimer = null;
let deliveryInProgress = false;

const app = express();
const PORT = Number(process.env.PORT || 5000);

const state = {
  connected: false,
  lastActivity: Date.now(),
  lastError: null
};

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function clearBotTimers() {
  for (const timer of [activityTimer, lookTimer, chatTimer, positionTimer]) {
    if (timer) clearInterval(timer);
  }
  activityTimer = null;
  lookTimer = null;
  chatTimer = null;
  positionTimer = null;
}

function scheduleReconnect() {
  if (intentionalStop || reconnectTimer) return;

  reconnectAttempts += 1;

  const base = Number(config.utils?.["auto-reconnect-delay"] || 5000);
  const max = Number(config.utils?.["max-reconnect-delay"] || 30000);
  const delay = Math.min(base + (reconnectAttempts - 1) * 1000, max);

  log(`Reconnecting in ${Math.ceil(delay / 1000)}s (attempt ${reconnectAttempts})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, delay);
}

function discordWebhook(message) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  try {
    const parsed = new URL(url);
    const payload = JSON.stringify({ content: message });

    const request = (parsed.protocol === "https:" ? https : http).request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (res) => res.resume()
    );

    request.on("error", (err) => log(`[Discord] ${err.message}`));
    request.write(payload);
    request.end();
  } catch (err) {
    log(`[Discord] Invalid webhook URL: ${err.message}`);
  }
}

function sendChatMessages() {
  if (!bot || !state.connected) return;

  const messages = config.utils?.["chat-messages"]?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;

  let index = 0;

  const sendOne = () => {
    if (!bot || !state.connected) return;
    const message = messages[index % messages.length];
    index += 1;

    try {
      bot.chat(String(message));
      state.lastActivity = Date.now();
    } catch (err) {
      log(`[Chat] ${err.message}`);
    }
  };

  if (config.utils?.["chat-messages"]?.enabled) sendOne();

  if (config.utils?.["chat-messages"]?.repeat) {
    const delay = Math.max(
      10000,
      Number(config.utils?.["chat-messages"]?.["repeat-delay"] || 60000)
    );
    chatTimer = setInterval(sendOne, delay);
  }
}

function startAntiAfk() {
  if (!config.utils?.["anti-afk"]?.enabled) return;

  activityTimer = setInterval(() => {
    if (!bot || !state.connected) return;

    try {
      bot.setControlState("jump", true);

      setTimeout(() => {
        if (bot) {
          try { bot.setControlState("jump", false); } catch (_) {}
        }
      }, 250);

      if (config.utils["anti-afk"].sneak) {
        bot.setControlState("sneak", true);
        setTimeout(() => {
          if (bot) {
            try { bot.setControlState("sneak", false); } catch (_) {}
          }
        }, 500);
      }

      state.lastActivity = Date.now();
    } catch (err) {
      log(`[Anti-AFK] ${err.message}`);
    }
  }, 30000);
}

function startMovement() {
  if (!config.movement?.enabled) return;

  const circle = config.movement["circle-walk"];
  if (circle?.enabled) {
    let direction = 0;

    positionTimer = setInterval(() => {
      if (!bot || !state.connected || deliveryInProgress) return;

      try {
        const directions = ["forward", "left", "back", "right"];
        const current = directions[direction % directions.length];
        direction += 1;

        bot.clearControlStates();
        bot.setControlState(current, true);

        setTimeout(() => {
          if (bot) {
            try { bot.clearControlStates(); } catch (_) {}
          }
        }, Math.max(500, Math.min(Number(circle.speed || 3000), 5000)));

        state.lastActivity = Date.now();
      } catch (err) {
        log(`[Movement] ${err.message}`);
      }
    }, Math.max(1000, Number(circle.speed || 3000)));
  }

  const look = config.movement["look-around"];
  if (look?.enabled) {
    lookTimer = setInterval(() => {
      if (!bot || !state.connected || deliveryInProgress) return;

      try {
        const yaw = Math.random() * Math.PI * 2 - Math.PI;
        const pitch = (Math.random() - 0.5) * 0.6;
        bot.look(yaw, pitch, true).catch(() => {});
        state.lastActivity = Date.now();
      } catch (err) {
        log(`[Look] ${err.message}`);
      }
    }, Math.max(2000, Number(look.interval || 5000)));
  }

  const jump = config.movement["random-jump"];
  if (jump?.enabled && !activityTimer) {
    activityTimer = setInterval(() => {
      if (!bot || !state.connected || deliveryInProgress) return;
      try {
        bot.setControlState("jump", true);
        setTimeout(() => {
          if (bot) {
            try { bot.setControlState("jump", false); } catch (_) {}
          }
        }, 250);
        state.lastActivity = Date.now();
      } catch (_) {}
    }, Math.max(3000, Number(jump.interval || 10000)));
  }
}

function setupAuth() {
  if (!config.utils?.["auto-auth"]?.enabled) return;

  let handled = false;

  const onMessage = (message) => {
    if (handled || !bot || !state.connected) return;

    const text = String(message).toLowerCase();
    const password = config.utils["auto-auth"].password;

    try {
      if (text.includes("register") || text.includes("/register")) {
        handled = true;
        bot.chat(`/register ${password} ${password}`);
        log("[Auth] Register command sent.");
      } else if (text.includes("login") || text.includes("/login")) {
        handled = true;
        bot.chat(`/login ${password}`);
        log("[Auth] Login command sent.");
      }
    } catch (err) {
      log(`[Auth] ${err.message}`);
    }
  };

  bot.on("messagestr", onMessage);
}

function normalizeUsername(username) {
  return String(username || "")
    .trim()
    .replace(/^\./, "")
    .toLowerCase();
}

function getAdminUsername() {
  return normalizeUsername(config.admin?.username);
}

function isAdmin(username) {
  const admin = getAdminUsername();
  return Boolean(admin) && normalizeUsername(username) === admin;
}

function tell(username, message) {
  if (!bot) return;
  const safe = String(message);
  try {
    // /msg is a private Minecraft message. It is not public chat.
    bot.chat(`/msg ${username} ${safe}`);
  } catch (_) {
    try { bot.whisper(username, safe); } catch (_) {}
  }
}

function inventorySummary() {
  if (!bot) return [];
  return bot.inventory.items().map((item) => ({
    name: item.name,
    displayName: item.displayName || item.name,
    count: item.count,
    slot: item.slot
  }));
}

function findInventoryItem(name) {
  if (!bot) return null;
  const normalized = String(name).toLowerCase().replace(/^minecraft:/, "");
  return bot.inventory.items().find((item) =>
    item.name.toLowerCase() === normalized ||
    String(item.displayName || "").toLowerCase() === normalized
  ) || null;
}

async function setCreativeMode() {
  if (!bot || !state.connected) throw new Error("Bot is not connected.");

  // Mineflayer's creative inventory API assumes the server has already
  // put the bot in Creative mode. The command below works when the bot
  // has the required server permission (OP/console/plugin permission).
  bot.chat("/gamemode creative");
  await new Promise((resolve) => setTimeout(resolve, 800));
}

async function createCreativeItem(itemName, amount) {
  if (!bot || !state.connected) throw new Error("Bot is not connected.");
  if (!bot.creative || typeof bot.creative.setInventorySlot !== "function") {
    throw new Error("Creative inventory API is unavailable for this Minecraft version.");
  }

  const normalized = String(itemName).toLowerCase().replace(/^minecraft:/, "");
  const itemType = bot.registry.itemsByName[normalized];
  if (!itemType) throw new Error(`Unknown item: ${normalized}`);

  const count = Math.max(1, Math.min(64, Number(amount) || 1));
  const prismarineItem = bot.registry.itemsByName[normalized];

  // The registry entry is enough for the command-based fallback below,
  // but creative.setInventorySlot requires an Item instance. Mineflayer
  // exposes a convenient factory through bot.registry.
  const Item = require("prismarine-item")(bot.registry);
  const item = new Item(itemType.id, count, 0, null);

  // 36 is the first hotbar slot in Mineflayer's inventory coordinates.
  await bot.creative.setInventorySlot(36, item);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { name: normalized, count, type: prismarineItem.id };
}

async function deliverItem(targetUsername, itemName, amount) {
  if (deliveryInProgress) throw new Error("Another delivery is already running.");
  if (!bot || !state.connected) throw new Error("Bot is not connected.");

  const target = bot.players[targetUsername]?.entity;
  if (!target) throw new Error(`Player '${targetUsername}' is not currently visible/online to the bot.`);

  deliveryInProgress = true;
  try {
    bot.clearControlStates();

    await setCreativeMode();
    const created = await createCreativeItem(itemName, amount);

    // Pathfind close to the target, then drop the created stack.
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1to1towers = false;
    movements.allowFreeMotion = false;
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2));

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const current = bot.players[targetUsername]?.entity;
      if (!current) throw new Error(`Player '${targetUsername}' moved out of tracking range.`);

      const distance = bot.entity.position.distanceTo(current.position);
      if (distance <= 3.2) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    bot.pathfinder.setGoal(null);
    bot.clearControlStates();

    const current = bot.players[targetUsername]?.entity;
    if (!current || bot.entity.position.distanceTo(current.position) > 4.5) {
      throw new Error("Could not get close enough to the target player.");
    }

    const slotItem = bot.inventory.slots[36];
    if (!slotItem) throw new Error("Creative item was not placed in the hotbar.");

    await bot.tossStack(slotItem);
    state.lastActivity = Date.now();

    return created;
  } finally {
    try { bot.pathfinder.setGoal(null); } catch (_) {}
    try { bot.clearControlStates(); } catch (_) {}
    deliveryInProgress = false;
  }
}

function handleAdminCommand(username, message) {
  if (!isAdmin(username)) return false;

  const text = String(message || "").trim();
  if (!text.startsWith("!")) return false;

  const parts = text.slice(1).trim().split(/\s+/);
  const command = (parts.shift() || "").toLowerCase();

  if (command === "help") {
    tell(username, "!creative | !inv | !drop <item> [amount] | !give <player> <item> [amount]");
    return true;
  }

  if (command === "creative") {
    setCreativeMode()
      .then(() => tell(username, "Creative command sent. The bot must have permission to change gamemode."))
      .catch((err) => tell(username, `Creative failed: ${err.message}`));
    return true;
  }

  if (command === "inv") {
    const items = inventorySummary();
    if (!items.length) {
      tell(username, "Bot inventory is empty.");
      return true;
    }

    const chunks = [];
    let current = "";
    for (const item of items) {
      const part = `${item.displayName} x${item.count}`;
      if ((current + ", " + part).length > 180) {
        chunks.push(current);
        current = part;
      } else {
        current = current ? `${current}, ${part}` : part;
      }
    }
    if (current) chunks.push(current);
    chunks.slice(0, 4).forEach((chunk) => tell(username, chunk));
    return true;
  }

  if (command === "drop") {
    const itemName = parts[0];
    const amount = Math.max(1, Number(parts[1] || 64));
    if (!itemName) {
      tell(username, "Usage: !drop <item> [amount]");
      return true;
    }

    const item = findInventoryItem(itemName);
    if (!item) {
      tell(username, `I don't have ${itemName}.`);
      return true;
    }

    const count = Math.min(amount, item.count);
    bot.toss(item.type, item.metadata, count)
      .then(() => tell(username, `Dropped ${count} ${item.name}.`))
      .catch((err) => tell(username, `Drop failed: ${err.message}`));
    return true;
  }

  if (command === "give") {
    const target = parts[0];
    const itemName = parts[1];
    const amount = Math.max(1, Math.min(64, Number(parts[2] || 1)));

    if (!target || !itemName) {
      tell(username, "Usage: !give <player> <item> [amount]");
      return true;
    }

    deliverItem(target, itemName, amount)
      .then((created) => tell(username, `Delivered ${created.count} ${created.name} to ${target}.`))
      .catch((err) => tell(username, `Give failed: ${err.message}`));
    return true;
  }

  return false;
}

function createBot() {
  if (intentionalStop || bot) return;

  const account = config["bot-account"] || {};
  const server = config.server || {};

  log(`Connecting to ${server.ip}:${server.port} as ${account.username}`);

  try {
    bot = mineflayer.createBot({
      username: account.username,
      password: account.password || undefined,
      auth: account.type || "offline",
      host: server.ip,
      port: Number(server.port),
      version: server.version || false,
      hideErrors: false,
      checkTimeoutInterval: 120000
    });

    bot.loadPlugin(pathfinder);

    bot.once("spawn", () => {
      state.connected = true;
      state.lastActivity = Date.now();
      reconnectAttempts = 0;

      log("[Bot] Connected and spawned.");
      discordWebhook(`[+] Connected to ${server.ip}:${server.port}`);

      setupAuth();
      startAntiAfk();
      startMovement();
      sendChatMessages();
    });

    // ADMIN COMMANDS ARE PRIVATE-ONLY.
    // Public chat messages such as !inv are intentionally ignored.
    bot.on("whisper", (username, message) => {
      state.lastActivity = Date.now();

      if (username !== bot.username) {
        const handled = handleAdminCommand(username, message);
        if (handled && config.utils?.["chat-log"]) {
          log(`[Private Admin] <${username}> ${message}`);
        }
      }
    });

    // Keep public chat logging, but NEVER execute admin commands from it.
    bot.on("chat", (username, message) => {
      state.lastActivity = Date.now();

      if (
        config.chat?.respond &&
        username !== bot.username &&
        typeof message === "string" &&
        message.toLowerCase().includes(bot.username.toLowerCase())
      ) {
        bot.chat(`Hello ${username}!`);
      }

      if (config.utils?.["chat-log"]) {
        log(`[Chat] <${username}> ${message}`);
      }
    });

    bot.on("messagestr", (message) => {
      if (config.utils?.["chat-log"]) log(`[Server] ${message}`);
    });

    bot.on("kicked", (reason) => {
      log(`[Bot] Kicked: ${typeof reason === "string" ? reason : JSON.stringify(reason)}`);
    });

    bot.on("error", (err) => {
      state.lastError = err.message;
      log(`[Bot] Error: ${err.message}`);
    });

    bot.on("end", (reason) => {
      state.connected = false;
      clearBotTimers();
      deliveryInProgress = false;

      log(`[Bot] Disconnected: ${reason || "unknown reason"}`);
      discordWebhook(`[-] Disconnected: ${reason || "unknown reason"}`);

      bot = null;

      if (config.utils?.["auto-reconnect"] && !intentionalStop) scheduleReconnect();
    });
  } catch (err) {
    state.lastError = err.message;
    log(`[Bot] Creation failed: ${err.message}`);
    bot = null;
    scheduleReconnect();
  }
}

function stopBot() {
  intentionalStop = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  clearBotTimers();
  deliveryInProgress = false;

  if (bot) {
    try {
      bot.clearControlStates();
      bot.pathfinder?.setGoal(null);
      bot.quit("Stopped");
    } catch (_) {}
    bot = null;
  }

  state.connected = false;
}

function restartBot() {
  stopBot();
  intentionalStop = false;
  reconnectAttempts = 0;
  setTimeout(createBot, 1000);
}

app.get("/", (req, res) => {
  res.send(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(config.name || "AFK Bot")}</title>
<style>
body{font-family:Arial,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.card{width:min(90%,520px);background:#1e293b;padding:28px;border-radius:18px;box-shadow:0 10px 40px #0005}
h1{margin-top:0;color:#5eead4}
.row{padding:12px;margin:10px 0;background:#0f172a;border-radius:10px}
button{padding:10px 14px;margin:5px;border:0;border-radius:8px;cursor:pointer}
code{background:#0f172a;padding:3px 6px;border-radius:5px}
</style>
</head>
<body>
<div class="card">
<h1>${escapeHtml(config.name || "AFK Bot")}</h1>
<div class="row">Status: <b id="status">Loading...</b></div>
<div class="row">Uptime: <b id="uptime">0s</b></div>
<div class="row">Server: <b>${escapeHtml(String(config.server?.ip || ""))}:${escapeHtml(String(config.server?.port || ""))}</b></div>
<div class="row">Last activity: <b id="activity">-</b></div>
<div class="row">Admin commands: <code>!help</code> <code>!inv</code> <code>!creative</code> <code>!drop</code> <code>!give</code></div>
<button onclick="fetch('/start',{method:'POST'})">Start</button>
<button onclick="fetch('/stop',{method:'POST'})">Stop</button>
<button onclick="fetch('/restart',{method:'POST'})">Reconnect</button>
</div>
<script>
async function update(){
 try{
  const r=await fetch('/health');
  const d=await r.json();
  document.getElementById('status').textContent=d.status;
  document.getElementById('uptime').textContent=d.uptime+'s';
  document.getElementById('activity').textContent=new Date(d.lastActivity).toLocaleTimeString();
 }catch(e){}
}
setInterval(update,1000); update();
</script>
</body>
</html>`);
});

app.get("/health", (req, res) => {
  res.json({
    status: state.connected ? "connected" : "disconnected",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastActivity: state.lastActivity,
    reconnectAttempts,
    username: bot?.username || null,
    position: bot?.entity?.position || null,
    lastError: state.lastError,
    deliveryInProgress
  });
});

app.get("/ping", (req, res) => res.send("pong"));

app.post("/start", (req, res) => {
  intentionalStop = false;
  createBot();
  res.json({ ok: true });
});

app.post("/stop", (req, res) => {
  stopBot();
  res.json({ ok: true });
});

app.post("/restart", (req, res) => {
  restartBot();
  res.json({ ok: true });
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

app.listen(PORT, "0.0.0.0", () => {
  log(`Web server listening on port ${PORT}`);
  createBot();
});

process.on("SIGTERM", () => {
  log("SIGTERM received.");
  stopBot();
  process.exit(0);
});

process.on("SIGINT", (
