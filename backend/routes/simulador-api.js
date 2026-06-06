'use strict';
const express = require('express');
const router  = express.Router();
const sql     = require('mssql');

// ── helpers ───────────────────────────────────────────────────────────────────

async function _getPool() {
    const { getDbPool } = require('./bet365-api');
    return getDbPool();
}

// Fetch multiple config keys in a single query
async function _getCfgs(pool, defaults) {
    try {
        const keys   = Object.keys(defaults);
        const inList = keys.map(k => `'${k}'`).join(',');
        const r      = await pool.request()
            .query(`SELECT chave, valor FROM bet365_config WHERE chave IN (${inList})`);
        const map = { ...defaults };
        r.recordset.forEach(row => { map[row.chave] = row.valor; });
        return map;
    } catch (_) { return defaults; }
}

// ── table + indexes (run once per process) ────────────────────────────────────

let _tableEnsured = false;

async function _ensureTable(pool) {
    if (_tableEnsured) return;

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

    // Covering index for per-user queries (saldo, histórico, pendentes por usuário)
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.indexes
                       WHERE name = 'IX_sim_uid_res'
                         AND object_id = OBJECT_ID('simulador_apostas'))
        CREATE INDEX IX_sim_uid_res
            ON simulador_apostas (usuario_id, resultado)
            INCLUDE (time_casa, time_fora, liga, data_jogo, mercado, odd,
                     creditos, lucro, data_aposta, data_resultado)
    `);

    // Index on bet365_resultados_mercados for the resolution JOIN
    // Covers: JOIN on time_casa+time_fora+data_partida, SELECT mercado+selecao
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.indexes
                       WHERE name = 'IX_b365rm_tc_tf_data'
                         AND object_id = OBJECT_ID('bet365_resultados_mercados'))
        CREATE INDEX IX_b365rm_tc_tf_data
            ON bet365_resultados_mercados (time_casa, time_fora, data_partida)
            INCLUDE (mercado, selecao)
    `);

    _tableEnsured = true;
}

// ── market resolution (from aggregated row of bet365_resultados_mercados) ─────
//
// The resolution query does a GROUP BY (one row per pending bet) aggregating
// all market results for that game from bet365_resultados_mercados.
// Each tem_X flag = 1 means we have data for that market type.
// Each over_X / result_X = 1 means that outcome won.
// null return = "game not resolved yet" → bet stays pending.

function _resolveMarketFromRow(row) {
    switch (row.aposta_mercado) {
        // ── FT 1X2 ──
        case 'casa':        return row.tem_resultado ? (row.resultado_casa   === 1) : null;
        case 'empate':      return row.tem_resultado ? (row.resultado_empate === 1) : null;
        case 'fora':        return row.tem_resultado ? (row.resultado_fora   === 1) : null;

        // ── FT Over/Under ──
        case 'over0.5':     return row.tem_over05 ? (row.over05 === 1) : null;
        case 'under0.5':    return row.tem_over05 ? (row.over05 === 0) : null;
        case 'over1.5':     return row.tem_over15 ? (row.over15 === 1) : null;
        case 'under1.5':    return row.tem_over15 ? (row.over15 === 0) : null;
        case 'over2.5':     return row.tem_over25 ? (row.over25 === 1) : null;
        case 'under2.5':    return row.tem_over25 ? (row.over25 === 0) : null;
        case 'over3.5':     return row.tem_over35 ? (row.over35 === 1) : null;
        case 'under3.5':    return row.tem_over35 ? (row.over35 === 0) : null;
        case 'over4.5':     return row.tem_over45 ? (row.over45 === 1) : null;
        case 'under4.5':    return row.tem_over45 ? (row.over45 === 0) : null;

        // ── BTTS ──
        case 'ambas-sim':   return row.tem_btts ? (row.btts_sim === 1) : null;
        case 'ambas-nao':   return row.tem_btts ? (row.btts_sim === 0) : null;

        // ── HT 1X2 ('Resultado Intervalo' ou 'Intervalo Resultado' — ambos no banco) ──
        case 'casa-ht':     return row.tem_ht ? (row.ht_casa   === 1) : null;
        case 'empate-ht':   return row.tem_ht ? (row.ht_empate === 1) : null;
        case 'fora-ht':     return row.tem_ht ? (row.ht_fora   === 1) : null;

        // ── HT Over/Under ──
        case 'over0.5-1t':  return row.tem_ht05 ? (row.ht_over05 === 1) : null;
        case 'under0.5-1t': return row.tem_ht05 ? (row.ht_over05 === 0) : null;
        case 'over1.5-1t':  return row.tem_ht15 ? (row.ht_over15 === 1) : null;
        case 'under1.5-1t': return row.tem_ht15 ? (row.ht_over15 === 0) : null;

        default: return null;
    }
}

// ── resolution: single JOIN → GROUP BY → single batched UPDATE ───────────────
//
// Joins simulador_apostas × bet365_resultados_mercados (INNER JOIN = only bets
// whose game already has collected results). Aggregates all market rows for each
// pending bet into one row with boolean flags, then resolves each bet in JS.
// Ends with a single batched UPDATE (CASE WHEN id …) instead of N individual ones.

async function _resolverPendentes(pool, usuarioIdFiltro = null) {
    const filtro = usuarioIdFiltro ? `AND a.usuario_id = ${Number(usuarioIdFiltro)}` : '';

    const resolvable = await pool.request().query(`
        SELECT
            a.id             AS aposta_id,
            a.mercado        AS aposta_mercado,
            a.creditos,
            a.odd,
            a.time_casa,
            a.time_fora,
            -- FT result
            MAX(CASE WHEN r.mercado = 'Resultado Final' THEN 1 ELSE 0 END) AS tem_resultado,
            MAX(CASE WHEN r.mercado = 'Resultado Final' AND r.selecao = a.time_casa THEN 1 ELSE 0 END) AS resultado_casa,
            MAX(CASE WHEN r.mercado = 'Resultado Final' AND r.selecao = 'Empate'    THEN 1 ELSE 0 END) AS resultado_empate,
            MAX(CASE WHEN r.mercado = 'Resultado Final' AND r.selecao = a.time_fora THEN 1 ELSE 0 END) AS resultado_fora,
            -- FT over/under (NOT LIKE '%Intervalo%' to exclude HT markets)
            MAX(CASE WHEN r.mercado LIKE '%0.5%' AND r.mercado NOT LIKE '%Intervalo%' THEN 1 ELSE 0 END) AS tem_over05,
            MAX(CASE WHEN r.mercado LIKE '%0.5%' AND r.mercado NOT LIKE '%Intervalo%' AND r.selecao LIKE 'Mais%' THEN 1 ELSE 0 END) AS over05,
            MAX(CASE WHEN r.mercado LIKE '%1.5%' AND r.mercado NOT LIKE '%Intervalo%' THEN 1 ELSE 0 END) AS tem_over15,
            MAX(CASE WHEN r.mercado LIKE '%1.5%' AND r.mercado NOT LIKE '%Intervalo%' AND r.selecao LIKE 'Mais%' THEN 1 ELSE 0 END) AS over15,
            MAX(CASE WHEN r.mercado LIKE '%2.5%' AND r.mercado NOT LIKE '%Intervalo%' THEN 1 ELSE 0 END) AS tem_over25,
            MAX(CASE WHEN r.mercado LIKE '%2.5%' AND r.mercado NOT LIKE '%Intervalo%' AND r.selecao LIKE 'Mais%' THEN 1 ELSE 0 END) AS over25,
            MAX(CASE WHEN r.mercado LIKE '%3.5%' AND r.mercado NOT LIKE '%Intervalo%' THEN 1 ELSE 0 END) AS tem_over35,
            MAX(CASE WHEN r.mercado LIKE '%3.5%' AND r.mercado NOT LIKE '%Intervalo%' AND r.selecao LIKE 'Mais%' THEN 1 ELSE 0 END) AS over35,
            MAX(CASE WHEN r.mercado LIKE '%4.5%' AND r.mercado NOT LIKE '%Intervalo%' THEN 1 ELSE 0 END) AS tem_over45,
            MAX(CASE WHEN r.mercado LIKE '%4.5%' AND r.mercado NOT LIKE '%Intervalo%' AND r.selecao LIKE 'Mais%' THEN 1 ELSE 0 END) AS over45,
            -- BTTS
            MAX(CASE WHEN r.mercado = 'Ambos Marcam' THEN 1 ELSE 0 END) AS tem_btts,
            MAX(CASE WHEN r.mercado = 'Ambos Marcam' AND r.selecao = 'Sim' THEN 1 ELSE 0 END) AS btts_sim,
            -- HT result ('Resultado Intervalo' ou 'Intervalo Resultado' — ambos existem no banco)
            MAX(CASE WHEN r.mercado IN ('Resultado Intervalo','Intervalo Resultado') THEN 1 ELSE 0 END) AS tem_ht,
            MAX(CASE WHEN r.mercado IN ('Resultado Intervalo','Intervalo Resultado') AND r.selecao = a.time_casa THEN 1 ELSE 0 END) AS ht_casa,
            MAX(CASE WHEN r.mercado IN ('Resultado Intervalo','Intervalo Resultado') AND r.selecao = 'Empate'    THEN 1 ELSE 0 END) AS ht_empate,
            MAX(CASE WHEN r.mercado IN ('Resultado Intervalo','Intervalo Resultado') AND r.selecao = a.time_fora THEN 1 ELSE 0 END) AS ht_fora,
            -- HT over/under
            MAX(CASE WHEN r.mercado LIKE '%0.5%' AND r.mercado LIKE '%Intervalo%' THEN 1 ELSE 0 END) AS tem_ht05,
            MAX(CASE WHEN r.mercado LIKE '%0.5%' AND r.mercado LIKE '%Intervalo%' AND r.selecao LIKE 'Mais%' THEN 1 ELSE 0 END) AS ht_over05,
            MAX(CASE WHEN r.mercado LIKE '%1.5%' AND r.mercado LIKE '%Intervalo%' THEN 1 ELSE 0 END) AS tem_ht15,
            MAX(CASE WHEN r.mercado LIKE '%1.5%' AND r.mercado LIKE '%Intervalo%' AND r.selecao LIKE 'Mais%' THEN 1 ELSE 0 END) AS ht_over15
        FROM simulador_apostas a
        INNER JOIN bet365_resultados_mercados r
            ON  r.time_casa    = a.time_casa
            AND r.time_fora    = a.time_fora
            AND r.data_partida BETWEEN DATEADD(minute, -90, a.data_jogo)
                                   AND DATEADD(minute,  90, a.data_jogo)
        WHERE a.resultado = 'pendente' ${filtro}
        GROUP BY a.id, a.mercado, a.creditos, a.odd, a.time_casa, a.time_fora
    `);

    if (!resolvable.recordset.length) return 0;

    const ganhouIds = [];
    const perdeuIds = [];
    const lucros    = {};

    for (const row of resolvable.recordset) {
        const ganhou = _resolveMarketFromRow(row);
        if (ganhou === null) continue; // game not yet resolved for this market
        const lucro = ganhou
            ? +(row.creditos * (row.odd - 1)).toFixed(2)
            : +(-row.creditos).toFixed(2);
        if (ganhou) ganhouIds.push(row.aposta_id);
        else        perdeuIds.push(row.aposta_id);
        lucros[row.aposta_id] = lucro;
    }

    const allIds = [...ganhouIds, ...perdeuIds];
    if (!allIds.length) return 0;

    // Single batched UPDATE — replaces N individual updates
    const ganhouList = ganhouIds.length ? ganhouIds.join(',') : '-1';
    const lucroCase  = allIds
        .map(id => `WHEN ${id} THEN CAST(${lucros[id]} AS DECIMAL(10,2))`)
        .join(' ');

    await pool.request().query(`
        UPDATE simulador_apostas
        SET
            resultado      = CASE WHEN id IN (${ganhouList}) THEN 'ganhou' ELSE 'perdeu' END,
            lucro          = CASE id ${lucroCase} ELSE 0 END,
            data_resultado = GETUTCDATE()
        WHERE id IN (${allIds.join(',')}) AND resultado = 'pendente'
    `);

    return allIds.length;
}

// ── balance helper ────────────────────────────────────────────────────────────

async function _getSaldo(pool, usuarioId, saldoInicial) {
    const r = await pool.request()
        .input('uid', sql.Int, Number(usuarioId))
        .query(`
            SELECT
                ISNULL(SUM(CASE WHEN resultado NOT IN ('pendente','cancelado') THEN lucro    ELSE 0 END), 0) AS lucros,
                ISNULL(SUM(CASE WHEN resultado = 'pendente'                   THEN creditos  ELSE 0 END), 0) AS em_jogo,
                COUNT(CASE WHEN resultado = 'pendente'  THEN 1 END) AS pendentes,
                COUNT(CASE WHEN resultado = 'ganhou'    THEN 1 END) AS ganhas,
                COUNT(CASE WHEN resultado = 'perdeu'    THEN 1 END) AS perdidas,
                COUNT(CASE WHEN resultado = 'cancelado' THEN 1 END) AS canceladas
            FROM simulador_apostas WHERE usuario_id = @uid
        `);
    const s          = r.recordset[0];
    const saldoTotal = +(saldoInicial + Number(s.lucros)).toFixed(2);
    const saldoDisp  = +(saldoTotal   - Number(s.em_jogo)).toFixed(2);
    return {
        saldoTotal, saldoDisp,
        emJogo:     +Number(s.em_jogo).toFixed(2),
        pendentes:  s.pendentes,
        ganhas:     s.ganhas,
        perdidas:   s.perdidas,
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

        const cfg = await _getCfgs(pool, {
            simulador_saldo_inicial: '100',
            simulador_max_aposta:    '50',
        });
        const saldoInicial = parseFloat(cfg.simulador_saldo_inicial);
        const maxAposta    = parseFloat(cfg.simulador_max_aposta);

        await _resolverPendentes(pool, usuarioId);

        const saldo = await _getSaldo(pool, usuarioId, saldoInicial);

        const apostas = await pool.request()
            .input('uid', sql.Int, Number(usuarioId))
            .query(`
                SELECT TOP 20
                    id, time_casa, time_fora, liga, data_jogo, mercado, odd, creditos,
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

        const cfg = await _getCfgs(pool, {
            simulador_saldo_inicial: '100',
            simulador_max_aposta:    '50',
        });
        const saldoInicial = parseFloat(cfg.simulador_saldo_inicial);
        const maxAposta    = parseFloat(cfg.simulador_max_aposta);

        const credNum = parseFloat(creditos);
        const oddNum  = parseFloat(odd);

        if (isNaN(credNum) || credNum <= 0)
            return res.json({ success: false, message: 'Créditos inválidos' });
        if (isNaN(oddNum)  || oddNum  <= 1.0)
            return res.json({ success: false, message: 'Odd inválida (mínimo 1.01)' });
        if (credNum > maxAposta)
            return res.json({ success: false, message: `Máximo por aposta: ${maxAposta} cr` });

        const saldo = await _getSaldo(pool, usuarioId, saldoInicial);
        if (credNum > saldo.saldoDisp)
            return res.json({ success: false, message: `Saldo insuficiente (disponível: ${saldo.saldoDisp} cr)` });

        await pool.request()
            .input('uid',  sql.Int,           Number(usuarioId))
            .input('tc',   sql.VarChar,        String(time_casa).substring(0, 120))
            .input('tf',   sql.VarChar,        String(time_fora).substring(0, 120))
            .input('liga', sql.VarChar,        String(liga || '').substring(0, 120))
            .input('dj',   sql.DateTime,       data_jogo ? new Date(data_jogo) : new Date())
            .input('mkt',  sql.VarChar,        String(mercado).substring(0, 60))
            .input('odd',  sql.Decimal(7, 2),  oddNum)
            .input('cred', sql.Decimal(10, 2), credNum)
            .query(`
                INSERT INTO simulador_apostas
                    (usuario_id, time_casa, time_fora, liga, data_jogo, mercado, odd, creditos)
                VALUES (@uid, @tc, @tf, @liga, @dj, @mkt, @odd, @cred)
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
        if (!usuarioId || !apostaId)
            return res.json({ success: false, message: 'Dados incompletos' });

        const pool = await _getPool();
        const r    = await pool.request()
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

// ── POST /admin ───────────────────────────────────────────────────────────────

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

        const cfg          = await _getCfgs(pool, { simulador_saldo_inicial: '100' });
        const saldoInicial = parseFloat(cfg.simulador_saldo_inicial);

        const r = await pool.request().query(`
            SELECT
                u.Id, u.NomeCompleto, u.Usuario, u.TipoUsuario,
                ISNULL(SUM(CASE WHEN a.resultado NOT IN ('pendente','cancelado') THEN a.lucro    ELSE 0 END), 0) AS lucros,
                ISNULL(SUM(CASE WHEN a.resultado = 'pendente'                   THEN a.creditos ELSE 0 END), 0) AS em_jogo,
                ISNULL(SUM(a.creditos), 0) AS total_apostado,
                COUNT(CASE WHEN a.resultado = 'pendente' THEN 1 END) AS pendentes,
                COUNT(CASE WHEN a.resultado = 'ganhou'   THEN 1 END) AS ganhas,
                COUNT(CASE WHEN a.resultado = 'perdeu'   THEN 1 END) AS perdidas,
                MAX(a.data_aposta) AS ultima_aposta
            FROM Usuarios u
            LEFT JOIN simulador_apostas a ON a.usuario_id = u.Id
            WHERE u.Ativo = 1
            GROUP BY u.Id, u.NomeCompleto, u.Usuario, u.TipoUsuario
            ORDER BY lucros DESC
        `);

        const usuarios = r.recordset.map(row => ({
            id:           row.Id,
            nome:         row.NomeCompleto,
            usuario:      row.Usuario,
            tipo:         row.TipoUsuario,
            saldoTotal:   +(saldoInicial + Number(row.lucros)).toFixed(2),
            saldoDisp:    +(saldoInicial + Number(row.lucros) - Number(row.em_jogo)).toFixed(2),
            emJogo:       +Number(row.em_jogo).toFixed(2),
            totalApost:   +Number(row.total_apostado).toFixed(2),
            pendentes:    row.pendentes,
            ganhas:       row.ganhas,
            perdidas:     row.perdidas,
            ultimaAposta: row.ultima_aposta,
        }));

        res.json({ success: true, saldoInicial, usuarios });
    } catch (e) {
        console.error('[simulador/admin]', e.message);
        res.json({ success: false, message: e.message });
    }
});

module.exports = router;
