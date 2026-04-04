/**
 * ============================================
 * API REST - BETANO DADOS EM TEMPO REAL (COMPLETO)
 * ============================================
 * Endpoints para o dashboard HTML consultar
 * os dados coletados nas tabelas betano_*
 * ============================================
 */

const express = require('express');
const sql = require('mssql');
const router = express.Router();
const { betanoCache } = require('../utils/cache');
const {
    formatarNumero,
    formatarPorcentagem,
    oddParaProbabilidade,
    calcularMargem,
    detectarTendenciaOdd,
    calcularValorEsperado
} = require('../utils/betano-utils');

// Pool de conexão global
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
            trustServerCertificate: process.env.DB_TRUST_CERT === 'true'
        },
        pool: {
            max: 10,
            min: 0,
            idleTimeoutMillis: 30000
        }
    };

    sqlPool = await sql.connect(config);
    console.log('✅ Pool SQL betano criado');
    return sqlPool;
}

/**
 * GET /api/betano/eventos
 * Retorna todos os eventos ativos COM ESTATÍSTICAS
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
                e.posse_bola_casa,
                e.posse_bola_fora,
                e.chutes_casa,
                e.chutes_fora,
                e.chutes_gol_casa,
                e.chutes_gol_fora,
                e.escanteios_casa,
                e.escanteios_fora,
                e.cartoes_amarelos_casa,
                e.cartoes_amarelos_fora,
                e.cartoes_vermelhos_casa,
                e.cartoes_vermelhos_fora,
                e.estatisticas_json,
                COUNT(DISTINCT m.id) AS total_mercados,
                COUNT(DISTINCT o.id) AS total_odds
            FROM betano_eventos e
            LEFT JOIN betano_mercados m ON m.evento_id = e.id AND m.ativo = 1
            LEFT JOIN betano_odds o ON o.mercado_id = m.id AND o.ativo = 1
            WHERE e.ativo = 1
        `;

        if (liga) {
            query += ' AND e.league_name LIKE @liga';
        }

        if (status) {
            query += ' AND e.status = @status';
        }

        query += ' GROUP BY e.id, e.time_casa, e.time_fora, e.league_name, e.start_time_datetime, e.seconds_to_start, e.status, e.gol_casa, e.gol_fora, e.minuto_jogo, e.odd_casa, e.odd_empate, e.odd_fora, e.posse_bola_casa, e.posse_bola_fora, e.chutes_casa, e.chutes_fora, e.chutes_gol_casa, e.chutes_gol_fora, e.escanteios_casa, e.escanteios_fora, e.cartoes_amarelos_casa, e.cartoes_amarelos_fora, e.cartoes_vermelhos_casa, e.cartoes_vermelhos_fora, e.estatisticas_json ORDER BY e.start_time_datetime ASC';

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
        console.error('❌ ERRO API betano/eventos:', error.message);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar eventos',
            error: error.message
        });
    }
});

/**
 * GET /api/betano/evento/:id
 * Retorna detalhes completos de um evento COM ESTATÍSTICAS
 */
router.get('/evento/:id', async (req, res) => {
    try {
        const pool = await getDbPool();

        const result = await pool.request()
            .input('eventoId', sql.BigInt, BigInt(req.params.id))
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
                    e.odd_fora,
                    e.posse_bola_casa,
                    e.posse_bola_fora,
                    e.chutes_casa,
                    e.chutes_fora,
                    e.chutes_gol_casa,
                    e.chutes_gol_fora,
                    e.escanteios_casa,
                    e.escanteios_fora,
                    e.cartoes_amarelos_casa,
                    e.cartoes_amarelos_fora,
                    e.cartoes_vermelhos_casa,
                    e.cartoes_vermelhos_fora,
                    e.estatisticas_json,
                    m.id AS mercado_id,
                    m.nome AS mercado_nome,
                    m.tipo AS mercado_tipo,
                    o.id AS odd_id,
                    o.nome AS odd_nome,
                    o.full_name AS odd_full_name,
                    o.valor AS odd_valor,
                    o.handicap AS odd_handicap
                FROM betano_eventos e
                INNER JOIN betano_mercados m ON m.evento_id = e.id
                INNER JOIN betano_odds o ON o.mercado_id = m.id
                WHERE e.id = @eventoId AND e.ativo = 1 AND m.ativo = 1 AND o.ativo = 1
                ORDER BY m.nome, o.column_index
            `);

        // Agrupar dados
        const evento = {
            evento_id: result.recordset[0]?.evento_id,
            time_casa: result.recordset[0]?.time_casa,
            time_fora: result.recordset[0]?.time_fora,
            liga: result.recordset[0]?.liga,
            horario: result.recordset[0]?.horario,
            segundos_inicio: result.recordset[0]?.seconds_to_start,
            status: result.recordset[0]?.status,
            gol_casa: result.recordset[0]?.gol_casa || 0,
            gol_fora: result.recordset[0]?.gol_fora || 0,
            minuto_jogo: result.recordset[0]?.minuto_jogo || '',
            odd_casa: result.recordset[0]?.odd_casa || 0,
            odd_empate: result.recordset[0]?.odd_empate || 0,
            odd_fora: result.recordset[0]?.odd_fora || 0,
            estatisticas: JSON.parse(result.recordset[0]?.estatisticas_json || '{}'),
            mercados: []
        };

        let mercadoAtual = null;
        result.recordset.forEach(row => {
            if (!mercadoAtual || mercadoAtual.mercado_id !== row.mercado_id) {
                mercadoAtual = {
                    mercado_id: row.mercado_id,
                    nome: row.mercado_nome,
                    tipo: row.mercado_tipo,
                    odds: []
                };
                evento.mercados.push(mercadoAtual);
            }

            mercadoAtual.odds.push({
                odd_id: row.odd_id,
                nome: row.odd_nome,
                full_name: row.odd_full_name,
                valor: parseFloat(row.odd_valor),
                handicap: parseFloat(row.odd_handicap)
            });
        });

        res.json({
            success: true,
            data: evento
        });

    } catch (error) {
        console.error('❌ ERRO API betano/evento:', error.message);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar evento',
            error: error.message
        });
    }
});

/**
 * GET /api/betano/estatisticas/:id
 * Retorna estatísticas em tempo real de um evento
 */
router.get('/estatisticas/:id', async (req, res) => {
    try {
        const pool = await getDbPool();

        const result = await pool.request()
            .input('eventoId', sql.BigInt, BigInt(req.params.id))
            .query(`
                SELECT
                    evento_id,
                    minuto,
                    gol_casa,
                    gol_fora,
                    posse_bola_casa,
                    posse_bola_fora,
                    chutes_casa,
                    chutes_fora,
                    chutes_gol_casa,
                    chutes_gol_fora,
                    escanteios_casa,
                    escanteios_fora,
                    cartoes_amarelos_casa,
                    cartoes_amarelos_fora,
                    cartoes_vermelhos_casa,
                    cartoes_vermelhos_fora,
                    ataques_casa,
                    ataques_fora,
                    ataques_perigo_casa,
                    ataques_perigo_fora,
                    data_coleta
                FROM betano_estatisticas_tempo_real
                WHERE evento_id = @eventoId
                ORDER BY data_coleta DESC
            `);

        res.json({
            success: true,
            count: result.recordset.length,
            data: result.recordset
        });

    } catch (error) {
        console.error('❌ ERRO API betano/estatisticas:', error.message);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar estatísticas',
            error: error.message
        });
    }
});

/**
 * GET /api/betano/historico-odds/:id
 * Retorna histórico de odds de um evento específico
 */
router.get('/historico-odds/:id', async (req, res) => {
    try {
        const { limite = 100 } = req.query;
        const pool = await getDbPool();

        const result = await pool.request()
            .input('eventoId', sql.BigInt, BigInt(req.params.id))
            .query(`
                SELECT
                    h.id,
                    h.evento_id,
                    h.mercado_id,
                    h.odd_id,
                    h.nome_selecao,
                    h.valor_odd,
                    h.valor_anterior,
                    h.variacao_percentual,
                    h.data_coleta,
                    m.nome AS mercado_nome,
                    e.time_casa,
                    e.time_fora
                FROM betano_historico_odds h
                INNER JOIN betano_eventos e ON e.id = h.evento_id
                INNER JOIN betano_mercados m ON m.id = h.mercado_id
                WHERE h.evento_id = @eventoId
                ORDER BY h.data_coleta DESC
            `);

        res.json({
            success: true,
            count: result.recordset.length,
            data: result.recordset
        });

    } catch (error) {
        console.error('❌ ERRO API betano/historico-odds:', error.message);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar histórico de odds',
            error: error.message
        });
    }
});

/**
 * GET /api/betano/ligas
 * Retorna lista de ligas disponíveis
 */
router.get('/ligas', async (req, res) => {
    try {
        const pool = await getDbPool();

        const result = await pool.query(`
            SELECT DISTINCT
                league_name AS liga,
                COUNT(*) AS quantidade
            FROM betano_eventos
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
        console.error('❌ ERRO API betano/ligas:', error.message);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar ligas',
            error: error.message
        });
    }
});

/**
 * GET /api/betano/stats
 * Retorna estatísticas gerais COMPLETAS
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
            FROM betano_eventos WHERE ativo = 1
        `);

        const mercadosResult = await pool.query(`
            SELECT COUNT(*) AS total FROM betano_mercados WHERE ativo = 1
        `);

        const oddsResult = await pool.query(`
            SELECT COUNT(*) AS total FROM betano_odds WHERE ativo = 1
        `);

        const estatisticasResult = await pool.query(`
            SELECT COUNT(*) AS total FROM betano_estatisticas_tempo_real
        `);

        const historicoOddsResult = await pool.query(`
            SELECT COUNT(*) AS total FROM betano_historico_odds
        `);

        const logResult = await pool.query(`
            SELECT TOP 1
                data_inicio,
                data_fim,
                status,
                eventos_coletados,
                mercados_coletados,
                odds_coletadas,
                estatisticas_coletadas,
                historico_odds_salvas
            FROM betano_log_coleta
            ORDER BY data_inicio DESC
        `);

        res.json({
            success: true,
            data: {
                eventos: eventosResult.recordset[0],
                mercados: mercadosResult.recordset[0]?.total || 0,
                odds: oddsResult.recordset[0]?.total || 0,
                estatisticas: estatisticasResult.recordset[0]?.total || 0,
                historicoOdds: historicoOddsResult.recordset[0]?.total || 0,
                ultima_coleta: logResult.recordset[0] || null
            }
        });

    } catch (error) {
        console.error('❌ ERRO API betano/stats:', error.message);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar estatísticas',
            error: error.message
        });
    }
});

/**
 * GET /api/betano/ao-vivo
 * Retorna apenas eventos ao vivo COM ESTATÍSTICAS
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
                e.posse_bola_casa,
                e.posse_bola_fora,
                e.chutes_casa,
                e.chutes_fora,
                e.chutes_gol_casa,
                e.chutes_gol_fora,
                e.escanteios_casa,
                e.escanteios_fora,
                e.cartoes_amarelos_casa,
                e.cartoes_amarelos_fora,
                e.cartoes_vermelhos_casa,
                e.cartoes_vermelhos_fora,
                e.odd_casa,
                e.odd_empate,
                e.odd_fora
            FROM betano_eventos e
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
        console.error('❌ ERRO API betano/ao-vivo:', error.message);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar eventos ao vivo',
            error: error.message
        });
    }
});

/**
 * GET /api/betano/eventos-completos
 * Retorna eventos COM mercados e odds detalhados
 */
router.get('/eventos-completos', async (req, res) => {
    try {
        const pool = await getDbPool();

        // Sem limite artificial — retorna todos os eventos ativos
        // Ordena: ao vivo primeiro, depois por horário (NULLs por último)
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
                    e.odd_fora,
                    e.posse_bola_casa,
                    e.posse_bola_fora,
                    e.chutes_casa,
                    e.chutes_fora,
                    e.chutes_gol_casa,
                    e.chutes_gol_fora,
                    e.escanteios_casa,
                    e.escanteios_fora,
                    e.cartoes_amarelos_casa,
                    e.cartoes_amarelos_fora,
                    e.cartoes_vermelhos_casa,
                    e.cartoes_vermelhos_fora,
                    e.estatisticas_json
                FROM betano_eventos e
                WHERE e.ativo = 1
                ORDER BY
                    CASE WHEN e.status = 'EM_ANDAMENTO' THEN 0 ELSE 1 END ASC,
                    ISNULL(e.start_time_datetime, '9999-12-31') ASC
            `);

        // Para cada evento, buscar mercados e odds
        const eventosCompletos = await Promise.all(eventosResult.recordset.map(async (evento) => {
            const mercadosResult = await pool.request()
                .input('eventoId', sql.BigInt, BigInt(evento.evento_id))
                .query(`
                    SELECT
                        m.id AS mercado_id,
                        m.nome AS mercado_nome,
                        m.tipo AS mercado_tipo,
                        o.id AS odd_id,
                        o.nome AS odd_nome,
                        o.full_name AS odd_full_name,
                        o.valor AS odd_valor,
                        o.handicap AS odd_handicap
                    FROM betano_mercados m
                    INNER JOIN betano_odds o ON o.mercado_id = m.id
                    WHERE m.evento_id = @eventoId AND m.ativo = 1 AND o.ativo = 1
                    ORDER BY m.nome, o.column_index
                `);

            // Agrupar odds por mercado
            const mercadosMap = new Map();
            mercadosResult.recordset.forEach(row => {
                if (!mercadosMap.has(row.mercado_id)) {
                    mercadosMap.set(row.mercado_id, {
                        id: row.mercado_id,
                        nome: row.mercado_nome,
                        tipo: row.mercado_tipo,
                        odds: []
                    });
                }
                mercadosMap.get(row.mercado_id).odds.push({
                    id: row.odd_id,
                    nome: row.odd_nome,
                    full_name: row.odd_full_name,
                    valor: parseFloat(row.odd_valor),
                    handicap: parseFloat(row.odd_handicap)
                });
            });

            return {
                ...evento,
                mercados: Array.from(mercadosMap.values())
            };
        }));

        res.json({
            success: true,
            count: eventosCompletos.length,
            timestamp: new Date().toISOString(),
            data: eventosCompletos
        });

    } catch (error) {
        console.error('❌ ERRO API betano/eventos-completos:', error.message);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar eventos completos',
            error: error.message
        });
    }
});

/**
 * GET /api/betano/probabilidades/:id
 * Retorna análise de probabilidade histórica vs odds atuais para um evento
 */
router.get('/probabilidades/:id', async (req, res) => {
    try {
        const pool = await getDbPool();
        const MIN_PARTIDAS = 5; // mínimo para mostrar dados confiáveis

        // Buscar o evento atual
        const evResult = await pool.request()
            .input('id', sql.BigInt, BigInt(req.params.id))
            .query(`
                SELECT id, time_casa, time_fora, league_name AS liga,
                       odd_casa, odd_empate, odd_fora, status,
                       gol_casa, gol_fora, minuto_jogo
                FROM betano_eventos
                WHERE id = @id
            `);

        if (!evResult.recordset.length) {
            return res.status(404).json({ success: false, message: 'Evento não encontrado' });
        }

        const ev = evResult.recordset[0];
        const timeCasa = ev.time_casa;
        const timeFora = ev.time_fora;
        const liga = ev.league_name || ev.liga || '';

        // -----------------------------------------------
        // STATS DO TIME DA CASA (jogando em casa)
        // -----------------------------------------------
        const statsCasaResult = await pool.request()
            .input('time', sql.NVarChar(100), timeCasa)
            .input('liga', sql.NVarChar(200), `%${liga}%`)
            .query(`
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN resultado = 'CASA' THEN 1 ELSE 0 END) AS vitorias,
                    SUM(CASE WHEN resultado = 'EMPATE' THEN 1 ELSE 0 END) AS empates,
                    SUM(CASE WHEN resultado = 'FORA' THEN 1 ELSE 0 END) AS derrotas,
                    AVG(CAST(gol_casa AS FLOAT)) AS media_gols_marcados,
                    AVG(CAST(gol_fora AS FLOAT)) AS media_gols_sofridos,
                    MAX(data_partida) AS ultima_partida
                FROM betano_historico_partidas
                WHERE time_casa = @time AND liga LIKE @liga
            `);

        // -----------------------------------------------
        // STATS DO TIME DE FORA (jogando fora)
        // -----------------------------------------------
        const statsForaResult = await pool.request()
            .input('time', sql.NVarChar(100), timeFora)
            .input('liga', sql.NVarChar(200), `%${liga}%`)
            .query(`
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN resultado = 'FORA' THEN 1 ELSE 0 END) AS vitorias,
                    SUM(CASE WHEN resultado = 'EMPATE' THEN 1 ELSE 0 END) AS empates,
                    SUM(CASE WHEN resultado = 'CASA' THEN 1 ELSE 0 END) AS derrotas,
                    AVG(CAST(gol_fora AS FLOAT)) AS media_gols_marcados,
                    AVG(CAST(gol_casa AS FLOAT)) AS media_gols_sofridos,
                    MAX(data_partida) AS ultima_partida
                FROM betano_historico_partidas
                WHERE time_fora = @time AND liga LIKE @liga
            `);

        // -----------------------------------------------
        // CONFRONTO DIRETO (head-to-head)
        // -----------------------------------------------
        const h2hResult = await pool.request()
            .input('casa', sql.NVarChar(100), timeCasa)
            .input('fora', sql.NVarChar(100), timeFora)
            .query(`
                SELECT TOP 20
                    gol_casa, gol_fora, resultado, data_partida,
                    odd_casa, odd_empate, odd_fora
                FROM betano_historico_partidas
                WHERE time_casa = @casa AND time_fora = @fora
                ORDER BY data_partida DESC
            `);

        // -----------------------------------------------
        // ÚLTIMOS 10 JOGOS DE CADA TIME (forma recente)
        // -----------------------------------------------
        const formaTimeCasaResult = await pool.request()
            .input('time', sql.NVarChar(100), timeCasa)
            .query(`
                SELECT TOP 10 resultado, gol_casa, gol_fora, time_fora, data_partida
                FROM betano_historico_partidas
                WHERE time_casa = @time
                ORDER BY data_partida DESC
            `);

        const formaTimeForaResult = await pool.request()
            .input('time', sql.NVarChar(100), timeFora)
            .query(`
                SELECT TOP 10 resultado, gol_casa, gol_fora, time_casa, data_partida
                FROM betano_historico_partidas
                WHERE time_fora = @time
                ORDER BY data_partida DESC
            `);

        // -----------------------------------------------
        // CALCULAR PROBABILIDADES
        // -----------------------------------------------
        const sc = statsCasaResult.recordset[0];
        const sf = statsForaResult.recordset[0];
        const h2h = h2hResult.recordset;

        // Probabilidade implícita pelas odds (remover margem da casa)
        const oddCasa = parseFloat(ev.odd_casa) || 0;
        const oddEmp = parseFloat(ev.odd_empate) || 0;
        const oddFora = parseFloat(ev.odd_fora) || 0;

        let implCasa = 0, implEmp = 0, implFora = 0;
        if (oddCasa > 0 && oddEmp > 0 && oddFora > 0) {
            const rawCasa = 1 / oddCasa;
            const rawEmp  = 1 / oddEmp;
            const rawFora = 1 / oddFora;
            const margem  = rawCasa + rawEmp + rawFora;
            implCasa = (rawCasa / margem) * 100;
            implEmp  = (rawEmp  / margem) * 100;
            implFora = (rawFora / margem) * 100;
        }

        // Probabilidade histórica combinada
        let histCasa = null, histEmp = null, histFora = null;
        let amostrasH2H = h2h.length;

        if (amostrasH2H >= MIN_PARTIDAS) {
            // Preferir confronto direto se tiver amostra suficiente
            const vCasa = h2h.filter(r => r.resultado === 'CASA').length;
            const vEmp  = h2h.filter(r => r.resultado === 'EMPATE').length;
            const vFora = h2h.filter(r => r.resultado === 'FORA').length;
            histCasa = (vCasa / amostrasH2H) * 100;
            histEmp  = (vEmp  / amostrasH2H) * 100;
            histFora = (vFora / amostrasH2H) * 100;
        } else if (sc.total >= MIN_PARTIDAS && sf.total >= MIN_PARTIDAS) {
            // Combinar stats individuais (média ponderada)
            const pctCasaVit  = (sc.vitorias  / sc.total) * 100;
            const pctCasaEmp  = (sc.empates   / sc.total) * 100;
            const pctCasaDer  = (sc.derrotas  / sc.total) * 100;
            const pctForaVit  = (sf.vitorias  / sf.total) * 100;
            const pctForaEmp  = (sf.empates   / sf.total) * 100;
            const pctForaDer  = (sf.derrotas  / sf.total) * 100;

            histCasa = (pctCasaVit + pctForaDer) / 2;
            histEmp  = (pctCasaEmp + pctForaEmp) / 2;
            histFora = (pctCasaDer + pctForaVit) / 2;

            // Normalizar para 100%
            const total = histCasa + histEmp + histFora;
            if (total > 0) {
                histCasa = (histCasa / total) * 100;
                histEmp  = (histEmp  / total) * 100;
                histFora = (histFora / total) * 100;
            }
        }

        // Indicador de valor (histórico - implícita)
        const valorCasa = histCasa !== null ? histCasa - implCasa : null;
        const valorEmp  = histEmp  !== null ? histEmp  - implEmp  : null;
        const valorFora = histFora !== null ? histFora - implFora : null;

        // Forma recente (string: V/E/D)
        const formaTimeCasa = formaTimeCasaResult.recordset.map(r => r.resultado === 'CASA' ? 'V' : r.resultado === 'EMPATE' ? 'E' : 'D');
        const formaTimeFora = formaTimeForaResult.recordset.map(r => r.resultado === 'FORA' ? 'V' : r.resultado === 'EMPATE' ? 'E' : 'D');

        res.json({
            success: true,
            data: {
                evento: {
                    id: ev.id,
                    time_casa: timeCasa,
                    time_fora: timeFora,
                    liga,
                    odd_casa: oddCasa,
                    odd_empate: oddEmp,
                    odd_fora: oddFora,
                    status: ev.status
                },
                probabilidades: {
                    implicita: {
                        casa: implCasa ? +implCasa.toFixed(1) : null,
                        empate: implEmp  ? +implEmp.toFixed(1)  : null,
                        fora: implFora  ? +implFora.toFixed(1)  : null
                    },
                    historica: {
                        casa:   histCasa !== null ? +histCasa.toFixed(1) : null,
                        empate: histEmp  !== null ? +histEmp.toFixed(1)  : null,
                        fora:   histFora !== null ? +histFora.toFixed(1) : null,
                        amostras: amostrasH2H >= MIN_PARTIDAS ? amostrasH2H : (sc.total + sf.total > 0 ? `${sc.total}/${sf.total}` : 0),
                        fonte: amostrasH2H >= MIN_PARTIDAS ? 'confronto_direto' : 'individual'
                    },
                    valor: {
                        casa:   valorCasa !== null ? +valorCasa.toFixed(1) : null,
                        empate: valorEmp  !== null ? +valorEmp.toFixed(1)  : null,
                        fora:   valorFora !== null ? +valorFora.toFixed(1) : null
                    }
                },
                stats_time_casa: {
                    nome: timeCasa,
                    total: sc.total,
                    vitorias: sc.vitorias,
                    empates: sc.empates,
                    derrotas: sc.derrotas,
                    media_gols_marcados: sc.media_gols_marcados ? +sc.media_gols_marcados.toFixed(2) : 0,
                    media_gols_sofridos: sc.media_gols_sofridos ? +sc.media_gols_sofridos.toFixed(2) : 0,
                    ultima_partida: sc.ultima_partida,
                    forma: formaTimeCasa
                },
                stats_time_fora: {
                    nome: timeFora,
                    total: sf.total,
                    vitorias: sf.vitorias,
                    empates: sf.empates,
                    derrotas: sf.derrotas,
                    media_gols_marcados: sf.media_gols_marcados ? +sf.media_gols_marcados.toFixed(2) : 0,
                    media_gols_sofridos: sf.media_gols_sofridos ? +sf.media_gols_sofridos.toFixed(2) : 0,
                    ultima_partida: sf.ultima_partida,
                    forma: formaTimeFora
                },
                confronto_direto: {
                    total: amostrasH2H,
                    historico: h2h.slice(0, 10).map(r => ({
                        placar: `${r.gol_casa}x${r.gol_fora}`,
                        resultado: r.resultado,
                        data: r.data_partida
                    }))
                }
            }
        });

    } catch (error) {
        console.error('❌ ERRO API probabilidades:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao calcular probabilidades', error: error.message });
    }
});

/**
 * GET /api/betano/historico-partidas
 * Retorna histórico geral de partidas salvas
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
            FROM betano_historico_partidas
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
 * GET /api/betano/sugestoes
 * Analisa betano_historico_partidas e retorna sugestões de aposta por liga
 * Taxa de acerto, streaks, tendência de cada filtro
 */
router.get('/sugestoes', async (req, res) => {
    try {
        const pool = await getDbPool();

        // Ligas com ao menos 10 partidas
        const ligasResult = await pool.query(`
            SELECT liga, COUNT(*) AS total
            FROM betano_historico_partidas
            WHERE liga IS NOT NULL AND liga <> ''
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
                    FROM betano_historico_partidas
                    WHERE liga = @liga
                    ORDER BY data_partida DESC, data_registro DESC
                `);

            const partidas = pResult.recordset.map(p => ({
                gol_casa: p.gol_casa || 0,
                gol_fora: p.gol_fora || 0,
                resultado: p.resultado || '',
                odd_casa: parseFloat(p.odd_casa) || 0,
                odd_empate: parseFloat(p.odd_empate) || 0,
                odd_fora: parseFloat(p.odd_fora) || 0,
            }));

            if (partidas.length < 5) continue;

            const filtroStats = FILTROS.map(f => {
                const n     = partidas.length;
                const n5    = Math.min(5,  n);
                const n10   = Math.min(10, n);
                const n20   = Math.min(20, n);

                const hGeral = partidas.filter(f.check).length;
                const h5     = partidas.slice(0, n5).filter(f.check).length;
                const h10    = partidas.slice(0, n10).filter(f.check).length;
                const h20    = partidas.slice(0, n20).filter(f.check).length;

                const txGeral = +(hGeral / n    * 100).toFixed(1);
                const tx5     = +(h5    / n5   * 100).toFixed(1);
                const tx10    = +(h10   / n10  * 100).toFixed(1);
                const tx20    = +(h20   / n20  * 100).toFixed(1);

                // Streak atual
                let streak = 0;
                const streakTipo = f.check(partidas[0]) ? 'verde' : 'vermelho';
                for (let i = 0; i < Math.min(30, n); i++) {
                    if (f.check(partidas[i]) === (streakTipo === 'verde')) streak++;
                    else break;
                }

                // Tendência (tx10 vs txGeral)
                const diff = tx10 - txGeral;
                const tendencia = diff > 8 ? 'subindo' : diff < -8 ? 'caindo' : 'estavel';

                // Confiança: alta se tx10 >= 65% e n >= 20, média >= 55%, baixa resto
                const referencia = n >= 20 ? tx10 : tx5;
                const confianca = (referencia >= 65 && n >= 10) ? 'alta'
                                : (referencia >= 55 && n >=  5) ? 'media' : 'baixa';

                return {
                    id: f.id, label: f.label,
                    tx_geral: txGeral, tx_ult5: tx5, tx_ult10: tx10, tx_ult20: tx20,
                    streak, streak_tipo: streakTipo, tendencia, confianca,
                    amostras: n
                };
            });

            // Ordenar por taxa recente (ult10)
            filtroStats.sort((a, b) => b.tx_ult10 - a.tx_ult10);

            // Estatísticas gerais da liga
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
        console.error('❌ ERRO API sugestoes:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/betano/historico-tabela
 * Retorna TODAS as partidas históricas em ordem cronológica ASC
 * para renderização da tabela estilo Caramelo.bet
 */
router.get('/historico-tabela', async (req, res) => {
    try {
        const { liga, horas = 24 } = req.query;
        const horasNum = Math.min(Math.max(parseInt(horas) || 24, 1), 168); // 1h–7 dias
        const pool = await getDbPool();

        const request = pool.request();
        request.input('horas', sql.Int, horasNum);

        let query = `
            SELECT
                id, evento_id, liga, time_casa, time_fora,
                gol_casa, gol_fora, resultado,
                odd_casa, odd_empate, odd_fora,
                data_partida, data_registro
            FROM betano_historico_partidas
            WHERE data_partida >= DATEADD(HOUR, -@horas, GETDATE())
        `;

        if (liga && liga !== 'all') {
            query += ' AND liga LIKE @liga';
            request.input('liga', sql.NVarChar(200), `%${liga}%`);
        }

        query += ' ORDER BY data_partida ASC, data_registro ASC';

        const result = await request.query(query);

        // Ligas distintas com contagem (dentro do período)
        const ligasResult = await pool.request()
            .input('horas2', sql.Int, horasNum)
            .query(`
                SELECT DISTINCT liga, COUNT(*) AS total
                FROM betano_historico_partidas
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
        console.error('❌ ERRO API historico-tabela:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/betano/diagnostico
 * Mostra estado atual do banco: schema, últimas coletas, amostra de dados
 */
router.get('/diagnostico', async (req, res) => {
    try {
        const pool = await getDbPool();

        // Colunas de betano_eventos
        const colunas = await pool.query(`
            SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_NAME = 'betano_eventos' ORDER BY ORDINAL_POSITION
        `);
        const colunasExistentes = colunas.recordset.map(r => r.COLUMN_NAME);
        const necessarias = ['gol_casa','gol_fora','odd_casa','odd_empate','odd_fora',
                             'minuto_jogo','estatisticas_json','posse_bola_casa',
                             'chutes_casa','escanteios_casa','cartoes_amarelos_casa'];
        const faltando = necessarias.filter(c => !colunasExistentes.includes(c));

        // Últimas 5 coletas
        const logs = await pool.query(`
            SELECT TOP 5 id, data_inicio, status, eventos_coletados,
                   mercados_coletados, odds_coletadas, estatisticas_coletadas,
                   LEFT(ISNULL(erro_mensagem,''), 200) AS erro
            FROM betano_log_coleta ORDER BY data_inicio DESC
        `);

        // Últimos 5 eventos Brasileirão
        let ultimosEventos = { recordset: [] };
        const temGolCasa = colunasExistentes.includes('gol_casa');
        if (temGolCasa) {
            ultimosEventos = await pool.query(`
                SELECT TOP 5 id, time_casa, time_fora, status,
                       gol_casa, gol_fora, odd_casa, odd_fora,
                       start_time_datetime, data_atualizacao
                FROM betano_eventos
                WHERE league_name = 'Brasileirão Betano'
                ORDER BY data_atualizacao DESC
            `);
        }

        // Últimos 10 resultados históricos hoje
        const historico = await pool.query(`
            SELECT TOP 10 time_casa, time_fora, gol_casa, gol_fora,
                   resultado, odd_casa, odd_empate, odd_fora, data_partida
            FROM betano_historico_partidas
            WHERE data_partida >= CAST(GETDATE() AS DATE)
            ORDER BY data_partida DESC
        `);

        // Contagem por resultado hoje
        const contagem = await pool.query(`
            SELECT resultado,
                   COUNT(*) AS total,
                   SUM(CASE WHEN gol_casa=0 AND gol_fora=0 THEN 1 ELSE 0 END) AS zero_zero
            FROM betano_historico_partidas
            WHERE data_partida >= CAST(GETDATE() AS DATE)
            GROUP BY resultado
        `);

        // Última estatística tempo real
        const ultimaStat = await pool.query(`
            SELECT TOP 3 etr.evento_id, be.time_casa, be.time_fora,
                   etr.gol_casa, etr.gol_fora, etr.minuto, etr.data_coleta
            FROM betano_estatisticas_tempo_real etr
            LEFT JOIN betano_eventos be ON be.id = etr.evento_id
            ORDER BY etr.data_coleta DESC
        `);

        res.json({
            success: true,
            schema: {
                colunasExistentes,
                faltando,
                ok: faltando.length === 0
            },
            ultimasColetas: logs.recordset,
            amostraEventos: ultimosEventos.recordset,
            historicoHoje: {
                partidas: historico.recordset,
                contagem: contagem.recordset,
                totalHoje: historico.recordset.length
            },
            ultimasEstatisticas: ultimaStat.recordset
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/betano/limpar-historico
 * ⚠️ DESATIVADO - Não apaga mais dados para proteger o histórico
 * Retorna apenas informações sobre os registros
 */
router.post('/limpar-historico', async (req, res) => {
    try {
        const pool = await getDbPool();

        // Apenas consulta, NÃO deleta
        const antes = await pool.query(`SELECT COUNT(*) AS total FROM betano_historico_partidas`);
        const totalAntes = antes.recordset[0].total;

        const placaresZero = await pool.query(`
            SELECT COUNT(*) AS total 
            FROM betano_historico_partidas 
            WHERE gol_casa = 0 AND gol_fora = 0
        `);
        const totalZero = placaresZero.recordset[0].total;

        const ultimosRegistros = await pool.query(`
            SELECT TOP 10 evento_id, liga, time_casa, time_fora, gol_casa, gol_fora, data_partida
            FROM betano_historico_partidas
            ORDER BY data_partida DESC
        `);

        res.json({
            success: true,
            msg: 'Operação de delete DESATIVADA para proteção dos dados',
            totalRegistros: totalAntes,
            placaresZero: totalZero,
            ultimosRegistros: ultimosRegistros.recordset
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/betano/resetar-tudo
 * ⚠️ DESATIVADO - Não apaga mais dados para proteger o histórico
 * Retorna apenas informações sobre as tabelas
 */
router.post('/resetar-tudo', async (req, res) => {
    try {
        const pool = await getDbPool();

        // Apenas consulta, NÃO deleta
        const countEventos = await pool.query(`SELECT COUNT(*) as total FROM betano_eventos`);
        const countHistorico = await pool.query(`SELECT COUNT(*) as total FROM betano_historico_partidas`);
        const countMercados = await pool.query(`SELECT COUNT(*) as total FROM betano_mercados`);
        const countOdds = await pool.query(`SELECT COUNT(*) as total FROM betano_odds`);
        const countLog = await pool.query(`SELECT COUNT(*) as total FROM betano_log_coleta`);

        res.json({
            success: true,
            msg: 'Operação de reset DESATIVADA para proteção dos dados',
            tabelas: {
                betano_eventos: countEventos.recordset[0].total,
                betano_historico_partidas: countHistorico.recordset[0].total,
                betano_mercados: countMercados.recordset[0].total,
                betano_odds: countOdds.recordset[0].total,
                betano_log_coleta: countLog.recordset[0].total
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/betano/buscar-resultados
 * Força busca de resultados de eventos que já deveriam ter terminado
 * Varre eventos antigos e tenta capturar placar final
 */
router.post('/buscar-resultados', async (req, res) => {
    try {
        const pool = await getDbPool();
        
        // Busca eventos que começaram há mais de 10 minutos e não têm resultado salvo
        const candidatos = await pool.query(`
            SELECT TOP 30
                e.id, e.time_casa, e.time_fora, e.league_name,
                e.gol_casa, e.gol_fora, e.start_time_datetime,
                e.odd_casa, e.odd_empate, e.odd_fora,
                DATEDIFF(MINUTE, e.start_time_datetime, GETDATE()) AS minutos_atras
            FROM betano_eventos e
            WHERE e.start_time_datetime < DATEADD(MINUTE, -10, GETDATE())
              AND e.time_casa <> '' AND e.time_fora <> ''
              AND NOT EXISTS (
                  SELECT 1 FROM betano_historico_partidas h 
                  WHERE h.evento_id = e.id
              )
            ORDER BY e.start_time_datetime ASC
        `);

        if (candidatos.recordset.length === 0) {
            return res.json({ 
                success: true, 
                encontrados: 0, 
                salvos: 0,
                msg: 'Nenhum evento candidato encontrado' 
            });
        }

        let salvos = 0;
        const resultados = [];

        for (const ev of candidatos.recordset) {
            let golCasa = ev.gol_casa || 0;
            let golFora = ev.gol_fora || 0;

            // Se não tem placar no evento, tenta nas estatísticas em tempo real
            if (golCasa === 0 && golFora === 0) {
                const stats = await pool.request()
                    .input('eventoId', sql.BigInt, ev.id)
                    .query(`
                        SELECT TOP 1 gol_casa, gol_fora
                        FROM betano_estatisticas_tempo_real
                        WHERE evento_id = @eventoId
                          AND (gol_casa > 0 OR gol_fora > 0)
                        ORDER BY data_coleta DESC
                    `);

                if (stats.recordset.length > 0) {
                    golCasa = stats.recordset[0].gol_casa;
                    golFora = stats.recordset[0].gol_fora;
                }
            }

            // Pula se ainda não tem placar ou se é 0x0 (pode ser que o jogo não tenha tido gols)
            // Mas salva se tiver decorrido mais de 30 minutos (provável 0x0 real)
            const minutosAtras = ev.minutos_atras || 0;
            if (golCasa === 0 && golFora === 0 && minutosAtras < 30) {
                resultados.push({
                    id: ev.id,
                    time_casa: ev.time_casa,
                    time_fora: ev.time_fora,
                    status: 'aguardando_placar',
                    minutos_atras: minutosAtras
                });
                continue;
            }

            const resultado = golCasa > golFora ? 'CASA' : golFora > golCasa ? 'FORA' : 'EMPATE';

            try {
                await pool.request()
                    .input('eventoId', sql.BigInt, ev.id)
                    .input('liga', sql.NVarChar(200), ev.league_name)
                    .input('timeCasa', sql.NVarChar(100), ev.time_casa)
                    .input('timeFora', sql.NVarChar(100), ev.time_fora)
                    .input('golCasa', sql.Int, golCasa)
                    .input('golFora', sql.Int, golFora)
                    .input('resultado', sql.NVarChar(10), resultado)
                    .input('oddCasa', sql.Decimal(10,2), ev.odd_casa || 0)
                    .input('oddEmpate', sql.Decimal(10,2), ev.odd_empate || 0)
                    .input('oddFora', sql.Decimal(10,2), ev.odd_fora || 0)
                    .input('dataPartida', sql.DateTime2, ev.start_time_datetime)
                    .query(`
                        IF NOT EXISTS (
                            SELECT 1 FROM betano_historico_partidas 
                            WHERE evento_id = @eventoId
                        )
                        INSERT INTO betano_historico_partidas
                            (evento_id, liga, time_casa, time_fora,
                             gol_casa, gol_fora, resultado,
                             odd_casa, odd_empate, odd_fora, data_partida)
                        VALUES
                            (@eventoId, @liga, @timeCasa, @timeFora,
                             @golCasa, @golFora, @resultado,
                             @oddCasa, @oddEmpate, @oddFora, @dataPartida)
                    `);
                
                salvos++;
                resultados.push({
                    id: ev.id,
                    time_casa: ev.time_casa,
                    time_fora: ev.time_fora,
                    placar: `${golCasa}-${golFora}`,
                    resultado: resultado,
                    status: 'salvo'
                });

            } catch (err) {
                resultados.push({
                    id: ev.id,
                    erro: err.message
                });
            }
        }

        res.json({
            success: true,
            candidatos: candidatos.recordset.length,
            salvos,
            resultados
        });

    } catch (err) {
        console.error('❌ ERRO API buscar-resultados:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/betano/tendencias
 * Retorna tendências de odds para eventos ao vivo
 * Compara odds atuais com odds iniciais
 */
router.get('/tendencias', async (req, res) => {
    try {
        const pool = await getDbPool();

        // Busca eventos ao vivo com odds atuais e estatísticas
        const result = await pool.query(`
            SELECT TOP 50
                e.id AS evento_id,
                e.time_casa,
                e.time_fora,
                e.league_name AS liga,
                e.gol_casa,
                e.gol_fora,
                e.minuto_jogo,
                e.odd_casa,
                e.odd_empate,
                e.odd_fora,
                e.posse_bola_casa,
                e.posse_bola_fora,
                e.chutes_casa,
                e.chutes_fora,
                e.chutes_gol_casa,
                e.chutes_gol_fora,
                e.status
            FROM betano_eventos e
            WHERE e.ativo = 1 AND e.status = 'EM_ANDAMENTO'
            ORDER BY e.start_time_datetime ASC
        `);

        const tendencias = result.recordset.map(ev => {
            // Calcula probabilidade implícita atual
            const implCasa = ev.odd_casa ? oddParaProbabilidade(ev.odd_casa) : 0;
            const implEmpate = ev.odd_empate ? oddParaProbabilidade(ev.odd_empate) : 0;
            const implFora = ev.odd_fora ? oddParaProbabilidade(ev.odd_fora) : 0;

            // Calcula margem
            const margem = calcularMargem(ev.odd_casa, ev.odd_empate, ev.odd_fora);

            // Detecta tendência baseada no momento do jogo
            // Se está perdendo e odd subiu = valor potencial
            let tendenciaCasa = 'estavel';
            let tendenciaFora = 'estavel';

            if (ev.gol_casa > ev.gol_fora) {
                // Casa ganhando: odd da casa deve cair
                tendenciaCasa = 'caindo';
                tendenciaFora = 'subindo';
            } else if (ev.gol_fora > ev.gol_casa) {
                // Fora ganhando
                tendenciaCasa = 'subindo';
                tendenciaFora = 'caindo';
            }

            // Ajusta por estatísticas (se chutes a gol é muito diferente)
            const diffChutes = (ev.chutes_gol_casa || 0) - (ev.chutes_gol_fora || 0);
            if (diffChutes > 3) tendenciaCasa = 'caindo'; // Mais chance de gol
            if (diffChutes < -3) tendenciaFora = 'caindo';

            // Calcula valor esperado (simplificado)
            const valorCasa = calcularValorEsperado(ev.odd_casa, implCasa * 0.9);
            const valorFora = calcularValorEsperado(ev.odd_fora, implFora * 0.9);

            return {
                evento_id: ev.evento_id,
                time_casa: ev.time_casa,
                time_fora: ev.time_fora,
                liga: ev.liga,
                placar: `${ev.gol_casa}-${ev.gol_fora}`,
                minuto: ev.minuto_jogo,
                odds: {
                    casa: ev.odd_casa,
                    empate: ev.odd_empate,
                    fora: ev.odd_fora
                },
                probabilidades: {
                    casa: formatarPorcentagem(implCasa),
                    empate: formatarPorcentagem(implEmpate),
                    fora: formatarPorcentagem(implFora)
                },
                margem: formatarPorcentagem(margem),
                tendencias: {
                    casa: tendenciaCasa,
                    fora: tendenciaFora
                },
                valor: {
                    casa: formatarNumero(valorCasa),
                    fora: formatarNumero(valorFora)
                },
                estatisticas: {
                    posse: {
                        casa: ev.posse_bola_casa || 0,
                        fora: ev.posse_bola_fora || 0
                    },
                    chutesGol: {
                        casa: ev.chutes_gol_casa || 0,
                        fora: ev.chutes_gol_fora || 0
                    }
                }
            };
        });

        res.json({
            success: true,
            count: tendencias.length,
            timestamp: new Date().toISOString(),
            data: tendencias
        });

    } catch (error) {
        console.error('❌ ERRO API tendencias:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/betano/filtro-avancado
 * Busca avançada com múltiplos filtros combinados
 */
router.get('/filtro-avancado', async (req, res) => {
    try {
        const {
            liga,
            time,
            status,
            golsMin,
            golsMax,
            oddMin,
            oddMax,
            posseMin,
            chutesMin,
            ordenar,
            limite = 100
        } = req.query;

        const pool = await getDbPool();
        const request = pool.request();

        let query = `
            SELECT
                e.id AS evento_id,
                e.time_casa,
                e.time_fora,
                e.league_name AS liga,
                e.start_time_datetime AS horario,
                e.status,
                e.gol_casa,
                e.gol_fora,
                e.minuto_jogo,
                e.odd_casa,
                e.odd_empate,
                e.odd_fora,
                e.posse_bola_casa,
                e.posse_bola_fora,
                e.chutes_casa,
                e.chutes_fora,
                e.chutes_gol_casa,
                e.chutes_gol_fora,
                e.escanteios_casa,
                e.escanteios_fora
            FROM betano_eventos e
            WHERE e.ativo = 1
        `;

        // Aplica filtros
        if (liga) {
            query += ' AND e.league_name LIKE @liga';
            request.input('liga', sql.NVarChar(200), `%${liga}%`);
        }

        if (time) {
            query += ' AND (e.time_casa LIKE @time OR e.time_fora LIKE @time)';
            request.input('time', sql.NVarChar(100), `%${time}%`);
        }

        if (status) {
            query += ' AND e.status = @status';
            request.input('status', sql.NVarChar(50), status);
        }

        if (golsMin != null) {
            query += ' AND (e.gol_casa + e.gol_fora) >= @golsMin';
            request.input('golsMin', sql.Int, parseInt(golsMin));
        }

        if (golsMax != null) {
            query += ' AND (e.gol_casa + e.gol_fora) <= @golsMax';
            request.input('golsMax', sql.Int, parseInt(golsMax));
        }

        if (oddMin != null) {
            query += ' AND (e.odd_casa >= @oddMin OR e.odd_fora >= @oddMin)';
            request.input('oddMin', sql.Decimal(10, 2), parseFloat(oddMin));
        }

        if (oddMax != null) {
            query += ' AND (e.odd_casa <= @oddMax OR e.odd_fora <= @oddMax)';
            request.input('oddMax', sql.Decimal(10, 2), parseFloat(oddMax));
        }

        if (posseMin != null) {
            query += ' AND e.posse_bola_casa >= @posseMin';
            request.input('posseMin', sql.Int, parseInt(posseMin));
        }

        if (chutesMin != null) {
            query += ' AND (e.chutes_gol_casa + e.chutes_gol_fora) >= @chutesMin';
            request.input('chutesMin', sql.Int, parseInt(chutesMin));
        }

        // Ordenação
        const ordenacoesValidas = ['horario', 'gols', 'odds', 'posse', 'chutes'];
        const ordenacao = ordenacoesValidas.includes(ordenar) ? ordenar : 'horario';

        switch (ordenacao) {
            case 'gols':
                query += ' ORDER BY (e.gol_casa + e.gol_fora) DESC, e.start_time_datetime ASC';
                break;
            case 'odds':
                query += ' ORDER BY (e.odd_casa + e.odd_fora) DESC, e.start_time_datetime ASC';
                break;
            case 'posse':
                query += ' ORDER BY e.posse_bola_casa DESC, e.start_time_datetime ASC';
                break;
            case 'chutes':
                query += ' ORDER BY (e.chutes_gol_casa + e.chutes_gol_fora) DESC, e.start_time_datetime ASC';
                break;
            default:
                query += ' ORDER BY e.start_time_datetime ASC';
        }

        // Limite
        query += ' OFFSET 0 ROWS FETCH NEXT @limite ROWS ONLY';
        request.input('limite', sql.Int, parseInt(limite));

        const result = await request.query(query);

        res.json({
            success: true,
            count: result.recordset.length,
            filtros: {
                liga, time, status, golsMin, golsMax, oddMin, oddMax, posseMin, chutesMin, ordenar
            },
            data: result.recordset
        });

    } catch (error) {
        console.error('❌ ERRO API filtro-avancado:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/betano/estatisticas-avancadas
 * Retorna estatísticas avançadas e métricas derivadas
 */
router.get('/estatisticas-avancadas', async (req, res) => {
    try {
        const pool = await getDbPool();

        // Estatísticas gerais agregadas
        const statsGerais = await pool.query(`
            SELECT
                COUNT(*) AS total_eventos,
                SUM(CASE WHEN status = 'EM_ANDAMENTO' THEN 1 ELSE 0 END) AS ao_vivo,
                SUM(CASE WHEN status = 'AGENDADO' THEN 1 ELSE 0 END) AS agendados,
                AVG(gol_casa + gol_fora) AS media_gols,
                AVG(odd_casa) AS media_odd_casa,
                AVG(odd_empate) AS media_odd_empate,
                AVG(odd_fora) AS media_odd_fora,
                AVG(posse_bola_casa) AS media_posse_casa,
                AVG(chutes_gol_casa + chutes_gol_fora) AS media_chutes_gol
            FROM betano_eventos
            WHERE ativo = 1
        `);

        // Distribuição de gols
        const distribuicaoGols = await pool.query(`
            SELECT
                (gol_casa + gol_fora) AS total_gols,
                COUNT(*) AS quantidade,
                CAST(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM betano_eventos WHERE ativo = 1) AS DECIMAL(5,2)) AS porcentagem
            FROM betano_eventos
            WHERE ativo = 1 AND (gol_casa + gol_fora) > 0
            GROUP BY (gol_casa + gol_fora)
            ORDER BY total_gols
        `);

        // Performance por liga
        const performanceLiga = await pool.query(`
            SELECT TOP 20
                league_name AS liga,
                COUNT(*) AS total_jogos,
                AVG(gol_casa + gol_fora) AS media_gols,
                SUM(CASE WHEN status = 'EM_ANDAMENTO' THEN 1 ELSE 0 END) AS ao_vivo,
                AVG(odd_casa + odd_empate + odd_fora) AS soma_odds,
                AVG(posse_bola_casa) AS media_posse_casa
            FROM betano_eventos
            WHERE ativo = 1 AND league_name IS NOT NULL AND league_name <> ''
            GROUP BY league_name
            ORDER BY total_jogos DESC
        `);

        // Heatmap de resultados (para eventos finalizados)
        const heatmapResultados = await pool.query(`
            SELECT
                gol_casa,
                gol_fora,
                COUNT(*) AS frequencia
            FROM betano_historico_partidas
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
        console.error('❌ ERRO API estatisticas-avancadas:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/betano/cache/stats
 * Retorna estatísticas do cache
 */
router.get('/cache/stats', async (req, res) => {
    try {
        const stats = betanoCache.getStats();
        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/betano/cache/limpar
 * Limpa o cache
 */
router.post('/cache/limpar', async (req, res) => {
    try {
        const { prefix } = req.body;
        betanoCache.clear(prefix);
        res.json({
            success: true,
            message: prefix ? `Cache com prefixo "${prefix}" limpo` : 'Cache totalmente limpo'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
