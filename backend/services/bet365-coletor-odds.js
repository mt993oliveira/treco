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

// ── Lê odds pré-jogo ─────────────────────────────────────────
// Estratégia:
//   1) Verifica página atual — se tiver pod com odds NÃO suspensas, usa direto
//   2) Se odds suspensas (jogo em race-off), clica no próximo botão de horário
//      e aguarda os pods carregarem (waitForSelector, até 6s)
//   3) Lê odds do pod não suspenso
//
// NOTA: .svc-MarketGroup_RaceOff é IRMÃO dos pods, não ancestral.
// Indicador correto de jogo em andamento: _Suspended em TODOS os participantes.
async function lerOddsPreJogo(pg) {
    // Função DOM pura: lê pod "Resultado Final"
    // Prefere pod NÃO suspenso; se só tiver suspenso, usa mesmo assim (odds são válidas)
    const lerOddsDOM = () => {
        const allPods = [...document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup')]
            .filter(p => {
                const txt = p.querySelector('.gl-MarketGroupButton_Text')?.textContent.trim();
                return txt === 'Fulltime Result' || txt === 'Resultado Final';
            });
        if (allPods.length === 0) return { motivo: 'sem_mercado' };

        // Prefere pod não suspenso; cai no primeiro disponível se todos suspensos
        let ftPod = null, suspended = false;
        for (const pod of allPods) {
            const parts = [...pod.querySelectorAll('.srb-ParticipantStackedBorderless')];
            const allSusp = parts.length > 0 && parts.every(p => p.classList.contains('srb-ParticipantStackedBorderless_Suspended'));
            if (!allSusp) { ftPod = pod; suspended = false; break; }
            if (!ftPod)   { ftPod = pod; suspended = true; }
        }

        // Horário: botão selecionado
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
    };

    // 1ª tentativa: página atual
    let odds = await pg.evaluate(lerOddsDOM);
    if (odds.ok) return odds;

    // 2ª tentativa: clica no próximo botão de horário (o não selecionado imediatamente após o atual)
    const horarioClicado = await pg.evaluate(() => {
        const btns = [...document.querySelectorAll('.vr-EventTimesNavBarButton')];
        const selIdx = btns.findIndex(b =>
            b.classList.contains('vr-EventTimesNavBarButton-selected') ||
            b.querySelector('.vr-EventTimesNavBarButton_Text--selected') ||
            b.classList.contains('selected'));
        const proximo = selIdx >= 0 ? btns[selIdx + 1] : btns[0];
        if (!proximo) return null;
        const texto = proximo.querySelector('.vr-EventTimesNavBarButton_Text')?.textContent.trim()
            || proximo.textContent.trim();
        proximo.click();
        return texto;
    });

    if (!horarioClicado) return { motivo: 'sem_botao_proximo' };

    // Aguarda pods aparecerem (re-render da página ao mudar de horário)
    try {
        await pg.waitForSelector('.gl-MarketGroupPod.gl-MarketGroup', { timeout: 6000 });
    } catch(_) {
        return { motivo: 'sem_mercado', horario: horarioClicado };
    }
    await new Promise(r => setTimeout(r, 500));

    odds = await pg.evaluate(lerOddsDOM);
    return { ...odds, horario: horarioClicado };
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
            // Captura times atuais para detectar se esta liga tem o mesmo jogo (aviso de possível duplicata)
            const timesAntes = await pg.evaluate(() =>
                [...document.querySelectorAll('.srb-ParticipantStackedBorderless_Name')]
                    .slice(0, 2).map(n => n.textContent.trim()).join('|')
            );

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

            // Pausa para o re-render iniciar após o clique na aba
            await new Promise(r => setTimeout(r, 800));

            // Aguarda pods ou race-off — timeout 15s (SPA pode demorar após hard refresh)
            try {
                await pg.waitForSelector(
                    '.gl-MarketGroupPod.gl-MarketGroup, .svc-MarketGroup_RaceOff, .svc-MarketGroup-eventstarted',
                    { timeout: 15000 }
                );
            } catch(_) {
                // Diagnóstico: mostra se o tab ficou ativo e quantos timeBtns existem
                await diagnosticarPagina(pg, ligaNorm, ' sem jogo/timeout:');
                continue;
            }

            const odds = await lerOddsPreJogo(pg);
            const clubes = (odds.timeCasa && odds.timeFora)
                ? ` ${normalizarNomeTime(odds.timeCasa)} × ${normalizarNomeTime(odds.timeFora)}`
                : '';
            if (odds.ok) {
                await salvarEvento(ligaNorm, odds.timeCasa, odds.timeFora,
                                   odds.horario, odds.oddCasa, odds.oddEmpate, odds.oddFora);
                // 💰 = odds frescas (próximo jogo) | 📌 = race-off (jogo já iniciado, odds salvas como referência)
                const icon = odds.suspended ? '📌' : '💰';
                const label = odds.suspended ? ' [race-off]' : ' [próximo]';
                console.log(`   ${icon} [${ligaNorm}] ${odds.horario}${clubes}${label} | C:${odds.oddCasa} E:${odds.oddEmpate} F:${odds.oddFora}`);
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

        // Hard refresh após cada liga (exceto a última) — reseta o estado do SPA
        // para garantir que a próxima liga carregue corretamente ao clicar na aba
        if (i < ligasFiltradas.length - 1) {
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
