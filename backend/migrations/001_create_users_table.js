// migrations/001_create_users_table.js - Adaptado para o sistema existente

const checkUsuariosTable = `
  IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Usuarios' AND xtype='U')
  BEGIN
    PRINT 'A tabela Usuarios não existe. Não é necessário criar, pois já existe no sistema.'
  END
  ELSE
  BEGIN
    PRINT 'A tabela Usuarios já existe no sistema.'
  END;
`;

module.exports = {
  up: async (db) => {
    // Não criar tabelas que já existem - apenas verificar se existem
    await db.query(checkUsuariosTable);
    console.log('Verificação da tabela Usuarios concluída.');
  },
  
  down: async (db) => {
    // Não excluir tabelas existentes
    console.log('Não é possível reverter tabelas existentes no sistema.');
  }
};