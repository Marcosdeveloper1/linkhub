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

let tokenCache = null;

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

function centavosParaDecimal(centavos) {
  return Number((Number(centavos || 0) / 100).toFixed(2));
}

function decimalParaCentavos(valor) {
  return Math.round(Number(valor || 0) * 100);
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
    preco,
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

function limparCpf(valor) {
  return String(valor || '').replace(/\D/g, '');
}

function validarComprador(body) {
  const nome = String(body.nome || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 160);
  const cpf = limparCpf(body.cpf || '');

  if (nome.length < 2) {
    return { erro: 'Informe o nome do comprador.' };
  }

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return { erro: 'Informe um email válido.' };
  }

  if (cpf && cpf.length !== 11) {
    return { erro: 'CPF deve ter 11 números ou ficar em branco.' };
  }

  return { nome, email, cpf: cpf || null };
}

function syncPayBaseUrl() {
  return String(process.env.SYNCPAY_BASE_URL || '').replace(/\/$/, '');
}

function syncPayConfigurado() {
  return Boolean(syncPayBaseUrl() && process.env.SYNCPAY_CLIENT_ID && process.env.SYNCPAY_CLIENT_SECRET);
}

async function syncPayRequest(path, { method = 'GET', body = null, auth = true } = {}) {
  const baseUrl = syncPayBaseUrl();
  if (!baseUrl) throw new Error('SYNCPAY_BASE_URL não configurado.');

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };

  if (auth) {
    headers.Authorization = `Bearer ${await obterTokenSyncPay()}`;
  }

  const resp = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await resp.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    const detalhe = data?.message || data?.erro || data?.error || `HTTP ${resp.status}`;
    throw new Error(`Sync Pay: ${detalhe}`);
  }

  return data;
}

async function obterTokenSyncPay() {
  const agora = Date.now();
  if (tokenCache?.access_token && tokenCache.expires_at_ms && tokenCache.expires_at_ms - 60000 > agora) {
    return tokenCache.access_token;
  }

  const data = await syncPayRequest('/api/partner/v1/auth-token', {
    method: 'POST',
    auth: false,
    body: {
      client_id: process.env.SYNCPAY_CLIENT_ID,
      client_secret: process.env.SYNCPAY_CLIENT_SECRET
    }
  });

  if (!data.access_token) {
    throw new Error('Sync Pay não retornou access_token.');
  }

  tokenCache = {
    access_token: data.access_token,
    expires_at_ms: data.expires_at ? new Date(data.expires_at).getTime() : agora + Number(data.expires_in || 3600) * 1000
  };

  return tokenCache.access_token;
}

function montarWebhookUrl(req) {
  return process.env.SYNCPAY_WEBHOOK_URL || `${req.protocol}://${req.get('host')}/api/webhooks/syncpay`;
}

function formatarPedido(pedido) {
  if (!pedido) return null;
  const coins = Number(pedido.coins || 0);
  const precoCentavos = Number(pedido.preco_centavos || 0);
  const precoUnitario = coins > 0 ? Math.round(precoCentavos / coins) : 0;

  return {
    id: pedido.id,
    user_id: pedido.user_id,
    package_id: pedido.package_id,
    coins,
    preco_centavos: precoCentavos,
    preco_formatado: moedaBRL(precoCentavos),
    preco_unitario_centavos: precoUnitario,
    preco_unitario_formatado: moedaBRL(precoUnitario),
    status: pedido.status,
    gateway: pedido.gateway,
    gateway_payment_id: pedido.gateway_payment_id,
    gateway_status: pedido.gateway_status,
    payment_method: pedido.payment_method,
    pix_code: pedido.pix_code,
    checkout_url: pedido.checkout_url,
    buyer_name: pedido.buyer_name,
    buyer_email: pedido.buyer_email,
    buyer_cpf: pedido.buyer_cpf,
    criado_em: pedido.criado_em,
    pago_em: pedido.pago_em,
    credited_at: pedido.credited_at
  };
}

function buscarPedidoDoUsuario(pedidoId, usuarioId) {
  return db.queryOne(
    `SELECT * FROM zapcoin_orders WHERE id = ? AND user_id = ?`,
    [pedidoId, usuarioId]
  );
}

function statusPagoSyncPay(status) {
  return ['completed', 'paid', 'approved', 'captured'].includes(String(status || '').toLowerCase());
}

function atualizarPedidoGateway({ pedidoId, status, gatewayStatus = null, gatewayPayload = null, pixCode = null, gatewayPaymentId = null }) {
  db.run(
    `UPDATE zapcoin_orders
     SET status = ?,
         gateway_status = COALESCE(?, gateway_status),
         gateway_payload = COALESCE(?, gateway_payload),
         pix_code = COALESCE(?, pix_code),
         gateway_payment_id = COALESCE(?, gateway_payment_id),
         atualizado_em = datetime('now')
     WHERE id = ?`,
    [status, gatewayStatus, gatewayPayload ? JSON.stringify(gatewayPayload).slice(0, 8000) : null, pixCode, gatewayPaymentId, pedidoId]
  );
}

function creditarPedidoPago(pedido, origem = 'syncpay') {
  const atual = db.queryOne('SELECT * FROM zapcoin_orders WHERE id = ?', [pedido.id]);
  if (!atual) return { ok: false, motivo: 'Pedido não encontrado.' };

  if (atual.credited_at || atual.status === 'pago') {
    return { ok: true, ja_creditado: true, saldo: obterSaldo(atual.user_id) };
  }

  const saldoAntes = obterSaldo(atual.user_id);
  const saldoDepois = saldoAntes + Number(atual.coins || 0);

  db.run(
    `UPDATE user_wallets
     SET balance = ?, atualizado_em = datetime('now')
     WHERE user_id = ?`,
    [saldoDepois, atual.user_id]
  );

  registrarMovimento({
    userId: atual.user_id,
    tipo: 'compra',
    quantidade: Number(atual.coins || 0),
    saldoAntes,
    saldoDepois,
    referenciaTipo: 'zapcoin_order',
    referenciaId: atual.id,
    descricao: `Compra de ${atual.coins} ZapCoin${Number(atual.coins) > 1 ? 's' : ''} confirmada via ${origem}`
  });

  db.run(
    `UPDATE zapcoin_orders
     SET status = 'pago', pago_em = COALESCE(pago_em, datetime('now')), credited_at = COALESCE(credited_at, datetime('now')), atualizado_em = datetime('now')
     WHERE id = ?`,
    [atual.id]
  );

  return { ok: true, saldo: saldoDepois };
}

async function criarPixSyncPay(req, pedido, comprador) {
  if (!syncPayConfigurado()) {
    throw new Error('Gateway Sync Pay ainda não configurado. Preencha SYNCPAY_BASE_URL, SYNCPAY_CLIENT_ID e SYNCPAY_CLIENT_SECRET no .env.');
  }

  const client = {
    name: comprador.nome,
    email: comprador.email
  };

  if (comprador.cpf) client.cpf = comprador.cpf;

  const body = {
    amount: centavosParaDecimal(pedido.preco_centavos),
    description: `ZapCoin - ${pedido.coins} crédito${Number(pedido.coins) > 1 ? 's' : ''}`,
    webhook_url: montarWebhookUrl(req),
    client
  };

  const resp = await syncPayRequest('/api/partner/v1/cash-in', {
    method: 'POST',
    body
  });

  const identifier = resp.identifier || resp.id || resp.data?.id || resp.data?.identifier;
  const pixCode = resp.pix_code || resp.paymentCode || resp.data?.pix_code || resp.data?.paymentCode;

  if (!identifier) {
    throw new Error('Sync Pay não retornou identifier da transação.');
  }

  if (!pixCode) {
    throw new Error('Sync Pay não retornou código Pix.');
  }

  return { identifier, pixCode, raw: resp };
}

async function consultarSyncPay(identifier) {
  const resp = await syncPayRequest(`/api/partner/v1/transaction/${encodeURIComponent(identifier)}`, {
    method: 'GET'
  });

  return resp.data || resp;
}

function validarValorGateway(pedido, data) {
  if (!data || data.amount == null) return true;
  const amountCentavos = decimalParaCentavos(data.amount);
  return amountCentavos === Number(pedido.preco_centavos || 0);
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
// Cria o pedido local e direciona para o checkout próprio.
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
        (user_id, package_id, coins, preco_centavos, status, gateway, checkout_url)
       VALUES (?, ?, ?, ?, 'checkout', 'syncpay', ?)`,
      [usuarioId, pacote?.id || 0, calculo.quantidade, calculo.preco_centavos, `/pages/checkout.html?pedido=`]
    );

    const checkoutUrl = `/pages/checkout.html?pedido=${pedidoId}`;
    db.run('UPDATE zapcoin_orders SET checkout_url = ? WHERE id = ?', [checkoutUrl, pedidoId]);

    res.json({
      ok: true,
      pedido_id: pedidoId,
      status: 'checkout',
      quantidade: calculo.quantidade,
      preco_centavos: calculo.preco_centavos,
      preco_formatado: calculo.preco_formatado,
      preco_unitario_formatado: calculo.preco_unitario_formatado,
      checkout_url: checkoutUrl,
      mensagem: `Pedido de ${calculo.quantidade} ZapCoin${calculo.quantidade > 1 ? 's' : ''} criado por ${calculo.preco_formatado}.`
    });
  } catch (err) {
    console.error('[zapcoins/comprar]', err);
    res.status(500).json({ erro: 'Erro ao criar pedido de ZapCoins.' });
  }
});

// GET /api/zapcoins/pedido/:id
router.get('/pedido/:id', requireLogin, (req, res) => {
  try {
    const pedidoId = parseInt(req.params.id, 10);
    if (!pedidoId) return res.status(400).json({ erro: 'Pedido inválido.' });

    const pedido = buscarPedidoDoUsuario(pedidoId, req.session.usuario.id);
    if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });

    res.json(formatarPedido(pedido));
  } catch (err) {
    console.error('[zapcoins/pedido]', err);
    res.status(500).json({ erro: 'Erro ao carregar pedido.' });
  }
});

// POST /api/zapcoins/pedido/:id/pagar
router.post('/pedido/:id/pagar', requireLogin, async (req, res) => {
  try {
    const pedidoId = parseInt(req.params.id, 10);
    const metodo = String(req.body.metodo || 'pix').toLowerCase();
    const comprador = validarComprador(req.body);

    if (!pedidoId) return res.status(400).json({ erro: 'Pedido inválido.' });
    if (comprador.erro) return res.status(400).json({ erro: comprador.erro });

    if (metodo !== 'pix') {
      return res.status(400).json({
        erro: 'Cartão de crédito ainda não foi ativado: a documentação enviada não trouxe endpoint/tokenização oficial para cartão avulso. Nenhum dado de cartão será coletado ou salvo.'
      });
    }

    const pedido = buscarPedidoDoUsuario(pedidoId, req.session.usuario.id);
    if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    if (pedido.status === 'pago' || pedido.credited_at) return res.status(400).json({ erro: 'Este pedido já foi pago.' });

    if (pedido.gateway_payment_id && pedido.pix_code) {
      db.run(
        `UPDATE zapcoin_orders
         SET buyer_name = ?, buyer_email = ?, buyer_cpf = ?, payment_method = 'pix', atualizado_em = datetime('now')
         WHERE id = ?`,
        [comprador.nome, comprador.email, comprador.cpf, pedido.id]
      );

      const pedidoAtualizado = db.queryOne('SELECT * FROM zapcoin_orders WHERE id = ?', [pedido.id]);
      return res.json({
        ok: true,
        reutilizado: true,
        pedido: formatarPedido(pedidoAtualizado),
        pix_code: pedidoAtualizado.pix_code,
        mensagem: 'Este pedido já possui um Pix gerado.'
      });
    }

    const pix = await criarPixSyncPay(req, pedido, comprador);

    db.run(
      `UPDATE zapcoin_orders
       SET status = 'aguardando_pagamento',
           payment_method = 'pix',
           buyer_name = ?,
           buyer_email = ?,
           buyer_cpf = ?,
           gateway_payment_id = ?,
           pix_code = ?,
           gateway_status = 'pending',
           gateway_payload = ?,
           atualizado_em = datetime('now')
       WHERE id = ?`,
      [comprador.nome, comprador.email, comprador.cpf, pix.identifier, pix.pixCode, JSON.stringify(pix.raw).slice(0, 8000), pedido.id]
    );

    const pedidoAtualizado = db.queryOne('SELECT * FROM zapcoin_orders WHERE id = ?', [pedido.id]);

    res.json({
      ok: true,
      pedido: formatarPedido(pedidoAtualizado),
      pix_code: pix.pixCode,
      mensagem: 'Pix gerado com sucesso.'
    });
  } catch (err) {
    console.error('[zapcoins/pagar]', err);
    res.status(500).json({ erro: err.message || 'Erro ao gerar pagamento.' });
  }
});

// POST /api/zapcoins/pedido/:id/verificar
router.post('/pedido/:id/verificar', requireLogin, async (req, res) => {
  try {
    const pedidoId = parseInt(req.params.id, 10);
    if (!pedidoId) return res.status(400).json({ erro: 'Pedido inválido.' });

    const pedido = buscarPedidoDoUsuario(pedidoId, req.session.usuario.id);
    if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });

    if (pedido.status === 'pago' || pedido.credited_at) {
      return res.json({ ok: true, pedido: formatarPedido(pedido), mensagem: 'Pedido já confirmado.' });
    }

    if (!pedido.gateway_payment_id) {
      return res.status(400).json({ erro: 'Gere o Pix antes de verificar o pagamento.' });
    }

    const data = await consultarSyncPay(pedido.gateway_payment_id);

    if (!validarValorGateway(pedido, data)) {
      atualizarPedidoGateway({
        pedidoId: pedido.id,
        status: 'valor_divergente',
        gatewayStatus: data.status,
        gatewayPayload: data
      });
      const atualizado = db.queryOne('SELECT * FROM zapcoin_orders WHERE id = ?', [pedido.id]);
      return res.status(400).json({ erro: 'Pagamento localizado com valor divergente. Verifique manualmente no painel.', pedido: formatarPedido(atualizado) });
    }

    if (statusPagoSyncPay(data.status)) {
      atualizarPedidoGateway({
        pedidoId: pedido.id,
        status: 'aguardando_credito',
        gatewayStatus: data.status,
        gatewayPayload: data,
        pixCode: data.pix_code || null
      });

      const atualizado = db.queryOne('SELECT * FROM zapcoin_orders WHERE id = ?', [pedido.id]);
      creditarPedidoPago(atualizado, 'Sync Pay');
      const pago = db.queryOne('SELECT * FROM zapcoin_orders WHERE id = ?', [pedido.id]);
      return res.json({ ok: true, pedido: formatarPedido(pago), mensagem: 'Pagamento confirmado e ZapCoins creditados.' });
    }

    atualizarPedidoGateway({
      pedidoId: pedido.id,
      status: 'aguardando_pagamento',
      gatewayStatus: data.status || 'pending',
      gatewayPayload: data,
      pixCode: data.pix_code || null
    });

    const atualizado = db.queryOne('SELECT * FROM zapcoin_orders WHERE id = ?', [pedido.id]);
    res.json({ ok: true, pedido: formatarPedido(atualizado), mensagem: 'Pagamento ainda não confirmado.' });
  } catch (err) {
    console.error('[zapcoins/verificar]', err);
    res.status(500).json({ erro: err.message || 'Erro ao verificar pagamento.' });
  }
});

// POST /api/zapcoins/impulsionar
router.post('/impulsionar', requireLogin, (req, res) => {
  try {
    const usuarioId = req.session.usuario.id;
    const grupoId = parseInt(req.body.grupo_id, 10);
    const zapcoins = parseInt(req.body.zapcoins || req.body.dias, 10);

    if (!grupoId) {
      return res.status(400).json({ erro: 'Grupo inválido.' });
    }

    if (!ZAPCOINS_IMPULSO_PERMITIDOS.has(zapcoins)) {
      return res.status(400).json({ erro: 'Escolha 1, 2, 6, 14, 30 ou 60 ZapCoins de impulso.' });
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

    const custo = zapcoins;
    const saldoAntes = obterSaldo(usuarioId);

    if (saldoAntes < custo) {
      return res.status(400).json({
        erro: `Saldo insuficiente. Você precisa de ${custo} ZapCoins para este impulso.`
      });
    }

    const saldoDepois = saldoAntes - custo;
    const periodo = calcularPeriodoBoost(grupo, zapcoins);
    const periodoTexto = textoPeriodoPorZapCoins(zapcoins);

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
module.exports._internals = {
  moedaBRL,
  decimalParaCentavos,
  statusPagoSyncPay,
  validarValorGateway,
  creditarPedidoPago,
  atualizarPedidoGateway,
  formatarPedido,
  syncPayConfigurado,
  consultarSyncPay
};
