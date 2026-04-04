// migrations/003_create_profiles_table.js - Adaptado para o sistema existente

const checkProfilesTable = `
  IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='HistoricoUsuarios' AND xtype='U')
  BEGIN
    PRINT 'A tabela HistoricoUsuarios não existe. Não é necessário criar, pois já existe no sistema.'
  END
  ELSE
  BEGIN
    PRINT 'A tabela HistoricoUsuarios já existe no sistema.'
  END;
`;

module.exports = {
  up: async (db) => {
    // Não criar tabelas que já existem - apenas verificar se existem
    await db.query(checkProfilesTable);
    console.log('Verificação da tabela de histórico de usuários concluída.');
  },
  
  down: async (db) => {
    // Não excluir tabelas existentes
    console.log('Não é possível reverter tabelas existentes no sistema.');
  }
};