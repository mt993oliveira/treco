/**
 * Teste Bet365 - Conecta no Edge JÁ ABERTO pelo usuário
 *
 * COMO USAR:
 *   1. Feche o Edge completamente
 *   2. Clique duas vezes em: abrir-edge-debug.bat
 *   3. No Edge que abrir, acesse: https://www.bet365.bet.br/#/AVR/B146/R%5E1/
 *   4. Aguarde a página carregar com as ligas visíveis
 *   5. Rode: node testar-bet365.js
 */

require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const http = require('http');

const DEBUG_PORT = 9222;
const URL_SOCCER = 'https://www.bet365.bet.br/#/AVR/B146/R%5E1/';

function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
        }).on('error', reject);
    });
}

(async () => {
    console.log('============================================');
    console.log('  TESTE BET365 - SEU EDGE JÁ ABERTO');
    console.log('============================================\n');

    let browser;
    try {
        // ── 1. Verifica se Edge está rodando em debug mode ──
        console.log(`🔍 Procurando Edge na porta ${DEBUG_PORT}...`);
        let version;
        try {
            version = await httpGet(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
            console.log(`✅ Edge encontrado: ${version.Browser}\n`);
        } catch(e) {
            console.log('❌ Edge não está rodando com debug habilitado!\n');
            console.log('📋 PASSOS:');
            console.log('   1. Feche o Edge completamente (todos os processos)');
            console.log('   2. Clique duas vezes em: abrir-edge-debug.bat');
            console.log(`   3. Acesse no Edge: ${URL_SOCCER}`);
            console.log('   4. Rode novamente: node testar-bet365.js\n');
            return;
        }

        // ── 2. Conecta ao Edge sem abrir novo browser ──
        browser = await puppeteer.connect({
            browserWSEndpoint: version.webSocketDebuggerUrl,
            defaultViewport: null
        });
        console.log('✅ Conectado ao Edge do usuário!\n');

        // ── 3. Encontra a aba da Bet365 ──
        const pages = await browser.pages();
        console.log(`📋 ${pages.length} aba(s) aberta(s):`);
        for (const p of pages) {
            const u = p.url();
            console.log(`   ${u.substring(0, 80)}`);
        }

        let pgBet = pages.find(p => p.url().includes('bet365') && p.url().includes('AVR'));
        if (!pgBet) pgBet = pages.find(p => p.url().includes('bet365'));

        if (!pgBet) {
            console.log(`\n⚠️  Nenhuma aba da Bet365 encontrada.`);
            console.log(`   Abra no Edge: ${URL_SOCCER}`);
            console.log('   E rode novamente: node testar-bet365.js');
            return;
        }

        console.log(`\n✅ Aba Bet365: ${pgBet.url()}`);

        // Navega para o soccer se necessário
        if (!pgBet.url().includes('B146')) {
            console.log('   Navegando para Futebol Virtual...');
            await pgBet.goto(URL_SOCCER, { waitUntil: 'load', timeout: 60000 });
            await _delay(8000);
        }

        // ── 4. Aguarda ligas ──
        console.log('\n⏳ Aguardando ligas...');
        let ligas = [];
        try {
            await pgBet.waitForSelector('.vrl-MeetingsHeaderButton', { timeout: 30000 });
            ligas = await pgBet.evaluate(() =>
                [...document.querySelectorAll('.vrl-MeetingsHeaderButton')].map((el, idx) => {
                    const t = el.querySelector('.vrl-MeetingsHeaderButton_Title');
                    return { idx, nome: t ? t.textContent.trim() : `Liga${idx}` };
                })
            );
            console.log(`✅ ${ligas.length} liga(s): ${ligas.map(l => l.nome).join(' | ')}\n`);
        } catch(e) {
            const diag = await pgBet.evaluate(() => ({
                url: window.location.href,
                txt: (document.body?.innerText || '').substring(0, 400)
            })).catch(() => ({}));
            console.log('❌ Ligas não apareceram na aba');
            console.log(`   URL: ${diag.url}`);
            console.log(`   Conteúdo: ${(diag.txt||'').replace(/\n/g,' | ')}`);
            return;
        }

        // ── 5. Coleta todas as ligas ──
        const IGNORAR = ['express cup'];
        for (const liga of ligas) {
            if (IGNORAR.some(ig => liga.nome.toLowerCase().includes(ig))) continue;

            console.log(`─────────────────────────────────────`);
            console.log(`🏆 ${liga.nome}`);

            await pgBet.evaluate((idx) => {
                document.querySelectorAll('.vrl-MeetingsHeaderButton')[idx]?.click();
            }, liga.idx);
            await _delay(1500);

            // Resultados
            const temRes = await pgBet.evaluate(() => !!document.querySelector('.vr-ResultsNavBarButton'));
            if (temRes) {
                await pgBet.evaluate(() => document.querySelector('.vr-ResultsNavBarButton')?.click());
                await _delay(2000);
                await pgBet.evaluate(() => document.querySelector('.vrr-ShowMoreButton_Link')?.click());
                await _delay(800);
                const res = await pgBet.evaluate(() =>
                    [...document.querySelectorAll('.vrr-HeadToHeadMarketGroup')].slice(0,5).map(g => {
                        const t1 = g.querySelector('.vrr-HTHTeamDetails_TeamOne')?.textContent.trim()||'?';
                        const sc = g.querySelector('.vrr-HTHTeamDetails_Score')?.textContent.trim().replace(/\s+/g,'')||'?';
                        const t2 = g.querySelector('.vrr-HTHTeamDetails_TeamTwo')?.textContent.trim()||'?';
                        return `${t1} ${sc} ${t2}`;
                    })
                );
                console.log(res.length > 0 ? `   📋 ${res.join(' | ')}` : '   📋 Sem resultados');
                await pgBet.evaluate((idx) => document.querySelectorAll('.vrl-MeetingsHeaderButton')[idx]?.click(), liga.idx);
                await _delay(1500);
            }

            // Próximos jogos
            const numH = await pgBet.evaluate(() =>
                document.querySelectorAll('.vr-EventTimesNavBarButton').length
            );
            console.log(`   ⏰ ${numH} horário(s)`);

            for (let i = 0; i < Math.min(numH, 3); i++) {
                await pgBet.evaluate((i) => document.querySelectorAll('.vr-EventTimesNavBarButton')[i]?.click(), i);
                await _delay(1500);
                let temMkt = false;
                for (let t = 0; t < 10; t++) {
                    temMkt = await pgBet.evaluate(() =>
                        document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup').length > 0
                    ).catch(() => false);
                    if (temMkt) break;
                    await _delay(500);
                }
                if (!temMkt) continue;

                const j = await pgBet.evaluate(() => {
                    const h = document.querySelector('.vr-EventTimesNavBarButton-selected .vr-EventTimesNavBarButton_Text')?.textContent.trim()||'?';
                    const ftPod = [...document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup')]
                        .find(p => /Fulltime Result|Resultado Final/i.test(p.querySelector('.gl-MarketGroupButton_Text')?.textContent));
                    const nomes = ftPod ? [...ftPod.querySelectorAll('.srb-ParticipantStackedBorderless_Name')]
                        .map(n => n.textContent.trim()).filter(t => t && !/draw|empate/i.test(t)) : [];
                    const odds = ftPod ? [...ftPod.querySelectorAll('.srb-ParticipantStackedBorderless_Odds')]
                        .map(o => parseFloat(o.textContent.trim())||0) : [];
                    const cd = document.querySelector('.svc-MarketGroup_BookCloses span:last-child')?.textContent.trim()||'?';
                    const nm = document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup').length;
                    return { h, tc: nomes[0]||'?', tf: nomes[1]||'?', oc: odds[0]||0, oe: odds[1]||0, of_: odds[2]||0, cd, nm };
                });
                console.log(`   ⚽ ${j.tc} x ${j.tf} [${j.h}] | ${j.oc}/${j.oe}/${j.of_} | fecha: ${j.cd} | ${j.nm} mercados`);
            }
        }

        console.log('\n============================================');
        console.log('✅ COLETA CONCLUÍDA!');
        console.log('============================================');

    } catch(err) {
        console.error('\n❌ ERRO:', err.message);
    } finally {
        if (browser) {
            browser.disconnect(); // desconecta mas NÃO fecha o Edge
            console.log('\n🔌 Desconectado (seu Edge continua aberto normalmente)');
        }
    }
})();
