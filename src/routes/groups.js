const express = require('express');
const validator = require('validator');
const router = express.Router();
const db = require('../db');
const { buscarPreviewGrupo, baixarFotoGrupo } = require('../utils/whatsappPreview');
const { limiterGrupo, requireLogin, sanitizeString, isValidWhatsAppLink } = require('../middleware/security');

router.get('/', (req, res) => {
  try {
    const categoria = req.query.categoria ? sanitizeString(req.query.categoria, 50) : null;
    const busca = req.query.busca ? sanitizeString(req.query.busca, 100) : null;
    const pagina = Math.max(1, parseInt(req.query.pagina) || 1);
    const porPagina = 12;
    const offset = (pagina - 1) * porPagina;

    const isAdmin = req.session.usuario && req.session.usuario.role === 'admin';
    const incluirIndisponiveis = isAdmin && req.query.incluirIndisponiveis === 'true';

    let where = incluirIndisponiveis ? "g.status IN ('aprovado', 'indisponivel')" : "g.status = 'aprovado'";
    const params = [];

    if (categoria) {
      where += ' AND c.slug = ?';
      params.push(categoria);
    }

    if (busca) {
      where += ' AND (g.nome_grupo LIKE ? OR g.descricao LIKE ?)';
      params.push(`%${busca}%`, `%${busca}%`);
    }

    const total = db.queryOne(
      `SELECT COUNT(*) as total FROM groups g JOIN categories c ON g.categoria_id = c.id WHERE ${where}`,
      params
    );

    const grupos = db.query(
      `SELECT g.id, g.nome_grupo, g.descricao, g.link_whatsapp, g.foto_url, g.aprovado_em, g.status, g.regras, g.categoria_id,
              c.nome as categoria_nome, c.slug as categoria_slug, c.icone as categoria_icone
       FROM groups g
       JOIN categories c ON g.categoria_id = c.id
       WHERE ${where}
       ORDER BY g.aprovado_em DESC
       LIMIT ? OFFSET ?`,
      [...params, porPagina, offset]
    );

    res.json({
      grupos,
      total: total?.total || 0,
      pagina,
      totalPaginas: Math.ceil((total?.total || 0) / porPagina)
    });
  } catch (err) {
    console.error('[grupos/listar]', err);
    res.status(500).json({ erro: 'Erro ao buscar grupos.' });
  }
});

router.get('/categorias', (req, res) => {
  try {
    const isAdmin = req.session.usuario && req.session.usuario.role === 'admin';
    const incluirIndisponiveis = isAdmin && req.query.incluirIndisponiveis === 'true';
    const statusSql = incluirIndisponiveis ? "g.status IN ('aprovado', 'indisponivel')" : "g.status = 'aprovado'";

    const cats = db.query(`
      SELECT c.id, c.nome, c.slug, c.icone,
             COUNT(g.id) as total_grupos
      FROM categories c
      LEFT JOIN groups g ON g.categoria_id = c.id AND ${statusSql}
      GROUP BY c.id
      ORDER BY c.nome
    `);
    res.json(cats);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar categorias.' });
  }
});

// GET /api/grupos/meus — grupos enviados pelo usuário logado
router.get('/meus', requireLogin, (req, res) => {
  try {
    const grupos = db.query(
      `SELECT g.id, g.nome_grupo, g.descricao, g.link_whatsapp, g.foto_url,
              g.status, g.motivo_rejeicao, g.criado_em, g.aprovado_em,
              c.nome as categoria_nome
       FROM groups g
       JOIN categories c ON g.categoria_id = c.id
       WHERE g.usuario_id = ?
       ORDER BY g.criado_em DESC`,
      [req.session.usuario.id]
    );
    res.json(grupos);
  } catch (err) {
    console.error('[grupos/meus]', err);
    res.status(500).json({ erro: 'Erro ao buscar seus grupos.' });
  }
});

// DELETE /api/grupos/meus/:id — usuário remove um grupo próprio
router.delete('/meus/:id', requireLogin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ erro: 'ID inválido.' });

    const grupo = db.queryOne(
      'SELECT id, usuario_id FROM groups WHERE id = ?',
      [id]
    );

    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado.' });

    if (grupo.usuario_id !== req.session.usuario.id) {
      return res.status(403).json({ erro: 'Você não tem permissão para remover este grupo.' });
    }

    db.run('DELETE FROM groups WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[grupos/meus/remover]', err);
    res.status(500).json({ erro: 'Erro ao remover grupo.' });
  }
});

router.post('/enviar', requireLogin, limiterGrupo, async (req, res) => {
  try {
    const nomeGrupo = sanitizeString(req.body.nome_grupo, 100);
    const link = sanitizeString(req.body.link_whatsapp, 300);
    const descricao = sanitizeString(req.body.descricao, 500);
    const categoriaId = parseInt(req.body.categoria_id);
    const nomeContato = sanitizeString(req.body.nome_contato, 100);
    const emailContato = sanitizeString(req.body.email_contato, 200);
    const regras = req.body.regras ? sanitizeString(req.body.regras, 2000) : null;

    if (!nomeGrupo || nomeGrupo.length < 3) {
      return res.status(400).json({ erro: 'Nome do grupo deve ter pelo menos 3 caracteres.' });
    }

    if (!isValidWhatsAppLink(link)) {
      return res.status(400).json({ erro: 'Link do WhatsApp inválido. Use o formato: https://chat.whatsapp.com/CODIGO' });
    }

    if (!descricao || descricao.length < 20) {
      return res.status(400).json({ erro: 'Descrição deve ter pelo menos 20 caracteres.' });
    }

    if (!categoriaId || isNaN(categoriaId)) {
      return res.status(400).json({ erro: 'Selecione uma categoria.' });
    }

    const cat = db.queryOne('SELECT id FROM categories WHERE id = ?', [categoriaId]);
    if (!cat) {
      return res.status(400).json({ erro: 'Categoria inválida.' });
    }

    if (!nomeContato || nomeContato.length < 2) {
      return res.status(400).json({ erro: 'Nome de contato obrigatório.' });
    }

    if (!emailContato || !validator.isEmail(emailContato)) {
      return res.status(400).json({ erro: 'Email de contato inválido.' });
    }

    const linkExistente = db.queryOne('SELECT id FROM groups WHERE link_whatsapp = ?', [link]);
    if (linkExistente) {
      return res.status(409).json({ erro: 'Este link já foi cadastrado.' });
    }

    const preview = await buscarPreviewGrupo(link);

    const id = db.run(
      `INSERT INTO groups (nome_grupo, link_whatsapp, descricao, categoria_id, usuario_id, nome_contato, email_contato, regras, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendente')`,
      [nomeGrupo, link, descricao, categoriaId, req.session.usuario.id, nomeContato, validator.normalizeEmail(emailContato), regras]
    );

    if (preview.foto) {
      const fotoLocal = await baixarFotoGrupo(preview.foto, id);
      if (fotoLocal) {
        db.run('UPDATE groups SET foto_url = ? WHERE id = ?', [fotoLocal, id]);
      }
    }

    res.json({ ok: true, mensagem: 'Grupo enviado! Nossa equipe irá analisá-lo em breve.' });
  } catch (err) {
    console.error('[grupos/enviar]', err);
    res.status(500).json({ erro: 'Erro ao enviar grupo. Tente novamente.' });
  }
});

// GET /api/grupos/:id — detalhes de um grupo aprovado + incrementa contador de acessos
router.get('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ erro: 'ID inválido.' });

    const isAdmin = req.session.usuario && req.session.usuario.role === 'admin';
    const statusSql = isAdmin ? "g.status IN ('aprovado', 'indisponivel')" : "g.status = 'aprovado'";

    const grupo = db.queryOne(`
      SELECT g.*, c.nome as categoria_nome, c.slug as categoria_slug
      FROM groups g
      JOIN categories c ON c.id = g.categoria_id
      WHERE g.id = ? AND ${statusSql}
    `, [id]);

    if (!grupo) {
      return res.status(404).json({ erro: 'Grupo não encontrado.' });
    }

    if (grupo.status === 'aprovado' && !isAdmin) {
      db.run('UPDATE groups SET total_acessos = total_acessos + 1 WHERE id = ?', [id]);
      grupo.total_acessos = (grupo.total_acessos || 0) + 1;
    }

    res.json(grupo);
  } catch (err) {
    console.error('[grupos/detalhe]', err);
    res.status(500).json({ erro: 'Erro ao carregar grupo.' });
  }
});

// GET /api/grupos/:id/relacionados — outros grupos aprovados da mesma categoria
router.get('/:id/relacionados', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ erro: 'ID inválido.' });

    const grupo = db.queryOne('SELECT categoria_id FROM groups WHERE id = ?', [id]);
    if (!grupo) return res.json([]);

    const relacionados = db.query(`
      SELECT g.id, g.nome_grupo, g.descricao, g.foto_url, c.nome as categoria_nome
      FROM groups g
      JOIN categories c ON c.id = g.categoria_id
      WHERE g.categoria_id = ? AND g.status = 'aprovado' AND g.id != ?
      ORDER BY g.aprovado_em DESC
      LIMIT 6
    `, [grupo.categoria_id, id]);

    res.json(relacionados);
  } catch (err) {
    console.error('[grupos/relacionados]', err);
    res.status(500).json({ erro: 'Erro ao carregar grupos relacionados.' });
  }
});

module.exports = router;