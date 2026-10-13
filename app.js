/* =====================================================================
   Frota Disponível — app online (Firebase)
   Perfis: motorista (identifica-se, fica disponível, pega/devolve carro
   com QR Code + vistoria, reservas, GPS) e administrador.
   ===================================================================== */
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword, verifyBeforeUpdateEmail, sendPasswordResetEmail,
  createUserWithEmailAndPassword, linkWithCredential, setPersistence, inMemoryPersistence,
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
  auth.languageCode = "pt-BR"; // e-mails de senha/confirmação em português
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
  if (c === "auth/weak-password") return "Senha fraca: use pelo menos 6 caracteres.";
  if (c === "auth/email-already-in-use") return "Esse e-mail já é usado por outra conta.";
  if (c === "auth/requires-recent-login") return "Por segurança, saia e entre de novo antes de fazer isso.";
  if (c === "auth/missing-password") return "Digite a senha.";
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
  carros: [], motoristas: [], admins: [], usosAtivos: [], reservas: [], convites: [], ocorrencias: [], analises: [], usoAtivo: null,
  view: null, live: false, tab: "inicio",   // o painel sempre abre no Início
  resumo: null,
  subs: [], pushSuportado: false, pushOk: getLS("frota_push") === "1",
};

function go(fn, ...args) { S.view = { fn, args }; S.live = false; window.scrollTo(0, 0); fn(...args); }
let tRender;
function reRender() {
  clearTimeout(tRender);
  tRender = setTimeout(() => { if (S.live && S.view) S.view.fn(...S.view.args); }, 120);
}
function topo(titulo, botoes = []) {
  app.classList.remove("largo");   // só o painel do administrador usa a tela larga
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

/* Entrada:
   - link normal ............ motorista (direto, sem tela de escolha)
   - link + #admin .......... administrador (depois do 1º login, o aparelho já abre no painel)
   - link + #carro=CODIGO ... QR Code da etiqueta: abre direto a retirada/devolução daquele carro */
const linkBase = () => location.origin + location.pathname;
const linkCarro = c => `${linkBase()}#carro=${c.codigo}`;
const codigoDoLink = () => { const m = /carro=([A-Z0-9]{6})/i.exec(location.hash); return m ? m[1].toUpperCase() : null; };
const conviteDoLink = () => { const m = /convite=([A-Z0-9]{8})/i.exec(location.hash); return m ? m[1].toUpperCase() : null; };
const linkConvite = cod => `${linkBase()}#convite=${cod}`;
const pedeAdmin = () => /^#admin/i.test(location.hash);
const limparHash = () => history.replaceState(null, "", location.pathname + location.search);

async function iniciar() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(e => console.warn(e));
  if (!CONFIGURADO) return telaSemConfig();
  S.user = await new Promise(r => { const off = onAuthStateChanged(auth, u => { off(); r(u); }); });
  await prepararPush();
  const cod = codigoDoLink(), conv = conviteDoLink();
  if (pedeAdmin() || cod || conv) limparHash();
  S.qrPendente = cod;
  S.convitePendente = conv;
  // Sem sessão: tela de login (com convite, abre direto o cadastro)
  if (!S.user) return conv ? go(telaCadastro, {}) : go(telaLogin);
  // Entrada com digital/rosto ativada neste aparelho: pede antes de mostrar qualquer coisa
  if (bioSalva() && !bioLiberado()) return telaBloqueio(entrarComSessao);
  entrarComSessao();
}

/* ================== LOGIN (usuário e senha para todos) ================== */
// Motorista: "usuário" (sem @). Por dentro, cada usuário vira um e-mail técnico guardado em /logins.
// Administrador: entra com o próprio e-mail.
const normLogin = s => String(s || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, ".").replace(/[^a-z0-9._-]/g, "");
const emailMotorista = login => `m.${login}.${Date.now().toString(36)}@motoristas.frota.app`;
const loginDeEmail = e => (/^m\.(.+)\.[a-z0-9]+@motoristas\.frota\.app$/.exec(String(e || "")) || [])[1] || "";
const loginRef = login => doc(db, "logins", login);
function erroLogin(e) {
  const c = String(e?.code || "");
  if (/invalid-credential|wrong-password|user-not-found|invalid-login/.test(c)) return "Usuário ou senha incorretos.";
  if (/weak-password/.test(c)) return "Senha fraca: use pelo menos 6 caracteres.";
  if (/too-many-requests/.test(c)) return "Muitas tentativas. Aguarde alguns minutos.";
  if (/operation-not-allowed|admin-restricted/.test(c)) return "Login por usuário e senha não está ativado no Firebase (Authentication → Método de login → E-mail/senha).";
  return erroMsg(e);
}
async function entrarComSessao() {
  if (!S.user) return go(telaLogin);
  if (S.user.isAnonymous) return entrarMotorista();   // motorista da versão antiga: vai criar usuário e senha
  let ehAdmin;
  try { ehAdmin = (await getDoc(doc(db, "admins", S.user.uid))).exists(); }
  catch (e) { ehAdmin = getLS("frota_admin_uid") === S.user.uid; }   // sem internet: usa o que já sabia
  return ehAdmin ? entrarAdmin() : entrarMotorista();
}
async function sairDaConta(msg) {
  pararOuvintes(); pararRastreio();
  await signOut(auth).catch(() => {});
  S.user = null; S.me = null; S.admin = false;
  setLS("frota_bio", null); setLS("frota_admin_uid", null); setLS("frota_modo", null);
  go(telaLogin, msg);
}
function olhoSenha(id) {   // 👁 mostrar/esconder senha
  const i = $("#" + id); if (!i) return;
  const b = document.createElement("button"); b.type = "button"; b.className = "olho"; b.textContent = "👁"; b.title = "Mostrar senha";
  b.onclick = () => { const m = i.type === "password"; i.type = m ? "text" : "password"; b.textContent = m ? "🙈" : "👁"; };
  i.parentNode.style.position = "relative"; i.style.paddingRight = "48px"; i.insertAdjacentElement("afterend", b);
}
// Depois de entrar ou criar a conta: oferece a digital/rosto (uma vez)
function sugerirBiometria() {
  if (!bioApi() || bioSalva() || getLS("frota_bio_perguntado")) return;
  setLS("frota_bio_perguntado", "1");
  const m = modal(`<h2>👆 Entrar com digital ou rosto?</h2><p class="muted">Da próxima vez, é só a digital ou o rosto. Sem digitar senha.</p>
    <button class="btn" id="sbSim">Ativar agora</button><button class="btn sec" data-fechar>Agora não</button>`);
  $("#sbSim", m.el).onclick = () => { ativarBiometria(); m.fechar(); };   // a biometria é chamada direto no toque
}
function telaLogin(msg) {
  S.view = null; S.live = false;
  topo("🚗 Frota");
  app.innerHTML = `
    ${msg ? `<div class="alert">${esc(msg)}</div>` : ""}
    <div class="card">
      <h2>Entrar</h2>
      <label for="lUser">Usuário</label>
      <div><input id="lUser" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Seu usuário (administrador: seu e-mail)"></div>
      <label for="lSenha">Senha</label>
      <div><input id="lSenha" type="password" autocomplete="current-password"></div>
      <button class="btn" id="lEntrar">Entrar</button>
      <button class="btn sec" id="lEsqueci">Esqueci minha senha</button>
    </div>
    <div class="card center">
      <p class="muted" style="margin-top:0">Primeiro acesso?</p>
      <button class="btn ok" id="lCriar">✨ Criar minha conta</button>
    </div>
    ${cardInstalar()}`;
  ligarInstalar(); olhoSenha("lSenha");
  $("#lCriar").onclick = () => go(telaCadastro, {});
  $("#lEsqueci").onclick = async () => {
    const u = $("#lUser").value.trim();
    if (u.includes("@")) {
      ocupado("Enviando…");
      const ok = await tentar(async () => { await sendPasswordResetEmail(auth, u); return true; });
      if (ok) toast("Se esse e-mail for de um administrador, chega um link para criar uma nova senha. Veja também o spam.", 7000);
      return;
    }
    modal(`<h2>Esqueci minha senha</h2><p class="muted">Peça ao administrador para criar uma senha nova para você (Administração → Motoristas → Editar).</p>
      ${C.whatsappCentral ? `<a class="btn ok" target="_blank" rel="noopener" href="${waLink(C.whatsappCentral, `Olá! Esqueci a senha do app da frota. Meu usuário é: ${u || "(não lembro)"}`)}">💬 Pedir pelo WhatsApp</a>` : ""}
      <button class="btn sec" data-fechar>Fechar</button>`);
  };
  const entrar = async () => {
    const u = $("#lUser").value.trim(), senha = $("#lSenha").value;
    if (!u || !senha) return toast("Preencha usuário e senha");
    ocupado("Entrando…");
    const user = await tentar(async () => {
      let email = u;
      if (!u.includes("@")) {
        const lk = await getDoc(loginRef(normLogin(u)));
        if (!lk.exists()) throw new Error("Usuário não encontrado. Confira ou toque em \"Criar minha conta\".");
        email = lk.data().email;
      }
      try { return (await signInWithEmailAndPassword(auth, email, senha)).user; }
      catch (e) { throw new Error(erroLogin(e)); }
    });
    if (!user) return;
    S.user = user; marcarLiberado();
    await entrarComSessao();
    sugerirBiometria();
  };
  $("#lEntrar").onclick = entrar;
  $("#lSenha").onkeydown = e => { if (e.key === "Enter") entrar(); };
  $("#lUser").onkeydown = e => { if (e.key === "Enter") $("#lSenha").focus(); };
}

// Cadastro do motorista. modos: novo (sem conta) · upgrade (motorista antigo, sem senha) · completar (falta nome/WhatsApp)
async function telaCadastro(op = {}) {
  S.view = null; S.live = false;
  const upgrade = !!S.user?.isAnonymous, completar = !!(S.user && !S.user.isAnonymous);
  topo(upgrade ? "🔑 Crie seu acesso" : completar ? "Complete seu cadastro" : "✨ Criar conta", completar || upgrade ? [["Sair", () => sairDaConta()]] : [["Voltar", () => go(telaLogin)]]);
  let pre = { nome: S.me?.nome || "", telefone: S.me?.telefone || "" };
  if (!upgrade && !completar && S.convitePendente) {   // convite do administrador: já vem com nome e WhatsApp
    try { const c = await getDoc(doc(db, "convites", S.convitePendente)); if (c.exists() && !c.data().usadoPor) pre = { nome: c.data().nome || "", telefone: c.data().telefone || "" }; } catch (e) {}
  }
  app.innerHTML = `
    ${upgrade ? `<div class="alert"><b>🔑 Novidade: agora o app tem usuário e senha</b>Crie o seu uma única vez. Seu histórico continua o mesmo.</div>` : ""}
    ${completar ? `<div class="alert"><b>Falta pouco</b>Confirme seu nome e WhatsApp.</div>` : ""}
    <div class="card">
      <label for="cNome">Seu nome</label>
      <input id="cNome" autocomplete="name" maxlength="60" placeholder="Ex.: João Silva" value="${esc(pre.nome)}">
      <label for="cTel">WhatsApp (com DDD)</label>
      <input id="cTel" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" placeholder="Ex.: 11 91234-5678" value="${esc(pre.telefone)}">
      ${completar ? "" : `
      <label for="cUser">Crie seu usuário</label>
      <input id="cUser" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="30" placeholder="Ex.: joao.silva">
      <p class="muted" style="margin:-6px 0 10px;font-size:12px">Só letras, números, ponto, traço. Sem espaço.</p>
      <label for="cSenha">Crie uma senha (mínimo 6 caracteres)</label>
      <div><input id="cSenha" type="password" autocomplete="new-password"></div>
      <label for="cSenha2">Repita a senha</label>
      <div><input id="cSenha2" type="password" autocomplete="new-password"></div>`}
      <button class="btn ok" id="cSalvar">${completar ? "Salvar" : "Criar minha conta"}</button>
    </div>`;
  if (!completar) { olhoSenha("cSenha"); olhoSenha("cSenha2"); $("#cUser").oninput = e => { e.target.value = normLogin(e.target.value); }; }
  if (!pre.nome && completar) { const l = loginDeEmail(S.user.email); if (l) $("#cNome").placeholder = "Seu nome (usuário: " + l + ")"; }
  $("#cSalvar").onclick = async () => {
    const nome = $("#cNome").value.trim().replace(/\s+/g, " "), telefone = $("#cTel").value.trim();
    if (nome.length < 2) return toast("Digite seu nome");
    if (soDigitos(telefone).length < 10) return toast("O WhatsApp é obrigatório: confira com DDD");
    let login = completar ? (S.me?.login || loginDeEmail(S.user.email)) : normLogin($("#cUser").value), senha = "";
    if (!completar) {
      senha = $("#cSenha").value;
      if (login.length < 3) return toast("O usuário precisa ter pelo menos 3 letras/números");
      if (senha.length < 6) return toast("A senha precisa ter pelo menos 6 caracteres");
      if (senha !== $("#cSenha2").value) return toast("As duas senhas não são iguais");
    }
    ocupado(completar ? "Salvando…" : "Criando sua conta…");
    const ok = await tentar(async () => {
      if (!completar) {
        if ((await getDoc(loginRef(login))).exists()) throw new Error("Esse usuário já existe. Escolha outro.");
        const email = emailMotorista(login);
        try {
          // motorista antigo: liga o usuário e senha à mesma conta (mantém o histórico)
          S.user = upgrade ? (await linkWithCredential(S.user, EmailAuthProvider.credential(email, senha))).user
                           : (await createUserWithEmailAndPassword(auth, email, senha)).user;
        } catch (e) { throw new Error(erroLogin(e)); }
        await setDoc(loginRef(login), { email, uid: S.user.uid, criadoEm: serverTimestamp() });
      }
      const snap = await getDoc(meRef());
      if (snap.exists()) await updateDoc(meRef(), { nome, telefone, login });
      else await setDoc(meRef(), { nome, telefone, login, disponivelEm: null, ultimoUso: serverTimestamp(), criadoEm: serverTimestamp(), tokens: [] });
      if (S.convitePendente) {
        try { await updateDoc(doc(db, "convites", S.convitePendente), { usadoPor: S.user.uid, usadoEm: serverTimestamp() }); } catch (e) {}
        S.convitePendente = null;
      }
      return true;
    }, "Não foi possível criar a conta. Tente de novo.");
    if (!ok) return;
    marcarLiberado();
    toast(completar ? "Cadastro atualizado" : `Bem-vindo, ${primeiroNome(nome)}! Seu usuário é: ${login}`, 6000);
    await entrarMotorista();
    sugerirBiometria();
  };
}

/* ---------- Entrada com digital ou rosto (WebAuthn) ---------- */
let BIO_PLATAFORMA = null;
const bioApi = () => !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
if (bioApi()) PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.().then(ok => { BIO_PLATAFORMA = ok; }).catch(() => { BIO_PLATAFORMA = false; });
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const bioSalva = () => { try { return JSON.parse(getLS("frota_bio") || "null"); } catch (e) { return null; } };
const bioLiberado = () => { try { return sessionStorage.getItem("frota_liberado") === "1"; } catch (e) { return false; } };
const marcarLiberado = () => { try { sessionStorage.setItem("frota_liberado", "1"); } catch (e) {} };
async function hashPinBio(pin) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("frota-bio:" + pin));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, "0")).join("");
}
function msgBio(e) {
  const n = e && e.name;
  if (n === "NotAllowedError") return "A leitura foi cancelada ou o tempo acabou. Tente de novo.";
  if (n === "NotSupportedError") return "Este celular não tem digital/rosto disponível para apps. Cadastre a digital nas configurações do celular.";
  if (n === "SecurityError") return "Abra o app pelo endereço oficial (https).";
  if (n === "UnknownError" || /credential manager/i.test(String(e && e.message)))
    return "o celular não deixou salvar a biometria. No Android: use a DIGITAL (o rosto de muitos Android não é aceito por apps), deixe o Google como serviço de preenchimento automático e atualize o Chrome e o Google Play Services.";
  return (e && e.message) || "Erro desconhecido.";
}
function ativarBiometria(depois) {
  if (!bioApi()) return toast("Este celular/navegador não permite digital ou rosto aqui.", 4000);
  const nome = S.admin ? (S.admins.find(a => a.id === S.user?.uid)?.nome || S.user?.email || "Administrador") : (S.me?.nome || "Motorista");
  const opcoes = rk => ({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { name: "Frota", id: location.hostname },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: nome, displayName: nome },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { userVerification: "required", residentKey: rk, requireResidentKey: rk === "required", ...(BIO_PLATAFORMA ? { authenticatorAttachment: "platform" } : {}) },
    timeout: 60000 } });
  // chamado direto no toque (o iPhone exige); 1º modo simples, depois "chave de acesso"
  navigator.credentials.create(opcoes("discouraged"))
    .catch(e => { if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) throw e; return navigator.credentials.create(opcoes("preferred")); })
    .then(async cred => {
      let transports = [];
      try { transports = cred.response.getTransports?.() || []; } catch (e) {}
      const salvo = { id: b64u(cred.rawId), transports };
      if (S.user?.isAnonymous) {   // conta sem senha (versão antiga): PIN reserva, para o dia em que a digital falhar
        let pin = "";
        while (pin !== null && !/^\d{4}$/.test(pin)) pin = prompt("Crie um PIN de 4 números de reserva (para entrar se a digital/rosto falhar):", "");
        if (pin) salvo.pin = await hashPinBio(pin);
      }
      setLS("frota_bio", JSON.stringify(salvo)); setLS("frota_bio_perguntado", "1"); marcarLiberado();
      toast("✅ Pronto! O app vai pedir sua digital ou rosto ao abrir.", 4500);
      depois?.();
    })
    .catch(e => alert("Não foi possível ativar: " + msgBio(e)));
}
function desativarBiometria(depois) {
  if (!confirm("Desativar a entrada com digital/rosto neste aparelho?")) return;
  setLS("frota_bio", null); toast("Biometria desativada"); depois?.();
}
function cardBiometria() {
  if (!bioApi()) return "";
  const on = !!bioSalva();
  return `<div class="card"><h2>🔒 Entrada com digital ou rosto</h2>
    <p class="muted">${on ? "Ativada: ao abrir o app, ele pede sua digital ou rosto." : "Ao abrir o app, ele pede sua digital ou rosto. Ninguém usa o app no seu lugar se pegar seu celular."}</p>
    <button class="btn ${on ? "sec" : ""}" id="bioBtn">${on ? "Desativar neste aparelho" : "👆 Ativar digital / rosto"}</button></div>`;
}
function ligarBiometria(depois) { const b = $("#bioBtn"); if (b) b.onclick = () => bioSalva() ? desativarBiometria(depois) : ativarBiometria(depois); }
function telaBloqueio(seguir) {
  S.view = null; S.live = false;
  topo("🔒 Frota");
  app.innerHTML = `<div class="card center">
    <div style="font-size:56px;line-height:1.2">🔒</div>
    <h2>Confirme que é você</h2>
    <p class="muted">Use a digital ou o rosto cadastrado neste aparelho.</p>
    <button class="btn big" id="bioEntrar">👆 Entrar com digital / rosto</button>
    <button class="btn sec" id="bioOutro">Entrar com a senha</button>
    <button class="btn sec" id="bioTrocar">Entrar com outro usuário</button></div>`;
  $("#bioTrocar").onclick = () => sairDaConta();
  const liberar = () => { marcarLiberado(); seguir(); };
  $("#bioEntrar").onclick = () => {
    const b = bioSalva(); if (!b) return liberar();
    const cred = { type: "public-key", id: unb64u(b.id) };
    if (b.transports?.length) cred.transports = b.transports;
    navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname, allowCredentials: [cred], userVerification: "required", timeout: 60000 } })
      .then(liberar)
      .catch(e => { if (e?.name !== "NotAllowedError") alert("Falha na biometria: " + msgBio(e)); });
  };
  $("#bioOutro").onclick = async () => {
    const b = bioSalva() || {};
    if (S.user && !S.user.isAnonymous && S.user.email) {   // confirma com a senha da própria conta
      const senha = prompt(`Digite a sua senha (${loginDeEmail(S.user.email) || S.user.email}):`);
      if (!senha) return;
      ocupado("Conferindo…");
      const ok = await tentar(async () => { await signInWithEmailAndPassword(auth, S.user.email, senha); return true; }, "Senha incorreta.");
      if (ok) liberar();
    } else if (b.pin) {   // motorista: PIN de reserva
      const pin = prompt("Digite o seu PIN de reserva (4 números):");
      if (pin === null) return;
      if (await hashPinBio(pin.trim()) === b.pin) liberar(); else toast("PIN incorreto", 3000);
    } else if (confirm("Este aparelho não tem PIN de reserva. Desativar a biometria e entrar?")) { setLS("frota_bio", null); liberar(); }
  };
}

// QR Code lido com o app já aberto (ou link aberto de novo)
window.addEventListener("hashchange", () => {
  if (!CONFIGURADO) return;
  if (bioSalva() && !bioLiberado()) return;   // app bloqueado: só depois da digital/rosto
  if (pedeAdmin()) { limparHash(); return; }   // o administrador entra pela tela de login normal
  const conv = conviteDoLink();
  if (conv) {
    limparHash();
    if (S.user) return toast("Este celular já tem uma conta conectada. O convite é para criar uma conta nova.", 6000);
    S.convitePendente = conv;
    return go(telaCadastro, {});
  }
  const cod = codigoDoLink();
  if (!cod) return;
  limparHash();
  if (S.admin) return toast("Este aparelho está como administrador. Para pegar o carro, use o celular do motorista.", 6000);
  S.qrPendente = cod;
  processarQRPendente();
});

async function processarQRPendente() {
  const cod = S.qrPendente;
  if (!cod || !S.me || S.admin) return;
  S.qrPendente = null;
  await S.pronto;
  if (S.usoAtivo) {
    const carro = carroDoUso(S.usoAtivo);
    if (carro.codigo === cod) return devolverCarro(cod);
    return toast(`Você está com o ${carro.nome}. Devolva-o antes de pegar outro carro.`, 5000);
  }
  pegarCarro(cod);
}

function telaSemConfig() {
  topo("🚗 Frota Disponível");
  app.innerHTML = `<div class="card"><h2>App ainda não configurado</h2>
    <p class="muted">Preencha o arquivo <b>config.js</b> com os dados do seu projeto Firebase. O passo a passo está no arquivo <b>LEIA-ME.txt</b>.</p></div>`;
}

function telaSemConexao() {
  S.view = null; S.live = false;
  topo("🚗 Frota Disponível");
  app.innerHTML = `<div class="card center"><h2>Não foi possível entrar</h2>
    <p class="muted">Verifique a internet e tente de novo.</p>
    <button class="btn" id="denovo">Tentar de novo</button></div>`;
  $("#denovo").onclick = () => location.reload();
}

// Cartão "Instalar o app" (aparece só quando ainda não está instalado)
function cardInstalar() {
  const instalado = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (instalado) return "";
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (ios) return `<p class="muted center">📲 Para instalar no iPhone: toque em <b>Compartilhar</b> → <b>Adicionar à Tela de Início</b>.</p>`;
  return `<button class="btn sec ${promptInstalar ? "" : "hidden"}" id="btnInstalar" style="margin-bottom:14px">📲 Instalar o app neste celular</button>`;
}
function ligarInstalar() {
  const b = $("#btnInstalar");
  if (b) b.onclick = async () => { if (!promptInstalar) return; promptInstalar.prompt(); await promptInstalar.userChoice; promptInstalar = null; b.classList.add("hidden"); };
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
  S.admin = false;
  if (!S.user) return go(telaLogin);
  ocupado("Carregando…");
  const ok = await tentar(async () => {
    const snap = await getDoc(meRef());
    S.me = snap.exists() ? dados(snap) : null;
    return true;
  });
  if (!ok) return telaSemConexao();
  if (S.user.isAnonymous) {
    // motorista da versão antiga (entrava só com o nome): cria usuário e senha mantendo o histórico
    if (!S.me) return sairDaConta();
    return go(telaCadastro, {});
  }
  if (S.convitePendente) { S.convitePendente = null; toast("Você já tem uma conta: o convite não é necessário.", 4000); }
  if (!S.me) {
    // só completa o cadastro se o usuário ainda aponta para esta conta (o administrador pode ter trocado o acesso)
    const login = loginDeEmail(S.user.email);
    const lk = login ? await getDoc(loginRef(login)).catch(() => null) : null;
    if (!lk?.exists() || lk.data().uid !== S.user.uid) return sairDaConta("Seu acesso foi alterado ou removido pelo administrador. Entre com o usuário e a senha novos.");
  }
  if (!S.me || soDigitos(S.me.telefone).length < 10) return go(telaCadastro, {});   // falta nome ou WhatsApp
  semEsperar(updateDoc(meRef(), { ultimoUso: serverTimestamp() }));
  if (messaging && S.pushOk && Notification.permission === "granted") registrarToken().catch(() => {});
  ouvirMotorista();
  go(telaMotorista);
  processarQRPendente();
}

function ouvirMotorista() {
  pararOuvintes();
  const uid = S.user.uid;
  // S.pronto: resolve quando carros e uso atual já chegaram pela 1ª vez (usado pelo QR Code)
  let okCarros, okUso;
  S.pronto = Promise.all([new Promise(r => { okCarros = r; }), new Promise(r => { okUso = r; })]);
  ouvir(collection(db, "carros"), snap => {
    okCarros();
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
  ouvir(meRef(), snap => {
    if (snap.exists()) { S.me = dados(snap); reRender(); }
    else if (S.me && !snap.metadata.fromCache) sairDaConta("Seu acesso foi alterado pelo administrador. Entre com o usuário e a senha novos.");
  });
  ouvir(query(collection(db, "usos"), where("motoristaId", "==", uid), where("fim", "==", null)), snap => {
    S.usoAtivo = snap.docs.length ? dados(snap.docs[0]) : null;
    S.usoAtivo ? iniciarRastreio() : pararRastreio();
    okUso();
    reRender();
  });
  ouvir(query(collection(db, "reservas"), where("fim", ">=", Timestamp.now())), snap => {
    S.reservas = lista(snap).filter(r => r.status === "ativa").sort((a, b) => ms(a.inicio) - ms(b.inicio));
    reRender();
  });
}

// "Meus dados" do motorista: nome, WhatsApp, senha e digital/rosto
function telaIdentificar() {
  topo("Meus dados", [["Voltar", () => go(telaMotorista)]]);
  const usuario = S.me?.login || loginDeEmail(S.user?.email);
  app.innerHTML = `
    <div class="card">
      <h2>Meus dados</h2>
      ${usuario ? `<p class="muted" style="margin-top:-6px">Seu usuário: <b>${esc(usuario)}</b></p>` : ""}
      <label for="nome">Seu nome</label>
      <input id="nome" autocomplete="name" placeholder="Ex.: João Silva" maxlength="60" value="${esc(S.me?.nome || "")}">
      <label for="tel">WhatsApp (com DDD)</label>
      <input id="tel" type="tel" inputmode="tel" autocomplete="tel" placeholder="Ex.: 11 91234-5678" maxlength="20" value="${esc(S.me?.telefone || "")}">
      <button class="btn" id="salvar">Salvar</button>
    </div>
    <div class="card">
      <h2>🔑 Trocar minha senha</h2>
      <label for="sAtual">Senha atual</label><div><input id="sAtual" type="password" autocomplete="current-password"></div>
      <label for="sNova">Nova senha (mínimo 6 caracteres)</label><div><input id="sNova" type="password" autocomplete="new-password"></div>
      <button class="btn sec" id="sTrocar">Trocar senha</button>
    </div>
    ${cardBiometria()}`;
  ligarBiometria(() => go(telaIdentificar));
  olhoSenha("sAtual"); olhoSenha("sNova");
  $("#salvar").onclick = () => {
    const nome = $("#nome").value.trim().replace(/\s+/g, " "), telefone = $("#tel").value.trim();
    if (nome.length < 2) return toast("Digite seu nome");
    if (soDigitos(telefone).length < 10) return toast("O WhatsApp é obrigatório: confira com DDD");
    semEsperar(updateDoc(meRef(), { nome, telefone }));
    S.me = { ...S.me, nome, telefone };
    toast("Dados atualizados");
    go(telaMotorista);
  };
  $("#sTrocar").onclick = async () => {
    const atual = $("#sAtual").value, nova = $("#sNova").value;
    if (!atual) return toast("Digite a senha atual");
    if (nova.length < 6) return toast("A nova senha precisa ter pelo menos 6 caracteres");
    ocupado("Trocando a senha…");
    const ok = await tentar(async () => {
      try { await reauthenticateWithCredential(S.user, EmailAuthProvider.credential(S.user.email, atual)); }
      catch (e) { throw new Error("Senha atual incorreta."); }
      await updatePassword(S.user, nova); return true;
    });
    if (ok) { $("#sAtual").value = ""; $("#sNova").value = ""; toast("✅ Senha alterada", 4000); }
  };
}

function reservaTxt(r, comNome = true) {
  const mesmoDia = new Date(ms(r.inicio)).toDateString() === new Date().toDateString();
  return `${mesmoDia ? "hoje" : fmt(r.inicio).split(" ")[0]} ${hora(r.inicio)}–${hora(r.fim)}${comNome ? " (" + esc(primeiroNome(r.motoristaNome)) + ")" : ""}`;
}

function telaMotorista() {
  S.live = true;
  const me = S.me;
  if (!me) return go(telaCadastro, {});
  topo("🧑‍✈️ " + primeiroNome(me.nome), [["Meus dados", () => go(telaIdentificar, true)], ["Sair", () => { if (confirm("Sair da sua conta neste celular?")) sairDaConta(); }]]);
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
        ${u.vistoriaRetirada ? "" : `<button class="btn warn" id="vistRet">📸 Fazer a vistoria de retirada (pendente)</button>
          <button class="btn sec" id="cancelarRet">↩️ Cancelar retirada (peguei por engano)</button>`}
        <button class="btn ok" id="devolver">📷 Devolver o carro (ler QR Code)</button>
        <button class="btn bad" id="ocorrencia">⚠️ Registrar ocorrência (pneu, batida, pane…)</button>
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
      <button class="btn big" id="pegar">📷 Pegar um carro (ler QR Code)</button>
      <p class="muted center" style="margin:8px 0 14px">Dica: também dá para apontar a câmera normal do celular para o QR Code do carro.</p>`;
  }

  if (S.pushSuportado && !S.pushOk) {
    h += `<div class="card"><h2>🔔 Avisos de carro liberado</h2><p class="muted">Receba um aviso no celular quando um carro for liberado e você estiver disponível${messaging ? "" : " (com o app aberto ou minimizado)"}.</p><button class="btn sec" id="avisos">Ativar avisos</button></div>`;
  }
  h += cardInstalar();

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
  ligarInstalar();
  $("#toggle") && ($("#toggle").onclick = () => {
    semEsperar(updateDoc(meRef(), { disponivelEm: disponivel ? null : hoje(), ultimoUso: serverTimestamp() }));
    toast(disponivel ? "Marcado como indisponível" : "Pronto! Você está disponível");
  });
  $("#pegar") && ($("#pegar").onclick = pegarCarro);
  $("#devolver") && ($("#devolver").onclick = devolverCarro);
  $("#vistRet") && ($("#vistRet").onclick = () => go(telaVistoria, { tipo: "retirada", carro: carroDoUso(u), usoId: u.id }));
  $("#cancelarRet") && ($("#cancelarRet").onclick = () => cancelarRetirada(u));
  $("#ocorrencia") && ($("#ocorrencia").onclick = () => go(telaOcorrencia, u));
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

// codigoLink: vem do QR Code lido pela câmera normal do celular (link #carro=CODIGO)
async function pegarCarro(codigoLink) {
  if (S.usoAtivo) return toast("Você já está com um carro");
  const peloLink = typeof codigoLink === "string";
  const cod = peloLink ? codigoLink : await lerQR("Leia o QR Code do carro");
  if (!cod) return;
  const carro = S.carros.find(c => c.codigo === cod);
  if (!carro) return toast("Nenhum carro com o código " + cod, 4000);
  if (carro.status !== "disponivel") return toast(`${carro.nome} não está disponível agora`, 4000);
  if (peloLink && !confirm(`Pegar o carro ${carro.nome}${carro.placa ? " (" + carro.placa + ")" : ""}?`)) return;
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

// Pegou o carro por engano (antes da vistoria): encerra o uso e o carro volta a ficar disponível
function cancelarRetirada(u) {
  const carro = carroDoUso(u);
  if (u.vistoriaRetirada) return toast("A vistoria já foi feita. Use “Devolver o carro”.");
  if (!confirm(`Cancelar a retirada do ${carro.nome}? Ele volta a ficar disponível.`)) return;
  const b = writeBatch(db);
  b.update(doc(db, "usos", u.id), { fim: serverTimestamp() });
  b.update(doc(db, "carros", carro.id), { status: "disponivel", motoristaId: null, motoristaNome: null, usoId: null, desde: serverTimestamp() });
  semEsperar(b.commit());
  pararRastreio();
  toast("Retirada cancelada");
}

async function devolverCarro(codigoLink) {
  const u = S.usoAtivo; if (!u) return;
  const carro = carroDoUso(u);
  const peloLink = typeof codigoLink === "string";
  if (peloLink && !confirm(`Devolver o carro ${carro.nome}${carro.placa ? " (" + carro.placa + ")" : ""}?`)) return;
  const cod = peloLink ? codigoLink : await lerQR("Leia o QR Code do " + carro.nome);
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
      // Aceita o QR novo (link …#carro=CODIGO), o antigo (FROTA:CODIGO) ou só o código
      const t = String(txt).trim();
      const r = /#carro=([A-Z0-9]{6})$/i.exec(t) || /^(?:FROTA:)?([A-Z0-9]{6})$/i.exec(t);
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

  // cada foto obrigatória abre a câmera com o contorno certo (frente, traseira, laterais, painel)
  $$(".slot[data-i]").forEach(b => b.onclick = async () => { alvo = +b.dataset.i; const f = await fotoComMoldura(FOTOS_OBRIG[alvo]); if (f) processarFoto(f); });
  $("#addExtra").onclick = async () => { alvo = "extra"; const f = await fotoComMoldura(null, "Avaria / outra foto"); if (f) processarFoto(f); };
  cam.onchange = () => { const f = cam.files[0]; if (f) processarFoto(f); };
  const processarFoto = async file => {
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

/* ---------- Ocorrências durante o uso (pneu, batida, pane, multa, acidente) ---------- */
const TIPOS_OCORRENCIA = ["🛞 Pneu furado", "💥 Batida / avaria", "⚙️ Pane mecânica", "🚔 Multa / abordagem", "🚑 Acidente com feridos", "📝 Outro"];
function telaOcorrencia(u) {
  const carro = carroDoUso(u), O = { tipo: "", fotos: [], pos: null, podeRodar: null };
  topo("⚠️ Ocorrência", [["Voltar", () => { if (!O.tipo || confirm("Sair sem enviar a ocorrência?")) go(telaMotorista); }]]);
  app.innerHTML = `
    <div class="card">
      <h2 style="margin-bottom:2px">${esc(carro.nome)}</h2>
      <div class="muted">${esc(carro.placa || "")}</div>
      <div class="muted" id="oPos">📍 Pegando a localização…</div>
    </div>
    <div class="card hidden" id="oEmerg" style="border:2px solid var(--bad)">
      <h2>🚑 Emergência</h2><p class="muted">Se houver feridos, ligue antes de tudo:</p>
      <div class="row"><a class="btn bad" href="tel:192">SAMU 192</a><a class="btn bad" href="tel:193">Bombeiros 193</a><a class="btn bad" href="tel:190">Polícia 190</a></div>
    </div>
    <div class="card"><h2>O que aconteceu?</h2>
      <div class="fotos">${TIPOS_OCORRENCIA.map(t => `<button class="slot" data-tipo="${esc(t)}" style="aspect-ratio:auto;padding:14px 6px">${esc(t)}</button>`).join("")}</div>
      <label for="oDesc">Conte rapidamente</label>
      <input id="oDesc" maxlength="400" placeholder="Ex.: pneu traseiro direito furou na Av. Brasil">
      <label>O carro pode continuar rodando?</label>
      <div class="row"><button class="btn sec" data-rodar="1">Sim</button><button class="btn sec" data-rodar="0">Não</button></div>
    </div>
    <div class="card"><h2>Fotos (até 4)</h2>
      <div class="fotos" id="oFotos"></div>
      <button class="btn sec" id="oAddFoto">📷 Tirar foto</button>
    </div>
    <button class="btn warn big" id="oSalvar">⚠️ Enviar ocorrência</button>`;
  navigator.geolocation?.getCurrentPosition(
    p => { O.pos = { lat: p.coords.latitude, lng: p.coords.longitude }; const el = $("#oPos"); if (el) el.textContent = "📍 Local registrado"; },
    () => { const el = $("#oPos"); if (el) el.textContent = "📍 Localização não disponível"; },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
  $$("[data-tipo]").forEach(b => b.onclick = () => {
    O.tipo = b.dataset.tipo;
    $$("[data-tipo]").forEach(x => x.classList.toggle("sel", x === b));
    $("#oEmerg").classList.toggle("hidden", !O.tipo.includes("feridos"));
  });
  $$("[data-rodar]").forEach(b => b.onclick = () => {
    O.podeRodar = b.dataset.rodar === "1";
    $$("[data-rodar]").forEach(x => { x.className = "btn " + (x === b ? (O.podeRodar ? "ok" : "bad") : "sec"); });
  });
  const desenhar = () => {
    $("#oFotos").innerHTML = O.fotos.map((f, i) => `<button class="slot ok" data-of="${i}"><img src="${f.url}" alt=""><span>Foto ${i + 1} ✕</span></button>`).join("");
    $$("[data-of]").forEach(b => b.onclick = () => { if (confirm("Remover esta foto?")) { O.fotos.splice(+b.dataset.of, 1); desenhar(); } });
    $("#oAddFoto").classList.toggle("hidden", O.fotos.length >= 4);
  };
  $("#oAddFoto").onclick = async () => {
    const f = await fotoComMoldura(null, "Foto da ocorrência"); if (!f) return;
    ocupado("Processando foto…");
    const blob = await tentar(() => carimbarFoto(f, "Ocorrência", carro, O.pos));
    if (blob) { O.fotos.push({ blob, url: URL.createObjectURL(blob) }); desenhar(); }
  };
  $("#oSalvar").onclick = async () => {
    if (!O.tipo) return toast("Escolha o que aconteceu");
    if (O.podeRodar === null) return toast("Responda se o carro pode continuar rodando");
    if (O.fotos.length && !navigator.onLine) return toast("Sem internet para enviar as fotos. Tente de novo em instantes.", 4000);
    const descricao = $("#oDesc").value.trim();
    const ok = await tentar(async () => {
      const fotos = [];
      for (let i = 0; i < O.fotos.length; i++) { ocupado(`Enviando foto ${i + 1} de ${O.fotos.length}…`); fotos.push({ rotulo: "Ocorrência", ...(await salvarMidia(O.fotos[i].blob, u.id)) }); }
      ocupado("Enviando…");
      const dadosOc = { usoId: u.id, carroId: carro.id, carroNome: carro.nome, placa: carro.placa || "", motoristaId: S.user.uid, motoristaNome: S.me?.nome || "",
        tipo: O.tipo, descricao, podeRodar: O.podeRodar, lat: O.pos?.lat ?? null, lng: O.pos?.lng ?? null, fotos, status: "aberta", criadoEm: serverTimestamp() };
      if (navigator.onLine) await addDoc(collection(db, "ocorrencias"), dadosOc); else semEsperar(addDoc(collection(db, "ocorrencias"), dadosOc));
      return true;
    }, "Não foi possível enviar a ocorrência. Tente de novo.");
    if (!ok) return;
    toast("✅ Ocorrência enviada para a central", 4500);
    if (C.whatsappCentral) {
      const local = O.pos ? `\nLocal: https://maps.google.com/?q=${O.pos.lat},${O.pos.lng}` : "";
      const txt = `⚠️ OCORRÊNCIA: ${O.tipo}\nCarro: ${carro.nome} ${carro.placa || ""}\nMotorista: ${S.me?.nome || ""}${descricao ? "\n" + descricao : ""}\nPode continuar rodando: ${O.podeRodar ? "Sim" : "NÃO"}${local}`;
      modal(`<h2>Avisar a central agora?</h2><p class="muted">A ocorrência já foi registrada no app. Se for urgente, avise também pelo WhatsApp.</p>
        <a class="btn ok" target="_blank" rel="noopener" href="${waLink(C.whatsappCentral, txt)}">💬 Enviar no WhatsApp da central</a>
        <button class="btn sec" data-fechar>Agora não</button>`);
    }
    go(telaMotorista);
  };
}

/* ---------- IA: compara as fotos da retirada com as da devolução (Gemini, via ponte segura) ---------- */
const IA_ATIVA = () => /^https:\/\//.test(String(C.iaUrl || ""));
const PROMPT_IA = `Você é um vistoriador de veículos experiente. Vou mostrar pares de fotos do MESMO carro, tiradas do mesmo ângulo:
ANTES = na retirada (quando o motorista pegou o carro) e DEPOIS = na devolução.
Tarefa: encontrar AVARIAS NOVAS, que aparecem no DEPOIS e não existiam no ANTES: amassados, riscos, arranhões, trincas,
vidro/farol/lanterna/retrovisor quebrados, peças faltando, pneu danificado, para-choque solto.
Ignore diferenças de luz, sombra, reflexo, chuva, pequenas mudanças de ângulo e sujeira leve.
Na foto do painel, compare o nível de combustível e diga se há luzes de alerta acesas no DEPOIS.
Seja criterioso: só aponte o que dá para ver de verdade. Se não houver avaria nova, devolva a lista vazia.
Responda SOMENTE com JSON, em português, neste formato:
{"resumo":"frase curta","avarias":[{"foto":"nome da foto","local":"onde no carro","tipo":"amassado|risco|trinca|quebrado|faltando|pneu|outro","descricao":"o que mudou","gravidade":"baixa|media|alta","confianca":0}],"painel":{"combustivelAntes":"","combustivelDepois":"","alertas":""}}
"confianca" é de 0 a 100.`;
async function midiaParaBase64(m, max = 768) {
  const url = await carregarMidia(m); if (!url) return null;
  const img = await carregarImagem(await (await fetch(url)).blob());
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const cv = document.createElement("canvas"); cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
  cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
  URL.revokeObjectURL(img.src);
  return cv.toDataURL("image/jpeg", 0.7).split(",")[1];
}
async function analisarAvarias(usoId) {
  if (!IA_ATIVA()) throw new Error("A IA ainda não está configurada (config.js → iaUrl).");
  const filtros = [where("usoId", "==", usoId)];
  if (!S.admin) filtros.push(where("motoristaId", "==", S.user.uid));
  const vs = lista(await getDocs(query(collection(db, "vistorias"), ...filtros)));
  const ret = vs.find(v => v.tipo === "retirada"), dev = vs.find(v => v.tipo === "devolucao");
  if (!ret || !dev) throw new Error("Para comparar, o uso precisa ter as duas vistorias (retirada e devolução).");
  const parts = [{ text: PROMPT_IA }];
  let pares = 0;
  for (const r of FOTOS_OBRIG) {
    const a = (ret.fotos || []).find(f => f.rotulo === r), d = (dev.fotos || []).find(f => f.rotulo === r);
    if (!a || !d) continue;
    const [ba, bd] = await Promise.all([midiaParaBase64(a), midiaParaBase64(d)]);
    if (!ba || !bd) continue;
    pares++;
    parts.push({ text: `Foto "${r}" — ANTES (retirada):` }, { inline_data: { mime_type: "image/jpeg", data: ba } },
      { text: `Foto "${r}" — DEPOIS (devolução):` }, { inline_data: { mime_type: "image/jpeg", data: bd } });
  }
  if (!pares) throw new Error("As fotos das vistorias não estão mais disponíveis (podem ter sido apagadas na limpeza).");
  for (const e of (dev.fotos || []).filter(f => !FOTOS_OBRIG.includes(f.rotulo)).slice(0, 4)) {
    const b = await midiaParaBase64(e);
    if (b) parts.push({ text: `Foto extra tirada na devolução (${e.rotulo}):` }, { inline_data: { mime_type: "image/jpeg", data: b } });
  }
  parts.push({ text: `Dados informados pelo motorista — km: ${ret.km} → ${dev.km}; combustível: ${ret.combustivel} → ${dev.combustivel}; observação na retirada: "${ret.obs || "-"}"; na devolução: "${dev.obs || "-"}".` });
  const resp = await fetch(C.iaUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + await S.user.getIdToken() },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0.1, responseMimeType: "application/json" } }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error("A IA não respondeu: " + (j.error?.message || ("erro " + resp.status)));
  const texto = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").replace(/^\s*```(json)?|```\s*$/g, "").trim();
  let res; try { res = JSON.parse(texto); } catch (e) { throw new Error("A IA respondeu num formato inesperado. Tente de novo."); }
  const grav = g => ["baixa", "media", "alta"].includes(String(g).normalize("NFD").replace(/[̀-ͯ]/g, "")) ? String(g).normalize("NFD").replace(/[̀-ͯ]/g, "") : "media";
  const analise = {
    usoId, carroId: ret.carroId, carroNome: ret.carroNome, placa: ret.placa || "", motoristaId: ret.motoristaId, motoristaNome: ret.motoristaNome || "",
    resumo: String(res.resumo || "").slice(0, 400), pares,
    avarias: (Array.isArray(res.avarias) ? res.avarias : []).slice(0, 20).map(a => ({ foto: String(a.foto || ""), local: String(a.local || ""), tipo: String(a.tipo || ""), descricao: String(a.descricao || "").slice(0, 400), gravidade: grav(a.gravidade), confianca: Math.max(0, Math.min(100, Math.round(+a.confianca || 0))) })),
    painel: res.painel ? { combustivelAntes: String(res.painel.combustivelAntes || ""), combustivelDepois: String(res.painel.combustivelDepois || ""), alertas: String(res.painel.alertas || res.painel.alertasNoPainel || "") } : null,
    revisado: false, analisadoPor: S.admin ? "administrador" : "motorista", criadoEm: serverTimestamp(),
  };
  await setDoc(doc(db, "analises", usoId), analise);
  return analise;
}
function avariasIaHtml(a) {
  const cor = { alta: "bad", media: "warn", baixa: "off" };
  return `${a.resumo ? `<p><b>${esc(a.resumo)}</b></p>` : ""}
    ${a.avarias?.length ? `<ul class="list">${a.avarias.map(x => `<li class="item"><div class="info">
        <div class="title">${esc(x.local || x.foto)} <span class="pill ${cor[x.gravidade] || "warn"}">${x.gravidade === "alta" ? "Grave" : x.gravidade === "baixa" ? "Leve" : "Média"}</span> <span class="muted">${x.confianca}% de certeza</span></div>
        <div class="muted">${esc(x.tipo)}${x.foto ? " · foto: " + esc(x.foto) : ""}</div>${x.descricao ? `<div>${esc(x.descricao)}</div>` : ""}</div></li>`).join("")}</ul>`
      : `<p>✅ Nenhuma avaria nova encontrada.</p>`}
    ${a.painel && (a.painel.combustivelAntes || a.painel.alertas) ? `<p class="muted">⛽ Combustível pelas fotos: ${esc(a.painel.combustivelAntes || "?")} → ${esc(a.painel.combustivelDepois || "?")}${a.painel.alertas ? ` · ⚠️ Painel: ${esc(a.painel.alertas)}` : ""}</p>` : ""}
    ${a.comentarioMotorista ? `<p>💬 <b>Motorista:</b> ${esc(a.comentarioMotorista)}</p>` : ""}
    <p class="muted" style="font-size:12px">A IA pode errar: confira sempre as fotos antes de tomar qualquer decisão.</p>`;
}
// Depois da devolução: o motorista vê o resultado e pode comentar
async function iaPosDevolucao(usoId) {
  toast("🤖 A IA está comparando as fotos da retirada e da devolução…", 6000);
  let a;
  try { a = await analisarAvarias(usoId); } catch (e) { console.warn("IA:", e); return; }
  if (!a.avarias.length) return toast("🤖 A IA não encontrou avarias novas. Obrigado!", 5000);
  const m = modal(`<h2>🤖 A IA apontou possível avaria nova</h2>${avariasIaHtml(a)}
    <label for="iaCom">Quer comentar? (ex.: já estava assim, aconteceu em tal lugar…)</label>
    <input id="iaCom" maxlength="300">
    <button class="btn" id="iaEnviar">Enviar comentário</button>
    <button class="btn sec" data-fechar>Fechar</button>`);
  $("#iaEnviar", m.el).onclick = () => {
    const t = $("#iaCom", m.el).value.trim();
    if (t) semEsperar(updateDoc(doc(db, "analises", usoId), { comentarioMotorista: t, comentadoEm: serverTimestamp() }));
    m.fechar(); toast(t ? "Comentário enviado" : "Ok");
  };
}

/* ---------- Câmera com moldura: as fotos saem sempre no mesmo enquadramento ---------- */
const SVG_CARRO_LADO = `<path d="M30 205 L30 168 Q34 150 62 146 L118 142 L160 100 Q170 92 186 92 L282 92 Q304 92 318 110 L350 146 Q372 150 372 172 L372 205 Z"/><path d="M168 106 L240 106 L240 140 L132 140 Z M252 106 L292 106 Q304 108 312 120 L326 140 L252 140 Z"/><circle cx="100" cy="207" r="30"/><circle cx="300" cy="207" r="30"/>`;
const MOLDURAS = {
  "Frente": { dica: "Fique de frente para o carro e encaixe a frente inteira no contorno.",
    svg: `<path d="M118 82 L282 82 L318 150 L82 150 Z"/><rect x="52" y="150" width="296" height="72" rx="18"/><ellipse cx="96" cy="178" rx="24" ry="13"/><ellipse cx="304" cy="178" rx="24" ry="13"/><rect x="160" y="170" width="80" height="24" rx="5"/><rect x="70" y="220" width="44" height="30" rx="7"/><rect x="286" y="220" width="44" height="30" rx="7"/>` },
  "Traseira": { dica: "Fique atrás do carro e encaixe a traseira inteira, com a placa visível.",
    svg: `<path d="M122 82 L278 82 L312 148 L88 148 Z"/><rect x="52" y="148" width="296" height="74" rx="18"/><rect x="66" y="164" width="46" height="20" rx="5"/><rect x="288" y="164" width="46" height="20" rx="5"/><rect x="166" y="184" width="68" height="24" rx="3"/><rect x="70" y="220" width="44" height="30" rx="7"/><rect x="286" y="220" width="44" height="30" rx="7"/>` },
  "Lateral esquerda": { dica: "Lado do motorista. Afaste-se até o carro inteiro caber no contorno, com as duas rodas.", svg: SVG_CARRO_LADO },
  "Lateral direita": { dica: "Lado do passageiro. Afaste-se até o carro inteiro caber no contorno, com as duas rodas.", svg: `<g transform="translate(400,0) scale(-1,1)">${SVG_CARRO_LADO}</g>` },
  "Painel (km e combustível)": { dica: "Com o carro ligado, enquadre o painel: o km e o marcador de combustível precisam ficar legíveis.",
    svg: `<rect x="36" y="58" width="328" height="184" rx="34"/><circle cx="138" cy="150" r="60"/><circle cx="272" cy="150" r="46"/><text x="138" y="232" text-anchor="middle">km</text><text x="272" y="222" text-anchor="middle">combustível</text>` },
};
function fotoComMoldura(rotulo, titulo) {
  return new Promise(resolve => {
    const mold = rotulo && MOLDURAS[rotulo];
    let stream = null, feito = false;
    const m = modal(`
      <h2>📷 ${esc(titulo || rotulo || "Foto")}</h2>
      ${mold ? `<p class="muted" style="margin-top:-6px">${esc(mold.dica)}</p>` : ""}
      <div class="camera moldura"><video playsinline muted autoplay></video>${mold ? `<svg class="contorno" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid meet">${mold.svg}</svg>` : ""}</div>
      <p class="muted center" id="camMsg">Abrindo a câmera…</p>
      <button class="btn ok big hidden" id="camTirar">📸 Tirar foto</button>
      <button class="btn sec" id="camNativa">Usar a câmera do celular</button>
      <button class="btn sec" data-fechar>Cancelar</button>
      <input type="file" accept="image/*" capture="environment" class="hidden" id="camArq">`, { onClose: () => fim(null) });
    function fim(r) {
      if (feito) return; feito = true;
      stream?.getTracks().forEach(t => t.stop());
      m.el.remove();
      resolve(r);
    }
    const video = $("video", m.el), msg = $("#camMsg", m.el), btn = $("#camTirar", m.el);
    $("#camNativa", m.el).onclick = () => $("#camArq", m.el).click();
    $("#camArq", m.el).onchange = e => { const f = e.target.files[0]; if (f) fim(f); };
    if (!navigator.mediaDevices?.getUserMedia) { msg.textContent = "Use o botão abaixo para abrir a câmera do celular."; return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }).then(s => {
      if (feito) return s.getTracks().forEach(t => t.stop());
      stream = s; video.srcObject = s; video.play().catch(() => {});
      msg.textContent = mold ? "Encaixe no contorno e toque em Tirar foto." : "Enquadre e toque em Tirar foto.";
      btn.classList.remove("hidden");
    }).catch(() => { msg.textContent = "Não foi possível abrir a câmera aqui. Use o botão abaixo."; });
    btn.onclick = () => {
      if (!video.videoWidth) return toast("A câmera ainda está carregando…");
      // recorta exatamente o que aparece na tela (o mesmo enquadramento do contorno)
      const vw = video.videoWidth, vh = video.videoHeight, cw = video.clientWidth, ch = video.clientHeight;
      const k = Math.max(cw / vw, ch / vh), sw = cw / k, sh = ch / k;
      const cv = document.createElement("canvas"); cv.width = Math.round(sw); cv.height = Math.round(sh);
      cv.getContext("2d").drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, cv.width, cv.height);
      cv.toBlob(b => b ? fim(b) : toast("Falha ao capturar. Tente de novo."), "image/jpeg", 0.92);
    };
  });
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
const MIDIA_CACHE = new Map();   // cada foto/vídeo é baixado uma vez só enquanto o app está aberto
async function carregarMidia(m) {
  if (!m?.grupo) return null;
  if (MIDIA_CACHE.has(m.grupo)) return MIDIA_CACHE.get(m.grupo);
  const docs = await Promise.all(Array.from({ length: m.partes }, (_, i) => getDoc(doc(db, "midias", `${m.grupo}_${i}`))));
  if (docs.some(d => !d.exists())) return null; // apagada na limpeza
  const url = URL.createObjectURL(new Blob(docs.map(d => d.data().dados.toUint8Array()), { type: m.mime }));
  MIDIA_CACHE.set(m.grupo, url);
  return url;
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
  if (V.tipo === "devolucao" && IA_ATIVA()) setTimeout(() => iaPosDevolucao(V.usoId), 1500);   // IA compara retirada x devolução
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
  pararRastreio();
  if (!S.user || S.user.isAnonymous) return go(telaLogin);
  ocupado("Carregando…");
  let ehAdmin;
  try { ehAdmin = (await getDoc(doc(db, "admins", S.user.uid))).exists(); }
  catch (e) { ehAdmin = getLS("frota_admin_uid") === S.user.uid; } // sem internet: usa o que já sabia
  ocupado(false);
  if (!ehAdmin) return entrarMotorista();   // conta comum: entra como motorista
  setLS("frota_admin_uid", S.user.uid);
  S.admin = true;
  ouvirAdmin();
  go(telaAdmin);
}

function ouvirAdmin() {
  pararOuvintes();
  ouvir(collection(db, "carros"), s => { S.carros = lista(s).sort(porNome); reRender(); });
  ouvir(collection(db, "motoristas"), s => { S.motoristas = lista(s).sort(porNome); reRender(); });
  // Administradores. Se o meu acesso de administrador for removido, sai da conta.
  S.subs.push(onSnapshot(collection(db, "admins"), s => {
    S.admins = lista(s).sort((a, b) => (a.id !== S.user?.uid) - (b.id !== S.user?.uid) || String(a.nome || "").localeCompare(b.nome || ""));
    if (!s.metadata.fromCache && S.user && !S.admins.some(a => a.id === S.user.uid)) return sairDaConta("Seu acesso de administrador foi removido.");
    reRender();
  }, e => {
    if (e?.code === "permission-denied") sairDaConta("Seu acesso de administrador foi removido.");
    else console.warn("tempo real:", e);
  }));
  ouvir(collection(db, "convites"), s => {
    S.convites = lista(s).sort((a, b) => ms(b.criadoEm) - ms(a.criadoEm));
    // Convite usado: apaga o convite e, se era troca de celular, o cadastro do aparelho antigo
    S.convites.filter(c => c.usadoPor).forEach(c => {
      const b = writeBatch(db);
      const antigoComCarro = S.usosAtivos.some(u => u.motoristaId === c.substitui);
      if (c.substitui && c.substitui !== c.usadoPor && !antigoComCarro) b.delete(doc(db, "motoristas", c.substitui));
      b.delete(doc(db, "convites", c.id));
      semEsperar(b.commit());
    });
    reRender();
  });
  ouvir(query(collection(db, "usos"), where("fim", "==", null)), s => { S.usosAtivos = lista(s); reRender(); atualizarMapa(); });
  ouvir(query(collection(db, "reservas"), where("fim", ">=", Timestamp.now())), s => {
    S.reservas = lista(s).filter(r => r.status === "ativa").sort((a, b) => ms(a.inicio) - ms(b.inicio));
    reRender();
  });
  let primeiraOc = true;
  ouvir(query(collection(db, "ocorrencias"), orderBy("criadoEm", "desc"), limit(200)), s => {
    // ocorrência nova chegando com o painel aberto: aviso na hora
    if (!primeiraOc) s.docChanges().forEach(ch => {
      if (ch.type !== "added") return;
      const o = ch.doc.data();
      toast(`⚠️ Nova ocorrência: ${o.tipo} · ${o.carroNome} · ${o.motoristaNome}`, 8000);
      navigator.vibrate?.([300, 100, 300]);
      notificarLocal("⚠️ Nova ocorrência", `${o.tipo} · ${o.carroNome} · ${o.motoristaNome}`, "oc-" + ch.doc.id);
    });
    primeiraOc = false;
    S.ocorrencias = lista(s);
    reRender();
  });
  let primeiraIa = true;
  ouvir(query(collection(db, "analises"), orderBy("criadoEm", "desc"), limit(100)), s => {
    // análise da IA chegando com avaria: aviso na hora
    if (!primeiraIa) s.docChanges().forEach(ch => {
      if (ch.type !== "added") return;
      const a = ch.doc.data();
      if (!(a.avarias || []).length) return;
      toast(`🤖 IA: possível avaria nova no ${a.carroNome} (${a.motoristaNome})`, 8000);
      notificarLocal("🤖 Possível avaria nova", `${a.carroNome} · ${a.motoristaNome} · ${a.avarias.length} ponto(s)`, "ia-" + ch.doc.id);
    });
    primeiraIa = false;
    S.analises = lista(s);
    reRender();
  });
}

const ABAS = [["inicio", "🏠 Início"], ["carros", "🚗 Carros"], ["motoristas", "👥 Usuários"], ["mapa", "🗺️ Mapa"], ["ocorrencias", "⚠️ Ocorrências"], ["historico", "📄 Histórico"], ["reservas", "📅 Reservas"], ["ajustes", "⚙️ Ajustes"]];
const ocorrenciasAbertas = () => S.ocorrencias.filter(o => o.status !== "resolvida").length + S.analises.filter(a => (a.avarias || []).length && !a.revisado).length;
function irPara(tab) { S.tab = tab; setLS("frota_tab", tab); go(telaAdmin); }

function telaAdmin() {
  const tab = S.tab;
  S.live = ["inicio", "carros", "motoristas", "reservas", "ocorrencias"].includes(tab);
  topo("🛠️ Administração", [["👤 " + primeiroNome(meuAdmin().nome), abrirMinhaConta]]);
  app.classList.add("largo");
  const dias = +(getLS("frota_dias_alerta") || 3);
  const inativos = S.motoristas.filter(m => Date.now() - (ms(m.ultimoUso) || ms(m.criadoEm) || 0) > dias * 864e5);
  const livres = S.carros.filter(c => c.status === "disponivel").length;
  const dispHoje = S.motoristas.filter(m => m.disponivelEm === hoje()).length;
  const abertasOc = ocorrenciasAbertas();

  // No computador o menu fica na lateral (CSS .painel); no celular, em cima
  let h = `<div class="painel"><nav class="tabs">${ABAS.map(([k, t]) => {
    const n = k === "carros" ? `${livres}/${S.carros.length}` : k === "motoristas" ? `${dispHoje}/${S.motoristas.length}` : k === "mapa" ? `${S.usosAtivos.length}` : k === "ocorrencias" && abertasOc ? `${abertasOc}` : "";
    return `<button data-t="${k}" class="${tab === k ? "on" : ""}"><span>${t}</span>${n ? `<b class="cont">${n}</b>` : ""}</button>`;
  }).join("")}</nav><div class="conteudo">`;
  if (inativos.length) {
    h += `<div class="alert"><b>⚠️ ${inativos.length} motorista${inativos.length > 1 ? "s" : ""} sem usar o app há mais de ${dias} dias</b>
      ${inativos.map(m => `${esc(m.nome)} (último uso ${ago(m.ultimoUso)})`).join("<br>")}</div>`;
  }
  h += `<div id="aba"></div></div></div>`;
  app.innerHTML = h;
  $$(".tabs button").forEach(b => b.onclick = () => irPara(b.dataset.t));
  ({ inicio: abaInicio, carros: abaCarros, motoristas: abaMotoristas, mapa: abaMapa, ocorrencias: abaOcorrencias, historico: abaHistorico, reservas: abaReservas, ajustes: abaAjustes }[tab] || abaInicio)($("#aba"));
}

/* ---------- Aba Início (resumo da frota) ---------- */
// Usos e vistorias dos últimos 30 dias: lidos no máximo a cada 30 min (economiza a cota grátis do Firebase)
async function carregarResumo(forcar) {
  if (S.resumo && !forcar && Date.now() - S.resumo.t < 30 * 60000) return S.resumo;
  if (S.carregandoResumo) return S.carregandoResumo;
  const d0 = new Date(); d0.setHours(0, 0, 0, 0); d0.setDate(d0.getDate() - 29);
  const desde = Timestamp.fromDate(d0);
  S.carregandoResumo = Promise.all([
    getDocs(query(collection(db, "usos"), where("inicio", ">=", desde))),
    getDocs(query(collection(db, "vistorias"), where("criadoEm", ">=", desde))),
  ]).then(([u, v]) => (S.resumo = { t: Date.now(), desde: d0.getTime(), usos: lista(u), vist: lista(v) }))
    .finally(() => { S.carregandoResumo = null; });
  return S.carregandoResumo;
}

function abaInicio(el) {
  const R = S.resumo;
  if (!R || Date.now() - R.t > 30 * 60000) {
    carregarResumo().then(() => { if (S.view?.fn === telaAdmin && S.tab === "inicio") telaAdmin(); })
      .catch(e => { console.warn(e); if (!S.resumo) { S.resumo = { t: Date.now(), erro: true, usos: [], vist: [] }; if (S.tab === "inicio") telaAdmin(); } });
  }
  const emUso = S.usosAtivos.length;
  const livres = S.carros.filter(c => c.status === "disponivel").length;
  const parados = S.carros.filter(c => c.status === "indisponivel").length;
  const dispHoje = S.motoristas.filter(m => m.disponivelEm === hoje()).length;
  const abertasOc = ocorrenciasAbertas();

  // Primeiros passos: some sozinho quando tudo estiver feito
  const passos = [
    [S.carros.length > 0, "Cadastre seu primeiro carro", "carros"],
    [S.carros.length > 0 && !!getLS("frota_qr_visto"), "Imprima os QR Codes e cole nos carros", "qr"],
    [S.motoristas.length > 0, "Cadastre um motorista (ou mande o link para ele criar a conta)", "motoristas"],
    [!bioApi() || !!bioSalva(), "Ative a entrada com digital ou rosto neste aparelho", "ajustes"],
  ];
  const feitos = passos.filter(p => p[0]).length;
  const cardPassos = feitos < passos.length ? `<div class="card">
      <h2>🚀 Primeiros passos <span class="muted" style="font-weight:400">· ${feitos} de ${passos.length}</span></h2>
      <div class="barra"><i style="width:${Math.round(feitos / passos.length * 100)}%"></i></div>
      <ul class="list passos">${passos.map(([ok, txt, ir], i) => `
        <li class="${ok ? "feito" : ""}" data-passo="${ir}"><span class="ck">${ok ? "✓" : i + 1}</span><span class="tx">${txt}</span>${ok ? "" : `<span class="muted">›</span>`}</li>`).join("")}</ul>
    </div>` : "";

  const kpi = (n, t, s, cor, ir) => `<button class="kpi" style="--cor:${cor}" data-ir="${ir}"><div class="n">${n}</div><div class="t">${t}</div>${s ? `<div class="s">${s}</div>` : ""}</button>`;
  const kpis = `<div class="kpis">
      ${kpi(livres, "Carros disponíveis", `de ${S.carros.length} na frota`, "var(--ok)", "carros")}
      ${kpi(emUso, "Em uso agora", emUso ? "ver no mapa" : "nenhum na rua", "var(--primary)", "mapa")}
      ${kpi(parados, "Parados", "indisponíveis", "var(--muted)", "carros")}
      ${kpi(dispHoje, "Motoristas disponíveis hoje", `de ${S.motoristas.length} cadastrados`, "#8250df", "motoristas")}
      ${kpi(abertasOc, "Ocorrências abertas", abertasOc ? "precisam de atenção" : "tudo em ordem", abertasOc ? "var(--bad)" : "var(--ok)", "ocorrencias")}
    </div>`;

  let mes = `<div class="card"><h2>📊 Últimos 30 dias</h2><div class="empty">Carregando…</div></div>`, eventos = "";
  if (R && R.erro) mes = `<div class="card"><h2>📊 Últimos 30 dias</h2><div class="empty">Não foi possível carregar agora. <button class="mini" id="resAtualizar">Tentar de novo</button></div></div>`;
  else if (R) {
    // km por uso = km da devolução − km da retirada
    const vs = {};
    R.vist.forEach(v => { (vs[v.usoId] = vs[v.usoId] || {})[v.tipo] = v; });
    const kmDe = u => { const r = vs[u.id]?.retirada, d = vs[u.id]?.devolucao; const k = d && r ? Number(d.km) - Number(r.km) : NaN; return k >= 0 && k < 5000 ? k : 0; };
    const usos = R.usos;
    const km = usos.reduce((s, u) => s + kmDe(u), 0);
    const horas = usos.filter(u => u.fim).reduce((s, u) => s + Math.max(0, ms(u.fim) - ms(u.inicio)), 0) / 3600000;
    const conta = campo => { const c = {}; usos.forEach(u => { const k = u[campo] || "—"; c[k] = (c[k] || 0) + 1; }); return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 3); };
    // gráfico: usos por dia
    const dias = Array.from({ length: 30 }, (_, i) => { const d = new Date(R.desde); d.setDate(d.getDate() + i); return d; });
    const porDia = {}; usos.forEach(u => { const k = new Date(ms(u.inicio)).toLocaleDateString("en-CA"); porDia[k] = (porDia[k] || 0) + 1; });
    const max = Math.max(1, ...dias.map(d => porDia[d.toLocaleDateString("en-CA")] || 0));
    const barras = dias.map((d, i) => {
      const n = porDia[d.toLocaleDateString("en-CA")] || 0, alt = n ? Math.max(3, n / max * 70) : 0;
      return `<rect x="${i * 10 + 1}" y="${80 - alt}" width="8" height="${alt}" rx="1.5"><title>${pad(d.getDate())}/${pad(d.getMonth() + 1)}: ${n} uso(s)</title></rect>
        ${(i % 7 === 0 && i < 26) || i === 29 ? `<text x="${i === 29 ? 299 : i * 10 + 1}" y="92" text-anchor="${i === 29 ? "end" : "start"}">${i === 29 ? "hoje" : pad(d.getDate()) + "/" + pad(d.getMonth() + 1)}</text>` : ""}`;
    }).join("");
    const top = (t, arr) => `<div><div class="muted">${t}</div>${arr.length ? arr.map(([n, q], i) => `<div class="rank"><span>${["🥇", "🥈", "🥉"][i]} ${esc(n)}</span><b>${q}</b></div>`).join("") : `<div class="muted">—</div>`}</div>`;
    mes = `<div class="card">
        <h2 style="display:flex;justify-content:space-between;align-items:center;gap:8px">📊 Últimos 30 dias <button class="mini" id="resAtualizar" title="Atualizar">↻</button></h2>
        <div class="numeros">
          <div><b>${usos.length}</b><span>usos</span></div>
          <div><b>${km.toLocaleString("pt-BR")}</b><span>km rodados</span></div>
          <div><b>${horas < 10 ? horas.toFixed(1).replace(".", ",") : Math.round(horas)}</b><span>horas em uso</span></div>
        </div>
        ${usos.length ? `<div class="muted" style="font-size:12px">Usos por dia</div><div class="grafico"><svg viewBox="0 0 300 96">${barras}</svg></div>`
          : `<div class="empty">Nenhum uso nos últimos 30 dias.</div>`}
        <div class="tops">${top("Quem mais usou", conta("motoristaNome"))}${top("Carros mais usados", conta("carroNome"))}</div>
      </div>`;

    // Últimos acontecimentos: retiradas, devoluções e ocorrências
    const ev = [];
    usos.forEach(u => {
      ev.push({ t: ms(u.inicio), html: `🔑 <b>${esc(primeiroNome(u.motoristaNome))}</b> pegou o <b>${esc(u.carroNome)}</b>` });
      if (u.fim) { const k = kmDe(u); ev.push({ t: ms(u.fim), html: `✅ <b>${esc(primeiroNome(u.motoristaNome))}</b> devolveu o <b>${esc(u.carroNome)}</b>${k ? ` · ${k} km` : ""}` }); }
    });
    S.ocorrencias.forEach(o => ev.push({ t: ms(o.criadoEm), html: `⚠️ Ocorrência: <b>${esc(o.tipo)}</b> · ${esc(o.carroNome)} · ${esc(primeiroNome(o.motoristaNome))}` }));
    const ult = ev.filter(e => e.t).sort((a, b) => b.t - a.t).slice(0, 8);
    eventos = `<div class="card"><h2>🕒 Últimos acontecimentos</h2>${ult.length ? `<ul class="list eventos">${ult.map(e => `<li><span>${e.html}</span><span class="muted">${ago(e.t)}</span></li>`).join("")}</ul>` : `<div class="empty">Ainda não aconteceu nada. Quando um motorista pegar um carro, aparece aqui.</div>`}</div>`;
  }

  el.innerHTML = `${cardPassos}${kpis}<div class="duas">${mes}${eventos || ""}</div>`;
  $$("[data-ir]", el).forEach(b => b.onclick = () => irPara(b.dataset.ir));
  $$("[data-passo]", el).forEach(li => li.onclick = () => li.dataset.passo === "qr" ? (S.carros.length ? go(telaEtiquetas, S.carros) : irPara("carros")) : irPara(li.dataset.passo));
  $("#resAtualizar", el) && ($("#resAtualizar", el).onclick = () => { S.resumo = null; telaAdmin(); });
}

/* ---------- Aba Ocorrências ---------- */
function itemOcorrencia(o, comAcoes) {
  const mot = S.motoristas.find(m => m.id === o.motoristaId);
  return `<li class="item" data-id="${o.id}"><div class="info">
      <div class="title">${esc(o.tipo)} ${o.status === "resolvida" ? `<span class="pill ok">Resolvida</span>` : `<span class="pill bad">Aberta</span>`} ${o.podeRodar === false ? `<span class="pill warn">Carro não pode rodar</span>` : ""}</div>
      <div class="muted">${esc(o.carroNome)} ${esc(o.placa || "")} · ${esc(o.motoristaNome)} · ${fmt(o.criadoEm)}</div>
      ${o.descricao ? `<div>${esc(o.descricao)}</div>` : ""}
      ${o.lat != null ? `<a target="_blank" rel="noopener" href="https://maps.google.com/?q=${o.lat},${o.lng}">📍 Ver no mapa</a>` : ""}
      ${(o.fotos || []).length ? `<div class="fotos" style="margin-top:8px">${o.fotos.map(f => `<img data-midia="${midiaAttr(f)}" alt="Foto da ocorrência" style="width:100%;border-radius:10px">`).join("")}</div>` : ""}
      ${o.resolucao ? `<div class="muted">✅ ${esc(o.resolucao)}</div>` : ""}
    </div>${comAcoes ? `<div class="acts">
      ${mot?.telefone ? `<a class="mini" target="_blank" rel="noopener" href="${waLink(mot.telefone, `Olá ${primeiroNome(mot.nome)}, sobre a ocorrência (${o.tipo}) com o ${o.carroNome}:`)}">💬 Motorista</a>` : ""}
      ${o.usoId ? `<button class="mini" data-relo="${o.usoId}">Relatório</button>` : ""}
      ${o.status !== "resolvida" ? `<button class="mini ok" data-resolver="${o.id}">✅ Resolver</button>` : ""}
    </div>` : ""}</li>`;
}
function abaOcorrencias(el) {
  const abertas = S.ocorrencias.filter(o => o.status !== "resolvida"), resolvidas = S.ocorrencias.filter(o => o.status === "resolvida").slice(0, 30);
  const iaPend = S.analises.filter(a => (a.avarias || []).length && !a.revisado);
  el.innerHTML = `
    ${iaPend.length ? `<div class="card" style="border:2px solid var(--warn)"><h2>🤖 Avarias apontadas pela IA (${iaPend.length})</h2>
      <ul class="list">${iaPend.map(a => `<li class="item"><div class="info">
        <div class="title">${esc(a.carroNome)} ${esc(a.placa || "")} · ${esc(a.motoristaNome)}</div>
        <div class="muted">${fmt(a.criadoEm)} · ${a.avarias.length} ponto(s): ${a.avarias.map(x => esc(x.local || x.foto)).join(", ")}</div>
        ${a.comentarioMotorista ? `<div>💬 ${esc(a.comentarioMotorista)}</div>` : ""}
      </div><div class="acts"><button class="mini" data-relo="${a.usoId}">Ver fotos</button><button class="mini ok" data-revisar="${a.usoId}">✔ Revisado</button></div></li>`).join("")}</ul></div>` : ""}
    <div class="card"><h2>⚠️ Abertas (${abertas.length})</h2>
      ${abertas.length ? `<ul class="list">${abertas.map(o => itemOcorrencia(o, true)).join("")}</ul>` : `<div class="empty">Nenhuma ocorrência aberta. 👍</div>`}</div>
    <div class="card"><h2>Resolvidas (últimas)</h2>
      ${resolvidas.length ? `<ul class="list">${resolvidas.map(o => itemOcorrencia(o, true)).join("")}</ul>` : `<div class="empty">Nenhuma.</div>`}</div>`;
  $$("[data-relo]", el).forEach(b => b.onclick = () => go(telaRelatorio, b.dataset.relo));
  $$("[data-revisar]", el).forEach(b => b.onclick = () => { semEsperar(updateDoc(doc(db, "analises", b.dataset.revisar), { revisado: true, revisadoEm: serverTimestamp() })); toast("Marcado como revisado"); });
  $$("[data-resolver]", el).forEach(b => b.onclick = () => {
    const nota = prompt("Como foi resolvido? (opcional)", "");
    if (nota === null) return;
    semEsperar(updateDoc(doc(db, "ocorrencias", b.dataset.resolver), { status: "resolvida", resolucao: nota.trim(), resolvidoEm: serverTimestamp(), resolvidoPor: S.user?.email || "" }));
    toast("Ocorrência resolvida");
  });
  carregarMidiasDaTela();
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
  if (carros.length) setLS("frota_qr_visto", "1");   // passo "imprimir QR Codes" dos Primeiros passos
  app.innerHTML = `
    <div class="no-print acoes"><button class="btn" id="imprimir">🖨️ Imprimir etiquetas</button>
      <p class="muted center">Cole a etiqueta no carro (vidro ou painel). O motorista lê o QR para pegar e devolver.</p></div>
    <div class="etiquetas">${carros.map(c => `
      <div class="etiqueta">
        <div class="et-nome">${esc(c.nome)}</div>
        <div class="et-placa">${esc(c.placa || "")}</div>
        <img src="${qrDataURL(linkCarro(c), 6)}" alt="QR Code">
        <div class="et-cod">${esc(c.codigo)}</div>
        <div class="et-inst">Aponte a câmera do celular para pegar ou devolver este carro</div>
      </div>`).join("")}</div>`;
  $("#imprimir").onclick = () => window.print();
}

/* ---------- Aba Motoristas ---------- */
function abaMotoristas(el) {
  const dias = +(getLS("frota_dias_alerta") || 3);
  const ordenados = [...S.motoristas].sort((a, b) => ((b.disponivelEm === hoje()) - (a.disponivelEm === hoje())) || porNome(a, b));
  const pendentes = S.convites.filter(c => !c.usadoPor);
  el.innerHTML = `
    <button class="btn" id="novoMot">＋ Cadastrar motorista</button>
    <button class="btn sec" id="novoAdm" style="margin-bottom:14px">＋ Cadastrar administrador</button>
    ${pendentes.length ? `<div class="card"><h2>📨 Convites aguardando</h2><ul class="list">${pendentes.map(c => {
      const vencido = Date.now() - (ms(c.criadoEm) || 0) > 7 * 864e5;
      return `<li class="item"><div class="info">
          <div class="title">${esc(c.nome)} ${c.substitui ? `<span class="pill uso">Novo celular</span>` : ""} ${vencido ? `<span class="pill bad">Vencido</span>` : ""}</div>
          <div class="muted">Criado ${ago(c.criadoEm)} · ainda não abriu o link</div>
        </div><div class="acts">
          ${vencido ? "" : `<button class="mini" data-verconv="${c.id}">Ver / enviar</button>`}
          <button class="mini del" data-delconv="${c.id}" title="Cancelar convite">✕</button>
        </div></li>`;
    }).join("")}</ul></div>` : ""}
    <div class="card">
    ${ordenados.length ? `<ul class="list">${ordenados.map(m => {
      const uso = S.usosAtivos.find(u => u.motoristaId === m.id);
      const inativo = Date.now() - (ms(m.ultimoUso) || ms(m.criadoEm) || 0) > dias * 864e5;
      return `<li class="item" data-id="${m.id}">
        <div class="info">
          <div class="title">${esc(m.nome)}
            ${uso ? `<span class="pill uso">Com ${esc(uso.carroNome)}</span>` : m.disponivelEm === hoje() ? `<span class="pill ok">Disponível hoje</span>` : ""}
            ${inativo ? `<span class="pill warn">Inativo</span>` : ""}
          </div>
          <div class="muted">${m.login ? `👤 ${esc(m.login)}` : `<span class="pill warn">Sem usuário</span>`} · ${m.telefone ? esc(m.telefone) + " · " : ""}Último uso: ${ago(m.ultimoUso)}</div>
        </div>
        <div class="acts">
          ${m.telefone ? `<a class="mini" target="_blank" rel="noopener" href="${waLink(m.telefone)}">💬 WhatsApp</a>` : ""}
          <button class="mini" data-edit="${m.id}">✏️ Editar / senha</button>
          <button class="mini del" data-del="${m.id}" title="Remover">✕</button>
        </div></li>`;
    }).join("")}</ul>` : `<div class="empty">Nenhum motorista ainda. Cadastre ou mande o link do app para eles.</div>`}</div>
    <div class="card"><h2>🛡️ Administradores</h2>
    <ul class="list">${S.admins.map(a => {
      const eu = a.id === S.user?.uid;
      return `<li class="item"><div class="info">
          <div class="title">${esc(a.nome || (eu ? S.user.email : "") || "Administrador")} ${eu ? `<span class="pill ok">Você</span>` : ""}</div>
          <div class="muted">${a.login ? `👤 ${esc(a.login)}` : eu ? esc(S.user.email || "") : "entra com e-mail"}</div>
        </div><div class="acts">
          ${eu ? `<button class="mini" data-meuacesso>Minha senha</button>` : `<button class="mini" data-editadm="${a.id}">✏️ Editar / senha</button>
          <button class="mini del" data-deladm="${a.id}" title="Remover">✕</button>`}
        </div></li>`;
    }).join("")}</ul></div>`;
  $("#novoMot").onclick = () => go(telaMotoristaForm, null);
  $("#novoAdm").onclick = () => go(telaAdminForm, null);
  $$("[data-meuacesso]", el).forEach(b => b.onclick = abrirMinhaConta);
  $$("[data-editadm]", el).forEach(b => b.onclick = () => go(telaAdminForm, S.admins.find(x => x.id === b.dataset.editadm)));
  $$("[data-deladm]", el).forEach(b => b.onclick = () => {
    const a = S.admins.find(x => x.id === b.dataset.deladm);
    if (!confirm(`Remover o administrador ${a.nome || a.login || ""}? Ele não consegue mais entrar no painel.`)) return;
    const lote = writeBatch(db);
    lote.delete(doc(db, "admins", a.id));
    if (a.login) lote.delete(loginRef(a.login));
    semEsperar(lote.commit());
  });
  $$("[data-edit]", el).forEach(b => b.onclick = () => go(telaMotoristaForm, S.motoristas.find(x => x.id === b.dataset.edit)));
  $$("[data-verconv]", el).forEach(b => b.onclick = () => { const c = S.convites.find(x => x.id === b.dataset.verconv); go(telaConvite, { codigo: c.id, nome: c.nome, telefone: c.telefone }); });
  $$("[data-delconv]", el).forEach(b => b.onclick = () => { if (confirm("Cancelar este convite? O link deixa de funcionar.")) semEsperar(deleteDoc(doc(db, "convites", b.dataset.delconv))); });
  $$("[data-del]", el).forEach(b => b.onclick = () => {
    const m = S.motoristas.find(x => x.id === b.dataset.del);
    if (S.usosAtivos.some(u => u.motoristaId === m.id)) return toast("Esse motorista está com um carro. Encerre o uso antes.");
    if (!confirm(`Remover o motorista ${m.nome}? Ele não consegue mais entrar no app.`)) return;
    const b = writeBatch(db);
    b.delete(doc(db, "motoristas", m.id));
    if (m.login) b.delete(loginRef(m.login));
    semEsperar(b.commit());
  });
}

// Cria a conta de login de um motorista ou administrador sem desconectar quem está no painel
// (usa um 2º "app" só na memória)
let AUTH_CRIADOR = null;
async function criarConta(login, senha, adm) {
  if (!AUTH_CRIADOR) {
    const a = getApps().find(x => x.name === "criador") || initializeApp(C.firebase, "criador");
    AUTH_CRIADOR = getAuth(a);
    await setPersistence(AUTH_CRIADOR, inMemoryPersistence);
  }
  const email = adm ? `a.${login}.${Date.now().toString(36)}@admins.frota.app` : emailMotorista(login);
  try { return { uid: (await createUserWithEmailAndPassword(AUTH_CRIADOR, email, senha)).user.uid, email }; }
  catch (e) { throw new Error(erroLogin(e)); }
  finally { signOut(AUTH_CRIADOR).catch(() => {}); }
}

function telaMotoristaForm(m) {
  topo(m ? "Editar motorista" : "Cadastrar motorista", [["Voltar", () => go(telaAdmin)]]);
  const comCarro = m && S.usosAtivos.some(u => u.motoristaId === m.id);
  app.innerHTML = `
    <div class="card">
      ${m ? "<h2>Dados</h2>" : ""}
      <label for="mNome">Nome</label>
      <input id="mNome" maxlength="60" placeholder="Ex.: João Silva" value="${esc(m?.nome || "")}">
      <label for="mTel">WhatsApp (com DDD)</label>
      <input id="mTel" type="tel" inputmode="tel" maxlength="20" placeholder="Ex.: 11 91234-5678" value="${esc(m?.telefone || "")}">
      ${m ? `<button class="btn" id="mSalvar">Salvar</button>` : ""}
    </div>
    <div class="card">
      <h2>🔑 ${m ? "Usuário e senha" : "Acesso ao app"}</h2>
      ${m ? `<p class="muted">${m.login ? `Usuário atual: <b>${esc(m.login)}</b>` : "Este motorista ainda não tem usuário (versão antiga)."}
        Para trocar o usuário ou criar uma senha nova (ex.: ele esqueceu), preencha abaixo. Ele vai precisar entrar de novo com o acesso novo.</p>` : ""}
      <label for="mUser">Usuário</label>
      <input id="mUser" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="30" placeholder="Ex.: joao.silva" value="${esc(m?.login || "")}">
      <label for="mSenha">${m ? "Nova senha" : "Senha"} (mínimo 6 caracteres)</label>
      <div><input id="mSenha" type="password" autocomplete="new-password"></div>
      ${comCarro ? `<div class="alert">Este motorista está com um carro agora. Troque o acesso depois que ele devolver.</div>` : ""}
      <button class="btn ${m ? "sec" : "ok"}" id="mAcesso" ${comCarro ? "disabled" : ""}>${m ? "Salvar novo acesso" : "Cadastrar motorista"}</button>
      ${m ? "" : `<p class="muted">Depois é só mandar o usuário e a senha para ele (tem botão de WhatsApp). O próprio motorista também pode criar a conta dele em "Criar minha conta".</p>`}
    </div>`;
  olhoSenha("mSenha");
  $("#mUser").oninput = e => { e.target.value = normLogin(e.target.value); };
  const lerDados = () => {
    const nome = $("#mNome").value.trim().replace(/\s+/g, " "), telefone = $("#mTel").value.trim();
    if (nome.length < 2) { toast("Digite o nome"); return null; }
    if (soDigitos(telefone).length < 10) { toast("O WhatsApp é obrigatório: confira com DDD"); return null; }
    return { nome, telefone };
  };
  if (m) $("#mSalvar").onclick = () => {
    const d = lerDados(); if (!d) return;
    semEsperar(updateDoc(doc(db, "motoristas", m.id), d));
    toast("Motorista atualizado");
    go(telaAdmin);
  };
  $("#mAcesso").onclick = async () => {
    const d = lerDados(); if (!d) return;
    const login = normLogin($("#mUser").value), senha = $("#mSenha").value;
    if (login.length < 3) return toast("O usuário precisa ter pelo menos 3 letras/números");
    if (senha.length < 6) return toast("A senha precisa ter pelo menos 6 caracteres");
    if (m && S.usosAtivos.some(u => u.motoristaId === m.id)) return toast("Esse motorista está com um carro. Troque o acesso depois da devolução.");
    if (m && !confirm(`Trocar o acesso de ${m.nome}? O usuário/senha antigos deixam de funcionar.`)) return;
    ocupado(m ? "Trocando o acesso…" : "Cadastrando…");
    const ok = await tentar(async () => {
      const lk = await getDoc(loginRef(login));
      if (lk.exists() && lk.data().uid !== m?.id) throw new Error("Esse usuário já existe. Escolha outro.");
      const conta = await criarConta(login, senha);
      const b = writeBatch(db);
      // a conta nova recebe o cadastro (o histórico de usos antigos continua no relatório)
      const { id, ...resto } = m || {};
      b.set(doc(db, "motoristas", conta.uid), m
        ? { ...resto, ...d, login }
        : { ...d, login, disponivelEm: null, ultimoUso: serverTimestamp(), criadoEm: serverTimestamp(), tokens: [] });
      b.set(loginRef(login), { email: conta.email, uid: conta.uid, criadoEm: serverTimestamp() });
      if (m) {
        b.delete(doc(db, "motoristas", m.id));
        if (m.login && m.login !== login) b.delete(loginRef(m.login));
        S.reservas.filter(r => r.motoristaId === m.id).forEach(r => b.update(doc(db, "reservas", r.id), { motoristaId: conta.uid }));
      }
      await b.commit();
      return true;
    }, "Não foi possível salvar o acesso. Tente de novo.");
    if (!ok) return;
    go(telaAcessoCriado, { nome: d.nome, telefone: d.telefone, login, senha });
  };
}

function telaAcessoCriado(a) {
  topo("✅ Acesso pronto", [["Voltar", () => go(telaAdmin)]]);
  const msg = `Olá ${primeiroNome(a.nome)}! Seu acesso ao app da frota:\n${linkBase()}\nUsuário: ${a.login}\nSenha: ${a.senha}\n(Você pode trocar a senha depois, dentro do app.)`;
  app.innerHTML = `
    <div class="card center">
      <h2>${esc(a.nome)}</h2>
      <p>Usuário: <b>${esc(a.login)}</b><br>Senha: <b>${esc(a.senha)}</b></p>
      <p class="muted">Anote ou envie agora: a senha não aparece de novo.</p>
      ${a.telefone ? `<a class="btn ok" target="_blank" rel="noopener" href="${waLink(a.telefone, msg)}">💬 Enviar pelo WhatsApp</a>` : ""}
      <button class="btn sec" id="aCopiar">📋 Copiar usuário e senha</button>
      <button class="btn sec" id="aVoltar">Concluir</button>
    </div>`;
  $("#aCopiar").onclick = async () => {
    try { await navigator.clipboard.writeText(msg); toast("Copiado"); } catch (e) { toast("Não deu para copiar: anote o usuário e a senha"); }
  };
  $("#aVoltar").onclick = () => go(telaAdmin);
}

// Cadastro / edição de outro administrador (usuário e senha, como os motoristas)
function telaAdminForm(a) {
  topo(a ? "Editar administrador" : "Novo administrador", [["Voltar", () => go(telaAdmin)]]);
  app.innerHTML = `
    <div class="card">
      <label for="aNome">Nome</label>
      <input id="aNome" maxlength="60" placeholder="Ex.: Maria Souza" value="${esc(a?.nome || "")}">
      <label for="aTel">WhatsApp (opcional, para mandar o acesso)</label>
      <input id="aTel" type="tel" inputmode="tel" maxlength="20" placeholder="Ex.: 11 91234-5678" value="${esc(a?.telefone || "")}">
      ${a ? `<button class="btn" id="aSalvar">Salvar</button>` : ""}
    </div>
    <div class="card">
      <h2>🔑 ${a ? "Usuário e senha" : "Acesso ao painel"}</h2>
      ${a ? `<p class="muted">${a.login ? `Usuário atual: <b>${esc(a.login)}</b>.` : "Hoje ele entra com e-mail."}
        Para trocar o usuário ou criar uma senha nova, preencha abaixo. O acesso antigo para de funcionar.</p>` : `<p class="muted">Administrador vê e altera tudo no painel: carros, motoristas, relatórios e outros administradores.</p>`}
      <label for="aUser">Usuário</label>
      <input id="aUser" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="30" placeholder="Ex.: maria.adm" value="${esc(a?.login || "")}">
      <label for="aSenha">${a ? "Nova senha" : "Senha"} (mínimo 6 caracteres)</label>
      <div><input id="aSenha" type="password" autocomplete="new-password"></div>
      <button class="btn ${a ? "sec" : "ok"}" id="aAcesso">${a ? "Salvar novo acesso" : "Cadastrar administrador"}</button>
    </div>`;
  olhoSenha("aSenha");
  $("#aUser").oninput = e => { e.target.value = normLogin(e.target.value); };
  const lerDados = () => {
    const nome = $("#aNome").value.trim().replace(/\s+/g, " "), telefone = $("#aTel").value.trim();
    if (nome.length < 2) { toast("Digite o nome"); return null; }
    if (telefone && soDigitos(telefone).length < 10) { toast("Confira o WhatsApp com DDD"); return null; }
    return { nome, telefone };
  };
  if (a) $("#aSalvar").onclick = () => {
    const d = lerDados(); if (!d) return;
    semEsperar(updateDoc(doc(db, "admins", a.id), d));
    toast("Administrador atualizado");
    go(telaAdmin);
  };
  $("#aAcesso").onclick = async () => {
    const d = lerDados(); if (!d) return;
    const login = normLogin($("#aUser").value), senha = $("#aSenha").value;
    if (login.length < 3) return toast("O usuário precisa ter pelo menos 3 letras/números");
    if (senha.length < 6) return toast("A senha precisa ter pelo menos 6 caracteres");
    if (a && !confirm(`Trocar o acesso de ${a.nome || a.login || "este administrador"}? O acesso antigo deixa de funcionar.`)) return;
    ocupado(a ? "Trocando o acesso…" : "Cadastrando…");
    const ok = await tentar(async () => {
      const lk = await getDoc(loginRef(login));
      if (lk.exists() && lk.data().uid !== a?.id) throw new Error("Esse usuário já existe. Escolha outro.");
      const conta = await criarConta(login, senha, true);
      const lote = writeBatch(db);
      lote.set(doc(db, "admins", conta.uid), { ativo: true, ...d, login, email: conta.email, criadoEm: serverTimestamp() });
      lote.set(loginRef(login), { email: conta.email, uid: conta.uid, criadoEm: serverTimestamp() });
      if (a) {
        lote.delete(doc(db, "admins", a.id));
        if (a.login && a.login !== login) lote.delete(loginRef(a.login));
      }
      await lote.commit();
      return true;
    }, "Não foi possível salvar o acesso. Tente de novo.");
    if (!ok) return;
    go(telaAcessoCriado, { nome: d.nome, telefone: d.telefone, login, senha });
  };
}

function telaConvite(c) {
  topo("📨 Convite", [["Voltar", () => go(telaAdmin)]]);
  const link = linkConvite(c.codigo);
  const msg = `Olá ${primeiroNome(c.nome)}! Este é o seu acesso ao app da frota. Abra no seu celular: ${link}`;
  app.innerHTML = `
    <div class="card center">
      <h2>Convite de ${esc(c.nome)}</h2>
      <p class="muted">Mande o link para o celular do motorista ou peça para ele apontar a câmera para o QR Code abaixo. Vale por 7 dias e só pode ser usado uma vez.</p>
      <img src="${qrDataURL(link, 6)}" alt="QR Code do convite" style="width:220px;max-width:100%;image-rendering:pixelated;background:#fff;padding:8px;border-radius:10px">
      <input readonly value="${esc(link)}" onclick="this.select()" style="margin-top:10px">
      ${c.telefone ? `<a class="btn ok" target="_blank" rel="noopener" href="${waLink(c.telefone, msg)}">💬 Enviar pelo WhatsApp</a>` : ""}
      <button class="btn sec" id="copiar">📋 Copiar link</button>
    </div>`;
  $("#copiar").onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast("Link copiado"); } catch (e) { toast("Toque no link acima e copie"); }
  };
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
  el.innerHTML = `<input id="hBusca" placeholder="🔎 Buscar por carro, placa ou motorista"><div class="card" id="hLista"><div class="empty">Carregando…</div></div>
    <button class="btn sec" id="hLimpar">🧹 Limpar histórico</button>`;
  $("#hLimpar").onclick = limparHistorico;
  const snap = await tentar(() => getDocs(query(collection(db, "usos"), orderBy("inicio", "desc"), limit(100))));
  if (!snap || !$("#hLista")) return;
  let usos = lista(snap);
  const desenhar = () => {
    const b = $("#hBusca").value.trim().toLowerCase();
    const f = usos.filter(u => !b || `${u.carroNome} ${u.placa} ${u.motoristaNome}`.toLowerCase().includes(b));
    $("#hLista").innerHTML = f.length ? `<ul class="list">${f.map(u => `
      <li class="item click" data-rel="${u.id}"><div class="info">
        <div class="title">${esc(u.carroNome)} · ${esc(u.motoristaNome)}</div>
        <div class="muted">${fmt(u.inicio)} → ${u.fim ? fmt(u.fim) + " · " + duracao(u.inicio, u.fim) : "em andamento"}</div>
      </div><div class="acts"><span class="mini">📄 Relatório</span>
        ${u.fim ? `<button class="mini del" data-apagaruso="${u.id}" title="Apagar este uso">✕</button>` : ""}</div></li>`).join("")}</ul>` : `<div class="empty">Nenhum uso encontrado.</div>`;
    $$("[data-rel]").forEach(li => li.onclick = () => go(telaRelatorio, li.dataset.rel));
    $$("[data-apagaruso]").forEach(btn => btn.onclick = async ev => {
      ev.stopPropagation();
      const u = usos.find(x => x.id === btn.dataset.apagaruso);
      if (!confirm(`Apagar DEFINITIVAMENTE o uso do ${u.carroNome} por ${u.motoristaNome} (${fmt(u.inicio)})?\nSaem também as fotos, o vídeo, o trajeto e as ocorrências desse uso. Não dá para desfazer.`)) return;
      ocupado("Apagando…");
      const ok = await tentar(async () => { await apagarUso(u.id); return true; });
      if (!ok) return;
      usos = usos.filter(x => x.id !== u.id);
      toast("Uso apagado");
      desenhar();
    });
  };
  $("#hBusca").oninput = desenhar;
  desenhar();
}

// Apaga um uso já encerrado e tudo que é dele: vistorias, fotos/vídeos, trajeto, ocorrências e análise da IA
async function apagarUso(usoId) {
  const [vs, oc, ps] = await Promise.all([
    getDocs(query(collection(db, "vistorias"), where("usoId", "==", usoId))),
    getDocs(query(collection(db, "ocorrencias"), where("usoId", "==", usoId))),
    getDocs(collection(db, "usos", usoId, "pontos")),
  ]);
  const refs = [];
  const midia = m => { if (m?.grupo) for (let i = 0; i < (m.partes || 1); i++) refs.push(doc(db, "midias", `${m.grupo}_${i}`)); };
  vs.docs.forEach(d => { const v = d.data(); (v.fotos || []).forEach(midia); midia(v.video); refs.push(d.ref); });
  oc.docs.forEach(d => { (d.data().fotos || []).forEach(midia); refs.push(d.ref); });
  ps.docs.forEach(d => refs.push(d.ref));
  refs.push(doc(db, "analises", usoId));
  refs.push(doc(db, "usos", usoId));   // por último
  for (let i = 0; i < refs.length; i += 400) {
    const b = writeBatch(db);
    refs.slice(i, i + 400).forEach(r => b.delete(r));
    await b.commit();
  }
}

function limparHistorico() {
  const m = modal(`<h2>🧹 Limpar histórico</h2>
    <p class="muted">Apaga os usos já encerrados, com fotos, vídeos, trajetos, ocorrências e análises da IA. Carros em uso agora não são mexidos. <b>Não dá para desfazer.</b></p>
    <label for="lhDias">Apagar usos com mais de (dias)</label>
    <input id="lhDias" type="number" min="0" max="3650" value="90">
    <p class="muted" style="margin-top:-6px;font-size:12px">Use 0 para apagar TODO o histórico.</p>
    <button class="btn bad" id="lhOk">Apagar</button>
    <button class="btn sec" data-fechar>Cancelar</button>`);
  $("#lhOk", m.el).onclick = async () => {
    const d = parseInt($("#lhDias", m.el).value, 10);
    if (!(d >= 0)) return toast("Digite o número de dias");
    if (!confirm(d === 0 ? "Apagar TODO o histórico de usos? Não dá para desfazer." : `Apagar todos os usos com mais de ${d} dias? Não dá para desfazer.`)) return;
    m.fechar();
    let feitos = 0;
    const ok = await tentar(async () => {
      ocupado("Procurando usos…");
      const snap = await getDocs(query(collection(db, "usos"), where("inicio", "<", Timestamp.fromMillis(Date.now() - d * 864e5))));
      const encerrados = snap.docs.filter(x => x.data().fim != null);
      for (const x of encerrados) {
        ocupado(`Apagando… ${feitos} de ${encerrados.length}`);
        await apagarUso(x.id);
        feitos++;
      }
      return true;
    }, "Parou no meio. Toque em Limpar de novo para continuar.");
    if (ok) toast(feitos ? `${feitos} uso(s) apagado(s)` : "Nada para apagar", 4000);
    go(telaAdmin);
  };
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
    const [u, vs, ps, oc, ia] = await Promise.all([
      getDoc(doc(db, "usos", usoId)),
      getDocs(query(collection(db, "vistorias"), where("usoId", "==", usoId))),
      getDocs(query(collection(db, "usos", usoId, "pontos"), orderBy("t"), limit(3000))),
      getDocs(query(collection(db, "ocorrencias"), where("usoId", "==", usoId))).catch(() => null),
      getDoc(doc(db, "analises", usoId)).catch(() => null),
    ]);
    return { u: dados(u), vs: lista(vs), ps: lista(ps), oc: oc ? lista(oc) : [], ia: ia && ia.exists() ? dados(ia) : null };
  });
  if (!r) return;
  const { u, vs, ps, oc, ia } = r;
  const ret = vs.find(v => v.tipo === "retirada"), dev = vs.find(v => v.tipo === "devolucao");
  let dist = 0;
  for (let i = 1; i < ps.length; i++) dist += distM(ps[i - 1], ps[i]);
  const kmRodados = ret && dev ? dev.km - ret.km : null;
  const numero = usoId.slice(0, 8).toUpperCase();
  const veiculo = `${u.carroNome || ""}${u.placa ? " · " + u.placa : ""}`;
  // A tabela "folha" repete uma margem em cima e um rodapé em cada página impressa
  // (o endereço do site que o navegador imprime fica escondido: @page rel no index.html)
  app.innerHTML = `
    <div class="no-print acoes"><button class="btn" id="imprimir" disabled>⏳ Carregando fotos…</button></div>
    <article class="relatorio"><table class="folha">
     <thead><tr><td><div class="folha-topo"></div></td></tr></thead>
     <tfoot><tr><td><div class="folha-pe"><span>Relatório de uso do veículo · ${esc(veiculo)}</span><span>Nº ${numero}</span></div></td></tr></tfoot>
     <tbody><tr><td>
      <div class="rel-cab">
        <div><div class="rel-marca">Gestão de frota</div><h1>Relatório de uso do veículo</h1><div class="rel-sub">${esc(veiculo)}</div></div>
        <div class="rel-id">Nº <b>${numero}</b><br>${fmt(u.inicio)}</div>
      </div>
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
      ${oc.length ? `<h2>Ocorrências durante o uso (${oc.length})</h2><ul class="list">${oc.sort((a, b) => ms(a.criadoEm) - ms(b.criadoEm)).map(o => itemOcorrencia(o, false)).join("")}</ul>` : ""}
      ${ia || (ret && dev) ? `<h2>🤖 Análise de avarias pela IA</h2>
        ${ia ? `<p class="muted">Analisado em ${fmtCompleto(ia.criadoEm)} (${esc(ia.analisadoPor || "")})</p>${avariasIaHtml(ia)}` : `<p class="muted">Ainda não analisado.</p>`}
        ${IA_ATIVA() && ret && dev ? `<button class="btn sec no-print" id="iaRodar">🤖 ${ia ? "Analisar de novo" : "Comparar fotos com a IA"}</button>` : ""}` : ""}
      <p class="muted rodape">Relatório gerado em ${fmtCompleto(Date.now())}</p>
     </td></tr></tbody></table></article>`;
  $("#imprimir").onclick = () => {
    // nome do arquivo PDF: "Relatório Polo ABC1234 10-10-2026"
    const antes = document.title;
    document.title = `Relatório ${veiculo.replace(" · ", " ")} ${new Date(ms(u.inicio) || Date.now()).toLocaleDateString("pt-BR").replace(/\//g, "-")}`;
    addEventListener("afterprint", () => { document.title = antes; }, { once: true });
    window.print();
  };
  $("#iaRodar") && ($("#iaRodar").onclick = async () => {
    ocupado("🤖 A IA está comparando as fotos… (pode levar até 1 minuto)");
    const a = await tentar(() => analisarAvarias(usoId), "Não foi possível analisar agora.");
    if (a) { toast(a.avarias.length ? `🤖 ${a.avarias.length} possível(is) avaria(s) nova(s)` : "🤖 Nenhuma avaria nova encontrada", 5000); telaRelatorio(usoId); }
  });
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
    ${cardInstalar()}
    ${cardBiometria()}`;
  ligarInstalar();
  ligarBiometria(() => go(telaAdmin));
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
}

/* ---------- Minha conta (botão com o nome, no canto do topo) ---------- */
function meuAdmin() {
  const a = S.admins.find(x => x.id === S.user?.uid) || {};
  const email = S.user?.email || "";
  return { login: a.login || "", nome: a.nome || a.login || email.split("@")[0] || "Administrador", mostrar: a.login ? "usuário " + a.login : email };
}
function abrirMinhaConta() {
  const eu = meuAdmin();
  const m = modal("");
  const sheet = $(".sheet", m.el);
  const menu = () => {
    sheet.innerHTML = `<h2>👤 ${esc(eu.nome)}</h2>
      <p class="muted">Conectado como <b>${esc(eu.mostrar)}</b>.</p>
      <button class="btn sec" id="mcSenha">🔑 Trocar senha</button>
      ${eu.login ? "" : `<button class="btn sec" id="mcEmail">✉️ Trocar e-mail</button>`}
      <button class="btn bad" id="mcSair">Sair</button>
      <button class="btn sec" data-fechar>Fechar</button>`;
    $("#mcSenha", sheet).onclick = formSenha;
    $("#mcEmail", sheet) && ($("#mcEmail", sheet).onclick = formEmail);
    $("#mcSair", sheet).onclick = () => { if (confirm("Sair da administração? Será preciso digitar usuário e senha de novo.")) { m.fechar(); sairDaConta(); } };
  };
  const reautenticar = async () => {
    const senha = $("#mcAtual", sheet).value;
    if (!senha) throw new Error("Digite a senha atual.");
    await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(auth.currentUser.email, senha));
  };
  const formSenha = () => {
    sheet.innerHTML = `<h2>🔑 Trocar senha</h2>
      <label for="mcAtual">Senha atual</label><div><input id="mcAtual" type="password" autocomplete="current-password"></div>
      <label for="mcNova">Nova senha (mínimo 6 caracteres)</label><div><input id="mcNova" type="password" autocomplete="new-password"></div>
      <label for="mcNova2">Repita a nova senha</label><div><input id="mcNova2" type="password" autocomplete="new-password"></div>
      <button class="btn" id="mcOk">Salvar nova senha</button>
      <button class="btn sec" id="mcVoltar">Voltar</button>`;
    ["mcAtual", "mcNova", "mcNova2"].forEach(olhoSenha);
    $("#mcVoltar", sheet).onclick = menu;
    $("#mcOk", sheet).onclick = async () => {
      const nova = $("#mcNova", sheet).value;
      if (nova.length < 6) return toast("A nova senha precisa ter pelo menos 6 caracteres");
      if (nova !== $("#mcNova2", sheet).value) return toast("As duas senhas novas não são iguais");
      ocupado("Trocando a senha…");
      const ok = await tentar(async () => { await reautenticar(); await updatePassword(auth.currentUser, nova); return true; });
      if (ok) { m.fechar(); toast("Senha alterada!", 4000); }
    };
  };
  const formEmail = () => {
    sheet.innerHTML = `<h2>✉️ Trocar e-mail</h2>
      <label for="mcEmailNovo">Novo e-mail</label><input id="mcEmailNovo" type="email" inputmode="email" autocomplete="off">
      <label for="mcAtual">Senha atual</label><div><input id="mcAtual" type="password" autocomplete="current-password"></div>
      <p class="muted">Chega um link de confirmação no e-mail novo. O login só muda depois que você clicar nele.</p>
      <button class="btn" id="mcOk">Enviar confirmação</button>
      <button class="btn sec" id="mcVoltar">Voltar</button>`;
    olhoSenha("mcAtual");
    $("#mcVoltar", sheet).onclick = menu;
    $("#mcOk", sheet).onclick = async () => {
      const email = $("#mcEmailNovo", sheet).value.trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return toast("Digite um e-mail válido");
      ocupado("Enviando confirmação…");
      const ok = await tentar(async () => { await reautenticar(); await verifyBeforeUpdateEmail(auth.currentUser, email); return true; });
      if (ok) { m.fechar(); toast(`Link enviado para ${email}. Clique nele para concluir a troca (veja também o spam).`, 8000); }
    };
  };
  menu();
}

iniciar();
