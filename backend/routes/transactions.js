const express = require('express');
const Transaction = require('../models/transaction');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Transações
 *   description: Rotas para gerenciamento de transações financeiras
 */

/**
 * @swagger
 * /api/transactions:
 *   get:
 *     summary: Listar transações do usuário autenticado
 *     tags: [Transações]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Número da página
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Número de itens por página
 *     responses:
 *       200:
 *         description: Lista de transações
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 transactions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                         description: ID da transação
 *                       description:
 *                         type: string
 *                         description: Descrição da transação
 *                       amount:
 *                         type: number
 *                         description: Valor da transação
 *                       type:
 *                         type: string
 *                         description: Tipo (income/expense)
 *                       date:
 *                         type: string
 *                         format: date
 *                         description: Data da transação
 *                 total:
 *                   type: integer
 *                   description: Total de transações
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const { transactions, total } = await Transaction.findByUser(userId, limit, offset);
    res.json({ transactions, total, page, pages: Math.ceil(total / limit) });
  } catch (error) {
    logger.error(`Erro ao listar transações do usuário ${req.user.id}: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

/**
 * @swagger
 * /api/transactions:
 *   post:
 *     summary: Criar nova transação
 *     tags: [Transações]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               description:
 *                 type: string
 *                 description: Descrição da transação
 *               amount:
 *                 type: number
 *                 description: Valor da transação
 *               type:
 *                 type: string
 *                 description: Tipo (income/expense)
 *               date:
 *                 type: string
 *                 format: date
 *                 description: Data da transação
 *     responses:
 *       201:
 *         description: Transação criada com sucesso
 *       400:
 *         description: Erro de validação
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { description, amount, type, date } = req.body;
    const userId = req.user.id;

    // Validação básica
    if (!description || !amount || !type) {
      return res.status(400).json({ error: 'Descrição, valor e tipo são obrigatórios.' });
    }

    if (!['income', 'expense'].includes(type)) {
      return res.status(400).json({ error: 'Tipo deve ser "income" ou "expense".' });
    }

    const transaction = await Transaction.create({
      userId,
      description,
      amount,
      type,
      date: date || new Date()
    });

    logger.info(`Transação criada para o usuário ${userId}: ${transaction.id}`);
    res.status(201).json(transaction);
  } catch (error) {
    logger.error(`Erro ao criar transação para o usuário ${req.user.id}: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

/**
 * @swagger
 * /api/transactions/{id}:
 *   get:
 *     summary: Obter uma transação específica
 *     tags: [Transações]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID da transação
 *     responses:
 *       200:
 *         description: Dados da transação
 *       404:
 *         description: Transação não encontrada
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction) {
      return res.status(404).json({ error: 'Transação não encontrada.' });
    }

    // Verificar se a transação pertence ao usuário autenticado
    if (transaction.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    res.json(transaction);
  } catch (error) {
    logger.error(`Erro ao obter transação ${req.params.id}: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

/**
 * @swagger
 * /api/transactions/{id}:
 *   put:
 *     summary: Atualizar uma transação
 *     tags: [Transações]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID da transação
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               description:
 *                 type: string
 *                 description: Descrição da transação
 *               amount:
 *                 type: number
 *                 description: Valor da transação
 *               type:
 *                 type: string
 *                 description: Tipo (income/expense)
 *               date:
 *                 type: string
 *                 format: date
 *                 description: Data da transação
 *     responses:
 *       200:
 *         description: Transação atualizada com sucesso
 *       404:
 *         description: Transação não encontrada
 */
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction) {
      return res.status(404).json({ error: 'Transação não encontrada.' });
    }

    // Verificar se a transação pertence ao usuário autenticado
    if (transaction.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    const { description, amount, type, date } = req.body;

    // Validação básica
    if (description !== undefined && !description) {
      return res.status(400).json({ error: 'Descrição não pode ser vazia.' });
    }
    if (amount !== undefined && typeof amount !== 'number') {
      return res.status(400).json({ error: 'Valor deve ser um número.' });
    }
    if (type !== undefined && !['income', 'expense'].includes(type)) {
      return res.status(400).json({ error: 'Tipo deve ser "income" ou "expense".' });
    }

    const updatedTransaction = await Transaction.update(req.params.id, {
      description,
      amount,
      type,
      date
    });

    logger.info(`Transação ${req.params.id} atualizada pelo usuário ${req.user.id}`);
    res.json(updatedTransaction);
  } catch (error) {
    logger.error(`Erro ao atualizar transação ${req.params.id}: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

/**
 * @swagger
 * /api/transactions/{id}:
 *   delete:
 *     summary: Deletar uma transação
 *     tags: [Transações]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID da transação
 *     responses:
 *       200:
 *         description: Transação deletada com sucesso
 *       404:
 *         description: Transação não encontrada
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction) {
      return res.status(404).json({ error: 'Transação não encontrada.' });
    }

    // Verificar se a transação pertence ao usuário autenticado
    if (transaction.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    const deleted = await Transaction.delete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Transação não encontrada.' });
    }

    logger.info(`Transação ${req.params.id} deletada pelo usuário ${req.user.id}`);
    res.json({ message: 'Transação deletada com sucesso.' });
  } catch (error) {
    logger.error(`Erro ao deletar transação ${req.params.id}: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

/**
 * @swagger
 * /api/transactions/summary:
 *   get:
 *     summary: Obter resumo financeiro do usuário
 *     tags: [Transações]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Resumo financeiro
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalIncome:
 *                   type: number
 *                   description: Total de receitas
 *                 totalExpenses:
 *                   type: number
 *                   description: Total de despesas
 *                 balance:
 *                   type: number
 *                   description: Saldo (receitas - despesas)
 */
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const summary = await Transaction.getSummaryByUser(userId);

    res.json(summary);
  } catch (error) {
    logger.error(`Erro ao obter resumo financeiro para o usuário ${req.user.id}: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

module.exports = router;