const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

// Config
process.env.TZ = process.env.TZ || "America/Sao_Paulo";
const PORT = Number(process.env.PORT || 8080);
const LOCK_FRIDAY_HOUR = Number(process.env.LOCK_FRIDAY_HOUR || 10);
const ADMIN_KEY = (process.env.ADMIN_KEY || "").trim();

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "escala.json");
const PUBLIC_DIR = path.join(__dirname, "public");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

function nowISO() {
  return new Date().toISOString();
}

function todayISODate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Seed compatível com o frontend do escala12:
 * - officers: [{id, rank, name}]
 * - assignments: {}
 * - history: []
 * - codes_help
 */
const DEFAULT_STATE = {
  meta: {
    title: "Escala de Oficiais (23/02 a 01/03)",
    author: "Desenvolvido por Alberto Franzini Neto",
    created_at: "2026-02-22",
  },
  period: { start: "2026-02-23", end: "2026-03-01" },
  dates: [
    "2026-02-23",
    "2026-02-24",
    "2026-02-25",
    "2026-02-26",
    "2026-02-27",
    "2026-02-28",
    "2026-03-01",
  ],
  codes: ["EXP", "SR", "FO", "MA", "VE", "F", "LP", "CFP_DIA", "CFP_NOITE", "12H", "12X36", "PF"],
  codes_help: {
    EXP: "expediente",
    SR: "supervisor regional",
    FO: "folga",
    MA: "meio expediente matutino",
    VE: "meio expediente vespertino",
    F: "férias",
    LP: "licença/afastamento",
    CFP_DIA: "cfp dia",
    CFP_NOITE: "cfp noite",
    "12H": "serviço 12h",
    "12X36": "12x36",
    PF: "ponto facultativo",
  },
  officers: [
    { id: "o1", rank: "Ten Cel PM", name: "NOME 01" },
    { id: "o2", rank: "Maj PM", name: "NOME 02" },
    { id: "o3", rank: "Cap PM", name: "NOME 03" },
  ],
  assignments: {},
  history: [],
  // compat (se existir no frontend antigo)
  signatures: {
    chefe_p1: { nome: "Cap PM Alberto Franzini Neto", assinado_em: "" },
    subcomandante: { nome: "Maj PM Mozna", ciente_em: "" },
  },
};

function ensureStateFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(DATA_FILE)) {
    const seeded = JSON.parse(JSON.stringify(DEFAULT_STATE));
    seeded.meta = seeded.meta || {};
    seeded.meta.created_at = todayISODate();
    if (process.env.TITLE) seeded.meta.title = process.env.TITLE;
    if (process.env.AUTHOR) seeded.meta.author = process.env.AUTHOR;
    fs.writeFileSync(DATA_FILE, JSON.stringify(seeded, null, 2), "utf-8");
  }
}

/**
 * Normalização forte:
 * - garante rank/name SEMPRE
 * - também escreve posto/nome por compatibilidade (para não quebrar nada)
 * - garante assignments/history e também espelha para atribuições/história
 * - garante codes_help (copiando de legend, se vier)
 */
function normalizeState(state) {
  if (!state || typeof state !== "object") return state;

  // meta
  state.meta = state.meta || {};
  if (!state.meta.created_at) state.meta.created_at = todayISODate();
  if (process.env.TITLE) state.meta.title = process.env.TITLE;
  if (process.env.AUTHOR) state.meta.author = process.env.AUTHOR;

  // codes_help
  if (!state.codes_help && state.legend && typeof state.legend === "object") {
    state.codes_help = state.legend;
  }
  if (!state.codes_help) state.codes_help = DEFAULT_STATE.codes_help;

  // officers
  const rawOfficers = Array.isArray(state.officers) ? state.officers : [];
  const normOfficers = rawOfficers
    .map((o) => {
      const id = (o && o.id) ? String(o.id) : "";
      const rank = (o && (o.rank || o.posto || o.patente)) ? String(o.rank || o.posto || o.patente) : "";
      const name = (o && (o.name || o.nome)) ? String(o.name || o.nome) : "";
      if (!id || !rank || !name) return null;

      // IMPORTANTÍSSIMO:
      // devolve SEMPRE name e rank, e também nome/posto por compatibilidade
      return {
        id,
        rank,
        name,
        posto: rank,
        nome: name,
      };
    })
    .filter(Boolean);

  state.officers = normOfficers;

  // assignments/history (aceita chaves antigas)
  let assignments = state.assignments;
  if (!assignments) assignments = state["atribuições"] || state["atribuicoes"] || {};
  if (typeof assignments !== "object" || assignments === null || Array.isArray(assignments)) assignments = {};

  let history = state.history;
  if (!history) history = state["história"] || state["historia"] || [];
  if (!Array.isArray(history)) history = [];

  // grava no formato esperado + espelho compat
  state.assignments = assignments;
  state.history = history;

  state["atribuições"] = assignments;
  state["história"] = history;

  // legend compat (se o frontend usar)
  if (!state.legend) state.legend = state.codes_help;

  // garantir period/dates/codes pelo menos existam
  if (!state.period) state.period = DEFAULT_STATE.period;
  if (!Array.isArray(state.dates)) state.dates = DEFAULT_STATE.dates;
  if (!Array.isArray(state.codes)) state.codes = DEFAULT_STATE.codes;

  return state;
}

function writeState(state) {
  ensureStateFile();
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, DATA_FILE);
}

function readState() {
  ensureStateFile();
  const raw = fs.readFileSync(DATA_FILE, "utf-8");
  const parsed = JSON.parse(raw);

  const norm = normalizeState(parsed);

  // se mudou, salva de volta (conserta o volume automaticamente)
  try {
    if (JSON.stringify(parsed) !== JSON.stringify(norm)) {
      writeState(norm);
    }
  } catch (_) {}

  return norm;
}

/**
 * trava: sexta >= LOCK_FRIDAY_HOUR e sábado todo
 */
function isLockedNow() {
  const d = new Date();
  const day = d.getDay(); // 0 dom, 5 sex, 6 sab
  const hour = d.getHours();
  if (day === 5 && hour >= LOCK_FRIDAY_HOUR) return true;
  if (day === 6) return true;
  return false;
}

function adminBypass(req) {
  if (!ADMIN_KEY) return false;
  const key = (req.headers["x-admin-key"] || "").toString().trim();
  return key && key === ADMIN_KEY;
}

function mustText(v) {
  return (v || "").toString().trim();
}

function requiredUserReason(body) {
  const user = mustText(body.user);
  const reason = mustText(body.reason);
  if (!user) return { ok: false, error: "campo_obrigatorio", details: "informe quem alterou" };
  if (!reason) return { ok: false, error: "campo_obrigatorio", details: "informe o motivo da alteração" };
  return { ok: true, user, reason };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "escala-oficiais", time: nowISO(), locked: isLockedNow() });
});

app.get("/api/state", (_req, res) => {
  try {
    const state = readState();
    res.json({ ok: true, state, locked: isLockedNow() });
  } catch (e) {
    res.status(500).json({ ok: false, error: "falha_leitura", details: e.message });
  }
});

app.post("/api/update", (req, res) => {
  try {
    if (isLockedNow() && !adminBypass(req)) {
      return res.status(403).json({ ok: false, error: "travado", details: "edição bloqueada (sexta 10h até domingo)" });
    }

    const check = requiredUserReason(req.body || {});
    if (!check.ok) return res.status(400).json(check);

    const updates = Array.isArray(req.body.updates) ? req.body.updates : [];
    if (!updates.length) {
      return res.status(400).json({ ok: false, error: "sem_alteracoes", details: "nenhuma alteração enviada" });
    }

    const state = readState();
    const validCodes = new Set(state.codes || []);
    const validDates = new Set(state.dates || []);
    const byId = new Map((state.officers || []).map((o) => [o.id, o]));

    const changes = [];
    for (const u of updates) {
      const officerId = mustText(u.officerId);
      const date = mustText(u.date);
      const code = mustText(u.code);

      if (!byId.has(officerId)) return res.status(400).json({ ok: false, error: "oficial_invalido", details: `id inválido: ${officerId}` });
      if (!validDates.has(date)) return res.status(400).json({ ok: false, error: "data_invalida", details: `data inválida: ${date}` });
      if (!validCodes.has(code) && code !== "") return res.status(400).json({ ok: false, error: "codigo_invalido", details: `código inválido: ${code}` });

      const key = `${officerId}|${date}`;
      const oldCode = state.assignments[key] || "";
      if (oldCode === code) continue;

      changes.push({ officerId, date, oldCode, newCode: code });
    }

    if (!changes.length) return res.json({ ok: true, message: "nenhuma mudança efetiva", locked: isLockedNow() });

    for (const c of changes) {
      const k = `${c.officerId}|${c.date}`;
      if (c.newCode === "") delete state.assignments[k];
      else state.assignments[k] = c.newCode;

      state.history.unshift({
        at: nowISO(),
        user: check.user,
        reason: check.reason,
        officerId: c.officerId,
        date: c.date,
        from: c.oldCode || "",
        to: c.newCode || "",
      });
    }

    if (state.history.length > 2000) state.history = state.history.slice(0, 2000);

    // espelho compat
    state["atribuições"] = state.assignments;
    state["história"] = state.history;

    writeState(state);
    res.json({ ok: true, locked: isLockedNow() });
  } catch (e) {
    res.status(500).json({ ok: false, error: "falha_gravacao", details: e.message });
  }
});

app.listen(PORT, () => {
  try { ensureStateFile(); } catch (_) {}
  console.log(`[OK] Escala rodando na porta interna ${PORT} (TZ=${process.env.TZ})`);
});