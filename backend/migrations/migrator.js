// migrations/migrator.js - Sistema de migrations para o banco de dados

const { connect, sql } = require('../config/db');
const logger = require('../utils/logger');

// Importar todos os scripts de migration
const migrations = [
  require('./001_create_users_table'),
  require('./002_create_transactions_table'),
  require('./003_create_profiles_table'),
  require('./004_create_audit_logs_table')
];

// Função para executar migrations
const runMigrations = async (direction = 'up') => {
  try {
    logger.info(`Iniciando ${direction} migrations...`);
    
    const pool = await connect();
    
    // Criar tabela para rastrear migrations executadas
    await pool.query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='migrations' AND xtype='U')
      CREATE TABLE migrations (
        id INT IDENTITY(1,1) PRIMARY KEY,
        name NVARCHAR(255) NOT NULL,
        executed_at DATETIME2 DEFAULT GETDATE()
      );
    `);
    
    // Obter migrations já executadas
    const executedMigrations = await pool.query(`
      SELECT name FROM migrations ORDER BY id;
    `);
    
    const executedNames = executedMigrations.recordset.map(m => m.name);
    
    for (const migration of migrations) {
      const migrationName = migration.toString().split('(')[0].replace('function ', '');
      
      if (direction === 'up' && !executedNames.includes(migrationName)) {
        logger.info(`Executando migration: ${migrationName}`);
        await migration.up(pool);
        
        // Registrar migration como executada
        await pool.query(`
          INSERT INTO migrations (name) VALUES ('${migrationName}');
        `);
        
        logger.info(`Migration ${migrationName} executada com sucesso.`);
      } else if (direction === 'down' && executedNames.includes(migrationName)) {
        logger.info(`Revertendo migration: ${migrationName}`);
        await migration.down(pool);
        
        // Remover registro da migration
        await pool.query(`
          DELETE FROM migrations WHERE name = '${migrationName}';
        `);
        
        logger.info(`Migration ${migrationName} revertida com sucesso.`);
      }
    }
    
    logger.info(`${direction} migrations finalizadas.`);
  } catch (error) {
    logger.error(`Erro durante as migrations: ${error.message}`);
    throw error;
  }
};

// Executar migrations se este arquivo for chamado diretamente
if (require.main === module) {
  const direction = process.argv[2] === 'down' ? 'down' : 'up';
  
  runMigrations(direction)
    .then(() => {
      console.log(`${direction} migrations executadas com sucesso.`);
      process.exit(0);
    })
    .catch((error) => {
      console.error(`Erro ao executar migrations: ${error.message}`);
      process.exit(1);
    });
}

module.exports = {
  runMigrations
};