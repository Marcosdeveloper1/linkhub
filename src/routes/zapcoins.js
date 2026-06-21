const express = require('express');
const crypto = require('crypto');
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

function mercadoPagoConfigurado() {
  return Boolean(process.env.MERCADOPAGO_ACCESS_TOKEN);
}

function mercadoPagoAccessToken() {
  if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
    throw new Error('MERCADOPAGO_ACCESS_TOKEN não configurado no .env.');
  }
  return process.env.MERCADOPAGO_ACCESS_TOKEN;
}

async function mercadoPagoRequest(path, { method = 'GET', body = null, idempotencyKey = null } = {}) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${mercadoPagoAccessToken()}`
  };

  if (idempotencyKey) {
    headers['X-Idempotency-Key'] = idempotencyKey;
  }

  const resp = await fetch(`https://api.mercadopago.com${path}`, {
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
    const detalhe = data?.message || data?.error || data?.cause?.[0]?.description || `HTTP ${resp.status}`;
    throw new Error(`Mercado Pago: ${detalhe}`);
  }

  return data;
}

function montarWebhookMercadoPagoUrl(req) {
  return process.env.MERCADOPAGO_WEBHOOK_URL || `${req.protocol}://${req.get('host')}/api/webhooks/mercadopago`;
}


function siteUrl(req) {
  return String(process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function escolherCheckoutMercadoPagoUrl(preference) {
  return preference?.init_point || preference?.sandbox_init_point || null;
}

async function criarPreferenciaMercadoPago({ req, pedido, usuario }) {
  const baseUrl = siteUrl(req);
  const coins = Number(pedido.coins || 0);
  const titulo = `${coins} ZapCoin${coins !== 1 ? 's' : ''} - WhatsApp Grupos`;

  const payload = {
    items: [
      {
        id: `zapcoin-${pedido.id}`,
        title: titulo,
        description: `${coins * 12} horas de impulso para grupos aprovados`,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: centavosParaDecimal(pedido.preco_centavos)
      }
    ],
    payer: {
      name: usuario?.nome || undefined,
      email: usuario?.email || undefined
    },
    external_reference: `zapcoin_order_${pedido.id}`,
    notification_url: montarWebhookMercadoPagoUrl(req),
    back_urls: {
      success: `${baseUrl}/pages/meus-grupos.html?pagamento=sucesso&pedido=${pedido.id}`,
      failure: `${baseUrl}/pages/meus-grupos.html?pagamento=falhou&pedido=${pedido.id}`,
      pending: `${baseUrl}/pages/meus-grupos.html?pagamento=pendente&pedido=${pedido.id}`
    },
    auto_return: 'approved',
    statement_descriptor: 'WHATSAPPGRUPOS',
    metadata: {
      order_id: String(pedido.id),
      user_id: String(pedido.user_id),
      product: 'zapcoin',
      coins
    }
  };

  return mercadoPagoRequest('/checkout/preferences', {
    method: 'POST',
    body: payload,
    idempotencyKey: crypto.createHash('sha256').update(`zapcoin-preference:${pedido.id}:${pedido.preco_centavos}`).digest('hex')
  });
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
    pix_qr_code_base64: pedido.gateway_payload ? extrairQrCodeBase64Seguro(pedido.gateway_payload) : null,
    checkout_url: pedido.checkout_url,
    buyer_name: pedido.buyer_name,
    buyer_email: pedido.buyer_email,
    buyer_cpf: pedido.buyer_cpf,
    criado_em: pedido.criado_em,
    pago_em: pedido.pago_em,
    credited_at: pedido.credited_at
  };
}

function extrairQrCodeBase64Seguro(payloadTexto) {
  try {
    const data = JSON.parse(payloadTexto || '{}');
    return data?.point_of_interaction?.transaction_data?.qr_code_base64 || null;
  } catch {
    return null;
  }
}

function buscarPedidoDoUsuario(pedidoId, usuarioId) {
  return db.queryOne(
    `SELECT * FROM zapcoin_orders WHERE id = ? AND user_id = ?`,
    [pedidoId, usuarioId]
  );
}

function statusPagoMercadoPago(status) {
  return ['approved', 'paid', 'accredited'].includes(String(status || '').toLowerCase());
}

function statusFalhouMercadoPago(status) {
  return ['rejected', 'cancelled', 'refunded', 'charged_back'].includes(String(status || '').toLowerCase());
}

function traduzirStatusMercadoPago(status) {
  const st = String(status || '').toLowerCase();
  if (statusPagoMercadoPago(st)) return 'pago';
  if (statusFalhouMercadoPago(st)) return 'falhou';
  if (['in_process', 'pending', 'authorized'].includes(st)) return 'aguardando_pagamento';
  return 'aguardando_pagamento';
}

function atualizarPedidoGateway({ pedidoId, status, gatewayStatus = null, gatewayPayload = null, pixCode = null, gatewayPaymentId = null, paymentMethod = null, finalAmountCentavos = null }) {
  db.run(
    `UPDATE zapcoin_orders
     SET status = ?,
         gateway_status = COALESCE(?, gateway_status),
         gateway_payload = COALESCE(?, gateway_payload),
         pix_code = COALESCE(?, pix_code),
         gateway_payment_id = COALESCE(?, gateway_payment_id),
         payment_method = COALESCE(?, payment_method),
         gateway_final_amount_centavos = COALESCE(?, gateway_final_amount_centavos),
         atualizado_em = datetime('now')
     WHERE id = ?`,
    [
      status,
      gatewayStatus,
      gatewayPayload ? JSON.stringify(gatewayPayload).slice(0, 8000) : null,
      pixCode,
      gatewayPaymentId,
      paymentMethod,
      finalAmountCentavos,
      pedidoId
    ]
  );
}

function creditarPedidoPago(pedido, origem = 'Mercado Pago') {
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

function validarValorGateway(pedido, data) {
  if (!data || data.transaction_amount == null) return true;
  const amountCentavos = decimalParaCentavos(data.transaction_amount);
  return amountCentavos === Number(pedido.preco_centavos || 0);
}

function identificarPedidoPorPagamento(data) {
  const externalReference = String(data.external_reference || '');
  const match = externalReference.match(/zapcoin_order_(\d+)/);
  if (match) {
    return db.queryOne('SELECT * FROM zapcoin_orders WHERE id = ?', [parseInt(match[1], 10)]);
  }

  if (data.id) {
    return db.queryOne('SELECT * FROM zapcoin_orders WHERE gateway_payment_id = ?', [String(data.id)]);
  }

  return null;
}

async function consultarPagamentoMercadoPago(paymentId) {
  if (!paymentId) throw new Error('ID do pagamento não informado.');
  return mercadoPagoRequest(`/v1/payments/${encodeURIComponent(paymentId)}`);
}

function extrairPixCodePagamento(data) {
  return data?.point_of_interaction?.transaction_data?.qr_code || null;
}

function extrairMetodoPagamento(data) {
  if (data?.payment_method_id === 'pix') return 'pix';
  if (data?.payment_type_id) return data.payment_type_id;
  return data?.payment_method_id || null;
}

function montarPayloadPagamentoMercadoPago({ req, pedido, comprador, formData }) {
  const payer = formData?.payer && typeof formData.payer === 'object' ? { ...formData.payer } : {};
  payer.email = comprador.email || payer.email;

  if (comprador.cpf) {
    payer.identification = {
      type: 'CPF',
      number: comprador.cpf
    };
  }

  const payload = {
    transaction_amount: centavosParaDecimal(pedido.preco_centavos),
    description: `ZapCoin - ${pedido.coins} crédito${Number(pedido.coins) > 1 ? 's' : ''}`,
    payment_method_id: formData.payment_method_id,
    payer,
    external_reference: `zapcoin_order_${pedido.id}`,
    notification_url: montarWebhookMercadoPagoUrl(req),
    metadata: {
      order_id: String(pedido.id),
      user_id: String(pedido.user_id),
      product: 'zapcoin',
      coins: Number(pedido.coins || 0)
    }
  };

  if (formData.token) payload.token = formData.token;
  if (formData.issuer_id) payload.issuer_id = formData.issuer_id;
  if (formData.installments) payload.installments = Number(formData.installments);

  return payload;
}

function aplicarRetornoMercadoPagoNoPedido(pedido, data) {
  if (!validarValorGateway(pedido, data)) {
    atualizarPedidoGateway({
      pedidoId: pedido.id,
      status: 'valor_divergente',
      gatewayStatus: data.status,
      gatewayPayload: data,
      pixCode: extrairPixCodePagamento(data),
      gatewayPaymentId: data.id ? String(data.id) : null,
      paymentMethod: extrairMetodoPagamento(data),
      finalAmountCentavos: data.transaction_amount != null ? decimalParaCentavos(data.transaction_amount) : null
    });
    return { ok: false, status: 'valor_divergente', mensagem: 'Pagamento localizado com valor divergente. Verifique manualmente no painel.' };
  }

  const novoStatus = traduzirStatusMercadoPago(data.status);

  atualizarPedidoGateway({
    pedidoId: pedido.id,
    status: novoStatus === 'pago' ? 'aguardando_credito' : novoStatus,
    gatewayStatus: data.status,
    gatewayPayload: data,
    pixCode: extrairPixCodePagamento(data),
    gatewayPaymentId: data.id ? String(data.id) : null,
    paymentMethod: extrairMetodoPagamento(data),
    finalAmountCentavos: data.transaction_amount != null ? decimalParaCentavos(data.transaction_amount) : null
  });

  if (novoStatus === 'pago') {
    const atualizado = db.queryOne('SELECT * FROM zapcoin_orders WHERE id = ?', [pedido.id]);
    creditarPedidoPago(atualizado, 'Mercado Pago');
    return { ok: true, status: 'pago', mensagem: 'Pagamento aprovado e ZapCoins creditados.' };
  }

  return {
    ok: true,
    status: novoStatus,
    mensagem: novoStatus === 'falhou' ? 'Pagamento recusado pelo Mercado Pago.' : 'Pagamento enviado. Aguarde a confirmação.'
  };
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

// GET /api/zapcoins/mercadopago/config
router.get('/mercadopago/config', requireLogin, (req, res) => {
  try {
    if (!process.env.MERCADOPAGO_PUBLIC_KEY) {
      return res.status(500).json({ erro: 'MERCADOPAGO_PUBLIC_KEY não configurada no .env.' });
    }

    res.json({
      public_key: process.env.MERCADOPAGO_PUBLIC_KEY,
      locale: 'pt-BR'
    });
  } catch (err) {
    console.error('[zapcoins/mp/config]', err);
    res.status(500).json({ erro: 'Erro ao carregar configuração do Mercado Pago.' });
  }
});

// POST /api/zapcoins/comprar
// Cria o pedido local e redireciona para o Checkout Pro oficial do Mercado Pago.
router.post('/comprar', requireLogin, async (req, res) => {
  try {
    if (!mercadoPagoConfigurado()) {
      return res.status(500).json({ erro: 'Mercado Pago não configurado. Preencha MERCADOPAGO_ACCESS_TOKEN no .env.' });
    }

    const usuario = req.session.usuario;
    const usuarioId = usuario.id;
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
        (user_id, package_id, coins, preco_centavos, status, gateway, buyer_name, buyer_email)
       VALUES (?, ?, ?, ?, 'checkout', 'mercadopago', ?, ?)`,
      [usuarioId, pacote?.id || 0, calculo.quantidade, calculo.preco_centavos, usuario.nome || null, usuario.email || null]
    );

    const pedido = db.queryOne('SELECT * FROM zapcoin_orders WHERE id = ?', [pedidoId]);
    const preference = await criarPreferenciaMercadoPago({ req, pedido, usuario });
    const checkoutUrl = escolherCheckoutMercadoPagoUrl(preference);

    if (!checkoutUrl) {
      throw new Error('Mercado Pago não retornou URL de checkout.');
    }

    db.run(
      `UPDATE zapcoin_orders
       SET checkout_url = ?, gateway_status = ?, gateway_payload = ?, gateway_preference_id = ?, atualizado_em = datetime('now')
       WHERE id = ?`,
      [checkoutUrl, 'preference_created', JSON.stringify(preference).slice(0, 8000), preference.id ? String(preference.id) : null, pedidoId]
    );

    res.json({
      ok: true,
      pedido_id: pedidoId,
      status: 'checkout',
      gateway: 'mercadopago',
      quantidade: calculo.quantidade,
      preco_centavos: calculo.preco_centavos,
      preco_formatado: calculo.preco_formatado,
      preco_unitario_formatado: calculo.preco_unitario_formatado,
      checkout_url: checkoutUrl,
      mensagem: `Você será direcionado para o checkout seguro do Mercado Pago.`
    });
  } catch (err) {
    console.error('[zapcoins/comprar]', err);
    res.status(500).json({ erro: err.message || 'Erro ao criar checkout no Mercado Pago.' });
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

// POST /api/zapcoins/pedido/:id/mercadopago/processar
router.post('/pedido/:id/mercadopago/processar', requireLogin, async (req, res) => {
  try {
    if (!mercadoPagoConfigurado()) {
      return res.status(500).json({ erro: 'Mercado Pago ainda não configurado. Preencha MERCADOPAGO_PUBLIC_KEY e MERCADOPAGO_ACCESS_TOKEN no .env.' });
    }

    const pedidoId = parseInt(req.params.id, 10);
    const comprador = validarComprador(req.body || {});
    const formData = req.body.formData && typeof req.body.formData === 'object' ? req.body.formData : {};

    if (!pedidoId) return res.status(400).json({ erro: 'Pedido inválido.' });
    if (comprador.erro) return res.status(400).json({ erro: comprador.erro });
    if (!formData.payment_method_id) return res.status(400).json({ erro: 'Forma de pagamento não informada pelo Mercado Pago.' });

    const pedido = buscarPedidoDoUsuario(pedidoId, req.session.usuario.id);
    if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    if (pedido.status === 'pago' || pedido.credited_at) return res.status(400).json({ erro: 'Este pedido já foi pago.' });

    db.run(
      `UPDATE zapcoin_orders
       SET buyer_name = ?, buyer_email = ?, buyer_cpf = ?, payment_method = ?, gateway = 'mercadopago', atualizado_em = datetime('now')
       WHERE id = ?`,
      [comprador.nome, comprador.email, comprador.cpf, formData.payment_method_id, pedido.id]
    );

    const payload = montarPayloadPagamentoMercadoPago({ req, pedido, comprador, formData });
    const payment = await mercadoPagoRequest('/v1/payments', {
      method: 'POST',
      body: payload,
      idempotencyKey: crypto.createHash('sha256').update(`zapcoin:${pedido.id}:${pedido.preco_centavos}:${formData.payment_method_id}`).digest('hex')
    });

    const resultado = aplicarRetornoMercadoPagoNoPedido(pedido, payment);
    const pedidoAtualizado = db.queryOne('SELECT * FROM zapcoin_orders WHERE id = ?', [pedido.id]);

    return res.json({
      ok: resultado.ok,
      status: resultado.status,
      pedido: formatarPedido(pedidoAtualizado),
      payment_id: payment.id,
      pix_code: extrairPixCodePagamento(payment),
      pix_qr_code_base64: payment?.point_of_interaction?.transaction_data?.qr_code_base64 || null,
      mensagem: resultado.mensagem || 'Pagamento enviado ao Mercado Pago.'
    });
  } catch (err) {
    console.error('[zapcoins/mercadopago/processar]', err);
    res.status(500).json({ erro: err.message || 'Erro ao processar pagamento no Mercado Pago.' });
  }
});

// POST /api/zapcoins/pedido/:id/pagar
// Mantido por compatibilidade: o checkout novo usa redirecionamento para Checkout Pro.
router.post('/pedido/:id/pagar', requireLogin, async (req, res) => {
  return res.status(400).json({
    erro: 'Este checkout agora usa o Checkout Pro do Mercado Pago. Volte para Meus grupos e clique em comprar novamente.'
  });
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
      return res.status(400).json({ erro: 'Finalize o pagamento no Mercado Pago antes de verificar.' });
    }

    const data = await consultarPagamentoMercadoPago(pedido.gateway_payment_id);
    const resultado = aplicarRetornoMercadoPagoNoPedido(pedido, data);
    const atualizado = db.queryOne('SELECT * FROM zapcoin_orders WHERE id = ?', [pedido.id]);

    res.json({ ok: true, pedido: formatarPedido(atualizado), mensagem: resultado.mensagem || 'Status atualizado.' });
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
  statusPagoMercadoPago,
  validarValorGateway,
  creditarPedidoPago,
  atualizarPedidoGateway,
  formatarPedido,
  mercadoPagoConfigurado,
  consultarPagamentoMercadoPago,
  identificarPedidoPorPagamento,
  aplicarRetornoMercadoPagoNoPedido
};
