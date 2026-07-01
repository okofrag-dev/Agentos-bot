const https = require("https");
const crypto = require("crypto");

const TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const BUFFER_TOKEN = process.env.BUFFER_TOKEN;
const SHEET_ID = process.env.SHEET_ID;

// Gmail (OAuth utilisateur)
const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;

// Sheets (compte de service)
const GOOGLE_SERVICE_EMAIL = process.env.GOOGLE_SERVICE_EMAIL;
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

console.log("Bot démarré, token:", TOKEN ? TOKEN.substring(0, 15) + "..." : "MANQUANT");
console.log("Gmail OAuth:", GMAIL_REFRESH_TOKEN ? "OK" : "MANQUANT");
console.log("Sheets service:", GOOGLE_SERVICE_EMAIL ? "OK" : "MANQUANT");

// ─── TELEGRAM ────────────────────────────────────────────────────────────────
function telegramRequest(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname: "api.telegram.org", path: `/bot${TOKEN}/${method}`, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function sendMessage(chatId, text) {
  return telegramRequest("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" });
}

function sendMenu(chatId) {
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text: "🤖 *AgentOS* — Choisissez votre agent :",
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🗓️ Agent Temps",  callback_data: "agent_temps"  }],
        [{ text: "📣 Agent Social", callback_data: "agent_social" }],
        [{ text: "📦 Agent Stock",  callback_data: "agent_stock"  }],
        [{ text: "📧 Agent Email",  callback_data: "agent_email"  }],
        [{ text: "🕐 Agent RH",    callback_data: "agent_rh"     }],
      ]
    }
  });
}

// ─── GMAIL OAUTH (compte @gmail.com) ──────────────────────────────────────────
async function getGmailAccessToken() {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token"
    }).toString();

    const req = https.request(
      { hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => {
          try {
            const parsed = JSON.parse(d);
            console.log("Gmail OAuth:", parsed.access_token ? "Token OK" : JSON.stringify(parsed).substring(0, 150));
            resolve(parsed.access_token || null);
          } catch(e) { resolve(null); }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function gmailRequest(path, accessToken, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" };
    if (data) headers["Content-Length"] = Buffer.byteLength(data);
    const req = https.request(
      { hostname: "gmail.googleapis.com", path, method, headers },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } }); }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getUnreadEmails() {
  const token = await getGmailAccessToken();
  if (!token) return "⚠️ Erreur d'authentification Gmail.";
  const list = await gmailRequest("/gmail/v1/users/me/messages?q=is:unread&maxResults=5", token);
  if (!list.messages || list.messages.length === 0) return "📭 Aucun email non lu.";

  let result = `📬 *${list.resultSizeEstimate || list.messages.length} emails non lus :*\n\n`;
  for (const msg of list.messages.slice(0, 5)) {
    const detail = await gmailRequest(`/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, token);
    const headers = detail.payload?.headers || [];
    const from = headers.find(h => h.name === "From")?.value || "Inconnu";
    const subject = headers.find(h => h.name === "Subject")?.value || "Sans objet";
    result += `📩 *De :* ${from.substring(0, 40)}\n📋 ${subject.substring(0, 50)}\n\n`;
  }
  return result;
}

async function sendEmail(to, subject, body) {
  const token = await getGmailAccessToken();
  if (!token) return "⚠️ Erreur d'authentification Gmail.";
  const email = [`To: ${to}`, `Subject: ${subject}`, `Content-Type: text/plain; charset=utf-8`, ``, body].join("\n");
  const encoded = Buffer.from(email).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  const result = await gmailRequest("/gmail/v1/users/me/messages/send", token, "POST", { raw: encoded });
  return result.id ? "✅ Email envoyé avec succès !" : "⚠️ Erreur lors de l'envoi.";
}

// ─── SHEETS (compte de service JWT) ───────────────────────────────────────────
async function getSheetsAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: GOOGLE_SERVICE_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600, iat: now
  };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claim)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signingInput);
  const signature = sign.sign(GOOGLE_PRIVATE_KEY, "base64url");
  const jwt = `${signingInput}.${signature}`;

  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    }).toString();
    const req = https.request(
      { hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d).access_token || null); } catch(e) { resolve(null); } }); }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function sheetsRequest(path, accessToken, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" };
    if (data) headers["Content-Length"] = Buffer.byteLength(data);
    const req = https.request(
      { hostname: "sheets.googleapis.com", path, method, headers },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } }); }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function addHoursToSheet(date, employee, hours, comment) {
  const token = await getSheetsAccessToken();
  if (!token) return "⚠️ Erreur d'authentification Google Sheets.";
  const body = { values: [[date, employee, hours, comment || ""]] };
  const result = await sheetsRequest(
    `/v4/spreadsheets/${SHEET_ID}/values/A:D:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    token, "POST", body
  );
  return result.updates ? "✅ Heures enregistrées dans le tableau !" : "⚠️ Erreur : " + JSON.stringify(result).substring(0, 150);
}

async function getRecentHours() {
  const token = await getSheetsAccessToken();
  if (!token) return "⚠️ Erreur d'authentification Google Sheets.";
  const result = await sheetsRequest(`/v4/spreadsheets/${SHEET_ID}/values/A:D`, token);
  if (!result.values || result.values.length <= 1) return "📋 Aucune heure enregistrée.";
  const rows = result.values.slice(-6);
  let out = "🕐 *Dernières heures enregistrées :*\n\n";
  for (const row of rows) {
    if (row[0] === "Date") continue;
    out += `📅 ${row[0]} — ${row[1]} : *${row[2]}h*${row[3] ? " (" + row[3] + ")" : ""}\n`;
  }
  return out;
}

async function getMonthlyReport(month, year) {
  const token = await getSheetsAccessToken();
  if (!token) return "⚠️ Erreur d'authentification Google Sheets.";
  const result = await sheetsRequest(`/v4/spreadsheets/${SHEET_ID}/values/A:D`, token);
  if (!result.values || result.values.length <= 1) return "📋 Aucune heure enregistrée.";

  const totals = {};
  for (const row of result.values) {
    if (row[0] === "Date" || !row[0] || !row[1] || !row[2]) continue;
    const parts = row[0].split("/");
    if (parts.length < 3) continue;
    if (parseInt(parts[1]) === month && parseInt(parts[2]) === year) {
      const employee = row[1].trim();
      totals[employee] = (totals[employee] || 0) + (parseFloat(row[2]) || 0);
    }
  }
  if (Object.keys(totals).length === 0) return `📋 Aucune heure pour ${String(month).padStart(2,"0")}/${year}.`;

  const monthNames = ["","Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
  let out = `📊 *Bilan ${monthNames[month]} ${year} :*\n\n`;
  let total = 0;
  for (const [employee, hours] of Object.entries(totals).sort()) {
    out += `👤 ${employee} — *${hours}h*\n`;
    total += hours;
  }
  out += `\n⏱️ *Total équipe : ${total}h*`;
  return out;
}

// ─── BUFFER ──────────────────────────────────────────────────────────────────
function getBufferProfiles() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: "api.bufferapp.com", path: "/1/profiles.json?access_token=" + BUFFER_TOKEN, method: "GET" },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); }
    );
    req.on("error", reject);
    req.end();
  });
}

function publishToBuffer(profileId, text, imageUrl) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      access_token: BUFFER_TOKEN, profile_ids: profileId, text,
      media: JSON.stringify({ photo: imageUrl })
    }).toString();
    const req = https.request(
      { hostname: "api.bufferapp.com", path: "/1/updates/create.json", method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(postData) } },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); }
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// ─── AGENTS ──────────────────────────────────────────────────────────────────
const AGENTS = {
  temps: {
    emoji: "🗓️", name: "Agent Temps",
    system: "Tu es un assistant en gestion du temps. Aide l'utilisateur à planifier ses journées, gérer son agenda et optimiser son emploi du temps. Réponds en français, sois concis."
  },
  social: {
    emoji: "📣", name: "Agent Social",
    system: `Tu es un expert en réseaux sociaux. Tu rédiges des posts pour Instagram et LinkedIn.
Quand l'utilisateur veut publier sur Instagram, génère le texte et demande l'URL de l'image.
Une fois l'image fournie, réponds EXACTEMENT avec ce JSON:
{"action":"publish_instagram","text":"texte du post","image_url":"url de l'image"}
Sinon réponds normalement en français.`
  },
  stock: {
    emoji: "📦", name: "Agent Stock",
    system: "Tu es un gestionnaire de stocks. Tu surveilles les inventaires, alertes sur les ruptures et prépares des commandes. Réponds en français, sois précis et concis."
  },
  email: {
    emoji: "📧", name: "Agent Email",
    system: `Tu es un assistant de gestion d'emails Gmail.
RÈGLE ABSOLUE : quand l'utilisateur veut lire ses emails, réponds UNIQUEMENT avec :
{"action":"read_emails"}
RÈGLE ABSOLUE : quand l'utilisateur veut envoyer un email et que tu as toutes les infos (destinataire, objet, contenu), réponds UNIQUEMENT avec :
{"action":"send_email","to":"email","subject":"objet","body":"contenu"}
Si infos manquantes, demande-les en français.
NE JAMAIS expliquer le fonctionnement technique. NE JAMAIS dire que tu ne peux pas exécuter des actions.`
  },
  rh: {
    emoji: "🕐", name: "Agent RH",
    system: `Tu es un assistant de gestion des heures de travail des employés.
RÈGLE ABSOLUE : dès que tu identifies une déclaration d'heures avec une date et un nombre d'heures, réponds UNIQUEMENT avec ce JSON :
{"action":"log_hours","date":"JJ/MM/AAAA","employee":"prénom","hours":"X","comment":""}
Si l'employé ne donne pas son nom, demande-le d'abord.
Si l'utilisateur veut voir les heures récentes, réponds UNIQUEMENT avec :
{"action":"get_hours"}
Si l'utilisateur veut le bilan/récapitulatif d'un mois, réponds UNIQUEMENT avec :
{"action":"monthly_report","month":MM,"year":AAAA}
NE JAMAIS expliquer le fonctionnement technique.`
  }
};

async function askClaude(system, history, message) {
  const today = new Date().toLocaleDateString("fr-FR");
  const messages = [...history, { role: "user", content: message }];
  const body = JSON.stringify({
    model: "claude-sonnet-4-6", max_tokens: 500,
    system: system + `\n\nDate du jour : ${today}`, messages
  });
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY,
                   "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => { try { resolve(JSON.parse(d).content?.[0]?.text || "Désolé, je n'ai pas pu répondre."); } catch(e) { reject(e); } });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────
const userState = {};

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

  if (text === "/start" || text === "/menu") { await sendMenu(chatId); return; }
  if (text === "/reset") {
    if (userState[chatId]) userState[chatId].history = [];
    await sendMessage(chatId, "🔄 Conversation réinitialisée.");
    return;
  }
  if (text === "/aide" || text === "/help") {
    await sendMessage(chatId, "📖 *Commandes :*\n/start — Démarrer\n/menu — Choisir un agent\n/reset — Réinitialiser\n/aide — Aide");
    return;
  }

  const state = userState[chatId];
  if (!state?.agent) { await sendMenu(chatId); return; }

  await telegramRequest("sendChatAction", { chat_id: chatId, action: "typing" });

  try {
    const agent = AGENTS[state.agent];
    const reply = await askClaude(agent.system, state.history, text);

    try {
      const parsed = JSON.parse(reply);

      if (parsed.action === "publish_instagram") {
        await sendMessage(chatId, "📤 Publication en cours sur Instagram...");
        const profiles = await getBufferProfiles();
        const instaProfile = profiles.find(p => p.service === "instagram");
        if (!instaProfile) { await sendMessage(chatId, "⚠️ Aucun compte Instagram trouvé sur Buffer."); return; }
        const result = await publishToBuffer(instaProfile.id, parsed.text, parsed.image_url);
        await sendMessage(chatId, result.success ? "✅ *Post publié sur Instagram !*" : "⚠️ Erreur : " + (result.message || "Erreur inconnue"));
        return;
      }

      if (parsed.action === "read_emails") {
        await sendMessage(chatId, "📬 Récupération de tes emails...");
        await sendMessage(chatId, await getUnreadEmails());
        return;
      }

      if (parsed.action === "send_email") {
        await sendMessage(chatId, `📤 Envoi de l'email à ${parsed.to}...`);
        await sendMessage(chatId, await sendEmail(parsed.to, parsed.subject, parsed.body));
        return;
      }

      if (parsed.action === "log_hours") {
        await sendMessage(chatId, "📝 Enregistrement des heures...");
        await sendMessage(chatId, await addHoursToSheet(parsed.date, parsed.employee, parsed.hours, parsed.comment));
        return;
      }

      if (parsed.action === "get_hours") {
        await sendMessage(chatId, "🔎 Récupération des heures...");
        await sendMessage(chatId, await getRecentHours());
        return;
      }

      if (parsed.action === "monthly_report") {
        await sendMessage(chatId, "📊 Calcul du bilan mensuel...");
        await sendMessage(chatId, await getMonthlyReport(parsed.month, parsed.year));
        return;
      }

    } catch(e) { /* Pas un JSON */ }

    state.history.push({ role: "user", content: text });
    state.history.push({ role: "assistant", content: reply });
    if (state.history.length > 20) state.history = state.history.slice(-20);
    await sendMessage(chatId, reply);

  } catch(err) {
    console.error("Erreur:", err);
    await sendMessage(chatId, "⚠️ Une erreur s'est produite. Réessayez.");
  }
}

// ─── POLLING ─────────────────────────────────────────────────────────────────
let offset = 0;
async function poll() {
  try {
    const result = await telegramRequest("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
    if (result.ok && result.result.length > 0) {
      for (const update of result.result) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    }
  } catch(err) { console.error("Erreur polling:", err.message); }
  setTimeout(poll, 500);
}

poll();
