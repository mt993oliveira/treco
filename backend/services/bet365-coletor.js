/**
 * ============================================================
 * COLETOR BET365 - FUTEBOL VIRTUAL
 * URL: https://www.bet365.bet.br/#/AVR/B146/R%5E1/
 * ============================================================
 *
 * Conecta no Edge já aberto pelo usuário via remote debugging.
 * SEM login, SEM bot detection — usa o browser real do usuário.
 *
 * PRÉ-REQUISITO:
 *   Edge aberto via abrir-edge-debug.bat (porta 9222)
 *   com a página de futebol virtual carregada.
 *
 * Ligas: World Cup | Euro Cup | Premiership | Express Cup | Super Liga Sul-Americana
 * (Super League ignorada)
 * ============================================================
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const sql    = require('mssql');
const http   = require('http');
const dotenv = require('dotenv');
dotenv.config();

const fs   = require('fs');
const path = require('path');

const DEBUG_PORT        = parseInt(process.env.BET365_DEBUG_PORT) || 9222;
const SCREENSHOT_ATIVO  = process.env.BET365_SCREENSHOT === 'true';
const SCREENSHOT_DIAS   = parseInt(process.env.BET365_SCREENSHOT_DIAS) || 30;
const SCREENSHOT_DIR    = path.join(__dirname, '..', '..', 'img', 'screenshots');
const URL_SOCCER = 'https://www.bet365.bet.br/#/AVR/B146/R%5E1/';
const LIGAS_IGNORAR = ['super league'];

// Normaliza nomes de liga antes de gerar IDs e salvar no banco.
// Garante que a mesma liga não seja gravada com nomes diferentes.
const LIGA_NORMALIZAR = {
    'copa do mundo':             'World Cup',
    'world cup':                 'World Cup',
    'euro cup':                  'Euro Cup',
    'premiership':               'Premiership',
    'premier league':            'Premiership',
    'express cup':               'Express Cup',
    'south american super league': 'Super Liga Sul-Americana',
    'super liga sul-americana':  'Super Liga Sul-Americana',
};

function normalizarNomeLiga(nome) {
    return LIGA_NORMALIZAR[(nome || '').toLowerCase().trim()] || nome;
}

// Slots de minuto por liga (mesma convenção do frontend)
const LIGA_SLOTS = {
    'World Cup':                [1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58],
    'Euro Cup':                 [2,5,8,11,14,17,20,23,26,29,32,35,38,41,44,47,50,53,56,59],
    'Premiership':              [0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57],
    'Super Liga Sul-Americana': [1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58],
    'Express Cup':              Array.from({length: 60}, (_, i) => i),
};

// Snap de um Date ao slot de minuto mais próximo para a liga.
// Evita que resultados coletados com atraso de 1-3 min usem o minuto errado.
function snapMinutoSlot(dt, liga) {
    const slots = LIGA_SLOTS[liga];
    if (!slots) return dt; // liga desconhecida: sem snap
    const minReal = dt.getUTCMinutes();
    let bestMin = slots[0], bestDist = Infinity;
    for (const m of slots) {
        const d = Math.abs(m - minReal);
        if (d < bestDist) { bestDist = d; bestMin = m; }
    }
    if (bestMin === minReal) return dt; // já está no slot correto
    const snapped = new Date(dt.getTime());
    snapped.setUTCMinutes(bestMin, 0, 0);
    return snapped;
}

class Bet365Coletor {
    constructor() {
        this.url       = URL_SOCCER;
        this.browser   = null;
        this.page      = null;
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
        const h = this._hash(`${liga}|${timeCasa}|${timeFora}|${horario}`);
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
        await this._rodarMigracoes();
        return this.pool;
    }

    async _rodarMigracoes() {
        const migracoes = [
            `IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id=OBJECT_ID('bet365_resultados_mercados') AND type='U')
             CREATE TABLE bet365_resultados_mercados (
                 id            BIGINT        NOT NULL PRIMARY KEY,
                 evento_id     BIGINT        NOT NULL,
                 liga          NVARCHAR(200) NOT NULL,
                 time_casa     NVARCHAR(100) NOT NULL,
                 time_fora     NVARCHAR(100) NOT NULL,
                 data_partida  DATETIME2     NULL,
                 mercado       NVARCHAR(200) NOT NULL,
                 selecao       NVARCHAR(200) NOT NULL,
                 odd_paga      DECIMAL(10,2) NOT NULL DEFAULT 0,
                 data_registro DATETIME2     NOT NULL DEFAULT GETUTCDATE()
             )`,
            `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID('bet365_resultados_mercados') AND name='IX_b365_resmkt_evento')
             CREATE INDEX IX_b365_resmkt_evento ON bet365_resultados_mercados (evento_id)`,
            `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID('bet365_resultados_mercados') AND name='IX_b365_resmkt_liga_data')
             CREATE INDEX IX_b365_resmkt_liga_data ON bet365_resultados_mercados (liga, data_partida)`,
        ];
        for (const mig of migracoes) {
            await this.pool.query(mig).catch(e => console.warn('⚠️ Schema:', e.message));
        }
    }

    // ─────────────────────────────────────────────────────────────
    // CONEXÃO COM O EDGE (remote debugging)
    // ─────────────────────────────────────────────────────────────

    _getEdgeEndpoint() {
        return new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${DEBUG_PORT}/json/version`, res => {
                let data = '';
                res.on('data', d => data += d);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch(e) { reject(new Error('Resposta inválida do Edge debug')); }
                });
            }).on('error', () => reject(new Error(`Edge não encontrado na porta ${DEBUG_PORT}`)));
        });
    }

    async conectarBrowser() {
        // Verifica se já está conectado
        if (this.browser) {
            try {
                await this.browser.version();
                return; // ainda conectado
            } catch(_) {
                console.log('   ⚠️  Conexão com Edge perdida, reconectando...');
                this.browser   = null;
                this.pagesLiga = [];
            }
        }

        const endpoint = await this._getEdgeEndpoint();
        console.log(`🌐 Conectando ao Edge (${endpoint.Browser})...`);

        this.browser = await puppeteer.connect({
            browserWSEndpoint: endpoint.webSocketDebuggerUrl,
            defaultViewport: null
        });
        console.log('✅ Bet365 - Conectado ao Edge do usuário');
    }

    async encerrar() {
        if (this.browser) {
            this.browser.disconnect();
            this.browser = null;
            this.page    = null;
            console.log('🔌 Bet365 - Desconectado do Edge');
        }
        if (this.pool) {
            await this.pool.close().catch(() => {});
            this.pool = null;
        }
    }

    // ─────────────────────────────────────────────────────────────
    // SCREENSHOTS — captura tela dos resultados para validação
    // ─────────────────────────────────────────────────────────────

    async _tirarScreenshot(pg, ligaNome) {
        if (!SCREENSHOT_ATIVO) return;
        try {
            if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
            const agora    = new Date();
            const ts       = `${agora.getUTCFullYear()}-${String(agora.getUTCMonth()+1).padStart(2,'0')}-${String(agora.getUTCDate()).padStart(2,'0')}` +
                             `_${String(agora.getUTCHours()).padStart(2,'0')}-${String(agora.getUTCMinutes()).padStart(2,'0')}-${String(agora.getUTCSeconds()).padStart(2,'0')}`;
            const nomeLimpo = ligaNome.replace(/[^a-zA-Z0-9]/g, '_');
            const filename  = `${ts}_${nomeLimpo}.png`;
            await pg.screenshot({ path: path.join(SCREENSHOT_DIR, filename), fullPage: false });
            console.log(`   📸 Screenshot: ${filename}`);
        } catch(e) {
            console.warn(`   ⚠️  Screenshot falhou: ${e.message}`);
        }
    }

    _limparScreenshotsAntigos() {
        if (!SCREENSHOT_ATIVO) return;
        try {
            if (!fs.existsSync(SCREENSHOT_DIR)) return;
            const limite = Date.now() - SCREENSHOT_DIAS * 86400000;
            const files  = fs.readdirSync(SCREENSHOT_DIR).filter(f => f.endsWith('.png'));
            let removidos = 0;
            for (const f of files) {
                const fp   = path.join(SCREENSHOT_DIR, f);
                const stat = fs.statSync(fp);
                if (stat.mtimeMs < limite) { fs.unlinkSync(fp); removidos++; }
            }
            if (removidos > 0) console.log(`   🗑  ${removidos} screenshot(s) antigo(s) removido(s)`);
        } catch(e) {
            console.warn(`   ⚠️  Limpeza screenshots: ${e.message}`);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // NAVEGA E PREPARA ABAS POR LIGA
    // ─────────────────────────────────────────────────────────────

    async _encontrarOuAbrirPaginaVirtual() {
        const pages = await this.browser.pages();

        // Procura aba com futebol virtual já aberta
        let pg = pages.find(p => {
            try { return p.url().includes('bet365') && p.url().includes('AVR'); }
            catch(_) { return false; }
        });

        if (pg) {
            console.log(`   ✅ Aba virtual encontrada: ${pg.url()}`);
            return { page: pg, _criada: false };
        }

        // Procura qualquer aba da Bet365 e navega
        pg = pages.find(p => { try { return p.url().includes('bet365'); } catch(_) { return false; } });

        if (!pg) {
            // Cria nova aba
            pg = await this.browser.newPage();
            console.log('   🗂️  Nova aba criada');
        }

        console.log('   📡 Navegando para Futebol Virtual...');
        await pg.goto(this.url, { waitUntil: 'load', timeout: 60000 });
        await this._delay(6000);
        return { page: pg, _criada: true };
    }


    // ─────────────────────────────────────────────────────────────
    // EXTRAÇÃO DE MERCADOS
    // ─────────────────────────────────────────────────────────────

    async _extrairMercadosDoPagina(pg) {
        return await pg.evaluate(() => {
            const mercados = [];
            const bcText   = document.querySelector('.svc-MarketGroup_BookCloses span:last-child');
            const raceOff  = document.querySelector('.svc-MarketGroup_RaceOff');
            const countdown = raceOff ? 'EVENTO INICIADO' : (bcText ? bcText.textContent.trim() : null);

            const pods = document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup');
            for (const pod of pods) {
                const nomeBtn    = pod.querySelector('.gl-MarketGroupButton_Text');
                const nomeMercado = nomeBtn ? nomeBtn.textContent.trim() : 'Desconhecido';
                const selecoes   = [];

                // Padrão 1: StackedBorderless
                for (const el of pod.querySelectorAll('.srb-ParticipantStackedBorderless')) {
                    const nome = el.querySelector('.srb-ParticipantStackedBorderless_Name');
                    const odd  = el.querySelector('.srb-ParticipantStackedBorderless_Odds');
                    if (nome && odd) selecoes.push({ nome: nome.textContent.trim(), odd: parseFloat(odd.textContent.trim()) || 0, handicap: 0, coluna: '' });
                }

                // Padrão 2: ParticipantBorderless
                if (selecoes.length === 0) {
                    for (const el of pod.querySelectorAll('.gl-ParticipantBorderless')) {
                        const nome = el.querySelector('.gl-ParticipantBorderless_Name');
                        const odd  = el.querySelector('.gl-ParticipantBorderless_Odds');
                        if (nome && odd) selecoes.push({ nome: nome.textContent.trim(), odd: parseFloat(odd.textContent.trim()) || 0, handicap: 0, coluna: '' });
                    }
                }

                // Padrão 3: ResponsiveText
                if (selecoes.length === 0) {
                    for (const el of pod.querySelectorAll('.srb-ParticipantResponsiveText')) {
                        const nome = el.querySelector('.srb-ParticipantResponsiveText_Name');
                        const odd  = el.querySelector('.srb-ParticipantResponsiveText_Odds');
                        if (nome && odd) selecoes.push({ nome: nome.textContent.trim(), odd: parseFloat(odd.textContent.trim()) || 0, handicap: 0, coluna: '' });
                    }
                }

                // Padrão 4: tabela com colunas
                if (selecoes.length === 0) {
                    const labels = [...pod.querySelectorAll('.srb-ParticipantLabelCentered_Name, .srb-ParticipantLabel_Name')]
                        .map(el => el.textContent.trim());
                    for (const market of pod.querySelectorAll('.gl-Market')) {
                        const colHeader = market.querySelector('.gl-MarketColumnHeader');
                        const colNome   = colHeader ? colHeader.textContent.trim().replace(/\u00a0/g, '') : '';
                        if (!colNome) continue;
                        for (const el of market.querySelectorAll('.gl-ParticipantCentered')) {
                            const nome  = el.querySelector('.gl-ParticipantCentered_Name');
                            const handi = el.querySelector('.gl-ParticipantCentered_Handicap');
                            const oddEl = el.querySelector('.gl-ParticipantCentered_Odds');
                            if (oddEl) selecoes.push({ nome: (nome?.textContent.trim() || handi?.textContent.trim() || colNome), odd: parseFloat(oddEl.textContent.trim()) || 0, handicap: parseFloat(handi?.textContent.trim()) || 0, coluna: colNome });
                        }
                        market.querySelectorAll('.gl-ParticipantOddsOnly').forEach((el, idx) => {
                            const oddEl = el.querySelector('.gl-ParticipantOddsOnly_Odds');
                            if (oddEl) selecoes.push({ nome: labels[idx] || `Linha ${idx + 1}`, odd: parseFloat(oddEl.textContent.trim()) || 0, handicap: 0, coluna: colNome });
                        });
                    }
                }

                if (selecoes.length > 0) mercados.push({ nome: nomeMercado, selecoes });
            }
            return { countdown, mercados };
        });
    }

    async _extrairInfoJogo(liga, pg) {
        return await pg.evaluate((liga) => {
            const timeBtn  = document.querySelector('.vr-EventTimesNavBarButton-selected .vr-EventTimesNavBarButton_Text');
            const horario  = timeBtn ? timeBtn.textContent.trim() : null;
            const nomes    = [];
            const ftPod    = [...document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup')]
                .find(p => { const txt = p.querySelector('.gl-MarketGroupButton_Text')?.textContent.trim(); return txt === 'Fulltime Result' || txt === 'Resultado Final'; });
            if (ftPod) {
                for (const n of ftPod.querySelectorAll('.srb-ParticipantStackedBorderless_Name')) {
                    const t = n.textContent.trim();
                    if (t && t !== 'Draw' && t !== 'Empate') nomes.push(t);
                }
            }
            const bcText   = document.querySelector('.svc-MarketGroup_BookCloses span:last-child');
            const raceOff  = document.querySelector('.svc-MarketGroup_RaceOff');
            const countdown = raceOff ? 'EVENTO INICIADO' : (bcText ? bcText.textContent.trim() : null);
            return { liga, horario, timeCasa: nomes[0] || null, timeFora: nomes[1] || null, countdown };
        }, liga);
    }

    async _extrairResultados(liga, pg) {
        return await pg.evaluate((liga) => {
            const resultados = [];
            for (const grupo of document.querySelectorAll('.vrr-HeadToHeadMarketGroup')) {
                const eventLabel   = grupo.querySelector('.vrr-FixtureDetails_Event');
                const horarioMatch = (eventLabel?.textContent.trim() || '').match(/(\d{1,2}[.:]\d{2})$/);
                const horario      = horarioMatch ? horarioMatch[1] : null;
                const t1El         = grupo.querySelector('.vrr-HTHTeamDetails_TeamOne');
                const t2El         = grupo.querySelector('.vrr-HTHTeamDetails_TeamTwo');
                const scEl         = grupo.querySelector('.vrr-HTHTeamDetails_Score');
                if (!t1El || !t2El || !scEl) continue;

                const timeCasa  = t1El.textContent.trim();
                const timeFora  = t2El.textContent.trim();
                const placar    = scEl.textContent.trim().replace(/\s+/g, '');
                const parts     = placar.split(/[-–]/);
                const gcParse   = parseInt(parts[0]);
                const gfParse   = parseInt(parts[1]);
                // Quando a Bet365 não exibe o placar (5+ gols) o score vem como " - "
                const placarOculto = isNaN(gcParse) || isNaN(gfParse);
                const golCasa   = placarOculto ? 5 : (gcParse || 0);
                const golFora   = placarOculto ? 0 : (gfParse || 0);
                const resultado = placarOculto ? 'OCULTO'
                    : golCasa > golFora ? 'CASA' : golFora > golCasa ? 'FORA' : 'EMPATE';

                const mercados = [];

                // Padrão 1: vrr-HeadToHeadParticipant (mercados em linha: nome + vencedor + odd)
                for (const p of grupo.querySelectorAll('.vrr-HeadToHeadParticipant')) {
                    const mkt = p.querySelector('.vrr-HeadToHeadParticipant_Market');
                    const win = p.querySelector('.vrr-HeadToHeadParticipant_Winner');
                    const prc = p.querySelector('.vrr-HeadToHeadParticipant_Price');
                    if (mkt && win) mercados.push({ mercado: mkt.textContent.trim(), selecao: win.textContent.trim(), odd: prc ? parseFloat(prc.textContent.trim()) || 0 : 0 });
                }


                let golCasaHT = null, golForaHT = null;
                for (const m of mercados) {
                    if (/intervalo.*correto|half.?time correct/i.test(m.mercado)) {
                        const htMatch = m.selecao.match(/^(\d+)\s*[-–]\s*(\d+)$/);
                        if (htMatch) { golCasaHT = parseInt(htMatch[1]); golForaHT = parseInt(htMatch[2]); }
                        break;
                    }
                }

                resultados.push({ liga, horario, timeCasa, timeFora, placar, golCasa, golFora, golCasaHT, golForaHT, resultado, mercados, placarOculto });
            }
            return resultados;
        }, liga);
    }

    // ─────────────────────────────────────────────────────────────
    // COLETA DE UMA LIGA (F5 + extração)
    // ─────────────────────────────────────────────────────────────

    async _coletarLiga(pg, liga) {
        const eventos    = [];
        const resultados = [];

        // Resultados — clica "Show More" várias vezes para pegar todos da sessão
        const temBtnRes = await pg.evaluate(() => !!document.querySelector('.vr-ResultsNavBarButton'));
        if (temBtnRes) {
            await pg.evaluate(() => document.querySelector('.vr-ResultsNavBarButton')?.click());
            await this._delay(2000);
            // Clica Show More até 10 vezes para garantir cobertura ampla de resultados
            for (let sm = 0; sm < 10; sm++) {
                const temMore = await pg.evaluate(() => !!document.querySelector('.vrr-ShowMoreButton_Link'));
                if (!temMore) break;
                await pg.evaluate(() => document.querySelector('.vrr-ShowMoreButton_Link')?.click());
                await this._delay(800);
            }
            // Expande mercados ocultos em cada card de resultado (clica "Mostrar Mais" interno)
            const totalMaisInternos = await pg.evaluate(() => {
                const btns = [...document.querySelectorAll('.vrr-HeadToHeadMarketGroup .vrr-ShowMoreButton_Link')];
                btns.forEach(b => b.click());
                return btns.length;
            });
            if (totalMaisInternos > 0) {
                console.log(`   🔽 [${normalizarNomeLiga(liga.nome)}] Expandindo ${totalMaisInternos} card(s) de resultado...`);
                await this._delay(1500);
            }

            const res = await this._extrairResultados(normalizarNomeLiga(liga.nome), pg);
            resultados.push(...res);
            console.log(`   📋 [${normalizarNomeLiga(liga.nome)}] ${res.length} resultado(s)`);


            // Screenshot para validação dos resultados
            await this._tirarScreenshot(pg, normalizarNomeLiga(liga.nome));

            // Volta para próximos — clica pelo nome para garantir a aba certa
            await pg.evaluate((nomeLiga) => {
                const tabs = document.querySelectorAll('.vrl-MeetingsHeaderButton');
                for (const tab of tabs) {
                    const txt = tab.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim();
                    if (txt === nomeLiga) { tab.click(); return; }
                }
            }, liga.nome);
            await this._delay(2000);
        }

        // Próximos jogos — aguarda botões de horário aparecerem (até 8s)
        let numHorarios = 0;
        for (let t = 0; t < 8; t++) {
            numHorarios = await pg.evaluate(() => document.querySelectorAll('.vr-EventTimesNavBarButton').length);
            if (numHorarios > 0) break;
            await this._delay(1000);
        }
        console.log(`   ⏰ [${liga.nome}] ${numHorarios} horário(s)`);

        for (let i = 0; i < numHorarios; i++) {
            const ok = await pg.evaluate((idx) => {
                const btns = document.querySelectorAll('.vr-EventTimesNavBarButton');
                if (btns[idx]) { btns[idx].click(); return true; }
                return false;
            }, i);
            if (!ok) continue;
            await this._delay(1500);

            // Aguarda mercados
            let temMkt = false;
            for (let t = 0; t < 16; t++) {
                temMkt = await pg.evaluate(() => document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup').length > 0).catch(() => false);
                if (temMkt) break;
                await this._delay(500);
            }
            if (!temMkt) continue;

            const infoJogo = await this._extrairInfoJogo(liga.nome, pg);
            if (!infoJogo.timeCasa || !infoJogo.timeFora) continue;

            const { mercados, countdown } = await this._extrairMercadosDoPagina(pg);
            const ftMkt    = mercados.find(m => /Fulltime Result|Resultado Final/i.test(m.nome));
            const oddCasa   = ftMkt?.selecoes[0]?.odd || 0;
            const oddEmpate = ftMkt?.selecoes[1]?.odd || 0;
            const oddFora   = ftMkt?.selecoes[2]?.odd || 0;

            const horario    = infoJogo.horario || countdown;
            const ligaNormal = normalizarNomeLiga(liga.nome);
            const eventoId   = this._gerarId(ligaNormal, infoJogo.timeCasa, infoJogo.timeFora, horario);

            eventos.push({ eventoId, liga: ligaNormal, timeCasa: infoJogo.timeCasa, timeFora: infoJogo.timeFora, horario, countdown, oddCasa, oddEmpate, oddFora, mercados });
            console.log(`      ✅ [${ligaNormal}] ${infoJogo.timeCasa} x ${infoJogo.timeFora} [${horario}]`);
        }

        return { eventos, resultados };
    }

    // ─────────────────────────────────────────────────────────────
    // COLETA PARALELA — todas as ligas
    // ─────────────────────────────────────────────────────────────

    async _extrairDados(pg) {
        // Lê as ligas disponíveis na aba atual
        const ligas = await pg.evaluate(() =>
            [...document.querySelectorAll('.vrl-MeetingsHeaderButton')].map((el, idx) => {
                const t = el.querySelector('.vrl-MeetingsHeaderButton_Title');
                return { idx, nome: t ? t.textContent.trim() : `Liga${idx}` };
            })
        );

        // Filtra apenas as ignoradas (percorre todas, inclusive duplicatas)
        const ligasFiltradas = ligas.filter(l =>
            !LIGAS_IGNORAR.some(ig => l.nome.toLowerCase().includes(ig))
        );

        console.log(`   ✅ ${ligasFiltradas.length} liga(s): ${ligasFiltradas.map(l => l.nome).join(' | ')}`);

        const todosEventos    = [];
        const todosResultados = [];
        const contadoresTotal = { eventosOk: 0, mercadosOk: 0, oddsOk: 0, histOk: 0 };

        // Limpeza de screenshots antigos no início de cada ciclo
        this._limparScreenshotsAntigos();

        for (let i = 0; i < ligasFiltradas.length; i++) {
            const liga = ligasFiltradas[i];

            // Clica na aba PELO NOME (não pelo índice) — evita erro após F5
            const clicou = await pg.evaluate((nomeLiga) => {
                const tabs = document.querySelectorAll('.vrl-MeetingsHeaderButton');
                for (const tab of tabs) {
                    const txt = tab.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim();
                    if (txt === nomeLiga) { tab.click(); return true; }
                }
                return false;
            }, liga.nome);
            if (!clicou) { console.log(`   ⚠️  [${liga.nome}] Tab não encontrada pelo nome`); continue; }
            await this._delay(3000); // aguarda conteúdo da aba carregar

            try {
                const { eventos, resultados } = await this._coletarLiga(pg, liga);
                todosEventos.push(...eventos);
                todosResultados.push(...resultados);

                // ── Commit por liga — salva imediatamente após coletar cada liga ──
                console.log(`   💾 [${normalizarNomeLiga(liga.nome)}] Salvando no banco...`);
                const cont = await this.salvarNoBanco({ eventos, resultados });
                contadoresTotal.eventosOk  += cont.eventosOk;
                contadoresTotal.mercadosOk += cont.mercadosOk;
                contadoresTotal.oddsOk     += cont.oddsOk;
                contadoresTotal.histOk     += cont.histOk;
            } catch(err) {
                console.log(`   ❌ [${liga.nome}] Erro: ${err.message}`);
            }

            // Ctrl+F5 (hard refresh) após cada liga — limpa cache e garante estado limpo
            console.log(`   🔄 [${liga.nome}] Ctrl+F5 — hard refresh...`);
            for (let r = 1; r <= 3; r++) {
                try {
                    await pg.setCacheEnabled(false);                          // desativa cache (= Ctrl+F5)
                    await pg.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                    await pg.setCacheEnabled(true);                           // reativa cache
                    await this._delay(4000);                                  // aguarda JS da Bet365 inicializar
                    await pg.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: 20000 });
                    break; // ligas apareceram, continua para próxima liga
                } catch(e) {
                    await pg.setCacheEnabled(true).catch(() => {});           // garante que cache não fica desativado
                    console.log(`   ⚠️  Ligas não apareceram após Ctrl+F5 (${r}/3), tentando novamente...`);
                    if (r === 3) console.log('   ❌ Não foi possível recarregar. Próxima liga pode falhar.');
                }
            }
        }

        console.log(`\n   ✅ Total: ${todosEventos.length} evento(s), ${todosResultados.length} resultado(s)`);
        return { eventos: todosEventos, resultados: todosResultados, contadores: contadoresTotal };
    }

    // ─────────────────────────────────────────────────────────────
    // SALVAR NO BANCO
    // ─────────────────────────────────────────────────────────────

    async salvarNoBanco(dados) {
        const pool = await this.conectarBanco();
        const { eventos, resultados } = dados;
        let eventosOk = 0, mercadosOk = 0, oddsOk = 0;

        const ligasPresentes = [...new Set(eventos.map(e => e.liga))];
        for (const ligaNome of ligasPresentes) {
            await pool.request().input('liga', sql.NVarChar(200), ligaNome)
                .query(`UPDATE bet365_eventos SET ativo = 0 WHERE league_name = @liga`);
        }
        await pool.request().query(`UPDATE bet365_eventos SET ativo = 0 WHERE start_time_datetime < DATEADD(HOUR, -3, GETUTCDATE())`);

        for (const ev of eventos) {
            try {
                let startDt = null;
                if (ev.horario && /^\d{1,2}[.:]\d{2}$/.test(ev.horario)) {
                    const [h, m] = ev.horario.replace('.', ':').split(':').map(Number);
                    // Convenção: salva o horário da Bet365 diretamente como UTC.
                    // O frontend lê UTC e exibe como está — sem conversão de fuso.
                    let ms = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate(), h, m, 0, 0);
                    // Bet365 exibe UTC+1 (BST). O "agora" na convenção armazenada é Date.now()+1h.
                    // Rollover: compara contra esse "now Bet365" para não errar o dia.
                    const nowB365 = Date.now() + 1 * 3600000;
                    if (ms > nowB365 + 90 * 60000) ms -= 86400000; // muito futuro → era ontem
                    if (ms < nowB365 - 30 * 60000) ms += 86400000; // >30min atrás → é amanhã
                    startDt = new Date(ms);
                }
                const agora = new Date();
                await pool.request()
                    .input('id',      sql.BigInt,        ev.eventoId)
                    .input('url',     sql.NVarChar(500),  this.url)
                    .input('league',  sql.NVarChar(200),  ev.liga)
                    .input('timeCasa',sql.NVarChar(100),  ev.timeCasa)
                    .input('timeFora',sql.NVarChar(100),  ev.timeFora)
                    .input('status',  sql.NVarChar(50),   'AGENDADO')
                    .input('startDt', sql.DateTime2,      startDt)
                    .input('oddCasa', sql.Decimal(10,2),  ev.oddCasa || 0)
                    .input('oddEmp',  sql.Decimal(10,2),  ev.oddEmpate || 0)
                    .input('oddFora', sql.Decimal(10,2),  ev.oddFora || 0)
                    .input('coleta',  sql.DateTime2,      agora)
                    .query(`
                        MERGE bet365_eventos AS t
                        USING (SELECT @id AS id) AS s ON t.id = s.id
                        WHEN MATCHED THEN UPDATE SET
                            t.league_name=@league, t.time_casa=@timeCasa, t.time_fora=@timeFora,
                            t.status=@status, t.start_time_datetime=@startDt,
                            t.odd_casa=@oddCasa, t.odd_empate=@oddEmp, t.odd_fora=@oddFora,
                            t.data_atualizacao=@coleta, t.ativo=1
                        WHEN NOT MATCHED THEN INSERT
                            (id,url,league_name,time_casa,time_fora,status,start_time_datetime,
                             odd_casa,odd_empate,odd_fora,data_coleta,data_atualizacao,ativo)
                        VALUES (@id,@url,@league,@timeCasa,@timeFora,@status,@startDt,
                                @oddCasa,@oddEmp,@oddFora,@coleta,@coleta,1);
                    `);
                eventosOk++;

                await pool.request().input('evId', sql.BigInt, ev.eventoId)
                    .query(`UPDATE bet365_mercados SET ativo = 0 WHERE evento_id = @evId`);

                for (const mkt of ev.mercados) {
                    const mktId = this._gerarMercadoId(ev.eventoId, mkt.nome);
                    await pool.request()
                        .input('id',    sql.BigInt,       mktId)
                        .input('evId',  sql.BigInt,       ev.eventoId)
                        .input('nome',  sql.NVarChar(200), mkt.nome)
                        .input('tipo',  sql.NVarChar(50),  mkt.nome.replace(/\s+/g,'_').toUpperCase().substring(0,50))
                        .input('coleta',sql.DateTime2,     new Date())
                        .query(`
                            MERGE bet365_mercados AS t USING (SELECT @id AS id) AS s ON t.id=s.id
                            WHEN MATCHED THEN UPDATE SET t.ativo=1, t.data_coleta=@coleta
                            WHEN NOT MATCHED THEN INSERT (id,evento_id,nome,tipo,data_coleta,ativo)
                            VALUES (@id,@evId,@nome,@tipo,@coleta,1);
                        `);
                    mercadosOk++;

                    await pool.request().input('mId', sql.BigInt, mktId)
                        .query(`UPDATE bet365_odds SET ativo = 0 WHERE mercado_id = @mId`);

                    for (const sel of mkt.selecoes) {
                        if (!sel.odd || sel.odd <= 0) continue;
                        const oddId = this._gerarOddId(mktId, sel.nome, sel.handicap);
                        await pool.request()
                            .input('id',    sql.BigInt,       oddId)
                            .input('mId',   sql.BigInt,       mktId)
                            .input('evId',  sql.BigInt,       ev.eventoId)
                            .input('nome',  sql.NVarChar(100), (sel.nome||'').substring(0,100))
                            .input('full',  sql.NVarChar(200), (`${sel.coluna} ${sel.nome}`.trim()).substring(0,200))
                            .input('valor', sql.Decimal(10,2), sel.odd)
                            .input('handi', sql.Decimal(10,2), sel.handicap||0)
                            .input('coleta',sql.DateTime2,     new Date())
                            .query(`
                                MERGE bet365_odds AS t USING (SELECT @id AS id) AS s ON t.id=s.id
                                WHEN MATCHED THEN UPDATE SET t.valor=@valor, t.ativo=1, t.data_coleta=@coleta
                                WHEN NOT MATCHED THEN INSERT
                                    (id,mercado_id,evento_id,nome,full_name,valor,handicap,data_coleta,ativo)
                                VALUES (@id,@mId,@evId,@nome,@full,@valor,@handi,@coleta,1);
                            `);
                        oddsOk++;
                    }
                }
            } catch(e) {
                console.error(`   ❌ Erro salvando ${ev.timeCasa} x ${ev.timeFora}: ${e.message}`);
            }
        }

        for (const res of resultados) {
            try {
                // ── 1. Busca start_time_datetime + odds no banco (fonte autoritativa) ──
                // res.horario vem de um seletor errado e retorna valores como "0.55" (odds),
                // portanto usamos start_time_datetime de bet365_eventos como hora real do jogo.
                let dataPart = null;
                let oddCasa = 0, oddEmpate = 0, oddFora = 0;

                const evDb = await pool.request()
                    .input('liga2',     sql.NVarChar(200), res.liga)
                    .input('timeCasa2', sql.NVarChar(100), res.timeCasa)
                    .input('timeFora2', sql.NVarChar(100), res.timeFora)
                    .query(`
                        SELECT TOP 1 id, start_time_datetime, odd_casa, odd_empate, odd_fora
                        FROM bet365_eventos
                        WHERE league_name = @liga2
                          AND time_casa   = @timeCasa2
                          AND time_fora   = @timeFora2
                          -- Bet365 armazena UTC+1: janela de -3h a +65min em relação ao UTC real
                          AND start_time_datetime BETWEEN DATEADD(HOUR,-3,GETUTCDATE()) AND DATEADD(MINUTE,65,GETUTCDATE())
                        ORDER BY start_time_datetime DESC
                    `);

                // eventoIdFixo: quando encontramos o evento, usamos o ID dele diretamente.
                // Isso garante que bet365_historico.evento_id = bet365_eventos.id,
                // permitindo JOIN correto para buscar mercados e odds completos.
                let eventoIdFixo = null;
                if (evDb.recordset.length > 0) {
                    const ev = evDb.recordset[0];
                    eventoIdFixo = ev.id;
                    oddCasa   = parseFloat(ev.odd_casa)   || 0;
                    oddEmpate = parseFloat(ev.odd_empate) || 0;
                    oddFora   = parseFloat(ev.odd_fora)   || 0;
                    if (ev.start_time_datetime) dataPart = new Date(ev.start_time_datetime);
                }

                // Fallback 1: memória do ciclo atual
                if (!oddCasa && !oddEmpate && !oddFora) {
                    const evMem = eventos.find(e =>
                        e.liga === res.liga &&
                        e.timeCasa === res.timeCasa &&
                        e.timeFora === res.timeFora
                    );
                    if (evMem) { oddCasa = evMem.oddCasa; oddEmpate = evMem.oddEmpate; oddFora = evMem.oddFora; }
                }

                // Fallback: sem start_time do evento → usa "Bet365 agora" (UTC+1) snapado ao slot da liga
                if (!dataPart) {
                    dataPart = new Date(Date.now() + 1 * 3600000);
                    dataPart.setUTCSeconds(0, 0);
                    dataPart = snapMinutoSlot(dataPart, res.liga);
                }

                // Usa o ID do evento encontrado (garante JOIN com bet365_eventos).
                // Fallback: gera hash por data+hora (para resultados sem evento correspondente).
                const dataKey = `${dataPart.getUTCFullYear()}-${String(dataPart.getUTCMonth()+1).padStart(2,'0')}-${String(dataPart.getUTCDate()).padStart(2,'0')}`;
                const timeKey = `${String(dataPart.getUTCHours()).padStart(2,'0')}:${String(dataPart.getUTCMinutes()).padStart(2,'0')}`;
                let eventoId;
                if (eventoIdFixo) {
                    eventoId = eventoIdFixo;
                } else {
                    eventoId = this._gerarId(res.liga, res.timeCasa, res.timeFora, `${dataKey}|${timeKey}`);
                }

                // ── 2. Salva mercados pagos (sempre — independente de o histórico já existir) ──
                for (const mkt of (res.mercados || [])) {
                    if (!mkt.mercado || !mkt.selecao) continue;
                    const mktId = this._gerarMercadoId(eventoId, `resultado|${mkt.mercado}|${mkt.selecao}`);
                    await pool.request()
                        .input('id',       sql.BigInt,        mktId)
                        .input('eventoId', sql.BigInt,        eventoId)
                        .input('liga',     sql.NVarChar(200), res.liga)
                        .input('timeCasa', sql.NVarChar(100), res.timeCasa)
                        .input('timeFora', sql.NVarChar(100), res.timeFora)
                        .input('dataPart', sql.DateTime2,     dataPart)
                        .input('mercado',  sql.NVarChar(200), mkt.mercado)
                        .input('selecao',  sql.NVarChar(200), mkt.selecao)
                        .input('oddPaga',  sql.Decimal(10,2), mkt.odd || 0)
                        .query(`
                            MERGE bet365_resultados_mercados AS t
                            USING (SELECT @id AS id) AS s ON t.id = s.id
                            WHEN NOT MATCHED THEN INSERT
                                (id, evento_id, liga, time_casa, time_fora, data_partida, mercado, selecao, odd_paga)
                            VALUES (@id, @eventoId, @liga, @timeCasa, @timeFora, @dataPart, @mercado, @selecao, @oddPaga);
                        `);
                }

                // ── 3. Log do resultado salvo via mercados ──
                console.log(`   ✅ Mercados: [${res.liga}] ${res.timeCasa} × ${res.timeFora} (UTC ${timeKey}) — ${(res.mercados||[]).length} mercado(s)`);
            } catch(e) {
                console.error(`   ❌ Erro histórico ${res.timeCasa} x ${res.timeFora}: ${e.message}`);
            }
        }

        console.log(`   💾 Eventos:${eventosOk} | Mercados:${mercadosOk} | Odds:${oddsOk}`);
        return { eventosOk, mercadosOk, oddsOk };
    }

    // ─────────────────────────────────────────────────────────────
    // LOG DE COLETA
    // ─────────────────────────────────────────────────────────────

    async _logColeta(inicio, status, contadores, erro) {
        try {
            const pool = await this.conectarBanco();
            await pool.request()
                .input('inicio',    sql.DateTime2,       inicio)
                .input('fim',       sql.DateTime2,       new Date())
                .input('status',    sql.NVarChar(50),    status)
                .input('eventos',   sql.Int,             contadores?.eventosOk  || 0)
                .input('mercados',  sql.Int,             contadores?.mercadosOk || 0)
                .input('odds',      sql.Int,             contadores?.oddsOk     || 0)
                .input('resultados',sql.Int,             contadores?.histOk     || 0)
                .input('erro',      sql.NVarChar(sql.MAX), erro || null)
                .query(`
                    INSERT INTO bet365_log_coleta
                        (data_inicio,data_fim,status,eventos_coletados,mercados_coletados,odds_coletadas,resultados_salvos,erro_mensagem)
                    VALUES (@inicio,@fim,@status,@eventos,@mercados,@odds,@resultados,@erro)
                `);
        } catch(e) {
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
            await this.conectarBrowser();

            // Garante que temos a aba correta
            if (!this.page || this.page.isClosed()) {
                const { page } = await this._encontrarOuAbrirPaginaVirtual();
                this.page = page;
            }

            // Aguarda ligas — com até 3 tentativas de reload automático
            console.log('   ⏳ Aguardando ligas...');
            let ligasOk = false;
            for (let tentativa = 1; tentativa <= 3; tentativa++) {
                try {
                    await this.page.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: 20000 });
                    ligasOk = true;
                    break;
                } catch(e) {
                    console.log(`   ⚠️  Ligas não apareceram (tentativa ${tentativa}/3) — Ctrl+F5...`);
                    try {
                        await this.page.setCacheEnabled(false);
                        await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                        await this.page.setCacheEnabled(true);
                        await this._delay(4000);
                    } catch(reloadErr) {
                        await this.page.setCacheEnabled(true).catch(() => {});
                        console.log(`   ⚠️  Reload falhou: ${reloadErr.message}`);
                    }
                }
            }
            if (!ligasOk) {
                throw new Error('Ligas não apareceram após 3 tentativas — verifique se a página está aberta no Edge');
            }

            const { contadores } = await this._extrairDados(this.page);
            await this._logColeta(inicio, 'SUCESSO', contadores, null);

            if (typeof global.wsBroadcast === 'function') {
                global.wsBroadcast({ tipo: 'coleta', fonte: 'bet365', novos: contadores.eventosOk, resultadosSalvos: contadores.histOk, timestamp: new Date().toISOString() });
            }

            console.log(`✅ Bet365 - Coleta concluída`);

        } catch(err) {
            console.error(`❌ Bet365 - Erro: ${err.message}`);
            await this._logColeta(inicio, 'ERRO', null, err.message);

            // Se perdeu conexão com o Edge, reseta
            if (err.message.includes('Session closed') || err.message.includes('Target closed') ||
                err.message.includes('Protocol error') || err.message.includes('Connection closed') ||
                err.message.includes('ECONNRESET') || err.message.includes('detached') ||
                err.message.includes('não encontrado')) {
                console.log('   🔄 Resetando conexão...');
                this.browser = null;
                this.page    = null;
            }
        } finally {
            this.coletando = false;
        }
    }
}

module.exports = Bet365Coletor;
