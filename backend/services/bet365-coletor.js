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
const {
    normalizarTime:     normalizarNomeTime,
    normalizarMercado:  normalizarNomeMercado,
    normalizarSelecao:  normalizarNomeSelecao,
    normalizarLiga:     normalizarNomeLiga,
    LIGA_NORMALIZAR,
} = require('../utils/normalizacao');

const fs   = require('fs');
const path = require('path');

const DEBUG_PORT        = parseInt(process.env.BET365_DEBUG_PORT) || 9222;
const SCREENSHOT_ATIVO  = process.env.BET365_SCREENSHOT === 'true';
const SCREENSHOT_DIAS   = parseInt(process.env.BET365_SCREENSHOT_DIAS) || 30;
const SCREENSHOT_DIR    = path.join(__dirname, '..', '..', 'img', 'screenshots');
const URL_SOCCER = 'https://www.bet365.bet.br/#/AVR/B146/R%5E1/';
const LIGAS_IGNORAR = [];

// Modo de inicialização do browser
// manual      → comportamento atual (conecta ao Edge existente via remote debugging)
// auto        → puppeteer.launch() em modo headless (invisível) + login automático
// auto-visivel → puppeteer.launch() com janela visível + login automático
const MODO_INICIO = (process.env.BET365_MODO_INICIO || 'manual').toLowerCase().trim();

// Caminho do executável Edge e diretório do perfil BetColetor (usado nos modos auto)
const EDGE_EXE   = process.env.BET365_EDGE_EXE
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EDGE_PERFIL = process.env.BET365_EDGE_PERFIL
    || path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Administrador\\AppData\\Local',
                 'Microsoft', 'Edge', 'User Data', 'BetColetor');

// TIME_NORMALIZAR: usado apenas pelas queries SQL de startup (_inicializarBancoDados)
// Lógica de runtime (normalizarNomeMercado, normalizarNomeSelecao, etc.) vem de normalizacao.js
const TIME_NORMALIZAR = Object.fromEntries(
    Object.entries(require('../utils/normalizacao').TIMES_EN_PT)
        .map(([k, v]) => [k.toLowerCase(), v])
);

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
        this._ultimoLoginTs        = 0;     // timestamp do último login bem-sucedido (anti-duplo-login)
        this._reinicioAgendado     = false; // evita agendar múltiplos reinícios simultâneos
        this._ligasFalhadasConsec    = 0;   // contador de falhas consecutivas "Ligas não apareceram"
        this._edgeSemPortaConsec   = 0;    // contador de falhas consecutivas "Edge não encontrado na porta"
        this._proximaColetaPermitida = 0;   // backoff: timestamp mínimo para próxima tentativa
        this._ciclosSemResultados    = 0;   // contador de ciclos consecutivos com 0 resultados
        this._resultadosCache        = new Map(); // "liga|casa|fora|horario" → timestamp (TTL 3h)
    }

    _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    // Broadcast WS: direto quando roda dentro do server.js (VPS),
    // ou via HTTP quando roda como processo local separado.
    async _broadcast(dados) {
        if (typeof global.wsBroadcast === 'function') {
            global.wsBroadcast(dados);
            return;
        }
        const url = process.env.RADARDABET_BACKEND_URL;
        const key = process.env.JWT_SECRET;
        if (!url || !key) {
            console.log('   ⚠️  _broadcast: RADARDABET_BACKEND_URL ou JWT_SECRET não configurado — skip');
            return;
        }
        try {
            const mod = url.startsWith('https') ? require('https') : require('http');
            const body = Buffer.from(JSON.stringify(dados));
            const urlObj = new URL('/api/ws/notificar', url);
            await new Promise((resolve, reject) => {
                const req = mod.request({
                    hostname: urlObj.hostname,
                    port: urlObj.port || (url.startsWith('https') ? 443 : 80),
                    path: urlObj.pathname,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, 'x-notify-key': key },
                    timeout: 5000
                }, res => {
                    let raw = '';
                    res.on('data', d => raw += d);
                    res.on('end', () => {
                        if (res.statusCode === 200) console.log(`   ✅ _broadcast → VPS OK`);
                        else console.log(`   ⚠️  _broadcast → VPS status ${res.statusCode}: ${raw.substring(0,80)}`);
                        resolve();
                    });
                });
                req.on('error', e => { console.log(`   ⚠️  _broadcast erro: ${e.message}`); resolve(); });
                req.on('timeout', () => { req.destroy(); console.log('   ⚠️  _broadcast timeout'); resolve(); });
                req.write(body);
                req.end();
            });
        } catch(e) { console.log(`   ⚠️  _broadcast exception: ${e.message}`); }
    }

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
        // Migrações estruturais — sempre executadas (rápidas: IF NOT EXISTS / IF EXISTS)
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

        // Migrações de normalização de dados históricos — desabilitadas por padrão (migracoes_normalizar=1 para ativar)
        const rCfg = await this.pool.request().query(
            `IF OBJECT_ID('bet365_config') IS NOT NULL
                 SELECT TOP 1 valor FROM bet365_config WHERE chave='migracoes_normalizar'
             ELSE
                 SELECT NULL AS valor WHERE 1=0`
        ).catch(() => ({ recordset: [] }));
        if (rCfg.recordset[0]?.valor !== '1') {
            console.log('   ⏩ Normalizações de dados desabilitadas (migracoes_normalizar=0)');
            return;
        }

        console.log('   🔧 Executando normalizações de dados históricos...');
        const normalizacoes = [
            // ── Normalizar nomes de mercado em inglês → português ──
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
        ];
        for (const mig of normalizacoes) {
            await this.pool.query(mig).catch(e => console.warn('⚠️ Schema:', e.message));
        }
        console.log('   ✅ Normalizações de dados concluídas');
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

    async _lancarEdgeAuto() {
        const headless = MODO_INICIO === 'auto';
        console.log(`🚀 Iniciando Edge automaticamente (${headless ? 'headless' : 'visível'})...`);
        console.log(`   📁 Perfil: ${EDGE_PERFIL}`);

        this.browser = await puppeteer.launch({
            executablePath: EDGE_EXE,
            headless,
            defaultViewport: null,
            args: [
                `--user-data-dir=${EDGE_PERFIL}`,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
            ],
        });

        console.log('✅ Edge lançado — abrindo Bet365...');
        const pages = await this.browser.pages();
        const pg    = pages[0] || await this.browser.newPage();
        await pg.goto(URL_SOCCER, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this._delay(4000);

        // _verificarSessao detecta "Faça Login para Assistir" ou botão Login e faz login automático
        await this._verificarSessao(pg);
        await this._delay(3000);
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

        if (MODO_INICIO === 'auto' || MODO_INICIO === 'auto-visivel') {
            await this._lancarEdgeAuto();
            return;
        }

        // Modo manual: conecta ao Edge já aberto pelo usuário
        let endpoint;
        try {
            endpoint = await this._getEdgeEndpoint();
            this._edgeSemPortaConsec = 0; // sucesso — reseta contador
        } catch(errPorta) {
            this._edgeSemPortaConsec++;
            console.log(`   ⚠️  Edge não encontrado na porta ${DEBUG_PORT} (${this._edgeSemPortaConsec}x): ${errPorta.message}`);
            // Após 3 falhas consecutivas: Edge reiniciou sem debug port (crash recovery) → reinicia tudo
            if (this._edgeSemPortaConsec >= 3 && !this._reinicioAgendado && this._cfgBool('coletor_auto_restart', true)) {
                this._reinicioAgendado = true;
                console.log(`   🔄 Edge sem porta debug após ${this._edgeSemPortaConsec} tentativas — disparando reinício automático em 5s...`);
                const pool = await this.conectarBanco().catch(() => null);
                const agora = new Date().toLocaleTimeString('pt-BR');
                if (pool) {
                    dispararAlerta(this.cfg, pool,
                        '🔄 Edge caiu — reinício automático',
                        `Edge não encontrado na porta ${DEBUG_PORT} (${this._edgeSemPortaConsec}x).\nReiniciando Edge + Node automaticamente.\n🕐 ${agora}`
                    ).catch(() => {});
                }
                setTimeout(() => {
                    try {
                        const { spawn } = require('child_process');
                        const batPath = require('path').join(__dirname, '..', '..', 'reiniciar-tudo.bat');
                        spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore' }).unref();
                        console.log('   🔄 reiniciar-tudo.bat disparado — encerrando processo...');
                    } catch(batErr) {
                        console.warn('   ⚠️  Erro ao disparar reiniciar-tudo.bat:', batErr.message);
                    }
                    process.exit(0);
                }, 5000);
            }
            throw errPorta;
        }
        console.log(`🌐 Conectando ao Edge (${endpoint.Browser})...`);

        this.browser = await puppeteer.connect({
            browserWSEndpoint: endpoint.webSocketDebuggerUrl,
            defaultViewport: null
        });
        console.log('✅ Bet365 - Conectado ao Edge do usuário');
    }

    async encerrar() {
        if (this.browser) {
            if (MODO_INICIO === 'auto' || MODO_INICIO === 'auto-visivel') {
                await this.browser.close().catch(() => {});
                console.log('🔌 Bet365 - Edge encerrado (modo auto)');
            } else {
                this.browser.disconnect();
                console.log('🔌 Bet365 - Desconectado do Edge');
            }
            this.browser = null;
            this.page    = null;
        }
        if (this.pool) {
            await this.pool.close().catch(() => {});
            this.pool = null;
        }
    }

    // ─────────────────────────────────────────────────────────────
    // SCREENSHOTS — captura tela dos resultados para validação
    // ─────────────────────────────────────────────────────────────

    async _tirarScreenshotFalha(pg, motivo) {
        try {
            if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
            const agora    = new Date();
            const ts       = `${agora.getUTCFullYear()}-${String(agora.getUTCMonth()+1).padStart(2,'0')}-${String(agora.getUTCDate()).padStart(2,'0')}` +
                             `_${String(agora.getUTCHours()).padStart(2,'0')}-${String(agora.getUTCMinutes()).padStart(2,'0')}-${String(agora.getUTCSeconds()).padStart(2,'0')}`;
            const motivoLimpo = motivo.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 40);
            const filename  = `FALHA_${ts}_${motivoLimpo}.png`;
            await pg.screenshot({ path: path.join(SCREENSHOT_DIR, filename), fullPage: false });
            console.log(`   📸 Screenshot: ${filename}`);
        } catch(e) {
            console.warn(`   ⚠️  Screenshot falhou: ${e.message}`);
        }
    }

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
        const resultados = [];
        await this._coletarResultados(pg, liga, resultados);
        return { resultados };
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

        // Deduplica por nome — evita processar a mesma liga duas vezes em caso de DOM duplicado
        // (pode acontecer após duplo login rápido que deixa a página em estado inconsistente)
        const ligasUnicas = [...new Map(ligas.map(l => [l.nome, l])).values()];

        // Filtra ligas: ignora por nome E respeita config do banco
        const ligasFiltradas = ligasUnicas.filter(l => {
            if (LIGAS_IGNORAR.some(ig => l.nome.toLowerCase().includes(ig))) return false;
            const norm = normalizarNomeLiga(l.nome);
            const key  = LIGA_CONFIG_KEY[norm];
            return key ? this._cfgBool(key, true) : true;
        });

        console.log(`   ✅ ${ligasFiltradas.length} liga(s): ${ligasFiltradas.map(l => l.nome).join(' | ')}`);

        const todosResultados = [];
        const contadoresTotal = { eventosOk: 0, mercadosOk: 0, oddsOk: 0, histOk: 0 };

        // Limpeza de screenshots antigos no início de cada ciclo
        this._limparScreenshotsAntigos();

        for (let i = 0; i < ligasFiltradas.length; i++) {
            const liga = ligasFiltradas[i];

            // Garante que a aba está em foco antes de qualquer interação
            // (evita throttling do Chromium quando o browser está em background)
            await pg.bringToFront().catch(() => {});

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

            let _ligaTodosCache = false;
            try {
                const { resultados } = await this._coletarLiga(pg, liga);
                todosResultados.push(...resultados);

                // ── Filtro de cache — pula resultados já salvos nesta sessão ──
                const cacheAtivo = this._cfgBool('cache_resultados_ativo', false);
                const CACHE_TTL  = 3 * 60 * 60 * 1000; // 3h
                const novos = cacheAtivo
                    ? resultados.filter(r => {
                        const k      = `${r.liga}|${r.timeCasa}|${r.timeFora}|${r.horario}`;
                        const ts     = this._resultadosCache.get(k);
                        const cached = ts && (Date.now() - ts < CACHE_TTL);
                        if (cached) console.log(`   ⏭️  [${normalizarNomeLiga(liga.nome)}] ${r.timeCasa} × ${r.timeFora} (UTC ${r.horario}) — já coletado`);
                        return !cached;
                    })
                    : resultados;

                // ── Commit por liga — salva imediatamente após coletar cada liga ──
                if (novos.length > 0) {
                    console.log(`   💾 [${normalizarNomeLiga(liga.nome)}] Salvando no banco...`);
                    const cont = await this.salvarNoBanco({ eventos: [], resultados: novos });
                    contadoresTotal.eventosOk  += cont.eventosOk;
                    contadoresTotal.mercadosOk += cont.mercadosOk;
                    contadoresTotal.oddsOk     += cont.oddsOk;
                    contadoresTotal.histOk     += cont.histOk;
                    // Notifica o frontend imediatamente após cada liga salvar,
                    // sem esperar o ciclo completo terminar.
                    if (cont.histOk > 0) {
                        console.log(`   📡 [${normalizarNomeLiga(liga.nome)}] Notificando frontend — ${cont.histOk} resultado(s)`);
                        this._broadcast({ tipo: 'coleta', fonte: 'bet365', novos: cont.eventosOk, resultadosSalvos: cont.histOk, timestamp: new Date().toISOString() });
                    }
                }

                // Pula Ctrl+F5 apenas se ESTA liga tinha resultados e todos já estavam no cache
                _ligaTodosCache = cacheAtivo && resultados.length > 0 && novos.length === 0;
            } catch(err) {
                console.log(`   ❌ [${liga.nome}] Erro: ${err.message}`);
            }

            if (_ligaTodosCache) {
                console.log(`   ⏭️  [${normalizarNomeLiga(liga.nome)}] Ctrl+F5 pulado — tudo em cache`);
                continue;
            }
            // Ctrl+F5 (hard refresh) após cada liga — força buscar do servidor, sem cache
            console.log(`   🔄 [${liga.nome}] Ctrl+F5 — recarregando sem cache...`);
            let recarregouOk = false;
            for (let r = 1; r <= 2; r++) {
                try {
                    await pg.bringToFront().catch(() => {}); // foco antes do F5
                    await this._hardRefresh(pg, this._cfgNum('timeout_navegacao_ms', 30000));
                    await this._delay(this._cfgNum('delay_pos_reload_ms', 8000));
                    await pg.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: this._cfgNum('timeout_ligas_ms', 20000) });
                    recarregouOk = true;
                    break; // ligas apareceram, continua para próxima liga
                } catch(e) {
                    console.log(`   ⚠️  Ligas não apareceram após Ctrl+F5 (${r}/2), verificando sessão...`);
                    await this._tirarScreenshotFalha(pg, `f5_mid_r${r}`);
                    await this._verificarSessao(pg);
                }
            }
            if (!recarregouOk) {
                console.log('   ❌ Não foi possível recarregar — navegando de volta para URL virtual...');
                let recuperouMidCiclo = false;
                for (let rt = 1; rt <= 2; rt++) {
                    try {
                        await pg.goto(this.url, { waitUntil: 'domcontentloaded', timeout: this._cfgNum('timeout_goto_ms', 60000) });
                        await this._delay(12000); // mais tempo que o reload normal
                        await this._verificarSessao(pg);
                        await pg.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: this._cfgNum('timeout_ligas_ms', 20000) });
                        console.log('   ✅ Navegação de recuperação OK — ligas voltaram');
                        recuperouMidCiclo = true;
                        break;
                    } catch(e) {
                        console.log(`   ❌ Recuperação tentativa ${rt}/2 falhou: ${e.message.substring(0, 60)}`);
                        await this._tirarScreenshotFalha(pg, `recuperacao_mid_rt${rt}`);
                        if (rt < 2) await this._delay(5000);
                    }
                }
                if (!recuperouMidCiclo) {
                    console.log('   ⚠️  Recuperação mid-ciclo falhou — próximas ligas podem não aparecer');
                    await this._tirarScreenshotFalha(pg, 'recuperacao_mid_ciclo_final');
                }
            }
        }

        console.log(`\n   ✅ Total: ${todosResultados.length} resultado(s)`);
        return { resultados: todosResultados, contadores: contadoresTotal };
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
                // Marca no cache para evitar re-salvamento nos próximos ciclos
                this._resultadosCache.set(`${res.liga}|${res.timeCasa}|${res.timeFora}|${res.horario}`, Date.now());
                histOk++;
            } catch(e) {
                console.error(`   ❌ Erro histórico ${res.timeCasa} x ${res.timeFora}: ${e.message}`);
            }
        }

        console.log(`   💾 Resultados salvos: ${histOk}`);
        return { eventosOk, mercadosOk, oddsOk, histOk };
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

    // Itera TODOS os frames da página (inclusive iframes) procurando o modal de confirmação.
    // O Bet365 renderiza o modal num iframe separado (mdl-ModalManager_ModalContainer-iframenoheight),
    // por isso pg.evaluate() no frame principal nunca o enxerga.
    async _encontrarFrameModal(pg) {
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

    async _verificarSessao(pg, { forcar = false } = {}) {
        try {
            await pg.bringToFront();

            // ── Detecta modal "confirme os seus dados" em qualquer frame ─────────────
            const frameModal = await this._encontrarFrameModal(pg);

            if (frameModal) {
                console.log('   🔒 Modal "Confirme seus dados" detectado — preenchendo...');
                this._logAuditoria('modal_confirmacao_avr', 'Modal confirme seus dados na página AVR');
                const contas = this._listarContas();
                for (const [, , dataNasc, emailVerif] of contas) {
                    if (!emailVerif || !dataNasc) continue;
                    const preencheu = await this._preencherConfirmacaoDados(frameModal, emailVerif, dataNasc);
                    if (!preencheu) continue;
                    await this._delay(this._cfgNum('delay_confirmacao_modal_ms', 6000));
                    let sumiu = true;
                    try {
                        sumiu = await frameModal.evaluate(() =>
                            !document.querySelector('.nui-ModalContainer select[aria-label="Dia"]')
                        );
                    } catch(_) { sumiu = true; } // frame detachado = modal fechou = sucesso
                    if (sumiu) {
                        console.log('   ✅ Modal de confirmação resolvido — sessão ativa!');
                        this._logAuditoria('modal_confirmacao_ok', 'Modal preenchido com sucesso', emailVerif);
                        this._ultimoLoginTs = null;
                        // Após confirmação, Bet365 pode redirecionar para fora do AVR.
                        // Navega de volta para garantir que o próximo ciclo encontre a página certa.
                        try {
                            await this._delay(3000);
                            const urlPos = pg.url();
                            if (!urlPos.includes('AVR')) {
                                console.log('   🔄 Redirecionando para página virtual após confirmação...');
                                await pg.goto(this.url, { waitUntil: 'domcontentloaded', timeout: this._cfgNum('timeout_goto_ms', 60000) });
                                await this._delay(this._cfgNum('delay_pos_reload_ms', 4000));
                            }
                        } catch(e) {
                            console.warn('   ⚠️  Falha ao redirecionar após confirmação:', e.message);
                        }
                        return;
                    }
                }
                console.log('   ⚠️  Não conseguiu resolver modal de confirmação — prosseguindo verificação normal...');
                await this._tirarScreenshotFalha(pg, 'modal_confirmacao_nao_resolvido');
            }

            // ── Detecta estado da sessão ──────────────────────────────────────────
            const url = pg.url();
            const naPaginaVirtual = url.includes('bet365') && url.includes('AVR');

            const temAvisoVirtual = await pg.evaluate(() =>
                [...document.querySelectorAll('button')].some(b =>
                    (b.textContent || '').trim().includes('Faça Login para Assistir'))
            );

            const temBotaoLoginHeader = !temAvisoVirtual && await pg.evaluate(() =>
                [...document.querySelectorAll('button, a, [role="button"]')].some(el => {
                    const t = (el.textContent || el.innerText || '').trim();
                    return t === 'Login' || t === 'Log In';
                })
            );

            if (!forcar && !temAvisoVirtual && !temBotaoLoginHeader && naPaginaVirtual) return; // sessão OK
            if (forcar && !temAvisoVirtual && !temBotaoLoginHeader && naPaginaVirtual) {
                console.log('   🔑 Sessão aparenta OK visualmente mas forçando login (ciclos sem resultado)...');
            }

            const motivo = temAvisoVirtual ? '"Faça Login para Assistir" detectado'
                : !naPaginaVirtual         ? `URL fora da página virtual: ${url.substring(0, 60)}`
                                           : 'botão "Login" no cabeçalho detectado';

            // ── Proteção anti-duplo-login (mesmo processo) ────────────────────────
            // _verificarSessao é chamada até 3x por ciclo. Se já tentamos login nos
            // últimos 5 min neste processo, aguarda em vez de tentar de novo.
            const TENTATIVA_COOLDOWN_MS = 5 * 60 * 1000;
            if (this._ultimoLoginTs && (Date.now() - this._ultimoLoginTs) < TENTATIVA_COOLDOWN_MS) {
                const secAtras = Math.round((Date.now() - this._ultimoLoginTs) / 1000);
                console.log(`   ⏳ Sessão expirada — login em andamento ou aguardando (${secAtras}s)`);
                return;
            }

            // ── Cooldown cross-processo: login falhou recentemente? ───────────────
            // Arquivo gravado quando _loginComCredenciais retorna false.
            // Limpo pelo iniciar-tudo.bat no início manual.
            const FALHA_COOLDOWN_MS = 10 * 60 * 1000;
            const FALHA_TS_FILE = require('path').join(require('os').tmpdir(), 'bet365-login-fail.ts');
            let ultimaFalha = 0;
            try {
                ultimaFalha = parseInt(require('fs').readFileSync(FALHA_TS_FILE, 'utf8').trim()) || 0;
            } catch(_) {}

            const agora = new Date().toLocaleTimeString('pt-BR');

            if ((Date.now() - ultimaFalha) < FALHA_COOLDOWN_MS) {
                // Login falhou recentemente em outro processo — não tenta de novo
                const minAtras = Math.round((Date.now() - ultimaFalha) / 60000);
                console.log(`   ⚠️  Login falhou ${minAtras}min atrás — aguardando intervenção manual`);
                if (Date.now() - this._ultimoAlertaLoginTs >= FALHA_COOLDOWN_MS) {
                    this._ultimoAlertaLoginTs = Date.now();
                    const pool = await this.conectarBanco().catch(() => null);
                    dispararAlerta(this.cfg, pool,
                        '❌ Bet365 — login manual necessário',
                        `Login automático falhou. Acesse o Edge e faça login manualmente.\n🕐 ${agora}`
                    ).catch(() => {});
                }
                return;
            }

            // ── Realiza login com credenciais (1 tentativa por evento) ────────────
            console.log(`   🔐 Sessão expirada — ${motivo} — realizando login automático...`);
            this._logAuditoria('sessao_expirada', motivo);
            this._ultimoLoginTs = Date.now(); // marca tentativa — bloqueia novas por 5 min

            const sessaoOk = await this._loginComCredenciais(pg);

            // ── Após login bem-sucedido, garante retorno à página virtual ─────────
            if (sessaoOk) {
                try {
                    const urlPos = pg.url();
                    if (!urlPos.includes('AVR')) {
                        console.log('   🔄 Redirecionando para página virtual...');
                        await pg.goto(this.url, { waitUntil: 'domcontentloaded', timeout: this._cfgNum('timeout_goto_ms', 60000) });
                        await this._delay(this._cfgNum('delay_pos_reload_ms', 4000));
                    }
                } catch(e) {
                    console.warn('   ⚠️  Falha ao redirecionar após login:', e.message);
                }
            }

            // ── Notificação Telegram ──────────────────────────────────────────────
            const throttle = 10 * 60 * 1000;
            if (Date.now() - this._ultimoAlertaLoginTs >= throttle) {
                this._ultimoAlertaLoginTs = Date.now();
                const pool = await this.conectarBanco().catch(() => null);
                if (sessaoOk) {
                    console.log('   ✅ Sessão restaurada!');
                    dispararAlerta(this.cfg, pool,
                        '🔐 Sessão Bet365 expirou — restaurada',
                        `Login automático realizado com sucesso.\n✅ Coleta continuando normalmente.\n🕐 ${agora}`
                    ).catch(() => {});
                } else {
                    console.log('   ❌ Login falhou — reiniciando tudo...');
                    dispararAlerta(this.cfg, pool,
                        '❌ Sessão Bet365 — login falhou, reiniciando',
                        `Login com credenciais falhou.\n🔄 Reiniciando Edge + Node automaticamente.\n🕐 ${agora}`
                    ).catch(() => {});
                }
            }

            // ── Login falhou → grava cooldown + reinicia tudo (se habilitado) ──────
            if (!sessaoOk && !this._reinicioAgendado) {
                this._reinicioAgendado = true;
                try {
                    require('fs').writeFileSync(FALHA_TS_FILE, String(Date.now()), 'utf8');
                } catch(_) {}

                const autoRestart = this._cfgBool('coletor_auto_restart', true);
                if (!autoRestart) {
                    console.log('   ⚠️  Login falhou — auto-restart DESATIVADO (coletor_auto_restart=false). Aguardando intervenção manual.');
                    return;
                }

                console.log('   🔄 Reiniciando tudo em 5s (Edge + Node)...');
                setTimeout(() => {
                    try {
                        const { spawn } = require('child_process');
                        const batPath = require('path').join(__dirname, '..', '..', 'reiniciar-tudo.bat');
                        spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore' }).unref();
                        console.log('   🔄 reiniciar-tudo.bat disparado — encerrando processo...');
                    } catch(batErr) {
                        console.warn('   ⚠️  Erro ao disparar reiniciar-tudo.bat:', batErr.message);
                    }
                    process.exit(0);
                }, 5000);
            }

        } catch(e) {
            console.warn('   ⚠️  _verificarSessao:', e.message);
            await this._tirarScreenshotFalha(pg, 'verificar_sessao_erro').catch(() => {});
        }
    }

    _listarContas() {
        // Suporta lista via BET365_CONTAS=user1:pass1,user2:pass2,...
        // BET365_EMAILS_VERIFICACAO=email1,email2   (e-mails para modal "Confirme seus dados")
        // BET365_DATAS_NASC=DD/MM/YYYY,DD/MM/YYYY  (datas de nascimento, mesma ordem)
        // Fallback para BET365_USERNAME/BET365_PASSWORD (compatibilidade)
        const datas  = (process.env.BET365_DATAS_NASC          || '').split(',').map(s => s.trim()).filter(Boolean);
        const emails = (process.env.BET365_EMAILS_VERIFICACAO  || '').split(',').map(s => s.trim()).filter(Boolean);
        const lista  = (process.env.BET365_CONTAS || '').trim();
        if (lista) {
            return lista.split(',')
                .map((c, i) => {
                    const [u, ...rest] = c.trim().split(':');
                    const emailVerif = emails[i] || (u.includes('@') ? u : null);
                    return [u, rest.join(':'), datas[i] || null, emailVerif];
                })
                .filter(([u, s]) => u && s);
        }
        const u = (process.env.BET365_USERNAME || '').trim();
        const s = (process.env.BET365_PASSWORD || '').trim();
        const emailVerif = emails[0] || (u.includes('@') ? u : null);
        return (u && s) ? [[u, s, datas[0] || null, emailVerif]] : [];
    }

    async _tentarLoginComPar(pg, usuario, senha, dataNasc = null, emailVerif = null) {
        try {
            // Se não há campos de input visíveis, o modal pode não estar aberto —
            // tenta abrir clicando no botão "Login" do cabeçalho primeiro
            let inputUser = await pg.$('input[type="text"]:not([type="hidden"])');
            if (!inputUser) {
                const abrindoModal = await this._clicarBotaoPorTexto(pg, 'Login', true)
                    || await this._clicarBotaoPorTexto(pg, 'Log In', true)
                    || await this._clicarElementoPorTexto(pg, 'Login', true);
                if (abrindoModal) {
                    await this._delay(this._cfgNum('delay_modal_login_ms', 2500));
                    inputUser = await pg.$('input[type="text"]:not([type="hidden"])');
                }
            }
            if (inputUser) {
                await inputUser.click({ clickCount: 3 });
                await inputUser.type(usuario, { delay: 60 });
            }
            const inputPass = await pg.$('input[type="password"]');
            if (inputPass) {
                await inputPass.click({ clickCount: 3 });
                await inputPass.type(senha, { delay: 60 });
            }
            // Clica no botão submit dentro do form/modal
            const clicou = await this._clicarBotaoSubmitModal(pg)
                || await this._clicarBotaoPorTexto(pg, 'Login', true);
            if (!clicou) { console.log('   ❌ Botão Login não encontrado'); return false; }

            await this._delay(this._cfgNum('delay_credenciais_ms', 5000));

            // ── Detecta modal "confirme os seus dados" em qualquer frame ─────────────
            const frameModalPos = await this._encontrarFrameModal(pg);
            if (frameModalPos) {
                console.log('   🔒 Modal "Confirme seus dados" detectado — preenchendo e-mail e data de nascimento...');
                this._logAuditoria('verificacao_confirmacao_dados', 'Modal confirme seus dados detectado', usuario);
                const preencheu = await this._preencherConfirmacaoDados(frameModalPos, emailVerif || usuario, dataNasc);
                if (preencheu) {
                    await this._delay(this._cfgNum('delay_confirmacao_modal_ms', 6000));
                    let modalSumiu = true;
                    try {
                        modalSumiu = await frameModalPos.evaluate(() =>
                            !document.querySelector('.nui-ModalContainer select[aria-label="Dia"]')
                        );
                    } catch(_) { modalSumiu = true; } // frame detachado = modal fechou = sucesso
                    if (modalSumiu) { console.log('   ✅ Confirmação aceita!'); return true; }
                    console.log('   ❌ Modal ainda aberto após confirmação');
                } else {
                    console.log('   ❌ Não foi possível preencher confirmação — sem data de nascimento no .env?');
                }
                return 'verificacao';
            }

            // Detecta pedido de verificação genérica (SMS, captcha)
            const pedindoVerificacao = await pg.evaluate(() => {
                const texto = (document.body?.innerText || '').toLowerCase();
                return texto.includes('verifica') || texto.includes('verification')
                    || texto.includes('sms') || texto.includes('código de segurança');
            });
            if (pedindoVerificacao) {
                console.log('   ⚠️  Conta exige verificação (SMS/email) — pulando para próxima...');
                return 'verificacao';
            }

            // Verifica se modal ainda está visível (false positive guard)
            const modalAindaAberto = await pg.evaluate(() => {
                const visibleSelects = [...document.querySelectorAll('select')].filter(s => {
                    const r = s.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                });
                return visibleSelects.some(s => {
                    const ph = (s.options[0]?.text || '').trim().toLowerCase().replace(/ê/g, 'e');
                    return ph === 'dia' || ph === 'mes' || ph === 'ano';
                });
            });
            if (modalAindaAberto) {
                console.log('   ⚠️  Modal de confirmação ainda aberto — login incompleto');
                return 'verificacao';
            }

            const ok = await pg.evaluate(() =>
                ![...document.querySelectorAll('button')].some(b =>
                    (b.textContent || '').trim().includes('Faça Login para Assistir'))
            );
            return ok ? true : false;
        } catch(e) {
            console.log('   ❌ Erro no login:', e.message);
            return false;
        }
    }

    async _preencherConfirmacaoDados(pg, email, dataNasc) {
        try {
            if (!dataNasc) {
                console.log('   ⚠️  BET365_DATAS_NASC não configurado — impossível preencher data');
                return false;
            }
            const parts = dataNasc.split(/[\/\-\.]/);
            if (parts.length < 3) {
                console.log(`   ⚠️  Formato inválido: ${dataNasc} (esperado DD/MM/YYYY)`);
                return false;
            }
            // Values do HTML: value="07" value="01" value="1990"
            const valDia = parts[0].padStart(2, '0');
            const valMes = parts[1].padStart(2, '0');
            const valAno = parts[2];

            // ── E-mail: id="email" (específico do modal Bet365) ────────────────────
            // Usa setter nativo + evento input para compatibilidade com React
            const emailOk = await pg.evaluate((emailVal) => {
                const input = document.querySelector('#email')
                    || document.querySelector('.nui-ModalContainer input[type="text"]')
                    || document.querySelector('input[placeholder*="e-mail" i]');
                if (!input) return false;
                input.focus();
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                if (setter) setter.call(input, emailVal);
                else input.value = emailVal;
                input.dispatchEvent(new Event('input',  { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }, email);
            console.log(emailOk ? `   ✉️  E-mail preenchido: ${email}` : '   ⚠️  Campo de e-mail não encontrado');
            await this._delay(this._cfgNum('delay_email_ms', 400));

            // ── Data de nascimento: aria-label exato do HTML da Bet365 ─────────────
            // <select aria-label="Dia"> value="01"–"31"
            // <select aria-label="Mês"> value="01"–"12" (texto Jan/Fev/...)
            // <select aria-label="Ano"> value="1900"–"2008"
            const dataOk = await pg.evaluate((dia, mes, ano) => {
                function setarSelect(sel, value) {
                    if (!sel) return false;
                    sel.value = value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    sel.dispatchEvent(new Event('input',  { bubbles: true }));
                    return sel.value === value;
                }
                const selDia = document.querySelector('select[aria-label="Dia"]');
                // Mês pode vir com ou sem acento dependendo do encoding
                const selMes = document.querySelector('select[aria-label="Mês"]')
                    || document.querySelector('select[aria-label="Mes"]')
                    || document.querySelector('select[aria-label="Més"]');
                const selAno = document.querySelector('select[aria-label="Ano"]');
                return {
                    dia: setarSelect(selDia, dia),
                    mes: setarSelect(selMes, mes),
                    ano: setarSelect(selAno, ano),
                };
            }, valDia, valMes, valAno);
            console.log(`   📅 Data ${valDia}/${valMes}/${valAno} — dia:${dataOk.dia} mês:${dataOk.mes} ano:${dataOk.ano}`);
            await this._delay(this._cfgNum('delay_data_nasc_ms', 800));

            // ── Botão Login dentro do nui-ModalContainer ───────────────────────────
            // O botão não tem type="submit" nem está em <form>; busca pelo texto dentro do modal
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
                // Frame detachado após o clique = modal fechou = login aceito
                if (eClick.message.includes('detached') || eClick.message.includes('Target closed')) {
                    console.log('   ✅ Modal fechado após clique (frame detachado — login aceito)');
                    return true;
                }
                throw eClick;
            }
            if (!clicou) console.log('   ⚠️  Botão Login não encontrado dentro do nui-ModalContainer');
            return clicou;
        } catch(e) {
            console.log('   ❌ Erro em _preencherConfirmacaoDados:', e.message);
            return false;
        }
    }

    async _loginComCredenciais(pg) {
        const contas = this._listarContas();
        if (contas.length === 0) {
            console.log('   ⚠️  Nenhuma credencial definida no .env (BET365_CONTAS ou BET365_USERNAME/PASSWORD)');
            return false;
        }

        for (let i = 0; i < contas.length; i++) {
            const [usuario, senha, dataNasc, emailVerif] = contas[i];
            const label = contas.length > 1 ? ` [conta ${i + 1}/${contas.length}]` : '';
            console.log(`   🔑 Tentando login${label}: ${usuario}`);
            this._logAuditoria('login_tentativa', `Tentando login${label}`, usuario);

            const resultado = await this._tentarLoginComPar(pg, usuario, senha, dataNasc, emailVerif);
            if (resultado === true) {
                console.log(`   ✅ Login bem-sucedido${label}!`);
                this._logAuditoria('login_ok', `Login bem-sucedido${label}`, usuario);
                return true;
            }
            if (resultado === 'verificacao') {
                this._logAuditoria('verificacao_exigida', 'Conta solicitou verificação SMS/email', usuario);
                // Notifica via Telegram mesmo que haja conta de fallback disponível
                const pool = await this.conectarBanco().catch(() => null);
                dispararAlerta(this.cfg, pool,
                    `⚠️ Bet365 — conta ${usuario} exige verificação`,
                    `A conta ${usuario} solicitou verificação de SMS/email durante o auto-login.\n` +
                    `${i + 1 < contas.length ? `Tentando conta de fallback (${i + 2}/${contas.length})...` : 'Não há conta de fallback — intervenção manual necessária.'}\n` +
                    `🕐 ${new Date().toLocaleTimeString('pt-BR')}`
                ).catch(() => {});
                continue; // tenta próxima conta
            }
            // false = falhou por outro motivo, tenta próxima mesmo assim
            console.log(`   ❌ Login falhou${label}`);
            this._logAuditoria('login_falhou', `Credencial rejeitada${label}`, usuario);
        }

        console.log('   ❌ Todas as contas falharam');
        this._logAuditoria('todas_falharam', 'Nenhuma conta conseguiu fazer login');
        return false;
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
    // AUDITORIA DO COLETOR
    // ─────────────────────────────────────────────────────────────

    _logAuditoria(tipo, detalhe = null, conta = null) {
        this.conectarBanco().then(pool => {
            pool.request()
                .input('tipo',    sql.NVarChar(50),  String(tipo).substring(0, 50))
                .input('detalhe', sql.NVarChar(500), detalhe ? String(detalhe).substring(0, 500) : null)
                .input('conta',   sql.NVarChar(100), conta   ? String(conta).substring(0, 100)   : null)
                .query(`
                    IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='coletor_auditoria' AND xtype='U')
                        CREATE TABLE coletor_auditoria (
                            id        INT IDENTITY(1,1) PRIMARY KEY,
                            data_hora DATETIME2 DEFAULT GETUTCDATE(),
                            tipo      NVARCHAR(50)  NOT NULL,
                            detalhe   NVARCHAR(500) NULL,
                            conta     NVARCHAR(100) NULL
                        );
                    INSERT INTO coletor_auditoria (tipo, detalhe, conta)
                    VALUES (@tipo, @detalhe, @conta);
                `)
                .catch(() => {});
        }).catch(() => {});
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

        // ── Backoff de ligas: pula ciclo se estamos em período de espera ─────────
        if (this._cfgBool('backoff_ligas_ativo', true) && this._proximaColetaPermitida > Date.now()) {
            const restanteMin = Math.ceil((this._proximaColetaPermitida - Date.now()) / 60000);
            console.log(`⏸️  Bet365 - Backoff ativo: aguardando ${restanteMin}min (${this._ligasFalhadasConsec} falhas consecutivas de ligas)`);
            this.coletando = false;
            return;
        }

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

            // ── PASSO 1: Verifica sessão ANTES de qualquer Ctrl+F5 ──────────────────
            // Se o Login já está aparecendo, não adianta recarregar — vai direto ao login.
            console.log('   ⏳ Aguardando ligas...');
            await this._verificarSessao(this.page);

            // ── PASSO 2: Aguarda ligas — com até 2 Ctrl+F5 e espera generosa ───────
            let ligasOk = false;
            try {
                await this.page.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: this._cfgNum('timeout_ligas_ms', 20000) });
                ligasOk = true;
            } catch(_) {}

            if (!ligasOk) {
                for (let tentativa = 1; tentativa <= 2; tentativa++) {
                    console.log(`   ⚠️  Ligas não apareceram (tentativa ${tentativa}/2) — Ctrl+F5...`);
                    try {
                        await this._hardRefresh(this.page, this._cfgNum('timeout_navegacao_ms', 30000));
                        // Aguarda a página estabilizar antes de verificar — mais tempo do que antes
                        await this._delay(this._cfgNum('delay_pos_reload_ms', 8000));
                    } catch(reloadErr) {
                        console.log(`   ⚠️  Hard refresh falhou: ${reloadErr.message}`);
                        await this._tirarScreenshotFalha(this.page, `hard_refresh_falhou_t${tentativa}`);
                    }
                    // Verifica sessão APÓS cada reload — pode ter expirado durante a navegação
                    await this._verificarSessao(this.page);
                    try {
                        await this.page.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: this._cfgNum('timeout_ligas_ms', 20000) });
                        ligasOk = true;
                        break;
                    } catch(_) {
                        await this._tirarScreenshotFalha(this.page, `ligas_nao_apareceram_t${tentativa}`);
                    }
                }
            }

            if (!ligasOk) {
                // Último recurso: goto() forçado na URL do futebol virtual + espera maior
                console.log('   🔁 Último recurso — navegando direto para URL virtual...');
                try {
                    await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: this._cfgNum('timeout_goto_ms', 60000) });
                    await this._delay(12000);
                    await this._verificarSessao(this.page);
                    await this.page.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: this._cfgNum('timeout_ligas_ms', 20000) });
                    ligasOk = true;
                    console.log('   ✅ Recuperação por goto OK — ligas voltaram');
                } catch(e) {
                    console.log(`   ❌ Recuperação por goto falhou: ${e.message.substring(0, 60)}`);
                    await this._tirarScreenshotFalha(this.page, 'recuperacao_goto_falhou');
                }
            }

            if (!ligasOk) {
                await this._tirarScreenshotFalha(this.page, 'ligas_nao_apareceram_FINAL');
                throw new Error('Ligas não apareceram após login + 2 recarregamentos — intervenção manual necessária');
            }

            // Ligas OK — reset do backoff
            this._ligasFalhadasConsec    = 0;
            this._proximaColetaPermitida = 0;

            // ── PASSO 3: Verificação final de sessão após ligas carregarem ─────────
            await this._verificarSessao(this.page);

            const { resultados: resBrutos, contadores } = await this._extrairDados(this.page);
            await this._logColeta(inicio, 'SUCESSO', contadores, null);

            this._broadcast({ tipo: 'coleta', fonte: 'bet365', novos: contadores.eventosOk, resultadosSalvos: contadores.histOk, timestamp: new Date().toISOString() });

            // Só marca sucesso se extraiu algum dado — garante alerta quando sessão falha silenciosamente
            if (resBrutos.length > 0) {
                this.ultimaColetaSucesso  = Date.now();
                this.ultimoErro           = null;
                this._ciclosSemResultados = 0;
                console.log(`✅ Bet365 - Coleta concluída`);
            } else {
                this._ciclosSemResultados++;
                this.ultimoErro = 'Coleta retornou 0 eventos e 0 resultados';
                console.log(`⚠️  Bet365 - Coleta concluída mas sem dados extraídos (sessão pode ter expirado) [${this._ciclosSemResultados}x]`);
                const threshold = this._cfgNum('ciclos_sem_resultado_threshold', 3);
                if (this._ciclosSemResultados >= threshold) {
                    console.log(`   🔑 ${this._ciclosSemResultados} ciclos sem resultado — forçando verificação de sessão...`);
                    await this._verificarSessao(this.page, { forcar: true });
                    this._ciclosSemResultados = 0;
                }
            }

        } catch(err) {
            this.ultimoErro = err.message;
            console.error(`❌ Bet365 - Erro: ${err.message}`);
            await this._logColeta(inicio, 'ERRO', null, err.message);

            // ── Backoff de ligas ──────────────────────────────────────────────────
            if (err.message.includes('Ligas não apareceram')) {
                this._ligasFalhadasConsec++;
                if (this._cfgBool('backoff_ligas_ativo', true)) {
                    const threshold = this._cfgNum('backoff_ligas_threshold', 5);
                    const esperaMin = this._cfgNum('backoff_ligas_espera_min', 15);
                    if (this._ligasFalhadasConsec >= threshold) {
                        this._proximaColetaPermitida = Date.now() + esperaMin * 60 * 1000;
                        const agora = new Date().toLocaleTimeString('pt-BR');
                        console.log(`⏸️  Bet365 - Backoff: ${this._ligasFalhadasConsec} falhas consecutivas → pausando ${esperaMin}min`);
                        this.conectarBanco().then(pool => {
                            dispararAlerta(this.cfg, pool,
                                `⏸️ Bet365 — backoff ${esperaMin}min`,
                                `Ligas não apareceram ${this._ligasFalhadasConsec}× seguidas.\nPróxima tentativa em ${esperaMin}min.\n🕐 ${agora}`
                            ).catch(() => {});
                        }).catch(() => {});
                    }
                }
            }

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
