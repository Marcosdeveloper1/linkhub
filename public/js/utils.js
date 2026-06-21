/* whatsapp-grupos-utils.js — funções compartilhadas entre páginas */

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
      <a href="/" class="navbar-logo" aria-label="WhatsApp Grupos - Página inicial">
        <img src="/img/icon.png" alt="" class="navbar-logo-icone" width="48" height="48">
        <span class="navbar-logo-texto">
          <span class="navbar-logo-whatsapp">WhatsApp</span>
          <span class="navbar-logo-grupos">Grupos</span>
        </span>
      </a>

      <nav class="navbar-links" aria-label="Menu principal">
        ${logado && !ehAdmin ? `<a href="/pages/meus-grupos.html" class="navbar-link ${linkAtivo('/pages/meus-grupos.html')}">Meus grupos</a>` : ''}
        ${logado ? `<a href="/pages/enviar-grupo.html" class="navbar-link ${linkAtivo('/pages/enviar-grupo.html')}">Enviar grupo</a>` : ''}
        ${ehAdmin ? `<a href="/pages/admin.html" class="navbar-link ${linkAtivo('/pages/admin.html')}">Painel Admin</a>` : ''}
      </nav>

      <div class="navbar-actions">
        ${logado
          ? `<span class="navbar-user">Olá, ${usuario.nome.split(' ')[0]}</span>
             <button class="btn btn-contorno-branco btn-sm" id="btn-logout-navbar">Sair</button>`
          : `<a href="/pages/login.html" class="btn btn-contorno-branco btn-sm">Entrar</a>
             <a href="/pages/cadastro.html" class="btn btn-primario btn-sm">Cadastrar</a>`
        }

        <button class="navbar-menu-btn" type="button" id="btn-menu-lateral" aria-label="Abrir menu" aria-expanded="false" aria-controls="menu-lateral">
          <span></span>
          <span></span>
          <span></span>
        </button>
      </div>
    </div>

    <div class="menu-lateral-overlay" id="menu-lateral-overlay" aria-hidden="true"></div>

    <aside class="menu-lateral" id="menu-lateral" aria-hidden="true">
      <div class="menu-lateral-topo">
        <div>
          <strong>Menu</strong>
          <span>WhatsApp Grupos</span>
        </div>
        <button class="menu-lateral-fechar" type="button" id="btn-fechar-menu" aria-label="Fechar menu">×</button>
      </div>

      <nav class="menu-lateral-links" aria-label="Links do site">
        <a href="/" class="menu-lateral-link ${linkAtivo('/')}">
          <span class="menu-lateral-icone">⌂</span>
          <span>Início</span>
        </a>

        ${logado
          ? `<a href="/pages/enviar-grupo.html" class="menu-lateral-link ${linkAtivo('/pages/enviar-grupo.html')}">
              <span class="menu-lateral-icone">＋</span>
              <span>Enviar grupo</span>
            </a>
            ${!ehAdmin ? `<a href="/pages/meus-grupos.html" class="menu-lateral-link ${linkAtivo('/pages/meus-grupos.html')}">
              <span class="menu-lateral-icone">▣</span>
              <span>Meus grupos</span>
            </a>` : ''}`
          : `<a href="/pages/cadastro.html" class="menu-lateral-link ${linkAtivo('/pages/cadastro.html')}">
              <span class="menu-lateral-icone">＋</span>
              <span>Divulgar grupo</span>
            </a>`
        }

        ${ehAdmin
          ? `<a href="/pages/admin.html" class="menu-lateral-link ${linkAtivo('/pages/admin.html')}">
              <span class="menu-lateral-icone">⚙</span>
              <span>Painel Admin</span>
            </a>`
          : ''
        }

        <div class="menu-lateral-divisor"></div>

        <a href="/pages/faq.html" class="menu-lateral-link ${linkAtivo('/pages/faq.html')}">
          <span class="menu-lateral-icone">?</span>
          <span>FAQ</span>
        </a>
        <a href="/pages/termos.html" class="menu-lateral-link ${linkAtivo('/pages/termos.html')}">
          <span class="menu-lateral-icone">§</span>
          <span>Termos de uso</span>
        </a>
        <a href="/pages/privacidade.html" class="menu-lateral-link ${linkAtivo('/pages/privacidade.html')}">
          <span class="menu-lateral-icone">◌</span>
          <span>Política de privacidade</span>
        </a>

        ${!logado
          ? `<div class="menu-lateral-divisor"></div>
            <a href="/pages/login.html" class="menu-lateral-link ${linkAtivo('/pages/login.html')}">
              <span class="menu-lateral-icone">→</span>
              <span>Entrar</span>
            </a>`
          : ''
        }
      </nav>
    </aside>
  `;

  const btnLogout = document.getElementById('btn-logout-navbar');
  if (btnLogout) btnLogout.addEventListener('click', fazerLogout);

  configurarMenuLateral();
}

function configurarMenuLateral() {
  const btnAbrir = document.getElementById('btn-menu-lateral');
  const btnFechar = document.getElementById('btn-fechar-menu');
  const overlay = document.getElementById('menu-lateral-overlay');
  const menu = document.getElementById('menu-lateral');

  if (!btnAbrir || !btnFechar || !overlay || !menu) return;

  const abrirMenu = () => {
    document.body.classList.add('menu-lateral-aberto');
    btnAbrir.setAttribute('aria-expanded', 'true');
    menu.setAttribute('aria-hidden', 'false');
  };

  const fecharMenu = () => {
    document.body.classList.remove('menu-lateral-aberto');
    btnAbrir.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-hidden', 'true');
  };

  btnAbrir.addEventListener('click', abrirMenu);
  btnFechar.addEventListener('click', fecharMenu);
  overlay.addEventListener('click', fecharMenu);

  menu.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', fecharMenu);
  });

  document.addEventListener('keydown', (evento) => {
    if (evento.key === 'Escape') fecharMenu();
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