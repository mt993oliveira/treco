const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/user');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Autenticação
 *   description: Rotas para autenticação de usuários
 */

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Autenticar usuário
 *     tags: [Autenticação]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               identifier:
 *                 type: string
 *                 description: Email ou nome de usuário
 *               password:
 *                 type: string
 *                 description: Senha do usuário
 *     responses:
 *       200:
 *         description: Login bem-sucedido
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                   description: Token JWT
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *                       description: ID do usuário
 *                     email:
 *                       type: string
 *                       description: Email do usuário
 *                     name:
 *                       type: string
 *                       description: Nome do usuário
 *                     username:
 *                       type: string
 *                       description: Nome de usuário
 */
router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;

    // Validação básica
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Email/nome de usuário e senha são obrigatórios.' });
    }

    // Buscar usuário por email ou nome de usuário
    const user = await User.findByEmailOrUsername(identifier);
    if (!user) {
      logger.warn(`Tentativa de login falhou - identificador não encontrado: ${identifier}`);
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    // Verificar senha - tentar diferentes métodos de verificação
    let isPasswordValid = false;

    // Primeiro tentar com bcrypt (para senhas hashadas)
    try {
      isPasswordValid = await bcrypt.compare(password, user.password_hash);
    } catch (error) {
      // Se houver erro com bcrypt, continuar com outras verificações
      isPasswordValid = false;
    }

    // Se bcrypt não validou, tentar outros métodos
    if (!isPasswordValid) {
      // Comparar com a senha em texto simples
      if (user.password_hash === password) {
        isPasswordValid = true;
      }
      // Tentar decodificar de base64 e comparar
      else {
        try {
          const decodedPassword = Buffer.from(user.password_hash, 'base64').toString('utf8');
          if (decodedPassword === password) {
            isPasswordValid = true;
          }
        } catch (decodeError) {
          // Não é base64 ou está corrompido, continuar sem alterar isPasswordValid
        }
      }
    }

    if (!isPasswordValid) {
      logger.warn(`Tentativa de login falhou - senha incorreta para: ${identifier}`);
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    // Gerar token JWT
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'default_secret',
      { expiresIn: '24h' }
    );

    logger.info(`Login bem-sucedido para o usuário: ${identifier}`);

    // Enviar resposta sem o hash da senha
    const { password_hash, ...userWithoutPassword } = user;
    res.json({
      token,
      user: userWithoutPassword
    });
  } catch (error) {
    logger.error(`Erro durante login: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Cadastrar novo usuário
 *     tags: [Autenticação]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Nome do usuário
 *               email:
 *                 type: string
 *                 description: Email do usuário
 *               username:
 *                 type: string
 *                 description: Nome de usuário
 *               password:
 *                 type: string
 *                 description: Senha do usuário
 *     responses:
 *       201:
 *         description: Usuário criado com sucesso
 *       400:
 *         description: Erro de validação
 */
router.post('/register', async (req, res) => {
  try {
    const { name, email, username, password } = req.body;

    // Validação básica
    if (!name || !email || !username || !password) {
      return res.status(400).json({ error: 'Nome, email, nome de usuário e senha são obrigatórios.' });
    }

    // Verificar se o email ou usuário já existe
    const existingUser = await User.findByEmail(email);
    if (existingUser) {
      return res.status(409).json({ error: 'Email ou nome de usuário já está em uso.' });
    }

    // Criar novo usuário
    const newUser = await User.create({ name, email, username, password, role: 'user' });

    logger.info(`Novo usuário cadastrado: ${email}`);

    res.status(201).json({ message: 'Usuário criado com sucesso.', userId: newUser.id });
  } catch (error) {
    logger.error(`Erro durante cadastro: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

/**
 * @swagger
 * /api/auth/profile:
 *   get:
 *     summary: Obter perfil do usuário autenticado
 *     tags: [Autenticação]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Perfil do usuário
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: integer
 *                   description: ID do usuário
 *                 email:
 *                   type: string
 *                   description: Email do usuário
 *                 name:
 *                   type: string
 *                   description: Nome do usuário
 */
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    const { password_hash, ...userWithoutPassword } = user;
    res.json(userWithoutPassword);
  } catch (error) {
    logger.error(`Erro ao obter perfil do usuário: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

module.exports = router;