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
 * Ligas: World Cup | Euro Cup | Premiership | Super League
 * (Express Cup ignorada)
 * ============================================================
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const sql    = require('mssql');
const http   = require('http');
const dotenv = require('dotenv');
dotenv.config();

const DEBUG_PORT = parseInt(process.env.BET365_DEBUG_PORT) || 9222;
const URL_SOCCER = 'https://www.bet365.bet.br/#/AVR/B146/R%5E1/';
const LIGAS_IGNORAR = ['express cup'];

class Bet365Coletor {
    constructor() {
        this.url       = URL_SOCCER;
        this.browser   = null;
        this.pagesLiga = [];
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
            `IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bet365_historico_partidas') AND name='resultado_estimado')
             ALTER TABLE bet365_historico_partidas ADD resultado_estimado BIT NOT NULL DEFAULT 0`,
            `IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bet365_historico_partidas') AND name='gol_casa_ht')
             ALTER TABLE bet365_historico_partidas ADD gol_casa_ht TINYINT NULL`,
            `IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bet365_historico_partidas') AND name='gol_fora_ht')
             ALTER TABLE bet365_historico_partidas ADD gol_fora_ht TINYINT NULL`,
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
            // Fecha abas extras que criamos (não a principal do usuário)
            for (const entry of this.pagesLiga) {
                if (entry._criada && !entry.page.isClosed()) {
                    await entry.page.close().catch(() => {});
                }
            }
            this.pagesLiga = [];
            this.browser.disconnect();
            this.browser = null;
            console.log('🔌 Bet365 - Desconectado do Edge');
        }
        if (this.pool) {
            await this.pool.close().catch(() => {});
            this.pool = null;
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

    async _prepararAbas() {
        // Encontra/abre a página base
        const base = await this._encontrarOuAbrirPaginaVirtual();
        const pgBase = base.page;

        // Aguarda abas de liga
        console.log('   ⏳ Aguardando ligas...');
        try {
            await pgBase.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: 30000 });
        } catch(e) {
            console.log('   ❌ Ligas não apareceram — verifique se a página está aberta no Edge');
            return;
        }

        const ligas = await pgBase.evaluate(() =>
            [...document.querySelectorAll('.vrl-MeetingsHeaderButton')].map((el, idx) => {
                const t = el.querySelector('.vrl-MeetingsHeaderButton_Title');
                return { idx, nome: t ? t.textContent.trim() : `Liga${idx}` };
            })
        );

        const ligasFiltradas = ligas.filter(l =>
            !LIGAS_IGNORAR.some(ig => l.nome.toLowerCase().includes(ig))
        );

        console.log(`   ✅ ${ligasFiltradas.length} liga(s): ${ligasFiltradas.map(l => l.nome).join(' | ')}`);

        // Fecha abas antigas que criamos
        for (const entry of this.pagesLiga) {
            if (entry._criada && !entry.page.isClosed()) {
                await entry.page.close().catch(() => {});
            }
        }
        this.pagesLiga = [];

        // Aba da 1ª liga: reutiliza pgBase
        // Demais ligas: abre nova aba no Edge do usuário
        for (let i = 0; i < ligasFiltradas.length; i++) {
            const liga = ligasFiltradas[i];
            let pg, criada;

            if (i === 0) {
                pg = pgBase;
                criada = base._criada;
            } else {
                pg = await this.browser.newPage();
                pg.on('pageerror', () => {});
                pg.on('requestfailed', () => {});
                await pg.goto(this.url, { waitUntil: 'load', timeout: 60000 });
                await this._delay(4000);
                await pg.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: 20000 }).catch(() => {});
                criada = true;
            }

            // Clica na aba desta liga
            await pg.evaluate((idx) => {
                document.querySelectorAll('.vrl-MeetingsHeaderButton')[idx]?.click();
            }, liga.idx);
            await this._delay(1500);

            this.pagesLiga.push({ page: pg, liga, _criada: criada });
            console.log(`   ✅ Aba ${i + 1}/${ligasFiltradas.length}: ${liga.nome}`);
        }
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
                const golCasa   = parseInt(parts[0]) || 0;
                const golFora   = parseInt(parts[1]) || 0;
                const resultado = golCasa > golFora ? 'CASA' : golFora > golCasa ? 'FORA' : 'EMPATE';

                const mercados = [];
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

                resultados.push({ liga, horario, timeCasa, timeFora, placar, golCasa, golFora, golCasaHT, golForaHT, resultado, mercados });
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

        // F5 na aba desta liga
        await pg.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await this._delay(3000);

        try { await pg.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: 20000 }); }
        catch(e) { console.log(`   ⚠️  [${liga.nome}] Tabs não apareceram após F5`); return { eventos, resultados }; }

        // Clica na aba desta liga
        const clicou = await pg.evaluate((idx) => {
            const tabs = document.querySelectorAll('.vrl-MeetingsHeaderButton');
            if (tabs[idx]) { tabs[idx].click(); return true; }
            return false;
        }, liga.idx);
        if (!clicou) return { eventos, resultados };
        await this._delay(1500);

        // Resultados
        const temBtnRes = await pg.evaluate(() => !!document.querySelector('.vr-ResultsNavBarButton'));
        if (temBtnRes) {
            await pg.evaluate(() => document.querySelector('.vr-ResultsNavBarButton')?.click());
            await this._delay(2000);
            await pg.evaluate(() => document.querySelector('.vrr-ShowMoreButton_Link')?.click());
            await this._delay(1000);
            const res = await this._extrairResultados(liga.nome, pg);
            resultados.push(...res);
            console.log(`   📋 [${liga.nome}] ${res.length} resultado(s)`);

            // Volta para próximos
            await pg.evaluate((idx) => document.querySelectorAll('.vrl-MeetingsHeaderButton')[idx]?.click(), liga.idx);
            await this._delay(2000);
        }

        // Próximos jogos
        const numHorarios = await pg.evaluate(() => document.querySelectorAll('.vr-EventTimesNavBarButton').length);
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

            const horario  = infoJogo.horario || countdown;
            const eventoId = this._gerarId(liga.nome, infoJogo.timeCasa, infoJogo.timeFora, horario);

            eventos.push({ eventoId, liga: liga.nome, timeCasa: infoJogo.timeCasa, timeFora: infoJogo.timeFora, horario, countdown, oddCasa, oddEmpate, oddFora, mercados });
            console.log(`      ✅ [${liga.nome}] ${infoJogo.timeCasa} x ${infoJogo.timeFora} [${horario}]`);
        }

        return { eventos, resultados };
    }

    // ─────────────────────────────────────────────────────────────
    // COLETA PARALELA — todas as ligas
    // ─────────────────────────────────────────────────────────────

    async _extrairDados() {
        if (this.pagesLiga.length === 0) {
            console.log('   ⚠️  Nenhuma aba de liga preparada');
            return { eventos: [], resultados: [] };
        }

        console.log(`   🔄 Coletando ${this.pagesLiga.length} liga(s) em paralelo...`);

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
                    let ms = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate(), h, m, 0, 0);
                    if (ms > Date.now() + 90 * 60000) ms -= 86400000;
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
                const eventoId = this._gerarId(res.liga, res.timeCasa, res.timeFora, res.horario || '');
                const existe   = await pool.request().input('evId', sql.BigInt, eventoId)
                    .query(`SELECT id, gol_casa, gol_fora FROM bet365_historico_partidas WHERE evento_id=@evId`);

                const jaExiste  = existe.recordset.length > 0;
                const scoreZero = jaExiste && existe.recordset[0].gol_casa === 0 && existe.recordset[0].gol_fora === 0;
                const temScore  = (res.golCasa || 0) + (res.golFora || 0) > 0;

                if (jaExiste && !scoreZero) continue;
                if (jaExiste && scoreZero && !temScore) continue;

                let oddCasa = 0, oddEmpate = 0, oddFora = 0;
                const evMem = eventos.find(e => e.eventoId === eventoId);
                if (evMem) { oddCasa = evMem.oddCasa; oddEmpate = evMem.oddEmpate; oddFora = evMem.oddFora; }

                if (!oddCasa && !oddEmpate && !oddFora) {
                    const evDb = await pool.request().input('evId2', sql.BigInt, eventoId)
                        .query(`SELECT odd_casa, odd_empate, odd_fora FROM bet365_eventos WHERE id=@evId2`);
                    if (evDb.recordset.length > 0) {
                        oddCasa   = parseFloat(evDb.recordset[0].odd_casa)   || 0;
                        oddEmpate = parseFloat(evDb.recordset[0].odd_empate) || 0;
                        oddFora   = parseFloat(evDb.recordset[0].odd_fora)   || 0;
                    }
                }

                let dataPart = new Date();
                if (res.horario && /^\d{1,2}[.:]\d{2}$/.test(res.horario)) {
                    const [hh, mm] = res.horario.replace('.', ':').split(':').map(Number);
                    let ms = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate(), hh, mm, 0, 0);
                    if (ms > Date.now() + 90 * 60000) ms -= 86400000;
                    dataPart = new Date(ms);
                }

                await pool.request()
                    .input('evId',     sql.BigInt,       eventoId)
                    .input('liga',     sql.NVarChar(200), res.liga)
                    .input('timeCasa', sql.NVarChar(100), res.timeCasa)
                    .input('timeFora', sql.NVarChar(100), res.timeFora)
                    .input('golCasa',  sql.Int,           res.golCasa)
                    .input('golFora',  sql.Int,           res.golFora)
                    .input('golCHT',   sql.TinyInt,       res.golCasaHT ?? null)
                    .input('golFHT',   sql.TinyInt,       res.golForaHT ?? null)
                    .input('resultado',sql.NVarChar(10),  res.resultado)
                    .input('oddCasa',  sql.Decimal(10,2), oddCasa)
                    .input('oddEmp',   sql.Decimal(10,2), oddEmpate)
                    .input('oddFora',  sql.Decimal(10,2), oddFora)
                    .input('dataPart', sql.DateTime2,     dataPart)
                    .query(`
                        MERGE bet365_historico_partidas AS t
                        USING (SELECT @evId AS evento_id) AS s ON t.evento_id=s.evento_id
                        WHEN MATCHED AND t.gol_casa=0 AND t.gol_fora=0 THEN UPDATE SET
                            t.gol_casa=@golCasa, t.gol_fora=@golFora,
                            t.gol_casa_ht=ISNULL(@golCHT,t.gol_casa_ht),
                            t.gol_fora_ht=ISNULL(@golFHT,t.gol_fora_ht),
                            t.resultado=@resultado, t.resultado_estimado=0,
                            t.odd_casa=CASE WHEN t.odd_casa=0 THEN @oddCasa ELSE t.odd_casa END,
                            t.odd_empate=CASE WHEN t.odd_empate=0 THEN @oddEmp ELSE t.odd_empate END,
                            t.odd_fora=CASE WHEN t.odd_fora=0 THEN @oddFora ELSE t.odd_fora END
                        WHEN NOT MATCHED THEN INSERT
                            (evento_id,liga,time_casa,time_fora,gol_casa,gol_fora,gol_casa_ht,gol_fora_ht,
                             resultado,odd_casa,odd_empate,odd_fora,data_partida,resultado_estimado)
                        VALUES (@evId,@liga,@timeCasa,@timeFora,@golCasa,@golFora,@golCHT,@golFHT,
                                @resultado,@oddCasa,@oddEmp,@oddFora,@dataPart,0);
                    `);

                if (jaExiste && scoreZero) console.log(`   🔄 Score atualizado: ${res.timeCasa} ${res.golCasa}-${res.golFora} ${res.timeFora}`);
                histOk++;
            } catch(e) {
                console.error(`   ❌ Erro histórico ${res.timeCasa} x ${res.timeFora}: ${e.message}`);
            }
        }

        console.log(`   💾 Eventos:${eventosOk} | Mercados:${mercadosOk} | Odds:${oddsOk} | Histórico:${histOk}`);
        return { eventosOk, mercadosOk, oddsOk, histOk };
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

            // Prepara abas na 1ª coleta ou se perdeu as abas
            if (this.pagesLiga.length === 0) {
                await this._prepararAbas();
            }

            const dados      = await this._extrairDados();
            const contadores = await this.salvarNoBanco(dados);
            await this._logColeta(inicio, 'SUCESSO', contadores, null);

            if (typeof global.wsBroadcast === 'function') {
                global.wsBroadcast({ tipo: 'coleta', fonte: 'bet365', novos: contadores.eventosOk, resultadosSalvos: contadores.histOk, timestamp: new Date().toISOString() });
            }

            console.log(`✅ Bet365 - Coleta concluída`);
        } catch(err) {
            console.error(`❌ Bet365 - Erro: ${err.message}`);
            await this._logColeta(inicio, 'ERRO', null, err.message);

            // Se perdeu conexão com o Edge, reseta as abas
            if (err.message.includes('Session closed') || err.message.includes('Target closed') ||
                err.message.includes('Protocol error') || err.message.includes('Connection closed') ||
                err.message.includes('ECONNRESET') || err.message.includes('detached') ||
                err.message.includes('não encontrado')) {
                console.log('   🔄 Resetando conexão...');
                this.browser   = null;
                this.pagesLiga = [];
            }
        } finally {
            this.coletando = false;
        }
    }
}

module.exports = Bet365Coletor;
