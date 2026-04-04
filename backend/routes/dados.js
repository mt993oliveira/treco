const express = require('express');
const sql = require('mssql');
const dotenv = require('dotenv');

dotenv.config();

const router = express.Router();

// Conexão direta (sem pool global)
async function query(sqlQuery, params = {}) {
    const config = {
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        server: process.env.DB_SERVER,
        database: process.env.DB_NAME,
        port: parseInt(process.env.DB_PORT) || 1433,
        options: {
            encrypt: process.env.DB_ENCRYPT === 'true',
            trustServerCertificate: process.env.DB_TRUST_CERT === 'true'
        }
    };

    const pool = await sql.connect(config);
    const request = pool.request();
    
    Object.entries(params).forEach(([key, value]) => {
        request.input(key, value);
    });
    
    const result = await request.query(sqlQuery);
    await pool.close();
    
    return result.recordset;
}

/**
 * GET /api/dados/partidas
 * Retorna partidas diretamente do banco
 */
router.get('/partidas', async (req, res) => {
    try {
        const { limite = 200, liga, status } = req.query;
        
        let whereClause = 'WHERE 1=1';
        const params = { limite: parseInt(limite) || 200 };
        
        if (liga) {
            whereClause += ' AND Liga = @liga';
            params.liga = liga;
        }
        
        if (status) {
            whereClause += ' AND StatusPartida = @status';
            params.status = status;
        }
        
        const query = `
            SELECT TOP (@limite)
                Id, CasaAposta, Liga, TimeCasa, TimeFora,
                GolCasa, GolFora, StatusPartida, Minuto,
                OddCasa, OddEmpate, OddFora, DataPartida,
                DataColeta, PaginaUrl
            FROM FutebolVirtual
            ${whereClause}
            ORDER BY DataColeta DESC, DataPartida DESC
        `;
        
        const data = await query(query, params);
        
        res.json({
            success: true,
            count: data.length,
            data: data
        });
        
    } catch (error) {
        console.error('Erro API dados:', error.message);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar dados',
            error: error.message
        });
    }
});

/**
 * GET /api/dados/ligas
 * Retorna lista de ligas
 */
router.get('/ligas', async (req, res) => {
    try {
        const data = await query(`
            SELECT DISTINCT Liga, COUNT(*) as Quantidade
            FROM FutebolVirtual
            GROUP BY Liga
            ORDER BY Quantidade DESC
        `);
        
        res.json({
            success: true,
            count: data.length,
            data: data
        });
        
    } catch (error) {
        console.error('Erro API ligas:', error.message);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar ligas',
            error: error.message
        });
    }
});

/**
 * GET /api/dados/estatisticas
 * Retorna estatísticas
 */
router.get('/estatisticas', async (req, res) => {
    try {
        const stats = await query(`
            SELECT
                COUNT(*) as TotalPartidas,
                SUM(CASE WHEN StatusPartida = 'AO_VIVO' THEN 1 ELSE 0 END) as AoVivo,
                SUM(CASE WHEN StatusPartida = 'AGENDADA' THEN 1 ELSE 0 END) as Agendadas,
                COUNT(DISTINCT Liga) as TotalLigas
            FROM FutebolVirtual
        `);
        
        const ligas = await query(`
            SELECT TOP 10 Liga, COUNT(*) as Partidas
            FROM FutebolVirtual
            GROUP BY Liga
            ORDER BY Partidas DESC
        `);
        
        res.json({
            success: true,
            data: {
                estatisticas: stats[0],
                ligas: ligas
            }
        });
        
    } catch (error) {
        console.error('Erro API estatisticas:', error.message);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar estatísticas',
            error: error.message
        });
    }
});

module.exports = router;
