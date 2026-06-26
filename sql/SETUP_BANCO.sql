-- ============================================================
-- SETUP_BANCO.sql
-- Script COMPLETO de criação do banco de dados PRODUCAO
-- Sistema: RadarDaBet + ControlFinance + Betano
-- Atualizado: 2026-06-26
-- ============================================================
-- EXECUÇÃO: SQL Server Management Studio conectado a 127.0.0.1
-- O script é idempotente: seguro rodar em banco existente.
-- ============================================================

USE PRODUCAO;
GO

PRINT '============================================================';
PRINT 'SETUP BANCO DE DADOS - PRODUCAO';
PRINT '============================================================';

-- ============================================================
-- TABELA: Usuarios
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[Usuarios]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[Usuarios] (
        [Id]                INT            IDENTITY(1,1) PRIMARY KEY,
        [NomeCompleto]      NVARCHAR(100)  NOT NULL,
        [Usuario]           NVARCHAR(50)   NOT NULL UNIQUE,
        [Email]             NVARCHAR(100)  NOT NULL UNIQUE,
        [Senha]             NVARCHAR(255)  NOT NULL,
        [TipoUsuario]       NVARCHAR(20)   NOT NULL DEFAULT 'user',
        [DataInicioLicenca] DATETIME2      NULL,
        [DataFimLicenca]    DATETIME2      NULL,
        [DataCriacao]       DATETIME2      NOT NULL DEFAULT GETDATE(),
        [DataAtualizacao]   DATETIME2      NULL DEFAULT GETDATE(),
        [Ativo]             BIT            NOT NULL DEFAULT 1,
        [Telefone]          NVARCHAR(20)   NULL,
        [UltimoAcesso]      DATETIME2      NULL,
        [PlanoAtivo]        NVARCHAR(50)   NULL DEFAULT 'Mensal',
        [sess_token]        NVARCHAR(64)   NULL,
        [sess_expira]       DATETIME2      NULL
    );
    CREATE INDEX IX_usuarios_email   ON Usuarios(Email);
    CREATE INDEX IX_usuarios_usuario ON Usuarios(Usuario);
    -- Usuário MASTER padrão (bcrypt hash — alterar senha após restore se necessário)
    INSERT INTO Usuarios (NomeCompleto, Usuario, Email, Senha, TipoUsuario, Ativo, DataInicioLicenca, DataFimLicenca)
    VALUES ('Administrador Master','MASTER','MT993.OLIVEIRA@gmail.com',
            '$2a$12$4lC7YmweQFNJNe1hqtCSJun5CeBze/LL21Jbei4Yep6P8vbx2Dwqu','master',1,'2026-03-22','2031-06-10');
    PRINT '✅ Tabela Usuarios criada com usuário MASTER!';
END
ELSE
BEGIN
    -- Garante colunas adicionadas depois
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('Usuarios') AND name='Telefone')
        ALTER TABLE Usuarios ADD Telefone NVARCHAR(20) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('Usuarios') AND name='UltimoAcesso')
        ALTER TABLE Usuarios ADD UltimoAcesso DATETIME2 NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('Usuarios') AND name='PlanoAtivo')
        ALTER TABLE Usuarios ADD PlanoAtivo NVARCHAR(50) NULL DEFAULT 'Mensal';
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('Usuarios') AND name='sess_token')
        ALTER TABLE Usuarios ADD sess_token NVARCHAR(64) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('Usuarios') AND name='sess_expira')
        ALTER TABLE Usuarios ADD sess_expira DATETIME2 NULL;
    PRINT 'ℹ️  Tabela Usuarios já existe';
END
GO

-- ============================================================
-- TABELA: ConfiguracoesSistema
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[ConfiguracoesSistema]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[ConfiguracoesSistema] (
        [Id]              INT            IDENTITY(1,1) PRIMARY KEY,
        [Chave]           NVARCHAR(100)  NOT NULL UNIQUE,
        [Valor]           NVARCHAR(500)  NOT NULL,
        [Descricao]       NVARCHAR(300)  NULL,
        [DataAtualizacao] DATETIME2      NOT NULL DEFAULT GETDATE()
    );
    INSERT INTO ConfiguracoesSistema (Chave, Valor, Descricao) VALUES
        ('SistemaNome',     'Controle de Gestão Financeira Avançada', 'Nome do sistema'),
        ('SistemaSubtitulo','Dashboard interativo com análises estatísticas e histórico completo','Subtítulo do sistema'),
        ('SQLDatabase',     'PRODUCAO',   'Nome do banco de dados'),
        ('SQLServer',       '127.0.0.1',  'Endereço do servidor SQL');
    PRINT '✅ Tabela ConfiguracoesSistema criada!';
END
ELSE
    PRINT 'ℹ️  Tabela ConfiguracoesSistema já existe';
GO

-- ============================================================
-- TABELA: HistoricoAcessos
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[HistoricoAcessos]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[HistoricoAcessos] (
        [id]          INT            IDENTITY(1,1) PRIMARY KEY,
        [usuario_id]  INT            NULL,
        [usuario]     NVARCHAR(100)  NOT NULL,
        [tipo]        NVARCHAR(30)   NOT NULL,
        [ip]          NVARCHAR(60)   NULL,
        [user_agent]  NVARCHAR(500)  NULL,
        [data_hora]   DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
        [cidade]      NVARCHAR(100)  NULL,
        [pais]        NVARCHAR(10)   NULL,
        [provedor]    NVARCHAR(200)  NULL,
        [duracao_seg] INT            NULL
    );
    CREATE INDEX IX_hist_acessos_uid  ON HistoricoAcessos(usuario_id);
    CREATE INDEX IX_hist_acessos_data ON HistoricoAcessos(data_hora DESC);
    PRINT '✅ Tabela HistoricoAcessos criada!';
END
ELSE
    PRINT 'ℹ️  Tabela HistoricoAcessos já existe';
GO

-- ============================================================
-- TABELA: ip_blacklist
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='ip_blacklist' AND xtype='U')
BEGIN
    CREATE TABLE ip_blacklist (
        ip           NVARCHAR(45)  NOT NULL PRIMARY KEY,
        bloqueado_por NVARCHAR(50) NULL,
        bloqueado_em  DATETIME2    NOT NULL DEFAULT GETDATE()
    );
    PRINT '✅ Tabela ip_blacklist criada!';
END
ELSE
    PRINT 'ℹ️  Tabela ip_blacklist já existe';
GO

-- ============================================================
-- TABELA: HistoricoAlteracoes
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[HistoricoAlteracoes]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[HistoricoAlteracoes] (
        [Id]            INT            IDENTITY(1,1) PRIMARY KEY,
        [Mes]           INT            NOT NULL,
        [Ano]           INT            NOT NULL,
        [DataAlteracao] DATETIME2      NOT NULL DEFAULT GETDATE(),
        [Acao]          NVARCHAR(1000) NOT NULL,
        [UsuarioId]     INT            NOT NULL
    );
    PRINT '✅ Tabela HistoricoAlteracoes criada!';
END
ELSE
    PRINT 'ℹ️  Tabela HistoricoAlteracoes já existe';
GO

-- ============================================================
-- TABELA: HistoricoUsuarios
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[HistoricoUsuarios]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[HistoricoUsuarios] (
        [Id]            INT            IDENTITY(1,1) PRIMARY KEY,
        [UsuarioId]     INT            NOT NULL,
        [DataAlteracao] DATETIME2      NOT NULL DEFAULT GETDATE(),
        [Acao]          NVARCHAR(500)  NOT NULL
    );
    CREATE INDEX IX_hist_usr_uid ON HistoricoUsuarios(UsuarioId);
    PRINT '✅ Tabela HistoricoUsuarios criada!';
END
ELSE
    PRINT 'ℹ️  Tabela HistoricoUsuarios já existe';
GO

-- ============================================================
-- TABELA: movimento
-- Tipos de movimento financeiro (receita/despesa)
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[movimento]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[movimento] (
        [Id]              INT            IDENTITY(1,1) PRIMARY KEY,
        [Descricao]       NVARCHAR(200)  NOT NULL,
        [Tipo]            NVARCHAR(1)    NOT NULL,   -- 'R' receita | 'D' despesa
        [Ativo]           BIT            NOT NULL DEFAULT 1,
        [DataCriacao]     DATETIME        NOT NULL DEFAULT GETDATE(),
        [DataAtualizacao] DATETIME        NOT NULL DEFAULT GETDATE()
    );
    PRINT '✅ Tabela movimento criada!';
END
ELSE
    PRINT 'ℹ️  Tabela movimento já existe';
GO

-- ============================================================
-- TABELA: DespesasMensais
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[DespesasMensais]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[DespesasMensais] (
        [Id]              INT            IDENTITY(1,1) PRIMARY KEY,
        [Mes]             INT            NOT NULL,
        [Ano]             INT            NOT NULL,
        [Descricao]       NVARCHAR(500)  NOT NULL,
        [Valor]           DECIMAL(15,2)  NOT NULL,
        [Observacoes]     NVARCHAR(1000) NULL,
        [UsuarioId]       INT            NOT NULL,
        [DataCriacao]     DATETIME2      NOT NULL DEFAULT GETDATE(),
        [DataAtualizacao] DATETIME2      NULL
    );
    CREATE INDEX IX_despesas_mensais_usuario ON DespesasMensais(UsuarioId);
    CREATE INDEX IX_despesas_mensais_mes_ano ON DespesasMensais(Ano, Mes);
    PRINT '✅ Tabela DespesasMensais criada!';
END
ELSE
    PRINT 'ℹ️  Tabela DespesasMensais já existe';
GO

-- ============================================================
-- TABELA: ContasReceber
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[ContasReceber]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[ContasReceber] (
        [Id]              INT            IDENTITY(1,1) PRIMARY KEY,
        [Mes]             INT            NOT NULL,
        [Ano]             INT            NOT NULL,
        [Descricao]       NVARCHAR(200)  NOT NULL,
        [Valor]           DECIMAL(15,2)  NOT NULL,
        [Observacoes]     NVARCHAR(500)  NULL,
        [MovimentoId]     INT            NULL,
        [UsuarioId]       INT            NOT NULL,
        [DataCriacao]     DATETIME2      NOT NULL DEFAULT GETDATE(),
        [DataAtualizacao] DATETIME2      NULL DEFAULT GETDATE()
    );
    CREATE INDEX IX_contas_receber_uid ON ContasReceber(UsuarioId);
    PRINT '✅ Tabela ContasReceber criada!';
END
ELSE
    PRINT 'ℹ️  Tabela ContasReceber já existe';
GO

-- ============================================================
-- TABELA: financeiro_lancamentos
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[financeiro_lancamentos]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[financeiro_lancamentos] (
        [id]          INT            IDENTITY(1,1) PRIMARY KEY,
        [tipo]        NVARCHAR(10)   NOT NULL,   -- 'receita' | 'despesa'
        [descricao]   NVARCHAR(200)  NOT NULL,
        [valor]       DECIMAL(15,2)  NOT NULL,
        [mes_ref]     NVARCHAR(7)    NOT NULL,   -- 'YYYY-MM'
        [data_criacao] DATETIME2     NOT NULL DEFAULT GETUTCDATE()
    );
    CREATE INDEX IX_fin_lanc_mes ON financeiro_lancamentos(mes_ref);
    PRINT '✅ Tabela financeiro_lancamentos criada!';
END
ELSE
    PRINT 'ℹ️  Tabela financeiro_lancamentos já existe';
GO

-- ============================================================
-- TABELA: usuario_preferencias
-- Preferências por usuário: cores, layout, etc.
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[usuario_preferencias]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[usuario_preferencias] (
        [Id]          INT            IDENTITY(1,1) PRIMARY KEY,
        [UsuarioId]   INT            NOT NULL,
        [Chave]       NVARCHAR(100)  NOT NULL,
        [Valor]       NVARCHAR(MAX)  NULL,
        [AtualizadoEm] DATETIME2    NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT UQ_usuario_pref UNIQUE (UsuarioId, Chave)
    );
    CREATE INDEX IX_usr_pref_uid ON usuario_preferencias(UsuarioId);
    PRINT '✅ Tabela usuario_preferencias criada!';
END
ELSE
    PRINT 'ℹ️  Tabela usuario_preferencias já existe';
GO

-- ============================================================
-- TABELA: chat_mensagens
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[chat_mensagens]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[chat_mensagens] (
        [id]           INT            IDENTITY(1,1) PRIMARY KEY,
        [usuario_id]   INT            NULL,
        [usuario_nome] NVARCHAR(100)  NULL,
        [mensagem]     NVARCHAR(1000) NULL,
        [criado_em]    DATETIME2      NOT NULL DEFAULT GETUTCDATE()
    );
    CREATE INDEX IX_chat_criado ON chat_mensagens(criado_em DESC);
    PRINT '✅ Tabela chat_mensagens criada!';
END
ELSE
    PRINT 'ℹ️  Tabela chat_mensagens já existe';
GO

-- ============================================================
-- TABELA: user_padroes_grafico
-- Padrões de gráfico salvos por usuário (publicados pelo MASTER)
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[user_padroes_grafico]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[user_padroes_grafico] (
        [id]               INT            IDENTITY(1,1) PRIMARY KEY,
        [user_id]          INT            NOT NULL,
        [nome]             NVARCHAR(100)  NOT NULL,
        [filtros]          NVARCHAR(MAX)  NOT NULL DEFAULT '{}',
        [is_principal]     BIT            NOT NULL DEFAULT 0,
        [data_criacao]     DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
        [data_atualizacao] DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
        [publicado_por]    INT            NULL,
        [is_publicado]     BIT            NOT NULL DEFAULT 0
    );
    CREATE INDEX IX_padroes_uid ON user_padroes_grafico(user_id);
    PRINT '✅ Tabela user_padroes_grafico criada!';
END
ELSE
    PRINT 'ℹ️  Tabela user_padroes_grafico já existe';
GO

-- ============================================================
-- TABELA: simulador_apostas
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[simulador_apostas]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[simulador_apostas] (
        [id]             INT           IDENTITY(1,1) PRIMARY KEY,
        [usuario_id]     INT           NOT NULL,
        [time_casa]      VARCHAR(120)  NOT NULL,
        [time_fora]      VARCHAR(120)  NOT NULL,
        [liga]           VARCHAR(120)  NOT NULL DEFAULT '',
        [data_jogo]      DATETIME      NOT NULL,
        [mercado]        VARCHAR(60)   NOT NULL,
        [odd]            DECIMAL(7,2)  NOT NULL,
        [creditos]       DECIMAL(10,2) NOT NULL,
        [resultado]      VARCHAR(20)   NOT NULL DEFAULT 'pendente',
        [lucro]          DECIMAL(10,2) NOT NULL DEFAULT 0,
        [data_aposta]    DATETIME      NOT NULL DEFAULT GETUTCDATE(),
        [data_resultado] DATETIME      NULL
    );
    CREATE INDEX IX_sim_uid_res ON simulador_apostas(usuario_id, resultado)
        INCLUDE (time_casa, time_fora, liga, data_jogo, mercado, odd,
                 creditos, lucro, data_aposta, data_resultado);
    PRINT '✅ Tabela simulador_apostas criada!';
END
ELSE
    PRINT 'ℹ️  Tabela simulador_apostas já existe';
GO

-- ============================================================
-- TABELA: kirvano_assinaturas
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[kirvano_assinaturas]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[kirvano_assinaturas] (
        [id]                       INT            IDENTITY(1,1) PRIMARY KEY,
        [kirvano_purchase_id]      NVARCHAR(150)  NULL,
        [kirvano_subscription_id]  NVARCHAR(150)  NULL,
        [email_cliente]            NVARCHAR(255)  NOT NULL,
        [nome_cliente]             NVARCHAR(255)  NOT NULL,
        [usuario_id]               INT            NULL,
        [usuario_login]            NVARCHAR(100)  NULL,
        [plano]                    NVARCHAR(100)  NOT NULL,
        [valor]                    DECIMAL(10,2)  NOT NULL,
        [evento]                   NVARCHAR(100)  NULL,
        [status]                   NVARCHAR(50)   NOT NULL DEFAULT 'ativo',
        [data_criacao]             DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
        [data_expiracao]           DATETIME2      NULL,
        [payload_raw]              NVARCHAR(MAX)  NULL
    );
    CREATE INDEX IX_kirv_assin_email    ON kirvano_assinaturas(email_cliente);
    CREATE INDEX IX_kirv_assin_purchase ON kirvano_assinaturas(kirvano_purchase_id);
    CREATE INDEX IX_kirv_assin_usuario  ON kirvano_assinaturas(usuario_id);
    PRINT '✅ Tabela kirvano_assinaturas criada!';
END
ELSE
    PRINT 'ℹ️  Tabela kirvano_assinaturas já existe';
GO

-- ============================================================
-- TABELA: kirvano_credenciais_temp
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[kirvano_credenciais_temp]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[kirvano_credenciais_temp] (
        [usuario_id]  INT           NOT NULL PRIMARY KEY,
        [senha_plain] NVARCHAR(50)  NOT NULL,
        [criado_em]   DATETIME2     NOT NULL DEFAULT GETUTCDATE()
    );
    PRINT '✅ Tabela kirvano_credenciais_temp criada!';
END
ELSE
    PRINT 'ℹ️  Tabela kirvano_credenciais_temp já existe';
GO

-- ============================================================
-- TABELA: kirvano_webhook_log
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[kirvano_webhook_log]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[kirvano_webhook_log] (
        [id]          INT            IDENTITY(1,1) PRIMARY KEY,
        [recebido_em] DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
        [evento]      NVARCHAR(200)  NULL,
        [email]       NVARCHAR(255)  NULL,
        [action]      NVARCHAR(50)   NULL,
        [payload_raw] NVARCHAR(MAX)  NULL
    );
    CREATE INDEX IX_kirv_wh_log_email ON kirvano_webhook_log(email);
    CREATE INDEX IX_kirv_wh_log_data  ON kirvano_webhook_log(recebido_em DESC);
    PRINT '✅ Tabela kirvano_webhook_log criada!';
END
ELSE
    PRINT 'ℹ️  Tabela kirvano_webhook_log já existe';
GO

-- ============================================================
-- TABELA: betano_eventos
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[betano_eventos]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[betano_eventos] (
        [id]                    BIGINT PRIMARY KEY,
        [url]                   NVARCHAR(500) NOT NULL,
        [region_name]           NVARCHAR(200) NULL,
        [league_name]           NVARCHAR(200) NOT NULL,
        [league_id]             NVARCHAR(50)  NULL,
        [subscription_key]      NVARCHAR(100) NULL,
        [seconds_to_start]      INT           NULL,
        [start_time]            BIGINT        NULL,
        [start_time_datetime]   DATETIME2     NULL,
        [time_casa]             NVARCHAR(100) NULL,
        [time_fora]             NVARCHAR(100) NULL,
        [status]                NVARCHAR(50)  NOT NULL DEFAULT 'AGENDADO',
        [resultado_casa]        INT           NULL,
        [resultado_fora]        INT           NULL,
        [data_coleta]           DATETIME2     NOT NULL DEFAULT GETDATE(),
        [data_atualizacao]      DATETIME2     NOT NULL DEFAULT GETDATE(),
        [ativo]                 BIT           NOT NULL DEFAULT 1
    );
    CREATE INDEX IX_betano_eventos_start_time ON betano_eventos(start_time);
    CREATE INDEX IX_betano_eventos_league     ON betano_eventos(league_name);
    CREATE INDEX IX_betano_eventos_status     ON betano_eventos(status);
    PRINT '✅ Tabela betano_eventos criada!';
END
ELSE
    PRINT 'ℹ️  Tabela betano_eventos já existe';
GO

-- ============================================================
-- TABELA: betano_mercados
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[betano_mercados]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[betano_mercados] (
        [id]            BIGINT PRIMARY KEY,
        [evento_id]     BIGINT        NOT NULL,
        [nome]          NVARCHAR(200) NOT NULL,
        [tipo]          NVARCHAR(50)  NULL,
        [handicap]      DECIMAL(10,2) NOT NULL DEFAULT 0,
        [data_coleta]   DATETIME2     NOT NULL DEFAULT GETDATE(),
        [ativo]         BIT           NOT NULL DEFAULT 1,
        CONSTRAINT FK_betano_mercados_eventos
            FOREIGN KEY (evento_id) REFERENCES betano_eventos(id) ON DELETE CASCADE
    );
    CREATE INDEX IX_betano_mercados_evento ON betano_mercados(evento_id);
    PRINT '✅ Tabela betano_mercados criada!';
END
ELSE
    PRINT 'ℹ️  Tabela betano_mercados já existe';
GO

-- ============================================================
-- TABELA: betano_odds
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[betano_odds]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[betano_odds] (
        [id]            BIGINT PRIMARY KEY,
        [mercado_id]    BIGINT        NOT NULL,
        [evento_id]     BIGINT        NOT NULL,
        [nome]          NVARCHAR(100) NOT NULL,
        [full_name]     NVARCHAR(200) NULL,
        [valor]         DECIMAL(10,2) NOT NULL,
        [handicap]      DECIMAL(10,2) NOT NULL DEFAULT 0,
        [column_index]  INT           NULL,
        [data_coleta]   DATETIME2     NOT NULL DEFAULT GETDATE(),
        [ativo]         BIT           NOT NULL DEFAULT 1,
        CONSTRAINT FK_betano_odds_mercados
            FOREIGN KEY (mercado_id) REFERENCES betano_mercados(id) ON DELETE CASCADE
    );
    CREATE INDEX IX_betano_odds_mercado ON betano_odds(mercado_id);
    CREATE INDEX IX_betano_odds_evento  ON betano_odds(evento_id);
    PRINT '✅ Tabela betano_odds criada!';
END
ELSE
    PRINT 'ℹ️  Tabela betano_odds já existe';
GO

-- ============================================================
-- TABELA: betano_historico_odds
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[betano_historico_odds]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[betano_historico_odds] (
        [id]                    BIGINT IDENTITY(1,1) PRIMARY KEY,
        [evento_id]             BIGINT        NOT NULL,
        [mercado_id]            BIGINT        NOT NULL,
        [odd_id]                BIGINT        NOT NULL,
        [nome_selecao]          NVARCHAR(100) NOT NULL,
        [valor_odd]             DECIMAL(10,2) NOT NULL,
        [variacao_percentual]   DECIMAL(10,4) NULL,
        [data_coleta]           DATETIME2     NOT NULL DEFAULT GETDATE()
    );
    CREATE INDEX IX_betano_historico_evento ON betano_historico_odds(evento_id);
    CREATE INDEX IX_betano_historico_data   ON betano_historico_odds(data_coleta);
    PRINT '✅ Tabela betano_historico_odds criada!';
END
ELSE
    PRINT 'ℹ️  Tabela betano_historico_odds já existe';
GO

-- ============================================================
-- TABELA: betano_historico_partidas
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[betano_historico_partidas]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[betano_historico_partidas] (
        [id]            BIGINT IDENTITY(1,1) PRIMARY KEY,
        [evento_id]     BIGINT        NOT NULL,
        [liga]          NVARCHAR(200) NULL,
        [time_casa]     NVARCHAR(100) NOT NULL,
        [time_fora]     NVARCHAR(100) NOT NULL,
        [gol_casa]      INT           NOT NULL DEFAULT 0,
        [gol_fora]      INT           NOT NULL DEFAULT 0,
        [resultado]     NVARCHAR(10)  NOT NULL,
        [odd_casa]      DECIMAL(10,2) NOT NULL DEFAULT 0,
        [odd_empate]    DECIMAL(10,2) NOT NULL DEFAULT 0,
        [odd_fora]      DECIMAL(10,2) NOT NULL DEFAULT 0,
        [data_partida]  DATETIME2     NULL,
        [data_registro] DATETIME2     NOT NULL DEFAULT GETDATE()
    );
    CREATE INDEX IX_hist_time_casa ON betano_historico_partidas(time_casa);
    CREATE INDEX IX_hist_time_fora ON betano_historico_partidas(time_fora);
    CREATE INDEX IX_hist_liga      ON betano_historico_partidas(liga);
    CREATE INDEX IX_hist_data      ON betano_historico_partidas(data_partida);
    CREATE UNIQUE INDEX IX_hist_evento ON betano_historico_partidas(evento_id);
    PRINT '✅ Tabela betano_historico_partidas criada!';
END
ELSE
    PRINT 'ℹ️  Tabela betano_historico_partidas já existe';
GO

-- ============================================================
-- TABELA: betano_estatisticas_tempo_real
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[betano_estatisticas_tempo_real]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[betano_estatisticas_tempo_real] (
        [id]                        BIGINT IDENTITY(1,1) PRIMARY KEY,
        [evento_id]                 BIGINT        NOT NULL,
        [minuto]                    NVARCHAR(20)  NULL,
        [gol_casa]                  INT           NOT NULL DEFAULT 0,
        [gol_fora]                  INT           NOT NULL DEFAULT 0,
        [posse_bola_casa]           DECIMAL(5,2)  NULL,
        [posse_bola_fora]           DECIMAL(5,2)  NULL,
        [chutes_casa]               INT           NOT NULL DEFAULT 0,
        [chutes_fora]               INT           NOT NULL DEFAULT 0,
        [chutes_gol_casa]           INT           NOT NULL DEFAULT 0,
        [chutes_gol_fora]           INT           NOT NULL DEFAULT 0,
        [escanteios_casa]           INT           NOT NULL DEFAULT 0,
        [escanteios_fora]           INT           NOT NULL DEFAULT 0,
        [cartoes_amarelos_casa]     INT           NOT NULL DEFAULT 0,
        [cartoes_amarelos_fora]     INT           NOT NULL DEFAULT 0,
        [cartoes_vermelhos_casa]    INT           NOT NULL DEFAULT 0,
        [cartoes_vermelhos_fora]    INT           NOT NULL DEFAULT 0,
        [ataques_casa]              INT           NOT NULL DEFAULT 0,
        [ataques_fora]              INT           NOT NULL DEFAULT 0,
        [ataques_perigo_casa]       INT           NOT NULL DEFAULT 0,
        [ataques_perigo_fora]       INT           NOT NULL DEFAULT 0,
        [dados_completos]           NVARCHAR(MAX) NULL,
        [data_coleta]               DATETIME2     NOT NULL DEFAULT GETDATE(),
        CONSTRAINT FK_estatisticas_evento FOREIGN KEY (evento_id) REFERENCES betano_eventos(id)
    );
    CREATE INDEX IX_betano_est_evento ON betano_estatisticas_tempo_real(evento_id);
    CREATE INDEX IX_betano_est_data   ON betano_estatisticas_tempo_real(data_coleta DESC);
    PRINT '✅ Tabela betano_estatisticas_tempo_real criada!';
END
ELSE
    PRINT 'ℹ️  Tabela betano_estatisticas_tempo_real já existe';
GO

-- ============================================================
-- TABELA: betano_log_coleta
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[betano_log_coleta]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[betano_log_coleta] (
        [id]                        BIGINT IDENTITY(1,1) PRIMARY KEY,
        [data_inicio]               DATETIME2     NOT NULL DEFAULT GETDATE(),
        [data_fim]                  DATETIME2     NULL,
        [status]                    NVARCHAR(50)  NOT NULL DEFAULT 'INICIANDO',
        [eventos_coletados]         INT           NOT NULL DEFAULT 0,
        [mercados_coletados]        INT           NOT NULL DEFAULT 0,
        [odds_coletadas]            INT           NOT NULL DEFAULT 0,
        [estatisticas_coletadas]    INT           NOT NULL DEFAULT 0,
        [historico_odds_salvas]     INT           NOT NULL DEFAULT 0,
        [erro_mensagem]             NVARCHAR(MAX) NULL
    );
    CREATE INDEX IX_betano_log_data ON betano_log_coleta(data_inicio);
    PRINT '✅ Tabela betano_log_coleta criada!';
END
ELSE
    PRINT 'ℹ️  Tabela betano_log_coleta já existe';
GO

-- ============================================================
-- TABELA: bet365_config
-- 328 chaves — INSERT individual com IF NOT EXISTS (idempotente)
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[bet365_config]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[bet365_config] (
        [id]               INT            IDENTITY(1,1) PRIMARY KEY,
        [chave]            NVARCHAR(100)  NOT NULL UNIQUE,
        [valor]            NVARCHAR(500)  NOT NULL,
        [descricao]        NVARCHAR(500)  NULL,
        [data_atualizacao] DATETIME2      NOT NULL DEFAULT GETUTCDATE()
    );
    PRINT '✅ Tabela bet365_config criada!';
END
ELSE
    PRINT 'ℹ️  Tabela bet365_config já existe';
GO

-- Insere chaves ausentes (seguro rodar sempre)
DECLARE @cfg TABLE (chave NVARCHAR(100), valor NVARCHAR(500), descricao NVARCHAR(500));
INSERT INTO @cfg VALUES
('alerta_ativado','true','Ativar sistema de alertas (Telegram + e-mail)'),
('alerta_btts_mosaico','true','Sugestão BTTS no Mosaico — exibir linha de destaque na grid'),
('alerta_btts_mosaico_botao','true','Sugestão BTTS — exibir botão "Ambas Marcam" no toolbar do Mosaico'),
('alerta_btts_mosaico_pct','50','Sugestão BTTS — limite máximo de % de Ambas Marcam (padrão: 50)'),
('alerta_liga_piscar_s','180','Duração do piscar da liga nos alertas visuais (segundos)'),
('alerta_minutos_sem_coleta','10','Minutos sem coleta bem-sucedida para disparar alerta'),
('alerta_over25_mosaico','true','Exibir linha de sugestão Over 2.5 na grid'),
('alerta_over25_mosaico_botao','true','Exibir botão "Over 2.5" no toolbar do Mosaico'),
('alerta_over25_mosaico_pct','50','Limite % de Over 2.5 para exibir sugestão no Mosaico (padrão: 50)'),
('alerta_popup_ativo','false','Exibir popup de alerta visual'),
('alerta_visual_duracao_s','181','Duração do alerta visual piscante na grade (segundos)'),
('analise_liberar_bronze','true','Análise & Sugestões: liberar para Bronze'),
('analise_liberar_gold','true','Análise & Sugestões: liberar para Gold'),
('analise_liberar_prata','true','Análise & Sugestões: liberar para Prata'),
('analise_liberar_premium','true','Análise & Sugestões: liberar para Premium'),
('analise_liberar_user','true','Análise & Sugestões: liberar para User'),
('auto_refresh_segundos','5','Intervalo de atualização automática da grade (segundos; 0 = desativar)'),
('auto_reinicio_minutos','20','Reinício automático: minutos sem coleta para reiniciar (0 = desativado)'),
('backoff_ligas_ativo','false','Backoff automático — pausar tentativas quando ligas não aparecem N vezes'),
('backoff_ligas_espera_min','5','Backoff: minutos de espera ao atingir o limite de falhas'),
('backoff_ligas_threshold','5','Backoff: nº de falhas consecutivas para ativar a pausa'),
('brute_force_bloqueio_min','10','Brute Force: duração do bloqueio (minutos)'),
('brute_force_janela_min','15','Brute Force: janela de tempo (minutos)'),
('brute_force_tentativas','10','Brute Force: tentativas antes de bloquear'),
('cache_resultados_ativo','false','Cache de resultados: pular re-coleta no mesmo ciclo'),
('chart_cor_ambas_nao','#00c8ff','Cor — AmbNão (BTTS Não)'),
('chart_cor_ambas_sim','#ffffff','Cor — Ambas (BTTS: ambos marcam)'),
('chart_cor_casa_marca','#4ade80','Cor — CM (Casa Marca)'),
('chart_cor_cd_12','#22d3ee','Cor — 12 (Chance Dupla: Casa ou Fora)'),
('chart_cor_cd_1x','#84cc16','Cor — 1X (Chance Dupla: Casa ou Empate)'),
('chart_cor_cd_x2','#f97316','Cor — X2 (Chance Dupla: Empate ou Fora)'),
('chart_cor_equilibrio','#64748b','Cor — Equilíbrio (linha de referência/média)'),
('chart_cor_esp_btts_o25','#2dd4bf','Cor — Ambas+O2.5'),
('chart_cor_esp_btts_u25','#38bdf8','Cor — Ambas+U2.5'),
('chart_cor_esp_casa_o15','#34d399','Cor — Casa+O1.5'),
('chart_cor_esp_fora_o15','#fb923c','Cor — Fora+O1.5'),
('chart_cor_fora_marca','#fbbf24','Cor — FM (Fora Marca)'),
('chart_cor_ft_casa','#84cc16','Cor — Casa FT'),
('chart_cor_ft_empate','#a78bfa','Cor — Empate FT'),
('chart_cor_ft_fora','#fb923c','Cor — Fora FT'),
('chart_cor_gols_0','#eb4747','Cor — 0G'),
('chart_cor_gols_1','#1e71e6','Cor — 1G'),
('chart_cor_gols_1t','false','Gráfico de Gols: cor da linha Gols 1T'),
('chart_cor_gols_2','#398445','Cor — 2G'),
('chart_cor_gols_2t','false','Gráfico de Gols: cor da linha Gols 2T'),
('chart_cor_gols_3','#867523','Cor — 3G'),
('chart_cor_gols_4','#7d07f2','Cor — 4G'),
('chart_cor_gols_5p','#5b012f','Cor — 5+ Gols FT'),
('chart_cor_gols_casa','false','Gráfico de Gols: cor da linha Casa'),
('chart_cor_gols_fora','false','Gráfico de Gols: cor da linha Fora'),
('chart_cor_gols_total','false','Gráfico de Gols: cor da linha Gols Total'),
('chart_cor_ht_0_0','#64748b','Cor — 0-0 HT'),
('chart_cor_ht_0_1','#f87171','Cor — 0-1 HT'),
('chart_cor_ht_0_2','#fca5a5','Cor — 0-2 HT'),
('chart_cor_ht_1_0','#4ade80','Cor — 1-0 HT'),
('chart_cor_ht_1_1','#a78bfa','Cor — 1-1 HT'),
('chart_cor_ht_2_0','#86efac','Cor — 2-0 HT'),
('chart_cor_ht_casa','#65a30d','Cor — Casa HT'),
('chart_cor_ht_empate','#c4b5fd','Cor — Empate HT'),
('chart_cor_ht_fora','#f97316','Cor — Fora HT'),
('chart_cor_ht_gols','#67e8f9','Cor — Gol HT'),
('chart_cor_ht_out','#94a3b8','Cor — OUT HT'),
('chart_cor_ht_over','#22d3ee','Cor — O1.5 HT'),
('chart_cor_ht_under','#0891b2','Cor — U1.5 HT'),
('chart_cor_htft_cc','#166534','Cor — casa-casa HT/FT'),
('chart_cor_htft_ce','#15803d','Cor — casa-empate HT/FT'),
('chart_cor_htft_cf','#16a34a','Cor — casa-fora HT/FT'),
('chart_cor_htft_ec','#4c1d95','Cor — empate-casa HT/FT'),
('chart_cor_htft_ee','#6d28d9','Cor — empate-empate HT/FT'),
('chart_cor_htft_ef','#7c3aed','Cor — empate-fora HT/FT'),
('chart_cor_htft_fc','#7f1d1d','Cor — fora-casa HT/FT'),
('chart_cor_htft_fe','#991b1b','Cor — fora-empate HT/FT'),
('chart_cor_htft_ff','#b91c1c','Cor — fora-fora HT/FT'),
('chart_cor_impar_ft','#ffffff','Cor — Ímpar FT'),
('chart_cor_mg_0','#475569','Cor — 0-0 Margem de Vitória'),
('chart_cor_mg_1g','#fbbf24','Cor — Mg1 Margem de Vitória'),
('chart_cor_mg_2g','#f59e0b','Cor — Mg2 Margem de Vitória'),
('chart_cor_mg_3gp','#d97706','Cor — Mg3+ Margem de Vitória'),
('chart_cor_mg_eg','#818cf8','Cor — EmpG Margem de Vitória'),
('chart_cor_mm21','#fbbf24','Cor — MM21 (Média Móvel 21 jogos)'),
('chart_cor_mm9','#60a5fa','Cor — MM9 (Média Móvel 9 jogos)'),
('chart_cor_over0_5','#c3c1c1','Cor — O0.5'),
('chart_cor_over1_5','#d60000','Cor — O1.5'),
('chart_cor_over2_5','#fbff00','Cor — O2.5'),
('chart_cor_over3_5','#b0950c','Cor — O3.5'),
('chart_cor_over4_5','#fa007d','Cor — O4.5'),
('chart_cor_par_ft','#b90e0e','Cor — Par FT'),
('chart_cor_pmr_casa','#4ade80','Cor — 1ºC Primeiro a Marcar Casa'),
('chart_cor_pmr_fora','#fb923c','Cor — 1ºV Primeiro a Marcar Fora'),
('chart_cor_pmr_ng','#94a3b8','Cor — 0-0 Primeiro a Marcar nenhum'),
('chart_cor_st_ambas','#06b6d4','Cor — Ambas 2T'),
('chart_cor_st_ambas_nao','#164e63','Cor — AmbNão 2T'),
('chart_cor_st_casa','#4ade80','Cor — Casa 2T'),
('chart_cor_st_empate','#a78bfa','Cor — Emp 2T'),
('chart_cor_st_fora','#fb923c','Cor — Fora 2T'),
('chart_cor_st_gols_0','#475569','Cor — 0G 2T'),
('chart_cor_st_gols_1','#94a3b8','Cor — 1G 2T'),
('chart_cor_st_gols_2','#60a5fa','Cor — 2G 2T'),
('chart_cor_st_gols_3','#818cf8','Cor — 3G 2T'),
('chart_cor_st_gols_3p','#f472b6','Cor — 3+ 2T'),
('chart_cor_st_gols_4','#c084fc','Cor — 4G 2T'),
('chart_cor_st_gols_5p','#f472b6','Cor — 5+ 2T'),
('chart_cor_st_over1_5','#22d3ee','Cor — O1.5 2T'),
('chart_cor_st_under1_5','#0891b2','Cor — U1.5 2T'),
('chart_cor_under0_5','#88b6f7','Cor — U0.5'),
('chart_cor_under1_5','#e7b7f0','Cor — U1.5'),
('chart_cor_under2_5','#44c62a','Cor — U2.5'),
('chart_cor_under3_5','#70e7ff','Cor — U3.5'),
('chat_historico_horas','24','Chat: horas de histórico exibido ao abrir (padrão: 24)'),
('chat_notificacao','true','Chat: piscar botão e exibir badge quando há mensagens novas'),
('coletar_proximos_jogos','true','Habilitar coleta de próximos jogos agendados'),
('coletor_auto_restart','true','Coletor: reiniciar automaticamente quando login falha'),
('coletor2_ativo','false','Coletor 2 (Odds pré-jogo) — ativar/pausar coleta'),
('coletor2_janela_visivel','true','Coletor 2: exibir janela CMD visível'),
('coletor2_minutos','03,13,23,33,43,53','Coletor 2: minutos da hora para disparar coleta'),
('coletor3_ativo','true','Coletor 3 (Backfill Auto) — verificar lacunas automaticamente'),
('coletor3_minuto_execucao','20','Coletor 3: minuto de cada hora para verificar lacunas (0–59)'),
('config_versao','7','Versão das configurações — incrementar força reset do localStorage'),
('default_dias_analise','100','Padrão de jogos para Análise (mín. 20)'),
('default_exibir_clubes','false','Exibir Clubes ativado por padrão na grade'),
('default_exibir_ht','false','Exibir HT ativado por padrão na grade'),
('default_exibir_odds','false','Exibir Odds ativado por padrão na grade'),
('default_freq_min','60','Frequência mínima % padrão (Análise)'),
('default_horas_historico','12','Período padrão da Tabela Histórica (horas)'),
('default_janela_recente','20','Janela recente padrão (Análise)'),
('default_jogos_gols','200','Padrão de jogos — Gráfico de Gols'),
('default_jogos_grafico','200','Período padrão — Gráfico de Gols [legado]'),
('default_jogos_linha','200','Padrão de jogos — Gráfico de Linha'),
('default_jogos_mosaico','120','Padrão de jogos — Grade (Mosaico)'),
('default_jogos_parimpar','200','Período padrão — Gráfico Par/Ímpar'),
('default_legendas','false','Legendas ativado por padrão no gráfico'),
('default_min_amostras','3','Mínimo de amostras padrão (Análise)'),
('default_mosaico_gols','false','Linha ativado por padrão no Mosaico'),
('default_mosaico_pct','false','% Linha ativado por padrão no Mosaico'),
('default_open_gols','false','Aberto por padrão: Gráfico de Gols'),
('default_open_grafico','true','Aberto por padrão: Gráfico [legado]'),
('default_open_linha','true','Aberto por padrão: Gráfico de Linha'),
('default_open_mercados','false','Aberto por padrão: Mercados'),
('default_open_mosaico','true','Aberto por padrão: Menu Mosaico'),
('default_open_parimpar','false','Aberto por padrão: Par/Ímpar'),
('default_proximos_jogos','false','Próximos Jogos ativado por padrão na grade'),
('default_so_value_bets','false','Apenas value bets por padrão (Análise)'),
('default_tema','CARBON','Tema padrão para todos os usuários'),
('default_tipo_mercado','Todos','Tipo de mercado padrão (Análise)'),
('delay_aguarda_mercado_ms','1000','Delay de polling ao aguardar mercados (ms)'),
('delay_apos_clicar_liga_ms','2500','Delay após clicar na aba da liga (ms)'),
('delay_apos_resultados_ms','2000','Delay após abrir aba de Resultados (ms)'),
('delay_confirmacao_modal_ms','6000','Modal confirmação: aguardar (ms) após preencher'),
('delay_credenciais_ms','5000','Login: aguardar (ms) após submeter credenciais'),
('delay_data_nasc_ms','1000','Modal confirmação: aguardar após preencher data de nascimento'),
('delay_email_ms','1000','Modal confirmação: aguardar após preencher e-mail'),
('delay_entre_horarios_ms','2000','Delay entre cliques de horário (ms)'),
('delay_expandir_mercados_ms','1000','Delay após expandir mercados internos (ms)'),
('delay_initial_load_ms','2000','Delay após carregar a página inicial (ms)'),
('delay_modal_login_ms','3000','Delay aguardando modal de login aparecer (ms)'),
('delay_pos_login_ms','5000','Delay após clicar em Login para aguardar sessão (ms)'),
('delay_pos_reload_ms','2500','Delay após reload da página (ms)'),
('delay_show_more_ms','1000','Delay entre cliques em "Mostrar Mais" (ms)'),
('delay_volta_proximos_ms','2000','Delay ao voltar para Próximos Jogos (ms)'),
('f5_entre_ligas','true','Ctrl+F5 entre ligas (recarrega pagina apos cada liga)'),
('fonte_proximos','results','Fonte dos próximos jogos: results = página de resultados'),
('grafico_altura','200','Gráfico: altura do painel (px)'),
('grafico_congest','false','Gráfico: destacar zonas de congestão por padrão'),
('grafico_fixa','false','Gráfico: fixar linha de referência por padrão'),
('grafico_gols_altura','500','Gráfico de Gols: altura do painel (px)'),
('grafico_gols_barra','true','Gráfico de Gols: cor das barras'),
('grafico_gols_flat','true','Gráfico de Gols: ocultar bolinhas sem variação por padrão'),
('grafico_gols_flat_visivel','true','Gráfico de Gols: exibir o botão Plano na toolbar'),
('grafico_gols_label_cor','#73ff00','Gráfico de Gols: cor dos números sobre as bolinhas (hex)'),
('grafico_gols_label_tamanho','12','Gráfico de Gols: tamanho da fonte dos números (px)'),
('grafico_gols_mm','true','Gráfico de Gols: cor da MM'),
('grafico_gols_ponto_borda','2','Gráfico de Gols: espessura da borda das bolinhas (px)'),
('grafico_gols_ponto_raio','4','Gráfico de Gols: raio das bolinhas (px)'),
('grafico_impar_cor','#2dfb04','Gráfico Par/Ímpar: cor do Ímpar'),
('grafico_linha_altura','500','Gráfico de Linha: altura do painel (px)'),
('grafico_macd_altura','300','Gráfico MACD: altura do sub-painel (px)'),
('grafico_medias','false','Gráfico: exibir médias móveis por padrão'),
('grafico_mercados_master_only','false','Restringir acesso aos Mercados apenas ao Master'),
('grafico_mm1','9','Gráfico: período da MM curta (padrão 9 jogos)'),
('grafico_mm1_cor','#36fa00','MM curta: cor da linha (hex)'),
('grafico_mm1_dash','0','MM curta: padrão tracejado'),
('grafico_mm1_espessura','2','MM curta: espessura da linha (px)'),
('grafico_mm2','21','Gráfico: período da MM longa (padrão 21 jogos)'),
('grafico_mm2_cor','#ff0000','MM longa: cor da linha (hex)'),
('grafico_mm2_dash','0','MM longa: padrão tracejado'),
('grafico_mm2_espessura','2','MM longa: espessura da linha (px)'),
('grafico_par_cor','#e01010','Gráfico Par/Ímpar: cor do Par'),
('grafico_pct','true','Gráfico: exibir % no final das linhas por padrão'),
('grafico_pct_cor','#e00000','% Gráfico: cor do texto de porcentagem'),
('grafico_pct_tamanho','11','% Gráfico: tamanho da fonte da porcentagem (px)'),
('grafico_pills_default','true','Exibir seleção de mercados (pills) por padrão'),
('grafico_ponto_borda','3','Gráfico: espessura da borda das bolinhas (px)'),
('grafico_ponto_cores','true','Cores: vir habilitado por padrão (verde=hit / vermelho=miss)'),
('grafico_ponto_cores_visivel','true','Cores: exibir o botão de cores nos gráficos'),
('grafico_ponto_desce_cor','#ff0000','Gráfico: cor da bolinha quando desce (hex)'),
('grafico_ponto_flat','true','Plano: vir habilitado por padrão'),
('grafico_ponto_flat_visivel','false','Plano: exibir o botão nos gráficos'),
('grafico_ponto_raio','2','Gráfico: raio das bolinhas nos gráficos (px)'),
('grafico_ponto_sobe_cor','#3bff05','Gráfico: cor da bolinha quando sobe (hex)'),
('grafico_rsi_altura','300','Gráfico RSI: altura do sub-painel (px)'),
('grafico_tf_fundo_cor','#ff0000','Gráfico T/F: cor do ponto Fundo (mínimo)'),
('grafico_tf_topo_cor','#00ff5e','Gráfico T/F: cor do ponto Topo (máximo)'),
('grafico_topo_fundo','false','Gráfico: marcar topo/fundo por padrão'),
('grafico_watermark_opacidade','10','Marca d''água: opacidade (0 = invisível)'),
('grid_canetaCor','#f50a0a','Caneta: cor padrão'),
('grid_clubeFs','16','Fonte dos Clubes (px)'),
('grid_clubeTxt','#050505','Clubes — cor do texto'),
('grid_filtroAtivoBg','#1fcc59','Botões Mercado ativo: cor de fundo'),
('grid_filtroAtivoTxt','#59ff00','Botões Mercado ativo: cor do texto'),
('grid_filtroInativoBg','#1fcc59','Botões Mercado inativo: cor base'),
('grid_ftFs','16','Fonte Resultado FT (px)'),
('grid_ftTxt','#000000','Resultado FT — cor do texto'),
('grid_futuroBg','#ffffff','Próximos: cor de fundo'),
('grid_futuroBrd','#0a0a0b','Próximos: cor da borda'),
('grid_futuroTxt','#000000','Próximos: cor do texto'),
('grid_horaHHCor','#73ff00','Hora (HH): cor'),
('grid_horaMinCor','#6aeb00','Minuto (:MM): cor'),
('grid_horaMinFs','16','Fonte :MM coluna minuto (px)'),
('grid_htFs','16','Fonte Resultado HT (px)'),
('grid_htTxt','#000000','Resultado HT — cor do texto'),
('grid_oddAzarao','#000000','Odd azarão (>3): cor'),
('grid_oddFav','#000000','Odd favorito (<2.0): cor'),
('grid_oddFs','12','Fonte das Odds (px)'),
('grid_oddMed','#000000','Odd médio (2–3): cor'),
('grid_proxFs','14','Fonte Próximos Jogos (px)'),
('grid_selClubBg','#ffffff','Seleção Clube: fundo'),
('grid_selClubBrd','#050505','Seleção Clube: borda'),
('grid_selColBg','#00ff00','Coluna selecionada: fundo'),
('grid_selColBrd','#75e802','Coluna selecionada: borda'),
('grid_selColTxt','#0c0d0d','Coluna selecionada: texto'),
('grid_selRowBg','#4dff00','Linha selecionada: fundo'),
('grid_selRowBrd','#90f000','Linha selecionada: borda'),
('grid_selRowTxt','#030303','Linha selecionada: texto'),
('grid_selScoreBg','#fafafa','Seleção Resultado: fundo'),
('grid_selScoreBrd','#000000','Seleção Resultado: borda'),
('grid_verdeBg','#02f262','Acerto: cor de fundo'),
('grid_verdeTxt','#000000','Acerto: cor do texto'),
('grid_vermBg','#ff0000','Erro: cor de fundo'),
('grid_vermTxt','#000000','Erro: cor do texto'),
('header_subtitle_cor','#94a3b8','Header — cor do subtítulo'),
('header_subtitle_tamanho','0','Header — tamanho da fonte do subtítulo (px)'),
('header_subtitle_texto','','Header — texto ao lado do logo'),
('hist_delay_clique_ms','4000','Backfill: delay após cada clique em jogo (ms)'),
('hist_max_cliques','5','Backfill: máximo de tentativas de clique por jogo'),
('hist_retry_delay_ms','600000','Backfill: delay (ms) antes de retentar após falha'),
('historico_cache_segundos','10','Cache do servidor — grade/histórico (segundos)'),
('intervalo_coleta_seg','5','Intervalo entre ciclos de coleta (segundos)'),
('intervalo_proximos_min','3','Intervalo mínimo entre buscas de próximos jogos por liga (min)'),
('janela_proximos_min','6','Janela de antecedência para próximos jogos (minutos)'),
('liga_euro_cup','true','Coletar Euro Cup'),
('liga_express_cup','false','Coletar Express Cup'),
('liga_img_altura','68','Ligas — altura da imagem no desktop (px)'),
('liga_img_largura','240','Ligas — largura da imagem no desktop (px)'),
('liga_premiership','true','Coletar Premier League'),
('liga_super_liga','true','Coletar Super Liga Sul-Americana'),
('liga_world_cup','true','Coletar Copa do Mundo'),
('logo_header_altura','100','Logo do header — altura (px)'),
('logo_header_largura','200','Logo do header — largura mínima (px)'),
('macd_visivel_bronze','true','MACD: exibir para Bronze'),
('macd_visivel_gold','true','MACD: exibir para Gold'),
('macd_visivel_prata','true','MACD: exibir para Prata'),
('macd_visivel_premium','true','MACD: exibir para Premium'),
('manutencao_ativa','false','Ativar modo manutenção — bloqueia acesso de não-Master'),
('manutencao_mensagem','Estamos realizando melhorias no sistema. Voltamos em breve!','Mensagem na tela de manutenção'),
('manutencao_previsao','','Previsão de retorno — deixe vazio para não exibir'),
('max_horarios_proximos','4','Máximo de horários futuros a coletar por liga'),
('max_padroes_usuario','5','Limite de padrões de gráfico por usuário (1–10)'),
('max_tendencias','6','Máximo de itens exibidos em Tendências (1–20)'),
('max_value_bets','6','Máximo de sugestões exibidas em Value Bets (1–20)'),
('max_ver_mais_clicks','4','Cliques em "Ver Mais" ao coletar resultados'),
('mkt_grupo_cor','#4be907','Mercados: cor dos nomes de grupo — estado ativo'),
('mkt_grupo_cor_inativo','true','Mercados: cor dos nomes de grupo — estado inativo'),
('mkt_grupo_fs','13','Mercados: tamanho da fonte dos nomes de grupo (px)'),
('mkt_pill_bold','true','Mercados: negrito nos filtros'),
('mkt_pill_cor','#fafafa','Mercados: cor do texto dos filtros (hex)'),
('mkt_pill_fs','13','Mercados: tamanho da fonte dos filtros (px)'),
('mosaico_celula_fonte','10','Mosaico: fonte das células de jogo (px)'),
('mosaico_celula_largura','50','Mosaico: largura das células de jogo (px)'),
('mosaico_divisor_colunas','4','Mosaico: divisor de colunas (0 = desativado)'),
('mosaico_divisor_cor','#000000','Mosaico: cor da linha divisória'),
('mosaico_divisor_espessura','6','Mosaico: espessura da linha divisória (px)'),
('mosaico_gols_largura','14','Mosaico: min-width da coluna Gols (px)'),
('mosaico_hora_fonte_dd','13','Mosaico: fonte da data DD/MM (px)'),
('mosaico_hora_fonte_hh','16','Mosaico: fonte do horário HH (px)'),
('mosaico_hora_largura','10','Mosaico: min-width da coluna HORA (px)'),
('mosaico_mostrar_data_jogos','false','Mosaico: exibir data DD/MM e contagem de jogos'),
('mosaico_pct_largura','14','Mosaico: min-width da coluna % (px)'),
('odds_intervalo_seg','120','Intervalo entre ciclos do Coletor de Odds (segundos)'),
('padroes_visivel_bronze','false','Padrões: exibir para usuários Bronze'),
('padroes_visivel_gold','false','Padrões: exibir para usuários Gold'),
('padroes_visivel_prata','false','Padrões: exibir para usuários Prata'),
('padroes_visivel_premium','true','Padrões: exibir para usuários Premium'),
('proximos_antes_resultados','false','Coletar próximos jogos ANTES dos resultados'),
('rank_odds_jogos_padrao','200','Ranking de Odds — Número de Jogos padrão'),
('refresh_mosaico_btn_visivel','true','Exibir botão de atualizar mosaico para todos'),
('refresh_mosaico_cooldown_s','30','Cooldown do botão atualizar mosaico (segundos)'),
('retry_liga_refresh_antes','false','Hard refresh antes de re-tentar coleta em liga com jogo em andamento'),
('retry_liga_sem_resultado','false','Retry automático quando liga sem resultados'),
('retry_sem_resultados_delay_ms','2500','Delay entre tentativas de aguardar resultados (ms)'),
('retry_sem_resultados_tentativas','2','Tentativas de aguardar resultados aparecerem na página'),
('rsi_visivel_bronze','true','RSI: exibir para Bronze'),
('rsi_visivel_gold','true','RSI: exibir para Gold'),
('rsi_visivel_prata','true','RSI: exibir para Prata'),
('rsi_visivel_premium','true','RSI: exibir para Premium'),
('sessao_timeout_minutos','360','Timeout de sessão em minutos (0 = nunca expirar)'),
('show_secao_desempenho','false','Exibir seção: Desempenho por Liga'),
('show_secao_frequencia','false','Exibir seção: Frequência dos Mercados'),
('show_secao_ia','false','Exibir seção: IA — Sugestões para Próximos Jogos'),
('show_secao_tendencias','false','Exibir seção: Tendências'),
('show_secao_value_bets','false','Exibir seção: Value Bets'),
('show_subview_gols','true','Exibir botão/seção: Gráfico de Gols'),
('show_subview_grafico','true','Exibir botão/seção: Gráfico [legado]'),
('show_subview_linha','true','Exibir botão/seção: Gráfico de Linha'),
('show_subview_mosaico','true','Exibir botão/seção: Menu Mosaico'),
('show_subview_parimpar','true','Exibir botão/seção: Par/Ímpar'),
('simulador_max_aposta','50','Simulador: máximo de créditos por aposta'),
('simulador_saldo_inicial','100','Simulador: saldo inicial de créditos por usuário'),
('sync_visivel_todos','true','Exibir horário de sync do mosaico para todos'),
('telegram_bot_token','8189807116:AAEByra9URAFBh_Hutwn_-lVzWinpk68BOY','Token do bot Telegram (@BotFather) — TROCAR SE COMPROMETIDO'),
('telegram_chat_ids','5493649790','Chat IDs do Telegram separados por vírgula'),
('timeout_goto_ms','30000','Timeout ao navegar para a página inicial (ms)'),
('timeout_ligas_ms','30000','Timeout aguardando botões de liga (ms)'),
('timeout_navegacao_ms','30000','Timeout de navegação/reload (ms)'),
('tour_dias','10','Tour de onboarding: exibir por N dias após a data de licença (0 = desativado)'),
('youtube_video_1','https://youtu.be/fcCE45uP660','Video 1 - URL'),
('youtube_video_1_titulo','Radar da Bet - Site para análises de gráficos do futebol virtual.','Video 1 - Título'),
('youtube_video_2','https://youtu.be/svYaFzv_1VM','Video 2 - URL'),
('youtube_video_2_titulo','Radar da Bet - Gols Totais - Par e Ímpar','Video 2 - Título'),
('migracoes_normalizar','0','1 = executa normalizações históricas no startup');

-- Insere só as chaves que ainda não existem
INSERT INTO bet365_config (chave, valor, descricao)
SELECT c.chave, c.valor, c.descricao
FROM @cfg c
WHERE NOT EXISTS (SELECT 1 FROM bet365_config x WHERE x.chave = c.chave);

DECLARE @inseridas INT = @@ROWCOUNT;
IF @inseridas > 0
    PRINT '✅ bet365_config: ' + CAST(@inseridas AS NVARCHAR) + ' chaves novas inseridas';
ELSE
    PRINT 'ℹ️  bet365_config: todas as chaves já existem';
GO

-- ============================================================
-- TABELA: bet365_eventos  (estrutura completa — inclui todas as colunas)
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[bet365_eventos]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[bet365_eventos] (
        -- Identificação
        [id]                    BIGINT        NOT NULL PRIMARY KEY,
        [url]                   NVARCHAR(500) NOT NULL,
        [league_name]           NVARCHAR(200) NOT NULL,
        [league_id]             NVARCHAR(50)  NULL,
        [time_casa]             NVARCHAR(100) NULL,
        [time_fora]             NVARCHAR(100) NULL,
        -- Agendamento
        [status]                NVARCHAR(50)  NOT NULL DEFAULT 'AGENDADO',
        [start_time]            BIGINT        NULL,
        [start_time_datetime]   DATETIME2     NULL,
        -- Placar FT e HT
        [gol_casa]              INT           NULL,
        [gol_fora]              INT           NULL,
        [gol_casa_ht]           INT           NULL,
        [gol_fora_ht]           INT           NULL,
        [periodo]               NVARCHAR(50)  NULL,
        -- Odds 1X2
        [odd_casa]              DECIMAL(10,2) NOT NULL DEFAULT 0,
        [odd_empate]            DECIMAL(10,2) NOT NULL DEFAULT 0,
        [odd_fora]              DECIMAL(10,2) NOT NULL DEFAULT 0,
        -- Estatísticas em tempo real
        [posse_bola_casa]       DECIMAL(5,2)  NULL,
        [posse_bola_fora]       DECIMAL(5,2)  NULL,
        [chutes_casa]           INT           NULL,
        [chutes_fora]           INT           NULL,
        [chutes_gol_casa]       INT           NULL,
        [chutes_gol_fora]       INT           NULL,
        [escanteios_casa]       INT           NULL,
        [escanteios_fora]       INT           NULL,
        [cartoes_amarelos_casa] INT           NULL,
        [cartoes_amarelos_fora] INT           NULL,
        [cartoes_vermelhos_casa] INT          NULL,
        [cartoes_vermelhos_fora] INT          NULL,
        [estatisticas_json]     NVARCHAR(MAX) NULL,
        -- Controle
        [data_coleta]           DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
        [data_atualizacao]      DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
        [ativo]                 BIT           NOT NULL DEFAULT 1,
        -- Odds Over/Under (Coletor 2)
        [odd_over25]            DECIMAL(10,2) NULL,
        [odd_under25]           DECIMAL(10,2) NULL,
        [odd_btts_sim]          DECIMAL(10,2) NULL,
        [odd_btts_nao]          DECIMAL(10,2) NULL,
        [odd_ht_casa]           DECIMAL(10,2) NULL,
        [odd_ht_empate]         DECIMAL(10,2) NULL,
        [odd_ht_fora]           DECIMAL(10,2) NULL,
        [odd_over05]            DECIMAL(10,2) NULL,
        [odd_under05]           DECIMAL(10,2) NULL,
        [odd_over15]            DECIMAL(10,2) NULL,
        [odd_under15]           DECIMAL(10,2) NULL,
        [odd_over35]            DECIMAL(10,2) NULL,
        [odd_under35]           DECIMAL(10,2) NULL,
        -- HT/FT combinado
        [odd_htft_11]           DECIMAL(10,2) NULL,
        [odd_htft_1x]           DECIMAL(10,2) NULL,
        [odd_htft_12]           DECIMAL(10,2) NULL,
        [odd_htft_x1]           DECIMAL(10,2) NULL,
        [odd_htft_xx]           DECIMAL(10,2) NULL,
        [odd_htft_x2]           DECIMAL(10,2) NULL,
        [odd_htft_21]           DECIMAL(10,2) NULL,
        [odd_htft_2x]           DECIMAL(10,2) NULL,
        [odd_htft_22]           DECIMAL(10,2) NULL,
        -- Total de gols exact
        [odd_totgols_01]        DECIMAL(10,2) NULL,
        [odd_totgols_23]        DECIMAL(10,2) NULL,
        [odd_totgols_4mais]     DECIMAL(10,2) NULL,
        -- Resultado correto (placares exatos)
        [odd_placar_1_0]        DECIMAL(10,2) NULL,
        [odd_placar_2_0]        DECIMAL(10,2) NULL,
        [odd_placar_2_1]        DECIMAL(10,2) NULL,
        [odd_placar_3_0]        DECIMAL(10,2) NULL,
        [odd_placar_3_1]        DECIMAL(10,2) NULL,
        [odd_placar_4_0]        DECIMAL(10,2) NULL,
        [odd_placar_0_0]        DECIMAL(10,2) NULL,
        [odd_placar_1_1]        DECIMAL(10,2) NULL,
        [odd_placar_2_2]        DECIMAL(10,2) NULL,
        [odd_placar_0_1]        DECIMAL(10,2) NULL,
        [odd_placar_0_2]        DECIMAL(10,2) NULL,
        [odd_placar_1_2]        DECIMAL(10,2) NULL,
        [odd_placar_0_3]        DECIMAL(10,2) NULL,
        [odd_placar_1_3]        DECIMAL(10,2) NULL,
        [odd_placar_0_4]        DECIMAL(10,2) NULL,
        [odd_placar_outros]     DECIMAL(10,2) NULL
    );
    CREATE INDEX IX_b365_ev_league ON bet365_eventos(league_name);
    CREATE INDEX IX_b365_ev_status ON bet365_eventos(status);
    CREATE INDEX IX_b365_ev_start  ON bet365_eventos(start_time_datetime);
    CREATE INDEX IX_b365_ev_ativo  ON bet365_eventos(ativo);
    PRINT '✅ Tabela bet365_eventos criada!';
END
ELSE
BEGIN
    -- Garante colunas adicionadas após a criação inicial
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bet365_eventos') AND name='gol_casa')
        ALTER TABLE bet365_eventos ADD gol_casa INT NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bet365_eventos') AND name='gol_fora')
        ALTER TABLE bet365_eventos ADD gol_fora INT NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bet365_eventos') AND name='gol_casa_ht')
        ALTER TABLE bet365_eventos ADD gol_casa_ht INT NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bet365_eventos') AND name='gol_fora_ht')
        ALTER TABLE bet365_eventos ADD gol_fora_ht INT NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bet365_eventos') AND name='periodo')
        ALTER TABLE bet365_eventos ADD periodo NVARCHAR(50) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bet365_eventos') AND name='odd_over25')
        ALTER TABLE bet365_eventos ADD odd_over25 DECIMAL(10,2) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bet365_eventos') AND name='odd_btts_sim')
        ALTER TABLE bet365_eventos ADD odd_btts_sim DECIMAL(10,2) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('bet365_eventos') AND name='odd_ht_casa')
        ALTER TABLE bet365_eventos ADD odd_ht_casa DECIMAL(10,2) NULL;
    PRINT 'ℹ️  Tabela bet365_eventos já existe';
END
GO

-- ============================================================
-- TABELA: bet365_mercados
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[bet365_mercados]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[bet365_mercados] (
        [id]          BIGINT        NOT NULL PRIMARY KEY,
        [evento_id]   BIGINT        NOT NULL,
        [nome]        NVARCHAR(200) NOT NULL,
        [tipo]        NVARCHAR(50)  NULL,
        [data_coleta] DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
        [ativo]       BIT           NOT NULL DEFAULT 1
    );
    CREATE INDEX IX_b365_mkt_evento ON bet365_mercados(evento_id);
    PRINT '✅ Tabela bet365_mercados criada!';
END
ELSE
    PRINT 'ℹ️  Tabela bet365_mercados já existe';
GO

-- ============================================================
-- TABELA: bet365_odds
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[bet365_odds]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[bet365_odds] (
        [id]          BIGINT        NOT NULL PRIMARY KEY,
        [mercado_id]  BIGINT        NOT NULL,
        [evento_id]   BIGINT        NOT NULL,
        [nome]        NVARCHAR(100) NOT NULL,
        [full_name]   NVARCHAR(200) NULL,
        [valor]       DECIMAL(10,2) NOT NULL,
        [handicap]    DECIMAL(10,2) NOT NULL DEFAULT 0,
        [data_coleta] DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
        [ativo]       BIT           NOT NULL DEFAULT 1
    );
    CREATE INDEX IX_b365_odd_mercado ON bet365_odds(mercado_id);
    CREATE INDEX IX_b365_odd_evento  ON bet365_odds(evento_id);
    PRINT '✅ Tabela bet365_odds criada!';
END
ELSE
    PRINT 'ℹ️  Tabela bet365_odds já existe';
GO

-- ============================================================
-- TABELA: bet365_resultados_mercados
-- Fonte principal de resultados — substitui bet365_historico_partidas
-- Lógica de derivação de placar: backend/routes/bet365-api.js
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[bet365_resultados_mercados]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[bet365_resultados_mercados] (
        [id]            BIGINT        NOT NULL PRIMARY KEY,
        [evento_id]     BIGINT        NOT NULL,
        [liga]          NVARCHAR(200) NOT NULL,
        [time_casa]     NVARCHAR(100) NOT NULL,
        [time_fora]     NVARCHAR(100) NOT NULL,
        [data_partida]  DATETIME2     NULL,
        [mercado]       NVARCHAR(200) NOT NULL,
        [selecao]       NVARCHAR(200) NOT NULL,
        [odd_paga]      DECIMAL(10,2) NOT NULL DEFAULT 0,
        [data_registro] DATETIME2     NOT NULL DEFAULT GETUTCDATE()
    );
    CREATE INDEX IX_b365_resmkt_evento    ON bet365_resultados_mercados(evento_id);
    CREATE INDEX IX_b365_resmkt_liga_data ON bet365_resultados_mercados(liga, data_partida);
    PRINT '✅ Tabela bet365_resultados_mercados criada!';
END
ELSE
    PRINT 'ℹ️  Tabela bet365_resultados_mercados já existe';
GO

-- ============================================================
-- TABELA: bet365_log_coleta
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[bet365_log_coleta]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[bet365_log_coleta] (
        [id]                  INT            IDENTITY(1,1) PRIMARY KEY,
        [data_inicio]         DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
        [data_fim]            DATETIME2      NULL,
        [status]              NVARCHAR(50)   NOT NULL DEFAULT 'INICIANDO',
        [eventos_coletados]   INT            NOT NULL DEFAULT 0,
        [mercados_coletados]  INT            NOT NULL DEFAULT 0,
        [odds_coletadas]      INT            NOT NULL DEFAULT 0,
        [resultados_salvos]   INT            NOT NULL DEFAULT 0,
        [erro_mensagem]       NVARCHAR(MAX)  NULL
    );
    CREATE INDEX IX_b365_log_data ON bet365_log_coleta(data_inicio DESC);
    PRINT '✅ Tabela bet365_log_coleta criada!';
END
ELSE
    PRINT 'ℹ️  Tabela bet365_log_coleta já existe';
GO

-- ============================================================
-- TABELA: coletor_auditoria
-- Eventos do ciclo de vida do coletor (login, crash, reinício)
-- Tipos: login_sucesso, login_falha, processo_iniciado, reinicio_disparado, edge_sem_porta
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[coletor_auditoria]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[coletor_auditoria] (
        [id]        INT            IDENTITY(1,1) PRIMARY KEY,
        [data_hora] DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
        [tipo]      NVARCHAR(50)   NOT NULL,
        [detalhe]   NVARCHAR(500)  NULL,
        [conta]     NVARCHAR(100)  NULL
    );
    CREATE INDEX IX_coletor_audit_data ON coletor_auditoria(data_hora DESC);
    CREATE INDEX IX_coletor_audit_tipo ON coletor_auditoria(tipo);
    PRINT '✅ Tabela coletor_auditoria criada!';
END
ELSE
    PRINT 'ℹ️  Tabela coletor_auditoria já existe';
GO

-- ============================================================
-- VIEW: vw_betano_eventos_completos
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[vw_betano_eventos_completos]') AND type = 'V')
BEGIN
    EXEC('
    CREATE VIEW [dbo].[vw_betano_eventos_completos] AS
    SELECT e.id AS evento_id, e.time_casa, e.time_fora, e.league_name,
           e.start_time_datetime, e.seconds_to_start, e.status,
           m.id AS mercado_id, m.nome AS mercado_nome, m.tipo AS mercado_tipo,
           o.id AS odd_id, o.nome AS odd_nome, o.full_name AS odd_full_name,
           o.valor AS odd_valor, o.handicap AS odd_handicap, e.data_coleta
    FROM betano_eventos e
    INNER JOIN betano_mercados m ON m.evento_id = e.id
    INNER JOIN betano_odds     o ON o.mercado_id = m.id
    WHERE e.ativo = 1 AND m.ativo = 1 AND o.ativo = 1;
    ');
    PRINT '✅ View vw_betano_eventos_completos criada!';
END
ELSE
    PRINT 'ℹ️  View vw_betano_eventos_completos já existe';
GO

-- ============================================================
-- CONSULTAS ÚTEIS DE VERIFICAÇÃO
-- ============================================================
-- Todas as tabelas do banco:
-- SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;
--
-- Contagem de registros:
-- SELECT 'Usuarios' AS t, COUNT(*) AS n FROM Usuarios
-- UNION ALL SELECT 'bet365_resultados_mercados', COUNT(*) FROM bet365_resultados_mercados
-- UNION ALL SELECT 'bet365_eventos',             COUNT(*) FROM bet365_eventos
-- UNION ALL SELECT 'bet365_config',              COUNT(*) FROM bet365_config
-- UNION ALL SELECT 'coletor_auditoria',          COUNT(*) FROM coletor_auditoria
-- UNION ALL SELECT 'user_padroes_grafico',        COUNT(*) FROM user_padroes_grafico
-- UNION ALL SELECT 'usuario_preferencias',       COUNT(*) FROM usuario_preferencias
-- UNION ALL SELECT 'kirvano_assinaturas',         COUNT(*) FROM kirvano_assinaturas
-- UNION ALL SELECT 'simulador_apostas',           COUNT(*) FROM simulador_apostas
-- UNION ALL SELECT 'betano_historico_partidas',   COUNT(*) FROM betano_historico_partidas;
--
-- Últimas auditorias do coletor:
-- SELECT TOP 20 * FROM coletor_auditoria ORDER BY data_hora DESC;
--
-- Resultados mais recentes Bet365:
-- SELECT TOP 10 liga, time_casa, time_fora, mercado, selecao, odd_paga
-- FROM bet365_resultados_mercados ORDER BY data_registro DESC;

PRINT '';
PRINT '============================================================';
PRINT '✅ SETUP CONCLUÍDO COM SUCESSO!';
PRINT '============================================================';
GO
