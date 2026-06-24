/* zapgrupos-utils.js — funções compartilhadas entre páginas */

const API = '/api';

async function apiFetch(caminho, opcoes = {}) {
  const resp = await fetch(API + caminho, {
    headers: { 'Content-Type': 'application/json', ...opcoes.headers },
    credentials: 'include',
    ...opcoes
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.erro || 'Erro na requisição');
  return data;
}

async function verificarSessao() {
  try {
    return await apiFetch('/auth/me');
  } catch {
    return { logado: false };
  }
}

function montarNavbar(sessao) {
  const nav = document.getElementById('navbar');
  if (!nav) return;

  const { logado, usuario } = sessao;
  const paginaAtual = window.location.pathname;
  const ehAdmin = logado && usuario?.role === 'admin';

  const linkAtivo = (href) => paginaAtual === href || paginaAtual.endsWith(href) ? 'ativo' : '';

  nav.innerHTML = `
    <div class="navbar-inner">
      <a href="/" class="navbar-logo" aria-label="ZapGrupos - Página inicial">
        <img src="/img/icon.png" alt="" class="navbar-logo-icone" width="48" height="48">
        <span class="navbar-logo-texto">
          <span class="navbar-logo-whatsapp">Zap</span>
          <span class="navbar-logo-grupos">Grupos</span>
        </span>
      </a>

      <nav class="navbar-links" aria-label="Menu principal">
        ${logado && !ehAdmin ? `<a href="/pages/meus-grupos.html" class="navbar-link ${linkAtivo('/pages/meus-grupos.html')}">Meus grupos</a>` : ''}
        ${logado ? `<a href="/pages/enviar-grupo.html" class="navbar-link ${linkAtivo('/pages/enviar-grupo.html')}">Enviar grupo</a>` : ''}
        ${ehAdmin ? `<a href="/pages/admin.html" class="navbar-link ${linkAtivo('/pages/admin.html')}">Painel Admin</a>` : ''}
      </nav>

      ${logado ? `
        <div class="navbar-mobile-atalhos" id="navbar-mobile-atalhos">
          <button class="navbar-mobile-atalhos-btn" type="button" id="btn-mobile-atalhos" aria-label="Abrir atalhos" aria-expanded="false" aria-controls="menu-mobile-atalhos">
            <span class="navbar-mobile-atalhos-icone" aria-hidden="true"><img src="/img/icones/grade.png" alt=""></span>
            <span class="navbar-mobile-atalhos-texto">Ações</span>
          </button>

          <div class="navbar-mobile-atalhos-menu" id="menu-mobile-atalhos" aria-hidden="true">
            <a href="/pages/enviar-grupo.html" class="navbar-mobile-atalho-link ${linkAtivo('/pages/enviar-grupo.html')}">
              <span class="navbar-mobile-atalho-icone">
                <img src="/img/icones/enviargrupo.png" alt="" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='inline-flex';">
                <span class="navbar-mobile-atalho-fallback" style="display:none;">＋</span>
              </span>
              <span>Enviar grupo</span>
            </a>
            <a href="/pages/meus-grupos.html" class="navbar-mobile-atalho-link ${linkAtivo('/pages/meus-grupos.html')}">
              <span class="navbar-mobile-atalho-icone">
                <img src="/img/icones/meusgrupos.png" alt="" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='inline-flex';">
                <span class="navbar-mobile-atalho-fallback" style="display:none;">▣</span>
              </span>
              <span>Meus grupos</span>
            </a>
            ${ehAdmin ? `<a href="/pages/admin.html" class="navbar-mobile-atalho-link ${linkAtivo('/pages/admin.html')}">
              <span class="navbar-mobile-atalho-icone">
                <img src="/img/icones/paineladmin.png" alt="" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='inline-flex';">
                <span class="navbar-mobile-atalho-fallback" style="display:none;">⚙</span>
              </span>
              <span>Painel Admin</span>
            </a>` : ''}
          </div>
        </div>` : ''}

      <div class="navbar-actions">
        ${logado
          ? `<span class="navbar-user">Olá, ${usuario.nome.split(' ')[0]}</span>
             <button class="btn btn-contorno-branco btn-sm" id="btn-logout-navbar">Sair</button>`
          : `<a href="/pages/login.html" class="btn btn-contorno-branco btn-sm">Entrar</a>
             <a href="/pages/cadastro.html" class="btn btn-primario btn-sm">Cadastrar</a>`
        }
      </div>
    </div>
  `;

  const btnLogout = document.getElementById('btn-logout-navbar');
  if (btnLogout) btnLogout.addEventListener('click', fazerLogout);

  configurarMenuMobileAtalhos();
}

function configurarMenuMobileAtalhos() {
  const wrapper = document.getElementById('navbar-mobile-atalhos');
  const btn = document.getElementById('btn-mobile-atalhos');
  const menu = document.getElementById('menu-mobile-atalhos');

  if (!wrapper || !btn || !menu) return;

  const fechar = () => {
    wrapper.classList.remove('aberto');
    btn.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-hidden', 'true');
  };

  const alternar = (evento) => {
    evento.stopPropagation();
    const abriu = wrapper.classList.toggle('aberto');
    btn.setAttribute('aria-expanded', String(abriu));
    menu.setAttribute('aria-hidden', String(!abriu));
  };

  btn.addEventListener('click', alternar);

  menu.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', fechar);
  });

  document.addEventListener('click', (evento) => {
    if (!wrapper.contains(evento.target)) fechar();
  });

  document.addEventListener('keydown', (evento) => {
    if (evento.key === 'Escape') fechar();
  });
}

async function fazerLogout() {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
  } finally {
    window.location.href = '/';
  }
}

function mostrarAviso(elementoId, mensagem, tipo = 'erro') {
  const el = document.getElementById(elementoId);
  if (!el) return;
  el.className = `aviso visivel aviso-${tipo === 'ok' ? 'ok' : 'erro'}`;
  el.textContent = mensagem;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function limparAviso(elementoId) {
  const el = document.getElementById(elementoId);
  if (el) el.className = 'aviso';
}

function btnCarregando(btn, sim = true, textoOriginal = '') {
  if (sim) {
    btn.dataset.textoOriginal = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span>';
    btn.disabled = true;
  } else {
    btn.innerHTML = btn.dataset.textoOriginal || textoOriginal;
    btn.disabled = false;
  }
}

function formatarData(str) {
  if (!str) return '';
  const d = new Date(str.endsWith('Z') ? str : str + 'Z');
  const data = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `${data} às ${hora}`;
}

function iconeCategoria(icone) {
  return `<svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><use href="#icone-${icone}"></use></svg>`;
}

async function iniciarPagina(opcoesRedirecionamento = {}) {
  const sessao = await verificarSessao();
  montarNavbar(sessao);

  if (opcoesRedirecionamento.requerLogin && !sessao.logado) {
    window.location.href = '/pages/login.html?redirect=' + encodeURIComponent(window.location.pathname);
    return null;
  }

  if (opcoesRedirecionamento.requerAdmin && sessao.usuario?.role !== 'admin') {
    window.location.href = '/';
    return null;
  }

  if (opcoesRedirecionamento.seLogadoIrPara && sessao.logado) {
    window.location.href = opcoesRedirecionamento.seLogadoIrPara;
    return null;
  }

  return sessao;
}

window.apiFetch = apiFetch;
window.iniciarPagina = iniciarPagina;
window.mostrarAviso = mostrarAviso;
window.limparAviso = limparAviso;
window.btnCarregando = btnCarregando;
window.formatarData = formatarData;
window.fazerLogout = fazerLogout;
