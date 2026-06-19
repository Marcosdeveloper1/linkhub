const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin, sanitizeString } = require('../middleware/security');
const { emailGrupoAprovado, emailGrupoRejeitado } = require('../email');

router.use(requireAdmin);

router.get('/pendentes', (req, res) => {
  try {
    const grupos = db.query(`
      SELECT g.id, g.nome_grupo, g.link_whatsapp, g.descricao, g.nome_contato,
             g.email_contato, g.criado_em, c.nome as categoria_nome,
             u.nome as usuario_nome
      FROM groups g
      JOIN categories c ON g.categoria_id = c.id
      LEFT JOIN users u ON g.usuario_id = u.id
      WHERE g.status = 'pendente'
      ORDER BY g.criado_em ASC
    `);
    res.json(grupos);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar pendentes.' });
  }
});

router.get('/grupos', (req, res) => {
  try {
    const status = req.query.status || 'aprovado';
    const validos = ['aprovado', 'pendente', 'rejeitado'];
    const filtroStatus = validos.includes(status) ? status : 'aprovado';

    const grupos = db.query(`
      SELECT g.id, g.nome_grupo, g.link_whatsapp, g.descricao, g.nome_contato,
             g.email_contato, g.status, g.criado_em, g.aprovado_em,
             c.nome as categoria_nome, u.nome as usuario_nome
      FROM groups g
      JOIN categories c ON g.categoria_id = c.id
      LEFT JOIN users u ON g.usuario_id = u.id
      WHERE g.status = ?
      ORDER BY g.criado_em DESC
    `, [filtroStatus]);
    res.json(grupos);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar grupos.' });
  }
});

router.get('/stats', (req, res) => {
  try {
    const pendentes = db.queryOne("SELECT COUNT(*) as n FROM groups WHERE status = 'pendente'");
    const aprovados = db.queryOne("SELECT COUNT(*) as n FROM groups WHERE status = 'aprovado'");
    const rejeitados = db.queryOne("SELECT COUNT(*) as n FROM groups WHERE status = 'rejeitado'");
    const usuarios = db.queryOne("SELECT COUNT(*) as n FROM users WHERE role = 'user'");

    res.json({
      pendentes: pendentes?.n || 0,
      aprovados: aprovados?.n || 0,
      rejeitados: rejeitados?.n || 0,
      usuarios: usuarios?.n || 0
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar stats.' });
  }
});

router.post('/aprovar/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido.' });

    const grupo = db.queryOne(
      "SELECT id, nome_grupo, link_whatsapp, email_contato FROM groups WHERE id = ? AND status = 'pendente'",
      [id]
    );

    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado ou já processado.' });

    db.run(
      "UPDATE groups SET status = 'aprovado', aprovado_em = datetime('now'), motivo_rejeicao = NULL WHERE id = ?",
      [id]
    );

    emailGrupoAprovado(grupo.email_contato, grupo.nome_grupo, grupo.link_whatsapp).catch(() => {});

    res.json({ ok: true, mensagem: 'Grupo aprovado com sucesso.' });
  } catch (err) {
    console.error('[admin/aprovar]', err);
    res.status(500).json({ erro: 'Erro ao aprovar.' });
  }
});

router.post('/rejeitar/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const motivo = sanitizeString(req.body.motivo, 500);

    if (!id) return res.status(400).json({ erro: 'ID inválido.' });
    if (!motivo || motivo.length < 10) {
      return res.status(400).json({ erro: 'Informe o motivo da rejeição (mínimo 10 caracteres).' });
    }

    const grupo = db.queryOne(
      "SELECT id, nome_grupo, email_contato FROM groups WHERE id = ? AND status = 'pendente'",
      [id]
    );

    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado ou já processado.' });

    db.run(
      "UPDATE groups SET status = 'rejeitado', motivo_rejeicao = ? WHERE id = ?",
      [motivo, id]
    );

    emailGrupoRejeitado(grupo.email_contato, grupo.nome_grupo, motivo).catch(() => {});

    res.json({ ok: true, mensagem: 'Grupo rejeitado.' });
  } catch (err) {
    console.error('[admin/rejeitar]', err);
    res.status(500).json({ erro: 'Erro ao rejeitar.' });
  }
});

router.delete('/grupo/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido.' });

    const grupo = db.queryOne('SELECT id FROM groups WHERE id = ?', [id]);
    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado.' });

    db.run('DELETE FROM groups WHERE id = ?', [id]);
    res.json({ ok: true, mensagem: 'Grupo removido.' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover grupo.' });
  }
});

router.get('/usuarios', (req, res) => {
  try {
    const usuarios = db.query(
      'SELECT id, nome, email, role, ativo, criado_em FROM users ORDER BY criado_em DESC'
    );
    res.json(usuarios);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar usuários.' });
  }
});

router.post('/usuario/:id/toggle-ativo', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (id === req.session.usuario.id) {
      return res.status(400).json({ erro: 'Você não pode desativar sua própria conta.' });
    }

    const u = db.queryOne('SELECT id, ativo FROM users WHERE id = ?', [id]);
    if (!u) return res.status(404).json({ erro: 'Usuário não encontrado.' });

    db.run('UPDATE users SET ativo = ? WHERE id = ?', [u.ativo ? 0 : 1, id]);
    res.json({ ok: true, ativo: !u.ativo });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar usuário.' });
  }
});

module.exports = router;
