// backend/utils/auditLogger.js - Sistema de log de auditoria

const logger = require('./logger');
const { connect } = require('../config/db');

// Função para registrar uma ação de auditoria
const auditLog = async (userId, action, resource = null, details = null) => {
  try {
    // Registrar no logger Winston
    logger.info('AUDIT', {
      userId,
      action,
      resource,
      details,
      timestamp: new Date().toISOString(),
      ip: null, // Será preenchido pelo middleware
      userAgent: null // Será preenchido pelo middleware
    });

    // Em produção, também registrar no banco de dados
    if (process.env.NODE_ENV === 'production') {
      const pool = await connect();
      
      await pool.query(`
        INSERT INTO audit_logs (user_id, action, resource, details, ip_address, user_agent, created_at)
        VALUES (@userId, @action, @resource, @details, @ipAddress, @userAgent, GETDATE())
      `, {
        userId,
        action,
        resource,
        details,
        ipAddress: null,
        userAgent: null
      });
    }
  } catch (error) {
    // Não lançar erro para não afetar a operação principal
    logger.error(`Erro ao registrar log de auditoria: ${error.message}`);
  }
};

// Middleware para adicionar informações de auditoria às requisições
const auditMiddleware = (req, res, next) => {
  // Armazenar informações de IP e User-Agent para auditoria
  req.auditInfo = {
    ip: req.ip,
    userAgent: req.get('User-Agent')
  };

  // Registrar início da requisição
  const startTime = Date.now();
  
  // Intercepta o envio da resposta para registrar a auditoria
  const originalSend = res.send;
  res.send = function(data) {
    // Registra auditoria se houver usuário autenticado
    if (req.user && req.user.id) {
      const auditDetails = {
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        responseTime: Date.now() - startTime,
        dataSize: data ? (typeof data === 'string' ? data.length : JSON.stringify(data).length) : 0
      };
      
      // Registra no log de auditoria
      auditLog(
        req.user.id, 
        'REQUEST_COMPLETED', 
        `${req.method} ${req.url}`, 
        auditDetails
      ).catch(err => {
        logger.error(`Erro no auditLog: ${err.message}`);
      });
    }
    
    return originalSend.call(this, data);
  };
  
  next();
};

// Função para registrar auditoria de login
const logLogin = async (userId, success, details = null) => {
  const action = success ? 'LOGIN_SUCCESS' : 'LOGIN_FAILED';
  await auditLog(userId, action, 'auth', details);
};

// Função para registrar auditoria de logout
const logLogout = async (userId, details = null) => {
  await auditLog(userId, 'LOGOUT', 'auth', details);
};

// Função para registrar auditoria de alterações de dados
const logDataChange = async (userId, action, resource, details) => {
  await auditLog(userId, action, resource, details);
};

// Função para registrar auditoria de acesso não autorizado
const logUnauthorizedAccess = async (userId, resource, details = null) => {
  await auditLog(userId, 'UNAUTHORIZED_ACCESS', resource, details);
};

// Função para obter logs de auditoria
const getAuditLogs = async (userId = null, limit = 100, offset = 0) => {
  try {
    const pool = await connect();
    
    let query = `
      SELECT user_id, action, resource, details, ip_address, user_agent, created_at
      FROM audit_logs
    `;
    const params = {};
    
    if (userId) {
      query += ' WHERE user_id = @userId';
      params.userId = userId;
    }
    
    query += ' ORDER BY created_at DESC';
    query += ' OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY';
    
    params.offset = offset;
    params.limit = limit;
    
    const result = await pool.query(query, params);
    return result.recordset;
  } catch (error) {
    logger.error(`Erro ao obter logs de auditoria: ${error.message}`);
    throw error;
  }
};

module.exports = {
  auditLog,
  auditMiddleware,
  logLogin,
  logLogout,
  logDataChange,
  logUnauthorizedAccess,
  getAuditLogs
};