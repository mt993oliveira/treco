/**
 * ============================================================
 * COLETOR 2 — ODDS PRÉ-JOGO + PRÓXIMOS JOGOS
 * ============================================================
 * Responsabilidade: capturar odds 1X2 (casa/empate/fora) do
 * mercado Fulltime Result ANTES do jogo começar e salvar em
 * bet365_eventos (campos odd_casa, odd_empate, odd_fora).
 *
 * Roda continuamente em ciclos automáticos (padrão: 90s).
 * Porta Edge: 9222 (mesma do Coletor 1, aba separada — não interfere)
 *
 * Fluxo por ciclo:
 *   Hard refresh → para cada liga → clica na aba →
 *   itera TODOS os botões de horário → lê odds de cada jogo →
 *   salva próximos jogos + odds em bet365_eventos
 *
 * Não usa a aba do Coletor 1 — abre aba própria no mesmo browser.
 * ============================================================
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const sql    = require('mssql');
const http   = require('http');
const dotenv = require('dotenv');
dotenv.config();

const DEBUG_PORT   = parseInt(process.env.BET365_ODDS_DEBUG_PORT) || 9222;
const URL_SOCCER        = 'https://www.bet365.bet.br/#/AVR/B146/R%5E1/';
const LIGAS_IGNORAR     = [];
const INTERVALO_MS      = parseInt(process.env.BET365_ODDS_INTERVALO_MS)      || 90000;
const DELAY_HORARIO_MS  = parseInt(process.env.BET365_ODDS_DELAY_HORARIO_MS)  || 2000;
const DELAY_LIGA_MS     = parseInt(process.env.BET365_ODDS_DELAY_LIGA_MS)     || 2500;
const DELAY_REFRESH_MS  = parseInt(process.env.BET365_ODDS_DELAY_REFRESH_MS)  || 3500;

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

// ── Puppeteer: conecta ao Edge e abre aba própria ────────────
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
    const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null, protocolTimeout: 60000 });

    // Abre nova aba exclusiva — não usa nem interfere na aba do Coletor 1
    const pg = await browser.newPage();

    // Força aba a se comportar como sempre visível antes de qualquer navegação.
    // Bet365 SPA usa Page Visibility API e não renderiza em abas em segundo plano.
    await pg.evaluateOnNewDocument(() => {
        Object.defineProperty(document, 'hidden',          { get: () => false });
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
        document.addEventListener('visibilitychange', e => e.stopImmediatePropagation(), true);
    });

    await pg.bringToFront();
    await pg.goto(URL_SOCCER, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000));
    await pg.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: 30000 });

    console.log(`   ✅ [Odds] Nova aba aberta (porta ${DEBUG_PORT})`);
    return { browser, pg };
}


// ── Diagnóstico DOM ───────────────────────────────────────────
async function diagnosticarPagina(pg, ligaNorm, label) {
    const info = await pg.evaluate(() => {
        const ligaBtns = [...document.querySelectorAll('.vrl-MeetingsHeaderButton')];
        const ligaAtiva = ligaBtns.find(b => [...b.classList].some(c =>
            c.toLowerCase().includes('select') || c.toLowerCase().includes('active') || c.toLowerCase().includes('current')
        ))?.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim() || '?';
        return {
            pods:      document.querySelectorAll('.gl-MarketGroupPod').length,
            glMarkets: document.querySelectorAll('[class*="gl-Market"]').length,
            raceOff:   !!document.querySelector('.svc-MarketGroup_RaceOff'),
            timeBtns:  document.querySelectorAll('.vr-EventTimesNavBarButton').length,
            ligaAtiva,
            btnTextos: [...document.querySelectorAll('[class*="MarketGroupButton_Text"]')]
                           .slice(0, 4).map(e => e.textContent.trim()).filter(Boolean),
        };
    });
    console.log(`   🔬 [${ligaNorm}]${label} pods=${info.pods} gl=${info.glMarkets} timeBtns=${info.timeBtns} ligaAtiva="${info.ligaAtiva}" raceOff=${info.raceOff}`);
    if (info.btnTextos.length) console.log(`      Mercados: ${info.btnTextos.join(' | ')}`);
}

// ── Lê odds do pod Fulltime Result no DOM atual ───────────────
// Serializada e passada ao pg.evaluate() — deve ser auto-contida
function lerOddsDOM() {
    const allPods = [...document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup')]
        .filter(p => {
            const txt = p.querySelector('.gl-MarketGroupButton_Text')?.textContent.trim();
            return txt === 'Fulltime Result' || txt === 'Resultado Final';
        });
    if (allPods.length === 0) return { motivo: 'sem_mercado' };

    let ftPod = null, suspended = false;
    for (const pod of allPods) {
        const parts = [...pod.querySelectorAll('.srb-ParticipantStackedBorderless')];
        const allSusp = parts.length > 0 && parts.every(p => p.classList.contains('srb-ParticipantStackedBorderless_Suspended'));
        if (!allSusp) { ftPod = pod; suspended = false; break; }
        if (!ftPod)   { ftPod = pod; suspended = true; }
    }

    const selBtn = document.querySelector('.vr-EventTimesNavBarButton-selected');
    const horario = selBtn
        ? selBtn.querySelector('.vr-EventTimesNavBarButton_Text')?.textContent.trim() || selBtn.textContent.trim()
        : null;

    const participantes = [...ftPod.querySelectorAll('.srb-ParticipantStackedBorderless')].map(el => ({
        nome: el.querySelector('.srb-ParticipantStackedBorderless_Name')?.textContent.trim() || '',
        odd:  parseFloat(el.querySelector('.srb-ParticipantStackedBorderless_Odds')?.textContent.trim()) || 0,
    }));
    if (participantes.length < 3) return { motivo: 'participantes_insuficientes', qtd: participantes.length };

    const isEmpate = n => n === 'Draw' || n === 'Empate';
    const empIdx   = participantes.findIndex(p => isEmpate(p.nome));
    const times    = participantes.filter(p => !isEmpate(p.nome));
    const oddCasa   = times[0]?.odd || 0;
    const oddEmpate = empIdx >= 0 ? participantes[empIdx].odd : 0;
    const oddFora   = times[1]?.odd || 0;
    const timeCasa  = times[0]?.nome || null;
    const timeFora  = times[1]?.nome || null;

    if (!timeCasa || !timeFora || oddCasa <= 0 || oddEmpate <= 0 || oddFora <= 0)
        return { motivo: 'odds_zeradas', suspended };

    return { ok: true, suspended, horario, timeCasa, timeFora, oddCasa, oddEmpate, oddFora };
}

// ── Itera TODOS os botões de horário e coleta odds de cada jogo ─
async function lerTodasAsOdds(pg) {
    const resultados = [];

    const qtdBtns = await pg.evaluate(() =>
        document.querySelectorAll('.vr-EventTimesNavBarButton').length
    );
    if (qtdBtns === 0) return resultados;

    for (let idx = 0; idx < qtdBtns; idx++) {
        try {
            const clicou = await pg.evaluate((i) => {
                const btns = [...document.querySelectorAll('.vr-EventTimesNavBarButton')];
                if (!btns[i]) return false;
                btns[i].scrollIntoView();
                btns[i].click();
                return true;
            }, idx);
            if (!clicou) continue;

            await new Promise(r => setTimeout(r, DELAY_HORARIO_MS));
            try {
                await pg.waitForSelector('.gl-MarketGroupPod.gl-MarketGroup', { timeout: 5000 });
            } catch(_) { continue; }
            await new Promise(r => setTimeout(r, 300));

            const odds = await pg.evaluate(lerOddsDOM);
            if (odds.ok) resultados.push(odds);
        } catch(e) {
            console.warn(`   ⚠️  [Odds] Erro no horário ${idx}: ${e.message}`);
        }
    }

    return resultados;
}

// ── Salva evento no banco (MERGE) ────────────────────────────
async function salvarEvento(liga, timeCasa, timeFora, horario, oddCasa, oddEmpate, oddFora) {
    const db       = await getPool();
    const tcNorm   = normalizarNomeTime(timeCasa);
    const tfNorm   = normalizarNomeTime(timeFora);
    const eventoId = gerarId(liga, tcNorm, tfNorm, horario || '');

    let startDt = new Date();
    if (horario && /^\d{1,2}:\d{2}$/.test(horario)) {
        const [hh, mm] = horario.split(':').map(Number);
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
        .input('oddCasa',  sql.Decimal(10,2), oddCasa)
        .input('oddEmp',   sql.Decimal(10,2), oddEmpate)
        .input('oddFora',  sql.Decimal(10,2), oddFora)
        .input('agora',    sql.DateTime2,     new Date())
        .query(`
            MERGE bet365_eventos AS t
            USING (SELECT @id AS id) AS s ON t.id = s.id
            WHEN MATCHED THEN UPDATE SET
                t.odd_casa   = CASE WHEN @oddCasa > 0 THEN @oddCasa   ELSE t.odd_casa   END,
                t.odd_empate = CASE WHEN @oddEmp  > 0 THEN @oddEmp    ELSE t.odd_empate END,
                t.odd_fora   = CASE WHEN @oddFora > 0 THEN @oddFora   ELSE t.odd_fora   END,
                t.start_time_datetime = @startDt,
                t.data_atualizacao    = @agora,
                t.ativo               = 1
            WHEN NOT MATCHED THEN INSERT
                (id, url, league_name, time_casa, time_fora, status,
                 start_time_datetime, odd_casa, odd_empate, odd_fora,
                 data_coleta, data_atualizacao, ativo)
            VALUES (@id, '', @league, @timeCasa, @timeFora, 'AGENDADO',
                    @startDt, @oddCasa, @oddEmp, @oddFora,
                    @agora, @agora, 1);
        `);
}

// ── Hard refresh e aguarda ligas ────────────────────────────
async function hardRefresh(pg) {
    try {
        await pg.setCacheEnabled(false);
        await pg.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await pg.setCacheEnabled(true);
        await new Promise(r => setTimeout(r, DELAY_REFRESH_MS));
        await pg.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: 15000 });
        return true;
    } catch(err) {
        await pg.setCacheEnabled(true).catch(() => {});
        console.warn(`   ⚠️  [Odds] Refresh falhou: ${err.message}`);
        return false;
    }
}

// ── Ciclo principal ──────────────────────────────────────────
async function ciclo(pg) {
    // Hard refresh inicial — garante página limpa antes do ciclo
    await hardRefresh(pg);

    const ligas = await pg.evaluate(() =>
        [...document.querySelectorAll('.vrl-MeetingsHeaderButton')]
            .map(el => el.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim() || '')
            .filter(Boolean)
    );
    const ligasFiltradas = ligas.filter(l => !LIGAS_IGNORAR.some(ig => l.toLowerCase().includes(ig)));
    console.log(`   📋 [Odds] ${ligasFiltradas.length} liga(s): ${ligasFiltradas.join(' | ')}`);

    let oddsOk = 0;

    for (let i = 0; i < ligasFiltradas.length; i++) {
        const nomeLiga = ligasFiltradas[i];
        const ligaNorm = normalizarNomeLiga(nomeLiga);
        try {
            // Garante que a aba do browser está em foco (necessário para eventos de mouse reais)
            await pg.bringToFront();

            // Clique nativo via ElementHandle — dispara eventos reais de mouse (mousedown/up/click)
            // Busca o índice em uma única chamada evaluate (evita N round-trips ao browser)
            const tabIdx = await pg.evaluate((nome) => {
                const tabs = [...document.querySelectorAll('.vrl-MeetingsHeaderButton')];
                return tabs.findIndex(t =>
                    t.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim() === nome
                );
            }, nomeLiga);

            let clicou = false;
            if (tabIdx >= 0) {
                const tabs = await pg.$$('.vrl-MeetingsHeaderButton');
                if (tabs[tabIdx]) { await tabs[tabIdx].click(); clicou = true; }
            }

            if (!clicou) { console.warn(`   ⚠️  [${ligaNorm}] Aba não encontrada`); continue; }

            // Aguarda SPA carregar o conteúdo da liga após o clique
            await new Promise(r => setTimeout(r, 3000));

            // Verificação rápida: se não há botões de horário, a liga está inativa agora
            const estadoApos = await pg.evaluate(() => {
                const ligaBtns = [...document.querySelectorAll('.vrl-MeetingsHeaderButton')];
                const ligaAtiva = ligaBtns.find(b => [...b.classList].some(c =>
                    c.toLowerCase().includes('select') || c.toLowerCase().includes('active') || c.toLowerCase().includes('current')
                ))?.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim() || '?';
                return {
                    timeBtns: document.querySelectorAll('.vr-EventTimesNavBarButton').length,
                    pods: document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup').length,
                    ligaAtiva,
                };
            });
            if (estadoApos.timeBtns === 0 && estadoApos.pods === 0) {
                const navOk = estadoApos.ligaAtiva === nomeLiga ? '✅nav' : `❌nav(=${estadoApos.ligaAtiva})`;
                console.log(`   ⏭️  [${ligaNorm}] Liga inativa | ${navOk}`);
                continue;
            }

            // Tem jogos agendados — aguarda pods ou race-off carregarem
            try {
                await pg.waitForSelector(
                    '.gl-MarketGroupPod.gl-MarketGroup, .svc-MarketGroup_RaceOff, .svc-MarketGroup-eventstarted',
                    { timeout: 8000 }
                );
            } catch(_) {
                await diagnosticarPagina(pg, ligaNorm, ' pods não carregaram:');
                continue;
            }

            const todasOdds = await lerTodasAsOdds(pg);
            if (todasOdds.length === 0) {
                console.log(`   ⏭️  [${ligaNorm}] — sem odds disponíveis`);
            } else {
                for (const odds of todasOdds) {
                    await salvarEvento(ligaNorm, odds.timeCasa, odds.timeFora,
                                       odds.horario, odds.oddCasa, odds.oddEmpate, odds.oddFora);
                    // 💰 = próximo jogo | 📌 = race-off (jogo em andamento)
                    const icon   = odds.suspended ? '📌' : '💰';
                    const label  = odds.suspended ? ' [race-off]' : ' [próximo]';
                    const clubes = ` ${normalizarNomeTime(odds.timeCasa)} × ${normalizarNomeTime(odds.timeFora)}`;
                    console.log(`   ${icon} [${ligaNorm}] ${odds.horario}${clubes}${label} | C:${odds.oddCasa} E:${odds.oddEmpate} F:${odds.oddFora}`);
                    oddsOk++;
                }
            }

        } catch(err) {
            console.warn(`   ⚠️  [${ligaNorm}] Erro: ${err.message}`);
        }

        // Sem hard refresh entre ligas — o hard refresh causa estado inválido no SPA
        // impedindo que abas como Copa do Mundo carreguem seu conteúdo.
        // Navegação via click direto funciona como o usuário faz manualmente.
    }

    console.log(`   ✅ [Odds] Ciclo concluído — odds: ${oddsOk}`);
    return { oddsOk };
}

// ── Entry point ──────────────────────────────────────────────
async function run() {
    let browser = null, pg = null, cicloNum = 0;

    while (true) {
        cicloNum++;
        const agora = new Date().toLocaleTimeString('pt-BR');
        console.log(`\n============================================`);
        console.log(`🔄 [Odds] Ciclo #${cicloNum} - ${agora}`);
        console.log(`============================================`);

        try {
            // Verifica se coletor 2 está ativo nas configurações do sistema
            try {
                const db  = await getPool();
                const res = await db.request().query(`SELECT valor FROM bet365_config WHERE chave = 'coletor2_ativo'`);
                if (res.recordset[0]?.valor === 'false') {
                    console.log(`   ⏸️  [Odds] Coletor 2 pausado nas configurações do sistema.`);
                    await new Promise(r => setTimeout(r, INTERVALO_MS));
                    continue;
                }
            } catch(_) { /* DB indisponível — continua normalmente */ }

            if (!pg || pg.isClosed()) {
                if (pg && !pg.isClosed()) await pg.close().catch(() => {});
                const conn = await conectarEdge();
                browser = conn.browser;
                pg      = conn.pg;
            }
            await ciclo(pg);
        } catch(err) {
            console.error(`   ❌ [Odds] Erro no ciclo: ${err.message}`);
            if (pg && !pg.isClosed()) await pg.close().catch(() => {});
            pg = null;
        }

        await new Promise(r => setTimeout(r, INTERVALO_MS));
    }
}

run().catch(e => { console.error('❌ [Odds] Fatal:', e.message); process.exit(1); });
