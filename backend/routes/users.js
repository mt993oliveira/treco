const express = require('express');
const User = require('../models/user');
const { authenticateToken, authorizeAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Usuários
 *   description: Rotas para gerenciamento de usuários
 */

/**
 * @swagger
 * /api/users:
 *   get:
 *     summary: Listar todos os usuários (somente administradores)
 *     tags: [Usuários]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Lista de usuários
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: integer
 *                     description: ID do usuário
 *                   email:
 *                     type: string
 *                     description: Email do usuário
 *                   name:
 *                     type: string
 *                     description: Nome do usuário
 */
router.get('/', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const users = await User.getAll();
    res.json(users.map(user => {
      const { password_hash, ...userWithoutPassword } = user;
      return userWithoutPassword;
    }));
  } catch (error) {
    logger.error(`Erro ao listar usuários: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

/**
 * @swagger
 * /api/users/{id}:
 *   get:
 *     summary: Obter um usuário específico
 *     tags: [Usuários]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID do usuário
 *     responses:
 *       200:
 *         description: Dados do usuário
 *       404:
 *         description: Usuário não encontrado
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    const { password_hash, ...userWithoutPassword } = user;
    res.json(userWithoutPassword);
  } catch (error) {
    logger.error(`Erro ao obter usuário ${req.params.id}: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

/**
 * @swagger
 * /api/users/{id}:
 *   put:
 *     summary: Atualizar um usuário
 *     tags: [Usuários]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID do usuário
 *     requestBody:
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
 *     responses:
 *       200:
 *         description: Usuário atualizado com sucesso
 *       404:
 *         description: Usuário não encontrado
 */
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    // Somente o próprio usuário ou administrador podem atualizar
    if (req.user.id !== parseInt(req.params.id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    const { name, email } = req.body;
    const updatedUser = await User.update(req.params.id, { name, email });

    if (!updatedUser) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    logger.info(`Usuário ${req.params.id} atualizado por usuário ${req.user.id}`);
    const { password_hash, ...userWithoutPassword } = updatedUser;
    res.json(userWithoutPassword);
  } catch (error) {
    logger.error(`Erro ao atualizar usuário ${req.params.id}: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

/**
 * @swagger
 * /api/users/{id}:
 *   delete:
 *     summary: Deletar um usuário
 *     tags: [Usuários]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID do usuário
 *     responses:
 *       200:
 *         description: Usuário deletado com sucesso
 *       404:
 *         description: Usuário não encontrado
 */
router.delete('/:id', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const deleted = await User.delete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    logger.info(`Usuário ${req.params.id} deletado por administrador ${req.user.id}`);
    res.json({ message: 'Usuário deletado com sucesso.' });
  } catch (error) {
    logger.error(`Erro ao deletar usuário ${req.params.id}: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

module.exports = router;