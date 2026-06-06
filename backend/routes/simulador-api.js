'use strict';
const express = require('express');
const router  = express.Router();
const sql     = require('mssql');

// ── helpers ───────────────────────────────────────────────────────────────────

async function _getPool() {
    const { getDbPool } = require('./bet365-api');
    return getDbPool();
}

async function _getCfg(pool, chave, fallback) {
    try {
        const r = await pool.request()
            .input('c', sql.VarChar, chave)
            .query('SELECT valor FROM bet365_config WHERE chave = @c');
        return r.recordset[0]?.valor ?? fallback;
    } catch (_) { return fallback; }
}

async function _ensureTable(pool) {
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='simulador_apostas' AND xtype='U')
        CREATE TABLE simulador_apostas (
            id             INT            PRIMARY KEY IDENTITY,
            usuario_id     INT            NOT NULL,
            time_casa      VARCHAR(120)   NOT NULL,
            time_fora      VARCHAR(120)   NOT NULL,
            liga           VARCHAR(120)   NOT NULL DEFAULT '',
            data_jogo      DATETIME       NOT NULL,
            mercado        VARCHAR(60)    NOT NULL,
            odd            DECIMAL(7,2)   NOT NULL,
            creditos       DECIMAL(10,2)  NOT NULL,
            resultado      VARCHAR(20)    NOT NULL DEFAULT 'pendente',
            lucro          DECIMAL(10,2)  NOT NULL DEFAULT 0,
            data_aposta    DATETIME       NOT NULL DEFAULT GETUTCDATE(),
            data_resultado DATETIME       NULL
        )
    `);
}

// Resolve market ID against FT/HT goals → true/false/null (null = mercado desconhecido)
function _resolveMarket(mercado, gCasa, gFora, gCasaHT, gForaHT) {
    const t   = gCasa + gFora;
    const tHT = (gCasaHT ?? 0) + (gForaHT ?? 0);
    const cHT = gCasaHT ?? 0;
    const fHT = gForaHT ?? 0;
    switch (mercado) {
        case 'casa':         return gCasa  > gFora;
        case 'empate':       return gCasa === gFora;
        case 'fora':         return gFora  > gCasa;
        case 'over0.5':      return t  > 0.5;
        case 'over1.5':      return t  > 1.5;
        case 'over2.5':      return t  > 2.5;
        case 'over3.5':      return t  > 3.5;
        case 'over4.5':      return t  > 4.5;
        case 'under0.5':     return t  < 0.5;
        case 'under1.5':     return t  < 1.5;
        case 'under2.5':     return t  < 2.5;
        case 'under3.5':     return t  < 3.5;
        case 'under4.5':     return t  < 4.5;
        case 'ambas-sim':    return gCasa > 0 && gFora > 0;
        case 'ambas-nao':    return !(gCasa > 0 && gFora > 0);
        case 'over0.5-1t':   return tHT > 0.5;
        case 'over1.5-1t':   return tHT > 1.5;
        case 'under0.5-1t':  return tHT < 0.5;
        case 'under1.5-1t':  return tHT < 1.5;
        case 'casa-ht':      return cHT  > fHT;
        case 'empate-ht':    return cHT === fHT;
        case 'fora-ht':      return fHT  > cHT;
        default:             return null;
    }
}

// Auto-resolve pending bets by matching against bet365_eventos results
// If usuarioIdFiltro is null, resolves for ALL users (admin use case)
async function _resolverPendentes(pool, usuarioIdFiltro = null) {
    const filtro = usuarioIdFiltro
        ? `AND a.usuario_id = ${Number(usuarioIdFiltro)}`
        : '';

    const pendentes = await pool.request().query(`
        SELECT id, usuario_id, time_casa, time_fora, liga, data_jogo, mercado, creditos, odd
        FROM simulador_apostas
        WHERE resultado = 'pendente' ${filtro}
    `);

    let resolved = 0;
    for (const bet of pendentes.recordset) {
        const r = await pool.request()
            .input('tc', sql.VarChar, bet.time_casa)
            .input('tf', sql.VarChar, bet.time_fora)
            .input('dj', sql.DateTime, new Date(bet.data_jogo))
            .query(`
                SELECT TOP 1 gol_casa, gol_fora, gol_casa_ht, gol_fora_ht
                FROM bet365_eventos
                WHERE time_casa = @tc AND time_fora = @tf
                  AND gol_casa IS NOT NULL AND gol_fora IS NOT NULL
                  AND ABS(DATEDIFF(minute, data_partida, @dj)) <= 90
                ORDER BY ABS(DATEDIFF(minute, data_partida, @dj))
            `);

        if (!r.recordset.length) continue;
        const ev     = r.recordset[0];
        const ganhou = _resolveMarket(bet.mercado, ev.gol_casa, ev.gol_fora, ev.gol_casa_ht, ev.gol_fora_ht);
        if (ganhou === null) continue;

        const lucro = ganhou
            ? +(bet.creditos * (bet.odd - 1)).toFixed(2)
            : +(-bet.creditos).toFixed(2);

        await pool.request()
            .input('id',  sql.Int,         bet.id)
            .input('res', sql.VarChar,     ganhou ? 'ganhou' : 'perdeu')
            .input('luc', sql.Decimal(10, 2), lucro)
            .query(`
                UPDATE simulador_apostas
                SET resultado = @res, lucro = @luc, data_resultado = GETUTCDATE()
                WHERE id = @id
            `);
        resolved++;
    }
    return resolved;
}

// Calculates balance and stats for a given user
async function _getSaldo(pool, usuarioId, saldoInicial) {
    const r = await pool.request()
        .input('uid', sql.Int, Number(usuarioId))
        .query(`
            SELECT
                ISNULL(SUM(CASE WHEN resultado NOT IN ('pendente','cancelado') THEN lucro  ELSE 0 END), 0) AS lucros,
                ISNULL(SUM(CASE WHEN resultado = 'pendente'                   THEN creditos ELSE 0 END), 0) AS em_jogo,
                COUNT(CASE WHEN resultado = 'pendente' THEN 1 END) AS pendentes,
                COUNT(CASE WHEN resultado = 'ganhou'   THEN 1 END) AS ganhas,
                COUNT(CASE WHEN resultado = 'perdeu'   THEN 1 END) AS perdidas,
                COUNT(CASE WHEN resultado = 'cancelado' THEN 1 END) AS canceladas
            FROM simulador_apostas WHERE usuario_id = @uid
        `);
    const s        = r.recordset[0];
    const saldoTotal = +(saldoInicial + Number(s.lucros)).toFixed(2);
    const saldoDisp  = +(saldoTotal   - Number(s.em_jogo)).toFixed(2);
    return {
        saldoTotal,
        saldoDisp,
        emJogo:    +Number(s.em_jogo).toFixed(2),
        pendentes: s.pendentes,
        ganhas:    s.ganhas,
        perdidas:  s.perdidas,
        canceladas: s.canceladas,
    };
}

// ── POST /resumo ──────────────────────────────────────────────────────────────

router.post('/resumo', async (req, res) => {
    try {
        const { usuarioId } = req.body;
        if (!usuarioId) return res.json({ success: false, message: 'usuarioId obrigatório' });

        const pool = await _getPool();
        await _ensureTable(pool);

        const saldoInicial = parseFloat(await _getCfg(pool, 'simulador_saldo_inicial', '100'));
        const maxAposta    = parseFloat(await _getCfg(pool, 'simulador_max_aposta',    '50'));

        // Auto-resolve pending bets for this user before returning balance
        await _resolverPendentes(pool, usuarioId);

        const saldo = await _getSaldo(pool, usuarioId, saldoInicial);

        const apostas = await pool.request()
            .input('uid', sql.Int, Number(usuarioId))
            .query(`
                SELECT TOP 20 id, time_casa, time_fora, liga, data_jogo, mercado, odd, creditos,
                              resultado, lucro, data_aposta, data_resultado
                FROM simulador_apostas
                WHERE usuario_id = @uid
                ORDER BY data_aposta DESC
            `);

        res.json({
            success: true,
            saldoInicial,
            maxAposta,
            ...saldo,
            apostas: apostas.recordset,
        });
    } catch (e) {
        console.error('[simulador/resumo]', e.message);
        res.json({ success: false, message: e.message });
    }
});

// ── POST /apostar ─────────────────────────────────────────────────────────────

router.post('/apostar', async (req, res) => {
    try {
        const { usuarioId, time_casa, time_fora, liga, data_jogo, mercado, odd, creditos } = req.body;
        if (!usuarioId || !time_casa || !time_fora || !mercado || !odd || !creditos)
            return res.json({ success: false, message: 'Dados incompletos' });

        const pool = await _getPool();
        await _ensureTable(pool);

        const saldoInicial = parseFloat(await _getCfg(pool, 'simulador_saldo_inicial', '100'));
        const maxAposta    = parseFloat(await _getCfg(pool, 'simulador_max_aposta',    '50'));

        const credNum = parseFloat(creditos);
        const oddNum  = parseFloat(odd);

        if (isNaN(credNum) || credNum <= 0)
            return res.json({ success: false, message: 'Créditos inválidos' });
        if (isNaN(oddNum) || oddNum <= 1.0)
            return res.json({ success: false, message: 'Odd inválida (mínimo 1.01)' });
        if (credNum > maxAposta)
            return res.json({ success: false, message: `Máximo por aposta: ${maxAposta} cr` });

        const saldo = await _getSaldo(pool, usuarioId, saldoInicial);
        if (credNum > saldo.saldoDisp)
            return res.json({ success: false, message: `Saldo insuficiente (disponível: ${saldo.saldoDisp} cr)` });

        const jogoDate = data_jogo ? new Date(data_jogo) : new Date();

        await pool.request()
            .input('uid',  sql.Int,            Number(usuarioId))
            .input('tc',   sql.VarChar,         String(time_casa).substring(0, 120))
            .input('tf',   sql.VarChar,         String(time_fora).substring(0, 120))
            .input('liga', sql.VarChar,         String(liga || '').substring(0, 120))
            .input('dj',   sql.DateTime,        jogoDate)
            .input('mkt',  sql.VarChar,         String(mercado).substring(0, 60))
            .input('odd',  sql.Decimal(7, 2),   oddNum)
            .input('cred', sql.Decimal(10, 2),  credNum)
            .query(`
                INSERT INTO simulador_apostas
                    (usuario_id, time_casa, time_fora, liga, data_jogo, mercado, odd, creditos)
                VALUES
                    (@uid, @tc, @tf, @liga, @dj, @mkt, @odd, @cred)
            `);

        res.json({ success: true, message: 'Aposta registrada!' });
    } catch (e) {
        console.error('[simulador/apostar]', e.message);
        res.json({ success: false, message: e.message });
    }
});

// ── POST /cancelar-aposta ─────────────────────────────────────────────────────

router.post('/cancelar-aposta', async (req, res) => {
    try {
        const { usuarioId, apostaId } = req.body;
        if (!usuarioId || !apostaId) return res.json({ success: false, message: 'Dados incompletos' });

        const pool = await _getPool();
        const r = await pool.request()
            .input('id',  sql.Int, Number(apostaId))
            .input('uid', sql.Int, Number(usuarioId))
            .query(`
                UPDATE simulador_apostas
                SET resultado = 'cancelado', lucro = 0, data_resultado = GETUTCDATE()
                WHERE id = @id AND usuario_id = @uid AND resultado = 'pendente'
            `);
        if (r.rowsAffected[0] === 0)
            return res.json({ success: false, message: 'Aposta não encontrada ou já resolvida' });

        res.json({ success: true, message: 'Aposta cancelada' });
    } catch (e) {
        console.error('[simulador/cancelar-aposta]', e.message);
        res.json({ success: false, message: e.message });
    }
});

// ── POST /resolver-pendentes (admin / sistema) ────────────────────────────────

router.post('/resolver-pendentes', async (req, res) => {
    try {
        const pool     = await _getPool();
        await _ensureTable(pool);
        const resolved = await _resolverPendentes(pool, null);
        res.json({ success: true, message: `${resolved} aposta(s) resolvida(s)` });
    } catch (e) {
        console.error('[simulador/resolver-pendentes]', e.message);
        res.json({ success: false, message: e.message });
    }
});

// ── POST /admin — lista todos os usuários com resumo ─────────────────────────

router.post('/admin', async (req, res) => {
    try {
        const { usuarioId } = req.body;
        if (!usuarioId) return res.json({ success: false, message: 'usuarioId obrigatório' });

        const pool = await _getPool();

        const check = await pool.request()
            .input('uid', sql.Int, Number(usuarioId))
            .query('SELECT TipoUsuario FROM Usuarios WHERE Id = @uid');
        const tipo = (check.recordset[0]?.TipoUsuario || '').toLowerCase();
        if (!['master', 'admin', 'administrador'].includes(tipo))
            return res.json({ success: false, message: 'Acesso negado' });

        await _ensureTable(pool);
        const saldoInicial = parseFloat(await _getCfg(pool, 'simulador_saldo_inicial', '100'));

        const r = await pool.request().query(`
            SELECT
                u.Id, u.NomeCompleto, u.Usuario, u.TipoUsuario,
                ISNULL(SUM(CASE WHEN a.resultado NOT IN ('pendente','cancelado') THEN a.lucro   ELSE 0 END), 0) AS lucros,
                ISNULL(SUM(CASE WHEN a.resultado = 'pendente'                   THEN a.creditos ELSE 0 END), 0) AS em_jogo,
                ISNULL(SUM(a.creditos), 0)                                                                      AS total_apostado,
                COUNT(CASE WHEN a.resultado = 'pendente' THEN 1 END)  AS pendentes,
                COUNT(CASE WHEN a.resultado = 'ganhou'   THEN 1 END)  AS ganhas,
                COUNT(CASE WHEN a.resultado = 'perdeu'   THEN 1 END)  AS perdidas,
                MAX(a.data_aposta) AS ultima_aposta
            FROM Usuarios u
            LEFT JOIN simulador_apostas a ON a.usuario_id = u.Id
            WHERE u.Ativo = 1
            GROUP BY u.Id, u.NomeCompleto, u.Usuario, u.TipoUsuario
            ORDER BY (${saldoInicial} + ISNULL(SUM(CASE WHEN a.resultado NOT IN ('pendente','cancelado') THEN a.lucro ELSE 0 END), 0)) DESC
        `);

        const usuarios = r.recordset.map(row => ({
            id:          row.Id,
            nome:        row.NomeCompleto,
            usuario:     row.Usuario,
            tipo:        row.TipoUsuario,
            saldoTotal:  +(saldoInicial + Number(row.lucros)).toFixed(2),
            saldoDisp:   +(saldoInicial + Number(row.lucros) - Number(row.em_jogo)).toFixed(2),
            emJogo:      +Number(row.em_jogo).toFixed(2),
            totalApost:  +Number(row.total_apostado).toFixed(2),
            pendentes:   row.pendentes,
            ganhas:      row.ganhas,
            perdidas:    row.perdidas,
            ultimaAposta: row.ultima_aposta,
        }));

        res.json({ success: true, saldoInicial, usuarios });
    } catch (e) {
        console.error('[simulador/admin]', e.message);
        res.json({ success: false, message: e.message });
    }
});

module.exports = router;
