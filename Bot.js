const https = require("https");

const TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

console.log("Bot démarré, token:", TOKEN ? TOKEN.substring(0, 15) + "..." : "MANQUANT");

function telegramRequest(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TOKEN}/${method}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function sendMessage(chatId, text) {
  console.log("Envoi message à", chatId, ":", text.substring(0, 50));
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown"
  });
}

function sendMenu(chatId) {
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text: "🤖 *AgentOS* — Choisissez votre agent :",
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🗓️ Agent Temps", callback_data: "agent_temps" }],
        [{ text: "📣 Agent Social", callback_data: "agent_social" }],
        [{ text: "📦 Agent Stock", callback_data: "agent_stock" }]
      ]
    }
  });
}

const AGENTS = {
  temps: {
    emoji: "🗓️",
    name: "Agent Temps",
    system: "Tu es un assistant en gestion du temps. Aide l'utilisateur à planifier ses journées, gérer son agenda et optimiser son emploi du temps. Réponds en français, sois concis."
  },
  social: {
    emoji: "📣",
    name: "Agent Social",
    system: "Tu es un expert en réseaux sociaux. Tu rédiges des posts pour LinkedIn, Instagram, X et TikTok. Réponds en français, sois créatif et concis."
  },
  stock: {
    emoji: "📦",
    name: "Agent Stock",
    system: "Tu es un gestionnaire de stocks. Tu surveilles les inventaires, alertes sur les ruptures et prépares des commandes. Réponds en français, sois précis et concis."
  }
};

const userState = {};

async function askClaude(system, history, message) {
  const messages = [...history, { role: "user", content: message }];
  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    system: system,
    messages: messages
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          console.log("Réponse Claude reçue");
          resolve(parsed.content?.[0]?.text || "Désolé, je n'ai pas pu répondre.");
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function handleUpdate(update) {
  console.log("Update reçu:", JSON.stringify(update).substring(0, 100));

  if (update.callback_query) {
    const chatId = update.callback_query.message.chat.id;
    const data = update.callback_query.data;
    await telegramRequest("answerCallbackQuery", { callback_query_id: update.callback_query.id });

    const agentKey = data.replace("agent_", "");
    if (AGENTS[agentKey]) {
      userState[chatId] = { agent: agentKey, history: [] };
      const agent = AGENTS[agentKey];
      await sendMessage(chatId, `${agent.emoji} *${agent.name} activé !*\n\nComment puis-je vous aider ?\n\n_/menu pour changer d'agent_`);
    }
    return;
  }

  if (!update.message?.text) return;

  const chatId = update.message.chat.id;
  const text = update.message.text;
  console.log("Message de", chatId, ":", text);

  if (text === "/start" || text === "/menu") {
    await sendMenu(chatId);
    return;
  }

  if (text === "/reset") {
    if (userState[chatId]) userState[chatId].history = [];
    await sendMessage(chatId, "🔄 Conversation réinitialisée.");
    return;
  }

  const state = userState[chatId];
  if (!state?.agent) {
    await sendMenu(chatId);
    return;
  }

  await telegramRequest("sendChatAction", { chat_id: chatId, action: "typing" });

  try {
    const agent = AGENTS[state.agent];
    const reply = await askClaude(agent.system, state.history, text);
    state.history.push({ role: "user", content: text });
    state.history.push({ role: "assistant", content: reply });
    if (state.history.length > 20) state.history = state.history.slice(-20);
    await sendMessage(chatId, reply);
  } catch (err) {
    console.error("Erreur:", err);
    await sendMessage(chatId, "⚠️ Une erreur s'est produite. Réessayez.");
  }
}

let offset = 0;

async function poll() {
  try {
    const result = await telegramRequest("getUpdates", {
      offset: offset,
      timeout: 25,
      allowed_updates: ["message", "callback_query"]
    });

    if (result.ok && result.result.length > 0) {
      for (const update of result.result) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    }
  } catch (err) {
    console.error("Erreur polling:", err.message);
  }

  setTimeout(poll, 500);
}

poll();
