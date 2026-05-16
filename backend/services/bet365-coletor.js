/**
 * ============================================================
 * COLETOR 1 — RESULTADOS
 * ============================================================
 * Responsabilidade: coletar resultados de jogos finalizados
 * (mercados pagos) e salvar em bet365_resultados_mercados.
 *
 * Roda continuamente em ciclos automáticos (intervalo configurável).
 * Porta Edge: 9222 | Processo: npm start (via server.js)
 *
 * Fluxo por ciclo:
 *   Para cada liga → clica na aba → coleta resultados →
 *   expande mercados → salva no banco → hard refresh → próxima liga
 *
 * Ligas: World Cup | Euro Cup | Premiership | Express Cup | Super Liga Sul-Americana
 * ============================================================
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const sql    = require('mssql');
const http   = require('http');
const dotenv = require('dotenv');
dotenv.config();

const { dispararAlerta } = require('./alertas');

const fs   = require('fs');
const path = require('path');

const DEBUG_PORT        = parseInt(process.env.BET365_DEBUG_PORT) || 9222;
const SCREENSHOT_ATIVO  = process.env.BET365_SCREENSHOT === 'true';
const SCREENSHOT_DIAS   = parseInt(process.env.BET365_SCREENSHOT_DIAS) || 30;
const SCREENSHOT_DIR    = path.join(__dirname, '..', '..', 'img', 'screenshots');
const URL_SOCCER = 'https://www.bet365.bet.br/#/AVR/B146/R%5E1/';
const LIGAS_IGNORAR = [];

// Normaliza nomes de mercado (inglês → português)
const MERCADO_NORMALIZAR = {
    'fulltime result':                    'Resultado Final',
    'full time result':                   'Resultado Final',
    '1x2':                                'Resultado Final',
    'correct score':                      'Resultado Correto',
    'half time correct score':            'Resultado Correto - Intervalo',
    'half-time correct score':            'Resultado Correto - Intervalo',
    'halftime correct score':             'Resultado Correto - Intervalo',
    'half time/full time':                'Intervalo/Final do Jogo',
    'half time result':                   'Resultado Intervalo',
    'halftime result':                    'Resultado Intervalo',
    'both teams to score':                'Ambos Marcam',
    'both teams to score (ht)':           'Ambos Marcam - Intervalo',
    'first goalscorer':                   'Primeiro Marcador de Gol',
    'first team to score':                'Primeira Equipe a Marcar',
    'home team to score':                 'Para o Time da Casa Marcar',
    'away team to score':                 'Para o Time Visitante Marcar',
    'winning margin':                     'Margem de Vitória',
    'result / both teams to score':       'Resultado/Ambos Marcam',
    'result/both teams to score':         'Resultado/Ambos Marcam',
    'exact total goals':                  'Total Exato de Gols',
    'double chance':                      'Chance Dupla',
    'asian handicap':                     'Handicap Asiático',
    'scorecast':                          'Scorecast',
    'team goals':                         'Gols por Time',
    'player to score':                    'Marcador de Gol',
    'anytime goalscorer':                 'Marcar a Qualquer Momento',
    'last goalscorer':                    'Último Marcador de Gol',
};

function normalizarNomeMercado(nome) {
    const low = (nome || '').toLowerCase().trim();
    if (MERCADO_NORMALIZAR[low]) return MERCADO_NORMALIZAR[low];
    // "Total Goals Over/Under X.5" → "Total de Gols - Mais de/Menos de X.5"
    const m = low.match(/^total goals over\/under (\d+\.\d)$/);
    if (m) return `Total de Gols - Mais de/Menos de ${m[1]}`;
    return nome;
}

// Normaliza nomes de seleção (inglês → português)
const SELECAO_NORMALIZAR = {
    'yes': 'Sim', 'no': 'Não',
    'any other score': 'Qualquer Outro Resultado',
    'no goals (0-0)': 'Sem Gols (0-0)',
    'draw 0-0': 'Empate 0-0',
};

function normalizarNomeSelecao(sel) {
    const low = (sel || '').toLowerCase().trim();
    if (SELECAO_NORMALIZAR[low]) return SELECAO_NORMALIZAR[low];
    // "Over X.5" → "Mais de X.5" / "Under X.5" → "Menos de X.5"
    const m1 = low.match(/^over (\d+\.\d)$/);  if (m1) return `Mais de ${m1[1]}`;
    const m2 = low.match(/^under (\d+\.\d)$/); if (m2) return `Menos de ${m2[1]}`;
    // "Team - N Goal(s)" / "Team - 3+ Goals" → normalizar time + Goals→Gols
    if (/\bGoals?\s*$/i.test(sel)) {
        const norm = sel.replace(/\bGoals\b/gi, 'Gols').replace(/\bGoal\b/gi, 'Gol');
        const dash = norm.indexOf(' - ');
        if (dash > 0) return normalizarNomeTime(norm.substring(0, dash)) + norm.substring(dash);
        return norm;
    }
    return sel;
}

// Normaliza nomes de times (inglês → português) — igual ao TEAM_ALIASES do frontend
const TIME_NORMALIZAR = {
    'albania':        'Albânia',
    'australia':      'Austrália',
    'austria':        'Áustria',
    'belgium':        'Bélgica',
    'brazil':         'Brasil',
    'cameroon':       'Camarões',
    'canada':         'Canadá',
    'croatia':        'Croácia',
    'czechia':        'República Tcheca',
    'czech republic': 'República Tcheca',
    'denmark':        'Dinamarca',
    'ecuador':        'Equador',
    'england':        'Inglaterra',
    'france':         'França',
    'georgia':        'Geórgia',
    'germany':        'Alemanha',
    'ghana':          'Gana',
    'hungary':        'Hungria',
    'iran':           'Irã',
    'italy':          'Itália',
    'japan':          'Japão',
    'mexico':         'México',
    'morocco':        'Marrocos',
    'netherlands':    'Países Baixos',
    'poland':         'Polônia',
    'romania':        'Romênia',
    'scotland':       'Escócia',
    'senegal':        'Senegal',
    'serbia':         'Sérvia',
    'slovakia':       'Eslováquia',
    'slovenia':       'Eslovênia',
    'south korea':    'Coreia do Sul',
    'spain':          'Espanha',
    'switzerland':    'Suíça',
    'tunisia':        'Tunísia',
    'turkey':         'Turquia',
    'ukraine':        'Ucrânia',
    'uruguay':        'Uruguai',
    'usa':            'EUA',
    'wales':          'País de Gales',
};

function normalizarNomeTime(nome) {
    if (!nome) return nome;
    return TIME_NORMALIZAR[nome.toLowerCase().trim()] || nome;
}

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

// Mapeamento: nome normalizado da liga → chave de config
const LIGA_CONFIG_KEY = {
    'World Cup':                'liga_world_cup',
    'Euro Cup':                 'liga_euro_cup',
    'Premiership':              'liga_premiership',
    'Express Cup':              'liga_express_cup',
    'Super Liga Sul-Americana': 'liga_super_liga',
};

// Mapeamento: liga normalizada → IDs da página de resultados (extra.bet365.bet.br)
// IDs descobertos via investigação em 2026-04-26
const LIGA_RESULTADOS_URL = {
    'World Cup':                { compId: '20120650', compNomes: ['Copa do Mundo', 'World Cup'] },
    'Euro Cup':                 { compId: '20700663', compNomes: ['Euro Cup'] },
    'Premiership':              { compId: '20120653', compNomes: ['Premier League', 'Premiership'] },
    'Express Cup':              { compId: '20940364', compNomes: ['Express Cup'] },
    'Super Liga Sul-Americana': { compId: '20849528', compNomes: ['Super Liga Sul-Americana', 'South American Super League'] },
};

class Bet365Coletor {
    constructor() {
        this.url                 = URL_SOCCER;
        this.browser             = null;
        this.page                = null;
        this.pool                = null;
        this.coletando           = false;
        this._coletas            = 0;
        this.cfg                 = null;
        this.ultimaColetaSucesso = null;
        this.ultimoErro          = null;
        this._ultimoAlertaLoginTs  = 0; // throttle: evita spam de alertas de login
        this._ultimaColetaProximos = new Map(); // liga → timestamp da última busca de próximos
    }

    _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    // Ctrl+F5: recarrega ignorando cache (equivalente a location.reload(true) no navegador)
    async _hardRefresh(pg, timeoutMs = 30000) {
        const navPromise = pg.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
        await pg.evaluate(() => location.reload(true));
        await navPromise;
    }

    _cfgNum(chave, def) { return parseInt(this.cfg?.[chave]) || def; }
    _cfgBool(chave, def = true) {
        const v = this.cfg?.[chave];
        return v === undefined ? def : v === 'true';
    }

    async _loadConfig() {
        try {
            const pool = await this.conectarBanco();
            const r = await pool.request().query(`
                IF OBJECT_ID('bet365_config') IS NOT NULL
                    SELECT chave, valor FROM bet365_config
                ELSE
                    SELECT NULL AS chave, NULL AS valor WHERE 1=0
            `);
            const cfg = {};
            r.recordset.forEach(row => { if (row.chave) cfg[row.chave] = row.valor; });
            if (Object.keys(cfg).length === 0) throw new Error('tabela vazia ou inexistente');
            this.cfg = cfg;
            console.log(`   ⚙️  Config carregada do banco (${Object.keys(cfg).length} chaves)`);
        } catch(e) {
            console.warn(`   ⚠️  [Config] Usando defaults hardcoded (${e.message})`);
            this.cfg = {
                intervalo_coleta_seg:       '30',
                delay_apos_clicar_liga_ms:  '3000',
                delay_pos_reload_ms:        '4000',
                delay_apos_resultados_ms:   '2000',
                delay_show_more_ms:         '800',
                delay_expandir_mercados_ms: '1500',
                delay_volta_proximos_ms:    '2000',
                delay_entre_horarios_ms:    '1500',
                delay_aguarda_mercado_ms:   '500',
                timeout_goto_ms:            '60000',
                delay_initial_load_ms:      '6000',
                timeout_ligas_ms:           '20000',
                timeout_navegacao_ms:       '30000',
                liga_world_cup:             'true',
                liga_euro_cup:              'true',
                liga_premiership:           'true',
                liga_express_cup:           'true',
                liga_super_liga:            'true',
            };
        }
    }

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
            // ── Normalizar nomes de mercado em inglês → português (dados históricos) ──
            `UPDATE bet365_resultados_mercados SET mercado='Resultado Final'               WHERE mercado IN ('Fulltime Result','Full Time Result','1X2')`,
            `UPDATE bet365_resultados_mercados SET mercado='Resultado Correto'             WHERE mercado='Correct Score'`,
            `UPDATE bet365_resultados_mercados SET mercado='Resultado Correto - Intervalo' WHERE mercado IN ('Half Time Correct Score','Half-Time Correct Score','Halftime Correct Score')`,
            `UPDATE bet365_resultados_mercados SET mercado='Intervalo/Final do Jogo'       WHERE mercado='Half Time/Full Time'`,
            `UPDATE bet365_resultados_mercados SET mercado='Resultado Intervalo'           WHERE mercado IN ('Half Time Result','Halftime Result')`,
            `UPDATE bet365_resultados_mercados SET mercado='Ambos Marcam'                  WHERE mercado='Both Teams to Score'`,
            `UPDATE bet365_resultados_mercados SET mercado='Primeiro Marcador de Gol'      WHERE mercado='First Goalscorer'`,
            `UPDATE bet365_resultados_mercados SET mercado='Primeira Equipe a Marcar'      WHERE mercado='First Team to Score'`,
            `UPDATE bet365_resultados_mercados SET mercado='Para o Time da Casa Marcar'    WHERE mercado='Home Team To Score'`,
            `UPDATE bet365_resultados_mercados SET mercado='Para o Time Visitante Marcar'  WHERE mercado='Away Team To Score'`,
            `UPDATE bet365_resultados_mercados SET mercado='Margem de Vitória'             WHERE mercado='Winning Margin'`,
            `UPDATE bet365_resultados_mercados SET mercado='Resultado/Ambos Marcam'        WHERE mercado IN ('Result / Both Teams To Score','Result/Both Teams To Score')`,
            `UPDATE bet365_resultados_mercados SET mercado='Total Exato de Gols'           WHERE mercado='Exact Total Goals'`,
            `UPDATE bet365_resultados_mercados SET mercado='Chance Dupla'                  WHERE mercado='Double Chance'`,
            `UPDATE bet365_resultados_mercados SET mercado='Total de Gols - Mais de/Menos de 0.5' WHERE mercado='Total Goals Over/Under 0.5'`,
            `UPDATE bet365_resultados_mercados SET mercado='Total de Gols - Mais de/Menos de 1.5' WHERE mercado='Total Goals Over/Under 1.5'`,
            `UPDATE bet365_resultados_mercados SET mercado='Total de Gols - Mais de/Menos de 2.5' WHERE mercado='Total Goals Over/Under 2.5'`,
            `UPDATE bet365_resultados_mercados SET mercado='Total de Gols - Mais de/Menos de 3.5' WHERE mercado='Total Goals Over/Under 3.5'`,
            `UPDATE bet365_resultados_mercados SET mercado='Total de Gols - Mais de/Menos de 4.5' WHERE mercado='Total Goals Over/Under 4.5'`,
            `UPDATE bet365_resultados_mercados SET mercado='Total de Gols - Mais de/Menos de 5.5' WHERE mercado='Total Goals Over/Under 5.5'`,
            // ── Normalizar seleções em inglês ──
            `UPDATE bet365_resultados_mercados SET selecao='Mais de 0.5' WHERE selecao='Over 0.5'`,
            `UPDATE bet365_resultados_mercados SET selecao='Mais de 1.5' WHERE selecao='Over 1.5'`,
            `UPDATE bet365_resultados_mercados SET selecao='Mais de 2.5' WHERE selecao='Over 2.5'`,
            `UPDATE bet365_resultados_mercados SET selecao='Mais de 3.5' WHERE selecao='Over 3.5'`,
            `UPDATE bet365_resultados_mercados SET selecao='Mais de 4.5' WHERE selecao='Over 4.5'`,
            `UPDATE bet365_resultados_mercados SET selecao='Menos de 0.5' WHERE selecao='Under 0.5'`,
            `UPDATE bet365_resultados_mercados SET selecao='Menos de 1.5' WHERE selecao='Under 1.5'`,
            `UPDATE bet365_resultados_mercados SET selecao='Menos de 2.5' WHERE selecao='Under 2.5'`,
            `UPDATE bet365_resultados_mercados SET selecao='Menos de 3.5' WHERE selecao='Under 3.5'`,
            `UPDATE bet365_resultados_mercados SET selecao='Menos de 4.5' WHERE selecao='Under 4.5'`,
            `UPDATE bet365_resultados_mercados SET selecao='Sim'  WHERE selecao='Yes'`,
            `UPDATE bet365_resultados_mercados SET selecao='Não'  WHERE selecao='No'`,
            `UPDATE bet365_resultados_mercados SET selecao='Qualquer Outro Resultado' WHERE selecao='Any Other Score'`,
            // ── Team Goals ──
            `UPDATE bet365_resultados_mercados SET mercado='Gols por Time' WHERE mercado='Team Goals'`,
            `UPDATE bet365_resultados_mercados SET selecao=REPLACE(REPLACE(selecao,' Goals',' Gols'),' Goal',' Gol') WHERE mercado='Gols por Time' AND (selecao LIKE '% Goals' OR selecao LIKE '% Goal' OR selecao LIKE '%+ Goals' OR selecao LIKE '%+ Goal')`,
            // ── Nomes de times EN→PT (time_casa / time_fora) ──
            ...Object.entries(TIME_NORMALIZAR).map(([en,pt]) => {
                const cap = en.charAt(0).toUpperCase()+en.slice(1);
                return `UPDATE bet365_resultados_mercados SET time_casa='${pt}' WHERE time_casa IN ('${cap}','${en}')`;
            }),
            ...Object.entries(TIME_NORMALIZAR).map(([en,pt]) => {
                const cap = en.charAt(0).toUpperCase()+en.slice(1);
                return `UPDATE bet365_resultados_mercados SET time_fora='${pt}' WHERE time_fora IN ('${cap}','${en}')`;
            }),
            // ── Nomes de times na seleção do mercado Gols por Time ──
            ...Object.entries(TIME_NORMALIZAR).map(([en,pt]) => {
                const cap = en.charAt(0).toUpperCase()+en.slice(1);
                return `UPDATE bet365_resultados_mercados SET selecao=STUFF(selecao,1,${cap.length},'${pt}') WHERE mercado='Gols por Time' AND (selecao LIKE '${cap} - %' OR selecao LIKE '${en} - %')`;
            }),
            // ── Remover duplicatas de Resultado Final por evento (bug pré-odds) ──
            // Para cada evento com >1 linha de Resultado Final, apaga as extras
            `DELETE brm FROM bet365_resultados_mercados brm
             WHERE brm.mercado = 'Resultado Final'
             AND EXISTS (
                 SELECT 1 FROM bet365_resultados_mercados brm2
                 WHERE brm2.evento_id = brm.evento_id
                 AND brm2.mercado = 'Resultado Final'
                 AND brm2.id <> brm.id
             )
             AND brm.id NOT IN (
                 SELECT TOP 1 b.id FROM bet365_resultados_mercados b
                 INNER JOIN bet365_eventos ev ON ev.id = b.evento_id
                 WHERE b.evento_id = brm.evento_id AND b.mercado = 'Resultado Final'
                 AND (b.selecao = ev.time_casa OR b.selecao = ev.time_fora OR b.selecao = 'Empate')
                 ORDER BY CASE WHEN b.selecao = ev.time_casa OR b.selecao = ev.time_fora THEN 0 ELSE 1 END
             )`,
            // ── Remover colunas desnecessárias de bet365_eventos ──
            `IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bet365_eventos') AND name='gol_casa') ALTER TABLE bet365_eventos DROP COLUMN gol_casa`,
            `IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bet365_eventos') AND name='gol_fora') ALTER TABLE bet365_eventos DROP COLUMN gol_fora`,
            `IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bet365_eventos') AND name='minuto_jogo') ALTER TABLE bet365_eventos DROP COLUMN minuto_jogo`,
            `IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bet365_eventos') AND name='seconds_to_start') ALTER TABLE bet365_eventos DROP COLUMN seconds_to_start`,
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
        await pg.goto(this.url, { waitUntil: 'load', timeout: this._cfgNum('timeout_goto_ms', 60000) });
        await this._delay(this._cfgNum('delay_initial_load_ms', 6000));
        return { page: pg, _criada: true };
    }


    // ─────────────────────────────────────────────────────────────
    // EXTRAÇÃO DE MERCADOS
    // ─────────────────────────────────────────────────────────────

    async _extrairMercadosDoPagina(pg) {
        const raw = await pg.evaluate(() => {
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
        // Normaliza nomes de mercado e seleção (inglês → português)
        if (raw?.mercados) {
            raw.mercados = raw.mercados.map(m => ({
                ...m,
                nome: normalizarNomeMercado(m.nome),
                selecoes: (m.selecoes || []).map(s => ({ ...s, nome: normalizarNomeSelecao(s.nome) })),
            }));
        }
        return raw || { countdown: null, mercados: [] };
    }

    async _extrairInfoJogo(liga, pg) {
        return await pg.evaluate((liga) => {
            const timeBtn  = document.querySelector('.vr-EventTimesNavBarButton-selected .vr-EventTimesNavBarButton_Text');
            const horario  = timeBtn ? timeBtn.textContent.trim() : null;
            const participantes = [];
            const ftPod    = [...document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup')]
                .find(p => { const txt = p.querySelector('.gl-MarketGroupButton_Text')?.textContent.trim(); return txt === 'Fulltime Result' || txt === 'Resultado Final'; });
            if (ftPod) {
                for (const el of ftPod.querySelectorAll('.srb-ParticipantStackedBorderless')) {
                    const nEl = el.querySelector('.srb-ParticipantStackedBorderless_Name');
                    const oEl = el.querySelector('.srb-ParticipantStackedBorderless_Odds');
                    const nome = nEl ? nEl.textContent.trim() : '';
                    const odd  = oEl ? parseFloat(oEl.textContent.trim()) || 0 : 0;
                    participantes.push({ nome, odd });
                }
            }
            const bcText   = document.querySelector('.svc-MarketGroup_BookCloses span:last-child');
            const raceOff  = document.querySelector('.svc-MarketGroup_RaceOff');
            const countdown = raceOff ? 'EVENTO INICIADO' : (bcText ? bcText.textContent.trim() : null);
            // Identifica casa/empate/fora pela posição: [0]=casa, [1]=empate, [2]=fora
            const isEmpate = n => n === 'Draw' || n === 'Empate';
            const empIdx   = participantes.findIndex(p => isEmpate(p.nome));
            const times    = participantes.filter(p => !isEmpate(p.nome));
            const oddCasa   = times[0]?.odd  || 0;
            const oddEmpate = empIdx >= 0 ? participantes[empIdx].odd : 0;
            const oddFora   = times[1]?.odd  || 0;
            const timeCasa  = times[0]?.nome || null;
            const timeFora  = times[1]?.nome || null;
            return { liga, horario, timeCasa, timeFora, countdown, oddCasa, oddEmpate, oddFora };
        }, liga);
    }

    async _extrairResultados(liga, pg) {
        return await pg.evaluate((liga) => {
            const resultados = [];
            for (const grupo of document.querySelectorAll('.vrr-HeadToHeadMarketGroup')) {
                const eventLabel   = grupo.querySelector('.vrr-FixtureDetails_Event');
                const textoLabel   = eventLabel?.textContent.trim() || '';
                // Pula jogos em andamento: o label termina com minuto de jogo (ex: "65'")
                // Jogos finalizados mostram data no formato "DD.MM" (ex: "15.03")
                if (/\d{1,3}['´]\s*$/.test(textoLabel)) continue;
                const horarioMatch = textoLabel.match(/(\d{1,2}[.:]\d{2})$/);
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
        // Normaliza nomes de mercado e seleção (inglês → português)
        if (!Array.isArray(resultados)) return [];
        return resultados.map(r => ({
            ...r,
            timeCasa: normalizarNomeTime(r.timeCasa),
            timeFora: normalizarNomeTime(r.timeFora),
            mercados: (r.mercados || []).map(m => ({
                ...m,
                mercado: normalizarNomeMercado(m.mercado),
                selecao: normalizarNomeSelecao(m.selecao),
            })),
        }));
    }

    // ─────────────────────────────────────────────────────────────
    // COLETA DE UMA LIGA (F5 + extração)
    // ─────────────────────────────────────────────────────────────

    async _coletarProximos(pg, liga, eventos) {
        const fonteProximos   = (this.cfg?.fonte_proximos || 'results').trim().toLowerCase();
        const coletarProximos = this._cfgBool('coletar_proximos_jogos', true);
        const maxHorarios     = (fonteProximos === 'none' || !coletarProximos)
            ? 0 : this._cfgNum('max_horarios_proximos', 4);

        if (maxHorarios === 0) {
            console.log(`   ⏭️  [${liga.nome}] Coleta de próximos desativada (fonte: ${fonteProximos}).`);
            return;
        }

        const ligaNorm = normalizarNomeLiga(liga.nome);

        // Throttle: respeita intervalo mínimo entre buscas por liga
        const intervaloMs = this._cfgNum('intervalo_proximos_min', 3) * 60 * 1000;
        const ultimaTs    = this._ultimaColetaProximos.get(ligaNorm) || 0;
        const decorrido   = Date.now() - ultimaTs;
        if (decorrido < intervaloMs) {
            const restante = Math.ceil((intervaloMs - decorrido) / 1000);
            console.log(`   ⏭️  [${liga.nome}] Próximos: aguardando intervalo (${restante}s restantes).`);
            return;
        }
        this._ultimaColetaProximos.set(ligaNorm, Date.now());
        const ligaInfo = LIGA_RESULTADOS_URL[ligaNorm];

        if (!ligaInfo) {
            console.log(`   ⚠️  [${liga.nome}] Liga não mapeada para próximos. Pulando.`);
            return;
        }

        // Data atual em BST (Bet365 usa UTC+1 como referência de horário)
        const nowBST = new Date(Date.now() + 3600000);
        const yyyy   = nowBST.getUTCFullYear();
        const mm     = nowBST.getUTCMonth(); // 0-indexed
        const dd     = nowBST.getUTCDate();
        const dateStr = `${yyyy}-${String(mm + 1).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;

        const MESES_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho',
                          'Agosto','Setembro','Outubro','Novembro','Dezembro'];
        const displayDate = `${dd}-${dd}%20${MESES_PT[mm]}%20${yyyy}`;

        const horaAtualBST = nowBST.getUTCHours();
        const minAtualBST  = nowBST.getUTCMinutes();

        // Monta URL para cada nome alternativo da liga
        const b64 = s => Buffer.from(s).toString('base64');
        const _montarUrl = compNome => {
            const qParams = [
                b64('2'), b64('146'), b64('Futebol%20Virtual'),
                b64(dateStr), b64(dateStr), b64('0'), b64('0'),
                b64(displayDate), b64('0'),
                b64(encodeURIComponent(compNome)),
                b64(ligaInfo.compId), b64('0'), '',
                b64('fixture'),
                b64('0'), b64('0'), b64('0'), b64('0'), b64('0'),
                '', b64('0'), b64('0'),
            ].join('|');
            return `https://extra.bet365.bet.br/results/br?q=${qParams}`;
        };

        let novaPg = null;
        try {
            novaPg = await pg.browser().newPage();

            let futuros = [], totalEncontrados = 0, amostra = [];
            for (const compNome of ligaInfo.compNomes) {
                const urlResultados = _montarUrl(compNome);
                console.log(`   🔗 [${liga.nome}] URL próximos (${compNome}): ${urlResultados.substring(0, 120)}...`);
                await novaPg.goto(urlResultados, { waitUntil: 'networkidle2', timeout: 30000 });

                // Aguarda os botões de fixture aparecerem (até 10s), evita leitura prematura
                try {
                    await novaPg.waitForSelector('button.point-result__fixture', { timeout: 10000 });
                } catch(_) { /* continua mesmo sem fixtures */ }
                await this._delay(1500);

                // Rola até o fim para forçar carregamento lazy, depois volta ao topo (simulação humana)
                await novaPg.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await this._delay(1500);
                await novaPg.evaluate(() => window.scrollTo(0, 0));
                await this._delay(500);

                // Extrai fixtures com esse nome
                const resultado = await novaPg.evaluate((h, m, maxN, janela) => {
                const buttons = document.querySelectorAll('button.point-result__fixture');
                const futuros = [];
                const amostra = []; // primeiros 5 para log
                for (const btn of buttons) {
                    const parts = btn.querySelectorAll('.point-result__fixture-participant');
                    if (parts.length < 2) continue;
                    const p1    = parts[0].textContent.trim();
                    const match = p1.match(/^(\d{1,2})\.(\d{2})\s+(.+)$/);
                    if (!match) continue;
                    const jH = parseInt(match[1]);
                    const jM = parseInt(match[2]);
                    if (amostra.length < 5) amostra.push(`${jH}:${String(jM).padStart(2,'0')} ${match[3].trim()} x ${parts[1].textContent.trim()}`);
                    const nowMins = h * 60 + m;
                    const jMins   = jH * 60 + jM;
                    if (jMins > nowMins && jMins <= nowMins + janela) {
                        futuros.push({
                            horario:  `${jH}:${String(jM).padStart(2,'0')}`,
                            timeCasa: match[3].trim(),
                            timeFora: parts[1].textContent.trim(),
                        });
                        if (futuros.length >= maxN) break;
                    }
                }
                return { futuros, totalEncontrados: buttons.length, amostra };
                }, horaAtualBST, minAtualBST, maxHorarios, this._cfgNum('janela_proximos_min', 6));

                totalEncontrados = resultado.totalEncontrados;
                futuros          = resultado.futuros;
                amostra          = resultado.amostra;

                console.log(`   ⏰ [${liga.nome}] (${compNome}) BST: ${horaAtualBST}:${String(minAtualBST).padStart(2,'0')} | Fixtures: ${totalEncontrados} | Próximos: ${futuros.length}`);
                if (totalEncontrados > 0) break; // achou com este nome, não precisa tentar o próximo
            }

            if (futuros.length > 0) console.log(`      📋 Próximos fixtures: ${futuros.map(f => `${f.horario} ${f.timeCasa} x ${f.timeFora}`).join(' | ')}`);

            for (const f of futuros) {
                const tcNorm   = normalizarNomeTime(f.timeCasa);
                const tfNorm   = normalizarNomeTime(f.timeFora);
                const eventoId = this._gerarId(ligaNorm, tcNorm, tfNorm, f.horario);
                eventos.push({
                    eventoId,
                    liga:      ligaNorm,
                    timeCasa:  tcNorm,
                    timeFora:  tfNorm,
                    horario:   f.horario,
                    countdown: null,
                    oddCasa:   0,
                    oddEmpate: 0,
                    oddFora:   0,
                    mercados:  [],
                });
                console.log(`      ✅ [${ligaNorm}] ${tcNorm} x ${tfNorm} [${f.horario}]`);
            }
        } catch(err) {
            console.error(`   ❌ [${liga.nome}] Erro _coletarProximos: ${err.message}`);
        } finally {
            if (novaPg) await novaPg.close().catch(() => {});
        }
    }

    async _coletarResultados(pg, liga, resultados) {
        const temBtnRes = await pg.evaluate(() => !!document.querySelector('.vr-ResultsNavBarButton'));
        if (!temBtnRes) return;

        await pg.evaluate(() => document.querySelector('.vr-ResultsNavBarButton')?.click());
        await this._delay(this._cfgNum('delay_apos_resultados_ms', 2000));

        const maxVerMais = this._cfgNum('max_ver_mais_clicks', 10);
        for (let sm = 0; sm < maxVerMais; sm++) {
            const temMore = await pg.evaluate(() => !!document.querySelector('.vrr-ShowMoreButton_Link'));
            if (!temMore) break;
            await pg.evaluate(() => document.querySelector('.vrr-ShowMoreButton_Link')?.click());
            await this._delay(this._cfgNum('delay_show_more_ms', 800));
        }

        const totalMaisInternos = await pg.evaluate(() => {
            const btns = [...document.querySelectorAll('.vrr-HeadToHeadMarketGroup .vrr-ShowMoreButton_Link')];
            btns.forEach(b => b.click());
            return btns.length;
        });
        if (totalMaisInternos > 0) {
            console.log(`   🔽 [${normalizarNomeLiga(liga.nome)}] Expandindo ${totalMaisInternos} card(s) de resultado...`);
            await this._delay(this._cfgNum('delay_expandir_mercados_ms', 1500));
        }

        const res = await this._extrairResultados(normalizarNomeLiga(liga.nome), pg);
        resultados.push(...res);
        console.log(`   📋 [${normalizarNomeLiga(liga.nome)}] ${res.length} resultado(s)`);
        await this._tirarScreenshot(pg, normalizarNomeLiga(liga.nome));
    }

    async _coletarLiga(pg, liga) {
        const eventos    = [];
        const resultados = [];
        const proxAntesRes = this._cfgBool('proximos_antes_resultados', false);

        if (proxAntesRes) {
            console.log(`   🔀 [${liga.nome}] Ordem: próximos → resultados`);
            await this._coletarProximos(pg, liga, eventos);
            await this._coletarResultados(pg, liga, resultados);
        } else {
            await this._coletarResultados(pg, liga, resultados);
            await this._coletarProximos(pg, liga, eventos);
        }

        return { eventos, resultados };
    }

    // ─────────────────────────────────────────────────────────────
    // COLETA PARALELA — todas as ligas
    // ─────────────────────────────────────────────────────────────

    async _extrairDados(pg) {
        // Recarrega config do banco para garantir que mudanças feitas durante o ciclo
        // (ex: desativar uma liga pelo painel) sejam respeitadas imediatamente
        await this._loadConfig();

        // Lê as ligas disponíveis na aba atual
        const ligas = await pg.evaluate(() =>
            [...document.querySelectorAll('.vrl-MeetingsHeaderButton')].map((el, idx) => {
                const t = el.querySelector('.vrl-MeetingsHeaderButton_Title');
                return { idx, nome: t ? t.textContent.trim() : `Liga${idx}` };
            })
        );

        // Filtra ligas: ignora por nome E respeita config do banco
        const ligasFiltradas = ligas.filter(l => {
            if (LIGAS_IGNORAR.some(ig => l.nome.toLowerCase().includes(ig))) return false;
            const norm = normalizarNomeLiga(l.nome);
            const key  = LIGA_CONFIG_KEY[norm];
            return key ? this._cfgBool(key, true) : true;
        });

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
            await this._delay(this._cfgNum('delay_apos_clicar_liga_ms', 3000));

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

            // Ctrl+F5 (hard refresh) após cada liga — força buscar do servidor, sem cache
            console.log(`   🔄 [${liga.nome}] Ctrl+F5 — recarregando sem cache...`);
            for (let r = 1; r <= 3; r++) {
                try {
                    await this._hardRefresh(pg, this._cfgNum('timeout_navegacao_ms', 30000));
                    await this._delay(this._cfgNum('delay_pos_reload_ms', 4000));
                    await pg.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: this._cfgNum('timeout_ligas_ms', 20000) });
                    break; // ligas apareceram, continua para próxima liga
                } catch(e) {
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
                // ── 1. data_partida vem do horário real do jogo (label "Euro Cup - 13:56" na página) ──
                // res.horario é extraído de .vrr-FixtureDetails_Event — fonte autoritativa do horário.
                let dataPart = null;
                if (res.horario && /^\d{1,2}[.:]\d{2}$/.test(res.horario)) {
                    const [h, m] = res.horario.replace('.', ':').split(':').map(Number);
                    // Convenção BST-as-UTC: salva hora BST diretamente como UTC (sem conversão).
                    // Usa a data BST (nowB365) como base — não a data UTC — para que jogos às 00:xx BST
                    // (coletados às 23:xx UTC do dia anterior) recebam a data correta.
                    const nowB365 = Date.now() + 3600000;
                    const bst = new Date(nowB365);
                    let ms = Date.UTC(bst.getUTCFullYear(), bst.getUTCMonth(), bst.getUTCDate(), h, m, 0, 0);
                    // Se o horário ficou mais de 3 min no futuro, o jogo foi ontem (resultado tardio)
                    if (ms > nowB365 + 3 * 60000) ms -= 86400000;
                    dataPart = new Date(ms);
                }

                let oddCasa = 0, oddEmpate = 0, oddFora = 0;

                // ── 2. Busca em bet365_eventos apenas para eventoId e odds ──
                // Busca pelo horário REAL do resultado (dataPart ±10 min) para não
                // pegar o evento de outro jogo com os mesmos times em horário diferente.
                let evDb = await pool.request()
                    .input('liga2',     sql.NVarChar(200), res.liga)
                    .input('timeCasa2', sql.NVarChar(100), res.timeCasa)
                    .input('timeFora2', sql.NVarChar(100), res.timeFora)
                    .input('dataPart2', sql.DateTime2,     dataPart)
                    .query(`
                        SELECT TOP 1 id, odd_casa, odd_empate, odd_fora
                        FROM bet365_eventos
                        WHERE league_name = @liga2
                          AND time_casa   = @timeCasa2
                          AND time_fora   = @timeFora2
                          AND start_time_datetime BETWEEN DATEADD(MINUTE,-10,@dataPart2) AND DATEADD(MINUTE,10,@dataPart2)
                        ORDER BY ABS(DATEDIFF(SECOND, start_time_datetime, @dataPart2)) ASC
                    `);
                if (evDb.recordset.length === 0) {
                    // Fallback: janela de 30 min ao redor do horário real (nunca usa janela genérica)
                    evDb = await pool.request()
                        .input('liga2b',     sql.NVarChar(200), res.liga)
                        .input('timeCasa2b', sql.NVarChar(100), res.timeCasa)
                        .input('timeFora2b', sql.NVarChar(100), res.timeFora)
                        .input('dataPart2b', sql.DateTime2,     dataPart)
                        .query(`
                            SELECT TOP 1 id, odd_casa, odd_empate, odd_fora
                            FROM bet365_eventos
                            WHERE league_name = @liga2b
                              AND time_casa   = @timeCasa2b
                              AND time_fora   = @timeFora2b
                              AND start_time_datetime BETWEEN DATEADD(MINUTE,-30,@dataPart2b) AND DATEADD(MINUTE,30,@dataPart2b)
                            ORDER BY ABS(DATEDIFF(SECOND, start_time_datetime, @dataPart2b)) ASC
                        `);
                }

                let eventoIdFixo = null;
                if (evDb.recordset.length > 0) {
                    const ev = evDb.recordset[0];
                    eventoIdFixo = ev.id;
                    oddCasa   = parseFloat(ev.odd_casa)   || 0;
                    oddEmpate = parseFloat(ev.odd_empate) || 0;
                    oddFora   = parseFloat(ev.odd_fora)   || 0;
                    // NÃO sobrescreve dataPart — res.horario é a fonte autoritativa do horário
                }

                // Fallback odds: memória do ciclo atual
                if (!oddCasa && !oddEmpate && !oddFora) {
                    const evMem = eventos.find(e =>
                        e.liga === res.liga &&
                        e.timeCasa === res.timeCasa &&
                        e.timeFora === res.timeFora
                    );
                    if (evMem) { oddCasa = evMem.oddCasa; oddEmpate = evMem.oddEmpate; oddFora = evMem.oddFora; }
                }

                // Fallback data_partida: res.horario ausente → BST agora snapado ao slot
                if (!dataPart) {
                    dataPart = new Date(Date.now() + 3600000);
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
                            WHEN MATCHED THEN UPDATE SET t.odd_paga=@oddPaga, t.data_partida=@dataPart
                            WHEN NOT MATCHED THEN INSERT
                                (id, evento_id, liga, time_casa, time_fora, data_partida, mercado, selecao, odd_paga)
                            VALUES (@id, @eventoId, @liga, @timeCasa, @timeFora, @dataPart, @mercado, @selecao, @oddPaga);
                        `);
                }

                // ── 3. Upsert bet365_eventos com dados reais do jogo ──
                // Garante que o JOIN (bet365_eventos.id = bet365_resultados_mercados.evento_id) sempre funciona,
                // mesmo quando _coletarProximos gravou times errados (placeholder ≠ real).
                await pool.request()
                    .input('evId',     sql.BigInt,        eventoId)
                    .input('evLiga',   sql.NVarChar(200), res.liga)
                    .input('evCasa',   sql.NVarChar(100), res.timeCasa)
                    .input('evFora',   sql.NVarChar(100), res.timeFora)
                    .input('evDt',     sql.DateTime2,     dataPart)
                    .input('evOdCasa', sql.Decimal(10,2), oddCasa   || 0)
                    .input('evOdEmp',  sql.Decimal(10,2), oddEmpate || 0)
                    .input('evOdFora', sql.Decimal(10,2), oddFora   || 0)
                    .input('evAgora',  sql.DateTime2,     new Date())
                    .query(`
                        MERGE bet365_eventos AS t
                        USING (SELECT @evId AS id) AS s ON t.id = s.id
                        WHEN MATCHED THEN UPDATE SET
                            t.league_name=@evLiga, t.time_casa=@evCasa, t.time_fora=@evFora,
                            t.start_time_datetime=@evDt,
                            t.odd_casa=@evOdCasa, t.odd_empate=@evOdEmp, t.odd_fora=@evOdFora,
                            t.data_atualizacao=@evAgora, t.ativo=0
                        WHEN NOT MATCHED THEN INSERT
                            (id, url, league_name, time_casa, time_fora, status,
                             start_time_datetime, odd_casa, odd_empate, odd_fora,
                             data_coleta, data_atualizacao, ativo)
                        VALUES (@evId, '', @evLiga, @evCasa, @evFora, 'FINALIZADO',
                                @evDt, @evOdCasa, @evOdEmp, @evOdFora,
                                @evAgora, @evAgora, 0);
                    `);

                // ── 4. Log do resultado salvo via mercados ──
                console.log(`   ✅ Mercados: [${res.liga}] ${res.timeCasa} × ${res.timeFora} (UTC ${timeKey}) — ${(res.mercados||[]).length} mercado(s)`);
            } catch(e) {
                console.error(`   ❌ Erro histórico ${res.timeCasa} x ${res.timeFora}: ${e.message}`);
            }
        }

        console.log(`   💾 Eventos:${eventosOk} | Mercados:${mercadosOk} | Odds:${oddsOk}`);
        return { eventosOk, mercadosOk, oddsOk };
    }

    // ─────────────────────────────────────────────────────────────
    // SESSÃO — detecta "Faça Login para Assistir" e reconecta
    // ─────────────────────────────────────────────────────────────

    // Clica em um botão (<button>) pelo texto usando eventos reais de ponteiro
    async _clicarBotaoPorTexto(pg, texto, exato = false) {
        try {
            const seletor = await pg.evaluateHandle((txt, exato) => {
                return [...document.querySelectorAll('button')].find(b =>
                    exato ? b.textContent.trim() === txt
                          : b.textContent.trim().includes(txt)
                ) || null;
            }, texto, exato);
            const el = seletor.asElement();
            if (!el) return false;
            await el.scrollIntoView();
            await el.hover();
            await el.click({ delay: 80 });
            return true;
        } catch { return false; }
    }

    // Clica em qualquer elemento clicável (button, a, [role="button"]) pelo texto
    async _clicarElementoPorTexto(pg, texto, exato = false) {
        try {
            const handle = await pg.evaluateHandle((txt, exato) => {
                return [...document.querySelectorAll('button, a, [role="button"]')].find(el => {
                    const t = (el.textContent || el.innerText || '').trim();
                    return exato ? t === txt : t.includes(txt);
                }) || null;
            }, texto, exato);
            const el = handle.asElement();
            if (!el) return false;
            await el.scrollIntoView();
            await el.hover();
            await el.click({ delay: 80 });
            return true;
        } catch { return false; }
    }

    // Clica no botão de submit DENTRO do modal/formulário de login (não o do cabeçalho)
    async _clicarBotaoSubmitModal(pg) {
        try {
            const handle = await pg.evaluateHandle(() => {
                // 1ª tentativa: botão dentro de <form> com texto "Login"
                const dentroForm = [...document.querySelectorAll('form button, form [role="button"]')].find(el => {
                    const t = (el.textContent || el.innerText || '').trim();
                    return t === 'Login' || t === 'Log In';
                });
                if (dentroForm) return dentroForm;
                // 2ª tentativa: button[type="submit"] com texto Login (fora de form explícita)
                const submitBtn = [...document.querySelectorAll('button[type="submit"]')].find(el =>
                    (el.textContent || '').trim().toLowerCase().includes('login')
                );
                if (submitBtn) return submitBtn;
                // 3ª tentativa: último botão com texto Login (o do modal é mais embaixo no DOM que o do cabeçalho)
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

    async _verificarSessao(pg) {
        try {
            await pg.bringToFront();

            // ── Detecta estado da sessão ──────────────────────────────────────────
            const url = pg.url();
            const naPaginaVirtual = url.includes('bet365') && url.includes('AVR');

            // Cenário A: "Faça Login para Assistir" visível na página virtual
            const temAvisoVirtual = await pg.evaluate(() =>
                [...document.querySelectorAll('button')].some(b =>
                    (b.textContent || '').trim().includes('Faça Login para Assistir'))
            );

            // Cenário B: botão/link "Login" visível no cabeçalho (usuário deslogado)
            // Só verifica se não há "Faça Login para Assistir" (para não duplicar detecção)
            const temBotaoLoginHeader = !temAvisoVirtual && await pg.evaluate(() =>
                [...document.querySelectorAll('button, a, [role="button"]')].some(el => {
                    const t = (el.textContent || el.innerText || '').trim();
                    return t === 'Login' || t === 'Log In';
                })
            );

            if (!temAvisoVirtual && !temBotaoLoginHeader && naPaginaVirtual) return; // sessão OK

            const motivo = temAvisoVirtual ? '"Faça Login para Assistir" detectado'
                : !naPaginaVirtual         ? `URL fora da página virtual: ${url.substring(0, 60)}`
                                           : 'botão "Login" no cabeçalho detectado';
            console.log(`   🔐 Sessão expirada — ${motivo} — reconectando...`);

            // Se a página saiu da URL virtual, volta antes de logar
            if (!naPaginaVirtual) {
                try {
                    await pg.goto(this.url, { waitUntil: 'domcontentloaded', timeout: this._cfgNum('timeout_goto_ms', 60000) });
                    await this._delay(3000);
                } catch(e) {
                    console.warn(`   ⚠️  Falha ao navegar de volta: ${e.message}`);
                }
            }

            // ── ETAPA 1: abre o modal de login ────────────────────────────────────
            // Clica no botão que abre o formulário:
            //   "Faça Login para Assistir" → abre modal de login na página virtual
            //   "Login" (cabeçalho)        → abre modal de login na página principal
            let step1Ok = false;
            if (temAvisoVirtual) {
                step1Ok = await this._clicarBotaoPorTexto(pg, 'Faça Login para Assistir', false);
            } else {
                step1Ok = await this._clicarElementoPorTexto(pg, 'Login', true);
            }

            let sessaoOk = false;
            if (step1Ok) {
                console.log('   ✅ Etapa 1: modal de login aberto');
                await this._delay(this._cfgNum('delay_modal_login_ms', 2500));

                // ── ETAPA 2: clica "Login" no modal (credenciais já preenchidas) ──
                // Usa _clicarBotaoSubmitModal para encontrar o botão DENTRO do form/modal,
                // não o botão "Login" do cabeçalho que aparece atrás do modal no DOM.
                const step2Ok = await this._clicarBotaoSubmitModal(pg);
                if (step2Ok) {
                    console.log('   ⏳ Etapa 2: aguardando confirmação do login...');
                    await this._delay(this._cfgNum('delay_pos_login_ms', 4000));
                    sessaoOk = await pg.evaluate(() =>
                        ![...document.querySelectorAll('button')].some(b =>
                            (b.textContent || '').trim().includes('Faça Login para Assistir'))
                    );
                } else {
                    console.log('   ⚠️  Botão "Login" não encontrado no modal (etapa 2)');
                }
            } else {
                console.log('   ⚠️  Etapa 1 falhou — botão de login não encontrado na página');
            }

            // ── Fallback: credenciais do .env ─────────────────────────────────────
            if (!sessaoOk) {
                const motivoFallback = step1Ok ? 'modal não respondeu' : 'etapa 1 falhou';
                console.log(`   ⚠️  ${motivoFallback} — tentando com credenciais .env...`);
                sessaoOk = await this._loginComCredenciais(pg);
            }

            // ── Notificação Telegram ──────────────────────────────────────────────
            const agora = new Date().toLocaleTimeString('pt-BR');
            const throttle = 10 * 60 * 1000; // máx 1 alerta de login a cada 10 min
            if (Date.now() - this._ultimoAlertaLoginTs >= throttle) {
                this._ultimoAlertaLoginTs = Date.now();
                const pool = await this.conectarBanco().catch(() => null);
                if (sessaoOk) {
                    console.log('   ✅ Sessão restaurada!');
                    dispararAlerta(this.cfg, pool,
                        '🔐 Sessão Bet365 expirou — restaurada',
                        `A tela de login foi detectada e o acesso foi restaurado automaticamente.\n✅ Coleta continuando normalmente.\n🕐 ${agora}`
                    ).catch(() => {});
                } else {
                    console.log('   ❌ Não foi possível restaurar a sessão');
                    dispararAlerta(this.cfg, pool,
                        '❌ Sessão Bet365 expirou — falha no login',
                        `A tela de login foi detectada mas o auto-login não funcionou.\n⚠️ Intervenção manual necessária: abra o Edge e faça o login.\n🕐 ${agora}`
                    ).catch(() => {});
                }
            }
        } catch(e) {
            console.warn('   ⚠️  _verificarSessao:', e.message);
        }
    }

    async _loginComCredenciais(pg) {
        const usuario = (process.env.BET365_USERNAME || '').trim();
        const senha   = (process.env.BET365_PASSWORD || '').trim();
        if (!usuario || !senha) {
            console.log('   ⚠️  BET365_USERNAME/BET365_PASSWORD não definidos no .env — impossível fazer login automático');
            return false;
        }
        try {
            // Preenche usuário (limpa o campo antes)
            const inputUser = await pg.$('input[type="text"]:not([type="hidden"])');
            if (inputUser) {
                await inputUser.click({ clickCount: 3 });
                await inputUser.type(usuario, { delay: 60 });
            }
            // Preenche senha
            const inputPass = await pg.$('input[type="password"]');
            if (inputPass) {
                await inputPass.click({ clickCount: 3 });
                await inputPass.type(senha, { delay: 60 });
            }
            // Clica Login com evento real de ponteiro
            const clicou = await this._clicarBotaoPorTexto(pg, 'Login', true);
            if (!clicou) { console.log('   ❌ Botão Login não encontrado (credenciais)'); return false; }

            await this._delay(5000);
            const ok = await pg.evaluate(() =>
                ![...document.querySelectorAll('button')].some(b =>
                    (b.textContent || '').trim().includes('Faça Login para Assistir'))
            );
            if (ok) { console.log('   ✅ Login com credenciais bem-sucedido!'); return true; }
            console.log('   ❌ Login com credenciais falhou');
            return false;
        } catch(e) {
            console.log('   ❌ Erro no login com credenciais:', e.message);
            return false;
        }
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
        await this._loadConfig();

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
                    await this.page.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: this._cfgNum('timeout_ligas_ms', 20000) });
                    ligasOk = true;
                    break;
                } catch(e) {
                    console.log(`   ⚠️  Ligas não apareceram (tentativa ${tentativa}/3) — Ctrl+F5...`);
                    try {
                        await this._hardRefresh(this.page, this._cfgNum('timeout_navegacao_ms', 30000));
                        await this._delay(this._cfgNum('delay_pos_reload_ms', 4000));
                    } catch(reloadErr) {
                        console.log(`   ⚠️  Hard refresh falhou: ${reloadErr.message}`);
                    }
                }
            }
            if (!ligasOk) {
                throw new Error('Ligas não apareceram após 3 tentativas — verifique se a página está aberta no Edge');
            }

            // Verifica sessão — se "Faça Login para Assistir" aparecer, reconecta automaticamente
            await this._verificarSessao(this.page);

            const { eventos: evBrutos, resultados: resBrutos, contadores } = await this._extrairDados(this.page);
            await this._logColeta(inicio, 'SUCESSO', contadores, null);

            if (typeof global.wsBroadcast === 'function') {
                global.wsBroadcast({ tipo: 'coleta', fonte: 'bet365', novos: contadores.eventosOk, resultadosSalvos: contadores.histOk, timestamp: new Date().toISOString() });
            }

            // Só marca sucesso se extraiu algum dado — garante alerta quando sessão falha silenciosamente
            if (evBrutos.length > 0 || resBrutos.length > 0) {
                this.ultimaColetaSucesso = Date.now();
                this.ultimoErro          = null;
                console.log(`✅ Bet365 - Coleta concluída`);
            } else {
                this.ultimoErro = 'Coleta retornou 0 eventos e 0 resultados';
                console.log(`⚠️  Bet365 - Coleta concluída mas sem dados extraídos (sessão pode ter expirado)`);
            }

        } catch(err) {
            this.ultimoErro = err.message;
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
