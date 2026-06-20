/* Busca a foto e o nome públicos de um grupo a partir do link de convite,
   usando as tags Open Graph que o WhatsApp expõe pra gerar prévias de link.
   A foto é baixada UMA VEZ pelo servidor e salva localmente, porque o CDN
   do WhatsApp bloqueia hotlinking direto do navegador (retorna 403). */

const fs = require('fs');
const path = require('path');

const PASTA_FOTOS = path.join(__dirname, '../../public/img/grupos');

async function buscarPreviewGrupo(link) {
  try {
    const resp = await fetch(link, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkHubBot/1.0)' },
      redirect: 'follow'
    });

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

// Baixa a imagem do CDN do WhatsApp e salva localmente em public/img/grupos/.
// Retorna o caminho público (ex: /img/grupos/grupo-42.jpg) ou null se falhar.
async function baixarFotoGrupo(urlImagem, idGrupo) {
  if (!urlImagem) {
    console.log(`[whatsappPreview] grupo ${idGrupo}: nenhuma URL de foto pra baixar (og:image ausente).`);
    return null;
  }

  try {
    console.log(`[whatsappPreview] grupo ${idGrupo}: tentando baixar foto de ${urlImagem}`);

    const resp = await fetch(urlImagem, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LinkHubBot/1.0)',
        'Referer': 'https://chat.whatsapp.com/'
      }
    });

    if (!resp.ok) {
      console.warn(`[whatsappPreview] grupo ${idGrupo}: download da foto retornou ${resp.status} ${resp.statusText}`);
      return null;
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    console.log(`[whatsappPreview] grupo ${idGrupo}: foto baixada, ${buffer.length} bytes`);

    if (!fs.existsSync(PASTA_FOTOS)) {
      fs.mkdirSync(PASTA_FOTOS, { recursive: true });
      console.log(`[whatsappPreview] pasta criada: ${PASTA_FOTOS}`);
    }

    const nomeArquivo = `grupo-${idGrupo}.jpg`;
    const caminhoCompleto = path.join(PASTA_FOTOS, nomeArquivo);
    fs.writeFileSync(caminhoCompleto, buffer);

    console.log(`[whatsappPreview] grupo ${idGrupo}: foto salva em ${caminhoCompleto}`);

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
    const resp = await fetch(link, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkHubBot/1.0)' },
      redirect: 'follow'
    });

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