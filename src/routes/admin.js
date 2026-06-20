const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin, sanitizeString, isValidWhatsAppLink } = require('../middleware/security');
const { emailGrupoAprovado, emailGrupoRejeitado } = require('../email');
const { buscarPreviewGrupo, baixarFotoGrupo } = require('../utils/whatsappPreview');

router.use(requireAdmin);

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

// Lista grupos por status, com filtro opcional de categoria e busca por nome —
// usado pela aba "Aprovados" para a gestão completa (filtro + busca).
router.get('/grupos', (req, res) => {
  try {
    const status = sanitizeString(req.query.status, 20);
    const categoriaSlug = sanitizeString(req.query.categoria, 50);
    const busca = sanitizeString(req.query.busca, 100);

    let sql = `
      SELECT g.*, c.nome as categoria_nome, c.slug as categoria_slug
      FROM groups g
      JOIN categories c ON c.id = g.categoria_id
    `;
    const condicoes = [];
    const params = [];

    if (status) {
      condicoes.push('g.status = ?');
      params.push(status);
    }
    if (categoriaSlug) {
      condicoes.push('c.slug = ?');
      params.push(categoriaSlug);
    }
    if (busca) {
      condicoes.push('g.nome_grupo LIKE ?');
      params.push(`%${busca}%`);
    }

    if (condicoes.length > 0) {
      sql += ' WHERE ' + condicoes.join(' AND ');
    }
    sql += ' ORDER BY g.criado_em DESC';

    res.json(db.query(sql, params));
  } catch (err) {
    console.error('[admin/grupos]', err);
    res.status(500).json({ erro: 'Erro ao carregar grupos.' });
  }
});

router.post('/grupos/:id/aprovar', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const grupo = db.queryOne('SELECT * FROM groups WHERE id = ?', [id]);

    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado.' });
    if (grupo.status !== 'pendente') return res.status(400).json({ erro: 'Esta solicitação já foi analisada.' });

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

router.post('/grupos/:id/rejeitar', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const motivo = sanitizeString(req.body.motivo, 500);

    if (!motivo || motivo.length < 5) {
      return res.status(400).json({ erro: 'Informe um motivo para a rejeição (mínimo 5 caracteres).' });
    }

    const grupo = db.queryOne('SELECT * FROM groups WHERE id = ?', [id]);
    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado.' });
    if (grupo.status !== 'pendente') return res.status(400).json({ erro: 'Esta solicitação já foi analisada.' });

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

// IMPORTANTE: rotas com path fixo (/grupos/rejeitados, /grupos/verificar-links,
// /grupos/remover-em-lote) precisam vir ANTES de /grupos/:id no arquivo,
// senão o Express interpreta "rejeitados" etc. como se fossem um :id.

// Limpa todos os grupos rejeitados de uma vez (aba Rejeitados > botão "Limpar rejeitados")
router.delete('/grupos/rejeitados', (req, res) => {
  try {
    const rejeitados = db.query("SELECT id FROM groups WHERE status = 'rejeitado'");
    db.run("DELETE FROM groups WHERE status = 'rejeitado'");
    res.json({ ok: true, removidos: rejeitados.length });
  } catch (err) {
    console.error('[admin/limpar-rejeitados]', err);
    res.status(500).json({ erro: 'Erro ao limpar grupos rejeitados.' });
  }
});

// Remove vários grupos aprovados de uma vez (seleção múltipla na aba Aprovados)
router.post('/grupos/remover-em-lote', (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    if (ids.length === 0) {
      return res.status(400).json({ erro: 'Nenhum grupo selecionado.' });
    }

    const placeholders = ids.map(() => '?').join(',');
    db.run(`DELETE FROM groups WHERE id IN (${placeholders})`, ids);

    res.json({ ok: true, removidos: ids.length });
  } catch (err) {
    console.error('[admin/remover-em-lote]', err);
    res.status(500).json({ erro: 'Erro ao remover grupos selecionados.' });
  }
});

// Verifica se os links dos grupos aprovados ainda estão ativos.
// Um link de convite de grupo do WhatsApp que foi revogado/expirado pelo
// administrador do grupo retorna uma página diferente (sem og:image/og:title
// de grupo válido, ou um redirecionamento para a home do WhatsApp).
// Como não existe uma API oficial de "grupo existe?", a verificação é feita
// checando se a página de convite ainda responde com conteúdo de grupo válido
// (mesma técnica já usada em whatsappPreview.js para buscar nome/foto).
router.post('/grupos/verificar-links', async (req, res) => {
  try {
    const grupos = db.query(`
      SELECT id, nome_grupo, link_whatsapp
      FROM groups
      WHERE status = 'aprovado'
    `);

    if (grupos.length === 0) {
      return res.json({ verificados: 0, indisponiveis: 0, resultados: [] });
    }

    const { linkAindaValido } = require('../utils/whatsappPreview');
    const resultados = [];

    for (const grupo of grupos) {
      const valido = await linkAindaValido(grupo.link_whatsapp);

      if (!valido) {
        db.run("UPDATE groups SET status = 'indisponivel' WHERE id = ?", [grupo.id]);
      }

      resultados.push({ id: grupo.id, nome: grupo.nome_grupo, valido });
    }

    const indisponiveis = resultados.filter(r => !r.valido).length;

    res.json({
      verificados: resultados.length,
      indisponiveis,
      resultados
    });
  } catch (err) {
    console.error('[admin/verificar-links]', err);
    res.status(500).json({ erro: 'Erro ao verificar links dos grupos.' });
  }
});

router.delete('/grupos/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const grupo = db.queryOne('SELECT id FROM groups WHERE id = ?', [id]);
    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado.' });
    db.run('DELETE FROM groups WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/remover]', err);
    res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
  }
});

// Importa vários grupos de uma vez
// Recebe: links (um por linha), categoria_slug (único pra todo o lote),
// descricao (genérica editável) e regras (array de strings marcadas)
router.post('/grupos/importar-lote', async (req, res) => {
  try {
    const linhas = (req.body.links || '').split('\n').map(l => l.trim()).filter(Boolean);
    const categoriaSlug = sanitizeString(req.body.categoria_slug, 50);
    const descricao = sanitizeString(req.body.descricao, 500) || 'Grupo importado automaticamente. Acesse o link para mais detalhes.';
    const regras = Array.isArray(req.body.regras) ? req.body.regras.map(r => sanitizeString(r, 200)).filter(Boolean) : [];

    if (linhas.length === 0) {
      return res.status(400).json({ erro: 'Cole ao menos um link.' });
    }

    if (linhas.length > 50) {
      return res.status(400).json({ erro: 'Máximo de 50 grupos por importação. Divida em lotes menores.' });
    }

    if (!categoriaSlug) {
      return res.status(400).json({ erro: 'Selecione uma categoria para o lote.' });
    }

    const categoria = db.queryOne('SELECT id FROM categories WHERE slug = ?', [categoriaSlug]);
    if (!categoria) {
      return res.status(400).json({ erro: `Categoria "${categoriaSlug}" não encontrada.` });
    }

    const regrasTexto = regras.length > 0 ? regras.join('\n') : null;
    const resultados = [];

    for (const link of linhas) {
      if (!isValidWhatsAppLink(link)) {
        resultados.push({ linha: link, ok: false, erro: 'Link inválido' });
        continue;
      }

      const duplicado = db.queryOne('SELECT id FROM groups WHERE link_whatsapp = ?', [link]);
      if (duplicado) {
        resultados.push({ linha: link, ok: false, erro: 'Link já cadastrado' });
        continue;
      }

      const preview = await buscarPreviewGrupo(link);
      const nomeGrupo = preview.nome || 'Grupo sem nome (editar depois)';

      const id = db.run(
        `INSERT INTO groups (nome_grupo, link_whatsapp, descricao, categoria_id, usuario_id, nome_contato, email_contato, regras, status, aprovado_em)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'aprovado', datetime('now'))`,
        [nomeGrupo, link, descricao, categoria.id, 'Importação LinkHub', 'admin@linkhub.com.br', regrasTexto]
      );

      let fotoLocal = null;
      if (preview.foto) {
        fotoLocal = await baixarFotoGrupo(preview.foto, id);
        if (fotoLocal) {
          db.run('UPDATE groups SET foto_url = ? WHERE id = ?', [fotoLocal, id]);
        }
      }

      resultados.push({ linha: link, ok: true, id, nome: nomeGrupo, foto: fotoLocal });
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