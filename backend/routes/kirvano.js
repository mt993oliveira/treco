const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const sql     = require('mssql');
const { getDbPool } = require('./bet365-api');

const KIRVANO_TOKEN  = 'radarbet_kirvano_2026_xK9mP3qL';
const PLANO_DIAS     = 30;
const PLANO_NOME     = 'Mensal';
const PLANO_VALOR    = 19.90;

// ── Cria tabela se não existir ───────────────────────────────────
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

// ── Webhook Kirvano ──────────────────────────────────────────────
router.post('/webhook', async (req, res) => {
    // Validar token (Kirvano envia no header Authorization: Bearer TOKEN ou campo token no body)
    const authHeader = req.headers['authorization'] || '';
    const tokenHeader = authHeader.replace('Bearer ', '').trim();
    const tokenBody   = req.body?.token || '';
    if (tokenHeader !== KIRVANO_TOKEN && tokenBody !== KIRVANO_TOKEN) {
        console.warn('[Kirvano] Token inválido:', tokenHeader || tokenBody);
        return res.status(401).json({ error: 'Token inválido' });
    }

    const payload = req.body;
    const evento  = payload?.event || payload?.tipo || '';
    console.log('[Kirvano] Evento recebido:', evento, JSON.stringify(payload).slice(0, 300));

    // Apenas processa compra aprovada ou assinatura ativa
    const isAprovado = ['purchase.approved', 'subscription.active',
                        'PURCHASE_APPROVED', 'SUBSCRIPTION_ACTIVE'].includes(evento);
    if (!isAprovado) {
        return res.json({ received: true, action: 'ignored', evento });
    }

    // Extrai dados do cliente — tenta várias estruturas de payload da Kirvano
    const data     = payload?.data || payload;
    const customer = data?.customer || data?.comprador || data?.buyer || {};
    const purchase = data?.purchase || data?.compra || {};
    const sub      = data?.subscription || data?.assinatura || {};

    const nomeCliente  = customer?.name  || customer?.nome  || 'Cliente';
    const emailCliente = customer?.email || customer?.email_address || '';
    const purchaseId   = purchase?.id || payload?.purchase_id || payload?.id || '';
    const subId        = sub?.id || payload?.subscription_id || '';

    if (!emailCliente) {
        console.warn('[Kirvano] Email não encontrado no payload');
        return res.status(400).json({ error: 'Email do cliente não encontrado' });
    }

    try {
        const pool = await getDbPool();
        await _ensureTable(pool);

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
                    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='kirvano_credenciais_temp' AND xtype='U')
                    CREATE TABLE kirvano_credenciais_temp (
                        usuario_id   INT PRIMARY KEY,
                        senha_plain  NVARCHAR(50),
                        criado_em    DATETIME2 DEFAULT GETUTCDATE()
                    );
                    MERGE kirvano_credenciais_temp AS t
                    USING (SELECT @id AS id, @senha AS s) AS src ON t.usuario_id = src.id
                    WHEN MATCHED    THEN UPDATE SET senha_plain = src.s, criado_em = GETUTCDATE()
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

        res.json({ received: true, action: 'created', usuario: usuarioLogin });

    } catch (e) {
        console.error('[Kirvano] Erro no webhook:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Endpoint: busca credenciais pelo email (primeiras 24h) ───────
router.get('/credenciais', async (req, res) => {
    const email = (req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ success: false, error: 'Email obrigatório' });

    try {
        const pool = await getDbPool();
        await _ensureTable(pool);

        const r = await pool.request()
            .input('email', sql.NVarChar, email)
            .query(`
                SELECT u.Usuario, u.NomeCompleto, u.DataFimLicenca, ct.senha_plain
                FROM Usuarios u
                LEFT JOIN kirvano_credenciais_temp ct ON ct.usuario_id = u.Id
                WHERE LOWER(u.Email) = @email AND u.Ativo = 1
                  AND u.DataInicioLicenca >= DATEADD(hour, -24, GETUTCDATE())
            `);

        if (!r.recordset.length) {
            return res.json({ success: false, error: 'Nenhuma conta nova encontrada para este email. Se sua compra foi aprovada, aguarde alguns segundos e tente novamente.' });
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

module.exports = router;
