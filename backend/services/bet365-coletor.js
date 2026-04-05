/**
 * ============================================================
 * COLETOR BET365 - FUTEBOL VIRTUAL
 * URL: https://www.bet365.bet.br/#/AVR/B146/R%5E1/
 * ============================================================
 *
 * Coleta headless com seletores DOM exatos extraídos do HTML real da página.
 * Coleta TODAS as 5 ligas × todos os horários × todos os mercados.
 *
 * Ligas: Express Cup | World Cup | Euro Cup | Premiership | Super League
 *
 * Mercados coletados por jogo:
 *   Fulltime Result, Goals Over/Under, Team to Score Yes/No,
 *   Correct Score, Correct Score Group, Result/Both Teams to Score,
 *   Double Chance, Half Time/Full Time, Exact Total Goals,
 *   Half Time Result, Half Time Correct Score, Winning Margin,
 *   Team Goals, Team to Score, Handicap Result, Asian Handicap,
 *   First Goalscorer
 * ============================================================
 */

const puppeteer = require('puppeteer');
const sql = require('mssql');
const dotenv = require('dotenv');
const fs   = require('fs');
const path = require('path');

dotenv.config();

const COOKIES_FILE = path.join(__dirname, '../../cookies-bet365.json');

class Bet365Coletor {
    constructor() {
        this.url       = 'https://www.bet365.bet.br/#/AVR/B146/R%5E1/';
        this.browser   = null;
        this.page      = null;   // aba de login/referência
        this.pageLogin = null;
        this.pagesLiga = [];     // [{page, liga: {idx, nome}}] — uma por liga
        this.pool      = null;
        this.coletando = false;
        this._coletas  = 0;
    }

    _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ─────────────────────────────────────────────────────────────
    // IDs determinísticos (FNV-1a 32-bit)
    // ─────────────────────────────────────────────────────────────

    _hash(str) {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h;
    }

    _gerarId(liga, timeCasa, timeFora, horario) {
        const base = `${liga}|${timeCasa}|${timeFora}|${horario}`;
        const h = this._hash(base);
        return Number(BigInt(h) & BigInt('0x7FFFFFFFFFFFFFFF'));
    }

    _gerarMercadoId(eventoId, nomeMercado) {
        const h = this._hash(`${eventoId}|${nomeMercado}`);
        return Number(BigInt(h) & BigInt('0x7FFFFFFFFFFFFFFF'));
    }

    _gerarOddId(mercadoId, nomeSelecao, handicap) {
        const h = this._hash(`${mercadoId}|${nomeSelecao}|${handicap}`);
        return Number(BigInt(h) & BigInt('0x7FFFFFFFFFFFFFFF'));
    }

    // ─────────────────────────────────────────────────────────────
    // BANCO
    // ─────────────────────────────────────────────────────────────

    async conectarBanco() {
        if (this.pool && this.pool.connected) return this.pool;
        this.pool = await sql.connect({
            user:     process.env.DB_USER     || 'sa',
            password: process.env.DB_PASSWORD,
            server:   process.env.DB_SERVER   || '127.0.0.1',
            database: process.env.DB_NAME     || 'PRODUCAO',
            port:     parseInt(process.env.DB_PORT) || 1433,
            options: {
                encrypt:                process.env.DB_ENCRYPT    === 'true',
                trustServerCertificate: process.env.DB_TRUST_CERT !== 'false'
            },
            pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
        });
        console.log('✅ Bet365 - Banco conectado');
        // Garante colunas (idempotente)
        const migracoes = [
            `IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bet365_historico_partidas') AND name='resultado_estimado')
             ALTER TABLE bet365_historico_partidas ADD resultado_estimado BIT NOT NULL DEFAULT 0`,
            `IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bet365_historico_partidas') AND name='gol_casa_ht')
             ALTER TABLE bet365_historico_partidas ADD gol_casa_ht TINYINT NULL`,
            `IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bet365_historico_partidas') AND name='gol_fora_ht')
             ALTER TABLE bet365_historico_partidas ADD gol_fora_ht TINYINT NULL`,
        ];
        for (const sql of migracoes) {
            await this.pool.query(sql).catch(e => console.warn('⚠️ Schema:', e.message));
        }
        return this.pool;
    }

    // ─────────────────────────────────────────────────────────────
    // BROWSER — headless, stealth, sem janela
    // ─────────────────────────────────────────────────────────────

    async iniciarBrowser() {
        if (this.browser) {
            // Verifica se o browser ainda está conectado (pode ter sido fechado manualmente)
            try {
                await this.browser.version();
                return; // ainda vivo
            } catch(_) {
                console.log('   ⚠️  Navegador desconectado (fechado manualmente?), reiniciando...');
                this.browser   = null;
                this.page      = null;
                this.pageLogin = null;
                this.pagesLiga = [];
            }
        }
        const headless = process.env.BET365_HEADLESS !== 'false' ? 'new' : false;
        const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
        const userDataDir = 'C:\\Users\\Administrador\\AppData\\Local\\Microsoft\\Edge\\BetColetor';

        console.log(`🌐 Bet365 - Iniciando Edge (headless: ${headless})...`);
        this.browser = await puppeteer.launch({
            headless,
            executablePath: edgePath,
            userDataDir,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--window-size=1366,768',
                '--disable-blink-features=AutomationControlled',
                '--lang=pt-BR,pt',
                '--no-first-run', '--no-default-browser-check',
                '--disable-infobars',
                '--disable-notifications'
            ],
            defaultViewport: { width: 1366, height: 768 },
            ignoreDefaultArgs: ['--enable-automation']
        });

        this.page = await this.browser.newPage();

        // Injeta stealth antes de qualquer script da página (evita detecção de bot)
        await this.page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
            Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US'] });
            window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (params) =>
                params.name === 'notifications'
                    ? Promise.resolve({ state: Notification.permission })
                    : originalQuery(params);
        });

        this.page.on('pageerror', () => {});
        this.page.on('requestfailed', () => {});

        console.log('✅ Bet365 - Navegador iniciado');
    }

    async fecharBrowser() {
        if (this.browser) {
            await this.browser.close().catch(() => {});
            this.browser    = null;
            this.page       = null;
            this.pageLogin  = null;
            console.log('🔒 Bet365 - Navegador fechado');
        }
    }

    // ─────────────────────────────────────────────────────────────
    // NAVEGAÇÃO E ESPERA
    // ─────────────────────────────────────────────────────────────

    // Verifica se o usuário NÃO está logado (detecta botão Login ou "Registre-se" no header)
    async _botaoLoginVisivel() {
        // Aguarda o header da Bet365 renderizar completamente (SPA demora)
        try {
            await this.page.waitForFunction(() => {
                const txt = document.body?.innerText || '';
                // Aguarda até o texto "Login" ou algum indicador de conta aparecer
                return txt.includes('Login') || txt.includes('Registre-se') ||
                       txt.includes('Minha Conta') || txt.includes('Saldo') ||
                       txt.length > 200;
            }, { timeout: 8000, polling: 500 });
        } catch(_) {}

        return this.page.evaluate(() => {
            const txt = document.body?.innerText || '';
            // "Registre-se" aparece APENAS quando não está logado
            if (txt.includes('Registre-se') || txt.includes('Register')) return true;
            // Fallback: botão Login visível
            return [...document.querySelectorAll('button, a, [role="button"]')]
                .some(el => {
                    const t = el.textContent.trim();
                    return (t === 'Login' || t === 'Log In' || t === 'Entrar') &&
                           el.offsetParent !== null; // visível
                });
        });
    }

    // ─── Salva cookies da sessão em arquivo JSON ──────────────────
    async _salvarCookies() {
        try {
            const cookies = await this.page.cookies();
            if (cookies && cookies.length > 0) {
                fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
                console.log(`   💾 Cookies salvos (${cookies.length})`);
            }
        } catch(e) { console.log('   ⚠️  Erro ao salvar cookies:', e.message); }
    }

    // ─── Carrega cookies do arquivo e injeta na página ────────────
    async _carregarCookies() {
        try {
            if (!fs.existsSync(COOKIES_FILE)) return false;
            const stat = fs.statSync(COOKIES_FILE);
            const idadeHoras = (Date.now() - stat.mtimeMs) / 3600000;
            if (idadeHoras > 48) {
                console.log('   ⚠️  Cookies expirados (>48h), ignorando');
                return false;
            }
            const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
            if (!cookies || cookies.length === 0) return false;
            await this.page.setCookie(...cookies);
            console.log(`   🍪 Cookies carregados do arquivo (${cookies.length})`);
            return true;
        } catch(e) { console.log('   ⚠️  Erro ao carregar cookies:', e.message); return false; }
    }

    async _fazerLogin() {
        // ── 1. Já está logado? ──────────────────────────────────────
        const jaLogado = !(await this._botaoLoginVisivel());
        if (jaLogado) {
            console.log('   ✅ Já está logado (sessão ativa)');
            await this._salvarCookies();
            return true;
        }

        // ── 2. Aguarda login manual (30 minutos) ───────────────────
        // Login automático desabilitado (Bet365 detecta bot e bloqueia conta)
        const usuario = process.env.BET365_USERNAME;
        console.log('');
        console.log('   ══════════════════════════════════════════════');
        console.log('   🔐 FAÇA LOGIN MANUALMENTE NA JANELA DO EDGE');
        console.log(`   👤 Usuário: ${usuario || '(ver .env)'}`);
        console.log('   ⏳ Aguardando até 30 minutos...');
        console.log('   ══════════════════════════════════════════════');
        console.log('');

        try {
            await this.page.waitForFunction(() => {
                const txt = document.body?.innerText || '';
                // Logado quando NÃO há "Registre-se" e NÃO há botão Login visível
                if (txt.includes('Registre-se') || txt.includes('Register')) return false;
                return ![...document.querySelectorAll('button, a, [role="button"]')]
                    .some(b => {
                        const t = b.textContent.trim();
                        return (t === 'Login' || t === 'Log In') && b.offsetParent !== null;
                    });
            }, { timeout: 1800000, polling: 2000 }); // 30 min
            console.log('   ✅ Login detectado! Salvando cookies...');
            await this._salvarCookies();
            // Recarrega a aba principal para herdar sessão autenticada (evita conteúdo vazio)
            console.log('   🔄 Recarregando aba principal com sessão ativa...');
            await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            await this._delay(3000);
            return true;
        } catch(e) {
            console.log('   ❌ Timeout — login não realizado em 30 minutos');
            return false;
        }
    }

    // Aceita popup de política de cookies
    async _aceitarCookiesPopup() {
        try {
            const aceitou = await this.page.evaluate(() => {
                // Matching exato (evitar clicar em "Gerenciar Cookies" ou "Rejeitar")
                const exatos = ['Aceitar', 'Accept', 'Aceitar tudo', 'Accept All',
                                'Concordo', 'Allow all', 'Allow All', 'Aceitar cookies',
                                'Accept cookies', 'Got it'];
                for (const el of document.querySelectorAll('button, a, [role="button"]')) {
                    const txt = el.textContent.trim();
                    if (exatos.some(t => txt === t || txt.toLowerCase() === t.toLowerCase())) {
                        el.click();
                        return txt;
                    }
                }
                // Fallback menos agressivo: começa com "Aceitar" ou "Accept"
                for (const el of document.querySelectorAll('button, a, [role="button"]')) {
                    const txt = el.textContent.trim().toLowerCase();
                    if ((txt.startsWith('aceitar') || txt.startsWith('accept')) &&
                        !txt.includes('gerenciar') && !txt.includes('manage') &&
                        !txt.includes('config') && !txt.includes('ajust')) {
                        el.click();
                        return el.textContent.trim();
                    }
                }
                return null;
            });
            if (aceitou) {
                console.log(`   🍪 Cookies aceitos ("${aceitou}")`);
                await this._delay(800);
            }
        } catch(_) {}
    }

    // Fecha o popup "Seu último login foi no dia..." que aparece após login
    async _fecharPopupPosLogin() {
        try {
            const fechou = await this.page.evaluate(() => {
                // Procura botão "Continuar" em qualquer popup/overlay
                for (const btn of document.querySelectorAll('button, .btn, [role="button"]')) {
                    const txt = btn.textContent.trim();
                    if (txt === 'Continuar' || txt === 'Continue' || txt === 'OK' || txt === 'Fechar') {
                        btn.click();
                        return txt;
                    }
                }
                return null;
            });
            if (fechou) {
                console.log(`   ✅ Popup pós-login fechado (botão: ${fechou})`);
                await this._delay(1000);
            }
        } catch(e) { /* popup pode não existir */ }
    }

    async navegarParaPagina() {
        console.log(`📡 Bet365 - Carregando página...`);

        // 0. Tenta restaurar sessão via cookies salvos (antes de navegar)
        const cookiesOk = await this._carregarCookies();

        // 1. Carrega a home
        await this.page.goto('https://www.bet365.bet.br/', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        await this._delay(2000);

        // 1b. Aceita popup de cookies se aparecer (antes de verificar login)
        await this._aceitarCookiesPopup();
        await this._delay(1000);

        if (cookiesOk) {
            // Aguarda mais um pouco para a sessão ser reconhecida
            await this._delay(2000);
        }

        // 2. Login (só pede se necessário)
        await this._fazerLogin();
        await this._delay(2000);

        // 2b. Abre nova aba MANTENDO a aba original aberta (contexto de referência)
        // Igual ao que funciona manualmente: Ctrl+T com aba anterior ainda visível
        console.log('   🗂️  Abrindo nova aba para coleta (aba original mantida)...');
        this.pageLogin = this.page; // guarda aba original como referência
        this.page = await this.browser.newPage();
        this.page.on('pageerror', () => {});
        this.page.on('requestfailed', () => {});
        console.log('   ✅ Nova aba aberta');

        // 3. Navega direto para Futebol Virtual na nova aba
        console.log('   ⚽ Navegando para Futebol Virtual (B146)...');
        await this.page.goto(this.url, { waitUntil: 'load', timeout: 60000 });
        await this._delay(6000);

        // Fecha a aba de referência assim que a nova carregou (evita acúmulo de abas)
        if (this.pageLogin && !this.pageLogin.isClosed()) {
            await this.pageLogin.close().catch(() => {});
            this.pageLogin = null;
        }

        // 4. Aguarda as tabs de liga aparecerem
        console.log('   ⏳ Aguardando ligas...');
        try {
            await this.page.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: 45000 });
            const qtd = await this.page.evaluate(() =>
                document.querySelectorAll('.vrl-MeetingsHeaderButton').length
            );
            console.log(`   ✅ ${qtd} liga(s) encontrada(s)!`);
        } catch (e) {
            const diag = await this.page.evaluate(() => ({
                url: window.location.href,
                texto: document.body.innerText.substring(0, 400).replace(/\n/g, ' ')
            })).catch(() => ({}));
            console.log(`   ⚠️  Tabs não apareceram. URL: ${diag.url}`);
            console.log(`   🔍 Texto: ${diag.texto}`);
        }
    }

    async _aguardarMercados(maxMs, pg) {
        const p = pg || this.page;
        const inicio = Date.now();
        while (Date.now() - inicio < maxMs) {
            const ok = await p.evaluate(() =>
                document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup').length > 0
            ).catch(() => false);
            if (ok) return true;
            await this._delay(500);
        }
        return false;
    }

    // ─────────────────────────────────────────────────────────────
    // EXTRAÇÃO: MERCADOS de um jogo (modo upcoming)
    // Seletores confirmados no HTML real
    // ─────────────────────────────────────────────────────────────

    async _extrairMercadosDoPagina(pg) {
        const p = pg || this.page;
        return await p.evaluate(() => {
            const mercados = [];

            // Informações do countdown / encerramento
            const bcText = document.querySelector('.svc-MarketGroup_BookCloses span:last-child');
            const raceOff = document.querySelector('.svc-MarketGroup_RaceOff');
            const countdown = raceOff ? 'EVENTO INICIADO' : (bcText ? bcText.textContent.trim() : null);

            // Itera cada bloco de mercado
            const pods = document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup');
            for (const pod of pods) {
                const nomeBtn = pod.querySelector('.gl-MarketGroupButton_Text');
                const nomeMercado = nomeBtn ? nomeBtn.textContent.trim() : 'Desconhecido';

                const selecoes = [];

                // ── Padrão 1: ParticipantStackedBorderless (Fulltime Result) ──
                const stackedItems = pod.querySelectorAll('.srb-ParticipantStackedBorderless');
                if (stackedItems.length > 0) {
                    for (const el of stackedItems) {
                        const nome = el.querySelector('.srb-ParticipantStackedBorderless_Name');
                        const odd  = el.querySelector('.srb-ParticipantStackedBorderless_Odds');
                        if (nome && odd) {
                            selecoes.push({
                                nome: nome.textContent.trim(),
                                odd: parseFloat(odd.textContent.trim()) || 0,
                                handicap: 0,
                                coluna: ''
                            });
                        }
                    }
                }

                // ── Padrão 2: ParticipantBorderless (Double Chance, HT/FT, etc.) ──
                const borderlessItems = pod.querySelectorAll('.gl-ParticipantBorderless');
                if (borderlessItems.length > 0) {
                    for (const el of borderlessItems) {
                        const nome = el.querySelector('.gl-ParticipantBorderless_Name');
                        const odd  = el.querySelector('.gl-ParticipantBorderless_Odds');
                        if (nome && odd) {
                            selecoes.push({
                                nome: nome.textContent.trim(),
                                odd: parseFloat(odd.textContent.trim()) || 0,
                                handicap: 0,
                                coluna: ''
                            });
                        }
                    }
                }

                // ── Padrão 3: ResponsiveText (Exact Goals, HT Result, etc.) ──
                const respItems = pod.querySelectorAll('.srb-ParticipantResponsiveText');
                if (respItems.length > 0) {
                    for (const el of respItems) {
                        const nome = el.querySelector('.srb-ParticipantResponsiveText_Name');
                        const odd  = el.querySelector('.srb-ParticipantResponsiveText_Odds');
                        if (nome && odd) {
                            selecoes.push({
                                nome: nome.textContent.trim(),
                                odd: parseFloat(odd.textContent.trim()) || 0,
                                handicap: 0,
                                coluna: ''
                            });
                        }
                    }
                }

                // ── Padrão 4: Tabela com colunas (Over/Under, Winning Margin, Team Goals, etc.) ──
                // Pega as colunas de dados e as labels de linha
                const markets = pod.querySelectorAll('.gl-Market');
                if (selecoes.length === 0 && markets.length > 0) {
                    // Coleta labels das linhas (srb-ParticipantLabelCentered_Name)
                    const labels = [];
                    const labelEls = pod.querySelectorAll('.srb-ParticipantLabelCentered_Name, .srb-ParticipantLabel_Name');
                    for (const el of labelEls) labels.push(el.textContent.trim());

                    // Itera colunas de dados
                    for (const market of markets) {
                        const colHeader = market.querySelector('.gl-MarketColumnHeader');
                        const colNome = colHeader ? colHeader.textContent.trim().replace(/\u00a0/g, '') : '';
                        if (!colNome) continue; // Skip label columns

                        // ParticipantCentered (Correct Score, Handicap, Asian Handicap)
                        const centeredItems = market.querySelectorAll('.gl-ParticipantCentered');
                        for (const el of centeredItems) {
                            const nome    = el.querySelector('.gl-ParticipantCentered_Name');
                            const handi   = el.querySelector('.gl-ParticipantCentered_Handicap');
                            const oddEl   = el.querySelector('.gl-ParticipantCentered_Odds');
                            if (oddEl) {
                                const nomeVal  = nome  ? nome.textContent.trim()  : '';
                                const handiVal = handi ? handi.textContent.trim() : '';
                                selecoes.push({
                                    nome: nomeVal || handiVal || colNome,
                                    odd: parseFloat(oddEl.textContent.trim()) || 0,
                                    handicap: parseFloat(handiVal) || 0,
                                    coluna: colNome
                                });
                            }
                        }

                        // ParticipantOddsOnly (Over/Under, Team Goals, Winning Margin)
                        const oddsOnlyItems = market.querySelectorAll('.gl-ParticipantOddsOnly');
                        oddsOnlyItems.forEach((el, idx) => {
                            const oddEl = el.querySelector('.gl-ParticipantOddsOnly_Odds');
                            if (oddEl) {
                                selecoes.push({
                                    nome: labels[idx] || `Linha ${idx + 1}`,
                                    odd: parseFloat(oddEl.textContent.trim()) || 0,
                                    handicap: 0,
                                    coluna: colNome
                                });
                            }
                        });

                        // ParticipantLabel — labels já capturadas em labels[]
                        // as odds correspondentes vêm de OddsOnly nas colunas seguintes
                    }
                }

                if (selecoes.length > 0) {
                    mercados.push({ nome: nomeMercado, selecoes });
                }
            }

            return { countdown, mercados };
        });
    }

    // ─────────────────────────────────────────────────────────────
    // EXTRAÇÃO: Jogo atual (times e horário)
    // ─────────────────────────────────────────────────────────────

    async _extrairInfoJogo(liga, pg) {
        const p = pg || this.page;
        return await p.evaluate((liga) => {
            // Time selecionado (o botão ativo)
            const timeBtn = document.querySelector('.vr-EventTimesNavBarButton-selected .vr-EventTimesNavBarButton_Text');
            const horario = timeBtn ? timeBtn.textContent.trim() : null;

            // Times extraídos do mercado Fulltime Result / Resultado Final (PT)
            const nomes = [];
            const ftPod = [...document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup')]
                .find(p => {
                    const txt = p.querySelector('.gl-MarketGroupButton_Text')?.textContent.trim();
                    return txt === 'Fulltime Result' || txt === 'Resultado Final';
                });
            if (ftPod) {
                const names = ftPod.querySelectorAll('.srb-ParticipantStackedBorderless_Name');
                for (const n of names) {
                    const t = n.textContent.trim();
                    if (t && t !== 'Draw' && t !== 'Empate') nomes.push(t);
                }
            }

            const timeCasa = nomes[0] || null;
            const timeFora = nomes[1] || null;

            // Countdown
            const bcText = document.querySelector('.svc-MarketGroup_BookCloses span:last-child');
            const raceOff = document.querySelector('.svc-MarketGroup_RaceOff');
            const countdown = raceOff ? 'EVENTO INICIADO' : (bcText ? bcText.textContent.trim() : null);

            return { liga, horario, timeCasa, timeFora, countdown };
        }, liga);
    }

    // ─────────────────────────────────────────────────────────────
    // EXTRAÇÃO: Resultados (aba "Resultados")
    // ─────────────────────────────────────────────────────────────

    async _extrairResultados(liga, pg) {
        const p = pg || this.page;
        return await p.evaluate((liga) => {
            const resultados = [];

            // Cada partida de resultado
            const grupos = document.querySelectorAll('.vrr-HeadToHeadMarketGroup');
            for (const grupo of grupos) {
                const eventLabel = grupo.querySelector('.vrr-FixtureDetails_Event');
                const labelTxt = eventLabel ? eventLabel.textContent.trim() : '';
                // Formato: "World Cup - 19.55"
                const horarioMatch = labelTxt.match(/(\d{1,2}[.:]\d{2})$/);
                const horario = horarioMatch ? horarioMatch[1] : null;

                const t1El = grupo.querySelector('.vrr-HTHTeamDetails_TeamOne');
                const t2El = grupo.querySelector('.vrr-HTHTeamDetails_TeamTwo');
                const scEl = grupo.querySelector('.vrr-HTHTeamDetails_Score');

                if (!t1El || !t2El || !scEl) continue;

                const timeCasa = t1El.textContent.trim();
                const timeFora = t2El.textContent.trim();
                const placarRaw = scEl.textContent.trim().replace(/\s+/g, '');

                const placar = placarRaw;
                const parts  = placar.split(/[-–]/);
                const golCasa  = parseInt(parts[0]) || 0;
                const golFora  = parseInt(parts[1]) || 0;
                const resultado = golCasa > golFora ? 'CASA' : golFora > golCasa ? 'FORA' : 'EMPATE';

                // Mercados do resultado (odds pagas / seleções vencedoras)
                const mercados = [];
                const participantes = grupo.querySelectorAll('.vrr-HeadToHeadParticipant');
                for (const p of participantes) {
                    const mkt  = p.querySelector('.vrr-HeadToHeadParticipant_Market');
                    const win  = p.querySelector('.vrr-HeadToHeadParticipant_Winner');
                    const prc  = p.querySelector('.vrr-HeadToHeadParticipant_Price');
                    if (mkt && win) {
                        mercados.push({
                            mercado:  mkt.textContent.trim(),
                            selecao:  win.textContent.trim(),
                            odd:      prc ? parseFloat(prc.textContent.trim()) || 0 : 0
                        });
                    }
                }

                // Extrai HT dos mercados liquidados (seleção vencedora = placar real do HT)
                // "Resultado Correto - Intervalo" / "Half Time Correct Score" contém o placar HT como seleção
                let golCasaHT = null, golForaHT = null;
                for (const m of mercados) {
                    const nome = m.mercado.toLowerCase();
                    if (nome.includes('intervalo') && nome.includes('correto') ||
                        nome.includes('half time correct') ||
                        nome.includes('half-time correct')) {
                        // Seleção vencedora é o placar HT: "1-0", "2-1", etc.
                        const htMatch = m.selecao.match(/^(\d+)\s*[-–]\s*(\d+)$/);
                        if (htMatch) {
                            golCasaHT = parseInt(htMatch[1]);
                            golForaHT = parseInt(htMatch[2]);
                        }
                        // Se for "Qualquer Outro Resultado" / "Any Other Score" → HT desconhecido (null)
                        break;
                    }
                }

                resultados.push({ liga, horario, timeCasa, timeFora, placar, golCasa, golFora, golCasaHT, golForaHT, resultado, mercados });
            }
            return resultados;
        }, liga);
    }

    // ─────────────────────────────────────────────────────────────
    // ABAS PERSISTENTES — inicializa uma aba por liga
    // ─────────────────────────────────────────────────────────────

    async _prepararAbas() {
        // Lê ligas disponíveis na página atual
        const ligas = await this.page.evaluate(() => {
            const tabs = document.querySelectorAll('.vrl-MeetingsHeaderButton');
            return [...tabs].map((el, idx) => {
                const title = el.querySelector('.vrl-MeetingsHeaderButton_Title');
                return { idx, nome: title ? title.textContent.trim() : `Liga${idx}` };
            });
        });

        const LIGAS_IGNORAR = ['express cup'];
        const ligasFiltradas = ligas.filter(l =>
            !LIGAS_IGNORAR.some(ig => l.nome.toLowerCase().includes(ig))
        );

        if (ligasFiltradas.length === 0) {
            console.log('   ⚠️  Nenhuma liga para preparar');
            return;
        }

        // Fecha abas antigas
        for (const entry of this.pagesLiga) {
            if (entry.page !== this.page && !entry.page.isClosed()) {
                await entry.page.close().catch(() => {});
            }
        }
        this.pagesLiga = [];

        console.log(`   🗂️  Abrindo ${ligasFiltradas.length} aba(s) (uma por liga)...`);

        for (let i = 0; i < ligasFiltradas.length; i++) {
            const liga = ligasFiltradas[i];
            let pg;
            if (i === 0) {
                pg = this.page; // reutiliza aba atual
            } else {
                // Abre nova aba mantendo as anteriores como referência
                pg = await this.browser.newPage();
                pg.on('pageerror', () => {});
                pg.on('requestfailed', () => {});
                await pg.goto(this.url, { waitUntil: 'load', timeout: 60000 });
                await this._delay(4000);
                // Aguarda tabs carregarem
                await pg.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: 20000 }).catch(() => {});
            }
            // Seleciona a aba da liga nesta página
            await pg.evaluate((idx) => {
                const tabs = document.querySelectorAll('.vrl-MeetingsHeaderButton');
                if (tabs[idx]) tabs[idx].click();
            }, liga.idx);
            await this._delay(1500);

            this.pagesLiga.push({ page: pg, liga });
            console.log(`   ✅ Aba ${i + 1}/${ligasFiltradas.length}: ${liga.nome}`);
        }
        // Atualiza this.page para a primeira aba de liga
        this.page = this.pagesLiga[0].page;
        console.log(`   ✅ ${this.pagesLiga.length} aba(s) prontas`);
    }

    // ─────────────────────────────────────────────────────────────
    // COLETA DE UMA LIGA em sua aba dedicada
    // ─────────────────────────────────────────────────────────────

    async _coletarLiga(pg, liga) {
        const eventos    = [];
        const resultados = [];

        // F5 na aba desta liga
        await pg.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await this._delay(3000);

        // Aguarda tabs aparecerem após reload
        try {
            await pg.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: 20000 });
        } catch(e) {
            console.log(`   ⚠️  [${liga.nome}] Tabs não apareceram após F5`);
            return { eventos, resultados };
        }

        // Clica na aba desta liga específica
        const clicou = await pg.evaluate((idx) => {
            const tabs = document.querySelectorAll('.vrl-MeetingsHeaderButton');
            if (tabs[idx]) { tabs[idx].click(); return true; }
            return false;
        }, liga.idx);
        if (!clicou) {
            console.log(`   ⚠️  [${liga.nome}] Não encontrou aba idx=${liga.idx}`);
            return { eventos, resultados };
        }
        await this._delay(1500);

        // ── Resultados ──
        const temBtnResultados = await pg.evaluate(() =>
            !!document.querySelector('.vr-ResultsNavBarButton')
        );
        if (temBtnResultados) {
            await pg.evaluate(() => {
                document.querySelector('.vr-ResultsNavBarButton')?.click();
            });
            await this._delay(2000);
            await pg.evaluate(() => {
                document.querySelector('.vrr-ShowMoreButton_Link')?.click();
            });
            await this._delay(1000);

            const res = await this._extrairResultados(liga.nome, pg);
            resultados.push(...res);
            console.log(`   📋 [${liga.nome}] ${res.length} resultado(s)`);

            // Volta para próximos jogos
            await pg.evaluate((idx) => {
                document.querySelectorAll('.vrl-MeetingsHeaderButton')[idx]?.click();
            }, liga.idx);
            await this._delay(2000);
        }

        // ── Próximos jogos ──
        const numHorarios = await pg.evaluate(() =>
            document.querySelectorAll('.vr-EventTimesNavBarButton').length
        );
        console.log(`   ⏰ [${liga.nome}] ${numHorarios} horário(s)`);

        for (let i = 0; i < numHorarios; i++) {
            const ok = await pg.evaluate((idx) => {
                const btns = document.querySelectorAll('.vr-EventTimesNavBarButton');
                if (btns[idx]) { btns[idx].click(); return true; }
                return false;
            }, i);
            if (!ok) continue;
            await this._delay(1500);

            const temMercados = await this._aguardarMercados(8000, pg);
            if (!temMercados) continue;

            const infoJogo = await this._extrairInfoJogo(liga.nome, pg);
            if (!infoJogo.timeCasa || !infoJogo.timeFora) continue;

            const { mercados, countdown } = await this._extrairMercadosDoPagina(pg);
            const ftMkt = mercados.find(m =>
                m.nome === 'Fulltime Result' || m.nome === 'Resultado Final'
            );
            let oddCasa = 0, oddEmpate = 0, oddFora = 0;
            if (ftMkt) {
                oddCasa   = ftMkt.selecoes[0]?.odd || 0;
                oddEmpate = ftMkt.selecoes[1]?.odd || 0;
                oddFora   = ftMkt.selecoes[2]?.odd || 0;
            }

            const horario  = infoJogo.horario || countdown;
            const eventoId = this._gerarId(liga.nome, infoJogo.timeCasa, infoJogo.timeFora, horario);

            eventos.push({
                eventoId, liga: liga.nome,
                timeCasa: infoJogo.timeCasa, timeFora: infoJogo.timeFora,
                horario, countdown, oddCasa, oddEmpate, oddFora, mercados
            });
            console.log(`      ✅ [${liga.nome}] ${infoJogo.timeCasa} x ${infoJogo.timeFora} [${horario}]`);
        }

        return { eventos, resultados };
    }

    // ─────────────────────────────────────────────────────────────
    // COLETA PRINCIPAL — todas as ligas em paralelo
    // ─────────────────────────────────────────────────────────────

    async _extrairDados() {
        if (this.pagesLiga.length === 0) {
            console.log('   ⚠️  Nenhuma aba de liga — verifique a navegação inicial');
            return { eventos: [], resultados: [] };
        }

        console.log(`   🔄 Coletando ${this.pagesLiga.length} liga(s) em paralelo (F5 + coleta)...`);

        // Coleta todas as ligas simultaneamente
        const resultados = await Promise.all(
            this.pagesLiga.map(({ page: pg, liga }) =>
                this._coletarLiga(pg, liga).catch(err => {
                    console.log(`   ❌ [${liga.nome}] Erro: ${err.message}`);
                    return { eventos: [], resultados: [] };
                })
            )
        );

        const todosEventos    = resultados.flatMap(r => r.eventos);
        const todosResultados = resultados.flatMap(r => r.resultados);

        console.log(`\n   ✅ Total: ${todosEventos.length} evento(s), ${todosResultados.length} resultado(s)`);
        return { eventos: todosEventos, resultados: todosResultados };
    }

    // ─────────────────────────────────────────────────────────────
    // SALVAR NO BANCO
    // ─────────────────────────────────────────────────────────────

    async salvarNoBanco(dados) {
        const pool = await this.conectarBanco();
        const { eventos, resultados } = dados;

        let eventosOk = 0, mercadosOk = 0, oddsOk = 0, histOk = 0;

        // Desativa apenas eventos das ligas que serão re-processadas neste ciclo
        // (mantém eventos de outras ligas ativos — importante para mostrar múltiplos jogos futuros)
        const ligasPresentes = [...new Set(eventos.map(e => e.liga))];
        for (const ligaNome of ligasPresentes) {
            await pool.request()
                .input('liga', sql.NVarChar(200), ligaNome)
                .query(`UPDATE bet365_eventos SET ativo = 0 WHERE league_name = @liga`);
        }
        // Limpa eventos muito antigos (> 3 horas) de qualquer liga
        await pool.request().query(`
            UPDATE bet365_eventos SET ativo = 0
            WHERE start_time_datetime < DATEADD(HOUR, -3, GETUTCDATE())
        `);

        // ── Salva eventos + mercados + odds ──
        for (const ev of eventos) {
            try {
                const agora = new Date();
                // Monta datetime do horário
                let startDt = null;
                if (ev.horario && /^\d{1,2}[.:]\d{2}$/.test(ev.horario)) {
                    const clean = ev.horario.replace('.', ':');
                    const [h, m] = clean.split(':').map(Number);
                    const now = new Date();
                    let ms = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m, 0, 0);
                    // Bet365 BR exibe horários em UTC+1 (~1h à frente do UTC real)
                    // Usar buffer de 90 min para não tratar jogos recentes como "amanhã"
                    if (ms > Date.now() + 90 * 60000) ms -= 86400000;
                    startDt = new Date(ms);
                }

                await pool.request()
                    .input('id',         sql.BigInt,       ev.eventoId)
                    .input('url',        sql.NVarChar(500), this.url)
                    .input('league',     sql.NVarChar(200), ev.liga)
                    .input('timeCasa',   sql.NVarChar(100), ev.timeCasa)
                    .input('timeFora',   sql.NVarChar(100), ev.timeFora)
                    .input('status',     sql.NVarChar(50),  'AGENDADO')
                    .input('startDt',    sql.DateTime2,     startDt)
                    .input('oddCasa',    sql.Decimal(10,2), ev.oddCasa || 0)
                    .input('oddEmpate',  sql.Decimal(10,2), ev.oddEmpate || 0)
                    .input('oddFora',    sql.Decimal(10,2), ev.oddFora || 0)
                    .input('coleta',     sql.DateTime2,     agora)
                    .query(`
                        MERGE bet365_eventos AS t
                        USING (SELECT @id AS id) AS s ON t.id = s.id
                        WHEN MATCHED THEN UPDATE SET
                            t.league_name         = @league,
                            t.time_casa           = @timeCasa,
                            t.time_fora           = @timeFora,
                            t.status              = @status,
                            t.start_time_datetime = @startDt,
                            t.odd_casa            = @oddCasa,
                            t.odd_empate          = @oddEmpate,
                            t.odd_fora            = @oddFora,
                            t.data_atualizacao    = @coleta,
                            t.ativo               = 1
                        WHEN NOT MATCHED THEN INSERT
                            (id, url, league_name, time_casa, time_fora, status,
                             start_time_datetime, odd_casa, odd_empate, odd_fora,
                             data_coleta, data_atualizacao, ativo)
                        VALUES
                            (@id, @url, @league, @timeCasa, @timeFora, @status,
                             @startDt, @oddCasa, @oddEmpate, @oddFora,
                             @coleta, @coleta, 1);
                    `);
                eventosOk++;

                // Desativa mercados antigos deste evento
                await pool.request()
                    .input('evId', sql.BigInt, ev.eventoId)
                    .query(`UPDATE bet365_mercados SET ativo = 0 WHERE evento_id = @evId`);

                // Salva mercados e odds
                for (const mkt of ev.mercados) {
                    const mktId = this._gerarMercadoId(ev.eventoId, mkt.nome);

                    await pool.request()
                        .input('id',       sql.BigInt,       mktId)
                        .input('evId',     sql.BigInt,       ev.eventoId)
                        .input('nome',     sql.NVarChar(200), mkt.nome)
                        .input('tipo',     sql.NVarChar(50),  mkt.nome.replace(/\s+/g,'_').toUpperCase().substring(0, 50))
                        .input('coleta',   sql.DateTime2,     new Date())
                        .query(`
                            MERGE bet365_mercados AS t
                            USING (SELECT @id AS id) AS s ON t.id = s.id
                            WHEN MATCHED THEN UPDATE SET t.ativo = 1, t.data_coleta = @coleta
                            WHEN NOT MATCHED THEN INSERT
                                (id, evento_id, nome, tipo, data_coleta, ativo)
                            VALUES (@id, @evId, @nome, @tipo, @coleta, 1);
                        `);
                    mercadosOk++;

                    // Desativa odds antigas deste mercado
                    await pool.request()
                        .input('mId', sql.BigInt, mktId)
                        .query(`UPDATE bet365_odds SET ativo = 0 WHERE mercado_id = @mId`);

                    for (const sel of mkt.selecoes) {
                        if (!sel.odd || sel.odd <= 0) continue;
                        const oddId = this._gerarOddId(mktId, sel.nome, sel.handicap);
                        await pool.request()
                            .input('id',      sql.BigInt,       oddId)
                            .input('mId',     sql.BigInt,       mktId)
                            .input('evId',    sql.BigInt,       ev.eventoId)
                            .input('nome',    sql.NVarChar(100), (sel.nome || '').substring(0, 100))
                            .input('full',    sql.NVarChar(200), (`${sel.coluna} ${sel.nome}`.trim()).substring(0, 200))
                            .input('valor',   sql.Decimal(10,2), sel.odd)
                            .input('handi',   sql.Decimal(10,2), sel.handicap || 0)
                            .input('coleta',  sql.DateTime2,     new Date())
                            .query(`
                                MERGE bet365_odds AS t
                                USING (SELECT @id AS id) AS s ON t.id = s.id
                                WHEN MATCHED THEN UPDATE SET
                                    t.valor = @valor, t.ativo = 1, t.data_coleta = @coleta
                                WHEN NOT MATCHED THEN INSERT
                                    (id, mercado_id, evento_id, nome, full_name, valor, handicap, data_coleta, ativo)
                                VALUES (@id, @mId, @evId, @nome, @full, @valor, @handi, @coleta, 1);
                            `);
                        oddsOk++;
                    }
                }
            } catch (e) {
                console.error(`   ❌ Erro salvando evento ${ev.timeCasa} x ${ev.timeFora}: ${e.message}`);
            }
        }

        // ── Salva histórico de resultados ──
        for (const res of resultados) {
            try {
                const eventoId = this._gerarId(res.liga, res.timeCasa, res.timeFora, res.horario || '');

                // Verifica se já existe E se o score ainda é 0-0 (jogo capturado durante o início)
                const existe = await pool.request()
                    .input('evId', sql.BigInt, eventoId)
                    .query(`SELECT id, gol_casa, gol_fora FROM bet365_historico_partidas WHERE evento_id = @evId`);

                const jaExiste   = existe.recordset.length > 0;
                const scoreZero  = jaExiste && existe.recordset[0].gol_casa === 0 && existe.recordset[0].gol_fora === 0;
                const temScore   = (res.golCasa || 0) + (res.golFora || 0) > 0;

                // Pula se já existe com score real, ou se não há nada novo para atualizar
                if (jaExiste && !scoreZero) continue;
                // Pula se já existe com 0-0 mas o score ainda não mudou
                if (jaExiste && scoreZero && !temScore) continue;

                if (true) { // mantém indentação original
                    // 1. Tenta pegar as 3 odds do evento coletado no mesmo ciclo (memória)
                    const evMemoria = eventos.find(e => e.eventoId === eventoId);
                    let oddCasa   = evMemoria?.oddCasa   || 0;
                    let oddEmpate = evMemoria?.oddEmpate || 0;
                    let oddFora   = evMemoria?.oddFora   || 0;

                    // 2. Se não achou em memória, busca no banco pelo evento_id
                    if (!oddCasa && !oddEmpate && !oddFora) {
                        const evDb = await pool.request()
                            .input('evId2', sql.BigInt, eventoId)
                            .query(`SELECT odd_casa, odd_empate, odd_fora FROM bet365_eventos WHERE id = @evId2`);
                        if (evDb.recordset.length > 0) {
                            oddCasa   = parseFloat(evDb.recordset[0].odd_casa)   || 0;
                            oddEmpate = parseFloat(evDb.recordset[0].odd_empate) || 0;
                            oddFora   = parseFloat(evDb.recordset[0].odd_fora)   || 0;
                        }
                    }

                    // 3. Fallback: usa a odd da seleção vencedora da aba de Resultados
                    if (!oddCasa && !oddEmpate && !oddFora) {
                        const ftMkt = res.mercados?.find(m =>
                            /resultado final|fulltime result|full time result/i.test(m.mercado)
                        );
                        if (ftMkt) {
                            const sel = (ftMkt.selecao || '').toLowerCase();
                            const casaNorm = (res.timeCasa || '').toLowerCase();
                            const foraNorm = (res.timeFora || '').toLowerCase();
                            if (sel === 'empate' || sel === 'draw') {
                                oddEmpate = ftMkt.odd || 0;
                            } else if (sel.includes(casaNorm) || casaNorm.includes(sel)) {
                                oddCasa = ftMkt.odd || 0;
                            } else if (sel.includes(foraNorm) || foraNorm.includes(sel)) {
                                oddFora = ftMkt.odd || 0;
                            } else {
                                if (res.resultado === 'CASA')   oddCasa   = ftMkt.odd || 0;
                                if (res.resultado === 'EMPATE') oddEmpate = ftMkt.odd || 0;
                                if (res.resultado === 'FORA')   oddFora   = ftMkt.odd || 0;
                            }
                        }
                    }

                    // Usa o horário da Bet365 (ex: "19:55") gravado como UTC explícito
                    // Assim o horário exibido no browser bate com o mostrado na Bet365
                    let dataPart = new Date();
                    if (res.horario && /^\d{1,2}[.:]\d{2}$/.test(res.horario)) {
                        const clean = res.horario.replace('.', ':');
                        const [hh, mm] = clean.split(':').map(Number);
                        const now = new Date();
                        // Monta como UTC: o horário da Bet365 IS o UTC
                        let ms = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0, 0);
                        // Bet365 BR exibe horários em UTC+1 (~1h à frente do UTC real)
                        // Buffer de 90 min evita que jogos recentes sejam salvos como "ontem"
                        if (ms > Date.now() + 90 * 60000) ms -= 86400000;
                        dataPart = new Date(ms);
                    }

                    const reqHist = pool.request()
                        .input('evId',      sql.BigInt,       eventoId)
                        .input('liga',      sql.NVarChar(200), res.liga)
                        .input('timeCasa',  sql.NVarChar(100), res.timeCasa)
                        .input('timeFora',  sql.NVarChar(100), res.timeFora)
                        .input('golCasa',   sql.Int,           res.golCasa)
                        .input('golFora',   sql.Int,           res.golFora)
                        .input('golCasaHT', sql.TinyInt,       res.golCasaHT ?? null)
                        .input('golForaHT', sql.TinyInt,       res.golForaHT ?? null)
                        .input('resultado', sql.NVarChar(10),  res.resultado)
                        .input('oddCasa',   sql.Decimal(10,2), oddCasa)
                        .input('oddEmpate', sql.Decimal(10,2), oddEmpate)
                        .input('oddFora',   sql.Decimal(10,2), oddFora)
                        .input('dataPart',  sql.DateTime2,     dataPart);
                    await reqHist.query(`
                            MERGE bet365_historico_partidas AS t
                            USING (SELECT @evId AS evento_id) AS s ON t.evento_id = s.evento_id
                            WHEN MATCHED AND t.gol_casa = 0 AND t.gol_fora = 0 THEN UPDATE SET
                                t.gol_casa            = @golCasa,
                                t.gol_fora            = @golFora,
                                t.gol_casa_ht         = ISNULL(@golCasaHT, t.gol_casa_ht),
                                t.gol_fora_ht         = ISNULL(@golForaHT, t.gol_fora_ht),
                                t.resultado           = @resultado,
                                t.resultado_estimado  = 0,
                                t.odd_casa   = CASE WHEN t.odd_casa   = 0 THEN @oddCasa   ELSE t.odd_casa   END,
                                t.odd_empate = CASE WHEN t.odd_empate = 0 THEN @oddEmpate ELSE t.odd_empate END,
                                t.odd_fora   = CASE WHEN t.odd_fora   = 0 THEN @oddFora   ELSE t.odd_fora   END
                            WHEN NOT MATCHED THEN INSERT
                                (evento_id, liga, time_casa, time_fora, gol_casa, gol_fora,
                                 gol_casa_ht, gol_fora_ht,
                                 resultado, odd_casa, odd_empate, odd_fora, data_partida, resultado_estimado)
                            VALUES
                                (@evId, @liga, @timeCasa, @timeFora, @golCasa, @golFora,
                                 @golCasaHT, @golForaHT,
                                 @resultado, @oddCasa, @oddEmpate, @oddFora, @dataPart, 0);
                        `);
                    if (jaExiste && scoreZero) {
                        console.log(`   🔄 Score atualizado: ${res.timeCasa} ${res.golCasa}-${res.golFora} ${res.timeFora}`);
                    }
                    histOk++;
                }
            } catch (e) {
                console.error(`   ❌ Erro histórico ${res.timeCasa} x ${res.timeFora}: ${e.message}`);
            }
        }

        console.log(`   💾 Eventos: ${eventosOk} | Mercados: ${mercadosOk} | Odds: ${oddsOk} | Histórico: ${histOk} novo(s)`);
        return { eventosOk, mercadosOk, oddsOk, histOk };
    }

    // ─────────────────────────────────────────────────────────────
    // LOG DE COLETA
    // ─────────────────────────────────────────────────────────────

    async _logColeta(inicio, status, contadores, erro) {
        try {
            const pool = await this.conectarBanco();
            await pool.request()
                .input('inicio',     sql.DateTime2,    inicio)
                .input('fim',        sql.DateTime2,    new Date())
                .input('status',     sql.NVarChar(50), status)
                .input('eventos',    sql.Int,          contadores?.eventosOk    || 0)
                .input('mercados',   sql.Int,          contadores?.mercadosOk   || 0)
                .input('odds',       sql.Int,          contadores?.oddsOk       || 0)
                .input('resultados', sql.Int,          contadores?.histOk       || 0)
                .input('erro',       sql.NVarChar(sql.MAX), erro || null)
                .query(`
                    INSERT INTO bet365_log_coleta
                        (data_inicio, data_fim, status, eventos_coletados,
                         mercados_coletados, odds_coletadas, resultados_salvos, erro_mensagem)
                    VALUES
                        (@inicio, @fim, @status, @eventos,
                         @mercados, @odds, @resultados, @erro)
                `);
        } catch (e) {
            console.error('   ⚠️  Erro ao gravar log:', e.message);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // COLETA COMPLETA
    // ─────────────────────────────────────────────────────────────

    async coletar() {
        if (this.coletando) {
            console.log('⚠️  Bet365 - Coleta já em andamento, pulando...');
            return;
        }
        this.coletando = true;
        this._coletas++;

        const inicio = new Date();
        console.log(`\n============================================`);
        console.log(`🔄 Bet365 - Coleta #${this._coletas} - ${inicio.toLocaleTimeString('pt-BR')}`);
        console.log(`============================================`);

        try {
            // Reinicia browser a cada 30 coletas para evitar vazamento de memória
            if (this._coletas % 30 === 0 && this._coletas > 0) {
                console.log('   🔄 Reiniciando navegador (manutenção periódica)...');
                await this.fecharBrowser();
                this.pagesLiga = [];
            }

            await this.iniciarBrowser();

            // Primeira vez ou após reinício: login + navegação + abre abas por liga
            if (this.pagesLiga.length === 0) {
                await this.navegarParaPagina();
                await this._prepararAbas();
            }
            // Nas demais coletas: _coletarLiga() faz F5 individualmente em cada aba

            const dados = await this._extrairDados();
            const contadores = await this.salvarNoBanco(dados);
            await this._logColeta(inicio, 'SUCESSO', contadores, null);

            // Notifica clientes WebSocket
            if (typeof global.wsBroadcast === 'function') {
                global.wsBroadcast({
                    tipo: 'coleta', fonte: 'bet365',
                    novos: contadores.eventosOk,
                    resultadosSalvos: contadores.histOk,
                    timestamp: new Date().toISOString()
                });
            }

            console.log(`✅ Bet365 - Coleta concluída`);
        } catch (err) {
            console.error(`❌ Bet365 - Erro na coleta: ${err.message}`);
            await this._logColeta(inicio, 'ERRO', null, err.message);

            // Em caso de erro fatal do browser, reinicia
            if (err.message.includes('Session closed') ||
                err.message.includes('Target closed') ||
                err.message.includes('Protocol error') ||
                err.message.includes('Browser was closed') ||
                err.message.includes('Connection closed') ||
                err.message.includes('ECONNRESET') ||
                err.message.includes('not clickable') ||
                err.message.includes('not an Element') ||
                err.message.includes('detached') ||
                err.message.includes('Execution context')) {
                console.log('   🔄 Reiniciando navegador após erro...');
                await this.fecharBrowser();
                this.pagesLiga = [];
            }
        } finally {
            this.coletando = false;
        }
    }

    // ─────────────────────────────────────────────────────────────
    // ENCERRAR (chamado pelo scheduler ao parar)
    // ─────────────────────────────────────────────────────────────

    async encerrar() {
        await this.fecharBrowser();
        if (this.pool) {
            await this.pool.close().catch(() => {});
            this.pool = null;
        }
        console.log('🔒 Bet365 - Coletor encerrado');
    }
}

module.exports = Bet365Coletor;
