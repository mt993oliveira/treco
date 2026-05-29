/**
 * ============================================================
 * COLETOR 2 — ODDS PRÉ-JOGO + PRÓXIMOS JOGOS
 * ============================================================
 * Responsabilidade: capturar odds 1X2 (casa/empate/fora) do
 * mercado Fulltime Result ANTES do jogo começar e salvar em
 * bet365_eventos (campos odd_casa, odd_empate, odd_fora).
 *
 * Roda continuamente em ciclos automáticos (padrão: 180s).
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
const INTERVALO_MS      = parseInt(process.env.BET365_ODDS_INTERVALO_MS)      || 180000;
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

// Mapeamento: nome normalizado → chave em bet365_config (igual ao Coletor 1)
const LIGA_CONFIG_KEY = {
    'World Cup':                'liga_world_cup',
    'Euro Cup':                 'liga_euro_cup',
    'Premiership':              'liga_premiership',
    'Express Cup':              'liga_express_cup',
    'Super Liga Sul-Americana': 'liga_super_liga',
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

// ── Delay aleatório (simula comportamento humano) ─────────────
function randomDelay(minMs, maxMs) {
    return new Promise(r => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));
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

    // Encontra abas AVR — Coletor 1 usa a primeira, Coletor 2 usa a última.
    // O iniciar-tudo.bat abre 2 abas AVR desde o início; se só houver 1, abre a segunda aqui.
    let pages = await browser.pages();
    let avrPages = pages.filter(p => {
        try { return p.url().includes('bet365') && p.url().includes('AVR'); }
        catch(_) { return false; }
    });

    if (avrPages.length < 2) {
        console.log(`   ℹ️  [Odds] Apenas ${avrPages.length} aba(s) AVR — abrindo segunda aba automaticamente...`);
        const novaPg = await browser.newPage();
        await novaPg.bringToFront(); // traz para frente ANTES do goto — Chromium throttla JS em aba de fundo
        await novaPg.goto(URL_SOCCER, { waitUntil: 'load', timeout: 60000 });
        // Aguarda a página renderizar (20s para a Bet365 SPA carregar completamente)
        await new Promise(r => setTimeout(r, 20000));
        // Re-verifica
        pages    = await browser.pages();
        avrPages = pages.filter(p => {
            try { return p.url().includes('bet365') && p.url().includes('AVR'); }
            catch(_) { return false; }
        });
        if (avrPages.length < 2) throw new Error(
            `Não foi possível abrir a segunda aba AVR — verifique se o login está ativo`
        );
        console.log('   ✅ [Odds] Segunda aba AVR aberta com sucesso');
    }

    const pg = avrPages[avrPages.length - 1];
    console.log(`   ✅ [Odds] Aba encontrada (porta ${DEBUG_PORT}): ${pg.url().substring(0, 60)}`);
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
async function lerTodasAsOdds(pg, ligaNorm) {
    const resultados = [];

    // Coleta os textos dos botões ANTES de qualquer clique
    // O DOM pode se reconstruir após cada clique — usar texto é mais robusto que índice
    const horarios = await pg.evaluate(() =>
        [...document.querySelectorAll('.vr-EventTimesNavBarButton')]
            .map(b => b.querySelector('.vr-EventTimesNavBarButton_Text')?.textContent.trim() || b.textContent.trim())
            .filter(Boolean)
    );
    console.log(`   🕐 [${ligaNorm}] ${horarios.length} horário(s): ${horarios.join(' | ')}`);
    if (horarios.length === 0) return resultados;

    for (const horarioAlvo of horarios) {
        try {
            // Clica pelo TEXTO do botão — não quebra quando o DOM se reorganiza
            const clicou = await pg.evaluate((texto) => {
                const btn = [...document.querySelectorAll('.vr-EventTimesNavBarButton')].find(b => {
                    const t = b.querySelector('.vr-EventTimesNavBarButton_Text')?.textContent.trim() || b.textContent.trim();
                    return t === texto;
                });
                if (!btn) return false;
                btn.scrollIntoView();
                btn.click();
                return true;
            }, horarioAlvo);

            if (!clicou) {
                console.log(`   ⏭️  [${ligaNorm}] "${horarioAlvo}" — botão sumiu do DOM (jogo já passou?)`);
                continue;
            }

            // Aguarda confirmação visual: botão selecionado ganha classe -selected (borda amarela)
            try {
                await pg.waitForFunction((texto) => {
                    const sel = document.querySelector('.vr-EventTimesNavBarButton-selected');
                    if (!sel) return false;
                    const t = sel.querySelector('.vr-EventTimesNavBarButton_Text')?.textContent.trim()
                              || sel.textContent.trim();
                    return t === texto;
                }, { timeout: 3000 }, horarioAlvo);
            } catch(_) {
                console.log(`   ⚠️  [${ligaNorm}] "${horarioAlvo}" — clique não confirmado (sem borda amarela), continuando mesmo assim`);
            }

            // Delay humano após clicar no horário — aleatório para não ser previsível
            await randomDelay(1500, 3200);

            try {
                await pg.waitForSelector('.gl-MarketGroupPod.gl-MarketGroup', { timeout: 6000 });
            } catch(_) {
                await diagnosticarPagina(pg, ligaNorm, ` "${horarioAlvo}" sem pods:`);
                try { await pg.waitForSelector('.vr-EventTimesNavBarButton', { timeout: 8000 }); }
                catch(_2) {
                    console.log(`   ❌ [${ligaNorm}] Nav desapareceu — abortando liga`);
                    break;
                }
                // Nav voltou — verificar se ainda estamos na liga correta
                const ligaAposFalha = await pg.evaluate(() =>
                    [...document.querySelectorAll('.vrl-MeetingsHeaderButton')]
                        .find(b => [...b.classList].some(c => c.toLowerCase().includes('select') || c.toLowerCase().includes('active')))
                        ?.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim() || ''
                ).catch(() => '');
                if (ligaAposFalha && ligaAposFalha !== nomeLiga) {
                    console.log(`   ❌ [${ligaNorm}] Liga mudou para "${ligaAposFalha}" — abortando`);
                    break;
                }
                continue;
            }
            await randomDelay(300, 700);

            const odds = await pg.evaluate(lerOddsDOM);
            if (odds.ok) {
                // Só salva se o horário exibido bate com o que foi clicado
                // Evita duplicatas quando o clique não registrou e a página mostra jogo anterior
                if (odds.horario && odds.horario !== horarioAlvo) {
                    console.log(`   ⏭️  [${ligaNorm}] "${horarioAlvo}" — horário exibido (${odds.horario}) diverge, pulando`);
                } else {
                    console.log(`   ✔️  [${ligaNorm}] "${horarioAlvo}" → ${odds.timeCasa} × ${odds.timeFora} C:${odds.oddCasa} E:${odds.oddEmpate} F:${odds.oddFora}`);
                    resultados.push(odds);
                }
            } else {
                console.log(`   ⏭️  [${ligaNorm}] "${horarioAlvo}" — ${odds.motivo || JSON.stringify(odds)}`);
            }
        } catch(e) {
            console.warn(`   ⚠️  [Odds] Erro no horário "${horarioAlvo}": ${e.message}`);
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
// Usa location.reload(true) via evaluate — idêntico ao Ctrl+F5 do browser,
// mesmo mecanismo que o Coletor 1 usa e que funciona com a SPA da Bet365.
async function hardRefresh(pg) {
    try {
        await pg.bringToFront();
        const navPromise = pg.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await pg.evaluate(() => location.reload(true));
        await navPromise;
        await new Promise(r => setTimeout(r, 8000));
        await pg.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: 20000 });
        return true;
    } catch(err) {
        console.warn(`   ⚠️  [Odds] Refresh falhou: ${err.message}`);
        return false;
    }
}

// ── Hard refresh com até 3 tentativas (igual ao Coletor 1) ───
async function hardRefreshComRetry(pg) {
    for (let r = 1; r <= 3; r++) {
        const ok = await hardRefresh(pg);
        if (ok) return true;
        console.log(`   ⚠️  [Odds] Refresh tentativa ${r}/3 falhou`);
    }
    return false;
}

// ── Ciclo principal ──────────────────────────────────────────
async function ciclo(pg) {
    await pg.bringToFront();

    // Verificação suave: garante que estamos na página correta
    // SEM Ctrl+F5 — hard refresh repetido é comportamento claramente não-humano
    const urlAtual = pg.url();
    if (!urlAtual.includes('bet365') || !urlAtual.includes('AVR')) {
        console.log('   🌐 [Odds] Navegando para página de virtual soccer...');
        await pg.goto(URL_SOCCER, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(2500, 4500);
    }

    // Verificação de sessão: detecta logout ou redirect para login
    const sessaoOk = await pg.evaluate(() => {
        const temLigas    = document.querySelectorAll('.vrl-MeetingsHeaderButton').length > 0;
        const semLoginBtn = !document.querySelector('[class*="hm-Login"], [class*="LoginButton"]');
        return temLigas || semLoginBtn;
    }).catch(() => false);
    if (!sessaoOk) {
        console.log('   ❌ [Odds] Sessão possivelmente expirada — tentando navegar para a página...');
        await pg.goto(URL_SOCCER, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(3000, 5000);
    }

    // Aguarda ligas aparecerem — tenta 10s, se não achar faz hard refresh e tenta mais 35s
    let _ligasVisiveis = false;
    try {
        await pg.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: 10000 });
        _ligasVisiveis = true;
    } catch(_) {}

    if (!_ligasVisiveis) {
        console.log('   🔄 [Odds] Ligas não carregaram — hard refresh e aguardando próximo ciclo...');
        await hardRefreshComRetry(pg);
        try {
            await pg.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: 35000 });
            _ligasVisiveis = true;
        } catch(_) {}
    }

    if (!_ligasVisiveis) {
        console.log('   ⚠️ [Odds] Ligas não encontradas após refresh — pulando ciclo');
        return { oddsOk: 0 };
    }

    // Pausa humana antes de começar (simula usuário "olhando" a tela)
    await randomDelay(800, 2000);

    const ligas = await pg.evaluate(() =>
        [...document.querySelectorAll('.vrl-MeetingsHeaderButton')]
            .map(el => el.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim() || '')
            .filter(Boolean)
    );

    // Lê config de ligas habilitadas no banco (⚙️ Configurações do Sistema → 🏆 Ligas)
    let cfgLigas = {};
    try {
        const db   = await getPool();
        const rows = await db.request().query(`SELECT chave, valor FROM bet365_config`);
        rows.recordset.forEach(r => { if (r.chave) cfgLigas[r.chave] = r.valor; });
    } catch(_) { /* se DB falhar, não bloqueia — assume todas ativas */ }

    const ligasFiltradas = ligas.filter(l => {
        if (LIGAS_IGNORAR.some(ig => l.toLowerCase().includes(ig))) return false;
        const norm = normalizarNomeLiga(l);
        const key  = LIGA_CONFIG_KEY[norm];
        return key ? cfgLigas[key] !== 'false' : true;
    });
    console.log(`   📋 [Odds] ${ligasFiltradas.length} liga(s): ${ligasFiltradas.join(' | ')}`);

    let oddsOk = 0;

    for (let i = 0; i < ligasFiltradas.length; i++) {
        const nomeLiga = ligasFiltradas[i];
        const ligaNorm = normalizarNomeLiga(nomeLiga);
        try {
            await pg.bringToFront();

            // Pausa humana antes de clicar na liga (simula hesitação/leitura)
            await randomDelay(600, 1800);

            const clicou = await pg.evaluate((nome) => {
                const tabs = document.querySelectorAll('.vrl-MeetingsHeaderButton');
                for (const tab of tabs) {
                    const txt = tab.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim();
                    if (txt === nome) { tab.click(); return true; }
                }
                return false;
            }, nomeLiga);

            if (!clicou) { console.warn(`   ⚠️  [${ligaNorm}] Aba não encontrada`); continue; }

            // Delay humano após clicar na liga (2-4s — simula carregar e olhar a página)
            await randomDelay(2000, 4000);

            const estadoApos = await pg.evaluate(() => {
                const ligaBtns = [...document.querySelectorAll('.vrl-MeetingsHeaderButton')];
                const ligaAtiva = ligaBtns.find(b => [...b.classList].some(c =>
                    c.toLowerCase().includes('select') || c.toLowerCase().includes('active') || c.toLowerCase().includes('current')
                ))?.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim() || '?';
                return {
                    timeBtns: document.querySelectorAll('.vr-EventTimesNavBarButton').length,
                    pods:     document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup').length,
                    ligaAtiva,
                };
            });

            // Verifica se a liga ativa corresponde à esperada — se não, tenta clicar mais uma vez
            if (estadoApos.ligaAtiva !== nomeLiga && estadoApos.ligaAtiva !== '?') {
                console.log(`   🔁 [${ligaNorm}] Liga ativa é "${estadoApos.ligaAtiva}" — reclicando...`);
                await pg.evaluate((nome) => {
                    const tabs = document.querySelectorAll('.vrl-MeetingsHeaderButton');
                    for (const tab of tabs) {
                        if (tab.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim() === nome) {
                            tab.click(); return true;
                        }
                    }
                    return false;
                }, nomeLiga);
                await randomDelay(2500, 4000);
                // Re-lê estado
                const re = await pg.evaluate(() => {
                    const ligaBtns = [...document.querySelectorAll('.vrl-MeetingsHeaderButton')];
                    const ligaAtiva = ligaBtns.find(b => [...b.classList].some(c =>
                        c.toLowerCase().includes('select') || c.toLowerCase().includes('active') || c.toLowerCase().includes('current')
                    ))?.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim() || '?';
                    return { timeBtns: document.querySelectorAll('.vr-EventTimesNavBarButton').length, ligaAtiva };
                });
                if (re.ligaAtiva !== nomeLiga) {
                    console.log(`   ⏭️  [${ligaNorm}] Não foi possível navegar para a liga — pulando`);
                    continue;
                }
                estadoApos.timeBtns = re.timeBtns;
                estadoApos.ligaAtiva = re.ligaAtiva;
            }

            // Se não achou botões, aguarda mais 8s — pode ser janela entre rodadas abrindo
            if (estadoApos.timeBtns === 0 && estadoApos.pods === 0) {
                try {
                    await pg.waitForSelector('.vr-EventTimesNavBarButton, .gl-MarketGroupPod.gl-MarketGroup', { timeout: 8000 });
                    const re2 = await pg.evaluate(() => ({
                        timeBtns: document.querySelectorAll('.vr-EventTimesNavBarButton').length,
                        pods:     document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup').length,
                    }));
                    estadoApos.timeBtns = re2.timeBtns;
                    estadoApos.pods     = re2.pods;
                } catch(_) {
                    await diagnosticarPagina(pg, ligaNorm, ' sem botões após espera:');
                }
            }

            if (estadoApos.timeBtns === 0 && estadoApos.pods === 0) {
                const navOk = estadoApos.ligaAtiva === nomeLiga ? '✅nav' : `❌nav(=${estadoApos.ligaAtiva})`;
                console.log(`   ⏭️  [${ligaNorm}] Liga inativa | ${navOk}`);
            } else {
                try {
                    await pg.waitForSelector(
                        '.gl-MarketGroupPod.gl-MarketGroup, .svc-MarketGroup_RaceOff, .svc-MarketGroup-eventstarted',
                        { timeout: 8000 }
                    );
                } catch(_) {
                    await diagnosticarPagina(pg, ligaNorm, ' pods não carregaram:');
                }

                const todasOdds = await lerTodasAsOdds(pg, ligaNorm);
                if (todasOdds.length === 0) {
                    console.log(`   ⏭️  [${ligaNorm}] — sem odds disponíveis`);
                } else {
                    for (const odds of todasOdds) {
                        await salvarEvento(ligaNorm, odds.timeCasa, odds.timeFora,
                                           odds.horario, odds.oddCasa, odds.oddEmpate, odds.oddFora);
                        const icon   = odds.suspended ? '📌' : '💰';
                        const label  = odds.suspended ? ' [race-off]' : ' [próximo]';
                        const clubes = ` ${normalizarNomeTime(odds.timeCasa)} × ${normalizarNomeTime(odds.timeFora)}`;
                        console.log(`   ${icon} [${ligaNorm}] ${odds.horario}${clubes}${label} | C:${odds.oddCasa} E:${odds.oddEmpate} F:${odds.oddFora}`);
                        oddsOk++;
                    }
                }
            }

        } catch(err) {
            console.warn(`   ⚠️  [${ligaNorm}] Erro: ${err.message}`);
        }

        // Hard refresh após cada liga (exceto a última) — estado limpo antes da próxima aba
        if (i < ligasFiltradas.length - 1) {
            console.log(`   🔄 [Odds] Hard refresh pós-liga ${i + 1}/${ligasFiltradas.length}...`);
            await hardRefreshComRetry(pg);
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
            // Verifica se coletor 2 está ativo nas configurações do sistema
            try {
                const db  = await getPool();
                const res = await db.request().query(`SELECT valor FROM bet365_config WHERE chave = 'coletor2_ativo'`);
                if (res.recordset[0]?.valor === 'false') {
                    console.log(`   ⏸️  [Odds] Coletor 2 pausado nas configurações do sistema — encerrando processo.`);
                    if (pg) { try { await pg.close(); } catch(_){} pg = null; }
                    process.exit(0);
                }
            } catch(e) {
                // DB indisponível — não tenta abrir aba, aguarda próximo ciclo
                console.log(`   ⚠️  [Odds] DB indisponível para verificar config (${e.message}) — aguardando...`);
                await new Promise(r => setTimeout(r, INTERVALO_MS));
                continue;
            }

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

        // Intervalo com jitter aleatório (INTERVALO_MS + até 60s extra)
        // Evita que o coletor tenha um "pulso" previsível e detectável
        const jitter = Math.floor(Math.random() * 60000);
        const espera = INTERVALO_MS + jitter;
        console.log(`   ⏳ [Odds] Próximo ciclo em ${Math.round(espera / 1000)}s`);
        await new Promise(r => setTimeout(r, espera));
    }
}

run().catch(e => { console.error('❌ [Odds] Fatal:', e.message); process.exit(1); });
