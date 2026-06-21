const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin, sanitizeString, isValidWhatsAppLink } = require('../middleware/security');
const { emailGrupoAprovado, emailGrupoRejeitado } = require('../email');
const { buscarPreviewGrupo, baixarFotoGrupo } = require('../utils/whatsappPreview');

function garantirTabelaRelatosErro() {
  db.run(`
    CREATE TABLE IF NOT EXISTS error_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grupo_id INTEGER NOT NULL,
      usuario_id INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      descricao TEXT,
      status TEXT NOT NULL DEFAULT 'pendente',
      criado_em TEXT NOT NULL DEFAULT (datetime('now')),
      resolvido_em TEXT,
      FOREIGN KEY (grupo_id) REFERENCES groups(id),
      FOREIGN KEY (usuario_id) REFERENCES users(id)
    )
  `);
}

const TIPOS_RELATO_ERRO = {
  link_quebrado: 'Link quebrado ou expirado',
  grupo_cheio: 'Grupo cheio',
  grupo_errado: 'Grupo diferente do anunciado',
  conteudo_inadequado: 'Conteúdo inadequado',
  outro: 'Outro problema'
};

function traduzirTipoRelato(tipo) {
  return TIPOS_RELATO_ERRO[tipo] || tipo || 'Erro informado';
}

router.use(requireAdmin);


// Resumo geral do painel admin: totais por status, erros e grupos aprovados por categoria.
router.get('/resumo', (req, res) => {
  try {
    garantirTabelaRelatosErro();

    const porStatus = db.query(`
      SELECT status, COUNT(*) as total
      FROM groups
      GROUP BY status
    `);

    const totais = {
      aprovados: 0,
      pendentes: 0,
      rejeitados: 0,
      erros_relatados: 0
    };

    porStatus.forEach((linha) => {
      if (linha.status === 'aprovado') totais.aprovados = Number(linha.total || 0);
      if (linha.status === 'pendente') totais.pendentes = Number(linha.total || 0);
      if (linha.status === 'rejeitado') totais.rejeitados = Number(linha.total || 0);
    });

    const erros = db.queryOne(`SELECT COUNT(*) as total FROM error_reports`);
    totais.erros_relatados = Number(erros?.total || 0);

    const categorias = db.query(`
      SELECT c.id, c.nome, c.slug,
             COUNT(CASE WHEN g.status = 'aprovado' THEN 1 END) as total
      FROM categories c
      LEFT JOIN groups g ON g.categoria_id = c.id
      GROUP BY c.id, c.nome, c.slug
      ORDER BY c.nome ASC
    `).map((cat) => ({
      ...cat,
      total: Number(cat.total || 0)
    }));

    res.json({ ok: true, totais, categorias });
  } catch (err) {
    console.error('[admin/resumo]', err);
    res.status(500).json({ erro: 'Erro ao carregar resumo do painel.' });
  }
});



function garantirCarteiraUsuario(usuarioId) {
  db.run(
    `INSERT OR IGNORE INTO user_wallets (user_id, balance)
     VALUES (?, 0)`,
    [usuarioId]
  );

  return db.queryOne('SELECT user_id, balance FROM user_wallets WHERE user_id = ?', [usuarioId]);
}

function registrarAjusteZapCoinAdmin({ usuarioId, adminId, quantidade, saldoAntes, saldoDepois, motivo }) {
  db.run(
    `INSERT INTO wallet_transactions
      (user_id, tipo, quantidade, saldo_antes, saldo_depois, referencia_tipo, referencia_id, descricao, admin_id)
     VALUES (?, 'ajuste_admin', ?, ?, ?, 'admin_adjustment', ?, ?, ?)`,
    [usuarioId, quantidade, saldoAntes, saldoDepois, adminId, motivo, adminId]
  );
}

// Lista usuários para ajuste administrativo de ZapCoins.
router.get('/zapcoins/usuarios', (req, res) => {
  try {
    const busca = sanitizeString(req.query.busca, 120);

    let sql = `
      SELECT u.id, u.nome, u.email, u.role, u.ativo, u.criado_em,
             COALESCE(w.balance, 0) as saldo
      FROM users u
      LEFT JOIN user_wallets w ON w.user_id = u.id
    `;
    const params = [];

    if (busca) {
      sql += ' WHERE u.nome LIKE ? OR u.email LIKE ?';
      params.push(`%${busca}%`, `%${busca}%`);
    }

    sql += ' ORDER BY u.criado_em DESC LIMIT 80';

    res.json(db.query(sql, params));
  } catch (err) {
    console.error('[admin/zapcoins/usuarios]', err);
    res.status(500).json({ erro: 'Erro ao carregar usuários para ZapCoins.' });
  }
});

// Ajuste manual auditável de ZapCoins.
// Segurança: só admin logado, valida quantidade, impede saldo negativo e grava extrato com admin_id.
router.post('/zapcoins/ajustar', (req, res) => {
  try {
    const adminId = req.session.usuario.id;
    const usuarioId = parseInt(req.body.user_id, 10);
    const quantidade = parseInt(req.body.quantidade, 10);
    const motivo = sanitizeString(req.body.motivo, 300);

    if (!usuarioId) {
      return res.status(400).json({ erro: 'Usuário inválido.' });
    }

    if (!Number.isInteger(quantidade) || quantidade === 0) {
      return res.status(400).json({ erro: 'Informe uma quantidade válida. Use positivo para adicionar e negativo para remover.' });
    }

    if (Math.abs(quantidade) > 5000) {
      return res.status(400).json({ erro: 'Por segurança, o ajuste máximo por operação é de 5.000 ZapCoins.' });
    }

    if (!motivo || motivo.length < 5) {
      return res.status(400).json({ erro: 'Informe um motivo com pelo menos 5 caracteres.' });
    }

    const usuario = db.queryOne('SELECT id, nome, email FROM users WHERE id = ?', [usuarioId]);
    if (!usuario) {
      return res.status(404).json({ erro: 'Usuário não encontrado.' });
    }

    const carteira = garantirCarteiraUsuario(usuarioId);
    const saldoAntes = Number(carteira?.balance || 0);
    const saldoDepois = saldoAntes + quantidade;

    if (saldoDepois < 0) {
      return res.status(400).json({ erro: `Saldo insuficiente. O usuário tem ${saldoAntes} ZapCoins.` });
    }

    db.run(
      `UPDATE user_wallets
       SET balance = ?, atualizado_em = datetime('now')
       WHERE user_id = ?`,
      [saldoDepois, usuarioId]
    );

    registrarAjusteZapCoinAdmin({
      usuarioId,
      adminId,
      quantidade,
      saldoAntes,
      saldoDepois,
      motivo: `Ajuste admin: ${motivo}`
    });

    res.json({
      ok: true,
      usuario_id: usuarioId,
      saldo_antes: saldoAntes,
      saldo_depois: saldoDepois,
      quantidade,
      mensagem: `Saldo de ${usuario.nome} ajustado para ${saldoDepois} ZapCoins.`
    });
  } catch (err) {
    console.error('[admin/zapcoins/ajustar]', err);
    res.status(500).json({ erro: 'Erro ao ajustar ZapCoins.' });
  }
});


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


// Lista relatos de erro enviados por usuários cadastrados
router.get('/erros', (req, res) => {
  try {
    garantirTabelaRelatosErro();

    const relatos = db.query(`
      SELECT r.id, r.grupo_id, r.usuario_id, r.tipo, r.descricao, r.status, r.criado_em, r.resolvido_em,
             g.nome_grupo, g.link_whatsapp, g.status as grupo_status,
             c.nome as categoria_nome,
             u.nome as usuario_nome, u.email as usuario_email
      FROM error_reports r
      JOIN groups g ON g.id = r.grupo_id
      LEFT JOIN categories c ON c.id = g.categoria_id
      LEFT JOIN users u ON u.id = r.usuario_id
      ORDER BY CASE WHEN r.status = 'pendente' THEN 0 ELSE 1 END, r.criado_em DESC
    `);

    res.json(relatos.map((relato) => ({
      ...relato,
      tipo_label: traduzirTipoRelato(relato.tipo)
    })));
  } catch (err) {
    console.error('[admin/erros]', err);
    res.status(500).json({ erro: 'Erro ao carregar relatos de erro.' });
  }
});

// Marca um relato de erro como resolvido
router.post('/erros/:id/resolver', (req, res) => {
  try {
    garantirTabelaRelatosErro();

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ erro: 'ID inválido.' });

    const relato = db.queryOne('SELECT id FROM error_reports WHERE id = ?', [id]);
    if (!relato) return res.status(404).json({ erro: 'Relato não encontrado.' });

    db.run("UPDATE error_reports SET status = 'resolvido', resolvido_em = datetime('now') WHERE id = ?", [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/erros/resolver]', err);
    res.status(500).json({ erro: 'Erro ao marcar relato como resolvido.' });
  }
});

// Remove um relato de erro do painel
router.delete('/erros/:id', (req, res) => {
  try {
    garantirTabelaRelatosErro();

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ erro: 'ID inválido.' });

    const relato = db.queryOne('SELECT id FROM error_reports WHERE id = ?', [id]);
    if (!relato) return res.status(404).json({ erro: 'Relato não encontrado.' });

    db.run('DELETE FROM error_reports WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/erros/remover]', err);
    res.status(500).json({ erro: 'Erro ao remover relato.' });
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
        [nomeGrupo, link, descricao, categoria.id, 'Importação WhatsApp Grupos', 'admin@whatsappgrupos.site', regrasTexto]
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

// PUT /admin/grupos/:id — Edita um grupo existente
router.put('/grupos/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ erro: 'ID inválido.' });

    const grupo = db.queryOne('SELECT * FROM groups WHERE id = ?', [id]);
    if (!grupo) {
      return res.status(404).json({ erro: 'Grupo não encontrado.' });
    }

    const nomeGrupo = sanitizeString(req.body.nome_grupo, 100);
    const link = sanitizeString(req.body.link_whatsapp, 300);
    const descricao = sanitizeString(req.body.descricao, 500);
    const categoriaId = parseInt(req.body.categoria_id);
    const regras = req.body.regras ? sanitizeString(req.body.regras, 2000) : null;
    const status = sanitizeString(req.body.status, 20);

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

    if (status && !['aprovado', 'indisponivel', 'pendente', 'rejeitado'].includes(status)) {
      return res.status(400).json({ erro: 'Status inválido.' });
    }

    // Se o link de WhatsApp mudou, verifica duplicidade
    if (link !== grupo.link_whatsapp) {
      const duplicado = db.queryOne('SELECT id FROM groups WHERE link_whatsapp = ?', [link]);
      if (duplicado) {
        return res.status(409).json({ erro: 'Este link de WhatsApp já está cadastrado em outro grupo.' });
      }
    }

    db.run(
      `UPDATE groups 
       SET nome_grupo = ?, link_whatsapp = ?, descricao = ?, categoria_id = ?, regras = ?, status = ?
       WHERE id = ?`,
      [nomeGrupo, link, descricao, categoriaId, regras, status || grupo.status, id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/editar-grupo]', err);
    res.status(500).json({ erro: 'Erro ao editar o grupo.' });
  }
});

// POST /admin/grupos/status-lote — Atualiza status de vários grupos em lote
router.post('/grupos/status-lote', (req, res) => {
  try {
    const ids = req.body.ids;
    const status = sanitizeString(req.body.status, 20);

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ erro: 'Nenhum grupo selecionado.' });
    }

    if (!['aprovado', 'indisponivel', 'pendente', 'rejeitado'].includes(status)) {
      return res.status(400).json({ erro: 'Status inválido.' });
    }

    const placeholders = ids.map(() => '?').join(',');
    db.run(
      `UPDATE groups SET status = ? WHERE id IN (${placeholders})`,
      [status, ...ids]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/status-lote]', err);
    res.status(500).json({ erro: 'Erro ao atualizar status dos grupos.' });
  }
});

// POST /admin/grupos/deletar-lote — Deleta vários grupos em lote
router.post('/grupos/deletar-lote', (req, res) => {
  try {
    const ids = req.body.ids;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ erro: 'Nenhum grupo selecionado.' });
    }

    const placeholders = ids.map(() => '?').join(',');
    db.run(
      `DELETE FROM groups WHERE id IN (${placeholders})`,
      ids
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/deletar-lote]', err);
    res.status(500).json({ erro: 'Erro ao deletar grupos.' });
  }
});

module.exports = router;

