/**
 * Cria índices essenciais na tabela bet365_resultados_mercados.
 * Rodar uma única vez: node criar-indices.js
 */
require('dotenv').config();
const sql = require('mssql');

const cfg = {
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server:   process.env.DB_SERVER || '127.0.0.1',
    database: process.env.DB_NAME   || 'PRODUCAO',
    port:     parseInt(process.env.DB_PORT) || 1433,
    options:  { encrypt: false, trustServerCertificate: true }
};

const INDICES = [
    {
        nome: 'IX_b365_liga_data',
        sql:  'CREATE INDEX IX_b365_liga_data ON bet365_resultados_mercados(liga, data_partida DESC)'
    },
    {
        nome: 'IX_b365_evento',
        sql:  'CREATE INDEX IX_b365_evento ON bet365_resultados_mercados(evento_id)'
    },
    {
        nome: 'IX_b365_liga_evento',
        sql:  'CREATE INDEX IX_b365_liga_evento ON bet365_resultados_mercados(liga, evento_id)'
    },
    {
        nome: 'IX_b365_mercado',
        sql:  'CREATE INDEX IX_b365_mercado ON bet365_resultados_mercados(mercado)'
    },
];

(async () => {
    console.log('Conectando ao banco...');
    await sql.connect(cfg);
    console.log('✅ Conectado.\n');

    for (const idx of INDICES) {
        process.stdout.write(`Criando ${idx.nome}... `);
        try {
            await sql.query(`
                IF NOT EXISTS (
                    SELECT 1 FROM sys.indexes
                    WHERE object_id = OBJECT_ID('bet365_resultados_mercados')
                      AND name = '${idx.nome}'
                )
                    EXEC('${idx.sql}')
            `);
            console.log('✅ OK');
        } catch (e) {
            console.log(`❌ Erro: ${e.message}`);
        }
    }

    console.log('\nPronto. Reinicie o servidor: pm2 restart radardabet --update-env');
    await sql.close();
})();
