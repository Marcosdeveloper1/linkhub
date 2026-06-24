const express = require('express');
const validator = require('validator');
const router = express.Router();
const db = require('../db');
const { buscarPreviewGrupo, baixarFotoGrupo } = require('../utils/whatsappPreview');
const { limiterGrupo, requireLogin, sanitizeString, isValidWhatsAppLink } = require('../middleware/security');

const CATEGORIAS_PADRAO = [
  {
    "nome": "Amizade",
    "slug": "amizade",
    "icone": "users"
  },
  {
    "nome": "Relacionamento",
    "slug": "relacionamento",
    "icone": "heart"
  },
  {
    "nome": "Carros e Motos",
    "slug": "carros",
    "icone": "car"
  },
  {
    "nome": "Cidades",
    "slug": "cidade",
    "icone": "building"
  },
  {
    "nome": "Compra e Venda",
    "slug": "compras-e-vendas",
    "icone": "shopping-cart"
  },
  {
    "nome": "Concursos",
    "slug": "concursos",
    "icone": "books"
  },
  {
    "nome": "Desenhos e Animes",
    "slug": "desenhos",
    "icone": "video"
  },
  {
    "nome": "Divulgação",
    "slug": "divulgacao",
    "icone": "megaphone"
  },
  {
    "nome": "Educação",
    "slug": "educacao",
    "icone": "school"
  },
  {
    "nome": "Emagrecimento",
    "slug": "emagrecimento",
    "icone": "activity"
  },
  {
    "nome": "Dinheiro",
    "slug": "financas",
    "icone": "currency-dollar"
  },
  {
    "nome": "Investimentos",
    "slug": "investimentos",
    "icone": "chart-line"
  },
  {
    "nome": "Links",
    "slug": "links",
    "icone": "link"
  },
  {
    "nome": "Receitas",
    "slug": "receitas",
    "icone": "chef-hat"
  },
  {
    "nome": "Religião",
    "slug": "religiao",
    "icone": "sparkles"
  },
  {
    "nome": "Turismo",
    "slug": "turismo",
    "icone": "map"
  },
  {
    "nome": "Política",
    "slug": "politica",
    "icone": "speakerphone"
  },
  {
    "nome": "Tecnologia",
    "slug": "tecnologia",
    "icone": "device-laptop"
  },
  {
    "nome": "Saúde",
    "slug": "saude",
    "icone": "heart-pulse"
  },
  {
    "nome": "Entretenimento",
    "slug": "entretenimento",
    "icone": "movie"
  },
  {
    "nome": "Empregos",
    "slug": "empregos",
    "icone": "briefcase"
  },
  {
    "nome": "Negócios",
    "slug": "negocios",
    "icone": "trending-up"
  },
  {
    "nome": "Esportes",
    "slug": "esportes",
    "icone": "ball-football"
  },
  {
    "nome": "Outros",
    "slug": "outros",
    "icone": "dots-circle-horizontal"
  }
];

function garantirCategoriasPadrao() {
  CATEGORIAS_PADRAO.forEach((cat) => {
    db.run('INSERT OR IGNORE INTO categories (nome, slug, icone) VALUES (?, ?, ?)', [cat.nome, cat.slug, cat.icone]);
    db.run('UPDATE categories SET nome = ?, icone = ? WHERE slug = ?', [cat.nome, cat.icone, cat.slug]);
  });
}

function ordemCategoriasSql() {
  return `CASE c.slug
        WHEN 'amizade' THEN 1
        WHEN 'relacionamento' THEN 2
        WHEN 'carros' THEN 3
        WHEN 'cidade' THEN 4
        WHEN 'compras-e-vendas' THEN 5
        WHEN 'concursos' THEN 6
        WHEN 'desenhos' THEN 7
        WHEN 'divulgacao' THEN 8
        WHEN 'educacao' THEN 9
        WHEN 'emagrecimento' THEN 10
        WHEN 'financas' THEN 11
        WHEN 'investimentos' THEN 12
        WHEN 'links' THEN 13
        WHEN 'receitas' THEN 14
        WHEN 'religiao' THEN 15
        WHEN 'turismo' THEN 16
        WHEN 'politica' THEN 17
        WHEN 'tecnologia' THEN 18
        WHEN 'saude' THEN 19
        WHEN 'entretenimento' THEN 20
        WHEN 'empregos' THEN 21
        WHEN 'negocios' THEN 22
        WHEN 'esportes' THEN 23
        WHEN 'outros' THEN 24
        ELSE 999
      END, c.nome`;
}

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

router.get('/', (req, res) => {
  try {
    const categoria = req.query.categoria ? sanitizeString(req.query.categoria, 50) : null;
    const busca = req.query.busca ? sanitizeString(req.query.busca, 100) : null;
    const pagina = Math.max(1, parseInt(req.query.pagina) || 1);
    const porPagina = 16;
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
              c.nome as categoria_nome, c.slug as categoria_slug, c.icone as categoria_icone,
              (
                SELECT MAX(b.ends_at)
                FROM group_boosts b
                WHERE b.group_id = g.id
                  AND b.status = 'ativo'
                  AND datetime(b.ends_at) > datetime('now')
              ) as impulsionado_ate,
              (
                SELECT MAX(b.criado_em)
                FROM group_boosts b
                WHERE b.group_id = g.id
                  AND b.status = 'ativo'
                  AND datetime(b.ends_at) > datetime('now')
              ) as impulsionado_em,
              CASE
                WHEN EXISTS (
                  SELECT 1
                  FROM group_boosts b2
                  WHERE b2.group_id = g.id
                    AND b2.status = 'ativo'
                    AND datetime(b2.ends_at) > datetime('now')
                )
                THEN 1 ELSE 0
              END as impulsionado
       FROM groups g
       JOIN categories c ON g.categoria_id = c.id
       WHERE ${where}
       ORDER BY impulsionado DESC, datetime(CASE WHEN impulsionado = 1 THEN impulsionado_em ELSE g.aprovado_em END) DESC, datetime(g.aprovado_em) DESC, g.id DESC
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
    garantirCategoriasPadrao();
    const isAdmin = req.session.usuario && req.session.usuario.role === 'admin';
    const incluirIndisponiveis = isAdmin && req.query.incluirIndisponiveis === 'true';
    const statusSql = incluirIndisponiveis ? "g.status IN ('aprovado', 'indisponivel')" : "g.status = 'aprovado'";

    const cats = db.query(`
      SELECT c.id, c.nome, c.slug, c.icone,
             COUNT(g.id) as total_grupos
      FROM categories c
      LEFT JOIN groups g ON g.categoria_id = c.id AND ${statusSql}
      GROUP BY c.id
      ORDER BY ${ordemCategoriasSql()}
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
              g.owner_email, g.owner_user_id, g.ownership_status, g.ownership_claimed_at,
              c.nome as categoria_nome,
              (
                SELECT MAX(b.ends_at)
                FROM group_boosts b
                WHERE b.group_id = g.id
                  AND b.status = 'ativo'
                  AND datetime(b.ends_at) > datetime('now')
              ) as impulsionado_ate,
              (
                SELECT MAX(b.criado_em)
                FROM group_boosts b
                WHERE b.group_id = g.id
                  AND b.status = 'ativo'
                  AND datetime(b.ends_at) > datetime('now')
              ) as impulsionado_em,
              CASE
                WHEN EXISTS (
                  SELECT 1
                  FROM group_boosts b2
                  WHERE b2.group_id = g.id
                    AND b2.status = 'ativo'
                    AND datetime(b2.ends_at) > datetime('now')
                )
                THEN 1 ELSE 0
              END as impulsionado
       FROM groups g
       JOIN categories c ON g.categoria_id = c.id
       WHERE g.usuario_id = ?
          OR g.owner_user_id = ?
          OR LOWER(COALESCE(g.owner_email, '')) = LOWER(?)
       ORDER BY g.criado_em DESC`,
      [req.session.usuario.id, req.session.usuario.id, req.session.usuario.email]
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
      'SELECT id, usuario_id, owner_user_id, owner_email FROM groups WHERE id = ?',
      [id]
    );

    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado.' });

    const ehDono = grupo.usuario_id === req.session.usuario.id ||
      grupo.owner_user_id === req.session.usuario.id ||
      String(grupo.owner_email || '').toLowerCase() === String(req.session.usuario.email || '').toLowerCase();

    if (!ehDono) {
      return res.status(403).json({ erro: 'Você não tem permissão para remover este grupo.' });
    }

    db.run('DELETE FROM groups WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[grupos/meus/remover]', err);
    res.status(500).json({ erro: 'Erro ao remover grupo.' });
  }
});

// POST /api/grupos/preview — busca uma prévia pública do link do WhatsApp antes do envio
router.post('/preview', requireLogin, async (req, res) => {
  try {
    const link = sanitizeString(req.body.link_whatsapp, 300);

    if (!isValidWhatsAppLink(link)) {
      return res.status(400).json({ erro: 'Link do WhatsApp inválido.' });
    }

    const preview = await buscarPreviewGrupo(link);

    res.json({
      ok: true,
      nome: preview?.nome ? sanitizeString(preview.nome, 100) : '',
      descricao: preview?.descricao ? sanitizeString(preview.descricao, 300) : '',
      foto: preview?.foto || null
    });
  } catch (err) {
    console.error('[grupos/preview]', err);
    res.status(500).json({ erro: 'Não foi possível buscar a prévia do grupo.' });
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
    garantirCategoriasPadrao();


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
      `INSERT INTO groups
        (nome_grupo, link_whatsapp, descricao, categoria_id, usuario_id, owner_email, owner_user_id, ownership_status, ownership_claimed_at, nome_contato, email_contato, regras, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'vinculado', datetime('now'), ?, ?, ?, 'pendente')`,
      [
        nomeGrupo,
        link,
        descricao,
        categoriaId,
        req.session.usuario.id,
        req.session.usuario.email,
        req.session.usuario.id,
        nomeContato,
        validator.normalizeEmail(emailContato),
        regras
      ]
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


// POST /api/grupos/:id/comunicar-erro — usuário logado relata problema em um grupo
router.post('/:id/comunicar-erro', requireLogin, (req, res) => {
  try {
    garantirTabelaRelatosErro();

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ erro: 'ID inválido.' });

    const tipo = sanitizeString(req.body.tipo, 50);
    const descricao = req.body.descricao ? sanitizeString(req.body.descricao, 1000) : '';

    if (!TIPOS_RELATO_ERRO[tipo]) {
      return res.status(400).json({ erro: 'Selecione um tipo de erro válido.' });
    }

    if (tipo === 'outro' && descricao.length < 10) {
      return res.status(400).json({ erro: 'Descreva o problema com pelo menos 10 caracteres.' });
    }

    const grupo = db.queryOne(
      "SELECT id, status FROM groups WHERE id = ? AND status IN ('aprovado', 'indisponivel')",
      [id]
    );

    if (!grupo) {
      return res.status(404).json({ erro: 'Grupo não encontrado ou não disponível para relato.' });
    }

    db.run(
      `INSERT INTO error_reports (grupo_id, usuario_id, tipo, descricao, status)
       VALUES (?, ?, ?, ?, 'pendente')`,
      [id, req.session.usuario.id, tipo, descricao || null]
    );

    res.json({ ok: true, mensagem: 'Erro comunicado com sucesso. Nossa equipe irá analisar.' });
  } catch (err) {
    console.error('[grupos/comunicar-erro]', err);
    res.status(500).json({ erro: 'Erro ao comunicar problema. Tente novamente.' });
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
      SELECT g.*, c.nome as categoria_nome, c.slug as categoria_slug,
             (
               SELECT MAX(b.ends_at)
               FROM group_boosts b
               WHERE b.group_id = g.id
                 AND b.status = 'ativo'
                 AND datetime(b.ends_at) > datetime('now')
             ) as impulsionado_ate,
             CASE
               WHEN EXISTS (
                 SELECT 1
                 FROM group_boosts b2
                 WHERE b2.group_id = g.id
                   AND b2.status = 'ativo'
                   AND datetime(b2.ends_at) > datetime('now')
               )
               THEN 1 ELSE 0
             END as impulsionado
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
      SELECT g.id, g.nome_grupo, g.descricao, g.foto_url, c.nome as categoria_nome,
             (
               SELECT MAX(b.ends_at)
               FROM group_boosts b
               WHERE b.group_id = g.id
                 AND b.status = 'ativo'
                 AND datetime(b.ends_at) > datetime('now')
             ) as impulsionado_ate,
             CASE
               WHEN EXISTS (
                 SELECT 1
                 FROM group_boosts b2
                 WHERE b2.group_id = g.id
                   AND b2.status = 'ativo'
                   AND datetime(b2.ends_at) > datetime('now')
               )
               THEN 1 ELSE 0
             END as impulsionado
      FROM groups g
      JOIN categories c ON c.id = g.categoria_id
      WHERE g.categoria_id = ? AND g.status = 'aprovado' AND g.id != ?
      ORDER BY impulsionado DESC, datetime(impulsionado_ate) DESC, datetime(g.aprovado_em) DESC
      LIMIT 6
    `, [grupo.categoria_id, id]);

    res.json(relacionados);
  } catch (err) {
    console.error('[grupos/relacionados]', err);
    res.status(500).json({ erro: 'Erro ao carregar grupos relacionados.' });
  }
});

module.exports = router;
