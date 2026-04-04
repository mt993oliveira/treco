const express = require('express');
const { getMetrics } = require('../middleware/metrics');
const { authenticateToken, authorizeAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Monitoramento
 *   description: Rotas para monitoramento e métricas
 */

/**
 * @swagger
 * /api/monitoring/metrics:
 *   get:
 *     summary: Obter métricas de uso do sistema
 *     tags: [Monitoramento]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Métricas do sistema
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 summary:
 *                   type: object
 *                   properties:
 *                     totalRequests:
 *                       type: number
 *                       description: Total de requisições
 *                     totalErrors:
 *                       type: number
 *                       description: Total de erros
 *                     errorRate:
 *                       type: number
 *                       description: Percentual de erros
 *                     activeUsers:
 *                       type: number
 *                       description: Número de usuários ativos
 */
router.get('/metrics', authenticateToken, authorizeAdmin, (req, res) => {
  try {
    const metrics = getMetrics();
    res.json(metrics);
  } catch (error) {
    logger.error(`Erro ao obter métricas: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// Endpoint para obter métricas resumidas (acessível com qualquer token válido)
router.get('/metrics/summary', authenticateToken, (req, res) => {
  try {
    const { summary } = getMetrics();
    res.json(summary);
  } catch (error) {
    logger.error(`Erro ao obter resumo de métricas: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

module.exports = router;