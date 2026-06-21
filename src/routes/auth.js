const express = require('express');
const bcrypt = require('bcryptjs');
const validator = require('validator');
const router = express.Router();
const db = require('../db');
const { limiterLogin, limiterCadastro, sanitizeString } = require('../middleware/security');
const { emailBoasVindas } = require('../email');

router.post('/cadastro', limiterCadastro, async (req, res) => {
  try {
    const nome = sanitizeString(req.body.nome, 100);
    const email = sanitizeString(req.body.email, 200);
    const senha = req.body.senha;

    if (!nome || nome.length < 2) {
      return res.status(400).json({ erro: 'Nome deve ter pelo menos 2 caracteres.' });
    }

    if (!email || !validator.isEmail(email)) {
      return res.status(400).json({ erro: 'Email inválido.' });
    }

    if (!senha || senha.length < 8) {
      return res.status(400).json({ erro: 'Senha deve ter pelo menos 8 caracteres.' });
    }

    if (!/[A-Z]/.test(senha) || !/[0-9]/.test(senha)) {
      return res.status(400).json({ erro: 'Senha deve conter ao menos uma letra maiúscula e um número.' });
    }

    const emailNorm = validator.normalizeEmail(email);
    const existente = db.queryOne('SELECT id FROM users WHERE email = ?', [emailNorm]);
    if (existente) {
      return res.status(409).json({ erro: 'Este email já está cadastrado.' });
    }

    const hash = await bcrypt.hash(senha, 12);
    const id = db.run(
      'INSERT INTO users (nome, email, senha, role) VALUES (?, ?, ?, ?)',
      [nome, emailNorm, hash, 'user']
    );

    req.session.usuario = { id, nome, email: emailNorm, role: 'user' };

    emailBoasVindas(emailNorm, nome).catch(() => {});

    res.json({ ok: true, usuario: { id, nome, email: emailNorm, role: 'user' } });
  } catch (err) {
    console.error('[auth/cadastro]', err);
    res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
  }
});

router.post('/login', limiterLogin, async (req, res) => {
  try {
    const email = sanitizeString(req.body.email, 200);
    const senha = req.body.senha;

    if (!email || !senha) {
      return res.status(400).json({ erro: 'Email e senha obrigatórios.' });
    }

    const emailNorm = validator.isEmail(email) ? validator.normalizeEmail(email) : null;
    if (!emailNorm) {
      return res.status(400).json({ erro: 'Email inválido.' });
    }

    const usuario = db.queryOne(
      'SELECT id, nome, email, senha, role, ativo FROM users WHERE email = ?',
      [emailNorm]
    );

    const senhaOk = usuario ? await bcrypt.compare(senha, usuario.senha) : await bcrypt.hash(senha, 1);

    if (!usuario || !senhaOk) {
      return res.status(401).json({ erro: 'Email ou senha incorretos.' });
    }

    if (!usuario.ativo) {
      return res.status(403).json({ erro: 'Conta desativada. Entre em contato com o suporte.' });
    }

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ erro: 'Erro de sessão.' });
      req.session.usuario = {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        role: usuario.role
      };
      res.json({ ok: true, usuario: req.session.usuario });
    });
  } catch (err) {
    console.error('[auth/login]', err);
    res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('lh_sid');
    res.json({ ok: true });
  });
});

router.get('/me', (req, res) => {
  if (!req.session?.usuario) {
    return res.json({ logado: false });
  }
  res.json({ logado: true, usuario: req.session.usuario });
});

module.exports = router;