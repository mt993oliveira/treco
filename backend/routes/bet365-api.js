/**
 * ============================================
 * API REST - BET365 DADOS EM TEMPO REAL
 * ============================================
 */

const express = require('express');
const sql = require('mssql');
const router = express.Router();

let sqlPool = null;

// Mapeamento: nome canônico (frontend) → nome real no banco (bet365_resultados_mercados)
// O frontend envia "Copa do Mundo" / "Premier League", o banco armazena "World Cup" / "Premiership"
const LIGA_CANONICAL_TO_DB = {
    'Copa do Mundo':   'World Cup',
    'Premier League':  'Premiership',
    // as demais já coincidem: Euro Cup, Express Cup, Super Liga Sul-Americana
};
function ligaParaBanco(liga) {
    if (!liga || liga === 'all') return liga;
    return LIGA_CANONICAL_TO_DB[liga] || liga;
}

async function getDbPool() {
    if (sqlPool && sqlPool.connected) {
        return sqlPool;
    }

    const config = {
        user: process.env.DB_USER || 'sa',
        password: process.env.DB_PASSWORD || 'kvb@4sJ2',
        server: process.env.DB_SERVER || '127.0.0.1',
        database: process.env.DB_NAME || 'PRODUCAO',
        port: parseInt(process.env.DB_PORT) || 1433,
        options: {
            encrypt: process.env.DB_ENCRYPT === 'true',
            trustServerCertificate: process.env.DB_TRUST_CERT !== 'false'
        },
        pool: {
            max: 10,
            min: 0,
            idleTimeoutMillis: 30000
        }
    };

    sqlPool = await sql.connect(config);
    console.log('✅ Pool SQL Bet365 criado');

    // Cria índice composto para acelerar consultas por liga (TOP N por liga)
    // Não bloqueia — dispara em background e ignora erros se já existir
    sqlPool.request().query(`
        IF NOT EXISTS (
            SELECT 1 FROM sys.indexes
            WHERE name = 'IX_b365_resmkt_liga_evt_data'
              AND OBJECT_NAME(object_id) = 'bet365_resultados_mercados'
        )
        CREATE INDEX IX_b365_resmkt_liga_evt_data
            ON bet365_resultados_mercados (liga, data_partida DESC, evento_id)
    `).then(() => console.log('✅ Índice IX_b365_resmkt_liga_evt_data verificado/criado'))
      .catch(e => console.warn('⚠️ Índice: ' + e.message));

    return sqlPool;
}

// bet365_historico_partidas foi removida — toda a lógica usa bet365_resultados_mercados

/**
 * GET /api/bet365/eventos
 * Retorna todos os eventos ativos
 */
router.get('/eventos', async (req, res) => {
    try {
        const { limite = 100, liga, status } = req.query;
        const pool = await getDbPool();

        let query = `
            SELECT
                e.id AS evento_id,
                e.time_casa,
                e.time_fora,
                e.league_name AS liga,
                e.start_time_datetime AS horario,
                e.status,
                e.odd_casa,
                e.odd_empate,
                e.odd_fora,
                COUNT(DISTINCT m.id) AS total_mercados
            FROM bet365_eventos e
            LEFT JOIN bet365_mercados m ON m.evento_id = e.id AND m.ativo = 1
            WHERE e.ativo = 1
        `;

        if (liga) {
            query += ' AND e.league_name LIKE @liga';
        }

        if (status) {
            query += ' AND e.status = @status';
        }

        query += ' GROUP BY e.id, e.time_casa, e.time_fora, e.league_name, e.start_time_datetime, e.status, e.odd_casa, e.odd_empate, e.odd_fora ORDER BY e.start_time_datetime ASC';

        const request = pool.request();

        if (liga) {
            request.input('liga', sql.NVarChar(200), `%${liga}%`);
        }

        if (status) {
            request.input('status', sql.NVarChar(50), status);
        }

        const result = await request.query(query);

        res.json({
            success: true,
            count: result.recordset.length,
            timestamp: new Date().toISOString(),
            data: result.recordset
        });

    } catch (error) {
        console.error('❌ ERRO API bet365/eventos:', error.message);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar eventos',
            error: error.message
        });
    }
});

/**
 * GET /api/bet365/ao-vivo
 * Retorna apenas eventos ao vivo
 */
router.get('/ao-vivo', async (req, res) => {
    try {
        const pool = await getDbPool();

        const result = await pool.query(`
            SELECT
                e.id AS evento_id,
                e.time_casa,
                e.time_fora,
                e.league_name AS liga,
                e.status,
                e.odd_casa,
                e.odd_empate,
                e.odd_fora
            FROM bet365_eventos e
            WHERE e.ativo = 1 AND e.status = 'EM_ANDAMENTO'
            ORDER BY e.start_time_datetime ASC
        `);

        res.json({
            success: true,
            count: result.recordset.length,
            timestamp: new Date().toISOString(),
            data: result.recordset
        });

    } catch (error) {
        console.error('❌ ERRO API bet365/ao-vivo:', error.message);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar eventos ao vivo',
            error: error.message
        });
    }
});

/**
 * GET /api/bet365/historico-partidas — REMOVIDO (tabela bet365_historico_partidas descontinuada)
 * Use /api/bet365/historico-mercados
 */
router.get('/historico-partidas', (req, res) => {
    res.status(410).json({ success: false, message: 'Endpoint removido. Use /api/bet365/historico-mercados' });
});

/**
 * GET /api/bet365/ligas
 * Retorna ligas disponíveis
 */
router.get('/ligas', async (req, res) => {
    try {
        const pool = await getDbPool();

        const result = await pool.query(`
            SELECT DISTINCT
                league_name AS liga,
                COUNT(*) AS quantidade
            FROM bet365_eventos
            WHERE ativo = 1
            GROUP BY league_name
            ORDER BY quantidade DESC
        `);

        res.json({
            success: true,
            count: result.recordset.length,
            data: result.recordset
        });

    } catch (error) {
        console.error('❌ ERRO API bet365/ligas:', error.message);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar ligas',
            error: error.message
        });
    }
});

/**
 * GET /api/bet365/stats
 * Retorna estatísticas gerais
 */
router.get('/stats', async (req, res) => {
    try {
        const pool = await getDbPool();

        const eventosResult = await pool.query(`
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'EM_ANDAMENTO' THEN 1 ELSE 0 END) AS ao_vivo,
                SUM(CASE WHEN status = 'AGENDADO' THEN 1 ELSE 0 END) AS agendados
            FROM bet365_eventos WHERE ativo = 1
        `);

        const logResult = await pool.query(`
            SELECT TOP 1
                data_inicio,
                data_fim,
                status,
                eventos_coletados
            FROM bet365_log_coleta
            ORDER BY data_inicio DESC
        `);

        res.json({
            success: true,
            data: {
                eventos: eventosResult.recordset[0],
                ultima_coleta: logResult.recordset[0] || null
            }
        });

    } catch (error) {
        console.error('❌ ERRO API bet365/stats:', error.message);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar estatísticas',
            error: error.message
        });
    }
});

/**
 * GET /api/bet365/eventos-completos
 * Retorna eventos COM mercados adicionais (Double Chance, Over/Under, BTTS)
 */
router.get('/eventos-completos', async (req, res) => {
    try {
        const pool = await getDbPool();

        // Busca eventos ativos
        const eventosResult = await pool.request()
            .query(`
                SELECT
                    e.id AS evento_id,
                    e.time_casa,
                    e.time_fora,
                    e.league_name AS liga,
                    e.start_time_datetime AS horario,
                    e.status,
                    e.odd_casa,
                    e.odd_empate,
                    e.odd_fora
                FROM bet365_eventos e
                WHERE e.ativo = 1
                ORDER BY
                    CASE WHEN e.status = 'EM_ANDAMENTO' THEN 0 ELSE 1 END ASC,
                    ISNULL(e.start_time_datetime, '9999-12-31') ASC
            `);

        const eventos = eventosResult.recordset;

        // Busca mercados de todos os eventos em uma única query (evita N+1)
        if (eventos.length > 0) {
            const ids = eventos.map(e => String(BigInt(e.evento_id))).join(',');
            const allMkts = await pool.request().query(`
                SELECT
                    m.evento_id,
                    m.nome AS mercado_nome,
                    m.tipo AS mercado_tipo,
                    o.nome AS selecao,
                    o.valor AS odd
                FROM bet365_mercados m
                JOIN bet365_odds o ON o.mercado_id = m.id AND o.ativo = 1
                WHERE m.evento_id IN (${ids}) AND m.ativo = 1
                ORDER BY m.evento_id, m.tipo, o.nome
            `);

            const mktMap = {};
            for (const row of allMkts.recordset) {
                const evId = String(row.evento_id);
                if (!mktMap[evId]) mktMap[evId] = {};
                if (!mktMap[evId][row.mercado_tipo]) {
                    mktMap[evId][row.mercado_tipo] = {
                        nome: row.mercado_nome,
                        tipo: row.mercado_tipo,
                        selecoes: []
                    };
                }
                mktMap[evId][row.mercado_tipo].selecoes.push({ nome: row.selecao, odd: row.odd });
            }
            for (const ev of eventos) {
                ev.mercados = Object.values(mktMap[String(ev.evento_id)] || {});
            }
        }

        res.json({
            success: true,
            count: eventos.length,
            timestamp: new Date().toISOString(),
            data: eventos
        });

    } catch (error) {
        console.error('❌ ERRO API bet365/eventos-completos:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/bet365/diagnostico
 * Retorna estado do banco (usa bet365_resultados_mercados como fonte principal)
 */
router.get('/diagnostico', async (req, res) => {
    try {
        const pool = await getDbPool();

        const [countEventos, countMercados, countMercados24h, ultimosEventos, ultimosMercados, mercadosPorLiga] = await Promise.all([
            pool.query(`SELECT COUNT(*) AS total FROM bet365_eventos WHERE ativo = 1`),
            pool.query(`SELECT COUNT(DISTINCT evento_id) AS total FROM bet365_resultados_mercados`),
            pool.query(`SELECT COUNT(DISTINCT evento_id) AS total FROM bet365_resultados_mercados WHERE data_partida >= DATEADD(HOUR, -24, GETUTCDATE())`),
            pool.query(`SELECT TOP 10 id, time_casa, time_fora, league_name, status FROM bet365_eventos ORDER BY data_atualizacao DESC`),
            pool.query(`
                SELECT TOP 20 liga, time_casa, time_fora, data_partida,
                    MAX(CASE WHEN mercado='Resultado Final' THEN selecao END) AS resultado_final,
                    COUNT(*) AS total_mercados
                FROM bet365_resultados_mercados
                GROUP BY liga, time_casa, time_fora, data_partida
                ORDER BY data_partida DESC
            `),
            pool.query(`
                SELECT liga, COUNT(DISTINCT evento_id) AS total_jogos, MAX(data_partida) AS ultima_partida
                FROM bet365_resultados_mercados
                GROUP BY liga ORDER BY total_jogos DESC
            `)
        ]);

        res.json({
            success: true,
            data: {
                eventosAtivos:       countEventos.recordset[0]?.total || 0,
                jogosComMercados:    countMercados.recordset[0]?.total || 0,
                jogosComMercados24h: countMercados24h.recordset[0]?.total || 0,
                amostraEventos:      ultimosEventos.recordset,
                ultimosResultados:   ultimosMercados.recordset,
                porLiga:             mercadosPorLiga.recordset
            }
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/bet365/ultimos-resultados
 * Retorna os últimos N jogos com resultado (usa bet365_resultados_mercados)
 */
router.get('/ultimos-resultados', async (req, res) => {
    try {
        const n = Math.min(parseInt(req.query.n) || 30, 100);
        const pool = await getDbPool();
        const result = await pool.request()
            .input('n', sql.Int, n)
            .query(`
                SELECT TOP (@n)
                    m.liga, m.time_casa, m.time_fora, m.data_partida,
                    MAX(CASE WHEN m.mercado = 'Resultado Final' THEN m.selecao END) AS resultado_final,
                    MAX(CASE WHEN m.mercado LIKE '%0.5%' AND m.selecao LIKE 'Mais%' THEN 1 ELSE 0 END) AS over05,
                    MAX(CASE WHEN m.mercado LIKE '%1.5%' AND m.selecao LIKE 'Mais%' THEN 1 ELSE 0 END) AS over15,
                    MAX(CASE WHEN m.mercado LIKE '%2.5%' AND m.selecao LIKE 'Mais%' THEN 1 ELSE 0 END) AS over25,
                    MAX(CASE WHEN m.mercado = 'Ambos Marcam' AND m.selecao = 'Sim' THEN 1 ELSE 0 END) AS btts
                FROM bet365_resultados_mercados m
                GROUP BY m.evento_id, m.liga, m.time_casa, m.time_fora, m.data_partida
                ORDER BY m.data_partida DESC
            `);
        res.json({ success: true, total: result.recordset.length, data: result.recordset });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/bet365/historico-tabela — alias para historico-mercados (retrocompatibilidade)
 */
router.get('/historico-tabela', (req, res) => {
    res.redirect(307, `/api/bet365/historico-mercados?${new URLSearchParams(req.query).toString()}`);
});

/**
 * GET /api/bet365/sugestoes
 * Análise estatística por liga baseada em bet365_resultados_mercados
 */
router.get('/sugestoes', async (req, res) => {
    try {
        const nJogosN    = Math.min(420, Math.max(20, parseInt(req.query.nJogos) || 40));
        const ligaFiltro = req.query.liga && req.query.liga !== '' && req.query.liga !== 'all'
            ? ligaParaBanco(req.query.liga) : null;
        const pool = await getDbPool();

        // Passo 1: ligas + total de eventos por liga (uma única query, usa índice)
        let ligasInfo; // [{ liga, total_liga }]
        if (ligaFiltro) {
            const r = await pool.request()
                .input('liga', sql.NVarChar(200), ligaFiltro)
                .query(`
                    SELECT liga, COUNT(DISTINCT evento_id) AS total_liga
                    FROM bet365_resultados_mercados
                    WHERE liga = @liga
                    GROUP BY liga
                `);
            ligasInfo = r.recordset;
        } else {
            const r = await pool.request().query(`
                SELECT liga, COUNT(DISTINCT evento_id) AS total_liga
                FROM bet365_resultados_mercados
                WHERE liga IS NOT NULL AND liga <> ''
                GROUP BY liga
            `);
            ligasInfo = r.recordset;
        }
        const totalByLiga = new Map(ligasInfo.map(r => [r.liga, r.total_liga]));

        // Passo 2: consultas paralelas por liga — cada uma usa TOP + índice (liga, data_partida)
        const PER_LIGA_SQL = `
            SELECT
                @liga AS liga, m.evento_id, m.data_partida,
                MAX(CASE WHEN m.mercado = 'Resultado Final' THEN m.selecao END)                     AS resultado_final,
                MAX(CASE WHEN m.time_casa IS NOT NULL THEN m.time_casa END)                         AS time_casa,
                MAX(CASE WHEN m.time_fora IS NOT NULL THEN m.time_fora END)                         AS time_fora,
                MAX(CASE WHEN m.mercado LIKE '%0.5%' AND m.selecao LIKE 'Mais%'  THEN 1 ELSE 0 END) AS over05,
                MAX(CASE WHEN m.mercado LIKE '%1.5%' AND m.selecao LIKE 'Mais%'  THEN 1 ELSE 0 END) AS over15,
                MAX(CASE WHEN m.mercado LIKE '%2.5%' AND m.selecao LIKE 'Mais%'  THEN 1 ELSE 0 END) AS over25,
                MAX(CASE WHEN m.mercado LIKE '%3.5%' AND m.selecao LIKE 'Mais%'  THEN 1 ELSE 0 END) AS over35,
                MAX(CASE WHEN m.mercado LIKE '%1.5%' AND m.selecao LIKE 'Menos%' THEN 1 ELSE 0 END) AS under15,
                MAX(CASE WHEN m.mercado LIKE '%2.5%' AND m.selecao LIKE 'Menos%' THEN 1 ELSE 0 END) AS under25,
                MAX(CASE WHEN m.mercado = 'Ambos Marcam' AND m.selecao = 'Sim'   THEN 1 ELSE 0 END) AS btts
            FROM bet365_resultados_mercados m
            WHERE m.liga = @liga
              AND m.evento_id IN (
                  SELECT TOP (@nJogos) evento_id
                  FROM bet365_resultados_mercados
                  WHERE liga = @liga
                  GROUP BY evento_id
                  ORDER BY MAX(data_partida) DESC
              )
            GROUP BY m.evento_id, m.data_partida
            ORDER BY m.data_partida DESC
        `;

        const ligaDados = await Promise.all(
            ligasInfo.map(({ liga }) =>
                pool.request()
                    .input('liga',   sql.NVarChar(200), liga)
                    .input('nJogos', sql.Int,           nJogosN)
                    .query(PER_LIGA_SQL)
                    .then(r => ({ liga, rows: r.recordset }))
                    .catch(() => ({ liga, rows: [] }))
            )
        );

        // Monta byLiga usando os totais já calculados no passo 1
        const byLiga = new Map();
        for (const { liga, rows } of ligaDados) {
            if (rows.length === 0) continue;
            const total_liga = totalByLiga.get(liga) || rows.length;
            byLiga.set(liga, {
                total_liga,
                rows: rows.map(r => ({ ...r, liga, total_liga }))
            });
        }

        const FILTROS = [
            { id: 'over0.5',   label: 'Mais de 0.5',     check: j => j.over05 },
            { id: 'over1.5',   label: 'Mais de 1.5',     check: j => j.over15 },
            { id: 'over2.5',   label: 'Mais de 2.5',     check: j => j.over25 },
            { id: 'over3.5',   label: 'Mais de 3.5',     check: j => j.over35 },
            { id: 'under1.5',  label: 'Menos de 1.5',    check: j => j.under15 },
            { id: 'under2.5',  label: 'Menos de 2.5',    check: j => j.under25 },
            { id: 'ambas',     label: 'Ambas Marcam',     check: j => j.btts },
            { id: 'ft_casa',   label: 'Casa Vence',       check: j => j.resultado === 'CASA' },
            { id: 'ft_empate', label: 'Empate',           check: j => j.resultado === 'EMPATE' },
            { id: 'ft_fora',   label: 'Fora Vence',       check: j => j.resultado === 'FORA' },
            { id: 'btts_o25',  label: 'BTTS + Mais 2.5', check: j => j.btts && j.over25 },
        ];

        const resultado = [];
        for (const [ligaNome, { total_liga, rows }] of byLiga) {
            const partidas = rows.map(p => ({
                over05:  p.over05  === 1,
                over15:  p.over15  === 1,
                over25:  p.over25  === 1,
                over35:  p.over35  === 1,
                under15: p.under15 === 1,
                under25: p.under25 === 1,
                btts:    p.btts    === 1,
                resultado: p.resultado_final === p.time_casa ? 'CASA'
                         : p.resultado_final === p.time_fora ? 'FORA' : 'EMPATE',
            }));
            if (partidas.length < 5) continue;

            const n = partidas.length;
            const filtroStats = FILTROS.map(f => {
                const nN = Math.min(nJogosN, n), n5 = Math.min(5,n), n10 = Math.min(10,n), n20 = Math.min(20,n);
                const hGeral = partidas.filter(f.check).length;
                const hN  = partidas.slice(0, nN).filter(f.check).length;
                const h5  = partidas.slice(0, n5).filter(f.check).length;
                const h10 = partidas.slice(0, n10).filter(f.check).length;
                const h20 = partidas.slice(0, n20).filter(f.check).length;
                const txGeral = +(hGeral/n*100).toFixed(1);
                const txN = +(hN/nN*100).toFixed(1), tx5 = +(h5/n5*100).toFixed(1);
                const tx10 = +(h10/n10*100).toFixed(1), tx20 = +(h20/n20*100).toFixed(1);
                let streak = 0;
                const streakTipo = f.check(partidas[0]) ? 'verde' : 'vermelho';
                for (let i = 0; i < Math.min(30, n); i++) {
                    if (f.check(partidas[i]) === (streakTipo === 'verde')) streak++; else break;
                }
                const diff = txN - txGeral;
                return {
                    id: f.id, label: f.label,
                    tx_geral: txGeral, tx_ultn: txN, tx_ult5: tx5, tx_ult10: tx10, tx_ult20: tx20,
                    n_custom: nN, streak, streak_tipo: streakTipo,
                    tendencia: diff > 8 ? 'subindo' : diff < -8 ? 'caindo' : 'estavel',
                    confianca: (txN >= 65 && nN >= 10) ? 'alta' : (txN >= 55 && nN >= 5) ? 'media' : 'baixa',
                    amostras: n
                };
            });
            filtroStats.sort((a, b) => b.tx_ultn - a.tx_ultn);

            const pctCasa   = +(partidas.filter(p => p.resultado === 'CASA').length   / n * 100).toFixed(1);
            const pctEmpate = +(partidas.filter(p => p.resultado === 'EMPATE').length / n * 100).toFixed(1);
            const pctFora   = +(partidas.filter(p => p.resultado === 'FORA').length   / n * 100).toFixed(1);
            const pctAmbas  = +(partidas.filter(p => p.btts).length  / n * 100).toFixed(1);
            const pctO15    = +(partidas.filter(p => p.over15).length / n * 100).toFixed(1);
            const pctO25    = +(partidas.filter(p => p.over25).length / n * 100).toFixed(1);
            const mediaGols = +(
                partidas.reduce((s, p) => s + (!p.over05 ? 0 : !p.over15 ? 1 : !p.over25 ? 2 : !p.over35 ? 3 : 4), 0) / n
            ).toFixed(2);

            resultado.push({
                liga: ligaNome, total: total_liga, amostras: n,
                stats: { mediaGols, pctCasa, pctEmpate, pctFora, pctAmbas, pctO15, pctO25 },
                filtros: filtroStats, melhor: filtroStats[0] || null,
            });
        }

        res.json({ success: true, timestamp: new Date().toISOString(), data: resultado });

    } catch (error) {
        console.error('❌ ERRO API bet365/sugestoes:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/bet365/buscar-resultados
 * Verifica eventos passados sem mercados na bet365_resultados_mercados.
 * O coletor é responsável por salvar os mercados — este endpoint apenas diagnostica pendências.
 */
router.post('/buscar-resultados', async (req, res) => {
    try {
        const pool = await getDbPool();

        // Eventos que deveriam ter terminado mas não têm nenhum mercado salvo
        const pendentes = await pool.query(`
            SELECT TOP 30
                e.id, e.time_casa, e.time_fora, e.league_name,
                e.start_time_datetime,
                DATEDIFF(MINUTE, e.start_time_datetime, GETDATE()) AS minutos_atras
            FROM bet365_eventos e
            WHERE e.start_time_datetime < DATEADD(MINUTE, -10, GETDATE())
              AND e.time_casa <> '' AND e.time_fora <> ''
              AND NOT EXISTS (
                  SELECT 1 FROM bet365_resultados_mercados m
                  WHERE m.evento_id = e.id
              )
            ORDER BY e.start_time_datetime ASC
        `);

        const salvos = 0; // não salva mais — aguarda próxima coleta pelo coletor
        res.json({
            success: true,
            encontrados: pendentes.recordset.length,
            salvos,
            msg: pendentes.recordset.length === 0
                ? 'Nenhum evento pendente — todos com mercados coletados'
                : `${pendentes.recordset.length} evento(s) aguardando próxima coleta do coletor`,
            pendentes: pendentes.recordset.map(e => ({
                id: e.id, time_casa: e.time_casa, time_fora: e.time_fora,
                liga: e.league_name, minutos_atras: e.minutos_atras
            }))
        });

    } catch (err) {
        console.error('❌ ERRO API bet365/buscar-resultados:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/bet365/estatisticas-avancadas
 * Estatísticas agregadas do histórico
 */
router.get('/estatisticas-avancadas', async (req, res) => {
    try {
        const pool = await getDbPool();

        // 1. Eventos ao vivo/agendados + médias de odds dos agendados
        const statsEventos = await pool.query(`
            SELECT
                COUNT(*) AS total_eventos,
                SUM(CASE WHEN status = 'EM_ANDAMENTO' THEN 1 ELSE 0 END) AS ao_vivo,
                SUM(CASE WHEN status = 'AGENDADO'     THEN 1 ELSE 0 END) AS agendados,
                AVG(CASE WHEN status='AGENDADO' AND odd_casa   >0 THEN CAST(odd_casa   AS FLOAT) END) AS media_odd_casa,
                AVG(CASE WHEN status='AGENDADO' AND odd_empate >0 THEN CAST(odd_empate AS FLOAT) END) AS media_odd_empate,
                AVG(CASE WHEN status='AGENDADO' AND odd_fora   >0 THEN CAST(odd_fora   AS FLOAT) END) AS media_odd_fora
            FROM bet365_eventos WHERE ativo = 1
        `);

        // 2. Estatísticas gerais do histórico — usa TODOS os registros com resultado real
        // Estatísticas gerais de bet365_resultados_mercados
        const [statsHistorico, topSelecoes, performanceLiga, distribuicaoGols] = await Promise.all([
            pool.query(`
                SELECT
                    COUNT(DISTINCT evento_id) AS total_partidas,
                    COUNT(DISTINCT CASE WHEN mercado='Resultado Final' THEN evento_id END)*100.0/NULLIF(COUNT(DISTINCT evento_id),0) AS pct_com_resultado,
                    COUNT(DISTINCT CASE WHEN mercado='Ambos Marcam' AND selecao='Sim' THEN evento_id END)*100.0/NULLIF(COUNT(DISTINCT CASE WHEN mercado='Ambos Marcam' THEN evento_id END),0) AS pct_btts,
                    COUNT(DISTINCT CASE WHEN mercado LIKE '%1.5%' AND selecao LIKE 'Mais%' THEN evento_id END)*100.0/NULLIF(COUNT(DISTINCT CASE WHEN mercado LIKE '%1.5%' THEN evento_id END),0) AS pct_over15,
                    COUNT(DISTINCT CASE WHEN mercado LIKE '%2.5%' AND selecao LIKE 'Mais%' THEN evento_id END)*100.0/NULLIF(COUNT(DISTINCT CASE WHEN mercado LIKE '%2.5%' THEN evento_id END),0) AS pct_over25,
                    COUNT(DISTINCT CASE WHEN mercado LIKE '%3.5%' AND selecao LIKE 'Mais%' THEN evento_id END)*100.0/NULLIF(COUNT(DISTINCT CASE WHEN mercado LIKE '%3.5%' THEN evento_id END),0) AS pct_over35,
                    COUNT(DISTINCT CASE WHEN mercado LIKE '%4.5%' AND selecao LIKE 'Mais%' THEN evento_id END)*100.0/NULLIF(COUNT(DISTINCT CASE WHEN mercado LIKE '%4.5%' THEN evento_id END),0) AS pct_over45,
                    COUNT(DISTINCT CASE WHEN mercado='Resultado Final' AND selecao=time_casa  THEN evento_id END)*100.0/NULLIF(COUNT(DISTINCT CASE WHEN mercado='Resultado Final' THEN evento_id END),0) AS pct_casa,
                    COUNT(DISTINCT CASE WHEN mercado='Resultado Final' AND selecao='Empate'   THEN evento_id END)*100.0/NULLIF(COUNT(DISTINCT CASE WHEN mercado='Resultado Final' THEN evento_id END),0) AS pct_empate,
                    COUNT(DISTINCT CASE WHEN mercado='Resultado Final' AND selecao=time_fora  THEN evento_id END)*100.0/NULLIF(COUNT(DISTINCT CASE WHEN mercado='Resultado Final' THEN evento_id END),0) AS pct_fora
                FROM bet365_resultados_mercados
            `),
            pool.query(`
                SELECT TOP 8 selecao AS placar, COUNT(*) AS frequencia
                FROM bet365_resultados_mercados
                WHERE mercado = 'Resultado Correto'
                GROUP BY selecao
                ORDER BY COUNT(*) DESC
            `),
            pool.query(`
                SELECT liga,
                    COUNT(DISTINCT evento_id) AS total_jogos,
                    COUNT(DISTINCT CASE WHEN mercado='Resultado Final' THEN evento_id END) AS com_resultado,
                    COUNT(DISTINCT CASE WHEN mercado LIKE '%1.5%' AND selecao LIKE 'Mais%' THEN evento_id END)*100.0/NULLIF(COUNT(DISTINCT CASE WHEN mercado LIKE '%1.5%' THEN evento_id END),0) AS pct_over15,
                    COUNT(DISTINCT CASE WHEN mercado LIKE '%2.5%' AND selecao LIKE 'Mais%' THEN evento_id END)*100.0/NULLIF(COUNT(DISTINCT CASE WHEN mercado LIKE '%2.5%' THEN evento_id END),0) AS pct_over25,
                    COUNT(DISTINCT CASE WHEN mercado='Ambos Marcam' AND selecao='Sim' THEN evento_id END)*100.0/NULLIF(COUNT(DISTINCT CASE WHEN mercado='Ambos Marcam' THEN evento_id END),0) AS pct_btts,
                    COUNT(DISTINCT CASE WHEN mercado='Resultado Final' AND selecao=time_casa THEN evento_id END)*100.0/NULLIF(COUNT(DISTINCT CASE WHEN mercado='Resultado Final' THEN evento_id END),0) AS pct_casa,
                    COUNT(DISTINCT CASE WHEN mercado='Resultado Final' AND selecao='Empate'  THEN evento_id END)*100.0/NULLIF(COUNT(DISTINCT CASE WHEN mercado='Resultado Final' THEN evento_id END),0) AS pct_empate,
                    COUNT(DISTINCT CASE WHEN mercado='Resultado Final' AND selecao=time_fora THEN evento_id END)*100.0/NULLIF(COUNT(DISTINCT CASE WHEN mercado='Resultado Final' THEN evento_id END),0) AS pct_fora,
                    -- media_gols: E[X] = sum P(>n) para n=0..4 (identidade matemática)
                    ISNULL(COUNT(DISTINCT CASE WHEN mercado LIKE '%0.5%' AND selecao LIKE 'Mais%' THEN evento_id END)*1.0/NULLIF(COUNT(DISTINCT CASE WHEN mercado LIKE '%0.5%' THEN evento_id END),0),0)
                  + ISNULL(COUNT(DISTINCT CASE WHEN mercado LIKE '%1.5%' AND selecao LIKE 'Mais%' THEN evento_id END)*1.0/NULLIF(COUNT(DISTINCT CASE WHEN mercado LIKE '%1.5%' THEN evento_id END),0),0)
                  + ISNULL(COUNT(DISTINCT CASE WHEN mercado LIKE '%2.5%' AND selecao LIKE 'Mais%' THEN evento_id END)*1.0/NULLIF(COUNT(DISTINCT CASE WHEN mercado LIKE '%2.5%' THEN evento_id END),0),0)
                  + ISNULL(COUNT(DISTINCT CASE WHEN mercado LIKE '%3.5%' AND selecao LIKE 'Mais%' THEN evento_id END)*1.0/NULLIF(COUNT(DISTINCT CASE WHEN mercado LIKE '%3.5%' THEN evento_id END),0),0)
                  + ISNULL(COUNT(DISTINCT CASE WHEN mercado LIKE '%4.5%' AND selecao LIKE 'Mais%' THEN evento_id END)*1.0/NULLIF(COUNT(DISTINCT CASE WHEN mercado LIKE '%4.5%' THEN evento_id END),0),0) AS media_gols
                FROM bet365_resultados_mercados
                WHERE liga IS NOT NULL AND liga <> ''
                GROUP BY liga ORDER BY total_jogos DESC
            `),
            pool.query(`
                WITH per_game AS (
                    SELECT evento_id,
                        MAX(CASE WHEN mercado LIKE '%0.5%' AND selecao LIKE 'Mais%' THEN 1 ELSE 0 END) AS o05,
                        MAX(CASE WHEN mercado LIKE '%1.5%' AND selecao LIKE 'Mais%' THEN 1 ELSE 0 END) AS o15,
                        MAX(CASE WHEN mercado LIKE '%2.5%' AND selecao LIKE 'Mais%' THEN 1 ELSE 0 END) AS o25,
                        MAX(CASE WHEN mercado LIKE '%3.5%' AND selecao LIKE 'Mais%' THEN 1 ELSE 0 END) AS o35
                    FROM bet365_resultados_mercados
                    WHERE mercado LIKE '%0.5%' OR mercado LIKE '%1.5%' OR mercado LIKE '%2.5%' OR mercado LIKE '%3.5%'
                    GROUP BY evento_id
                )
                SELECT
                    CASE WHEN o05=0 THEN 0 WHEN o15=0 THEN 1 WHEN o25=0 THEN 2 WHEN o35=0 THEN 3 ELSE 4 END AS total_gols,
                    COUNT(*) AS quantidade
                FROM per_game
                GROUP BY CASE WHEN o05=0 THEN 0 WHEN o15=0 THEN 1 WHEN o25=0 THEN 2 WHEN o35=0 THEN 3 ELSE 4 END
                ORDER BY total_gols
            `)
        ]);

        // Deriva media_gols a partir da distribuicaoGols (0,1,2,3,4+ gols por jogo)
        const dgRows   = distribuicaoGols.recordset.filter(r => r.total_gols !== null);
        const totalJ   = dgRows.reduce((s, r) => s + r.quantidade, 0);
        const totalG   = dgRows.reduce((s, r) => s + r.total_gols * r.quantidade, 0);
        const mediaGols = totalJ > 0 ? +(totalG / totalJ).toFixed(2) : 0;

        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            data: {
                gerais: Object.assign({}, statsEventos.recordset[0], statsHistorico.recordset[0], { media_gols: mediaGols }),
                topPlacares:      topSelecoes.recordset,
                performanceLiga:  performanceLiga.recordset,
                distribuicaoGols: dgRows,
            }
        });

    } catch (error) {
        console.error('❌ ERRO API bet365/estatisticas-avancadas:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/bet365/log-coleta
 * Retorna os últimos logs de coleta para o painel de diagnóstico
 */
router.get('/log-coleta', async (req, res) => {
    try {
        const pool  = await getDbPool();
        const limit = req.query.limit !== undefined ? parseInt(req.query.limit) : 20; // 0 = todos, undefined = default 20
        const dia   = req.query.dia || '';               // 'YYYY-MM-DD' ou vazio

        let whereClause = '';
        const request = pool.request();

        if (dia) {
            whereClause = `WHERE CAST(data_inicio AS DATE) = @dia`;
            request.input('dia', dia);
        }

        const topClause = limit > 0 ? `TOP ${limit}` : '';

        const result = await request.query(`
            SELECT ${topClause}
                data_inicio, data_fim, status,
                eventos_coletados, mercados_coletados,
                odds_coletadas, resultados_salvos, erro_mensagem,
                DATEDIFF(SECOND, data_inicio, ISNULL(data_fim, data_inicio)) AS duracao_seg
            FROM bet365_log_coleta
            ${whereClause}
            ORDER BY data_inicio DESC
        `);
        res.json({ success: true, data: result.recordset });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/bet365/limpar-ligas-descartadas
 * Remove eventos e mercados de ligas descartadas ('Super League', 'South American Super League')
 */
router.post('/limpar-ligas-descartadas', async (req, res) => {
    try {
        const pool = await getDbPool();

        const resultMkt = await pool.request().query(`
            DELETE FROM bet365_resultados_mercados
            WHERE liga IN ('Super League', 'South American Super League')
        `);
        const removidosMkt = resultMkt.rowsAffected?.[0] ?? 0;

        const resultEvt = await pool.request().query(`
            DELETE FROM bet365_eventos
            WHERE league_name IN ('Super League', 'South American Super League')
        `);
        const removidosEvt = resultEvt.rowsAffected?.[0] ?? 0;

        res.json({ success: true, mercados_removidos: removidosMkt, eventos_removidos: removidosEvt,
            message: (removidosMkt + removidosEvt) === 0 ? 'Banco já está limpo.' : 'Limpeza concluída.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// reparar-datas e limpar-ligas-erradas foram removidos — operavam sobre bet365_historico_partidas (descontinuada)

/**
 * GET /api/bet365/historico-mercados
 * Retorna partidas históricas agrupadas por evento_id a partir de bet365_resultados_mercados
 * (fonte única de verdade — substitui historico-tabela que usava bet365_historico_partidas)
 */
router.get('/historico-mercados', async (req, res) => {
    try {
        const { liga, horas = 24, incluirFuturos = 'false' } = req.query;
        const horasNum = Math.min(Math.max(parseInt(horas) || 24, 1), 720);
        const comFuturos = incluirFuturos === 'true';
        const pool = await getDbPool();

        const request = pool.request();
        request.input('horas', sql.Int, horasNum);

        let query = `
            SELECT m.evento_id, m.liga, m.time_casa, m.time_fora, m.data_partida,
                   m.mercado, m.selecao, CAST(m.odd_paga AS FLOAT) AS odd_paga, m.data_registro,
                   e.odd_casa, e.odd_empate, e.odd_fora
            FROM bet365_resultados_mercados m
            LEFT JOIN bet365_eventos e ON e.id = m.evento_id
            WHERE m.data_partida >= DATEADD(HOUR, -@horas, GETUTCDATE())
              AND m.data_partida <= DATEADD(HOUR, 2, GETUTCDATE())
        `;

        if (liga && liga !== 'all') {
            query += ' AND m.liga LIKE @liga';
            request.input('liga', sql.NVarChar(200), `%${ligaParaBanco(liga)}%`);
        }

        // data_registro DESC garante que linhas mais recentes (resultado final real) venham
        // primeiro ao iterar mkts — evita retornar placar intermediário de jogo em andamento
        query += ' ORDER BY m.data_partida ASC, m.evento_id, m.data_registro DESC';

        const result = await request.query(query);

        // Agrupa por evento_id + minuto do data_partida.
        // O mesmo evento_id pode ter data_partida diferentes quando o coletor associa
        // erroneamente o resultado de um jogo ao evento de outro jogo com os mesmos times
        // em horário diferente. A chave composta garante que cada slot de tempo gera
        // uma entrada separada, evitando que o jogo apareça no bucket de hora errado.
        const gamesMap = new Map();
        for (const r of result.recordset) {
            const minuteKey = new Date(r.data_partida).toISOString().substring(0, 16);
            const key = `${r.evento_id}|${minuteKey}`;
            if (!gamesMap.has(key)) {
                gamesMap.set(key, {
                    evento_id:    r.evento_id,
                    liga:         r.liga,
                    time_casa:    r.time_casa,
                    time_fora:    r.time_fora,
                    data_partida: r.data_partida,
                    mercados:     [],
                    gol_casa:     null,
                    gol_fora:     null,
                    gol_casa_ht:  null,
                    gol_fora_ht:  null,
                    resultado:    null,
                    odd_casa:     parseFloat(r.odd_casa) || 0,
                    odd_fora:     parseFloat(r.odd_fora) || 0,
                    odd_empate:   parseFloat(r.odd_empate) || 0,
                });
            }
            gamesMap.get(key).mercados.push({
                mercado:  r.mercado,
                selecao:  r.selecao,
                odd_paga: r.odd_paga || 0
            });
        }

        // Deriva campos adicionais de cada partida a partir dos mercados
        for (const j of gamesMap.values()) {
            const mkts = j.mercados;

            // Resultado FT — "Resultado Final": selecao = nome do time vencedor ou "Empate"
            // Pode haver múltiplas linhas de "Resultado Final" por evento (bug corrigido de pré-odds);
            // prioriza a linha cujo selecao coincide com time_casa ou time_fora (resultado real).
            const rfMkts = mkts.filter(m => /resultado final/i.test(m.mercado));
            let rfMkt = rfMkts[0] || null;
            if (rfMkts.length > 1) {
                // Tenta confirmar pelo Resultado Correto FT (mais confiável)
                const ftCorMkt = mkts.find(m => /resultado correto/i.test(m.mercado) && !/intervalo/i.test(m.mercado));
                if (ftCorMkt) {
                    const sc = (() => {
                        const m2 = (ftCorMkt.selecao||'').match(/(\d+)\s*[-–]\s*(\d+)\s*$/);
                        if (!m2) return null;
                        const n = parseInt(m2[1]), k = parseInt(m2[2]);
                        const sf = (j.time_fora||'').toLowerCase().trim();
                        if (sf && (ftCorMkt.selecao||'').toLowerCase().startsWith(sf)) return { casa: k, fora: n };
                        return { casa: n, fora: k };
                    })();
                    if (sc) {
                        const winner = sc.casa > sc.fora ? j.time_casa : sc.fora > sc.casa ? j.time_fora : 'Empate';
                        const confirmed = rfMkts.find(r => r.selecao === winner);
                        if (confirmed) rfMkt = confirmed;
                    }
                } else {
                    // Sem Resultado Correto: pega o único RF que bate com um dos times
                    const single = rfMkts.find(r => r.selecao === j.time_casa || r.selecao === j.time_fora || r.selecao === 'Empate');
                    // Se só houver 1 que bate com time, usa ele; caso ambos batam escolhe o primeiro
                    if (single) rfMkt = single;
                }
            }
            if (rfMkt) {
                j.resultado = rfMkt.selecao === j.time_casa ? 'CASA'
                            : rfMkt.selecao === j.time_fora ? 'FORA' : 'EMPATE';
                if (j.resultado === 'CASA')        j.odd_casa   = rfMkt.odd_paga;
                else if (j.resultado === 'FORA')   j.odd_fora   = rfMkt.odd_paga;
                else                               j.odd_empate = rfMkt.odd_paga;
            }

            // Helper: "TeamName N-M" ou "Empate N-M" → { casa, fora }
            // Formato Bet365: o vencedor aparece primeiro, depois N-M onde N=gols_vencedor, M=gols_perdedor
            const parseSelecaoScore = (selecao) => {
                if (!selecao) return null;
                const m = selecao.match(/(\d+)\s*[-–]\s*(\d+)\s*$/);
                if (!m) return null;
                const n = parseInt(m[1]), k = parseInt(m[2]);
                const s   = selecao.toLowerCase().trim();
                const tf  = (j.time_fora || '').toLowerCase().trim();
                // Se a seleção começa com o nome do time visitante: N=gols_fora, K=gols_casa
                if (tf && s.startsWith(tf)) return { casa: k, fora: n };
                // Caso contrário (time da casa venceu, ou "Empate"): N=gols_casa, K=gols_fora
                return { casa: n, fora: k };
            };

            // Placar HT de "Resultado Correto - Intervalo"
            // Usa "Resultado Intervalo" (mercado simples, 1 linha) para confirmar qual linha é a correta
            const htInterMkt = mkts.find(m => /^resultado\s+intervalo$/i.test(m.mercado.trim()));
            const htCorMkts  = mkts.filter(m => /correto.*intervalo|intervalo.*correto/i.test(m.mercado));
            let htMkt = htCorMkts[0] || null;
            if (htCorMkts.length > 1 && htInterMkt) {
                // htInterMkt.selecao = "Empate" | time_casa | time_fora
                const htWinner = (htInterMkt.selecao || '').toLowerCase().trim();
                const casaLow  = (j.time_casa || '').toLowerCase().trim();
                const foraLow  = (j.time_fora || '').toLowerCase().trim();
                let confirmed;
                if (htWinner === 'empate') {
                    confirmed = htCorMkts.find(m => /^empate/i.test(m.selecao));
                } else if (casaLow && htWinner.includes(casaLow)) {
                    confirmed = htCorMkts.find(m => {
                        const sl = (m.selecao || '').toLowerCase().trim();
                        return sl.startsWith(casaLow);
                    });
                } else if (foraLow && htWinner.includes(foraLow)) {
                    confirmed = htCorMkts.find(m => {
                        const sl = (m.selecao || '').toLowerCase().trim();
                        return sl.startsWith(foraLow);
                    });
                }
                if (confirmed) htMkt = confirmed;
            }
            if (htMkt) {
                if (/qualquer outro resultado/i.test(htMkt.selecao)) {
                    j.ht_outro = true; // HT teve 3+ gols — exibe "OUT" no frontend
                } else {
                    const sc = parseSelecaoScore(htMkt.selecao);
                    if (sc) { j.gol_casa_ht = sc.casa; j.gol_fora_ht = sc.fora; }
                }
            }
            // resultado_ht: direção do HT (CASA/FORA/EMPATE) — derivado do placar quando disponível,
            // ou de htInterMkt ("Resultado Intervalo") como fallback para placares "OUT"
            if (j.gol_casa_ht != null && j.gol_fora_ht != null) {
                j.resultado_ht = j.gol_casa_ht > j.gol_fora_ht ? 'CASA' : j.gol_fora_ht > j.gol_casa_ht ? 'FORA' : 'EMPATE';
            } else if (htInterMkt) {
                const htW = (htInterMkt.selecao || '').toLowerCase().trim();
                const cL  = (j.time_casa || '').toLowerCase().trim();
                const fL  = (j.time_fora || '').toLowerCase().trim();
                if (htW === 'empate') j.resultado_ht = 'EMPATE';
                else if (cL && htW.includes(cL)) j.resultado_ht = 'CASA';
                else if (fL && htW.includes(fL)) j.resultado_ht = 'FORA';
            }

            // Placar FT de "Resultado Correto" (sem "Intervalo")
            // Usa rfMkt.selecao (já confirmado) para escolher a linha correta quando houver múltiplas
            const ftCorMkts = mkts.filter(m => /resultado correto/i.test(m.mercado) && !/intervalo/i.test(m.mercado));
            let ftCorMkt = ftCorMkts[0] || null;
            if (ftCorMkts.length > 1 && rfMkt) {
                const winner = (rfMkt.selecao || '').toLowerCase().trim();
                const casaLow = (j.time_casa || '').toLowerCase().trim();
                const foraLow = (j.time_fora || '').toLowerCase().trim();
                let confirmed;
                if (winner === 'empate') {
                    confirmed = ftCorMkts.find(m => /^empate/i.test(m.selecao));
                } else if (casaLow && winner.includes(casaLow)) {
                    confirmed = ftCorMkts.find(m => {
                        const sl = (m.selecao || '').toLowerCase().trim();
                        return sl.startsWith(casaLow);
                    });
                } else if (foraLow && winner.includes(foraLow)) {
                    confirmed = ftCorMkts.find(m => {
                        const sl = (m.selecao || '').toLowerCase().trim();
                        return sl.startsWith(foraLow);
                    });
                }
                if (confirmed) ftCorMkt = confirmed;
            }
            if (ftCorMkt) {
                const sc = parseSelecaoScore(ftCorMkt.selecao);
                if (sc) { j.gol_casa = sc.casa; j.gol_fora = sc.fora; }
            }

            // Fallback FT: "Time - Gols" → placar exato por time (ex: "Equador - 3 Gols")
            if (j.gol_casa === null) {
                const tgMkts = mkts.filter(m => /time\s*-\s*gols/i.test(m.mercado));
                for (const tg of tgMkts) {
                    const numMatch = (tg.selecao || '').match(/(\d+)\+?\s*gol/i);
                    if (!numMatch) continue;
                    const gols = parseInt(numMatch[1]);
                    const selLow  = (tg.selecao || '').toLowerCase().trim();
                    const casaLow = (j.time_casa || '').toLowerCase().trim();
                    const foraLow = (j.time_fora || '').toLowerCase().trim();
                    if (casaLow && selLow.startsWith(casaLow)) j.gol_casa = gols;
                    else if (foraLow && selLow.startsWith(foraLow)) j.gol_fora = gols;
                }
                if (j.gol_casa !== null && j.gol_fora !== null) {
                    j.total_gols = j.gol_casa + j.gol_fora;
                }
            }

            // Deriva total_gols para exibição quando placar exato não disponível
            if (j.gol_casa === null) {
                // 1ª prioridade: "Total Exato de Gols" (mais preciso)
                const texMkt = mkts.find(m => /total exato de gols/i.test(m.mercado));
                if (texMkt) {
                    const sel = texMkt.selecao || '';
                    if (/5\+/i.test(sel))        j.total_gols = 5;
                    else if (/4 gol/i.test(sel)) j.total_gols = 4;
                    else if (/3 gol/i.test(sel)) j.total_gols = 3;
                    else if (/2 gol/i.test(sel)) j.total_gols = 2;
                    else if (/1 gol/i.test(sel)) j.total_gols = 1;
                    else if (/0 gol/i.test(sel)) j.total_gols = 0;
                }
                // 2ª prioridade: Over/Under (aproximação)
                if (j.total_gols == null) {
                    const o05 = mkts.some(m => m.mercado.includes('0.5') && m.selecao.startsWith('Mais'));
                    const o15 = mkts.some(m => m.mercado.includes('1.5') && m.selecao.startsWith('Mais'));
                    const o25 = mkts.some(m => m.mercado.includes('2.5') && m.selecao.startsWith('Mais'));
                    const o35 = mkts.some(m => m.mercado.includes('3.5') && m.selecao.startsWith('Mais'));
                    const o45 = mkts.some(m => m.mercado.includes('4.5') && m.selecao.startsWith('Mais'));
                    j.total_gols = !o05 ? 0 : !o15 ? 1 : !o25 ? 2 : !o35 ? 3 : !o45 ? 4 : 5;
                }
            }
        }

        const partidas = [...gamesMap.values()];

        // Ligas distintas com contagem
        const ligasMap = {};
        for (const j of partidas) {
            ligasMap[j.liga] = (ligasMap[j.liga] || 0) + 1;
        }
        const ligas = Object.entries(ligasMap)
            .map(([l, total]) => ({ liga: l, total }))
            .sort((a, b) => b.total - a.total);

        res.json({ success: true, total: partidas.length, horas: horasNum, ligas, partidas });
    } catch (error) {
        console.error('❌ ERRO API bet365/historico-mercados:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/bet365/analise/mercados
 * Frequência e valor esperado de cada mercado/seleção por liga
 * ?liga=Euro Cup&dias=7&minJogos=5&minPct=0&tipoMercado=Gols&soValueBets=0&minVE=0
 */
router.get('/analise/mercados', async (req, res) => {
    try {
        const {
            liga,
            nJogos     = 200,
            minJogos   = 3,
            minPct     = 0,
            tipoMercado = '',
            soValueBets = '0',
            minVE      = 0,
        } = req.query;

        const nJogosN   = Math.min(420, Math.max(20, parseInt(nJogos) || 200));
        const minJogosN = Math.max(1, parseInt(minJogos) || 3);
        const minPctN   = Math.max(0, parseFloat(minPct)  || 0);
        const minVEN    = Math.max(0, parseFloat(minVE)   || 0);
        const pool      = await getDbPool();
        const request   = pool.request()
            .input('nJogos',    sql.Int,   nJogosN)
            .input('minJogos',  sql.Int,   minJogosN)
            .input('minPct',    sql.Float, minPctN)
            .input('minVE',     sql.Float, minVEN);

        const whereParts = [];
        if (liga && liga !== 'all') {
            request.input('liga', sql.NVarChar(200), ligaParaBanco(liga));
            whereParts.push('m.liga = @liga');
            whereParts.push(`m.evento_id IN (
                SELECT TOP (@nJogos) evento_id
                FROM bet365_resultados_mercados
                WHERE liga = @liga
                GROUP BY evento_id
                ORDER BY MAX(data_partida) DESC
            )`);
        } else {
            whereParts.push(`m.evento_id IN (
                SELECT evento_id FROM (
                    SELECT evento_id,
                           ROW_NUMBER() OVER (PARTITION BY liga ORDER BY MAX(data_partida) DESC) AS rn
                    FROM bet365_resultados_mercados
                    GROUP BY liga, evento_id
                ) t WHERE t.rn <= @nJogos
            )`);
        }
        if (tipoMercado && tipoMercado !== 'Todos') {
            // mapeia rótulos amigáveis para palavras-chave SQL
            const mktMap = {
                'Gols':       'Total de Gols',
                'Resultado':  'Resultado Final',
                'Ambas':      'Ambos Marcam',
                'Intervalo':  'Intervalo',
                'Handicap':   'Handicap',
                'Correto':    'Resultado Correto',
                'Chance':     'Chance Dupla',
            };
            const kw = mktMap[tipoMercado] || tipoMercado;
            request.input('tipoMercado', sql.NVarChar(200), `%${kw}%`);
            whereParts.push('m.mercado LIKE @tipoMercado');
        }

        const whereClause = whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : '';

        // ── Denominador CORRETO: total de jogos com aquele mercado na liga
        // (window function SUM OVER PARTITION) — NOT COUNT(evento_id) por seleção
        // que dá sempre 100% pois cada jogo só registra a seleção vencedora.
        const havingMinVE  = minVEN  > 0     ? `AND ve_raw >= @minVE`   : '';
        const havingVB     = soValueBets === '1' ? `AND ve_raw >= 0.95`  : '';

        const result = await request.query(`
            WITH base AS (
                SELECT
                    m.liga,
                    m.mercado,
                    m.selecao,
                    COUNT(*)                                             AS vezes,
                    SUM(COUNT(*)) OVER (PARTITION BY m.liga, m.mercado) AS total_jogos,
                    AVG(CAST(m.odd_paga AS FLOAT))                      AS odd_media_f
                FROM bet365_resultados_mercados m
                ${whereClause}
                GROUP BY m.liga, m.mercado, m.selecao
            ),
            calc AS (
                SELECT *,
                    vezes * 100.0 / NULLIF(total_jogos, 0)             AS pct_raw,
                    (vezes * 1.0  / NULLIF(total_jogos, 0)) * odd_media_f AS ve_raw
                FROM base
                WHERE total_jogos >= @minJogos
            )
            SELECT
                liga, mercado, selecao, vezes, total_jogos,
                CAST(odd_media_f  AS DECIMAL(7,2))  AS odd_media,
                CAST(pct_raw      AS DECIMAL(6,1))  AS pct_jogos,
                CAST(ve_raw       AS DECIMAL(8,3))  AS ve
            FROM calc
            WHERE pct_raw >= @minPct
              ${havingMinVE} ${havingVB}
            ORDER BY liga, mercado, pct_raw DESC
        `);

        // Agrupa por liga → mercado → seleções
        // Normaliza nomes de liga para canônicos (o banco armazena raw, o frontend espera canônico)
        const LIGA_DB_TO_CANONICAL = { 'World Cup': 'Copa do Mundo', 'Premiership': 'Premier League' };
        const agrupado = {};
        for (const r of result.recordset) {
            const ligaCanon = LIGA_DB_TO_CANONICAL[r.liga] || r.liga;
            if (!agrupado[ligaCanon]) agrupado[ligaCanon] = {};
            if (!agrupado[ligaCanon][r.mercado]) agrupado[ligaCanon][r.mercado] = [];
            agrupado[ligaCanon][r.mercado].push({
                selecao:        r.selecao,
                vezes:          r.vezes,
                total_jogos:    r.total_jogos,
                pct_jogos:      parseFloat(r.pct_jogos),
                odd_media:      parseFloat(r.odd_media || 0),
                valor_esperado: parseFloat(r.ve || 0),
                value_bet:      parseFloat(r.ve || 0) >= 0.95
            });
        }

        res.json({ success: true, nJogos: nJogosN, filtros: { minJogos: minJogosN, minPct: minPctN, tipoMercado, soValueBets }, data: agrupado });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/bet365/analise/tendencias
 * Compara frequência recente vs histórico total por liga+mercado
 * ?liga=Premiership&nRecente=20&minJogosHist=10&minJogosRec=5&minVariacao=10
 */
router.get('/analise/tendencias', async (req, res) => {
    try {
        const {
            liga,
            nJogos       = 200, // alias para nRecente
            nRecente,
            minJogosHist = 10,
            minJogosRec  = 5,
            minVariacao  = 10,
        } = req.query;

        const nRecenteN     = Math.max(5, parseInt(nJogos || nRecente) || 200);
        const minJogosHistN = Math.max(3,  parseInt(minJogosHist) || 5);
        const minJogosRecN  = Math.max(1,  parseInt(minJogosRec)  || 3);
        const minVariacaoN  = Math.max(0,  parseFloat(minVariacao) || 3);

        const pool    = await getDbPool();
        const req1    = pool.request().input('nRecente', sql.Int, nRecenteN);
        const req2    = pool.request();

        const ligaDb    = ligaParaBanco(liga);
        // ligaW1_base: usado em CTEs com tabela única (sem alias)
        // ligaW1_join: usado em CTEs com JOIN — qualificado com m. para evitar ambiguidade
        const ligaW1_base = ligaDb && ligaDb !== 'all' ? (req1.input('liga', sql.NVarChar(200), ligaDb), 'AND liga = @liga') : '';
        const ligaW1_join = ligaDb && ligaDb !== 'all' ? 'AND m.liga = @liga' : '';
        const ligaW2      = ligaDb && ligaDb !== 'all' ? (req2.input('liga2', sql.NVarChar(200), ligaDb), 'AND liga = @liga2') : '';

        // Histórico all-time — base rate por mercado/seleção (SEM filtro de dias)
        const total = await req2.query(`
            WITH base AS (
                SELECT liga, mercado, selecao,
                       COUNT(DISTINCT evento_id) AS vezes
                FROM bet365_resultados_mercados
                WHERE 1=1 ${ligaW2}
                GROUP BY liga, mercado, selecao
            )
            SELECT liga, mercado, selecao, vezes,
                   SUM(vezes) OVER (PARTITION BY liga, mercado) AS total_mkt
            FROM base
        `).catch(() => ({ recordset: [] }));

        // Últimos N jogos por liga (ROW_NUMBER) — comportamento recente
        const recente = await req1.query(`
            WITH ult AS (
                SELECT liga, evento_id,
                       ROW_NUMBER() OVER (PARTITION BY liga ORDER BY MAX(data_partida) DESC) AS rn
                FROM bet365_resultados_mercados
                WHERE 1=1 ${ligaW1_base}
                GROUP BY liga, evento_id
            ),
            base_rec AS (
                SELECT m.liga, m.mercado, m.selecao,
                       COUNT(DISTINCT m.evento_id) AS vezes
                FROM bet365_resultados_mercados m
                INNER JOIN ult u ON u.liga = m.liga AND u.evento_id = m.evento_id AND u.rn <= @nRecente
                WHERE 1=1 ${ligaW1_join}
                GROUP BY m.liga, m.mercado, m.selecao
            )
            SELECT liga, mercado, selecao, vezes,
                   SUM(vezes) OVER (PARTITION BY liga, mercado) AS total_mkt
            FROM base_rec
        `);

        const mapTotal = {};
        for (const r of total.recordset) {
            mapTotal[`${r.liga}|${r.mercado}|${r.selecao}`] = { vezes: r.vezes, total_mkt: r.total_mkt };
        }

        const tendencias = [];
        for (const r of recente.recordset) {
            const hist = mapTotal[`${r.liga}|${r.mercado}|${r.selecao}`];
            if (!hist || hist.total_mkt < minJogosHistN || r.total_mkt < minJogosRecN) continue;

            // pct = vezes / total_mkt (jogos com esse mercado) — percentual correto
            const pct_hist  = hist.vezes / hist.total_mkt * 100;
            const pct_rec   = r.vezes    / r.total_mkt    * 100;
            const variacao  = +(pct_rec - pct_hist).toFixed(1);
            const tendencia = variacao >= minVariacaoN ? 'subindo' : variacao <= -minVariacaoN ? 'caindo' : 'estavel';
            // Inclui sempre — frontend decide o que exibir
            tendencias.push({
                liga: r.liga, mercado: r.mercado, selecao: r.selecao,
                pct_hist:   +pct_hist.toFixed(1),
                pct_rec:    +pct_rec.toFixed(1),
                variacao, tendencia,
                jogos_hist: hist.total_mkt, jogos_rec: r.total_mkt
            });
        }

        tendencias.sort((a, b) => Math.abs(b.variacao) - Math.abs(a.variacao));
        res.json({ success: true, total: tendencias.length, filtros: { nRecente: nRecenteN, minJogosHist: minJogosHistN, minVariacao: minVariacaoN }, data: tendencias });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/bet365/analise/sugestoes-avancadas
 * Para cada evento futuro ativo, sugere os mercados com maior taxa histórica de acerto
 * ?liga=Copa%20do%20Mundo&dias=30
 */
router.get('/analise/sugestoes-avancadas', async (req, res) => {
    try {
        const { liga, nJogos = 200 } = req.query;
        const nJogosN  = Math.min(420, Math.max(20, parseInt(nJogos) || 200));
        const ligaDb   = ligaParaBanco(liga);
        const pool     = await getDbPool();
        const reqEvt   = pool.request();
        const reqStats = pool.request();

        // Filtro de liga para eventos
        let evtLigaWhere = '';
        if (ligaDb && ligaDb !== 'all') {
            reqEvt.input('ligaEvt', sql.NVarChar(200), ligaDb);
            evtLigaWhere = 'AND league_name = @ligaEvt';
        }

        // Filtro de liga para estatísticas + subquery TOP N por liga
        let statsLigaWhere = '';
        let nJogosStatsWhere;
        if (ligaDb && ligaDb !== 'all') {
            reqStats.input('ligaSt',    sql.NVarChar(200), ligaDb);
            reqStats.input('nJogosIA',  sql.Int,           nJogosN);
            statsLigaWhere = 'AND liga = @ligaSt';
            nJogosStatsWhere = `AND evento_id IN (
                SELECT TOP (@nJogosIA) evento_id
                FROM bet365_resultados_mercados
                WHERE liga = @ligaSt
                GROUP BY evento_id
                ORDER BY MAX(data_partida) DESC
            )`;
        } else {
            reqStats.input('nJogosIA',  sql.Int,           nJogosN);
            nJogosStatsWhere = `AND evento_id IN (
                SELECT evento_id FROM (
                    SELECT evento_id,
                           ROW_NUMBER() OVER (PARTITION BY liga ORDER BY MAX(data_partida) DESC) AS rn
                    FROM bet365_resultados_mercados
                    GROUP BY liga, evento_id
                ) t WHERE t.rn <= @nJogosIA
            )`;
        }

        // Eventos agendados (filtrados por liga se especificada)
        const eventos = await reqEvt.query(`
            SELECT id AS evento_id, league_name AS liga, time_casa, time_fora,
                   start_time_datetime AS horario, odd_casa, odd_empate, odd_fora
            FROM bet365_eventos
            WHERE ativo = 1 AND status = 'AGENDADO' ${evtLigaWhere}
            ORDER BY start_time_datetime ASC
        `);

        if (eventos.recordset.length === 0) {
            return res.json({ success: true, data: [] });
        }

        // Estatísticas de mercados por liga — últimos N jogos por liga (denominador correto)
        const statsLiga = await reqStats.query(`
            WITH base AS (
                SELECT liga, mercado, selecao,
                    COUNT(DISTINCT evento_id) AS vezes,
                    SUM(COUNT(DISTINCT evento_id)) OVER (PARTITION BY liga, mercado) AS total_jogos,
                    AVG(CAST(odd_paga AS FLOAT)) AS odd_f
                FROM bet365_resultados_mercados
                WHERE 1=1 ${statsLigaWhere} ${nJogosStatsWhere}
                GROUP BY liga, mercado, selecao
            )
            SELECT liga, mercado, selecao, vezes, total_jogos,
                CAST(odd_f AS DECIMAL(7,2)) AS odd_media,
                CAST(vezes*100.0/NULLIF(total_jogos,0) AS DECIMAL(6,1)) AS pct
            FROM base
            WHERE total_jogos >= 5
        `);

        // Monta mapa liga → lista de mercados ordenados por %
        const mapLiga = {};
        for (const r of statsLiga.recordset) {
            if (!mapLiga[r.liga]) mapLiga[r.liga] = [];
            mapLiga[r.liga].push({
                mercado:   r.mercado,
                selecao:   r.selecao,
                pct:       parseFloat(r.pct),
                odd_media: parseFloat(r.odd_media || 0),
                jogos:     r.total_jogos,
                valor_esp: parseFloat(((r.vezes / (r.total_jogos || 1)) * (r.odd_media || 1)).toFixed(3))
            });
        }
        for (const liga of Object.keys(mapLiga)) {
            mapLiga[liga].sort((a, b) => b.pct - a.pct);
        }

        // Monta sugestões por evento
        const sugestoes = eventos.recordset.map(ev => {
            const mercadosLiga = mapLiga[ev.liga] || [];
            const top = mercadosLiga.slice(0, 12); // top 12 mercados da liga
            return {
                evento_id:  ev.evento_id,
                liga:       ev.liga,
                time_casa:  ev.time_casa,
                time_fora:  ev.time_fora,
                horario:    ev.horario,
                odd_casa:   ev.odd_casa,
                odd_empate: ev.odd_empate,
                odd_fora:   ev.odd_fora,
                sugestoes:  top
            };
        });

        res.json({ success: true, total: sugestoes.length, data: sugestoes });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/bet365/analise/resumo
 * Resumo geral da tabela de mercados para o painel de análise
 * ?dias=7&liga=all&minJogos=5&minVE=0.95&soValueBets=0
 */
router.get('/analise/resumo', async (req, res) => {
    try {
        const {
            nJogos     = 200,
            liga,
            minJogos   = 5,
            minVE      = 0.95,
            soValueBets = '0',
        } = req.query;

        const nJogosN   = Math.min(420, Math.max(20, parseInt(nJogos) || 200));
        const minJogosN = Math.max(1, parseInt(minJogos) || 5);
        const minVEN    = Math.max(0, parseFloat(minVE)  || 0.95);
        const pool      = await getDbPool();

        const ligaDb     = ligaParaBanco(liga);
        const ligaWhere  = (ligaDb && ligaDb !== 'all') ? `AND liga = '${ligaDb.replace(/'/g,"''")}'` : '';

        // Subquery: últimos nJogos eventos por liga
        const nJogosWhere = (ligaDb && ligaDb !== 'all')
            ? `AND evento_id IN (
                SELECT TOP (${nJogosN}) evento_id
                FROM bet365_resultados_mercados
                WHERE liga = '${ligaDb.replace(/'/g,"''")}'
                GROUP BY evento_id
                ORDER BY MAX(data_partida) DESC
            )`
            : `AND evento_id IN (
                SELECT evento_id FROM (
                    SELECT evento_id,
                           ROW_NUMBER() OVER (PARTITION BY liga ORDER BY MAX(data_partida) DESC) AS rn
                    FROM bet365_resultados_mercados
                    GROUP BY liga, evento_id
                ) t WHERE t.rn <= ${nJogosN}
            )`;

        // threshold de VE para value bets (referencia ve_raw do CTE)
        const veThreshold = (soValueBets === '1' || minVEN > 0) ? Math.max(minVEN, 0) : 0.90;
        const vbWhere    = `AND ve_raw >= ${veThreshold}`;

        const [vol, porLiga, topMkt, valueBets] = await Promise.all([
            // Volume geral (filtrado por nJogos e liga)
            pool.query(`
                SELECT
                    COUNT(DISTINCT evento_id) AS jogos,
                    COUNT(*) AS mercados_total,
                    COUNT(DISTINCT mercado) AS tipos_mercado,
                    MIN(data_partida) AS primeiro_jogo,
                    MAX(data_partida) AS ultimo_jogo
                FROM bet365_resultados_mercados
                WHERE 1=1 ${ligaWhere} ${nJogosWhere}
            `),
            // Por liga (filtrado)
            pool.query(`
                SELECT liga,
                    COUNT(DISTINCT evento_id) AS jogos,
                    COUNT(*) AS mercados
                FROM bet365_resultados_mercados
                WHERE 1=1 ${ligaWhere} ${nJogosWhere}
                GROUP BY liga ORDER BY jogos DESC
            `),
            // Top 10 seleções mais frequentes — denominador correto (window function)
            pool.query(`
                WITH base AS (
                    SELECT liga, mercado, selecao,
                        COUNT(*) AS vezes,
                        SUM(COUNT(*)) OVER (PARTITION BY liga, mercado) AS total_jogos,
                        AVG(CAST(odd_paga AS FLOAT)) AS odd_f
                    FROM bet365_resultados_mercados
                    WHERE 1=1 ${ligaWhere} ${nJogosWhere}
                    GROUP BY liga, mercado, selecao
                )
                SELECT TOP 10 liga, mercado, selecao, vezes, total_jogos,
                    CAST(odd_f AS DECIMAL(7,2)) AS odd_media,
                    CAST(vezes*100.0/NULLIF(total_jogos,0) AS DECIMAL(6,1)) AS pct
                FROM base
                WHERE total_jogos >= ${minJogosN}
                ORDER BY pct DESC
            `),
            // Value bets — denominador correto (window function)
            pool.query(`
                WITH base AS (
                    SELECT liga, mercado, selecao,
                        COUNT(*) AS vezes,
                        SUM(COUNT(*)) OVER (PARTITION BY liga, mercado) AS total_jogos,
                        AVG(CAST(odd_paga AS FLOAT)) AS odd_f
                    FROM bet365_resultados_mercados
                    WHERE 1=1 ${ligaWhere} ${nJogosWhere}
                    GROUP BY liga, mercado, selecao
                ),
                calc AS (
                    SELECT *,
                        vezes*100.0/NULLIF(total_jogos,0)             AS pct_raw,
                        (vezes*1.0/NULLIF(total_jogos,0))*odd_f       AS ve_raw
                    FROM base
                    WHERE total_jogos >= ${minJogosN}
                )
                SELECT TOP 15 liga, mercado, selecao, vezes, total_jogos,
                    CAST(odd_f   AS DECIMAL(7,2)) AS odd_media,
                    CAST(pct_raw AS DECIMAL(6,1)) AS pct,
                    CAST(ve_raw  AS DECIMAL(8,3)) AS valor_esperado
                FROM calc
                WHERE pct_raw >= 10          -- exclui Scorecast/Wincast (frequência < 10%)
                  AND odd_f <= 30            -- exclui odds absurdas (mercados compostos)
                  ${vbWhere}
                ORDER BY ve_raw DESC
            `)
        ]);

        const _dbToCanon = r => ({ ...r, liga: ({ 'World Cup':'Copa do Mundo', 'Premiership':'Premier League' }[r.liga] || r.liga) });
        res.json({
            success:    true,
            timestamp:  new Date().toISOString(),
            filtros:    { nJogos: nJogosN, liga: liga || 'all', minJogos: minJogosN, minVE: minVEN },
            volume:     vol.recordset[0],
            por_liga:   porLiga.recordset.map(_dbToCanon),
            top_selecoes: topMkt.recordset.map(_dbToCanon),
            value_bets: valueBets.recordset.map(_dbToCanon)
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// CONFIGURAÇÕES DO SISTEMA (master only)
// ============================================================

const CONFIG_DEFAULTS = [
    // ── Próximos jogos ──
    { chave:'coletar_proximos_jogos',       valor:'true',  tipo:'boolean', grupo:'coleta', descricao:'Habilitar coleta de próximos jogos agendados' },
    { chave:'max_horarios_proximos',        valor:'4',     tipo:'number',  grupo:'coleta', descricao:'Máximo de horários futuros a coletar por liga (0 = desativar)' },
    { chave:'janela_proximos_min',          valor:'6',     tipo:'number',  grupo:'coleta', descricao:'Janela de antecedência para próximos jogos (minutos). Ex: 6 = pega jogos que começam nos próximos 6 min' },
    { chave:'intervalo_proximos_min',       valor:'3',     tipo:'number',  grupo:'coleta', descricao:'Intervalo mínimo entre buscas de próximos jogos por liga (minutos). Evita sobrecarga no extra.bet365' },
    // ── Ciclo de coleta ──
    { chave:'intervalo_coleta_seg',         valor:'30',    tipo:'number',  grupo:'coleta', descricao:'Intervalo entre ciclos de coleta (segundos)' },
    // ── Delays de navegação ──
    { chave:'delay_apos_clicar_liga_ms',    valor:'3000',  tipo:'number',  grupo:'coleta', descricao:'Delay após clicar na aba da liga (ms)' },
    { chave:'delay_pos_reload_ms',          valor:'4000',  tipo:'number',  grupo:'coleta', descricao:'Delay após reload da página (ms)' },
    { chave:'delay_apos_resultados_ms',     valor:'2000',  tipo:'number',  grupo:'coleta', descricao:'Delay após abrir aba de Resultados (ms)' },
    { chave:'delay_show_more_ms',           valor:'800',   tipo:'number',  grupo:'coleta', descricao:'Delay entre cliques em "Mostrar Mais" (ms)' },
    { chave:'delay_expandir_mercados_ms',   valor:'1500',  tipo:'number',  grupo:'coleta', descricao:'Delay após expandir mercados internos (ms)' },
    { chave:'delay_volta_proximos_ms',      valor:'2000',  tipo:'number',  grupo:'coleta', descricao:'Delay ao voltar para Próximos Jogos (ms)' },
    { chave:'delay_entre_horarios_ms',      valor:'1500',  tipo:'number',  grupo:'coleta', descricao:'Delay entre cliques de horário (ms)' },
    { chave:'delay_aguarda_mercado_ms',     valor:'500',   tipo:'number',  grupo:'coleta', descricao:'Delay de polling ao aguardar mercados (ms)' },
    // ── Timeouts ──
    { chave:'timeout_goto_ms',              valor:'60000', tipo:'number',  grupo:'coleta', descricao:'Timeout ao navegar para a página inicial (ms)' },
    { chave:'delay_initial_load_ms',        valor:'6000',  tipo:'number',  grupo:'coleta', descricao:'Delay após carregar a página inicial (ms)' },
    { chave:'timeout_ligas_ms',             valor:'20000', tipo:'number',  grupo:'coleta', descricao:'Timeout aguardando botões de liga (ms)' },
    { chave:'timeout_navegacao_ms',         valor:'30000', tipo:'number',  grupo:'coleta', descricao:'Timeout de navegação/reload (ms)' },
    // ── Auto-login (sessão expirada) ──
    { chave:'delay_modal_login_ms',         valor:'2500',  tipo:'number',  grupo:'coleta', descricao:'Delay aguardando modal de login aparecer após clicar "Faça Login para Assistir" (ms)' },
    { chave:'delay_pos_login_ms',           valor:'4000',  tipo:'number',  grupo:'coleta', descricao:'Delay após clicar em Login para aguardar restauração da sessão (ms)' },
    // ── Backfill (coletor histórico) ──
    { chave:'hist_delay_clique_ms',         valor:'1000',  tipo:'number',  grupo:'coleta', descricao:'Backfill: delay após cada clique em jogo no coletor histórico (ms)' },
    { chave:'hist_max_cliques',             valor:'3',     tipo:'number',  grupo:'coleta', descricao:'Backfill: máximo de tentativas de clique por jogo' },
    // ── Ordem de coleta ──
    { chave:'proximos_antes_resultados',    valor:'false', tipo:'boolean', grupo:'ordem',  descricao:'Coletar próximos jogos ANTES dos resultados' },
    // ── Ligas ──
    { chave:'liga_world_cup',               valor:'true',  tipo:'boolean', grupo:'ligas',    descricao:'Coletar Copa do Mundo' },
    { chave:'liga_euro_cup',                valor:'true',  tipo:'boolean', grupo:'ligas',    descricao:'Coletar Euro Cup' },
    { chave:'liga_premiership',             valor:'true',  tipo:'boolean', grupo:'ligas',    descricao:'Coletar Premier League' },
    { chave:'liga_express_cup',             valor:'true',  tipo:'boolean', grupo:'ligas',    descricao:'Coletar Express Cup' },
    { chave:'liga_super_liga',              valor:'true',  tipo:'boolean', grupo:'ligas',    descricao:'Coletar Super Liga Sul-Americana' },
    // ── Padrões do frontend ──
    { chave:'default_horas_historico',      valor:'6',     tipo:'number',  grupo:'frontend', descricao:'Período padrão da Tabela Histórica (horas)' },
    { chave:'default_dias_analise',         valor:'3',     tipo:'number',  grupo:'frontend', descricao:'Período padrão dos filtros de Análise (dias)' },
    { chave:'default_min_amostras',         valor:'5',     tipo:'number',  grupo:'frontend', descricao:'Mínimo de amostras padrão (Análise)' },
    { chave:'default_freq_min',             valor:'0',     tipo:'number',  grupo:'frontend', descricao:'Frequência mínima % padrão (Análise)' },
    { chave:'default_tipo_mercado',         valor:'Todos', tipo:'text',    grupo:'frontend', descricao:'Tipo de mercado padrão (Análise)' },
    { chave:'default_janela_recente',       valor:'20',    tipo:'number',  grupo:'frontend', descricao:'Janela recente padrão (Análise)' },
    // ── Botões padrão da grade ──
    { chave:'default_exibir_clubes',        valor:'true',  tipo:'boolean', grupo:'frontend', descricao:'🏷️ Exibir Clubes ativado por padrão na grade' },
    { chave:'default_exibir_odds',          valor:'false', tipo:'boolean', grupo:'frontend', descricao:'💹 Exibir Odds ativado por padrão na grade' },
    { chave:'default_proximos_jogos',       valor:'false', tipo:'boolean', grupo:'frontend', descricao:'🕐 Próximos Jogos ativado por padrão na grade' },
    { chave:'default_exibir_ht',            valor:'true',  tipo:'boolean', grupo:'frontend', descricao:'🔍 Exibir HT ativado por padrão na grade' },
    { chave:'default_mosaico_pct',          valor:'true',  tipo:'boolean', grupo:'frontend', descricao:'% Linha ativado por padrão no Mosaico' },
    { chave:'default_mosaico_gols',         valor:'true',  tipo:'boolean', grupo:'frontend', descricao:'⚽ Linha ativado por padrão no Mosaico' },
    { chave:'default_so_value_bets',        valor:'false', tipo:'boolean', grupo:'frontend', descricao:'Apenas value bets por padrão (Análise)' },
    { chave:'default_legendas',             valor:'false', tipo:'boolean', grupo:'frontend', descricao:'💬 Legendas (suprimir tooltips) ativado por padrão no gráfico' },
    { chave:'analise_liberar_user',         valor:'false', tipo:'boolean', grupo:'frontend', descricao:'📊 Liberar "Análise & Sugestões" para usuários tipo User' },
    // ── Mosaico — colunas esquerda ──
    { chave:'mosaico_hora_largura',         valor:'22',    tipo:'number',  grupo:'frontend', descricao:'Mosaico: min-width da coluna HORA (px)' },
    { chave:'mosaico_mostrar_data_jogos',   valor:'true',  tipo:'boolean', grupo:'frontend', descricao:'Mosaico: exibir data DD/MM e contagem de jogos' },
    { chave:'mosaico_hora_fonte_hh',        valor:'12',    tipo:'number',  grupo:'frontend', descricao:'Mosaico: fonte do horário HH (px)' },
    { chave:'mosaico_hora_fonte_dd',        valor:'6',     tipo:'number',  grupo:'frontend', descricao:'Mosaico: fonte da data DD/MM (px)' },
    { chave:'mosaico_pct_largura',          valor:'10',    tipo:'number',  grupo:'frontend', descricao:'Mosaico: min-width da coluna % (px)' },
    { chave:'mosaico_gols_largura',         valor:'8',     tipo:'number',  grupo:'frontend', descricao:'Mosaico: min-width da coluna ⚽ Gols (px)' },
    { chave:'mosaico_celula_largura',       valor:'40',    tipo:'number',  grupo:'frontend', descricao:'Mosaico: largura das células de jogo (px)' },
    { chave:'mosaico_celula_fonte',         valor:'11',    tipo:'number',  grupo:'frontend', descricao:'Mosaico: fonte das células de jogo (px)' },
    // ── Mercados (pills de filtro) ──
    { chave:'mkt_pill_fs',   valor:'9',        tipo:'number',  grupo:'grafico',  descricao:'🎯 Mercados: tamanho da fonte dos filtros (px)' },
    { chave:'mkt_pill_cor',  valor:'#94a3b8',  tipo:'text',    grupo:'grafico',  descricao:'🎯 Mercados: cor do texto dos filtros (hex)' },
    { chave:'mkt_pill_bold', valor:'false',    tipo:'boolean', grupo:'grafico',  descricao:'🎯 Mercados: negrito nos filtros' },
    { chave:'mkt_grupo_fs',         valor:'7.5',      tipo:'number', grupo:'grafico', descricao:'🎯 Mercados: tamanho da fonte dos nomes de grupo (BTTS, OVER FT…) (px)' },
    { chave:'mkt_grupo_cor',        valor:'#94a3b8',  tipo:'text',   grupo:'grafico', descricao:'🎯 Mercados: cor dos nomes de grupo — estado ativo (tem filtro ligado)' },
    { chave:'mkt_grupo_cor_inativo',valor:'#475569',  tipo:'text',   grupo:'grafico', descricao:'🎯 Mercados: cor dos nomes de grupo — estado inativo (nenhum filtro ligado)' },
    // ── Gráfico — padrões dos botões ──
    { chave:'grafico_altura',       valor:'300',   tipo:'number',  grupo:'grafico', descricao:'Gráfico: altura do painel (px; 80–600)' },
    { chave:'grafico_gols_altura',  valor:'260',   tipo:'number',  grupo:'grafico', descricao:'Gráfico de Gols: altura do painel (px; 80–600)' },
    { chave:'grafico_linha_altura', valor:'300',   tipo:'number',  grupo:'grafico', descricao:'Gráfico de Linha: altura do painel (px; 80–600)' },
    { chave:'grafico_pct',         valor:'false', tipo:'boolean', grupo:'grafico', descricao:'Gráfico: exibir % no final das linhas por padrão' },
    { chave:'grafico_topo_fundo',  valor:'false',   tipo:'boolean', grupo:'grafico', descricao:'Gráfico: marcar topo/fundo por padrão' },
    { chave:'grafico_tf_topo_cor', valor:'#4ade80', tipo:'text',    grupo:'grafico', descricao:'Gráfico T/F: cor do ponto Topo (máximo)' },
    { chave:'grafico_tf_fundo_cor',valor:'#f87171', tipo:'text',    grupo:'grafico', descricao:'Gráfico T/F: cor do ponto Fundo (mínimo)' },
    { chave:'grafico_congest',     valor:'false', tipo:'boolean', grupo:'grafico', descricao:'Gráfico: destacar zonas de congestão por padrão' },
    { chave:'grafico_medias',      valor:'false', tipo:'boolean', grupo:'grafico', descricao:'Gráfico: exibir médias móveis por padrão' },
    { chave:'grafico_mm1',         valor:'9',     tipo:'number',  grupo:'grafico', descricao:'Gráfico: período da MM curta (padrão 9 jogos)' },
    { chave:'grafico_mm2',         valor:'21',    tipo:'number',  grupo:'grafico', descricao:'Gráfico: período da MM longa (padrão 21 jogos)' },
    { chave:'grafico_mm1_cor',     valor:'#ffffff', tipo:'text',  grupo:'grafico', descricao:'📈 MM curta: cor da linha (hex)' },
    { chave:'grafico_mm2_cor',     valor:'#fbbf24', tipo:'text',  grupo:'grafico', descricao:'📈 MM longa: cor da linha (hex)' },
    { chave:'grafico_mm1_espessura', valor:'1.5', tipo:'number', grupo:'grafico', descricao:'📈 MM curta: espessura da linha (px)' },
    { chave:'grafico_mm2_espessura', valor:'2',   tipo:'number', grupo:'grafico', descricao:'📈 MM longa: espessura da linha (px)' },
    { chave:'grafico_mm1_dash',    valor:'4,4',   tipo:'text',  grupo:'grafico', descricao:'📈 MM curta: padrão tracejado (ex: "4,4" ou "8,4,2,4")' },
    { chave:'grafico_mm2_dash',    valor:'8,4',   tipo:'text',  grupo:'grafico', descricao:'📈 MM longa: padrão tracejado (ex: "8,4" ou "0" = sólido)' },
    { chave:'grafico_gols_barra',  valor:'#22c55e', tipo:'text', grupo:'grafico', descricao:'⚽ Gráfico de Gols: cor das barras' },
    { chave:'grafico_gols_mm',     valor:'#60a5fa', tipo:'text', grupo:'grafico', descricao:'⚽ Gráfico de Gols: cor da MM' },
    { chave:'grafico_par_cor',     valor:'#22c55e', tipo:'text', grupo:'grafico', descricao:'🔢 Gráfico Par/Ímpar: cor do Par' },
    { chave:'grafico_impar_cor',   valor:'#f97316', tipo:'text',   grupo:'grafico', descricao:'🔢 Gráfico Par/Ímpar: cor do Ímpar' },
    { chave:'grafico_ponto_raio',      valor:'4',       tipo:'number', grupo:'grafico', descricao:'📈 Gráfico: raio das bolinhas nos gráficos (px)' },
    { chave:'grafico_ponto_borda',     valor:'1.5',     tipo:'number', grupo:'grafico', descricao:'📈 Gráfico: espessura da borda das bolinhas (px)' },
    { chave:'grafico_ponto_sobe_cor',  valor:'#4ade80', tipo:'text',    grupo:'grafico', descricao:'📈 Gráfico: cor da bolinha quando sobe (hex)' },
    { chave:'grafico_ponto_desce_cor', valor:'#ef4444', tipo:'text',    grupo:'grafico', descricao:'📈 Gráfico: cor da bolinha quando desce (hex)' },
    { chave:'grafico_ponto_flat_visivel',  valor:'true',  tipo:'boolean', grupo:'grafico',  descricao:'● Plano: exibir o botão nos gráficos de Linha e Mercados' },
    { chave:'grafico_ponto_flat',          valor:'true',  tipo:'boolean', grupo:'grafico',  descricao:'● Plano: vir habilitado por padrão (ocultar bolinhas sem variação)' },
    { chave:'grafico_ponto_cores_visivel', valor:'true',  tipo:'boolean', grupo:'grafico',  descricao:'🟢 Cores: exibir o botão de cores (verde/vermelho) nos gráficos de Linha e Mercados' },
    { chave:'grafico_ponto_cores',         valor:'false', tipo:'boolean', grupo:'grafico',  descricao:'🟢 Cores: vir habilitado por padrão (colorir bolinhas verde=hit / vermelho=miss)' },
    { chave:'grafico_pct_cor',         valor:'#ef4444', tipo:'text',    grupo:'grafico', descricao:'% Gráfico: cor do texto de porcentagem nas linhas' },
    { chave:'grafico_pct_tamanho',     valor:'8',       tipo:'number',  grupo:'grafico', descricao:'% Gráfico: tamanho da fonte da porcentagem (px)' },
    { chave:'grafico_pills_default',   valor:'true',    tipo:'boolean', grupo:'grafico', descricao:'📊 Exibir seleção de mercados (pills) por padrão nos Gráficos de Linha e Mercados' },
    // ── Coletores ──
    { chave:'coletor2_ativo', valor:'true',  tipo:'boolean', grupo:'sistema', descricao:'⚡ Coletor 2 (Odds pré-jogo) — ativar/pausar coleta automática de odds' },
    { chave:'coletor3_ativo', valor:'false', tipo:'boolean', grupo:'sistema', descricao:'📚 Coletor 3 (Histórico) — ativar/pausar backfill de dados históricos' },
    // ── Sistema ──
    { chave:'manutencao_ativa',             valor:'false', tipo:'boolean', grupo:'sistema',  descricao:'Ativar modo manutenção — bloqueia acesso de usuários não-Master' },
    { chave:'manutencao_mensagem',          valor:'Estamos realizando melhorias no sistema. Voltamos em breve!', tipo:'text', grupo:'sistema', descricao:'Mensagem exibida na tela de manutenção' },
    { chave:'manutencao_previsao',          valor:'Em breve', tipo:'text', grupo:'sistema',  descricao:'Previsão de retorno (ex: "às 14:00" ou "em 30 min") — deixe vazio para não exibir' },
    { chave:'sessao_timeout_minutos',       valor:'180',   tipo:'number',  grupo:'sistema',  descricao:'Timeout de sessão em minutos (0 = nunca expirar; MASTER sempre ativo)' },
    { chave:'auto_refresh_segundos',        valor:'120',   tipo:'number',  grupo:'sistema',  descricao:'Intervalo de atualização automática da grade (segundos; 0 = desativar)' },
    { chave:'auto_reinicio_minutos',        valor:'6',     tipo:'number',  grupo:'sistema',  descricao:'🔄 Reinício automático: minutos sem coleta para fechar Edge + Node e reiniciar tudo (0 = desativado)' },
    { chave:'tour_dias',                    valor:'7',     tipo:'number',  grupo:'sistema',  descricao:'Tour de onboarding: exibir por N dias após a data de licença (0 = desativado para todos)' },
    { chave:'fonte_proximos',               valor:'results',tipo:'text',   grupo:'sistema',  descricao:'Fonte dos próximos jogos: results = página de resultados | none = desativado' },
    { chave:'max_padroes_usuario',          valor:'5',     tipo:'number',  grupo:'sistema',  descricao:'Limite de padrões de gráfico por usuário (1–10)' },
    { chave:'max_value_bets',               valor:'5',     tipo:'number',  grupo:'sistema',  descricao:'Máximo de sugestões exibidas em 💰 Value Bets (1–20)' },
    { chave:'max_tendencias',               valor:'8',     tipo:'number',  grupo:'sistema',  descricao:'Máximo de itens exibidos em 📈 Tendências (1–20)' },
    { chave:'max_ver_mais_clicks',          valor:'10',    tipo:'number',  grupo:'sistema',  descricao:'Cliques em "Ver Mais" ao coletar resultados (mais cliques = mais jogos históricos por ciclo)' },
    { chave:'grafico_mercados_master_only', valor:'false', tipo:'boolean', grupo:'sistema',  descricao:'📈 Gráfico de Mercados: exibir somente para o usuário MASTER' },
    // ── Alertas ──
    { chave:'alerta_ativado',               valor:'true',  tipo:'boolean', grupo:'alertas',  descricao:'Ativar sistema de alertas (Telegram + e-mail)' },
    { chave:'alerta_minutos_sem_coleta',    valor:'15',    tipo:'number',  grupo:'alertas',  descricao:'Minutos sem coleta bem-sucedida para disparar alerta' },
    { chave:'telegram_bot_token',           valor:'8189807116:AAEByra9URAFBh_Hutwn_-lVzWinpk68BOY', tipo:'text', grupo:'alertas', descricao:'Token do bot Telegram (obtido via @BotFather)' },
    { chave:'telegram_chat_ids',            valor:'5493649790', tipo:'text', grupo:'alertas', descricao:'Chat IDs do Telegram separados por vírgula' },
    // ── Seções da Análise ──
    { chave:'show_secao_ia',                valor:'true',  tipo:'boolean', grupo:'secoes',   descricao:'Exibir seção: IA — Sugestões para Próximos Jogos' },
    { chave:'show_secao_value_bets',        valor:'true',  tipo:'boolean', grupo:'secoes',   descricao:'Exibir seção: Value Bets' },
    { chave:'show_secao_tendencias',        valor:'true',  tipo:'boolean', grupo:'secoes',   descricao:'Exibir seção: Tendências' },
    { chave:'show_secao_frequencia',        valor:'true',  tipo:'boolean', grupo:'secoes',   descricao:'Exibir seção: Frequência dos Mercados' },
    { chave:'show_secao_desempenho',        valor:'true',  tipo:'boolean', grupo:'secoes',   descricao:'Exibir seção: Desempenho por Liga' },
    { chave:'show_subview_gols',            valor:'true',  tipo:'boolean', grupo:'secoes',   descricao:'Exibir botão/seção: ⚽ Gráfico de Gols' },
    { chave:'show_subview_grafico',         valor:'true',  tipo:'boolean', grupo:'secoes',   descricao:'Exibir botão/seção: 📈 Gráfico de Mercados' },
    { chave:'show_subview_linha',           valor:'true',  tipo:'boolean', grupo:'secoes',   descricao:'Exibir botão/seção: 📉 Gráfico de Linha' },
    { chave:'show_subview_parimpar',        valor:'true',  tipo:'boolean', grupo:'secoes',   descricao:'Exibir botão/seção: 🔢 Gráfico de Par e Ímpar' },
    { chave:'show_subview_mosaico',         valor:'true',  tipo:'boolean', grupo:'secoes',   descricao:'Exibir botão/seção: 🏁 Menu Mosaico' },
    { chave:'default_open_grafico',         valor:'true',  tipo:'boolean', grupo:'secoes',   descricao:'Aberto por padrão: 📈 Gráfico de Mercados' },
    { chave:'default_open_mosaico',         valor:'true',  tipo:'boolean', grupo:'secoes',   descricao:'Aberto por padrão: 🏁 Menu Mosaico' },
    { chave:'default_open_gols',            valor:'false', tipo:'boolean', grupo:'secoes',   descricao:'Aberto por padrão: ⚽ Gráfico de Gols' },
    { chave:'default_open_linha',           valor:'false', tipo:'boolean', grupo:'secoes',   descricao:'Aberto por padrão: 📉 Gráfico de Linha' },
    { chave:'default_open_parimpar',        valor:'false', tipo:'boolean', grupo:'secoes',   descricao:'Aberto por padrão: 🔢 Gráfico de Par e Ímpar' },
    { chave:'default_open_mercados',        valor:'false', tipo:'boolean', grupo:'secoes',   descricao:'Aberto por padrão: 🎯 Mercados' },
    // ── Grade/Mosaico — cores e fontes padrão (sobrescrevem os valores embutidos no código) ──
    { chave:'grid_selScoreBg', valor:'#422006',  tipo:'color',  grupo:'grid', descricao:'🎯 Seleção Resultado: fundo' },
    { chave:'grid_selScoreBrd',valor:'#fbbf24',  tipo:'color',  grupo:'grid', descricao:'🎯 Seleção Resultado: borda' },
    { chave:'grid_selClubBg',  valor:'#052e16',  tipo:'color',  grupo:'grid', descricao:'🎯 Seleção Clube: fundo' },
    { chave:'grid_selClubBrd', valor:'#1fcc59',  tipo:'color',  grupo:'grid', descricao:'🎯 Seleção Clube: borda' },
    { chave:'grid_horaHHCor', valor:'#1fcc59',  tipo:'color',  grupo:'grid', descricao:'🕐 Hora (HH): cor' },
    { chave:'grid_horaMinCor',valor:'#475569',  tipo:'color',  grupo:'grid', descricao:'🕐 Minuto (:MM): cor' },
    { chave:'grid_horaMinFs', valor:'10',       tipo:'number', grupo:'grid', descricao:'📐 Fonte :MM coluna minuto (px)' },
    { chave:'grid_clubeFs',   valor:'7',        tipo:'number', grupo:'grid', descricao:'📐 Fonte dos Clubes (px)' },
    { chave:'grid_ftFs',      valor:'10',       tipo:'number', grupo:'grid', descricao:'📐 Fonte Resultado FT (px)' },
    { chave:'grid_htFs',      valor:'10',       tipo:'number', grupo:'grid', descricao:'📐 Fonte Resultado HT (px)' },
    { chave:'grid_oddFs',     valor:'6',        tipo:'number', grupo:'grid', descricao:'📐 Fonte das Odds (px)' },
    { chave:'grid_proxFs',    valor:'9',        tipo:'number', grupo:'grid', descricao:'📐 Fonte Próximos Jogos (px)' },
    { chave:'grid_ftTxt',     valor:'#e2e8f0',  tipo:'color',  grupo:'grid', descricao:'📊 Resultado FT — cor do texto' },
    { chave:'grid_htTxt',     valor:'#64748b',  tipo:'color',  grupo:'grid', descricao:'📊 Resultado HT — cor do texto' },
    { chave:'grid_clubeTxt',  valor:'#94a3b8',  tipo:'color',  grupo:'grid', descricao:'🏷️ Clubes — cor do texto' },
    { chave:'grid_verdeBg',   valor:'#14532d',  tipo:'color',  grupo:'grid', descricao:'✅ Acerto: cor de fundo' },
    { chave:'grid_verdeTxt',  valor:'#4ade80',  tipo:'color',  grupo:'grid', descricao:'✅ Acerto: cor do texto' },
    { chave:'grid_vermBg',    valor:'#3b0a0a',  tipo:'color',  grupo:'grid', descricao:'❌ Erro: cor de fundo' },
    { chave:'grid_vermTxt',   valor:'#f87171',  tipo:'color',  grupo:'grid', descricao:'❌ Erro: cor do texto' },
    { chave:'grid_futuroBg',  valor:'#0a1628',  tipo:'color',  grupo:'grid', descricao:'🔜 Próximos: cor de fundo' },
    { chave:'grid_futuroTxt', valor:'#3b82f6',  tipo:'color',  grupo:'grid', descricao:'🔜 Próximos: cor do texto' },
    { chave:'grid_futuroBrd', valor:'#1e3a5f',  tipo:'color',  grupo:'grid', descricao:'🔜 Próximos: cor da borda' },
    { chave:'grid_oddFav',    valor:'#4ade80',  tipo:'color',  grupo:'grid', descricao:'💹 Odd favorito (<2.0): cor' },
    { chave:'grid_oddMed',    valor:'#fbbf24',  tipo:'color',  grupo:'grid', descricao:'💹 Odd médio (2–3): cor' },
    { chave:'grid_oddAzarao', valor:'#f87171',  tipo:'color',  grupo:'grid', descricao:'💹 Odd azarão (>3): cor' },
    { chave:'grid_selColBg',  valor:'#1d4ed8',  tipo:'color',  grupo:'grid', descricao:'🔵 Coluna selecionada: fundo' },
    { chave:'grid_selColTxt', valor:'#bfdbfe',  tipo:'color',  grupo:'grid', descricao:'🔵 Coluna selecionada: texto' },
    { chave:'grid_selColBrd', valor:'#60a5fa',  tipo:'color',  grupo:'grid', descricao:'🔵 Coluna selecionada: borda' },
    { chave:'grid_selRowBg',  valor:'#6d28d9',  tipo:'color',  grupo:'grid', descricao:'🟣 Linha selecionada: fundo' },
    { chave:'grid_selRowTxt', valor:'#ede9fe',  tipo:'color',  grupo:'grid', descricao:'🟣 Linha selecionada: texto' },
    { chave:'grid_selRowBrd', valor:'#a78bfa',  tipo:'color',  grupo:'grid', descricao:'🟣 Linha selecionada: borda' },
    { chave:'grid_canetaCor',       valor:'#f59e0b',  tipo:'color', grupo:'grid', descricao:'✏️ Caneta: cor padrão' },
    { chave:'grid_filtroInativoBg', valor:'#1fcc59',  tipo:'color', grupo:'grid', descricao:'🎯 Botões Mercado inativo: cor base' },
    { chave:'grid_filtroAtivoBg',   valor:'#1fcc59',  tipo:'color', grupo:'grid', descricao:'🎯 Botões Mercado ativo: cor de fundo' },
    { chave:'grid_filtroAtivoTxt',  valor:'#ffffff',  tipo:'color', grupo:'grid', descricao:'🎯 Botões Mercado ativo: cor do texto' },
];

async function _ensureConfigTable(pool) {
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='bet365_config' AND xtype='U')
        CREATE TABLE bet365_config (
            chave      VARCHAR(100) PRIMARY KEY,
            valor      VARCHAR(500) NOT NULL,
            tipo       VARCHAR(20)  NOT NULL DEFAULT 'text',
            grupo      VARCHAR(50)  NOT NULL DEFAULT 'geral',
            descricao  VARCHAR(500) DEFAULT '',
            atualizado DATETIME     DEFAULT GETUTCDATE()
        )
    `);
    for (const d of CONFIG_DEFAULTS) {
        await pool.request()
            .input('chave',    sql.VarChar, d.chave)
            .input('valor',    sql.VarChar, d.valor)
            .input('tipo',     sql.VarChar, d.tipo)
            .input('grupo',    sql.VarChar, d.grupo)
            .input('descricao',sql.VarChar, d.descricao)
            .query(`
                IF NOT EXISTS (SELECT 1 FROM bet365_config WHERE chave = @chave)
                    INSERT INTO bet365_config (chave,valor,tipo,grupo,descricao)
                    VALUES (@chave,@valor,@tipo,@grupo,@descricao)
                ELSE
                    UPDATE bet365_config SET tipo=@tipo, grupo=@grupo, descricao=@descricao
                    WHERE chave=@chave AND (tipo <> @tipo OR grupo <> @grupo)
            `);
    }
}

// Exporta para uso no coletor
async function getSystemConfig() {
    try {
        const pool = await getDbPool();
        await _ensureConfigTable(pool);
        const r = await pool.request().query(`SELECT chave, valor FROM bet365_config`);
        const cfg = {};
        r.recordset.forEach(row => { cfg[row.chave] = row.valor; });
        return cfg;
    } catch(e) {
        console.warn('[Config] Erro ao ler config, usando defaults:', e.message);
        const cfg = {};
        CONFIG_DEFAULTS.forEach(d => { cfg[d.chave] = d.valor; });
        return cfg;
    }
}

// ── Auditoria do Coletor ─────────────────────────────────────────────────────
router.get('/admin/auditoria', async (req, res) => {
    try {
        const pool = await getDbPool();
        const pagina    = Math.max(1, parseInt(req.query.pagina    || '1'));
        const porPagina = Math.min(200, Math.max(1, parseInt(req.query.porPagina || '50')));
        const tipo      = (req.query.tipo      || '').trim();
        const dataIni   = (req.query.dataInicio || '').trim();
        const dataFim   = (req.query.dataFim    || '').trim();

        // Cria tabela se não existir (pode ser a primeira leitura antes do coletor gravar)
        await pool.request().query(`
            IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='coletor_auditoria' AND xtype='U')
                CREATE TABLE coletor_auditoria (
                    id        INT IDENTITY(1,1) PRIMARY KEY,
                    data_hora DATETIME2 DEFAULT GETUTCDATE(),
                    tipo      NVARCHAR(50)  NOT NULL,
                    detalhe   NVARCHAR(500) NULL,
                    conta     NVARCHAR(100) NULL
                )
        `);

        const wheres = [];
        const cntReq  = pool.request();
        const mainReq = pool.request();
        if (tipo) {
            wheres.push('tipo = @tipo');
            cntReq.input('tipo',  sql.NVarChar, tipo);
            mainReq.input('tipo', sql.NVarChar, tipo);
        }
        if (dataIni) {
            wheres.push('data_hora >= @dataIni');
            cntReq.input('dataIni',  sql.DateTime2, new Date(dataIni + 'T00:00:00'));
            mainReq.input('dataIni', sql.DateTime2, new Date(dataIni + 'T00:00:00'));
        }
        if (dataFim) {
            wheres.push('data_hora <= @dataFim');
            cntReq.input('dataFim',  sql.DateTime2, new Date(dataFim + 'T23:59:59'));
            mainReq.input('dataFim', sql.DateTime2, new Date(dataFim + 'T23:59:59'));
        }
        const w   = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
        const off = (pagina - 1) * porPagina;

        const cntResult = await cntReq.query(`SELECT COUNT(*) AS total FROM coletor_auditoria ${w}`);
        const total = cntResult.recordset[0].total;

        mainReq.input('off', sql.Int, off);
        mainReq.input('pp',  sql.Int, porPagina);
        const rows = await mainReq.query(`
            SELECT id, data_hora, tipo, detalhe, conta
            FROM coletor_auditoria ${w}
            ORDER BY data_hora DESC
            OFFSET @off ROWS FETCH NEXT @pp ROWS ONLY
        `);

        res.json({ success: true, total, pagina, porPagina, data: rows.recordset });
    } catch(e) {
        res.json({ success: false, error: e.message });
    }
});

router.get('/admin/config', async (req, res) => {
    try {
        const pool = await getDbPool();
        await _ensureConfigTable(pool);
        const r = await pool.request().query(`SELECT * FROM bet365_config`);
        // Ordena conforme a sequência definida em CONFIG_DEFAULTS
        const ordemMap = new Map(CONFIG_DEFAULTS.map((d, i) => [d.chave, i]));
        const sorted = r.recordset.slice().sort((a, b) =>
            (ordemMap.get(a.chave) ?? 9999) - (ordemMap.get(b.chave) ?? 9999)
        );
        res.json({ success: true, data: sorted });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/admin/config', async (req, res) => {
    try {
        const pool = await getDbPool();
        await _ensureConfigTable(pool);
        for (const [chave, valor] of Object.entries(req.body || {})) {
            const grupoInferido = chave.startsWith('grid_') ? 'grid'
                : chave.startsWith('liga_') ? 'ligas'
                : chave.startsWith('grafico_') || chave.startsWith('chart_') ? 'grafico'
                : chave.startsWith('alerta_') ? 'alertas'
                : 'cores';
            await pool.request()
                .input('chave', sql.VarChar, chave)
                .input('valor', sql.VarChar, String(valor))
                .input('grupo', sql.VarChar, grupoInferido)
                .query(`
                    IF EXISTS (SELECT 1 FROM bet365_config WHERE chave=@chave)
                        UPDATE bet365_config SET valor=@valor, atualizado=GETUTCDATE() WHERE chave=@chave
                    ELSE
                        INSERT INTO bet365_config (chave,valor,tipo,grupo,descricao)
                        VALUES (@chave,@valor,'text',@grupo,'')
                `);
        }
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

const TIMES_EN_PT = {
    'Albania':'Albânia','Australia':'Austrália','Austria':'Áustria','Belgium':'Bélgica',
    'Brazil':'Brasil','Cameroon':'Camarões','Canada':'Canadá','Croatia':'Croácia',
    'Czechia':'República Tcheca','Czech Republic':'República Tcheca','Denmark':'Dinamarca',
    'Ecuador':'Equador','England':'Inglaterra','France':'França','Georgia':'Geórgia',
    'Germany':'Alemanha','Ghana':'Gana','Hungary':'Hungria','Iran':'Irã','Italy':'Itália',
    'Japan':'Japão','Mexico':'México','Morocco':'Marrocos','Netherlands':'Países Baixos',
    'Poland':'Polônia','Romania':'Romênia','Scotland':'Escócia','Senegal':'Senegal',
    'Serbia':'Sérvia','Slovakia':'Eslováquia','Slovenia':'Eslovênia','South Korea':'Coreia do Sul',
    'Spain':'Espanha','Switzerland':'Suíça','Tunisia':'Tunísia','Turkey':'Turquia',
    'Ukraine':'Ucrânia','Uruguay':'Uruguai','USA':'EUA','Wales':'País de Gales',
};

/**
 * POST /api/bet365/admin/normalizar-dados
 * Normaliza mercados/times em inglês → português no banco
 */
router.post('/admin/normalizar-dados', async (req, res) => {
    try {
        const pool = await getDbPool();
        const timesUpdates = Object.entries(TIMES_EN_PT).flatMap(([en, pt]) => [
            [`UPDATE bet365_resultados_mercados SET time_casa='${pt}' WHERE time_casa='${en}'`, `time_casa ${pt}`],
            [`UPDATE bet365_resultados_mercados SET time_fora='${pt}' WHERE time_fora='${en}'`, `time_fora ${pt}`],
            [`UPDATE bet365_resultados_mercados SET selecao=STUFF(selecao,1,${en.length},'${pt}') WHERE mercado='Gols por Time' AND selecao LIKE '${en} - %'`, `selecao Gols por Time ${pt}`],
        ]);
        const updates = [
            // Ligas
            [`UPDATE bet365_resultados_mercados SET liga='World Cup' WHERE liga IN ('Copa do Mundo','World Cup Virtual')`, 'liga World Cup'],
            [`UPDATE bet365_resultados_mercados SET liga='Premiership' WHERE liga IN ('Premier League','English Premier League')`, 'liga Premiership'],
            // Mercados inglês → português
            [`UPDATE bet365_resultados_mercados SET mercado='Resultado Final' WHERE mercado IN ('Full Time Result','Match Result','1X2')`, 'mercado Resultado Final'],
            [`UPDATE bet365_resultados_mercados SET mercado='Ambos Marcam' WHERE mercado IN ('Both Teams to Score','BTTS')`, 'mercado Ambos Marcam'],
            [`UPDATE bet365_resultados_mercados SET mercado='Resultado Correto' WHERE mercado IN ('Correct Score','Correct Score FT')`, 'mercado Resultado Correto'],
            [`UPDATE bet365_resultados_mercados SET mercado='Resultado Correto - Intervalo' WHERE mercado IN ('Correct Score HT','Half-Time Correct Score','Correct Score - Half Time')`, 'mercado Correto Intervalo'],
            [`UPDATE bet365_resultados_mercados SET mercado='Intervalo Resultado' WHERE mercado IN ('Half Time Result','HT Result','1X2 HT')`, 'mercado Intervalo Resultado'],
            [`UPDATE bet365_resultados_mercados SET mercado='Intervalo/Final' WHERE mercado IN ('Half-Time/Full-Time','HT/FT')`, 'mercado HT/FT'],
            [`UPDATE bet365_resultados_mercados SET mercado='Chance Dupla' WHERE mercado IN ('Double Chance')`, 'mercado Chance Dupla'],
            // Seleções comuns em inglês → português
            [`UPDATE bet365_resultados_mercados SET selecao='Empate' WHERE mercado='Resultado Final' AND selecao IN ('Draw','The Draw')`, 'selecao Empate'],
            [`UPDATE bet365_resultados_mercados SET selecao='Sim' WHERE mercado='Ambos Marcam' AND selecao IN ('Yes')`, 'selecao Sim'],
            [`UPDATE bet365_resultados_mercados SET selecao='Não' WHERE mercado='Ambos Marcam' AND selecao IN ('No')`, 'selecao Não'],
            [`UPDATE bet365_resultados_mercados SET selecao='Qualquer Outro Resultado' WHERE mercado='Resultado Correto - Intervalo' AND selecao IN ('Any Other Score','Any Unquoted')`, 'selecao Qualquer Outro'],
            // Team Goals
            [`UPDATE bet365_resultados_mercados SET mercado='Gols por Time' WHERE mercado='Team Goals'`, 'mercado Gols por Time'],
            [`UPDATE bet365_resultados_mercados SET selecao=REPLACE(REPLACE(selecao,' Goals',' Gols'),' Goal',' Gol') WHERE mercado='Gols por Time' AND (selecao LIKE '% Goals' OR selecao LIKE '% Goal' OR selecao LIKE '%+ Goals' OR selecao LIKE '%+ Goal')`, 'selecao Goals/Goal→Gols/Gol'],
            // Over/Under como nomes de seleção
            [`UPDATE bet365_resultados_mercados SET selecao='Mais de 0.5' WHERE selecao='Over 0.5'`, 'selecao Over 0.5'],
            [`UPDATE bet365_resultados_mercados SET selecao='Mais de 1.5' WHERE selecao='Over 1.5'`, 'selecao Over 1.5'],
            [`UPDATE bet365_resultados_mercados SET selecao='Mais de 2.5' WHERE selecao='Over 2.5'`, 'selecao Over 2.5'],
            [`UPDATE bet365_resultados_mercados SET selecao='Mais de 3.5' WHERE selecao='Over 3.5'`, 'selecao Over 3.5'],
            [`UPDATE bet365_resultados_mercados SET selecao='Mais de 4.5' WHERE selecao='Over 4.5'`, 'selecao Over 4.5'],
            [`UPDATE bet365_resultados_mercados SET selecao='Menos de 1.5' WHERE selecao='Under 1.5'`, 'selecao Under 1.5'],
            [`UPDATE bet365_resultados_mercados SET selecao='Menos de 2.5' WHERE selecao='Under 2.5'`, 'selecao Under 2.5'],
            [`UPDATE bet365_resultados_mercados SET selecao='Menos de 3.5' WHERE selecao='Under 3.5'`, 'selecao Under 3.5'],
            // Mercados adicionais inglês → português
            [`UPDATE bet365_resultados_mercados SET mercado='Total de Gols' WHERE mercado IN ('Total Goals','Goals Over/Under','Over/Under')`, 'mercado Total de Gols'],
            [`UPDATE bet365_resultados_mercados SET mercado='Handicap Asiático' WHERE mercado IN ('Asian Handicap','Asian Handicap FT')`, 'mercado Handicap Asiático'],
            [`UPDATE bet365_resultados_mercados SET mercado='Handicap Europeu' WHERE mercado IN ('European Handicap','Handicap')`, 'mercado Handicap Europeu'],
            [`UPDATE bet365_resultados_mercados SET mercado='Próximo Gol' WHERE mercado IN ('Next Goal','Next Goal Scorer')`, 'mercado Próximo Gol'],
            [`UPDATE bet365_resultados_mercados SET mercado='Sem Sofrer Gol' WHERE mercado IN ('Clean Sheet','To Keep a Clean Sheet')`, 'mercado Sem Sofrer Gol'],
            [`UPDATE bet365_resultados_mercados SET mercado='Resultado Sem Empate' WHERE mercado IN ('Draw No Bet')`, 'mercado Resultado Sem Empate'],
            [`UPDATE bet365_resultados_mercados SET mercado='Vencer Sem Sofrer Gol' WHERE mercado IN ('Win to Nil','To Win to Nil')`, 'mercado Vencer Sem Sofrer Gol'],
            [`UPDATE bet365_resultados_mercados SET mercado='Ambos Marcam e Resultado' WHERE mercado IN ('Both Teams to Score & Win','BTTS & Win','BTTS and Win')`, 'mercado BTTS e Resultado'],
            [`UPDATE bet365_resultados_mercados SET mercado='Escanteios' WHERE mercado IN ('Match Corners','Total Corners','Corners Over/Under')`, 'mercado Escanteios'],
            [`UPDATE bet365_resultados_mercados SET mercado='Cartões' WHERE mercado IN ('Booking Points','Cards','Match Cards')`, 'mercado Cartões'],
            [`UPDATE bet365_resultados_mercados SET mercado='Intervalo/Final' WHERE mercado IN ('1st Half/Full Time','First Half/Full Time')`, 'mercado HT/FT alt'],
            [`UPDATE bet365_resultados_mercados SET mercado='Marcador do Primeiro Gol' WHERE mercado IN ('First Goal Scorer','First Goalscorer')`, 'mercado Primeiro Gol Marcador'],
            [`UPDATE bet365_resultados_mercados SET mercado='Marcador a Qualquer Hora' WHERE mercado IN ('Anytime Scorer','Anytime Goalscorer','To Score Anytime')`, 'mercado Marcador a Qualquer Hora'],
            // Seleções de resultado em inglês → português (fora do mercado Resultado Final)
            [`UPDATE bet365_resultados_mercados SET selecao='Casa' WHERE selecao IN ('Home','Home Win','1')`, 'selecao Casa'],
            [`UPDATE bet365_resultados_mercados SET selecao='Fora' WHERE selecao IN ('Away','Away Win','2')`, 'selecao Fora'],
            [`UPDATE bet365_resultados_mercados SET selecao='Empate' WHERE selecao IN ('Draw','The Draw','X') AND mercado<>'Resultado Final'`, 'selecao Empate geral'],
            [`UPDATE bet365_resultados_mercados SET selecao='Sim' WHERE selecao IN ('Yes') AND mercado<>'Ambos Marcam'`, 'selecao Sim geral'],
            [`UPDATE bet365_resultados_mercados SET selecao='Não' WHERE selecao IN ('No') AND mercado<>'Ambos Marcam'`, 'selecao Não geral'],
            // Over/Under como mercados
            [`UPDATE bet365_resultados_mercados SET selecao=REPLACE(selecao,'Over ','Mais de ') WHERE selecao LIKE 'Over [0-9]%'`, 'selecao Over→Mais de'],
            [`UPDATE bet365_resultados_mercados SET selecao=REPLACE(selecao,'Under ','Menos de ') WHERE selecao LIKE 'Under [0-9]%'`, 'selecao Under→Menos de'],
            // Qualquer outro resultado
            [`UPDATE bet365_resultados_mercados SET selecao='Qualquer Outro Resultado' WHERE selecao IN ('Any Other Score','Any Unquoted','Any Other') AND mercado<>'Resultado Correto - Intervalo'`, 'selecao Qualquer Outro alt'],
        ];
        let totalAffected = 0;
        const detalhes = [];
        for (const [sql_str, label] of [...updates, ...timesUpdates]) {
            const r = await pool.request().query(sql_str);
            const n = r.rowsAffected?.[0] || 0;
            totalAffected += n;
            if (n > 0) detalhes.push(`${label}: ${n} linhas`);
        }
        res.json({ success: true, total: totalAffected, detalhes });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * POST /api/bet365/admin/excluir-liga
 * Remove todos os dados de uma liga do banco
 */
router.post('/admin/excluir-liga', async (req, res) => {
    try {
        const { liga } = req.body || {};
        if (!liga) return res.status(400).json({ success: false, error: 'Liga não informada' });
        const pool = await getDbPool();
        const r = await pool.request()
            .input('liga', sql.NVarChar(200), liga)
            .query(`DELETE FROM bet365_resultados_mercados WHERE liga = @liga`);
        const total = r.rowsAffected?.[0] || 0;
        res.json({ success: true, total, liga });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * POST /api/bet365/admin/excluir-por-periodo
 * Remove registros mais antigos que N dias de uma liga (mínimo 30 dias)
 */
router.post('/admin/excluir-por-periodo', async (req, res) => {
    try {
        const { liga, dias } = req.body || {};
        const diasNum = parseInt(dias, 10);
        if (!diasNum || diasNum < 30) return res.status(400).json({ success: false, error: 'Mínimo de 30 dias para manter' });
        const pool = await getDbPool();
        const req2 = pool.request().input('dias', sql.Int, diasNum);
        let query = `DELETE FROM bet365_resultados_mercados WHERE data_registro < DATEADD(day, -@dias, GETUTCDATE())`;
        if (liga && liga !== 'Todas') {
            req2.input('liga', sql.NVarChar(200), ligaParaBanco(liga));
            query += ` AND liga = @liga`;
        }
        const r = await req2.query(query);
        const total = r.rowsAffected?.[0] || 0;
        res.json({ success: true, total, liga: liga || 'Todas', dias: diasNum });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── Slots esperados por liga (minutos do horário UTC) ──
const LIGA_SLOTS_SRV = {
    'World Cup':                [1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58],
    'Euro Cup':                 [2,5,8,11,14,17,20,23,26,29,32,35,38,41,44,47,50,53,56,59],
    'Premiership':              [0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57],
    'Super Liga Sul-Americana': [1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58],
    'Express Cup':              Array.from({length:60},(_,i)=>i),
};
function _snapSlot(minuto, slots) {
    let best = slots[0], bestDist = Infinity;
    for (const s of slots) { const d = Math.abs(s - minuto); if (d < bestDist) { bestDist = d; best = s; } }
    return best;
}

/**
 * POST /api/bet365/admin/analisar-corrigir
 * Analisa jogos com data_partida no minuto errado para a liga e corrige se solicitado
 */
router.post('/admin/analisar-corrigir', async (req, res) => {
    try {
        const { liga, data, hora, corrigir = false } = req.body || {};
        if (!liga || !data) return res.status(400).json({ success: false, error: 'Liga e data são obrigatórios' });
        const slots = LIGA_SLOTS_SRV[liga];
        if (!slots) return res.status(400).json({ success: false, error: `Liga não reconhecida: ${liga}` });

        const pool = await getDbPool();
        const req2 = pool.request()
            .input('liga', sql.NVarChar(200), liga)
            .input('data', sql.NVarChar(10), data);
        let where = `liga = @liga AND CONVERT(VARCHAR(10), data_partida, 120) = @data`;
        if (hora !== undefined && hora !== null && hora !== '') {
            req2.input('hora', sql.Int, parseInt(hora));
            where += ` AND DATEPART(HOUR, data_partida) = @hora`;
        }

        const r = await req2.query(`
            SELECT DISTINCT
                data_partida,
                time_casa, time_fora,
                DATEPART(HOUR,   data_partida) AS h,
                DATEPART(MINUTE, data_partida) AS m
            FROM bet365_resultados_mercados
            WHERE ${where}
            ORDER BY data_partida
        `);

        const erros = [];
        for (const row of r.recordset) {
            const mCorreto = _snapSlot(row.m, slots);
            if (row.m !== mCorreto) {
                erros.push({
                    data_partida: row.data_partida,
                    time_casa:    row.time_casa,
                    time_fora:    row.time_fora,
                    hora:         row.h,
                    minuto_atual: row.m,
                    minuto_correto: mCorreto,
                    diff: mCorreto - row.m,
                });
            }
        }

        let corrigidos = 0;
        if (corrigir && erros.length > 0) {
            for (const e of erros) {
                const rUpd = await pool.request()
                    .input('liga', sql.NVarChar(200), liga)
                    .input('tc',   sql.NVarChar(100), e.time_casa)
                    .input('tf',   sql.NVarChar(100), e.time_fora)
                    .input('dp',   sql.DateTime2,     new Date(e.data_partida))
                    .input('diff', sql.Int,            e.diff)
                    .query(`
                        UPDATE bet365_resultados_mercados
                        SET data_partida = DATEADD(MINUTE, @diff, data_partida)
                        WHERE liga=@liga AND time_casa=@tc AND time_fora=@tf AND data_partida=@dp
                    `);
                corrigidos += rUpd.rowsAffected?.[0] || 0;
            }
        }

        res.json({
            success: true, liga, data, hora: hora || null,
            total_partidas: r.recordset.length,
            erros_encontrados: erros.length,
            erros,
            corrigidos: corrigir ? corrigidos : null,
        });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Endpoint: testar alertas
router.post('/admin/testar-alerta', async (req, res) => {
    try {
        const { dispararAlerta } = require('../services/alertas');
        const cfg  = await getSystemConfig();
        const pool = await getDbPool();
        const agora = new Date().toLocaleString('pt-BR');
        await dispararAlerta(cfg, pool, '🧪 Teste de Alerta', `Se você recebeu esta mensagem, os alertas estão configurados corretamente!\n🕐 ${agora}`);
        res.json({ success: true });
    } catch(e) {
        res.json({ success: false, error: e.message });
    }
});

module.exports = router;
module.exports.getSystemConfig = getSystemConfig;
module.exports.getDbPool       = getDbPool;
