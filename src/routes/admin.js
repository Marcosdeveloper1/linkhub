const express = require('express');
const validator = require('validator');
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

const DIAS_ATE_NOVA_VERIFICACAO = 5;
const TAMANHO_SESSAO_REVISAO = 10;
const ITENS_POR_PAGINA_HISTORICO_REVISAO = 5;
const JANELA_VERIFICACAO_MS = DIAS_ATE_NOVA_VERIFICACAO * 24 * 60 * 60 * 1000;

function dataSqliteParaTimestamp(valor) {
  if (!valor) return null;
  const texto = String(valor).trim();
  const normalizado = texto.includes('T') ? texto : texto.replace(' ', 'T');
  const comFuso = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalizado) ? normalizado : `${normalizado}Z`;
  const timestamp = Date.parse(comFuso);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function enriquecerGrupoVerificacao(grupo, agora = Date.now()) {
  const resultado = grupo.link_verificacao_resultado || 'pendente';
  const verificadoEmMs = dataSqliteParaTimestamp(grupo.link_verificado_em);
  const expiraEmMs = verificadoEmMs ? verificadoEmMs + JANELA_VERIFICACAO_MS : null;
  const resultadoConclusivo = resultado === 'valido' || resultado === 'invalido';
  const verificadoRecentemente = Boolean(resultadoConclusivo && expiraEmMs && expiraEmMs > agora);
  const restanteMs = verificadoRecentemente ? Math.max(0, expiraEmMs - agora) : 0;
  const diasRestantes = Math.floor(restanteMs / (24 * 60 * 60 * 1000));
  const horasRestantes = Math.floor((restanteMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

  return {
    ...grupo,
    link_verificacao_resultado: resultado,
    verificado_recentemente: verificadoRecentemente,
    dias_restantes: diasRestantes,
    horas_restantes: horasRestantes,
    expira_em: expiraEmMs ? new Date(expiraEmMs).toISOString() : null
  };
}

function paginaPositiva(valor, padrao = 1) {
  const numero = Number.parseInt(valor, 10);
  return Number.isInteger(numero) && numero > 0 ? numero : padrao;
}

function criarPaginacao(totalItens, paginaSolicitada, porPagina) {
  const total = Math.max(0, Number(totalItens || 0));
  const totalPaginas = Math.max(1, Math.ceil(total / porPagina));
  const pagina = Math.min(paginaPositiva(paginaSolicitada), totalPaginas);

  return {
    pagina,
    por_pagina: porPagina,
    total_itens: total,
    total_paginas: totalPaginas,
    tem_anterior: pagina > 1,
    tem_proxima: pagina < totalPaginas,
    offset: (pagina - 1) * porPagina
  };
}


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
      indisponiveis: 0,
      cadastrados: 0,
      pendentes: 0,
      rejeitados: 0,
      erros_relatados: 0
    };

    porStatus.forEach((linha) => {
      if (linha.status === 'aprovado') totais.aprovados = Number(linha.total || 0);
      if (linha.status === 'indisponivel') totais.indisponiveis = Number(linha.total || 0);
      if (linha.status === 'pendente') totais.pendentes = Number(linha.total || 0);
      if (linha.status === 'rejeitado') totais.rejeitados = Number(linha.total || 0);
    });

    // "Cadastrados" representa os grupos que pertencem ao catálogo administrativo:
    // aprovados e os que foram aprovados anteriormente, mas estão indisponíveis.
    totais.cadastrados = totais.aprovados + totais.indisponiveis;

    const erros = db.queryOne(`SELECT COUNT(*) as total FROM error_reports`);
    totais.erros_relatados = Number(erros?.total || 0);

    const categorias = db.query(`
      SELECT c.id, c.nome, c.slug,
             COUNT(CASE WHEN g.status IN ('aprovado', 'indisponivel') THEN 1 END) as total
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


// Lista paginada de usuários para administração.
// A paginação é feita no banco com LIMIT/OFFSET para não carregar todos os perfis na memória.
router.get('/usuarios', (req, res) => {
  try {
    const busca = sanitizeString(req.query.busca, 120);
    const paginaSolicitada = paginaPositiva(req.query.pagina, 1);
    const limiteSolicitado = Number.parseInt(req.query.limite, 10);
    const porPagina = Number.isInteger(limiteSolicitado)
      ? Math.min(50, Math.max(5, limiteSolicitado))
      : 15;

    const filtros = [];
    const paramsFiltro = [];

    if (busca) {
      const buscaDigitos = String(busca).replace(/\D/g, '');
      const partes = ['u.nome LIKE ?', 'u.email LIKE ?'];
      paramsFiltro.push(`%${busca}%`, `%${busca}%`);

      if (buscaDigitos) {
        partes.push("COALESCE(u.whatsapp_contato, '') LIKE ?");
        paramsFiltro.push(`%${buscaDigitos}%`);
      }

      filtros.push(`(${partes.join(' OR ')})`);
    }

    const whereSql = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';

    const totalLinha = db.queryOne(
      `SELECT COUNT(*) as total
       FROM users u
       ${whereSql}`,
      paramsFiltro
    );

    const paginacao = criarPaginacao(
      Number(totalLinha?.total || 0),
      paginaSolicitada,
      porPagina
    );

    const usuarios = db.query(
      `SELECT
         u.id,
         u.nome,
         u.email,
         u.role,
         u.ativo,
         u.criado_em,
         u.ultimo_login_em,
         u.whatsapp_contato,
         COALESCE(w.balance, 0) as saldo,
         (
           SELECT COUNT(*)
           FROM groups g
           WHERE g.owner_user_id = u.id
         ) + (
           SELECT COUNT(*)
           FROM groups g
           WHERE g.owner_user_id IS NULL
             AND g.usuario_id = u.id
         ) as total_grupos
       FROM users u
       LEFT JOIN user_wallets w ON w.user_id = u.id
       ${whereSql}
       ORDER BY
         CASE WHEN u.ultimo_login_em IS NULL THEN 1 ELSE 0 END ASC,
         u.ultimo_login_em DESC,
         u.criado_em DESC,
         u.id DESC
       LIMIT ? OFFSET ?`,
      [...paramsFiltro, paginacao.por_pagina, paginacao.offset]
    ).map((usuario) => ({
      ...usuario,
      saldo: Number(usuario.saldo || 0),
      total_grupos: Number(usuario.total_grupos || 0)
    }));

    res.json({
      ok: true,
      usuarios,
      paginacao: {
        pagina: paginacao.pagina,
        por_pagina: paginacao.por_pagina,
        total_itens: paginacao.total_itens,
        total_paginas: paginacao.total_paginas,
        tem_anterior: paginacao.tem_anterior,
        tem_proxima: paginacao.tem_proxima
      }
    });
  } catch (err) {
    console.error('[admin/usuarios]', err);
    res.status(500).json({ erro: 'Erro ao carregar usuários.' });
  }
});

// Lista usuários para ajuste administrativo de ZapCoins.
router.get('/zapcoins/usuarios', (req, res) => {
  try {
    const busca = sanitizeString(req.query.busca, 120);

    let sql = `
      SELECT u.id, u.nome, u.email, u.role, u.ativo, u.criado_em,
             u.whatsapp_contato,
             COALESCE(w.balance, 0) as saldo
      FROM users u
      LEFT JOIN user_wallets w ON w.user_id = u.id
    `;
    const params = [];

    if (busca) {
      const buscaDigitos = String(busca).replace(/\D/g, '');
      sql += ' WHERE (u.nome LIKE ? OR u.email LIKE ?';
      params.push(`%${busca}%`, `%${busca}%`);

      if (buscaDigitos) {
        sql += ' OR COALESCE(u.whatsapp_contato, \'\') LIKE ?';
        params.push(`%${buscaDigitos}%`);
      }

      sql += ')';
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
      SELECT g.*, c.nome as categoria_nome,
             u.nome as owner_nome,
             u.email as owner_usuario_email,
             u.whatsapp_contato as owner_whatsapp_contato
      FROM groups g
      JOIN categories c ON c.id = g.categoria_id
      LEFT JOIN users u ON u.id = COALESCE(g.owner_user_id, g.usuario_id)
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
      SELECT g.*, c.nome as categoria_nome, c.slug as categoria_slug,
             u.nome as owner_nome,
             u.email as owner_usuario_email,
             u.whatsapp_contato as owner_whatsapp_contato
      FROM groups g
      JOIN categories c ON c.id = g.categoria_id
      LEFT JOIN users u ON u.id = COALESCE(g.owner_user_id, g.usuario_id)
    `;
    const condicoes = [];
    const params = [];

    if (status) {
      // A aba "Aprovados" também precisa exibir os grupos que já foram
      // aprovados, mas estão temporariamente com link indisponível.
      if (status === 'aprovado') {
        condicoes.push("g.status IN ('aprovado', 'indisponivel')");
      } else {
        condicoes.push('g.status = ?');
        params.push(status);
      }
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


// Vincula um grupo importado/sem dono a um e-mail Google.
// Se o usuário já existir, o vínculo fica ativo na hora. Se ainda não existir,
// o grupo fica aguardando o primeiro login desse e-mail no Google.
router.post('/grupos/:id/vincular-dono', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const email = String(sanitizeString(req.body.email, 254) || '').toLowerCase().trim();

    if (!id) return res.status(400).json({ erro: 'ID inválido.' });
    if (!email || !validator.isEmail(email)) {
      return res.status(400).json({ erro: 'Informe um e-mail Google válido.' });
    }

    const grupo = db.queryOne('SELECT id, nome_grupo FROM groups WHERE id = ?', [id]);
    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado.' });

    const usuario = db.queryOne(
      'SELECT id, nome, email FROM users WHERE LOWER(email) = ?',
      [email]
    );

    if (usuario) {
      db.run(
        `UPDATE groups
         SET usuario_id = ?,
             owner_user_id = ?,
             owner_email = ?,
             ownership_status = 'vinculado',
             ownership_claimed_at = datetime('now'),
             owner_assigned_at = datetime('now'),
             owner_assigned_by = ?
         WHERE id = ?`,
        [usuario.id, usuario.id, usuario.email, req.session.usuario.id, id]
      );

      return res.json({
        ok: true,
        status: 'vinculado',
        mensagem: `Grupo vinculado ao usuário ${usuario.email}.`,
        usuario
      });
    }

    db.run(
      `UPDATE groups
       SET owner_email = ?,
           owner_user_id = NULL,
           ownership_status = 'convite_pendente',
           owner_assigned_at = datetime('now'),
           owner_assigned_by = ?
       WHERE id = ?`,
      [email, req.session.usuario.id, id]
    );

    res.json({
      ok: true,
      status: 'convite_pendente',
      mensagem: `E-mail salvo. Quando ${email} entrar com Google, o grupo será assumido automaticamente.`
    });
  } catch (err) {
    console.error('[admin/vincular-dono]', err);
    res.status(500).json({ erro: 'Erro ao vincular dono do grupo.' });
  }
});

// Remove o dono/vínculo de um grupo, deixando ele sem proprietário no painel.
router.post('/grupos/:id/remover-dono', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ erro: 'ID inválido.' });

    const grupo = db.queryOne('SELECT id FROM groups WHERE id = ?', [id]);
    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado.' });

    db.run(
      `UPDATE groups
       SET usuario_id = NULL,
           owner_user_id = NULL,
           owner_email = NULL,
           ownership_status = 'sem_dono',
           ownership_claimed_at = NULL,
           owner_assigned_at = datetime('now'),
           owner_assigned_by = ?
       WHERE id = ?`,
      [req.session.usuario.id, id]
    );

    res.json({ ok: true, mensagem: 'Dono removido. O grupo ficou sem proprietário.' });
  } catch (err) {
    console.error('[admin/remover-dono]', err);
    res.status(500).json({ erro: 'Erro ao remover dono do grupo.' });
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

// Painel de revisão assistida. Nenhuma consulta ao WhatsApp é feita pela VPS.
// O servidor entrega somente até 10 grupos; o administrador abre cada convite
// no próprio navegador e registra o resultado observado.
router.get('/grupos/revisao-links', (req, res) => {
  try {
    const categoriaSlug = sanitizeString(req.query.categoria, 50);
    const limiteSolicitado = Number.parseInt(req.query.limite, 10);
    const limite = Math.min(
      TAMANHO_SESSAO_REVISAO,
      Math.max(1, Number.isInteger(limiteSolicitado) ? limiteSolicitado : TAMANHO_SESSAO_REVISAO)
    );

    if (!categoriaSlug) {
      return res.status(400).json({ erro: 'Selecione uma categoria.' });
    }

    const categoria = db.queryOne(
      'SELECT id, nome, slug FROM categories WHERE slug = ?',
      [categoriaSlug]
    );

    if (!categoria) {
      return res.status(404).json({ erro: 'Categoria não encontrada.' });
    }

    const condicaoRecente = `
      g.link_verificado_em IS NOT NULL
      AND COALESCE(g.link_verificacao_resultado, 'pendente') IN ('valido', 'invalido')
      AND datetime(g.link_verificado_em, '+${DIAS_ATE_NOVA_VERIFICACAO} days') > datetime('now')
    `;

    const condicaoAguardando = `
      g.link_verificado_em IS NULL
      OR COALESCE(g.link_verificacao_resultado, 'pendente') NOT IN ('valido', 'invalido')
      OR datetime(g.link_verificado_em, '+${DIAS_ATE_NOVA_VERIFICACAO} days') <= datetime('now')
    `;

    const totaisLinha = db.queryOne(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN (${condicaoAguardando}) THEN 1 ELSE 0 END) AS aguardando,
        SUM(CASE WHEN (${condicaoRecente}) AND g.link_verificacao_resultado = 'valido' THEN 1 ELSE 0 END) AS validados,
        SUM(CASE WHEN (${condicaoRecente}) AND g.link_verificacao_resultado = 'invalido' THEN 1 ELSE 0 END) AS invalidos
      FROM groups g
      JOIN categories c ON c.id = g.categoria_id
      WHERE c.slug = ?
        AND g.status IN ('aprovado', 'indisponivel')
    `, [categoriaSlug]) || {};

    const fila = db.query(`
      SELECT
        g.id, g.nome_grupo, g.link_whatsapp, g.foto_url, g.status,
        g.link_ultima_tentativa_em, g.link_verificado_em,
        g.link_verificacao_resultado, g.link_verificacao_motivo,
        c.nome AS categoria_nome, c.slug AS categoria_slug
      FROM groups g
      JOIN categories c ON c.id = g.categoria_id
      WHERE c.slug = ?
        AND g.status IN ('aprovado', 'indisponivel')
        AND (${condicaoAguardando})
      ORDER BY
        COALESCE(
          datetime(g.link_ultima_tentativa_em),
          datetime(g.link_verificado_em),
          datetime(g.criado_em)
        ) ASC,
        g.id ASC
      LIMIT ?
    `, [categoriaSlug, limite]);

    res.json({
      ok: true,
      categoria,
      configuracao: {
        tamanho_sessao: TAMANHO_SESSAO_REVISAO,
        dias_ate_nova_verificacao: DIAS_ATE_NOVA_VERIFICACAO
      },
      totais: {
        total: Number(totaisLinha.total || 0),
        aguardando: Number(totaisLinha.aguardando || 0),
        validados: Number(totaisLinha.validados || 0),
        invalidos: Number(totaisLinha.invalidos || 0)
      },
      fila: fila.map((grupo) => enriquecerGrupoVerificacao(grupo))
    });
  } catch (err) {
    console.error('[admin/revisao-links]', err);
    res.status(500).json({ erro: 'Erro ao carregar a fila de revisão.' });
  }
});

// Histórico recente é carregado sob demanda e paginado no banco.
// Isso mantém o modal leve mesmo quando houver milhares de grupos.
router.get('/grupos/revisao-links/historico', (req, res) => {
  try {
    const categoriaSlug = sanitizeString(req.query.categoria, 50);
    const tipo = sanitizeString(req.query.tipo, 20);

    if (!categoriaSlug) {
      return res.status(400).json({ erro: 'Selecione uma categoria.' });
    }

    if (!['valido', 'invalido'].includes(tipo)) {
      return res.status(400).json({ erro: 'Tipo de histórico inválido.' });
    }

    const categoria = db.queryOne(
      'SELECT id, nome, slug FROM categories WHERE slug = ?',
      [categoriaSlug]
    );

    if (!categoria) {
      return res.status(404).json({ erro: 'Categoria não encontrada.' });
    }

    const condicao = `
      c.slug = ?
      AND g.status IN ('aprovado', 'indisponivel')
      AND g.link_verificado_em IS NOT NULL
      AND g.link_verificacao_resultado = ?
      AND datetime(g.link_verificado_em, '+${DIAS_ATE_NOVA_VERIFICACAO} days') > datetime('now')
    `;

    const totalLinha = db.queryOne(`
      SELECT COUNT(*) AS total
      FROM groups g
      JOIN categories c ON c.id = g.categoria_id
      WHERE ${condicao}
    `, [categoriaSlug, tipo]) || {};

    const paginacao = criarPaginacao(
      Number(totalLinha.total || 0),
      req.query.pagina,
      ITENS_POR_PAGINA_HISTORICO_REVISAO
    );

    const itens = db.query(`
      SELECT
        g.id, g.nome_grupo, g.link_whatsapp, g.foto_url, g.status,
        g.link_ultima_tentativa_em, g.link_verificado_em,
        g.link_verificacao_resultado, g.link_verificacao_motivo,
        c.nome AS categoria_nome, c.slug AS categoria_slug
      FROM groups g
      JOIN categories c ON c.id = g.categoria_id
      WHERE ${condicao}
      ORDER BY datetime(g.link_verificado_em) DESC, g.id DESC
      LIMIT ? OFFSET ?
    `, [
      categoriaSlug,
      tipo,
      paginacao.por_pagina,
      paginacao.offset
    ]);

    delete paginacao.offset;

    res.json({
      ok: true,
      categoria,
      tipo,
      itens: itens.map((grupo) => enriquecerGrupoVerificacao(grupo)),
      paginacao
    });
  } catch (err) {
    console.error('[admin/revisao-links/historico]', err);
    res.status(500).json({ erro: 'Erro ao carregar o histórico de revisão.' });
  }
});

// Registra o resultado observado pelo administrador no navegador.
router.post('/grupos/:id/confirmar-verificacao-link', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const resultado = sanitizeString(req.body.resultado, 20);

    if (!id) {
      return res.status(400).json({ erro: 'ID do grupo inválido.' });
    }

    if (!['valido', 'invalido'].includes(resultado)) {
      return res.status(400).json({ erro: 'Resultado deve ser "valido" ou "invalido".' });
    }

    const grupo = db.queryOne(
      'SELECT id, nome_grupo, status FROM groups WHERE id = ?',
      [id]
    );

    if (!grupo) {
      return res.status(404).json({ erro: 'Grupo não encontrado.' });
    }

    const status = resultado === 'valido' ? 'aprovado' : 'indisponivel';
    const motivo = resultado === 'valido'
      ? 'Convite confirmado manualmente como funcionando pelo administrador.'
      : 'Convite confirmado manualmente como inválido pelo administrador.';

    db.run(`
      UPDATE groups
      SET status = ?,
          link_ultima_tentativa_em = datetime('now'),
          link_verificado_em = datetime('now'),
          link_verificacao_resultado = ?,
          link_verificacao_motivo = ?,
          link_verificacao_http_status = NULL
      WHERE id = ?
    `, [status, resultado, motivo, id]);

    res.json({
      ok: true,
      id,
      nome: grupo.nome_grupo,
      resultado,
      status,
      mensagem: resultado === 'valido'
        ? 'Grupo validado e mantido público por 5 dias.'
        : 'Grupo marcado como inválido e removido das páginas públicas.'
    });
  } catch (err) {
    console.error('[admin/confirmar-verificacao-link]', err);
    res.status(500).json({ erro: 'Erro ao registrar o resultado da revisão.' });
  }
});

// Pular não altera a classificação do grupo. Apenas coloca o item no fim da
// fila, evitando que ele reapareça imediatamente ao carregar a próxima sessão.
router.post('/grupos/:id/pular-verificacao-link', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    if (!id) {
      return res.status(400).json({ erro: 'ID do grupo inválido.' });
    }

    const grupo = db.queryOne('SELECT id, nome_grupo FROM groups WHERE id = ?', [id]);
    if (!grupo) {
      return res.status(404).json({ erro: 'Grupo não encontrado.' });
    }

    db.run(`
      UPDATE groups
      SET link_ultima_tentativa_em = datetime('now')
      WHERE id = ?
    `, [id]);

    res.json({ ok: true, id, nome: grupo.nome_grupo });
  } catch (err) {
    console.error('[admin/pular-verificacao-link]', err);
    res.status(500).json({ erro: 'Erro ao pular o grupo.' });
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
        [nomeGrupo, link, descricao, categoria.id, 'Importação ZapGrupos', 'admin@zapgrupos.site', regrasTexto]
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

    const linkMudou = link !== grupo.link_whatsapp;

    db.run(
      `UPDATE groups
       SET nome_grupo = ?,
           link_whatsapp = ?,
           descricao = ?,
           categoria_id = ?,
           regras = ?,
           status = ?,
           link_ultima_tentativa_em = CASE WHEN ? = 1 THEN NULL ELSE link_ultima_tentativa_em END,
           link_verificado_em = CASE WHEN ? = 1 THEN NULL ELSE link_verificado_em END,
           link_verificacao_resultado = CASE WHEN ? = 1 THEN 'pendente' ELSE link_verificacao_resultado END,
           link_verificacao_motivo = CASE WHEN ? = 1 THEN NULL ELSE link_verificacao_motivo END,
           link_verificacao_http_status = CASE WHEN ? = 1 THEN NULL ELSE link_verificacao_http_status END
       WHERE id = ?`,
      [
        nomeGrupo,
        link,
        descricao,
        categoriaId,
        regras,
        status || grupo.status,
        linkMudou ? 1 : 0,
        linkMudou ? 1 : 0,
        linkMudou ? 1 : 0,
        linkMudou ? 1 : 0,
        linkMudou ? 1 : 0,
        id
      ]
    );

    res.json({ ok: true, verificacao_link_resetada: linkMudou });
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