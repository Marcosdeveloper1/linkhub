require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const { getDb } = db;
const { limiterGeral, sessionConfig } = require('./middleware/security');

const app = express();
const PORT = process.env.PORT || 3000;
const CATEGORIAS_PUBLICAS = new Set([
  'amizade',
  'relacionamento',
  'carros',
  'cidade',
  'compras-e-vendas',
  'concursos',
  'desenhos',
  'divulgacao',
  'educacao',
  'emagrecimento',
  'dinheiro',
  'investimentos',
  'links',
  'receitas',
  'religiao',
  'turismo',
  'politica',
  'tecnologia',
  'saude',
  'entretenimento',
  'empregos',
  'negocios',
  'esportes',
  'outros'
]);

function enviarHome(req, res) {
  res.sendFile(path.join(__dirname, '../public/index.html'));
}


function siteBaseUrl() {
  return (process.env.SITE_URL || 'https://zapgrupos.site').replace(/\/+$/, '');
}

function escapeXml(valor) {
  return String(valor || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatarDataSitemap(valor) {
  if (!valor) return new Date().toISOString();
  const data = new Date(String(valor).replace(' ', 'T') + 'Z');
  if (Number.isNaN(data.getTime())) return new Date().toISOString();
  return data.toISOString();
}

function linhaSitemap(loc, lastmod, changefreq = 'weekly', priority = '0.7') {
  return `  <url>\n    <loc>${escapeXml(loc)}</loc>\n    <lastmod>${escapeXml(lastmod || new Date().toISOString())}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;}


app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],

      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        'https://sdk.mercadopago.com',
        'https://*.mercadopago.com',
        'https://*.mercadopago.com.br',
        'https://*.mlstatic.com',

        // Adsterra
        'https://www.highperformanceformat.com',
        'https://highperformanceformat.com',
        'https://pl29902612.effectivecpmnetwork.com',
        'https://*.effectivecpmnetwork.com'
      ],

      scriptSrcElem: [
        "'self'",
        "'unsafe-inline'",
        'https://sdk.mercadopago.com',
        'https://*.mercadopago.com',
        'https://*.mercadopago.com.br',
        'https://*.mlstatic.com',

        // Adsterra
        'https://www.highperformanceformat.com',
        'https://highperformanceformat.com',
        'https://pl29902612.effectivecpmnetwork.com',
        'https://*.effectivecpmnetwork.com'
      ],

      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        'fonts.googleapis.com'
      ],

      fontSrc: [
        "'self'",
        'fonts.gstatic.com'
      ],

      imgSrc: [
        "'self'",
        'data:',
        'https:',
        'https://*.mercadopago.com',
        'https://*.mercadopago.com.br',
        'https://*.mlstatic.com',

        // Adsterra / redes de anúncios
        'https://*.effectivecpmnetwork.com',
        'https://*.highperformanceformat.com'
      ],

      connectSrc: [
        "'self'",
        'https://api.mercadopago.com',
        'https://*.mercadopago.com',
        'https://*.mercadopago.com.br',
        'https://*.mlstatic.com',

        // Adsterra
        'https://www.highperformanceformat.com',
        'https://highperformanceformat.com',
        'https://pl29902612.effectivecpmnetwork.com',
        'https://*.effectivecpmnetwork.com'
      ],

      frameSrc: [
        "'self'",
        'https://*.mercadopago.com',
        'https://*.mercadopago.com.br',

        // Adsterra
        'https://www.highperformanceformat.com',
        'https://highperformanceformat.com',
        'https://*.effectivecpmnetwork.com'
      ],

      childSrc: [
        "'self'",
        'https://www.highperformanceformat.com',
        'https://highperformanceformat.com',
        'https://*.effectivecpmnetwork.com'
      ],

      upgradeInsecureRequests: null
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || true,
  credentials: true
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(sessionConfig);

app.get('/sitemap.xml', (req, res) => {
  try {
    const baseUrl = siteBaseUrl();
    const agora = new Date().toISOString();

    const urls = [];
    urls.push(linhaSitemap(`${baseUrl}/`, agora, 'daily', '1.0'));

    Array.from(CATEGORIAS_PUBLICAS).forEach((slug) => {
      urls.push(linhaSitemap(`${baseUrl}/${slug}`, agora, 'daily', '0.9'));
    });

    [
      '/pages/faq.html',
      '/pages/termos.html',
      '/pages/privacidade.html'
    ].forEach((rota) => {
      urls.push(linhaSitemap(`${baseUrl}${rota}`, agora, 'monthly', '0.5'));
    });

    const grupos = db.query(`
      SELECT id, COALESCE(aprovado_em, criado_em, datetime('now')) as atualizado_em
      FROM groups
      WHERE status = 'aprovado'
      ORDER BY id DESC
      LIMIT 50000
    `);

    grupos.forEach((grupo) => {
      urls.push(linhaSitemap(
        `${baseUrl}/pages/grupo.html?id=${grupo.id}`,
        formatarDataSitemap(grupo.atualizado_em),
        'weekly',
        '0.8'
      ));
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;

    res.type('application/xml');
    res.send(xml);
  } catch (err) {
    console.error('[sitemap]', err);
    res.status(500).type('text/plain').send('Erro ao gerar sitemap.');
  }
});

// Arquivos estáticos servidos ANTES do rate limiter e sem passar por ele —
// HTML, CSS, JS e fontes não devem contar contra o limite de requisições.
app.use(express.static(path.join(__dirname, '../public')));

// O rate limiter agora protege só as rotas de API (login, cadastro,
// envio de grupo etc.), que são as que de fato precisam de proteção
// contra abuso e força bruta.
app.use('/api', limiterGeral);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/grupos', require('./routes/groups'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/zapcoins', require('./routes/zapcoins'));
app.use('/api/webhooks', require('./routes/webhooks'));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));


// URLs públicas de categorias, ex: /dinheiro, /turismo, /religiao.
// A rota fica depois dos arquivos estáticos e da API para não quebrar /css, /js, /img, /pages ou /api.
app.get('/:categoriaSlug', (req, res, next) => {
  const categoriaSlug = String(req.params.categoriaSlug || '').toLowerCase();

  if (!CATEGORIAS_PUBLICAS.has(categoriaSlug)) {
    return next();
  }

  return enviarHome(req, res);
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ erro: 'Rota não encontrada.' });
  }
  next();
});

app.use((err, req, res, next) => {
  console.error('[server error]', err);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

async function iniciar() {
  try {
    await getDb();
    console.log('[db] Banco de dados carregado.');

    const servidor = app.listen(PORT, () => {
      console.log(`[server] ZapGrupos rodando em http://localhost:${PORT}`);
    });

    servidor.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n[server] ❌ A porta ${PORT} já está em uso por outro processo.`);
        console.error('[server] Isso geralmente acontece quando o servidor anterior não foi fechado corretamente.');
        console.error('[server] No Windows, rode: netstat -ano | findstr :' + PORT);
        console.error('[server] Depois: taskkill /PID <numero_do_pid> /F\n');
        process.exit(1);
      } else {
        console.error('[server] Erro inesperado ao iniciar:', err);
        process.exit(1);
      }
    });
  } catch (err) {
    console.error('[server] Falha ao iniciar:', err.message);
    console.error('Execute primeiro: npm run setup');
    process.exit(1);
  }
}

iniciar();
