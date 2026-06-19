require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const { getDb } = require('./db');
const { limiterGeral, sessionConfig } = require('./middleware/security');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
      fontSrc: ["'self'", 'fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"]
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
app.use(limiterGeral);

app.use(express.static(path.join(__dirname, '../public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/grupos', require('./routes/groups'));
app.use('/api/admin', require('./routes/admin'));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

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
    app.listen(PORT, () => {
      console.log(`[server] LinkHub rodando em http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[server] Falha ao iniciar:', err.message);
    console.error('Execute primeiro: npm run setup');
    process.exit(1);
  }
}

iniciar();
