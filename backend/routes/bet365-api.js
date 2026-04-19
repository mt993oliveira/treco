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
                e.seconds_to_start,
                e.status,
                e.gol_casa,
                e.gol_fora,
                e.minuto_jogo,
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

        query += ' GROUP BY e.id, e.time_casa, e.time_fora, e.league_name, e.start_time_datetime, e.seconds_to_start, e.status, e.gol_casa, e.gol_fora, e.minuto_jogo, e.odd_casa, e.odd_empate, e.odd_fora ORDER BY e.start_time_datetime ASC';

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
                e.gol_casa,
                e.gol_fora,
                e.minuto_jogo,
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
                SUM(CASE WHEN status = 'AGENDADO' THEN 1 ELSE 0 END) AS agendados,
                AVG(gol_casa + gol_fora) AS media_gols
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
                    e.seconds_to_start,
                    e.status,
                    e.gol_casa,
                    e.gol_fora,
                    e.minuto_jogo,
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
            pool.query(`SELECT TOP 10 id, time_casa, time_fora, league_name, gol_casa, gol_fora, status FROM bet365_eventos ORDER BY data_atualizacao DESC`),
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
        const nParam = Math.min(100, Math.max(3, parseInt(req.query.n) || 10));
        const pool = await getDbPool();

        // Ligas com ao menos 5 jogos distintos
        const ligasResult = await pool.query(`
            SELECT liga, COUNT(DISTINCT evento_id) AS total
            FROM bet365_resultados_mercados
            WHERE liga IS NOT NULL AND liga <> ''
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
                    SELECT TOP 200
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
                    WHERE liga = @liga
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
                { id: 'over0.5',   label: 'Over 0.5',    check: j => j.over05 },
                { id: 'over1.5',   label: 'Over 1.5',    check: j => j.over15 },
                { id: 'over2.5',   label: 'Over 2.5',    check: j => j.over25 },
                { id: 'over3.5',   label: 'Over 3.5',    check: j => j.over35 },
                { id: 'under1.5',  label: 'Under 1.5',   check: j => j.under15 },
                { id: 'under2.5',  label: 'Under 2.5',   check: j => j.under25 },
                { id: 'ambas',     label: 'Ambas Marcam', check: j => j.btts },
                { id: 'ft_casa',   label: 'Casa Vence',  check: j => j.resultado === 'CASA' },
                { id: 'ft_empate', label: 'Empate',      check: j => j.resultado === 'EMPATE' },
                { id: 'ft_fora',   label: 'Fora Vence',  check: j => j.resultado === 'FORA' },
                { id: 'btts_o25',  label: 'BTTS + O2.5', check: j => j.btts && j.over25 },
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
        const { liga, horas = 24 } = req.query;
        const horasNum = Math.min(Math.max(parseInt(horas) || 24, 1), 720);
        const pool = await getDbPool();

        const request = pool.request();
        request.input('horas', sql.Int, horasNum);

        let query = `
            SELECT evento_id, liga, time_casa, time_fora, data_partida,
                   mercado, selecao, CAST(odd_paga AS FLOAT) AS odd_paga
            FROM bet365_resultados_mercados
            WHERE data_partida >= DATEADD(HOUR, -@horas, GETUTCDATE())
              AND data_partida <= DATEADD(HOUR, 2, GETUTCDATE())
        `;

        if (liga && liga !== 'all') {
            query += ' AND liga LIKE @liga';
            request.input('liga', sql.NVarChar(200), `%${ligaParaBanco(liga)}%`);
        }

        query += ' ORDER BY data_partida ASC, evento_id';

        const result = await request.query(query);

        // Agrupa por evento_id
        const gamesMap = new Map();
        for (const r of result.recordset) {
            const key = String(r.evento_id);
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

            // Resultado FT — "Resultado Final": selecao = nome do time ou "Empate"
            const rfMkt = mkts.find(m => /resultado final/i.test(m.mercado));
            if (rfMkt) {
                j.resultado = rfMkt.selecao === j.time_casa ? 'CASA'
                            : rfMkt.selecao === j.time_fora ? 'FORA' : 'EMPATE';
                // Odd paga do resultado final como odd do vencedor
                if (j.resultado === 'CASA')   j.odd_casa   = rfMkt.odd_paga;
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
            const htMkt = mkts.find(m => /correto.*intervalo|intervalo.*correto/i.test(m.mercado));
            if (htMkt) {
                const sc = parseSelecaoScore(htMkt.selecao);
                if (sc) { j.gol_casa_ht = sc.casa; j.gol_fora_ht = sc.fora; }
            }

            // Placar FT de "Resultado Correto" (sem "Intervalo")
            const ftCorMkt = mkts.find(m => /resultado correto/i.test(m.mercado) && !/intervalo/i.test(m.mercado));
            if (ftCorMkt) {
                const sc = parseSelecaoScore(ftCorMkt.selecao);
                if (sc) { j.gol_casa = sc.casa; j.gol_fora = sc.fora; }
            }

            // Fallback: deriva gols totais dos mercados Over/Under para exibição
            if (j.gol_casa === null) {
                const o05 = mkts.some(m => m.mercado.includes('0.5') && m.selecao.startsWith('Mais'));
                const o15 = mkts.some(m => m.mercado.includes('1.5') && m.selecao.startsWith('Mais'));
                const o25 = mkts.some(m => m.mercado.includes('2.5') && m.selecao.startsWith('Mais'));
                const o35 = mkts.some(m => m.mercado.includes('3.5') && m.selecao.startsWith('Mais'));
                const o45 = mkts.some(m => m.mercado.includes('4.5') && m.selecao.startsWith('Mais'));
                // Armazena total_gols derivado (exibição apenas — scores individuais desconhecidos)
                j.total_gols = !o05 ? 0 : !o15 ? 1 : !o25 ? 2 : !o35 ? 3 : !o45 ? 4 : 5;
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

        const nRecenteN     = Math.max(5,  parseInt(nRecente)    || 20);
        const minJogosHistN = Math.max(3,  parseInt(minJogosHist) || 10);
        const minJogosRecN  = Math.max(1,  parseInt(minJogosRec)  || 5);
        const minVariacaoN  = Math.max(1,  parseFloat(minVariacao) || 10);
        const diasNum       = parseInt(dias) || 0;

        const pool    = await getDbPool();
        const req1    = pool.request().input('nRecente', sql.Int, nRecenteN);
        const req2    = pool.request();

        const ligaDb2    = ligaParaBanco(liga);
        const ligaWhere1 = ligaDb2 && ligaDb2 !== 'all' ? (req1.input('liga', sql.NVarChar(200), ligaDb2), 'AND liga = @liga') : '';
        const ligaWhere2 = ligaDb2 && ligaDb2 !== 'all' ? (req2.input('liga2', sql.NVarChar(200), ligaDb2), 'AND liga = @liga2') : '';
        const diasWhere  = diasNum > 0 ? `AND data_partida >= DATEADD(DAY,-${diasNum},GETUTCDATE())` : '';

        // Histórico total — denominador correto: total de jogos com aquele mercado (não só aquela seleção)
        const total = await req2.query(`
            SELECT liga, mercado, selecao,
                   COUNT(DISTINCT evento_id) AS vezes,
                   SUM(COUNT(DISTINCT evento_id)) OVER (PARTITION BY liga, mercado) AS total_mkt
            FROM bet365_resultados_mercados
            WHERE 1=1 ${ligaWhere2} ${diasWhere}
            GROUP BY liga, mercado, selecao
        `).catch(() => ({ recordset: [] }));

        // Últimos N jogos por liga — mesmo denominador correto
        const recente = await req1.query(`
            WITH ult AS (
                SELECT liga, evento_id,
                       ROW_NUMBER() OVER (PARTITION BY liga ORDER BY MAX(data_partida) DESC) AS rn
                FROM bet365_resultados_mercados
                WHERE 1=1 ${ligaWhere1} ${diasWhere}
                GROUP BY liga, evento_id
            )
            SELECT m.liga, m.mercado, m.selecao,
                   COUNT(DISTINCT m.evento_id) AS vezes,
                   SUM(COUNT(DISTINCT m.evento_id)) OVER (PARTITION BY m.liga, m.mercado) AS total_mkt
            FROM bet365_resultados_mercados m
            INNER JOIN ult u ON u.liga = m.liga AND u.evento_id = m.evento_id AND u.rn <= @nRecente
            WHERE 1=1 ${ligaWhere1}
            GROUP BY m.liga, m.mercado, m.selecao
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
                jogos_hist: hist.jogos, jogos_rec: r.jogos
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
 */
router.get('/analise/sugestoes-avancadas', async (req, res) => {
    try {
        const pool = await getDbPool();

        // Eventos agendados
        const eventos = await pool.query(`
            SELECT id AS evento_id, league_name AS liga, time_casa, time_fora,
                   start_time_datetime AS horario, odd_casa, odd_empate, odd_fora
            FROM bet365_eventos
            WHERE ativo = 1 AND status = 'AGENDADO'
            ORDER BY start_time_datetime ASC
        `);

        if (eventos.recordset.length === 0) {
            return res.json({ success: true, data: [] });
        }

        // Estatísticas de mercados por liga — denominador correto (window function)
        const statsLiga = await pool.query(`
            WITH base AS (
                SELECT liga, mercado, selecao,
                    COUNT(*) AS vezes,
                    SUM(COUNT(*)) OVER (PARTITION BY liga, mercado) AS total_jogos,
                    AVG(CAST(odd_paga AS FLOAT)) AS odd_f
                FROM bet365_resultados_mercados
                WHERE data_partida >= DATEADD(DAY, -30, GETUTCDATE())
                GROUP BY liga, mercado, selecao
            )
            SELECT liga, mercado, selecao, vezes, total_jogos,
                CAST(odd_f AS DECIMAL(7,2)) AS odd_media,
                CAST(vezes*100.0/NULLIF(total_jogos,0) AS DECIMAL(6,1)) AS pct
            FROM base
            WHERE total_jogos >= 10
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

module.exports = router;
