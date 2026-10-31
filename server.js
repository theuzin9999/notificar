// ============================================================
// AviatorMax — Servidor de Push 24h (Render / Railway) — MULTI-FONTE
//
// Lê o Firebase de cada gráfico a cada poucos segundos, roda o mesmo radar
// do app (AmRadar: PAGUE / TOME / 50x / melhor modo) e manda Web Push para
// quem se inscreveu naquela fonte — mesmo com o app fechado.
//
// Rotas (iguais às do Worker antigo):
//   POST /subscribe?src=NOME        inscreve o aparelho
//   GET  /status                    estado de cada fonte
//   GET  /test-push[?src=NOME]      notificação de teste
//   GET  /send?token=SENHA&title=..&body=..[&src=NOME]   manual (sem src = todos)
//   GET  /health                    para o UptimeRobot manter acordado
//
// Variáveis de ambiente:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY   (obrigatórias)
//   ADMIN_TOKEN                           (senha da rota /send)
//   VAPID_SUBJECT   (opcional) mailto:voce@email.com
//   POLL_MS         (opcional) intervalo de leitura, padrão 5000
//   STALL_MIN       (opcional) avisa se ficar N min sem vela nova, padrão 15 (0 desliga)
//   SOURCES         (opcional) JSON com as fontes, ex.:
//     {"aviatormax":{"db":"https://X.firebaseio.com","path":"history"}}
//   SUBS_DB_URL     (opcional) Firebase onde guardar as inscrições
//   DRY_RUN=1       (opcional) só loga, não envia push
// ============================================================
import http from "node:http";
import crypto from "node:crypto";
import webpush from "web-push";

const PORT = Number(process.env.PORT || 3000);
const POLL_MS = Math.max(2000, Number(process.env.POLL_MS || 5000));
const STALL_MIN = Number(process.env.STALL_MIN ?? 15);
const DRY_RUN = process.env.DRY_RUN === "1";
// FILTRO_ENTRADA=1 liga o filtro de 22 velas no aviso "Possível PAGUE" (corta alertas, mas NÃO aumentou a taxa de acerto nos testes). Padrão: desligado.
const FILTRO_ENTRADA = process.env.FILTRO_ENTRADA === "1";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const DEFAULT_SRC = "aviatormax";

// ---- FONTES (um Firebase por gráfico) ----
const SOURCES = process.env.SOURCES
  ? JSON.parse(process.env.SOURCES)
  : {
      // nome = rótulo que aparece no título · g = número do gráfico · stall:false = não avisa "capturador parado"
      aviatormax: { db: "https://aviatormax-ac28e-default-rtdb.firebaseio.com", path: "history", nome: "Automática", g: 1 },
      aviatormax2: { db: "https://aviatormax-ac28e-default-rtdb.firebaseio.com", path: "aviator2", nome: "Automática", g: 2, stall: false },
      goty: { db: "https://goathvelas-default-rtdb.firebaseio.com", path: "history", nome: "Goathbet", g: 1 },
      goty2: { db: "https://goathvelas-default-rtdb.firebaseio.com", path: "aviator2", nome: "Goathbet", g: 2, stall: false },
    };
const SUBS_DB = (process.env.SUBS_DB_URL || SOURCES[DEFAULT_SRC]?.db || Object.values(SOURCES)[0].db).replace(/\/$/, "");

const CD_MOMENTO = 3 * 60 * 1000; // mesma msg de momento: 3 min
const CD_MODO = 10 * 60 * 1000; // melhor modo: 10 min
const CD_50X = 5 * 60 * 1000;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- VAPID ----------
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:aviatormax@example.com",
    VAPID_PUBLIC,
    VAPID_PRIVATE
  );
} else if (!DRY_RUN) {
  console.error("⚠️ VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY não configuradas — push não vai funcionar.");
}

// ---------- INSCRIÇÕES (guardadas no Firebase, em push_subs/<fonte>/<hash>) ----------
const subs = {};
for (const s of Object.keys(SOURCES)) subs[s] = new Map();

const sha = (str) => crypto.createHash("sha256").update(str).digest("hex").slice(0, 40);

async function loadSubs() {
  for (const src of Object.keys(SOURCES)) {
    try {
      const r = await fetch(`${SUBS_DB}/push_subs/${src}.json`);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = (await r.json()) || {};
      for (const [hash, sub] of Object.entries(data)) {
        if (sub && sub.endpoint && sub.keys) subs[src].set(hash, sub);
      }
      log(`inscrições carregadas [${src}]:`, subs[src].size);
    } catch (e) {
      log(`não consegui carregar inscrições [${src}]:`, String(e.message || e));
    }
  }
}
async function saveSub(src, hash, sub) {
  try {
    const r = await fetch(`${SUBS_DB}/push_subs/${src}/${hash}.json`, {
      method: "PUT",
      body: JSON.stringify(sub),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
  } catch (e) {
    log("aviso: inscrição só em memória (Firebase recusou a gravação):", String(e.message || e));
  }
}
async function deleteSub(src, hash) {
  try {
    await fetch(`${SUBS_DB}/push_subs/${src}/${hash}.json`, { method: "DELETE" });
  } catch (_) {}
}

// ---------- ENVIO ----------
// src = nome da fonte · null = todas
const prefixo = (s) => { const c = SOURCES[s] || {}; return c.nome ? `[${c.nome} · G${c.g || 1}] ` : ""; };
// gráfico 2 usa tag própria (am-g2-momento…) para não substituir a notificação do gráfico 1
const tagDe = (s, tag) => { const g = (SOURCES[s] || {}).g || 1; return g > 1 ? tag.replace(/^am-/, `am-g${g}-`) : tag; };
async function sendPushToAll(src, title, body, tag, extra) {
  const targets = src ? [src] : Object.keys(SOURCES);
  let sent = 0;
  const jobs = [];
  for (const s of targets) {
    const payload = JSON.stringify({ title: prefixo(s) + (title || "AviatorMax"), body: body || "", tag: tagDe(s, tag || "am-radar"), ...(extra || {}) });
    for (const [hash, sub] of [...(subs[s] || new Map())]) {
      jobs.push(
        (async () => {
          if (DRY_RUN) {
            log(`[DRY-RUN push ${s}] ${title} | ${body} | tag=${tag}`);
            sent++;
            return;
          }
          try {
            await webpush.sendNotification(sub, payload, { TTL: 120, urgency: "high" });
            sent++;
          } catch (e) {
            const code = e && e.statusCode;
            if (code === 404 || code === 410 || code === 403) {
              subs[s].delete(hash);
              deleteSub(s, hash);
              log(`inscrição removida [${s}] (HTTP ${code})`);
            } else {
              log(`falha no envio [${s}]:`, code || "", String(e.body || e.message || e).slice(0, 200));
            }
          }
        })()
      );
    }
  }
  await Promise.all(jobs);
  return sent;
}

// ---------- LEITURA DE VELAS ----------
function parseMult(row, key) {
  let v = 0;
  if (typeof row === "number") v = row;
  else if (typeof row === "string") v = parseFloat(String(row).replace(/x/gi, "")) || 0;
  else if (row && typeof row === "object") {
    const n = Number(
      row.multiplier ?? row.odds ?? row.vela ?? row.value ?? row.crash ?? row.m ??
        row.mult ?? row.resultado ?? row.result ?? row.odd
    );
    v = isFinite(n) ? n : 0;
  }
  // último recurso: o nome da chave termina com o multiplicador (…_5-34x)
  if (!(v >= 1) && typeof key === "string") {
    const m = /_(\d+)-(\d+)x$/i.exec(key);
    if (m) v = parseFloat(m[1] + "." + m[2]) || 0;
  }
  return v;
}
function tsFromKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(key);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}
const q = (s) => encodeURIComponent(s);

async function fetchCandles(cfg, lastKey) {
  const base = `${cfg.db.replace(/\/$/, "")}/${cfg.path || "history"}.json`;
  const url = lastKey
    ? `${base}?orderBy=${q('"$key"')}&startAt=${q(JSON.stringify(lastKey))}`
    : `${base}?orderBy=${q('"$key"')}&limitToLast=300`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Firebase HTTP " + r.status);
  return (await r.json()) || {};
}

// ---------- RADAR (port do AmRadar do app) ----------
const state = {};
for (const s of Object.keys(SOURCES)) {
  state[s] = {
    ready: false,
    busy: false,
    lastKey: null,
    hist: [],
    histTs: [],
    phase: "unknown", // 'pague' | 'tome' | 'neutro'
    pagueStartTs: 0,
    lastPagueDurationsMin: [],
    wasTome: false,
    lastNotifyAt: Object.create(null),
    lastCandleAt: Date.now(),
    stalled: false,
    lastError: 0,
  };
}

function prevPagueDurMin(st) {
  const arr = st.lastPagueDurationsMin;
  if (!arr.length) return null;
  if (arr.length === 1) return Math.round(arr[0]);
  return Math.round((arr[arr.length - 1] + arr[arr.length - 2]) / 2);
}
function lastPagueDurMin(st) {
  const arr = st.lastPagueDurationsMin;
  return arr.length ? Math.round(arr[arr.length - 1]) : null;
}
function rebuildCycleStats(st) {
  const vals = st.hist;
  const ts = st.histTs;
  if (vals.length < 20) return;
  let inP = false, startI = -1;
  const pagueRuns = [];
  for (let i = 9; i < vals.length; i++) {
    const w = vals.slice(i - 9, i + 1);
    let pos = 0;
    for (let k = 0; k < w.length; k++) if (w[k] >= 2) pos++;
    const isP = pos >= 6;
    if (isP && !inP) { inP = true; startI = i - 9; }
    if (!isP && inP) {
      inP = false;
      const endI = i - 1;
      const t0 = ts[startI] || 0, t1 = ts[endI] || 0;
      if (t0 && t1 && t1 > t0) {
        const min = (t1 - t0) / 60000;
        if (min >= 2 && min <= 90) pagueRuns.push(min);
      }
      startI = -1;
    }
  }
  if (pagueRuns.length) st.lastPagueDurationsMin = pagueRuns.slice(-4);
}
function detectPT(st, vals) {
  const w7 = vals.slice(-7);
  const w15 = vals.slice(-15);
  let pos7 = 0, az7 = 0, pos15 = 0;
  for (const v of w7) { if (v >= 2) pos7++; else az7++; }
  for (const v of w15) if (v >= 2) pos15++;
  const az15 = w15.length - pos15;
  const diff15 = pos15 - az15;
  let azSeq = 0;
  for (let a = vals.length - 1; a >= 0 && vals[a] < 2; a--) azSeq++;
  const pague = pos7 >= 4 && pos15 >= 7 && azSeq <= 3 && diff15 >= 2;
  const tome = az7 >= 5 || (pos15 <= 5 && azSeq >= 3);
  const prev7 = vals.slice(-14, -7);
  let prevPos = 0;
  for (const v of prev7) if (v >= 2) prevPos++;
  const early = pague && diff15 >= 2 && (prevPos <= 3 || st.wasTome || st.phase === "tome") && azSeq <= 2;
  // FILTRO DE ENTRADA (definições do usuário, janela de 22 velas): predominância de positivas e no máx. 3 azuis seguidas.
  // pink22 >= 2 => PAGUE REAL; senão => PAGUE de roxinhas. Só o AVISO depende do filtro; o ciclo (fase) segue igual.
  const w22 = vals.slice(-22);
  let pos22 = 0, pink22 = 0, run22 = 0, bm22 = 0;
  for (const v of w22) {
    if (v >= 2) { pos22++; run22 = 0; } else { run22++; if (run22 > bm22) bm22 = run22; }
    if (v >= 10) pink22++;
  }
  const filtro = !FILTRO_ENTRADA || (w22.length >= 22 && pos22 >= 12 && bm22 <= 3);
  const tipo = pink22 >= 2 ? "PAGUE REAL" : "PAGUE de roxinhas";
  const depthMin = st.pagueStartTs ? (Date.now() - st.pagueStartTs) / 60000 : 0;
  return { pague, tome, pos7, az7, pos15, azSeq, early, depthMin, prevPos, filtro, tipo, pos22, pink22, bm22 };
}
function countRosesBelow50(vals) {
  let c = 0;
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i] >= 50) break;
    if (vals[i] >= 10) c++;
  }
  return c;
}
function scoreModes(vals) {
  const w = vals.slice(-Math.min(vals.length, 100));
  if (w.length < 20) return [];
  const pos = (a) => a.filter((v) => v >= 2).length;
  const pos7 = pos(w.slice(-7));
  const az7 = w.slice(-7).length - pos7;
  const pos15 = pos(w.slice(-15));
  let rosa = 0, dens2 = 0, dens3 = 0, high5 = 0;
  for (const v of w) {
    if (v >= 10) rosa++;
    if (v >= 2 && v < 3) dens2++;
    if (v >= 3 && v < 10) dens3++;
    if (v >= 5) high5++;
  }
  let azSeq = 0;
  for (let a = w.length - 1; a >= 0 && w[a] < 2; a--) azSeq++;
  let distRosa = 99;
  for (let j = w.length - 1; j >= 0; j--) {
    if (w[j] >= 10) { distRosa = w.length - 1 - j; break; }
  }
  const modes = [
    { nome: "Meta Rápida Pague", score: (pos7 >= 4 ? 30 : 0) + (pos15 >= 8 ? 25 : 0) + (azSeq <= 2 ? 20 : 0) + (dens3 >= 3 ? 15 : 0) + (az7 >= 5 ? -40 : 0) },
    { nome: "Bot 3x Replit", score: (pos7 / 7 >= 0.55 ? 35 : 0) + (azSeq >= 1 && azSeq <= 2 ? 25 : 0) + (dens3 >= 2 ? 20 : 0) + (azSeq >= 4 ? -30 : 0) },
    { nome: "Foco 2x Replit", score: (dens2 >= 4 ? 40 : dens2 >= 2 ? 20 : 0) + (pos7 >= 4 ? 20 : 0) + (azSeq <= 2 ? 15 : 0) + (az7 >= 5 ? -25 : 0) },
    { nome: "Bot 10x Replit", score: (rosa >= 2 ? 25 : 0) + (distRosa >= 10 && distRosa <= 14 ? 35 : distRosa <= 20 ? 10 : 0) },
    { nome: "Minutagem 5x", score: (high5 >= 3 ? 40 : 0) + (pos7 >= 4 ? 15 : 0) },
    { nome: "Shazam", score: (rosa >= 1 && distRosa <= 20 ? 30 : 0) + (dens3 >= 2 ? 15 : 0) },
  ];
  modes.sort((a, b) => b.score - a.score);
  return modes;
}

// tag FIXA por tipo ('am-momento', 'am-50x', 'am-modo') = mesma tag do app:
// se o app estiver aberto, a notificação dele substitui a do servidor (sem duplicar)
const ENTRADA_EXTRA = { vibrate: [300, 120, 300, 120, 500], requireInteraction: true }; // aviso de entrada: vibra mais e fica na tela
function notify(src, st, title, body, key, minMs, force, extra) {
  const now = Date.now();
  if (!force && st.lastNotifyAt[key] && now - st.lastNotifyAt[key] < minMs) return false;
  st.lastNotifyAt[key] = now;
  sendPushToAll(src, title, body, "am-" + key, extra).catch((e) => log("erro envio:", e));
  return true;
}

function analyze(src, st) {
  const vals = st.hist;
  if (!vals || vals.length < 15) return;
  rebuildCycleStats(st);
  const pt = detectPT(st, vals);
  const roses = countRosesBelow50(vals);
  const prevDur = prevPagueDurMin(st);
  const lastDur = lastPagueDurMin(st);
  const prevTxt = prevDur != null ? "~" + prevDur + " min" : "—";
  const lastTxt = lastDur != null ? "~" + lastDur + " min" : "—";

  if (pt.tome) st.wasTome = true;

  if (pt.early && st.phase !== "pague") {
    st.phase = "pague";
    st.pagueStartTs = Date.now();
    st.wasTome = false;
    st.pagueAvisado = !!pt.filtro;
    if (pt.filtro) notify(
      src, st,
      "🟢 Possível PAGUE iniciando — inicie operação agora",
      (FILTRO_ENTRADA ? "Padrão " + pt.tipo + " · " + pt.pos22 + "/22 positivas · " + pt.pink22 + " rosa(s) · máx " + pt.bm22 + " azuis seguidas. " : "") + "Previsão de duração: " + prevTxt + " (média dos 2 últimos pagues). Pos15:" + pt.pos15 +
        " Az15:" + (15 - pt.pos15) + " (diff " + (pt.pos15 - (15 - pt.pos15)) + "). Pos7:" + pt.pos7 + " Az7:" + pt.az7,
      "momento", CD_MOMENTO, true, FILTRO_ENTRADA ? ENTRADA_EXTRA : undefined
    );
  } else if (pt.tome && st.phase !== "tome") {
    if (st.phase === "pague" && st.pagueStartTs) {
      const d = (Date.now() - st.pagueStartTs) / 60000;
      if (d >= 2 && d <= 90) {
        st.lastPagueDurationsMin.push(d);
        if (st.lastPagueDurationsMin.length > 4) st.lastPagueDurationsMin = st.lastPagueDurationsMin.slice(-4);
      }
    }
    st.phase = "tome";
    st.pagueStartTs = 0;
    st.pagueAvisado = false;
    notify(
      src, st,
      "🔴 Gráfico ruim — evite operar",
      "Último pague durou " + lastTxt + ". TOME · Pos7:" + pt.pos7 + " Az7:" + pt.az7 + " · seq azul " + pt.azSeq,
      "momento", CD_MOMENTO, true
    );
  } else if (pt.pague && st.phase === "pague" && st.pagueAvisado) {
    const depth = Math.round(pt.depthMin);
    const late = depth >= 18;
    notify(
      src, st,
      late ? "🟡 PAGUE avançado — cuidado com o fim" : "🟢 PAGUE em andamento",
      late
        ? "~" + depth + " min no ciclo · previsão era " + prevTxt + ". Considere travar."
        : "~" + depth + " min · previsão " + prevTxt + " · Pos7:" + pt.pos7,
      "momento", CD_MOMENTO, false
    );
  } else if (pt.tome && st.phase === "tome") {
    notify(
      src, st,
      "🔴 Gráfico ruim — evite operar",
      "Último pague durou " + lastTxt + ". Ainda em TOME · Pos7:" + pt.pos7 + " Az7:" + pt.az7,
      "momento", CD_MOMENTO, false
    );
  } else if (!pt.pague && !pt.tome) {
    st.phase = "neutro";
  }

  if (roses >= 7) {
    notify(src, st, "💎 Possível chance de 50x", roses + " rosas <50x desde a última mega.", "50x", CD_50X, false);
  }

  // Melhor modo: 10 em 10 min
  const now = Date.now();
  if (!st.lastNotifyAt["modo-tick"] || now - st.lastNotifyAt["modo-tick"] >= CD_MODO) {
    st.lastNotifyAt["modo-tick"] = now;
    const modes = scoreModes(vals);
    if (modes.length) {
      const top = modes.slice(0, 3).map((m) => m.nome + "(" + m.score + ")").join(" · ");
      notify(src, st, "🎯 Melhor modo agora: " + modes[0].nome, "Ranking 20 min (a cada 10 min): " + top, "modo", CD_MODO, true);
    }
  }
}

function pushCandle(st, key, row) {
  const mult = parseMult(row, key);
  st.lastKey = key; // avança sempre, mesmo se a vela for inválida
  if (!(mult >= 1) || mult >= 100000) return false;
  st.hist.push(mult);
  st.histTs.push(tsFromKey(key) ?? Date.now());
  if (st.hist.length > 400) {
    st.hist = st.hist.slice(-400);
    st.histTs = st.histTs.slice(-400);
  }
  return true;
}

async function pollSource(src) {
  const st = state[src];
  if (st.busy) return;
  st.busy = true;
  try {
    const cfg = SOURCES[src];
    const data = await fetchCandles(cfg, st.lastKey);
    const keys = Object.keys(data).sort().filter((k) => !st.lastKey || k > st.lastKey);

    if (!st.ready) {
      // primeira leitura: carrega o histórico SEM disparar alertas
      for (const k of keys) pushCandle(st, k, data[k]);
      st.ready = true;
      st.lastCandleAt = Date.now();
      rebuildCycleStats(st);
      if (st.hist.length >= 15) {
        const pt = detectPT(st, st.hist);
        st.phase = pt.pague ? "pague" : pt.tome ? "tome" : "neutro";
        if (pt.pague) st.pagueStartTs = Date.now();
      }
      st.lastNotifyAt["modo-tick"] = Date.now();
      log(`[${src}] histórico carregado: ${st.hist.length} velas · fase ${st.phase}`);
      return;
    }

    if (keys.length) {
      let added = 0;
      for (const k of keys) if (pushCandle(st, k, data[k])) added++;
      st.lastCandleAt = Date.now();
      if (st.stalled) {
        st.stalled = false;
        notify(src, st, "✅ Velas voltaram", `O gráfico ${src} voltou a receber velas.`, "stall", 0, true);
      }
      if (added) analyze(src, st);
    } else if (STALL_MIN > 0 && SOURCES[src].stall !== false && !st.stalled && Date.now() - st.lastCandleAt > STALL_MIN * 60000) {
      st.stalled = true;
      const min = Math.round((Date.now() - st.lastCandleAt) / 60000);
      notify(src, st, "⚠️ Capturador parado", `Sem velas novas em ${src} há ${min} min. Verifique o capturador.`, "stall", 0, true);
    }
  } catch (e) {
    // loga no máximo 1 erro por minuto por fonte
    if (Date.now() - st.lastError > 60000) {
      st.lastError = Date.now();
      log(`[${src}] erro ao ler Firebase:`, String(e.message || e));
    }
  } finally {
    st.busy = false;
  }
}

function startPolling() {
  for (const src of Object.keys(SOURCES)) {
    const loop = async () => {
      await pollSource(src);
      setTimeout(loop, POLL_MS);
    };
    loop();
  }
}

// ---------- HTTP ----------
const cors = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
function json(res, obj, status = 200) {
  res.writeHead(status, cors);
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body grande demais")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function getSrc(url) {
  const src = (url.searchParams.get("src") || DEFAULT_SRC).toLowerCase();
  return SOURCES[src] ? src : null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }

    if (url.pathname === "/health") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }

    if (url.pathname === "/subscribe" && req.method === "POST") {
      const src = getSrc(url);
      if (!src) return json(res, { error: "src desconhecida" }, 400);
      let sub;
      try { sub = JSON.parse(await readBody(req)); } catch (_) { return json(res, { error: "JSON inválido" }, 400); }
      if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
        return json(res, { error: "Inscrição inválida" }, 400);
      }
      const hash = sha(sub.endpoint);
      subs[src].set(hash, { endpoint: sub.endpoint, expirationTime: sub.expirationTime ?? null, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
      await saveSub(src, hash, subs[src].get(hash));
      return json(res, { success: true, src, subs: subs[src].size });
    }

    if (url.pathname === "/status" || url.pathname === "/") {
      const fontes = {};
      for (const [name, st] of Object.entries(state)) {
        fontes[name] = {
          subscriptions: subs[name].size,
          last_processed_id: st.lastKey,
          candles_em_memoria: st.hist.length,
          fase: st.phase,
          minutos_desde_ultima_vela: Math.round((Date.now() - st.lastCandleAt) / 60000),
          capturador_parado: st.stalled,
          pronto: st.ready,
        };
      }
      return json(res, {
        status: "AviatorMax Push Server ativo e operacional!",
        uptime_min: Math.round(process.uptime() / 60),
        has_vapid_private: !!VAPID_PRIVATE,
        dry_run: DRY_RUN,
        fontes,
      });
    }

    if (url.pathname === "/test-push") {
      const srcParam = url.searchParams.get("src");
      const src = srcParam ? getSrc(url) : null;
      if (srcParam && !src) return json(res, { error: "src desconhecida" }, 400);
      const sent = await sendPushToAll(src, "🔔 Teste AviatorMax", "Se você recebeu isso com o app fechado, o push 24h está OK.", "am-teste");
      return json(res, { ok: true, sent });
    }

    if (url.pathname === "/send") {
      if (!ADMIN_TOKEN || url.searchParams.get("token") !== ADMIN_TOKEN) return json(res, { error: "não autorizado" }, 401);
      const srcParam = url.searchParams.get("src");
      const src = srcParam ? getSrc(url) : null; // sem src = todos
      if (srcParam && !src) return json(res, { error: "src desconhecida" }, 400);
      const sent = await sendPushToAll(src, url.searchParams.get("title") || "AviatorMax", url.searchParams.get("body") || "", "am-manual");
      return json(res, { ok: true, sent });
    }

    return json(res, { status: "AviatorMax Push Server ativo e operacional!" });
  } catch (e) {
    return json(res, { error: String(e.message || e) }, 500);
  }
});

process.on("unhandledRejection", (e) => log("unhandledRejection:", e));
process.on("uncaughtException", (e) => log("uncaughtException:", e));

server.listen(PORT, async () => {
  log(`AviatorMax Push Server na porta ${PORT} · fontes: ${Object.keys(SOURCES).join(", ")}${DRY_RUN ? " · DRY_RUN" : ""}`);
  await loadSubs();
  startPolling();
  // mantém o Render acordado (reforço — o UptimeRobot é o principal)
  if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => fetch(process.env.RENDER_EXTERNAL_URL + "/health").catch(() => {}), 9 * 60 * 1000);
  }
});
