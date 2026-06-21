const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');
const zapcoins = require('./zapcoins');

function extrairAssinaturaMercadoPago(header) {
  const partes = String(header || '').split(',').map((p) => p.trim());
  const dados = {};

  for (const parte of partes) {
    const [chave, valor] = parte.split('=');
    if (chave && valor) dados[chave] = valor;
  }

  return dados;
}

function validarAssinaturaMercadoPago(req) {
  const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  if (!secret) return true;

  const signature = extrairAssinaturaMercadoPago(req.headers['x-signature']);
  const requestId = String(req.headers['x-request-id'] || '').trim();
  const dataId = String(req.body?.data?.id || req.query?.['data.id'] || req.query?.id || '').trim();

  if (!signature.ts || !signature.v1) return false;

  let manifest = '';
  if (dataId) manifest += `id:${dataId};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${signature.ts};`;

  const hmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature.v1));
  } catch {
    return false;
  }
}

router.post('/mercadopago', async (req, res) => {
  try {
    if (!validarAssinaturaMercadoPago(req)) {
      return res.status(401).json({ erro: 'Webhook Mercado Pago não autorizado.' });
    }

    const tipo = String(req.body?.type || req.body?.topic || req.query?.type || req.query?.topic || '').toLowerCase();
    const paymentId = String(req.body?.data?.id || req.query?.['data.id'] || req.query?.id || '').trim();

    if (!paymentId) {
      return res.json({ ok: true, ignorado: 'sem_payment_id' });
    }

    if (tipo && !['payment', 'payments'].includes(tipo)) {
      return res.json({ ok: true, ignorado: `tipo_${tipo}` });
    }

    const pagamento = await zapcoins._internals.consultarPagamentoMercadoPago(paymentId);
    const pedido = zapcoins._internals.identificarPedidoPorPagamento(pagamento);

    if (!pedido) {
      return res.json({ ok: true, ignorado: 'pedido_nao_encontrado' });
    }

    const resultado = zapcoins._internals.aplicarRetornoMercadoPagoNoPedido(pedido, pagamento);
    return res.json({ ok: true, status: resultado.status || 'atualizado' });
  } catch (err) {
    console.error('[webhook/mercadopago]', err);
    return res.status(500).json({ erro: 'Erro no webhook Mercado Pago.' });
  }
});

// Mantido temporariamente para não quebrar chamadas antigas enquanto a migração acontece.
router.post('/syncpay', (req, res) => {
  return res.json({ ok: true, ignorado: 'syncpay_desativado' });
});

module.exports = router;
