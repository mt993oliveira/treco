// Model para User - adaptado para usar a tabela Usuarios existente no banco de dados
const bcrypt = require('bcryptjs');
const { connect } = require('../config/db');
const logger = require('../utils/logger');

const User = {
  findByEmail: async (email) => {
    try {
      const pool = await connect();
      const request = pool.request();
      request.input('email', email);
      const result = await request.query(`
        SELECT Id as id, NomeCompleto as name, Email as email, Usuario as username, Senha as password_hash, TipoUsuario as role, DataCriacao as created_at
        FROM Usuarios
        WHERE Email = @email AND Ativo = 1
      `);

      return result.recordset[0] || null;
    } catch (error) {
      logger.error(`Erro ao buscar usuário por email: ${error.message}`);
      throw error;
    }
  },

  findByUsername: async (username) => {
    try {
      const pool = await connect();
      const request = pool.request();
      request.input('username', username);
      const result = await request.query(`
        SELECT Id as id, NomeCompleto as name, Email as email, Usuario as username, Senha as password_hash, TipoUsuario as role, DataCriacao as created_at
        FROM Usuarios
        WHERE Usuario = @username AND Ativo = 1
      `);

      return result.recordset[0] || null;
    } catch (error) {
      logger.error(`Erro ao buscar usuário por nome de usuário: ${error.message}`);
      throw error;
    }
  },

  findByEmailOrUsername: async (identifier) => {
    try {
      const pool = await connect();
      const request = pool.request();
      request.input('identifier', identifier);
      const result = await request.query(`
        SELECT Id as id, NomeCompleto as name, Email as email, Usuario as username, Senha as password_hash, TipoUsuario as role, DataCriacao as created_at
        FROM Usuarios
        WHERE (Email = @identifier OR Usuario = @identifier) AND Ativo = 1
      `);

      return result.recordset[0] || null;
    } catch (error) {
      logger.error(`Erro ao buscar usuário por email ou nome de usuário: ${error.message}`);
      throw error;
    }
  },

  findById: async (id) => {
    try {
      const pool = await connect();
      const request = pool.request();
      request.input('id', id);
      const result = await request.query(`
        SELECT Id as id, NomeCompleto as name, Email as email, TipoUsuario as role, DataCriacao as created_at
        FROM Usuarios
        WHERE Id = @id AND Ativo = 1
      `);

      return result.recordset[0] || null;
    } catch (error) {
      logger.error(`Erro ao buscar usuário por ID: ${error.message}`);
      throw error;
    }
  },

  getAll: async () => {
    try {
      const pool = await connect();
      const result = await pool.query(`
        SELECT Id as id, NomeCompleto as name, Usuario as username, Email as email, TipoUsuario as role, DataCriacao as created_at, Ativo as active
        FROM Usuarios
        ORDER BY DataCriacao DESC
      `);
      
      return result.recordset;
    } catch (error) {
      logger.error(`Erro ao buscar todos os usuários: ${error.message}`);
      throw error;
    }
  },

  create: async ({ name, email, password, username, role = 'user' }) => {
    try {
      const pool = await connect();

      // Verificar se o email ou usuário já existe
      const request1 = pool.request();
      request1.input('email', email);
      request1.input('username', username);
      const existingUser = await request1.query(`
        SELECT Id FROM Usuarios
        WHERE Email = @email OR Usuario = @username
      `);

      if (existingUser.recordset.length > 0) {
        throw new Error('Email ou usuário já está em uso');
      }

      // Criptografar a senha com bcrypt
      const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS) || 12;
      const password_hash = await bcrypt.hash(password, saltRounds);

      const request2 = pool.request();
      request2.input('name', name);
      request2.input('username', username);
      request2.input('email', email);
      request2.input('password_hash', password_hash);
      request2.input('role', role);
      const result = await request2.query(`
        INSERT INTO Usuarios (NomeCompleto, Usuario, Email, Senha, TipoUsuario)
        OUTPUT INSERTED.Id as id, INSERTED.NomeCompleto as name, INSERTED.Usuario as username,
               INSERTED.Email as email, INSERTED.TipoUsuario as role, INSERTED.DataCriacao as created_at
        VALUES (@name, @username, @email, @password_hash, @role)
      `);

      return result.recordset[0];
    } catch (error) {
      logger.error(`Erro ao criar usuário: ${error.message}`);
      throw error;
    }
  },

  update: async (id, { name, email, username, role }) => {
    try {
      const pool = await connect();

      // Verificar se o email ou usuário já está sendo usado por outro usuário
      const request1 = pool.request();
      request1.input('email', email);
      request1.input('username', username);
      request1.input('id', id);
      const existingUser = await request1.query(`
        SELECT Id FROM Usuarios
        WHERE (Email = @email OR Usuario = @username) AND Id != @id
      `);

      if (existingUser.recordset.length > 0) {
        throw new Error('Email ou usuário já está em uso por outro usuário');
      }

      // Construir a query dinamicamente com parâmetros
      let query = `UPDATE Usuarios SET `;
      const updateFields = [];
      const request = pool.request();

      if (name) {
        updateFields.push('NomeCompleto = @name');
        request.input('name', name);
      }
      if (username) {
        updateFields.push('Usuario = @username');
        request.input('username', username);
      }
      if (email) {
        updateFields.push('Email = @email');
        request.input('email', email);
      }
      if (role) {
        updateFields.push('TipoUsuario = @role');
        request.input('role', role);
      }

      query += updateFields.join(', ');
      query += `, DataAtualizacao = GETDATE() WHERE Id = @id`;
      query += ` OUTPUT INSERTED.Id as id, INSERTED.NomeCompleto as name, INSERTED.Usuario as username,
                 INSERTED.Email as email, INSERTED.TipoUsuario as role, INSERTED.DataAtualizacao as updated_at`;

      request.input('id', id);

      const result = await request.query(query);

      return result.recordset[0] || null;
    } catch (error) {
      logger.error(`Erro ao atualizar usuário: ${error.message}`);
      throw error;
    }
  },

  delete: async (id) => {
    try {
      const pool = await connect();

      // Não permitir exclusão do usuário master (assumindo que o master tem id=1 ou tipo='master')
      const request1 = pool.request();
      request1.input('id', id);
      const userToCheck = await request1.query(`
        SELECT TipoUsuario FROM Usuarios WHERE Id = @id
      `);

      if (userToCheck.recordset.length > 0 && userToCheck.recordset[0].TipoUsuario === 'master') {
        throw new Error('Não é possível excluir o usuário master');
      }

      const request2 = pool.request();
      request2.input('id', id);
      const result = await request2.query(`
        UPDATE Usuarios
        SET Ativo = 0
        WHERE Id = @id
      `);

      return result.rowsAffected[0] > 0;
    } catch (error) {
      logger.error(`Erro ao desativar usuário: ${error.message}`);
      throw error;
    }
  }
};

module.exports = User;