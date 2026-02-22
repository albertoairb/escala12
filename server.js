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
  // YYYY-MM-DD (timezone local do container)
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Estado seed (base) — usado somente se /data/escala.json não existir ainda.
 * Observação: ao rodar no Railway com Volume montado em /app/data, esse seed
 * garante que o sistema abre mesmo com o volume vazio.
 */
const DEFAULT_STATE = {
  meta: {
    title: "Escala de Oficiais (23/02 a 01/03)",
    author: "Desenvolvido por Alberto Franzini Neto",
    created_at: "2026-02-22"
  },
  period: {
    start: "2026-02-23",
    end: "2026-03-01"
  },
  dates: [
    "2026-02-23",
    "2026-02-24",
    "2026-02-25",
    "2026-02-26",
    "2026-02-27",
    "2026-02-28",
    "2026-03-01"
  ],
  codes: [
    "EXP",
    "SR",
    "FO",
    "MA",
    "VE",
    "F",
    "LP",
    "CFP_DIA",
    "CFP_NOITE",
    "12H",
    "12X36",
    "PF"
  ],
  legend: {
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
    PF: "ponto facultativo"
  },
  officers: [
    { id: "o1", posto: "Ten Cel PM", nome: "NOME 01" },
    { id: "o2", posto: "Maj PM", nome: "NOME 02" },
    { id: "o3", posto: "Cap PM", nome: "NOME 03" }
  ],
  assignments: {},
  history: [],
  signatures: {
    chefe_p1: {
      nome: "Cap PM Alberto Franzini Neto",
      assinado_em: ""
    },
    subcomandante: {
      nome: "Maj PM Mozna",
      ciente_em: ""
    }
  }
};

function ensureStateFile() {
  // garante pasta /data
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // se ainda não existe o arquivo, cria com seed
  if (!fs.existsSync(DATA_FILE)) {
    const seeded = JSON.parse(JSON.stringify(DEFAULT_STATE));

    // atualiza created_at para hoje (sem alterar period/dates)
    seeded.meta = seeded.meta || {};
    seeded.meta.created_at = todayISODate();

    // permite sobrescrever título/autor via env
    if (process.env.TITLE) seeded.meta.title = process.env.TITLE;
    if (process.env.AUTHOR) seeded.meta.author = process.env.AUTHOR;

    fs.writeFileSync(DATA_FILE, JSON.stringify(seeded, null, 2), "utf-8");
  }
}

function readState() {
  ensureStateFile();
  const raw = fs.readFileSync(DATA_FILE, "utf-8");
  return JSON.parse(raw);
}

function writeState(state) {
  ensureStateFile();
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, DATA_FILE);
}

/**
 * trava: sexta >= 10:00 até domingo 00:00
 * getDay(): 0=domingo, 5=sexta, 6=sábado
 */
function isLockedNow() {
  const d = new Date();
  const day = d.getDay();
  const hour = d.getHours();

  if (day === 5 && hour >= LOCK_FRIDAY_HOUR) return true; // sexta após 10h
  if (day === 6) return true; // sábado todo
  return false; // domingo em diante libera
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
    locked: isLockedNow()
  });
});

app.get("/api/state", (_req, res) => {
  try {
    const state = readState();

    // atualiza metadados dinâmicos (opcional)
    state.meta = state.meta || {};
    if (process.env.TITLE) state.meta.title = process.env.TITLE;
    if (process.env.AUTHOR) state.meta.author = process.env.AUTHOR;

    res.json({ ok: true, state, locked: isLockedNow() });
  } catch (e) {
    res.status(500).json({ ok: false, error: "falha_leitura", details: e.message });
  }
});

/**
 * body:
 *  - user: string
 *  - reason: string
 *  - updates: [{ officerId, date, code }]
 */
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
    const codes = state.codes || [];
    const valid = new Set(codes);

    const dates = state.dates || [];
    const validDates = new Set(dates);

    // index officers
    const byId = new Map((state.officers || []).map(o => [o.id, o]));

    const changes = [];
    for (const u of updates) {
      const officerId = mustText(u.officerId);
      const date = mustText(u.date);
      const code = mustText(u.code);

      if (!byId.has(officerId)) {
        return res.status(400).json({ ok: false, error: "oficial_invalido", details: `id inválido: ${officerId}` });
      }
      if (!validDates.has(date)) {
        return res.status(400).json({ ok: false, error: "data_invalida", details: `data inválida: ${date}` });
      }
      if (!valid.has(code) && code !== "") {
        return res.status(400).json({ ok: false, error: "codigo_invalido", details: `código inválido: ${code}` });
      }

      const key = `${officerId}|${date}`;
      const oldCode = (state.assignments && state.assignments[key]) ? state.assignments[key] : "";
      if (oldCode === code) continue;

      changes.push({ officerId, date, oldCode, newCode: code });
    }

    if (!changes.length) {
      return res.json({ ok: true, message: "nenhuma mudança efetiva", locked: isLockedNow() });
    }

    state.assignments = state.assignments || {};
    state.history = state.history || [];

    for (const c of changes) {
      const k = `${c.officerId}|${c.date}`;
      // permite limpar com "" (voltar para "-")
      if (c.newCode === "") {
        delete state.assignments[k];
      } else {
        state.assignments[k] = c.newCode;
      }

      state.history.unshift({
        at: nowISO(),
        user: check.user,
        reason: check.reason,
        officerId: c.officerId,
        date: c.date,
        from: c.oldCode || "",
        to: c.newCode || ""
      });
    }

    // limita histórico para não crescer infinito
    if (state.history.length > 2000) state.history = state.history.slice(0, 2000);

    writeState(state);
    res.json({ ok: true, locked: isLockedNow() });
  } catch (e) {
    res.status(500).json({ ok: false, error: "falha_gravacao", details: e.message });
  }
});

app.listen(PORT, () => {
  // cria o arquivo já na subida (útil para volume vazio)
  try { ensureStateFile(); } catch (_e) {}
  console.log(`[OK] Escala rodando na porta interna ${PORT} (TZ=${process.env.TZ})`);
});