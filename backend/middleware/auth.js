const jwt = require('jsonwebtoken');
const User = require('../models/user');

// Middleware para autenticação JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ 
      error: 'Acesso negado. Token não fornecido.' 
    });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'default_secret', (err, decoded) => {
    if (err) {
      return res.status(403).json({ 
        error: 'Token inválido.' 
      });
    }
    
    req.user = decoded;
    next();
  });
};

// Middleware para autorização de administrador
const authorizeAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    return res.status(403).json({ 
      error: 'Acesso negado. Permissões de administrador necessárias.' 
    });
  }
};

module.exports = {
  authenticateToken,
  authorizeAdmin
};