const nodemailer = require('nodemailer');

function criarTransporte() {
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
  }

  console.warn('[email] SMTP não configurado - emails serão logados no console');
  return null;
}

const transporte = criarTransporte();
const REMETENTE = process.env.EMAIL_FROM || 'LinkHub <noreply@linkhub.com.br>';
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';

async function enviarEmail(para, assunto, html) {
  if (!transporte) {
    console.log(`\n[EMAIL SIMULADO]\nPara: ${para}\nAssunto: ${assunto}\nConteúdo: ${html.slice(0, 200)}...\n`);
    return true;
  }

  try {
    await transporte.sendMail({
      from: REMETENTE,
      to: para,
      subject: assunto,
      html
    });
    return true;
  } catch (err) {
    console.error('[email] Erro ao enviar:', err.message);
    return false;
  }
}

function htmlBase(titulo, conteudo) {
  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${titulo}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="background:#1a472a;padding:24px 32px;">
          <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:600;">LinkHub</h1>
          <p style="margin:4px 0 0;color:#a7c4b5;font-size:14px;">Diretório de Grupos WhatsApp</p>
        </td></tr>
        <tr><td style="padding:32px;">
          ${conteudo}
        </td></tr>
        <tr><td style="background:#f9f9f9;padding:16px 32px;border-top:1px solid #e5e5e5;">
          <p style="margin:0;color:#999;font-size:12px;">
            Este email foi enviado automaticamente. Não responda esta mensagem.<br>
            <a href="${SITE_URL}" style="color:#1a472a;">Acessar LinkHub</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function emailGrupoAprovado(para, nomeGrupo, linkWhatsApp) {
  const html = htmlBase('Seu grupo foi aprovado!', `
    <h2 style="margin:0 0 16px;color:#1a472a;font-size:20px;">🎉 Grupo aprovado!</h2>
    <p style="color:#444;line-height:1.6;">Boa notícia! Seu grupo <strong>${nomeGrupo}</strong> foi aprovado e já está visível no LinkHub.</p>
    <p style="color:#444;line-height:1.6;">Link do grupo: <a href="${linkWhatsApp}" style="color:#1a472a;">${linkWhatsApp}</a></p>
    <div style="margin:24px 0;">
      <a href="${SITE_URL}" style="background:#1a472a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">
        Ver no site
      </a>
    </div>
    <p style="color:#888;font-size:14px;">Compartilhe o LinkHub com seus amigos para mais visibilidade!</p>
  `);
  return enviarEmail(para, `✅ Grupo "${nomeGrupo}" aprovado no LinkHub`, html);
}

async function emailGrupoRejeitado(para, nomeGrupo, motivo) {
  const html = htmlBase('Atualização sobre seu grupo', `
    <h2 style="margin:0 0 16px;color:#c0392b;font-size:20px;">Grupo não aprovado</h2>
    <p style="color:#444;line-height:1.6;">Infelizmente o grupo <strong>${nomeGrupo}</strong> não foi aprovado por nossa equipe de moderação.</p>
    <div style="background:#fff5f5;border-left:4px solid #c0392b;padding:16px;border-radius:4px;margin:16px 0;">
      <p style="margin:0;color:#666;font-size:14px;font-weight:600;">Motivo:</p>
      <p style="margin:8px 0 0;color:#444;">${motivo}</p>
    </div>
    <p style="color:#444;line-height:1.6;">Você pode corrigir os problemas indicados e submeter novamente seu grupo.</p>
    <div style="margin:24px 0;">
      <a href="${SITE_URL}/pages/enviar-grupo.html" style="background:#1a472a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">
        Enviar novamente
      </a>
    </div>
  `);
  return enviarEmail(para, `ℹ️ Atualização sobre o grupo "${nomeGrupo}"`, html);
}

async function emailBoasVindas(para, nome) {
  const html = htmlBase('Bem-vindo ao LinkHub!', `
    <h2 style="margin:0 0 16px;color:#1a472a;font-size:20px;">Bem-vindo, ${nome}!</h2>
    <p style="color:#444;line-height:1.6;">Sua conta foi criada com sucesso. Agora você pode submeter seus grupos de WhatsApp para divulgação gratuita.</p>
    <p style="color:#444;line-height:1.6;">Após submeter um grupo, nossa equipe fará a análise e você receberá uma resposta por email.</p>
    <div style="margin:24px 0;">
      <a href="${SITE_URL}/pages/enviar-grupo.html" style="background:#1a472a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">
        Enviar meu primeiro grupo
      </a>
    </div>
  `);
  return enviarEmail(para, 'Bem-vindo ao LinkHub!', html);
}

module.exports = {
  emailGrupoAprovado,
  emailGrupoRejeitado,
  emailBoasVindas
};
