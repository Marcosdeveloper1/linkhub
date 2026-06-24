const rateLimit = require('express-rate-limit');
const session = require('express-session');
const crypto = require('crypto');

const limiterGeral = rateLimit({
  windowMs: 5 * 60 * 1000, // janela menor (5 min em vez de 15) — libera mais rápido
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições. Tente novamente em 15 minutos.' }
});

const limiterLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas de login. Aguarde 15 minutos.' }
});

const limiterCadastro = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Limite de cadastros atingido. Aguarde 1 hora.' }
});

const limiterGrupo = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Limite de envios de grupos atingido. Aguarde 1 hora.' }
});

const sessionConfig = session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(64).toString('hex'),
  resave: false,
  saveUninitialized: false,
  name: 'lh_sid',
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
});

function requireLogin(req, res, next) {
  if (!req.session?.usuario) {
    return res.status(401).json({ erro: 'Faça login para continuar.' });
  }
  next();
}

function emailsAdminPermitidos() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function requireAdmin(req, res, next) {
  const usuario = req.session?.usuario;

  if (!usuario || usuario.role !== 'admin') {
    return res.status(403).json({ erro: 'Acesso restrito.' });
  }

  // Quando ADMIN_EMAILS estiver definido no .env, só esses emails poderão acessar o admin.
  // Exemplo: ADMIN_EMAILS=julio01020354@gmail.com,email_do_marcos@gmail.com
  const permitidos = emailsAdminPermitidos();
  if (permitidos.length > 0 && !permitidos.includes(String(usuario.email || '').toLowerCase())) {
    return res.status(403).json({ erro: 'Seu email não está autorizado para acessar o painel admin.' });
  }

  next();
}

function sanitizeString(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

function isValidWhatsAppLink(url) {
  if (typeof url !== 'string') return false;
  const pattern = /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]{20,}$/;
  return pattern.test(url.trim());
}

module.exports = {
  limiterGeral,
  limiterLogin,
  limiterCadastro,
  limiterGrupo,
  sessionConfig,
  requireLogin,
  requireAdmin,
  sanitizeString,
  isValidWhatsAppLink
};