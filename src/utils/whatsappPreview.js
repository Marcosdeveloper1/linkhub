/* Busca a foto e o nome públicos de um grupo a partir do link de convite,
   usando as tags Open Graph que o WhatsApp expõe pra gerar prévias de link.
   A foto é baixada UMA VEZ pelo servidor, redimensionada e comprimida com
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

// Wrapper de fetch com timeout e respeito ao limitador de velocidade global.
async function fetchControlado(url, opcoes = {}) {
  await aguardarProximaJanela();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_REQUISICAO_MS);

  try {
    return await fetch(url, { ...opcoes, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// Igual ao fetchControlado, mas com retry automático e backoff exponencial
// especificamente para erro 429 (rate limit do WhatsApp).
async function fetchComRetry429(url, opcoes = {}, contexto = '') {
  for (let tentativa = 0; tentativa <= MAX_TENTATIVAS_429; tentativa++) {
    const resp = await fetchControlado(url, opcoes);

    if (resp.status !== 429) {
      return resp;
    }

    if (tentativa === MAX_TENTATIVAS_429) {
      console.warn(`[whatsappPreview] ${contexto} esgotou tentativas após 429 repetido: ${url}`);
      return resp;
    }

    const espera = ESPERA_BASE_429_MS * Math.pow(2, tentativa);
    console.warn(`[whatsappPreview] ${contexto} recebeu 429 (tentativa ${tentativa + 1}/${MAX_TENTATIVAS_429}), aguardando ${espera}ms antes de tentar de novo: ${url}`);
    await dormir(espera);
  }
}

async function buscarPreviewGrupo(link) {
  try {
    const resp = await fetchComRetry429(link, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkHubBot/1.0)' },
      redirect: 'follow'
    }, 'buscarPreviewGrupo');

    if (!resp.ok) {
      console.warn(`[whatsappPreview] página do link retornou ${resp.status}: ${link}`);
      return { foto: null, nome: null };
    }

    const html = await resp.text();

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
    }, `baixarFotoGrupo grupo ${idGrupo}`);

    if (!resp.ok) {
      console.warn(`[whatsappPreview] grupo ${idGrupo}: download da foto retornou ${resp.status} ${resp.statusText}`);
      return null;
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
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

// Verifica se um link de convite de grupo do WhatsApp ainda está ativo.
// Quando o administrador do grupo revoga o link (gera um novo) ou o grupo
// atinge o limite de membros, o WhatsApp deixa de servir a página normal
// de convite (com og:title/og:image do grupo) e passa a mostrar uma página
// genérica de erro/redirecionamento. Usamos isso como sinal de link inválido,
// já que não existe endpoint oficial para checar "este grupo ainda existe?".
async function linkAindaValido(link) {
  try {
    const resp = await fetchComRetry429(link, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkHubBot/1.0)' },
      redirect: 'follow'
    }, 'linkAindaValido');

    if (!resp.ok) {
      console.warn(`[whatsappPreview] verificação: ${link} retornou ${resp.status}`);
      return false;
    }

    const html = await resp.text();

    // Link revogado/expirado geralmente não tem mais a tag og:title
    // específica do grupo (ou a página vem vazia/genérica).
    const nome = extrairMetaTag(html, 'og:title');

    if (!nome) {
      console.warn(`[whatsappPreview] verificação: ${link} sem og:title — provável link morto`);
      return false;
    }

    // Heurística adicional: o WhatsApp mostra textos assim quando o convite
    // não é mais válido, mesmo retornando 200 OK.
    const indicaInvalido = /convite inv[aá]lido|link expirou|n[aã]o est[aá] mais dispon[ií]vel/i.test(html);
    if (indicaInvalido) {
      console.warn(`[whatsappPreview] verificação: ${link} contém texto de convite inválido`);
      return false;
    }

    return true;
  } catch (err) {
    console.warn(`[whatsappPreview] falha ao verificar link ${link}:`, err.message);
    // Erro de rede/timeout não é prova de que o link morreu — evita marcar
    // como indisponível por instabilidade temporária. Mantém como estava.
    return true;
  }
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

module.exports = { buscarPreviewGrupo, baixarFotoGrupo, linkAindaValido };
