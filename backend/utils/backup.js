/**
 * ============================================
 * BACKUP AUTOMÁTICO: Protege dados Betano
 * Cria backup das tabelas antes de qualquer operação crítica
 * ============================================
 */

const sql = require('mssql');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

async function criarBackup() {
    console.log('=== BACKUP AUTOMÁTICO BETANO ===\n');

    const pool = await sql.connect({
        user:     process.env.DB_USER     || 'sa',
        password: process.env.DB_PASSWORD,
        server:   process.env.DB_SERVER   || '127.0.0.1',
        database: process.env.DB_NAME     || 'PRODUCAO',
        port:     parseInt(process.env.DB_PORT) || 1433,
        options: {
            encrypt: process.env.DB_ENCRYPT === 'true',
            trustServerCertificate: process.env.DB_TRUST_CERT !== 'false'
        }
    });

    // Cria pasta de backups
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
        console.log(`📁 Pasta de backups criada: ${backupDir}`);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const backupFile = path.join(backupDir, `backup-betano-${timestamp}.json`);

    const backup = {
        timestamp: new Date().toISOString(),
        tabelas: {}
    };

    // Tabelas para backup
    const tabelas = [
        'betano_eventos',
        'betano_historico_partidas',
        'betano_mercados',
        'betano_odds',
        'betano_log_coleta',
        'betano_estatisticas_tempo_real',
        'betano_historico_odds'
    ];

    console.log('📊 Criando backup das tabelas...\n');

    for (const tabela of tabelas) {
        try {
            // Verifica se a tabela existe
            const existe = await pool.request()
                .input('tabela', sql.NVarChar(100), tabela)
                .query(`
                    SELECT COUNT(*) as total 
                    FROM INFORMATION_SCHEMA.TABLES 
                    WHERE TABLE_NAME = @tabela
                `);

            if (existe.recordset[0].total === 0) {
                console.log(`   ⚠️ Tabela ${tabela} não existe - pulando`);
                continue;
            }

            // Conta registros
            const countResult = await pool.request()
                .query(`SELECT COUNT(*) as total FROM ${tabela}`);
            const total = countResult.recordset[0].total;

            console.log(`   📦 ${tabela}: ${total} registros`);

            // Backup apenas das últimas N linhas para não ficar muito grande
            let dados;
            if (tabela === 'betano_historico_partidas') {
                // Tabelas de histórico - backup completo
                dados = await pool.request().query(`SELECT * FROM ${tabela} ORDER BY data_partida DESC, data_registro DESC`);
            } else if (tabela === 'betano_log_coleta') {
                // Log de coleta - ordena por data_inicio
                dados = await pool.request().query(`SELECT * FROM ${tabela} ORDER BY data_inicio DESC`);
            } else if (tabela === 'betano_estatisticas_tempo_real' || tabela === 'betano_historico_odds') {
                // Tabelas muito grandes - apenas últimas 1000 linhas
                dados = await pool.request().query(`SELECT TOP 1000 * FROM ${tabela} ORDER BY data_coleta DESC`);
            } else {
                // Demais tabelas - últimas 500 linhas
                dados = await pool.request().query(`SELECT TOP 500 * FROM ${tabela} ORDER BY data_coleta DESC`);
            }

            backup.tabelas[tabela] = {
                total_registros: total,
                dados: dados.recordset
            };

            console.log(`   ✅ ${tabela} backupada`);
        } catch (err) {
            console.log(`   ❌ Erro ao backupar ${tabela}: ${err.message}`);
        }
    }

    // Salva arquivo JSON
    fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
    const tamanho = (fs.statSync(backupFile).size / 1024 / 1024).toFixed(2);
    
    console.log(`\n💾 Backup salvo: ${backupFile}`);
    console.log(`📊 Tamanho: ${tamanho} MB`);

    // Limpa backups antigos (mantém últimos 10)
    const arquivos = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('backup-betano-') && f.endsWith('.json'))
        .sort()
        .reverse();

    if (arquivos.length > 10) {
        console.log(`\n🗑️ Limpando backups antigos...`);
        for (const arquivo of arquivos.slice(10)) {
            const caminho = path.join(backupDir, arquivo);
            fs.unlinkSync(caminho);
            console.log(`   🗑️ Removido: ${arquivo}`);
        }
    }

    await pool.close();
    console.log('\n✅ Backup concluído com sucesso!');
    
    return backupFile;
}

// Exporta para uso em outros módulos
module.exports = { criarBackup };

// Executa se chamado diretamente
if (require.main === module) {
    criarBackup().catch(console.error);
}
