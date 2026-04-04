/**
 * ============================================
 * UTILITÁRIOS BETANO - Funções compartilhadas
 * ============================================
 */

/**
 * Delay assíncrono
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry com backoff exponencial
 * @param {Function} fn - Função para executar
 * @param {Object} options - Configurações
 * @returns {Promise<any>}
 */
async function retryWithBackoff(fn, options = {}) {
    const {
        maxRetries = 3,
        baseDelay = 1000,
        maxDelay = 30000,
        backoffMultiplier = 2,
        onRetry = null
    } = options;

    let lastError;
    let attempt = 0;

    while (attempt <= maxRetries) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            attempt++;

            if (attempt > maxRetries) break;

            if (onRetry) {
                onRetry({ attempt, error, maxRetries });
            }

            const delayMs = Math.min(baseDelay * Math.pow(backoffMultiplier, attempt - 1), maxDelay);
            console.log(`   🔄 Tentativa ${attempt}/${maxRetries} falhou, aguardando ${delayMs}ms...`);
            await delay(delayMs);
        }
    }

    throw lastError;
}

/**
 * Normaliza nome de time para comparação
 * @param {string} nome - Nome do time
 * @returns {string} - Nome normalizado
 */
function normalizarNome(nome) {
    if (!nome) return '';
    return nome
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '')
        .trim();
}

/**
 * Compara dois nomes de time (aceita correspondência parcial)
 * @param {string} nome1 - Primeiro time
 * @param {string} nome2 - Segundo time
 * @returns {boolean}
 */
function compararTimes(nome1, nome2) {
    const n1 = normalizarNome(nome1);
    const n2 = normalizarNome(nome2);

    if (!n1 || !n2) return false;

    // Correspondência exata
    if (n1 === n2) return true;

    // Um contém o outro (mínimo 4 chars)
    if (n1.length >= 4 && n2.includes(n1)) return true;
    if (n2.length >= 4 && n1.includes(n2)) return true;

    // Similaridade (Levenshtein simplificado)
    if (Math.abs(n1.length - n2.length) <= 2) {
        let diffs = 0;
        for (let i = 0; i < Math.max(n1.length, n2.length); i++) {
            if (n1[i] !== n2[i]) diffs++;
        }
        if (diffs <= 2) return true;
    }

    return false;
}

/**
 * Formata número com casas decimais
 * @param {number} valor - Valor a formatar
 * @param {number} casas - Casas decimais
 * @returns {string}
 */
function formatarNumero(valor, casas = 2) {
    if (valor === null || valor === undefined || isNaN(valor)) return '0';
    return valor.toFixed(casas);
}

/**
 * Formata porcentagem
 * @param {number} valor - Valor a formatar
 * @param {number} casas - Casas decimais
 * @returns {string}
 */
function formatarPorcentagem(valor, casas = 1) {
    return formatarNumero(valor, casas) + '%';
}

/**
 * Calcula probabilidade implícita de uma odd
 * @param {number} odd - Odd decimal
 * @returns {number} - Probabilidade em porcentagem
 */
function oddParaProbabilidade(odd) {
    if (!odd || odd <= 0) return 0;
    return (1 / odd) * 100;
}

/**
 * Calcula margem da casa de apostas
 * @param {number} oddCasa - Odd casa
 * @param {number} oddEmpate - Odd empate
 * @param {number} oddFora - Odd fora
 * @returns {number} - Margem em porcentagem
 */
function calcularMargem(oddCasa, oddEmpate, oddFora) {
    if (!oddCasa || !oddEmpate || !oddFora) return 0;
    const probCasa = oddParaProbabilidade(oddCasa);
    const probEmpate = oddParaProbabilidade(oddEmpate);
    const probFora = oddParaProbabilidade(oddFora);
    return probCasa + probEmpate + probFora - 100;
}

/**
 * Detecta tendência de odds
 * @param {number} oddAntiga - Odd anterior
 * @param {number} oddNova - Odd atual
 * @returns {'subindo'|'caindo'|'estavel'}
 */
function detectarTendenciaOdd(oddAntiga, oddNova) {
    if (!oddAntiga || !oddNova) return 'estavel';
    const diff = oddNova - oddAntiga;
    if (diff > 0.05) return 'subindo';
    if (diff < -0.05) return 'caindo';
    return 'estavel';
}

/**
 * Calcula valor esperado de uma aposta
 * @param {number} odd - Odd atual
 * @param {number} probabilidadeReal - Probabilidade estimada real (%)
 * @returns {number} - Valor esperado (%)
 */
function calcularValorEsperado(odd, probabilidadeReal) {
    if (!odd || !probabilidadeReal) return 0;
    const probabilidadeImplicita = oddParaProbabilidade(odd);
    return probabilidadeReal - probabilidadeImplicita;
}

/**
 * Gera hash único para evento
 * @param {string} timeCasa - Nome do time da casa
 * @param {string} timeFora - Nome do time de fora
 * @param {Date} data - Data do evento
 * @returns {string}
 */
function gerarHashEvento(timeCasa, timeFora, data) {
    const str = `${normalizarNome(timeCasa)}|${normalizarNome(timeFora)}|${data?.toISOString()?.slice(0, 10) || 'unknown'}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
}

/**
 * Parse de string de placar "X - Y" para objeto
 * @param {string} placarStr - String do placar
 * @returns {{golCasa: number, golFora: number}}
 */
function parsePlacar(placarStr) {
    if (!placarStr) return { golCasa: 0, golFora: 0 };

    const match = placarStr.trim().match(/^(\d+)\s*[-–:]\s*(\d+)$/);
    if (!match) return { golCasa: 0, golFora: 0 };

    return {
        golCasa: parseInt(match[1]) || 0,
        golFora: parseInt(match[2]) || 0
    };
}

/**
 * Verifica se liga é de futebol virtual
 * @param {string} liga - Nome da liga
 * @returns {boolean}
 */
function isFutebolVirtual(liga) {
    if (!liga) return false;

    const l = liga.toLowerCase();

    // Lista de esportes não-futebol
    const naoFutebol = [
        'nba', 'nfl', 'basketball', 'bowling', 'greyhound',
        'tennis', 'baseball', 'cricket', 'rugby', 'golf',
        'volleyball', 'handball', 'boxing', 'mma', 'ufc',
        'esports', 'lol', 'csgo', 'dota', 'valorant'
    ];

    // Excluir não-futebol
    if (naoFutebol.some(esporte => l.includes(esporte))) {
        return false;
    }

    // Futebol virtual geralmente tem "futebol" ou nomes de ligas conhecidas
    const futebolIndicators = [
        'futebol', 'football', 'soccer', 'brasileirão', 'liga',
        'copa', 'champions', 'premier', 'bundesliga', 'serie a',
        'la liga', 'ligue 1', 'euro', 'copa america'
    ];

    return futebolIndicators.some(ind => l.includes(ind));
}

/**
 * Timeout para promessas
 * @param {Promise} promise - Promise para executar
 * @param {number} ms - Timeout em milissegundos
 * @param {string} message - Mensagem de erro
 * @returns {Promise<any>}
 */
async function promiseTimeout(promise, ms, message = 'Timeout') {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timeoutId);
    }
}

module.exports = {
    delay,
    retryWithBackoff,
    normalizarNome,
    compararTimes,
    formatarNumero,
    formatarPorcentagem,
    oddParaProbabilidade,
    calcularMargem,
    detectarTendenciaOdd,
    calcularValorEsperado,
    gerarHashEvento,
    parsePlacar,
    isFutebolVirtual,
    promiseTimeout
};
