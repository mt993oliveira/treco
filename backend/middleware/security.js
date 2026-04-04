// backend/middleware/security.js - Middleware de segurança adicional

const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const hpp = require('hpp');

// Middleware de proteção contra rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: process.env.NODE_ENV === 'production' ? 100 : 500,
  message: {
    error: 'Muitas requisições realizadas a partir deste IP. Por favor, tente novamente mais tarde.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware de segurança com helmet
const securityHelmet = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:", "http:"],
      scriptSrc: ["'self'", "https:", "http:"],
      imgSrc: ["'self'", "data:", "https:", "http:"],
      fontSrc: ["'self'", "https:", "http:"],
      connectSrc: ["'self'", "https:", "http:"],
      frameSrc: ["'self'"],
      objectSrc: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000, // 1 ano
    includeSubDomains: true,
    preload: true
  },
  referrerPolicy: {
    policy: 'no-referrer'
  }
});

// Middleware para sanitizar dados de entrada (proteção contra injeção)
const sanitize = mongoSanitize();

// Middleware para prevenir XSS
const preventXSS = xss();

// Middleware para prevenir parâmetros duplicados
const preventHPP = hpp();

module.exports = {
  limiter,
  securityHelmet,
  sanitize,
  preventXSS,
  preventHPP
};