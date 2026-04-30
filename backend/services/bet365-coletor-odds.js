/**
 * ============================================================
 * COLETOR BET365 - ODDS PRÉ-JOGO (EXPERIMENTAL)
 * ============================================================
 * Objetivo: capturar odds 1X2 (casa/empate/fora) do mercado
 * Fulltime Result ANTES do jogo começar e salvar em bet365_eventos.
 *
 * PRÉ-REQUISITO:
 *   Segundo Edge aberto via porta 9223 (abrir-edge-debug-odds.bat)
 *   com a página de futebol virtual carregada e login feito.
 *
 * IMPORTANTE: NÃO navega para resultados, NÃO faz F5.
 * Completamente independente do coletor principal (porta 9222).
 * ============================================================
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const sql    = require('mssql');
const http   = require('http');
const dotenv = require('dotenv');
dotenv.config();

const DEBUG_PORT  = parseInt(process.env.BET365_ODDS_DEBUG_PORT) || 9223;
const URL_SOCCER  = 'https://www.bet365.bet.br/#/AVR/B146/R%5E1/';
const LIGAS_IGNORAR = ['super league'];

// ── Normalização de nomes ────────────────────────────────────
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

const TIME_NORMALIZAR = {
    'man city': 'City', 'manchester city': 'City',
    'man utd': 'United', 'manchester utd': 'United', 'manchester united': 'United',
    'tottenham': 'Tottenham', 'spurs': 'Tottenham',
    'newcastle': 'Newcastle', 'newcastle utd': 'Newcastle',
};

function normalizarNomeTime(nome) {
    if (!nome) return nome;
    return TIME_NORMALIZAR[nome.toLowerCase().trim()] || nome;
}

// ── Hash / ID ────────────────────────────────────────────────
function _hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
}

function gerarId(liga, timeCasa, timeFora, horario) {
    const h = _hash(`${liga}|${timeCasa}|${timeFora}|${horario}`);
    return Number(BigInt(h) & BigInt('0x7FFFFFFFFFFFFFFF'));
}

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
    console.log('   ✅ [Odds] Banco conectado');
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
    const pg      = pages.find(p => { try { return p.url().includes('bet365'); } catch(_) { return false; } });

    if (!pg) throw new Error('Aba bet365 não encontrada na porta ' + DEBUG_PORT);
    console.log(`   ✅ [Odds] Conectado ao Edge (porta ${DEBUG_PORT}) | URL: ${pg.url().substring(0, 60)}`);
    return { browser, pg };
}

// ── Extrai odds do mercado Fulltime Result ───────────────────
async function extrairOddsPreJogo(pg) {
    return await pg.evaluate(() => {
        const timeBtn  = document.querySelector('.vr-EventTimesNavBarButton-selected .vr-EventTimesNavBarButton_Text');
        const horario  = timeBtn ? timeBtn.textContent.trim() : null;

        const ftPod = [...document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup')]
            .find(p => {
                const txt = p.querySelector('.gl-MarketGroupButton_Text')?.textContent.trim();
                return txt === 'Fulltime Result' || txt === 'Resultado Final';
            });

        if (!ftPod) return { motivo: 'sem_mercado' };

        const raceOff = document.querySelector('.svc-MarketGroup_RaceOff');
        if (raceOff) return { motivo: 'em_andamento' };

        const participantes = [];
        for (const el of ftPod.querySelectorAll('.srb-ParticipantStackedBorderless')) {
            const nEl = el.querySelector('.srb-ParticipantStackedBorderless_Name');
            const oEl = el.querySelector('.srb-ParticipantStackedBorderless_Odds');
            participantes.push({
                nome: nEl ? nEl.textContent.trim() : '',
                odd:  oEl ? parseFloat(oEl.textContent.trim()) || 0 : 0,
            });
        }

        if (participantes.length < 3) return { motivo: 'participantes_insuficientes', qtd: participantes.length };

        const isEmpate = n => n === 'Draw' || n === 'Empate';
        const empIdx   = participantes.findIndex(p => isEmpate(p.nome));
        const times    = participantes.filter(p => !isEmpate(p.nome));

        const oddCasa   = times[0]?.odd  || 0;
        const oddEmpate = empIdx >= 0 ? participantes[empIdx].odd : 0;
        const oddFora   = times[1]?.odd  || 0;
        const timeCasa  = times[0]?.nome || null;
        const timeFora  = times[1]?.nome || null;

        if (!timeCasa || !timeFora || oddCasa <= 0 || oddEmpate <= 0 || oddFora <= 0)
            return { motivo: 'odds_zeradas' };

        return { horario, timeCasa, timeFora, oddCasa, oddEmpate, oddFora };
    });
}

// ── Salva evento com odds no banco ───────────────────────────
async function salvarOdds(liga, info) {
    const db       = await getPool();
    const tcNorm   = normalizarNomeTime(info.timeCasa);
    const tfNorm   = normalizarNomeTime(info.timeFora);
    const eventoId = gerarId(liga, tcNorm, tfNorm, info.horario || '');

    // Converte horario "HH:MM" → próxima ocorrência desse horário
    let startDt = new Date();
    if (info.horario && /^\d{1,2}:\d{2}$/.test(info.horario)) {
        const [hh, mm] = info.horario.split(':').map(Number);
        const now = new Date();
        startDt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0));
        if (startDt < now) startDt.setUTCDate(startDt.getUTCDate() + 1);
    }

    await db.request()
        .input('id',       sql.BigInt,       eventoId)
        .input('league',   sql.NVarChar(200), liga)
        .input('timeCasa', sql.NVarChar(100), tcNorm)
        .input('timeFora', sql.NVarChar(100), tfNorm)
        .input('startDt',  sql.DateTime2,     startDt)
        .input('oddCasa',  sql.Decimal(10,2), info.oddCasa)
        .input('oddEmp',   sql.Decimal(10,2), info.oddEmpate)
        .input('oddFora',  sql.Decimal(10,2), info.oddFora)
        .input('agora',    sql.DateTime2,     new Date())
        .query(`
            MERGE bet365_eventos AS t
            USING (SELECT @id AS id) AS s ON t.id = s.id
            WHEN MATCHED THEN UPDATE SET
                t.odd_casa=@oddCasa, t.odd_empate=@oddEmp, t.odd_fora=@oddFora,
                t.data_atualizacao=@agora
            WHEN NOT MATCHED THEN INSERT
                (id, url, league_name, time_casa, time_fora, status,
                 start_time_datetime, odd_casa, odd_empate, odd_fora,
                 data_coleta, data_atualizacao, ativo)
            VALUES (@id, '', @league, @timeCasa, @timeFora, 'AGENDADO',
                    @startDt, @oddCasa, @oddEmp, @oddFora,
                    @agora, @agora, 1);
        `);

    console.log(`   💰 [${liga}] ${tcNorm} × ${tfNorm} | C:${info.oddCasa} E:${info.oddEmpate} F:${info.oddFora}`);
}

// ── Ciclo principal ──────────────────────────────────────────
async function ciclo(pg) {
    // Hard refresh no início de cada ciclo — garante mercados atualizados
    try {
        await pg.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000));
        await pg.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: 15000 });
    } catch(err) {
        console.warn(`   ⚠️  [Odds] Reload falhou: ${err.message}`);
    }

    const ligas = await pg.evaluate(() =>
        [...document.querySelectorAll('.vrl-MeetingsHeaderButton')].map(el => {
            const t = el.querySelector('.vrl-MeetingsHeaderButton_Title');
            return t ? t.textContent.trim() : '';
        }).filter(Boolean)
    );

    const ligasFiltradas = ligas.filter(l =>
        !LIGAS_IGNORAR.some(ig => l.toLowerCase().includes(ig))
    );

    console.log(`   📋 [Odds] ${ligasFiltradas.length} liga(s): ${ligasFiltradas.join(' | ')}`);

    let capturadas = 0;
    for (const nomeLiga of ligasFiltradas) {
        try {
            const clicou = await pg.evaluate((nome) => {
                const tabs = document.querySelectorAll('.vrl-MeetingsHeaderButton');
                for (const tab of tabs) {
                    const txt = tab.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim();
                    if (txt === nome) { tab.click(); return true; }
                }
                return false;
            }, nomeLiga);

            if (!clicou) continue;

            await new Promise(r => setTimeout(r, 3500));

            const info = await extrairOddsPreJogo(pg);

            if (!info || info.motivo) {
                const msgs = {
                    sem_mercado:              'mercado não encontrado na página',
                    em_andamento:             'jogo em andamento (race off)',
                    participantes_insuficientes: `poucos participantes (${info?.qtd ?? 0})`,
                    odds_zeradas:             'odds zeradas',
                };
                console.log(`   ⏭️  [${normalizarNomeLiga(nomeLiga)}] ${msgs[info?.motivo] || 'sem odds'}`);
                continue;
            }

            await salvarOdds(normalizarNomeLiga(nomeLiga), info);
            capturadas++;
        } catch(err) {
            console.warn(`   ⚠️  [${nomeLiga}] Erro: ${err.message}`);
        }
    }

    return capturadas;
}

// ── Entry point ──────────────────────────────────────────────
async function run() {
    let browser = null;
    let pg      = null;
    let cicloNum = 0;

    const INTERVALO_MS = parseInt(process.env.BET365_ODDS_INTERVALO_MS) || 90000; // 90s default

    while (true) {
        cicloNum++;
        const agora = new Date().toLocaleTimeString('pt-BR');
        console.log(`\n============================================`);
        console.log(`🔄 [Odds] Ciclo #${cicloNum} - ${agora}`);
        console.log(`============================================`);

        try {
            if (!pg || pg.isClosed()) {
                const conn = await conectarEdge();
                browser = conn.browser;
                pg      = conn.pg;
            }

            const cap = await ciclo(pg);
            console.log(`   ✅ [Odds] ${cap} odds capturada(s) neste ciclo`);
        } catch(err) {
            console.error(`   ❌ [Odds] Erro no ciclo: ${err.message}`);
            pg = null; // força reconexão no próximo ciclo
        }

        await new Promise(r => setTimeout(r, INTERVALO_MS));
    }
}

run().catch(e => {
    console.error('❌ [Odds] Fatal:', e.message);
    process.exit(1);
});
