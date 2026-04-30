/**
 * ============================================================
 * COLETOR BET365 - ODDS + PRÓXIMOS JOGOS (EXPERIMENTAL)
 * ============================================================
 * Roda em segundo Edge (porta 9223) — independente do principal.
 * Por ciclo, para cada liga:
 *   1. Lê odds pré-jogo do Fulltime Result (página principal)
 *   2. Busca próximos fixtures via URL de resultados
 *   3. Salva tudo em bet365_eventos (MERGE)
 *
 * Não navega para Resultados — não interfere com coletor principal.
 * ============================================================
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const sql    = require('mssql');
const http   = require('http');
const dotenv = require('dotenv');
dotenv.config();

const DEBUG_PORT   = parseInt(process.env.BET365_ODDS_DEBUG_PORT) || 9223;
const URL_SOCCER   = 'https://www.bet365.bet.br/#/AVR/B146/R%5E1/';
const LIGAS_IGNORAR = ['super league'];
const MAX_PROXIMOS  = parseInt(process.env.BET365_ODDS_MAX_PROXIMOS) || 4;
const INTERVALO_MS  = parseInt(process.env.BET365_ODDS_INTERVALO_MS) || 90000;

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

// URLs para coleta de fixtures por liga
const LIGA_RESULTADOS_URL = {
    'World Cup':                { compId: '20120650', compNome: 'Copa do Mundo' },
    'Euro Cup':                 { compId: '20700663', compNome: 'Euro Cup' },
    'Premiership':              { compId: '20120653', compNome: 'Premier League' },
    'Express Cup':              { compId: '20940364', compNome: 'Express Cup' },
    'Super Liga Sul-Americana': { compId: '20849528', compNome: 'Super Liga Sul-Americana' },
};

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
    console.log(`   ✅ [Odds] Conectado (porta ${DEBUG_PORT}) | ${pg.url().substring(0, 60)}`);
    return { browser, pg };
}

// ── Lê odds pré-jogo da página principal ────────────────────
async function lerOddsPreJogo(pg) {
    return await pg.evaluate(() => {
        const timeBtn = document.querySelector('.vr-EventTimesNavBarButton-selected .vr-EventTimesNavBarButton_Text');
        const horario = timeBtn ? timeBtn.textContent.trim() : null;

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

        return { ok: true, horario, timeCasa, timeFora, oddCasa, oddEmpate, oddFora };
    });
}

// ── Busca próximos fixtures via URL externa ──────────────────
async function buscarProximosFixtures(pg, ligaNorm) {
    const ligaInfo = LIGA_RESULTADOS_URL[ligaNorm];
    if (!ligaInfo) return [];

    const nowBST  = new Date(Date.now() + 3600000);
    const yyyy    = nowBST.getUTCFullYear();
    const mm      = nowBST.getUTCMonth();
    const dd      = nowBST.getUTCDate();
    const dateStr = `${yyyy}-${String(mm+1).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
    const MESES_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho',
                      'Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const displayDate = `${dd}-${dd}%20${MESES_PT[mm]}%20${yyyy}`;

    const b64 = s => Buffer.from(s).toString('base64');
    const qParams = [
        b64('2'), b64('146'), b64('Futebol%20Virtual'),
        b64(dateStr), b64(dateStr), b64('0'), b64('0'),
        b64(displayDate), b64('0'),
        b64(encodeURIComponent(ligaInfo.compNome)),
        b64(ligaInfo.compId), b64('0'), '',
        b64('fixture'),
        b64('0'), b64('0'), b64('0'), b64('0'), b64('0'),
        '', b64('0'), b64('0'),
    ].join('|');
    const url = `https://extra.bet365.bet.br/results/br?q=${qParams}`;

    const horaAtualBST = nowBST.getUTCHours();
    const minAtualBST  = nowBST.getUTCMinutes();

    let novaPg = null;
    try {
        novaPg = await pg.browser().newPage();
        await novaPg.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        try { await novaPg.waitForSelector('button.point-result__fixture', { timeout: 10000 }); } catch(_) {}
        await new Promise(r => setTimeout(r, 1000));

        const { futuros, total } = await novaPg.evaluate((h, m, maxN) => {
            const buttons = document.querySelectorAll('button.point-result__fixture');
            const futuros = [];
            for (const btn of buttons) {
                const parts = btn.querySelectorAll('.point-result__fixture-participant');
                if (parts.length < 2) continue;
                const p1    = parts[0].textContent.trim();
                const match = p1.match(/^(\d{1,2})\.(\d{2})\s+(.+)$/);
                if (!match) continue;
                const jH = parseInt(match[1]);
                const jM = parseInt(match[2]);
                const nowMins = h * 60 + m;
                const jMins   = jH * 60 + jM;
                if (jMins > nowMins && jMins <= nowMins + 6) {
                    futuros.push({
                        horario:  `${jH}:${String(jM).padStart(2,'0')}`,
                        timeCasa: match[3].trim(),
                        timeFora: parts[1].textContent.trim(),
                    });
                    if (futuros.length >= maxN) break;
                }
            }
            return { futuros, total: buttons.length };
        }, horaAtualBST, minAtualBST, MAX_PROXIMOS);

        console.log(`   📅 [${ligaNorm}] Fixtures: ${total} encontrados | ${futuros.length} próximos`);
        if (futuros.length > 0)
            console.log(`      → ${futuros.map(f => `${f.horario} ${f.timeCasa} x ${f.timeFora}`).join(' | ')}`);

        return futuros;
    } catch(err) {
        console.warn(`   ⚠️  [${ligaNorm}] Erro fixtures: ${err.message}`);
        return [];
    } finally {
        if (novaPg) await novaPg.close().catch(() => {});
    }
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
            WHEN MATCHED AND (@oddCasa > 0 OR @oddEmp > 0 OR @oddFora > 0) THEN UPDATE SET
                t.odd_casa=@oddCasa, t.odd_empate=@oddEmp, t.odd_fora=@oddFora,
                t.start_time_datetime=@startDt, t.data_atualizacao=@agora, t.ativo=1
            WHEN MATCHED THEN UPDATE SET
                t.start_time_datetime=@startDt, t.data_atualizacao=@agora, t.ativo=1
            WHEN NOT MATCHED THEN INSERT
                (id, url, league_name, time_casa, time_fora, status,
                 start_time_datetime, odd_casa, odd_empate, odd_fora,
                 data_coleta, data_atualizacao, ativo)
            VALUES (@id, '', @league, @timeCasa, @timeFora, 'AGENDADO',
                    @startDt, @oddCasa, @oddEmp, @oddFora,
                    @agora, @agora, 1);
        `);
}

// ── Ciclo principal ──────────────────────────────────────────
async function ciclo(pg) {
    // Reload para garantir mercados atualizados
    try {
        await pg.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000));
        await pg.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: 15000 });
    } catch(err) {
        console.warn(`   ⚠️  [Odds] Reload falhou: ${err.message}`);
    }

    const ligas = await pg.evaluate(() =>
        [...document.querySelectorAll('.vrl-MeetingsHeaderButton')]
            .map(el => el.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim() || '')
            .filter(Boolean)
    );
    const ligasFiltradas = ligas.filter(l => !LIGAS_IGNORAR.some(ig => l.toLowerCase().includes(ig)));
    console.log(`   📋 [Odds] ${ligasFiltradas.length} liga(s): ${ligasFiltradas.join(' | ')}`);

    const MOTIVO_MSG = {
        sem_mercado:               'mercado não encontrado',
        em_andamento:              'jogo em andamento',
        participantes_insuficientes: 'poucos participantes',
        odds_zeradas:              'odds zeradas',
    };

    let oddsOk = 0, proximosOk = 0;

    for (const nomeLiga of ligasFiltradas) {
        const ligaNorm = normalizarNomeLiga(nomeLiga);
        try {
            // ── 1. Clica na aba e lê odds pré-jogo ──────────────
            const clicou = await pg.evaluate((nome) => {
                const tabs = document.querySelectorAll('.vrl-MeetingsHeaderButton');
                for (const tab of tabs) {
                    if (tab.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim() === nome) {
                        tab.click(); return true;
                    }
                }
                return false;
            }, nomeLiga);

            if (!clicou) { console.warn(`   ⚠️  [${ligaNorm}] Aba não encontrada`); continue; }
            await new Promise(r => setTimeout(r, 3500));

            const odds = await lerOddsPreJogo(pg);
            if (odds.ok) {
                await salvarEvento(ligaNorm, odds.timeCasa, odds.timeFora, odds.horario,
                                   odds.oddCasa, odds.oddEmpate, odds.oddFora);
                console.log(`   💰 [${ligaNorm}] ${normalizarNomeTime(odds.timeCasa)} × ${normalizarNomeTime(odds.timeFora)} | C:${odds.oddCasa} E:${odds.oddEmpate} F:${odds.oddFora}`);
                oddsOk++;
            } else {
                console.log(`   ⏭️  [${ligaNorm}] Odds: ${MOTIVO_MSG[odds.motivo] || odds.motivo}`);
            }

            // ── 2. Busca próximos fixtures via URL ───────────────
            const futuros = await buscarProximosFixtures(pg, ligaNorm);
            for (const f of futuros) {
                await salvarEvento(ligaNorm, f.timeCasa, f.timeFora, f.horario, 0, 0, 0);
                proximosOk++;
            }

        } catch(err) {
            console.warn(`   ⚠️  [${ligaNorm}] Erro: ${err.message}`);
        }
    }

    console.log(`   ✅ [Odds] Ciclo concluído — odds: ${oddsOk} | próximos: ${proximosOk}`);
    return { oddsOk, proximosOk };
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
            if (!pg || pg.isClosed()) {
                const conn = await conectarEdge();
                browser = conn.browser;
                pg      = conn.pg;
            }
            await ciclo(pg);
        } catch(err) {
            console.error(`   ❌ [Odds] Erro no ciclo: ${err.message}`);
            pg = null;
        }

        await new Promise(r => setTimeout(r, INTERVALO_MS));
    }
}

run().catch(e => { console.error('❌ [Odds] Fatal:', e.message); process.exit(1); });
