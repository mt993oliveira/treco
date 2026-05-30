require('dotenv').config();
const sql = require('mssql');
const cfg = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  port: parseInt(process.env.DB_PORT)||1433,
  options: { encrypt: false, trustServerCertificate: true }
};
sql.connect(cfg).then(async pool => {
  // Insere coletor2_minutos se não existir (vazio = desativado por enquanto)
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM bet365_config WHERE chave='coletor2_minutos')
      INSERT INTO bet365_config (chave, valor, tipo, grupo, descricao)
      VALUES ('coletor2_minutos','','text','sistema',
        '📊 Coletor 2: minutos da hora para disparar coleta, separados por vírgula (ex: 03,18,33,48)')
  `);
  console.log('coletor2_minutos inserido (vazio = aguardando configuração)');

  const r = await pool.request().query(`
    SELECT chave, valor, descricao FROM bet365_config
    WHERE chave IN ('coletor2_ativo','coletor2_minutos')
    ORDER BY chave`);
  console.log('\nConfig atual:');
  r.recordset.forEach(row => console.log(`  ${row.chave} = "${row.valor}"`));

  pool.close();
}).catch(e => console.error('DB ERROR:', e.message));
