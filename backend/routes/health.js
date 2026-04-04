const express = require('express');
const { connect } = require('../config/db');
const logger = require('../utils/logger');

const router = express.Router();

// Endpoint de health check
router.get('/', async (req, res) => {
  try {
    const startTime = Date.now();
    
    // Verificar conectividade com o banco de dados
    let dbStatus = 'unknown';
    let dbLatency = 0;
    try {
      const pool = await connect();
      const dbStartTime = Date.now();
      await pool.query('SELECT 1 as health_check');
      dbLatency = Date.now() - dbStartTime;
      dbStatus = 'ok';
    } catch (dbError) {
      dbStatus = 'error';
      logger.error(`Health check - Erro de conexão com o banco: ${dbError.message}`);
    }
    
    // Calcular latência total
    const totalLatency = Date.now() - startTime;
    
    // Verificar uso de memória
    const memoryUsage = process.memoryUsage();
    
    // Preparar resposta
    const healthInfo = {
      status: dbStatus === 'ok' ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      totalLatency: `${totalLatency}ms`,
      database: {
        status: dbStatus,
        latency: `${dbLatency}ms`
      },
      memory: {
        rss: `${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`,
        heapTotal: `${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
        heapUsed: `${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
        external: `${(memoryUsage.external / 1024 / 1024).toFixed(2)} MB`
      }
    };
    
    // Verificar status HTTP adequado
    if (dbStatus === 'error') {
      return res.status(503).json(healthInfo);
    }
    
    res.status(200).json(healthInfo);
  } catch (error) {
    logger.error(`Erro no health check: ${error.message}`);
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// Endpoint para health check simplificado
router.get('/simple', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString() 
  });
});

// Endpoint para verificar recursos do sistema
router.get('/system', (req, res) => {
  const systemInfo = {
    pid: process.pid,
    title: process.title,
    version: process.version,
    versions: process.versions,
    platform: process.platform,
    arch: process.arch,
    memory: process.memoryUsage(),
    uptime: process.uptime(),
    loadAvg: process.env.NODE_ENV === 'production' ? process.loadavg() : [0, 0, 0],
    env: process.env.NODE_ENV,
    hostname: process.env.HOSTNAME || 'localhost'
  };
  
  res.status(200).json(systemInfo);
});

module.exports = router;