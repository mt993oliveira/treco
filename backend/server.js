const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const axios = require('axios');
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

// Middleware para verificar autenticação
function requireAuth(req, res, next) {
    if (!req.body.usuarioId) {
        return res.json({ success: false, message: 'Usuário não autenticado' });
    }
    next();
}

// =============================================
// API BETANO - Dados em tempo real (tabelas betano_*)
// =============================================
const betanoRoutes = require('./routes/betano-api');
app.use('/api/betano', betanoRoutes);

// =============================================
// API BET365 - Dados em tempo real (tabelas bet365_*)
// =============================================
const bet365Routes = require('./routes/bet365-api');
app.use('/api/bet365', bet365Routes);

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

    app.get('/api/bet365/historico-tabela', async (req, res) => {
        try {
            const horas = Math.min(Math.max(parseInt(req.query.horas) || 24, 1), 168);
            const liga = req.query.liga;
            const pool = await _b365Pool();
            const req1 = pool.request().input('h', sqlB.Int, horas);
            let q = `SELECT id,evento_id,liga,time_casa,time_fora,gol_casa,gol_fora,resultado,odd_casa,odd_empate,odd_fora,data_partida FROM bet365_historico_partidas WHERE data_partida>=DATEADD(HOUR,-@h,GETDATE())`;
            if (liga && liga !== 'all') { q += ' AND liga LIKE @liga'; req1.input('liga', sqlB.NVarChar(200), `%${liga}%`); }
            q += ' ORDER BY data_partida ASC';
            const result = await req1.query(q);
            const ligas = await pool.request().input('h2', sqlB.Int, horas)
                .query(`SELECT DISTINCT liga, COUNT(*) AS total FROM bet365_historico_partidas WHERE liga IS NOT NULL AND liga<>'' AND data_partida>=DATEADD(HOUR,-@h2,GETDATE()) GROUP BY liga ORDER BY total DESC`);
            res.json({ success: true, total: result.recordset.length, horas, ligas: ligas.recordset, partidas: result.recordset });
        } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // DIAGNÓSTICO — mostra últimos 30 registros sem filtro de hora + GETDATE() do SQL Server
    app.get('/api/bet365/debug-db', async (req, res) => {
        try {
            const pool = await _b365Pool();
            const ultimos = await pool.query(`
                SELECT TOP 30 liga, time_casa, time_fora, gol_casa, gol_fora, resultado,
                    data_partida,
                    CONVERT(varchar(25), data_partida, 126) AS data_partida_iso,
                    CONVERT(varchar(25), GETDATE(), 126)    AS getdate_agora
                FROM bet365_historico_partidas
                ORDER BY data_partida DESC
            `);
            const total = await pool.query(`SELECT COUNT(*) AS total FROM bet365_historico_partidas`);
            const porHora = await pool.query(`
                SELECT TOP 48
                    CONVERT(varchar(13), data_partida, 126) AS hora_utc,
                    COUNT(*) AS qtd
                FROM bet365_historico_partidas
                GROUP BY CONVERT(varchar(13), data_partida, 126)
                ORDER BY hora_utc DESC
            `);
            res.json({
                total: total.recordset[0]?.total,
                getdate_servidor: new Date().toISOString(),
                ultimos30: ultimos.recordset,
                por_hora: porHora.recordset
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/bet365/sugestoes', async (req, res) => {
        try {
            const nParam = Math.min(100, Math.max(3, parseInt(req.query.n) || 10));
            const pool = await _b365Pool();
            const ligasRes = await pool.query(`SELECT liga, COUNT(*) AS total FROM bet365_historico_partidas WHERE liga IS NOT NULL AND liga<>'' GROUP BY liga HAVING COUNT(*)>=5 ORDER BY total DESC`);
            const FILTROS = [
                { id:'over0.5',  label:'Over 0.5',     check: j=>(j.gol_casa+j.gol_fora)>=1 },
                { id:'over1.5',  label:'Over 1.5',     check: j=>(j.gol_casa+j.gol_fora)>=2 },
                { id:'over2.5',  label:'Over 2.5',     check: j=>(j.gol_casa+j.gol_fora)>=3 },
                { id:'over3.5',  label:'Over 3.5',     check: j=>(j.gol_casa+j.gol_fora)>=4 },
                { id:'under1.5', label:'Under 1.5',    check: j=>(j.gol_casa+j.gol_fora)<=1 },
                { id:'under2.5', label:'Under 2.5',    check: j=>(j.gol_casa+j.gol_fora)<=2 },
                { id:'ambas',    label:'Ambas Marcam',  check: j=>j.gol_casa>0&&j.gol_fora>0 },
                { id:'ft_casa',  label:'Casa Vence',   check: j=>j.resultado==='CASA' },
                { id:'ft_empate',label:'Empate',        check: j=>j.resultado==='EMPATE' },
                { id:'ft_fora',  label:'Fora Vence',   check: j=>j.resultado==='FORA' },
                { id:'btts_o25', label:'BTTS + O2.5',  check: j=>j.gol_casa>0&&j.gol_fora>0&&(j.gol_casa+j.gol_fora)>=3 },
            ];
            const resultado = [];
            for (const l of ligasRes.recordset) {
                const pr = await pool.request().input('liga', sqlB.NVarChar(200), l.liga)
                    .query(`SELECT TOP 100 gol_casa,gol_fora,resultado,odd_casa,odd_empate,odd_fora,data_partida FROM bet365_historico_partidas WHERE liga=@liga ORDER BY data_partida DESC`);
                const partidas = pr.recordset.map(p=>({gol_casa:p.gol_casa||0,gol_fora:p.gol_fora||0,resultado:p.resultado||'',odd_casa:parseFloat(p.odd_casa)||0,odd_empate:parseFloat(p.odd_empate)||0,odd_fora:parseFloat(p.odd_fora)||0}));
                if (partidas.length<5) continue;
                const n=partidas.length;
                const filtroStats=FILTROS.map(f=>{
                    const nN=Math.min(nParam,n),n5=Math.min(5,n),n10=Math.min(10,n),n20=Math.min(20,n);
                    const hG=partidas.filter(f.check).length,hN=partidas.slice(0,nN).filter(f.check).length,h5=partidas.slice(0,n5).filter(f.check).length,h10=partidas.slice(0,n10).filter(f.check).length,h20=partidas.slice(0,n20).filter(f.check).length;
                    const txG=+(hG/n*100).toFixed(1),txN=+(hN/nN*100).toFixed(1),tx5=+(h5/n5*100).toFixed(1),tx10=+(h10/n10*100).toFixed(1),tx20=+(h20/n20*100).toFixed(1);
                    let streak=0;const sT=f.check(partidas[0])?'verde':'vermelho';
                    for(let i=0;i<Math.min(30,n);i++){if(f.check(partidas[i])===(sT==='verde'))streak++;else break;}
                    const diff=txN-txG,tendencia=diff>8?'subindo':diff<-8?'caindo':'estavel';
                    const confianca=(txN>=65&&nN>=10)?'alta':(txN>=55&&nN>=5)?'media':'baixa';
                    return{id:f.id,label:f.label,tx_geral:txG,tx_ultn:txN,tx_ult5:tx5,tx_ult10:tx10,tx_ult20:tx20,n_custom:nN,streak,streak_tipo:sT,tendencia,confianca,amostras:n};
                });
                filtroStats.sort((a,b)=>b.tx_ultn-a.tx_ultn);
                const tG=partidas.reduce((s,p)=>s+p.gol_casa+p.gol_fora,0),mG=+(tG/n).toFixed(2);
                const pC=+(partidas.filter(p=>p.resultado==='CASA').length/n*100).toFixed(1);
                const pE=+(partidas.filter(p=>p.resultado==='EMPATE').length/n*100).toFixed(1);
                const pF=+(partidas.filter(p=>p.resultado==='FORA').length/n*100).toFixed(1);
                const pA=+(partidas.filter(p=>p.gol_casa>0&&p.gol_fora>0).length/n*100).toFixed(1);
                const pO15=+(partidas.filter(p=>(p.gol_casa+p.gol_fora)>=2).length/n*100).toFixed(1);
                const pO25=+(partidas.filter(p=>(p.gol_casa+p.gol_fora)>=3).length/n*100).toFixed(1);
                resultado.push({liga:l.liga,total:l.total,amostras:n,stats:{mediaGols:mG,pctCasa:pC,pctEmpate:pE,pctFora:pF,pctAmbas:pA,pctO15:pO15,pctO25:pO25},filtros:filtroStats,melhor:filtroStats[0]||null});
            }
            res.json({success:true,timestamp:new Date().toISOString(),data:resultado});
        } catch(e){ res.status(500).json({success:false,error:e.message}); }
    });

    app.get('/api/bet365/estatisticas-avancadas', async (req, res) => {
        try {
            const pool = await _b365Pool();
            const gerais = await pool.query(`SELECT COUNT(*) AS total_eventos, SUM(CASE WHEN status='EM_ANDAMENTO' THEN 1 ELSE 0 END) AS ao_vivo, SUM(CASE WHEN status='AGENDADO' THEN 1 ELSE 0 END) AS agendados, AVG(CAST(odd_casa AS FLOAT)) AS media_odd_casa, AVG(CAST(odd_empate AS FLOAT)) AS media_odd_empate, AVG(CAST(odd_fora AS FLOAT)) AS media_odd_fora FROM bet365_eventos WHERE ativo=1`);
            const distGols = await pool.query(`SELECT (gol_casa+gol_fora) AS total_gols, COUNT(*) AS quantidade FROM bet365_historico_partidas WHERE data_partida>=DATEADD(HOUR,-24,GETDATE()) GROUP BY (gol_casa+gol_fora) ORDER BY total_gols`);
            const perfLiga = await pool.query(`SELECT TOP 20 liga, COUNT(*) AS total_jogos, AVG(CAST(gol_casa+gol_fora AS FLOAT)) AS media_gols, SUM(CASE WHEN resultado='CASA' THEN 1 ELSE 0 END) AS vitorias_casa, SUM(CASE WHEN resultado='EMPATE' THEN 1 ELSE 0 END) AS empates, SUM(CASE WHEN resultado='FORA' THEN 1 ELSE 0 END) AS vitorias_fora FROM bet365_historico_partidas WHERE liga IS NOT NULL AND liga<>'' GROUP BY liga ORDER BY total_jogos DESC`);
            const heatmap = await pool.query(`SELECT gol_casa, gol_fora, COUNT(*) AS frequencia FROM bet365_historico_partidas WHERE data_partida>=DATEADD(HOUR,-24,GETDATE()) GROUP BY gol_casa,gol_fora ORDER BY frequencia DESC`);
            res.json({success:true,timestamp:new Date().toISOString(),data:{gerais:gerais.recordset[0],distribuicaoGols:distGols.recordset,performanceLiga:perfLiga.recordset,heatmapResultados:heatmap.recordset.slice(0,20)}});
        } catch(e){ res.status(500).json({success:false,error:e.message}); }
    });
}

// Rota alternativa de dados (funciona sem pool global)
const dadosRoutes = require('./routes/dados');
app.use('/api/dados', dadosRoutes);

// Rota de teste de conexão
app.post('/api/test-connection', async (req, res) => {
    try {
        // Se nenhuma configuração for fornecida, usar as do ambiente
        const sqlConfig = req.body.sqlConfig || getDatabaseConfigFromEnv();
        await connectSQL(sqlConfig);

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
                if (inicioLicenca && hoje < inicioLicenca) {
                    licencaValida = false;
                }
                if (fimLicenca && hoje > fimLicenca) {
                    licencaValida = false;
                }

                if (!licencaValida) {
                    res.json({ success: false, message: 'Licença do usuário expirada ou ainda não iniciada' });
                    return;
                }

                const { Senha, ...userWithoutPassword } = user;
                res.json({ success: true, user: userWithoutPassword });
            } else {
                res.json({ success: false, message: 'Credenciais inválidas' });
            }
        } else {
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
        await connectSQL(sqlConfig);

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
        await connectSQL(sqlConfig);

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
        await connectSQL(sqlConfig);

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
        await connectSQL(sqlConfig);

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
        await connectSQL(sqlConfig);

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
        await connectSQL(sqlConfig);

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
        await connectSQL(sqlConfig);

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
        await connectSQL(sqlConfig);

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
        await connectSQL(sqlConfig);

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
        await connectSQL(sqlConfig);

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
        await connectSQL(sqlConfig);

        // Verificar se o usuário é master
        const userCheck = await sql.query`
            SELECT TipoUsuario FROM Usuarios WHERE Id = ${req.body.usuarioId}
        `;

        if (userCheck.recordset.length === 0 || userCheck.recordset[0].TipoUsuario !== 'master') {
            return res.json({ success: false, message: 'Acesso não autorizado' });
        }

        const result = await sql.query`
            SELECT Id, NomeCompleto, Usuario, Email, TipoUsuario, DataInicioLicenca, DataFimLicenca, DataCriacao, Ativo
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
    const { id, nomeCompleto, usuario, email, senha, tipoUsuario, ativo, sqlConfig } = req.body;
    const ativoVal = ativo !== undefined ? (ativo ? 1 : 0) : null;

    try {
        await connectSQL(sqlConfig || getDatabaseConfigFromEnv());

        // Verificar se o usuário é master para criar/editar usuários
        const userCheck = await sql.query`
            SELECT TipoUsuario FROM Usuarios WHERE Id = ${req.body.usuarioId}
        `;

        if (userCheck.recordset.length === 0) {
            return res.json({ success: false, message: 'Usuário não encontrado' });
        }

        const currentUser = userCheck.recordset[0];

        if (id) {
            // Edição de usuário
            if (currentUser.TipoUsuario !== 'master' && parseInt(id) !== req.body.usuarioId) {
                return res.json({ success: false, message: 'Acesso não autorizado' });
            }

            // Extrair datas de licença do corpo da requisição, se estiverem presentes
            const dataInicioLicenca = req.body.dataInicioLicenca || null;
            const dataFimLicenca = req.body.dataFimLicenca || null;

            // Para atualizações de perfil, os campos Usuario e TipoUsuario só devem ser atualizados se fornecidos explicitamente
            // Obter o tipo de usuário atual para usar como fallback, caso não seja fornecido
            const currentTipoUsuario = (await sql.query`SELECT TipoUsuario FROM Usuarios WHERE Id = ${id}`).recordset[0]?.TipoUsuario;

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

            // Registrar no histórico de usuários
            const historicoUsuario = usuario || (await sql.query`SELECT Usuario FROM Usuarios WHERE Id = ${id}`).recordset[0]?.Usuario || 'usuário';
            await sql.query`
                INSERT INTO HistoricoUsuarios (UsuarioId, DataAlteracao, Acao)
                VALUES (${req.body.usuarioId}, GETDATE(), ${'Usuário ' + historicoUsuario + ' atualizado'})
            `;
        } else {
            // Novo usuário - apenas masters podem criar
            if (currentUser.TipoUsuario !== 'master') {
                return res.json({ success: false, message: 'Apenas usuários master podem criar novos usuários' });
            }

            // Criptografar senha com bcrypt
            const hashedPassword = await bcrypt.hash(senha, parseInt(process.env.BCRYPT_SALT_ROUNDS) || 12);
            const dataInicioLicenca = req.body.dataInicioLicenca || null;
            const dataFimLicenca = req.body.dataFimLicenca || null;

            await sql.query`
                INSERT INTO Usuarios (NomeCompleto, Usuario, Email, Senha, TipoUsuario, DataInicioLicenca, DataFimLicenca, DataCriacao, DataAtualizacao)
                VALUES (${nomeCompleto}, ${usuario}, ${email}, ${hashedPassword}, ${tipoUsuario}, ${dataInicioLicenca}, ${dataFimLicenca}, GETDATE(), GETDATE())
            `;

            await sql.query`
                INSERT INTO HistoricoUsuarios (UsuarioId, DataAlteracao, Acao)
                VALUES (${req.body.usuarioId}, GETDATE(), ${'Novo usuário criado: ' + usuario})
            `;

            // Enviar e-mail com dados do novo usuário via Formspree
            try {
                const licencaInicio = dataInicioLicenca ? new Date(dataInicioLicenca).toLocaleDateString('pt-BR') : '—';
                const licencaFim = dataFimLicenca ? new Date(dataFimLicenca).toLocaleDateString('pt-BR') : '—';
                await axios.post('https://formspree.io/f/xaqawaep', {
                    _subject: `[RadarX] Novo usuário criado: ${usuario}`,
                    name: 'Sistema RadarX',
                    email: email || 'sem-email@radarx.com.br',
                    message:
                        `✅ Novo usuário cadastrado na plataforma RadarX\n\n` +
                        `Nome: ${nomeCompleto}\n` +
                        `Usuário (login): ${usuario}\n` +
                        `E-mail: ${email || '—'}\n` +
                        `Tipo: ${tipoUsuario}\n` +
                        `Senha inicial: ${senha}\n` +
                        `Licença início: ${licencaInicio}\n` +
                        `Licença fim: ${licencaFim}\n` +
                        `Cadastrado em: ${new Date().toLocaleString('pt-BR')}`,
                }, { headers: { Accept: 'application/json' } });
            } catch (emailErr) {
                console.warn('⚠️ Falha ao enviar e-mail via Formspree:', emailErr.message);
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
            SELECT TipoUsuario FROM Usuarios WHERE Id = ${req.body.usuarioId}
        `;

        if (userCheck.recordset.length === 0 || userCheck.recordset[0].TipoUsuario !== 'master') {
            return res.json({ success: false, message: 'Acesso não autorizado' });
        }

        // Não permitir excluir a si mesmo
        if (parseInt(id) === req.body.usuarioId) {
            return res.json({ success: false, message: 'Não é possível excluir seu próprio usuário' });
        }

        await sql.query`DELETE FROM Usuarios WHERE Id = ${id}`;

        await sql.query`
            INSERT INTO HistoricoUsuarios (UsuarioId, DataAlteracao, Acao)
            VALUES (${req.body.usuarioId}, GETDATE(), ${'Usuário excluído: ID ' + id})
        `;

        res.json({ success: true, message: 'Usuário excluído com sucesso' });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

const path = require('path');

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

// Rota principal para servir o portfolio.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/portifolio.html'));
});

// Rota para servir o RadarX (painel de futebol virtual)
app.get('/radarx.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, '../frontend/radarx.html'));
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

// Garante colunas extras em betano_eventos ao iniciar o servidor
async function garantirSchemaEventos() {
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

    // ── Inicia o agendador Bet365 junto com o servidor ──
    if (process.env.BET365_AGENDADOR_ATIVADO !== 'false') {
        const cron = require('node-cron');
        const Bet365Coletor = require('./services/bet365-coletor');
        const coletor365 = new Bet365Coletor();
        const intervaloSeg = parseInt(process.env.BET365_INTERVALO_SEG) || 0;
        const intervalo    = parseInt(process.env.BET365_INTERVALO) || 1;
        // BET365_INTERVALO_SEG=30 → a cada 30s  |  BET365_INTERVALO=1 → a cada 1min
        const expressao = intervaloSeg > 0
            ? `*/${intervaloSeg} * * * * *`
            : intervalo === 1 ? '* * * * *' : `*/${intervalo} * * * *`;
        const descIntervalo = intervaloSeg > 0 ? `${intervaloSeg}s` : `${intervalo}min`;

        console.log(`\n📡 Bet365 - Agendador iniciado (a cada ${descIntervalo})\n`);

        coletor365.coletar().catch(e => console.error('Bet365 coleta inicial:', e.message));
        cron.schedule(expressao, () => coletor365.coletar().catch(e => console.error('Bet365 cron:', e.message)));

        process.on('SIGINT', async () => { await coletor365.encerrar(); process.exit(0); });
        process.on('SIGTERM', async () => { await coletor365.encerrar(); process.exit(0); });
    }
});