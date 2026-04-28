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
        const nParam  = Math.min(100, Math.max(3, parseInt(req.query.n) || 10));
        const diasN   = req.query.dias === 'tudo' ? null : (parseInt(req.query.dias) || null);
        const pool    = await getDbPool();
        const diasWhere = diasN ? `AND data_partida >= DATEADD(DAY, -${diasN}, GETUTCDATE())` : '';

        // Ligas com ao menos 5 jogos distintos (respeitando o período)
        const ligasResult = await pool.query(`
            SELECT liga, COUNT(DISTINCT evento_id) AS total
            FROM bet365_resultados_mercados
            WHERE liga IS NOT NULL AND liga <> '' ${diasWhere}
            GROUP BY liga
            HAVING COUNT(DISTINCT evento_id) >= 5
            ORDER BY total DESC
        `);

        const resultado = [];

        for (const l of ligasResult.recordset) {
            // Busca todos os eventos da liga com seus mercados-chave (até 200 eventos)
            const pResult = await pool.request()
                .input('liga', sql.NVarChar(200), l.liga)
                .query(`
                    SELECT TOP 500
                        evento_id, data_partida,
                        MAX(CASE WHEN mercado = 'Resultado Final' THEN selecao END) AS resultado_final,
                        MAX(CASE WHEN time_casa IS NOT NULL THEN time_casa END) AS time_casa,
                        MAX(CASE WHEN time_fora IS NOT NULL THEN time_fora END) AS time_fora,
                        MAX(CASE WHEN mercado LIKE '%0.5%' AND selecao LIKE 'Mais%' THEN 1 ELSE 0 END) AS over05,
                        MAX(CASE WHEN mercado LIKE '%1.5%' AND selecao LIKE 'Mais%' THEN 1 ELSE 0 END) AS over15,
                        MAX(CASE WHEN mercado LIKE '%2.5%' AND selecao LIKE 'Mais%' THEN 1 ELSE 0 END) AS over25,
                        MAX(CASE WHEN mercado LIKE '%3.5%' AND selecao LIKE 'Mais%' THEN 1 ELSE 0 END) AS over35,
                        MAX(CASE WHEN mercado LIKE '%1.5%' AND selecao LIKE 'Menos%' THEN 1 ELSE 0 END) AS under15,
                        MAX(CASE WHEN mercado LIKE '%2.5%' AND selecao LIKE 'Menos%' THEN 1 ELSE 0 END) AS under25,
                        MAX(CASE WHEN mercado = 'Ambos Marcam' AND selecao = 'Sim' THEN 1 ELSE 0 END) AS btts
                    FROM bet365_resultados_mercados
                    WHERE liga = @liga ${diasWhere}
                    GROUP BY evento_id, data_partida
                    ORDER BY data_partida DESC
                `);

            const partidas = pResult.recordset.map(p => ({
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

            const FILTROS = [
                { id: 'over0.5',   label: 'Mais de 0.5',  check: j => j.over05 },
                { id: 'over1.5',   label: 'Mais de 1.5',  check: j => j.over15 },
                { id: 'over2.5',   label: 'Mais de 2.5',  check: j => j.over25 },
                { id: 'over3.5',   label: 'Mais de 3.5',  check: j => j.over35 },
                { id: 'under1.5',  label: 'Menos de 1.5', check: j => j.under15 },
                { id: 'under2.5',  label: 'Menos de 2.5', check: j => j.under25 },
                { id: 'ambas',     label: 'Ambas Marcam', check: j => j.btts },
                { id: 'ft_casa',   label: 'Casa Vence',   check: j => j.resultado === 'CASA' },
                { id: 'ft_empate', label: 'Empate',       check: j => j.resultado === 'EMPATE' },
                { id: 'ft_fora',   label: 'Fora Vence',   check: j => j.resultado === 'FORA' },
                { id: 'btts_o25',  label: 'BTTS + Mais 2.5', check: j => j.btts && j.over25 },
            ];

            const n = partidas.length;
            const filtroStats = FILTROS.map(f => {
                const nN = Math.min(nParam, n), n5 = Math.min(5,n), n10 = Math.min(10,n), n20 = Math.min(20,n);
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

            // Stats derivadas de mercados
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
                liga: l.liga, total: l.total, amostras: n,
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
            SELECT evento_id, liga, time_casa, time_fora, data_partida,
                   mercado, selecao, CAST(odd_paga AS FLOAT) AS odd_paga, data_registro
            FROM bet365_resultados_mercados
            WHERE data_partida >= DATEADD(HOUR, -@horas, GETUTCDATE())
              AND data_partida <= DATEADD(HOUR, 2, GETUTCDATE())
        `;

        if (liga && liga !== 'all') {
            query += ' AND liga LIKE @liga';
            request.input('liga', sql.NVarChar(200), `%${ligaParaBanco(liga)}%`);
        }

        // data_registro DESC garante que linhas mais recentes (resultado final real) venham
        // primeiro ao iterar mkts — evita retornar placar intermediário de jogo em andamento
        query += ' ORDER BY data_partida ASC, evento_id, data_registro DESC';

        const result = await request.query(query);

        // Agrupa por evento_id + minuto do data_partida.
        // O mesmo evento_id pode ter data_partida diferentes quando o coletor associa
        // erroneamente o resultado de um jogo ao evento de outro jogo com os mesmos times
        // em horário diferente. A chave composta garante que cada slot de tempo gera
        // uma entrada separada, evitando que o jogo apareça no bucket de hora errado.
        const gamesMap = new Map();
        for (const r of result.recordset) {
            const minuteKey = String(r.data_partida).substring(0, 16);
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
                    odd_casa:     0,
                    odd_fora:     0,
                    odd_empate:   0,
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
            dias       = 7,
            minJogos   = 3,
            minPct     = 0,
            tipoMercado = '',
            soValueBets = '0',
            minVE      = 0,
        } = req.query;

        const diasNum   = dias === 'tudo' ? 9999 : Math.min(parseInt(dias) || 7, 365);
        const minJogosN = Math.max(1, parseInt(minJogos) || 3);
        const minPctN   = Math.max(0, parseFloat(minPct)  || 0);
        const minVEN    = Math.max(0, parseFloat(minVE)   || 0);
        const pool      = await getDbPool();
        const request   = pool.request()
            .input('minJogos',  sql.Int,   minJogosN)
            .input('minPct',    sql.Float, minPctN)
            .input('minVE',     sql.Float, minVEN);

        const whereParts = [];
        if (diasNum < 9999) {
            request.input('dias', sql.Int, diasNum);
            whereParts.push('m.data_partida >= DATEADD(DAY, -@dias, GETUTCDATE())');
        }
        if (liga && liga !== 'all') {
            request.input('liga', sql.NVarChar(200), ligaParaBanco(liga));
            whereParts.push('m.liga = @liga');
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

        res.json({ success: true, dias: diasNum, filtros: { minJogos: minJogosN, minPct: minPctN, tipoMercado, soValueBets }, data: agrupado });
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
            nRecente    = 20,
            minJogosHist = 10,
            minJogosRec  = 5,
            minVariacao  = 10,
            dias         = 0,   // 0 = todo o histórico
        } = req.query;

        const nRecenteN     = Math.max(5,  parseInt(nRecente)    || 30);
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
        const { liga, dias = 30 } = req.query;
        const diasN    = parseInt(dias) || 30;
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

        // Filtro de liga para estatísticas
        let statsLigaWhere = '';
        if (ligaDb && ligaDb !== 'all') {
            reqStats.input('ligaSt', sql.NVarChar(200), ligaDb);
            statsLigaWhere = 'AND liga = @ligaSt';
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

        // Estatísticas de mercados por liga — denominador correto (window function)
        const statsLiga = await reqStats.query(`
            WITH base AS (
                SELECT liga, mercado, selecao,
                    COUNT(DISTINCT evento_id) AS vezes,
                    SUM(COUNT(DISTINCT evento_id)) OVER (PARTITION BY liga, mercado) AS total_jogos,
                    AVG(CAST(odd_paga AS FLOAT)) AS odd_f
                FROM bet365_resultados_mercados
                WHERE data_partida >= DATEADD(DAY, -${diasN}, GETUTCDATE()) ${statsLigaWhere}
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
            dias       = 7,
            liga,
            minJogos   = 5,
            minVE      = 0.95,
            soValueBets = '0',
        } = req.query;

        const diasNum   = dias === 'tudo' ? 9999 : Math.min(parseInt(dias) || 7, 365);
        const minJogosN = Math.max(1, parseInt(minJogos) || 5);
        const minVEN    = Math.max(0, parseFloat(minVE)  || 0.95);
        const pool      = await getDbPool();

        const diasWhere  = diasNum < 9999 ? `AND data_partida >= DATEADD(DAY,-${diasNum},GETUTCDATE())` : '';
        const ligaDb     = ligaParaBanco(liga);
        const ligaWhere  = (ligaDb && ligaDb !== 'all') ? `AND liga = '${ligaDb.replace(/'/g,"''")}'` : '';
        // threshold de VE para value bets (referencia ve_raw do CTE)
        const veThreshold = (soValueBets === '1' || minVEN > 0) ? Math.max(minVEN, 0) : 0.90;
        const vbWhere    = `AND ve_raw >= ${veThreshold}`;

        const [vol, porLiga, topMkt, valueBets] = await Promise.all([
            // Volume geral (filtrado pelo período e liga)
            pool.query(`
                SELECT
                    COUNT(DISTINCT evento_id) AS jogos,
                    COUNT(*) AS mercados_total,
                    COUNT(DISTINCT mercado) AS tipos_mercado,
                    MIN(data_partida) AS primeiro_jogo,
                    MAX(data_partida) AS ultimo_jogo
                FROM bet365_resultados_mercados
                WHERE 1=1 ${diasWhere} ${ligaWhere}
            `),
            // Por liga (filtrado)
            pool.query(`
                SELECT liga,
                    COUNT(DISTINCT evento_id) AS jogos,
                    COUNT(*) AS mercados
                FROM bet365_resultados_mercados
                WHERE 1=1 ${diasWhere} ${ligaWhere}
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
                    WHERE 1=1 ${diasWhere} ${ligaWhere}
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
                    WHERE 1=1 ${diasWhere} ${ligaWhere}
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
            filtros:    { dias: diasNum, liga: liga || 'all', minJogos: minJogosN, minVE: minVEN },
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
    { chave:'default_so_value_bets',        valor:'false', tipo:'boolean', grupo:'frontend', descricao:'Apenas value bets por padrão (Análise)' },
    // ── Sistema ──
    { chave:'sessao_timeout_minutos',       valor:'180',   tipo:'number',  grupo:'sistema',  descricao:'Timeout de sessão em minutos (0 = nunca expirar; MASTER sempre ativo)' },
    { chave:'auto_refresh_segundos',        valor:'120',   tipo:'number',  grupo:'sistema',  descricao:'Intervalo de atualização automática da grade (segundos; 0 = desativar)' },
    { chave:'tour_dias',                    valor:'7',     tipo:'number',  grupo:'sistema',  descricao:'Tour de onboarding: exibir por N dias após a data de licença (0 = desativado para todos)' },
    { chave:'fonte_proximos',               valor:'results',tipo:'text',   grupo:'sistema',  descricao:'Fonte dos próximos jogos: results = página de resultados | none = desativado' },
    { chave:'max_padroes_usuario',          valor:'5',     tipo:'number',  grupo:'sistema',  descricao:'Limite de padrões de gráfico por usuário (1–10)' },
    { chave:'max_value_bets',               valor:'5',     tipo:'number',  grupo:'sistema',  descricao:'Máximo de sugestões exibidas em 💰 Value Bets (1–20)' },
    { chave:'max_tendencias',               valor:'8',     tipo:'number',  grupo:'sistema',  descricao:'Máximo de itens exibidos em 📈 Tendências (1–20)' },
    { chave:'max_ver_mais_clicks',          valor:'10',    tipo:'number',  grupo:'sistema',  descricao:'Cliques em "Ver Mais" ao coletar resultados (mais cliques = mais jogos históricos por ciclo)' },
    // ── Seções da Análise ──
    { chave:'show_secao_ia',                valor:'true',  tipo:'boolean', grupo:'secoes',   descricao:'Exibir seção: IA — Sugestões para Próximos Jogos' },
    { chave:'show_secao_value_bets',        valor:'true',  tipo:'boolean', grupo:'secoes',   descricao:'Exibir seção: Value Bets' },
    { chave:'show_secao_tendencias',        valor:'true',  tipo:'boolean', grupo:'secoes',   descricao:'Exibir seção: Tendências' },
    { chave:'show_secao_frequencia',        valor:'true',  tipo:'boolean', grupo:'secoes',   descricao:'Exibir seção: Frequência dos Mercados' },
    { chave:'show_secao_desempenho',        valor:'true',  tipo:'boolean', grupo:'secoes',   descricao:'Exibir seção: Desempenho por Liga' },
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
            await pool.request()
                .input('chave', sql.VarChar, chave)
                .input('valor', sql.VarChar, String(valor))
                .query(`UPDATE bet365_config SET valor=@valor, atualizado=GETUTCDATE() WHERE chave=@chave`);
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

module.exports = router;
module.exports.getSystemConfig = getSystemConfig;
