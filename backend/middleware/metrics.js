// backend/middleware/metrics.js - Middleware para coleta de métricas

const logger = require('../utils/logger');

// Armazenar métricas em memória (em produção, use Redis ou banco de dados)
let metrics = {
  requests: 0,
  errors: 0,
  responseTimes: [],
  endpoints: {},
  users: new Set(), // Usar Set para armazenar IDs únicos de usuários
  timestamp: new Date()
};

// Middleware para coleta de métricas
const metricsMiddleware = (req, res, next) => {
  const startTime = Date.now();
  
  // Incrementar contador de requisições
  metrics.requests++;
  
  // Registrar o endpoint acessado
  const endpoint = `${req.method} ${req.route ? req.route.path : req.path}`;
  metrics.endpoints[endpoint] = (metrics.endpoints[endpoint] || 0) + 1;
  
  // Capturar ID do usuário se estiver autenticado
  if (req.user && req.user.id) {
    metrics.users.add(req.user.id);
  }
  
  // Capturar o tempo de resposta quando a resposta for enviada
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    
    // Adicionar tempo de resposta às métricas
    metrics.responseTimes.push(duration);
    
    // Manter apenas os últimos 1000 tempos de resposta para economizar memória
    if (metrics.responseTimes.length > 1000) {
      metrics.responseTimes = metrics.responseTimes.slice(-1000);
    }
    
    // Verificar se foi um erro
    if (res.statusCode >= 400) {
      metrics.errors++;
    }
    
    // Log de requisição para fins de auditoria
    logger.info(`REQ ${req.method} ${req.url} - ${res.statusCode} - ${duration}ms`, {
      userId: req.user ? req.user.id : 'anonymous',
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
  });
  
  next();
};

// Função para obter métricas
const getMetrics = () => {
  // Calcular média de tempo de resposta
  const avgResponseTime = metrics.responseTimes.length > 0
    ? (metrics.responseTimes.reduce((a, b) => a + b, 0) / metrics.responseTimes.length).toFixed(2)
    : 0;
  
  // Obter tempo de resposta máximo e mínimo
  const maxResponseTime = metrics.responseTimes.length > 0
    ? Math.max(...metrics.responseTimes)
    : 0;
  
  const minResponseTime = metrics.responseTimes.length > 0
    ? Math.min(...metrics.responseTimes)
    : 0;
  
  return {
    summary: {
      totalRequests: metrics.requests,
      totalErrors: metrics.errors,
      errorRate: metrics.requests > 0 ? (metrics.errors / metrics.requests * 100).toFixed(2) : 0,
      activeUsers: metrics.users.size,
      timestamp: metrics.timestamp,
      uptime: process.uptime()
    },
    responseTimes: {
      average: `${avgResponseTime}ms`,
      min: `${minResponseTime}ms`,
      max: `${maxResponseTime}ms`,
      last100: metrics.responseTimes.slice(-100) // Últimos 100 tempos de resposta
    },
    endpoints: metrics.endpoints,
    topEndpoints: Object.entries(metrics.endpoints)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10)
      .map(([path, count]) => ({ path, count }))
  };
};

// Função para resetar métricas (opcional)
const resetMetrics = () => {
  metrics = {
    requests: 0,
    errors: 0,
    responseTimes: [],
    endpoints: {},
    users: new Set(),
    timestamp: new Date()
  };
};

module.exports = {
  metricsMiddleware,
  getMetrics,
  resetMetrics
};