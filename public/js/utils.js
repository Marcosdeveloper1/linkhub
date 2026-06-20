/* linkhub-utils.js — funções compartilhadas entre páginas */

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

  const linkAtivo = (href) => paginaAtual === href || paginaAtual.endsWith(href) ? 'ativo' : '';

  nav.innerHTML = `
    <div class="navbar-inner">
      <a href="/" class="navbar-logo">Link<span>Hub</span></a>
      <nav class="navbar-links">
        <a href="/" class="navbar-link ${linkAtivo('/') || linkAtivo('/index.html')}">Grupos</a>
        ${logado ? `<a href="/pages/meus-grupos.html" class="navbar-link ${linkAtivo('/pages/meus-grupos.html')}">Meus grupos</a>` : ''}
        ${logado ? `<a href="/pages/enviar-grupo.html" class="navbar-link ${linkAtivo('/pages/enviar-grupo.html')}">Enviar grupo</a>` : ''}
        ${logado && usuario?.role === 'admin' ? `<a href="/pages/admin.html" class="navbar-link ${linkAtivo('/pages/admin.html')}">Painel Admin</a>` : ''}
      </nav>
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
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
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