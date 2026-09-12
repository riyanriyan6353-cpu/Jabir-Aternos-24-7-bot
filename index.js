const mineflayer = require('mineflayer');
const express = require('express');
const https = require('https');
const http = require('http');

const config = require('./settings.json');

let bot = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let intentionalStop = false;
let startTime = Date.now();
let antiAfkTimer = null;
let movementTimer = null;
let lookTimer = null;
let jumpTimer = null;
let deliveryInProgress = false;

const state = {
  connected: false,
  lastActivity: Date.now(),
  lastError: null
};

const app = express();
const PORT = Number(process.env.PORT || 8080);

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function envOr(pathValue, envName, fallback = '') {
  return process.env[envName] !== undefined ? process.env[envName] : pathValue ?? fallback;
}

function serverConfig() {
  return {
    host: envOr(config.server?.ip, 'MC_HOST', ''),
    port: Number(envOr(config.server?.port, 'MC_PORT', 25565)),
    version: envOr(config.server?.version, 'MC_VERSION', false)
  };
}

function accountConfig() {
  return {
    username: envOr(config['bot-account']?.username, 'BOT_USERNAME', ''),
    password: envOr(config['bot-account']?.password, 'BOT_PASSWORD', ''),
    auth: envOr(config['bot-account']?.type, 'BOT_AUTH', 'offline')
  };
}

function adminUsername() {
  return envOr(config.admin?.username, 'ADMIN_USERNAME', '');
}

function normalizeUsername(username) {
  return String(username || '').trim().replace(/^\./, '').toLowerCase();
}

function isAdmin(username) {
  const configured = normalizeUsername(adminUsername());
  return configured && normalizeUsername(username) === configured;
}

function clearTimers() {
  for (const timer of [antiAfkTimer, movementTimer, lookTimer, jumpTimer]) {
    if (timer) clearInterval(timer);
  }
  antiAfkTimer = null;
  movementTimer = null;
  lookTimer = null;
  jumpTimer = null;
}

function scheduleReconnect() {
  if (intentionalStop || reconnectTimer) return;

  reconnectAttempts += 1;
  const base = Math.max(3000, Number(config.utils?.['auto-reconnect-delay'] || 5000));
  const max = Math.max(base, Number(config.utils?.['max-reconnect-delay'] || 30000));
  const delay = Math.min(base + (reconnectAttempts - 1) * 1000, max);

  log(`[Reconnect] Reconnecting in ${Math.ceil(delay / 1000)}s (attempt ${reconnectAttempts})`);

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
    const payload = JSON.stringify({ content: String(message) });
    const transport = parsed.protocol === 'https:' ? https : http;

    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => res.resume());

    req.on('error', err => log(`[Discord] ${err.message}`));
    req.write(payload);
    req.end();
  } catch (err) {
    log(`[Discord] Invalid webhook URL: ${err.message}`);
  }
}

function privateReply(username, message) {
  if (!bot) return;

  const raw = String(username || '').trim();
  const candidates = [];
  const add = value => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  // Geyser/Floodgate often displays Bedrock names with a leading dot.
  if (raw.startsWith('.')) {
    add(raw);
    add(raw.slice(1));
  } else {
    add(`.${raw}`);
    add(raw);
  }

  for (const recipient of candidates) {
    try {
      bot.chat(`/msg ${recipient} ${String(message).slice(0, 240)}`);
      return;
    } catch (_) {}
  }
}

function inventorySummary() {
  if (!bot) return [];
  return bot.inventory.items().map(item => ({
    name: item.name,
    displayName: item.displayName || item.name,
    count: item.count,
    slot: item.slot
  }));
}

function findInventoryItem(name) {
  if (!bot) return null;
  const wanted = String(name).toLowerCase().replace(/^minecraft:/, '');
  return bot.inventory.items().find(item =>
    item.name.toLowerCase() === wanted ||
    String(item.displayName || '').toLowerCase() === wanted
  ) || null;
}

function resolveGeyserTarget(name) {
  const raw = String(name || '').trim();
  if (!raw) return null;

  const candidates = raw.startsWith('.')
    ? [raw, raw.slice(1)]
    : [raw, `.${raw}`];

  // Exact/case-insensitive lookup in Mineflayer's player table.
  for (const key of Object.keys(bot?.players || {})) {
    if (candidates.some(candidate => key.toLowerCase() === candidate.toLowerCase())) {
      return key;
    }
  }

  return candidates[0];
}

function validateItemName(itemName) {
  const normalized = String(itemName || '').toLowerCase().replace(/^minecraft:/, '');
  if (!/^[a-z0-9_.-]+$/.test(normalized)) return null;
  if (!bot?.registry?.itemsByName?.[normalized]) return null;
  return normalized;
}

async function setCreativeMode() {
  if (!bot || !state.connected) throw new Error('Bot is not connected.');
  bot.chat('/gamemode creative');
  await sleep(1000);
}

/*
 * RELIABLE ITEM DELIVERY
 *
 * We deliberately do NOT use bot.creative.setInventorySlot() for !give.
 * That API waits for a server slot-update packet; with this Paper + Geyser
 * setup that packet sometimes does not arrive, producing the old:
 * "Event updateSlot:36 did not fire within timeout" error.
 *
 * The bot is already OP, so the server itself can execute /give directly.
 * This avoids creative-slot synchronization, pathfinding and entity tracking.
 */
async function giveItemDirect(targetInput, itemInput, amountInput) {
  if (!bot || !state.connected) throw new Error('Bot is not connected.');

  const target = resolveGeyserTarget(targetInput);
  const item = validateItemName(itemInput);
  const amount = Number(amountInput || 1);

  if (!target) throw new Error('Target player name is missing.');
  if (!item) throw new Error(`Unknown or invalid item: ${itemInput}`);
  if (!Number.isInteger(amount) || amount < 1 || amount > 64) {
    throw new Error('Amount must be a whole number from 1 to 64.');
  }

  // Try the displayed Geyser form first. If the supplied target already has
  // the dot, this sends it unchanged.
  const command = `/give ${target} minecraft:${item} ${amount}`;
  log(`[Give] ${command}`);
  bot.chat(command);
  state.lastActivity = Date.now();
  await sleep(1200);

  return { target, item, amount };
}

async function dropOwnInventoryItem(itemInput, amountInput) {
  if (!bot || !state.connected) throw new Error('Bot is not connected.');

  const item = findInventoryItem(itemInput);
  if (!item) throw new Error(`Bot does not have ${itemInput}.`);

  const requested = Number(amountInput || item.count);
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error('Amount must be a positive whole number.');
  }

  const amount = Math.min(requested, item.count);
  await bot.toss(item.type, item.metadata ?? null, amount);
  state.lastActivity = Date.now();
  return { item: item.name, amount };
}

async function enableCreative() {
  if (!bot || !state.connected) throw new Error('Bot is not connected.');
  bot.chat('/gamemode creative');
  await sleep(1000);
  return true;
}

function startAntiAfk() {
  if (!config.utils?.['anti-afk']?.enabled) return;

  antiAfkTimer = setInterval(() => {
    if (!bot || !state.connected || deliveryInProgress) return;
    try {
      bot.setControlState('jump', true);
      setTimeout(() => {
        if (bot) {
          try { bot.setControlState('jump', false); } catch (_) {}
        }
      }, 250);

      if (config.utils['anti-afk'].sneak) {
        bot.setControlState('sneak', true);
        setTimeout(() => {
          if (bot) {
            try { bot.setControlState('sneak', false); } catch (_) {}
          }
        }, 400);
      }
      state.lastActivity = Date.now();
    } catch (err) {
      log(`[Anti-AFK] ${err.message}`);
    }
  }, 30000);
}

function startMovement() {
  if (!config.movement?.enabled) return;

  const circle = config.movement['circle-walk'];
  if (circle?.enabled) {
    let direction = 0;
    const interval = Math.max(1500, Number(circle.speed || 3000));

    movementTimer = setInterval(() => {
      if (!bot || !state.connected || deliveryInProgress) return;
      try {
        const directions = ['forward', 'left', 'back', 'right'];
        bot.clearControlStates();
        bot.setControlState(directions[direction++ % directions.length], true);
        setTimeout(() => {
          if (bot) {
            try { bot.clearControlStates(); } catch (_) {}
          }
        }, Math.min(interval - 200, 2500));
        state.lastActivity = Date.now();
      } catch (err) {
        log(`[Movement] ${err.message}`);
      }
    }, interval);
  }

  const look = config.movement['look-around'];
  if (look?.enabled) {
    lookTimer = setInterval(() => {
      if (!bot || !state.connected || deliveryInProgress) return;
      try {
        const yaw = Math.random() * Math.PI * 2 - Math.PI;
        const pitch = (Math.random() - 0.5) * 0.5;
        bot.look(yaw, pitch, true).catch(() => {});
        state.lastActivity = Date.now();
      } catch (_) {}
    }, Math.max(3000, Number(look.interval || 5000)));
  }

  const jump = config.movement['random-jump'];
  if (jump?.enabled) {
    jumpTimer = setInterval(() => {
      if (!bot || !state.connected || deliveryInProgress) return;
      try {
        bot.setControlState('jump', true);
        setTimeout(() => {
          if (bot) {
            try { bot.setControlState('jump', false); } catch (_) {}
          }
        }, 250);
      } catch (_) {}
    }, Math.max(5000, Number(jump.interval || 10000)));
  }
}

function setupAutoAuth() {
  if (!config.utils?.['auto-auth']?.enabled || !bot) return;

  let handled = false;
  const password = envOr(config.utils['auto-auth'].password, 'AUTH_PASSWORD', '');
  if (!password || password === 'CHANGE_THIS_PASSWORD') return;

  const listener = message => {
    if (handled || !bot || !state.connected) return;
    const text = String(message).toLowerCase();

    try {
      if (text.includes('register') || text.includes('/register')) {
        handled = true;
        bot.chat(`/register ${password} ${password}`);
      } else if (text.includes('login') || text.includes('/login')) {
        handled = true;
        bot.chat(`/login ${password}`);
      }
    } catch (err) {
      log(`[Auth] ${err.message}`);
    }
  };

  bot.on('messagestr', listener);
}

function handleAdminCommand(username, message) {
  if (!isAdmin(username)) return false;

  const text = String(message || '').trim();
  if (!text.startsWith('!')) return false;

  const parts = text.slice(1).trim().split(/\s+/);
  const command = String(parts.shift() || '').toLowerCase();

  if (command === 'help') {
    privateReply(username,
      '!help | !inv | !creative | !give <player> <item> [amount] | !drop <item> [amount]'
    );
    return true;
  }

  if (command === 'creative') {
    enableCreative()
      .then(() => privateReply(username, 'Bot Creative mode enabled.'))
      .catch(err => privateReply(username, `Creative failed: ${err.message}`));
    return true;
  }

  if (command === 'inv') {
    const items = inventorySummary();
    if (!items.length) {
      privateReply(username, 'Bot inventory is empty.');
      return true;
    }

    let line = '';
    for (const item of items) {
      const part = `${item.displayName} x${item.count}`;
      if ((line + (line ? ', ' : '') + part).length > 190) {
        privateReply(username, line);
        line = part;
      } else {
        line += (line ? ', ' : '') + part;
      }
    }
    if (line) privateReply(username, line);
    return true;
  }

  if (command === 'give') {
    const target = parts[0];
    const item = parts[1];
    const amount = parts[2] || '1';

    if (!target || !item) {
      privateReply(username, 'Usage: !give <player> <item> [amount]');
      return true;
    }

    if (deliveryInProgress) {
      privateReply(username, 'Another item delivery is already running.');
      return true;
    }

    deliveryInProgress = true;
    giveItemDirect(target, item, amount)
      .then(result => {
        privateReply(username,
          `Give command sent: ${result.item} x${result.amount} -> ${result.target}`
        );
      })
      .catch(err => {
        privateReply(username, `Give failed: ${err.message}`);
      })
      .finally(() => {
        deliveryInProgress = false;
      });

    return true;
  }

  if (command === 'drop') {
    const item = parts[0];
    const amount = parts[1] || '';

    if (!item) {
      privateReply(username, 'Usage: !drop <item> [amount]');
      return true;
    }

    dropOwnInventoryItem(item, amount)
      .then(result => privateReply(username, `Dropped ${result.item} x${result.amount} at the bot.`))
      .catch(err => privateReply(username, `Drop failed: ${err.message}`));

    return true;
  }

  privateReply(username, `Unknown command: ${command}. Use !help.`);
  return true;
}

function createBot() {
  if (intentionalStop || bot) return;

  const server = serverConfig();
  const account = accountConfig();

  if (!server.host || !account.username) {
    log('[Bot] Missing MC_HOST/server.ip or BOT_USERNAME/bot-account.username.');
    scheduleReconnect();
    return;
  }

  log(`Connecting to ${server.host}:${server.port} as ${account.username}`);

  try {
    bot = mineflayer.createBot({
      username: account.username,
      password: account.password || undefined,
      auth: account.auth || 'offline',
      host: server.host,
      port: server.port,
      version: server.version || false,
      hideErrors: false,
      checkTimeoutInterval: 120000
    });

    bot.once('spawn', () => {
      state.connected = true;
      state.lastActivity = Date.now();
      state.lastError = null;
      reconnectAttempts = 0;
      log('[Bot] Connected and spawned.');
      discordWebhook(`[+] Bot connected to ${server.host}:${server.port}`);

      setupAutoAuth();
      startAntiAfk();
      startMovement();
    });

    // PRIVATE ADMIN COMMANDS ONLY.
    bot.on('whisper', (username, message) => {
      state.lastActivity = Date.now();
      if (username === bot.username) return;

      const handled = handleAdminCommand(username, message);
      if (handled && config.utils?.['chat-log']) {
        log(`[Private Admin] <${username}> ${message}`);
      }
    });

    // Public chat never executes admin commands.
    bot.on('chat', (username, message) => {
      state.lastActivity = Date.now();
      if (config.utils?.['chat-log']) {
        log(`[Chat] ${username}: ${message}`);
      }
    });

    bot.on('messagestr', message => {
      if (config.utils?.['chat-log']) log(`[Server] ${message}`);
    });

    bot.on('kicked', reason => {
      log(`[Bot] Kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
    });

    bot.on('error', err => {
      state.lastError = err?.message || String(err);
      log(`[Bot] Error: ${state.lastError}`);
    });

    bot.on('end', reason => {
      state.connected = false;
      clearTimers();
      deliveryInProgress = false;

      const why = reason || 'socket closed';
      log(`[Bot] Disconnected: ${why}`);
      discordWebhook(`[-] Bot disconnected: ${why}`);

      bot = null;
      if (!intentionalStop && config.utils?.['auto-reconnect'] !== false) {
        scheduleReconnect();
      }
    });
  } catch (err) {
    state.lastError = err?.message || String(err);
    log(`[Bot] Creation failed: ${state.lastError}`);
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

  clearTimers();
  deliveryInProgress = false;

  if (bot) {
    try { bot.clearControlStates(); } catch (_) {}
    try { bot.quit('Stopped'); } catch (_) {}
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

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

app.get('/', (req, res) => {
  const server = serverConfig();
  res.send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AFK Bot</title>
<style>body{font-family:Arial;background:#0f172a;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}.card{width:min(90%,520px);background:#1e293b;padding:28px;border-radius:18px}h1{color:#5eead4}.row{padding:12px;margin:10px 0;background:#0f172a;border-radius:10px}code{background:#0f172a;padding:3px 6px;border-radius:5px}</style></head>
<body><div class="card"><h1>AFK Bot</h1>
<div class="row">Status: <b id="status">Loading...</b></div>
<div class="row">Uptime: <b id="uptime">0s</b></div>
<div class="row">Server: <b>${escapeHtml(server.host)}:${escapeHtml(server.port)}</b></div>
<div class="row">Last error: <b id="error">None</b></div>
<div class="row">Commands: <code>!help</code> <code>!inv</code> <code>!creative</code> <code>!give</code> <code>!drop</code></div>
</div><script>async function u(){try{const d=await (await fetch('/health')).json();status.textContent=d.status;uptime.textContent=d.uptime+'s';error.textContent=d.lastError||'None'}catch(e){}}setInterval(u,1000);u();</script></body></html>`);
});

app.get('/health', (req, res) => {
  res.json({
    status: state.connected ? 'connected' : 'disconnected',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastActivity: state.lastActivity,
    reconnectAttempts,
    username: bot?.username || null,
    position: bot?.entity?.position || null,
    lastError: state.lastError,
    deliveryInProgress
  });
});

app.get('/ping', (req, res) => res.send('pong'));

app.post('/start', (req, res) => {
  intentionalStop = false;
  createBot();
  res.json({ ok: true });
});

app.post('/stop', (req, res) => {
  stopBot();
  res.json({ ok: true });
});

app.post('/restart', (req, res) => {
  restartBot();
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  log(`Web server listening on port ${PORT}`);
  createBot();
});

process.on('SIGTERM', () => {
  log('SIGTERM received.');
  stopBot();
  process.exit(0);
});

process.on('SIGINT', () => {
  log('SIGINT received.');
  stopBot();
  process.exit(0);
});
