require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const { getDb } = require('./db');
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


app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
      fontSrc: ["'self'", 'fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
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
      console.log(`[server] WhatsApp Grupos rodando em http://localhost:${PORT}`);
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