let STATE = null;
let LOCKED = false;

// alterações pendentes: key -> { officerId, date, code }
const PENDING = new Map();

function el(id) { return document.getElementById(id); }

function fmtDateBR(iso) {
  // iso: YYYY-MM-DD
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function fmtDateTimeBR(isoDT) {
  const d = new Date(isoDT);
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

async function apiGet(path) {
  const r = await fetch(path);
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

function setLockStatus() {
  const box = el("lockStatus");
  if (LOCKED) {
    box.textContent = "status: travado (sexta 10h até domingo). visualização liberada.";
  } else {
    box.textContent = "status: liberado para edição.";
  }
}

function buildLegend() {
  const legend = el("legend");
  legend.innerHTML = "";
  const help = STATE.codes_help || {};
  for (const code of STATE.codes) {
    const div = document.createElement("div");
    div.innerHTML = `<b>${code}</b><br>${help[code] || ""}`;
    legend.appendChild(div);
  }
}


function buildSignatures() {
  const box = el("signBox");
  if (!box) return;
  const s = (STATE && STATE.signatures) ? STATE.signatures : null;

  const chefe = s && s.chefe_p1 ? s.chefe_p1 : { name: "", role: "Chefe P/1" };
  const sub = s && s.subcomandante ? s.subcomandante : { name: "", role: "Subcomandante" };
  const c = s && s.ciente ? s.ciente : { ok: false, at: "", by: "" };

  const cienteTxt = c.ok ? `ciente registrado em <b>${fmtDateTimeBR(c.at)}</b>` : "<b>sem ciente registrado</b>";

  box.innerHTML = `
    <div class="signrow">
      <div class="sig">
        <div class="sigline"></div>
        <div class="siglabel">${chefe.role}</div>
        <div class="signame"><b>${chefe.name || ""}</b></div>
      </div>

      <div class="sig">
        <div class="sigline"></div>
        <div class="siglabel">${sub.role}</div>
        <div class="signame"><b>${sub.name || ""}</b></div>
        <div class="sigciente">${cienteTxt}</div>
      </div>
    </div>
  `;

  const btn = el("btnCiente");
  if (btn) btn.disabled = c.ok; // já deu ciente -> desabilita
}

async function giveCiente() {
  const key = prompt("Informe a chave do Subcomandante (ciente):");
  if (!key) return;

  const note = prompt("Observação (opcional):") || "";

  const r = await fetch("/api/ciente", {
    method: "POST",
    headers: { "content-type": "application/json", "x-major-key": key.trim() },
    body: JSON.stringify({ note })
  });

  const data = await r.json();
  if (!r.ok || !data.ok) {
    const msg = (data && (data.details || data.error)) ? `${data.details || data.error}` : `erro (${r.status})`;
    alert(msg);
    return;
  }

  el("cienteMsg").textContent = "ciente registrado com sucesso.";
  await loadAll();
}

function buildTable() {
  const table = el("table");
  table.innerHTML = "";

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");

  const th1 = document.createElement("th");
  th1.textContent = "posto";
  trh.appendChild(th1);

  const th2 = document.createElement("th");
  th2.textContent = "nome";
  trh.appendChild(th2);

  for (const date of STATE.dates) {
    const th = document.createElement("th");
    th.textContent = fmtDateBR(date);
    trh.appendChild(th);
  }

  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  for (const o of STATE.officers) {
    const tr = document.createElement("tr");

    const tdRank = document.createElement("td");
    tdRank.textContent = o.rank;
    tr.appendChild(tdRank);

    const tdName = document.createElement("td");
    tdName.innerHTML = `<b>${o.name}</b>`;
    tr.appendChild(tdName);

    for (const date of STATE.dates) {
      const td = document.createElement("td");

      const sel = document.createElement("select");
      sel.disabled = LOCKED; // travado -> só leitura

      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "-";
      sel.appendChild(empty);

      for (const code of STATE.codes) {
        const opt = document.createElement("option");
        opt.value = code;
        opt.textContent = code;
        sel.appendChild(opt);
      }

      const key = `${o.id}|${date}`;
      const current = (STATE.assignments && STATE.assignments[key]) ? STATE.assignments[key] : "";
      const pending = PENDING.has(key) ? PENDING.get(key).code : null;

      sel.value = pending !== null ? pending : current;

      sel.addEventListener("change", () => {
        const newCode = sel.value;
        const original = current;

        if (newCode === original) {
          PENDING.delete(key);
          td.classList.remove("changed");
        } else {
          PENDING.set(key, { officerId: o.id, date, code: newCode });
          td.classList.add("changed");
        }

        el("saveMsg").textContent = `${PENDING.size} alteração(ões) pendente(s).`;
      });

      if (pending !== null && pending !== current) td.classList.add("changed");

      td.appendChild(sel);
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
}

function buildHistory() {
  const history = el("history");
  history.innerHTML = "";

  const list = Array.isArray(STATE.history) ? STATE.history : [];
  if (!list.length) {
    history.textContent = "sem alterações registradas.";
    return;
  }

  const byId = new Map(STATE.officers.map(o => [o.id, o]));

  for (const h of list.slice(0, 200)) {
    const off = byId.get(h.officerId);
    const div = document.createElement("div");
    div.className = "histitem";

    const who = h.user || "";
    const why = h.reason || "";
    const when = fmtDateTimeBR(h.at);
    const name = off ? `${off.rank} ${off.name}` : h.officerId;

    const from = h.from ? h.from : "-";
    const to = h.to ? h.to : "-";

    div.innerHTML = `
      <div><b>${when}</b></div>
      <div>${name}</div>
      <div>de <b>${from}</b> para <b>${to}</b> em <b>${fmtDateBR(h.date)}</b></div>
      <div>quem: <b>${who}</b></div>
      <div>motivo: <b>${why}</b></div>
    `;
    history.appendChild(div);
  }
}

async function loadAll() {
  const resp = await apiGet("/api/state");
  if (!resp.ok) {
    alert("falha ao carregar estado");
    return;
  }

  STATE = resp.state;
  LOCKED = !!resp.locked;

  el("title").textContent = (STATE.meta && STATE.meta.title) ? STATE.meta.title : "Escala";
  el("subtitle").textContent = `período: ${fmtDateBR(STATE.period.start)} a ${fmtDateBR(STATE.period.end)}`;
  el("author").textContent = (STATE.meta && STATE.meta.author) ? STATE.meta.author : "";

  setLockStatus();
  buildLegend();
  buildTable();
  buildSignatures();
  buildHistory();

  el("saveMsg").textContent = "";
  PENDING.clear();
}

async function saveChanges() {
  if (LOCKED) {
    alert("travado para edição (sexta 10h até domingo).");
    return;
  }

  const user = el("user").value.trim();
  const reason = el("reason").value.trim();

  if (!user) { alert("informe quem alterou"); return; }
  if (!reason) { alert("informe o motivo da alteração"); return; }
  if (!PENDING.size) { alert("nenhuma alteração pendente"); return; }

  const updates = Array.from(PENDING.values());

  const { ok, status, data } = await apiPost("/api/update", { user, reason, updates });

  if (!ok) {
    const msg = (data && (data.details || data.error)) ? `${data.details || data.error}` : `erro (${status})`;
    alert(msg);
    return;
  }

  await loadAll();
  el("saveMsg").textContent = "alterações salvas e registradas no histórico.";
}

function exportJson() {
  const blob = new Blob([JSON.stringify(STATE, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "escala_export.json";
  a.click();
  URL.revokeObjectURL(url);
}

document.addEventListener("DOMContentLoaded", async () => {
  el("btnReload").addEventListener("click", loadAll);
  el("btnSave").addEventListener("click", saveChanges);
  const bc = el("btnCiente");
  if (bc) bc.addEventListener("click", giveCiente);
  el("btnExport").addEventListener("click", exportJson);
  await loadAll();
});
