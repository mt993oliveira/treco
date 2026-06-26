const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

// Map de sessões ativas: userId -> { id, usuario, nome, tipo, lastSeen, loginTime, ip, userAgent, token }
const activeSessions = new Map();
const forcedLogouts  = new Set(); // IDs desconectados pelo admin — próximo ping força logout

// Blacklist de IPs bloqueados permanentemente (scraping, abuso, ataques)
// Gerenciado via UI: Diagnóstico → Blacklist Permanente
// Persistido na tabela ip_blacklist — sobrevive restart do PM2
const _ipBlacklist = new Set();
async function _blacklistCarregarDB() {
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        const r = await sql.query`SELECT ip FROM ip_blacklist`;
        r.recordset.forEach(row => _ipBlacklist.add(row.ip));
        if (_ipBlacklist.size) console.log(`🚫 [Blacklist] ${_ipBlacklist.size} IP(s) carregados do banco`);
    } catch(e) { console.error('[Blacklist] Erro ao carregar:', e.message); }
}
const loginHistory  = new Map(); // String(userId) -> { countToday, lastLoginDate }
const loginFailures = new Map(); // username_lower -> [{ ip, ts }]
const _geoCache     = new Map(); // ip -> { city, region, country, org, cachedAt }
const _loginBlocklist = new Map(); // ip -> { blockedUntil } — IPs bloqueados por brute force
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const hpp = require('hpp');
const app = express();
app.set('trust proxy', 1); // lê X-Forwarded-For do Nginx corretamente

// ✅ CONFIGURAÇÃO CORRETA DO CORS (substitua tudo que tem antes)
app.use(cors({
    origin: [
        'https://www.controlfinance.com.br',
		'http://www.controlfinance.com.br',
		'https://controlfinance.com.br',
        'http://controlfinance.com.br',
        'https://vps62858.publiccloud.com.br',
        'http://vps62858.publiccloud.com.br',
        'http://191.252.186.245',
        'https://191.252.186.245',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://192.168.0.166:3000',
		'http://localhost:8080',
        'http://127.0.0.1:8080',
        'http://192.168.0.166:8080',
        'null'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

// Configurações de segurança
// Configuração específica do helmet para permitir scripts inline, recursos externos e requisições API (necessário para o frontend atual)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      "default-src": "'self'",
      "script-src": ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
      "script-src-attr": "'unsafe-inline'", // Permite eventos inline como onclick
      "style-src": ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      "img-src": ["'self'", "data:", "blob:", "https:"],
      "font-src": ["'self'", "https://cdnjs.cloudflare.com"],
      "connect-src": ["'self'"], // Permite requisições para o próprio servidor (API)
      "frame-src": ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com"],
      "object-src": "'none'",
    },
  },
  crossOriginEmbedderPolicy: false, // Necessário para permitir recursos externos
}));
app.use(mongoSanitize());
app.use(xss());
app.use(hpp());
app.use(cookieParser());

// Blacklist de IPs — bloqueia antes de qualquer outra lógica
app.use((req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
    if (_ipBlacklist.has(ip)) return res.status(403).json({ success: false, message: 'Acesso bloqueado.' });
    next();
});

// Rate limit global por IP — barreira contra varredura e flood
// Usuários autenticados (com cookie de sessão válido) são isentos — controlados por userRateLimit
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 2000,
    message: 'Muitas requisições a partir deste IP, tente novamente mais tarde.',
    standardHeaders: true,
    skip: (req) => {
        const token = req.cookies?.sess;
        if (!token) return false;
        for (const [, sess] of activeSessions.entries()) {
            if (sess.token === token) return true;
        }
        return false;
    },
    legacyHeaders: false,
});
app.use(limiter);

// Rate limit específico para login — evita força bruta por IP
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Muitas tentativas de login, tente novamente em 15 minutos.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Rate limit por usuário autenticado — máx 300 req/min por userId
const _userReqCount = new Map(); // uid -> { count, windowStart, rotas: Map<rota, count> }
function userRateLimit(req, res, next) {
    const uid = req.sessionUser?.id || req.body?.usuarioId || req.query?.usuarioId;
    if (!uid) return next();
    const agora = Date.now();
    const entry = _userReqCount.get(uid) || { count: 0, windowStart: agora, rotas: new Map() };
    if (agora - entry.windowStart > 60000) {
        entry.count = 0;
        entry.windowStart = agora;
        entry.rotas = new Map();
    }
    entry.count++;
    // Registra rota sem query string e sem prefixo /api/bet365 /api/simulador etc.
    const rota = (req.originalUrl || req.path).split('?')[0].replace(/^\/api\/[^/]+/, '') || req.path;
    entry.rotas.set(rota, (entry.rotas.get(rota) || 0) + 1);
    _userReqCount.set(uid, entry);
    if (entry.count > 300) {
        console.warn(`[Segurança] Rate limit por usuário: uid=${uid} count=${entry.count}`);
        return res.status(429).json({ success: false, message: 'Muitas requisições. Aguarde um momento.' });
    }
    next();
}

app.use(express.json());

// Logging enxuto: método + rota + status + tempo (sem headers sensíveis)
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - start;
        if (!req.url.startsWith('/api/usuarios/ping')) {
            console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${ms}ms`);
        }
    });
    next();
});


// Middleware para conexão com SQL Server
// ✅ CONEXÃO GLOBAL - substitua a função connectSQL atual
let sqlConnectionPool = null;
let _sqlConnectingPromise = null; // lock: evita duas chamadas simultâneas a sql.connect()

async function connectSQL(config) {
    if (sqlConnectionPool) return true;
    if (_sqlConnectingPromise) { await _sqlConnectingPromise; return !!sqlConnectionPool; }

    const sqlConfig = {
        server: config.server,
        database: config.database,
        user: config.username,
        password: config.password,
        options: {
            encrypt: config.encrypt,
            trustServerCertificate: config.trustServerCertificate || true,
            connectTimeout: 30000,
            requestTimeout: 30000,
            port: config.port || 1433,
            pool: {
                max: 10,
                min: 0,
                idleTimeoutMillis: 30000
            }
        }
    };

    _sqlConnectingPromise = (async () => {
        try {
            sqlConnectionPool = await sql.connect(sqlConfig);
            console.log('✅ Conexão SQL estabelecida');
        } catch (err) {
            sqlConnectionPool = null;
            throw new Error(`Erro SQL: ${err.message}`);
        } finally {
            _sqlConnectingPromise = null;
        }
    })();
    await _sqlConnectingPromise;
    return !!sqlConnectionPool;
}

// Função para obter configurações do banco de dados a partir do .env
function getDatabaseConfigFromEnv() {
    return {
        server: process.env.DB_SERVER || 'localhost',
        database: process.env.DB_NAME || 'master',
        username: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        encrypt: process.env.DB_ENCRYPT === 'true',
        trustServerCertificate: process.env.DB_TRUST_CERT === 'true',
        port: parseInt(process.env.DB_PORT, 10) || 1433
    };
}

// ── Helpers: login tracking, UA parse, geo lookup ─────────────
function _todayUTC() { return new Date().toISOString().slice(0, 10); }

function _trackLoginSuccess(userId) {
    const k = String(userId), today = _todayUTC();
    const h = loginHistory.get(k) || { countToday: 0, lastLoginDate: '' };
    if (h.lastLoginDate !== today) { h.countToday = 0; h.lastLoginDate = today; }
    h.countToday++;
    loginHistory.set(k, h);
}

// Cache de config de brute force — recarregado a cada 5 min
let _bfCfg = { tentativas: 10, janelaMins: 15, bloqueioMins: 10, cachedAt: 0 };
async function _loadBfCfg() {
    if (Date.now() - _bfCfg.cachedAt < 5 * 60000) return;
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        const r = await sql.query`SELECT chave, valor FROM bet365_config
            WHERE chave IN ('brute_force_tentativas','brute_force_janela_min','brute_force_bloqueio_min')`;
        r.recordset.forEach(row => {
            const v = parseInt(row.valor);
            if (!isNaN(v) && v > 0) {
                if (row.chave === 'brute_force_tentativas')   _bfCfg.tentativas   = v;
                if (row.chave === 'brute_force_janela_min')   _bfCfg.janelaMins   = v;
                if (row.chave === 'brute_force_bloqueio_min') _bfCfg.bloqueioMins = v;
            }
        });
        _bfCfg.cachedAt = Date.now();
    } catch(_) {}
}

async function _trackLoginFail(username, ip) {
    await _loadBfCfg();
    const k = (username || '').toLowerCase();
    const arr = loginFailures.get(k) || [];
    arr.unshift({ ip: ip || '?', ts: Date.now() });
    loginFailures.set(k, arr.slice(0, 50));

    const JANELA   = _bfCfg.janelaMins   * 60 * 1000;
    const LIMITE   = _bfCfg.tentativas;
    const BLOQUEIO = _bfCfg.bloqueioMins * 60 * 1000;
    if (ip && ip !== '?') {
        const recentes = arr.filter(e => Date.now() - e.ts < JANELA && e.ip === ip);
        if (recentes.length >= LIMITE) {
            const entry = _loginBlocklist.get(ip) || { usuarios: new Set() };
            entry.blockedUntil = Date.now() + BLOQUEIO;
            entry.usuarios.add(k);
            _loginBlocklist.set(ip, entry);
            console.log(`🔒 [BruteForce] IP ${ip} bloqueado por ${_bfCfg.bloqueioMins}min (usuário: ${k}, tentativas: ${recentes.length})`);
        }
    }
}

function _isIpBlocked(ip) {
    if (!ip || ip === '?') return false;
    const entry = _loginBlocklist.get(ip);
    if (!entry) return false;
    if (Date.now() > entry.blockedUntil) { _loginBlocklist.delete(ip); return false; }
    return true;
}

// Limpa sessões inativas há mais de 8h (roda a cada 30min)
setInterval(() => {
    const OITO_HORAS = 8 * 60 * 60 * 1000;
    const agora = Date.now();
    for (const [uid, sess] of activeSessions.entries()) {
        if (sess.tipo !== 'master' && agora - new Date(sess.lastSeen).getTime() > OITO_HORAS) {
            activeSessions.delete(uid);
            console.log(`[Segurança] Sessão expirada por inatividade: usuário ${sess.usuario} (${uid})`);
        }
    }
}, 30 * 60 * 1000);

function _parseUA(ua) {
    if (!ua) return { browser: '?', os: '?' };
    let browser = '?', os = '?';
    if      (/Windows NT 1[01]/i.test(ua)) os = 'Windows 10/11';
    else if (/Windows/i.test(ua))           os = 'Windows';
    else if (/Mac OS X/i.test(ua))          os = 'macOS';
    else if (/Android ([0-9]+)/i.test(ua)) { const m = ua.match(/Android ([0-9]+)/i); os = 'Android' + (m ? ' '+m[1] : ''); }
    else if (/iPhone|iPad/i.test(ua))       os = 'iOS';
    else if (/Linux/i.test(ua))             os = 'Linux';
    if      (/Edg\/([0-9]+)/i.test(ua))    { const m = ua.match(/Edg\/([0-9]+)/i);     browser = 'Edge'    + (m ? ' '+m[1] : ''); }
    else if (/OPR\/([0-9]+)/i.test(ua))    { const m = ua.match(/OPR\/([0-9]+)/i);     browser = 'Opera'   + (m ? ' '+m[1] : ''); }
    else if (/Chrome\/([0-9]+)/i.test(ua)) { const m = ua.match(/Chrome\/([0-9]+)/i);  browser = 'Chrome'  + (m ? ' '+m[1] : ''); }
    else if (/Firefox\/([0-9]+)/i.test(ua)){ const m = ua.match(/Firefox\/([0-9]+)/i); browser = 'Firefox' + (m ? ' '+m[1] : ''); }
    else if (/Safari\//i.test(ua))          browser = 'Safari';
    return { browser, os };
}

async function _geoLookup(ip) {
    const _ip = ip ? ip.replace(/^::ffff:/, '') : ip;
    if (!_ip || _ip === '?' || _ip === '::1' || /^(127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(_ip)) {
        return { city: 'Local', region: '', country: 'BR', org: 'Rede local' };
    }
    const cached = _geoCache.get(ip);
    if (cached && Date.now() - cached.cachedAt < 6 * 60 * 60 * 1000) {
        const { cachedAt, ...geo } = cached; return geo;
    }
    try {
        const r = await axios.get(`https://ipinfo.io/${ip}/json`, { timeout: 3000 });
        const d = r.data || {};
        const geo = { city: d.city||'', region: d.region||'', country: d.country||'', org: d.org||'' };
        _geoCache.set(ip, { ...geo, cachedAt: Date.now() });
        return geo;
    } catch(e) {
        return { city: '', region: '', country: '', org: '' };
    }
}

async function _registrarAcesso(usuarioId, usuario, tipo, ip, userAgent, geo, duracao_seg) {
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        const cidade   = geo?.city    ? String(geo.city).substring(0,100)    : null;
        const pais     = geo?.country ? String(geo.country).substring(0,10)  : null;
        const provedor = geo?.org     ? String(geo.org).substring(0,200)     : null;
        const dur      = (duracao_seg != null && isFinite(duracao_seg)) ? Math.round(duracao_seg) : null;
        await sql.query`
            INSERT INTO HistoricoAcessos (usuario_id, usuario, tipo, ip, user_agent, data_hora, cidade, pais, provedor, duracao_seg)
            VALUES (${usuarioId ? Number(usuarioId) : null}, ${(usuario||'?').substring(0,100)},
                    ${tipo}, ${(ip||'?').substring(0,60)}, ${(userAgent||'').substring(0,500)}, GETUTCDATE(),
                    ${cidade}, ${pais}, ${provedor}, ${dur})
        `;
    } catch(e) { /* fire-and-forget */ }
}
// ──────────────────────────────────────────────────────────────

// Middleware de autenticação — valida sessão ativa via cookie (preferido) ou body/query (legado)
async function requireAuth(req, res, next) {
    // 1) Token via cookie httpOnly (novo padrão)
    const cookieToken = req.cookies?.sess;
    if (cookieToken) {
        for (const [uid, sess] of activeSessions.entries()) {
            if (sess.token === cookieToken) {
                sess.lastSeen = new Date();
                req.sessionUser = sess;
                if (!req.body) req.body = {};
                req.body.usuarioId = req.body.usuarioId || uid;
                return next();
            }
        }
        // Cookie presente mas token não encontrado em memória — reconstitui do banco após restart
        try {
            const dbR = await sqlConnectionPool.request()
                .input('token', cookieToken)
                .query('SELECT Id, Usuario, NomeCompleto, TipoUsuario FROM Usuarios WHERE sess_token = @token AND sess_expira > GETDATE() AND Ativo = 1');
            if (dbR.recordset.length) {
                const u = dbR.recordset[0];
                const sess = { id: String(u.Id), usuario: u.Usuario, nome: u.NomeCompleto, tipo: u.TipoUsuario, token: cookieToken, lastSeen: new Date(), loginTime: new Date() };
                activeSessions.set(String(u.Id), sess);
                req.sessionUser = sess;
                if (!req.body) req.body = {};
                req.body.usuarioId = req.body.usuarioId || String(u.Id);
                return next();
            }
        } catch (_) {}
        res.clearCookie('sess');
        return res.status(401).json({ success: false, message: 'Sessão expirada. Faça login novamente.' });
    }

    // 2) Fallback legado: usuarioId no body ou query validado contra activeSessions
    const uid = String(req.body?.usuarioId || req.query?.usuarioId || '');
    if (uid && activeSessions.has(uid)) {
        const sess = activeSessions.get(uid);
        sess.lastSeen = new Date();
        req.sessionUser = sess;
        return next();
    }

    return res.status(401).json({ success: false, message: 'Não autenticado. Faça login novamente.' });
}

// Middleware para rotas GET que passam usuarioId como query param (ex: /api/bet365/*)
async function requireAuthQuery(req, res, next) {
    // 1) Cookie httpOnly — validação forte
    const cookieToken = req.cookies?.sess;
    if (cookieToken) {
        for (const [uid, sess] of activeSessions.entries()) {
            if (sess.token === cookieToken) {
                sess.lastSeen = new Date();
                req.sessionUser = sess;
                return next();
            }
        }
        // Cookie presente mas token não encontrado em memória — pode ser restart do servidor
        // Tenta reconstituir sessão a partir do banco
        try {
            const dbR = await sqlConnectionPool.request()
                .input('token', cookieToken)
                .query('SELECT Id, Usuario, NomeCompleto, TipoUsuario FROM Usuarios WHERE sess_token = @token AND sess_expira > GETDATE() AND Ativo = 1');
            if (dbR.recordset.length) {
                const u = dbR.recordset[0];
                const sess = { id: String(u.Id), usuario: u.Usuario, nome: u.NomeCompleto, tipo: u.TipoUsuario, token: cookieToken, lastSeen: new Date(), loginTime: new Date() };
                activeSessions.set(String(u.Id), sess);
                req.sessionUser = sess;
                return next();
            }
        } catch (_) {}
        res.clearCookie('sess');
        return res.status(401).json({ success: false, message: 'Não autenticado.' });
    }
    // 2) Fallback de transição: uid presente no body/query (browser já logado antes do deploy)
    const uid = String(req.query?.usuarioId || req.body?.usuarioId || '');
    if (uid) {
        const sess = activeSessions.get(uid);
        if (sess) { sess.lastSeen = new Date(); req.sessionUser = sess; }
        return next(); // aceita — usuário lerá a página e ao próximo login ganha o cookie
    }
    return res.status(401).json({ success: false, message: 'Não autenticado.' });
}

// =============================================
// API BET365 - Dados em tempo real (tabelas bet365_*)
// =============================================
const bet365Routes = require('./routes/bet365-api');

// Auditoria de requisições suspeitas: horas > 20 — loga + persiste no banco
app.use('/api/bet365/historico-mercados', (req, res, next) => {
    const horas = parseInt(req.query.horas) || 0;
    if (horas > 20) {
        const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
        const token = req.cookies?.sess;
        let usuario = 'anonimo';
        let usuario_id = null;
        if (token) {
            for (const [, sess] of activeSessions.entries()) {
                if (sess.token === token) { usuario = sess.usuario; usuario_id = parseInt(sess.id) || null; break; }
            }
        }
        console.warn(`[AUDIT-HORAS] horas=${horas} ip=${ip} usuario=${usuario_id ? `${usuario} (id:${usuario_id})` : 'anonimo'} ua="${(req.headers['user-agent']||'').substring(0,80)}"`);
        // Persiste para análise no painel administrativo
        if (sqlConnectionPool) {
            sqlConnectionPool.request()
                .input('uid',    usuario_id)
                .input('usr',    usuario)
                .input('ip',     ip)
                .input('horas',  horas)
                .query('INSERT INTO auditoria_requests (usuario_id, usuario, ip, horas) VALUES (@uid, @usr, @ip, @horas)')
                .catch(() => {});
        }
    }
    next();
});

app.use('/api/bet365', requireAuthQuery, userRateLimit, bet365Routes);

// Simulador de apostas virtuais
const simuladorRoutes = require('./routes/simulador-api');
app.use('/api/simulador', userRateLimit, simuladorRoutes);

// Kirvano — webhook de pagamento + credenciais
const kirvanRoutes = require('./routes/kirvano');
app.use('/api/kirvano', kirvanRoutes);

// Financeiro — receitas e despesas (master/admin only)
const financeiroRoutes = require('./routes/financeiro');
app.use('/api/financeiro', requireAuth, financeiroRoutes);

// ── Endpoint interno: coletor local notifica VPS para fazer WS broadcast ──
// Autenticado por x-notify-key = JWT_SECRET (sem auth de usuário)
app.post('/api/ws/notificar', express.json(), (req, res) => {
    const key = req.headers['x-notify-key'];
    if (!key || key !== process.env.JWT_SECRET) return res.status(403).json({ error: 'Forbidden' });
    const { novos = 0, resultadosSalvos = 0, fonte = 'bet365' } = req.body || {};
    if (typeof global.wsBroadcast === 'function') {
        global.wsBroadcast({ tipo: 'coleta', fonte, novos, resultadosSalvos, timestamp: new Date().toISOString() });
    }
    res.json({ ok: true });
});

// ── Rotas bet365 declaradas diretamente (garante funcionamento no contexto do server.js) ──
{
    const sqlB = require('mssql');
    let _bet365Pool = null;
    async function _b365Pool() {
        if (_bet365Pool && _bet365Pool.connected) return _bet365Pool;
        _bet365Pool = await sqlB.connect({
            user: process.env.DB_USER || 'sa',
            password: process.env.DB_PASSWORD,
            server: process.env.DB_SERVER || '127.0.0.1',
            database: process.env.DB_NAME || 'PRODUCAO',
            port: parseInt(process.env.DB_PORT) || 1433,
            options: { encrypt: false, trustServerCertificate: true },
            pool: { max: 5, min: 0, idleTimeoutMillis: 30000 }
        });
        return _bet365Pool;
    }

    // historico-tabela, debug-db, sugestoes, estatisticas-avancadas agora servidos por bet365-api.js
    // (usando bet365_resultados_mercados como fonte única — bet365_historico_partidas removida)
}

// Rota alternativa de dados (funciona sem pool global)
const dadosRoutes = require('./routes/dados');
app.use('/api/dados', dadosRoutes);

// Rota de teste de conexão
app.post('/api/test-connection', async (req, res) => {
    try {
        // Se nenhuma configuração for fornecida, usar as do ambiente
        const sqlConfig = req.body.sqlConfig || getDatabaseConfigFromEnv();
        await connectSQL(sqlConfig || getDatabaseConfigFromEnv());

        res.json({ success: true, message: 'Conexão bem-sucedida' });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// Rota de login
app.post('/api/login', loginLimiter, async (req, res) => {
    const { username, password, sqlConfig } = req.body;
    const _ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '?';

    // Rejeita IPs bloqueados por brute force — master nunca é bloqueado por IP
    const _isMasterAttempt = (username || '').toUpperCase() === 'MASTER';
    if (!_isMasterAttempt && _isIpBlocked(_ip)) {
        return res.json({ success: false, message: 'Muitas tentativas incorretas. Tente novamente em 30 minutos.' });
    }

    try {
        const dbConfig = sqlConfig || getDatabaseConfigFromEnv();
        await connectSQL(dbConfig);

        // Buscar usuário pelo nome de usuário ou e-mail
        const result = await sql.query`
            SELECT Id, NomeCompleto, Usuario, Email, Senha, TipoUsuario, DataInicioLicenca, DataFimLicenca
            FROM Usuarios
            WHERE (Usuario = ${username} OR LOWER(Email) = LOWER(${username})) AND Ativo = 1
        `;

        if (result.recordset.length > 0) {
            const user = result.recordset[0];

            // Verificar senha (suporte a Base64 legado e bcrypt)
            let passwordMatch = false;

            // Verificar se a senha no banco é um hash bcrypt
            if (user.Senha.startsWith('$2a$') || user.Senha.startsWith('$2b$')) {
                // É um hash bcrypt
                passwordMatch = await bcrypt.compare(password, user.Senha);
            } else {
                // É uma senha em Base64 (legado) ou texto plano
                try {
                    const base64Password = Buffer.from(password).toString('base64');
                    passwordMatch = user.Senha === base64Password;
                } catch (e) {
                    // Tentar como texto plano
                    passwordMatch = user.Senha === password;
                }

                // Se ainda não encontrou, tentar a senha original
                if (!passwordMatch) {
                    passwordMatch = user.Senha === password;
                }
            }

            if (passwordMatch) {
                // Verificar validade da licença
                const hoje = new Date();
                const inicioLicenca = user.DataInicioLicenca ? new Date(user.DataInicioLicenca) : null;
                const fimLicenca = user.DataFimLicenca ? new Date(user.DataFimLicenca) : null;

                let licencaValida = true;
                if (user.TipoUsuario !== 'master') {
                    if (!inicioLicenca && !fimLicenca) {
                        // Sem nenhuma data configurada → acesso bloqueado
                        licencaValida = false;
                    } else {
                        if (inicioLicenca && hoje < inicioLicenca) licencaValida = false;
                        if (fimLicenca    && hoje > fimLicenca)    licencaValida = false;
                    }
                }

                if (!licencaValida) {
                    res.json({ success: false, message: 'Licença do usuário expirada, ainda não iniciada ou não configurada.' });
                    return;
                }

                // Bloquear acesso simultâneo (exceto master)
                if (user.TipoUsuario !== 'master') {
                    const sessao = activeSessions.get(String(user.Id));
                    const limite = Date.now() - 1 * 60 * 1000;
                    if (sessao && sessao.lastSeen.getTime() >= limite) {
                        const restam = Math.ceil((sessao.lastSeen.getTime() + 1 * 60 * 1000 - Date.now()) / 60000);
                        return res.json({
                            success: false,
                            message: `Usuário já possui uma sessão ativa em outro dispositivo. Faça logout no outro dispositivo ou aguarde ${restam} minuto(s).`
                        });
                    }
                }

                // Registrar sessão ao logar
                const _loginIp = _ip;
                const sessionToken = crypto.randomUUID();
                activeSessions.set(String(user.Id), {
                    id: String(user.Id),
                    usuario: user.Usuario,
                    nome: user.NomeCompleto,
                    tipo: user.TipoUsuario,
                    lastSeen: new Date(),
                    loginTime: new Date(),
                    ip: _loginIp,
                    userAgent: req.headers['user-agent'] || '',
                    token: sessionToken,
                });
                // Persiste token no banco — sessão sobrevive restart do PM2
                sqlConnectionPool.request()
                    .input('token', sessionToken)
                    .input('expira', new Date(Date.now() + 8 * 60 * 60 * 1000))
                    .input('id', user.Id)
                    .query('UPDATE Usuarios SET sess_token = @token, sess_expira = @expira WHERE Id = @id')
                    .catch(() => {});
                _trackLoginSuccess(user.Id);
                _geoLookup(_loginIp).then(geo => _registrarAcesso(user.Id, user.Usuario, 'login_ok', _loginIp, req.headers['user-agent'], geo, null)).catch(()=>{});

                // Cookie httpOnly — enviado automaticamente em todos os requests futuros
                res.cookie('sess', sessionToken, {
                    httpOnly: true,
                    sameSite: 'lax',
                    secure: process.env.NODE_ENV === 'production',
                    maxAge: 8 * 60 * 60 * 1000, // 8 horas
                });

                const { Senha, ...userWithoutPassword } = user;
                res.json({ success: true, user: userWithoutPassword });
            } else {
                const _failIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
                await _trackLoginFail(username, _failIp);
                _geoLookup(_failIp).then(geo => _registrarAcesso(null, username, 'login_fail', _failIp, req.headers['user-agent'], geo, null)).catch(()=>{});
                res.json({ success: false, message: 'Credenciais inválidas' });
            }
        } else {
            const _failIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
            await _trackLoginFail(username, _failIp);
            _geoLookup(_failIp).then(geo => _registrarAcesso(null, username, 'login_fail', _failIp, req.headers['user-agent'], geo, null)).catch(()=>{});
            res.json({ success: false, message: 'Credenciais inválidas' });
        }


    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// Rota para carregar despesas mensais
app.post('/api/despesas/mensais', requireAuth, async (req, res) => {
    const { mes, ano, sqlConfig } = req.body;

    try {
        await connectSQL(sqlConfig || getDatabaseConfigFromEnv());

        const result = await sql.query`
            SELECT dm.*, m.Descricao AS MovimentoDescricao
            FROM DespesasMensais dm
            LEFT JOIN movimento m ON dm.MovimentoId = m.Id
            WHERE dm.Mes = ${mes} AND dm.Ano = ${ano} AND dm.UsuarioId = ${req.body.usuarioId}
            ORDER BY dm.DataCriacao DESC
        `;

        res.json({ success: true, data: result.recordset });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// Rota para salvar despesa mensal
app.post('/api/despesas/mensais/save', requireAuth, async (req, res) => {
    const { id, descricao, valor, observacoes, mes, ano, usuarioId, sqlConfig, movimentoId } = req.body;

    try {
        await connectSQL(sqlConfig || getDatabaseConfigFromEnv());

        // Validar se movimentoId foi fornecido
        if (!movimentoId) {
            return res.json({ success: false, message: 'Categoria de movimento é obrigatória' });
        }

        if (id) {
            // Registrar histórico antes de atualizar
            const oldData = await sql.query`
                SELECT dm.Descricao, dm.Valor, m.Descricao AS MovimentoDescricao
                FROM DespesasMensais dm
                LEFT JOIN movimento m ON dm.MovimentoId = m.Id
                WHERE dm.Id = ${id}
            `;

            await sql.query`
                UPDATE DespesasMensais
                SET Descricao = ${descricao}, Valor = ${valor}, Observacoes = ${observacoes}, MovimentoId = ${movimentoId}, DataAtualizacao = GETDATE()
                WHERE Id = ${id} AND UsuarioId = ${usuarioId}
            `;

            // Registrar alteração no histórico
            if (oldData.recordset.length > 0) {
                const old = oldData.recordset[0];
                const oldMovimento = old.MovimentoDescricao ? ` - Categoria: ${old.MovimentoDescricao}` : '';
                await sql.query`
                    INSERT INTO HistoricoAlteracoes (Mes, Ano, DataAlteracao, Acao, UsuarioId)
                    VALUES (${mes}, ${ano}, GETDATE(),
                    ${'Despesa mensal atualizada: "' + old.Descricao + '" (R$ ' + old.Valor + ') → "' + descricao + '" (R$ ' + valor + ')' + oldMovimento},
                    ${usuarioId})
                `;
            }
        } else {
            await sql.query`
                INSERT INTO DespesasMensais (Mes, Ano, Descricao, Valor, Observacoes, UsuarioId, MovimentoId, DataCriacao, DataAtualizacao)
                VALUES (${mes}, ${ano}, ${descricao}, ${valor}, ${observacoes}, ${usuarioId}, ${movimentoId}, GETDATE(), GETDATE())
            `;

            // Pegar a descrição do movimento para o histórico
            const movimentoDescricao = (await sql.query`SELECT Descricao FROM movimento WHERE Id = ${movimentoId}`).recordset[0]?.Descricao || 'Sem categoria';

            await sql.query`
                INSERT INTO HistoricoAlteracoes (Mes, Ano, DataAlteracao, Acao, UsuarioId)
                VALUES (${mes}, ${ano}, GETDATE(), ${'Nova despesa mensal: "' + descricao + '" - R$ ' + valor + ' - Categoria: ' + movimentoDescricao}, ${usuarioId})
            `;
        }

        res.json({ success: true, message: 'Despesa salva com sucesso' });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// Rota para excluir despesa mensal
app.post('/api/despesas/mensais/delete', requireAuth, async (req, res) => {
    const { id, mes, ano, usuarioId, sqlConfig } = req.body;

    try {
        await connectSQL(sqlConfig || getDatabaseConfigFromEnv());

        // Registrar histórico antes de excluir
        const oldData = await sql.query`
            SELECT dm.Descricao, dm.Valor, m.Descricao AS MovimentoDescricao
            FROM DespesasMensais dm
            LEFT JOIN movimento m ON dm.MovimentoId = m.Id
            WHERE dm.Id = ${id} AND dm.UsuarioId = ${usuarioId}
        `;

        await sql.query`DELETE FROM DespesasMensais WHERE Id = ${id} AND UsuarioId = ${usuarioId}`;

        if (oldData.recordset.length > 0) {
            const old = oldData.recordset[0];
            const movimentoInfo = old.MovimentoDescricao ? ` - Categoria: ${old.MovimentoDescricao}` : '';
            await sql.query`
                INSERT INTO HistoricoAlteracoes (Mes, Ano, DataAlteracao, Acao, UsuarioId)
                VALUES (${mes}, ${ano}, GETDATE(), ${'Despesa mensal excluída: "' + old.Descricao + '" - R$ ' + old.Valor + movimentoInfo}, ${usuarioId})
            `;
        }

        res.json({ success: true, message: 'Despesa excluída com sucesso' });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});



// Rota para carregar histórico - CORRIGIDA E MELHORADA
app.post('/api/historico', requireAuth, async (req, res) => {
    const { mes, ano, sqlConfig } = req.body;

    try {
        await connectSQL(sqlConfig || getDatabaseConfigFromEnv());

        const result = await sql.query`
            SELECT ha.*, u.Usuario, u.NomeCompleto
            FROM HistoricoAlteracoes ha
            INNER JOIN Usuarios u ON ha.UsuarioId = u.Id
            WHERE ha.Mes = ${mes} AND ha.Ano = ${ano} AND ha.UsuarioId = ${req.body.usuarioId}
            ORDER BY ha.DataAlteracao DESC
        `;

        res.json({ success: true, data: result.recordset });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// Rota para carregar categorias de movimento
app.post('/api/movimento', requireAuth, async (req, res) => {
    const { tipo, sqlConfig } = req.body;

    try {
        await connectSQL(sqlConfig || getDatabaseConfigFromEnv());

        let query;
        if (tipo) {
            query = await sql.query`
                SELECT Id, Descricao, Tipo
                FROM movimento
                WHERE Ativo = 1 AND Tipo = ${tipo}
                ORDER BY Descricao
            `;
        } else {
            query = await sql.query`
                SELECT Id, Descricao, Tipo
                FROM movimento
                WHERE Ativo = 1
                ORDER BY Tipo, Descricao
            `;
        }

        res.json({ success: true, data: query.recordset });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// Rota para carregar todos os históricos (para navegação) - MELHORADA
app.post('/api/historico/todos', requireAuth, async (req, res) => {
    const { sqlConfig } = req.body;

    try {
        await connectSQL(sqlConfig || getDatabaseConfigFromEnv());

        const result = await sql.query`
            SELECT DISTINCT Mes, Ano
            FROM HistoricoAlteracoes
            WHERE UsuarioId = ${req.body.usuarioId}
            ORDER BY Ano DESC, Mes DESC
        `;

        res.json({ success: true, data: result.recordset });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// Rota para carregar histórico com paginação - NOVA
app.post('/api/historico/paginado', requireAuth, async (req, res) => {
    const { mes, ano, pagina = 1, itensPorPagina = 10, sqlConfig } = req.body;

    try {
        await connectSQL(sqlConfig || getDatabaseConfigFromEnv());

        const offset = (pagina - 1) * itensPorPagina;

        const result = await sql.query`
            SELECT ha.*, u.Usuario, u.NomeCompleto
            FROM HistoricoAlteracoes ha
            INNER JOIN Usuarios u ON ha.UsuarioId = u.Id
            WHERE ha.Mes = ${mes} AND ha.Ano = ${ano} AND ha.UsuarioId = ${req.body.usuarioId}
            ORDER BY ha.DataAlteracao DESC
            OFFSET ${offset} ROWS FETCH NEXT ${itensPorPagina} ROWS ONLY
        `;

        // Contar total de registros
        const totalResult = await sql.query`
            SELECT COUNT(*) as Total
            FROM HistoricoAlteracoes
            WHERE Mes = ${mes} AND Ano = ${ano} AND UsuarioId = ${req.body.usuarioId}
        `;

        const total = totalResult.recordset[0].Total;
        const totalPaginas = Math.ceil(total / itensPorPagina);

        res.json({
            success: true,
            data: result.recordset,
            paginacao: {
                paginaAtual: pagina,
                itensPorPagina: itensPorPagina,
                totalItens: total,
                totalPaginas: totalPaginas
            }
        });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// Rotas para Contas a Receber - NOVAS
app.post('/api/contas/receber', requireAuth, async (req, res) => {
    const { mes, ano, sqlConfig } = req.body;

    try {
        await connectSQL(sqlConfig || getDatabaseConfigFromEnv());

        const result = await sql.query`
            SELECT cr.*, m.Descricao AS MovimentoDescricao
            FROM ContasReceber cr
            LEFT JOIN movimento m ON cr.MovimentoId = m.Id
            WHERE cr.Mes = ${mes} AND cr.Ano = ${ano} AND cr.UsuarioId = ${req.body.usuarioId}
            ORDER BY cr.DataCriacao DESC
        `;

        res.json({ success: true, data: result.recordset });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

app.post('/api/contas/receber/save', requireAuth, async (req, res) => {
    const { id, descricao, valor, observacoes, mes, ano, usuarioId, sqlConfig, movimentoId } = req.body;

    try {
        await connectSQL(sqlConfig || getDatabaseConfigFromEnv());

        // Validar se movimentoId foi fornecido
        if (!movimentoId) {
            return res.json({ success: false, message: 'Categoria de movimento é obrigatória' });
        }

        if (id) {
            // Registrar histórico antes de atualizar
            const oldData = await sql.query`
                SELECT cr.Descricao, cr.Valor, m.Descricao AS MovimentoDescricao
                FROM ContasReceber cr
                LEFT JOIN movimento m ON cr.MovimentoId = m.Id
                WHERE cr.Id = ${id}
            `;

            await sql.query`
                UPDATE ContasReceber
                SET Descricao = ${descricao}, Valor = ${valor}, Observacoes = ${observacoes}, MovimentoId = ${movimentoId}, DataAtualizacao = GETDATE()
                WHERE Id = ${id} AND UsuarioId = ${usuarioId}
            `;

            if (oldData.recordset.length > 0) {
                const old = oldData.recordset[0];
                const oldMovimento = old.MovimentoDescricao ? ` - Categoria: ${old.MovimentoDescricao}` : '';
                await sql.query`
                    INSERT INTO HistoricoAlteracoes (Mes, Ano, DataAlteracao, Acao, UsuarioId)
                    VALUES (${mes}, ${ano}, GETDATE(),
                    ${'Conta a receber atualizada: "' + old.Descricao + '" (R$ ' + old.Valor + ') → "' + descricao + '" (R$ ' + valor + ')' + oldMovimento},
                    ${usuarioId})
                `;
            }
        } else {
            await sql.query`
                INSERT INTO ContasReceber (Mes, Ano, Descricao, Valor, Observacoes, UsuarioId, MovimentoId, DataCriacao, DataAtualizacao)
                VALUES (${mes}, ${ano}, ${descricao}, ${valor}, ${observacoes}, ${usuarioId}, ${movimentoId}, GETDATE(), GETDATE())
            `;

            // Pegar a descrição do movimento para o histórico
            const movimentoDescricao = (await sql.query`SELECT Descricao FROM movimento WHERE Id = ${movimentoId}`).recordset[0]?.Descricao || 'Sem categoria';

            await sql.query`
                INSERT INTO HistoricoAlteracoes (Mes, Ano, DataAlteracao, Acao, UsuarioId)
                VALUES (${mes}, ${ano}, GETDATE(), ${'Nova conta a receber: "' + descricao + '" - R$ ' + valor + ' - Categoria: ' + movimentoDescricao}, ${usuarioId})
            `;
        }

        res.json({ success: true, message: 'Conta a receber salva com sucesso' });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

app.post('/api/contas/receber/delete', requireAuth, async (req, res) => {
    const { id, mes, ano, usuarioId, sqlConfig } = req.body;

    try {
        await connectSQL(sqlConfig || getDatabaseConfigFromEnv());

        // Registrar histórico antes de excluir
        const oldData = await sql.query`
            SELECT cr.Descricao, cr.Valor, m.Descricao AS MovimentoDescricao
            FROM ContasReceber cr
            LEFT JOIN movimento m ON cr.MovimentoId = m.Id
            WHERE cr.Id = ${id} AND cr.UsuarioId = ${usuarioId}
        `;

        await sql.query`DELETE FROM ContasReceber WHERE Id = ${id} AND UsuarioId = ${usuarioId}`;

        if (oldData.recordset.length > 0) {
            const old = oldData.recordset[0];
            const movimentoInfo = old.MovimentoDescricao ? ` - Categoria: ${old.MovimentoDescricao}` : '';
            await sql.query`
                INSERT INTO HistoricoAlteracoes (Mes, Ano, DataAlteracao, Acao, UsuarioId)
                VALUES (${mes}, ${ano}, GETDATE(), ${'Conta a receber excluída: "' + old.Descricao + '" - R$ ' + old.Valor + movimentoInfo}, ${usuarioId})
            `;
        }

        res.json({ success: true, message: 'Conta a receber excluída com sucesso' });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// Rota para carregar usuários (apenas para masters) — paginada + filtros
app.post('/api/usuarios', requireAuth, async (req, res) => {
    const { sqlConfig, pagina = 1, porPagina = 10,
            filtroAtivo, filtroTipo, filtroExpirando, busca } = req.body;
    try {
        await connectSQL(sqlConfig || getDatabaseConfigFromEnv());

        // Monta filtros dinâmicos
        const wheres = [];
        const r = sqlConnectionPool.request();
        r.input('uid', sql.Int, req.body.usuarioId);

        if (filtroAtivo === 'ativo')   { wheres.push('Ativo = 1'); }
        if (filtroAtivo === 'inativo') { wheres.push('Ativo = 0'); }
        if (filtroTipo && filtroTipo !== 'todos') {
            wheres.push('TipoUsuario = @filtroTipo');
            r.input('filtroTipo', sql.NVarChar, filtroTipo);
        }
        if (filtroExpirando) {
            wheres.push(`DataFimLicenca BETWEEN GETUTCDATE() AND DATEADD(DAY, 7, GETUTCDATE())`);
        }
        if (busca && busca.trim()) {
            wheres.push(`(NomeCompleto LIKE @busca OR Usuario LIKE @busca OR Email LIKE @busca)`);
            r.input('busca', sql.NVarChar, `%${busca.trim()}%`);
        }

        const whereSQL = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
        const pp  = Math.max(1, Math.min(100, parseInt(porPagina) || 10));
        const pag = Math.max(1, parseInt(pagina) || 1);
        const off = (pag - 1) * pp;

        r.input('off', sql.Int, off);
        r.input('pp',  sql.Int, pp);

        // Auth via sessão (req.sessionUser.tipo é preenchido pelo requireAuth)
        const _chkTipo = (req.sessionUser?.tipo || '').toLowerCase();
        if (!_chkTipo || (_chkTipo !== 'master' && _chkTipo !== 'administrador' && _chkTipo !== 'admin')) {
            return res.json({ success: false, message: 'Acesso não autorizado' });
        }

        const result = await r.query(`
            SELECT
                a.Id, a.NomeCompleto, a.Usuario, a.Email, a.Telefone, a.TipoUsuario, a.PlanoAtivo,
                a.DataInicioLicenca, a.DataFimLicenca, a.DataCriacao, a.Ativo, a.UltimoAcesso,
                CASE WHEN k.usuario_id IS NOT NULL THEN 1 ELSE 0 END AS VeioKirvano,
                COUNT(*) OVER() AS _total
            FROM Usuarios a
            LEFT OUTER JOIN (SELECT DISTINCT usuario_id FROM kirvano_assinaturas) k ON a.Id = k.usuario_id
            ${whereSQL}
            ORDER BY a.DataCriacao DESC
            OFFSET @off ROWS FETCH NEXT @pp ROWS ONLY
        `);

        const total = result.recordset[0]?._total ?? 0;
        const usuariosFormatados = result.recordset.map(({ _total, ...u }) => ({
            ...u,
            DataInicioLicenca: u.DataInicioLicenca ? new Date(u.DataInicioLicenca).toISOString() : null,
            DataFimLicenca:    u.DataFimLicenca    ? new Date(u.DataFimLicenca).toISOString()    : null,
        }));

        res.json({ success: true, data: usuariosFormatados, total, pagina: pag, porPagina: pp });

    } catch (error) {
        console.error('Erro na rota /api/usuarios:', error);
        res.json({ success: false, message: error.message, data: [], total: 0 });
    }
});

// Rota para salvar usuário - CORRIGIDA
app.post('/api/usuarios/save', requireAuth, async (req, res) => {
    const { id, nomeCompleto, usuario, email, telefone, senha, tipoUsuario, ativo, planoAtivo, sqlConfig } = req.body;
    const ativoVal = ativo !== undefined ? (ativo ? 1 : 0) : null;
    const telefoneVal = telefone !== undefined ? (telefone || null) : undefined;

    try {
        await connectSQL(sqlConfig || getDatabaseConfigFromEnv());

        // Verificar se o usuário é master para criar/editar usuários
        const userCheck = await sql.query`
            SELECT TipoUsuario, Usuario FROM Usuarios WHERE Id = ${req.body.usuarioId}
        `;

        if (userCheck.recordset.length === 0) {
            return res.json({ success: false, message: 'Usuário não encontrado' });
        }

        const currentUser = userCheck.recordset[0];

        if (id) {
            const _reqTipoNorm = (currentUser.TipoUsuario || '').toLowerCase();
            const _reqIsElevated = _reqTipoNorm === 'master' || _reqTipoNorm === 'administrador' || _reqTipoNorm === 'admin';

            // Master e admin podem editar outros usuários; user só pode editar a si mesmo
            if (!_reqIsElevated && parseInt(id) !== req.body.usuarioId) {
                return res.json({ success: false, message: 'Acesso não autorizado' });
            }

            // Datas de licença: só atualizar quando explicitamente enviadas no body
            const _diEnviada = 'dataInicioLicenca' in req.body;
            const _dfEnviada = 'dataFimLicenca'    in req.body;
            const dataInicioLicenca = _diEnviada ? (req.body.dataInicioLicenca || null) : undefined;
            const dataFimLicenca    = _dfEnviada ? (req.body.dataFimLicenca    || null) : undefined;

            // Obter estado atual do usuário alvo (para fallback e para gerar diff no histórico)
            const prevRow = (await sql.query`
                SELECT NomeCompleto, Usuario, Email, Telefone, TipoUsuario, PlanoAtivo, Ativo, DataInicioLicenca, DataFimLicenca
                FROM Usuarios WHERE Id = ${id}
            `).recordset[0] || {};
            const currentTipoUsuario = prevRow.TipoUsuario;

            // ── Segurança: prevenção de escalada de privilégio ──
            // Admin não pode editar o usuário Master
            if (_reqTipoNorm !== 'master' && (currentTipoUsuario || '').toLowerCase() === 'master') {
                return res.json({ success: false, message: 'Sem permissão para editar o usuário Master.' });
            }
            // Apenas master pode definir tipo = 'master'
            if (tipoUsuario && tipoUsuario === 'master' && _reqTipoNorm !== 'master') {
                return res.json({ success: false, message: 'Apenas o usuário Master pode definir tipo master.' });
            }
            // Apenas admin ou master podem alterar o tipo de usuário
            const _reqTipo = (currentUser.TipoUsuario || '').toLowerCase();
            if (tipoUsuario && tipoUsuario !== currentTipoUsuario &&
                _reqTipo !== 'master' && _reqTipo !== 'administrador' && _reqTipo !== 'admin') {
                return res.json({ success: false, message: 'Sem permissão para alterar o tipo de usuário.' });
            }

            if (senha) {
                // Criptografar senha com bcrypt
                const hashedPassword = await bcrypt.hash(senha, parseInt(process.env.BCRYPT_SALT_ROUNDS) || 12);
                if (usuario && tipoUsuario) {
                    await sql.query`
                        UPDATE Usuarios
                        SET NomeCompleto = ${nomeCompleto}, Usuario = ${usuario}, Email = ${email},
                            Senha = ${hashedPassword}, TipoUsuario = ${tipoUsuario},
                            DataAtualizacao = GETDATE()
                        WHERE Id = ${id}
                    `;
                } else if (usuario) {
                    await sql.query`
                        UPDATE Usuarios
                        SET NomeCompleto = ${nomeCompleto}, Usuario = ${usuario}, Email = ${email},
                            Senha = ${hashedPassword}, TipoUsuario = ${tipoUsuario || currentTipoUsuario},
                            DataAtualizacao = GETDATE()
                        WHERE Id = ${id}
                    `;
                } else if (tipoUsuario) {
                    await sql.query`
                        UPDATE Usuarios
                        SET NomeCompleto = ${nomeCompleto}, Email = ${email},
                            Senha = ${hashedPassword}, TipoUsuario = ${tipoUsuario},
                            DataAtualizacao = GETDATE()
                        WHERE Id = ${id}
                    `;
                } else {
                    await sql.query`
                        UPDATE Usuarios
                        SET NomeCompleto = ${nomeCompleto}, Email = ${email},
                            Senha = ${hashedPassword}, TipoUsuario = ${currentTipoUsuario},
                            DataAtualizacao = GETDATE()
                        WHERE Id = ${id}
                    `;
                }
            } else {
                if (usuario && tipoUsuario) {
                    await sql.query`
                        UPDATE Usuarios
                        SET NomeCompleto = ${nomeCompleto}, Usuario = ${usuario}, Email = ${email},
                            TipoUsuario = ${tipoUsuario},
                            DataAtualizacao = GETDATE()
                        WHERE Id = ${id}
                    `;
                } else if (usuario) {
                    await sql.query`
                        UPDATE Usuarios
                        SET NomeCompleto = ${nomeCompleto}, Usuario = ${usuario}, Email = ${email},
                            TipoUsuario = ${tipoUsuario || currentTipoUsuario},
                            DataAtualizacao = GETDATE()
                        WHERE Id = ${id}
                    `;
                } else if (tipoUsuario) {
                    await sql.query`
                        UPDATE Usuarios
                        SET NomeCompleto = ${nomeCompleto}, Email = ${email},
                            TipoUsuario = ${tipoUsuario},
                            DataAtualizacao = GETDATE()
                        WHERE Id = ${id}
                    `;
                } else {
                    await sql.query`
                        UPDATE Usuarios
                        SET NomeCompleto = ${nomeCompleto}, Email = ${email},
                            TipoUsuario = ${currentTipoUsuario},
                            DataAtualizacao = GETDATE()
                        WHERE Id = ${id}
                    `;
                }
            }

            // Atualizar datas de licença apenas quando explicitamente enviadas no body — independentes entre si
            if (_diEnviada) await sql.query`UPDATE Usuarios SET DataInicioLicenca = ${dataInicioLicenca ?? null} WHERE Id = ${id}`;
            if (_dfEnviada) await sql.query`UPDATE Usuarios SET DataFimLicenca    = ${dataFimLicenca    ?? null} WHERE Id = ${id}`;

            // Atualizar Ativo se informado
            if (ativoVal !== null) {
                await sql.query`UPDATE Usuarios SET Ativo = ${ativoVal} WHERE Id = ${id}`;
            }
            // Atualizar Telefone se informado
            if (telefoneVal !== undefined) {
                await sql.query`UPDATE Usuarios SET Telefone = ${telefoneVal} WHERE Id = ${id}`;
            }
            // Atualizar PlanoAtivo se informado
            if (planoAtivo) {
                await sql.query`UPDATE Usuarios SET PlanoAtivo = ${planoAtivo} WHERE Id = ${id}`;
            }

            // Registrar no histórico — diff dos campos alterados
            {
                const reqLogin    = currentUser.Usuario || `ID:${req.body.usuarioId}`;
                const targetLogin = prevRow.Usuario || usuario || `ID:${id}`;
                const _fmt = v => (v == null || v === '') ? '(vazio)' : String(v);
                const _fmtD = v => v ? new Date(v).toLocaleDateString('pt-BR') : '(vazio)';
                const diffs = [];
                if (nomeCompleto !== undefined && nomeCompleto !== prevRow.NomeCompleto)
                    diffs.push(`Nome: "${_fmt(prevRow.NomeCompleto)}" → "${_fmt(nomeCompleto)}"`);
                if (usuario && usuario !== prevRow.Usuario)
                    diffs.push(`Login: "${_fmt(prevRow.Usuario)}" → "${_fmt(usuario)}"`);
                if (email !== undefined && email !== prevRow.Email)
                    diffs.push(`Email: "${_fmt(prevRow.Email)}" → "${_fmt(email)}"`);
                if (telefoneVal !== undefined && (telefoneVal || null) !== (prevRow.Telefone || null))
                    diffs.push(`Telefone: "${_fmt(prevRow.Telefone)}" → "${_fmt(telefoneVal)}"`);
                const novoTipo = tipoUsuario || currentTipoUsuario;
                if (novoTipo && novoTipo !== prevRow.TipoUsuario)
                    diffs.push(`Tipo: "${_fmt(prevRow.TipoUsuario)}" → "${_fmt(novoTipo)}"`);
                if (ativoVal !== null && ativoVal !== (prevRow.Ativo ? 1 : 0))
                    diffs.push(`Ativo: ${prevRow.Ativo ? 'sim' : 'não'} → ${ativoVal ? 'sim' : 'não'}`);
                if (req.body.dataInicioLicenca !== undefined) {
                    const prevDi = _fmtD(prevRow.DataInicioLicenca);
                    const newDi  = req.body.dataInicioLicenca ? _fmtD(new Date(req.body.dataInicioLicenca)) : '(vazio)';
                    if (prevDi !== newDi) diffs.push(`Início licença: ${prevDi} → ${newDi}`);
                }
                if (req.body.dataFimLicenca !== undefined) {
                    const prevDf = _fmtD(prevRow.DataFimLicenca);
                    const newDf  = req.body.dataFimLicenca ? _fmtD(new Date(req.body.dataFimLicenca)) : '(vazio)';
                    if (prevDf !== newDf) diffs.push(`Fim licença: ${prevDf} → ${newDf}`);
                }
                if (planoAtivo && planoAtivo !== prevRow.PlanoAtivo)
                    diffs.push(`Plano: "${_fmt(prevRow.PlanoAtivo)}" → "${_fmt(planoAtivo)}"`);
                if (senha) diffs.push('Senha: alterada');
                const acaoMsg = diffs.length
                    ? `[${reqLogin}] alterou "${targetLogin}": ${diffs.join(' | ')}`
                    : `[${reqLogin}] salvou "${targetLogin}" (sem alterações detectadas)`;
                await sql.query`
                    INSERT INTO HistoricoUsuarios (UsuarioId, DataAlteracao, Acao)
                    VALUES (${req.body.usuarioId}, GETDATE(), ${acaoMsg})
                `;
            }
        } else {
            // Novo usuário - master ou administrador podem criar
            const _reqTipoNovoCriar = (currentUser.TipoUsuario || '').toLowerCase();
            const _podecriar = _reqTipoNovoCriar === 'master' || _reqTipoNovoCriar === 'administrador' || _reqTipoNovoCriar === 'admin';
            if (!_podecriar) {
                return res.json({ success: false, message: 'Apenas usuários master ou administrador podem criar novos usuários' });
            }

            // Criptografar senha com bcrypt
            const hashedPassword = await bcrypt.hash(senha, parseInt(process.env.BCRYPT_SALT_ROUNDS) || 12);
            const dataInicioLicenca = req.body.dataInicioLicenca || null;
            const dataFimLicenca = req.body.dataFimLicenca || null;

            if (tipoUsuario !== 'master' && (!dataInicioLicenca || !dataFimLicenca)) {
                return res.json({ success: false, message: 'Data de início e fim da licença são obrigatórias para criar um usuário.' });
            }

            const _planoNovoUsr = planoAtivo || 'Mensal';
            const insUser = await sql.query`
                INSERT INTO Usuarios (NomeCompleto, Usuario, Email, Telefone, Senha, TipoUsuario, PlanoAtivo, DataInicioLicenca, DataFimLicenca, DataCriacao, DataAtualizacao)
                OUTPUT INSERTED.Id
                VALUES (${nomeCompleto}, ${usuario}, ${email}, ${telefoneVal || null}, ${hashedPassword}, ${tipoUsuario}, ${_planoNovoUsr}, ${dataInicioLicenca}, ${dataFimLicenca}, GETDATE(), GETDATE())
            `;
            const novoUserId = insUser.recordset[0]?.Id;

            // Copia automaticamente todos os padrões publicados (is_publicado=1) para o novo usuário
            if (novoUserId) {
                try {
                    await _ensurePadroesTable();
                    const limite = await _getMaxPadroes();
                    const pubPadroes = await sql.query`SELECT * FROM user_padroes_grafico WHERE is_publicado=1`;
                    for (const p of pubPadroes.recordset) {
                        const cnt = (await sql.query`SELECT COUNT(*) AS n FROM user_padroes_grafico WHERE user_id=${novoUserId}`).recordset[0].n;
                        if (cnt >= limite) break;
                        await sql.query`
                            INSERT INTO user_padroes_grafico (user_id, nome, filtros, publicado_por)
                            VALUES (${novoUserId}, ${p.nome}, ${p.filtros}, ${p.id})
                        `;
                    }
                } catch(_) {}
            }

            const reqLogin2 = currentUser.Usuario || `ID:${req.body.usuarioId}`;
            await sql.query`
                INSERT INTO HistoricoUsuarios (UsuarioId, DataAlteracao, Acao)
                VALUES (${req.body.usuarioId}, GETDATE(), ${'[' + reqLogin2 + '] criou usuário "' + usuario + '"'})
            `;

            // Enviar e-mail de boas-vindas via Formspree (mesmo mecanismo do formulário de contato)
            try {
                const licencaInicio = dataInicioLicenca ? new Date(dataInicioLicenca).toLocaleDateString('pt-BR') : '—';
                const licencaFim    = dataFimLicenca    ? new Date(dataFimLicenca).toLocaleDateString('pt-BR')    : '—';
                const fResp = await axios.post('https://formspree.io/f/xaqawaep', {
                    name: nomeCompleto || usuario,
                    email: email || 'sem-email@radarx.com.br',
                    _subject: `[Radardabet] Novo acesso criado: ${usuario}`,
                    message:
                        `✅ Novo acesso criado na plataforma Radardabet\n\n` +
                        `Nome: ${nomeCompleto}\n` +
                        `Usuário (login): ${usuario}\n` +
                        `E-mail: ${email || '—'}\n` +
                        `Tipo: ${tipoUsuario}\n` +
                        `Senha inicial: ${senha}\n` +
                        `Licença início: ${licencaInicio}\n` +
                        `Licença fim: ${licencaFim}\n` +
                        `Cadastrado em: ${new Date().toLocaleString('pt-BR')}`,
                }, { headers: { Accept: 'application/json', 'Content-Type': 'application/json' } });
                console.log(`📧 Formspree OK (usuário ${usuario}):`, fResp.status);
            } catch (emailErr) {
                const detail = emailErr.response ? JSON.stringify(emailErr.response.data) : emailErr.message;
                console.error(`⚠️ Falha e-mail Formspree (${usuario}):`, detail);
            }
        }

        res.json({ success: true, message: 'Usuário salvo com sucesso' });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// Incrementar licença de um usuário específico (adicionar N dias ao DataFimLicenca)
app.post('/api/usuarios/incrementar-licenca', requireAuth, async (req, res) => {
    const { id, dias, sqlConfig } = req.body;
    if (!id || !dias || isNaN(parseInt(dias)) || parseInt(dias) <= 0) {
        return res.json({ success: false, message: 'id e dias (> 0) são obrigatórios' });
    }
    try {
        await connectSQL(sqlConfig || getDatabaseConfigFromEnv());
        const reqCheck = await sql.query`SELECT TipoUsuario, Usuario FROM Usuarios WHERE Id = ${req.body.usuarioId}`;
        if (!reqCheck.recordset[0] || reqCheck.recordset[0].TipoUsuario !== 'master') {
            return res.json({ success: false, message: 'Acesso não autorizado' });
        }
        const d = parseInt(dias);
        // Se já tem data fim, soma a partir dela; senão usa hoje
        await sql.query`
            UPDATE Usuarios
            SET DataFimLicenca = DATEADD(day, ${d}, ISNULL(DataFimLicenca, CAST(GETDATE() AS DATE)))
            WHERE Id = ${id}
        `;
        const atualizado = await sql.query`SELECT DataFimLicenca FROM Usuarios WHERE Id = ${id}`;
        const novaData = atualizado.recordset[0]?.DataFimLicenca;
        const targetRow = await sql.query`SELECT Usuario FROM Usuarios WHERE Id = ${id}`;
        const targetLogin = targetRow.recordset[0]?.Usuario || `ID:${id}`;
        const reqLogin = reqCheck.recordset[0].Usuario;
        await sql.query`
            INSERT INTO HistoricoUsuarios (UsuarioId, DataAlteracao, Acao)
            VALUES (${req.body.usuarioId}, GETDATE(), ${`[${reqLogin}] adicionou ${d} dias à licença de "${targetLogin}" → ${novaData ? new Date(novaData).toLocaleDateString('pt-BR') : '?'}`})
        `;
        res.json({ success: true, novaData: novaData ? new Date(novaData).toISOString() : null });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// Incrementar licença de TODOS os usuários ativos (exceto master)
app.post('/api/usuarios/incrementar-licenca-todos', requireAuth, async (req, res) => {
    const { dias, sqlConfig } = req.body;
    if (!dias || isNaN(parseInt(dias)) || parseInt(dias) <= 0) {
        return res.json({ success: false, message: 'dias (> 0) é obrigatório' });
    }
    try {
        await connectSQL(sqlConfig || getDatabaseConfigFromEnv());
        const reqCheck = await sql.query`SELECT TipoUsuario, Usuario FROM Usuarios WHERE Id = ${req.body.usuarioId}`;
        if (!reqCheck.recordset[0] || reqCheck.recordset[0].TipoUsuario !== 'master') {
            return res.json({ success: false, message: 'Acesso não autorizado' });
        }
        const d = parseInt(dias);
        const result = await sql.query`
            UPDATE Usuarios
            SET DataFimLicenca = DATEADD(day, ${d}, ISNULL(DataFimLicenca, CAST(GETDATE() AS DATE)))
            WHERE Ativo = 1 AND TipoUsuario <> 'master'
        `;
        const afetados = result.rowsAffected?.[0] ?? 0;
        const reqLogin = reqCheck.recordset[0].Usuario;
        await sql.query`
            INSERT INTO HistoricoUsuarios (UsuarioId, DataAlteracao, Acao)
            VALUES (${req.body.usuarioId}, GETDATE(), ${`[${reqLogin}] adicionou ${d} dias à licença de todos os usuários ativos (${afetados} usuários)`})
        `;
        res.json({ success: true, afetados });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// Rota para excluir usuário
app.post('/api/usuarios/delete', requireAuth, async (req, res) => {
    const { id, sqlConfig } = req.body;

    try {
        await connectSQL(sqlConfig || getDatabaseConfigFromEnv());

        // Apenas masters podem excluir usuários
        const userCheck = await sql.query`
            SELECT TipoUsuario, Usuario FROM Usuarios WHERE Id = ${req.body.usuarioId}
        `;

        if (userCheck.recordset.length === 0 || userCheck.recordset[0].TipoUsuario !== 'master') {
            return res.json({ success: false, message: 'Acesso não autorizado' });
        }

        // Não permitir excluir a si mesmo
        if (parseInt(id) === req.body.usuarioId) {
            return res.json({ success: false, message: 'Não é possível excluir seu próprio usuário' });
        }

        // Obter login do alvo ANTES de excluir
        const targetRow = await sql.query`SELECT Usuario FROM Usuarios WHERE Id = ${id}`;
        const targetLoginDel = targetRow.recordset[0]?.Usuario || `ID:${id}`;
        const reqLoginDel = userCheck.recordset[0].Usuario || `ID:${req.body.usuarioId}`;

        await sql.query`DELETE FROM Usuarios WHERE Id = ${id}`;

        await sql.query`
            INSERT INTO HistoricoUsuarios (UsuarioId, DataAlteracao, Acao)
            VALUES (${req.body.usuarioId}, GETDATE(), ${'[' + reqLoginDel + '] excluiu usuário "' + targetLoginDel + '"'})
        `;

        res.json({ success: true, message: 'Usuário excluído com sucesso' });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

const path = require('path');

// ─────────────────────────────────────────────────────────────
// PADRÕES DE GRÁFICO — por usuário
// ─────────────────────────────────────────────────────────────
let _padroesMigrated = false;
async function _ensurePadroesTable() {
    if (_padroesMigrated) return;
    await sql.query`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='user_padroes_grafico' AND xtype='U')
        CREATE TABLE user_padroes_grafico (
            id               INT IDENTITY(1,1) PRIMARY KEY,
            user_id          INT            NOT NULL,
            nome             NVARCHAR(100)  NOT NULL,
            filtros          NVARCHAR(MAX)  NOT NULL DEFAULT '{}',
            is_principal     BIT            NOT NULL DEFAULT 0,
            data_criacao     DATETIME2      DEFAULT GETUTCDATE(),
            data_atualizacao DATETIME2      DEFAULT GETUTCDATE()
        )
    `;
    // Garante filtros NVARCHAR(MAX): dropa DEFAULT constraint antes de alterar (SQL Server exige)
    try {
        const _dfRow = await sql.query`
            SELECT dc.name FROM sys.default_constraints dc
            JOIN sys.columns c ON dc.parent_object_id=c.object_id AND dc.parent_column_id=c.column_id
            JOIN sys.objects o ON c.object_id=o.object_id
            WHERE o.name='user_padroes_grafico' AND c.name='filtros'
              AND EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
                          WHERE TABLE_NAME='user_padroes_grafico' AND COLUMN_NAME='filtros'
                          AND CHARACTER_MAXIMUM_LENGTH IS NOT NULL AND CHARACTER_MAXIMUM_LENGTH<>-1)`;
        const _dfName = _dfRow.recordset[0]?.name;
        if (_dfName) await sql.query(`ALTER TABLE user_padroes_grafico DROP CONSTRAINT [${_dfName}]`);
        await sql.query`
            IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
                       WHERE TABLE_NAME='user_padroes_grafico' AND COLUMN_NAME='filtros'
                       AND CHARACTER_MAXIMUM_LENGTH IS NOT NULL AND CHARACTER_MAXIMUM_LENGTH<>-1)
            ALTER TABLE user_padroes_grafico ALTER COLUMN filtros NVARCHAR(MAX) NOT NULL`;
        if (_dfName) await sql.query`ALTER TABLE user_padroes_grafico ADD DEFAULT ('{}') FOR filtros`;
    } catch(_) {}
    // Coluna publicado_por: referência ao padrão original quando é uma cópia publicada pelo admin
    try {
        await sql.query`
            IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS
                           WHERE TABLE_NAME='user_padroes_grafico' AND COLUMN_NAME='publicado_por')
            ALTER TABLE user_padroes_grafico ADD publicado_por INT NULL`;
    } catch(_) {}
    // Coluna is_publicado: marca o padrão original do admin como já publicado
    try {
        await sql.query`
            IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS
                           WHERE TABLE_NAME='user_padroes_grafico' AND COLUMN_NAME='is_publicado')
            ALTER TABLE user_padroes_grafico ADD is_publicado BIT NOT NULL DEFAULT 0`;
    } catch(_) {}
    _padroesMigrated = true;
}
function _isAdminTipo(tipo) {
    return ['master', 'admin', 'administrador'].includes((tipo || '').toLowerCase());
}
let _maxPadroesCache = null, _maxPadroesCacheTs = 0;
async function _getMaxPadroes() {
    if (_maxPadroesCache !== null && Date.now() - _maxPadroesCacheTs < 60000) return _maxPadroesCache;
    try {
        const { getSystemConfig } = require('./routes/bet365-api');
        const cfg = await getSystemConfig();
        _maxPadroesCache = Math.max(1, Math.min(10, parseInt(cfg.max_padroes_usuario) || 5));
        _maxPadroesCacheTs = Date.now();
        return _maxPadroesCache;
    } catch(_) { return 5; }
}

// Listar padrões do usuário
app.get('/api/usuario/padroes', requireAuthQuery, async (req, res) => {
    const usuarioId = parseInt(req.query.usuarioId);
    if (!usuarioId) return res.json({ success: false, message: 'usuarioId obrigatório' });
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        const r = await sql.query`
            SELECT id, nome, filtros, is_principal, data_criacao, publicado_por, is_publicado
            FROM user_padroes_grafico
            WHERE user_id = ${usuarioId}
            ORDER BY is_principal DESC, data_criacao ASC
        `;
        const uRow = (await sql.query`SELECT TipoUsuario FROM Usuarios WHERE Id=${usuarioId}`).recordset[0];
        const isMaster = (uRow?.TipoUsuario || '').toLowerCase() === 'master';
        const limite = isMaster ? null : await _getMaxPadroes();
        res.json({ success: true, padroes: r.recordset, limite });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

// Criar padrão
app.post('/api/usuario/padroes', requireAuth, async (req, res) => {
    const { usuarioId, nome, filtros } = req.body;
    if (!usuarioId || !nome || !filtros) return res.json({ success: false, message: 'Dados incompletos' });
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        await _ensurePadroesTable();
        const uRow = (await sql.query`SELECT TipoUsuario FROM Usuarios WHERE Id=${usuarioId}`).recordset[0];
        const isMaster = (uRow?.TipoUsuario || '').toLowerCase() === 'master';
        if (!isMaster) {
            const limite = await _getMaxPadroes();
            const cnt = (await sql.query`SELECT COUNT(*) AS n FROM user_padroes_grafico WHERE user_id=${usuarioId}`).recordset[0].n;
            if (cnt >= limite) return res.json({ success: false, message: `Limite de ${limite} padrões atingido` });
        }
        const fs = typeof filtros === 'string' ? filtros : JSON.stringify(filtros);
        const r = await sql.query`
            INSERT INTO user_padroes_grafico (user_id, nome, filtros)
            OUTPUT INSERTED.id VALUES (${usuarioId}, ${nome}, ${fs})
        `;
        res.json({ success: true, id: r.recordset[0].id });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

// Atualizar padrão (nome/filtros) ou definir principal — propaga para cópias publicadas
app.put('/api/usuario/padroes/:id', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id);
    const { usuarioId, nome, filtros, is_principal } = req.body;
    if (!usuarioId || !id) return res.json({ success: false, message: 'Dados incompletos' });
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        await _ensurePadroesTable();
        if (is_principal) {
            await sql.query`UPDATE user_padroes_grafico SET is_principal=0 WHERE user_id=${usuarioId}`;
            await sql.query`UPDATE user_padroes_grafico SET is_principal=1, data_atualizacao=GETUTCDATE() WHERE id=${id} AND user_id=${usuarioId}`;
        }
        if (nome && filtros) {
            const fs = typeof filtros === 'string' ? filtros : JSON.stringify(filtros);
            await sql.query`UPDATE user_padroes_grafico SET nome=${nome}, filtros=${fs}, data_atualizacao=GETUTCDATE() WHERE id=${id} AND user_id=${usuarioId}`;
            // Propaga alterações para todas as cópias publicadas deste padrão
            await sql.query`UPDATE user_padroes_grafico SET nome=${nome}, filtros=${fs}, data_atualizacao=GETUTCDATE() WHERE publicado_por=${id}`;
        }
        res.json({ success: true });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

// Apagar padrão — bloqueia se for cópia recebida de um admin (publicado_por IS NOT NULL)
app.delete('/api/usuario/padroes/:id', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id);
    const usuarioId = parseInt(req.body.usuarioId || req.query.usuarioId);
    if (!usuarioId || !id) return res.json({ success: false, message: 'Dados incompletos' });
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        await _ensurePadroesTable();
        const chk = await sql.query`SELECT publicado_por FROM user_padroes_grafico WHERE id=${id} AND user_id=${usuarioId}`;
        if (chk.recordset.length && chk.recordset[0].publicado_por != null) {
            return res.json({ success: false, message: 'Padrão publicado pelo administrador não pode ser excluído' });
        }
        await sql.query`DELETE FROM user_padroes_grafico WHERE id=${id} AND user_id=${usuarioId}`;
        res.json({ success: true });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

// Publicar padrão para todos os usuários ativos (somente master/admin)
app.post('/api/padroes/publicar/:id', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id);
    const { usuarioId } = req.body;
    if (!usuarioId || !id) return res.json({ success: false, message: 'Dados incompletos' });
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        await _ensurePadroesTable();
        // Verifica tipo do usuário solicitante
        const uRow = await sql.query`SELECT TipoUsuario FROM Usuarios WHERE id=${usuarioId}`;
        if (!uRow.recordset.length || !_isAdminTipo(uRow.recordset[0].TipoUsuario)) {
            return res.json({ success: false, message: 'Permissão insuficiente' });
        }
        // Busca o padrão original
        const pRow = await sql.query`SELECT * FROM user_padroes_grafico WHERE id=${id} AND user_id=${usuarioId}`;
        if (!pRow.recordset.length) return res.json({ success: false, message: 'Padrão não encontrado' });
        const p = pRow.recordset[0];
        // Marca como publicado
        await sql.query`UPDATE user_padroes_grafico SET is_publicado=1 WHERE id=${id}`;
        const limite = await _getMaxPadroes();
        // Usuários ativos que ainda não têm cópia deste padrão
        const usuarios = await sql.query`SELECT id FROM Usuarios WHERE id <> ${usuarioId} AND Ativo=1`;
        let copiados = 0, pulados = 0;
        for (const u of usuarios.recordset) {
            const jaExiste = await sql.query`SELECT 1 AS n FROM user_padroes_grafico WHERE publicado_por=${id} AND user_id=${u.id}`;
            if (jaExiste.recordset.length) continue;
            const cnt = (await sql.query`SELECT COUNT(*) AS n FROM user_padroes_grafico WHERE user_id=${u.id}`).recordset[0].n;
            if (cnt >= limite) { pulados++; continue; }
            await sql.query`
                INSERT INTO user_padroes_grafico (user_id, nome, filtros, publicado_por)
                VALUES (${u.id}, ${p.nome}, ${p.filtros}, ${id})
            `;
            copiados++;
        }
        res.json({ success: true, copiados, pulados });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

// Remover padrão publicado de todos os usuários (somente master/admin)
app.delete('/api/padroes/publicar/:id', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id);
    const usuarioId = parseInt(req.body.usuarioId || req.query.usuarioId);
    if (!usuarioId || !id) return res.json({ success: false, message: 'Dados incompletos' });
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        await _ensurePadroesTable();
        const uRow = await sql.query`SELECT TipoUsuario FROM Usuarios WHERE id=${usuarioId}`;
        if (!uRow.recordset.length || !_isAdminTipo(uRow.recordset[0].TipoUsuario)) {
            return res.json({ success: false, message: 'Permissão insuficiente' });
        }
        // Verifica que o padrão pertence a este admin
        const pRow = await sql.query`SELECT id FROM user_padroes_grafico WHERE id=${id} AND user_id=${usuarioId}`;
        if (!pRow.recordset.length) return res.json({ success: false, message: 'Padrão não encontrado' });
        // Remove todas as cópias e desmarca o original
        const del = await sql.query`DELETE FROM user_padroes_grafico WHERE publicado_por=${id}`;
        await sql.query`UPDATE user_padroes_grafico SET is_publicado=0 WHERE id=${id}`;
        res.json({ success: true, removidos: del.rowsAffected[0] || 0 });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

// Listar todos os padrões de todos os usuários (somente master/admin)
app.get('/api/admin/padroes', requireAuth, async (req, res) => {
    const usuarioId = parseInt(req.query.usuarioId);
    if (!usuarioId) return res.json({ success: false, message: 'usuarioId obrigatório' });
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        const uRow = await sql.query`SELECT TipoUsuario FROM Usuarios WHERE id=${usuarioId}`;
        if (!uRow.recordset.length || !_isAdminTipo(uRow.recordset[0].TipoUsuario)) {
            return res.json({ success: false, message: 'Permissão insuficiente' });
        }
        await _ensurePadroesTable();
        const r = await sql.query`
            SELECT p.id, p.user_id, u.Usuario AS usuario_nome, u.TipoUsuario AS usuario_tipo,
                   p.nome, p.filtros, p.is_principal, p.is_publicado, p.publicado_por, p.data_criacao
            FROM user_padroes_grafico p
            INNER JOIN Usuarios u ON u.Id = p.user_id
            ORDER BY u.Usuario ASC, p.data_criacao ASC
        `;
        res.json({ success: true, padroes: r.recordset });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

// Excluir qualquer padrão (somente master/admin)
app.delete('/api/admin/padroes/:id', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id);
    const usuarioId = parseInt(req.body.usuarioId || req.query.usuarioId);
    if (!usuarioId || !id) return res.json({ success: false, message: 'Dados incompletos' });
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        const uRow = await sql.query`SELECT TipoUsuario FROM Usuarios WHERE id=${usuarioId}`;
        if (!uRow.recordset.length || !_isAdminTipo(uRow.recordset[0].TipoUsuario)) {
            return res.json({ success: false, message: 'Permissão insuficiente' });
        }
        await _ensurePadroesTable();
        // Se for o original publicado, remove também todas as cópias
        await sql.query`DELETE FROM user_padroes_grafico WHERE publicado_por=${id}`;
        await sql.query`DELETE FROM user_padroes_grafico WHERE id=${id}`;
        res.json({ success: true });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

// Rota de contato — encaminha para Formspree pelo backend (evita bloqueio CORS/domínio)
app.post('/api/contato', async (req, res) => {
    const { name, email, phone, message } = req.body;
    if (!name || !email || !message) {
        return res.status(400).json({ success: false, message: 'Campos obrigatórios: name, email, message' });
    }
    try {
        const r = await axios.post('https://formspree.io/f/xaqawaep', {
            name,
            email,
            phone: phone || '',
            message,
        }, { headers: { Accept: 'application/json', 'Content-Type': 'application/json' } });
        res.json({ success: true });
    } catch (err) {
        console.error('Erro ao enviar contato via Formspree:', err.message);
        res.status(500).json({ success: false, message: 'Erro ao enviar mensagem.' });
    }
});

// ──────────────────────────────────────────────────────
// SESSÕES ATIVAS — ping e listagem (master only)
// ──────────────────────────────────────────────────────

/**
 * POST /api/usuarios/ping
 * Frontend chama a cada 2 min para manter a sessão viva no mapa em memória.
 */
app.post('/api/usuarios/ping', async (req, res) => {
    const { usuarioId, usuario, nome, tipo } = req.body;
    if (!usuarioId) return res.json({ ok: false });
    const uid = String(usuarioId);
    if (forcedLogouts.has(uid)) {
        forcedLogouts.delete(uid);
        activeSessions.delete(uid);
        return res.json({ ok: false, disconnected: true });
    }
    const existing = activeSessions.get(uid) || {};
    activeSessions.set(uid, {
        ...existing,
        id: uid,
        usuario: usuario || existing.usuario || '?',
        nome: nome || existing.nome || '?',
        tipo: tipo || existing.tipo || 'user',
        lastSeen: new Date(),
        loginTime: existing.loginTime || new Date(),
        ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || existing.ip || '?',
        userAgent: existing.userAgent || req.headers['user-agent'] || '',
    });
    // Grava último acesso no banco (assíncrono, sem bloquear resposta)
    connectSQL(getDatabaseConfigFromEnv())
        .then(() => sql.query`UPDATE Usuarios SET UltimoAcesso = GETUTCDATE() WHERE Id = ${usuarioId}`)
        .catch(() => {});
    res.json({ ok: true });
});

app.post('/api/logout', async (req, res) => {
    const { usuarioId } = req.body;
    if (usuarioId) {
        const _lgtSess = activeSessions.get(String(usuarioId));
        const _lgtIp   = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
        const _lgtDur  = _lgtSess?.loginTime ? Math.round((Date.now() - new Date(_lgtSess.loginTime).getTime()) / 1000) : null;
        activeSessions.delete(String(usuarioId));
        // Invalida token persistido no banco
        sqlConnectionPool.request()
            .input('id', usuarioId)
            .query('UPDATE Usuarios SET sess_token = NULL, sess_expira = NULL WHERE Id = @id')
            .catch(() => {});
        _geoLookup(_lgtIp).then(geo => _registrarAcesso(usuarioId, _lgtSess?.usuario || '?', 'logout', _lgtIp, req.headers['user-agent'], geo, _lgtDur)).catch(()=>{});
    }
    res.clearCookie('sess');
    res.json({ success: true });
});

app.post('/api/usuarios/desconectar-todos', requireAuth, async (req, res) => {
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        const check = await sql.query`SELECT TipoUsuario FROM Usuarios WHERE Id = ${req.body.usuarioId}`;
        if (!check.recordset.length || check.recordset[0].TipoUsuario !== 'master') {
            return res.json({ success: false, message: 'Acesso negado' });
        }
        let removidos = 0;
        for (const [key, s] of activeSessions.entries()) {
            if (s.tipo !== 'master') {
                const _dur = s.loginTime ? Math.round((Date.now() - new Date(s.loginTime).getTime()) / 1000) : null;
                activeSessions.delete(key);
                forcedLogouts.add(key);
                removidos++;
                _geoLookup(s.ip).then(geo => _registrarAcesso(s.id, s.usuario, 'desconectado', s.ip, s.userAgent, geo, _dur)).catch(()=>{});
            }
        }
        res.json({ success: true, removidos });
    } catch(e) {
        res.json({ success: false, message: e.message });
    }
});

/**
 * POST /api/usuarios/desconectar/:id
 * Desconecta um usuário específico (exceto master). Apenas para master.
 */
app.post('/api/usuarios/desconectar/:id', requireAuth, async (req, res) => {
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        const check = await sql.query`SELECT TipoUsuario FROM Usuarios WHERE Id = ${req.body.usuarioId}`;
        if (!check.recordset.length || check.recordset[0].TipoUsuario !== 'master') {
            return res.json({ success: false, message: 'Acesso negado' });
        }
        const targetId = String(req.params.id);
        const target = activeSessions.get(targetId);
        if (target && target.tipo === 'master') {
            return res.json({ success: false, message: 'Não é possível desconectar um Master' });
        }
        if (target) {
            const _dur = target.loginTime ? Math.round((Date.now() - new Date(target.loginTime).getTime()) / 1000) : null;
            activeSessions.delete(targetId);
            forcedLogouts.add(targetId);
            _geoLookup(target.ip).then(geo => _registrarAcesso(target.id, target.usuario, 'desconectado', target.ip, target.userAgent, geo, _dur)).catch(()=>{});
        } else {
            activeSessions.delete(targetId);
            forcedLogouts.add(targetId);
        }
        res.json({ success: true });
    } catch(e) {
        res.json({ success: false, message: e.message });
    }
});

/**
 * POST /api/usuarios/online-detalhe
 * Retorna sessões ativas enriquecidas com geo, device, login stats. Apenas para master.
 */
app.post('/api/usuarios/online-detalhe', requireAuth, async (req, res) => {
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        const chk = await sql.query`SELECT TipoUsuario FROM Usuarios WHERE Id = ${req.body.usuarioId}`;
        const _onlineTipo = (chk.recordset[0]?.TipoUsuario || '').toLowerCase();
        if (!chk.recordset.length || (_onlineTipo !== 'master' && _onlineTipo !== 'administrador' && _onlineTipo !== 'admin')) {
            return res.json({ success: false, message: 'Acesso negado' });
        }
        const limite = Date.now() - 15 * 60 * 1000;
        const ativos = [...activeSessions.values()]
            .filter(s => s.lastSeen.getTime() >= limite)
            .sort((a, b) => b.lastSeen - a.lastSeen);

        // Busca UltimoAcesso do banco para todos os usuários ativos de uma vez
        const ids = ativos.map(s => s.id).filter(Boolean);
        let ultimoAcessoMap = {};
        if (ids.length) {
            try {
                const uaReq = sql.request();
                ids.forEach((id, i) => uaReq.input(`uid${i}`, sql.Int, parseInt(String(id), 10)));
                const uaPlaceholders = ids.map((_, i) => `@uid${i}`).join(',');
                const uaRes = await uaReq.query(`SELECT Id, UltimoAcesso FROM Usuarios WHERE Id IN (${uaPlaceholders})`);
                uaRes.recordset.forEach(r => { ultimoAcessoMap[String(r.Id)] = r.UltimoAcesso; });
            } catch(_) {}
        }

        const enriched = await Promise.all(ativos.map(async s => {
            const geo  = await _geoLookup(s.ip);
            const device = _parseUA(s.userAgent || '');
            const hist = loginHistory.get(s.id) || { countToday: 0 };
            const fails = (loginFailures.get((s.usuario||'').toLowerCase()) || [])
                .filter(f => Date.now() - f.ts < 60 * 60 * 1000).length;
            const ua = ultimoAcessoMap[String(s.id)];
            return {
                id: s.id, usuario: s.usuario, nome: s.nome, tipo: s.tipo,
                ip: s.ip, userAgent: s.userAgent||'',
                lastSeen: s.lastSeen.toISOString(),
                loginTime: s.loginTime ? s.loginTime.toISOString() : null,
                ultimoAcesso: ua ? new Date(ua).toISOString() : null,
                geo, device,
                loginsHoje: hist.countToday || 0,
                falhasUltimaHora: fails,
            };
        }));

        res.json({ success: true, total: enriched.length, data: enriched });
    } catch(e) {
        res.json({ success: false, message: e.message });
    }
});

/**
 * POST /api/usuarios/ativos
 * Retorna usuários com lastSeen nos últimos 15 min. Apenas para master.
 */
app.post('/api/usuarios/ativos', requireAuth, async (req, res) => {
    try {
        // Verifica se o solicitante é master
        await connectSQL(getDatabaseConfigFromEnv());
        const chk = await sql.query`SELECT TipoUsuario FROM Usuarios WHERE Id = ${req.body.usuarioId}`;
        if (!chk.recordset.length || chk.recordset[0].TipoUsuario !== 'master') {
            return res.json({ success: false, message: 'Acesso negado' });
        }

        const limite = Date.now() - 15 * 60 * 1000;
        const ativos = [...activeSessions.values()]
            .filter(s => s.lastSeen.getTime() >= limite)
            .sort((a, b) => b.lastSeen - a.lastSeen);

        res.json({ success: true, total: ativos.length, data: ativos });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ── PREFERÊNCIAS DO USUÁRIO ─────────────────────────────────────────────────

app.get('/api/preferencias', requireAuthQuery, async (req, res) => {
    try {
        const uid = req.sessionUser?.id || req.query?.usuarioId;
        if (!uid) return res.json({ success: false, message: 'Não autenticado' });
        await connectSQL(getDatabaseConfigFromEnv());
        const r = await sql.query`SELECT Chave, Valor FROM usuario_preferencias WHERE UsuarioId = ${Number(uid)}`;
        const prefs = {};
        r.recordset.forEach(row => { prefs[row.Chave] = row.Valor; });
        res.json({ success: true, data: prefs });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/preferencias', requireAuth, async (req, res) => {
    try {
        const uid = req.sessionUser?.id || req.body?.usuarioId;
        if (!uid) return res.json({ success: false, message: 'Não autenticado' });
        const { prefs } = req.body;
        if (!prefs || typeof prefs !== 'object') return res.json({ success: false, message: 'Payload inválido' });
        await connectSQL(getDatabaseConfigFromEnv());
        for (const [chave, valor] of Object.entries(prefs)) {
            if (!chave || chave.length > 100) continue;
            const valorStr = valor === null || valor === undefined ? null : String(valor);
            await sqlConnectionPool.request()
                .input('uid',   sql.Int,              Number(uid))
                .input('chave', sql.NVarChar(100),    chave)
                .input('valor', sql.NVarChar(sql.MAX), valorStr)
                .query(`MERGE usuario_preferencias AS t
                    USING (SELECT @uid AS UsuarioId, @chave AS Chave) AS s
                    ON t.UsuarioId = s.UsuarioId AND t.Chave = s.Chave
                    WHEN MATCHED THEN UPDATE SET Valor = @valor, AtualizadoEm = GETUTCDATE()
                    WHEN NOT MATCHED THEN INSERT (UsuarioId, Chave, Valor) VALUES (@uid, @chave, @valor);`);
        }
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/usuarios/historico-acessos
 * Retorna histórico paginado e filtrado. Apenas master.
 */
app.post('/api/usuarios/historico-acessos', requireAuth, async (req, res) => {
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        const chk = await sql.query`SELECT TipoUsuario FROM Usuarios WHERE Id = ${req.body.usuarioId}`;
        const _tipoChk = (chk.recordset[0]?.TipoUsuario || '').toLowerCase();
        if (!chk.recordset.length || !['master','admin','administrador'].includes(_tipoChk)) {
            return res.json({ success: false, message: 'Acesso negado' });
        }
        const { usuario = '', tipo = '', dataInicio = '', dataFim = '', pagina = 1, porPagina = 50 } = req.body;
        const pp  = Math.min(200, Math.max(1, Number(porPagina)));
        const off = (Math.max(1, Number(pagina)) - 1) * pp;

        const cntReq = sqlConnectionPool.request();
        const mainReq = sqlConnectionPool.request();
        const wheres = [];
        if (usuario)    { wheres.push('(h.usuario LIKE @usuario OR h.ip LIKE @usuario)'); cntReq.input('usuario', sql.NVarChar, `%${usuario}%`); mainReq.input('usuario', sql.NVarChar, `%${usuario}%`); }
        if (tipo)       { wheres.push('h.tipo = @tipo');       cntReq.input('tipo', sql.NVarChar, tipo);       mainReq.input('tipo', sql.NVarChar, tipo); }
        if (dataInicio) { wheres.push('h.data_hora >= @di');   cntReq.input('di', sql.DateTime2, new Date(dataInicio)); mainReq.input('di', sql.DateTime2, new Date(dataInicio)); }
        if (dataFim)    { wheres.push('h.data_hora <= @df');   cntReq.input('df', sql.DateTime2, new Date(dataFim));    mainReq.input('df', sql.DateTime2, new Date(dataFim)); }
        const w = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

        const cntResult = await cntReq.query(`SELECT COUNT(*) AS total FROM HistoricoAcessos h ${w}`);
        const total = cntResult.recordset[0].total;

        mainReq.input('off', sql.Int, off);
        mainReq.input('pp',  sql.Int, pp);
        const rows = await mainReq.query(`
            SELECT h.id, h.usuario_id, h.usuario, h.tipo, h.ip, h.user_agent, h.data_hora,
                   h.cidade, h.pais, h.provedor, h.duracao_seg,
                   u.UltimoAcesso AS ultimo_acesso
            FROM HistoricoAcessos h
            LEFT JOIN Usuarios u ON u.Id = h.usuario_id
            ${w}
            ORDER BY h.data_hora DESC
            OFFSET @off ROWS FETCH NEXT @pp ROWS ONLY
        `);
        res.json({ success: true, total, pagina: Number(pagina), porPagina: pp, data: rows.recordset });
    } catch(e) {
        res.json({ success: false, message: e.message });
    }
});

/**
 * POST /api/usuarios/historico-limpar
 * Remove registros mais antigos que N dias. Apenas master.
 */
app.post('/api/usuarios/historico-limpar', requireAuth, async (req, res) => {
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        const chk = await sql.query`SELECT TipoUsuario FROM Usuarios WHERE Id = ${req.body.usuarioId}`;
        const _tipoChk2 = (chk.recordset[0]?.TipoUsuario || '').toLowerCase();
        if (!chk.recordset.length || !['master','admin','administrador'].includes(_tipoChk2)) {
            return res.json({ success: false, message: 'Acesso negado' });
        }
        const dias = Math.max(1, Number(req.body.dias) || 30);
        const r = await sql.query`
            DELETE FROM HistoricoAcessos WHERE data_hora < DATEADD(DAY, -${dias}, GETUTCDATE())
        `;
        res.json({ success: true, removidos: r.rowsAffected[0] || 0 });
    } catch(e) {
        res.json({ success: false, message: e.message });
    }
});

/**
 * POST /api/usuarios/historico-alteracoes
 * Retorna histórico de alterações de usuários paginado. Apenas master.
 */
app.post('/api/usuarios/historico-alteracoes', requireAuth, async (req, res) => {
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        const chk = await sql.query`SELECT TipoUsuario FROM Usuarios WHERE Id = ${req.body.usuarioId}`;
        if (!chk.recordset.length || (chk.recordset[0].TipoUsuario || '').toLowerCase() !== 'master') {
            return res.json({ success: false, message: 'Acesso negado' });
        }
        const { busca = '', dataInicio = '', dataFim = '', pagina = 1, porPagina = 50 } = req.body;
        const pp  = Math.min(200, Math.max(1, Number(porPagina)));
        const off = (Math.max(1, Number(pagina)) - 1) * pp;

        const cntReq  = sqlConnectionPool.request();
        const mainReq = sqlConnectionPool.request();
        const wheres = [];

        if (busca) {
            wheres.push('h.Acao LIKE @busca');
            cntReq.input('busca',  sql.NVarChar, `%${busca}%`);
            mainReq.input('busca', sql.NVarChar, `%${busca}%`);
        }
        if (dataInicio) {
            wheres.push('h.DataAlteracao >= @di');
            cntReq.input('di',  sql.DateTime2, new Date(dataInicio));
            mainReq.input('di', sql.DateTime2, new Date(dataInicio));
        }
        if (dataFim) {
            wheres.push('h.DataAlteracao <= @df');
            cntReq.input('df',  sql.DateTime2, new Date(dataFim));
            mainReq.input('df', sql.DateTime2, new Date(dataFim));
        }
        const w = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

        const cntResult = await cntReq.query(`SELECT COUNT(*) AS total FROM HistoricoUsuarios h ${w}`);
        const total = cntResult.recordset[0].total;

        mainReq.input('off', sql.Int, off);
        mainReq.input('pp',  sql.Int, pp);
        const rows = await mainReq.query(`
            SELECT h.UsuarioId, h.DataAlteracao, h.Acao, u.Usuario AS QuemFez
            FROM HistoricoUsuarios h
            LEFT JOIN Usuarios u ON u.Id = h.UsuarioId
            ${w}
            ORDER BY h.DataAlteracao DESC
            OFFSET @off ROWS FETCH NEXT @pp ROWS ONLY
        `);

        res.json({ success: true, total, pagina: Number(pagina), porPagina: pp, data: rows.recordset });
    } catch(e) {
        res.json({ success: false, message: e.message });
    }
});

// Rota principal para servir o portfolio.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/portifolio.html'));
});

// Rota para servir o RadarX (painel de futebol virtual)
app.get('/radardabet.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, '../frontend/radardabet.html'));
});

// Página de boas-vindas após pagamento Kirvano
app.get('/bem-vindo', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, '../frontend/bem-vindo.html'));
});

// Rota para servir o index.html (painel de controle) após o login
app.get('/dashboard', (req, res) => {
    // Verificar se o usuário está autenticado consultando o localStorage do lado do cliente
    // Como isso é feito no frontend, simplesmente enviamos o arquivo e deixamos a verificação ser feita no frontend
    // Mas podemos adicionar uma verificação de autenticação mais robusta se implementarmos backend de sessão
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Rota para servir o index.html para outras rotas específicas (mantendo compatibilidade)
app.get('/index.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Servir pasta /img da raiz do projeto (logo RadarX etc.)
app.use('/img', express.static(path.join(__dirname, '../img')));

// Servir arquivos estáticos — HTML sem cache, demais com cache normal
app.use(express.static(path.join(__dirname, '../frontend'), {
    setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// ── Chat: garante tabela no banco ───────────────────────────
async function _garantirTabelaChat() {
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        await sql.query`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='chat_mensagens' AND xtype='U')
            CREATE TABLE chat_mensagens (
                id           INT IDENTITY(1,1) PRIMARY KEY,
                usuario_id   INT,
                usuario_nome NVARCHAR(100),
                mensagem     NVARCHAR(1000),
                criado_em    DATETIME2 DEFAULT GETUTCDATE()
            )`;
        console.log('✅ Tabela chat_mensagens OK');
    } catch(e) { console.warn('⚠️  chat_mensagens:', e.message); }
}
_garantirTabelaChat();

// ── Chat: histórico das últimas N horas ─────────────────────
app.get('/api/chat/historico', requireAuth, async (req, res) => {
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        const cfgH = await sql.query`SELECT valor FROM bet365_config WHERE chave='chat_historico_horas'`;
        const horas = Math.max(1, Math.min(168, parseInt(cfgH.recordset[0]?.valor) || 24));
        const r = await sql.query`
            SELECT TOP 200 id, usuario_id, usuario_nome, mensagem, criado_em
            FROM chat_mensagens
            WHERE criado_em >= DATEADD(HOUR, -${horas}, GETUTCDATE())
            ORDER BY criado_em ASC`;
        res.json({ success: true, mensagens: r.recordset });
    } catch(e) { res.json({ success: false, error: e.message }); }
});

// Rota curinga para servir o portifolio.html para todas as outras rotas (exceto API e rotas específicas)
app.get('*', (req, res) => {
    // Verificar se é uma tentativa de acesso direto a recurso ou rota de API
    if (
        req.path.startsWith('/api/') ||
        req.path.startsWith('/static/')
    ) {
        // Para rotas de API, responder com erro de não encontrado
        // Isso será tratado pelas rotas específicas de API definidas anteriormente
        res.status(404).json({ success: false, message: 'Recurso não encontrado' });
    } else {
        // Para todas as outras rotas que não sejam as definidas explicitamente,
        // servir o portifólio.html
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.sendFile(path.join(__dirname, '../frontend/portifolio.html'));
    }
});

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// WebSocket Server
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
    console.log('🔌 WebSocket cliente conectado');
    ws.send(JSON.stringify({ tipo: 'conectado', timestamp: new Date().toISOString() }));

    ws.on('message', async (raw) => {
        try {
            const m = JSON.parse(raw.toString());
            if (m.tipo === 'chat' && m.mensagem && m.mensagem.trim()) {
                const texto = m.mensagem.trim().substring(0, 500);
                const nome  = (m.usuario_nome || 'Anônimo').substring(0, 100);
                const uid   = m.usuario_id ? parseInt(m.usuario_id) : null;
                const agora = new Date().toISOString();

                try {
                    await connectSQL(getDatabaseConfigFromEnv());
                    await sql.query`
                        INSERT INTO chat_mensagens (usuario_id, usuario_nome, mensagem)
                        VALUES (${uid}, ${nome}, ${texto})`;
                } catch(e) { console.warn('chat save:', e.message); }

                global.wsBroadcast({ tipo:'chat', usuario_nome:nome, usuario_id:uid, mensagem:texto, criado_em:agora });
            }
        } catch(_) {}
    });

    ws.on('close', () => console.log('🔌 WebSocket cliente desconectado'));
    ws.on('error', (err) => console.error('WebSocket erro:', err.message));
});

// Função global de broadcast (usada pelo coletor)
global.wsBroadcast = (dados) => {
    const msg = JSON.stringify(dados);
    wss.clients.forEach(client => {
        if (client.readyState === 1) { // OPEN
            client.send(msg);
        }
    });
};

server.listen(PORT, () => {
    console.log(`🚀 Backend rodando na porta ${PORT}`);
    console.log(`🌐 Acesse: http://localhost:${PORT}`);
    console.log(`🔌 WebSocket: ws://localhost:${PORT}/ws`);
    // Garante colunas de licença e Telefone na tabela Usuarios
    (async () => {
        try {
            await connectSQL(getDatabaseConfigFromEnv());
            await sql.query`
                IF NOT EXISTS (
                    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_NAME = 'Usuarios' AND COLUMN_NAME = 'Telefone'
                )
                    ALTER TABLE Usuarios ADD Telefone NVARCHAR(20) NULL
            `;
            await sql.query`
                IF NOT EXISTS (
                    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_NAME = 'Usuarios' AND COLUMN_NAME = 'DataInicioLicenca'
                )
                    ALTER TABLE Usuarios ADD DataInicioLicenca DATETIME2 NULL
            `;
            await sql.query`
                IF NOT EXISTS (
                    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_NAME = 'Usuarios' AND COLUMN_NAME = 'DataFimLicenca'
                )
                    ALTER TABLE Usuarios ADD DataFimLicenca DATETIME2 NULL
            `;
            await sql.query`
                IF NOT EXISTS (
                    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_NAME = 'Usuarios' AND COLUMN_NAME = 'UltimoAcesso'
                )
                    ALTER TABLE Usuarios ADD UltimoAcesso DATETIME2 NULL
            `;
            await sql.query`
                IF NOT EXISTS (
                    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_NAME = 'Usuarios' AND COLUMN_NAME = 'PlanoAtivo'
                )
                    ALTER TABLE Usuarios ADD PlanoAtivo NVARCHAR(50) NULL DEFAULT 'Mensal'
            `;
        } catch(e) { console.warn('⚠️ Schema Usuarios:', e.message); }

        // Cria tabela de preferencias do usuario se nao existir
        try {
            await sql.query`
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'usuario_preferencias')
                BEGIN
                    CREATE TABLE usuario_preferencias (
                        Id           INT IDENTITY(1,1) PRIMARY KEY,
                        UsuarioId    INT NOT NULL,
                        Chave        NVARCHAR(100) NOT NULL,
                        Valor        NVARCHAR(MAX),
                        AtualizadoEm DATETIME2 DEFAULT GETUTCDATE(),
                        CONSTRAINT UQ_usuario_pref UNIQUE (UsuarioId, Chave),
                        CONSTRAINT FK_usuario_pref FOREIGN KEY (UsuarioId) REFERENCES Usuarios(Id) ON DELETE CASCADE
                    )
                    PRINT 'Tabela usuario_preferencias criada'
                END
            `;
        } catch(e) { console.warn('⚠️ usuario_preferencias:', e.message); }

        // Corrige descricao da chave youtube_video_1 (emoji causava ?? no Windows)
        try {
            await sql.query`
                UPDATE bet365_config SET descricao = 'Video 1 - URL'
                WHERE chave = 'youtube_video_1'
            `;
        } catch(e) { /* tabela pode nao existir ainda — sem problema */ }
    })();

    // Garante colunas extras de odds em bet365_eventos (Coletor 2 expansão)
    (async () => {
        try {
            await connectSQL(getDatabaseConfigFromEnv());
            const oddCols = [
                ['odd_over25',   'DECIMAL(10,2)'],
                ['odd_under25',  'DECIMAL(10,2)'],
                ['odd_btts_sim', 'DECIMAL(10,2)'],
                ['odd_btts_nao', 'DECIMAL(10,2)'],
                ['odd_ht_casa',  'DECIMAL(10,2)'],
                ['odd_ht_empate','DECIMAL(10,2)'],
                ['odd_ht_fora',  'DECIMAL(10,2)'],
            ];
            for (const [col, type] of oddCols) {
                await sql.query(`
                    IF NOT EXISTS (
                        SELECT 1 FROM sys.columns
                        WHERE object_id = OBJECT_ID('bet365_eventos') AND name = '${col}'
                    ) ALTER TABLE bet365_eventos ADD ${col} ${type} NULL
                `);
            }
        } catch(e) { console.warn('⚠️ Schema bet365_eventos odds:', e.message); }
    })();

    // Garante tabela HistoricoAcessos
    (async () => {
        try {
            await connectSQL(getDatabaseConfigFromEnv());
            await sql.query`
                IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='HistoricoAcessos' AND xtype='U')
                CREATE TABLE HistoricoAcessos (
                    id           INT IDENTITY(1,1) PRIMARY KEY,
                    usuario_id   INT NULL,
                    usuario      NVARCHAR(100) NOT NULL,
                    tipo         NVARCHAR(30)  NOT NULL,
                    ip           NVARCHAR(60),
                    user_agent   NVARCHAR(500),
                    data_hora    DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
                    cidade       NVARCHAR(100),
                    pais         NVARCHAR(10),
                    provedor     NVARCHAR(200),
                    duracao_seg  INT
                )
            `;
            // Adiciona colunas geo/duracao se a tabela já existia sem elas
            for (const [col, def] of [
                ['cidade',      'NVARCHAR(100)'],
                ['pais',        'NVARCHAR(10)'],
                ['provedor',    'NVARCHAR(200)'],
                ['duracao_seg', 'INT'],
            ]) {
                await sql.query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('HistoricoAcessos') AND name='${col}') ALTER TABLE HistoricoAcessos ADD ${col} ${def}`);
            }
            await sql.query`
                IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID('HistoricoAcessos') AND name='IX_HA_data_hora')
                    CREATE INDEX IX_HA_data_hora ON HistoricoAcessos (data_hora DESC)
            `;
            await sql.query`
                IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID('HistoricoAcessos') AND name='IX_HA_usuario_id')
                    CREATE INDEX IX_HA_usuario_id ON HistoricoAcessos (usuario_id)
            `;
            console.log('✅ Schema HistoricoAcessos verificado');
        } catch(e) { console.warn('⚠️ Schema HistoricoAcessos:', e.message); }
    })();

    // Garante tabela auditoria_requests
    (async () => {
        try {
            await sql.query`
                IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='auditoria_requests' AND xtype='U')
                BEGIN
                    CREATE TABLE auditoria_requests (
                        id         INT IDENTITY(1,1) PRIMARY KEY,
                        usuario_id INT NULL,
                        usuario    NVARCHAR(100) NOT NULL DEFAULT 'anonimo',
                        ip         NVARCHAR(45)  NOT NULL,
                        horas      INT           NOT NULL,
                        data_hora  DATETIME2     NOT NULL DEFAULT GETUTCDATE()
                    );
                    CREATE INDEX IX_ar_data ON auditoria_requests(data_hora DESC);
                    CREATE INDEX IX_ar_uid  ON auditoria_requests(usuario_id, data_hora DESC);
                END
            `;
        } catch(e) { console.warn('⚠️ Schema auditoria_requests:', e.message); }
    })();

    // Garante tabela ip_blacklist
    (async () => {
        try {
            await sql.query`
                IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='ip_blacklist' AND xtype='U')
                CREATE TABLE ip_blacklist (
                    ip            NVARCHAR(45)  NOT NULL PRIMARY KEY,
                    bloqueado_por NVARCHAR(50)  NULL,
                    bloqueado_em  DATETIME2     NOT NULL DEFAULT GETDATE()
                )
            `;
        } catch(e) { console.warn('⚠️ Schema ip_blacklist:', e.message); }
    })();

    // Carrega blacklist persistida do banco na memória
    _blacklistCarregarDB();

    // ── Inicia o agendador Bet365 junto com o servidor ──
    if (process.env.BET365_AGENDADOR_ATIVADO !== 'false') {
        const Bet365Coletor               = require('./services/bet365-coletor');
        const { getSystemConfig, getDbPool } = require('./routes/bet365-api');
        const { dispararAlerta }          = require('./services/alertas');
        const coletor365 = new Bet365Coletor();

        let _coletorTimer    = null;
        let _alertaEnviado   = false;
        let _reinicioAgendado = false;
        let _ultimaColetaOk  = Date.now(); // grace period inicial

        async function _cicloColeta() {
            const inicio = Date.now();
            await coletor365.coletar().catch(e => console.error('Bet365 coletar:', e.message));
            const cfg  = await getSystemConfig().catch(() => ({}));

            // ── Verificar alertas ──────────────────────────────────
            if (coletor365.ultimaColetaSucesso && coletor365.ultimaColetaSucesso > _ultimaColetaOk) {
                _ultimaColetaOk = coletor365.ultimaColetaSucesso;
                if (_alertaEnviado || _reinicioAgendado) {
                    _alertaEnviado    = false;
                    _reinicioAgendado = false;
                    const pool  = await getDbPool().catch(() => null);
                    const agora = new Date().toLocaleString('pt-BR');
                    dispararAlerta(cfg, pool, '✅ Coletor recuperado',
                        `O coletor voltou a funcionar normalmente.\n🕐 ${agora}`).catch(() => {});
                }
            }
            if (cfg.alerta_ativado !== 'false' && !_alertaEnviado) {
                const alertMin  = Math.max(5, parseInt(cfg.alerta_minutos_sem_coleta) || 15);
                const semColeta = (Date.now() - _ultimaColetaOk) / 60000;
                if (semColeta >= alertMin) {
                    _alertaEnviado = true;
                    const pool  = await getDbPool().catch(() => null);
                    const agora = new Date().toLocaleString('pt-BR');
                    const erro  = coletor365.ultimoErro ? `\n❌ Erro: ${coletor365.ultimoErro}` : '';
                    dispararAlerta(cfg, pool, '⚠️ Coletor parado',
                        `Sem coleta há ${Math.round(semColeta)} minuto(s).${erro}\n🕐 ${agora}`).catch(() => {});
                }
            }
            // ── Reinício automático ────────────────────────────────
            if (!_reinicioAgendado) {
                const reinicioMin = parseInt(cfg.auto_reinicio_minutos) || 0;
                if (reinicioMin > 0) {
                    const semColeta = (Date.now() - _ultimaColetaOk) / 60000;
                    if (semColeta >= reinicioMin) {
                        _reinicioAgendado = true;
                        const pool  = await getDbPool().catch(() => null);
                        const agora = new Date().toLocaleString('pt-BR');
                        console.log(`\n🔄 [AutoReinicio] Sem coleta há ${Math.round(semColeta)} min — reiniciando tudo...\n`);
                        coletor365._logAuditoria('reinicio_disparado', `Auto-restart: sem coleta há ${Math.round(semColeta)} min`);
                        dispararAlerta(cfg, pool,
                            '🔄 Reinício automático disparado',
                            `Sem coleta há ${Math.round(semColeta)} minuto(s).\nFechando Edge + Node e reiniciando tudo automaticamente.\n🕐 ${agora}`
                        ).catch(() => {});
                        // Aguarda alerta ser enviado antes de sair
                        setTimeout(() => {
                            const { spawn } = require('child_process');
                            const batPath = require('path').join(__dirname, '..', 'reiniciar-tudo.bat');
                            spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore' }).unref();
                            console.log('🔄 [AutoReinicio] reiniciar-tudo.bat disparado — encerrando servidor...');
                            process.exit(0);
                        }, 3000);
                        return; // para o ciclo aqui
                    }
                }
            }
            // ──────────────────────────────────────────────────────

            const seg   = parseInt(cfg.intervalo_coleta_seg) || 10;
            const gasto = Math.round((Date.now() - inicio) / 1000);
            const espera = Math.max(5, seg - gasto);
            console.log(`⏱️  Bet365 - próxima coleta em ${espera}s (ciclo configurado: ${seg}s, coleta levou: ${gasto}s)`);
            _coletorTimer = setTimeout(_cicloColeta, espera * 1000);
        }

        app.get('/api/status-coletor', requireAuth, (req, res) => {
            const uptime = process.uptime(), mem = process.memoryUsage(), agora = Date.now();
            const semColeta = coletor365.ultimaColetaSucesso ? Math.round((agora - coletor365.ultimaColetaSucesso) / 1000) : null;
            const fu = s => { const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),sc=Math.floor(s%60); return d>0?`${d}d ${h}h ${m}m`:h>0?`${h}h ${m}m ${sc}s`:`${m}m ${sc}s`; };
            const _c2Vivo = _c2Proc && !_c2Proc.killed && _c2Proc.exitCode === null;
            res.json({
                servidor: { uptime_fmt: fu(Math.round(uptime)), hora: new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}), memoria_mb: Math.round(mem.rss/1024/1024), heap_mb: Math.round(mem.heapUsed/1024/1024) },
                coletor:  { coletando: coletor365.coletando, total_coletas: coletor365._coletas, ultima_sucesso: coletor365.ultimaColetaSucesso ? new Date(coletor365.ultimaColetaSucesso).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}) : null, seg_sem_coleta: semColeta, ultimo_erro: coletor365.ultimoErro||null, alerta_disparado: _alertaEnviado },
                coletor2: { rodando: !!_c2Vivo }
            });
        });

        console.log(`\n📡 Bet365 - Agendador iniciado (intervalo dinâmico via config DB)\n`);
        _cicloColeta();

        // ── Coletor 2 — Odds pré-jogo (agendado por minutos configurados) ──
        // Só executa localmente (Edge acessível na porta 9222).
        // Configuração: coletor2_ativo=true e coletor2_minutos="03,18,33,48"
        // A cada minuto verificado, se o minuto atual estiver na lista, abre
        // janela CMD separada com /c (fecha ao terminar) para uma rodada de coleta.
        let _c2Rodando   = false;
        let _c2UltimoMin = -1;

        function _edgeAcessivel() {
            return new Promise(resolve => {
                const req = http.get('http://127.0.0.1:9222/json/version', res => {
                    res.resume();
                    resolve(true);
                });
                req.on('error', () => resolve(false));
                req.setTimeout(2000, () => { req.destroy(); resolve(false); });
            });
        }

        async function _autoColetorOdds() {
            if (_c2Rodando) return;
            try {
                if (!await _edgeAcessivel()) return;
                const _pool = await getDbPool();
                const _cfgR = await _pool.request().query(`
                    SELECT chave, valor FROM bet365_config
                    WHERE chave IN ('coletor2_ativo','coletor2_minutos','coletor2_janela_visivel')
                `);
                const _cfg = {};
                _cfgR.recordset.forEach(r => { _cfg[r.chave] = r.valor; });

                if (_cfg['coletor2_ativo'] === 'false') return;

                const _minutosStr = _cfg['coletor2_minutos'] || '';
                const _minutos = _minutosStr.split(',')
                    .map(m => parseInt(m.trim()))
                    .filter(m => !isNaN(m) && m >= 0 && m <= 59);
                if (_minutos.length === 0) return;

                const _minAtual = new Date().getUTCMinutes();
                if (!_minutos.includes(_minAtual)) return;
                if (_c2UltimoMin === _minAtual) return; // já disparou neste minuto
                _c2UltimoMin = _minAtual;

                _c2Rodando = true;
                const _janelaVisivel = _cfg['coletor2_janela_visivel'] !== 'false';
                console.log(`\n📊 [Coletor 2] Disparando coleta de odds — minuto ${_minAtual}${_janelaVisivel ? '' : ' (2º plano)'}...`);
                const { spawn } = require('child_process');
                const _dir2 = require('path').join(__dirname, '..');
                let proc;
                if (_janelaVisivel) {
                    const _batC2 = require('path').join(_dir2, 'start-coletor2-auto.bat');
                    proc = spawn('cmd.exe', ['/c', _batC2],
                        { detached: true, stdio: 'ignore', env: process.env }
                    );
                } else {
                    const _logC2 = require('path').join(_dir2, 'coletor2-debug.log');
                    const _logFd = require('fs').openSync(_logC2, 'w');
                    proc = spawn(process.execPath,
                        ['--require', 'dotenv/config', 'backend/services/bet365-coletor-odds.js'],
                        { cwd: _dir2, detached: true, stdio: ['ignore', _logFd, _logFd], env: process.env }
                    );
                    require('fs').closeSync(_logFd);
                }
                proc.on('exit', code => {
                    console.log(`   📊 [Coletor 2] Coleta concluída (código: ${code})`);
                    _c2Rodando = false;
                });
                proc.on('error', e => {
                    console.error(`   ❌ [Coletor 2] Erro ao iniciar: ${e.message}`);
                    _c2Rodando = false;
                });
            } catch(e) {
                console.warn(`   ⚠️  [Coletor 2] Erro: ${e.message}`);
                _c2Rodando = false;
            }
        }
        // Aguarda 3 min antes da primeira verificação — dá tempo do Coletor 1 fazer login
        setTimeout(() => {
            _autoColetorOdds();
            setInterval(_autoColetorOdds, 60000);
        }, 180000);
        // ─────────────────────────────────────────────────────────────────

        // ── Backfill automático (Coletor 3) ──────────────────────────────────
        // A cada minuto verifica se chegou o minuto configurado (coletor3_minuto_execucao).
        // Se sim, confere lacunas na hora anterior e aciona o historico.js só se necessário.
        let _backfillUltimaHora = -1;
        let _backfillRodando    = false;

        async function _autoBackfill() {
            if (_backfillRodando) return;
            try {
                if (!await _edgeAcessivel()) return;

                const pool = await getDbPool();
                const cfgR = await pool.request().query(
                    `SELECT chave, valor FROM bet365_config WHERE chave IN ('coletor3_ativo','coletor3_minuto_execucao')`
                );
                const cfg = {};
                cfgR.recordset.forEach(r => { cfg[r.chave] = r.valor; });
                if (cfg.coletor3_ativo !== 'true') return;

                const minutoAlvo = Math.max(0, Math.min(59, parseInt(cfg.coletor3_minuto_execucao) || 5));
                const agora      = new Date(Date.now() + 3600000); // Bet365 BST = UTC+1
                const minAtual   = agora.getUTCMinutes();
                const horaAtual  = agora.getUTCHours();

                if (minAtual !== minutoAlvo) return;
                if (_backfillUltimaHora === horaAtual) return; // já rodou nesta hora
                _backfillUltimaHora = horaAtual;

                // Hora anterior a ser verificada
                const horaAnterior = (horaAtual + 23) % 24;
                const horaIniStr   = `${String(horaAnterior).padStart(2,'0')}:00`;
                const horaFimStr   = `${String(horaAnterior).padStart(2,'0')}:59`;

                // Data para extra.bet365: madrugada BST (00–05) usa sessão do "dia anterior"
                const bst = new Date(Date.now() + 3600000);
                let dataExtra;
                if (horaAnterior < 6) {
                    const d = new Date(bst);
                    d.setUTCDate(d.getUTCDate() - 1);
                    dataExtra = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
                } else {
                    dataExtra = `${bst.getUTCFullYear()}-${String(bst.getUTCMonth()+1).padStart(2,'0')}-${String(bst.getUTCDate()).padStart(2,'0')}`;
                }

                // Conta resultados por liga na hora anterior — detecta lacunas
                const LIGAS_ESPERADO = {
                    'World Cup': 20, 'Euro Cup': 20, 'Premiership': 20,
                    'Super Liga Sul-Americana': 20, 'Express Cup': 55,
                };
                const LIGA_CFG_KEY = {
                    'World Cup':'liga_world_cup','Euro Cup':'liga_euro_cup',
                    'Premiership':'liga_premiership','Express Cup':'liga_express_cup',
                    'Super Liga Sul-Americana':'liga_super_liga',
                };
                const cfgAll = {};
                (await pool.request().query(`SELECT chave, valor FROM bet365_config`))
                    .recordset.forEach(r => { cfgAll[r.chave] = r.valor; });

                const ligasComLacuna = [];
                for (const [liga, esperado] of Object.entries(LIGAS_ESPERADO)) {
                    const key = LIGA_CFG_KEY[liga];
                    if (key && cfgAll[key] === 'false') continue;
                    const r = await pool.request()
                        .input('liga', sql.NVarChar(200), liga)
                        .input('hora', sql.Int, horaAnterior)
                        .query(`
                            SELECT COUNT(DISTINCT evento_id) AS qtd
                            FROM bet365_resultados_mercados
                            WHERE liga = @liga
                              AND DATEPART(HOUR, data_partida) = @hora
                              AND data_partida >= DATEADD(HOUR, -3, GETUTCDATE())
                        `);
                    const qtd     = r.recordset[0]?.qtd || 0;
                    if (qtd < esperado) {
                        ligasComLacuna.push(liga);
                        console.log(`   📚 [Backfill] [${liga}] ${qtd}/${esperado} resultados na hora ${horaIniStr} → backfill`);
                    }
                }

                if (ligasComLacuna.length === 0) {
                    console.log(`   📚 [Backfill] Hora ${horaIniStr}: dados completos, sem backfill necessário`);
                    return;
                }

                _backfillRodando = true;
                const _bfInicioMs = Date.now();
                console.log(`\n📚 [Backfill Auto] Iniciando para: ${ligasComLacuna.join(', ')} | ${horaIniStr}–${horaFimStr}`);

                const { spawn } = require('child_process');
                const _bfDir = require('path').join(__dirname, '..');
                const _bfEnv = {
                    ...process.env,
                    BET365_HIST_DEBUG_PORT: String(parseInt(process.env.BET365_DEBUG_PORT) || 9222),
                    BET365_HIST_DATA:       dataExtra,
                    BET365_HIST_HORA_INI:   horaIniStr,
                    BET365_HIST_HORA_FIM:   horaFimStr,
                    BET365_HIST_LIGAS:      ligasComLacuna.join(','),
                };
                const proc = spawn('node', ['-r', 'dotenv/config', 'backend/services/bet365-coletor-historico.js'], {
                    detached: true, env: _bfEnv, stdio: 'ignore', cwd: _bfDir,
                });
                proc.on('exit', code => {
                    const duracaoS = Math.round((Date.now() - _bfInicioMs) / 1000);
                    console.log(`   📚 [Backfill Auto] Concluído em ${duracaoS}s (código: ${code})`);
                    _backfillRodando = false;
                });
                proc.on('error', e => {
                    console.error(`   ❌ [Backfill Auto] Erro ao iniciar processo: ${e.message}`);
                    _backfillRodando = false;
                });

            } catch(e) {
                console.warn(`   ⚠️  [Backfill Auto] Erro: ${e.message}`);
                _backfillRodando = false;
            }
        }
        setInterval(_autoBackfill, 60000);
        // ─────────────────────────────────────────────────────────────────────

        // ── Limpeza automática de eventos antigos (a cada 1h) ─────────────────
        // FutebolVirtual: partidas duram ~3-5 min. Eventos com mais de 4h são lixo.
        async function _limparEventosAntigos() {
            try {
                const pool = await getDbPool();
                const r = await pool.request().query(`
                    UPDATE bet365_eventos
                    SET ativo = 0
                    WHERE ativo = 1
                      AND start_time_datetime < DATEADD(MINUTE, 45, GETUTCDATE())
                `);
                if (r.rowsAffected[0] > 0) {
                    console.log(`   🧹 [Limpeza] ${r.rowsAffected[0]} eventos antigos desativados`);
                }
            } catch(e) {
                console.warn(`   ⚠️  [Limpeza] Erro ao desativar eventos antigos: ${e.message}`);
            }
        }
        _limparEventosAntigos(); // executa no início para limpar acumulado imediatamente
        setInterval(_limparEventosAntigos, 60 * 60 * 1000);
        // ─────────────────────────────────────────────────────────────────────

        process.on('SIGINT',  async () => { clearTimeout(_coletorTimer); await coletor365.encerrar(); process.exit(0); });
        process.on('SIGTERM', async () => { clearTimeout(_coletorTimer); await coletor365.encerrar(); process.exit(0); });
    }

    // ── Auto-normalização EN→PT a cada 10 minutos (últimas 2h) ───────────
    const { normalizarAutomaticamente } = require('./routes/bet365-api');
    setInterval(() => normalizarAutomaticamente(2), 10 * 60 * 1000);
});

// ── Dashboard de segurança (apenas master) ────────────────────────────────
app.post('/api/admin/seguranca', requireAuth, async (req, res) => {
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        const check = await sql.query`SELECT TipoUsuario FROM Usuarios WHERE Id = ${req.body.usuarioId}`;
        const tipoReq = (check.recordset[0]?.TipoUsuario || '').toLowerCase();
        if (!check.recordset.length || !['master','administrador'].includes(tipoReq)) {
            return res.json({ success: false, message: 'Acesso negado' });
        }

        // Sessões ativas
        const sessoes = [...activeSessions.values()].map(s => ({
            id: s.id,
            usuario: s.usuario,
            nome: s.nome,
            tipo: s.tipo,
            ip: s.ip,
            loginTime: s.loginTime,
            lastSeen: s.lastSeen,
            userAgent: s.userAgent,
            inativoMin: Math.round((Date.now() - new Date(s.lastSeen).getTime()) / 60000),
        }));

        // IPs bloqueados
        const bloqueados = [..._loginBlocklist.entries()]
            .filter(([, v]) => Date.now() < v.blockedUntil)
            .map(([ip, v]) => ({
                ip,
                desbloqueiaEm: new Date(v.blockedUntil).toISOString(),
                usuarios: v.usuarios ? [...v.usuarios] : [],
            }));

        // Req/min por usuário (instantâneo)
        const reqPorUsuario = [..._userReqCount.entries()]
            .filter(([, v]) => Date.now() - v.windowStart < 60000)
            .map(([uid, v]) => ({
                uid,
                usuario: activeSessions.get(uid)?.usuario || '?',
                reqUltimoMin: v.count,
                rotas: v.rotas ? [...v.rotas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([r, c]) => ({ r, c })) : [],
            }))
            .sort((a, b) => b.reqUltimoMin - a.reqUltimoMin);

        // Últimas 50 tentativas de login no banco
        const logins = await sql.query`
            SELECT TOP 50 usuario, tipo, ip, cidade, pais, data_hora, user_agent
            FROM HistoricoAcessos
            WHERE tipo IN ('login_ok','login_fail')
            ORDER BY data_hora DESC
        `;

        res.json({
            success: true,
            sessoesAtivas: sessoes,
            ipsBlockeados: bloqueados,
            reqPorUsuario,
            ultimosLogins: logins.recordset,
            bfCfg: { tentativas: _bfCfg.tentativas, janelaMins: _bfCfg.janelaMins, bloqueioMins: _bfCfg.bloqueioMins },
        });
    } catch(e) {
        res.json({ success: false, message: e.message });
    }
});

// ── Alertas de Abuso ──────────────────────────────────────────────────────
app.get('/api/admin/alertas-abuso', requireAuth, async (req, res) => {
    const tipo = (req.sessionUser?.tipo || '').toLowerCase();
    if (!['master','administrador','admin'].includes(tipo)) return res.status(403).json({ success: false });
    try {
        await connectSQL(getDatabaseConfigFromEnv());

        // 1) Escalada de horas: usuario/ip com variação > 30h nas últimas 24h (padrão de bot)
        const escalada = await sql.query`
            SELECT usuario_id, usuario, ip,
                MIN(horas) as horas_inicio, MAX(horas) as horas_fim,
                COUNT(*) as total_chamadas,
                MAX(horas) - MIN(horas) as variacao,
                CONVERT(VARCHAR(19), MAX(data_hora), 120) as ultima_vez
            FROM auditoria_requests
            WHERE data_hora > DATEADD(hour, -24, GETUTCDATE())
            GROUP BY usuario_id, usuario, ip
            HAVING COUNT(*) >= 5 AND (MAX(horas) - MIN(horas)) > 30
            ORDER BY variacao DESC
        `;

        // 2) Volume alto: usuario/ip com muitas chamadas de horas altas nas últimas 24h
        const volume = await sql.query`
            SELECT usuario_id, usuario, ip,
                COUNT(*) as total_chamadas,
                AVG(horas) as media_horas,
                MAX(horas) as max_horas,
                CONVERT(VARCHAR(19), MAX(data_hora), 120) as ultima_vez
            FROM auditoria_requests
            WHERE data_hora > DATEADD(hour, -24, GETUTCDATE())
            GROUP BY usuario_id, usuario, ip
            HAVING COUNT(*) >= 10
            ORDER BY total_chamadas DESC
        `;

        // 3) Relogin rápido: logout → login em menos de 30 segundos (padrão de script)
        const reloginRapido = await sql.query`
            SELECT usuario_id, usuario, ip,
                COUNT(*) as relogins_rapidos,
                MIN(seg) as min_segundos,
                CONVERT(VARCHAR(19), MAX(data_hora), 120) as ultima_vez
            FROM (
                SELECT usuario_id, usuario, ip, data_hora,
                    DATEDIFF(SECOND,
                        LAG(data_hora) OVER (PARTITION BY usuario_id ORDER BY data_hora),
                        data_hora) as seg,
                    LAG(tipo) OVER (PARTITION BY usuario_id ORDER BY data_hora) as tipo_ant,
                    tipo
                FROM HistoricoAcessos
                WHERE data_hora > DATEADD(day, -7, GETUTCDATE())
                  AND usuario_id IS NOT NULL
            ) t
            WHERE tipo = 'login_ok' AND tipo_ant IN ('logout','desconectado') AND seg < 30
            GROUP BY usuario_id, usuario, ip
            HAVING COUNT(*) >= 2
            ORDER BY relogins_rapidos DESC
        `;

        // 4) IP único: usuários com 5+ logins todos do mesmo IP (últimos 30 dias)
        const ipUnico = await sql.query`
            SELECT usuario_id, usuario,
                MAX(ip) as ip,
                COUNT(*) as total_logins,
                COUNT(DISTINCT ip) as ips_distintos,
                CONVERT(VARCHAR(19), MAX(data_hora), 120) as ultima_vez
            FROM HistoricoAcessos
            WHERE tipo = 'login_ok'
              AND data_hora > DATEADD(day, -30, GETUTCDATE())
              AND usuario_id IS NOT NULL
            GROUP BY usuario_id, usuario
            HAVING COUNT(DISTINCT ip) = 1 AND COUNT(*) >= 5
            ORDER BY total_logins DESC
        `;

        res.json({
            success: true,
            escalada:      escalada.recordset,
            volume:        volume.recordset,
            reloginRapido: reloginRapido.recordset,
            ipUnico:       ipUnico.recordset,
        });
    } catch(e) { res.json({ success: false, error: e.message }); }
});

// ── Blacklist de IPs (apenas master) ─────────────────────────────────────
app.get('/api/admin/blacklist', requireAuth, (req, res) => {
    const tipo = (req.sessionUser?.tipo || '').toLowerCase();
    if (!['master','administrador','admin'].includes(tipo)) return res.status(403).json({ success: false });
    res.json({ success: true, blacklist: [..._ipBlacklist] });
});

app.post('/api/admin/blacklist', requireAuth, async (req, res) => {
    const tipo = (req.sessionUser?.tipo || '').toLowerCase();
    if (!['master','administrador','admin'].includes(tipo)) return res.status(403).json({ success: false });
    const { ip, acao } = req.body;
    if (!ip || !/^[\d\.]+$/.test(ip)) return res.status(400).json({ success: false, message: 'IP inválido' });
    try {
        if (acao === 'adicionar') {
            _ipBlacklist.add(ip);
            await sqlConnectionPool.request()
                .input('ip', ip)
                .input('por', req.sessionUser?.usuario || '?')
                .query(`IF NOT EXISTS (SELECT 1 FROM ip_blacklist WHERE ip=@ip)
                        INSERT INTO ip_blacklist (ip, bloqueado_por) VALUES (@ip, @por)`);
            console.warn(`🚫 [Blacklist] IP ${ip} bloqueado por ${req.sessionUser?.usuario}`);
        } else if (acao === 'remover') {
            _ipBlacklist.delete(ip);
            await sqlConnectionPool.request()
                .input('ip', ip)
                .query('DELETE FROM ip_blacklist WHERE ip = @ip');
            console.log(`✅ [Blacklist] IP ${ip} removido por ${req.sessionUser?.usuario}`);
        }
    } catch(e) { console.error('[Blacklist] Erro ao persistir:', e.message); }
    res.json({ success: true, blacklist: [..._ipBlacklist] });
});

app.post('/api/admin/desbloquear-ip', requireAuth, async (req, res) => {
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        const check = await sql.query`SELECT TipoUsuario FROM Usuarios WHERE Id = ${req.body.usuarioId}`;
        const tipo = (check.recordset[0]?.TipoUsuario || '').toLowerCase();
        if (!['master','administrador'].includes(tipo)) return res.json({ success: false, message: 'Acesso negado' });
        const ip = (req.body.ip || '').trim();
        if (!ip) return res.json({ success: false, message: 'IP obrigatório' });
        _loginBlocklist.delete(ip);
        console.log(`🔓 [BruteForce] IP ${ip} desbloqueado manualmente por uid ${req.body.usuarioId}`);
        res.json({ success: true });
    } catch(e) {
        res.json({ success: false, message: e.message });
    }
});