const express = require('express');
const bcrypt = require('bcryptjs');
const validator = require('validator');
const { OAuth2Client } = require('google-auth-library');
const router = express.Router();
const db = require('../db');
const { limiterLogin, limiterCadastro, requireLogin, sanitizeString } = require('../middleware/security');
const { emailBoasVindas } = require('../email');

// ===================================================================
// LOGIN COM GOOGLE
// ===================================================================

const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_CALLBACK_URL
);

function emailsAdminPermitidos() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}


function normalizarWhatsappContato(valor) {
  let digitos = String(valor || '').replace(/\D/g, '');

  if (digitos.startsWith('00')) {
    digitos = digitos.slice(2);
  }

  if (digitos.length === 10 || digitos.length === 11) {
    digitos = `55${digitos}`;
  }

  if (!/^55\d{10,11}$/.test(digitos)) {
    return null;
  }

  const ddd = digitos.slice(2, 4);
  const numeroLocal = digitos.slice(4);

  if (/^(\d)\1+$/.test(digitos) || ddd === '00' || numeroLocal.length < 8) {
    return null;
  }

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

function usuarioPublico(usuario) {
  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    role: usuario.role,
    whatsapp_contato: usuario.whatsapp_contato || null,
    whatsapp_formatado: formatarWhatsappContato(usuario.whatsapp_contato)
  };
}

function vincularGruposPendentesAoUsuario(usuario) {
  const email = String(usuario.email || '').toLowerCase().trim();
  if (!email || !usuario?.id) return;

  try {
    db.run(
      `UPDATE groups
       SET usuario_id = ?,
           owner_user_id = ?,
           ownership_status = 'vinculado',
           ownership_claimed_at = COALESCE(ownership_claimed_at, datetime('now'))
       WHERE LOWER(COALESCE(owner_email, '')) = ?
         AND (usuario_id IS NULL OR usuario_id = ?)
         AND (owner_user_id IS NULL OR owner_user_id = ?)`,
      [usuario.id, usuario.id, email, usuario.id, usuario.id]
    );
  } catch (err) {
    console.error('[auth] falha ao vincular grupos pendentes:', err.message);
  }
}

// GET /api/auth/google — redireciona o usuário pro Google
router.get('/google', (req, res) => {
  const redirectFinal = typeof req.query.redirect === 'string' ? req.query.redirect : '/';

  const authUrl = googleClient.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    // Guardamos o destino final (ex: /pages/meus-grupos.html) num "state" assinado pelo próprio Google OAuth flow.
    state: Buffer.from(JSON.stringify({ redirect: redirectFinal })).toString('base64')
  });

  res.redirect(authUrl);
});

// GET /api/auth/google/callback — o Google volta pra cá depois do login
router.get('/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.redirect('/pages/login.html?erro=google_cancelado');
    }

    const { tokens } = await googleClient.getToken(code);

    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();

    if (!payload?.email || !payload.email_verified) {
      return res.redirect('/pages/login.html?erro=email_nao_verificado');
    }

    const email = String(payload.email).toLowerCase().trim();
    const nome = payload.name || email.split('@')[0];

    const admins = emailsAdminPermitidos();
    const roleCorreto = admins.includes(email) ? 'admin' : 'user';

    let usuario = db.queryOne('SELECT id, nome, email, role, ativo, whatsapp_contato FROM users WHERE email = ?', [email]);

    if (!usuario) {
      // Cria o usuário no primeiro login. Sem senha (login é só via Google).
      const id = db.run(
        'INSERT INTO users (nome, email, senha, role) VALUES (?, ?, ?, ?)',
        [nome, email, '', roleCorreto]
      );
      usuario = { id, nome, email, role: roleCorreto, ativo: 1, whatsapp_contato: null };
      emailBoasVindas(email, nome).catch(() => {});
    } else if (usuario.role !== roleCorreto) {
      // Mantém o papel (admin/user) sempre sincronizado com a lista ADMIN_EMAILS do .env
      db.run('UPDATE users SET role = ? WHERE id = ?', [roleCorreto, usuario.id]);
      usuario.role = roleCorreto;
    }

    if (!usuario.ativo) {
      return res.redirect('/pages/login.html?erro=conta_desativada');
    }

    // Registra o login real somente no callback de autenticação.
    // Não atualizamos em /auth/me para não confundir navegação com novo login.
    db.run(
      "UPDATE users SET ultimo_login_em = datetime('now') WHERE id = ?",
      [usuario.id]
    );

    vincularGruposPendentesAoUsuario(usuario);

    req.session.regenerate((err) => {
      if (err) return res.redirect('/pages/login.html?erro=sessao');

      req.session.usuario = usuarioPublico(usuario);

      let destino = '/';
      try {
        const decoded = JSON.parse(Buffer.from(state || '', 'base64').toString('utf8'));
        if (decoded?.redirect) destino = decoded.redirect;
      } catch (_) {
        // state inválido ou ausente — usa destino padrão
      }

      res.redirect(destino);
    });
  } catch (err) {
    console.error('[auth/google/callback]', err);
    res.redirect('/pages/login.html?erro=google_falhou');
  }
});

// ===================================================================
// LOGIN/CADASTRO POR EMAIL E SENHA — DESATIVADOS (login agora é só via Google)
// Mantidos comentados como referência / rede de segurança, caso seja
// necessário reativar no futuro.
// ===================================================================

/*
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
*/


router.get('/whatsapp', requireLogin, (req, res) => {
  try {
    const usuario = db.queryOne(
      'SELECT whatsapp_contato, whatsapp_atualizado_em FROM users WHERE id = ?',
      [req.session.usuario.id]
    );

    if (!usuario) {
      return res.status(404).json({ erro: 'Usuário não encontrado.' });
    }

    res.json({
      ok: true,
      whatsapp_contato: usuario.whatsapp_contato || null,
      whatsapp_formatado: formatarWhatsappContato(usuario.whatsapp_contato),
      atualizado_em: usuario.whatsapp_atualizado_em || null
    });
  } catch (err) {
    console.error('[auth/whatsapp/get]', err);
    res.status(500).json({ erro: 'Erro ao carregar o WhatsApp de contato.' });
  }
});

router.put('/whatsapp', requireLogin, (req, res) => {
  try {
    const whatsapp = normalizarWhatsappContato(req.body?.numero);

    if (!whatsapp) {
      return res.status(400).json({
        erro: 'Informe um número válido com DDD. Exemplo: (61) 99999-9999.'
      });
    }

    db.run(
      `UPDATE users
       SET whatsapp_contato = ?,
           whatsapp_atualizado_em = datetime('now')
       WHERE id = ?`,
      [whatsapp, req.session.usuario.id]
    );

    req.session.usuario.whatsapp_contato = whatsapp;
    req.session.usuario.whatsapp_formatado = formatarWhatsappContato(whatsapp);

    res.json({
      ok: true,
      mensagem: 'WhatsApp de contato salvo com sucesso.',
      whatsapp_contato: whatsapp,
      whatsapp_formatado: formatarWhatsappContato(whatsapp)
    });
  } catch (err) {
    console.error('[auth/whatsapp/put]', err);
    res.status(500).json({ erro: 'Erro ao salvar o WhatsApp de contato.' });
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

  try {
    const usuario = db.queryOne(
      'SELECT id, nome, email, role, ativo, whatsapp_contato FROM users WHERE id = ?',
      [req.session.usuario.id]
    );

    if (!usuario || !usuario.ativo) {
      return req.session.destroy(() => {
        res.clearCookie('lh_sid');
        res.json({ logado: false });
      });
    }

    req.session.usuario = usuarioPublico(usuario);
    res.json({ logado: true, usuario: req.session.usuario });
  } catch (err) {
    console.error('[auth/me]', err);
    res.status(500).json({ erro: 'Erro ao consultar a sessão.' });
  }
});

module.exports = router;