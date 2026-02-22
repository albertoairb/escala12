const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

// Config
process.env.TZ = process.env.TZ || "America/Sao_Paulo";
const PORT = Number(process.env.PORT || 8080);
const LOCK_FRIDAY_HOUR = Number(process.env.LOCK_FRIDAY_HOUR || 10);
const ADMIN_KEY = (process.env.ADMIN_KEY || "").trim();

const DATA_FILE = path.join(__dirname, "data", "escala.json");
const PUBLIC_DIR = path.join(__dirname, "public");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

function nowISO() {
  return new Date().toISOString();
}

function readState() {
  const raw = fs.readFileSync(DATA_FILE, "utf-8");
  return JSON.parse(raw);
}

function writeState(state) {
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

function majorBypass(req) {
  if (!MAJOR_KEY) return false;
  const key = (req.headers["x-major-key"] || "").toString().trim();
  return key && key === MAJOR_KEY;
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

    // assinaturas (fixas por env)
    state.signatures = state.signatures || {};
    state.signatures.chefe_p1 = state.signatures.chefe_p1 || {};
    state.signatures.chefe_p1.name = CHEFE_P1_NOME;
    state.signatures.chefe_p1.role = state.signatures.chefe_p1.role || "Chefe P/1";
    state.signatures.subcomandante = state.signatures.subcomandante || {};
    state.signatures.subcomandante.name = SUBCOMANDANTE_NOME;
    state.signatures.subcomandante.role = state.signatures.subcomandante.role || "Subcomandante";
    state.signatures.ciente = state.signatures.ciente || { ok: false, at: "", by: "" };


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


/**
 * marca "ciente" do Subcomandante (somente leitura; não altera escala)
 * header: x-major-key
 * body opcional: { note: "..." }
 */
app.post("/api/ciente", (req, res) => {
  try {
    if (!majorBypass(req) && !adminBypass(req)) {
      return res.status(403).json({ ok: false, error: "negado", details: "chave inválida para ciente" });
    }

    const state = readState();
    state.signatures = state.signatures || {};
    state.signatures.chefe_p1 = state.signatures.chefe_p1 || { role: "Chefe P/1" };
    state.signatures.chefe_p1.name = CHEFE_P1_NOME;

    state.signatures.subcomandante = state.signatures.subcomandante || { role: "Subcomandante" };
    state.signatures.subcomandante.name = SUBCOMANDANTE_NOME;

    state.signatures.ciente = state.signatures.ciente || { ok: false, at: "", by: "" };
    state.signatures.ciente.ok = true;
    state.signatures.ciente.at = nowISO();
    state.signatures.ciente.by = SUBCOMANDANTE_NOME;

    state.audit = Array.isArray(state.audit) ? state.audit : [];
    state.audit.unshift({
      at: nowISO(),
      action: "CIENTE_SUBCOMANDANTE",
      by: SUBCOMANDANTE_NOME,
      note: mustText((req.body || {}).note)
    });
    if (state.audit.length > 1000) state.audit = state.audit.slice(0, 1000);

    writeState(state);
    res.json({ ok: true, ciente: state.signatures.ciente, locked: isLockedNow() });
  } catch (e) {
    res.status(500).json({ ok: false, error: "falha_ciente", details: e.message });
  }
});


app.listen(PORT, () => {
  console.log(`[OK] Escala rodando na porta interna ${PORT} (TZ=${process.env.TZ})`);
});
