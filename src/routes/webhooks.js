const express = require('express');
const router = express.Router();
const db = require('../db');
const zapcoins = require('./zapcoins');

function tokenAutorizado(req) {
  const esperado = process.env.SYNCPAY_WEBHOOK_TOKEN;
  if (!esperado) return true;

  const header = String(req.headers.authorization || '');
  const token = header.replace(/^Bearer\s+/i, '').trim();
  return token && token === esperado;
}

function decimalParaCentavos(valor) {
  return Math.round(Number(valor || 0) * 100);
}

function statusPago(status) {
  return ['completed', 'paid', 'approved', 'captured'].includes(String(status || '').toLowerCase());
}

function validarValor(pedido, data) {
  if (!data || data.amount == null) return true;
  const amountCentavos = decimalParaCentavos(data.amount);
  return amountCentavos === Number(pedido.preco_centavos || 0);
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

function registrarMovimento({ userId, tipo, quantidade, saldoAntes, saldoDepois, referenciaTipo = null, referenciaId = null, descricao = null }) {
  db.run(
    `INSERT INTO wallet_transactions
      (user_id, tipo, quantidade, saldo_antes, saldo_depois, referencia_tipo, referencia_id, descricao)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, tipo, quantidade, saldoAntes, saldoDepois, referenciaTipo, referenciaId, descricao]
  );
}

function creditarPedidoPago(pedido, origem = 'Sync Pay') {
  const atual = db.queryOne('SELECT * FROM zapcoin_orders WHERE id = ?', [pedido.id]);
  if (!atual) return { ok: false };

  if (atual.credited_at || atual.status === 'pago') {
    return { ok: true, ja_creditado: true };
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

router.post('/syncpay', (req, res) => {
  try {
    if (!tokenAutorizado(req)) {
      return res.status(401).json({ erro: 'Webhook não autorizado.' });
    }

    const evento = String(req.headers.event || req.body.event || '').toLowerCase();
    const data = req.body.data || req.body;
    const identifier = data.id || data.identifier || data.reference_id || req.body.identifier;

    if (!identifier) {
      return res.json({ ok: true, ignorado: 'sem_identifier' });
    }

    const pedido = db.queryOne('SELECT * FROM zapcoin_orders WHERE gateway_payment_id = ?', [identifier]);
    if (!pedido) {
      return res.json({ ok: true, ignorado: 'pedido_nao_encontrado' });
    }

    if (!validarValor(pedido, data)) {
      atualizarPedidoGateway({
        pedidoId: pedido.id,
        status: 'valor_divergente',
        gatewayStatus: data.status || evento,
        gatewayPayload: req.body,
        pixCode: data.pix_code || null,
        gatewayPaymentId: identifier
      });
      return res.json({ ok: true, status: 'valor_divergente' });
    }

    if (statusPago(data.status)) {
      atualizarPedidoGateway({
        pedidoId: pedido.id,
        status: 'aguardando_credito',
        gatewayStatus: data.status,
        gatewayPayload: req.body,
        pixCode: data.pix_code || null,
        gatewayPaymentId: identifier
      });
      creditarPedidoPago(pedido, 'Sync Pay');
      return res.json({ ok: true, status: 'creditado' });
    }

    atualizarPedidoGateway({
      pedidoId: pedido.id,
      status: 'aguardando_pagamento',
      gatewayStatus: data.status || evento || 'pending',
      gatewayPayload: req.body,
      pixCode: data.pix_code || null,
      gatewayPaymentId: identifier
    });

    return res.json({ ok: true, status: 'atualizado' });
  } catch (err) {
    console.error('[webhook/syncpay]', err);
    return res.status(500).json({ erro: 'Erro no webhook.' });
  }
});

module.exports = router;
