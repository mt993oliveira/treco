// Model para Transaction - adaptado para usar as tabelas existentes do banco de dados
const { connect } = require('../config/db');
const logger = require('../utils/logger');

const Transaction = {
  // Método para buscar despesas mensais de um usuário
  findByUser: async (userId, limit = 10, offset = 0) => {
    try {
      const pool = await connect();

      // Buscar despesas mensais com paginação (vamos usar despesas mensais como exemplo principal)
      const request = pool.request();
      request.input('userId', userId);
      request.input('limit', limit);
      request.input('offset', offset);
      const result = await request.query(`
        SELECT Id as id, Mes as month, Ano as year, Descricao as description,
               Valor as amount, Observacoes as notes, UsuarioId as user_id,
               DataCriacao as created_at, DataAtualizacao as updated_at
        FROM DespesasMensais
        WHERE UsuarioId = @userId
        ORDER BY DataCriacao DESC
        OFFSET @offset ROWS
        FETCH NEXT @limit ROWS ONLY
      `);

      // Obter total de despesas mensais
      const countRequest = pool.request();
      countRequest.input('userId', userId);
      const countResult = await countRequest.query(`
        SELECT COUNT(*) as total
        FROM DespesasMensais
        WHERE UsuarioId = @userId
      `);

      return {
        transactions: result.recordset,
        total: countResult.recordset[0].total
      };
    } catch (error) {
      logger.error(`Erro ao buscar transações do usuário: ${error.message}`);
      throw error;
    }
  },

  findById: async (id) => {
    try {
      const pool = await connect();

      // Primeiro tentar encontrar na tabela DespesasMensais
      const request1 = pool.request();
      request1.input('id', id);
      let result = await request1.query(`
        SELECT Id as id, Mes as month, Ano as year, Descricao as description,
               Valor as amount, Observacoes as notes, UsuarioId as user_id,
               DataCriacao as created_at, DataAtualizacao as updated_at
        FROM DespesasMensais
        WHERE Id = @id
      `);

      if (result.recordset.length > 0) {
        return result.recordset[0];
      }

      // Tentar na tabela DespesasAnuais
      const request2 = pool.request();
      request2.input('id', id);
      result = await request2.query(`
        SELECT Id as id, Mes as month, Ano as year, Descricao as description,
               ValorAnual as amount, UsuarioId as user_id,
               DataCriacao as created_at, DataAtualizacao as updated_at
        FROM DespesasAnuais
        WHERE Id = @id
      `);

      if (result.recordset.length > 0) {
        return result.recordset[0];
      }

      // Tentar na tabela NubankCobrancasFixas
      const request3 = pool.request();
      request3.input('id', id);
      result = await request3.query(`
        SELECT Id as id, Mes as month, Ano as year, Descricao as description,
               Valor as amount, UsuarioId as user_id,
               DataCriacao as created_at, DataAtualizacao as updated_at
        FROM NubankCobrancasFixas
        WHERE Id = @id
      `);

      return result.recordset[0] || null;
    } catch (error) {
      logger.error(`Erro ao buscar transação por ID: ${error.message}`);
      throw error;
    }
  },

  // Método para criar diferentes tipos de transações baseado no tipo
  create: async ({ userId, description, amount, type, month, year, notes }) => {
    try {
      const pool = await connect();

      if (type === 'monthly_expense') {
        // Criar despesa mensal
        const request = pool.request();
        request.input('month', month);
        request.input('year', year);
        request.input('description', description);
        request.input('amount', amount);
        request.input('notes', notes || '');
        request.input('userId', userId);
        const result = await request.query(`
          INSERT INTO DespesasMensais (Mes, Ano, Descricao, Valor, Observacoes, UsuarioId)
          OUTPUT INSERTED.Id as id, INSERTED.Mes as month, INSERTED.Ano as year,
                 INSERTED.Descricao as description, INSERTED.Valor as amount,
                 INSERTED.Observacoes as notes, INSERTED.UsuarioId as user_id,
                 INSERTED.DataCriacao as created_at
          VALUES (@month, @year, @description, @amount, @notes, @userId)
        `);
        return result.recordset[0];
      } else if (type === 'annual_expense') {
        // Calcular valor mensal
        const monthlyAmount = amount / 12;

        // Criar despesa anual
        const request = pool.request();
        request.input('month', month);
        request.input('year', year);
        request.input('description', description);
        request.input('amount', amount);
        request.input('monthlyAmount', monthlyAmount);
        request.input('userId', userId);
        const result = await request.query(`
          INSERT INTO DespesasAnuais (Mes, Ano, Descricao, ValorAnual, ValorMensal, UsuarioId)
          OUTPUT INSERTED.Id as id, INSERTED.Mes as month, INSERTED.Ano as year,
                 INSERTED.Descricao as description, INSERTED.ValorAnual as amount,
                 INSERTED.UsuarioId as user_id, INSERTED.DataCriacao as created_at
          VALUES (@month, @year, @description, @amount, @monthlyAmount, @userId)
        `);
        return result.recordset[0];
      } else if (type === 'nubank_fixed') {
        // Criar cobrança fixa do Nubank
        const request = pool.request();
        request.input('month', month);
        request.input('year', year);
        request.input('description', description);
        request.input('amount', amount);
        request.input('userId', userId);
        const result = await request.query(`
          INSERT INTO NubankCobrancasFixas (Mes, Ano, Descricao, Valor, UsuarioId)
          OUTPUT INSERTED.Id as id, INSERTED.Mes as month, INSERTED.Ano as year,
                 INSERTED.Descricao as description, INSERTED.Valor as amount,
                 INSERTED.UsuarioId as user_id, INSERTED.DataCriacao as created_at
          VALUES (@month, @year, @description, @amount, @userId)
        `);
        return result.recordset[0];
      }

      throw new Error('Tipo de transação inválido');
    } catch (error) {
      logger.error(`Erro ao criar transação: ${error.message}`);
      throw error;
    }
  },

  update: async (id, { description, amount, type, month, year, notes }) => {
    try {
      const pool = await connect();

      // Determinar qual tabela atualizar com base no tipo de transação
      if (type === 'monthly_expense') {
        // Construir a query dinamicamente com parâmetros
        let query = `UPDATE DespesasMensais SET `;
        const updateFields = [];
        const request = pool.request();

        if (description) {
          updateFields.push('Descricao = @description');
          request.input('description', description);
        }
        if (amount) {
          updateFields.push('Valor = @amount');
          request.input('amount', amount);
        }
        if (month) {
          updateFields.push('Mes = @month');
          request.input('month', month);
        }
        if (year) {
          updateFields.push('Ano = @year');
          request.input('year', year);
        }
        if (notes) {
          updateFields.push('Observacoes = @notes');
          request.input('notes', notes);
        }

        query += updateFields.join(', ');
        query += `, DataAtualizacao = GETDATE() WHERE Id = @id`;
        query += ` OUTPUT INSERTED.Id as id, INSERTED.Mes as month, INSERTED.Ano as year,
                   INSERTED.Descricao as description, INSERTED.Valor as amount,
                   INSERTED.Observacoes as notes, INSERTED.UsuarioId as user_id,
                   INSERTED.DataAtualizacao as updated_at`;

        request.input('id', id);

        const result = await request.query(query);
        return result.recordset[0] || null;
      } else if (type === 'annual_expense') {
        // Calcular valor mensal
        const monthlyAmount = amount ? amount / 12 : undefined;

        // Construir a query dinamicamente com parâmetros
        let query = `UPDATE DespesasAnuais SET `;
        const updateFields = [];
        const request = pool.request();

        if (description) {
          updateFields.push('Descricao = @description');
          request.input('description', description);
        }
        if (amount) {
          updateFields.push('ValorAnual = @amount');
          request.input('amount', amount);
        }
        if (monthlyAmount) {
          updateFields.push('ValorMensal = @monthlyAmount');
          request.input('monthlyAmount', monthlyAmount);
        }
        if (month) {
          updateFields.push('Mes = @month');
          request.input('month', month);
        }
        if (year) {
          updateFields.push('Ano = @year');
          request.input('year', year);
        }

        query += updateFields.join(', ');
        query += `, DataAtualizacao = GETDATE() WHERE Id = @id`;
        query += ` OUTPUT INSERTED.Id as id, INSERTED.Mes as month, INSERTED.Ano as year,
                   INSERTED.Descricao as description, INSERTED.ValorAnual as amount,
                   INSERTED.UsuarioId as user_id, INSERTED.DataAtualizacao as updated_at`;

        request.input('id', id);

        const result = await request.query(query);
        return result.recordset[0] || null;
      } else if (type === 'nubank_fixed') {
        // Construir a query dinamicamente com parâmetros
        let query = `UPDATE NubankCobrancasFixas SET `;
        const updateFields = [];
        const request = pool.request();

        if (description) {
          updateFields.push('Descricao = @description');
          request.input('description', description);
        }
        if (amount) {
          updateFields.push('Valor = @amount');
          request.input('amount', amount);
        }
        if (month) {
          updateFields.push('Mes = @month');
          request.input('month', month);
        }
        if (year) {
          updateFields.push('Ano = @year');
          request.input('year', year);
        }

        query += updateFields.join(', ');
        query += `, DataAtualizacao = GETDATE() WHERE Id = @id`;
        query += ` OUTPUT INSERTED.Id as id, INSERTED.Mes as month, INSERTED.Ano as year,
                   INSERTED.Descricao as description, INSERTED.Valor as amount,
                   INSERTED.UsuarioId as user_id, INSERTED.DataAtualizacao as updated_at`;

        request.input('id', id);

        const result = await request.query(query);
        return result.recordset[0] || null;
      }

      throw new Error('Tipo de transação inválido para atualização');
    } catch (error) {
      logger.error(`Erro ao atualizar transação: ${error.message}`);
      throw error;
    }
  },

  delete: async (id) => {
    try {
      const pool = await connect();

      // Tentar deletar de cada tabela até encontrar o registro
      const request1 = pool.request();
      request1.input('id', id);
      let result = await request1.query(`
        DELETE FROM DespesasMensais
        WHERE Id = @id
        OUTPUT DELETED.Id
      `);

      if (result.rowsAffected[0] > 0) {
        return true;
      }

      const request2 = pool.request();
      request2.input('id', id);
      result = await request2.query(`
        DELETE FROM DespesasAnuais
        WHERE Id = @id
        OUTPUT DELETED.Id
      `);

      if (result.rowsAffected[0] > 0) {
        return true;
      }

      const request3 = pool.request();
      request3.input('id', id);
      result = await request3.query(`
        DELETE FROM NubankCobrancasFixas
        WHERE Id = @id
        OUTPUT DELETED.Id
      `);

      return result.rowsAffected[0] > 0;
    } catch (error) {
      logger.error(`Erro ao deletar transação: ${error.message}`);
      throw error;
    }
  },

  getSummaryByUser: async (userId) => {
    try {
      const pool = await connect();

      // Obter total de despesas mensais
      const monthlyRequest = pool.request();
      monthlyRequest.input('userId', userId);
      const monthlyResult = await monthlyRequest.query(`
        SELECT ISNULL(SUM(Valor), 0) as totalMonthly
        FROM DespesasMensais
        WHERE UsuarioId = @userId
      `);

      // Obter total de despesas anuais (usando o valor anual total)
      const annualRequest = pool.request();
      annualRequest.input('userId', userId);
      const annualResult = await annualRequest.query(`
        SELECT ISNULL(SUM(ValorAnual), 0) as totalAnnual
        FROM DespesasAnuais
        WHERE UsuarioId = @userId
      `);

      // Obter total de cobranças fixas do Nubank
      const nubankRequest = pool.request();
      nubankRequest.input('userId', userId);
      const nubankResult = await nubankRequest.query(`
        SELECT ISNULL(SUM(Valor), 0) as totalNubank
        FROM NubankCobrancasFixas
        WHERE UsuarioId = @userId
      `);

      const totalExpenses = monthlyResult.recordset[0].totalMonthly +
                           annualResult.recordset[0].totalAnnual +
                           nubankResult.recordset[0].totalNubank;

      return {
        totalIncome: 0, // No seu sistema atual não há tabela específica de receitas
        totalExpenses,
        balance: -totalExpenses // Negativo porque são despesas
      };
    } catch (error) {
      logger.error(`Erro ao obter resumo financeiro: ${error.message}`);
      throw error;
    }
  }
};

module.exports = Transaction;