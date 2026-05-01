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
 *   Para cada liga → constrói URL extra.bet365.bet.br (modo=result) →
 *   abre nova aba → extrai jogos + placar → filtra por hora → salva no banco
 *
 * Uso:
 *   node -r dotenv/config backend/services/bet365-coletor-historico.js
 *
 * Parâmetros (via .env ou variáveis de ambiente):
 *   BET365_HIST_DEBUG_PORT=9223          (porta do Edge — padrão: 9223)
 *   BET365_HIST_DATA=2026-04-30          (data alvo — padrão: ontem)
 *   BET365_HIST_HORA_INI=21:00           (filtra horas a partir de — opcional)
 *   BET365_HIST_HORA_FIM=23:59           (filtra horas até — opcional)
 *   BET365_HIST_LIGAS=World Cup,Euro Cup (filtra ligas — padrão: todas)
 *
 * PRÉ-REQUISITO:
 *   Edge aberto na porta indicada com a conta Bet365 logada
 *   (a sessão é usada para autenticar em extra.bet365.bet.br).
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
const DELAY_LIGA_MS   = parseInt(process.env.BET365_HIST_DELAY_LIGA_MS) || 2000;

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
const LIMPAR_BACKFILL = process.env.BET365_HIST_LIMPAR === '1';

// extra.bet365 agrupa madrugada (00:00–05:59) sob o "dia anterior da sessão".
// Jogos antes deste horário pertencem ao próximo dia do calendário.
const HORA_VIRADA_DIA = 6;

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

// ── Competições para extra.bet365.bet.br ─────────────────────
const LIGA_COMP_EXTRA = {
    'World Cup':                { compId: '20120650', compNome: 'Copa do Mundo' },
    'Euro Cup':                 { compId: '20700663', compNome: 'Euro Cup' },
    'Premiership':              { compId: '20120653', compNome: 'Premier League' },
    'Express Cup':              { compId: '20940364', compNome: 'Express Cup' },
    'Super Liga Sul-Americana': { compId: '20849528', compNome: 'Super Liga Sul-Americana' },
};

function construirUrlExtra(ligaNorm, dataAlvo, modo) {
    const ligaInfo = LIGA_COMP_EXTRA[ligaNorm];
    if (!ligaInfo) return null;
    const [yyyy, mmN, dd] = dataAlvo.split('-').map(Number);
    const MESES_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                      'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const displayDate = `${dd}-${dd} ${MESES_PT[mmN-1]} ${yyyy}`;
    const b64 = s => Buffer.from(s).toString('base64');
    const qParams = [
        b64('2'), b64('146'), b64('Futebol%20Virtual'),
        b64(dataAlvo), b64(dataAlvo), b64('0'), b64('0'),
        b64(displayDate), b64('0'),
        b64(encodeURIComponent(ligaInfo.compNome)),
        b64(ligaInfo.compId), b64('0'), '',
        b64(modo || 'result'),
        b64('0'), b64('0'), b64('0'), b64('0'), b64('0'),
        '', b64('0'), b64('0'),
    ].join('|');
    return `https://extra.bet365.bet.br/results/br?q=${qParams}`;
}

async function coletarViaExtra(browser, ligaNorm, dataAlvo) {
    const url = construirUrlExtra(ligaNorm, dataAlvo, 'result');
    if (!url) { console.warn(`   ⚠️  [${ligaNorm}] Sem compId`); return 0; }
    console.log(`   🌐 [${ligaNorm}] ${url}`);

    let novaPg = null;
    try {
        novaPg = await browser.newPage();
        await novaPg.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        try { await novaPg.waitForSelector('button.point-result__fixture', { timeout: 15000 }); } catch(_) {}
        await delay(1000);

        // Se a página abriu direto num detalhe de jogo, volta para a lista
        const naLista = await novaPg.evaluate(() => {
            const inner = document.querySelector('.result-page__inner');
            return inner && !inner.classList.contains('result-page__inner--hidden');
        });
        if (!naLista) {
            await novaPg.evaluate(() => {
                const btn = document.querySelector('.fixture-page-header__back-button');
                if (btn) btn.click();
            });
            await novaPg.waitForFunction(() => {
                const inner = document.querySelector('.result-page__inner');
                return inner && !inner.classList.contains('result-page__inner--hidden');
            }, { timeout: 8000 }).catch(() => {});
            await delay(500);
        }

        // Identifica os botões dentro do filtro de hora (sem clicar ainda)
        const jogosParaClicar = await novaPg.evaluate((horaIni, horaFim) => {
            function dentroFiltro(horario) {
                const [h, m] = horario.split(':').map(Number);
                const mins = h * 60 + m;
                const ini = horaIni ? (() => { const [a,b] = horaIni.split(':').map(Number); return a*60+b; })() : 0;
                const fim = horaFim ? (() => { const [a,b] = horaFim.split(':').map(Number); return a*60+b; })() : 1440;
                return mins >= ini && mins <= fim;
            }
            const buttons = [...document.querySelectorAll('button.point-result__fixture')];
            const resultado = [];
            for (let i = 0; i < buttons.length; i++) {
                const btn = buttons[i];
                const parts = btn.querySelectorAll('.point-result__fixture-participant');
                if (parts.length < 2) continue;
                const p0 = parts[0].textContent.trim();
                const p1 = parts[1].textContent.trim();
                const match = p0.match(/^(\d{1,2})[.:](\d{2})\s+(.+)$/);
                if (!match) continue;
                const horario = `${match[1]}:${match[2]}`;
                if (!dentroFiltro(horario)) continue;
                resultado.push({
                    idx:      i,
                    horario,
                    timeCasa: match[3].trim(),
                    timeFora: p1.replace(/^\d{1,2}[.:]\d{2}\s+/, '').trim(),
                });
            }
            return resultado;
        }, HORA_INI, HORA_FIM);

        console.log(`   📊 [${ligaNorm}] ${jogosParaClicar.length} jogo(s) no filtro — abrindo detalhe de cada um`);
        if (jogosParaClicar.length === 0) return 0;

        const resultados = [];

        for (const jogo of jogosParaClicar) {
            try {
                // Clica no botão da partida (scroll para garantir visibilidade)
                await novaPg.evaluate((idx) => {
                    const btn = document.querySelectorAll('button.point-result__fixture')[idx];
                    if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); }
                }, jogo.idx);
                await delay(300);

                // Aguarda fixture-page__inner ficar visível
                await novaPg.waitForFunction(() => {
                    const inner = document.querySelector('.fixture-page__inner');
                    return inner && !inner.classList.contains('fixture-page__inner--hidden');
                }, { timeout: 15000 });

                // Aguarda pelo menos 1 mercado (não-bloqueante — jogos recentes podem não ter dados ainda)
                await novaPg.waitForFunction(() => {
                    return document.querySelectorAll('.market-search__link-variables-row').length > 0;
                }, { timeout: 12000 }).catch(() => {});
                await delay(800);

                // Extrai placar e seleções vencedoras
                const dadosJogo = await novaPg.evaluate((timeCasaArg) => {
                    const mercadosGanhadores = [];
                    let golCasa = null, golFora = null, placar = null;

                    const links = document.querySelectorAll('.market-search__link');
                    for (const link of links) {
                        const nameEl = link.querySelector('.market-search__link-name');
                        if (!nameEl) continue;
                        const nomeMercado = nameEl.textContent.trim();

                        const rows = link.querySelectorAll('.market-search__link-variables-row');
                        for (const row of rows) {
                            const selNome  = row.querySelector('.market-search__link-variables-name')?.textContent.trim();
                            const selValor = row.querySelector('.market-search__link-variables-value')?.textContent.trim();
                            if (!selNome || selValor !== 'Won') continue;

                            mercadosGanhadores.push({ mercado: nomeMercado, selecao: selNome, odd: 0 });

                            // Extrai placar de "Resultado Correto" (ex: "Bélgica 3-1", "Empate 1-1")
                            if (nomeMercado === 'Resultado Correto') {
                                const sm = selNome.match(/(\d+)-(\d+)/);
                                if (sm) {
                                    const g1 = parseInt(sm[1]);
                                    const g2 = parseInt(sm[2]);
                                    if (selNome.startsWith('Empate') || selNome.startsWith('Draw')) {
                                        golCasa = g1; golFora = g2;
                                    } else {
                                        // g1 = gols do vencedor, g2 = gols do perdedor
                                        const homeWon = selNome.toLowerCase().startsWith(timeCasaArg.toLowerCase());
                                        if (homeWon) { golCasa = g1; golFora = g2; }
                                        else         { golCasa = g2; golFora = g1; }
                                    }
                                    placar = `${golCasa}-${golFora}`;
                                }
                            }
                        }
                    }
                    return { mercadosGanhadores, golCasa, golFora, placar };
                }, jogo.timeCasa);

                const avisoMkt = dadosJogo.mercadosGanhadores.length === 0 ? ' ⚠️  sem mercados (página pode estar carregando)' : '';
                console.log(`   ✓ ${jogo.horario} ${jogo.timeCasa}×${jogo.timeFora} → ${dadosJogo.placar || '?'} | ${dadosJogo.mercadosGanhadores.length} mercados${avisoMkt}`);

                resultados.push({
                    ...jogo,
                    golCasa:  dadosJogo.golCasa,
                    golFora:  dadosJogo.golFora,
                    placar:   dadosJogo.placar,
                    mercados: dadosJogo.mercadosGanhadores,
                });

                // Volta para a lista de partidas
                await novaPg.evaluate(() => {
                    const btn = document.querySelector('.fixture-page-header__back-button');
                    if (btn) btn.click();
                });
                await novaPg.waitForFunction(() => {
                    const inner = document.querySelector('.result-page__inner');
                    return inner && !inner.classList.contains('result-page__inner--hidden');
                }, { timeout: 10000 });
                await delay(300);

            } catch(err) {
                console.warn(`   ⚠️  [${ligaNorm}] ${jogo.horario} ${jogo.timeCasa}: ${err.message}`);
                resultados.push({ ...jogo, golCasa: null, golFora: null, placar: null, mercados: [] });
                try {
                    await novaPg.evaluate(() => {
                        const btn = document.querySelector('.fixture-page-header__back-button');
                        if (btn) btn.click();
                    });
                    await delay(600);
                } catch(_) {}
            }
        }

        const comPlacar = resultados.filter(j => j.placar).length;
        const ex = resultados.slice(0,3).map(j=>`${j.horario} ${j.timeCasa}×${j.timeFora} (${j.placar||'?'})`);
        console.log(`   → ${resultados.length} jogos | ${comPlacar} com placar | ex: ${ex.join(' | ')}`);

        const jogosFormatados = resultados.map(j => {
            const placarOculto = j.golCasa === null || j.golFora === null || isNaN(j.golCasa) || isNaN(j.golFora);
            return {
                liga:      ligaNorm,
                horario:   j.horario,
                timeCasa:  normalizarNomeTime(j.timeCasa),
                timeFora:  normalizarNomeTime(j.timeFora),
                placar:    placarOculto ? 'OCULTO' : `${j.golCasa}-${j.golFora}`,
                golCasa:   placarOculto ? 0 : j.golCasa,
                golFora:   placarOculto ? 0 : j.golFora,
                resultado: placarOculto ? 'OCULTO'
                    : j.golCasa > j.golFora ? 'CASA'
                    : j.golFora > j.golCasa ? 'FORA' : 'EMPATE',
                mercados: (j.mercados || []).map(m => ({
                    mercado: normalizarNomeMercado(m.mercado),
                    selecao: normalizarNomeSelecao(m.selecao),
                    odd:     0,
                })),
                placarOculto,
            };
        });

        const salvos = await salvarResultados(ligaNorm, jogosFormatados, dataAlvo);
        console.log(`   💾 [${ligaNorm}] ${salvos} resultado(s) salvos`);
        return salvos;

    } catch(err) {
        console.error(`   ❌ [${ligaNorm}] Erro coletarViaExtra: ${err.message}`);
        return 0;
    } finally {
        if (novaPg) await novaPg.close().catch(() => {});
    }
}

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

// ── Salva resultados no banco ────────────────────────────────
async function salvarResultados(ligaNorm, resultados, dataAlvo) {
    const db = await getPool();
    let salvos = 0;

    for (const res of resultados) {
        try {
            // Monta data_partida: hora do jogo + data real do calendário.
            // extra.bet365 usa "sessão do dia": madrugada (00:00–05:59) aparece sob o dia anterior.
            // Jogos com hora < HORA_VIRADA_DIA pertencem ao dia seguinte no calendário.
            let dataPart = null;
            if (res.horario && /^\d{1,2}[.:]\d{2}$/.test(res.horario)) {
                const [h, m] = res.horario.replace('.', ':').split(':').map(Number);
                const [yyyy, mm, dd] = dataAlvo.split('-').map(Number);
                const diaOffset = h < HORA_VIRADA_DIA ? 1 : 0;
                dataPart = new Date(Date.UTC(yyyy, mm - 1, dd + diaOffset, h, m, 0, 0));
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

// ── Main ─────────────────────────────────────────────────────
async function run() {
    console.log('\n============================================');
    console.log('⏮️  COLETOR HISTÓRICO BET365 — extra.bet365.bet.br');
    console.log('============================================');
    // Calcula datas reais (considerando virada de dia da sessão extra)
    function _dataRealStr(dataStr, horaStr) {
        if (!horaStr) return dataStr;
        const [yyyy, mm, dd] = dataStr.split('-').map(Number);
        const h = parseInt(horaStr.split(':')[0]);
        if (h < HORA_VIRADA_DIA) {
            const d = new Date(Date.UTC(yyyy, mm-1, dd+1));
            return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
        }
        return dataStr;
    }
    const dataRealIni = _dataRealStr(DATA_ALVO, HORA_INI);
    const dataRealFim = _dataRealStr(DATA_ALVO, HORA_FIM);
    const avisoVirada = (dataRealIni !== DATA_ALVO || dataRealFim !== DATA_ALVO)
        ? ` ⚠️  madrugada → salvo como ${dataRealIni}` : '';

    console.log(`   📅 Data extra: ${DATA_ALVO}${avisoVirada}`);
    console.log(`   🕐 Hora ini:   ${HORA_INI || '(sem filtro)'}`);
    console.log(`   🕑 Hora fim:   ${HORA_FIM || '(sem filtro)'}`);
    console.log(`   🏆 Ligas:      ${LIGAS_FILTRO ? LIGAS_FILTRO.join(', ') : '(todas)'}`);
    console.log(`   🔌 Porta Edge: ${DEBUG_PORT}`);
    console.log('============================================\n');

    await getPool();

    // Modo limpeza: deleta jogos do backfill (odd=0, ativo=0) no período indicado
    if (LIMPAR_BACKFILL) {
        const [yyyy, mm, dd] = DATA_ALVO.split('-').map(Number);
        const [hIni, mIni] = (HORA_INI || '00:00').split(':').map(Number);
        const [hFim, mFim] = (HORA_FIM || '23:59').split(':').map(Number);
        const dtIni = new Date(Date.UTC(yyyy, mm-1, dd + (hIni < HORA_VIRADA_DIA ? 1 : 0), hIni, mIni, 0));
        const dtFim = new Date(Date.UTC(yyyy, mm-1, dd + (hFim < HORA_VIRADA_DIA ? 1 : 0), hFim, mFim, 59));
        const db = await getPool();
        const r = await db.request()
            .input('dtIni', sql.DateTime2, dtIni)
            .input('dtFim', sql.DateTime2, dtFim)
            .query(`
                DELETE FROM bet365_eventos
                WHERE start_time_datetime >= @dtIni
                  AND start_time_datetime <= @dtFim
                  AND ativo = 0
                  AND odd_casa = 0
                  AND odd_empate = 0
                  AND odd_fora = 0
            `);
        console.log(`🗑️  Deletados: ${r.rowsAffected[0]} evento(s) backfill (${DATA_ALVO} ${HORA_INI||'00:00'}–${HORA_FIM||'23:59'})`);
        process.exit(0);
    }

    const { browser } = await conectarEdge();

    // Ligas a processar (direto da constante LIGA_COMP_EXTRA)
    const todasLigas = Object.keys(LIGA_COMP_EXTRA);
    const ligasFiltradas = LIGAS_FILTRO
        ? todasLigas.filter(l => LIGAS_FILTRO.some(f => l.toLowerCase() === f.toLowerCase()))
        : todasLigas;

    console.log(`📋 ${ligasFiltradas.length} liga(s): ${ligasFiltradas.join(' | ')}\n`);

    let totalGeral = 0;
    for (const ligaNorm of ligasFiltradas) {
        try {
            const salvos = await coletarViaExtra(browser, ligaNorm, DATA_ALVO);
            totalGeral += salvos;
        } catch(e) {
            console.error(`   ❌ [${ligaNorm}] Erro: ${e.message}`);
        }
        await delay(2000);
    }

    console.log('\n============================================');
    console.log(`✅ Backfill concluído — ${totalGeral} resultado(s) salvos`);
    console.log('============================================');

    await browser.disconnect();
    process.exit(0);
}

run().catch(e => { console.error('❌ [Hist] Fatal:', e.message); process.exit(1); });
