/* =====================================================================
   Frota Disponível — app online (Firebase)
   Perfis: motorista (identifica-se, fica disponível, pega/devolve carro
   com QR Code + vistoria, reservas, GPS) e administrador.
   ===================================================================== */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, onSnapshot,
  query, where, orderBy, limit, serverTimestamp, runTransaction, writeBatch, arrayUnion, Timestamp, Bytes,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getMessaging, getToken, onMessage, isSupported } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";

window.__frotaOk = true;

/* ================== CONFIGURAÇÃO ================== */
const C = self.FROTA_CONFIG || {};
const CONFIGURADO = !!(C.firebase && C.firebase.apiKey && !String(C.firebase.apiKey).startsWith("COLE"));
const FOTOS_OBRIG = ["Frente", "Traseira", "Lateral esquerda", "Lateral direita", "Painel (km e combustível)"];
const COMBUSTIVEL = ["Reserva", "1/4", "1/2", "3/4", "Cheio"];
const GPS_SEG = C.intervaloGpsSegundos || 60;
const VIDEO_SEG = C.videoMaxSegundos || 15;
const PUSH_SERVIDOR = C.notificacoesPush === true; // só com plano pago (Cloud Functions)

let fb, auth, db, messaging = null;
if (CONFIGURADO) {
  fb = initializeApp(C.firebase);
  auth = getAuth(fb);
  try {
    // Cache local: o app abre e registra dados mesmo sem internet, e sincroniza depois
    db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch (e) {
    db = initializeFirestore(fb, {});
  }
}

/* ================== UTILIDADES ================== */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $("#app");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ms = t => t == null ? null : typeof t === "number" ? t : t instanceof Date ? t.getTime() : t.toMillis ? t.toMillis() : null;
const dados = d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) });
const lista = snap => snap.docs.map(dados);
const porNome = (a, b) => String(a.nome || "").localeCompare(String(b.nome || ""));
const hoje = () => new Date().toLocaleDateString("en-CA"); // AAAA-MM-DD no fuso do aparelho
const pad = n => String(n).padStart(2, "0");
const primeiroNome = n => String(n || "").split(" ")[0];
const soDigitos = t => String(t || "").replace(/\D/g, "");
const slug = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();

function fmt(t) { const v = ms(t); if (!v) return "—"; const d = new Date(v); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fmtCompleto(t) { const v = ms(t); if (!v) return "—"; const d = new Date(v); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function hora(t) { const v = ms(t); if (!v) return "—"; const d = new Date(v); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function ago(t) {
  const v = ms(t); if (!v) return "nunca";
  const min = Math.floor((Date.now() - v) / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "ontem" : `há ${d} dias`;
}
function duracao(a, b) {
  const min = Math.max(0, Math.round((ms(b) - ms(a)) / 60000));
  const h = Math.floor(min / 60);
  return h ? `${h} h ${min % 60} min` : `${min} min`;
}
function distM(a, b) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function waLink(tel, msg) {
  let d = soDigitos(tel);
  if (d && d.length <= 11) d = "55" + d;
  return `https://wa.me/${d}${msg ? "?text=" + encodeURIComponent(msg) : ""}`;
}
function novoCodigo() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c;
  do { c = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(""); }
  while (S.carros.some(x => x.codigo === c));
  return c;
}
function qrDataURL(texto, tamanho = 6) {
  if (!window.qrcode) return "";
  const qr = qrcode(0, "M"); qr.addData(texto); qr.make();
  return qr.createDataURL(tamanho, 2);
}
function getLS(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function setLS(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }

function toast(msg, tempo = 2800) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), tempo);
}
function ocupado(msg) {
  let o = $(".ocupado");
  if (!msg) { o?.remove(); return; }
  if (!o) { o = document.createElement("div"); o.className = "ocupado"; o.innerHTML = "<div></div>"; document.body.appendChild(o); }
  o.firstChild.textContent = msg;
}
function erroMsg(e, padrao) {
  const c = String(e?.code || ""), m = String(e?.message || "");
  if (c.includes("unavailable") || /network|offline|failed to fetch/i.test(c + m)) return "Sem internet. Tente de novo.";
  if (c.includes("permission-denied") || c.includes("unauthorized")) return "Sem permissão para essa ação.";
  if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(c)) return "E-mail ou senha incorretos.";
  if (c === "auth/admin-restricted-operation" || c === "auth/operation-not-allowed") return "Esse tipo de login não está ativado no Firebase (veja o LEIA-ME).";
  if (c === "auth/too-many-requests") return "Muitas tentativas. Aguarde alguns minutos.";
  if (m && !m.startsWith("Firebase")) return m;
  return padrao || "Algo deu errado. Tente de novo.";
}
async function tentar(fn, padrao) {
  try { return await fn(); }
  catch (e) { console.error(e); toast(erroMsg(e, padrao), 4000); return undefined; }
  finally { ocupado(false); }
}
// Gravações simples não esperam o servidor: aparecem na hora e sincronizam quando houver internet
const semEsperar = p => p.catch(e => { console.error(e); toast(erroMsg(e), 4000); });

function modal(html, { onClose } = {}) {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="sheet">${html}</div>`;
  document.body.appendChild(m);
  const fechar = () => { m.remove(); onClose?.(); };
  m.addEventListener("click", e => { if (e.target === m || e.target.closest("[data-fechar]")) fechar(); });
  return { el: m, fechar };
}

/* ================== ESTADO E NAVEGAÇÃO ================== */
const S = {
  user: null, admin: false, me: null,
  carros: [], motoristas: [], usosAtivos: [], reservas: [], usoAtivo: null,
  view: null, live: false, tab: getLS("frota_tab") || "carros",
  subs: [], pushSuportado: false, pushOk: getLS("frota_push") === "1",
};

function go(fn, ...args) { S.view = { fn, args }; S.live = false; window.scrollTo(0, 0); fn(...args); }
let tRender;
function reRender() {
  clearTimeout(tRender);
  tRender = setTimeout(() => { if (S.live && S.view) S.view.fn(...S.view.args); }, 120);
}
function topo(titulo, botoes = []) {
  $("#hTitle").textContent = titulo;
  const box = $("#hBtns"); box.innerHTML = "";
  botoes.forEach(([txt, fn]) => { const b = document.createElement("button"); b.textContent = txt; b.onclick = fn; box.appendChild(b); });
}
function pararOuvintes() { S.subs.forEach(f => f()); S.subs = []; }
function ouvir(q, fn) { S.subs.push(onSnapshot(q, fn, e => console.warn("tempo real:", e))); }
const meRef = () => doc(db, "motoristas", S.user.uid);
const carroDoUso = u => S.carros.find(c => c.id === u.carroId) || { id: u.carroId, nome: u.carroNome, placa: u.placa };

/* ================== INÍCIO ================== */
let promptInstalar = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); promptInstalar = e; $("#btnInstalar")?.classList.remove("hidden"); });

async function iniciar() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(e => console.warn(e));
  if (!CONFIGURADO) return telaSemConfig();
  S.user = await new Promise(r => { const off = onAuthStateChanged(auth, u => { off(); r(u); }); });
  await prepararPush();
  const modo = getLS("frota_modo");
  if (modo === "motorista") return entrarMotorista();
  if (modo === "admin") return entrarAdmin();
  telaInicio();
}

function telaSemConfig() {
  topo("🚗 Frota Disponível");
  app.innerHTML = `<div class="card"><h2>App ainda não configurado</h2>
    <p class="muted">Preencha o arquivo <b>config.js</b> com os dados do seu projeto Firebase. O passo a passo está no arquivo <b>LEIA-ME.txt</b>.</p></div>`;
}

function telaInicio() {
  S.view = null; S.live = false;
  topo("🚗 Frota Disponível");
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const instalado = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  app.innerHTML = `
    <div class="card center">
      <h2>Como você vai usar o app?</h2>
      <p class="muted">Escolha uma vez. Neste aparelho isso fica salvo.</p>
      <button class="btn big" id="goDriver">🧑‍✈️ Sou motorista</button>
      <button class="btn sec" id="goAdmin">🔒 Administrador</button>
    </div>
    <button class="btn sec ${promptInstalar ? "" : "hidden"}" id="btnInstalar">📲 Instalar o app neste celular</button>
    ${ios && !instalado ? `<p class="muted center">No iPhone: toque em <b>Compartilhar</b> e depois em <b>Adicionar à Tela de Início</b> para instalar e receber avisos.</p>` : ""}`;
  $("#goDriver").onclick = entrarMotorista;
  $("#goAdmin").onclick = entrarAdmin;
  $("#btnInstalar").onclick = async () => { if (!promptInstalar) return; promptInstalar.prompt(); await promptInstalar.userChoice; promptInstalar = null; $("#btnInstalar").classList.add("hidden"); };
}

function trocarPerfil() {
  if (!confirm("Voltar para a tela inicial?")) return;
  pararOuvintes(); pararRastreio();
  setLS("frota_modo", null);
  telaInicio();
}

/* ================== NOTIFICAÇÕES (PUSH) ================== */
// Plano grátis: o aviso aparece no celular enquanto o app estiver aberto ou minimizado.
// Plano pago (notificacoesPush: true + Cloud Function): chega mesmo com o app fechado.
async function prepararPush() {
  S.pushSuportado = "Notification" in window && "serviceWorker" in navigator;
  if (S.pushSuportado && !PUSH_SERVIDOR) S.pushOk = Notification.permission === "granted";
  if (!PUSH_SERVIDOR) return;
  try { if (await isSupported()) messaging = getMessaging(fb); } catch (e) { messaging = null; }
  if (!messaging || !C.vapidKey || String(C.vapidKey).startsWith("COLE")) { messaging = null; return; }
  onMessage(messaging, p => {
    // Mensagem que chega com o app aberto
    const d = p.data || p.notification || {};
    toast(`${d.title || "Aviso"} — ${d.body || ""}`, 6000);
    navigator.vibrate?.([200, 100, 200]);
  });
}
async function registrarToken() {
  const reg = await navigator.serviceWorker.ready;
  const token = await getToken(messaging, { vapidKey: C.vapidKey, serviceWorkerRegistration: reg });
  if (token) await updateDoc(meRef(), { tokens: arrayUnion(token) });
  return token;
}
async function ativarAvisos() {
  ocupado("Ativando avisos…");
  const ok = await tentar(async () => {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Permita as notificações para este app nas configurações do celular.");
    return messaging ? !!(await registrarToken()) : true;
  });
  if (ok) {
    S.pushOk = true; setLS("frota_push", "1");
    toast("Pronto! Você recebe aviso de carro liberado quando estiver disponível.", 4000);
    reRender();
  }
}
// Mostra a notificação do próprio celular (funciona com o app aberto ou minimizado)
function notificarLocal(titulo, corpo, tag) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  navigator.serviceWorker?.ready
    .then(r => r.showNotification(titulo, { body: corpo, tag, renotify: true, icon: "icon-192.png", badge: "icon-192.png", vibrate: [200, 100, 200] }))
    .catch(() => {});
}

/* ================== MOTORISTA ================== */
async function entrarMotorista() {
  setLS("frota_modo", "motorista");
  S.admin = false;
  ocupado("Carregando…");
  const ok = await tentar(async () => {
    if (S.user && !S.user.isAnonymous) { await signOut(auth); S.user = null; }
    if (!S.user) S.user = (await signInAnonymously(auth)).user;
    const snap = await getDoc(meRef());
    S.me = snap.exists() ? dados(snap) : null;
    return true;
  });
  if (!ok) { setLS("frota_modo", null); return telaInicio(); }
  if (!S.me) return go(telaIdentificar);
  semEsperar(updateDoc(meRef(), { ultimoUso: serverTimestamp() }));
  if (messaging && S.pushOk && Notification.permission === "granted") registrarToken().catch(() => {});
  ouvirMotorista();
  go(telaMotorista);
}

function ouvirMotorista() {
  pararOuvintes();
  const uid = S.user.uid;
  ouvir(collection(db, "carros"), snap => {
    // Aviso dentro do app quando um carro é liberado
    snap.docChanges().forEach(ch => {
      if (ch.type !== "modified") return;
      const novo = ch.doc.data(), antigo = S.carros.find(c => c.id === ch.doc.id);
      if (novo.status === "disponivel" && antigo && antigo.status !== "disponivel" && S.me?.disponivelEm === hoje() && !S.usoAtivo) {
        toast(`🚗 ${novo.nome} foi liberado!`, 6000);
        navigator.vibrate?.([200, 100, 200]);
        if (!messaging) notificarLocal("🚗 Carro liberado", `${novo.nome}${novo.placa ? " · " + novo.placa : ""} está disponível`, "carro-" + ch.doc.id);
      }
    });
    S.carros = lista(snap).sort(porNome);
    reRender();
  });
  ouvir(meRef(), snap => { if (snap.exists()) { S.me = dados(snap); reRender(); } });
  ouvir(query(collection(db, "usos"), where("motoristaId", "==", uid), where("fim", "==", null)), snap => {
    S.usoAtivo = snap.docs.length ? dados(snap.docs[0]) : null;
    S.usoAtivo ? iniciarRastreio() : pararRastreio();
    reRender();
  });
  ouvir(query(collection(db, "reservas"), where("fim", ">=", Timestamp.now())), snap => {
    S.reservas = lista(snap).filter(r => r.status === "ativa").sort((a, b) => ms(a.inicio) - ms(b.inicio));
    reRender();
  });
}

function telaIdentificar(editar = false) {
  topo(editar ? "Meus dados" : "🧑‍✈️ Motorista", editar ? [["Voltar", () => go(telaMotorista)]] : [["Voltar", trocarPerfil]]);
  app.innerHTML = `
    <div class="card">
      <h2>${editar ? "Meus dados" : "Identifique-se"}</h2>
      ${editar ? "" : `<p class="muted">Faça isso uma única vez. Seus dados ficam salvos neste celular.</p>`}
      <label for="nome">Seu nome</label>
      <input id="nome" autocomplete="name" placeholder="Ex.: João Silva" maxlength="60" value="${esc(S.me?.nome || "")}">
      <label for="tel">WhatsApp (com DDD)</label>
      <input id="tel" type="tel" inputmode="tel" autocomplete="tel" placeholder="Ex.: 11 91234-5678" maxlength="20" value="${esc(S.me?.telefone || "")}">
      <button class="btn" id="salvar">Salvar</button>
    </div>`;
  const salvar = async () => {
    const nome = $("#nome").value.trim().replace(/\s+/g, " ");
    const telefone = $("#tel").value.trim();
    if (nome.length < 2) return toast("Digite seu nome");
    if (telefone && soDigitos(telefone).length < 10) return toast("Confira o WhatsApp com DDD");
    if (editar) {
      semEsperar(updateDoc(meRef(), { nome, telefone }));
      S.me = { ...S.me, nome, telefone };
      toast("Dados atualizados");
      return go(telaMotorista);
    }
    const novo = { nome, telefone, disponivelEm: null, ultimoUso: serverTimestamp(), criadoEm: serverTimestamp(), tokens: [] };
    semEsperar(setDoc(meRef(), novo));
    S.me = { id: S.user.uid, ...novo, ultimoUso: Date.now(), criadoEm: Date.now() };
    toast("Bem-vindo, " + primeiroNome(nome) + "!");
    ouvirMotorista();
    go(telaMotorista);
  };
  $("#salvar").onclick = salvar;
  $("#nome").onkeydown = e => { if (e.key === "Enter") $("#tel").focus(); };
  $("#tel").onkeydown = e => { if (e.key === "Enter") salvar(); };
}

function reservaTxt(r, comNome = true) {
  const mesmoDia = new Date(ms(r.inicio)).toDateString() === new Date().toDateString();
  return `${mesmoDia ? "hoje" : fmt(r.inicio).split(" ")[0]} ${hora(r.inicio)}–${hora(r.fim)}${comNome ? " (" + esc(primeiroNome(r.motoristaNome)) + ")" : ""}`;
}

function telaMotorista() {
  S.live = true;
  const me = S.me;
  if (!me) return go(telaIdentificar);
  topo("🧑‍✈️ " + primeiroNome(me.nome), [["Meus dados", () => go(telaIdentificar, true)], ["Trocar", trocarPerfil]]);
  const disponivel = me.disponivelEm === hoje();
  const u = S.usoAtivo;
  let h = "";

  if (u) {
    const carro = carroDoUso(u);
    h += `
      <div class="card destaque">
        <div class="muted">Você está com</div>
        <h2 style="font-size:22px;margin-bottom:2px">${esc(carro.nome)}</h2>
        <div class="muted">${esc(carro.placa || "")} · desde ${hora(u.inicio)}</div>
        <div class="gps" id="gpsStatus">${gpsTexto()}</div>
        ${u.vistoriaRetirada ? "" : `<button class="btn warn" id="vistRet">📸 Fazer a vistoria de retirada (pendente)</button>`}
        <button class="btn ok" id="devolver">📷 Devolver o carro (ler QR Code)</button>
        ${C.whatsappCentral ? `<a class="btn sec" target="_blank" rel="noopener" href="${waLink(C.whatsappCentral, `Olá, aqui é ${me.nome}. Estou com o ${carro.nome} ${carro.placa || ""}.`)}">💬 Falar com a central</a>` : ""}
        <p class="muted center" style="margin-bottom:0">Deixe o app aberto enquanto estiver com o carro para a localização ser enviada.</p>
      </div>`;
  } else {
    h += `
      <div class="card">
        <div class="status">
          <span class="dot" style="background:${disponivel ? "var(--ok)" : "var(--muted)"}"></span>
          <b>${disponivel ? "Você está DISPONÍVEL hoje" : "Você não está marcado como disponível"}</b>
        </div>
        ${disponivel
          ? `<button class="btn sec" id="toggle">Não estou mais disponível</button>`
          : `<button class="btn ok big" id="toggle">✋ Estou disponível</button>`}
        <p class="muted center" style="margin:10px 0 0">Vale só para hoje. Amanhã é só apertar de novo.</p>
      </div>
      <button class="btn big" id="pegar" style="margin-bottom:14px">📷 Pegar um carro (ler QR Code)</button>`;
  }

  if (S.pushSuportado && !S.pushOk) {
    h += `<div class="card"><h2>🔔 Avisos de carro liberado</h2><p class="muted">Receba um aviso no celular quando um carro for liberado e você estiver disponível${messaging ? "" : " (com o app aberto ou minimizado)"}.</p><button class="btn sec" id="avisos">Ativar avisos</button></div>`;
  } else if (!S.pushSuportado && /iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone) {
    h += `<p class="muted center">Para receber avisos no iPhone, instale o app: <b>Compartilhar → Adicionar à Tela de Início</b>.</p>`;
  }

  const livres = S.carros.filter(c => c.status === "disponivel");
  h += `<div class="card"><h2>Carros disponíveis (${livres.length})</h2>${livres.length ? `<ul class="list">${livres.map(c => {
    const rs = S.reservas.filter(r => r.carroId === c.id).slice(0, 2);
    return `<li class="item"><div class="info">
        <div class="title">${esc(c.nome)}</div>
        <div class="muted">${esc(c.placa || "")}${c.obs ? " · " + esc(c.obs) : ""}</div>
        <div class="muted">Disponível desde ${fmt(c.desde)}</div>
        ${rs.map(r => `<div class="muted">📅 Reservado ${reservaTxt(r)}</div>`).join("")}
      </div><span class="pill ok">Disponível</span></li>`;
  }).join("")}</ul>` : `<div class="empty">Nenhum carro disponível no momento.</div>`}</div>`;

  const minhas = S.reservas.filter(r => r.motoristaId === S.user.uid);
  h += `<div class="card"><h2>📅 Minhas reservas</h2>
    ${minhas.length ? `<ul class="list">${minhas.map(r => `<li class="item"><div class="info"><div class="title">${esc(r.carroNome)}</div><div class="muted">${reservaTxt(r, false)}${r.motivo ? " · " + esc(r.motivo) : ""}</div></div><button class="mini del" data-cancelar="${r.id}">Cancelar</button></li>`).join("")}</ul>` : `<div class="muted" style="margin-bottom:10px">Nenhuma reserva.</div>`}
    <button class="btn sec" id="reservar">Reservar um carro</button></div>`;

  app.innerHTML = h;
  $("#toggle") && ($("#toggle").onclick = () => {
    semEsperar(updateDoc(meRef(), { disponivelEm: disponivel ? null : hoje(), ultimoUso: serverTimestamp() }));
    toast(disponivel ? "Marcado como indisponível" : "Pronto! Você está disponível");
  });
  $("#pegar") && ($("#pegar").onclick = pegarCarro);
  $("#devolver") && ($("#devolver").onclick = devolverCarro);
  $("#vistRet") && ($("#vistRet").onclick = () => go(telaVistoria, { tipo: "retirada", carro: carroDoUso(u), usoId: u.id }));
  $("#avisos") && ($("#avisos").onclick = ativarAvisos);
  $("#reservar").onclick = () => go(telaReservar);
  $$("[data-cancelar]").forEach(b => b.onclick = () => {
    if (!confirm("Cancelar esta reserva?")) return;
    semEsperar(updateDoc(doc(db, "reservas", b.dataset.cancelar), { status: "cancelada" }));
    toast("Reserva cancelada");
  });
}

/* ---------- Pegar e devolver carro (QR Code) ---------- */
function reservaDeOutro(carroId) {
  const agora = Date.now();
  return S.reservas.find(r => r.carroId === carroId && r.motoristaId !== S.user.uid && ms(r.inicio) < agora + 3 * 3600000 && ms(r.fim) > agora);
}

async function pegarCarro() {
  if (S.usoAtivo) return toast("Você já está com um carro");
  const cod = await lerQR("Leia o QR Code do carro");
  if (!cod) return;
  const carro = S.carros.find(c => c.codigo === cod);
  if (!carro) return toast("Nenhum carro com o código " + cod);
  if (carro.status !== "disponivel") return toast(`${carro.nome} não está disponível agora`);
  const r = reservaDeOutro(carro.id);
  if (r && !confirm(`${carro.nome} está reservado para ${r.motoristaNome} ${reservaTxt(r, false)}. Pegar mesmo assim?`)) return;
  if (!navigator.onLine) return toast("Você precisa de internet para pegar o carro");
  ocupado("Registrando…");
  const uid = S.user.uid;
  const usoId = await tentar(() => runTransaction(db, async tx => {
    const cRef = doc(db, "carros", carro.id);
    const c = await tx.get(cRef);
    if (!c.exists() || c.data().status !== "disponivel") throw new Error("Esse carro acabou de ser pego por outra pessoa.");
    const uRef = doc(collection(db, "usos"));
    tx.set(uRef, {
      carroId: carro.id, carroNome: c.data().nome, placa: c.data().placa || "",
      motoristaId: uid, motoristaNome: S.me.nome,
      inicio: serverTimestamp(), fim: null, ultimaPos: null, vistoriaRetirada: false,
    });
    tx.update(cRef, { status: "em_uso", motoristaId: uid, motoristaNome: S.me.nome, usoId: uRef.id, desde: serverTimestamp() });
    tx.update(meRef(), { disponivelEm: null, ultimoUso: serverTimestamp() });
    return uRef.id;
  }));
  if (!usoId) return;
  toast("Carro registrado! Agora faça a vistoria.");
  go(telaVistoria, { tipo: "retirada", carro, usoId });
}

async function devolverCarro() {
  const u = S.usoAtivo; if (!u) return;
  const carro = carroDoUso(u);
  const cod = await lerQR("Leia o QR Code do " + carro.nome);
  if (!cod) return;
  if (carro.codigo && cod !== carro.codigo) return toast("Esse QR Code é de outro carro");
  go(telaVistoria, { tipo: "devolucao", carro, usoId: u.id });
}

function lerQR(titulo) {
  return new Promise(resolve => {
    let stream = null, timer = null, feito = false;
    const m = modal(`
      <h2>${esc(titulo)}</h2>
      <div class="camera"><video playsinline muted></video><div class="mira"></div></div>
      <p class="muted center" id="qrMsg">Abrindo a câmera…</p>
      <label for="qrCod">Ou digite o código que está embaixo do QR Code</label>
      <div class="row"><input id="qrCod" maxlength="6" placeholder="Ex.: K7M2QX" style="text-transform:uppercase" autocomplete="off"><button class="mini ok" id="qrOk" style="flex:0 0 auto;margin-bottom:10px">OK</button></div>
      <button class="btn sec" data-fechar>Cancelar</button>`, { onClose: () => fim(null) });
    function fim(cod) {
      if (feito) return; feito = true;
      clearInterval(timer);
      stream?.getTracks().forEach(t => t.stop());
      m.el.remove();
      resolve(cod);
    }
    const video = $("video", m.el), msg = $("#qrMsg", m.el);
    $("#qrOk", m.el).onclick = () => {
      const v = $("#qrCod", m.el).value.trim().toUpperCase();
      v.length === 6 ? fim(v) : toast("O código tem 6 letras/números");
    };
    const ler = txt => {
      const r = /^(?:FROTA:)?([A-Z0-9]{6})$/i.exec(String(txt).trim());
      if (r) { navigator.vibrate?.(80); fim(r[1].toUpperCase()); }
    };
    if (!navigator.mediaDevices?.getUserMedia) { msg.textContent = "Câmera indisponível aqui. Digite o código abaixo."; return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }).then(async s => {
      if (feito) return s.getTracks().forEach(t => t.stop());
      stream = s; video.srcObject = s;
      await video.play().catch(() => {});
      msg.textContent = "Aponte para o QR Code";
      let det = null;
      try { if ("BarcodeDetector" in window && (await BarcodeDetector.getSupportedFormats()).includes("qr_code")) det = new BarcodeDetector({ formats: ["qr_code"] }); } catch (e) {}
      const cv = document.createElement("canvas"), ctx = cv.getContext("2d", { willReadFrequently: true });
      timer = setInterval(async () => {
        if (feito || video.readyState < 2) return;
        try {
          if (det) { const r = await det.detect(video); if (r[0]) ler(r[0].rawValue); }
          else if (window.jsQR) {
            const k = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
            cv.width = video.videoWidth * k; cv.height = video.videoHeight * k;
            ctx.drawImage(video, 0, 0, cv.width, cv.height);
            const r = jsQR(ctx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height);
            if (r) ler(r.data);
          }
        } catch (e) {}
      }, 300);
    }).catch(() => { msg.textContent = "Não foi possível abrir a câmera. Digite o código abaixo."; });
  });
}

/* ---------- Vistoria (fotos + vídeo + km + local) ---------- */
function telaVistoria(V) {
  V.fotos = V.fotos || {}; V.extras = V.extras || []; V.video = V.video || null; V.pos = V.pos || null;
  const ret = V.tipo === "retirada";
  topo(ret ? "📸 Vistoria de retirada" : "📸 Vistoria de devolução", [["Voltar", () => { if (confirm("Sair sem salvar a vistoria?")) go(telaMotorista); }]]);
  app.innerHTML = `
    <div class="card">
      <h2 style="margin-bottom:2px">${esc(V.carro.nome)}</h2>
      <div class="muted">${esc(V.carro.placa || "")}</div>
      <div class="muted" id="vPos">📍 Pegando a localização…</div>
    </div>
    <div class="card"><h2>Fotos obrigatórias</h2>
      <p class="muted">Toque em cada quadro para tirar a foto. Data, hora e local ficam gravados na imagem.</p>
      <div class="fotos">${FOTOS_OBRIG.map((r, i) => `<button class="slot" data-i="${i}"><span class="ph">📷</span><span>${esc(r)}</span></button>`).join("")}</div>
    </div>
    <div class="card"><h2>Avarias / outras fotos</h2>
      <div class="fotos" id="extras"></div>
      <button class="btn sec" id="addExtra">＋ Adicionar foto</button>
    </div>
    <div class="card"><h2>Vídeo ${C.videoObrigatorio === false ? "(opcional)" : ""}</h2>
      <p class="muted">Dê uma volta em torno do carro filmando (até ${VIDEO_SEG} segundos).</p>
      <div id="vidBox"></div>
      <button class="btn sec" id="gravar">🎥 Gravar vídeo</button>
    </div>
    <div class="card"><h2>Dados</h2>
      <label for="vKm">Quilometragem (km)</label>
      <input id="vKm" type="number" inputmode="numeric" min="0" placeholder="Ex.: 45230">
      <label for="vComb">Combustível</label>
      <select id="vComb">${COMBUSTIVEL.map(c => `<option>${c}</option>`).join("")}</select>
      <label for="vObs">Observações</label>
      <input id="vObs" maxlength="300" placeholder="Ex.: risco na porta traseira">
    </div>
    <button class="btn ok big" id="salvarVist">✅ ${ret ? "Salvar vistoria" : "Salvar e devolver o carro"}</button>
    <input type="file" id="camFoto" accept="image/*" capture="environment" class="hidden">`;

  navigator.geolocation?.getCurrentPosition(
    p => { V.pos = { lat: p.coords.latitude, lng: p.coords.longitude, precisao: Math.round(p.coords.accuracy) }; const el = $("#vPos"); if (el) el.textContent = `📍 Local registrado (precisão de ${V.pos.precisao} m)`; },
    () => { const el = $("#vPos"); if (el) el.textContent = "📍 Localização não disponível (verifique a permissão de localização)"; },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });

  let alvo = null;
  const cam = $("#camFoto");
  const desenharExtras = () => {
    $("#extras").innerHTML = V.extras.map((f, i) => `<button class="slot ok" data-x="${i}"><img src="${f.url}" alt=""><span>Extra ${i + 1} ✕</span></button>`).join("");
    $$("[data-x]").forEach(b => b.onclick = () => { if (confirm("Remover esta foto?")) { V.extras.splice(+b.dataset.x, 1); desenharExtras(); } });
  };
  const desenharSlot = i => {
    const r = FOTOS_OBRIG[i], f = V.fotos[r], b = $(`.slot[data-i="${i}"]`);
    if (f) { b.classList.add("ok"); b.innerHTML = `<img src="${f.url}" alt=""><span>${esc(r)}</span>`; }
  };
  FOTOS_OBRIG.forEach((_, i) => desenharSlot(i));
  desenharExtras();
  if (V.video) $("#vidBox").innerHTML = `<video class="preview" src="${V.video.url}" controls playsinline></video>`;

  $$(".slot[data-i]").forEach(b => b.onclick = () => { alvo = +b.dataset.i; cam.value = ""; cam.click(); });
  $("#addExtra").onclick = () => { alvo = "extra"; cam.value = ""; cam.click(); };
  cam.onchange = async () => {
    const file = cam.files[0]; if (!file) return;
    const rotulo = alvo === "extra" ? `Avaria/extra ${V.extras.length + 1}` : FOTOS_OBRIG[alvo];
    ocupado("Processando foto…");
    const blob = await tentar(() => carimbarFoto(file, rotulo, V.carro, V.pos));
    if (!blob) return;
    const item = { blob, url: URL.createObjectURL(blob) };
    if (alvo === "extra") { V.extras.push(item); desenharExtras(); }
    else { V.fotos[FOTOS_OBRIG[alvo]] = item; desenharSlot(alvo); }
  };
  $("#gravar").onclick = async () => {
    const v = await gravarVideo();
    if (!v) return;
    V.video = { ...v, url: URL.createObjectURL(v.blob) };
    $("#vidBox").innerHTML = `<video class="preview" src="${V.video.url}" controls playsinline></video>`;
    $("#gravar").textContent = "🎥 Gravar de novo";
  };
  $("#salvarVist").onclick = () => salvarVistoria(V);
}

function carregarImagem(file) {
  return new Promise((ok, erro) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => erro(new Error("Não foi possível ler a foto"));
    img.src = URL.createObjectURL(file);
  });
}
async function carimbarFoto(file, rotulo, carro, pos) {
  const img = await carregarImagem(file);
  const max = 1280, k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(img.src);
  // Faixa com placa, tipo da foto, data/hora e coordenadas
  const fs = Math.max(14, Math.round(w / 45)), barra = fs * 2.9;
  ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.fillRect(0, h - barra, w, barra);
  ctx.fillStyle = "#fff"; ctx.font = `bold ${fs}px system-ui, sans-serif`;
  ctx.fillText(`${carro.placa || carro.nome} · ${rotulo}`, fs * .6, h - barra + fs * 1.25);
  ctx.font = `${Math.round(fs * .85)}px system-ui, sans-serif`;
  ctx.fillText(`${fmtCompleto(Date.now())}${pos ? ` · ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}` : ""}`, fs * .6, h - barra + fs * 2.45);
  // Comprime até ficar leve (o plano grátis tem 1 GB no total)
  const jpeg = q => new Promise((ok, erro) => cv.toBlob(b => b ? ok(b) : erro(new Error("Falha ao processar a foto")), "image/jpeg", q));
  let q = 0.7, blob = await jpeg(q);
  while (blob.size > 350 * 1024 && q > 0.35) { q -= 0.1; blob = await jpeg(q); }
  return blob;
}

function gravarVideo() {
  return new Promise(resolve => {
    let stream = null, rec = null, partes = [], timer = null, seg = 0, feito = false;
    const m = modal(`
      <h2>🎥 Vídeo do carro</h2>
      <div class="camera"><video playsinline muted autoplay></video><div class="rec hidden" id="recInd">● <span id="recSeg">0</span>s / ${VIDEO_SEG}s</div></div>
      <p class="muted center" id="vidMsg">Abrindo a câmera…</p>
      <button class="btn bad hidden" id="recBtn">● Começar a gravar</button>
      <button class="btn sec" id="vidArquivo">Usar a câmera do celular</button>
      <button class="btn sec" data-fechar>Cancelar</button>
      <input type="file" accept="video/*" capture="environment" class="hidden" id="vidFile">`, { onClose: () => fim(null) });
    function fim(r) {
      if (feito) return; feito = true;
      clearInterval(timer);
      try { if (rec && rec.state === "recording") rec.stop(); } catch (e) {}
      stream?.getTracks().forEach(t => t.stop());
      m.el.remove();
      resolve(r);
    }
    const video = $("video", m.el), btn = $("#recBtn", m.el), msg = $("#vidMsg", m.el);
    $("#vidArquivo", m.el).onclick = () => $("#vidFile", m.el).click();
    $("#vidFile", m.el).onchange = e => {
      const f = e.target.files[0]; if (!f) return;
      if (f.size > 8 * 1024 * 1024) return toast("Vídeo muito grande. Use o botão de gravar do app ou grave um vídeo mais curto.", 5000);
      fim({ blob: f, ext: (f.name.split(".").pop() || "mp4").toLowerCase() });
    };
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { msg.textContent = "Use o botão abaixo para gravar com a câmera do celular."; return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 854 }, height: { ideal: 480 } }, audio: true }).then(s => {
      if (feito) return s.getTracks().forEach(t => t.stop());
      stream = s; video.srcObject = s;
      msg.textContent = `Toque em gravar e dê uma volta no carro (máx. ${VIDEO_SEG}s).`;
      btn.classList.remove("hidden");
    }).catch(() => { msg.textContent = "Não foi possível abrir a câmera aqui. Use o botão abaixo."; });
    btn.onclick = () => {
      if (rec && rec.state === "recording") return rec.stop();
      const tipos = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp8,opus", "video/webm"];
      const mime = tipos.find(t => MediaRecorder.isTypeSupported?.(t)) || "";
      rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 500000, audioBitsPerSecond: 32000 });
      partes = [];
      rec.ondataavailable = e => { if (e.data.size) partes.push(e.data); };
      rec.onstop = () => {
        clearInterval(timer);
        if (feito) return;
        const tipo = (rec.mimeType || mime || "video/webm").split(";")[0];
        fim({ blob: new Blob(partes, { type: tipo }), ext: tipo.includes("mp4") ? "mp4" : "webm" });
      };
      rec.start(1000); seg = 0;
      $("#recInd", m.el).classList.remove("hidden");
      btn.textContent = "■ Parar e usar este vídeo";
      timer = setInterval(() => { seg++; $("#recSeg", m.el).textContent = seg; if (seg >= VIDEO_SEG) rec.stop(); }, 1000);
    };
  });
}

/* Fotos e vídeos ficam no próprio Firestore (plano grátis), em pedaços de até 900 KB */
const PEDACO = 900 * 1024;
async function salvarMidia(blob, usoId, progresso) {
  const grupo = doc(collection(db, "midias")).id;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const partes = Math.max(1, Math.ceil(bytes.length / PEDACO));
  const mime = (blob.type || "application/octet-stream").split(";")[0];
  for (let i = 0; i < partes; i++) {
    progresso?.(Math.round(i / partes * 100));
    await setDoc(doc(db, "midias", `${grupo}_${i}`), {
      grupo, parte: i, partes, mime, usoId, motoristaId: S.user.uid,
      dados: Bytes.fromUint8Array(bytes.subarray(i * PEDACO, (i + 1) * PEDACO)),
      criadoEm: serverTimestamp(),
    });
  }
  return { grupo, partes, mime };
}
async function carregarMidia(m) {
  if (!m?.grupo) return null;
  const docs = await Promise.all(Array.from({ length: m.partes }, (_, i) => getDoc(doc(db, "midias", `${m.grupo}_${i}`))));
  if (docs.some(d => !d.exists())) return null; // apagada na limpeza
  return URL.createObjectURL(new Blob(docs.map(d => d.data().dados.toUint8Array()), { type: m.mime }));
}

async function salvarVistoria(V) {
  const faltam = FOTOS_OBRIG.filter(r => !V.fotos[r]);
  if (faltam.length) return toast("Falta a foto: " + faltam[0]);
  if (C.videoObrigatorio !== false && !V.video) return toast("Grave o vídeo do carro");
  const km = parseInt($("#vKm").value, 10);
  if (!(km >= 0)) return toast("Informe a quilometragem");
  if (!navigator.onLine) return toast("Sem internet. Conecte-se para enviar a vistoria.", 4000);
  const uid = S.user.uid;
  const arquivos = [
    ...FOTOS_OBRIG.map(r => ({ rotulo: r, ...V.fotos[r] })),
    ...V.extras.map((f, i) => ({ rotulo: `Avaria/extra ${i + 1}`, ...f })),
  ];
  const total = arquivos.length + (V.video ? 1 : 0);
  let n = 0;
  const ok = await tentar(async () => {
    const fotos = [];
    for (const f of arquivos) {
      ocupado(`Enviando foto ${++n} de ${total}…`);
      fotos.push({ rotulo: f.rotulo, ...(await salvarMidia(f.blob, V.usoId)) });
    }
    let video = null;
    if (V.video) {
      ++n;
      ocupado("Enviando vídeo…");
      const blob = V.video.blob.type ? V.video.blob : new Blob([V.video.blob], { type: "video/" + V.video.ext });
      video = await salvarMidia(blob, V.usoId, p => ocupado(`Enviando vídeo… ${p}%`));
    }
    ocupado("Salvando…");
    const batch = writeBatch(db);
    batch.set(doc(collection(db, "vistorias")), {
      usoId: V.usoId, carroId: V.carro.id, carroNome: V.carro.nome, placa: V.carro.placa || "",
      motoristaId: uid, motoristaNome: S.me?.nome || "", tipo: V.tipo,
      km, combustivel: $("#vComb").value, obs: $("#vObs").value.trim(),
      lat: V.pos?.lat ?? null, lng: V.pos?.lng ?? null, fotos, video, criadoEm: serverTimestamp(),
    });
    const usoRef = doc(db, "usos", V.usoId);
    if (V.tipo === "retirada") {
      batch.update(usoRef, { vistoriaRetirada: true });
    } else {
      batch.update(usoRef, { fim: serverTimestamp() });
      batch.update(doc(db, "carros", V.carro.id), { status: "disponivel", motoristaId: null, motoristaNome: null, usoId: null, desde: serverTimestamp() });
    }
    batch.update(meRef(), { ultimoUso: serverTimestamp() });
    await batch.commit();
    return true;
  }, "Não foi possível enviar a vistoria. Tente de novo.");
  if (!ok) return;
  if (V.tipo === "devolucao") { pararRastreio(); toast("Carro devolvido. Obrigado!", 4000); }
  else toast("Vistoria salva. Boa viagem!", 4000);
  go(telaMotorista);
}

/* ---------- Rastreamento por GPS do celular ---------- */
const GPS = { watch: null, ultimoEnvio: 0, ultima: null, erro: "", lock: null };
function gpsTexto() {
  if (!navigator.geolocation) return "📍 Este celular não tem GPS disponível no navegador";
  if (GPS.erro) return "⚠️ " + GPS.erro;
  if (GPS.ultima) return `📍 Localização enviada ${ago(GPS.ultima.t)}`;
  return "📍 Buscando sinal de GPS…";
}
function atualizarGps() { const el = $("#gpsStatus"); if (el) el.textContent = gpsTexto(); }
setInterval(atualizarGps, 30000);

function iniciarRastreio() {
  if (GPS.watch != null || !navigator.geolocation) return;
  GPS.watch = navigator.geolocation.watchPosition(posicaoGps, e => {
    GPS.erro = e.code === 1 ? "Permita o acesso à localização para este app" : "Sem sinal de GPS";
    atualizarGps();
  }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 60000 });
  manterTelaLigada();
}
function pararRastreio() {
  if (GPS.watch != null) navigator.geolocation.clearWatch(GPS.watch);
  GPS.watch = null; GPS.ultima = null; GPS.ultimoEnvio = 0;
  GPS.lock?.release?.().catch(() => {}); GPS.lock = null;
}
function posicaoGps(p) {
  if (!S.usoAtivo) return;
  GPS.erro = "";
  const { latitude: lat, longitude: lng, accuracy, speed } = p.coords;
  const agora = Date.now();
  const dist = GPS.ultima ? distM(GPS.ultima, { lat, lng }) : Infinity;
  const passou = agora - GPS.ultimoEnvio;
  // Envia a cada intervalo (ou antes, se andou bastante). Parado, envia no máximo a cada 5 min.
  if (passou < GPS_SEG * 1000 && dist < 200) return atualizarGps();
  if (dist < 30 && passou < 5 * 60000) return atualizarGps();
  GPS.ultimoEnvio = agora; GPS.ultima = { lat, lng, t: agora };
  const ponto = { lat, lng, precisao: Math.round(accuracy || 0), velocidade: speed ?? null, t: Timestamp.fromMillis(agora) };
  const usoRef = doc(db, "usos", S.usoAtivo.id);
  addDoc(collection(usoRef, "pontos"), ponto).catch(e => console.warn(e));
  updateDoc(usoRef, { ultimaPos: ponto }).catch(e => console.warn(e));
  atualizarGps();
}
async function manterTelaLigada() {
  try { if ("wakeLock" in navigator && !GPS.lock) { GPS.lock = await navigator.wakeLock.request("screen"); GPS.lock.addEventListener("release", () => { GPS.lock = null; }); } } catch (e) {}
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (GPS.watch != null) manterTelaLigada();
  reRender();
});

/* ---------- Reservas ---------- */
function telaReservar() {
  topo("📅 Reservar carro", [["Voltar", () => go(telaMotorista)]]);
  const carros = S.carros.filter(c => c.status !== "indisponivel");
  if (!carros.length) { app.innerHTML = `<div class="card empty">Nenhum carro cadastrado para reservar.</div>`; return; }
  app.innerHTML = `
    <div class="card">
      <label for="rCarro">Carro</label>
      <select id="rCarro">${carros.map(c => `<option value="${c.id}">${esc(c.nome)}${c.placa ? " · " + esc(c.placa) : ""}</option>`).join("")}</select>
      <label for="rData">Data</label>
      <input id="rData" type="date" value="${hoje()}" min="${hoje()}">
      <div class="row">
        <div><label for="rIni">Das</label><input id="rIni" type="time" value="08:00"></div>
        <div><label for="rFim">Até</label><input id="rFim" type="time" value="12:00"></div>
      </div>
      <label for="rMot">Motivo</label>
      <input id="rMot" maxlength="120" placeholder="Ex.: visita ao cliente">
      <button class="btn" id="rSalvar">Reservar</button>
    </div>
    <div class="card"><h2>Reservas deste carro no dia</h2><div id="rLista"></div></div>`;
  const listar = () => {
    const id = $("#rCarro").value, dia = $("#rData").value;
    const rs = S.reservas.filter(r => r.carroId === id && new Date(ms(r.inicio)).toLocaleDateString("en-CA") === dia);
    $("#rLista").innerHTML = rs.length
      ? `<ul class="list">${rs.map(r => `<li class="item"><div class="info"><div class="title">${hora(r.inicio)}–${hora(r.fim)}</div><div class="muted">${esc(r.motoristaNome)}${r.motivo ? " · " + esc(r.motivo) : ""}</div></div></li>`).join("")}</ul>`
      : `<div class="muted">Livre o dia todo.</div>`;
  };
  $("#rCarro").onchange = listar; $("#rData").onchange = listar; listar();
  $("#rSalvar").onclick = () => {
    const carro = S.carros.find(c => c.id === $("#rCarro").value), dia = $("#rData").value;
    const ini = new Date(`${dia}T${$("#rIni").value}`), fim = new Date(`${dia}T${$("#rFim").value}`);
    if (isNaN(ini) || isNaN(fim)) return toast("Confira a data e os horários");
    if (fim <= ini) return toast("O horário final precisa ser depois do inicial");
    if (ini.getTime() < Date.now() - 10 * 60000) return toast("Escolha um horário no futuro");
    const choque = S.reservas.find(r => r.carroId === carro.id && ms(r.inicio) < fim.getTime() && ms(r.fim) > ini.getTime());
    if (choque) return toast(`Já reservado ${reservaTxt(choque)}`, 4000);
    semEsperar(addDoc(collection(db, "reservas"), {
      carroId: carro.id, carroNome: carro.nome, motoristaId: S.user.uid, motoristaNome: S.me.nome,
      inicio: Timestamp.fromDate(ini), fim: Timestamp.fromDate(fim), motivo: $("#rMot").value.trim(),
      status: "ativa", criadoEm: serverTimestamp(),
    }));
    toast("Reserva feita!");
    go(telaMotorista);
  };
}

/* ================== ADMINISTRADOR ================== */
async function entrarAdmin() {
  setLS("frota_modo", "admin");
  if (!S.user || S.user.isAnonymous) return go(telaLogin);
  ocupado("Carregando…");
  let ehAdmin;
  try { ehAdmin = (await getDoc(doc(db, "admins", S.user.uid))).exists(); }
  catch (e) { ehAdmin = getLS("frota_admin_uid") === S.user.uid; } // sem internet: usa o que já sabia
  ocupado(false);
  if (!ehAdmin) {
    toast("Este usuário não é administrador", 4000);
    await signOut(auth).catch(() => {}); S.user = null;
    return go(telaLogin);
  }
  setLS("frota_admin_uid", S.user.uid);
  S.admin = true;
  ouvirAdmin();
  go(telaAdmin);
}

function telaLogin() {
  topo("🔒 Administrador", [["Voltar", () => { setLS("frota_modo", null); telaInicio(); }]]);
  app.innerHTML = `
    <div class="card">
      <h2>Entrar</h2>
      <p class="muted">Use o e-mail e a senha de administrador. Você só precisa entrar uma vez neste aparelho.</p>
      <label for="lEmail">E-mail</label>
      <input id="lEmail" type="email" autocomplete="username" inputmode="email">
      <label for="lSenha">Senha</label>
      <input id="lSenha" type="password" autocomplete="current-password">
      <button class="btn" id="lEntrar">Entrar</button>
    </div>`;
  const entrar = async () => {
    const email = $("#lEmail").value.trim(), senha = $("#lSenha").value;
    if (!email || !senha) return toast("Preencha e-mail e senha");
    if (S.user?.isAnonymous && !confirm("Este aparelho está identificado como motorista. Entrar como administrador desconecta o motorista deste aparelho. Continuar?")) return;
    ocupado("Entrando…");
    const u = await tentar(async () => (await signInWithEmailAndPassword(auth, email, senha)).user);
    if (u) { S.user = u; entrarAdmin(); }
  };
  $("#lEntrar").onclick = entrar;
  $("#lSenha").onkeydown = e => { if (e.key === "Enter") entrar(); };
}

function ouvirAdmin() {
  pararOuvintes();
  ouvir(collection(db, "carros"), s => { S.carros = lista(s).sort(porNome); reRender(); });
  ouvir(collection(db, "motoristas"), s => { S.motoristas = lista(s).sort(porNome); reRender(); });
  ouvir(query(collection(db, "usos"), where("fim", "==", null)), s => { S.usosAtivos = lista(s); reRender(); atualizarMapa(); });
  ouvir(query(collection(db, "reservas"), where("fim", ">=", Timestamp.now())), s => {
    S.reservas = lista(s).filter(r => r.status === "ativa").sort((a, b) => ms(a.inicio) - ms(b.inicio));
    reRender();
  });
}

const ABAS = [["carros", "🚗 Carros"], ["motoristas", "🧑‍✈️ Motoristas"], ["mapa", "🗺️ Mapa"], ["historico", "📄 Histórico"], ["reservas", "📅 Reservas"], ["ajustes", "⚙️ Ajustes"]];

function telaAdmin() {
  const tab = S.tab;
  S.live = ["carros", "motoristas", "reservas"].includes(tab);
  topo("🛠️ Administração");
  const dias = +(getLS("frota_dias_alerta") || 3);
  const inativos = S.motoristas.filter(m => Date.now() - (ms(m.ultimoUso) || ms(m.criadoEm) || 0) > dias * 864e5);
  const livres = S.carros.filter(c => c.status === "disponivel").length;
  const dispHoje = S.motoristas.filter(m => m.disponivelEm === hoje()).length;

  let h = "";
  if (inativos.length) {
    h += `<div class="alert"><b>⚠️ ${inativos.length} motorista${inativos.length > 1 ? "s" : ""} sem usar o app há mais de ${dias} dias</b>
      ${inativos.map(m => `${esc(m.nome)} (último uso ${ago(m.ultimoUso)})`).join("<br>")}</div>`;
  }
  h += `<div class="tabs">${ABAS.map(([k, t]) => {
    const n = k === "carros" ? ` ${livres}/${S.carros.length}` : k === "motoristas" ? ` ${dispHoje}/${S.motoristas.length}` : k === "mapa" ? ` ${S.usosAtivos.length}` : "";
    return `<button data-t="${k}" class="${tab === k ? "on" : ""}">${t}${n}</button>`;
  }).join("")}</div><div id="aba"></div>`;
  app.innerHTML = h;
  $$(".tabs button").forEach(b => b.onclick = () => { S.tab = b.dataset.t; setLS("frota_tab", S.tab); go(telaAdmin); });
  ({ carros: abaCarros, motoristas: abaMotoristas, mapa: abaMapa, historico: abaHistorico, reservas: abaReservas, ajustes: abaAjustes }[tab] || abaCarros)($("#aba"));
}

/* ---------- Aba Carros ---------- */
function abaCarros(el) {
  const ordem = { disponivel: 0, em_uso: 1, indisponivel: 2 };
  const carros = [...S.carros].sort((a, b) => (ordem[a.status] - ordem[b.status]) || porNome(a, b));
  const pill = { disponivel: `<span class="pill ok">Disponível</span>`, em_uso: `<span class="pill uso">Em uso</span>`, indisponivel: `<span class="pill off">Indisponível</span>` };
  el.innerHTML = `
    <div class="row acoes"><button class="btn" id="novoCarro">＋ Cadastrar carro</button><button class="btn sec" id="qrTodos">🖨️ QR Codes</button></div>
    <div class="card">${carros.length ? `<ul class="list">${carros.map(c => {
      const prox = S.reservas.find(r => r.carroId === c.id);
      return `<li class="item" data-id="${c.id}">
        <div class="info">
          <div class="title">${esc(c.nome)} ${pill[c.status] || ""}</div>
          <div class="muted">${esc(c.placa || "sem placa")} · código <b>${esc(c.codigo)}</b>${c.obs ? " · " + esc(c.obs) : ""}</div>
          ${c.status === "disponivel" ? `<div class="muted">Liberado ${fmt(c.desde)}</div>` : ""}
          ${c.status === "em_uso" ? `<div class="muted">Com <b>${esc(c.motoristaNome)}</b> desde ${fmt(c.desde)}</div>` : ""}
          ${prox ? `<div class="muted">📅 Próxima reserva: ${reservaTxt(prox)}</div>` : ""}
        </div>
        <div class="acts">
          ${c.status === "indisponivel" ? `<button class="mini ok" data-a="liberar">Liberar</button>` : ""}
          ${c.status === "disponivel" ? `<button class="mini" data-a="indisp">Tirar de uso</button>` : ""}
          ${c.status === "em_uso" ? `<button class="mini" data-a="mapa">Ver no mapa</button><button class="mini" data-a="encerrar">Encerrar uso</button>` : ""}
          <button class="mini" data-a="qr">QR</button>
          <button class="mini" data-a="editar">Editar</button>
          <button class="mini del" data-a="excluir" title="Excluir">✕</button>
        </div></li>`;
    }).join("")}</ul>` : `<div class="empty">Nenhum carro cadastrado. Toque em “Cadastrar carro”.</div>`}</div>`;
  $("#novoCarro").onclick = () => go(telaCarroForm, null);
  $("#qrTodos").onclick = () => go(telaEtiquetas, S.carros);
  $$("[data-a]", el).forEach(b => b.onclick = () => acaoCarro(b.dataset.a, S.carros.find(c => c.id === b.closest("[data-id]").dataset.id)));
}

function acaoCarro(a, c) {
  if (!c) return;
  const ref = doc(db, "carros", c.id);
  if (a === "liberar") {
    semEsperar(updateDoc(ref, { status: "disponivel", desde: serverTimestamp(), motoristaId: null, motoristaNome: null, usoId: null }));
    toast(`${c.nome} liberado. Avisando os motoristas disponíveis…`, 3500);
    avisarWhatsApp(c);
  } else if (a === "indisp") {
    semEsperar(updateDoc(ref, { status: "indisponivel", desde: null }));
    toast(`${c.nome} fora de uso`);
  } else if (a === "mapa") {
    S.tab = "mapa"; S.focoUso = c.usoId; setLS("frota_tab", "mapa"); go(telaAdmin);
  } else if (a === "encerrar") {
    if (!confirm(`Encerrar o uso do ${c.nome} por ${c.motoristaNome}? O carro fica indisponível até você liberar.`)) return;
    const b = writeBatch(db);
    if (c.usoId) b.update(doc(db, "usos", c.usoId), { fim: serverTimestamp(), encerradoPeloAdmin: true });
    b.update(ref, { status: "indisponivel", motoristaId: null, motoristaNome: null, usoId: null, desde: null });
    semEsperar(b.commit());
    toast("Uso encerrado");
  } else if (a === "qr") {
    go(telaEtiquetas, [c]);
  } else if (a === "editar") {
    go(telaCarroForm, c);
  } else if (a === "excluir") {
    if (c.status === "em_uso") return toast("Encerre o uso antes de excluir");
    if (!confirm(`Excluir o carro ${c.nome}? O histórico continua salvo.`)) return;
    semEsperar(deleteDoc(ref));
  }
}

function avisarWhatsApp(c) {
  const alvo = S.motoristas.filter(m => m.disponivelEm === hoje() && m.telefone && !S.usosAtivos.some(u => u.motoristaId === m.id));
  if (!alvo.length) return;
  const txt = m => `Olá ${primeiroNome(m.nome)}! O carro ${c.nome}${c.placa ? " (" + c.placa + ")" : ""} foi liberado e está disponível.`;
  modal(`
    <h2>💬 Avisar também pelo WhatsApp?</h2>
    <p class="muted">Motoristas disponíveis hoje. Toque em cada um para abrir a conversa com a mensagem pronta.</p>
    ${alvo.map(m => `<a class="btn sec" target="_blank" rel="noopener" href="${waLink(m.telefone, txt(m))}">💬 ${esc(m.nome)}</a>`).join("")}
    <button class="btn" data-fechar style="margin-top:10px">Fechar</button>`);
}

function telaCarroForm(c) {
  topo(c ? "Editar carro" : "Cadastrar carro", [["Voltar", () => go(telaAdmin)]]);
  app.innerHTML = `
    <div class="card">
      <label for="cNome">Modelo / apelido</label>
      <input id="cNome" placeholder="Ex.: Gol branco" maxlength="40" value="${esc(c?.nome || "")}">
      <label for="cPlaca">Placa</label>
      <input id="cPlaca" placeholder="ABC1D23" maxlength="8" style="text-transform:uppercase" value="${esc(c?.placa || "")}">
      <label for="cObs">Observação</label>
      <input id="cObs" placeholder="Opcional" maxlength="60" value="${esc(c?.obs || "")}">
      <button class="btn" id="cSalvar">${c ? "Salvar" : "Cadastrar"}</button>
    </div>`;
  $("#cSalvar").onclick = () => {
    const nome = $("#cNome").value.trim(), placa = $("#cPlaca").value.trim().toUpperCase(), obs = $("#cObs").value.trim();
    if (!nome) return toast("Informe o modelo do carro");
    if (c) semEsperar(updateDoc(doc(db, "carros", c.id), { nome, placa, obs }));
    else semEsperar(setDoc(doc(collection(db, "carros")), {
      nome, placa, obs, codigo: novoCodigo(), status: "indisponivel", desde: null,
      motoristaId: null, motoristaNome: null, usoId: null, criadoEm: serverTimestamp(),
    }));
    toast(c ? "Carro atualizado" : "Carro cadastrado. Imprima o QR Code dele.");
    go(telaAdmin);
  };
}

function telaEtiquetas(carros) {
  topo("🖨️ QR Codes", [["Voltar", () => go(telaAdmin)]]);
  app.innerHTML = `
    <div class="no-print acoes"><button class="btn" id="imprimir">🖨️ Imprimir etiquetas</button>
      <p class="muted center">Cole a etiqueta no carro (vidro ou painel). O motorista lê o QR para pegar e devolver.</p></div>
    <div class="etiquetas">${carros.map(c => `
      <div class="etiqueta">
        <div class="et-nome">${esc(c.nome)}</div>
        <div class="et-placa">${esc(c.placa || "")}</div>
        <img src="${qrDataURL("FROTA:" + c.codigo, 8)}" alt="QR Code">
        <div class="et-cod">${esc(c.codigo)}</div>
        <div class="et-inst">Abra o app Frota e leia este código para pegar ou devolver o carro</div>
      </div>`).join("")}</div>`;
  $("#imprimir").onclick = () => window.print();
}

/* ---------- Aba Motoristas ---------- */
function abaMotoristas(el) {
  const dias = +(getLS("frota_dias_alerta") || 3);
  const ordenados = [...S.motoristas].sort((a, b) => ((b.disponivelEm === hoje()) - (a.disponivelEm === hoje())) || porNome(a, b));
  el.innerHTML = `<div class="card"><p class="muted" style="margin-top:0">Os motoristas se cadastram sozinhos pelo app.</p>
    ${ordenados.length ? `<ul class="list">${ordenados.map(m => {
      const uso = S.usosAtivos.find(u => u.motoristaId === m.id);
      const inativo = Date.now() - (ms(m.ultimoUso) || ms(m.criadoEm) || 0) > dias * 864e5;
      return `<li class="item" data-id="${m.id}">
        <div class="info">
          <div class="title">${esc(m.nome)}
            ${uso ? `<span class="pill uso">Com ${esc(uso.carroNome)}</span>` : m.disponivelEm === hoje() ? `<span class="pill ok">Disponível hoje</span>` : ""}
            ${inativo ? `<span class="pill warn">Inativo</span>` : ""}
            ${(m.tokens || []).length ? "" : `<span class="pill off" title="Não ativou as notificações">🔕</span>`}
          </div>
          <div class="muted">${m.telefone ? esc(m.telefone) + " · " : ""}Último uso: ${ago(m.ultimoUso)}</div>
        </div>
        <div class="acts">
          ${m.telefone ? `<a class="mini" target="_blank" rel="noopener" href="${waLink(m.telefone)}">💬 WhatsApp</a>` : ""}
          <button class="mini del" data-del="${m.id}" title="Remover">✕</button>
        </div></li>`;
    }).join("")}</ul>` : `<div class="empty">Nenhum motorista cadastrado ainda.</div>`}</div>`;
  $$("[data-del]", el).forEach(b => b.onclick = () => {
    const m = S.motoristas.find(x => x.id === b.dataset.del);
    if (confirm(`Remover o motorista ${m.nome}?`)) semEsperar(deleteDoc(doc(db, "motoristas", m.id)));
  });
}

/* ---------- Aba Mapa (rastreamento) ---------- */
let MAPA = null, MARCAS = {}, TRAJETO = null;
function abaMapa(el) {
  el.innerHTML = `
    <div class="card pad0"><div id="mapa"></div></div>
    <div class="card"><h2>Carros em uso agora</h2><div id="emUso"></div></div>`;
  MAPA = null; MARCAS = {}; TRAJETO = null;
  if (!window.L) { $("#mapa").innerHTML = `<div class="empty">O mapa precisa de internet para carregar.</div>`; }
  else {
    MAPA = L.map("mapa").setView([-15.78, -47.93], 4);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(MAPA);
    setTimeout(() => MAPA?.invalidateSize(), 200);
  }
  atualizarMapa(true);
  if (S.focoUso) { mostrarTrajeto(S.focoUso); S.focoUso = null; }
}
function iconeCarro(nome) {
  return L.divIcon({ className: "pin", html: `<div class="pin-in">🚗</div><div class="pin-nome">${esc(primeiroNome(nome))}</div>`, iconSize: [40, 44], iconAnchor: [20, 22] });
}
function atualizarMapa(ajustar) {
  const lista = $("#emUso");
  if (lista) {
    lista.innerHTML = S.usosAtivos.length ? `<ul class="list">${S.usosAtivos.map(u => `
      <li class="item"><div class="info">
        <div class="title">${esc(u.carroNome)} · ${esc(u.motoristaNome)}</div>
        <div class="muted">Desde ${fmt(u.inicio)} · ${u.ultimaPos ? "posição " + ago(u.ultimaPos.t) : "sem posição ainda"}</div>
      </div><div class="acts">
        <button class="mini" data-traj="${u.id}">Trajeto</button>
        <button class="mini" data-rel="${u.id}">Relatório</button>
      </div></li>`).join("")}</ul>` : `<div class="empty">Nenhum carro em uso.</div>`;
    $$("[data-traj]", lista).forEach(b => b.onclick = () => mostrarTrajeto(b.dataset.traj));
    $$("[data-rel]", lista).forEach(b => b.onclick = () => go(telaRelatorio, b.dataset.rel));
  }
  if (!MAPA || !document.body.contains(MAPA.getContainer())) { MAPA = null; return; }
  const vistos = new Set();
  S.usosAtivos.forEach(u => {
    const p = u.ultimaPos; if (!p) return;
    vistos.add(u.id);
    const txt = `<b>${esc(u.motoristaNome)}</b><br>${esc(u.carroNome)} ${esc(u.placa || "")}<br>Atualizado ${ago(p.t)}`;
    if (MARCAS[u.id]) MARCAS[u.id].setLatLng([p.lat, p.lng]).setPopupContent(txt);
    else MARCAS[u.id] = L.marker([p.lat, p.lng], { icon: iconeCarro(u.motoristaNome) }).addTo(MAPA).bindPopup(txt);
  });
  Object.keys(MARCAS).forEach(id => { if (!vistos.has(id)) { MARCAS[id].remove(); delete MARCAS[id]; } });
  const pts = Object.values(MARCAS).map(m => m.getLatLng());
  if (ajustar && pts.length) MAPA.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 15 });
}
async function mostrarTrajeto(usoId) {
  if (!MAPA) return;
  const snap = await tentar(() => getDocs(query(collection(db, "usos", usoId, "pontos"), orderBy("t"), limit(3000))));
  if (!snap) return;
  const pts = lista(snap).map(p => [p.lat, p.lng]);
  TRAJETO?.remove();
  if (!pts.length) return toast("Ainda não há pontos de GPS para esse uso");
  TRAJETO = L.polyline(pts, { color: "#1f6feb", weight: 5, opacity: .8 }).addTo(MAPA);
  MAPA.fitBounds(TRAJETO.getBounds().pad(0.2));
  $("#mapa").scrollIntoView({ behavior: "smooth" });
}

/* ---------- Aba Histórico + relatório ---------- */
async function abaHistorico(el) {
  el.innerHTML = `<input id="hBusca" placeholder="🔎 Buscar por carro, placa ou motorista"><div class="card" id="hLista"><div class="empty">Carregando…</div></div>`;
  const snap = await tentar(() => getDocs(query(collection(db, "usos"), orderBy("inicio", "desc"), limit(100))));
  if (!snap || !$("#hLista")) return;
  const usos = lista(snap);
  const desenhar = () => {
    const b = $("#hBusca").value.trim().toLowerCase();
    const f = usos.filter(u => !b || `${u.carroNome} ${u.placa} ${u.motoristaNome}`.toLowerCase().includes(b));
    $("#hLista").innerHTML = f.length ? `<ul class="list">${f.map(u => `
      <li class="item click" data-rel="${u.id}"><div class="info">
        <div class="title">${esc(u.carroNome)} · ${esc(u.motoristaNome)}</div>
        <div class="muted">${fmt(u.inicio)} → ${u.fim ? fmt(u.fim) + " · " + duracao(u.inicio, u.fim) : "em andamento"}</div>
      </div><span class="mini">📄 Relatório</span></li>`).join("")}</ul>` : `<div class="empty">Nenhum uso encontrado.</div>`;
    $$("[data-rel]").forEach(li => li.onclick = () => go(telaRelatorio, li.dataset.rel));
  };
  $("#hBusca").oninput = desenhar;
  desenhar();
}

// As mídias são carregadas depois (data-midia) a partir do Firestore
const midiaAttr = m => esc(JSON.stringify({ grupo: m.grupo, partes: m.partes, mime: m.mime }));
function blocoVistoria(titulo, v) {
  if (!v) return `<h2>${titulo}</h2><p class="muted">Não realizada.</p>`;
  return `<section>
    <h2>${titulo}</h2>
    <p>${fmtCompleto(v.criadoEm)} · Km <b>${esc(v.km)}</b> · Combustível <b>${esc(v.combustivel)}</b>
      ${v.lat != null ? `· <a target="_blank" rel="noopener" href="https://maps.google.com/?q=${v.lat},${v.lng}">📍 ${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}</a>` : ""}</p>
    ${v.obs ? `<p><b>Observações:</b> ${esc(v.obs)}</p>` : ""}
    <div class="grade">${(v.fotos || []).map(f => `<figure><img data-midia="${midiaAttr(f)}" alt="${esc(f.rotulo)}"><figcaption>${esc(f.rotulo)}</figcaption></figure>`).join("")}</div>
    ${v.video ? `<div class="video-bloco">
      <video class="no-print" data-midia="${midiaAttr(v.video)}" controls playsinline preload="metadata"></video>
      <div class="video-qr" style="display:block"><b>🎥 Vídeo da vistoria registrado</b><br>
        <small>Para assistir, abra este relatório no app (Histórico → Relatório).</small></div>
    </div>` : ""}
  </section>`;
}
async function carregarMidiasDaTela() {
  const els = $$("[data-midia]");
  await Promise.all(els.map(async el => {
    const url = await carregarMidia(JSON.parse(el.dataset.midia)).catch(() => null);
    if (url) el.src = url;
    else el.replaceWith(Object.assign(document.createElement("div"), { className: "muted", textContent: "(arquivo apagado na limpeza)" }));
  }));
}

async function telaRelatorio(usoId) {
  topo("📄 Relatório", [["Voltar", () => go(telaAdmin)]]);
  app.innerHTML = `<div class="empty">Carregando relatório…</div>`;
  const r = await tentar(async () => {
    const [u, vs, ps] = await Promise.all([
      getDoc(doc(db, "usos", usoId)),
      getDocs(query(collection(db, "vistorias"), where("usoId", "==", usoId))),
      getDocs(query(collection(db, "usos", usoId, "pontos"), orderBy("t"), limit(3000))),
    ]);
    return { u: dados(u), vs: lista(vs), ps: lista(ps) };
  });
  if (!r) return;
  const { u, vs, ps } = r;
  const ret = vs.find(v => v.tipo === "retirada"), dev = vs.find(v => v.tipo === "devolucao");
  let dist = 0;
  for (let i = 1; i < ps.length; i++) dist += distM(ps[i - 1], ps[i]);
  const kmRodados = ret && dev ? dev.km - ret.km : null;
  app.innerHTML = `
    <div class="no-print acoes"><button class="btn" id="imprimir" disabled>⏳ Carregando fotos…</button></div>
    <article class="relatorio">
      <h1>Relatório de uso do veículo</h1>
      <table class="tab">
        <tr><th>Veículo</th><td>${esc(u.carroNome)} ${esc(u.placa || "")}</td></tr>
        <tr><th>Motorista</th><td>${esc(u.motoristaNome)}</td></tr>
        <tr><th>Retirada</th><td>${fmtCompleto(u.inicio)}</td></tr>
        <tr><th>Devolução</th><td>${u.fim ? fmtCompleto(u.fim) + (u.encerradoPeloAdmin ? " (encerrado pelo administrador)" : "") : "Em andamento"}</td></tr>
        <tr><th>Duração</th><td>${duracao(u.inicio, u.fim || Date.now())}</td></tr>
        <tr><th>Quilometragem</th><td>${ret?.km ?? "—"} → ${dev?.km ?? "—"}${kmRodados != null ? ` <b>(${kmRodados} km rodados)</b>` : ""}</td></tr>
        <tr><th>Combustível</th><td>${esc(ret?.combustivel ?? "—")} → ${esc(dev?.combustivel ?? "—")}</td></tr>
        <tr><th>Trajeto pelo GPS</th><td>${ps.length ? `≈ ${(dist / 1000).toFixed(1)} km · ${ps.length} pontos registrados` : "Sem pontos de GPS"}</td></tr>
      </table>
      ${ps.length ? `<h2>Trajeto</h2><div id="mapaRel" class="mapa-rel"></div>` : ""}
      ${blocoVistoria("Vistoria de retirada", ret)}
      ${blocoVistoria("Vistoria de devolução", dev)}
      <p class="muted rodape">Relatório gerado em ${fmtCompleto(Date.now())}</p>
    </article>`;
  $("#imprimir").onclick = () => window.print();
  carregarMidiasDaTela().finally(() => {
    const b = $("#imprimir");
    if (b) { b.disabled = false; b.textContent = "🖨️ Imprimir / salvar em PDF"; }
  });
  if (ps.length && window.L) {
    const m = L.map("mapaRel", { zoomControl: false, attributionControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(m);
    const linha = L.polyline(ps.map(p => [p.lat, p.lng]), { color: "#1f6feb", weight: 5 }).addTo(m);
    L.circleMarker([ps[0].lat, ps[0].lng], { radius: 8, color: "#1a7f37", fillOpacity: 1 }).addTo(m).bindTooltip("Início");
    const ult = ps[ps.length - 1];
    L.circleMarker([ult.lat, ult.lng], { radius: 8, color: "#c62828", fillOpacity: 1 }).addTo(m).bindTooltip("Fim");
    m.fitBounds(linha.getBounds().pad(0.15));
  }
}

/* ---------- Aba Reservas ---------- */
function abaReservas(el) {
  el.innerHTML = `<div class="card"><h2>Próximas reservas</h2>
    ${S.reservas.length ? `<ul class="list">${S.reservas.map(r => `
      <li class="item"><div class="info">
        <div class="title">${esc(r.carroNome)} · ${esc(r.motoristaNome)}</div>
        <div class="muted">${fmt(r.inicio)} até ${hora(r.fim)}${r.motivo ? " · " + esc(r.motivo) : ""}</div>
      </div><button class="mini del" data-cancelar="${r.id}">Cancelar</button></li>`).join("")}</ul>` : `<div class="empty">Nenhuma reserva.</div>`}</div>`;
  $$("[data-cancelar]", el).forEach(b => b.onclick = () => {
    if (confirm("Cancelar esta reserva?")) semEsperar(updateDoc(doc(db, "reservas", b.dataset.cancelar), { status: "cancelada" }));
  });
}

/* ---------- Aba Ajustes ---------- */
function abaAjustes(el) {
  el.innerHTML = `
    <div class="card">
      <h2>Alerta de inatividade</h2>
      <label for="dias">Avisar quando um motorista ficar sem usar o app por mais de (dias)</label>
      <input id="dias" type="number" min="1" max="60" value="${+(getLS("frota_dias_alerta") || 3)}">
      <button class="btn" id="saveDias">Salvar</button>
    </div>
    <div class="card">
      <h2>Espaço (plano grátis: 1 GB)</h2>
      <p class="muted">Cada uso com vistoria ocupa em média 3 a 5 MB. Apague fotos e vídeos antigos de vez em quando. Os dados (km, horários, trajeto) continuam no histórico.</p>
      <label for="limpDias">Apagar fotos e vídeos com mais de (dias)</label>
      <input id="limpDias" type="number" min="7" max="3650" value="90">
      <button class="btn sec" id="limpar">🧹 Apagar fotos e vídeos antigos</button>
    </div>
    <div class="card">
      <h2>Conta</h2>
      <p class="muted">Conectado como ${esc(S.user?.email || "")}. O login fica salvo neste aparelho.</p>
      <button class="btn bad" id="sair">Sair da administração</button>
    </div>`;
  $("#saveDias").onclick = () => {
    const n = parseInt($("#dias").value, 10);
    if (!(n >= 1 && n <= 60)) return toast("Use entre 1 e 60 dias");
    setLS("frota_dias_alerta", String(n)); toast("Salvo");
  };
  $("#limpar").onclick = async () => {
    const d = parseInt($("#limpDias").value, 10);
    if (!(d >= 7)) return toast("Use no mínimo 7 dias");
    if (!confirm(`Apagar DEFINITIVAMENTE as fotos e vídeos com mais de ${d} dias? Não dá para desfazer.`)) return;
    const limite = Timestamp.fromMillis(Date.now() - d * 864e5);
    let total = 0;
    const ok = await tentar(async () => {
      for (;;) {
        ocupado(`Apagando… ${total} arquivos`);
        const snap = await getDocs(query(collection(db, "midias"), where("criadoEm", "<", limite), limit(100)));
        if (snap.empty) break;
        const b = writeBatch(db);
        snap.docs.forEach(x => b.delete(x.ref));
        await b.commit();
        total += snap.size;
      }
      return true;
    });
    if (ok) toast(total ? `${total} arquivos apagados` : "Nada para apagar", 4000);
  };
  $("#sair").onclick = async () => {
    if (!confirm("Sair da administração? Será preciso digitar e-mail e senha de novo.")) return;
    pararOuvintes();
    await signOut(auth).catch(() => {});
    S.user = null; S.admin = false;
    setLS("frota_modo", null); setLS("frota_admin_uid", null);
    telaInicio();
  };
}

iniciar();
