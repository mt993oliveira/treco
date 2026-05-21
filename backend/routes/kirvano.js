const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const sql     = require('mssql');
const { getDbPool } = require('./bet365-api');

const KIRVANO_TOKEN  = 'radarbet_kirvano_2026_xK9mP3qL';
const PLANO_DIAS     = 30;
const PLANO_NOME     = 'Mensal';
const PLANO_VALOR    = 19.90;

// ── Cria tabelas se não existirem ───────────────────────────────
async function _ensureTable(pool) {
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='kirvano_assinaturas' AND xtype='U')
        CREATE TABLE kirvano_assinaturas (
            id                    INT IDENTITY(1,1) PRIMARY KEY,
            kirvano_purchase_id   NVARCHAR(150),
            kirvano_subscription_id NVARCHAR(150),
            email_cliente         NVARCHAR(255),
            nome_cliente          NVARCHAR(255),
            usuario_id            INT,
            usuario_login         NVARCHAR(100),
            plano                 NVARCHAR(100),
            valor                 DECIMAL(10,2),
            evento                NVARCHAR(100),
            status                NVARCHAR(50),
            data_criacao          DATETIME2 DEFAULT GETUTCDATE(),
            data_expiracao        DATETIME2,
            payload_raw           NVARCHAR(MAX)
        )
    `);
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='kirvano_credenciais_temp' AND xtype='U')
        CREATE TABLE kirvano_credenciais_temp (
            usuario_id   INT PRIMARY KEY,
            senha_plain  NVARCHAR(50),
            criado_em    DATETIME2 DEFAULT GETUTCDATE()
        )
    `);
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='kirvano_webhook_log' AND xtype='U')
        CREATE TABLE kirvano_webhook_log (
            id           INT IDENTITY(1,1) PRIMARY KEY,
            recebido_em  DATETIME2 DEFAULT GETUTCDATE(),
            evento       NVARCHAR(200),
            email        NVARCHAR(255),
            action       NVARCHAR(50),
            payload_raw  NVARCHAR(MAX)
        )
    `);
}

// ── Gera senha aleatória ─────────────────────────────────────────
function _gerarSenha(len = 8) {
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}

// ── Gera login único baseado no email ────────────────────────────
async function _gerarLogin(pool, email) {
    const base = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 12) || 'user';
    const check = async (u) => {
        const r = await pool.request().input('u', sql.VarChar, u)
            .query(`SELECT 1 FROM Usuarios WHERE Usuario = @u`);
        return r.recordset.length > 0;
    };
    if (!(await check(base))) return base;
    for (let i = 1; i <= 99; i++) {
        const candidate = base + i;
        if (!(await check(candidate))) return candidate;
    }
    return base + Date.now().toString().slice(-4);
}

// ── Cria usuário no banco ────────────────────────────────────────
async function _criarUsuario(pool, { nome, email, login, senha, dataExpiracao }) {
    const hash = await bcrypt.hash(senha, 10);
    const r = await pool.request()
        .input('nome',    sql.NVarChar, nome)
        .input('login',   sql.NVarChar, login)
        .input('email',   sql.NVarChar, email)
        .input('hash',    sql.NVarChar, hash)
        .input('expira',  sql.DateTime2, dataExpiracao)
        .query(`
            INSERT INTO Usuarios (NomeCompleto, Usuario, Email, Senha, TipoUsuario, Ativo, DataInicioLicenca, DataFimLicenca)
            OUTPUT INSERTED.Id
            VALUES (@nome, @login, @email, @hash, 'user', 1, GETUTCDATE(), @expira)
        `);
    return r.recordset[0]?.Id;
}

// ── Salva log de webhook (sem travar o fluxo principal) ─────────
async function _logWebhook(pool, { evento, email, action, payload }) {
    try {
        await pool.request()
            .input('evento',  sql.NVarChar, String(evento || '').slice(0, 200))
            .input('email',   sql.NVarChar, String(email  || '').slice(0, 255))
            .input('action',  sql.NVarChar, String(action || '').slice(0, 50))
            .input('raw',     sql.NVarChar, JSON.stringify(payload).slice(0, 4000))
            .query(`INSERT INTO kirvano_webhook_log (evento, email, action, payload_raw)
                    VALUES (@evento, @email, @action, @raw)`);
    } catch (_) { /* log não pode travar o fluxo */ }
}

// ── Webhook Kirvano ──────────────────────────────────────────────
router.post('/webhook', async (req, res) => {
    const payload = req.body;
    const evento  = payload?.event || payload?.tipo || payload?.type || '';
    console.log('[Kirvano] Webhook recebido. Evento:', evento);
    console.log('[Kirvano] Body keys:', JSON.stringify(Object.keys(payload || {})));
    console.log('[Kirvano] Payload (300 chars):', JSON.stringify(payload).slice(0, 300));

    const data     = payload?.data || payload;
    const customer = data?.customer || data?.comprador || data?.buyer || {};
    const emailCliente = (customer?.email || customer?.email_address || '').toLowerCase();

    let pool;
    try { pool = await getDbPool(); await _ensureTable(pool); } catch (_) {}

    // Apenas processa compra aprovada ou assinatura ativa
    const isAprovado = ['purchase.approved', 'subscription.active',
                        'PURCHASE_APPROVED', 'SUBSCRIPTION_ACTIVE'].includes(evento);
    if (!isAprovado) {
        if (pool) await _logWebhook(pool, { evento, email: emailCliente, action: 'ignored', payload });
        return res.json({ received: true, action: 'ignored', evento });
    }

    // Extrai dados do cliente — tenta várias estruturas de payload da Kirvano
    const purchase = data?.purchase || data?.compra || {};
    const sub      = data?.subscription || data?.assinatura || {};

    const nomeCliente = customer?.name  || customer?.nome  || 'Cliente';
    const purchaseId  = purchase?.id || payload?.purchase_id || payload?.id || '';
    const subId       = sub?.id || payload?.subscription_id || '';

    if (!emailCliente) {
        console.warn('[Kirvano] Email não encontrado no payload');
        if (pool) await _logWebhook(pool, { evento, email: '', action: 'erro_sem_email', payload });
        return res.status(400).json({ error: 'Email do cliente não encontrado' });
    }

    try {
        if (!pool) throw new Error('Sem conexão com banco');

        // Evita duplicidade: verifica se já existe assinatura para este purchase_id
        if (purchaseId) {
            const dup = await pool.request()
                .input('pid', sql.NVarChar, purchaseId)
                .query(`SELECT 1 FROM kirvano_assinaturas WHERE kirvano_purchase_id = @pid`);
            if (dup.recordset.length > 0) {
                console.log('[Kirvano] Purchase já processado:', purchaseId);
                return res.json({ received: true, action: 'duplicate' });
            }
        }

        // Verifica se email já tem conta ativa
        const existente = await pool.request()
            .input('email', sql.NVarChar, emailCliente)
            .query(`SELECT Id, DataFimLicenca FROM Usuarios WHERE Email = @email AND Ativo = 1`);

        const dataExpiracao = new Date(Date.now() + PLANO_DIAS * 86400000);
        let usuarioId, usuarioLogin;

        if (existente.recordset.length > 0) {
            // Renova licença do usuário existente
            usuarioId    = existente.recordset[0].Id;
            const result = await pool.request()
                .input('id',     sql.Int,       usuarioId)
                .input('expira', sql.DateTime2, dataExpiracao)
                .query(`UPDATE Usuarios SET DataFimLicenca = @expira WHERE Id = @id`);
            const uRow = await pool.request()
                .input('id', sql.Int, usuarioId)
                .query(`SELECT Usuario FROM Usuarios WHERE Id = @id`);
            usuarioLogin = uRow.recordset[0]?.Usuario || '';
            console.log(`[Kirvano] Licença renovada: ${emailCliente} até ${dataExpiracao.toISOString()}`);
        } else {
            // Cria novo usuário
            usuarioLogin = await _gerarLogin(pool, emailCliente);
            const senha  = _gerarSenha();
            usuarioId    = await _criarUsuario(pool, {
                nome: nomeCliente, email: emailCliente,
                login: usuarioLogin, senha, dataExpiracao
            });
            // Guarda senha em texto por 24h para exibir na tela de boas-vindas
            await pool.request()
                .input('id',    sql.Int,      usuarioId)
                .input('senha', sql.NVarChar, senha)
                .query(`
                    MERGE kirvano_credenciais_temp AS t
                    USING (SELECT @id AS id, @senha AS s) AS src ON t.usuario_id = src.id
                    WHEN MATCHED     THEN UPDATE SET senha_plain = src.s, criado_em = GETUTCDATE()
                    WHEN NOT MATCHED THEN INSERT (usuario_id, senha_plain) VALUES (src.id, src.s);
                `);
            console.log(`[Kirvano] Usuário criado: ${usuarioLogin} / ${emailCliente}`);
        }

        // Registra assinatura
        await pool.request()
            .input('pid',    sql.NVarChar,   purchaseId)
            .input('sid',    sql.NVarChar,   subId)
            .input('email',  sql.NVarChar,   emailCliente)
            .input('nome',   sql.NVarChar,   nomeCliente)
            .input('uid',    sql.Int,         usuarioId)
            .input('login',  sql.NVarChar,   usuarioLogin)
            .input('plano',  sql.NVarChar,   PLANO_NOME)
            .input('valor',  sql.Decimal,    PLANO_VALOR)
            .input('evento', sql.NVarChar,   evento)
            .input('status', sql.NVarChar,   'ativo')
            .input('expira', sql.DateTime2,  dataExpiracao)
            .input('raw',    sql.NVarChar,   JSON.stringify(payload))
            .query(`
                INSERT INTO kirvano_assinaturas
                (kirvano_purchase_id, kirvano_subscription_id, email_cliente, nome_cliente,
                 usuario_id, usuario_login, plano, valor, evento, status, data_expiracao, payload_raw)
                VALUES (@pid, @sid, @email, @nome, @uid, @login, @plano, @valor, @evento, @status, @expira, @raw)
            `);

        const action = existente.recordset.length > 0 ? 'renovado' : 'criado';
        await _logWebhook(pool, { evento, email: emailCliente, action, payload });
        res.json({ received: true, action, usuario: usuarioLogin });

    } catch (e) {
        console.error('[Kirvano] Erro no webhook:', e.message);
        if (pool) await _logWebhook(pool, { evento, email: emailCliente, action: 'erro', payload });
        res.status(500).json({ error: e.message });
    }
});

// ── Endpoint: busca credenciais pelo email ───────────────────────
router.get('/credenciais', async (req, res) => {
    const email = (req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ success: false, error: 'Email obrigatório' });

    try {
        const pool = await getDbPool();
        await _ensureTable(pool);

        const r = await pool.request()
            .input('email', sql.NVarChar, email)
            .query(`
                SELECT u.Usuario, u.NomeCompleto, u.DataFimLicenca, u.DataInicioLicenca, ct.senha_plain
                FROM Usuarios u
                LEFT JOIN kirvano_credenciais_temp ct ON ct.usuario_id = u.Id
                WHERE LOWER(u.Email) = @email AND u.Ativo = 1
            `);

        if (!r.recordset.length) {
            return res.json({ success: false, error: 'Email não encontrado. Verifique se o email informado é o mesmo usado na compra.' });
        }

        const u = r.recordset[0];
        res.json({
            success:   true,
            usuario:   u.Usuario,
            nome:      u.NomeCompleto,
            expira_em: u.DataFimLicenca,
            senha:     u.senha_plain || '(senha não disponível — entre em contato)'
        });

    } catch (e) {
        console.error('[Kirvano] Erro credenciais:', e.message);
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// ── Endpoint: últimos webhooks recebidos (diagnóstico) ───────────
router.get('/webhook-log', async (req, res) => {
    try {
        const pool = await getDbPool();
        await _ensureTable(pool);
        const limit = Math.min(parseInt(req.query.limit || '50'), 200);
        const r = await pool.request()
            .input('limit', sql.Int, limit)
            .query(`SELECT TOP (@limit) id, recebido_em, evento, email, action,
                        LEFT(payload_raw, 500) AS payload_preview
                    FROM kirvano_webhook_log
                    ORDER BY recebido_em DESC`);
        res.json({ success: true, total: r.recordset.length, logs: r.recordset });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/kirvano/admin/assinaturas
router.post('/admin/assinaturas', async (req, res) => {
    try {
        const pool = await getDbPool();
        const { usuarioId, email = '', status = '', pagina = 1, porPagina = 50 } = req.body;
        if (!usuarioId) return res.json({ success: false, message: 'Não autenticado' });
        const auth = await pool.request().input('id', sql.Int, Number(usuarioId))
            .query(`SELECT TipoUsuario FROM Usuarios WHERE Id = @id`);
        if (!auth.recordset.length || auth.recordset[0].TipoUsuario !== 'master')
            return res.json({ success: false, message: 'Acesso negado' });
        await _ensureTable(pool);
        const pp  = Math.min(200, Math.max(1, Number(porPagina)));
        const off = (Math.max(1, Number(pagina)) - 1) * pp;
        const wheres = [];
        const cntReq  = pool.request();
        const mainReq = pool.request();
        if (email) {
            wheres.push('(email_cliente LIKE @email OR usuario_login LIKE @email OR nome_cliente LIKE @email)');
            cntReq.input('email',  sql.NVarChar, `%${email}%`);
            mainReq.input('email', sql.NVarChar, `%${email}%`);
        }
        if (status) {
            wheres.push('status = @status');
            cntReq.input('status',  sql.NVarChar, status);
            mainReq.input('status', sql.NVarChar, status);
        }
        const w = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
        const cntResult = await cntReq.query(`SELECT COUNT(*) AS total FROM kirvano_assinaturas ${w}`);
        const total = cntResult.recordset[0].total;
        mainReq.input('off', sql.Int, off);
        mainReq.input('pp',  sql.Int, pp);
        const rows = await mainReq.query(`
            SELECT id, kirvano_purchase_id, kirvano_subscription_id, email_cliente, nome_cliente,
                   usuario_id, usuario_login, plano, valor, evento, status, data_criacao, data_expiracao
            FROM kirvano_assinaturas ${w}
            ORDER BY data_criacao DESC
            OFFSET @off ROWS FETCH NEXT @pp ROWS ONLY
        `);
        res.json({ success: true, total, pagina: Number(pagina), porPagina: pp, data: rows.recordset });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// POST /api/kirvano/admin/webhooks
router.post('/admin/webhooks', async (req, res) => {
    try {
        const pool = await getDbPool();
        const { usuarioId, email = '', evento = '', pagina = 1, porPagina = 50 } = req.body;
        if (!usuarioId) return res.json({ success: false, message: 'Não autenticado' });
        const auth = await pool.request().input('id', sql.Int, Number(usuarioId))
            .query(`SELECT TipoUsuario FROM Usuarios WHERE Id = @id`);
        if (!auth.recordset.length || auth.recordset[0].TipoUsuario !== 'master')
            return res.json({ success: false, message: 'Acesso negado' });
        await _ensureTable(pool);
        const pp  = Math.min(200, Math.max(1, Number(porPagina)));
        const off = (Math.max(1, Number(pagina)) - 1) * pp;
        const wheres = [];
        const cntReq  = pool.request();
        const mainReq = pool.request();
        if (email) {
            wheres.push('email LIKE @email');
            cntReq.input('email',  sql.NVarChar, `%${email}%`);
            mainReq.input('email', sql.NVarChar, `%${email}%`);
        }
        if (evento) {
            wheres.push('evento LIKE @evento');
            cntReq.input('evento',  sql.NVarChar, `%${evento}%`);
            mainReq.input('evento', sql.NVarChar, `%${evento}%`);
        }
        const w = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
        const cntResult = await cntReq.query(`SELECT COUNT(*) AS total FROM kirvano_webhook_log ${w}`);
        const total = cntResult.recordset[0].total;
        mainReq.input('off', sql.Int, off);
        mainReq.input('pp',  sql.Int, pp);
        const rows = await mainReq.query(`
            SELECT id, recebido_em, evento, email, action, payload_raw
            FROM kirvano_webhook_log ${w}
            ORDER BY recebido_em DESC
            OFFSET @off ROWS FETCH NEXT @pp ROWS ONLY
        `);
        res.json({ success: true, total, pagina: Number(pagina), porPagina: pp, data: rows.recordset });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

module.exports = router;
