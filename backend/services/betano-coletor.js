/**
 * ============================================
 * COLETOR BETANO - MULTI-LIGA + STEALTH
 * Coleta TODAS as ligas de futebol virtual
 * ============================================
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const sql = require('mssql');
const dotenv = require('dotenv');
const teamMapping = require('../utils/team-mapping');

dotenv.config();
puppeteer.use(StealthPlugin());

class BetanoColetor {
    constructor() {
        this.baseUrl  = 'https://www.betano.bet.br/virtuals/futebol/brasileirao/';
        this.loginUrl = 'https://www.betano.bet.br/';
        this.browser  = null;
        this.page     = null;
        this.pool     = null;
        this.loggedIn = false;
        this.coletando = false; // lock anti-overlap
    }

    /**
     * Normaliza nome do time usando mapeamento
     * @param {string} nomeTime - Nome do time vindo da Betano
     * @param {number} teamId - ID do time (opcional)
     * @returns {string} - Nome normalizado
     */
    _normalizarNomeTime(nomeTime, teamId = null) {
        if (!nomeTime) return '';
        
        // Tenta buscar pelo teamId primeiro
        if (teamId && teamMapping[teamId]) {
            return teamMapping[teamId];
        }
        
        // Mapeamentos diretos de nomes genéricos para reais
        const mapeamentoNomes = {
            // Scudetto Italiano
            'Milan Red': 'AC Milan',
            'Milan Blue': 'Inter Milan',
            'Turin White': 'Juventus',
            'Turin Red': 'Torino',
            'Rome Red': 'AS Roma',
            'Rome Blue': 'Lazio',
            'Naples': 'Napoli',
            'Florence': 'Fiorentina',
            'Bergamo': 'Atalanta',
            'Blucerchiati': 'Sampdoria',
            'Nerazzuri': 'Inter Milan',
            'Turim': 'Torino',
            'Sassulo': 'Sassuolo',
            'Cremonês': 'Cremonese',
            
            // Liga Espanhola
            'Madrid White': 'Real Madrid',
            'Madrid Reds': 'Atletico Madrid',
            'Madrid Red': 'Atletico Madrid',
            'Real': 'Real Madrid',
            'Barcelona': 'Barcelona',
            'Barcelona Blue': 'Barcelona',
            'Barcelona White': 'Barcelona',
            'Sevilla Red': 'Sevilla',
            'Sevilla Green': 'Sevilla',
            'San Sebastian': 'Real Sociedad',
            'Bilbao': 'Athletic Bilbao',
            'Villareal': 'Villarreal',
            'Vigo': 'Celta Vigo',
            
            // Premier League
            'Manchester Blue': 'Manchester City',
            'Manchester Red': 'Manchester United',
            'Manchester': 'Manchester City',
            'Highbury': 'Arsenal',
            'London Guns': 'Arsenal',
            'Wolverhampton': 'Wolves',
            
            // Bundesliga
            'Munich': 'Bayern Munich',
            'Dortmund': 'Borussia Dortmund',
            'Berlin': 'Union Berlin',
            'Leipzig': 'RB Leipzig',
            
            // Ligue 1
            'Paris': 'PSG',
            
            // Champions League
            'Milan': 'AC Milan',
            'Milan Blues': 'AC Milan',
            'Amsterdam': 'Ajax',
            'Highbury': 'Arsenal',
            
            // Copa das Estrelas
            'City': 'Manchester City',
            'Liverpool': 'Liverpool',
            'Celtic': 'Celtic',
            'FCSB': 'FCSB',
            
            // Liga Europeia
            'Milão': 'AC Milan',
            'Istanbul Blues': 'Istanbul Basaksehir',
            'Kaunas': 'Zalgiris Kaunas',
            'Belgrade': 'Red Star Belgrade',
            'Tel Aviv': 'Maccabi Tel Aviv',
            
            // Clássicos da América
            'Tricolor paulista': 'São Paulo',
            'Mengo': 'Flamengo',
            'Timao': 'Corinthians',
            'Los Verdiblancos': 'Real Betis',
            'Los Rojos del Ávila': 'Atlético Nacional',
            'Deportes': 'Deportes Tolima',
            'O. Caldas': 'Once Caldas',
            
            // Brasileirão - nomes já vêm corretos na API danae
            // Mas normaliza variações
            'Red Bull Bragantino': 'Bragantino',
            'Atletico Mineiro': 'Atlético-MG',
            'Fluminense': 'Fluminense',
        };
        
        return mapeamentoNomes[nomeTime] || nomeTime;
    }

    // ============================================
    // FILTRO: APENAS FUTEBOL VIRTUAL - LIGAS ESPECÍFICAS
    // ============================================

    // Ligas permitidas (apenas estas serão coletadas)
    static LIGAS_PERMITIDAS = [
        'brasileirão betano',
        'clássicos da américa',
        'copa america',
        'euro',
        'ligas america',
        'british derbies',
        'liga espanhola',
        'scudetto italiano',
        'campeonato italiano',
        'copa das estrelas',
        'campeões',
        'liga europeia',
        'bundesliga',
        'premier clubs',
        'super clubs',
        'liga das estrelas'
    ];

    // Ligas não-futebol conhecidas (greyhounds, NBA, NFL, bowling, etc.)
    static LIGAS_EXCLUIR = [
        'nba', 'nfl', 'basketball', 'bowls', 'bolinhas', 'bowling',
        'velodrome', 'greyhound', 'fairfield', 'jennison', 'playford',
        'brook park', 'princess parkway', 'valley arena', 'ringway',
        'replay strike', 'v-play nfl', 'us arena', 'american football',
        'baseball', 'cricket', 'tennis', 'golf', 'cycling', 'motorsport'
    ];

    _isFutebol(liga, timeCasa, timeFora) {
        const l  = (liga     || '').toLowerCase().trim();
        const tc = (timeCasa || '').toLowerCase();
        const tf = (timeFora || '').toLowerCase();

        // Liga vazia = não é futebol virtual identificado — rejeita
        if (!l) return false;

        // Excluir ligas conhecidas como não-futebol
        if (BetanoColetor.LIGAS_EXCLUIR.some(excl => l.includes(excl))) return false;

        // Excluir formato NBA "Dia de jogo X" ou adversário vazio
        if (tc.includes('dia de jogo') || tf.includes('dia de jogo')) return false;
        if (!tc.trim() || !tf.trim()) return false;

        return true;
    }

    // Verifica se a liga está na lista de ligas permitidas
    _isLigaPermitida(liga) {
        const l = (liga || '').toLowerCase().trim();
        if (!l) return false;
        // Verifica se a liga está na lista de permitidas (busca parcial)
        return BetanoColetor.LIGAS_PERMITIDAS.some(permitida => l.includes(permitida));
    }

    // ============================================
    // BANCO DE DADOS
    // ============================================

    async conectarBanco() {
        if (this.pool && this.pool.connected) return this.pool;

        this.pool = await sql.connect({
            user:     process.env.DB_USER     || 'sa',
            password: process.env.DB_PASSWORD,
            server:   process.env.DB_SERVER   || '127.0.0.1',
            database: process.env.DB_NAME     || 'PRODUCAO',
            port:     parseInt(process.env.DB_PORT) || 1433,
            options: {
                encrypt: process.env.DB_ENCRYPT === 'true',
                trustServerCertificate: process.env.DB_TRUST_CERT !== 'false'
            },
            pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
        });

        console.log('✅ Banco conectado');
        return this.pool;
    }

    // ============================================
    // BROWSER (abre uma vez, reutiliza)
    // ============================================

    async iniciarBrowser() {
        if (this.browser) return;

        console.log('🌐 Iniciando navegador stealth...');
        this.browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--window-size=1366,768',
                '--disable-blink-features=AutomationControlled',
                '--lang=pt-BR,pt'
            ],
            defaultViewport: { width: 1366, height: 768 }
        });

        this.page = await this.browser.newPage();
        await this.page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' });

        // Bloquear recursos desnecessários (imagens, fonts, etc.)
        await this.page.setRequestInterception(true);
        this.page.on('request', (req) => {
            const tipo = req.resourceType();
            if (['image', 'font', 'media', 'stylesheet'].includes(tipo)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // ── INTERCEPTAÇÃO DE REDE: captura respostas JSON das APIs da Betano ──
        // Scores de jogos finalizados chegam via chamadas assíncronas (XHR/fetch),
        // nunca ficam no window.initial_state. Por isso interceptamos a rede.
        this._capturedResponses = [];
        this._loggedUrls = new Set(); // URLs já logadas (evita spam)

        this.page.on('response', async (response) => {
            try {
                const url = response.url();
                const status = response.status();

                // Só APIs JSON da Betano
                if (status < 200 || status >= 300) return;
                const ct = response.headers()['content-type'] || '';
                if (!ct.includes('json')) return;

                // Filtra só endpoints relevantes
                const ehBetano = url.includes('betano') || url.includes('virtual') ||
                                 url.includes('sports-api') || url.includes('sportsbook');
                if (!ehBetano) return;

                const json = await response.json().catch(() => null);
                if (!json) return;

                this._capturedResponses.push({ url, json, ts: Date.now() });

                // Log de URL nova (diagnóstico — mostra quais endpoints Betano usa)
                const urlBase = url.split('?')[0];
                if (!this._loggedUrls.has(urlBase)) {
                    this._loggedUrls.add(urlBase);
                    console.log(`   🌐 API capturada: ${urlBase}`);
                }
            } catch {}
        });

        console.log('🌐 Navegador iniciado (interceptação de rede ativa)');
    }

    async fecharBrowser() {
        if (this.browser) {
            await this.browser.close().catch(() => {});
            this.browser = null;
            this.page    = null;
            this.loggedIn = false;
            console.log('🔒 Navegador fechado');
        }
    }

    // ============================================
    // LOGIN
    // ============================================

    async fazerLogin() {
        if (this.loggedIn) return true;

        const username = process.env.BETANO_USERNAME;
        const password = process.env.BETANO_PASSWORD;
        if (!username || !password) {
            console.log('ℹ️ Sem credenciais — modo público');
            return false;
        }

        try {
            console.log('🔑 Fazendo login na Betano...');
            await this.page.goto(this.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await this._delay(3000);

            const btnLogin = await this.page.$('[data-testid="login-button"], .login-button, [class*="login"]');
            if (btnLogin) { await btnLogin.click(); await this._delay(1500); }

            const inputUser = await this.page.$('input[type="text"][name*="user"], input[type="email"], input[placeholder*="email"], input[placeholder*="usuário"]');
            if (inputUser) { await inputUser.click({ clickCount: 3 }); await inputUser.type(username, { delay: 80 }); }

            const inputPass = await this.page.$('input[type="password"]');
            if (inputPass) { await inputPass.click({ clickCount: 3 }); await inputPass.type(password, { delay: 80 }); }

            const submitBtn = await this.page.$('button[type="submit"], [data-testid="submit-button"]');
            if (submitBtn) { await submitBtn.click(); await this._delay(3000); }

            this.loggedIn = true;
            console.log('✅ Login realizado');
            return true;
        } catch (err) {
            console.log('⚠️ Login falhou, modo público:', err.message);
            return false;
        }
    }

    // ============================================
    // EXTRAÇÃO — PÁGINA ATUAL (usa initial_state)
    // ============================================

    // ============================================
    // EXTRAIR RESULTADOS DO PAINEL HTML (botão virtuals-results-toggle-button)
    // ============================================
    async _extrairResultadosDoPainel() {
        console.log('🔍 Tentando clicar no botão de resultados...');

        const resultados = [];

        try {
            // Esperar o botão estar visível
            await this.page.waitForSelector('[data-qa="virtuals-results-toggle-button"]', { timeout: 5000 }).catch(() => null);

            // Clica no botão de resultados
            const botaoResultados = await this.page.$('[data-qa="virtuals-results-toggle-button"]');
            if (!botaoResultados) {
                console.log('   ⚠️ Botão de resultados não encontrado');
                return [];
            }

            await botaoResultados.click();
            await this._delay(4000); // Aguarda painel abrir e carregar dados

            // Extrai os resultados do painel aberto
            const dadosPainel = await this.page.evaluate(() => {
                const jogos = [];

                // Seletores reais baseados na inspeção do HTML da Betano
                const SEL_BOTAO = '[data-qa="virtuals-results-toggle-button"]';
                const SEL_CONTAINER_RESULTADOS = '[class*="tw-flex"][class*="tw-items-center"][class*="tw-justify-center"]';
                const SEL_LINHA_JOGO = '[class*="tw-flex"][class*="tw-text-xs"][class*="tw-leading-s"][class*="tw-text-sem-color-text-gray-subtle"]';
                const SEL_TIME = '[class*="tw-font-bold"][class*="tw-flex-1"][class*="tw-text-center"][class*="tw-overflow-hidden"]';
                const SEL_PLACAR = '[class*="tw-font-bold"][class*="tw-text-l"][class*="tw-leading-l"]';
                const SEL_HORARIO = '[class*="tw-text-xs"][class*="tw-leading-s"][class*="tw-text-sem-color-text-gray-subtle"]';

                // Estratégia: Buscar containers que representam cada jogo
                // Estrutura: [horário] [timeCasa] [placar] [timeFora]
                
                // Busca todos os elementos com horário (padrão HH:MM)
                const elementosHorario = Array.from(document.querySelectorAll(SEL_HORARIO));
                
                elementosHorario.forEach(elHorario => {
                    try {
                        const horario = (elHorario.textContent || '').trim();
                        
                        // Valida formato HH:MM
                        if (!/^\d{2}:\d{2}$/.test(horario)) return;

                        // Navega até o container pai mais próximo que contém o jogo completo
                        let container = elHorario.parentElement;
                        while (container && !container.classList.contains('tw-flex')) {
                            container = container.parentElement;
                        }
                        
                        if (!container) return;

                        // Busca todos os elementos com texto em negrito (times e placar)
                        const elementosBold = Array.from(container.querySelectorAll(SEL_TIME));
                        const placarElement = container.querySelector(SEL_PLACAR);

                        // Extrai texto dos times
                        const times = elementosBold
                            .map(el => (el.textContent || '').trim())
                            .filter(text => 
                                text.length > 2 && 
                                text.length < 50 && 
                                !/^\d/.test(text) &&
                                text !== 'Em progresso' &&
                                text !== 'Virtuais' &&
                                text !== 'Futebol' &&
                                text !== 'Resultados'
                            );

                        // Extrai placar
                        let golCasa = 0, golFora = 0, placar = '';
                        if (placarElement) {
                            const textoPlacar = (placarElement.textContent || '').trim();
                            // Formato: "2 - 2" ou "1-2" ou "2:1"
                            const match = textoPlacar.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
                            if (match) {
                                placar = textoPlacar;
                                golCasa = parseInt(match[1]) || 0;
                                golFora = parseInt(match[2]) || 0;
                            }
                        }

                        // Precisa ter 2 times e placar válido
                        if (times.length >= 2 && placar) {
                            jogos.push({
                                timeCasa: times[0],
                                timeFora: times[1],
                                golCasa,
                                golFora,
                                placar,
                                horario
                            });
                        }
                    } catch (e) {
                        console.error('Erro ao extrair jogo:', e);
                    }
                });

                return jogos;
            });

            // Fecha o painel clicando no botão novamente
            await botaoResultados.click();
            await this._delay(500);

            if (dadosPainel.length > 0) {
                console.log(`   ✅ ${dadosPainel.length} jogos extraídos do painel`);
                dadosPainel.forEach(j => {
                    console.log(`      ${j.horario || '--:--'} ${j.timeCasa} ${j.golCasa}x${j.golFora} ${j.timeFora}`);
                });
            }

            return dadosPainel;
        } catch (err) {
            console.log(`   ⚠️ Erro ao extrair painel: ${err.message}`);
            return [];
        }
    }

    async _extrairEventosDaPagina() {
        const dados = await this.page.evaluate(() => {
            const state = window['initial_state'];
            if (!state || !state.data) return { eventos: [], ligaUrls: [], finalizados: [], debugKeys: [] };

            const data = state.data;
            const eventos = [];
            const processados = new Set();
            const ligaUrls = [];

            // ── currentEvents (ao vivo + agendados COM odds) ──────────
            if (Array.isArray(data.currentEvents)) {
                data.currentEvents.forEach(ev => {
                    const id = parseInt(ev.id) || 0;
                    if (!id || processados.has(id)) return;
                    processados.add(id);

                    const participantes = ev.participants || [];
                    const mercados      = ev.markets     || [];

                    // ── Score: paths corretos baseados no mapeamento real da API Betano ──
                    // liveData.score → scoreViewModel { home, away }
                    // liveData.results → eventResultViewModel { fullTimeScore, goal, firstHalfScore, ... }
                    const ld      = ev.liveData    || {};
                    const ldScore = ld.score        || {};   // scoreViewModel atual
                    const ldRes   = ld.results      || {};   // eventResultViewModel
                    const ldFT    = ldRes.fullTimeScore || {}; // placar tempo inteiro (FT)
                    const ldHT    = ldRes.firstHalfScore || ldRes.halfTimeScore || {}; // placar HT
                    const ldGoal  = ldRes.goal         || {}; // gols marcados
                    const ldStd   = ldRes.standardTimeScore || {};

                    const golCasa = parseInt(
                        ldFT.home   ?? ldFT.h   ??     // fullTimeScore (FINAL)
                        ldGoal.home ?? ldGoal.h ??     // goal
                        ldStd.home  ?? ldStd.h  ??     // standardTimeScore
                        ldScore.home ?? ldScore.h ??   // score atual
                        ev.homeScore ?? ev.home_score ?? 0
                    ) || 0;
                    const golFora = parseInt(
                        ldFT.away   ?? ldFT.a   ??
                        ldGoal.away ?? ldGoal.a ??
                        ldStd.away  ?? ldStd.a  ??
                        ldScore.away ?? ldScore.a ??
                        ev.awayScore ?? ev.away_score ?? 0
                    ) || 0;

                    // Placar do primeiro tempo (HT)
                    const golCasaHT = parseInt(ldHT.home ?? ldHT.h ?? ldRes.halfTimeHome ?? ldRes.htHome ?? 0) || 0;
                    const golForaHT = parseInt(ldHT.away ?? ldHT.a ?? ldRes.halfTimeAway ?? ldRes.htAway ?? 0) || 0;
                    // clock: liveData.clock → clockTimeViewModel { secondsSinceStart, clockStopped }
                    const clock = ld.clock || {};
                    const minutoJogo = clock.secondsSinceStart != null
                        ? String(Math.floor(clock.secondsSinceStart / 60)) + "'"
                        : String(ldRes.periodDescription ?? ld.periodDescription ?? '');
                    const isLive = (ev.secondsToStart != null && ev.secondsToStart <= 0);

                    // ── Odds 1X2: aceita vários nomes de mercado ──
                    let oddCasa = 0, oddEmpate = 0, oddFora = 0;
                    const mRF = mercados.find(m => {
                        const n = (m.name || '').toLowerCase();
                        const t = (m.type || '').toUpperCase();
                        return n.includes('resultado') || n.includes('1x2') ||
                               n.includes('moneyline') || n.includes('full time') ||
                               n.includes('match result') ||
                               t === 'MRES' || t === 'MR' || t === '1X2' || t === 'FT';
                    });
                    if (mRF?.selections) {
                        mRF.selections.forEach(s => {
                            const n = (s.name || s.shortName || '').trim().toUpperCase();
                            if (n === '1' || n === 'HOME' || n === 'CASA' || n === 'H' || n.startsWith('1-')) {
                                oddCasa   = parseFloat(s.price) || 0;
                            } else if (n === 'X' || n === 'DRAW' || n === 'EMPATE' || n === 'E' || n === 'D') {
                                oddEmpate = parseFloat(s.price) || 0;
                            } else if (n === '2' || n === 'AWAY' || n === 'FORA' || n === 'A' || n.startsWith('2-')) {
                                oddFora   = parseFloat(s.price) || 0;
                            }
                        });
                    }

                    eventos.push({
                        id,
                        liga: ev.leagueName || ev.leagueDescription || ev.regionName || ev.rd || ev.sportDescription || '',
                        timeCasa: participantes[0]?.name || '',
                        timeFora: participantes[1]?.name || '',
                        status: isLive ? 'EM_ANDAMENTO' : 'AGENDADO',
                        secondsToStart: ev.secondsToStart || 999,
                        startTime: ev.startTime || 0,
                        startTimeDatetime: ev.startTime ? new Date(ev.startTime).toISOString() : null,
                        url: ev.url || '',
                        oddCasa, oddEmpate, oddFora,
                        golCasa, golFora,
                        golCasaHT, golForaHT,
                        minutoJogo,
                        periodo: ldRes.periodDescription || ld.periodDescription || (isLive ? '1T' : ''),
                        estatisticas: {
                            posseBolaCasa:      ld.possessionHome         || 0,
                            posseBolaFora:      ld.possessionAway         || 0,
                            chutesCasa:         ld.shotsHome              || 0,
                            chutesFora:         ld.shotsAway              || 0,
                            chutesGolCasa:      ld.shotsOnTargetHome      || 0,
                            chutesGolFora:      ld.shotsOnTargetAway      || 0,
                            escanteiosCasa:     ld.cornersHome            || 0,
                            escanteiosFora:     ld.cornersAway            || 0,
                            ataquesCasa:        ld.attacksHome            || 0,
                            ataquesFora:        ld.attacksAway            || 0,
                            ataquesPerigoCasa:  ld.dangerousAttacksHome   || 0,
                            ataquesPerigoFora:  ld.dangerousAttacksAway   || 0,
                            cartoesAmarelosCasa:ld.yellowCardsHome        || 0,
                            cartoesAmarelosFora:ld.yellowCardsAway        || 0,
                            cartoesVermelhosCasa:ld.redCardsHome          || 0,
                            cartoesVermelhosFora:ld.redCardsAway          || 0,
                        },
                        mercados: mercados.map(m => ({
                            id:   parseInt(m.id) || 0,
                            nome: m.name  || '',
                            tipo: m.type  || '',
                            handicap: m.handicap || 0,
                            selecoes: (m.selections || []).map(s => ({
                                id:          parseInt(s.id) || 0,
                                nome:        s.name     || '',
                                fullName:    s.fullName || s.name || '',
                                valor:       parseFloat(s.price) || 0,
                                handicap:    s.handicap     || 0,
                                columnIndex: s.columnIndex  || 0
                            }))
                        }))
                    });
                });
            }

            // ── menu (ligas adicionais + URLs para navegar) ───────────
            if (Array.isArray(data.menu)) {
                data.menu.forEach(menuItem => {
                    // Capturar URL da liga no menu
                    if (menuItem.url) {
                        ligaUrls.push({
                            nome: menuItem.name || menuItem.title || 'Liga',
                            url:  menuItem.url
                        });
                    }

                    if (!Array.isArray(menuItem.content)) return;
                    menuItem.content.forEach(ev => {
                        const id = parseInt(ev.id) || 0;
                        if (!id || processados.has(id)) return;
                        processados.add(id);

                        let timeCasa = '', timeFora = '';
                        if (Array.isArray(ev.displayNameParts)) {
                            timeCasa = ev.displayNameParts[0]?.name || '';
                            timeFora = ev.displayNameParts[1]?.name || '';
                        }

                        eventos.push({
                            id,
                            liga: ev.leagueName || ev.leagueDescription || ev.regionName || ev.rd || menuItem.name || '',
                            timeCasa, timeFora,
                            status: (ev.secondsToStart <= 0) ? 'EM_ANDAMENTO' : 'AGENDADO',
                            secondsToStart: ev.secondsToStart || 999,
                            startTime: ev.startTime || 0,
                            startTimeDatetime: ev.startTime ? new Date(ev.startTime).toISOString() : null,
                            url: ev.url || '',
                            oddCasa: 0, oddEmpate: 0, oddFora: 0,
                            golCasa: 0, golFora: 0, minutoJogo: '',
                            estatisticas: null,
                            mercados: []
                        });
                    });
                });
            }

            // ══════════════════════════════════════════════════════════════
            // CAPTURAR FINALIZADOS — usa estrutura real da API Betano
            // Mapeamento: data.results (chave longa) = data.ee (chave curta)
            //   → virtualV4ResultViewModel:  { leagueName/ld, id, events/e, startTime/tt }
            //   → virtualV4EndedEventViewModel: { id/i, displayNameParts/dnp, statistics/st, markets/mr }
            //   → virtualsV4StatisticsViewModel: { statisticsType/k, value/v: [{score/s, name/n},...] }
            // ══════════════════════════════════════════════════════════════
            const finalizados = [];
            const finIds = new Set();

            // Extrai score de ev usando paths corretos do mapeamento Betano
            function extrairScoreEv(ev) {
                const ld   = ev.liveData    || {};
                const ldFT = (ld.results || {}).fullTimeScore || {};
                const ldG  = (ld.results || {}).goal          || {};
                const ldSc = ld.score || {};
                const gc = parseInt(ldFT.home ?? ldFT.h ?? ldG.home ?? ldG.h ?? ldSc.home ?? ldSc.h ?? 0) || 0;
                const gf = parseInt(ldFT.away ?? ldFT.a ?? ldG.away ?? ldG.a ?? ldSc.away ?? ldSc.a ?? 0) || 0;
                return { golCasa: gc, golFora: gf };
            }

            // Extrai score de virtualV4EndedEventViewModel (jogos finalizados via data.results/data.ee)
            function extrairScoreEndedEvent(ev) {
                let gc = 0, gf = 0;
                // Primeiro tenta via statistics (virtualsV4StatisticsViewModel)
                const stats = ev.statistics || ev.st || [];
                stats.forEach(stat => {
                    const type = (stat.statisticsType || stat.k || '').toUpperCase();
                    const vals = stat.value || stat.v || [];
                    // Tipo SCORE ou FT_SCORE ou GOAL são os que têm o placar
                    if (type === 'SCORE' || type === 'FT_SCORE' || type === 'GOAL' ||
                        type === 'RESULT' || type.includes('SCORE')) {
                        if (Array.isArray(vals) && vals.length >= 2) {
                            const v0 = vals[0] || {};
                            const v1 = vals[1] || {};
                            const a = parseInt(v0.score ?? v0.s ?? v0.number ?? v0.sn ?? 0) || 0;
                            const b = parseInt(v1.score ?? v1.s ?? v1.number ?? v1.sn ?? 0) || 0;
                            if (a > 0 || b > 0) { gc = a; gf = b; }
                        }
                    }
                });
                // Se não encontrou, tenta via mercado "Resultado Final" — selecao vencedora
                if (gc === 0 && gf === 0) {
                    const markets = ev.markets || ev.mr || [];
                    const mRes = markets.find(m => {
                        const n = (m.name || m.n || '').toLowerCase();
                        return n.includes('resultado') || n.includes('1x2') || n.includes('result');
                    });
                    if (mRes) {
                        const sels = mRes.selections || mRes.s || [];
                        // outcome: 1=WON, 0=LOST (ou 'WON'/'LOST')
                        sels.forEach(s => {
                            const outcome = s.outcome || s.t;
                            const won = outcome === 1 || outcome === 'WON' || outcome === 'Won';
                            if (won) {
                                const name = (s.name || s.n || '').trim().toUpperCase();
                                // placar exato no nome? ex: "1-0", "2-1"
                                const m = name.match(/^(\d+)-(\d+)$/);
                                if (m) { gc = parseInt(m[1]); gf = parseInt(m[2]); }
                            }
                        });
                    }
                }
                return { golCasa: gc, golFora: gf };
            }

            // ── 1. data.results / data.ee (jogos recém-finalizados) ──────
            const gruposResultado = data.results || data.ee || [];
            if (Array.isArray(gruposResultado)) {
                gruposResultado.forEach(grupo => {
                    const liga = grupo.leagueName || grupo.ld || '';
                    const evs = grupo.events || grupo.e || [];
                    evs.forEach(ev => {
                        const id = parseInt(ev.id || ev.i) || 0;
                        if (!id || finIds.has(id)) return;
                        finIds.add(id);
                        const dnp = ev.displayNameParts || ev.dnp || [];
                        const timeCasa = dnp[0]?.name || '';
                        const timeFora = dnp[1]?.name || '';
                        const { golCasa, golFora } = extrairScoreEndedEvent(ev);
                        finalizados.push({
                            id, golCasa, golFora,
                            liga, timeCasa, timeFora,
                            startTime: grupo.startTime || grupo.tt || 0,
                            startTimeDatetime: (grupo.startTime || grupo.tt)
                                ? new Date(grupo.startTime || grupo.tt).toISOString() : null,
                            fonte: 'data_results'
                        });
                    });
                });
            }

            // ── 2. currentEvents com liveData.results populado (jogo no final ou recém-encerrado) ──
            if (Array.isArray(data.currentEvents)) {
                data.currentEvents.forEach(ev => {
                    const id = parseInt(ev.id) || 0;
                    if (!id || finIds.has(id)) return;
                    const { golCasa, golFora } = extrairScoreEv(ev);
                    const p = ev.participants || [];
                    const ldRes = (ev.liveData || {}).results || {};
                    const isPostMatch = ldRes.isPostMatch === true || ldRes.psm === true;
                    const gameRunning = ev.secondsToStart != null && ev.secondsToStart < 0;
                    // Captura se: tem placar E (jogo finalizou OU passou 3+ minutos)
                    if ((golCasa > 0 || golFora > 0) && (isPostMatch || ev.secondsToStart < -180)) {
                        finIds.add(id);
                        finalizados.push({
                            id, golCasa, golFora,
                            liga: ev.leagueName || ev.leagueDescription || ev.regionName || ev.rd || '',
                            timeCasa: p[0]?.name || '',
                            timeFora: p[1]?.name || '',
                            startTime: ev.startTime || 0,
                            startTimeDatetime: ev.startTime ? new Date(ev.startTime).toISOString() : null,
                            fonte: isPostMatch ? 'post_match' : 'current_expired'
                        });
                    }
                    // Também atualiza placar durante o jogo (mesmo sem ser finalizado)
                    if ((golCasa > 0 || golFora > 0) && gameRunning && !finIds.has(id)) {
                        // registra como evento ao vivo com placar (não como finalizado)
                        finIds.add(id);
                        finalizados.push({
                            id, golCasa, golFora,
                            liga: ev.leagueName || ev.leagueDescription || ev.regionName || ev.rd || '',
                            timeCasa: p[0]?.name || '',
                            timeFora: p[1]?.name || '',
                            startTime: ev.startTime || 0,
                            startTimeDatetime: ev.startTime ? new Date(ev.startTime).toISOString() : null,
                            fonte: 'live_score',
                            emAndamento: true
                        });
                    }
                });
            }

            // ── DEBUG: estrutura real da página ──────────────────────
            const debugKeys = Object.keys(data);

            // Captura amostra de liveData do primeiro evento ao vivo (para diagnóstico)
            let debugLive = null;
            if (Array.isArray(data.currentEvents)) {
                const ao_vivo = data.currentEvents.find(e => e.secondsToStart != null && e.secondsToStart <= 0);
                if (ao_vivo) {
                    const ld = ao_vivo.liveData || ao_vivo.ld || {};
                    debugLive = {
                        eventoId: ao_vivo.id,
                        temLiveData: !!(ao_vivo.liveData),
                        temLd: !!(ao_vivo.ld),
                        liveDataKeys: Object.keys(ld),
                        scoreRaw: ld.score || ld.sc || null,
                        resultsRaw: ld.results || ld.r || null,
                        secondsToStart: ao_vivo.secondsToStart
                    };
                }
            }

            // Verifica se data.results / data.ee existe (jogos finalizados)
            const temResults = !!(data.results || data.ee);
            const qtdResults = (data.results || data.ee || []).length;

            return { eventos, ligaUrls, finalizados, debugKeys, debugLive, temResults, qtdResults };
        });

        return dados || { eventos: [], ligaUrls: [], finalizados: [], debugKeys: [] };
    }

    // ============================================
    // EXTRAÇÃO VIA HTML PARSING (fallback)
    // Extrai placares diretamente do DOM quando a API falha
    // ============================================

    async _extrairPlacarDoHTML() {
        const placaresHTML = await this.page.evaluate(() => {
            const placares = [];
            
            // Busca elementos com padrão de placar da Betano
            // Estrutura: time-casa | placar | time-fora
            // Classes Tailwind: tw-font-bold, tw-flex-1, tw-text-center, etc.
            
            // Seletor baseado no HTML fornecido:
            // div com tw-flex tw-items-center tw-justify-center contendo:
            //   - time casa (tw-font-bold tw-flex-1 tw-text-center tw-overflow-hidden tw-text-ellipsis)
            //   - placar (tw-font-bold tw-text-l tw-leading-l tw-mx-n)
            //   - time fora (tw-font-bold tw-flex-1 tw-text-center tw-overflow-hidden tw-text-ellipsis)
            
            const containers = document.querySelectorAll('[class*="tw-flex"][class*="tw-items-center"][class*="tw-justify-center"]');
            
            containers.forEach(container => {
                try {
                    const children = Array.from(container.children);
                    
                    // Procura por padrão: time | placar | time
                    // O placar tem formato "X - Y" ou "X-Y"
                    let timeCasa = '';
                    let placarTexto = '';
                    let timeFora = '';
                    
                    for (let i = 0; i < children.length; i++) {
                        const child = children[i];
                        const text = (child.textContent || '').trim();
                        const classList = child.className || '';
                        
                        // Identifica placar pelo formato "X - Y"
                        if (/^\d+\s*-\s*\d+$/.test(text)) {
                            placarTexto = text;
                            // Time casa é o elemento anterior
                            if (i > 0) {
                                timeCasa = (children[i - 1].textContent || '').trim();
                            }
                            // Time fora é o elemento seguinte
                            if (i < children.length - 1) {
                                timeFora = (children[i + 1].textContent || '').trim();
                            }
                            break;
                        }
                    }
                    
                    // Se encontrou placar válido
                    if (placarTexto && timeCasa && timeFora) {
                        const [golCasa, golFora] = placarTexto.split('-').map(s => parseInt(s.trim()) || 0);
                        
                        // Filtra times vazios ou genéricos
                        if (timeCasa.length > 2 && timeFora.length > 2) {
                            placares.push({
                                timeCasa,
                                timeFora,
                                golCasa,
                                golFora,
                                placarTexto
                            });
                        }
                    }
                } catch (e) {
                    // Ignora erros de parsing individual
                }
            });
            
            return placares;
        });
        
        return placaresHTML;
    }

    // ============================================
    // EXTRAÇÃO — MULTI-LIGA (navega cada liga)
    // ============================================

    async extrairDados() {
        try {
            if (typeof window !== 'undefined') window._dbgLive = false;
            console.log('📡 Acessando futebol virtual (página principal)...');

            // Limpa respostas capturadas antes de navegar
            this._capturedResponses = [];

            await this.page.goto(this.baseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await this._aguardarInitialState(15000);

            // Aguarda chamadas assíncronas da Betano (resultados, live data, etc.)
            await this._delay(4000);

            // Extrai scores das respostas de rede capturadas
            const scoresRede = this._extrairScoresDasRespostas(this._capturedResponses);
            if (this._capturedResponses.length > 0) {
                console.log(`🔬 Respostas API: ${this._capturedResponses.length} | Scores via rede: ${scoresRede.length}`);
                if (scoresRede.length > 0) {
                    // Filtra apenas futebol DAS LIGAS PERMITIDAS e separa finalizados
                    const futebolScores = scoresRede.filter(s => {
                        if (!this._isFutebol(s.liga, s.timeCasa, s.timeFora)) return false;
                        if (!this._isLigaPermitida(s.liga)) return false;
                        return true;
                    });
                    const finalizadosRede = futebolScores.filter(s => s.finalizado === true);

                    if (futebolScores.length > 0) {
                        console.log(`   ⚽ Futebol: ${futebolScores.length} | Finalizados: ${finalizadosRede.length}`);
                    }
                    finalizadosRede.forEach(s => console.log(`   ✅ [FINALIZADO] ev${s.id}: ${s.timeCasa} ${s.golCasa}x${s.golFora} ${s.timeFora} (${s.liga})`));
                }
            }

            // Extrai eventos + URLs das ligas do menu
            const { eventos: ev0, ligaUrls, finalizados: fin0, debugKeys, debugLive, temResults, qtdResults } = await this._extrairEventosDaPagina();

            // Log diagnóstico completo
            if (debugKeys && debugKeys.length) {
                console.log(`🔍 initial_state.data keys: [${debugKeys.join(', ')}]`);
            }
            console.log(`📦 data.results/ee: ${temResults ? `SIM (${qtdResults} grupos)` : 'NÃO ENCONTRADO'}`);
            if (debugLive) {
                console.log(`🔴 LIVE sample ev${debugLive.eventoId}: liveData=${debugLive.temLiveData} ld=${debugLive.temLd} keys=[${debugLive.liveDataKeys.join(',')}]`);
                console.log(`   score raw: ${JSON.stringify(debugLive.scoreRaw)} | results raw: ${JSON.stringify(debugLive.resultsRaw)}`);
            } else {
                console.log(`⚪ Nenhum evento ao vivo encontrado nesta coleta`);
            }

            // ============================================
            // FALLBACK: Extração via HTML PARSING
            // Usado quando a API não retorna placares
            // ============================================
            const placaresHTML = await this._extrairPlacarDoHTML();
            if (placaresHTML.length > 0) {
                console.log(`🎨 Placares via HTML: ${placaresHTML.length}`);
                placaresHTML.forEach(p => {
                    console.log(`   📊 ${p.timeCasa} ${p.golCasa}x${p.golFora} ${p.timeFora} [HTML]`);
                });
            }

            // ============================================
            // NOVO: Extrair resultados do painel (botão virtuals-results-toggle-button)
            // ============================================
            console.log('\n🔍 Tentar extrair resultados do painel...');
            await this._delay(2000); // Aguarda renderização completa
            const resultadosPainel = await this._extrairResultadosDoPainel();
            if (resultadosPainel.length > 0) {
                console.log(`📋 Placares via PAINEL: ${resultadosPainel.length}`);
                resultadosPainel.forEach(p => {
                    console.log(`   📊 ${p.horario || '--:--'} ${p.timeCasa} ${p.golCasa}x${p.golFora} ${p.timeFora} [PAINEL]`);
                });
            } else {
                console.log('   ⚠️ Nenhum placar via painel (pode ser que não há jogos finalizados ainda)');
            }

            const todosEventos   = [...ev0];
            const todosFinalizados = [...fin0];
            const todosIds       = new Set(ev0.map(e => Number(e.id)));
            const finIds         = new Set(fin0.map(f => Number(f.id)));

            if (fin0.length > 0) console.log(`📋 Finalizados na página principal: ${fin0.length}`);

            // Adiciona scores capturados via rede (fonte mais confiável)
            scoresRede.forEach(s => {
                if (!finIds.has(Number(s.id))) {
                    finIds.add(Number(s.id));
                    todosFinalizados.push(s);
                }
            });

            // Adiciona scores capturados via HTML PARSING (fallback)
            // Mescla por nome de time (usa team-mapping para normalizar)
            placaresHTML.forEach(p => {
                const timeCasaNorm = this._normalizarNomeTime(p.timeCasa);
                const timeForaNorm = this._normalizarNomeTime(p.timeFora);

                // Busca evento correspondente nos eventos coletados
                const eventoCorrespondente = todosEventos.find(e => {
                    const eCasaNorm = this._normalizarNomeTime(e.timeCasa);
                    const eForaNorm = this._normalizarNomeTime(e.timeFora);
                    return (eCasaNorm === timeCasaNorm && eForaNorm === timeForaNorm);
                });

                if (eventoCorrespondente && !finIds.has(Number(eventoCorrespondente.id))) {
                    // Adiciona como finalizado via HTML
                    finIds.add(Number(eventoCorrespondente.id));
                    todosFinalizados.push({
                        id: eventoCorrespondente.id,
                        golCasa: p.golCasa,
                        golFora: p.golFora,
                        liga: eventoCorrespondente.liga,
                        timeCasa: eventoCorrespondente.timeCasa,
                        timeFora: eventoCorrespondente.timeFora,
                        startTime: eventoCorrespondente.startTime,
                        startTimeDatetime: eventoCorrespondente.startTimeDatetime,
                        fonte: 'html_parsing'
                    });
                    console.log(`   ✅ HTML: ${eventoCorrespondente.timeCasa} ${p.golCasa}x${p.golFora} ${eventoCorrespondente.timeFora}`);
                }
            });

            // Adiciona scores capturados via PAINEL (botão de resultados)
            // Mescla por nome de time (usa team-mapping para normalizar)
            resultadosPainel.forEach(p => {
                const timeCasaNorm = this._normalizarNomeTime(p.timeCasa);
                const timeForaNorm = this._normalizarNomeTime(p.timeFora);

                // Busca evento correspondente nos eventos coletados
                const eventoCorrespondente = todosEventos.find(e => {
                    const eCasaNorm = this._normalizarNomeTime(e.timeCasa);
                    const eForaNorm = this._normalizarNomeTime(e.timeFora);
                    return (eCasaNorm === timeCasaNorm && eForaNorm === timeForaNorm);
                });

                if (eventoCorrespondente && !finIds.has(Number(eventoCorrespondente.id))) {
                    // Adiciona como finalizado via PAINEL
                    finIds.add(Number(eventoCorrespondente.id));
                    todosFinalizados.push({
                        id: eventoCorrespondente.id,
                        golCasa: p.golCasa,
                        golFora: p.golFora,
                        liga: eventoCorrespondente.liga,
                        timeCasa: eventoCorrespondente.timeCasa,
                        timeFora: eventoCorrespondente.timeFora,
                        startTime: eventoCorrespondente.startTime,
                        startTimeDatetime: eventoCorrespondente.startTimeDatetime,
                        fonte: 'painel_resultados'
                    });
                    console.log(`   ✅ PAINEL: ${eventoCorrespondente.timeCasa} ${p.golCasa}x${p.golFora} ${eventoCorrespondente.timeFora}`);
                }
            });

            const ligasUnicas = [...new Set(ev0.map(e => e.liga).filter(Boolean))];
            console.log(`📊 Principal: ${ev0.length} eventos | ${ligasUnicas.join(', ') || 'sem liga'}`);
            console.log(`🔍 Ligas descobertas no menu: ${ligaUrls.length}`);

            // Filtra apenas URLs de futebol DAS LIGAS PERMITIDAS
            const ESPORTES_EXCLUIR = [
                'basquete','basketball','tenis','tennis','americano',
                'beisebol','baseball','cricket','rugby','golfe','golf',
                'ciclismo','cycling','motorsport','greyhound','velodrome',
                'arena','voleibol','volleyball','handball','boxe','boxing',
            ];
            const ligasFutebol = ligaUrls.filter(l => {
                const url = (l.url || '').toLowerCase();
                const nome = (l.nome || '').toLowerCase();
                
                // Excluir outros esportes
                if (ESPORTES_EXCLUIR.some(e => url.includes(e) || nome.includes(e))) return false;
                
                // Filtrar apenas ligas permitidas (com log para debug)
                const permitida = this._isLigaPermitida(nome);
                if (!permitida) {
                    console.log(`   ⚠️ Liga excluída (não permitida): ${l.nome}`);
                }
                return permitida;
            });

            console.log(`⚽ Ligas de futebol para visitar: ${ligasFutebol.length}`);
            if (ligasFutebol.length > 0) {
                console.log(`   📋 Ligas selecionadas: ${ligasFutebol.map(l => l.nome).join(', ')}`);
            }

            // Visita cada liga e coleta eventos adicionais
            for (const liga of ligasFutebol.slice(0, 6)) {
                try {
                    const fullUrl = liga.url.startsWith('http')
                        ? liga.url
                        : `https://www.betano.bet.br/${liga.url.replace(/^\//, '')}`;

                    // Não re-visita a URL base já carregada
                    if (fullUrl === this.baseUrl) continue;

                    console.log(`   📡 ${liga.nome} → ${fullUrl}`);
                    this._capturedResponses = [];
                    await this.page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
                    await this._aguardarInitialState(8000);
                    await this._delay(3000); // aguarda chamadas assíncronas

                    const { eventos: subEvs, finalizados: subFin } = await this._extrairEventosDaPagina();

                    // Scores via rede nesta sub-liga
                    const subScoresRede = this._extrairScoresDasRespostas(this._capturedResponses);
                    subScoresRede.forEach(s => {
                        if (!finIds.has(Number(s.id))) {
                            finIds.add(Number(s.id));
                            todosFinalizados.push(s);
                        }
                    });
                    if (subScoresRede.length > 0) console.log(`   🔬 ${liga.nome}: +${subScoresRede.length} scores via rede`);
                    let novos = 0;
                    subEvs.forEach(ev => {
                        if (ev.id && !todosIds.has(Number(ev.id))) {
                            todosIds.add(Number(ev.id));
                            todosEventos.push(ev);
                            novos++;
                        }
                    });
                    subFin.forEach(f => {
                        if (f.id && !finIds.has(Number(f.id))) {
                            finIds.add(Number(f.id));
                            todosFinalizados.push(f);
                        }
                    });
                    if (novos > 0) console.log(`   ✅ +${novos} eventos: ${liga.nome}`);

                } catch (subErr) {
                    console.log(`   ⚠️ Erro em ${liga.nome}: ${subErr.message}`);
                }
            }

            if (todosEventos.length === 0) {
                console.log('⚠️ Nenhum evento encontrado em nenhuma liga');
                return [];
            }

            const ligasTotal = [...new Set(todosEventos.map(e => e.liga).filter(Boolean))];
            console.log(`📊 TOTAL: ${todosEventos.length} eventos | Ligas: ${ligasTotal.join(' | ')}`);
            if (todosFinalizados.length > 0) console.log(`📋 Finalizados coletados: ${todosFinalizados.length}`);

            // Armazena finalizados para uso em salvarNoBanco()
            this._finalizadosPendentes = todosFinalizados;
            return todosEventos;

        } catch (err) {
            console.error('❌ Erro na extração:', err.message);
            await this.fecharBrowser();
            return [];
        }
    }

    async _aguardarInitialState(maxMs) {
        const inicio = Date.now();
        while (Date.now() - inicio < maxMs) {
            const ok = await this.page.evaluate(() =>
                !!(window['initial_state'] && window['initial_state'].data)
            ).catch(() => false);
            if (ok) return;
            await this._delay(500);
        }
        console.log('⚠️ initial_state não apareceu no tempo esperado');
    }

    // ============================================
    // EXTRAÇÃO DE SCORES VIA RESPOSTAS DE REDE
    // Analisa todas as respostas JSON capturadas pelo interceptor
    // ============================================

    _extrairScoresDasRespostas(respostas) {
        if (!respostas || respostas.length === 0) return [];
        const scores = new Map(); // eventoId → { id, golCasa, golFora, ... }

        // Mapeamento de zoneId para nome da zona (liga)
        const zoneMap = new Map();
        const leagueMap = new Map();
        let totalEventosVRTS = 0;
        let eventosComPlacar = 0;

        for (const { url, json } of respostas) {
            // ============================================
            // ESTRUTURA DANAE-WEBAPI (nova estrutura)
            // ============================================
            if (url.includes('danae-webapi') || url.includes('live/overview/latest')) {
                // Extrai zones (nomes das zonas/países)
                if (json.zones) {
                    for (const [zoneId, zone] of Object.entries(json.zones)) {
                        zoneMap.set(zoneId, zone.name || zone.n || '');
                    }
                }
                
                // Extrai leagues (nomes das ligas)
                if (json.leagues) {
                    for (const [leagueId, league] of Object.entries(json.leagues)) {
                        leagueMap.set(leagueId, league.name || league.n || '');
                    }
                }
                
                // Extrai eventos (principal fonte de placares)
                if (json.events) {
                    for (const [eventId, event] of Object.entries(json.events)) {
                        // Conta todos os eventos VRTS para diagnóstico
                        if (event.sportId === 'VRTS') {
                            totalEventosVRTS++;
                        }
                        
                        // Filtra apenas futebol virtual
                        if (event.sportId !== 'VRTS' || !event.isVirtual) continue;
                        
                        const id = parseInt(eventId) || 0;
                        if (!id) continue;
                        
                        // Participantes (times)
                        const participants = event.participants || event.p || [];
                        const timeCasaRaw = participants[0]?.name || '';
                        const timeForaRaw = participants[1]?.name || '';
                        const timeCasaId = participants[0]?.teamId || null;
                        const timeForaId = participants[1]?.teamId || null;
                        
                        // Normaliza nomes dos times
                        const timeCasa = this._normalizarNomeTime(timeCasaRaw, timeCasaId);
                        const timeFora = this._normalizarNomeTime(timeForaRaw, timeForaId);
                        
                        // Liga (usa leagueId + zoneId para nome completo)
                        const leagueId = event.leagueId?.toString();
                        const zoneId = event.zoneId?.toString();
                        const leagueName = leagueMap.get(leagueId) || zoneMap.get(zoneId) || '';
                        
                        // liveData
                        const ld = event.liveData || event.ld || {};
                        const results = ld.results || ld.r || {};
                        const score = ld.score || ld.sc || {};
                        const fullTime = results.fullTimeScore || results.fts || {};
                        const setScoreList = results.setScoreList || results.sl || [];
                        
                        // Extrai placar
                        let golCasa = 0, golFora = 0;
                        
                        // Prioridade 1: setScoreList (soma de todos os sets/periodos)
                        if (Array.isArray(setScoreList) && setScoreList.length > 0) {
                            for (const set of setScoreList) {
                                golCasa += parseInt(set.home || set.h || 0);
                                golFora += parseInt(set.away || set.a || 0);
                            }
                        }
                        // Prioridade 2: fullTimeScore
                        else if (fullTime.home != null || fullTime.h != null) {
                            golCasa = parseInt(fullTime.home ?? fullTime.h) || 0;
                            golFora = parseInt(fullTime.away ?? fullTime.a) || 0;
                        }
                        // Prioridade 3: score (ao vivo)
                        else if (score.home != null || score.h != null) {
                            golCasa = parseInt(score.home ?? score.h) || 0;
                            golFora = parseInt(score.away ?? score.a) || 0;
                        }
                        
                        // Verifica se é jogo finalizado
                        const secondsToStart = event.startTime ? Date.now() - event.startTime : 999;
                        const isPostMatch = results.isPostMatch === true || results.psm === true;
                        const finalizado = isPostMatch || secondsToStart > 180000; // 3 minutos após início
                        
                        // Log de diagnóstico para eventos com placar
                        if (golCasa > 0 || golFora > 0) {
                            eventosComPlacar++;
                            console.log(`      🎯 [DANAE] ID ${id}: ${timeCasa} ${golCasa}x${golFora} ${timeFora} (${leagueName})`);
                        }
                        
                        if (golCasa > 0 || golFora > 0 || finalizado) {
                            scores.set(id, {
                                id,
                                golCasa,
                                golFora,
                                timeCasa,
                                timeFora,
                                liga: leagueName,
                                startTimeDatetime: event.startTime ? new Date(event.startTime).toISOString() : null,
                                secondsToStart: secondsToStart / 1000,
                                finalizado,
                                fonte: 'danae_webapi',
                                urlFonte: url.split('?')[0]
                            });
                        }
                    }
                }
                continue; // Não processa como estrutura antiga
            }

            // ============================================
            // ESTRUTURA ANTIGA (fallback)
            // ============================================
            this._buscarEventosComScore(json, scores, url, 0);
        }

        // Log de diagnóstico
        if (totalEventosVRTS > 0) {
            console.log(`      📊 VRTS: ${totalEventosVRTS} eventos | ${eventosComPlacar} com placar`);
        }

        return [...scores.values()];
    }

    _buscarEventosComScore(obj, scores, url, depth) {
        if (!obj || typeof obj !== 'object' || depth > 12) return;

        // ============================================
        // 1. PROCESSAR ARRAYS (results, ee, events, currentEvents)
        // ============================================
        if (Array.isArray(obj)) {
            // Verifica se é array de resultados finalizados (data.results / data.ee)
            // Estrutura: [{ events: [...], e: [...] }, ...]
            for (const item of obj) {
                if (item && typeof item === 'object') {
                    // Tenta extrair de events/e dentro de grupos de resultados
                    const eventos = item.events || item.e || [];
                    if (Array.isArray(eventos)) {
                        for (const ev of eventos) {
                            this._extrairScoreDeEventoFinalizado(ev, scores, url, 'data.results');
                        }
                    }
                    // Recursão para outros objetos no array
                    this._buscarEventosComScore(item, scores, url, depth + 1);
                }
            }
            // Também processa como array normal
            obj.forEach(item => this._buscarEventosComScore(item, scores, url, depth + 1));
            return;
        }

        // ============================================
        // 2. PROCESSAR OBJETO COMO EVENTO POTENCIAL
        // ============================================
        const idRaw = obj.id || obj.i || obj.eventId || obj.event_id;
        const id = parseInt(idRaw) || 0;

        if (id > 0) {
            this._extrairScoreDeEventoFinalizado(obj, scores, url, 'network_api');
        }

        // ============================================
        // 3. RECURSÃO EM OUTRAS PROPRIEDADES
        // ============================================
        for (const val of Object.values(obj)) {
            if (val && typeof val === 'object') {
                this._buscarEventosComScore(val, scores, url, depth + 1);
            }
        }
    }

    /**
     * Extrai placar de um evento (finalizado ou ao vivo)
     * Suporta múltiplos formatos de resposta da API Betano
     */
    _extrairScoreDeEventoFinalizado(obj, scores, url, fontePadrao) {
        const idRaw = obj.id || obj.i || obj.eventId || obj.event_id;
        const id = parseInt(idRaw) || 0;
        if (id === 0) return;

        let golCasa = null, golFora = null;
        let fonte = fontePadrao;

        // ============================================
        // TENTATIVA 1: data.results / data.ee (statistics)
        // ============================================
        const statistics = obj.statistics || obj.st || [];
        if (Array.isArray(statistics) && statistics.length > 0) {
            for (const stat of statistics) {
                const tipo = (stat.statisticsType || stat.k || '').toUpperCase();
                const vals = stat.value || stat.v || [];
                
                // Procura por "SCORE" ou "GOAL" nas estatísticas
                if ((tipo.includes('SCORE') || tipo === 'GOAL') && Array.isArray(vals) && vals.length >= 2) {
                    const home = parseInt(vals[0]?.score ?? vals[0]?.s ?? vals[0] ?? 0) || 0;
                    const away = parseInt(vals[1]?.score ?? vals[1]?.s ?? vals[1] ?? 0) || 0;
                    
                    if (home > 0 || away > 0) {
                        golCasa = home;
                        golFora = away;
                        fonte = 'data.results.statistics';
                        break;
                    }
                }
            }
        }

        // ============================================
        // TENTATIVA 2: liveData.results.fullTimeScore (placar final)
        // ============================================
        if (golCasa === null) {
            const ld = obj.liveData || obj.ld || {};
            const results = ld.results || ld.r || {};
            const fullTime = results.fullTimeScore || results.fts || {};
            
            if (fullTime.home != null || fullTime.h != null) {
                const h = parseInt(fullTime.home ?? fullTime.h);
                const a = parseInt(fullTime.away ?? fullTime.a);
                
                if (!isNaN(h) && !isNaN(a)) {
                    golCasa = h;
                    golFora = a;
                    fonte = 'liveData.fullTimeScore';
                }
            }
        }

        // ============================================
        // TENTATIVA 3: liveData.score (placar ao vivo/final)
        // ============================================
        if (golCasa === null) {
            const ld = obj.liveData || obj.ld || {};
            const score = ld.score || ld.sc || {};
            
            if (score.home != null || score.h != null) {
                const h = parseInt(score.home ?? score.h);
                const a = parseInt(score.away ?? score.a);
                
                if (!isNaN(h) && !isNaN(a) && (h > 0 || a > 0)) {
                    golCasa = h;
                    golFora = a;
                    fonte = 'liveData.score';
                }
            }
        }

        // ============================================
        // TENTATIVA 4: Paths alternativos
        // ============================================
        if (golCasa === null) {
            const tentativas = [
                () => { const g = ((obj.liveData||obj.ld||{}).results||{}).goal||{}; return [g.home??g.h, g.away??g.a]; },
                () => [obj.homeScore??obj.home_score, obj.awayScore??obj.away_score],
                () => { const sc = obj.score||{}; return [sc.home??sc.h, sc.away??sc.a]; },
                () => { const sc = obj.result||obj.finalScore||{}; return [sc.home??sc.h, sc.away??sc.a]; },
                () => [obj.goals_home??obj.goalsHome, obj.goals_away??obj.goalsAway],
            ];

            for (const tentar of tentativas) {
                try {
                    const [h, a] = tentar();
                    if ((h != null || a != null) && (h !== '' || a !== '')) {
                        const gc = parseInt(h ?? 0);
                        const gf = parseInt(a ?? 0);
                        if (!isNaN(gc) && !isNaN(gf) && (gc > 0 || gf > 0)) {
                            golCasa = gc;
                            golFora = gf;
                            fonte = 'alternative_paths';
                            break;
                        }
                    }
                } catch {}
            }
        }

        // ============================================
        // SALVAR SE ENCONTROU PLACAR
        // ============================================
        if (golCasa !== null && golFora !== null) {
            const existing = scores.get(id);
            const total = golCasa + golFora;
            
            // Salva se não existe ou se tem mais gols (prioriza placar final)
            if (!existing || total > (existing.golCasa + existing.golFora)) {
                const dnp = obj.displayNameParts || obj.dnp || obj.participants || [];
                const timeCasa = (Array.isArray(dnp) ? dnp[0]?.name : '') ||
                                 obj.teamHome || obj.home_team || obj.homeTeam || '';
                const timeFora = (Array.isArray(dnp) ? dnp[1]?.name : '') ||
                                 obj.teamAway || obj.away_team || obj.awayTeam || '';
                const liga = obj.leagueName || obj.leagueDescription || obj.league_name ||
                             obj.league || '';
                const startTime = obj.startTime || obj.start_time || obj.tt || 0;

                // Verifica se é jogo FINALIZADO
                const ld = obj.liveData || obj.ld || {};
                const results = ld.results || ld.r || {};
                const isPostMatch = results.isPostMatch === true || results.psm === true;
                const hasFullTime = results.fullTimeScore && (results.fullTimeScore.home != null || results.fullTimeScore.away != null);
                const secondsToStart = obj.secondsToStart != null ? obj.secondsToStart : 999;
                const finalizado = isPostMatch || hasFullTime || (secondsToStart < -180);

                scores.set(id, {
                    id, golCasa, golFora, timeCasa, timeFora, liga,
                    startTimeDatetime: startTime ? new Date(startTime).toISOString() : null,
                    secondsToStart, finalizado,
                    fonte,
                    urlFonte: url.split('?')[0]
                });
            }
        }
    }

    // ============================================
    // DETECTAR E SALVAR RESULTADOS FINAIS
    // ============================================

    async detectarPartidaFinalizadas(novosEventosIds) {
        const pool = await this.conectarBanco();

        // Busca eventos que já passaram do horário + não têm resultado ainda
        // Usa colunas com fallback caso ainda não existam no banco
        let candidatos;
        try {
            candidatos = await pool.request().query(`
                SELECT id, league_name, time_casa, time_fora,
                       ISNULL(gol_casa,0) AS gol_casa,
                       ISNULL(gol_fora,0) AS gol_fora,
                       ISNULL(odd_casa,0) AS odd_casa,
                       ISNULL(odd_empate,0) AS odd_empate,
                       ISNULL(odd_fora,0) AS odd_fora,
                       start_time_datetime, status
                FROM betano_eventos
                WHERE start_time_datetime IS NOT NULL
                  AND start_time_datetime < DATEADD(MINUTE, -3, GETDATE())
                  AND time_casa <> '' AND time_fora <> ''
                  AND NOT EXISTS (
                      SELECT 1 FROM betano_historico_partidas
                      WHERE evento_id = betano_eventos.id
                  )
            `);
        } catch (err) {
            console.log(`   ⚠️ detectarPartidaFinalizadas erro query: ${err.message}`);
            return 0;
        }

        const total = candidatos.recordset.length;
        if (total > 0) console.log(`🔎 detectarPartidaFinalizadas: ${total} candidatos`);

        let resultadosSalvos = 0;

        for (const ev of candidatos.recordset) {
            // NÃO pula eventos novos - tenta buscar placar de todas as fontes
            // if (novosEventosIds.has(Number(ev.id))) continue;
            
            if (!this._isFutebol(ev.league_name, ev.time_casa, ev.time_fora)) {
                console.log(`   ⚠️ Ignorado (não futebol): ev${ev.id} - ${ev.time_casa} x ${ev.time_fora}`);
                continue;
            }
            // Filtrar apenas ligas permitidas
            if (!this._isLigaPermitida(ev.league_name)) {
                console.log(`   ⚠️ Ignorado (liga não permitida): ev${ev.id} - ${ev.league_name}`);
                continue;
            }

            let gCasa = ev.gol_casa ?? 0;
            let gFora = ev.gol_fora ?? 0;
            let fonte = 'betano_eventos';

            // ============================================
            // TENTA RECUPERAR PLACAR DA API DANAE (fonte mais confiável)
            // ============================================
            if (gCasa === 0 && gFora === 0 && this._capturedResponses && this._capturedResponses.length > 0) {
                for (const { url, json } of this._capturedResponses) {
                    if (url.includes('danae-webapi') && json.events && json.events[ev.id]) {
                        const event = json.events[ev.id];
                        const ld = event.liveData || {};
                        const results = ld.results || {};
                        const score = ld.score || {};
                        const fullTime = results.fullTimeScore || {};
                        const setScoreList = results.setScoreList || [];
                        
                        // Extrai placar
                        if (Array.isArray(setScoreList) && setScoreList.length > 0) {
                            for (const set of setScoreList) {
                                gCasa += parseInt(set.home || set.h || 0);
                                gFora += parseInt(set.away || set.a || 0);
                            }
                            fonte = 'danae_setScoreList';
                        } else if (fullTime.home != null) {
                            gCasa = parseInt(fullTime.home) || 0;
                            gFora = parseInt(fullTime.away) || 0;
                            fonte = 'danae_fullTime';
                        } else if (score.home != null) {
                            gCasa = parseInt(score.home) || 0;
                            gFora = parseInt(score.away) || 0;
                            fonte = 'danae_score';
                        }
                        
                        if (gCasa > 0 || gFora > 0) break;
                    }
                }
            }

            // Tenta recuperar placar da tabela de estatísticas em tempo real
            if (gCasa === 0 && gFora === 0) {
                try {
                    const statsR = await pool.request()
                        .input('eventoId', sql.BigInt, ev.id)
                        .query(`
                            SELECT TOP 1 gol_casa, gol_fora
                            FROM betano_estatisticas_tempo_real
                            WHERE evento_id = @eventoId
                              AND (gol_casa > 0 OR gol_fora > 0)
                            ORDER BY data_coleta DESC
                        `);
                    if (statsR.recordset.length > 0) {
                        gCasa = statsR.recordset[0].gol_casa || 0;
                        gFora = statsR.recordset[0].gol_fora || 0;
                        fonte = 'estatisticas_tempo_real';
                    }
                } catch {}
            }

            // ============================================
            // FALLBACK: Extração via HTML PARSING
            // Tenta buscar placar diretamente do HTML da página do evento
            // ============================================
            if (gCasa === 0 && gFora === 0 && ev.url && ev.url.trim() !== '') {
                try {
                    const fullUrl = ev.url.startsWith('http')
                        ? ev.url
                        : `https://www.betano.bet.br/${ev.url.replace(/^\//, '')}`;
                    
                    console.log(`   🌐 Tentando HTML: ${fullUrl}`);
                    
                    await this.page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
                    await this._delay(3000);
                    
                    const placarHTML = await this.page.evaluate(() => {
                        const placares = [];
                        const containers = document.querySelectorAll('[class*="tw-flex"][class*="tw-items-center"][class*="tw-justify-center"]');
                        
                        containers.forEach(container => {
                            try {
                                const children = Array.from(container.children);
                                for (let i = 0; i < children.length; i++) {
                                    const child = children[i];
                                    const text = (child.textContent || '').trim();
                                    
                                    if (/^\d+\s*-\s*\d+$/.test(text)) {
                                        const [golC, golF] = text.split('-').map(s => parseInt(s.trim()) || 0);
                                        const timeC = (i > 0) ? (children[i - 1].textContent || '').trim() : '';
                                        const timeF = (i < children.length - 1) ? (children[i + 1].textContent || '').trim() : '';
                                        
                                        if (timeC.length > 2 && timeF.length > 2) {
                                            placares.push({ timeCasa: timeC, timeFora: timeF, golCasa: golC, golFora: golF });
                                        }
                                        break;
                                    }
                                }
                            } catch (e) {}
                        });
                        
                        return placares;
                    });
                    
                    // Tenta encontrar placar correspondente
                    const placarCorrespondente = placarHTML.find(p => {
                        const timeCasaNorm = p.timeCasa.toLowerCase().replace(/[^a-z]/g, '');
                        const timeForaNorm = p.timeFora.toLowerCase().replace(/[^a-z]/g, '');
                        const evCasaNorm = ev.time_casa.toLowerCase().replace(/[^a-z]/g, '');
                        const evForaNorm = ev.time_fora.toLowerCase().replace(/[^a-z]/g, '');
                        
                        return (timeCasaNorm.includes(evCasaNorm) || evCasaNorm.includes(timeCasaNorm)) &&
                               (timeForaNorm.includes(evForaNorm) || evForaNorm.includes(timeForaNorm));
                    });
                    
                    if (placarCorrespondente) {
                        gCasa = placarCorrespondente.golCasa;
                        gFora = placarCorrespondente.golFora;
                        fonte = 'html_parsing';
                        console.log(`   ✅ HTML: ${ev.time_casa} ${gCasa}x${gFora} ${ev.time_fora}`);
                    }
                    
                    // Volta para página principal
                    await this.page.goto(this.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                } catch (err) {
                    console.log(`   ⚠️ Erro HTML parsing: ${err.message}`);
                }
            }

            // ============================================
            // NÃO salva placar 0x0 APENAS SE:
            // - Jogo já passou de 3 minutos do horário de início
            // ============================================
            const agora = new Date();
            const inicioPartida = ev.start_time_datetime;
            const diffMs = agora - inicioPartida;
            const diffMin = diffMs / 60000;
            
            // Se placar 0x0 e jogo tem menos de 3 min, aguarda
            if (gCasa === 0 && gFora === 0 && diffMin < 3) {
                console.log(`   ⏩ Sem placar: ${ev.time_casa} x ${ev.time_fora} (${ev.league_name}) — aguardando captura (${Math.floor(diffMin * 60)}s)`);
                continue;
            }

            // Se chegou aqui e é 0x0, confirma placar
            if (gCasa === 0 && gFora === 0) {
                console.log(`   ⚠️ Placar 0x0 confirmado: ${ev.time_casa} x ${ev.time_fora}`);
            }

            const resultado = gCasa > gFora ? 'CASA' : gFora > gCasa ? 'FORA' : 'EMPATE';

            try {
                await pool.request()
                    .input('eventoId',   sql.BigInt,        ev.id)
                    .input('liga',       sql.NVarChar(200),  ev.league_name || '')
                    .input('timeCasa',   sql.NVarChar(100),  ev.time_casa   || '')
                    .input('timeFora',   sql.NVarChar(100),  ev.time_fora   || '')
                    .input('golCasa',    sql.Int,            gCasa)
                    .input('golFora',    sql.Int,            gFora)
                    .input('resultado',  sql.NVarChar(10),   resultado)
                    .input('oddCasa',    sql.Decimal(10,2),  ev.odd_casa    || 0)
                    .input('oddEmpate',  sql.Decimal(10,2),  ev.odd_empate  || 0)
                    .input('oddFora',    sql.Decimal(10,2),  ev.odd_fora    || 0)
                    .input('dataPartida',sql.DateTime2,      ev.start_time_datetime || new Date())
                    .query(`
                        IF NOT EXISTS (SELECT 1 FROM betano_historico_partidas WHERE evento_id = @eventoId)
                        INSERT INTO betano_historico_partidas
                            (evento_id, liga, time_casa, time_fora,
                             gol_casa, gol_fora, resultado,
                             odd_casa, odd_empate, odd_fora, data_partida)
                        VALUES
                            (@eventoId, @liga, @timeCasa, @timeFora,
                             @golCasa, @golFora, @resultado,
                             @oddCasa, @oddEmpate, @oddFora, @dataPartida)
                    `);
                resultadosSalvos++;
                console.log(`📋 [${fonte}] ${ev.time_casa} ${gCasa}x${gFora} ${ev.time_fora} [${resultado}] (${ev.league_name})`);
            } catch (err) {
                console.log(`   ⚠️ Erro ao salvar resultado ${ev.id}: ${err.message}`);
            }
        }

        return resultadosSalvos;
    }

    // ============================================
    // SALVAR NO BANCO
    // ============================================

    async salvarNoBanco(eventos, finalizadosDiretos = []) {
        if (!eventos || eventos.length === 0) return { success: false, count: 0 };

        const pool = await this.conectarBanco();
        let salvos = 0, atualizados = 0, totalMercados = 0, totalOdds = 0;
        let estatisticasSalvas = 0, historicoOddsSalvo = 0, resultadosSalvos = 0;

        // ── FILTRAR APENAS FUTEBOL DAS LIGAS PERMITIDAS ──────────────────────────────
        const eventosFutebol = eventos.filter(e => {
            // Primeiro verifica se é futebol (exclui outros esportes)
            if (!this._isFutebol(e.liga, e.timeCasa, e.timeFora)) return false;
            // Depois verifica se está na lista de ligas permitidas
            if (!this._isLigaPermitida(e.liga)) return false;
            return true;
        });
        const excluidos = eventos.length - eventosFutebol.length;
        if (excluidos > 0) console.log(`⚽ Filtro futebol: ${eventosFutebol.length} futebol | ${excluidos} outros esportes/ligas descartados`);
        eventos = eventosFutebol;

        if (eventos.length === 0) {
            console.log('⚠️ Nenhum evento de futebol após filtro');
            return { success: false, count: 0, motivo: 'sem_futebol' };
        }

        // ── REGISTRAR LOG DE INÍCIO ─────────────────────────────
        let logId = null;
        try {
            const logStart = await pool.request()
                .input('eventosColetados', sql.Int, eventos.length)
                .query(`
                    INSERT INTO betano_log_coleta (data_inicio, status, eventos_coletados)
                    OUTPUT INSERTED.id
                    VALUES (GETDATE(), 'EM_ANDAMENTO', @eventosColetados)
                `);
            logId = logStart.recordset[0]?.id || null;
        } catch {}

        const novosIds = new Set(eventos.map(e => Number(e.id)));

        // Pré-atualiza gol_casa/gol_fora em betano_eventos a partir dos finalizados capturados
        // Garante que detectarPartidaFinalizadas() vai encontrar o placar correto no banco
        for (const fin of finalizadosDiretos) {
            if (!fin.id || (fin.golCasa === 0 && fin.golFora === 0)) continue;
            try {
                await pool.request()
                    .input('id',      sql.BigInt, fin.id)
                    .input('golCasa', sql.Int,    fin.golCasa)
                    .input('golFora', sql.Int,    fin.golFora)
                    .query(`
                        UPDATE betano_eventos
                        SET gol_casa = @golCasa, gol_fora = @golFora
                        WHERE id = @id AND (gol_casa = 0 AND gol_fora = 0)
                    `);
            } catch {}
        }

        // Detectar partidas finalizadas antes de desativar
        resultadosSalvos = await this.detectarPartidaFinalizadas(novosIds);

        // ── Salvar finalizados capturados direto da página (têm placar real) ──
        if (finalizadosDiretos.length > 0) {
            for (const fin of finalizadosDiretos) {
                if (fin.golCasa === 0 && fin.golFora === 0) continue; // placar inválido

                try {
                    // Busca o evento no banco para: validar que é futebol, obter liga correta e odds
                    let evDB = await pool.request()
                        .input('id', sql.BigInt, fin.id)
                        .query('SELECT league_name, time_casa, time_fora, odd_casa, odd_empate, odd_fora, start_time_datetime FROM betano_eventos WHERE id = @id');

                    // Se não existe no banco, cria o evento primeiro
                    if (!evDB.recordset.length) {
                        await pool.request()
                            .input('id', sql.BigInt, fin.id)
                            .input('liga', sql.NVarChar(200), fin.liga || '')
                            .input('timeCasa', sql.NVarChar(100), fin.timeCasa || '')
                            .input('timeFora', sql.NVarChar(100), fin.timeFora || '')
                            .input('startTimeDatetime', sql.DateTime2, fin.startTimeDatetime ? new Date(fin.startTimeDatetime) : new Date())
                            .input('url', sql.NVarChar(500), '')
                            .query(`
                                IF NOT EXISTS (SELECT 1 FROM betano_eventos WHERE id = @id)
                                INSERT INTO betano_eventos (id, league_name, time_casa, time_fora, start_time_datetime, status, ativo, data_coleta, url)
                                VALUES (@id, @liga, @timeCasa, @timeFora, @startTimeDatetime, 'FINALIZADO', 0, GETDATE(), @url)
                            `);
                        evDB = await pool.request()
                            .input('id', sql.BigInt, fin.id)
                            .query('SELECT league_name, time_casa, time_fora, odd_casa, odd_empate, odd_fora, start_time_datetime FROM betano_eventos WHERE id = @id');
                    }

                    // Só salva se o evento existe em betano_eventos (garantia de que é futebol coletado)
                    if (!evDB.recordset.length) continue;

                    const evRow = evDB.recordset[0];
                    const ligaFinal  = fin.liga    || evRow.league_name || '';
                    const timeCasaFinal = fin.timeCasa || evRow.time_casa || '';
                    const timeForaFinal = fin.timeFora || evRow.time_fora || '';

                    // Valida futebol com liga correta do banco E liga permitida
                    if (!this._isFutebol(ligaFinal, timeCasaFinal, timeForaFinal)) continue;
                    if (!this._isLigaPermitida(ligaFinal)) continue;

                    const check = await pool.request()
                        .input('eventoId', sql.BigInt, fin.id)
                        .query('SELECT id FROM betano_historico_partidas WHERE evento_id = @eventoId');
                    if (check.recordset.length > 0) continue;

                    const gCasa = fin.golCasa;
                    const gFora = fin.golFora;
                    const resultado = gCasa > gFora ? 'CASA' : gFora > gCasa ? 'FORA' : 'EMPATE';

                    const oddsDB = evRow; // odds já obtidas acima

                    await pool.request()
                        .input('eventoId',   sql.BigInt,        fin.id)
                        .input('liga',       sql.NVarChar(200), ligaFinal)
                        .input('timeCasa',   sql.NVarChar(100), timeCasaFinal)
                        .input('timeFora',   sql.NVarChar(100), timeForaFinal)
                        .input('golCasa',    sql.Int,           gCasa)
                        .input('golFora',    sql.Int,           gFora)
                        .input('resultado',  sql.NVarChar(10),  resultado)
                        .input('oddCasa',    sql.Decimal(10,2), oddsDB.odd_casa    || 0)
                        .input('oddEmpate',  sql.Decimal(10,2), oddsDB.odd_empate  || 0)
                        .input('oddFora',    sql.Decimal(10,2), oddsDB.odd_fora    || 0)
                        .input('dataPartida',sql.DateTime2,
                               fin.startTimeDatetime ? new Date(fin.startTimeDatetime)
                               : evRow.start_time_datetime ? new Date(evRow.start_time_datetime)
                               : new Date())
                        .query(`
                            INSERT INTO betano_historico_partidas
                                (evento_id, liga, time_casa, time_fora,
                                 gol_casa, gol_fora, resultado,
                                 odd_casa, odd_empate, odd_fora, data_partida)
                            VALUES
                                (@eventoId, @liga, @timeCasa, @timeFora,
                                 @golCasa, @golFora, @resultado,
                                 @oddCasa, @oddEmpate, @oddFora, @dataPartida)
                        `);
                    resultadosSalvos++;
                    console.log(`✅ Resultado direto [${fin.fonte}]: ${timeCasaFinal} ${gCasa}x${gFora} ${timeForaFinal} [${resultado}] (${ligaFinal})`);
                } catch (err) {
                    console.log(`   ⚠️ Erro ao salvar finalizado ${fin.id}: ${err.message}`);
                }
            }
        }

        // Desativar eventos antigos
        await pool.request().query(`UPDATE betano_eventos SET ativo = 0 WHERE ativo = 1`);

        // Odds anteriores para cálculo de variação
        const oddsAnterioresResult = await pool.request().query(
            `SELECT id, valor FROM betano_odds WHERE ativo = 1`
        );
        const oddsAnterioresMap = new Map();
        oddsAnterioresResult.recordset.forEach(r => oddsAnterioresMap.set(Number(r.id), Number(r.valor)));

        for (const evento of eventos) {
            if (!evento.id) continue;
            const eventoId = BigInt(evento.id);

            const check = await pool.request()
                .input('id', sql.BigInt, eventoId)
                .query('SELECT id FROM betano_eventos WHERE id = @id');

            const params = (req) => req
                .input('id',              sql.BigInt,        eventoId)
                .input('liga',            sql.NVarChar(200), evento.liga             || '')
                .input('timeCasa',        sql.NVarChar(100), evento.timeCasa         || '')
                .input('timeFora',        sql.NVarChar(100), evento.timeFora         || '')
                .input('status',          sql.NVarChar(50),  evento.status           || 'AGENDADO')
                .input('secondsToStart',  sql.Int,           evento.secondsToStart   || 999)
                .input('startTime',       sql.BigInt,        BigInt(evento.startTime || 0))
                .input('startTimeDatetime', sql.DateTime2,   evento.startTimeDatetime ? new Date(evento.startTimeDatetime) : null)
                .input('url',             sql.NVarChar(500), evento.url              || '')
                .input('golCasa',         sql.Int,           evento.golCasa          || 0)
                .input('golFora',         sql.Int,           evento.golFora          || 0)
                .input('golCasaHT',       sql.Int,           evento.golCasaHT        || 0)
                .input('golForaHT',       sql.Int,           evento.golForaHT        || 0)
                .input('minutoJogo',      sql.NVarChar(20),  evento.minutoJogo       || '')
                .input('periodo',         sql.NVarChar(50),  evento.periodo          || '')
                .input('oddCasa',         sql.Decimal(10,2), evento.oddCasa          || 0)
                .input('oddEmpate',       sql.Decimal(10,2), evento.oddEmpate        || 0)
                .input('oddFora',         sql.Decimal(10,2), evento.oddFora          || 0)
                .input('posseBolaCasa',   sql.Decimal(5,2),  evento.estatisticas?.posseBolaCasa      || 0)
                .input('posseBolaFora',   sql.Decimal(5,2),  evento.estatisticas?.posseBolaFora      || 0)
                .input('chutesCasa',      sql.Int,           evento.estatisticas?.chutesCasa         || 0)
                .input('chutesFora',      sql.Int,           evento.estatisticas?.chutesFora         || 0)
                .input('chutesGolCasa',   sql.Int,           evento.estatisticas?.chutesGolCasa      || 0)
                .input('chutesGolFora',   sql.Int,           evento.estatisticas?.chutesGolFora      || 0)
                .input('escanteiosCasa',  sql.Int,           evento.estatisticas?.escanteiosCasa     || 0)
                .input('escanteiosFora',  sql.Int,           evento.estatisticas?.escanteiosFora     || 0)
                .input('cartoesAmarelosCasa',  sql.Int,      evento.estatisticas?.cartoesAmarelosCasa  || 0)
                .input('cartoesAmarelosFora',  sql.Int,      evento.estatisticas?.cartoesAmarelosFora  || 0)
                .input('cartoesVermelhosCasa', sql.Int,      evento.estatisticas?.cartoesVermelhosCasa || 0)
                .input('cartoesVermelhosFora', sql.Int,      evento.estatisticas?.cartoesVermelhosFora || 0)
                .input('estatisticasJson', sql.NVarChar(sql.MAX), JSON.stringify(evento.estatisticas || {}));

            if (check.recordset.length > 0) {
                await params(pool.request()).query(`
                    UPDATE betano_eventos SET
                        league_name=@liga, time_casa=@timeCasa, time_fora=@timeFora,
                        status=@status, seconds_to_start=@secondsToStart,
                        start_time=@startTime, start_time_datetime=@startTimeDatetime,
                        url=@url,
                        gol_casa=@golCasa, gol_fora=@golFora,
                        gol_casa_ht=@golCasaHT, gol_fora_ht=@golForaHT,
                        minuto_jogo=@minutoJogo, periodo=@periodo,
                        odd_casa=@oddCasa, odd_empate=@oddEmpate, odd_fora=@oddFora,
                        posse_bola_casa=@posseBolaCasa, posse_bola_fora=@posseBolaFora,
                        chutes_casa=@chutesCasa, chutes_fora=@chutesFora,
                        chutes_gol_casa=@chutesGolCasa, chutes_gol_fora=@chutesGolFora,
                        escanteios_casa=@escanteiosCasa, escanteios_fora=@escanteiosFora,
                        cartoes_amarelos_casa=@cartoesAmarelosCasa,
                        cartoes_amarelos_fora=@cartoesAmarelosFora,
                        cartoes_vermelhos_casa=@cartoesVermelhosCasa,
                        cartoes_vermelhos_fora=@cartoesVermelhosFora,
                        estatisticas_json=@estatisticasJson,
                        ativo=1, data_atualizacao=GETDATE()
                    WHERE id=@id
                `);
                atualizados++;
            } else {
                await params(pool.request()).query(`
                    INSERT INTO betano_eventos (
                        id, league_name, time_casa, time_fora, status, seconds_to_start,
                        start_time, start_time_datetime, url,
                        gol_casa, gol_fora, gol_casa_ht, gol_fora_ht,
                        minuto_jogo, periodo,
                        odd_casa, odd_empate, odd_fora,
                        posse_bola_casa, posse_bola_fora,
                        chutes_casa, chutes_fora, chutes_gol_casa, chutes_gol_fora,
                        escanteios_casa, escanteios_fora,
                        cartoes_amarelos_casa, cartoes_amarelos_fora,
                        cartoes_vermelhos_casa, cartoes_vermelhos_fora,
                        estatisticas_json, ativo, data_coleta, data_atualizacao
                    ) VALUES (
                        @id, @liga, @timeCasa, @timeFora, @status, @secondsToStart,
                        @startTime, @startTimeDatetime, @url,
                        @golCasa, @golFora, @golCasaHT, @golForaHT,
                        @minutoJogo, @periodo,
                        @oddCasa, @oddEmpate, @oddFora,
                        @posseBolaCasa, @posseBolaFora,
                        @chutesCasa, @chutesFora, @chutesGolCasa, @chutesGolFora,
                        @escanteiosCasa, @escanteiosFora,
                        @cartoesAmarelosCasa, @cartoesAmarelosFora,
                        @cartoesVermelhosCasa, @cartoesVermelhosFora,
                        @estatisticasJson, 1, GETDATE(), GETDATE()
                    )
                `);
                salvos++;
            }

            // Estatísticas em tempo real (somente ao vivo)
            if (evento.status === 'EM_ANDAMENTO' && evento.estatisticas) {
                await pool.request()
                    .input('eventoId',       sql.BigInt,     eventoId)
                    .input('minuto',         sql.NVarChar(20), evento.minutoJogo || '')
                    .input('golCasa',        sql.Int,          evento.golCasa || 0)
                    .input('golFora',        sql.Int,          evento.golFora || 0)
                    .input('posseBolaCasa',  sql.Decimal(5,2), evento.estatisticas.posseBolaCasa || 0)
                    .input('posseBolaFora',  sql.Decimal(5,2), evento.estatisticas.posseBolaFora || 0)
                    .input('chutesCasa',     sql.Int,          evento.estatisticas.chutesCasa    || 0)
                    .input('chutesFora',     sql.Int,          evento.estatisticas.chutesFora    || 0)
                    .input('chutesGolCasa',  sql.Int,          evento.estatisticas.chutesGolCasa || 0)
                    .input('chutesGolFora',  sql.Int,          evento.estatisticas.chutesGolFora || 0)
                    .input('escanteiosCasa', sql.Int,          evento.estatisticas.escanteiosCasa || 0)
                    .input('escanteiosFora', sql.Int,          evento.estatisticas.escanteiosFora || 0)
                    .input('dadosCompletos', sql.NVarChar(sql.MAX), JSON.stringify(evento))
                    .query(`
                        INSERT INTO betano_estatisticas_tempo_real (
                            evento_id, minuto, gol_casa, gol_fora,
                            posse_bola_casa, posse_bola_fora,
                            chutes_casa, chutes_fora, chutes_gol_casa, chutes_gol_fora,
                            escanteios_casa, escanteios_fora,
                            dados_completos, data_coleta
                        ) VALUES (
                            @eventoId, @minuto, @golCasa, @golFora,
                            @posseBolaCasa, @posseBolaFora,
                            @chutesCasa, @chutesFora, @chutesGolCasa, @chutesGolFora,
                            @escanteiosCasa, @escanteiosFora,
                            @dadosCompletos, GETDATE()
                        )
                    `);
                estatisticasSalvas++;
            }

            // Mercados e odds
            for (const mercado of evento.mercados || []) {
                if (!mercado.id) continue;
                const mercadoId = BigInt(mercado.id);

                const mCheck = await pool.request()
                    .input('id', sql.BigInt, mercadoId)
                    .query('SELECT id FROM betano_mercados WHERE id = @id');

                if (mCheck.recordset.length > 0) {
                    await pool.request()
                        .input('id', sql.BigInt, mercadoId)
                        .input('eventoId', sql.BigInt, eventoId)
                        .input('nome', sql.NVarChar(200), mercado.nome)
                        .input('tipo', sql.NVarChar(50), mercado.tipo)
                        .query(`UPDATE betano_mercados SET evento_id=@eventoId, nome=@nome, tipo=@tipo, ativo=1, data_coleta=GETDATE() WHERE id=@id`);
                } else {
                    await pool.request()
                        .input('id', sql.BigInt, mercadoId)
                        .input('eventoId', sql.BigInt, eventoId)
                        .input('nome', sql.NVarChar(200), mercado.nome)
                        .input('tipo', sql.NVarChar(50), mercado.tipo)
                        .query(`INSERT INTO betano_mercados (id, evento_id, nome, tipo, ativo, data_coleta) VALUES (@id, @eventoId, @nome, @tipo, 1, GETDATE())`);
                }
                totalMercados++;

                for (const odd of mercado.selecoes || []) {
                    if (!odd.id) continue;
                    const oddId      = BigInt(odd.id);
                    const valorAtual = odd.valor || 0;
                    const valorAnt   = oddsAnterioresMap.get(Number(odd.id)) || 0;
                    const variacao   = (valorAnt > 0 && valorAtual > 0)
                        ? ((valorAtual - valorAnt) / valorAnt) * 100 : 0;

                    const oCheck = await pool.request()
                        .input('id', sql.BigInt, oddId)
                        .query('SELECT id FROM betano_odds WHERE id = @id');

                    if (oCheck.recordset.length > 0) {
                        await pool.request()
                            .input('id', sql.BigInt, oddId)
                            .input('mercadoId', sql.BigInt, mercadoId)
                            .input('eventoId',  sql.BigInt, eventoId)
                            .input('nome',      sql.NVarChar(100), odd.nome)
                            .input('fullName',  sql.NVarChar(200), odd.fullName)
                            .input('valor',     sql.Decimal(10,2), valorAtual)
                            .query(`UPDATE betano_odds SET mercado_id=@mercadoId, evento_id=@eventoId, nome=@nome, full_name=@fullName, valor=@valor, ativo=1, data_coleta=GETDATE() WHERE id=@id`);
                    } else {
                        await pool.request()
                            .input('id', sql.BigInt, oddId)
                            .input('mercadoId', sql.BigInt, mercadoId)
                            .input('eventoId',  sql.BigInt, eventoId)
                            .input('nome',      sql.NVarChar(100), odd.nome)
                            .input('fullName',  sql.NVarChar(200), odd.fullName)
                            .input('valor',     sql.Decimal(10,2), valorAtual)
                            .query(`INSERT INTO betano_odds (id, mercado_id, evento_id, nome, full_name, valor, ativo, data_coleta) VALUES (@id, @mercadoId, @eventoId, @nome, @fullName, @valor, 1, GETDATE())`);
                    }
                    totalOdds++;

                    // Histórico de odds (só se mudou)
                    if (Math.abs(variacao) > 0.01 || valorAnt === 0) {
                        await pool.request()
                            .input('eventoId',          sql.BigInt,       eventoId)
                            .input('mercadoId',         sql.BigInt,       mercadoId)
                            .input('oddId',             sql.BigInt,       oddId)
                            .input('nomeSelecao',       sql.NVarChar(100), odd.nome)
                            .input('valorOdd',          sql.Decimal(10,2), valorAtual)
                            .input('valorAnterior',     sql.Decimal(10,2), valorAnt)
                            .input('variacaoPercentual',sql.Decimal(10,4), variacao)
                            .query(`
                                INSERT INTO betano_historico_odds (
                                    evento_id, mercado_id, odd_id, nome_selecao,
                                    valor_odd, valor_anterior, variacao_percentual, data_coleta
                                ) VALUES (
                                    @eventoId, @mercadoId, @oddId, @nomeSelecao,
                                    @valorOdd, @valorAnterior, @variacaoPercentual, GETDATE()
                                )
                            `);
                        historicoOddsSalvo++;
                    }
                }
            }
        }

        console.log(`✅ ${salvos} novos | ${atualizados} atualiz. | ${totalMercados} merc. | ${totalOdds} odds | ${resultadosSalvos} resultados`);

        // ── EXIBIR TOTAL NO HISTÓRICO (para diagnóstico) ───────
        try {
            const totalHistorico = await pool.request().query('SELECT COUNT(*) as total FROM betano_historico_partidas');
            const hojeHistorico = await pool.request().query('SELECT COUNT(*) as hoje FROM betano_historico_partidas WHERE CAST(data_partida AS DATE) = CAST(GETDATE() AS DATE)');
            const totalHistoricoLigas = await pool.request().query(`
                SELECT COUNT(*) as total FROM betano_historico_partidas 
                WHERE LOWER(liga) IN ('brasileirão betano', 'clássicos da américa', 'copa america', 'euro', 'ligas america', 
                      'british derbies', 'liga espanhola', 'scudetto italiano', 'campeonato italiano', 'copa das estrelas', 'campeões')
            `);
            console.log(`📊 HISTÓRICO: ${totalHistorico.recordset[0].total} total | ${hojeHistorico.recordset[0].hoje} hoje | ${totalHistoricoLigas.recordset[0].total} ligas permitidas`);
        } catch {}

        // ── FECHAR LOG DE COLETA ────────────────────────────────
        if (logId) {
            try {
                await pool.request()
                    .input('logId',           sql.BigInt, BigInt(logId))
                    .input('salvos',          sql.Int,    salvos)
                    .input('atualizados',     sql.Int,    atualizados)
                    .input('mercados',        sql.Int,    totalMercados)
                    .input('odds',            sql.Int,    totalOdds)
                    .input('estatisticas',    sql.Int,    estatisticasSalvas)
                    .input('histOdds',        sql.Int,    historicoOddsSalvo)
                    .input('resultados',      sql.Int,    resultadosSalvos)
                    .query(`
                        UPDATE betano_log_coleta SET
                            data_fim = GETDATE(), status = 'SUCESSO',
                            eventos_coletados = @salvos + @atualizados,
                            mercados_coletados = @mercados,
                            odds_coletadas = @odds,
                            estatisticas_coletadas = @estatisticas,
                            historico_odds_salvas = @histOdds
                        WHERE id = @logId
                    `);
            } catch {}
        }

        return {
            success: true, count: eventos.length,
            salvos, atualizados, mercados: totalMercados, odds: totalOdds,
            estatisticas: estatisticasSalvas, historicoOdds: historicoOddsSalvo, resultadosSalvos
        };
    }

    // ============================================
    // VERIFICAR RESULTADO VIA URL DO EVENTO
    // A página principal só mostra agendados — quando o jogo acaba,
    // ele some da lista. Visitamos a URL individual para capturar o placar.
    // ============================================

    async verificarEventosFinalizados() {
        const pool = await this.conectarBanco();
        let candidatos;
        try {
            // Eventos que iniciaram entre 4 e 20 minutos atrás, sem resultado, com URL
            candidatos = await pool.request().query(`
                SELECT TOP 6 id, url, time_casa, time_fora, league_name,
                       ISNULL(odd_casa,0)   AS odd_casa,
                       ISNULL(odd_empate,0) AS odd_empate,
                       ISNULL(odd_fora,0)   AS odd_fora,
                       start_time_datetime
                FROM betano_eventos
                WHERE start_time_datetime BETWEEN DATEADD(MINUTE,-20,GETDATE()) AND DATEADD(MINUTE,-4,GETDATE())
                  AND ISNULL(url,'') <> ''
                  AND time_casa <> '' AND time_fora <> ''
                  AND NOT EXISTS (SELECT 1 FROM betano_historico_partidas WHERE evento_id = betano_eventos.id)
                ORDER BY start_time_datetime ASC
            `);
        } catch (err) {
            console.log(`   ⚠️ verificarEventosFinalizados query: ${err.message}`);
            return [];
        }

        if (!candidatos.recordset.length) return [];
        console.log(`🔍 Verificando ${candidatos.recordset.length} evento(s) via URL...`);

        const resultados = [];

        for (const ev of candidatos.recordset) {
            if (!this._isFutebol(ev.league_name, ev.time_casa, ev.time_fora)) continue;
            // Filtrar apenas ligas permitidas
            if (!this._isLigaPermitida(ev.league_name)) continue;

            const fullUrl = ev.url.startsWith('http')
                ? ev.url
                : `https://www.betano.bet.br/${ev.url.replace(/^\//, '')}`;

            console.log(`   🌐 ${ev.time_casa} x ${ev.time_fora} → ${fullUrl}`);

            try {
                this._capturedResponses = [];
                await this.page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
                await this._aguardarInitialState(8000);
                await this._delay(5000); // aguarda chamadas assíncronas de resultados

                // Tenta scores via rede PRIMEIRO (mais confiável que window.initial_state)
                const scoresRede = this._extrairScoresDasRespostas(this._capturedResponses);
                console.log(`      📡 Respostas capturadas: ${this._capturedResponses.length} | Scores: ${scoresRede.length}`);
                // Loga todas as URLs capturadas para diagnóstico
                const urlsCapturadas = [...new Set(this._capturedResponses.map(r => r.url.split('?')[0]))];
                if (urlsCapturadas.length > 0) console.log(`      URLs: ${urlsCapturadas.join(', ')}`);

                // Verifica se o score desta partida foi capturado via rede
                const scoreRede = scoresRede.find(s => Number(s.id) === Number(ev.id));
                if (scoreRede && (scoreRede.golCasa > 0 || scoreRede.golFora > 0)) {
                    console.log(`      ✅ [rede] ${ev.time_casa} ${scoreRede.golCasa}x${scoreRede.golFora} ${ev.time_fora}`);
                    resultados.push({
                        id: Number(ev.id),
                        golCasa: scoreRede.golCasa, golFora: scoreRede.golFora,
                        liga: ev.league_name, timeCasa: ev.time_casa, timeFora: ev.time_fora,
                        startTimeDatetime: ev.start_time_datetime,
                        oddCasa: ev.odd_casa, oddEmpate: ev.odd_empate, oddFora: ev.odd_fora,
                        fonte: 'network_api'
                    });
                    continue;
                }

                // Fallback: tenta via window.initial_state
                const score = await this.page.evaluate(() => {
                    const state = window['initial_state'];
                    if (!state?.data) return { erro: 'sem_initial_state' };
                    const data = state.data;
                    const keys = Object.keys(data);

                    // Tenta currentEvents (evento pode ainda aparecer como finalizado)
                    for (const ev of (data.currentEvents || [])) {
                        const ld  = ev.liveData || ev.ld || {};
                        const res = ld.results  || ld.r  || {};
                        const ft  = res.fullTimeScore || res.fts || {};
                        const sc  = ld.score || ld.sc || {};
                        const h   = ft.home ?? ft.h ?? sc.home ?? sc.h ?? null;
                        const a   = ft.away ?? ft.a ?? sc.away ?? sc.a ?? null;
                        if (h !== null && a !== null) {
                            return { golCasa: parseInt(h)||0, golFora: parseInt(a)||0,
                                     fonte: 'currentEvents_liveData', keys,
                                     ldKeys: Object.keys(ld), resKeys: Object.keys(res) };
                        }
                    }

                    // Tenta data.results / data.ee (lista de finalizados)
                    const grupos = data.results || data.ee || [];
                    for (const grupo of (Array.isArray(grupos) ? grupos : [])) {
                        for (const e of (grupo.events || grupo.e || [])) {
                            const stats = e.statistics || e.st || [];
                            for (const stat of stats) {
                                const tipo = (stat.statisticsType || stat.k || '').toUpperCase();
                                const vals = stat.value || stat.v || [];
                                if ((tipo.includes('SCORE') || tipo === 'GOAL') && vals.length >= 2) {
                                    const a = parseInt(vals[0]?.score ?? vals[0]?.s ?? 0)||0;
                                    const b = parseInt(vals[1]?.score ?? vals[1]?.s ?? 0)||0;
                                    if (a > 0 || b > 0) return { golCasa:a, golFora:b, fonte:'data_results', keys };
                                }
                            }
                        }
                    }

                    // Tenta data.content (seção de conteúdo da página)
                    const content = data.content;
                    const contentType = Array.isArray(content) ? 'array' : typeof content;
                    const contentKeys = content ? (Array.isArray(content)
                        ? content.slice(0,3).map(c => c?.type || c?.kind || Object.keys(c||{})[0])
                        : Object.keys(content)) : [];

                    return { naoEncontrado: true, keys, contentType, contentKeys,
                             currentEventsLen: (data.currentEvents||[]).length };
                });

                if (score.erro) {
                    console.log(`      ❌ ${score.erro}`);
                } else if (score.naoEncontrado) {
                    console.log(`      ❓ Sem placar. data keys: [${score.keys?.join(',')}] | content: ${score.contentType} ${JSON.stringify(score.contentKeys)} | currentEvents: ${score.currentEventsLen}`);
                } else {
                    console.log(`      ✅ [${score.fonte}] ${ev.time_casa} ${score.golCasa}x${score.golFora} ${ev.time_fora} | ldKeys: ${score.ldKeys||[]} | resKeys: ${score.resKeys||[]}`);
                    if (score.golCasa > 0 || score.golFora > 0) {
                        resultados.push({
                            id: Number(ev.id),
                            golCasa: score.golCasa, golFora: score.golFora,
                            liga: ev.league_name, timeCasa: ev.time_casa, timeFora: ev.time_fora,
                            startTimeDatetime: ev.start_time_datetime,
                            oddCasa: ev.odd_casa, oddEmpate: ev.odd_empate, oddFora: ev.odd_fora,
                            fonte: `url_${score.fonte}`
                        });
                    }
                }

            } catch (err) {
                console.log(`      ⚠️ Erro URL: ${err.message.slice(0,80)}`);
            }
        }

        return resultados;
    }

    // ============================================
    // COLETA PRINCIPAL
    // ============================================

    async coletar() {
        if (this.coletando) {
            console.log('⏳ Coleta anterior ainda em andamento — ignorando');
            return { success: false, error: 'overlap' };
        }

        this.coletando = true;
        const inicio = Date.now();

        try {
            await this.iniciarBrowser();
            if (!this.loggedIn) await this.fazerLogin();

            const eventos = await this.extrairDados();

            if (!eventos || eventos.length === 0) {
                return { success: false, error: 'Nenhum evento' };
            }

            // Extrai finalizados da rede (dados já capturados pelo interceptor)
            const finalizadosRede = this._extrairScoresDasRespostas(this._capturedResponses || [])
                .filter(s => {
                    if (!s.finalizado) return false;
                    if (!this._isFutebol(s.liga, s.timeCasa, s.timeFora)) return false;
                    if (!this._isLigaPermitida(s.liga)) return false;
                    return true;
                });
            
            if (finalizadosRede.length > 0) {
                console.log(`📋 Finalizados via rede: ${finalizadosRede.length}`);
            }

            // Verifica resultados via URL individual de cada evento finalizado
            const finalizadosURL = await this.verificarEventosFinalizados();

            // Junta todos os finalizados: página + rede + URLs
            const finalizados = [
                ...(this._finalizadosPendentes || []),
                ...finalizadosRede,
                ...finalizadosURL
            ];
            this._finalizadosPendentes = [];
            
            const resultado = await this.salvarNoBanco(eventos, finalizados);
            if (finalizadosURL.length > 0) resultado.finalizadosURL = finalizadosURL.length;
            if (finalizadosRede.length > 0) resultado.finalizadosRede = finalizadosRede.length;
            resultado.duracao = ((Date.now() - inicio) / 1000).toFixed(2) + 's';

            if (global.wsBroadcast) {
                global.wsBroadcast({ tipo: 'coleta', ...resultado, timestamp: new Date().toISOString() });
            }

            return resultado;

        } catch (err) {
            console.error('❌ ERRO coleta:', err.message);
            return { success: false, error: err.message };
        } finally {
            this.coletando = false;
        }
    }

    async fechar() {
        await this.fecharBrowser();
        if (this.pool && this.pool.connected) {
            await this.pool.close().catch(() => {});
        }
    }

    _delay(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = BetanoColetor;

if (require.main === module) {
    const coletor = new BetanoColetor();
    coletor.coletar()
        .then(r => { console.log('Resultado:', r); return coletor.fechar(); })
        .catch(e => { console.error(e); return coletor.fechar(); });
}
