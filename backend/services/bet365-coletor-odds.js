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

const DEBUG_PORT        = parseInt(process.env.BET365_ODDS_DEBUG_PORT) || 9222;
const COLETOR2_USUARIO  = process.env.BET365_COLETOR2_USUARIO  || '';
const COLETOR2_SENHA    = process.env.BET365_COLETOR2_SENHA    || '';
const COLETOR2_EMAIL    = process.env.BET365_COLETOR2_EMAIL    || '';
const COLETOR2_DATA_NASC = process.env.BET365_COLETOR2_DATA_NASC || '';
// true quando Coletor 2 tem porta/conta própria — sem dependência do Coletor 1
const MODO_AUTONOMO     = DEBUG_PORT !== 9222;
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

// ── Detecta erros fatais de sessão CDP ───────────────────────
function isFatalError(err) {
    const msg = err?.message || '';
    return msg.includes('Session closed') ||
           msg.includes('detached Frame') ||
           msg.includes('Target closed') ||
           (msg.includes('Protocol error') && (msg.includes('Session') || msg.includes('Target')));
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

// ── Login autônomo (usado apenas no MODO_AUTONOMO) ───────────
async function _verificarLoginColetor2(pg) {
    if (!COLETOR2_USUARIO || !COLETOR2_SENHA) {
        console.log('   ℹ️  [Odds] BET365_COLETOR2_USUARIO não configurado — assumindo sessão ativa');
        return;
    }
    const jaLogado = await pg.evaluate(() =>
        ![...document.querySelectorAll('button')].some(b =>
            ['Login', 'Log In'].includes((b.textContent || '').trim()))
    ).catch(() => false);

    if (jaLogado) { console.log('   ✅ [Odds] Sessão ativa — sem necessidade de login'); return; }

    console.log(`   🔐 [Odds] Fazendo login com ${COLETOR2_USUARIO}...`);

    // Abre modal de login se os campos ainda não estiverem visíveis
    let inputUser = await pg.$('input[type="text"]:not([type="hidden"])');
    if (!inputUser) {
        await pg.evaluate(() => {
            for (const btn of [...document.querySelectorAll('button, [role="button"]')]) {
                const txt = (btn.textContent || '').trim();
                if (txt === 'Login' || txt === 'Log In') { btn.click(); return; }
            }
        });
        await new Promise(r => setTimeout(r, 2500));
        inputUser = await pg.$('input[type="text"]:not([type="hidden"])');
    }

    if (!inputUser) { console.log('   ⚠️  [Odds] Campo usuário não encontrado — assumindo sessão ativa'); return; }

    await inputUser.click({ clickCount: 3 });
    await inputUser.type(COLETOR2_USUARIO, { delay: 60 });

    const inputPass = await pg.$('input[type="password"]');
    if (inputPass) {
        await inputPass.click({ clickCount: 3 });
        await inputPass.type(COLETOR2_SENHA, { delay: 60 });
    }

    // Submit
    const clicouSubmit = await pg.evaluate(() => {
        const sub = document.querySelector('input[type="submit"], button[type="submit"]');
        if (sub) { sub.click(); return true; }
        for (const btn of [...document.querySelectorAll('button, [role="button"]')]) {
            if (['Login', 'Log In'].includes((btn.textContent || '').trim())) { btn.click(); return true; }
        }
        return false;
    });
    if (!clicouSubmit) { console.log('   ❌ [Odds] Botão submit não encontrado'); return; }

    await new Promise(r => setTimeout(r, 5000));

    // Modal "Confirme seus dados" (e-mail + data de nascimento)
    const modalAberto = await pg.evaluate(() =>
        !!document.querySelector('.nui-ModalContainer select[aria-label="Dia"]') ||
        !!document.querySelector('select[aria-label="Dia"]')
    ).catch(() => false);

    if (modalAberto && COLETOR2_DATA_NASC && COLETOR2_EMAIL) {
        console.log('   🔒 [Odds] Modal "Confirme seus dados" — preenchendo...');
        const parts = COLETOR2_DATA_NASC.split(/[\/\-\.]/);
        if (parts.length >= 3) {
            await pg.evaluate((email, dia, mes, ano) => {
                const emailInput = document.querySelector('#email')
                    || document.querySelector('.nui-ModalContainer input[type="text"]')
                    || document.querySelector('input[placeholder*="e-mail" i]');
                if (emailInput) {
                    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                    if (setter) setter.call(emailInput, email); else emailInput.value = email;
                    emailInput.dispatchEvent(new Event('input',  { bubbles: true }));
                    emailInput.dispatchEvent(new Event('change', { bubbles: true }));
                }
                const setSelect = (sel, val) => {
                    if (!sel) return;
                    sel.value = val;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                };
                const selects = [...document.querySelectorAll('select')];
                setSelect(selects.find(s => ['Dia'].includes(s.getAttribute('aria-label') || '')), dia);
                setSelect(selects.find(s => ['Mês','Mes'].includes(s.getAttribute('aria-label') || '')), mes);
                setSelect(selects.find(s => ['Ano'].includes(s.getAttribute('aria-label') || '')), ano);
                const confirmBtn = document.querySelector('.nui-ModalContainer button[type="submit"]')
                    || [...document.querySelectorAll('button')].find(b =>
                        (b.textContent || '').trim().toLowerCase().includes('confirm'));
                if (confirmBtn) confirmBtn.click();
            }, COLETOR2_EMAIL, parts[0].padStart(2, '0'), parts[1].padStart(2, '0'), parts[2]);
            await new Promise(r => setTimeout(r, 4000));
        }
    }

    const ok = await pg.evaluate(() =>
        ![...document.querySelectorAll('button')].some(b =>
            (b.textContent || '').trim().includes('Faça Login para Assistir'))
    ).catch(() => true);
    console.log(ok ? '   ✅ [Odds] Login bem-sucedido!' : '   ⚠️  [Odds] Login pode ter falhado — verifique o Edge');
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

    // MODO_AUTONOMO: porta própria (ex: 9223), sem dependência do Coletor 1
    if (MODO_AUTONOMO) {
        const pages = await browser.pages();
        let pg = pages.find(p => { try { return p.url().includes('bet365') && p.url().includes('AVR'); } catch(_) { return false; } });
        if (!pg) {
            pg = pages.length > 0 ? pages[0] : await browser.newPage();
            await pg.bringToFront();
            await pg.evaluate(url => { location.href = url; }, URL_SOCCER);
            await new Promise(r => setTimeout(r, 15000));
            if (!pg.url().includes('AVR')) await new Promise(r => setTimeout(r, 10000));
        }
        await pg.bringToFront();
        console.log(`   ✅ [Odds] Aba pronta (porta ${DEBUG_PORT}): ${pg.url().substring(0, 60)}`);
        await _verificarLoginColetor2(pg);
        return { browser, pg };
    }

    // MODO_COMPARTILHADO (porta 9222): Coletor 1 usa a primeira aba AVR, Coletor 2 usa a última.
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
        await novaPg.bringToFront();
        await novaPg.goto(URL_SOCCER, { waitUntil: 'load', timeout: 60000 });
        await new Promise(r => setTimeout(r, 20000));

        // Verifica se SPA ficou na URL correta; se não, navega via JS (Bet365 às vezes redireciona)
        const urlApos = novaPg.url();
        if (!urlApos.includes('AVR')) {
            console.log(`   🔄 [Odds] URL pós-goto: ${urlApos.substring(0, 60)} — tentando via location.href...`);
            await novaPg.evaluate((url) => { location.href = url; }, URL_SOCCER);
            await new Promise(r => setTimeout(r, 15000));
        }

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

// ── Hard refresh + volta à liga (reutilizado entre jogos) ────
async function _refreshEVoltarLiga(pg, ligaNorm, nomeLigaOriginal) {
    const navP = pg.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await pg.evaluate(() => location.reload(true));
    await navP;
    await new Promise(r => setTimeout(r, 7000));
    const voltou = await pg.evaluate((nome) => {
        const btn = [...document.querySelectorAll('.vrl-MeetingsHeaderButton')].find(b =>
            b.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim() === nome
        );
        if (btn) { btn.click(); return true; }
        return false;
    }, nomeLigaOriginal).catch(() => false);
    if (!voltou) { console.log(`   ❌ [${ligaNorm}] Liga não encontrada após refresh`); return false; }
    await new Promise(r => setTimeout(r, 4000));
    try { await pg.waitForSelector('.vr-EventTimesNavBarButton', { timeout: 15000 }); }
    catch(_) { console.log(`   ❌ [${ligaNorm}] Nav não voltou após refresh`); return false; }
    return true;
}

// ── Itera TODOS os botões de horário e coleta odds de cada jogo ─
// Hard refresh antes de cada jogo (exceto o primeiro) — garante estado limpo.
async function lerTodasAsOdds(pg, ligaNorm, nomeLigaOriginal) {
    const resultados = [];

    const lerHorarios = () => pg.evaluate(() =>
        [...document.querySelectorAll('.vr-EventTimesNavBarButton')]
            .map(b => b.querySelector('.vr-EventTimesNavBarButton_Text')?.textContent.trim() || b.textContent.trim())
            .filter(Boolean)
    );

    const horarios = await lerHorarios();
    console.log(`   🕐 [${ligaNorm}] ${horarios.length} horário(s): ${horarios.join(' | ')}`);
    if (horarios.length === 0) return resultados;

    for (let idx = 0; idx < horarios.length; idx++) {
        const horarioAlvo = horarios[idx];
        try {
            // Hard refresh antes de cada jogo (exceto o primeiro)
            if (idx > 0) {
                let ok = await _refreshEVoltarLiga(pg, ligaNorm, nomeLigaOriginal);
                if (!ok) {
                    console.log(`   🔄 [${ligaNorm}] "${horarioAlvo}" — retry refresh...`);
                    await new Promise(r => setTimeout(r, 3000));
                    ok = await _refreshEVoltarLiga(pg, ligaNorm, nomeLigaOriginal);
                }
                if (!ok) {
                    console.log(`   ⏭️  [${ligaNorm}] "${horarioAlvo}" — nav falhou 2x, pulando jogo`);
                    continue;
                }
            }

            // Clica pelo texto do botão
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
                console.log(`   ⏭️  [${ligaNorm}] "${horarioAlvo}" — jogo já ao vivo (não encontrado após refresh)`);
                continue;
            }

            await randomDelay(1500, 3000);

            try {
                await pg.waitForSelector('.gl-MarketGroupPod.gl-MarketGroup', { timeout: 6000 });
            } catch(_) {
                await diagnosticarPagina(pg, ligaNorm, ` "${horarioAlvo}" sem pods:`);
                continue; // próximo jogo terá seu próprio refresh
            }

            const odds = await pg.evaluate(lerOddsDOM);
            if (odds.ok) {
                if (odds.horario && odds.horario !== horarioAlvo) {
                    console.log(`   ⏭️  [${ligaNorm}] "${horarioAlvo}" — horário exibido (${odds.horario}) diverge, pulando`);
                } else {
                    const icon  = odds.suspended ? '📌' : '💰';
                    const label = odds.suspended ? '[race-off]' : '[próximo]';
                    await salvarEvento(ligaNorm, odds.timeCasa, odds.timeFora,
                                       odds.horario, odds.oddCasa, odds.oddEmpate, odds.oddFora);
                    console.log(`   ${icon} [${ligaNorm}] ${odds.horario} ${normalizarNomeTime(odds.timeCasa)} × ${normalizarNomeTime(odds.timeFora)} ${label} | C:${odds.oddCasa} E:${odds.oddEmpate} F:${odds.oddFora}`);
                    resultados.push(odds);
                }
            } else {
                console.log(`   ⏭️  [${ligaNorm}] "${horarioAlvo}" — ${odds.motivo || JSON.stringify(odds)}`);
            }
        } catch(e) {
            if (isFatalError(e)) {
                console.warn(`   ⚠️  [Odds] Erro fatal no horário "${horarioAlvo}" — abortando liga: ${e.message}`);
                throw e;
            }
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
        if (isFatalError(err)) throw err;
        console.warn(`   ⚠️  [Odds] Refresh falhou: ${err.message}`);
        return false;
    }
}

// ── Hard refresh com até 3 tentativas (igual ao Coletor 1) ───
async function hardRefreshComRetry(pg) {
    for (let r = 1; r <= 3; r++) {
        try {
            const ok = await hardRefresh(pg);
            if (ok) return true;
        } catch(err) {
            if (isFatalError(err)) throw err;
        }
        console.log(`   ⚠️  [Odds] Refresh tentativa ${r}/3 falhou`);
    }
    return false;
}

// ── Reconecta ao Edge e obtém nova aba AVR ───────────────────
async function reconectarEdge(browserAtual, ligaCtx) {
    console.log(`   🔄 [${ligaCtx}] Sessão perdida — reconectando ao Edge...`);
    await browserAtual.disconnect().catch(() => {});
    const conn = await conectarEdge();
    console.log(`   ✅ [Odds] Reconectado`);
    return conn;
}

// ── Ciclo principal ──────────────────────────────────────────
async function ciclo(browser, pg) {
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
    const ligasParaRetry = [];
    let reconectou = false;

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
                console.log(`   ⏭️  [${ligaNorm}] Liga inativa | ${navOk} → retry ao final`);
                if (estadoApos.ligaAtiva === nomeLiga) ligasParaRetry.push({ nomeLiga, ligaNorm });
            } else {
                try {
                    await pg.waitForSelector(
                        '.gl-MarketGroupPod.gl-MarketGroup, .svc-MarketGroup_RaceOff, .svc-MarketGroup-eventstarted',
                        { timeout: 8000 }
                    );
                } catch(_) {
                    await diagnosticarPagina(pg, ligaNorm, ' pods não carregaram:');
                }

                const todasOdds = await lerTodasAsOdds(pg, ligaNorm, nomeLiga);
                if (todasOdds.length === 0) {
                    console.log(`   ⏭️  [${ligaNorm}] — sem odds disponíveis`);
                } else {
                    oddsOk += todasOdds.length;
                }
            }

        } catch(err) {
            if (isFatalError(err)) {
                if (reconectou) {
                    console.warn(`   ❌ [Odds] Sessão perdida novamente após reconexão — abortando ciclo`);
                    return { browser, pg, oddsOk };
                }
                try {
                    ({ browser, pg } = await reconectarEdge(browser, ligaNorm));
                    reconectou = true;
                    i--;  // retenta esta liga na próxima iteração
                } catch(e2) {
                    console.warn(`   ❌ [Odds] Reconexão falhou: ${e2.message} — abortando ciclo`);
                    return { browser, pg, oddsOk };
                }
                continue;
            }
            console.warn(`   ⚠️  [${ligaNorm}] Erro: ${err.message}`);
        }

        // Hard refresh após cada liga (exceto a última) — estado limpo antes da próxima aba
        if (i < ligasFiltradas.length - 1) {
            console.log(`   🔄 [Odds] Hard refresh pós-liga ${i + 1}/${ligasFiltradas.length}...`);
            try {
                await hardRefreshComRetry(pg);
            } catch(err) {
                if (isFatalError(err)) {
                    if (reconectou) {
                        console.warn(`   ❌ [Odds] Sessão perdida novamente após reconexão — abortando ciclo`);
                        return { browser, pg, oddsOk };
                    }
                    try {
                        ({ browser, pg } = await reconectarEdge(browser, 'Odds'));
                        reconectou = true;
                        console.log(`   ✅ [Odds] Reconectado — continuando com próxima liga`);
                    } catch(e2) {
                        console.warn(`   ❌ [Odds] Reconexão falhou: ${e2.message} — abortando ciclo`);
                        return { browser, pg, oddsOk };
                    }
                }
            }
        }
    }

    // Retry de ligas com 0 horários (Copa do Mundo é a mais afetada — está ao vivo quando o ciclo começa,
    // mas após ~3-4 min coletando as outras ligas, uma nova rodada já estará disponível)
    if (ligasParaRetry.length > 0) {
        console.log(`\n   🔁 [Odds] Retry: ${ligasParaRetry.map(l => l.ligaNorm).join(', ')} — aguardando nova rodada...`);
        try {
            await hardRefreshComRetry(pg);
        } catch(err) {
            if (isFatalError(err)) {
                if (reconectou) {
                    console.warn(`   ❌ [Odds] Sessão perdida no retry — abortando`);
                    console.log(`   ✅ [Odds] Ciclo concluído — odds: ${oddsOk}`);
                    return { browser, pg, oddsOk };
                }
                try {
                    ({ browser, pg } = await reconectarEdge(browser, 'Retry'));
                    reconectou = true;
                } catch(e2) {
                    console.warn(`   ❌ [Odds] Reconexão falhou: ${e2.message}`);
                    console.log(`   ✅ [Odds] Ciclo concluído — odds: ${oddsOk}`);
                    return { browser, pg, oddsOk };
                }
            }
        }

        for (const { nomeLiga, ligaNorm } of ligasParaRetry) {
            try {
                const clicou = await pg.evaluate((nome) => {
                    for (const tab of document.querySelectorAll('.vrl-MeetingsHeaderButton')) {
                        if (tab.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim() === nome) {
                            tab.click(); return true;
                        }
                    }
                    return false;
                }, nomeLiga);

                if (!clicou) { console.warn(`   ⚠️  [${ligaNorm}] Retry: aba não encontrada`); continue; }

                await randomDelay(2000, 4000);

                const est = await pg.evaluate(() => ({
                    timeBtns: document.querySelectorAll('.vr-EventTimesNavBarButton').length,
                    pods:     document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup').length,
                }));

                if (est.timeBtns === 0 && est.pods === 0) {
                    console.log(`   ⏭️  [${ligaNorm}] Retry: ainda sem horários`);
                    continue;
                }

                try {
                    await pg.waitForSelector(
                        '.gl-MarketGroupPod.gl-MarketGroup, .svc-MarketGroup_RaceOff',
                        { timeout: 8000 }
                    );
                } catch(_) {}

                const todasOdds = await lerTodasAsOdds(pg, ligaNorm, nomeLiga);
                if (todasOdds.length > 0) {
                    oddsOk += todasOdds.length;
                    console.log(`   ✅ [${ligaNorm}] Retry: ${todasOdds.length} jogo(s) coletado(s)`);
                } else {
                    console.log(`   ⏭️  [${ligaNorm}] Retry: sem odds disponíveis`);
                }
            } catch(err) {
                console.warn(`   ⚠️  [${ligaNorm}] Retry: Erro: ${err.message}`);
            }
        }
    }

    console.log(`   ✅ [Odds] Ciclo concluído — odds: ${oddsOk}`);
    return { browser, pg, oddsOk };
}

// ── Entry point ──────────────────────────────────────────────
async function run() {
    const agora = new Date().toLocaleTimeString('pt-BR');
    console.log(`\n============================================`);
    console.log(`🔄 [Odds] Iniciando coleta — ${agora}`);
    console.log(`============================================`);

    let browser = null, pg = null;
    const inicio = Date.now();
    // Aguarda intervalo aleatório para o Coletor 1 terminar qualquer refresh em andamento
    await randomDelay(8000, 14000);
    try {
        const conn = await conectarEdge();
        browser = conn.browser;
        pg      = conn.pg;
        const result = await ciclo(browser, pg);
        browser = result.browser;
    } catch(err) {
        console.error(`   ❌ [Odds] Erro: ${err.message}`);
    } finally {
        // Não fecha a aba — ela fica aberta para a próxima coleta reutilizar
        if (browser) await browser.disconnect().catch(() => {});
    }

    const duracaoS = Math.round((Date.now() - inicio) / 1000);
    console.log(`============================================`);
    console.log(`✅ [Odds] Ciclo concluído em ${duracaoS}s`);
    console.log(`============================================`);
}

async function main() {
    while (true) {
        await run().catch(e => console.error('❌ [Odds] Erro no ciclo:', e.message));
        console.log(`⏳ [Odds] Próximo ciclo em ${Math.round(INTERVALO_MS / 1000)}s...`);
        await new Promise(r => setTimeout(r, INTERVALO_MS));
    }
}

main();
