const nodemailer = require('nodemailer');

function criarTransporte() {
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT, 10) || 587,
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
const REMETENTE = process.env.EMAIL_FROM || 'ZapGrupos <noreply@zapgrupos.site>';
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';

function escaparHtml(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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
  const tituloSeguro = escaparHtml(titulo);

  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${tituloSeguro}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;max-width:600px;width:100%;box-shadow:0 8px 30px rgba(18,63,40,0.08);">
        <tr><td style="background:#123f28;padding:24px 32px;">
          <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">ZapGrupos</h1>
          <p style="margin:6px 0 0;color:#d9f8e5;font-size:14px;">Diretório independente de comunidades</p>
        </td></tr>
        <tr><td style="padding:32px;">
          ${conteudo}
        </td></tr>
        <tr><td style="background:#f9f9f9;padding:16px 32px;border-top:1px solid #e5e5e5;">
          <p style="margin:0;color:#777;font-size:12px;line-height:1.5;">
            Este e-mail foi enviado automaticamente pelo ZapGrupos. Não responda esta mensagem.<br>
            <a href="${SITE_URL}" style="color:#1a472a;font-weight:600;">Acessar ZapGrupos</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function emailGrupoAprovado(para, nomeGrupo, linkWhatsApp) {
  const nomeSeguro = escaparHtml(nomeGrupo || 'seu grupo');
  const linkSeguro = escaparHtml(linkWhatsApp || SITE_URL);

  const html = htmlBase('Seu grupo foi aprovado - ZapGrupos', `
    <h2 style="margin:0 0 16px;color:#1a472a;font-size:20px;">🎉 Seu grupo foi aprovado!</h2>
    <p style="color:#444;line-height:1.6;margin:0 0 10px;">O grupo <strong>${nomeSeguro}</strong> foi aprovado pela nossa equipe e já pode aparecer no diretório do ZapGrupos.</p>
    <p style="color:#444;line-height:1.6;margin:0;">Você pode acessar o site para conferir a publicação e acompanhar novos grupos adicionados.</p>
    <div style="margin:24px 0;">
      <a href="${SITE_URL}" style="background:#1a472a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">
        Ver no site
      </a>
    </div>
    <p style="color:#777;font-size:13px;line-height:1.5;margin:0;">Link enviado: <a href="${linkSeguro}" style="color:#1a472a;">${linkSeguro}</a></p>
  `);

  return enviarEmail(para, 'Seu grupo foi aprovado - ZapGrupos', html);
}

async function emailGrupoRejeitado(para, nomeGrupo, motivo) {
  const nomeSeguro = escaparHtml(nomeGrupo || 'seu grupo');
  const motivoSeguro = escaparHtml(motivo || 'O grupo não atende às diretrizes da plataforma.');

  const html = htmlBase('Seu grupo não foi aprovado - ZapGrupos', `
    <h2 style="margin:0 0 16px;color:#c0392b;font-size:20px;">Seu grupo não foi aprovado</h2>
    <p style="color:#444;line-height:1.6;margin:0 0 10px;">A análise do grupo <strong>${nomeSeguro}</strong> foi concluída, mas ele não foi aprovado neste momento.</p>
    <div style="background:#fff5f5;border-left:4px solid #c0392b;padding:12px 14px;margin:18px 0;border-radius:6px;">
      <strong style="color:#842029;">Motivo:</strong>
      <p style="margin:6px 0 0;color:#842029;line-height:1.5;">${motivoSeguro}</p>
    </div>
    <p style="color:#444;line-height:1.6;margin:0;">Você pode corrigir as informações e enviar o grupo novamente para uma nova análise.</p>
    <div style="margin:24px 0;">
      <a href="${SITE_URL}/pages/enviar-grupo.html" style="background:#1a472a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">
        Enviar novamente
      </a>
    </div>
  `);

  return enviarEmail(para, 'Seu grupo não foi aprovado - ZapGrupos', html);
}

async function emailBoasVindas(para, nome) {
  const nomeSeguro = escaparHtml(nome || '');

  const html = htmlBase('Bem-vindo ao ZapGrupos', `
    <h2 style="margin:0 0 16px;color:#1a472a;font-size:20px;">Bem-vindo, ${nomeSeguro}!</h2>
    <p style="color:#444;line-height:1.6;margin:0 0 10px;">Sua conta foi criada com sucesso no ZapGrupos.</p>
    <p style="color:#444;line-height:1.6;margin:0;">Agora você pode enviar comunidades para divulgação gratuita. Após o envio, nossa equipe fará a análise e você receberá uma resposta por e-mail.</p>
    <div style="margin:24px 0;">
      <a href="${SITE_URL}/pages/enviar-grupo.html" style="background:#1a472a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">
        Enviar meu primeiro grupo
      </a>
    </div>
  `);

  return enviarEmail(para, 'Bem-vindo ao ZapGrupos', html);
}

module.exports = {
  emailGrupoAprovado,
  emailGrupoRejeitado,
  emailBoasVindas
};