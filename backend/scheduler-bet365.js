/**
 * ============================================
 * AGENDADOR BET365 - FUTEBOL VIRTUAL
 * Coleta a cada 1-2 minutos
 * ============================================
 */

const cron = require('node-cron');
const Bet365Coletor = require('./services/bet365-coletor');

const INTERVALO_MIN = parseInt(process.env.BET365_INTERVALO) || 1;
const ATIVO = process.env.BET365_AGENDADOR_ATIVADO !== 'false';

if (!ATIVO) {
    console.log('⏸️ Bet365 - Agendador desativado');
    process.exit(0);
}

const coletor = new Bet365Coletor();

const expressao = INTERVALO_MIN === 1
    ? '* * * * *'
    : `*/${INTERVALO_MIN} * * * *`;

console.log('============================================');
console.log('🚀 AGENDADOR BET365 - FUTEBOL VIRTUAL');
console.log(`📅 Intervalo: ${INTERVALO_MIN} minuto(s)`);
console.log(`⏰ Cron: ${expressao}`);
console.log('============================================\n');

async function executarColeta() {
    const agora = new Date().toLocaleTimeString('pt-BR');
    console.log(`\n[${agora}] 🔄 Bet365 - Iniciando coleta...`);
    await coletor.coletar();
}

// Coleta inicial imediata
console.log('🚀 Bet365 - Coleta inicial...\n');
executarColeta().then(() => {
    console.log('\n📡 Bet365 - Agendador ativo\n');
});

// Agendar coletas periódicas
cron.schedule(expressao, executarColeta);

// Encerramento gracioso
process.on('SIGINT', async () => {
    console.log('\n\n🛑 Bet365 - Encerrando agendador...');
    await coletor.encerrar();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await coletor.encerrar();
    process.exit(0);
});
