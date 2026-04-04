/**
 * Teste rápido do coletor Bet365
 * Abre a página, extrai os dados e mostra no console SEM salvar no banco
 * Uso: node testar-bet365.js
 */

require('dotenv').config();

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const URL = 'https://www.bet365.bet.br/#/AVR/B146/R%5E1/';

(async () => {
    console.log('============================================');
    console.log('  TESTE BET365 - FUTEBOL VIRTUAL');
    console.log('============================================\n');

    let browser;
    try {
        console.log('🌐 Abrindo navegador headless...');
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', '--disable-gpu',
                '--window-size=1366,768',
                '--disable-blink-features=AutomationControlled',
                '--lang=pt-BR,pt'
            ],
            defaultViewport: { width: 1366, height: 768 }
        });

        const page = await browser.newPage();
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        );
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' });

        await page.setRequestInterception(true);
        page.on('request', req => {
            if (['image', 'media', 'font'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        console.log(`📡 Navegando para: ${URL}`);
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

        // Aguarda conteúdo
        console.log('⏳ Aguardando página renderizar (até 30s)...');
        let carregou = false;
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 1500));
            carregou = await page.evaluate(() => {
                const txt = document.body.innerText || '';
                return /\d{1,2}\.\d{2}/.test(txt) && txt.length > 300;
            }).catch(() => false);
            if (carregou) { console.log('✅ Conteúdo detectado!\n'); break; }
            process.stdout.write('.');
        }
        if (!carregou) console.log('\n⚠️  Conteúdo não detectado — mostrando o que tem\n');

        // Extrai TUDO da página
        const dados = await page.evaluate(() => {
            const linhas = (document.body.innerText || '')
                .split('\n').map(l => l.trim()).filter(l => l.length > 0);

            function isOdd(t) {
                t = (t || '').trim();
                const n = parseFloat(t);
                return /^\d{1,2}\.\d{2}$/.test(t) && n >= 1.01 && n <= 99;
            }
            function isCountdown(t) {
                t = (t || '').trim();
                if (!/^\d{1,2}:\d{2}$/.test(t)) return false;
                const [m, s] = t.split(':').map(Number);
                return s < 60 && m < 99;
            }
            function isScore(t) {
                return /^\d{1,2}\s*[-–]\s*\d{1,2}$/.test((t || '').trim());
            }
            function skip(t) {
                const s = (t || '').toLowerCase().trim();
                if (s.length < 2 || isOdd(t) || isCountdown(t) || isScore(t)) return true;
                if (/^\d+$/.test(s)) return true;
                const palavras = ['bet365','login','depositar','saque','futebol','virtual',
                    'esportes','sports','ao vivo','resultado','odds','apostas','home',
                    'mais','more','1','x','2'];
                return palavras.includes(s);
            }

            const proximos = [];
            const resultados = [];
            const processados = new Set();

            for (let i = 0; i < linhas.length - 5; i++) {
                if (!skip(linhas[i]) && isCountdown(linhas[i+1]) &&
                    isOdd(linhas[i+2]) && isOdd(linhas[i+3]) && isOdd(linhas[i+4]) &&
                    !skip(linhas[i+5])) {
                    const k = `${linhas[i]}|${linhas[i+5]}`;
                    if (!processados.has(k)) {
                        processados.add(k);
                        proximos.push({
                            timeCasa: linhas[i], timeFora: linhas[i+5],
                            countdown: linhas[i+1],
                            oddCasa: parseFloat(linhas[i+2]),
                            oddEmpate: parseFloat(linhas[i+3]),
                            oddFora: parseFloat(linhas[i+4])
                        });
                    }
                }
                if (isCountdown(linhas[i]) && !skip(linhas[i+1]) &&
                    isOdd(linhas[i+2]) && isOdd(linhas[i+3]) && isOdd(linhas[i+4]) &&
                    !skip(linhas[i+5])) {
                    const k = `${linhas[i+1]}|${linhas[i+5]}`;
                    if (!processados.has(k)) {
                        processados.add(k);
                        proximos.push({
                            timeCasa: linhas[i+1], timeFora: linhas[i+5],
                            countdown: linhas[i],
                            oddCasa: parseFloat(linhas[i+2]),
                            oddEmpate: parseFloat(linhas[i+3]),
                            oddFora: parseFloat(linhas[i+4])
                        });
                    }
                }
            }

            const rp = new Set();
            for (let i = 0; i < linhas.length - 2; i++) {
                let t1, sc, t2;
                if (!skip(linhas[i]) && isScore(linhas[i+1]) && !skip(linhas[i+2])) {
                    [t1, sc, t2] = [linhas[i], linhas[i+1], linhas[i+2]];
                } else if (/^\d{2}:\d{2}$/.test(linhas[i]) && !skip(linhas[i+1]) && isScore(linhas[i+2]) && !skip(linhas[i+3])) {
                    [t1, sc, t2] = [linhas[i+1], linhas[i+2], linhas[i+3]];
                }
                if (t1 && sc && t2) {
                    const k = `${t1}|${sc}|${t2}`;
                    if (!rp.has(k)) {
                        rp.add(k);
                        const p = sc.split(/[-–]/).map(x => parseInt(x)||0);
                        resultados.push({ timeCasa: t1, placar: sc, timeFora: t2,
                            golCasa: p[0]||0, golFora: p[1]||0 });
                    }
                }
            }

            return {
                totalLinhas: linhas.length,
                primeiras50Linhas: linhas.slice(0, 50),
                proximos,
                resultados
            };
        });

        // ── Mostrar resultados ────────────────────────────────────
        console.log('============================================');
        console.log(`📄 Total de linhas de texto na página: ${dados.totalLinhas}`);
        console.log('============================================\n');

        console.log('📝 PRIMEIRAS 50 LINHAS DA PÁGINA (para identificar ligas):');
        console.log('--------------------------------------------');
        dados.primeiras50Linhas.forEach((l, i) => console.log(`  ${String(i+1).padStart(2)}: ${l}`));
        console.log('');

        if (dados.proximos.length > 0) {
            console.log(`⚽ PRÓXIMOS JOGOS (${dados.proximos.length} encontrados):`);
            console.log('--------------------------------------------');
            dados.proximos.forEach(j =>
                console.log(`  ⏰ ${j.countdown.padEnd(6)} | ${j.timeCasa.padEnd(20)} x ${j.timeFora.padEnd(20)} | ${j.oddCasa} / ${j.oddEmpate} / ${j.oddFora}`)
            );
            console.log('');
        } else {
            console.log('⚠️  Nenhum jogo próximo detectado\n');
        }

        if (dados.resultados.length > 0) {
            console.log(`📋 RESULTADOS (${dados.resultados.length} encontrados):`);
            console.log('--------------------------------------------');
            dados.resultados.forEach(r =>
                console.log(`  ${r.timeCasa.padEnd(20)} ${r.golCasa} - ${r.golFora}  ${r.timeFora}`)
            );
            console.log('');
        }

        console.log('============================================');
        console.log(dados.proximos.length > 0 || dados.resultados.length > 0
            ? '✅ PÁGINA FUNCIONANDO - Coletor vai operar normalmente'
            : '⚠️  Página carregou mas sem dados estruturados\n   → Verifique as "50 linhas" acima para entender o layout');
        console.log('============================================');

    } catch (err) {
        console.error('❌ Erro:', err.message);
    } finally {
        if (browser) await browser.close();
    }
})();
