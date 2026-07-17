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

function normalizarWhatsappContato(valor) {
  let digitos = String(valor || '').replace(/\D/g, '');

  if (digitos.startsWith('00')) digitos = digitos.slice(2);
  if (digitos.length === 10 || digitos.length === 11) digitos = `55${digitos}`;

  if (!/^55\d{10,11}$/.test(digitos)) return null;

  const ddd = digitos.slice(2, 4);
  const numeroLocal = digitos.slice(4);
  if (ddd === '00' || /^(\d)\1+$/.test(digitos) || numeroLocal.length < 8) return null;

  return digitos;
}

function formatarWhatsappContato(valor) {
  const digitos = normalizarWhatsappContato(valor);
  if (!digitos) return '';

  const ddd = digitos.slice(2, 4);
  const local = digitos.slice(4);

  if (local.length === 9) {
    return `+55 (${ddd}) ${local.slice(0, 5)}-${local.slice(5)}`;
  }

  return `+55 (${ddd}) ${local.slice(0, 4)}-${local.slice(4)}`;
}

function aplicarMascaraWhatsappContato(valor) {
  let digitos = String(valor || '').replace(/\D/g, '');

  if (digitos.startsWith('55') && digitos.length > 11) {
    digitos = digitos.slice(2);
  }

  digitos = digitos.slice(0, 11);

  if (digitos.length <= 2) return digitos;
  if (digitos.length <= 6) return `(${digitos.slice(0, 2)}) ${digitos.slice(2)}`;
  if (digitos.length <= 10) {
    return `(${digitos.slice(0, 2)}) ${digitos.slice(2, 6)}-${digitos.slice(6)}`;
  }

  return `(${digitos.slice(0, 2)}) ${digitos.slice(2, 7)}-${digitos.slice(7)}`;
}

async function obterWhatsappContato() {
  return apiFetch('/auth/whatsapp');
}

async function salvarWhatsappContato(numero) {
  return apiFetch('/auth/whatsapp', {
    method: 'PUT',
    body: JSON.stringify({ numero })
  });
}

function chaveAdiamentoWhatsapp(usuarioId) {
  return `zapgrupos_whatsapp_adiado_ate_${usuarioId}`;
}

function whatsappEstaAdiado(usuarioId) {
  try {
    const ate = Number(localStorage.getItem(chaveAdiamentoWhatsapp(usuarioId)) || 0);
    if (!ate) return false;

    if (Date.now() >= ate) {
      localStorage.removeItem(chaveAdiamentoWhatsapp(usuarioId));
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function adiarModalWhatsappContato(usuarioId) {
  try {
    const doisDiasMs = 2 * 24 * 60 * 60 * 1000;
    localStorage.setItem(chaveAdiamentoWhatsapp(usuarioId), String(Date.now() + doisDiasMs));
  } catch {
    // O navegador pode bloquear o localStorage. Nesse caso, apenas fecha o modal.
  }
}

function abrirModalWhatsappContato(sessao) {
  const usuario = sessao?.usuario;
  if (!sessao?.logado || !usuario || usuario.role === 'admin') return;
  if (whatsappEstaAdiado(usuario.id)) return;
  if (document.getElementById('modal-whatsapp-contato-global')) return;

  const numeroAtual = usuario.whatsapp_formatado || formatarWhatsappContato(usuario.whatsapp_contato);
  const temNumero = Boolean(normalizarWhatsappContato(usuario.whatsapp_contato));

  const modal = document.createElement('div');
  modal.className = 'modal-fundo modal-whatsapp-contato-global';
  modal.id = 'modal-whatsapp-contato-global';
  modal.innerHTML = `
    <div class="modal-caixa whatsapp-contato-modal-caixa" role="dialog" aria-modal="true" aria-labelledby="whatsapp-contato-modal-titulo">
      <button class="modal-fechar" type="button" data-whatsapp-fechar aria-label="Fechar">&times;</button>

      <div class="whatsapp-contato-modal-icone" aria-hidden="true">☎</div>
      <span class="whatsapp-contato-modal-label">Contato administrativo</span>
      <h3 class="modal-titulo" id="whatsapp-contato-modal-titulo">
        ${temNumero ? 'Confirme seu WhatsApp' : 'Vincule seu WhatsApp'}
      </h3>
      <p class="whatsapp-contato-modal-texto">
        Este número será visível somente para os administradores do ZapGrupos, caso precisem falar com você sobre seus grupos.
      </p>

      <div class="aviso" id="aviso-whatsapp-contato-global"></div>

      <form id="form-whatsapp-contato-global" novalidate>
        <div class="form-grupo">
          <label class="form-label" for="input-whatsapp-contato-global">Número com DDD</label>
          <input
            class="form-input whatsapp-contato-input"
            id="input-whatsapp-contato-global"
            type="tel"
            inputmode="numeric"
            autocomplete="tel"
            maxlength="16"
            placeholder="(61) 99999-9999"
            value="${numeroAtual ? numeroAtual.replace(/^\+55\s*/, '') : ''}"
            required
          >
          <p class="form-dica">Exemplo: (61) 99999-9999. Não será exibido publicamente.</p>
        </div>

        <label class="whatsapp-contato-adiar">
          <input type="checkbox" id="nao-mostrar-whatsapp-2-dias">
          <span>Não mostrar novamente pelos próximos 2 dias</span>
        </label>

        <div class="whatsapp-contato-modal-acoes">
          <button class="btn btn-contorno" type="button" data-whatsapp-fechar>Agora não</button>
          <button class="btn btn-primario" id="btn-salvar-whatsapp-global" type="submit">
            ${temNumero ? 'Atualizar WhatsApp' : 'Salvar WhatsApp'}
          </button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('aberto'));

  const input = modal.querySelector('#input-whatsapp-contato-global');
  const form = modal.querySelector('#form-whatsapp-contato-global');
  const checkboxAdiar = modal.querySelector('#nao-mostrar-whatsapp-2-dias');
  const btnSalvar = modal.querySelector('#btn-salvar-whatsapp-global');
  let salvando = false;

  const fechar = () => {
    if (salvando) return;
    if (checkboxAdiar?.checked) adiarModalWhatsappContato(usuario.id);
    document.removeEventListener('keydown', aoPressionarEscape);
    modal.classList.remove('aberto');
    setTimeout(() => modal.remove(), 120);
  };

  modal.querySelectorAll('[data-whatsapp-fechar]').forEach((btn) => {
    btn.addEventListener('click', fechar);
  });

  modal.addEventListener('click', (evento) => {
    if (evento.target === modal) fechar();
  });

  const aoPressionarEscape = (evento) => {
    if (evento.key === 'Escape' && document.body.contains(modal)) fechar();
  };
  document.addEventListener('keydown', aoPressionarEscape);

  input.addEventListener('input', () => {
    input.value = aplicarMascaraWhatsappContato(input.value);
    limparAviso('aviso-whatsapp-contato-global');
  });

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    limparAviso('aviso-whatsapp-contato-global');

    if (!normalizarWhatsappContato(input.value)) {
      mostrarAviso(
        'aviso-whatsapp-contato-global',
        'Informe um número válido com DDD. Exemplo: (61) 99999-9999.'
      );
      input.focus();
      return;
    }

    salvando = true;
    btnCarregando(btnSalvar, true);

    try {
      const resposta = await salvarWhatsappContato(input.value);
      usuario.whatsapp_contato = resposta.whatsapp_contato;
      usuario.whatsapp_formatado = resposta.whatsapp_formatado;

      if (checkboxAdiar?.checked) adiarModalWhatsappContato(usuario.id);

      mostrarAviso(
        'aviso-whatsapp-contato-global',
        resposta.mensagem || 'WhatsApp salvo com sucesso.',
        'ok'
      );

      window.dispatchEvent(new CustomEvent('zapgrupos:whatsappAtualizado', {
        detail: resposta
      }));

      setTimeout(() => {
        salvando = false;
        document.removeEventListener('keydown', aoPressionarEscape);
        modal.classList.remove('aberto');
        setTimeout(() => modal.remove(), 120);
      }, 650);
    } catch (err) {
      salvando = false;
      btnCarregando(btnSalvar, false, temNumero ? 'Atualizar WhatsApp' : 'Salvar WhatsApp');
      mostrarAviso('aviso-whatsapp-contato-global', err.message);
    }
  });

  setTimeout(() => input.focus(), 120);
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

  window.zapgruposSessaoAtual = sessao;

  if (sessao.logado && sessao.usuario?.role !== 'admin') {
    setTimeout(() => abrirModalWhatsappContato(sessao), 180);
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
window.normalizarWhatsappContato = normalizarWhatsappContato;
window.formatarWhatsappContato = formatarWhatsappContato;
window.aplicarMascaraWhatsappContato = aplicarMascaraWhatsappContato;
window.obterWhatsappContato = obterWhatsappContato;
window.salvarWhatsappContato = salvarWhatsappContato;