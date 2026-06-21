const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireLogin } = require('../middleware/security');

const ZAPCOINS_IMPULSO_PERMITIDOS = new Set([1, 2, 6, 14, 30, 60]);
const MIN_ZAPCOINS_COMPRA = 1;
const MAX_ZAPCOINS_COMPRA = 1000;

const TABELA_PRECOS = [
  { min: 1, max: 4, centavos: 799, nome: 'Avulso' },
  { min: 5, max: 9, centavos: 699, nome: 'Starter' },
  { min: 10, max: 19, centavos: 649, nome: 'Bronze' },
  { min: 20, max: 49, centavos: 599, nome: 'Profissional / Empresarial' },
  { min: 50, max: 99, centavos: 549, nome: 'Empresarial' },
  { min: 100, max: Infinity, centavos: 499, nome: 'Empresarial Plus' }
];

function sqlDate(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function parseSqlDate(value) {
  if (!value) return null;
  return new Date(String(value).replace(' ', 'T') + 'Z');
}

function moedaBRL(centavos) {
  return (Number(centavos || 0) / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}

function faixaPreco(quantidade) {
  return TABELA_PRECOS.find((faixa) => quantidade >= faixa.min && quantidade <= faixa.max) || TABELA_PRECOS[0];
}

function calcularPrecoZapCoins(quantidadeBruta) {
  const quantidade = parseInt(quantidadeBruta, 10);

  if (!Number.isInteger(quantidade) || quantidade < MIN_ZAPCOINS_COMPRA || quantidade > MAX_ZAPCOINS_COMPRA) {
    return null;
  }

  const faixa = faixaPreco(quantidade);
  const precoUnitarioCentavos = faixa.centavos;
  const precoCentavos = quantidade * precoUnitarioCentavos;
  const precoCheioCentavos = quantidade * 799;
  const economiaCentavos = Math.max(0, precoCheioCentavos - precoCentavos);

  return {
    quantidade,
    preco_unitario_centavos: precoUnitarioCentavos,
    preco_centavos: precoCentavos,
    preco_unitario_formatado: moedaBRL(precoUnitarioCentavos),
    preco_formatado: moedaBRL(precoCentavos),
    economia_centavos: economiaCentavos,
    economia_formatada: moedaBRL(economiaCentavos),
    faixa: faixa.nome,
    empresarial: quantidade >= 20
  };
}

function formatarPacote(p) {
  const calculo = calcularPrecoZapCoins(p.coins);
  const preco = Number(p.preco_centavos || calculo?.preco_centavos || 0) / 100;
  const precoPorCoin = p.coins > 0 ? preco / p.coins : 0;

  return {
    id: p.id,
    codigo: p.codigo,
    nome: p.nome,
    coins: p.coins,
    preco_centavos: p.preco_centavos,
    preco: preco,
    preco_formatado: preco.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    preco_por_coin: precoPorCoin,
    preco_por_coin_formatado: precoPorCoin.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    descricao: p.descricao,
    destaque: Boolean(p.destaque),
    empresarial: Number(p.coins) >= 20,
    economia_centavos: calculo?.economia_centavos || 0,
    economia_formatada: calculo?.economia_formatada || moedaBRL(0)
  };
}

function garantirCarteira(usuarioId) {
  db.run(
    `INSERT OR IGNORE INTO user_wallets (user_id, balance)
     VALUES (?, 0)`,
    [usuarioId]
  );

  return db.queryOne(
    `SELECT user_id, balance FROM user_wallets WHERE user_id = ?`,
    [usuarioId]
  );
}

function obterSaldo(usuarioId) {
  const carteira = garantirCarteira(usuarioId);
  return Number(carteira?.balance || 0);
}

function registrarMovimento({ userId, tipo, quantidade, saldoAntes, saldoDepois, referenciaTipo = null, referenciaId = null, descricao = null, adminId = null }) {
  db.run(
    `INSERT INTO wallet_transactions
      (user_id, tipo, quantidade, saldo_antes, saldo_depois, referencia_tipo, referencia_id, descricao, admin_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, tipo, quantidade, saldoAntes, saldoDepois, referenciaTipo, referenciaId, descricao, adminId]
  );
}

function obterPacotes() {
  return db.query(
    `SELECT *
     FROM zapcoin_packages
     WHERE ativo = 1
     ORDER BY ordem ASC, coins ASC`
  ).map(formatarPacote);
}

function calcularPeriodoBoost(grupo, zapcoins) {
  const agora = new Date();
  const boostAtual = parseSqlDate(grupo.impulsionado_ate);
  const base = boostAtual && boostAtual > agora ? boostAtual : agora;
  const horas = zapcoins * 12;
  const fim = new Date(base.getTime() + horas * 60 * 60 * 1000);

  return {
    inicio: sqlDate(base),
    fim: sqlDate(fim),
    horas,
    diasEquivalentes: horas / 24
  };
}

function textoPeriodoPorZapCoins(zapcoins) {
  const horas = zapcoins * 12;
  if (horas < 24) return `${horas} horas`;
  const dias = horas / 24;
  if (Number.isInteger(dias)) return `${dias} dia${dias > 1 ? 's' : ''}`;
  return `${horas} horas`;
}

// GET /api/zapcoins/resumo
router.get('/resumo', requireLogin, (req, res) => {
  try {
    const usuarioId = req.session.usuario.id;
    const saldo = obterSaldo(usuarioId);
    const pacotes = obterPacotes();

    const historico = db.query(
      `SELECT id, tipo, quantidade, saldo_antes, saldo_depois, descricao, referencia_tipo, referencia_id, criado_em
       FROM wallet_transactions
       WHERE user_id = ?
       ORDER BY criado_em DESC, id DESC
       LIMIT 12`,
      [usuarioId]
    );

    const impulsionamentosAtivos = db.query(
      `SELECT b.id, b.group_id, b.coins_used, b.days, b.starts_at, b.ends_at, g.nome_grupo
       FROM group_boosts b
       JOIN groups g ON g.id = b.group_id
       WHERE b.user_id = ?
         AND b.status = 'ativo'
         AND datetime(b.ends_at) > datetime('now')
       ORDER BY b.ends_at DESC`,
      [usuarioId]
    );

    res.json({
      saldo,
      moeda: 'ZapCoin',
      pacotes,
      historico,
      impulsionamentos_ativos: impulsionamentosAtivos
    });
  } catch (err) {
    console.error('[zapcoins/resumo]', err);
    res.status(500).json({ erro: 'Erro ao carregar ZapCoins.' });
  }
});

// GET /api/zapcoins/pacotes
router.get('/pacotes', requireLogin, (req, res) => {
  try {
    res.json(obterPacotes());
  } catch (err) {
    console.error('[zapcoins/pacotes]', err);
    res.status(500).json({ erro: 'Erro ao carregar pacotes.' });
  }
});

// GET /api/zapcoins/calcular?quantidade=25
router.get('/calcular', requireLogin, (req, res) => {
  try {
    const calculo = calcularPrecoZapCoins(req.query.quantidade);
    if (!calculo) {
      return res.status(400).json({ erro: `Escolha entre ${MIN_ZAPCOINS_COMPRA} e ${MAX_ZAPCOINS_COMPRA} ZapCoins.` });
    }

    res.json(calculo);
  } catch (err) {
    console.error('[zapcoins/calcular]', err);
    res.status(500).json({ erro: 'Erro ao calcular preço.' });
  }
});

// POST /api/zapcoins/comprar
// Cria pedido pendente. O preço é sempre calculado aqui no backend.
// O front nunca define preço, apenas quantidade.
router.post('/comprar', requireLogin, (req, res) => {
  try {
    const usuarioId = req.session.usuario.id;
    const quantidade = parseInt(req.body.quantidade || req.body.coins, 10);
    const calculo = calcularPrecoZapCoins(quantidade);

    if (!calculo) {
      return res.status(400).json({ erro: `Escolha entre ${MIN_ZAPCOINS_COMPRA} e ${MAX_ZAPCOINS_COMPRA} ZapCoins.` });
    }

    const pacote = db.queryOne(
      `SELECT id FROM zapcoin_packages WHERE coins = ? AND ativo = 1 ORDER BY ordem ASC LIMIT 1`,
      [calculo.quantidade]
    );

    const pedidoId = db.run(
      `INSERT INTO zapcoin_orders
        (user_id, package_id, coins, preco_centavos, status, gateway)
       VALUES (?, ?, ?, ?, 'pendente', 'syncpay')`,
      [usuarioId, pacote?.id || 0, calculo.quantidade, calculo.preco_centavos]
    );

    res.json({
      ok: true,
      pedido_id: pedidoId,
      status: 'pendente',
      quantidade: calculo.quantidade,
      preco_centavos: calculo.preco_centavos,
      preco_formatado: calculo.preco_formatado,
      preco_unitario_formatado: calculo.preco_unitario_formatado,
      empresarial: calculo.empresarial,
      mensagem: `Pedido de ${calculo.quantidade} ZapCoin${calculo.quantidade > 1 ? 's' : ''} criado por ${calculo.preco_formatado}. A Sync Pay será ligada na próxima etapa.`
    });
  } catch (err) {
    console.error('[zapcoins/comprar]', err);
    res.status(500).json({ erro: 'Erro ao criar pedido de ZapCoins.' });
  }
});

// POST /api/zapcoins/impulsionar
router.post('/impulsionar', requireLogin, (req, res) => {
  try {
    const usuarioId = req.session.usuario.id;
    const grupoId = parseInt(req.body.grupo_id, 10);
    const zapcoinsSolicitados = parseInt(req.body.zapcoins || req.body.quantidade || req.body.dias, 10);

    if (!grupoId) {
      return res.status(400).json({ erro: 'Grupo inválido.' });
    }

    if (!ZAPCOINS_IMPULSO_PERMITIDOS.has(zapcoinsSolicitados)) {
      return res.status(400).json({ erro: 'Escolha uma opção válida de impulso: 12 horas, 24 horas, 3 dias, 7 dias, 15 dias ou 30 dias.' });
    }

    const grupo = db.queryOne(
      `SELECT g.id, g.nome_grupo, g.usuario_id, g.status,
              (
                SELECT MAX(b.ends_at)
                FROM group_boosts b
                WHERE b.group_id = g.id
                  AND b.status = 'ativo'
                  AND datetime(b.ends_at) > datetime('now')
              ) as impulsionado_ate
       FROM groups g
       WHERE g.id = ?`,
      [grupoId]
    );

    if (!grupo) {
      return res.status(404).json({ erro: 'Grupo não encontrado.' });
    }

    if (grupo.usuario_id !== usuarioId) {
      return res.status(403).json({ erro: 'Você só pode impulsionar grupos enviados por você.' });
    }

    if (grupo.status !== 'aprovado') {
      return res.status(400).json({ erro: 'Somente grupos aprovados podem ser impulsionados.' });
    }

    const custo = zapcoinsSolicitados;
    const saldoAntes = obterSaldo(usuarioId);

    if (saldoAntes < custo) {
      return res.status(400).json({
        erro: `Saldo insuficiente. Você precisa de ${custo} ZapCoins para este impulso.`
      });
    }

    const saldoDepois = saldoAntes - custo;
    const periodo = calcularPeriodoBoost(grupo, zapcoinsSolicitados);
    const periodoTexto = textoPeriodoPorZapCoins(zapcoinsSolicitados);

    db.run(
      `UPDATE user_wallets
       SET balance = ?, atualizado_em = datetime('now')
       WHERE user_id = ?`,
      [saldoDepois, usuarioId]
    );

    const boostId = db.run(
      `INSERT INTO group_boosts
        (group_id, user_id, coins_used, days, starts_at, ends_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'ativo')`,
      [grupoId, usuarioId, custo, periodo.diasEquivalentes, periodo.inicio, periodo.fim]
    );

    registrarMovimento({
      userId: usuarioId,
      tipo: 'uso',
      quantidade: -custo,
      saldoAntes,
      saldoDepois,
      referenciaTipo: 'group_boost',
      referenciaId: boostId,
      descricao: `Impulso de ${periodoTexto} para o grupo "${grupo.nome_grupo}"`
    });

    res.json({
      ok: true,
      saldo: saldoDepois,
      boost_id: boostId,
      impulsionado_ate: periodo.fim,
      mensagem: `Grupo impulsionado por ${periodoTexto}.`
    });
  } catch (err) {
    console.error('[zapcoins/impulsionar]', err);
    res.status(500).json({ erro: 'Erro ao impulsionar grupo.' });
  }
});

module.exports = router;