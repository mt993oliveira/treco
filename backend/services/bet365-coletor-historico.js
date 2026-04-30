/**
 * ============================================================
 * COLETOR 3 — JOGOS ANTIGOS (BACKFILL MANUAL)
 * ============================================================
 * Responsabilidade: recuperar resultados de jogos já realizados
 * em um dia/hora específico, para preencher lacunas no banco
 * causadas por queda do sistema.
 *
 * Uso manual — NÃO roda em ciclo automático.
 * Pode usar a mesma porta do Coletor 2 (9223) quando este estiver parado.
 *
 * Fluxo por execução:
 *   Para cada liga → clica na aba → abre view Resultados →
 *   clica em cada botão de hora → coleta → salva → hard refresh → próxima hora/liga
 *
 * Uso:
 *   node -r dotenv/config backend/services/bet365-coletor-historico.js
 *
 * Parâmetros (via .env ou variáveis de ambiente):
 *   BET365_HIST_DEBUG_PORT=9223     (porta do Edge — padrão: 9223)
 *   BET365_HIST_DATA=2026-04-28     (data alvo — padrão: ontem)
 *   BET365_HIST_HORA_INI=12:00      (filtra horas a partir de — opcional)
 *   BET365_HIST_HORA_FIM=18:00      (filtra horas até — opcional)
 *   BET365_HIST_LIGAS=World Cup,Euro Cup  (filtra ligas — padrão: todas)
 *   BET365_HIST_DELAY_HORA_MS=2500  (aguarda após clicar botão de hora)
 *   BET365_HIST_DELAY_REFRESH_MS=4000 (aguarda após hard refresh)
 *
 * PRÉ-REQUISITO:
 *   Edge aberto na porta indicada com a conta Bet365 logada e
 *   a página de Futebol Virtual carregada.
 * ============================================================
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const sql    = require('mssql');
const http   = require('http');
const dotenv = require('dotenv');
dotenv.config();

// ── Parâmetros ───────────────────────────────────────────────
const DEBUG_PORT      = parseInt(process.env.BET365_HIST_DEBUG_PORT)    || 9223;
const DELAY_HORA_MS   = parseInt(process.env.BET365_HIST_DELAY_HORA_MS) || 2500;
const DELAY_REFRESH_MS= parseInt(process.env.BET365_HIST_DELAY_REFRESH_MS) || 4000;
const DELAY_LIGA_MS   = parseInt(process.env.BET365_HIST_DELAY_LIGA_MS) || 3000;
const MAX_SHOW_MORE   = 20;

function _ontemStr() {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
const DATA_ALVO    = process.env.BET365_HIST_DATA     || _ontemStr();
const HORA_INI     = process.env.BET365_HIST_HORA_INI || null;
const HORA_FIM     = process.env.BET365_HIST_HORA_FIM || null;
const LIGAS_FILTRO = process.env.BET365_HIST_LIGAS
    ? process.env.BET365_HIST_LIGAS.split(',').map(l => l.trim())
    : null;

const URL_SOCCER    = 'https://www.bet365.bet.br/#/AVR/B146/R%5E1/';
const LIGAS_IGNORAR = ['super league'];

// ── Normalização (igual ao coletor principal) ────────────────
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
    'albania':'Albânia','australia':'Austrália','austria':'Áustria','belgium':'Bélgica',
    'brazil':'Brasil','cameroon':'Camarões','canada':'Canadá','croatia':'Croácia',
    'czechia':'República Tcheca','czech republic':'República Tcheca','denmark':'Dinamarca',
    'ecuador':'Equador','england':'Inglaterra','france':'França','georgia':'Geórgia',
    'germany':'Alemanha','ghana':'Gana','hungary':'Hungria','iran':'Irã','italy':'Itália',
    'japan':'Japão','mexico':'México','morocco':'Marrocos','netherlands':'Países Baixos',
    'poland':'Polônia','romania':'Romênia','scotland':'Escócia','senegal':'Senegal',
    'serbia':'Sérvia','slovakia':'Eslováquia','slovenia':'Eslovênia',
    'south korea':'Coreia do Sul','spain':'Espanha','switzerland':'Suíça',
    'tunisia':'Tunísia','turkey':'Turquia','ukraine':'Ucrânia','uruguay':'Uruguai',
    'usa':'EUA','wales':'País de Gales',
};
function normalizarNomeTime(nome) {
    if (!nome) return nome;
    return TIME_NORMALIZAR[(nome || '').toLowerCase().trim()] || nome;
}

const MERCADO_NORMALIZAR = {
    'fulltime result':'Resultado Final','full time result':'Resultado Final','1x2':'Resultado Final',
    'correct score':'Resultado Correto','half time correct score':'Resultado Correto - Intervalo',
    'half-time correct score':'Resultado Correto - Intervalo',
    'half time/full time':'Intervalo/Final do Jogo','half time result':'Resultado Intervalo',
    'both teams to score':'Ambos Marcam','first goalscorer':'Primeiro Marcador de Gol',
    'first team to score':'Primeira Equipe a Marcar','winning margin':'Margem de Vitória',
    'result / both teams to score':'Resultado/Ambos Marcam',
    'result/both teams to score':'Resultado/Ambos Marcam',
    'exact total goals':'Total Exato de Gols','double chance':'Chance Dupla',
    'team goals':'Gols por Time',
};
function normalizarNomeMercado(nome) {
    const low = (nome || '').toLowerCase().trim();
    if (MERCADO_NORMALIZAR[low]) return MERCADO_NORMALIZAR[low];
    const m = low.match(/^total goals over\/under (\d+\.\d)$/);
    if (m) return `Total de Gols - Mais de/Menos de ${m[1]}`;
    return nome;
}

function normalizarNomeSelecao(sel) {
    const low = (sel || '').toLowerCase().trim();
    if (low === 'yes') return 'Sim';
    if (low === 'no')  return 'Não';
    const m1 = low.match(/^over (\d+\.\d)$/);  if (m1) return `Mais de ${m1[1]}`;
    const m2 = low.match(/^under (\d+\.\d)$/); if (m2) return `Menos de ${m2[1]}`;
    return sel;
}

// ── Hash / ID (igual ao coletor principal) ───────────────────
function _hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h;
}
function gerarId(liga, timeCasa, timeFora, horario) {
    const h = _hash(`${liga}|${timeCasa}|${timeFora}|${horario}`);
    return Number(BigInt(h) & BigInt('0x7FFFFFFFFFFFFFFF'));
}
function gerarMercadoId(eventoId, mercado, selecao) {
    const h = _hash(`${eventoId}|resultado|${mercado}|${selecao}`);
    return Number(BigInt(h) & BigInt('0x7FFFFFFFFFFFFFFF'));
}

// ============================================================
// PRÓXIMOS JOGOS VIA extra.bet365.bet.br — IMPLEMENTAÇÃO FUTURA
// ============================================================
// Esta função foi desenvolvida e testada no coletor de odds
// (bet365-coletor-odds.js, commit f8a2f80) e depois removida
// para ser integrada aqui quando a abordagem for validada.
//
// O que faz: abre uma nova aba na URL abaixo, raspa os botões
// de fixture e retorna os jogos que começam nos próximos N min.
//
// URL base: https://extra.bet365.bet.br/results/br?q=<params_b64>
//
// Seletores identificados na página (a confirmar se ainda válidos):
//   button.point-result__fixture         → cada jogo
//   .point-result__fixture-participant   → participantes (>=2 por jogo)
//   Texto do participante[0]: "HH.MM NomeTime" (ex: "21.07 Portugal")
//   Texto do participante[1]: "NomeTime" (ex: "Brasil")
//
// IDs das competições (descobertos em 2026-04-26):
//   World Cup:                compId='20120650', compNome='Copa do Mundo'
//   Euro Cup:                 compId='20700663', compNome='Euro Cup'
//   Premiership:              compId='20120653', compNome='Premier League'
//   Express Cup:              compId='20940364', compNome='Express Cup'
//   Super Liga Sul-Americana: compId='20849528', compNome='Super Liga Sul-Americana'
//
// Parâmetros da querystring (cada item encodado em base64, separados por "|"):
//   [0]  '2'
//   [1]  '146'
//   [2]  'Futebol%20Virtual'
//   [3]  dateStr     (ex: '2026-04-29')
//   [4]  dateStr     (mesmo — início e fim do range)
//   [5]  '0'
//   [6]  '0'
//   [7]  displayDate (ex: '29-29 Abril 2026' — formato PT-BR)
//   [8]  '0'
//   [9]  compNome    (encodeURIComponent — ex: 'Copa%20do%20Mundo')
//   [10] compId      (ex: '20120650')
//   [11] '0'
//   [12] ''          (vazio — sem b64)
//   [13] 'fixture'   (ou 'result' para buscar resultados passados)
//   [14..18] '0','0','0','0','0'
//   [19] ''          (vazio — sem b64)
//   [20] '0'
//   [21] '0'
//
// Código da função (pronto para descomentar e adaptar):
//
// async function buscarProximosFixtures(pg, ligaNorm, maxProximos = 4) {
//     const LIGA_COMP = {
//         'World Cup':                { compId: '20120650', compNome: 'Copa do Mundo' },
//         'Euro Cup':                 { compId: '20700663', compNome: 'Euro Cup' },
//         'Premiership':              { compId: '20120653', compNome: 'Premier League' },
//         'Express Cup':              { compId: '20940364', compNome: 'Express Cup' },
//         'Super Liga Sul-Americana': { compId: '20849528', compNome: 'Super Liga Sul-Americana' },
//     };
//     const ligaInfo = LIGA_COMP[ligaNorm];
//     if (!ligaInfo) return [];
//
//     const nowBST  = new Date(Date.now() + 3600000); // UTC+1 (referência Bet365)
//     const yyyy    = nowBST.getUTCFullYear();
//     const mm      = nowBST.getUTCMonth();
//     const dd      = nowBST.getUTCDate();
//     const dateStr = `${yyyy}-${String(mm+1).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
//     const MESES_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho',
//                       'Agosto','Setembro','Outubro','Novembro','Dezembro'];
//     const displayDate = `${dd}-${dd}%20${MESES_PT[mm]}%20${yyyy}`;
//
//     const b64 = s => Buffer.from(s).toString('base64');
//     const qParams = [
//         b64('2'), b64('146'), b64('Futebol%20Virtual'),
//         b64(dateStr), b64(dateStr), b64('0'), b64('0'),
//         b64(displayDate), b64('0'),
//         b64(encodeURIComponent(ligaInfo.compNome)),
//         b64(ligaInfo.compId), b64('0'), '',
//         b64('fixture'),
//         b64('0'), b64('0'), b64('0'), b64('0'), b64('0'),
//         '', b64('0'), b64('0'),
//     ].join('|');
//     const url = `https://extra.bet365.bet.br/results/br?q=${qParams}`;
//
//     const horaAtualBST = nowBST.getUTCHours();
//     const minAtualBST  = nowBST.getUTCMinutes();
//
//     let novaPg = null;
//     try {
//         novaPg = await pg.browser().newPage();
//         await novaPg.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
//         try { await novaPg.waitForSelector('button.point-result__fixture', { timeout: 10000 }); } catch(_) {}
//         await new Promise(r => setTimeout(r, 1000));
//
//         const { futuros, total } = await novaPg.evaluate((h, m, maxN) => {
//             const buttons = document.querySelectorAll('button.point-result__fixture');
//             const futuros = [];
//             for (const btn of buttons) {
//                 const parts = btn.querySelectorAll('.point-result__fixture-participant');
//                 if (parts.length < 2) continue;
//                 const p1    = parts[0].textContent.trim();
//                 const match = p1.match(/^(\d{1,2})\.(\d{2})\s+(.+)$/);
//                 if (!match) continue;
//                 const jH = parseInt(match[1]);
//                 const jM = parseInt(match[2]);
//                 const nowMins = h * 60 + m;
//                 const jMins   = jH * 60 + jM;
//                 if (jMins > nowMins && jMins <= nowMins + 6) {
//                     futuros.push({
//                         horario:  `${jH}:${String(jM).padStart(2,'0')}`,
//                         timeCasa: match[3].trim(),
//                         timeFora: parts[1].textContent.trim(),
//                     });
//                     if (futuros.length >= maxN) break;
//                 }
//             }
//             return { futuros, total: buttons.length };
//         }, horaAtualBST, minAtualBST, maxProximos);
//
//         console.log(`   📅 [${ligaNorm}] Fixtures: ${total} encontrados | ${futuros.length} próximos`);
//         if (futuros.length > 0)
//             console.log(`      → ${futuros.map(f => `${f.horario} ${f.timeCasa} x ${f.timeFora}`).join(' | ')}`);
//         return futuros;
//     } catch(err) {
//         console.warn(`   ⚠️  [${ligaNorm}] Erro fixtures: ${err.message}`);
//         return [];
//     } finally {
//         if (novaPg) await novaPg.close().catch(() => {});
//     }
// }
// ============================================================

// ── Filtro de hora ───────────────────────────────────────────
function dentroDoFiltroHora(horario) {
    if (!HORA_INI && !HORA_FIM) return true;
    const [h, m] = (horario || '00:00').split(':').map(Number);
    const mins = h * 60 + m;
    const ini  = HORA_INI ? (() => { const [a,b] = HORA_INI.split(':').map(Number); return a*60+b; })() : 0;
    const fim  = HORA_FIM ? (() => { const [a,b] = HORA_FIM.split(':').map(Number); return a*60+b; })() : 24*60;
    return mins >= ini && mins <= fim;
}

// ── Banco ────────────────────────────────────────────────────
const DB_CFG = {
    user:     process.env.DB_USER     || 'sa',
    password: process.env.DB_PASSWORD || 'kvb@4sJ2',
    server:   process.env.DB_SERVER   || '76.13.174.51',
    database: process.env.DB_NAME     || 'PRODUCAO',
    port:     parseInt(process.env.DB_PORT) || 1433,
    options:  { encrypt: false, trustServerCertificate: true },
    pool:     { max: 5, min: 0, idleTimeoutMillis: 30000 },
};
let pool = null;
async function getPool() {
    if (pool && pool.connected) return pool;
    pool = await sql.connect(DB_CFG);
    console.log('   ✅ [Hist] Banco conectado');
    return pool;
}

// ── Puppeteer: conecta ao Edge existente ─────────────────────
async function conectarEdge() {
    const wsUrl = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${DEBUG_PORT}/json/version`, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d).webSocketDebuggerUrl); } catch(e) { reject(e); } });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error(`timeout porta ${DEBUG_PORT}`)); });
    });
    const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null });
    const pages   = await browser.pages();
    let pg = pages.find(p => { try { return p.url().includes('bet365') && p.url().includes('AVR'); } catch(_) { return false; } });
    if (!pg) pg = pages.find(p => { try { return p.url().includes('bet365'); } catch(_) { return false; } });
    if (!pg) throw new Error('Aba bet365 não encontrada na porta ' + DEBUG_PORT);
    console.log(`   ✅ [Hist] Conectado (porta ${DEBUG_PORT}) | ${pg.url().substring(0, 60)}`);
    return { browser, pg };
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Hard refresh (Ctrl+F5) ───────────────────────────────────
async function hardRefresh(pg) {
    for (let r = 1; r <= 3; r++) {
        try {
            await pg.setCacheEnabled(false);
            await pg.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            await pg.setCacheEnabled(true);
            await delay(DELAY_REFRESH_MS);
            await pg.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: 15000 });
            return true;
        } catch(e) {
            await pg.setCacheEnabled(true).catch(() => {});
            console.log(`   ⚠️  [Hist] Refresh ${r}/3 falhou: ${e.message}`);
        }
    }
    return false;
}

// ── Extrai resultados da página atual (igual ao coletor principal) ──
async function extrairResultados(pg, ligaNorm) {
    const raw = await pg.evaluate((liga) => {
        const resultados = [];
        for (const grupo of document.querySelectorAll('.vrr-HeadToHeadMarketGroup')) {
            const eventLabel  = grupo.querySelector('.vrr-FixtureDetails_Event');
            const textoLabel  = eventLabel?.textContent.trim() || '';
            // Pula jogos em andamento (label com minuto: "65'")
            if (/\d{1,3}[´']\s*$/.test(textoLabel)) continue;
            const horarioMatch = textoLabel.match(/(\d{1,2}[.:]\d{2})$/);
            const horario      = horarioMatch ? horarioMatch[1] : null;
            const t1El = grupo.querySelector('.vrr-HTHTeamDetails_TeamOne');
            const t2El = grupo.querySelector('.vrr-HTHTeamDetails_TeamTwo');
            const scEl = grupo.querySelector('.vrr-HTHTeamDetails_Score');
            if (!t1El || !t2El || !scEl) continue;
            const timeCasa = t1El.textContent.trim();
            const timeFora = t2El.textContent.trim();
            const placar   = scEl.textContent.trim().replace(/\s+/g, '');
            const parts    = placar.split(/[-–]/);
            const gcParse  = parseInt(parts[0]);
            const gfParse  = parseInt(parts[1]);
            const placarOculto = isNaN(gcParse) || isNaN(gfParse);
            const golCasa  = placarOculto ? 5 : (gcParse || 0);
            const golFora  = placarOculto ? 0 : (gfParse || 0);
            const resultado = placarOculto ? 'OCULTO'
                : golCasa > golFora ? 'CASA' : golFora > golCasa ? 'FORA' : 'EMPATE';
            const mercados = [];
            for (const p of grupo.querySelectorAll('.vrr-HeadToHeadParticipant')) {
                const mkt = p.querySelector('.vrr-HeadToHeadParticipant_Market');
                const win = p.querySelector('.vrr-HeadToHeadParticipant_Winner');
                const prc = p.querySelector('.vrr-HeadToHeadParticipant_Price');
                if (mkt && win) mercados.push({ mercado: mkt.textContent.trim(), selecao: win.textContent.trim(), odd: prc ? parseFloat(prc.textContent.trim()) || 0 : 0 });
            }
            resultados.push({ liga, horario, timeCasa, timeFora, placar, golCasa, golFora, resultado, mercados, placarOculto });
        }
        return resultados;
    }, ligaNorm);

    return raw.map(r => ({
        ...r,
        timeCasa: normalizarNomeTime(r.timeCasa),
        timeFora: normalizarNomeTime(r.timeFora),
        mercados: (r.mercados || []).map(m => ({
            mercado: normalizarNomeMercado(m.mercado),
            selecao: normalizarNomeSelecao(m.selecao),
            odd:     m.odd,
        })),
    }));
}

// ── Salva resultados no banco ────────────────────────────────
async function salvarResultados(ligaNorm, resultados, dataAlvo) {
    const db = await getPool();
    let salvos = 0;

    for (const res of resultados) {
        try {
            // Monta data_partida: hora do jogo + data alvo (sem conversão de fuso — igual ao coletor principal)
            let dataPart = null;
            if (res.horario && /^\d{1,2}[.:]\d{2}$/.test(res.horario)) {
                const [h, m] = res.horario.replace('.', ':').split(':').map(Number);
                const [yyyy, mm, dd] = dataAlvo.split('-').map(Number);
                dataPart = new Date(Date.UTC(yyyy, mm - 1, dd, h, m, 0, 0));
            }

            // Busca evento correspondente no banco (±30 min)
            let eventoId = null;
            if (dataPart) {
                const ev = await db.request()
                    .input('liga',     sql.NVarChar(200), ligaNorm)
                    .input('timeCasa', sql.NVarChar(100), res.timeCasa)
                    .input('timeFora', sql.NVarChar(100), res.timeFora)
                    .input('dt',       sql.DateTime2,     dataPart)
                    .query(`
                        SELECT TOP 1 id FROM bet365_eventos
                        WHERE league_name=@liga AND time_casa=@timeCasa AND time_fora=@timeFora
                          AND start_time_datetime BETWEEN DATEADD(MINUTE,-30,@dt) AND DATEADD(MINUTE,30,@dt)
                        ORDER BY ABS(DATEDIFF(SECOND, start_time_datetime, @dt)) ASC
                    `);
                if (ev.recordset.length > 0) eventoId = ev.recordset[0].id;
            }

            // Fallback: gera ID por data+hora
            if (!eventoId) {
                const dataKey = dataPart
                    ? `${dataPart.getUTCFullYear()}-${String(dataPart.getUTCMonth()+1).padStart(2,'0')}-${String(dataPart.getUTCDate()).padStart(2,'0')}`
                    : dataAlvo;
                const timeKey = dataPart
                    ? `${String(dataPart.getUTCHours()).padStart(2,'0')}:${String(dataPart.getUTCMinutes()).padStart(2,'0')}`
                    : '00:00';
                eventoId = gerarId(ligaNorm, res.timeCasa, res.timeFora, `${dataKey}|${timeKey}`);
            }

            // Garante o evento no banco (upsert)
            await db.request()
                .input('id',      sql.BigInt,        eventoId)
                .input('liga',    sql.NVarChar(200),  ligaNorm)
                .input('casa',    sql.NVarChar(100),  res.timeCasa)
                .input('fora',    sql.NVarChar(100),  res.timeFora)
                .input('dt',      sql.DateTime2,      dataPart)
                .input('agora',   sql.DateTime2,      new Date())
                .query(`
                    MERGE bet365_eventos AS t USING (SELECT @id AS id) AS s ON t.id=s.id
                    WHEN MATCHED THEN UPDATE SET
                        t.league_name=@liga, t.time_casa=@casa, t.time_fora=@fora,
                        t.start_time_datetime=@dt, t.data_atualizacao=@agora, t.ativo=0
                    WHEN NOT MATCHED THEN INSERT
                        (id,url,league_name,time_casa,time_fora,status,start_time_datetime,
                         odd_casa,odd_empate,odd_fora,data_coleta,data_atualizacao,ativo)
                    VALUES (@id,'',@liga,@casa,@fora,'FINALIZADO',@dt,0,0,0,@agora,@agora,0);
                `);

            // Salva mercados pagos
            for (const mkt of (res.mercados || [])) {
                if (!mkt.mercado || !mkt.selecao) continue;
                const mktId = gerarMercadoId(eventoId, mkt.mercado, mkt.selecao);
                await db.request()
                    .input('id',       sql.BigInt,        mktId)
                    .input('eventoId', sql.BigInt,        eventoId)
                    .input('liga',     sql.NVarChar(200), ligaNorm)
                    .input('timeCasa', sql.NVarChar(100), res.timeCasa)
                    .input('timeFora', sql.NVarChar(100), res.timeFora)
                    .input('dt',       sql.DateTime2,     dataPart)
                    .input('mercado',  sql.NVarChar(200), mkt.mercado)
                    .input('selecao',  sql.NVarChar(200), mkt.selecao)
                    .input('odd',      sql.Decimal(10,2), mkt.odd || 0)
                    .query(`
                        MERGE bet365_resultados_mercados AS t USING (SELECT @id AS id) AS s ON t.id=s.id
                        WHEN MATCHED THEN UPDATE SET t.odd_paga=@odd, t.data_partida=@dt
                        WHEN NOT MATCHED THEN INSERT
                            (id,evento_id,liga,time_casa,time_fora,data_partida,mercado,selecao,odd_paga)
                        VALUES (@id,@eventoId,@liga,@timeCasa,@timeFora,@dt,@mercado,@selecao,@odd);
                    `);
            }

            salvos++;
        } catch(e) {
            console.error(`   ❌ Erro salvando ${res.timeCasa} x ${res.timeFora}: ${e.message}`);
        }
    }
    return salvos;
}

// ── Clica no botão "Resultados" e expande com "Show More" ────
async function abrirResultados(pg) {
    const temBtn = await pg.evaluate(() => !!document.querySelector('.vr-ResultsNavBarButton'));
    if (!temBtn) return false;
    await pg.evaluate(() => document.querySelector('.vr-ResultsNavBarButton')?.click());
    await delay(2000);
    // Expande "Show More" para carregar mais resultados
    for (let i = 0; i < MAX_SHOW_MORE; i++) {
        const temMore = await pg.evaluate(() => !!document.querySelector('.vrr-ShowMoreButton_Link'));
        if (!temMore) break;
        await pg.evaluate(() => document.querySelector('.vrr-ShowMoreButton_Link')?.click());
        await delay(600);
    }
    // Expande cards individuais
    await pg.evaluate(() => { [...document.querySelectorAll('.vrr-HeadToHeadMarketGroup .vrr-ShowMoreButton_Link')].forEach(b => b.click()); });
    await delay(1000);
    return true;
}

// ── Lê botões de hora disponíveis na view de resultados ──────
async function lerBotoesHora(pg) {
    return await pg.evaluate(() => {
        // Tenta os seletores prováveis para navegação de hora nos resultados
        const seletores = [
            '.vr-EventTimesNavBarButton',
            '.vrr-TimeNavBarButton',
            '.vr-ResultsNavBar .vr-NavBarButton',
            '.vrl-TimeNavBarButton',
        ];
        for (const sel of seletores) {
            const btns = [...document.querySelectorAll(sel)];
            if (btns.length > 0) {
                return {
                    seletor: sel,
                    horas: btns.map((b, idx) => ({
                        idx,
                        texto: b.querySelector('[class*="Text"]')?.textContent.trim()
                               || b.textContent.trim(),
                    })),
                };
            }
        }
        return { seletor: null, horas: [] };
    });
}

// ── Processa uma liga completa ───────────────────────────────
async function processarLiga(pg, nomeLiga) {
    const ligaNorm = normalizarNomeLiga(nomeLiga);
    console.log(`\n🏆 [${ligaNorm}] Iniciando...`);

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

    if (!clicou) { console.warn(`   ⚠️  [${ligaNorm}] Aba não encontrada`); return 0; }
    await delay(DELAY_LIGA_MS);

    // Abre view de Resultados
    const abriu = await abrirResultados(pg);
    if (!abriu) { console.warn(`   ⚠️  [${ligaNorm}] Botão Resultados não encontrado`); return 0; }

    // Verifica se há navegação por hora
    const { seletor, horas } = await lerBotoesHora(pg);

    let totalSalvos = 0;

    if (horas.length === 0) {
        // Sem botões de hora — coleta tudo que está visível de uma vez
        console.log(`   ℹ️  [${ligaNorm}] Sem navegação por hora — coletando resultados visíveis`);
        const resultados = await extrairResultados(pg, ligaNorm);
        const filtrados  = resultados.filter(r => dentroDoFiltroHora(r.horario));
        console.log(`   → ${resultados.length} resultado(s) | ${filtrados.length} no filtro de hora`);
        if (filtrados.length > 0) {
            totalSalvos = await salvarResultados(ligaNorm, filtrados, DATA_ALVO);
            console.log(`   💾 [${ligaNorm}] ${totalSalvos} resultado(s) salvos`);
        }
    } else {
        // Navega hora a hora
        console.log(`   🕐 [${ligaNorm}] ${horas.length} botão(ões) de hora encontrados via "${seletor}"`);
        console.log(`      Horas: ${horas.map(h => h.texto).join(' | ')}`);

        for (let i = 0; i < horas.length; i++) {
            const hora = horas[i];

            // Aplica filtro de hora se configurado
            if (!dentroDoFiltroHora(hora.texto)) {
                console.log(`   ⏭️  [${ligaNorm}] Hora ${hora.texto} fora do filtro`);
                continue;
            }

            console.log(`   🕐 [${ligaNorm}] Hora ${hora.texto} (${i+1}/${horas.length})`);

            // Clica no botão de hora pelo índice (mais confiável que texto)
            await pg.evaluate((sel, idx) => {
                const btns = document.querySelectorAll(sel);
                if (btns[idx]) btns[idx].click();
            }, seletor, i);
            await delay(DELAY_HORA_MS);

            // Expande cards
            await pg.evaluate(() => {
                [...document.querySelectorAll('.vrr-HeadToHeadMarketGroup .vrr-ShowMoreButton_Link')]
                    .forEach(b => b.click());
            });
            await delay(800);

            // Coleta resultados desta hora
            const resultados = await extrairResultados(pg, ligaNorm);
            console.log(`      → ${resultados.length} resultado(s)`);

            if (resultados.length > 0) {
                const salvos = await salvarResultados(ligaNorm, resultados, DATA_ALVO);
                totalSalvos += salvos;
                console.log(`      💾 ${salvos} salvos`);
            }

            // Hard refresh antes da próxima hora (exceto na última)
            if (i < horas.length - 1) {
                console.log(`   🔄 [${ligaNorm}] Hard refresh antes da próxima hora...`);
                const ok = await hardRefresh(pg);
                if (!ok) { console.warn(`   ⚠️  [${ligaNorm}] Refresh falhou — tentando continuar`); }

                // Reclica na liga após o refresh
                await pg.evaluate((nome) => {
                    const tabs = document.querySelectorAll('.vrl-MeetingsHeaderButton');
                    for (const tab of tabs) {
                        if (tab.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim() === nome)
                            { tab.click(); return; }
                    }
                }, nomeLiga);
                await delay(DELAY_LIGA_MS);
                await abrirResultados(pg);
            }
        }
    }

    return totalSalvos;
}

// ── Main ─────────────────────────────────────────────────────
async function run() {
    console.log('\n============================================');
    console.log('⏮️  COLETOR HISTÓRICO BET365 (BACKFILL)');
    console.log('============================================');
    console.log(`   📅 Data alvo:  ${DATA_ALVO}`);
    console.log(`   🕐 Hora ini:   ${HORA_INI || '(sem filtro)'}`);
    console.log(`   🕑 Hora fim:   ${HORA_FIM || '(sem filtro)'}`);
    console.log(`   🏆 Ligas:      ${LIGAS_FILTRO ? LIGAS_FILTRO.join(', ') : '(todas)'}`);
    console.log(`   🔌 Porta Edge: ${DEBUG_PORT}`);
    console.log('============================================\n');

    await getPool();

    const { browser, pg } = await conectarEdge();

    // Lê ligas disponíveis na página
    await pg.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: 20000 });
    const ligas = await pg.evaluate(() =>
        [...document.querySelectorAll('.vrl-MeetingsHeaderButton')]
            .map(el => el.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim() || '')
            .filter(Boolean)
    );

    // Filtra: ignora ligas indesejadas + aplica filtro manual
    const ligasFiltradas = ligas.filter(l => {
        if (LIGAS_IGNORAR.some(ig => l.toLowerCase().includes(ig))) return false;
        if (LIGAS_FILTRO) return LIGAS_FILTRO.some(f => normalizarNomeLiga(l).toLowerCase() === f.toLowerCase());
        return true;
    });

    console.log(`📋 ${ligasFiltradas.length} liga(s) para processar: ${ligasFiltradas.join(' | ')}\n`);

    let totalGeral = 0;

    for (let i = 0; i < ligasFiltradas.length; i++) {
        const nomeLiga = ligasFiltradas[i];
        try {
            const salvos = await processarLiga(pg, nomeLiga);
            totalGeral += salvos;
        } catch(e) {
            console.error(`   ❌ [${nomeLiga}] Erro: ${e.message}`);
        }

        // Hard refresh entre ligas (exceto após a última)
        if (i < ligasFiltradas.length - 1) {
            console.log(`\n   🔄 Hard refresh antes da próxima liga...`);
            await hardRefresh(pg);
        }
    }

    console.log('\n============================================');
    console.log(`✅ Backfill concluído — ${totalGeral} resultado(s) salvos`);
    console.log('============================================');

    await browser.disconnect();
    process.exit(0);
}

run().catch(e => { console.error('❌ [Hist] Fatal:', e.message); process.exit(1); });
