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
 * Estado seed compatível com o frontend ORIGINAL do escala12:
 * - officers: [{id, rank, name}]
 * - assignments: {}
 * - history: []
 */
const DEFAULT_STATE = {
  meta: {
    title: "Escala de Oficiais (23/02 a 01/03)",
    author: "Desenvolvido por Alberto Franzini Neto",
    created_at: "2026-02-22",
  },
  period: {
    start: "2026-02-23",
    end: "2026-03-01",
  },
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
  // o frontend usa codes_help (no zip original)
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
 * Migra estados antigos/inconsistentes para o formato esperado pelo frontend:
 * - officers: posto/nome -> rank/name
 * - atribuições -> assignments
 * - história -> history
 * - legend -> codes_help (se necessário)
 */
function normalizeState(state) {
  if (!state || typeof state !== "object") return state;

  // meta defaults
  state.meta = state.meta || {};
  if (!state.meta.created_at) state.meta.created_at = todayISODate();
  if (process.env.TITLE) state.meta.title = process.env.TITLE;
  if (process.env.AUTHOR) state.meta.author = process.env.AUTHOR;

  // officers: aceitar tanto rank/name quanto posto/nome
  if (Array.isArray(state.officers)) {
    state.officers = state.officers.map((o) => ({
      id: (o && o.id) ? String(o.id) : "",
      rank: (o && (o.rank || o.posto || o.patente)) ? String(o.rank || o.posto || o.patente) : "",
      name: (o && (o.name || o.nome)) ? String(o.name || o.nome) : "",
    })).filter(o => o.id && o.rank && o.name);
  } else {
    state.officers = [];
  }

  // assignments/history: aceitar chaves com acento
  if (!state.assignments) {
    state.assignments = state["atribuições"] || state["atribuicoes"] || {};
  }
  if (!state.history) {
    state.history = state["história"] || state["historia"] || [];
  }

  // garantir tipos
  if (typeof state.assignments !== "object" || state.assignments === null || Array.isArray(state.assignments)) {
    state.assignments = {};
  }
  if (!Array.isArray(state.history)) state.history = [];

  // codes_help: se veio "legend", copiar
  if (!state.codes_help && state.legend && typeof state.legend === "object") {
    state.codes_help = state.legend;
  }
  if (!state.codes_help) state.codes_help = DEFAULT_STATE.codes_help;

  return state;
}

function readState() {
  ensureStateFile();
  const raw = fs.readFileSync(DATA_FILE, "utf-8");
  const parsed = JSON.parse(raw);
  const norm = normalizeState(parsed);

  // se normalizou algo, salva de volta para fixar no volume
  try {
    const before = JSON.stringify(parsed);
    const after = JSON.stringify(norm);
    if (before !== after) writeState(norm);
  } catch (_) {}

  return norm;
}

function writeState(state) {
  ensureStateFile();
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, DATA_FILE);
}

/**
 * trava: sexta >= LOCK_FRIDAY_HOUR até domingo (sábado todo)
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
  res.json({
    ok: true,
    service: "escala-oficiais",
    time: nowISO(),
    locked: isLockedNow(),
  });
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