/**
 * DEBUG: Captura o fluxo de navegação entre ligas no Bet365 virtual football.
 * Conecta ao Edge (porta 9223), percorre cada aba de liga e salva:
 *   - HTML completo da aba
 *   - Seletores encontrados (timeBtns, pods, botões de horário)
 *   - Estado antes e depois do clique
 *
 * Uso: node backend/services/bet365-debug-nav.js
 * Resultado: debug-nav-LIGA.html (um arquivo por liga)
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const http = require('http');
const fs = require('fs');
puppeteer.use(StealthPlugin());

const DEBUG_PORT = parseInt(process.env.BET365_ODDS_DEBUG_PORT) || 9223;
const DELAY_MS   = 3000; // ms após cada clique para aguardar carregamento

async function conectar() {
    const wsUrl = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${DEBUG_PORT}/json/version`, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d).webSocketDebuggerUrl); } catch(e) { reject(e); } });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    });
    const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null });
    const pages = await browser.pages();
    const pg = pages.find(p => { try { return p.url().includes('bet365'); } catch(_) { return false; } });
    if (!pg) throw new Error('Aba bet365 não encontrada em porta ' + DEBUG_PORT);
    console.log(`✅ Conectado: ${pg.url().substring(0, 70)}`);
    return { browser, pg };
}

async function capturarEstado(pg, label) {
    return await pg.evaluate((lbl) => {
        const timeBtns = [...document.querySelectorAll('.vr-EventTimesNavBarButton')]
            .map(b => b.querySelector('.vr-EventTimesNavBarButton_Text')?.textContent.trim() || b.textContent.trim());
        const pods = [...document.querySelectorAll('.gl-MarketGroupPod.gl-MarketGroup')]
            .map(p => p.querySelector('.gl-MarketGroupButton_Text')?.textContent.trim() || '?');
        const participantes = [...document.querySelectorAll('.srb-ParticipantStackedBorderless_Name')]
            .slice(0, 4).map(e => e.textContent.trim());
        const raceOff = !!document.querySelector('.svc-MarketGroup_RaceOff');
        const ligasDisponiveis = [...document.querySelectorAll('.vrl-MeetingsHeaderButton_Title')]
            .map(e => e.textContent.trim());
        const ligaAtiva = (() => {
            const btns = [...document.querySelectorAll('.vrl-MeetingsHeaderButton')];
            const active = btns.find(b => [...b.classList].some(c =>
                c.toLowerCase().includes('select') || c.toLowerCase().includes('active') || c.toLowerCase().includes('current')
            ));
            return active?.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim() || '?';
        })();
        // Coleta TODOS os seletores únicos presentes na página para análise
        const classesNavBtns = [...new Set(
            [...document.querySelectorAll('[class*="NavBar"],[class*="TimeBtn"],[class*="TimesNav"],[class*="MeetingsHeader"]')]
                .map(e => [...e.classList].join(' ')).filter(Boolean)
        )].slice(0, 15);

        return { label: lbl, timeBtns, pods, participantes, raceOff, ligasDisponiveis, ligaAtiva, classesNavBtns };
    }, label);
}

async function run() {
    const { browser, pg } = await conectar();

    // Estado inicial
    const inicial = await capturarEstado(pg, 'INICIAL (antes de qualquer click)');
    console.log('\n--- ESTADO INICIAL ---');
    console.log(JSON.stringify(inicial, null, 2));

    // Ligas disponíveis
    const ligas = await pg.evaluate(() =>
        [...document.querySelectorAll('.vrl-MeetingsHeaderButton')]
            .map(el => el.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim() || '')
            .filter(Boolean)
    );
    console.log(`\nLigas encontradas: ${ligas.join(' | ')}`);

    const resultados = [];

    for (const liga of ligas) {
        console.log(`\n► Clicando em: ${liga}`);

        // Estado ANTES do clique
        const antes = await capturarEstado(pg, `${liga} — ANTES do clique`);

        // Clica na aba
        const clicou = await pg.evaluate((nome) => {
            const tabs = document.querySelectorAll('.vrl-MeetingsHeaderButton');
            for (const tab of tabs) {
                if (tab.querySelector('.vrl-MeetingsHeaderButton_Title')?.textContent.trim() === nome) {
                    tab.click(); return true;
                }
            }
            return false;
        }, liga);

        console.log(`  Clique: ${clicou ? '✅' : '❌'}`);

        // Aguarda 3s para carregar
        await new Promise(r => setTimeout(r, DELAY_MS));

        // Estado DEPOIS do clique
        const depois = await capturarEstado(pg, `${liga} — DEPOIS (${DELAY_MS}ms)`);

        console.log(`  ligaAtiva: ${depois.ligaAtiva}`);
        console.log(`  timeBtns (${depois.timeBtns.length}): ${depois.timeBtns.join(' | ') || '(nenhum)'}`);
        console.log(`  pods (${depois.pods.length}): ${depois.pods.join(' | ') || '(nenhum)'}`);
        console.log(`  participantes: ${depois.participantes.join(' × ') || '(nenhum)'}`);

        // Salva HTML completo desta liga
        const html = await pg.content();
        const filename = `C:/PRODUCAO/debug-nav-${liga.replace(/[^a-zA-Z0-9]/g, '_')}.html`;
        fs.writeFileSync(filename, html, 'utf8');
        console.log(`  HTML salvo: ${filename}`);

        resultados.push({ liga, clicou, antes, depois });
    }

    // Relatório final
    console.log('\n\n=== RELATÓRIO FINAL ===');
    for (const r of resultados) {
        const ok = r.depois.timeBtns.length > 0 || r.depois.pods.length > 0;
        console.log(`${ok ? '✅' : '❌'} ${r.liga}: timeBtns=${r.depois.timeBtns.length} pods=${r.depois.pods.length} ligaAtiva="${r.depois.ligaAtiva}"`);
    }

    // Salva relatório JSON
    fs.writeFileSync('C:/PRODUCAO/debug-nav-relatorio.json', JSON.stringify(resultados, null, 2), 'utf8');
    console.log('\nRelatório JSON: C:/PRODUCAO/debug-nav-relatorio.json');

    await browser.disconnect();
}

run().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
