/*A foto é baixada UMA VEZ pelo servidor, redimensionada e comprimida com
   sharp, e salva localmente como WebP — evita hotlinking (403), economiza
   espaço em disco e acelera o carregamento nos cards.

   IMPORTANTE — limitador de velocidade (rate limit):
   O WhatsApp bloqueia com erro 429 quando recebemos várias requisições
   rápido demais (ex: importação em lote de muitos links). Por isso, toda
   chamada que bate no WhatsApp passa por `aguardarProximaJanela()`, que
   garante um intervalo mínimo entre uma requisição e outra — mesmo que
   sejam disparadas por rotas diferentes (importação em lote, cadastro
   normal, verificação de link, etc.), porque o controle é global no
   processo, não por chamada individual. */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PASTA_FOTOS = path.join(__dirname, '../../public/img/grupos');

// Tamanho final das fotos salvas: 120x120px, formato WebP, qualidade 75.
// WebP é ~30% menor que JPEG na mesma qualidade visual.
// 120x120 é suficiente para os avatares circulares dos cards.
const FOTO_LARGURA = 120;
const FOTO_ALTURA = 120;
const FOTO_QUALIDADE = 75;


// Intervalo mínimo entre requisições ao WhatsApp (ms). 1.5s é conservador
// o suficiente pra evitar 429 mesmo em importações de várias dezenas de links.
const INTERVALO_MINIMO_MS = 1500;

// Quantas vezes tenta de novo se receber 429, e quanto tempo espera a cada tentativa.
const MAX_TENTATIVAS_429 = 3;
const ESPERA_BASE_429_MS = 5000; // primeira espera: 5s, depois 10s, depois 20s (backoff exponencial)

const TIMEOUT_REQUISICAO_MS = 15000; // 15s — evita travar pra sempre numa requisição sem resposta

let proximaJanelaDisponivel = 0;

// Garante que, no mínimo, INTERVALO_MINIMO_MS tenha passado desde a última
// requisição feita ao WhatsApp por qualquer parte do sistema.
async function aguardarProximaJanela() {
  const agora = Date.now();
  const espera = Math.max(0, proximaJanelaDisponivel - agora);

  // Reserva a próxima janela já considerando a espera atual, antes mesmo
  // de aguardar — assim, chamadas concorrentes (ex: vários itens de um
  // lote disparados quase juntos) se enfileiram corretamente em vez de
  // todas acharem que "a vez é agora".
  proximaJanelaDisponivel = Math.max(proximaJanelaDisponivel, agora) + INTERVALO_MINIMO_MS;

  if (espera > 0) {
    await dormir(espera);
  }
}

function dormir(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Faz a requisição e consome o corpo dentro da mesma janela de timeout.
// Antes, o temporizador era cancelado assim que os cabeçalhos chegavam; se o
// WhatsApp demorasse ou travasse ao enviar o HTML, `resp.text()` podia ficar
// pendurado indefinidamente e o modal nunca terminava.
async function fetchControlado(url, opcoes = {}, configuracao = {}) {
  await aguardarProximaJanela();

  const controller = new AbortController();
  const timeoutMs = Number(configuracao.timeoutMs || TIMEOUT_REQUISICAO_MS);
  const tipoCorpo = configuracao.tipoCorpo || 'text';
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, { ...opcoes, signal: controller.signal });
    const corpo = tipoCorpo === 'arrayBuffer'
      ? await resp.arrayBuffer()
      : await resp.text();

    return {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      url: resp.url,
      headers: resp.headers,
      corpo
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Retry configurável para 429. Na verificação manual usamos zero retries:
// 429 é tratado como inconclusivo e o lote continua, em vez de ficar vários
// minutos aguardando backoff de 5s, 10s e 20s para cada grupo.
async function fetchComRetry429(url, opcoes = {}, contexto = '', configuracao = {}) {
  const maxTentativas429 = Number.isInteger(configuracao.maxTentativas429)
    ? Math.max(0, configuracao.maxTentativas429)
    : MAX_TENTATIVAS_429;

  for (let tentativa = 0; tentativa <= maxTentativas429; tentativa++) {
    const resp = await fetchControlado(url, opcoes, configuracao);

    if (resp.status !== 429) {
      return resp;
    }

    if (tentativa === maxTentativas429) {
      console.warn(`[whatsappPreview] ${contexto} encerrou após HTTP 429: ${url}`);
      return resp;
    }

    const espera = ESPERA_BASE_429_MS * Math.pow(2, tentativa);
    console.warn(`[whatsappPreview] ${contexto} recebeu 429 (tentativa ${tentativa + 1}/${maxTentativas429}), aguardando ${espera}ms antes de tentar de novo: ${url}`);
    await dormir(espera);
  }
}

async function buscarPreviewGrupo(link) {
  try {
    const resp = await fetchComRetry429(link, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkHubBot/1.0)' },
      redirect: 'follow'
    }, 'buscarPreviewGrupo', { tipoCorpo: 'text' });

    if (!resp.ok) {
      console.warn(`[whatsappPreview] página do link retornou ${resp.status}: ${link}`);
      return { foto: null, nome: null };
    }

    const html = resp.corpo;

    const fotoBruta = extrairMetaTag(html, 'og:image');
    const nomeBruto = extrairMetaTag(html, 'og:title');

    console.log(`[whatsappPreview] og:image encontrado? ${fotoBruta ? 'SIM — ' + fotoBruta : 'NÃO'}`);
    console.log(`[whatsappPreview] og:title encontrado? ${nomeBruto ? 'SIM — ' + nomeBruto : 'NÃO'}`);

    return {
      foto: decodificarEntidadesHtml(fotoBruta),
      nome: decodificarEntidadesHtml(nomeBruto)
    };
  } catch (err) {
    console.error('[whatsappPreview] falha ao buscar preview:', err.message);
    return { foto: null, nome: null };
  }
}

// Baixa, redimensiona e salva a foto do grupo localmente como WebP 120x120.
// Retorna o caminho público (ex: /img/grupos/grupo-42.webp) ou null se falhar.
async function baixarFotoGrupo(urlImagem, idGrupo) {
  if (!urlImagem) {
    console.log(`[whatsappPreview] grupo ${idGrupo}: nenhuma URL de foto pra baixar (og:image ausente).`);
    return null;
  }

  try {
    console.log(`[whatsappPreview] grupo ${idGrupo}: tentando baixar foto de ${urlImagem}`);

    const resp = await fetchComRetry429(urlImagem, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LinkHubBot/1.0)',
        'Referer': 'https://chat.whatsapp.com/'
      }
    }, `baixarFotoGrupo grupo ${idGrupo}`, { tipoCorpo: 'arrayBuffer' });

    if (!resp.ok) {
      console.warn(`[whatsappPreview] grupo ${idGrupo}: download da foto retornou ${resp.status} ${resp.statusText}`);
      return null;
    }

    const buffer = Buffer.from(resp.corpo);
    console.log(`[whatsappPreview] grupo ${idGrupo}: ${buffer.length} bytes baixados, processando com sharp...`);

    if (!fs.existsSync(PASTA_FOTOS)) {
      fs.mkdirSync(PASTA_FOTOS, { recursive: true });
      console.log(`[whatsappPreview] pasta criada: ${PASTA_FOTOS}`);
    }

    const nomeArquivo = `grupo-${idGrupo}.webp`;
    const caminhoCompleto = path.join(PASTA_FOTOS, nomeArquivo);

    // Redimensiona pra 120x120, cobre o espaço (cover) e converte pra WebP.
    // Sharp processa em stream via libvips — não precisa ter a imagem inteira
    // na heap do Node, ideal pra VPS com RAM limitada.
    await sharp(buffer)
      .resize(FOTO_LARGURA, FOTO_ALTURA, { fit: 'cover', position: 'centre' })
      .webp({ quality: FOTO_QUALIDADE })
      .toFile(caminhoCompleto);

    const stats = fs.statSync(caminhoCompleto);
    console.log(`[whatsappPreview] grupo ${idGrupo}: foto salva em ${nomeArquivo} (${Math.round(stats.size / 1024)}KB)`);

    return `/img/grupos/${nomeArquivo}`;
  } catch (err) {
    console.error(`[whatsappPreview] grupo ${idGrupo}: falha ao baixar/salvar foto:`, err.message);
    return null;
  }
}

// Verifica o estado de um link de convite do WhatsApp e diferencia uma
// resposta conclusiva de uma falha temporária da rede/servidor. Isso evita
// retirar grupos do site por timeout, bloqueio 429 ou instabilidade do WhatsApp.
async function verificarStatusLink(link) {
  try {
    const resp = await fetchComRetry429(link, {
      headers: {
        // Cabeçalhos semelhantes aos de um navegador real. Isso não burla um
        // bloqueio 429, mas evita respostas genéricas causadas por um user-agent
        // de bot quando o WhatsApp aceita a consulta normalmente.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Upgrade-Insecure-Requests': '1'
      },
      redirect: 'follow'
    }, 'verificarStatusLink', {
      tipoCorpo: 'text',
      timeoutMs: 10000,
      maxTentativas429: 0
    });

    const httpStatus = Number(resp.status || 0) || null;

    if (resp.status === 429) {
      console.warn(`[whatsappPreview] verificação inconclusiva: ${link} retornou 429`);
      return {
        resultado: 'inconclusivo',
        motivo: 'O WhatsApp bloqueou temporariamente as consultas da VPS (HTTP 429). Abra o convite e confirme manualmente.',
        httpStatus
      };
    }

    if (resp.status >= 500) {
      console.warn(`[whatsappPreview] verificação inconclusiva: ${link} retornou ${resp.status}`);
      return {
        resultado: 'inconclusivo',
        motivo: `WhatsApp respondeu temporariamente com HTTP ${resp.status}.`,
        httpStatus
      };
    }

    if (resp.status === 404 || resp.status === 410) {
      console.warn(`[whatsappPreview] link inválido: ${link} retornou ${resp.status}`);
      return {
        resultado: 'invalido',
        motivo: `Convite não encontrado pelo WhatsApp (HTTP ${resp.status}).`,
        httpStatus
      };
    }

    if (!resp.ok) {
      console.warn(`[whatsappPreview] verificação inconclusiva: ${link} retornou ${resp.status}`);
      return {
        resultado: 'inconclusivo',
        motivo: `Resposta HTTP ${resp.status} não permitiu confirmar o convite.`,
        httpStatus
      };
    }

    const html = String(resp.corpo || '');
    const textoPagina = normalizarTextoPagina(html);
    const nomeOg = decodificarEntidadesHtml(extrairMetaTag(html, 'og:title'));
    const imagemOg = extrairMetaTag(html, 'og:image');
    const nomeEstruturado = extrairNomeEstruturado(html);

    // Só classificamos como inválido quando há evidência explícita. A ausência
    // de og:title pode ser apenas uma página carregada por JavaScript ou uma
    // resposta genérica, portanto agora é inconclusiva e não falsa invalidação.
    const indicaInvalido = /convite\s+(?:do\s+grupo\s+)?inv[aá]lido|link\s+(?:do\s+convite\s+)?expirou|este\s+convite\s+n[aã]o\s+est[aá]\s+mais\s+dispon[ií]vel|invite\s+link\s+is\s+invalid|invite\s+link\s+has\s+expired|couldn['’]?t\s+load\s+group\s+info|this\s+invite\s+link\s+is\s+no\s+longer\s+available/i.test(textoPagina);

    if (indicaInvalido) {
      console.warn(`[whatsappPreview] link inválido: ${link} contém aviso explícito de convite indisponível`);
      return {
        resultado: 'invalido',
        motivo: 'O WhatsApp informou explicitamente que o convite está inválido, expirado ou indisponível.',
        httpStatus
      };
    }

    const nomeEspecifico = [nomeOg, nomeEstruturado]
      .find((nome) => nome && !/^(whatsapp|whatsapp group invite|convite para grupo|join whatsapp group)$/i.test(String(nome).trim()));

    const fraseConviteAtivo = /convite\s+para\s+conversa\s+em\s+grupo|invite\s+to\s+group\s+chat/i.test(textoPagina);
    const botoesConviteAtivo = /abrir\s+app|continuar\s+para\s+o\s+whatsapp\s+web|open\s+app|continue\s+to\s+whatsapp\s+web/i.test(textoPagina);

    // Nome específico é o sinal mais forte. Nome estruturado + foto ou a
    // combinação da frase e dos botões da tela de convite também confirmam a
    // página ativa quando o HTML não usa mais exatamente a antiga og:title.
    if (nomeEspecifico || (imagemOg && fraseConviteAtivo) || (fraseConviteAtivo && botoesConviteAtivo)) {
      return {
        resultado: 'valido',
        motivo: nomeEspecifico
          ? `Convite ativo; dados do grupo encontrados${nomeEspecifico ? ` (${nomeEspecifico})` : ''}.`
          : 'Convite ativo; a página normal de entrada do grupo foi encontrada.',
        httpStatus
      };
    }

    console.warn(`[whatsappPreview] verificação inconclusiva: ${link} respondeu 200 sem sinais suficientes`);
    return {
      resultado: 'inconclusivo',
      motivo: 'O WhatsApp respondeu, mas a página não trouxe sinais suficientes para confirmar se o convite está ativo. Abra o link e confirme manualmente.',
      httpStatus
    };
  } catch (err) {
    const motivo = err?.name === 'AbortError'
      ? 'Tempo limite excedido ao consultar o WhatsApp.'
      : `Falha temporária ao consultar o WhatsApp: ${err.message || 'erro de rede'}.`;

    console.warn(`[whatsappPreview] verificação inconclusiva para ${link}:`, err.message);
    return {
      resultado: 'inconclusivo',
      motivo,
      httpStatus: null
    };
  }
}

function normalizarTextoPagina(html) {
  return decodificarEntidadesHtml(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, codigo) => String.fromCharCode(parseInt(codigo, 16)))
    .replace(/\\\//g, '/')
    .replace(/\s+/g, ' ')
    .trim());
}

function extrairNomeEstruturado(html) {
  const padroes = [
    /["'](?:groupName|group_name|subject)["']\s*:\s*["']([^"']{2,160})["']/i,
    /["'](?:groupName|group_name|subject)["']\s*,\s*["']([^"']{2,160})["']/i
  ];

  for (const padrao of padroes) {
    const match = String(html || '').match(padrao);
    if (match?.[1]) {
      return decodificarEntidadesHtml(match[1]
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, codigo) => String.fromCharCode(parseInt(codigo, 16)))
        .replace(/\\\//g, '/'));
    }
  }

  return null;
}

// Mantém compatibilidade com chamadas antigas. Resultado inconclusivo não é
// tratado como link morto: somente uma resposta conclusiva "invalido" retorna false.
async function linkAindaValido(link) {
  const verificacao = await verificarStatusLink(link);
  return verificacao.resultado !== 'invalido';
}

function extrairMetaTag(html, propriedade) {
  const padroes = [
    new RegExp(`<meta[^>]+property=["']${propriedade}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${propriedade}["']`, 'i')
  ];
  for (const padrao of padroes) {
    const match = html.match(padrao);
    if (match) return match[1];
  }
  return null;
}

function decodificarEntidadesHtml(texto) {
  if (!texto) return texto;
  return texto
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

module.exports = { buscarPreviewGrupo, baixarFotoGrupo, verificarStatusLink, linkAindaValido };
