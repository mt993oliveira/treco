/**
 * ============================================================
 * COLETOR 2 — ODDS PRÉ-JOGO + PRÓXIMOS JOGOS
 * ============================================================
 * Responsabilidade: capturar odds 1X2 (casa/empate/fora) do
 * mercado Fulltime Result ANTES do jogo começar e salvar em
 * bet365_eventos (campos odd_casa, odd_empate, odd_fora).
 *
 * Roda continuamente em ciclos automáticos (padrão: 90s).
 * Porta Edge: 9223 (conta separada do Coletor 1)
 *
 * Fluxo por ciclo:
 *   Hard refresh → para cada liga → clica na aba →
 *   lê odds do Fulltime Result → salva em bet365_eventos
 *
 * Não navega para Resultados — não interfere com o Coletor 1.
 *
 * PRÓXIMOS JOGOS: implementação futura via extra.bet365.bet.br
 * (código de referência documentado no bet365-coletor-historico.js)
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
const URL_SOCCER        = 'https://www.bet365.bet.br/#/AVR/B146/R%5E1/';
const LIGAS_IGNORAR     = ['super league'];
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

// ── Tenta ler nomes dos clubes da página (fallback sem mercado) ──
function _lerNomesEquipes() {
    // Tenta vários seletores onde os nomes podem aparecer na pré-visualização
    const seletores = [
        // Cabeçalho do evento / H2H
        ['.vr-HeadToHeadParticipantName_Name', 2],
        // Botões de participante no topo
        ['.vr-ParticipantName_Name', 2],
        // Área de detalhes do evento
        ['.vr-EventDetails_Participant', 2],
        // Qualquer texto de participante visível
        ['.vr-Participant_Name', 2],
    ];
    for (const [sel, min] of seletores) {
        const els = [...document.querySelectorAll(sel)].map(e => e.textContent.trim()).filter(Boolean);
        if (els.length >= min) return { timeCasa: els[0], timeFora: els[1] };
    }
    return { timeCasa: null, timeFora: null };
}

// ── Diagnóstico DOM (chamado uma vez por liga quando sem mercado) ─
async function diagnosticarPagina(pg, ligaNorm, horario) {
    const info = await pg.evaluate(() => {
        // Conta elementos chave para entender o estado da página
        return {
            pods:         document.querySelectorAll('.gl-MarketGroupPod').length,
            marketGroups: document.querySelectorAll('.gl-MarketGroup').length,
            glMarkets:    document.querySelectorAll('[class*="gl-Market"]').length,
            vrMarkets:    document.querySelectorAll('[class*="vr-Market"]').length,
            svcMarkets:   document.querySelectorAll('[class*="svc-Market"]').length,
            raceOff:      !!document.querySelector('.svc-MarketGroup_RaceOff'),
            // Primeiros textos de botões de mercado visíveis
            btnTextos:    [...document.querySelectorAll('[class*="MarketGroupButton_Text"],[class*="MarketGroup_Title"]')]
                              .slice(0, 6).map(e => e.textContent.trim()),
            // Classes dos containers principais
            containers:   [...new Set([...document.querySelectorAll('[class*="MarketGroup"]')]
                              .map(e => e.className.split(' ').find(c => c.includes('MarketGroup')) || ''))
                          ].slice(0, 10),
        };
    });
    console.log(`   🔬 [${ligaNorm}] ${horario} DOM: pods=${info.pods} groups=${info.marketGroups} gl=${info.glMarkets} vr=${info.vrMarkets} svc=${info.svcMarkets} raceOff=${info.raceOff}`);
    if (info.btnTextos.length) console.log(`      Botões mercado: ${info.btnTextos.join(' | ')}`);
    if (info.containers.length) console.log(`      Classes: ${info.containers.join(', ')}`);
}

// ── Lê odds pré-jogo da página principal ────────────────────
// Busca o pod "Fulltime Result" que NÃO está dentro do bloco race-off
// (jogo em andamento). O próximo jogo aparece na mesma página,
// num container separado, sem o elemento .svc-MarketGroup_RaceOff.
async function lerOddsPreJogo(pg) {
    return await pg.evaluate(() => {
        // Horário: pega o PRÓXIMO botão de hora (o que vem após o selecionado)
        const todosHorarios = [...document.querySelectorAll('.vr-EventTimesNavBarButton')];
        const selIdx = todosHorarios.findIndex(b => b.classList.contains('vr-EventTimesNavBarButton-selected')
            || b.querySelector('.vr-EventTimesNavBarButton_Text--selected')
            || b.classList.contains('selected'));
        const proximoBtn = todosHorarios[selIdx + 1] || todosHorarios[0];
        const horario = proximoBtn
            ? proximoBtn.querySelector('.vr-EventTimesNavBarButton_Text')?.textContent.trim() || proximoBtn.textContent.trim()
            : null;

        // Encontra TODOS os pods "Fulltime Result"
        const allPods = [...document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup')]
            .filter(p => {
                const txt = p.querySelector('.gl-MarketGroupButton_Text')?.textContent.trim();
                return txt === 'Fulltime Result' || txt === 'Resultado Final';
            });

        if (allPods.length === 0) {
            const nomes = _lerNomesEquipes();
            return { motivo: 'sem_mercado', ...nomes };
        }

        // Escolhe o pod que NÃO está dentro de um bloco com race-off
        // (race-off pertence ao jogo atual; o próximo jogo fica num bloco separado)
        let ftPod = null;
        for (const pod of allPods) {
            let el = pod.parentElement;
            let dentroRaceOff = false;
            for (let i = 0; i < 8; i++) {
                if (!el) break;
                if (el.querySelector(':scope > .svc-MarketGroup_RaceOff')) { dentroRaceOff = true; break; }
                el = el.parentElement;
            }
            if (!dentroRaceOff) { ftPod = pod; break; }
        }

        // Se todos os pods têm race-off → jogo em andamento sem próximo visível ainda
        if (!ftPod) {
            const nomes = _lerNomesEquipes();
            return { motivo: 'em_andamento', ...nomes };
        }

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

        function _lerNomesEquipes() {
            const seletores = [
                ['.vr-HeadToHeadParticipantName_Name', 2],
                ['.vr-ParticipantName_Name', 2],
                ['.vr-EventDetails_Participant', 2],
                ['.vr-Participant_Name', 2],
            ];
            for (const [sel, min] of seletores) {
                const els = [...document.querySelectorAll(sel)].map(e => e.textContent.trim()).filter(Boolean);
                if (els.length >= min) return { timeCasa: els[0], timeFora: els[1] };
            }
            return { timeCasa: null, timeFora: null };
        }
    });
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
    const MOTIVO_MSG = {
        sem_mercado:                 'sem mercado',
        em_andamento:                'em andamento',
        participantes_insuficientes: 'poucos participantes',
        odds_zeradas:                'odds zeradas',
    };

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
            // Clica na aba da liga
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
            await new Promise(r => setTimeout(r, DELAY_LIGA_MS));

            // Lê página padrão — NÃO clica em botões de horário
            // (botões futuros retornam página vazia; o próximo jogo já aparece na página padrão)
            const odds = await lerOddsPreJogo(pg);
            const clubes = (odds.timeCasa && odds.timeFora)
                ? ` ${normalizarNomeTime(odds.timeCasa)} × ${normalizarNomeTime(odds.timeFora)}`
                : '';
            if (odds.ok) {
                await salvarEvento(ligaNorm, odds.timeCasa, odds.timeFora,
                                   odds.horario, odds.oddCasa, odds.oddEmpate, odds.oddFora);
                console.log(`   💰 [${ligaNorm}] ${odds.horario}${clubes} | C:${odds.oddCasa} E:${odds.oddEmpate} F:${odds.oddFora}`);
                oddsOk++;
            } else {
                console.log(`   ⏭️  [${ligaNorm}]${clubes} — ${MOTIVO_MSG[odds.motivo] || odds.motivo}`);
                if (odds.motivo === 'sem_mercado') {
                    await diagnosticarPagina(pg, ligaNorm, '(default)');
                }
            }

        } catch(err) {
            console.warn(`   ⚠️  [${ligaNorm}] Erro: ${err.message}`);
        }

        // Hard refresh após cada liga (exceto a última — o próximo ciclo já faz no início)
        if (i < ligasFiltradas.length - 1) {
            console.log(`   🔄 Hard refresh antes da próxima liga...`);
            await hardRefresh(pg);
        }
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
