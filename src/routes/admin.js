const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin, sanitizeString, isValidWhatsAppLink } = require('../middleware/security');
const { emailGrupoAprovado, emailGrupoRejeitado } = require('../email');
const { buscarPreviewGrupo, baixarFotoGrupo } = require('../utils/whatsappPreview');

// Todas as rotas deste arquivo exigem admin
router.use(requireAdmin);

// Lista solicitações pendentes, mais antigas primeiro (fila de atendimento)
router.get('/pendentes', (req, res) => {
  try {
    const pendentes = db.query(`
      SELECT g.*, c.nome as categoria_nome
      FROM groups g
      JOIN categories c ON c.id = g.categoria_id
      WHERE g.status = 'pendente'
      ORDER BY g.criado_em ASC
    `);
    res.json(pendentes);
  } catch (err) {
    console.error('[admin/pendentes]', err);
    res.status(500).json({ erro: 'Erro ao carregar solicitações.' });
  }
});

// Lista grupos por status (aprovado/rejeitado/pendente) — usado na aba de gestão/remoção
router.get('/grupos', (req, res) => {
  try {
    const status = sanitizeString(req.query.status, 20);
    let sql = `
      SELECT g.*, c.nome as categoria_nome
      FROM groups g
      JOIN categories c ON c.id = g.categoria_id
    `;
    const params = [];
    if (status) {
      sql += ' WHERE g.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY g.criado_em DESC';
    res.json(db.query(sql, params));
  } catch (err) {
    console.error('[admin/grupos]', err);
    res.status(500).json({ erro: 'Erro ao carregar grupos.' });
  }
});

// Aprova uma solicitação pendente e dispara email automático
router.post('/grupos/:id/aprovar', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const grupo = db.queryOne('SELECT * FROM groups WHERE id = ?', [id]);

    if (!grupo) {
      return res.status(404).json({ erro: 'Grupo não encontrado.' });
    }
    if (grupo.status !== 'pendente') {
      return res.status(400).json({ erro: 'Esta solicitação já foi analisada.' });
    }

    db.run(
      `UPDATE groups SET status = 'aprovado', aprovado_em = datetime('now'), motivo_rejeicao = NULL WHERE id = ?`,
      [id]
    );

    emailGrupoAprovado(grupo.email_contato, grupo.nome_grupo, grupo.link_whatsapp).catch((err) => {
      console.error('[admin/aprovar] falha ao enviar email:', err.message);
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/aprovar]', err);
    res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
  }
});

// Rejeita uma solicitação pendente — motivo é obrigatório e vai no email pro usuário
router.post('/grupos/:id/rejeitar', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const motivo = sanitizeString(req.body.motivo, 500);

    if (!motivo || motivo.length < 5) {
      return res.status(400).json({ erro: 'Informe um motivo para a rejeição (mínimo 5 caracteres).' });
    }

    const grupo = db.queryOne('SELECT * FROM groups WHERE id = ?', [id]);
    if (!grupo) {
      return res.status(404).json({ erro: 'Grupo não encontrado.' });
    }
    if (grupo.status !== 'pendente') {
      return res.status(400).json({ erro: 'Esta solicitação já foi analisada.' });
    }

    db.run(
      `UPDATE groups SET status = 'rejeitado', motivo_rejeicao = ? WHERE id = ?`,
      [motivo, id]
    );

    emailGrupoRejeitado(grupo.email_contato, grupo.nome_grupo, motivo).catch((err) => {
      console.error('[admin/rejeitar] falha ao enviar email:', err.message);
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/rejeitar]', err);
    res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
  }
});

// Remove um grupo já publicado (ex: denúncia ou problema encontrado depois da aprovação)
router.delete('/grupos/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const grupo = db.queryOne('SELECT id FROM groups WHERE id = ?', [id]);
    if (!grupo) {
      return res.status(404).json({ erro: 'Grupo não encontrado.' });
    }
    db.run('DELETE FROM groups WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/remover]', err);
    res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
  }
});

// Importa vários grupos de uma vez — cada linha: link,categoria_slug
// Já entra como aprovado, pois é o próprio admin inserindo (não passa por moderação).
router.post('/grupos/importar-lote', async (req, res) => {
  try {
    const linhas = (req.body.linhas || '').split('\n').map(l => l.trim()).filter(Boolean);

    if (linhas.length === 0) {
      return res.status(400).json({ erro: 'Cole ao menos uma linha no formato: link,categoria' });
    }

    if (linhas.length > 50) {
      return res.status(400).json({ erro: 'Máximo de 50 grupos por importação. Divida em lotes menores.' });
    }

    const resultados = [];

    for (const linha of linhas) {
      const [linkBruto, categoriaSlugBruto] = linha.split(',');
      const link = (linkBruto || '').trim();
      const categoriaSlug = (categoriaSlugBruto || '').trim();

      if (!isValidWhatsAppLink(link)) {
        resultados.push({ linha, ok: false, erro: 'Link inválido' });
        continue;
      }

      const categoria = db.queryOne('SELECT id FROM categories WHERE slug = ?', [categoriaSlug]);
      if (!categoria) {
        resultados.push({ linha, ok: false, erro: `Categoria "${categoriaSlug}" não encontrada` });
        continue;
      }

      const duplicado = db.queryOne('SELECT id FROM groups WHERE link_whatsapp = ?', [link]);
      if (duplicado) {
        resultados.push({ linha, ok: false, erro: 'Link já cadastrado' });
        continue;
      }

      const preview = await buscarPreviewGrupo(link);
      const nomeGrupo = preview.nome || 'Grupo sem nome (editar depois)';
      const descricao = 'Grupo importado automaticamente. Acesse o link para mais detalhes.';

      const id = db.run(
        `INSERT INTO groups (nome_grupo, link_whatsapp, descricao, categoria_id, usuario_id, nome_contato, email_contato, status, aprovado_em)
         VALUES (?, ?, ?, ?, NULL, ?, ?, 'aprovado', datetime('now'))`,
        [nomeGrupo, link, descricao, categoria.id, 'Importação LinkHub', 'admin@linkhub.com.br']
      );

      let fotoLocal = null;
      if (preview.foto) {
        fotoLocal = await baixarFotoGrupo(preview.foto, id);
        if (fotoLocal) {
          db.run('UPDATE groups SET foto_url = ? WHERE id = ?', [fotoLocal, id]);
        }
      }

      resultados.push({ linha, ok: true, id, nome: nomeGrupo, foto: fotoLocal });
    }

    res.json({
      resultados,
      total: linhas.length,
      sucesso: resultados.filter(r => r.ok).length
    });
  } catch (err) {
    console.error('[admin/importar-lote]', err);
    res.status(500).json({ erro: 'Erro interno na importação.' });
  }
});

module.exports = router;
