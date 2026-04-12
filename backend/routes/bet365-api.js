/**
 * ============================================
 * API REST - BET365 DADOS EM TEMPO REAL
 * ============================================
 */

const express = require('express');
const sql = require('mssql');
const router = express.Router();

let sqlPool = null;

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

// ─── Garante colunas em bet365_historico_partidas ───
let _schemaOk = false;
async function garantirSchema(pool) {
    if (_schemaOk) return;
    try {
        await pool.query(`
            IF NOT EXISTS (
                SELECT 1 FROM sys.columns
                WHERE object_id = OBJECT_ID('bet365_historico_partidas')
                AND name = 'resultado_estimado'
            )
            ALTER TABLE bet365_historico_partidas ADD resultado_estimado BIT NOT NULL DEFAULT 0
        `);
        await pool.query(`
            IF NOT EXISTS (
                SELECT 1 FROM sys.columns
                WHERE object_id = OBJECT_ID('bet365_historico_partidas')
                AND name = 'gol_casa_ht'
            )
            ALTER TABLE bet365_historico_partidas ADD gol_casa_ht TINYINT NULL
        `);
        await pool.query(`
            IF NOT EXISTS (
                SELECT 1 FROM sys.columns
                WHERE object_id = OBJECT_ID('bet365_historico_partidas')
                AND name = 'gol_fora_ht'
            )
            ALTER TABLE bet365_historico_partidas ADD gol_fora_ht TINYINT NULL
        `);
        _schemaOk = true;
    } catch (e) {
        console.warn('⚠️ garantirSchema bet365_historico_partidas:', e.message);
    }
}

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
 * GET /api/bet365/historico-partidas
 * Retorna histórico de partidas
 */
router.get('/historico-partidas', async (req, res) => {
    try {
        const { limite = 50, liga, time } = req.query;
        const pool = await getDbPool();

        let query = `
            SELECT
                id, evento_id, liga, time_casa, time_fora,
                gol_casa, gol_fora, resultado,
                odd_casa, odd_empate, odd_fora, data_partida
            FROM bet365_historico_partidas
            WHERE 1=1
        `;

        const request = pool.request();

        if (liga) {
            query += ' AND liga LIKE @liga';
            request.input('liga', sql.NVarChar(200), `%${liga}%`);
        }
        if (time) {
            query += ' AND (time_casa LIKE @time OR time_fora LIKE @time)';
            request.input('time', sql.NVarChar(100), `%${time}%`);
        }

        query += ' ORDER BY data_partida DESC';

        const result = await request.query(query);

        res.json({
            success: true,
            count: result.recordset.length,
            data: result.recordset
        });

    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro ao buscar histórico', error: error.message });
    }
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
 * Retorna estado do banco
 */
router.get('/diagnostico', async (req, res) => {
    try {
        const pool = await getDbPool();

        const countEventos = await pool.query(`SELECT COUNT(*) AS total FROM bet365_eventos WHERE ativo = 1`);
        const countHistorico = await pool.query(`SELECT COUNT(*) AS total FROM bet365_historico_partidas`);
        const countHistorico24h = await pool.query(`SELECT COUNT(*) AS total FROM bet365_historico_partidas WHERE data_partida >= DATEADD(HOUR, -24, GETDATE())`);
        const ultimosEventos = await pool.query(`
            SELECT TOP 10 id, time_casa, time_fora, league_name, gol_casa, gol_fora, status
            FROM bet365_eventos
            ORDER BY data_atualizacao DESC
        `);
        const ultimosHistorico = await pool.query(`
            SELECT TOP 20
                liga, time_casa, time_fora, gol_casa, gol_fora, resultado,
                data_partida,
                ISNULL(resultado_estimado, 0) AS resultado_estimado
            FROM bet365_historico_partidas
            ORDER BY data_partida DESC
        `);
        const historicoPorLiga = await pool.query(`
            SELECT liga, COUNT(*) AS total,
                   MAX(data_partida) AS ultima_partida
            FROM bet365_historico_partidas
            GROUP BY liga
            ORDER BY total DESC
        `);

        res.json({
            success: true,
            data: {
                eventosAtivos: countEventos.recordset[0]?.total || 0,
                historicoPartidas: countHistorico.recordset[0]?.total || 0,
                historicoPartidas24h: countHistorico24h.recordset[0]?.total || 0,
                amostraEventos: ultimosEventos.recordset,
                ultimosHistorico: ultimosHistorico.recordset,
                historicoPorLiga: historicoPorLiga.recordset
            }
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/bet365/ultimos-resultados
 * Retorna os últimos N resultados coletados (lista simples)
 */
router.get('/ultimos-resultados', async (req, res) => {
    try {
        const n = Math.min(parseInt(req.query.n) || 30, 100);
        const pool = await getDbPool();
        await garantirSchema(pool);
        const result = await pool.request()
            .input('n', sql.Int, n)
            .query(`
                SELECT TOP (@n)
                    liga, time_casa, time_fora,
                    gol_casa, gol_fora, resultado,
                    data_partida,
                    ISNULL(resultado_estimado, 0) AS resultado_estimado
                FROM bet365_historico_partidas
                WHERE resultado_estimado = 0
                ORDER BY data_partida DESC
            `);
        res.json({ success: true, total: result.recordset.length, data: result.recordset });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/bet365/historico-tabela
 * Retorna partidas históricas para tabela estilo Caramelo
 */
router.get('/historico-tabela', async (req, res) => {
    try {
        const { liga, horas = 24 } = req.query;
        const horasNum = Math.min(Math.max(parseInt(horas) || 24, 1), 168);
        const pool = await getDbPool();

        const request = pool.request();
        request.input('horas', sql.Int, horasNum);

        await garantirSchema(pool);

        let query = `
            SELECT
                id, evento_id, liga, time_casa, time_fora,
                gol_casa, gol_fora, resultado,
                odd_casa, odd_empate, odd_fora,
                data_partida,
                ISNULL(resultado_estimado, 0) AS resultado_estimado
            FROM bet365_historico_partidas
            WHERE data_partida >= DATEADD(HOUR, -@horas, GETDATE())
        `;

        if (liga && liga !== 'all') {
            query += ' AND liga LIKE @liga';
            request.input('liga', sql.NVarChar(200), `%${liga}%`);
        }

        query += ' ORDER BY data_partida ASC';

        const result = await request.query(query);

        const ligasResult = await pool.request()
            .input('horas2', sql.Int, horasNum)
            .query(`
                SELECT DISTINCT liga, COUNT(*) AS total
                FROM bet365_historico_partidas
                WHERE liga IS NOT NULL AND liga <> ''
                  AND data_partida >= DATEADD(HOUR, -@horas2, GETDATE())
                GROUP BY liga
                ORDER BY total DESC
            `);

        res.json({
            success: true,
            total: result.recordset.length,
            horas: horasNum,
            ligas: ligasResult.recordset,
            partidas: result.recordset
        });

    } catch (error) {
        console.error('❌ ERRO API bet365/historico-tabela:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/bet365/sugestoes
 * Análise estatística por liga baseada no histórico
 */
router.get('/sugestoes', async (req, res) => {
    try {
        // n = quantidade de jogos recentes para calcular a taxa principal do ranking
        const nParam = Math.min(100, Math.max(3, parseInt(req.query.n) || 10));
        const pool = await getDbPool();

        await garantirSchema(pool);

        const ligasResult = await pool.query(`
            SELECT liga, COUNT(*) AS total
            FROM bet365_historico_partidas
            WHERE liga IS NOT NULL AND liga <> ''
              AND ISNULL(resultado_estimado, 0) = 0
            GROUP BY liga
            HAVING COUNT(*) >= 5
            ORDER BY total DESC
        `);

        const FILTROS = [
            { id: 'over0.5',   label: 'Over 0.5',     check: j => (j.gol_casa + j.gol_fora) >= 1 },
            { id: 'over1.5',   label: 'Over 1.5',     check: j => (j.gol_casa + j.gol_fora) >= 2 },
            { id: 'over2.5',   label: 'Over 2.5',     check: j => (j.gol_casa + j.gol_fora) >= 3 },
            { id: 'over3.5',   label: 'Over 3.5',     check: j => (j.gol_casa + j.gol_fora) >= 4 },
            { id: 'under1.5',  label: 'Under 1.5',    check: j => (j.gol_casa + j.gol_fora) <= 1 },
            { id: 'under2.5',  label: 'Under 2.5',    check: j => (j.gol_casa + j.gol_fora) <= 2 },
            { id: 'ambas',     label: 'Ambas Marcam', check: j => j.gol_casa > 0 && j.gol_fora > 0 },
            { id: 'ft_casa',   label: 'Casa Vence',   check: j => j.resultado === 'CASA' },
            { id: 'ft_empate', label: 'Empate',       check: j => j.resultado === 'EMPATE' },
            { id: 'ft_fora',   label: 'Fora Vence',   check: j => j.resultado === 'FORA' },
            { id: 'btts_o25',  label: 'BTTS + O2.5',  check: j => j.gol_casa > 0 && j.gol_fora > 0 && (j.gol_casa + j.gol_fora) >= 3 },
        ];

        const resultado = [];

        for (const l of ligasResult.recordset) {
            const pResult = await pool.request()
                .input('liga', sql.NVarChar(200), l.liga)
                .query(`
                    SELECT TOP 100
                        gol_casa, gol_fora, resultado,
                        odd_casa, odd_empate, odd_fora, data_partida
                    FROM bet365_historico_partidas
                    WHERE liga = @liga
                      AND ISNULL(resultado_estimado, 0) = 0
                    ORDER BY data_partida DESC
                `);

            const partidas = pResult.recordset.map(p => ({
                gol_casa:   p.gol_casa  || 0,
                gol_fora:   p.gol_fora  || 0,
                resultado:  p.resultado || '',
                odd_casa:   parseFloat(p.odd_casa)   || 0,
                odd_empate: parseFloat(p.odd_empate) || 0,
                odd_fora:   parseFloat(p.odd_fora)   || 0,
            }));

            if (partidas.length < 5) continue;

            const filtroStats = FILTROS.map(f => {
                const n   = partidas.length;
                const nN  = Math.min(nParam, n);
                const n5  = Math.min(5,  n);
                const n10 = Math.min(10, n);
                const n20 = Math.min(20, n);

                const hGeral = partidas.filter(f.check).length;
                const hN     = partidas.slice(0, nN).filter(f.check).length;
                const h5     = partidas.slice(0, n5).filter(f.check).length;
                const h10    = partidas.slice(0, n10).filter(f.check).length;
                const h20    = partidas.slice(0, n20).filter(f.check).length;

                const txGeral = +(hGeral / n    * 100).toFixed(1);
                const txN     = +(hN    / nN   * 100).toFixed(1);
                const tx5     = +(h5    / n5   * 100).toFixed(1);
                const tx10    = +(h10   / n10  * 100).toFixed(1);
                const tx20    = +(h20   / n20  * 100).toFixed(1);

                let streak = 0;
                const streakTipo = f.check(partidas[0]) ? 'verde' : 'vermelho';
                for (let i = 0; i < Math.min(30, n); i++) {
                    if (f.check(partidas[i]) === (streakTipo === 'verde')) streak++;
                    else break;
                }

                const diff = txN - txGeral;
                const tendencia = diff > 8 ? 'subindo' : diff < -8 ? 'caindo' : 'estavel';
                const confianca = (txN >= 65 && nN >= 10) ? 'alta'
                                : (txN >= 55 && nN >=  5) ? 'media' : 'baixa';

                return {
                    id: f.id, label: f.label,
                    tx_geral: txGeral, tx_ultn: txN, tx_ult5: tx5, tx_ult10: tx10, tx_ult20: tx20,
                    n_custom: nN,
                    streak, streak_tipo: streakTipo, tendencia, confianca,
                    amostras: n
                };
            });

            filtroStats.sort((a, b) => b.tx_ultn - a.tx_ultn);

            const totalGols = partidas.reduce((s, p) => s + p.gol_casa + p.gol_fora, 0);
            const mediaGols = +(totalGols / partidas.length).toFixed(2);
            const pctCasa   = +(partidas.filter(p => p.resultado === 'CASA').length   / partidas.length * 100).toFixed(1);
            const pctEmpate = +(partidas.filter(p => p.resultado === 'EMPATE').length / partidas.length * 100).toFixed(1);
            const pctFora   = +(partidas.filter(p => p.resultado === 'FORA').length   / partidas.length * 100).toFixed(1);
            const pctAmbas  = +(partidas.filter(p => p.gol_casa > 0 && p.gol_fora > 0).length / partidas.length * 100).toFixed(1);
            const pctO15    = +(partidas.filter(p => (p.gol_casa + p.gol_fora) >= 2).length / partidas.length * 100).toFixed(1);
            const pctO25    = +(partidas.filter(p => (p.gol_casa + p.gol_fora) >= 3).length / partidas.length * 100).toFixed(1);

            resultado.push({
                liga: l.liga,
                total: l.total,
                amostras: partidas.length,
                stats: { mediaGols, pctCasa, pctEmpate, pctFora, pctAmbas, pctO15, pctO25 },
                filtros: filtroStats,
                melhor: filtroStats[0] || null,
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
 * Salva resultados de eventos que já deveriam ter terminado e não foram salvos pelo coletor
 */
router.post('/buscar-resultados', async (req, res) => {
    try {
        const pool = await getDbPool();
        await garantirSchema(pool);

        const candidatos = await pool.query(`
            SELECT TOP 30
                e.id, e.time_casa, e.time_fora, e.league_name,
                e.start_time_datetime,
                e.odd_casa, e.odd_empate, e.odd_fora,
                DATEDIFF(MINUTE, e.start_time_datetime, GETDATE()) AS minutos_atras
            FROM bet365_eventos e
            WHERE e.start_time_datetime < DATEADD(MINUTE, -5, GETDATE())
              AND e.time_casa <> '' AND e.time_fora <> ''
              AND NOT EXISTS (
                  SELECT 1 FROM bet365_historico_partidas h
                  WHERE h.evento_id = e.id
              )
            ORDER BY e.start_time_datetime ASC
        `);

        if (candidatos.recordset.length === 0) {
            return res.json({ success: true, encontrados: 0, salvos: 0, msg: 'Nenhum evento pendente' });
        }

        let salvos = 0;
        const resultados = [];

        for (const ev of candidatos.recordset) {
            const minutosAtras = ev.minutos_atras || 0;
            if (minutosAtras < 10) {
                resultados.push({ id: ev.id, status: 'aguardando', minutos_atras: minutosAtras });
                continue;
            }

            // Sem placar disponível na tabela de eventos (bet365 não trackeia ao vivo)
            // Registra como 0-0 EMPATE após 10 min — será corrigido pelo próximo ciclo do coletor
            const golCasa = 0, golFora = 0;
            const resultado = 'EMPATE';

            try {
                await pool.request()
                    .input('eventoId',   sql.BigInt,       ev.id)
                    .input('liga',       sql.NVarChar(200), ev.league_name)
                    .input('timeCasa',   sql.NVarChar(100), ev.time_casa)
                    .input('timeFora',   sql.NVarChar(100), ev.time_fora)
                    .input('golCasa',    sql.Int,           golCasa)
                    .input('golFora',    sql.Int,           golFora)
                    .input('resultado',  sql.NVarChar(10),  resultado)
                    .input('oddCasa',    sql.Decimal(10,2), ev.odd_casa    || 0)
                    .input('oddEmpate',  sql.Decimal(10,2), ev.odd_empate  || 0)
                    .input('oddFora',    sql.Decimal(10,2), ev.odd_fora    || 0)
                    .input('dataPartida',sql.DateTime2,     ev.start_time_datetime)
                    .query(`
                        IF NOT EXISTS (SELECT 1 FROM bet365_historico_partidas WHERE evento_id = @eventoId)
                        INSERT INTO bet365_historico_partidas
                            (evento_id, liga, time_casa, time_fora, gol_casa, gol_fora,
                             resultado, odd_casa, odd_empate, odd_fora, data_partida, resultado_estimado)
                        VALUES
                            (@eventoId, @liga, @timeCasa, @timeFora, @golCasa, @golFora,
                             @resultado, @oddCasa, @oddEmpate, @oddFora, @dataPartida, 1)
                    `);
                salvos++;
                resultados.push({ id: ev.id, time_casa: ev.time_casa, time_fora: ev.time_fora, status: 'salvo' });
            } catch (err) {
                resultados.push({ id: ev.id, erro: err.message });
            }
        }

        // Notifica clientes WebSocket se novos resultados foram salvos
        if (salvos > 0 && typeof global.wsBroadcast === 'function') {
            global.wsBroadcast({ tipo: 'coleta', fonte: 'bet365', novos: 0, resultadosSalvos: salvos });
        }

        res.json({ success: true, candidatos: candidatos.recordset.length, salvos, resultados });

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

        const statsGerais = await pool.query(`
            SELECT
                COUNT(*) AS total_eventos,
                SUM(CASE WHEN status = 'EM_ANDAMENTO' THEN 1 ELSE 0 END) AS ao_vivo,
                SUM(CASE WHEN status = 'AGENDADO' THEN 1 ELSE 0 END) AS agendados,
                AVG(CAST(odd_casa AS FLOAT))   AS media_odd_casa,
                AVG(CAST(odd_empate AS FLOAT)) AS media_odd_empate,
                AVG(CAST(odd_fora AS FLOAT))   AS media_odd_fora
            FROM bet365_eventos
            WHERE ativo = 1
        `);

        const distribuicaoGols = await pool.query(`
            SELECT
                (gol_casa + gol_fora) AS total_gols,
                COUNT(*) AS quantidade
            FROM bet365_historico_partidas
            WHERE data_partida >= DATEADD(HOUR, -24, GETDATE())
            GROUP BY (gol_casa + gol_fora)
            ORDER BY total_gols
        `);

        const performanceLiga = await pool.query(`
            SELECT TOP 20
                liga,
                COUNT(*) AS total_jogos,
                AVG(CAST(gol_casa + gol_fora AS FLOAT)) AS media_gols,
                SUM(CASE WHEN resultado = 'CASA'   THEN 1 ELSE 0 END) AS vitorias_casa,
                SUM(CASE WHEN resultado = 'EMPATE' THEN 1 ELSE 0 END) AS empates,
                SUM(CASE WHEN resultado = 'FORA'   THEN 1 ELSE 0 END) AS vitorias_fora
            FROM bet365_historico_partidas
            WHERE liga IS NOT NULL AND liga <> ''
            GROUP BY liga
            ORDER BY total_jogos DESC
        `);

        const heatmapResultados = await pool.query(`
            SELECT gol_casa, gol_fora, COUNT(*) AS frequencia
            FROM bet365_historico_partidas
            WHERE data_partida >= DATEADD(HOUR, -24, GETDATE())
            GROUP BY gol_casa, gol_fora
            ORDER BY frequencia DESC
        `);

        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            data: {
                gerais: statsGerais.recordset[0],
                distribuicaoGols: distribuicaoGols.recordset,
                performanceLiga: performanceLiga.recordset,
                heatmapResultados: heatmapResultados.recordset.slice(0, 20)
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
 * Remove registros de ligas descartadas: 'Super League' e 'South American Super League'
 */
router.post('/limpar-ligas-descartadas', async (req, res) => {
    try {
        const pool = await getDbPool();

        // bet365_historico_partidas usa coluna "liga"
        const resultHist = await pool.request().query(`
            DELETE FROM bet365_historico_partidas
            WHERE liga IN ('Super League', 'South American Super League')
        `);
        const removidos = resultHist.rowsAffected?.[0] ?? 0;

        // bet365_eventos usa coluna "league_name"
        const resultEvt = await pool.request().query(`
            DELETE FROM bet365_eventos
            WHERE league_name IN ('Super League', 'South American Super League')
        `);
        const removidosEvt = resultEvt.rowsAffected?.[0] ?? 0;

        if (removidos === 0 && removidosEvt === 0) {
            return res.json({ success: true, partidas_removidas: 0, eventos_removidos: 0,
                message: 'Nenhum registro encontrado para essas ligas. Banco já está limpo.' });
        }

        res.json({ success: true, partidas_removidas: removidos, eventos_removidos: removidosEvt });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/bet365/reparar-datas
 * Corrige registros históricos com data_partida errada (minuto 00:xx UTC)
 * cruzando com start_time_datetime de bet365_eventos pelo nome dos times.
 */
router.post('/reparar-datas', async (req, res) => {
    try {
        const pool = await getDbPool();

        // Busca registros históricos cujo minuto UTC não bate com os slots canônicos
        // da liga — ou cujo MINUTE(data_partida) = 55,52,48... (odds capturadas erroneamente)
        // Estratégia: cruza historico × eventos pelo nome dos times dentro de janela de 4h
        const corrigidos = [];
        const erros = [];

        const candidatos = await pool.query(`
            SELECT h.id, h.evento_id, h.liga, h.time_casa, h.time_fora, h.data_partida
            FROM bet365_historico_partidas h
            WHERE h.resultado_estimado = 0
              AND h.data_partida >= DATEADD(DAY, -3, GETUTCDATE())
        `);

        for (const h of candidatos.recordset) {
            try {
                const ev = await pool.request()
                    .input('liga',     sql.NVarChar(200), h.liga)
                    .input('timeCasa', sql.NVarChar(100), h.time_casa)
                    .input('timeFora', sql.NVarChar(100), h.time_fora)
                    .input('dataRef',  sql.DateTime2,     h.data_partida)
                    .query(`
                        SELECT TOP 1 start_time_datetime
                        FROM bet365_eventos
                        WHERE league_name = @liga
                          AND time_casa   = @timeCasa
                          AND time_fora   = @timeFora
                          AND ABS(DATEDIFF(HOUR, start_time_datetime, @dataRef)) <= 6
                        ORDER BY ABS(DATEDIFF(MINUTE, start_time_datetime, @dataRef))
                    `);

                if (ev.recordset.length > 0) {
                    const novaData = ev.recordset[0].start_time_datetime;
                    const diffMin  = Math.abs(
                        (new Date(novaData) - new Date(h.data_partida)) / 60000
                    );
                    // Só atualiza se a diferença for significativa (> 5 min)
                    if (diffMin > 5) {
                        await pool.request()
                            .input('id',       sql.Int,       h.id)
                            .input('novaData', sql.DateTime2, novaData)
                            .query(`UPDATE bet365_historico_partidas SET data_partida=@novaData WHERE id=@id`);
                        corrigidos.push({
                            id: h.id,
                            time_casa: h.time_casa,
                            time_fora: h.time_fora,
                            data_antiga: h.data_partida,
                            data_nova: novaData,
                            diff_min: Math.round(diffMin)
                        });
                    }
                }
            } catch (e) {
                erros.push({ id: h.id, erro: e.message });
            }
        }

        res.json({
            success: true,
            candidatos: candidatos.recordset.length,
            corrigidos: corrigidos.length,
            erros: erros.length,
            detalhes: corrigidos
        });

    } catch (err) {
        console.error('❌ ERRO API bet365/reparar-datas:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/bet365/limpar-ligas-erradas
 * Remove registros históricos onde o time pertence a uma liga diferente da registrada.
 * Times de clube (Chelsea, Leeds, etc.) não devem estar na World Cup.
 * Times nacionais (Brasil, França, etc.) não devem estar no Premier League.
 */
router.post('/limpar-ligas-erradas', async (req, res) => {
    try {
        const pool = await getDbPool();

        // Times exclusivos do Premier League (clubes ingleses)
        const timesPremier = [
            'Arsenal','Aston Villa','Bournemouth','Brentford','Brighton','Burnley',
            'Chelsea','Crystal Palace','Everton','Fulham','Leeds','Leicester',
            'Liverpool','Luton','Manchester City','Manchester United','Newcastle',
            'Nottingham Forest','Sheffield United','Tottenham','West Ham','Wolves',
            'Wolverhampton'
        ];

        // Times exclusivos do Super League (clubes europeus)
        const timesSuper = [
            'Ajax','Atletico Madrid','Barcelona','Benfica','Celtic','Dortmund',
            'Inter Milan','Juventus','Lyon','Marseille','Milan','Monaco','Napoli',
            'Paris','Porto','Real Madrid','Roma','Schalke','Valencia','Villarreal',
            'Galatasaray','Fenerbahce','Anderlecht','Salzburg','Bruges'
        ];

        // Deleta registros Premier League em liga errada
        const delPremierErrado = await pool.request()
            .input('times', sql.NVarChar(sql.MAX), timesPremier.join(','))
            .query(`
                DELETE FROM bet365_historico_partidas
                WHERE liga NOT IN ('Premiership','Premier League')
                  AND (
                    time_casa IN (${timesPremier.map(t => `'${t}'`).join(',')})
                    OR time_fora IN (${timesPremier.map(t => `'${t}'`).join(',')})
                  )
            `);

        // Deleta registros Super League em liga errada
        const delSuperErrado = await pool.request()
            .query(`
                DELETE FROM bet365_historico_partidas
                WHERE liga NOT IN ('Super League')
                  AND (
                    time_casa IN (${timesSuper.map(t => `'${t}'`).join(',')})
                    OR time_fora IN (${timesSuper.map(t => `'${t}'`).join(',')})
                  )
            `);

        res.json({
            success: true,
            removidos_premier_errado: delPremierErrado.rowsAffected[0],
            removidos_super_errado:   delSuperErrado.rowsAffected[0],
            total_removidos: delPremierErrado.rowsAffected[0] + delSuperErrado.rowsAffected[0]
        });

    } catch (err) {
        console.error('❌ ERRO API bet365/limpar-ligas-erradas:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
