const https = require("https");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "VOTRE_TOKEN_ICI";
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY || "VOTRE_CLE_ANTHROPIC_ICI";
const BASE_URL       = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const AGENTS = {
  temps: {
    emoji: "🗓️",
    name: "Agent Temps",
    system: `Tu es un assistant spécialisé en gestion du temps. Tu aides l'utilisateur à planifier ses journées, gérer son agenda, fixer des rappels et optimiser son emploi du temps. Tu es concis, pratique et proactif. Réponds toujours en français. Garde tes réponses courtes et structurées (adapté à Telegram).`,
  },
  social: {
    emoji: "📣",
    name: "Agent Social",
    system: `Tu es un expert en réseaux sociaux et marketing de contenu. Tu rédiges des posts engageants pour LinkedIn, Instagram, X et TikTok, planifies des publications et analyses les performances. Tu es créatif et orienté résultats. Réponds toujours en français. Garde tes réponses courtes et structurées (adapté à Telegram).`,
  },
  stock: {
    emoji: "📦",
    name: "Agent Stock",
    system: `Tu es un gestionnaire d'inventaire et de stocks. Tu surveilles les niveaux de stock, alertes sur les ruptures, prépares des commandes de réapprovisionnement et analyses les tendances. Tu es précis, chiffré et efficace. Réponds toujours en français. Garde tes réponses courtes et structurées (adapté à Telegram).`,
  },
};

const userState = {};
function getState(chatId) {
  if (!userState[chatId]) userState[chatId] = { agent: null, history: [] };
  return userState[chatId];
}

function apiCall(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname: "api.telegram.org", path: `/bot${TELEGRAM_TOKEN}/${method}`, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function sendMessage(chatId, text, extra = {}) {
  return apiCall("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown", ...extra });
}

function sendMenu(chatId) {
  return sendMessage(chatId,
    "🤖 *AgentOS — Choisissez votre agent :*\n\nQuel assistant souhaitez-vous consulter ?",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🗓️ Agent Temps",  callback_data: "agent_temps"  }],
          [{ text: "📣 Agent Social", callback_data: "agent_social" }],
          [{ text: "📦 Agent Stock",  callback_data: "agent_stock"  }],
        ],
      },
    }
  );
}

function askClaude(systemPrompt, history, userMessage) {
  return new Promise((resolve, reject) => {
    const messages = [...history, { role: "user", content: userMessage }];
    const body = JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: systemPrompt,
      messages,
    });
    const req = https.request(
      { hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY,
                   "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => {
          try {
            const parsed = JSON.parse(d);
            resolve(parsed.content?.[0]?.text || "Je n'ai pas pu générer de réponse.");
          } catch { reject(new Error("Réponse invalide de Claude")); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function handleUpdate(update) {
  if (update.callback_query) {
    const { id, data, message } = update.callback_query;
    const chatId = message.chat.id;
    await apiCall("answerCallbackQuery", { callback_query_id: id });
    const agentKey = data.replace("agent_", "");
    if (AGENTS[agentKey]) {
      const state = getState(chatId);
      state.agent = agentKey;
      state.history = [];
      const agent = AGENTS[agentKey];
      await sendMessage(chatId,
        `${agent.emoji} *${agent.name} activé !*\n\nBonjour ! Je suis votre ${agent.name}. Comment puis-je vous aider ?\n\n_Tapez /menu pour changer d'agent._`
      );
    }
    return;
  }

  if (!update.message?.text) return;
  const { text, chat } = update.message;
  const chatId = chat.id;
  const state  = getState(chatId);

  if (text === "/start") {
    await sendMessage(chatId, "👋 *Bienvenue sur AgentOS !*\n\nJe suis votre suite d'agents IA pour gérer votre temps, vos réseaux sociaux et vos stocks.");
    await sendMenu(chatId);
    return;
  }
  if (text === "/menu")  { await sendMenu(chatId); return; }
  if (text === "/reset") { state.history = []; await sendMessage(chatId, "🔄 Conversation réinitialisée."); return; }
  if (text === "/aide" || text === "/help") {
    await sendMessage(chatId,
      "📖 *Commandes disponibles :*\n\n/start — Démarrer le bot\n/menu — Choisir un agent\n/reset — Réinitialiser la conversation\n/aide — Afficher cette aide"
    );
    return;
  }

  if (!state.agent) { await sendMenu(chatId); return; }

  await apiCall("sendChatAction", { chat_id: chatId, action: "typing" });
  try {
    const reply = await askClaude(AGENTS[state.agent].system, state.history, text);
    state.history.push({ role: "user", content: text });
    state.history.push({ role: "assistant", content: reply });
    if (state.history.length > 20) state.history = state.history.slice(-20);
    await sendMessage(chatId, reply);
  } catch (err) {
    await sendMessage(chatId, "⚠️ Une erreur s'est produite. Réessayez dans un instant.");
    console.error(err);
  }
}

let offset = 0;
async function poll() {
  if (offset === 0) {
    try {
      const init = await apiCall("getUpdates", { offset: -1 });
      if (init.result?.length) offset = init.result[init.result.length - 1].update_id + 1;
    } catch(e) {}
  }
  try {
    const res = await apiCall("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
    if (res.result?.length) {
      for (const update of res.result) {
        offset = update.update_id + 1;
        handleUpdate(update).catch(console.error);
      }
    }
  } catch (e) { console.error("Polling error:", e.message); }
  setTimeout(poll, 1000);
}

console.log("🤖 AgentOS Bot démarré...");
poll();
