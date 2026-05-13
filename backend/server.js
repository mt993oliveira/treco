const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const axios = require('axios');

// Map de sessões ativas: userId -> { id, usuario, nome, tipo, lastSeen, loginTime, ip, userAgent }
const activeSessions = new Map();
const loginHistory  = new Map(); // String(userId) -> { countToday, lastLoginDate }
const loginFailures = new Map(); // username_lower -> [{ ip, ts }]
const _geoCache     = new Map(); // ip -> { city, region, country, org, cachedAt }
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const hpp = require('hpp');
const app = express();

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
      "frame-src": "'self'",
      "object-src": "'none'",
    },
  },
  crossOriginEmbedderPolicy: false, // Necessário para permitir recursos externos
}));
app.use(mongoSanitize()); // Previne injeção de consulta MongoDB
app.use(xss()); // Limpa entradas de solicitações de XSS
app.use(hpp()); // Prevene poluição de parâmetros HTTP

// Limitar requisições por IP
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 2000, // Limite de 2000 requisições por janela
    message: 'Muitas requisições a partir deste IP, por favor tente novamente mais tarde.',
    standardHeaders: true, // Retorna informações de limite no cabeçalho `RateLimit-*`
    legacyHeaders: false, // Desativa o cabeçalho `X-RateLimit-*`
});
app.use(limiter);

app.use(express.json());

// ✅ MIDDLEWARE DE DEBUG (opcional, mas útil)
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    console.log('Origin:', req.headers.origin);
    console.log('Headers:', req.headers);
    next();
});


// Middleware para conexão com SQL Server
// ✅ CONEXÃO GLOBAL - substitua a função connectSQL atual
let sqlConnectionPool = null;

async function connectSQL(config) {
    if (sqlConnectionPool) {
        return true; // Já está conectado
    }

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

    try {
        sqlConnectionPool = await sql.connect(sqlConfig);
        console.log('✅ Conexão SQL estabelecida');
        return true;
    } catch (err) {
        sqlConnectionPool = null;
        throw new Error(`Erro SQL: ${err.message}`);
    }
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

function _trackLoginFail(username, ip) {
    const k = (username || '').toLowerCase();
    const arr = loginFailures.get(k) || [];
    arr.unshift({ ip: ip || '?', ts: Date.now() });
    loginFailures.set(k, arr.slice(0, 50));
}

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
    if (!ip || ip === '?' || ip === '::1' || /^(127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) {
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

async function _registrarAcesso(usuarioId, usuario, tipo, ip, userAgent) {
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        await sql.query`
            INSERT INTO HistoricoAcessos (usuario_id, usuario, tipo, ip, user_agent, data_hora)
            VALUES (${usuarioId ? Number(usuarioId) : null}, ${(usuario||'?').substring(0,100)},
                    ${tipo}, ${(ip||'?').substring(0,60)}, ${(userAgent||'').substring(0,500)}, GETUTCDATE())
        `;
    } catch(e) { /* fire-and-forget */ }
}
// ──────────────────────────────────────────────────────────────

// Middleware para verificar autenticação
function requireAuth(req, res, next) {
    if (!req.body.usuarioId) {
        return res.json({ success: false, message: 'Usuário não autenticado' });
    }
    next();
}

// =============================================
// API BETANO - desativada (projeto atual é somente Bet365)
// =============================================
// const betanoRoutes = require('./routes/betano-api');
// app.use('/api/betano', betanoRoutes);

// =============================================
// API BET365 - Dados em tempo real (tabelas bet365_*)
// =============================================
const bet365Routes = require('./routes/bet365-api');
app.use('/api/bet365', bet365Routes);

// Kirvano — webhook de pagamento + credenciais
const kirvanRoutes = require('./routes/kirvano');
app.use('/api/kirvano', kirvanRoutes);

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

// Rota de login - CORRIGIDA PARA BASE64
app.post('/api/login', async (req, res) => {
    const { username, password, sqlConfig } = req.body;

    try {
        // Se nenhuma configuração de banco for fornecida, usar as do ambiente
        const dbConfig = sqlConfig || getDatabaseConfigFromEnv();
        await connectSQL(dbConfig);

        // Buscar usuário pelo nome de usuário
        const result = await sql.query`
            SELECT Id, NomeCompleto, Usuario, Email, Senha, TipoUsuario, DataInicioLicenca, DataFimLicenca
            FROM Usuarios
            WHERE Usuario = ${username} AND Ativo = 1
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
                    const limite = Date.now() - 5 * 60 * 1000;
                    if (sessao && sessao.lastSeen.getTime() >= limite) {
                        const restam = Math.ceil((sessao.lastSeen.getTime() + 5 * 60 * 1000 - Date.now()) / 60000);
                        return res.json({
                            success: false,
                            message: `Usuário já possui uma sessão ativa em outro dispositivo. Faça logout no outro dispositivo ou aguarde ${restam} minuto(s).`
                        });
                    }
                }

                // Registrar sessão ao logar
                const _loginIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '?';
                activeSessions.set(String(user.Id), {
                    id: String(user.Id),
                    usuario: user.Usuario,
                    nome: user.NomeCompleto,
                    tipo: user.TipoUsuario,
                    lastSeen: new Date(),
                    loginTime: new Date(),
                    ip: _loginIp,
                    userAgent: req.headers['user-agent'] || '',
                });
                _trackLoginSuccess(user.Id);
                _registrarAcesso(user.Id, user.Usuario, 'login_ok', _loginIp, req.headers['user-agent']).catch(()=>{});

                const { Senha, ...userWithoutPassword } = user;
                res.json({ success: true, user: userWithoutPassword });
            } else {
                const _failIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
                _trackLoginFail(username, _failIp);
                _registrarAcesso(null, username, 'login_fail', _failIp, req.headers['user-agent']).catch(()=>{});
                res.json({ success: false, message: 'Credenciais inválidas' });
            }
        } else {
            const _failIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
            _trackLoginFail(username, _failIp);
            _registrarAcesso(null, username, 'login_fail', _failIp, req.headers['user-agent']).catch(()=>{});
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

// Rota para carregar usuários (apenas para masters) - VERSÃO CORRIGIDA
app.post('/api/usuarios', requireAuth, async (req, res) => {
    const { sqlConfig } = req.body;

    try {
        await connectSQL(sqlConfig || getDatabaseConfigFromEnv());

        // Verificar se o usuário é master ou administrador
        const userCheck = await sql.query`
            SELECT TipoUsuario FROM Usuarios WHERE Id = ${req.body.usuarioId}
        `;
        const _chkTipo = (userCheck.recordset[0]?.TipoUsuario || '').toLowerCase();
        if (!userCheck.recordset.length || (_chkTipo !== 'master' && _chkTipo !== 'administrador' && _chkTipo !== 'admin')) {
            return res.json({ success: false, message: 'Acesso não autorizado' });
        }

        const result = await sql.query`
            SELECT Id, NomeCompleto, Usuario, Email, Telefone, TipoUsuario, DataInicioLicenca, DataFimLicenca, DataCriacao, Ativo
            FROM Usuarios
            ORDER BY Id DESC
        `;

        // CORREÇÃO: Garantir que sempre retorne 'data'
        const usuarios = result.recordset || [];

        // Para cada usuário, converter as datas para o formato correto
        const usuariosFormatados = usuarios.map(usuario => ({
            ...usuario,
            DataInicioLicenca: usuario.DataInicioLicenca ? new Date(usuario.DataInicioLicenca).toISOString() : null,
            DataFimLicenca: usuario.DataFimLicenca ? new Date(usuario.DataFimLicenca).toISOString() : null
        }));

        res.json({
            success: true,
            data: usuariosFormatados
        });

    } catch (error) {
        console.error('Erro na rota /api/usuarios:', error);
        res.json({
            success: false,
            message: error.message,
            data: [] // Sempre retorna data mesmo em caso de erro
        });
    }
});

// Rota para salvar usuário - CORRIGIDA
app.post('/api/usuarios/save', requireAuth, async (req, res) => {
    const { id, nomeCompleto, usuario, email, telefone, senha, tipoUsuario, ativo, sqlConfig } = req.body;
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

            // Extrair datas de licença do corpo da requisição, se estiverem presentes
            const dataInicioLicenca = req.body.dataInicioLicenca || null;
            const dataFimLicenca = req.body.dataFimLicenca || null;

            // Obter estado atual do usuário alvo (para fallback e para gerar diff no histórico)
            const prevRow = (await sql.query`
                SELECT NomeCompleto, Usuario, Email, Telefone, TipoUsuario, Ativo, DataInicioLicenca, DataFimLicenca
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
                            DataInicioLicenca = ${dataInicioLicenca}, DataFimLicenca = ${dataFimLicenca},
                            DataAtualizacao = GETDATE()
                        WHERE Id = ${id}
                    `;
                } else if (usuario) {
                    await sql.query`
                        UPDATE Usuarios
                        SET NomeCompleto = ${nomeCompleto}, Usuario = ${usuario}, Email = ${email},
                            Senha = ${hashedPassword}, TipoUsuario = ${tipoUsuario || currentTipoUsuario},
                            DataInicioLicenca = ${dataInicioLicenca}, DataFimLicenca = ${dataFimLicenca},
                            DataAtualizacao = GETDATE()
                        WHERE Id = ${id}
                    `;
                } else if (tipoUsuario) {
                    await sql.query`
                        UPDATE Usuarios
                        SET NomeCompleto = ${nomeCompleto}, Email = ${email},
                            Senha = ${hashedPassword}, TipoUsuario = ${tipoUsuario},
                            DataInicioLicenca = ${dataInicioLicenca}, DataFimLicenca = ${dataFimLicenca},
                            DataAtualizacao = GETDATE()
                        WHERE Id = ${id}
                    `;
                } else {
                    await sql.query`
                        UPDATE Usuarios
                        SET NomeCompleto = ${nomeCompleto}, Email = ${email},
                            Senha = ${hashedPassword}, TipoUsuario = ${currentTipoUsuario},
                            DataInicioLicenca = ${dataInicioLicenca}, DataFimLicenca = ${dataFimLicenca},
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
                            DataInicioLicenca = ${dataInicioLicenca}, DataFimLicenca = ${dataFimLicenca},
                            DataAtualizacao = GETDATE()
                        WHERE Id = ${id}
                    `;
                } else if (usuario) {
                    await sql.query`
                        UPDATE Usuarios
                        SET NomeCompleto = ${nomeCompleto}, Usuario = ${usuario}, Email = ${email},
                            TipoUsuario = ${tipoUsuario || currentTipoUsuario},
                            DataInicioLicenca = ${dataInicioLicenca}, DataFimLicenca = ${dataFimLicenca},
                            DataAtualizacao = GETDATE()
                        WHERE Id = ${id}
                    `;
                } else if (tipoUsuario) {
                    await sql.query`
                        UPDATE Usuarios
                        SET NomeCompleto = ${nomeCompleto}, Email = ${email},
                            TipoUsuario = ${tipoUsuario},
                            DataInicioLicenca = ${dataInicioLicenca}, DataFimLicenca = ${dataFimLicenca},
                            DataAtualizacao = GETDATE()
                        WHERE Id = ${id}
                    `;
                } else {
                    await sql.query`
                        UPDATE Usuarios
                        SET NomeCompleto = ${nomeCompleto}, Email = ${email},
                            TipoUsuario = ${currentTipoUsuario},
                            DataInicioLicenca = ${dataInicioLicenca}, DataFimLicenca = ${dataFimLicenca},
                            DataAtualizacao = GETDATE()
                        WHERE Id = ${id}
                    `;
                }
            }

            // Atualizar Ativo se informado
            if (ativoVal !== null) {
                await sql.query`UPDATE Usuarios SET Ativo = ${ativoVal} WHERE Id = ${id}`;
            }
            // Atualizar Telefone se informado
            if (telefoneVal !== undefined) {
                await sql.query`UPDATE Usuarios SET Telefone = ${telefoneVal} WHERE Id = ${id}`;
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
            // Novo usuário - apenas masters podem criar
            if (currentUser.TipoUsuario !== 'master') {
                return res.json({ success: false, message: 'Apenas usuários master podem criar novos usuários' });
            }

            // Criptografar senha com bcrypt
            const hashedPassword = await bcrypt.hash(senha, parseInt(process.env.BCRYPT_SALT_ROUNDS) || 12);
            const dataInicioLicenca = req.body.dataInicioLicenca || null;
            const dataFimLicenca = req.body.dataFimLicenca || null;

            if (tipoUsuario !== 'master' && (!dataInicioLicenca || !dataFimLicenca)) {
                return res.json({ success: false, message: 'Data de início e fim da licença são obrigatórias para criar um usuário.' });
            }

            await sql.query`
                INSERT INTO Usuarios (NomeCompleto, Usuario, Email, Telefone, Senha, TipoUsuario, DataInicioLicenca, DataFimLicenca, DataCriacao, DataAtualizacao)
                VALUES (${nomeCompleto}, ${usuario}, ${email}, ${telefoneVal || null}, ${hashedPassword}, ${tipoUsuario}, ${dataInicioLicenca}, ${dataFimLicenca}, GETDATE(), GETDATE())
            `;

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
    // Expande coluna filtros de NVARCHAR(2000) → NVARCHAR(MAX) — ignorado se já for MAX
    try {
        await sql.query`
            IF EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS
                       WHERE TABLE_NAME='user_padroes_grafico' AND COLUMN_NAME='filtros'
                       AND CHARACTER_MAXIMUM_LENGTH=2000)
            ALTER TABLE user_padroes_grafico ALTER COLUMN filtros NVARCHAR(MAX) NOT NULL`;
    } catch(_) {}
    _padroesMigrated = true;
}
async function _getMaxPadroes() {
    try {
        const { getSystemConfig } = require('./routes/bet365-api');
        const cfg = await getSystemConfig();
        return Math.max(1, Math.min(10, parseInt(cfg.max_padroes_usuario) || 5));
    } catch(_) { return 5; }
}

// Listar padrões do usuário
app.get('/api/usuario/padroes', async (req, res) => {
    const usuarioId = parseInt(req.query.usuarioId);
    if (!usuarioId) return res.json({ success: false, message: 'usuarioId obrigatório' });
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        await _ensurePadroesTable();
        const r = await sql.query`
            SELECT id, nome, filtros, is_principal, data_criacao
            FROM user_padroes_grafico
            WHERE user_id = ${usuarioId}
            ORDER BY is_principal DESC, data_criacao ASC
        `;
        const limite = await _getMaxPadroes();
        res.json({ success: true, padroes: r.recordset, limite });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

// Criar padrão
app.post('/api/usuario/padroes', async (req, res) => {
    const { usuarioId, nome, filtros } = req.body;
    if (!usuarioId || !nome || !filtros) return res.json({ success: false, message: 'Dados incompletos' });
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        await _ensurePadroesTable();
        const limite = await _getMaxPadroes();
        const cnt = (await sql.query`SELECT COUNT(*) AS n FROM user_padroes_grafico WHERE user_id=${usuarioId}`).recordset[0].n;
        if (cnt >= limite) return res.json({ success: false, message: `Limite de ${limite} padrões atingido` });
        const fs = typeof filtros === 'string' ? filtros : JSON.stringify(filtros);
        const r = await sql.query`
            INSERT INTO user_padroes_grafico (user_id, nome, filtros)
            OUTPUT INSERTED.id VALUES (${usuarioId}, ${nome}, ${fs})
        `;
        res.json({ success: true, id: r.recordset[0].id });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

// Atualizar padrão (nome/filtros) ou definir principal
app.put('/api/usuario/padroes/:id', async (req, res) => {
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
        }
        res.json({ success: true });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

// Apagar padrão
app.delete('/api/usuario/padroes/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const usuarioId = parseInt(req.body.usuarioId || req.query.usuarioId);
    if (!usuarioId || !id) return res.json({ success: false, message: 'Dados incompletos' });
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        await _ensurePadroesTable();
        await sql.query`DELETE FROM user_padroes_grafico WHERE id=${id} AND user_id=${usuarioId}`;
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
    const existing = activeSessions.get(String(usuarioId)) || {};
    activeSessions.set(String(usuarioId), {
        ...existing,
        id: String(usuarioId),
        usuario: usuario || existing.usuario || '?',
        nome: nome || existing.nome || '?',
        tipo: tipo || existing.tipo || 'user',
        lastSeen: new Date(),
        ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || existing.ip || '?',
        userAgent: existing.userAgent || req.headers['user-agent'] || '',
    });
    res.json({ ok: true });
});

app.post('/api/logout', async (req, res) => {
    const { usuarioId } = req.body;
    if (usuarioId) {
        const _lgtSess = activeSessions.get(String(usuarioId));
        const _lgtIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
        _registrarAcesso(usuarioId, _lgtSess?.usuario || '?', 'logout', _lgtIp, req.headers['user-agent']).catch(()=>{});
        activeSessions.delete(String(usuarioId));
    }
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
                _registrarAcesso(s.id, s.usuario, 'desconectado', s.ip, s.userAgent).catch(()=>{});
                activeSessions.delete(key);
                removidos++;
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
        if (target) _registrarAcesso(target.id, target.usuario, 'desconectado', target.ip, target.userAgent).catch(()=>{});
        activeSessions.delete(targetId);
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

        const enriched = await Promise.all(ativos.map(async s => {
            const geo  = await _geoLookup(s.ip);
            const device = _parseUA(s.userAgent || '');
            const hist = loginHistory.get(s.id) || { countToday: 0 };
            const fails = (loginFailures.get((s.usuario||'').toLowerCase()) || [])
                .filter(f => Date.now() - f.ts < 60 * 60 * 1000).length;
            return {
                id: s.id, usuario: s.usuario, nome: s.nome, tipo: s.tipo,
                ip: s.ip, userAgent: s.userAgent||'',
                lastSeen: s.lastSeen.toISOString(),
                loginTime: s.loginTime ? s.loginTime.toISOString() : null,
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

/**
 * POST /api/usuarios/historico-acessos
 * Retorna histórico paginado e filtrado. Apenas master.
 */
app.post('/api/usuarios/historico-acessos', requireAuth, async (req, res) => {
    try {
        await connectSQL(getDatabaseConfigFromEnv());
        const chk = await sql.query`SELECT TipoUsuario FROM Usuarios WHERE Id = ${req.body.usuarioId}`;
        if (!chk.recordset.length || chk.recordset[0].TipoUsuario !== 'master') {
            return res.json({ success: false, message: 'Acesso negado' });
        }
        const { usuario = '', tipo = '', dataInicio = '', dataFim = '', pagina = 1, porPagina = 50 } = req.body;
        const pp  = Math.min(200, Math.max(1, Number(porPagina)));
        const off = (Math.max(1, Number(pagina)) - 1) * pp;

        const cntReq = sqlConnectionPool.request();
        const mainReq = sqlConnectionPool.request();
        const wheres = [];
        if (usuario)    { wheres.push('(usuario LIKE @usuario OR ip LIKE @usuario)'); cntReq.input('usuario', sql.NVarChar, `%${usuario}%`); mainReq.input('usuario', sql.NVarChar, `%${usuario}%`); }
        if (tipo)       { wheres.push('tipo = @tipo');       cntReq.input('tipo', sql.NVarChar, tipo);       mainReq.input('tipo', sql.NVarChar, tipo); }
        if (dataInicio) { wheres.push('data_hora >= @di');   cntReq.input('di', sql.DateTime2, new Date(dataInicio)); mainReq.input('di', sql.DateTime2, new Date(dataInicio)); }
        if (dataFim)    { wheres.push('data_hora <= @df');   cntReq.input('df', sql.DateTime2, new Date(dataFim));    mainReq.input('df', sql.DateTime2, new Date(dataFim)); }
        const w = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

        const cntResult = await cntReq.query(`SELECT COUNT(*) AS total FROM HistoricoAcessos ${w}`);
        const total = cntResult.recordset[0].total;

        mainReq.input('off', sql.Int, off);
        mainReq.input('pp',  sql.Int, pp);
        const rows = await mainReq.query(`
            SELECT id, usuario_id, usuario, tipo, ip, user_agent, data_hora
            FROM HistoricoAcessos ${w}
            ORDER BY data_hora DESC
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
        if (!chk.recordset.length || chk.recordset[0].TipoUsuario !== 'master') {
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

// Garante colunas extras em betano_eventos ao iniciar o servidor (desativado — projeto somente Bet365)
async function garantirSchemaEventos() { return; // desativado
    try {
        const cfg = getDatabaseConfigFromEnv();
        const pool = await sql.connect({
            user: cfg.username, password: cfg.password,
            server: cfg.server, database: cfg.database,
            port: cfg.port,
            options: { encrypt: cfg.encrypt, trustServerCertificate: true }
        });

        // ── SEM LIMPEZA AUTOMÁTICA: preserva todos os dados (incluindo 0x0 válidos) ──
        // A limpeza deve ser feita manualmente se necessário, nunca automática ao iniciar
        const colunas = [
            ["gol_casa",               "INT DEFAULT 0"],
            ["gol_fora",               "INT DEFAULT 0"],
            ["minuto_jogo",            "NVARCHAR(20)"],
            ["odd_casa",               "DECIMAL(10,2) DEFAULT 0"],
            ["odd_empate",             "DECIMAL(10,2) DEFAULT 0"],
            ["odd_fora",               "DECIMAL(10,2) DEFAULT 0"],
            ["posse_bola_casa",        "DECIMAL(5,2) DEFAULT 0"],
            ["posse_bola_fora",        "DECIMAL(5,2) DEFAULT 0"],
            ["chutes_casa",            "INT DEFAULT 0"],
            ["chutes_fora",            "INT DEFAULT 0"],
            ["chutes_gol_casa",        "INT DEFAULT 0"],
            ["chutes_gol_fora",        "INT DEFAULT 0"],
            ["escanteios_casa",        "INT DEFAULT 0"],
            ["escanteios_fora",        "INT DEFAULT 0"],
            ["cartoes_amarelos_casa",  "INT DEFAULT 0"],
            ["cartoes_amarelos_fora",  "INT DEFAULT 0"],
            ["cartoes_vermelhos_casa", "INT DEFAULT 0"],
            ["cartoes_vermelhos_fora", "INT DEFAULT 0"],
            ["estatisticas_json",      "NVARCHAR(MAX)"],
        ];
        for (const [col, tipo] of colunas) {
            await pool.query(`
                IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('betano_eventos') AND name='${col}')
                    ALTER TABLE betano_eventos ADD ${col} ${tipo}
            `);
        }
        console.log('✅ Schema betano_eventos verificado');
        await pool.close();
    } catch (err) {
        console.warn('⚠️ garantirSchemaEventos:', err.message);
    }
}

server.listen(PORT, () => {
    console.log(`🚀 Backend rodando na porta ${PORT}`);
    console.log(`🌐 Acesse: http://localhost:${PORT}`);
    console.log(`🔌 WebSocket: ws://localhost:${PORT}/ws`);
    garantirSchemaEventos();
    // Garante coluna Telefone na tabela Usuarios
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
        } catch(e) { console.warn('⚠️ Schema Telefone:', e.message); }
    })();

    // Garante tabela HistoricoAcessos
    (async () => {
        try {
            await connectSQL(getDatabaseConfigFromEnv());
            await sql.query`
                IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='HistoricoAcessos' AND xtype='U')
                CREATE TABLE HistoricoAcessos (
                    id          INT IDENTITY(1,1) PRIMARY KEY,
                    usuario_id  INT NULL,
                    usuario     NVARCHAR(100) NOT NULL,
                    tipo        NVARCHAR(30)  NOT NULL,
                    ip          NVARCHAR(60),
                    user_agent  NVARCHAR(500),
                    data_hora   DATETIME2 NOT NULL DEFAULT GETUTCDATE()
                )
            `;
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

    // ── Inicia o agendador Bet365 junto com o servidor ──
    if (process.env.BET365_AGENDADOR_ATIVADO !== 'false') {
        const Bet365Coletor               = require('./services/bet365-coletor');
        const { getSystemConfig, getDbPool } = require('./routes/bet365-api');
        const { dispararAlerta }          = require('./services/alertas');
        const coletor365 = new Bet365Coletor();

        let _coletorTimer  = null;
        let _alertaEnviado = false;
        let _ultimaColetaOk = Date.now(); // grace period inicial

        async function _cicloColeta() {
            const inicio = Date.now();
            await coletor365.coletar().catch(e => console.error('Bet365 coletar:', e.message));
            const cfg  = await getSystemConfig().catch(() => ({}));

            // ── Verificar alertas ──────────────────────────────────
            if (coletor365.ultimaColetaSucesso && coletor365.ultimaColetaSucesso > _ultimaColetaOk) {
                _ultimaColetaOk = coletor365.ultimaColetaSucesso;
                if (_alertaEnviado) {
                    _alertaEnviado = false;
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
            // ──────────────────────────────────────────────────────

            const seg   = Math.max(10, parseInt(cfg.intervalo_coleta_seg) || 30);
            const gasto = Math.round((Date.now() - inicio) / 1000);
            const espera = Math.max(5, seg - gasto);
            console.log(`⏱️  Bet365 - próxima coleta em ${espera}s (ciclo configurado: ${seg}s, coleta levou: ${gasto}s)`);
            _coletorTimer = setTimeout(_cicloColeta, espera * 1000);
        }

        app.get('/api/status-coletor', (req, res) => {
            const uptime = process.uptime(), mem = process.memoryUsage(), agora = Date.now();
            const semColeta = coletor365.ultimaColetaSucesso ? Math.round((agora - coletor365.ultimaColetaSucesso) / 1000) : null;
            const fu = s => { const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),sc=Math.floor(s%60); return d>0?`${d}d ${h}h ${m}m`:h>0?`${h}h ${m}m ${sc}s`:`${m}m ${sc}s`; };
            res.json({
                servidor: { uptime_fmt: fu(Math.round(uptime)), hora: new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}), memoria_mb: Math.round(mem.rss/1024/1024), heap_mb: Math.round(mem.heapUsed/1024/1024) },
                coletor:  { coletando: coletor365.coletando, total_coletas: coletor365._coletas, ultima_sucesso: coletor365.ultimaColetaSucesso ? new Date(coletor365.ultimaColetaSucesso).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}) : null, seg_sem_coleta: semColeta, ultimo_erro: coletor365.ultimoErro||null, alerta_disparado: _alertaEnviado }
            });
        });

        console.log(`\n📡 Bet365 - Agendador iniciado (intervalo dinâmico via config DB)\n`);
        _cicloColeta();

        process.on('SIGINT',  async () => { clearTimeout(_coletorTimer); await coletor365.encerrar(); process.exit(0); });
        process.on('SIGTERM', async () => { clearTimeout(_coletorTimer); await coletor365.encerrar(); process.exit(0); });
    }
});