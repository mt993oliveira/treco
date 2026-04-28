/**
 * Serviço de Alertas — Telegram + E-mail
 * Chamado quando o coletor para de funcionar ou se recupera.
 */

const nodemailer = require('nodemailer');
const https = require('https');

async function _sendTelegram(token, chatIds, msg) {
    const ids = String(chatIds).split(',').map(s => s.trim()).filter(Boolean);
    for (const chatId of ids) {
        await new Promise(resolve => {
            const body = JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' });
            const req = https.request({
                hostname: 'api.telegram.org',
                path: `/bot${token}/sendMessage`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }, res => { res.resume(); resolve(); });
            req.on('error', () => resolve());
            req.write(body);
            req.end();
        });
    }
}

async function _sendEmail(recipients, assunto, html) {
    const pass = process.env.SMTP_PASS;
    const user = process.env.SMTP_USER;
    if (!user || !pass || pass === 'coloque_aqui_sua_senha_de_app') return;

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass }
    });

    await transporter.sendMail({
        from: `"Radardabet" <${user}>`,
        to: recipients.join(','),
        subject: assunto,
        html
    });
}

/**
 * Dispara alerta para Telegram (cfg) e e-mail (todos os masters do banco).
 * @param {object} cfg  - configurações do sistema (getSystemConfig)
 * @param {object} pool - pool SQL (pode ser null — sem e-mail nesse caso)
 * @param {string} titulo
 * @param {string} mensagem
 */
async function dispararAlerta(cfg, pool, titulo, mensagem) {
    if (!cfg || cfg.alerta_ativado === 'false') return;

    const token   = (cfg.telegram_bot_token  || '').trim();
    const chatIds = (cfg.telegram_chat_ids   || '').trim();

    const promises = [];

    // ── Telegram ──────────────────────────────────────────────
    if (token && chatIds) {
        const tgMsg = `<b>🤖 Radardabet</b>\n<b>${titulo}</b>\n\n${mensagem}`;
        promises.push(
            _sendTelegram(token, chatIds, tgMsg)
                .catch(e => console.error('[Alerta Telegram]', e.message))
        );
    }

    // ── E-mail para todos os masters ──────────────────────────
    if (pool) {
        try {
            const r = await pool.request().query(`
                SELECT Email FROM Usuarios
                WHERE TipoUsuario = 'master' AND Ativo = 1
                  AND Email IS NOT NULL AND Email <> ''
            `);
            const emails = r.recordset.map(x => x.Email).filter(Boolean);
            if (emails.length) {
                const htmlBody = `
                    <div style="font-family:sans-serif;max-width:500px">
                        <h2 style="color:#1fcc59;margin-bottom:8px">${titulo}</h2>
                        <p style="color:#334155;white-space:pre-line">${mensagem}</p>
                        <hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0">
                        <p style="font-size:11px;color:#94a3b8">Radardabet — Sistema de Monitoramento</p>
                    </div>`;
                promises.push(
                    _sendEmail(emails, `Radardabet — ${titulo}`, htmlBody)
                        .catch(e => console.error('[Alerta Email]', e.message))
                );
            }
        } catch(e) {
            console.error('[Alerta] Erro ao buscar masters:', e.message);
        }
    }

    if (promises.length) await Promise.all(promises);
}

module.exports = { dispararAlerta };
