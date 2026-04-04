// migrations/004_create_audit_logs_table.js

const checkAndCreateAuditLogsTable = `
  IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='audit_logs' AND xtype='U')
  BEGIN
    CREATE TABLE audit_logs (
      id INT IDENTITY(1,1) PRIMARY KEY,
      user_id INT,
      action NVARCHAR(100) NOT NULL,
      resource NVARCHAR(255),
      details NVARCHAR(MAX),
      ip_address NVARCHAR(45),
      user_agent NVARCHAR(500),
      created_at DATETIME2 DEFAULT GETDATE(),
      FOREIGN KEY (user_id) REFERENCES Usuarios(Id) ON DELETE SET NULL
    );
    
    CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
    CREATE INDEX idx_audit_logs_action ON audit_logs(action);
    CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
    
    PRINT 'Tabela audit_logs criada com sucesso.';
  END
  ELSE
  BEGIN
    PRINT 'Tabela audit_logs já existe.';
  END;
`;

module.exports = {
  up: async (db) => {
    await db.query(checkAndCreateAuditLogsTable);
  },
  
  down: async (db) => {
    await db.query('DROP TABLE IF EXISTS audit_logs;');
    console.log('Tabela audit_logs removida.');
  }
};