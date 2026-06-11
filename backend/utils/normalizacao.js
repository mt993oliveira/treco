/**
 * Fonte única de verdade para normalização EN→PT de nomes de times,
 * mercados, seleções e ligas usados em bet365_resultados_mercados.
 *
 * Usado por: bet365-coletor.js, bet365-coletor-historico.js, bet365-api.js
 */

// ── Times ─────────────────────────────────────────────────────────────────
// Chaves em Title Case (como aparecem no banco/Bet365) — export para SQL batch
const TIMES_EN_PT = {
    'Albania':'Albânia','Australia':'Austrália','Austria':'Áustria',
    'Belgium':'Bélgica','Brazil':'Brasil','Cameroon':'Camarões',
    'Canada':'Canadá','Croatia':'Croácia','Czechia':'República Tcheca',
    'Czech Republic':'República Tcheca','Denmark':'Dinamarca',
    'Ecuador':'Equador','England':'Inglaterra','France':'França',
    'Georgia':'Geórgia','Germany':'Alemanha','Ghana':'Gana',
    'Hungary':'Hungria','Iran':'Irã','Italy':'Itália','Japan':'Japão',
    'Mexico':'México','Morocco':'Marrocos','Netherlands':'Países Baixos',
    'Poland':'Polônia','Romania':'Romênia','Scotland':'Escócia',
    'Senegal':'Senegal','Serbia':'Sérvia','Slovakia':'Eslováquia',
    'Slovenia':'Eslovênia','South Korea':'Coreia do Sul','Spain':'Espanha',
    'Switzerland':'Suíça','Tunisia':'Tunísia','Turkey':'Turquia',
    'Ukraine':'Ucrânia','Uruguay':'Uruguai','USA':'EUA','Wales':'País de Gales',
};

// Índice lowercase para lookup em runtime (O(1))
const TIMES_LOWER = Object.fromEntries(
    Object.entries(TIMES_EN_PT).map(([k, v]) => [k.toLowerCase(), v])
);

function normalizarTime(nome) {
    if (!nome) return nome;
    return TIMES_LOWER[nome.toLowerCase().trim()] || nome;
}

// ── Ligas ─────────────────────────────────────────────────────────────────
const LIGA_NORMALIZAR = {
    'copa do mundo':               'World Cup',
    'world cup':                   'World Cup',
    'world cup virtual':           'World Cup',
    'euro cup':                    'Euro Cup',
    'premiership':                 'Premiership',
    'premier league':              'Premiership',
    'english premier league':      'Premiership',
    'express cup':                 'Express Cup',
    'south american super league': 'Super Liga Sul-Americana',
    'super liga sul-americana':    'Super Liga Sul-Americana',
};

function normalizarLiga(nome) {
    return LIGA_NORMALIZAR[(nome || '').toLowerCase().trim()] || nome;
}

// ── Mercados ──────────────────────────────────────────────────────────────
// Chaves em lowercase; valores em português canônico
const MERCADOS_EN_PT = {
    // Resultado Final
    'fulltime result':                    'Resultado Final',
    'full time result':                   'Resultado Final',
    'match result':                       'Resultado Final',
    '1x2':                               'Resultado Final',
    // Resultado Correto
    'correct score':                      'Resultado Correto',
    'correct score ft':                   'Resultado Correto',
    // Resultado Correto - Intervalo
    'correct score ht':                   'Resultado Correto - Intervalo',
    'half time correct score':            'Resultado Correto - Intervalo',
    'half-time correct score':            'Resultado Correto - Intervalo',
    'halftime correct score':             'Resultado Correto - Intervalo',
    'correct score - half time':          'Resultado Correto - Intervalo',
    'half-time correct score (ht)':       'Resultado Correto - Intervalo',
    // Intervalo Resultado
    'half time result':                   'Resultado Intervalo',
    'halftime result':                    'Resultado Intervalo',
    'ht result':                          'Resultado Intervalo',
    '1x2 ht':                            'Resultado Intervalo',
    // Intervalo/Final
    'half time/full time':                'Intervalo/Final',
    'half-time/full-time':                'Intervalo/Final',
    'ht/ft':                              'Intervalo/Final',
    '1st half/full time':                 'Intervalo/Final',
    'first half/full time':               'Intervalo/Final',
    // Ambos Marcam
    'both teams to score':                'Ambos Marcam',
    'btts':                               'Ambos Marcam',
    'both teams to score (ht)':           'Ambos Marcam - Intervalo',
    // Total de Gols
    'total goals':                        'Total de Gols',
    'goals over/under':                   'Total de Gols',
    'over/under':                         'Total de Gols',
    // Gols por Time
    'team goals':                         'Gols por Time',
    // Chance Dupla
    'double chance':                      'Chance Dupla',
    // Handicaps
    'asian handicap':                     'Handicap Asiático',
    'asian handicap ft':                  'Handicap Asiático',
    'european handicap':                  'Handicap Europeu',
    'handicap':                           'Handicap Europeu',
    // Ambos Marcam e Resultado
    'both teams to score & win':          'Ambos Marcam e Resultado',
    'btts & win':                         'Ambos Marcam e Resultado',
    'btts and win':                       'Ambos Marcam e Resultado',
    // Marcadores
    'first goalscorer':                   'Marcador do Primeiro Gol',
    'first goal scorer':                  'Marcador do Primeiro Gol',
    'anytime goalscorer':                 'Marcador a Qualquer Hora',
    'anytime scorer':                     'Marcador a Qualquer Hora',
    'to score anytime':                   'Marcador a Qualquer Hora',
    'last goalscorer':                    'Último Marcador de Gol',
    'player to score':                    'Marcador de Gol',
    // Outros
    'first team to score':                'Primeira Equipe a Marcar',
    'home team to score':                 'Para o Time da Casa Marcar',
    'away team to score':                 'Para o Time Visitante Marcar',
    'winning margin':                     'Margem de Vitória',
    'result / both teams to score':       'Resultado/Ambos Marcam',
    'result/both teams to score':         'Resultado/Ambos Marcam',
    'exact total goals':                  'Total Exato de Gols',
    'next goal':                          'Próximo Gol',
    'next goal scorer':                   'Próximo Gol',
    'clean sheet':                        'Sem Sofrer Gol',
    'to keep a clean sheet':              'Sem Sofrer Gol',
    'draw no bet':                        'Resultado Sem Empate',
    'win to nil':                         'Vencer Sem Sofrer Gol',
    'to win to nil':                      'Vencer Sem Sofrer Gol',
    'match corners':                      'Escanteios',
    'total corners':                      'Escanteios',
    'corners over/under':                 'Escanteios',
    'booking points':                     'Cartões',
    'cards':                              'Cartões',
    'match cards':                        'Cartões',
    'scorecast':                          'Scorecast',
};

function normalizarMercado(nome) {
    if (!nome) return nome;
    const low = nome.toLowerCase().trim();
    if (MERCADOS_EN_PT[low]) return MERCADOS_EN_PT[low];
    // "Total Goals Over/Under X.5" → "Total de Gols - Mais de/Menos de X.5"
    const m = low.match(/^total goals over\/under (\d+\.\d)$/);
    if (m) return `Total de Gols - Mais de/Menos de ${m[1]}`;
    return nome;
}

// ── Seleções ──────────────────────────────────────────────────────────────
const SELECOES_SIMPLES = {
    'yes': 'Sim',
    'no': 'Não',
    'any other score': 'Qualquer Outro Resultado',
    'any unquoted': 'Qualquer Outro Resultado',
    'any other': 'Qualquer Outro Resultado',
    'no goals (0-0)': 'Sem Gols (0-0)',
    'draw 0-0': 'Empate 0-0',
    'home': 'Casa',
    'home win': 'Casa',
    'away': 'Fora',
    'away win': 'Fora',
    'draw': 'Empate',
    'the draw': 'Empate',
};

function normalizarSelecao(sel) {
    if (!sel) return sel;
    const low = sel.toLowerCase().trim();
    if (SELECOES_SIMPLES[low]) return SELECOES_SIMPLES[low];
    // Over X.5 → Mais de X.5 / Under X.5 → Menos de X.5
    const m1 = low.match(/^over (\d+(?:\.\d)?)$/);  if (m1) return `Mais de ${m1[1]}`;
    const m2 = low.match(/^under (\d+(?:\.\d)?)$/); if (m2) return `Menos de ${m2[1]}`;
    // "Team - N Goal(s) / N+ Goals" → normaliza time + Goals→Gols
    if (/\bgoals?\s*$/i.test(sel)) {
        const norm = sel.replace(/\bGoals\b/gi, 'Gols').replace(/\bGoal\b/gi, 'Gol');
        const dash = norm.indexOf(' - ');
        if (dash > 0) return normalizarTime(norm.substring(0, dash)) + norm.substring(dash);
        return norm;
    }
    return sel;
}

module.exports = {
    TIMES_EN_PT,
    MERCADOS_EN_PT,
    SELECOES_SIMPLES,
    LIGA_NORMALIZAR,
    normalizarTime,
    normalizarLiga,
    normalizarMercado,
    normalizarSelecao,
};
