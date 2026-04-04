/**
 * ============================================
 * AGENDADOR BETANO - FUTEBOL VIRTUAL
 * Coleta a cada 2 minutos com proteção anti-overlap
 * ============================================
 */

const cron = require('node-cron');
const BetanoColetor = require('./services/betano-coletor');

const INTERVALO_MIN = parseInt(process.env.BETANO_INTERVALO) || 1;
const ATIVO = process.env.BETANO_AGENDADOR_ATIVADO !== 'false';

if (!ATIVO) {
    console.log('⏸️ Agendador desativado (BETANO_AGENDADOR_ATIVADO=false)');
    process.exit(0);
}

const coletor = new BetanoColetor();

const expressao = INTERVALO_MIN === 1
    ? '* * * * *'
    : `*/${INTERVALO_MIN} * * * *`;

console.log('============================================');
console.log('🚀 AGENDADOR BETANO - FUTEBOL VIRTUAL');
console.log(`📅 Intervalo: ${INTERVALO_MIN} minuto(s)`);
console.log(`⏰ Cron: ${expressao}`);
console.log('============================================\n');

async function executarColeta() {
    const agora = new Date().toLocaleTimeString('pt-BR');
    console.log(`\n[${agora}] 🔄 Iniciando coleta...`);

    const result = await coletor.coletar();

    if (result.success) {
        console.log(`[${agora}] ✅ ${result.count} eventos | ${result.mercados} mercados | ${result.odds} odds | ${result.duracao}`);
    } else if (result.error === 'overlap') {
        console.log(`[${agora}] ⏳ Ignorado — coleta anterior ainda rodando`);
    } else {
        console.log(`[${agora}] ⚠️ Falhou: ${result.error}`);
    }
}

// Coleta inicial imediata
console.log('🚀 Coleta inicial...\n');
executarColeta().then(() => {
    console.log('\n📡 Agendador ativo\n');
});

// Agendar coletas periódicas
cron.schedule(expressao, executarColeta);

// Encerramento gracioso
process.on('SIGINT', async () => {
    console.log('\n\n🛑 Encerrando agendador...');
    await coletor.fechar();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await coletor.fechar();
    process.exit(0);
});
