/**
 * ============================================================
 * COLETOR BET365 - BACKFILL HISTÓRICO (USO MANUAL)
 * ============================================================
 * Uso: recuperar resultados de um dia/hora específico quando
 * o sistema ficou fora do ar e há lacunas no banco de dados.
 *
 * Execução:
 *   node -r dotenv/config backend/services/bet365-coletor-historico.js
 *
 * Parâmetros (via variáveis de ambiente ou .env):
 *   BET365_HIST_DATA=2026-04-28        (padrão: ontem)
 *   BET365_HIST_HORA_INI=12:00         (opcional — filtra hora inicial)
 *   BET365_HIST_HORA_FIM=18:00         (opcional — filtra hora final)
 *   BET365_HIST_DEBUG_PORT=9223        (porta do Edge)
 *   BET365_HIST_LIGAS=World Cup,Euro Cup  (opcional — filtra ligas)
 *
 * PRÉ-REQUISITO:
 *   Edge aberto com a conta Bet365 logada na porta informada.
 *   Rode: node backend/services/bet365-coletor-historico.js
 * ============================================================
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const sql    = require('mssql');
const http   = require('http');
const dotenv = require('dotenv');
dotenv.config();

// ── Parâmetros ───────────────────────────────────────────────
const DEBUG_PORT = parseInt(process.env.BET365_HIST_DEBUG_PORT) || 9223;

function _ontemStr() {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

const DATA_ALVO    = process.env.BET365_HIST_DATA     || _ontemStr();
const HORA_INI     = process.env.BET365_HIST_HORA_INI || null;   // ex: '12:00'
const HORA_FIM     = process.env.BET365_HIST_HORA_FIM || null;   // ex: '18:00'
const LIGAS_FILTRO = process.env.BET365_HIST_LIGAS
    ? process.env.BET365_HIST_LIGAS.split(',').map(l => l.trim().toLowerCase())
    : null;

// ── Normalização ─────────────────────────────────────────────
const LIGA_NORMALIZAR = {
    'copa do mundo':               'World Cup',
    'world cup':                   'World Cup',
    'euro cup':                    'Euro Cup',
    'premiership':                 'Premiership',
    'premier league':              'Premiership',
    'express cup':                 'Express Cup',
    'south american super league': 'Super Liga Sul-Americana',
    'super liga sul-americana':    'Super Liga Sul-Americana',
};
function normalizarNomeLiga(nome) {
    return LIGA_NORMALIZAR[(nome || '').toLowerCase().trim()] || nome;
}

// IDs das competições no extra.bet365.bet.br
const LIGA_COMP = {
    'World Cup':                { compId: '20120650', compNome: 'Copa do Mundo' },
    'Euro Cup':                 { compId: '20700663', compNome: 'Euro Cup' },
    'Premiership':              { compId: '20120653', compNome: 'Premier League' },
    'Express Cup':              { compId: '20940364', compNome: 'Express Cup' },
    'Super Liga Sul-Americana': { compId: '20849528', compNome: 'Super Liga Sul-Americana' },
};

// ── Banco ────────────────────────────────────────────────────
const DB_CFG = {
    user:     process.env.DB_USER     || 'sa',
    password: process.env.DB_PASSWORD || 'kvb@4sJ2',
    server:   process.env.DB_SERVER   || '76.13.174.51',
    database: process.env.DB_NAME     || 'PRODUCAO',
    port:     1433,
    options:  { encrypt: false, trustServerCertificate: true },
    pool:     { max: 3, min: 0, idleTimeoutMillis: 30000 },
};
let pool = null;
async function getPool() {
    if (pool && pool.connected) return pool;
    pool = await sql.connect(DB_CFG);
    console.log('   ✅ [Hist] Banco conectado');
    return pool;
}

// ── Puppeteer: conecta ao Edge existente ─────────────────────
async function conectarEdge() {
    const wsUrl = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${DEBUG_PORT}/json/version`, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve(JSON.parse(d).webSocketDebuggerUrl); }
                catch(e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error(`timeout porta ${DEBUG_PORT}`)); });
    });
    const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null });
    const pages   = await browser.pages();
    const pg      = pages[0]; // qualquer aba serve — vamos navegar manualmente
    console.log(`   ✅ [Hist] Conectado ao Edge (porta ${DEBUG_PORT})`);
    return { browser, pg };
}

// ── Monta URL de resultados para uma liga/data ───────────────
function montarUrl(ligaNorm, dataStr) {
    const ligaInfo = LIGA_COMP[ligaNorm];
    if (!ligaInfo) return null;

    const [yyyy, mm, dd] = dataStr.split('-').map(Number);
    const MESES_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho',
                      'Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const displayDate = `${dd}-${dd}%20${MESES_PT[mm-1]}%20${yyyy}`;
    const dateStr     = dataStr;

    const b64 = s => Buffer.from(s).toString('base64');
    const qParams = [
        b64('2'), b64('146'), b64('Futebol%20Virtual'),
        b64(dateStr), b64(dateStr), b64('0'), b64('0'),
        b64(displayDate), b64('0'),
        b64(encodeURIComponent(ligaInfo.compNome)),
        b64(ligaInfo.compId), b64('0'), '',
        b64('result'),          // <-- 'result' para resultados passados
        b64('0'), b64('0'), b64('0'), b64('0'), b64('0'),
        '', b64('0'), b64('0'),
    ].join('|');

    return `https://extra.bet365.bet.br/results/br?q=${qParams}`;
}

// ── Extrai resultados da página de resultados ────────────────
// TODO: implementar quando for usar pela primeira vez
// Estrutura esperada (a confirmar inspecionando a página):
//   - cada jogo: button.point-result ou similar
//   - horário, time casa, time fora, placar
//   - mercados: Fulltime Result, etc.
async function extrairResultadosHistoricos(pg) {
    // TODO: raspar a página e retornar array de:
    // { horario, timeCasa, timeFora, golsCasa, golsFora, mercados: [{nome, selecao, odd}] }
    throw new Error('TODO: extrairResultadosHistoricos ainda não implementado');
}

// ── Salva resultado histórico no banco ───────────────────────
// TODO: confirmar schema e adaptar campos conforme necessário
async function salvarResultadoHistorico(liga, jogo) {
    // TODO: MERGE em bet365_eventos + INSERT em bet365_resultados_mercados
    throw new Error('TODO: salvarResultadoHistorico ainda não implementado');
}

// ── Filtra por hora (opcional) ───────────────────────────────
function dentroDoFiltroHora(horario) {
    if (!HORA_INI && !HORA_FIM) return true;
    const [h, m] = horario.split(':').map(Number);
    const mins = h * 60 + m;
    const ini  = HORA_INI ? (() => { const [a,b] = HORA_INI.split(':').map(Number); return a*60+b; })() : 0;
    const fim  = HORA_FIM ? (() => { const [a,b] = HORA_FIM.split(':').map(Number); return a*60+b; })() : 24*60;
    return mins >= ini && mins <= fim;
}

// ── Main ─────────────────────────────────────────────────────
async function run() {
    console.log('\n============================================');
    console.log('⏮️  COLETOR HISTÓRICO BET365 (BACKFILL)');
    console.log('============================================');
    console.log(`   📅 Data alvo:  ${DATA_ALVO}`);
    console.log(`   🕐 Hora ini:   ${HORA_INI || '(sem filtro)'}`);
    console.log(`   🕑 Hora fim:   ${HORA_FIM || '(sem filtro)'}`);
    console.log(`   🏆 Ligas:      ${LIGAS_FILTRO ? LIGAS_FILTRO.join(', ') : '(todas)'}`);
    console.log('============================================\n');

    const ligas = LIGAS_FILTRO
        ? Object.keys(LIGA_COMP).filter(l => LIGAS_FILTRO.includes(l.toLowerCase()))
        : Object.keys(LIGA_COMP);

    if (ligas.length === 0) {
        console.error('❌ Nenhuma liga válida encontrada. Verifique BET365_HIST_LIGAS.');
        process.exit(1);
    }

    // TODO: quando for implementar, descomentar abaixo e implementar as funções acima
    console.log('⚠️  Este coletor ainda não está implementado.');
    console.log('   Ligas que serão processadas quando implementado:');
    for (const liga of ligas) {
        const url = montarUrl(liga, DATA_ALVO);
        console.log(`   • ${liga}`);
        console.log(`     URL: ${url}`);
    }
    console.log('\n   Próximos passos para implementar:');
    console.log('   1. Confirmar seletores CSS na página de resultados do extra.bet365.bet.br');
    console.log('   2. Implementar extrairResultadosHistoricos()');
    console.log('   3. Implementar salvarResultadoHistorico()');
    console.log('   4. Testar com uma data recente');

    /*
    // ── Descomentar quando implementado ──
    const { browser, pg } = await conectarEdge();
    await getPool();

    let total = 0;
    for (const liga of ligas) {
        const url = montarUrl(liga, DATA_ALVO);
        if (!url) { console.warn(`   ⚠️  Liga sem mapeamento: ${liga}`); continue; }

        console.log(`\n🏆 [${liga}] Buscando resultados...`);
        await pg.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000));

        const jogos = await extrairResultadosHistoricos(pg);
        const filtrados = jogos.filter(j => dentroDoFiltroHora(j.horario));

        console.log(`   → ${jogos.length} jogos na página | ${filtrados.length} no filtro de hora`);
        for (const jogo of filtrados) {
            await salvarResultadoHistorico(liga, jogo);
            total++;
        }
    }

    console.log(`\n✅ Backfill concluído — ${total} jogos salvos`);
    await browser.disconnect();
    */

    process.exit(0);
}

run().catch(e => { console.error('❌ [Hist] Fatal:', e.message); process.exit(1); });
