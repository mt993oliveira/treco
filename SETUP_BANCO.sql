-- ============================================================
-- SETUP_BANCO.sql
-- Script completo de criação do banco de dados PRODUCAO
-- Sistema: Controle Financeiro + Betano Futebol Virtual
-- Data: 2026-03-29
-- ============================================================
-- EXECUÇÃO: Rodar no SQL Server Management Studio
-- conectado ao servidor 127.0.0.1 (local) ou Locaweb
-- ============================================================

USE PRODUCAO;
GO

PRINT '============================================================';
PRINT 'SETUP BANCO DE DADOS - PRODUCAO';
PRINT '============================================================';
PRINT '';

-- ============================================================
-- TABELA: betano_eventos
-- Eventos de futebol virtual coletados da Betano em tempo real
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[betano_eventos]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[betano_eventos] (
        [id]                    BIGINT PRIMARY KEY,
        [url]                   NVARCHAR(500) NOT NULL,
        [region_name]           NVARCHAR(200),
        [league_name]           NVARCHAR(200) NOT NULL,
        [league_id]             NVARCHAR(50),
        [subscription_key]      NVARCHAR(100),
        [seconds_to_start]      INT,
        [start_time]            BIGINT,
        [start_time_datetime]   DATETIME2,
        [time_casa]             NVARCHAR(100),
        [time_fora]             NVARCHAR(100),
        [status]                NVARCHAR(50) DEFAULT 'AGENDADO',
        [resultado_casa]        INT NULL,
        [resultado_fora]        INT NULL,
        [data_coleta]           DATETIME2 DEFAULT GETDATE(),
        [data_atualizacao]      DATETIME2 DEFAULT GETDATE(),
        [ativo]                 BIT DEFAULT 1
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
-- Mercados de apostas de cada evento (1x2, Over/Under, etc.)
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[betano_mercados]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[betano_mercados] (
        [id]            BIGINT PRIMARY KEY,
        [evento_id]     BIGINT NOT NULL,
        [nome]          NVARCHAR(200) NOT NULL,
        [tipo]          NVARCHAR(50),
        [handicap]      DECIMAL(10,2) DEFAULT 0,
        [data_coleta]   DATETIME2 DEFAULT GETDATE(),
        [ativo]         BIT DEFAULT 1,
        CONSTRAINT FK_betano_mercados_eventos
            FOREIGN KEY (evento_id) REFERENCES betano_eventos(id) ON DELETE CASCADE
    );

    CREATE INDEX IX_betano_mercados_evento ON betano_mercados(evento_id);
    CREATE INDEX IX_betano_mercados_nome   ON betano_mercados(nome);

    PRINT '✅ Tabela betano_mercados criada!';
END
ELSE
    PRINT 'ℹ️  Tabela betano_mercados já existe';
GO

-- ============================================================
-- TABELA: betano_odds
-- Odds de cada seleção dentro de um mercado
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[betano_odds]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[betano_odds] (
        [id]            BIGINT PRIMARY KEY,
        [mercado_id]    BIGINT NOT NULL,
        [evento_id]     BIGINT NOT NULL,
        [nome]          NVARCHAR(100) NOT NULL,
        [full_name]     NVARCHAR(200),
        [valor]         DECIMAL(10,2) NOT NULL,
        [handicap]      DECIMAL(10,2) DEFAULT 0,
        [column_index]  INT,
        [data_coleta]   DATETIME2 DEFAULT GETDATE(),
        [ativo]         BIT DEFAULT 1,
        CONSTRAINT FK_betano_odds_mercados
            FOREIGN KEY (mercado_id) REFERENCES betano_mercados(id) ON DELETE CASCADE
    );

    CREATE INDEX IX_betano_odds_mercado ON betano_odds(mercado_id);
    CREATE INDEX IX_betano_odds_evento  ON betano_odds(evento_id);
    CREATE INDEX IX_betano_odds_valor   ON betano_odds(valor);

    PRINT '✅ Tabela betano_odds criada!';
END
ELSE
    PRINT 'ℹ️  Tabela betano_odds já existe';
GO

-- ============================================================
-- TABELA: betano_historico_odds
-- Histórico de variação de odds ao longo do tempo
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[betano_historico_odds]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[betano_historico_odds] (
        [id]                    BIGINT IDENTITY(1,1) PRIMARY KEY,
        [evento_id]             BIGINT NOT NULL,
        [mercado_id]            BIGINT NOT NULL,
        [odd_id]                BIGINT NOT NULL,
        [nome_selecao]          NVARCHAR(100) NOT NULL,
        [valor_odd]             DECIMAL(10,2) NOT NULL,
        [variacao_percentual]   DECIMAL(10,4) NULL,
        [data_coleta]           DATETIME2 DEFAULT GETDATE()
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
-- Resultados finais de cada partida de futebol virtual
-- Usada para cálculo de probabilidades e sugestões de apostas
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[betano_historico_partidas]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[betano_historico_partidas] (
        [id]            BIGINT IDENTITY(1,1) PRIMARY KEY,
        [evento_id]     BIGINT NOT NULL,
        [liga]          NVARCHAR(200),
        [time_casa]     NVARCHAR(100) NOT NULL,
        [time_fora]     NVARCHAR(100) NOT NULL,
        [gol_casa]      INT NOT NULL DEFAULT 0,
        [gol_fora]      INT NOT NULL DEFAULT 0,
        [resultado]     NVARCHAR(10) NOT NULL,  -- 'CASA' | 'EMPATE' | 'FORA'
        [odd_casa]      DECIMAL(10,2) DEFAULT 0,
        [odd_empate]    DECIMAL(10,2) DEFAULT 0,
        [odd_fora]      DECIMAL(10,2) DEFAULT 0,
        [data_partida]  DATETIME2,
        [data_registro] DATETIME2 DEFAULT GETDATE()
    );

    CREATE INDEX IX_hist_time_casa  ON betano_historico_partidas(time_casa);
    CREATE INDEX IX_hist_time_fora  ON betano_historico_partidas(time_fora);
    CREATE INDEX IX_hist_liga       ON betano_historico_partidas(liga);
    CREATE INDEX IX_hist_data       ON betano_historico_partidas(data_partida);
    CREATE UNIQUE INDEX IX_hist_evento ON betano_historico_partidas(evento_id);

    PRINT '✅ Tabela betano_historico_partidas criada!';
END
ELSE
    PRINT 'ℹ️  Tabela betano_historico_partidas já existe';
GO

-- ============================================================
-- TABELA: betano_estatisticas_tempo_real
-- Estatísticas em tempo real de partidas em andamento
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[betano_estatisticas_tempo_real]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[betano_estatisticas_tempo_real] (
        [id]                        BIGINT IDENTITY(1,1) PRIMARY KEY,
        [evento_id]                 BIGINT NOT NULL,
        [minuto]                    NVARCHAR(20),
        [gol_casa]                  INT DEFAULT 0,
        [gol_fora]                  INT DEFAULT 0,
        [posse_bola_casa]           DECIMAL(5,2),
        [posse_bola_fora]           DECIMAL(5,2),
        [chutes_casa]               INT DEFAULT 0,
        [chutes_fora]               INT DEFAULT 0,
        [chutes_gol_casa]           INT DEFAULT 0,
        [chutes_gol_fora]           INT DEFAULT 0,
        [escanteios_casa]           INT DEFAULT 0,
        [escanteios_fora]           INT DEFAULT 0,
        [cartoes_amarelos_casa]     INT DEFAULT 0,
        [cartoes_amarelos_fora]     INT DEFAULT 0,
        [cartoes_vermelhos_casa]    INT DEFAULT 0,
        [cartoes_vermelhos_fora]    INT DEFAULT 0,
        [ataques_casa]              INT DEFAULT 0,
        [ataques_fora]              INT DEFAULT 0,
        [ataques_perigo_casa]       INT DEFAULT 0,
        [ataques_perigo_fora]       INT DEFAULT 0,
        [dados_completos]           NVARCHAR(MAX),
        [data_coleta]               DATETIME2 DEFAULT GETDATE(),
        CONSTRAINT FK_estatisticas_evento
            FOREIGN KEY (evento_id) REFERENCES betano_eventos(id)
    );

    CREATE INDEX IX_betano_estatisticas_evento ON betano_estatisticas_tempo_real(evento_id);
    CREATE INDEX IX_betano_estatisticas_data   ON betano_estatisticas_tempo_real(data_coleta DESC);

    PRINT '✅ Tabela betano_estatisticas_tempo_real criada!';
END
ELSE
    PRINT 'ℹ️  Tabela betano_estatisticas_tempo_real já existe';
GO

-- ============================================================
-- TABELA: betano_log_coleta
-- Log de cada execução do agendador/coletor
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[betano_log_coleta]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[betano_log_coleta] (
        [id]                        BIGINT IDENTITY(1,1) PRIMARY KEY,
        [data_inicio]               DATETIME2 DEFAULT GETDATE(),
        [data_fim]                  DATETIME2 NULL,
        [status]                    NVARCHAR(50) DEFAULT 'INICIANDO',  -- EM_ANDAMENTO | SUCESSO | ERRO
        [eventos_coletados]         INT DEFAULT 0,
        [mercados_coletados]        INT DEFAULT 0,
        [odds_coletadas]            INT DEFAULT 0,
        [estatisticas_coletadas]    INT DEFAULT 0,
        [historico_odds_salvas]     INT DEFAULT 0,
        [erro_mensagem]             NVARCHAR(MAX) NULL
    );

    CREATE INDEX IX_betano_log_data ON betano_log_coleta(data_inicio);

    PRINT '✅ Tabela betano_log_coleta criada!';
END
ELSE
BEGIN
    -- Garante colunas extras adicionadas posteriormente
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('betano_log_coleta') AND name = 'estatisticas_coletadas')
        ALTER TABLE betano_log_coleta ADD estatisticas_coletadas INT DEFAULT 0;
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('betano_log_coleta') AND name = 'historico_odds_salvas')
        ALTER TABLE betano_log_coleta ADD historico_odds_salvas INT DEFAULT 0;
    PRINT 'ℹ️  Tabela betano_log_coleta já existe';
END
GO

-- ============================================================
-- VIEW: vw_betano_eventos_completos
-- Visão completa: evento + mercado + odd em um único SELECT
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[vw_betano_eventos_completos]') AND type = 'V')
BEGIN
    EXEC('
    CREATE VIEW [dbo].[vw_betano_eventos_completos] AS
    SELECT
        e.id              AS evento_id,
        e.time_casa,
        e.time_fora,
        e.league_name,
        e.start_time_datetime,
        e.seconds_to_start,
        e.status,
        m.id              AS mercado_id,
        m.nome            AS mercado_nome,
        m.tipo            AS mercado_tipo,
        o.id              AS odd_id,
        o.nome            AS odd_nome,
        o.full_name       AS odd_full_name,
        o.valor           AS odd_valor,
        o.handicap        AS odd_handicap,
        e.data_coleta
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
-- STORED PROCEDURE: sp_betano_limpar_antigos
-- Desativa eventos com mais de N dias (padrão 7)
-- Uso: EXEC sp_betano_limpar_antigos @dias_retention = 7
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[sp_betano_limpar_antigos]') AND type IN ('P','PC'))
BEGIN
    EXEC('
    CREATE PROCEDURE [dbo].[sp_betano_limpar_antigos]
        @dias_retention INT = 7
    AS
    BEGIN
        SET NOCOUNT ON;
        DECLARE @data_corte DATETIME2 = DATEADD(DAY, -@dias_retention, GETDATE());
        UPDATE betano_eventos
        SET ativo = 0, data_atualizacao = GETDATE()
        WHERE start_time_datetime < @data_corte AND ativo = 1;
        SELECT @@ROWCOUNT AS eventos_desativados;
    END;
    ');
    PRINT '✅ Procedure sp_betano_limpar_antigos criada!';
END
ELSE
    PRINT 'ℹ️  Procedure sp_betano_limpar_antigos já existe';
GO

-- ============================================================
-- TABELA: Usuarios
-- Usuários do sistema (autenticação + licenças)
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[Usuarios]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[Usuarios] (
        [Id]                INT            IDENTITY(1,1) PRIMARY KEY,
        [NomeCompleto]      NVARCHAR(200)  NOT NULL,
        [Usuario]           NVARCHAR(100)  NOT NULL UNIQUE,
        [Email]             NVARCHAR(255)  NOT NULL UNIQUE,
        [Senha]             NVARCHAR(500)  NOT NULL,
        [TipoUsuario]       NVARCHAR(50)   NOT NULL DEFAULT 'user',  -- 'user' | 'master'
        [Ativo]             BIT            NOT NULL DEFAULT 1,
        [DataInicioLicenca] DATETIME2      NULL,
        [DataFimLicenca]    DATETIME2      NULL,
        [DataCriacao]       DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
        [DataAtualizacao]   DATETIME2      NULL
    );

    CREATE INDEX IX_usuarios_email   ON Usuarios(Email);
    CREATE INDEX IX_usuarios_usuario ON Usuarios(Usuario);

    -- Usuário MASTER padrão do sistema (bcrypt hash da senha atual)
    INSERT INTO Usuarios (NomeCompleto, Usuario, Email, Senha, TipoUsuario, Ativo, DataInicioLicenca, DataFimLicenca)
    VALUES (
        'Administrador Master',
        'MASTER',
        'MT993.OLIVEIRA@gmail.com',
        '$2a$12$4lC7YmweQFNJNe1hqtCSJun5CeBze/LL21Jbei4Yep6P8vbx2Dwqu',
        'master',
        1,
        '2026-03-22',
        '2031-06-10'
    );

    PRINT '✅ Tabela Usuarios criada com usuário MASTER!';
END
ELSE
    PRINT 'ℹ️  Tabela Usuarios já existe';
GO

-- ============================================================
-- TABELA: DespesasMensais
-- Despesas mensais do módulo ControlFinance
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
-- TABELA: DespesasAnuais
-- Despesas anuais do módulo ControlFinance
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[DespesasAnuais]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[DespesasAnuais] (
        [Id]              INT            IDENTITY(1,1) PRIMARY KEY,
        [Mes]             INT            NOT NULL,
        [Ano]             INT            NOT NULL,
        [Descricao]       NVARCHAR(500)  NOT NULL,
        [ValorAnual]      DECIMAL(15,2)  NOT NULL,
        [ValorMensal]     DECIMAL(15,2)  NOT NULL,
        [UsuarioId]       INT            NOT NULL,
        [DataCriacao]     DATETIME2      NOT NULL DEFAULT GETDATE(),
        [DataAtualizacao] DATETIME2      NULL
    );

    CREATE INDEX IX_despesas_anuais_usuario ON DespesasAnuais(UsuarioId);
    CREATE INDEX IX_despesas_anuais_ano     ON DespesasAnuais(Ano);

    PRINT '✅ Tabela DespesasAnuais criada!';
END
ELSE
    PRINT 'ℹ️  Tabela DespesasAnuais já existe';
GO

-- ============================================================
-- TABELA: NubankCobrancasFixas
-- Cobranças fixas do Nubank — módulo ControlFinance
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[NubankCobrancasFixas]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[NubankCobrancasFixas] (
        [Id]              INT            IDENTITY(1,1) PRIMARY KEY,
        [Mes]             INT            NOT NULL,
        [Ano]             INT            NOT NULL,
        [Descricao]       NVARCHAR(500)  NOT NULL,
        [Valor]           DECIMAL(15,2)  NOT NULL,
        [UsuarioId]       INT            NOT NULL,
        [DataCriacao]     DATETIME2      NOT NULL DEFAULT GETDATE(),
        [DataAtualizacao] DATETIME2      NULL
    );

    CREATE INDEX IX_nubank_usuario ON NubankCobrancasFixas(UsuarioId);

    PRINT '✅ Tabela NubankCobrancasFixas criada!';
END
ELSE
    PRINT 'ℹ️  Tabela NubankCobrancasFixas já existe';
GO

-- ============================================================
-- TABELA: FutebolVirtual
-- Partidas coletadas (legado — dados históricos Betano/Bet365)
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[FutebolVirtual]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[FutebolVirtual] (
        [Id]            BIGINT         IDENTITY(1,1) PRIMARY KEY,
        [CasaAposta]    NVARCHAR(100)  NULL,
        [Liga]          NVARCHAR(200)  NOT NULL,
        [TimeCasa]      NVARCHAR(100)  NOT NULL,
        [TimeFora]      NVARCHAR(100)  NOT NULL,
        [GolCasa]       INT            NULL,
        [GolFora]       INT            NULL,
        [StatusPartida] NVARCHAR(50)   NULL,
        [Minuto]        NVARCHAR(20)   NULL,
        [OddCasa]       DECIMAL(10,2)  NULL,
        [OddEmpate]     DECIMAL(10,2)  NULL,
        [OddFora]       DECIMAL(10,2)  NULL,
        [DataPartida]   DATETIME2      NULL,
        [DataColeta]    DATETIME2      NOT NULL DEFAULT GETDATE(),
        [PaginaUrl]     NVARCHAR(500)  NULL
    );

    CREATE INDEX IX_futvirt_liga       ON FutebolVirtual(Liga);
    CREATE INDEX IX_futvirt_data       ON FutebolVirtual(DataColeta DESC);
    CREATE INDEX IX_futvirt_status     ON FutebolVirtual(StatusPartida);

    PRINT '✅ Tabela FutebolVirtual criada!';
END
ELSE
    PRINT 'ℹ️  Tabela FutebolVirtual já existe';
GO

-- ============================================================
-- TABELA: bet365_config
-- Configurações dinâmicas do coletor 1 (intervalos, flags de liga, etc.)
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[bet365_config]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[bet365_config] (
        [id]              INT            IDENTITY(1,1) PRIMARY KEY,
        [chave]           NVARCHAR(100)  NOT NULL UNIQUE,
        [valor]           NVARCHAR(500)  NOT NULL,
        [descricao]       NVARCHAR(500)  NULL,
        [data_atualizacao] DATETIME2     NOT NULL DEFAULT GETUTCDATE()
    );

    -- Valores padrão de configuração
    INSERT INTO bet365_config (chave, valor, descricao) VALUES
        ('intervalo_coleta_seg',       '30',    'Intervalo entre ciclos de coleta em segundos'),
        ('delay_apos_clicar_liga_ms',  '3000',  'Delay após clicar na aba da liga (ms)'),
        ('delay_pos_reload_ms',        '4000',  'Delay após Ctrl+F5 (ms)'),
        ('delay_apos_resultados_ms',   '2000',  'Delay após coletar resultados (ms)'),
        ('delay_show_more_ms',         '800',   'Delay entre cliques em Show More (ms)'),
        ('delay_expandir_mercados_ms', '1500',  'Delay ao expandir mercados (ms)'),
        ('delay_volta_proximos_ms',    '2000',  'Delay ao voltar para próximos jogos (ms)'),
        ('delay_entre_horarios_ms',    '1500',  'Delay entre horários da mesma liga (ms)'),
        ('delay_aguarda_mercado_ms',   '500',   'Delay aguardando mercados abrirem (ms)'),
        ('timeout_goto_ms',            '60000', 'Timeout de navegação (ms)'),
        ('delay_initial_load_ms',      '6000',  'Delay no carregamento inicial (ms)'),
        ('timeout_ligas_ms',           '20000', 'Timeout aguardando ligas aparecerem (ms)'),
        ('timeout_navegacao_ms',       '30000', 'Timeout geral de navegação (ms)'),
        ('liga_world_cup',             'true',  'Habilita coleta da World Cup'),
        ('liga_euro_cup',              'true',  'Habilita coleta da Euro Cup'),
        ('liga_premiership',           'true',  'Habilita coleta da Premiership'),
        ('liga_express_cup',           'true',  'Habilita coleta da Express Cup'),
        ('liga_super_liga',            'true',  'Habilita coleta da Super Liga Sul-Americana'),
        ('migracoes_normalizar',       '0',     '1 = executa normalizações históricas no startup');

    PRINT '✅ Tabela bet365_config criada com valores padrão!';
END
ELSE
    PRINT 'ℹ️  Tabela bet365_config já existe';
GO

-- ============================================================
-- TABELA: bet365_eventos
-- Próximos jogos coletados da Bet365 em tempo real (coletor 1)
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[bet365_eventos]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[bet365_eventos] (
        [id]                    BIGINT        NOT NULL PRIMARY KEY,
        [url]                   NVARCHAR(500) NOT NULL,
        [league_name]           NVARCHAR(200) NOT NULL,
        [time_casa]             NVARCHAR(100) NOT NULL,
        [time_fora]             NVARCHAR(100) NOT NULL,
        [status]                NVARCHAR(50)  NOT NULL DEFAULT 'AGENDADO',
        [start_time_datetime]   DATETIME2     NULL,
        [odd_casa]              DECIMAL(10,2) NOT NULL DEFAULT 0,
        [odd_empate]            DECIMAL(10,2) NOT NULL DEFAULT 0,
        [odd_fora]              DECIMAL(10,2) NOT NULL DEFAULT 0,
        [data_coleta]           DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
        [data_atualizacao]      DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
        [ativo]                 BIT           NOT NULL DEFAULT 1
    );

    CREATE INDEX IX_b365_ev_league ON bet365_eventos(league_name);
    CREATE INDEX IX_b365_ev_status ON bet365_eventos(status);
    CREATE INDEX IX_b365_ev_start  ON bet365_eventos(start_time_datetime);
    CREATE INDEX IX_b365_ev_ativo  ON bet365_eventos(ativo);

    PRINT '✅ Tabela bet365_eventos criada!';
END
ELSE
    PRINT 'ℹ️  Tabela bet365_eventos já existe';
GO

-- ============================================================
-- TABELA: bet365_mercados
-- Mercados de cada evento (1X2, Over/Under, BTTS, etc.)
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
    CREATE INDEX IX_b365_mkt_nome   ON bet365_mercados(nome);

    PRINT '✅ Tabela bet365_mercados criada!';
END
ELSE
    PRINT 'ℹ️  Tabela bet365_mercados já existe';
GO

-- ============================================================
-- TABELA: bet365_odds
-- Odds de cada seleção dentro de um mercado
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
    CREATE INDEX IX_b365_odd_valor   ON bet365_odds(valor);

    PRINT '✅ Tabela bet365_odds criada!';
END
ELSE
    PRINT 'ℹ️  Tabela bet365_odds já existe';
GO

-- ============================================================
-- TABELA: bet365_resultados_mercados
-- Resultados pagos coletados pelo coletor 1 (fonte principal de dados)
-- Única tabela de resultados — bet365_historico_partidas foi descontinuada
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

    CREATE INDEX IX_b365_resmkt_evento   ON bet365_resultados_mercados(evento_id);
    CREATE INDEX IX_b365_resmkt_liga_data ON bet365_resultados_mercados(liga, data_partida);

    PRINT '✅ Tabela bet365_resultados_mercados criada!';
END
ELSE
    PRINT 'ℹ️  Tabela bet365_resultados_mercados já existe';
GO

-- ============================================================
-- TABELA: bet365_log_coleta
-- Log de cada ciclo de coleta do coletor 1
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
-- Auditoria de eventos do coletor 1 (login, logout, erros)
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
-- TABELA: simulador_apostas
-- Apostas virtuais do simulador (creditos fictícios por usuário)
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
-- Compras e assinaturas recebidas via webhook da Kirvano
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
-- Senha em texto claro temporária para tela de boas-vindas
-- (apagada após o usuário alterar a senha)
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
-- Log de todos os webhooks recebidos da Kirvano (diagnóstico)
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
-- CONSULTAS ÚTEIS PARA VERIFICAÇÃO
-- ============================================================

-- Verificar todas as tabelas do sistema:
-- SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME;

-- Contagem de registros por tabela principal:
-- SELECT 'Usuarios'                    AS tabela, COUNT(*) AS total FROM Usuarios
-- UNION ALL SELECT 'bet365_eventos',               COUNT(*) FROM bet365_eventos
-- UNION ALL SELECT 'bet365_mercados',              COUNT(*) FROM bet365_mercados
-- UNION ALL SELECT 'bet365_odds',                  COUNT(*) FROM bet365_odds
-- UNION ALL SELECT 'bet365_resultados_mercados',   COUNT(*) FROM bet365_resultados_mercados
-- UNION ALL SELECT 'bet365_log_coleta',            COUNT(*) FROM bet365_log_coleta
-- UNION ALL SELECT 'bet365_config',                COUNT(*) FROM bet365_config
-- UNION ALL SELECT 'betano_eventos',               COUNT(*) FROM betano_eventos
-- UNION ALL SELECT 'betano_mercados',              COUNT(*) FROM betano_mercados
-- UNION ALL SELECT 'betano_odds',                  COUNT(*) FROM betano_odds
-- UNION ALL SELECT 'betano_historico_partidas',    COUNT(*) FROM betano_historico_partidas
-- UNION ALL SELECT 'betano_log_coleta',            COUNT(*) FROM betano_log_coleta
-- UNION ALL SELECT 'kirvano_assinaturas',          COUNT(*) FROM kirvano_assinaturas
-- UNION ALL SELECT 'kirvano_webhook_log',          COUNT(*) FROM kirvano_webhook_log
-- UNION ALL SELECT 'simulador_apostas',            COUNT(*) FROM simulador_apostas
-- UNION ALL SELECT 'coletor_auditoria',            COUNT(*) FROM coletor_auditoria;

-- Últimas coletas bet365:
-- SELECT TOP 10 * FROM bet365_log_coleta ORDER BY data_inicio DESC;

-- Resultados mais recentes:
-- SELECT TOP 10 liga, time_casa, time_fora, mercado, selecao, odd_paga, data_partida
-- FROM bet365_resultados_mercados ORDER BY data_registro DESC;

PRINT '';
PRINT '============================================================';
PRINT '✅ SETUP CONCLUÍDO COM SUCESSO!';
PRINT '============================================================';
GO
