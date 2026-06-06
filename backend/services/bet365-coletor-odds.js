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

let _colsEnsured = false;
async function _ensureOddsColumns(pool) {
    if (_colsEnsured) return;
    const cols = [
        ['odd_over25',   'DECIMAL(10,2)'],
        ['odd_under25',  'DECIMAL(10,2)'],
        ['odd_btts_sim', 'DECIMAL(10,2)'],
        ['odd_btts_nao', 'DECIMAL(10,2)'],
        ['odd_ht_casa',  'DECIMAL(10,2)'],
        ['odd_ht_empate','DECIMAL(10,2)'],
        ['odd_ht_fora',  'DECIMAL(10,2)'],
    ];
    for (const [col, type] of cols) {
        await pool.request().query(`
            IF NOT EXISTS (
                SELECT 1 FROM sys.columns
                WHERE object_id = OBJECT_ID('bet365_eventos') AND name = '${col}'
            ) ALTER TABLE bet365_eventos ADD ${col} ${type} NULL
        `).catch(() => {});
    }
    _colsEnsured = true;
    console.log('   ✅ [Odds] Colunas de odds extras verificadas/criadas');
}

// ── Helpers de login (mesma lógica do Coletor 1) ────────────────────────────

async function _c2ClicarBotaoPorTexto(pg, texto, exato = false) {
    try {
        const handle = await pg.evaluateHandle((txt, ex) =>
            [...document.querySelectorAll('button')].find(b =>
                ex ? b.textContent.trim() === txt : b.textContent.trim().includes(txt)
            ) || null, texto, exato);
        const el = handle.asElement();
        if (!el) return false;
        await el.scrollIntoView();
        await el.hover();
        await el.click({ delay: 80 });
        return true;
    } catch { return false; }
}

async function _c2ClicarBotaoSubmitModal(pg) {
    try {
        const handle = await pg.evaluateHandle(() => {
            const dentroForm = [...document.querySelectorAll('form button, form [role="button"]')].find(el => {
                const t = (el.textContent || el.innerText || '').trim();
                return t === 'Login' || t === 'Log In';
            });
            if (dentroForm) return dentroForm;
            const submitBtn = [...document.querySelectorAll('button[type="submit"]')].find(el =>
                (el.textContent || '').trim().toLowerCase().includes('login')
            );
            if (submitBtn) return submitBtn;
            const todos = [...document.querySelectorAll('button, [role="button"]')].filter(el =>
                (el.textContent || el.innerText || '').trim() === 'Login'
            );
            return todos.length > 0 ? todos[todos.length - 1] : null;
        });
        const el = handle.asElement();
        if (!el) return false;
        await el.scrollIntoView();
        await el.hover();
        await el.click({ delay: 80 });
        return true;
    } catch { return false; }
}

async function _c2EncontrarFrameModal(pg) {
    for (const frame of pg.frames()) {
        try {
            const tem = await frame.evaluate(() =>
                !!document.querySelector('.nui-ModalContainer select[aria-label="Dia"]')
            );
            if (tem) return frame;
        } catch (_) {}
    }
    return null;
}

async function _c2PreencherConfirmacaoDados(pg, email, dataNasc) {
    try {
        if (!dataNasc) { console.log('   ⚠️  [Odds] BET365_COLETOR2_DATA_NASC não configurado'); return false; }
        const parts = dataNasc.split(/[\/\-\.]/);
        if (parts.length < 3) { console.log(`   ⚠️  [Odds] Formato inválido: ${dataNasc}`); return false; }
        const valDia = parts[0].padStart(2, '0');
        const valMes = parts[1].padStart(2, '0');
        const valAno = parts[2];

        const emailOk = await pg.evaluate((emailVal) => {
            const input = document.querySelector('#email')
                || document.querySelector('.nui-ModalContainer input[type="text"]')
                || document.querySelector('input[placeholder*="e-mail" i]');
            if (!input) return false;
            input.focus();
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(input, emailVal); else input.value = emailVal;
            input.dispatchEvent(new Event('input',  { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }, email);
        console.log(emailOk ? `   ✉️  [Odds] E-mail preenchido: ${email}` : '   ⚠️  [Odds] Campo e-mail não encontrado');
        await new Promise(r => setTimeout(r, 400));

        const dataOk = await pg.evaluate((dia, mes, ano) => {
            function set(sel, val) {
                if (!sel) return false;
                sel.value = val;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                sel.dispatchEvent(new Event('input',  { bubbles: true }));
                return sel.value === val;
            }
            const selDia = document.querySelector('select[aria-label="Dia"]');
            const selMes = document.querySelector('select[aria-label="Mês"]')
                || document.querySelector('select[aria-label="Mes"]');
            const selAno = document.querySelector('select[aria-label="Ano"]');
            return { dia: set(selDia, dia), mes: set(selMes, mes), ano: set(selAno, ano) };
        }, valDia, valMes, valAno);
        console.log(`   📅 [Odds] Data ${valDia}/${valMes}/${valAno} — dia:${dataOk.dia} mês:${dataOk.mes} ano:${dataOk.ano}`);
        await new Promise(r => setTimeout(r, 800));

        let clicou = false;
        try {
            clicou = await pg.evaluate(() => {
                const modal = document.querySelector('.nui-ModalContainer');
                if (!modal) return false;
                const btn = [...modal.querySelectorAll('button')].find(b =>
                    (b.textContent || '').trim() === 'Login'
                );
                if (!btn) return false;
                btn.click();
                return true;
            });
        } catch(eClick) {
            if (eClick.message.includes('detached') || eClick.message.includes('Target closed')) {
                console.log('   ✅ [Odds] Modal fechado após clique — login aceito');
                return true;
            }
            throw eClick;
        }
        if (!clicou) console.log('   ⚠️  [Odds] Botão Login não encontrado no modal');
        return clicou;
    } catch(e) {
        console.log('   ❌ [Odds] Erro em _c2PreencherConfirmacaoDados:', e.message);
        return false;
    }
}

async function _c2TentarLogin(pg) {
    if (!COLETOR2_USUARIO || !COLETOR2_SENHA) {
        console.log('   ⚠️  [Odds] Credenciais COLETOR2 não configuradas no .env');
        return false;
    }
    try {
        let inputUser = await pg.$('input[type="text"]:not([type="hidden"])');
        if (!inputUser) {
            const abrindoModal = await _c2ClicarBotaoPorTexto(pg, 'Login', true)
                || await _c2ClicarBotaoPorTexto(pg, 'Log In', true);
            if (abrindoModal) {
                await new Promise(r => setTimeout(r, 2500));
                inputUser = await pg.$('input[type="text"]:not([type="hidden"])');
            }
        }
        if (inputUser) {
            await inputUser.click({ clickCount: 3 });
            await inputUser.type(COLETOR2_USUARIO, { delay: 60 });
        }
        const inputPass = await pg.$('input[type="password"]');
        if (inputPass) {
            await inputPass.click({ clickCount: 3 });
            await inputPass.type(COLETOR2_SENHA, { delay: 60 });
        }
        const clicou = await _c2ClicarBotaoSubmitModal(pg)
            || await _c2ClicarBotaoPorTexto(pg, 'Login', true);
        if (!clicou) { console.log('   ❌ [Odds] Botão Login não encontrado'); return false; }

        await new Promise(r => setTimeout(r, 5000));

        // Modal "Confirme seus dados" (iframe separado)
        const frameModal = await _c2EncontrarFrameModal(pg);
        if (frameModal) {
            console.log('   🔒 [Odds] Modal "Confirme seus dados" detectado — preenchendo...');
            const preencheu = await _c2PreencherConfirmacaoDados(frameModal, COLETOR2_EMAIL || COLETOR2_USUARIO, COLETOR2_DATA_NASC);
            if (preencheu) {
                await new Promise(r => setTimeout(r, 6000));
                let sumiu = true;
                try { sumiu = await frameModal.evaluate(() =>
                    !document.querySelector('.nui-ModalContainer select[aria-label="Dia"]')
                ); } catch(_) { sumiu = true; }
                if (sumiu) { console.log('   ✅ [Odds] Modal confirmação resolvido!'); return true; }
            }
            console.log('   ⚠️  [Odds] Conta exige verificação (SMS/email) — login manual necessário');
            return 'verificacao';
        }

        // Verifica pedido de verificação genérica
        const pedindoVerif = await pg.evaluate(() => {
            const txt = (document.body?.innerText || '').toLowerCase();
            return txt.includes('verifica') || txt.includes('sms') || txt.includes('código de segurança');
        }).catch(() => false);
        if (pedindoVerif) {
            console.log('   ⚠️  [Odds] Conta exige verificação — login manual necessário');
            return 'verificacao';
        }

        const ok = await pg.evaluate(() =>
            ![...document.querySelectorAll('button')].some(b =>
                (b.textContent || '').trim().includes('Faça Login para Assistir'))
        ).catch(() => true);
        return ok;
    } catch(e) {
        console.log('   ❌ [Odds] Erro no login:', e.message);
        return false;
    }
}

// ── Verificação e recuperação de sessão ──────────────────────────────────────
let _ultimoLoginTs2 = 0;
const COOLDOWN_LOGIN2_MS = 5 * 60 * 1000;

async function _verificarLoginColetor2(pg) {
    try {
        await pg.bringToFront();

        // Detecta modal de confirmação em qualquer frame (pode aparecer antes do login)
        const frameModal = await _c2EncontrarFrameModal(pg);
        if (frameModal) {
            console.log('   🔒 [Odds] Modal "Confirme seus dados" detectado — preenchendo...');
            await _c2PreencherConfirmacaoDados(frameModal, COLETOR2_EMAIL || COLETOR2_USUARIO, COLETOR2_DATA_NASC);
            await new Promise(r => setTimeout(r, 6000));
        }

        const temAvisoVirtual = await pg.evaluate(() =>
            [...document.querySelectorAll('button')].some(b =>
                (b.textContent || '').trim().includes('Faça Login para Assistir'))
        ).catch(() => false);

        const temBotaoLogin = await pg.evaluate(() =>
            [...document.querySelectorAll('button, a, [role="button"]')].some(el => {
                const t = (el.textContent || el.innerText || '').trim();
                return t === 'Login' || t === 'Log In';
            })
        ).catch(() => false);

        if (!temAvisoVirtual && !temBotaoLogin) {
            console.log('   ✅ [Odds] Sessão ativa');
            return;
        }

        const motivo = temAvisoVirtual ? '"Faça Login para Assistir" detectado' : 'botão "Login" no cabeçalho';
        console.log(`   ⚠️  [Odds] Sessão expirada (${motivo}) — tentando login automático...`);

        // Anti-duplo-login: se já tentamos nos últimos 5 min, aguarda
        if (_ultimoLoginTs2 && (Date.now() - _ultimoLoginTs2) < COOLDOWN_LOGIN2_MS) {
            const s = Math.round((Date.now() - _ultimoLoginTs2) / 1000);
            console.log(`   ⏳ [Odds] Login em andamento ou aguardando cooldown (${s}s)`);
            return;
        }
        _ultimoLoginTs2 = Date.now();

        const resultado = await _c2TentarLogin(pg);
        if (resultado === true) {
            console.log('   ✅ [Odds] Login automático bem-sucedido!');
            _ultimoLoginTs2 = 0; // reseta cooldown após sucesso
            // Retorna à página AVR se necessário
            if (!pg.url().includes('AVR')) {
                await pg.goto(URL_SOCCER, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await new Promise(r => setTimeout(r, 4000));
            }
            return;
        }

        // Login automático não funcionou — aguarda login manual
        console.log('   ⚠️  [Odds] Login automático falhou ou exige verificação — aguardando login manual no Edge (porta 9223)...');
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 10000));
            const logouAgora = await pg.evaluate(() =>
                ![...document.querySelectorAll('button')].some(b =>
                    (b.textContent || '').trim().includes('Faça Login para Assistir'))
                && ![...document.querySelectorAll('button, a, [role="button"]')].some(el => {
                    const t = (el.textContent || el.innerText || '').trim();
                    return t === 'Login' || t === 'Log In';
                })
            ).catch(() => false);
            if (logouAgora) { console.log('   ✅ [Odds] Login detectado! Continuando...'); _ultimoLoginTs2 = 0; return; }
            console.log(`   ⏳ [Odds] Aguardando login manual... (${(i + 1) * 10}s)`);
        }
        console.log('   ❌ [Odds] Login não detectado após 5min — abortando ciclo');
        throw new Error('Sessão Coletor 2 expirada — login não realizado a tempo');
    } catch(e) {
        if (isFatalError(e) || e.message.includes('expirada')) throw e;
        console.warn('   ⚠️  [Odds] _verificarLoginColetor2:', e.message);
    }
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

// ── Lê odds de todos os pods relevantes no DOM atual ─────────
// Serializada e passada ao pg.evaluate() — deve ser auto-contida
function lerOddsDOM() {
    const allPods = [...document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup')];

    const podNames = allPods
        .map(p => (p.querySelector('.gl-MarketGroupButton_Text')?.textContent || '').trim())
        .filter(Boolean);

    function findPod(keys) {
        return allPods.find(p => {
            const txt = (p.querySelector('.gl-MarketGroupButton_Text')?.textContent || '').trim().toLowerCase();
            return keys.some(k => txt.includes(k));
        }) || null;
    }

    function readParts(pod) {
        if (!pod) return [];
        return [...pod.querySelectorAll('.srb-ParticipantStackedBorderless')].map(el => ({
            nome: (el.querySelector('.srb-ParticipantStackedBorderless_Name')?.textContent || '').trim(),
            odd:  parseFloat(el.querySelector('.srb-ParticipantStackedBorderless_Odds')?.textContent) || 0,
        }));
    }

    // ── Fulltime Result ───────────────────────────────────────
    const ftPodAll = allPods.filter(p => {
        const txt = (p.querySelector('.gl-MarketGroupButton_Text')?.textContent || '').trim();
        return txt === 'Fulltime Result' || txt === 'Resultado Final';
    });
    if (ftPodAll.length === 0) return { motivo: 'sem_mercado', podNames };

    let ftPod = null, suspended = false;
    for (const pod of ftPodAll) {
        const parts = [...pod.querySelectorAll('.srb-ParticipantStackedBorderless')];
        const allSusp = parts.length > 0 && parts.every(p => p.classList.contains('srb-ParticipantStackedBorderless_Suspended'));
        if (!allSusp) { ftPod = pod; suspended = false; break; }
        if (!ftPod)   { ftPod = pod; suspended = true; }
    }

    const selBtn = document.querySelector('.vr-EventTimesNavBarButton-selected');
    const horario = selBtn
        ? selBtn.querySelector('.vr-EventTimesNavBarButton_Text')?.textContent.trim() || selBtn.textContent.trim()
        : null;

    const ftParts = readParts(ftPod);
    if (ftParts.length < 3) return { motivo: 'participantes_insuficientes', qtd: ftParts.length, podNames };

    const isEmpate = n => n === 'Draw' || n === 'Empate';
    const empIdx   = ftParts.findIndex(p => isEmpate(p.nome));
    const times    = ftParts.filter(p => !isEmpate(p.nome));
    const oddCasa   = times[0]?.odd || 0;
    const oddEmpate = empIdx >= 0 ? ftParts[empIdx].odd : 0;
    const oddFora   = times[1]?.odd || 0;
    const timeCasa  = times[0]?.nome || null;
    const timeFora  = times[1]?.nome || null;

    if (!timeCasa || !timeFora || oddCasa <= 0 || oddEmpate <= 0 || oddFora <= 0)
        return { motivo: 'odds_zeradas', suspended, podNames };

    // ── Over/Under 2.5 ───────────────────────────────────────
    // PT: "Gols Mais/Menos" | EN: "Goals Over/Under"
    const ou25Pod   = findPod(['mais/menos', 'gols mais', 'over/under', 'goals over', 'gols acima', 'acima/abaixo']);
    const ou25Parts = readParts(ou25Pod);
    let oddOver25 = 0, oddUnder25 = 0;
    for (const p of ou25Parts) {
        const n = p.nome.toLowerCase();
        if      (n.includes('mais') || n.includes('over')  || n.includes('acima'))  oddOver25  = p.odd;
        else if (n.includes('menos') || n.includes('under') || n.includes('abaixo')) oddUnder25 = p.odd;
    }

    // ── Both Teams to Score (BTTS) ────────────────────────────
    // PT: "Para o Time Marcar - Sim/Não" | EN: "Both Teams to Score"
    const bttsPod   = findPod(['para o time marcar', 'time marcar', 'both teams', 'ambos marcam']);
    const bttsParts = readParts(bttsPod);
    let oddBttsSim = 0, oddBttsNao = 0;
    for (const p of bttsParts) {
        const n = p.nome.toLowerCase();
        if      (n === 'sim' || n === 'yes' || n.includes('sim') || n.includes('yes')) oddBttsSim = p.odd;
        else if (n === 'não' || n === 'nao' || n === 'no'  || n.includes('não'))       oddBttsNao = p.odd;
    }

    // ── Half-Time Result ─────────────────────────────────────
    // PT: "Intervalo - Resultado" | EN: "Half-Time Result"
    const htPod   = findPod(['intervalo - resultado', 'half-time', 'half time', 'ht result', 'resultado intervalo']);
    const htParts = readParts(htPod);
    let oddHtCasa = 0, oddHtEmpate = 0, oddHtFora = 0;
    if (htParts.length >= 3) {
        const htEmpIdx = htParts.findIndex(p => isEmpate(p.nome));
        const htTimes  = htParts.filter(p => !isEmpate(p.nome));
        oddHtCasa   = htTimes[0]?.odd || 0;
        oddHtEmpate = htEmpIdx >= 0 ? htParts[htEmpIdx].odd : 0;
        oddHtFora   = htTimes[1]?.odd || 0;
    }

    // Debug temporário: mostra os valores reais de nome/odd que readParts extraiu
    let debugPods = null;
    if (ou25Pod && oddOver25 === 0) {
        const partsInfo = ou25Parts.slice(0, 4).map(p => `nome="${p.nome}" odd=${p.odd}`).join(' | ');
        // Se parts vazio, mostra o HTML do primeiro elemento filho do pod
        let htmlSnip = '';
        if (ou25Parts.length === 0) {
            const body = ou25Pod.querySelector('[class*="Body"],[class*="Content"],[class*="MarketGroup_"]');
            const el = body || ou25Pod;
            htmlSnip = (el.innerHTML || '').replace(/\s+/g,' ').substring(0, 350);
        }
        debugPods = { count: ou25Parts.length, parts: partsInfo || '(vazio)', html: htmlSnip };
    }

    return {
        ok: true, suspended, horario, timeCasa, timeFora,
        oddCasa, oddEmpate, oddFora,
        oddOver25, oddUnder25,
        oddBttsSim, oddBttsNao,
        oddHtCasa, oddHtEmpate, oddHtFora,
        podNames, debugPods,
    };
}

// ── Expande pods colapsados antes de ler as odds ─────────────
// Bet365 renderiza apenas o Resultado Final expandido por padrão.
// OU, BTTS e HT ficam colapsados — precisamos clicar o header para ver participantes.
async function expandirPodsExtras(pg) {
    const KEYWORDS = ['mais/menos', 'gols mais', 'para o time marcar', 'time marcar', 'intervalo - resultado'];
    const expandiu = await pg.evaluate((keywords) => {
        const pods = [...document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup')];
        let count = 0;
        for (const pod of pods) {
            const txt = (pod.querySelector('.gl-MarketGroupButton_Text')?.textContent || '').trim().toLowerCase();
            if (!keywords.some(k => txt.includes(k))) continue;
            // Só clica se ainda não há participantes visíveis (evita fechar o que já está aberto)
            const temParticipantes = !!pod.querySelector('.srb-ParticipantStackedBorderless');
            if (!temParticipantes) {
                pod.querySelector('.gl-MarketGroupButton')?.click();
                count++;
            }
        }
        return count;
    }, KEYWORDS).catch(() => 0);
    if (expandiu > 0) await new Promise(r => setTimeout(r, 900));
}

// ── Hard refresh + volta à liga (reutilizado entre jogos) ────
async function _refreshEVoltarLiga(pg, ligaNorm, nomeLigaOriginal) {
    // pg.reload() é o caminho correto — pg.evaluate(location.reload) detacha o frame imediatamente
    await pg.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(e => {
        if (isFatalError(e)) throw e;
    });
    await new Promise(r => setTimeout(r, 7000));
    const voltou = await pg.evaluate((nome) => {
        const btn = [...document.querySelectorAll('.vrl-MeetingsHeaderButton')].find(b =>
            b.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim() === nome
        );
        if (btn) { btn.click(); return true; }
        return false;
    }, nomeLigaOriginal).catch(e => {
        if (isFatalError(e)) throw e;
        return false;
    });
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

            await expandirPodsExtras(pg);

            const odds = await pg.evaluate(lerOddsDOM);
            if (odds.ok) {
                if (odds.horario && odds.horario !== horarioAlvo) {
                    console.log(`   ⏭️  [${ligaNorm}] "${horarioAlvo}" — horário exibido (${odds.horario}) diverge, pulando`);
                } else {
                    const icon  = odds.suspended ? '📌' : '💰';
                    const label = odds.suspended ? '[race-off]' : '[próximo]';
                    await salvarEvento(ligaNorm, odds.timeCasa, odds.timeFora,
                                       odds.horario, odds.oddCasa, odds.oddEmpate, odds.oddFora, {
                        oddOver25:   odds.oddOver25   || 0,
                        oddUnder25:  odds.oddUnder25  || 0,
                        oddBttsSim:  odds.oddBttsSim  || 0,
                        oddBttsNao:  odds.oddBttsNao  || 0,
                        oddHtCasa:   odds.oddHtCasa   || 0,
                        oddHtEmpate: odds.oddHtEmpate || 0,
                        oddHtFora:   odds.oddHtFora   || 0,
                    });
                    const ou  = odds.oddOver25  ? ` | O2.5:${odds.oddOver25}/${odds.oddUnder25}` : '';
                    const bt  = odds.oddBttsSim ? ` | BTTS:${odds.oddBttsSim}/${odds.oddBttsNao}` : '';
                    const ht  = odds.oddHtCasa  ? ` | HT:${odds.oddHtCasa}/${odds.oddHtEmpate}/${odds.oddHtFora}` : '';
                    console.log(`   ${icon} [${ligaNorm}] ${odds.horario} ${normalizarNomeTime(odds.timeCasa)} × ${normalizarNomeTime(odds.timeFora)} ${label} | 1X2:${odds.oddCasa}/${odds.oddEmpate}/${odds.oddFora}${ou}${bt}${ht}`);
                    if (idx === 0 && odds.podNames && odds.podNames.length) {
                        console.log(`   📦 [${ligaNorm}] pods: ${odds.podNames.join(' | ')}`);
                    }
                    if (idx === 0 && odds.debugPods) {
                        console.log(`   🔍 [${ligaNorm}] OU parts(${odds.debugPods.count}): ${odds.debugPods.parts}`);
                        if (odds.debugPods.html) console.log(`   🔍 [${ligaNorm}] OU html: ${odds.debugPods.html}`);
                    }
                    resultados.push(odds);
                }
            } else {
                if (odds.podNames && odds.podNames.length && odds.motivo === 'sem_mercado') {
                    console.log(`   📦 [${ligaNorm}] pods disponíveis: ${odds.podNames.join(' | ')}`);
                }
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
// extra: { oddOver25, oddUnder25, oddBttsSim, oddBttsNao, oddHtCasa, oddHtEmpate, oddHtFora }
async function salvarEvento(liga, timeCasa, timeFora, horario, oddCasa, oddEmpate, oddFora, extra) {
    const db       = await getPool();
    await _ensureOddsColumns(db);
    const tcNorm   = normalizarNomeTime(timeCasa);
    const tfNorm   = normalizarNomeTime(timeFora);
    const eventoId = gerarId(liga, tcNorm, tfNorm, horario || '');
    const ex       = extra || {};

    let startDt = new Date();
    if (horario && /^\d{1,2}:\d{2}$/.test(horario)) {
        const [hh, mm] = horario.split(':').map(Number);
        const now = new Date();
        startDt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0));
        if (startDt < now) startDt.setUTCDate(startDt.getUTCDate() + 1);
    }

    await db.request()
        .input('id',         sql.BigInt,       eventoId)
        .input('league',     sql.NVarChar(200), liga)
        .input('timeCasa',   sql.NVarChar(100), tcNorm)
        .input('timeFora',   sql.NVarChar(100), tfNorm)
        .input('startDt',    sql.DateTime2,     startDt)
        .input('oddCasa',    sql.Decimal(10,2), oddCasa)
        .input('oddEmp',     sql.Decimal(10,2), oddEmpate)
        .input('oddFora',    sql.Decimal(10,2), oddFora)
        .input('oddOver25',  sql.Decimal(10,2), ex.oddOver25  || 0)
        .input('oddUnder25', sql.Decimal(10,2), ex.oddUnder25 || 0)
        .input('oddBttsSim', sql.Decimal(10,2), ex.oddBttsSim || 0)
        .input('oddBttsNao', sql.Decimal(10,2), ex.oddBttsNao || 0)
        .input('oddHtCasa',  sql.Decimal(10,2), ex.oddHtCasa  || 0)
        .input('oddHtEmp',   sql.Decimal(10,2), ex.oddHtEmpate|| 0)
        .input('oddHtFora',  sql.Decimal(10,2), ex.oddHtFora  || 0)
        .input('agora',      sql.DateTime2,     new Date())
        .query(`
            MERGE bet365_eventos AS t
            USING (SELECT @id AS id) AS s ON t.id = s.id
            WHEN MATCHED THEN UPDATE SET
                t.odd_casa    = CASE WHEN @oddCasa    > 0 THEN @oddCasa    ELSE t.odd_casa    END,
                t.odd_empate  = CASE WHEN @oddEmp     > 0 THEN @oddEmp     ELSE t.odd_empate  END,
                t.odd_fora    = CASE WHEN @oddFora    > 0 THEN @oddFora    ELSE t.odd_fora    END,
                t.odd_over25  = CASE WHEN @oddOver25  > 0 THEN @oddOver25  ELSE t.odd_over25  END,
                t.odd_under25 = CASE WHEN @oddUnder25 > 0 THEN @oddUnder25 ELSE t.odd_under25 END,
                t.odd_btts_sim= CASE WHEN @oddBttsSim > 0 THEN @oddBttsSim ELSE t.odd_btts_sim END,
                t.odd_btts_nao= CASE WHEN @oddBttsNao > 0 THEN @oddBttsNao ELSE t.odd_btts_nao END,
                t.odd_ht_casa = CASE WHEN @oddHtCasa  > 0 THEN @oddHtCasa  ELSE t.odd_ht_casa  END,
                t.odd_ht_empate= CASE WHEN @oddHtEmp  > 0 THEN @oddHtEmp   ELSE t.odd_ht_empate END,
                t.odd_ht_fora = CASE WHEN @oddHtFora  > 0 THEN @oddHtFora  ELSE t.odd_ht_fora  END,
                t.start_time_datetime = @startDt,
                t.data_atualizacao    = @agora,
                t.ativo               = 1
            WHEN NOT MATCHED THEN INSERT
                (id, url, league_name, time_casa, time_fora, status,
                 start_time_datetime, odd_casa, odd_empate, odd_fora,
                 odd_over25, odd_under25, odd_btts_sim, odd_btts_nao,
                 odd_ht_casa, odd_ht_empate, odd_ht_fora,
                 data_coleta, data_atualizacao, ativo)
            VALUES (@id, '', @league, @timeCasa, @timeFora, 'AGENDADO',
                    @startDt, @oddCasa, @oddEmp, @oddFora,
                    NULLIF(@oddOver25,0), NULLIF(@oddUnder25,0),
                    NULLIF(@oddBttsSim,0), NULLIF(@oddBttsNao,0),
                    NULLIF(@oddHtCasa,0), NULLIF(@oddHtEmp,0), NULLIF(@oddHtFora,0),
                    @agora, @agora, 1);
        `);
}

// ── Hard refresh e aguarda ligas ────────────────────────────
async function hardRefresh(pg) {
    try {
        await pg.bringToFront();
        await pg.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
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
            let refreshOk = false;
            try {
                refreshOk = await hardRefreshComRetry(pg);
            } catch(err) {
                if (isFatalError(err)) {
                    if (reconectou) {
                        console.warn(`   ❌ [Odds] Sessão perdida novamente após reconexão — abortando ciclo`);
                        return { browser, pg, oddsOk };
                    }
                    try {
                        ({ browser, pg } = await reconectarEdge(browser, 'Odds'));
                        reconectou = true;
                        refreshOk = true;
                        console.log(`   ✅ [Odds] Reconectado — continuando com próxima liga`);
                    } catch(e2) {
                        console.warn(`   ❌ [Odds] Reconexão falhou: ${e2.message} — abortando ciclo`);
                        return { browser, pg, oddsOk };
                    }
                }
            }
            // Todas as tentativas de refresh falharam sem lançar exceção → sesssão morta
            if (!refreshOk && !reconectou) {
                console.warn(`   ⚠️  [Odds] Refresh falhou após 3 tentativas — reconectando...`);
                try {
                    ({ browser, pg } = await reconectarEdge(browser, 'Odds'));
                    reconectou = true;
                    console.log(`   ✅ [Odds] Reconectado após falha de refresh`);
                } catch(e2) {
                    console.warn(`   ❌ [Odds] Reconexão falhou: ${e2.message} — abortando ciclo`);
                    return { browser, pg, oddsOk };
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
