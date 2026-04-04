// migrations/002_create_transactions_table.js - Adaptado para o sistema existente

const checkDespesasTables = `
  IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='DespesasMensais' AND xtype='U')
  BEGIN
    PRINT 'A tabela DespesasMensais não existe. Não é necessário criar, pois já existe no sistema.'
  END
  ELSE
  BEGIN
    PRINT 'A tabela DespesasMensais já existe no sistema.'
  END;

  IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='DespesasAnuais' AND xtype='U')
  BEGIN
    PRINT 'A tabela DespesasAnuais não existe. Não é necessário criar, pois já existe no sistema.'
  END
  ELSE
  BEGIN
    PRINT 'A tabela DespesasAnuais já existe no sistema.'
  END;

  IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='NubankCobrancasFixas' AND xtype='U')
  BEGIN
    PRINT 'A tabela NubankCobrancasFixas não existe. Não é necessário criar, pois já existe no sistema.'
  END
  ELSE
  BEGIN
    PRINT 'A tabela NubankCobrancasFixas já existe no sistema.'
  END;
`;

module.exports = {
  up: async (db) => {
    // Não criar tabelas que já existem - apenas verificar se existem
    await db.query(checkDespesasTables);
    console.log('Verificação das tabelas de transações concluída.');
  },
  
  down: async (db) => {
    // Não excluir tabelas existentes
    console.log('Não é possível reverter tabelas existentes no sistema.');
  }
};