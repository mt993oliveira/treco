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
-- CONSULTAS ÚTEIS PARA VERIFICAÇÃO
-- ============================================================

-- Verificar tabelas criadas:
-- SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME LIKE 'betano%' ORDER BY TABLE_NAME;

-- Contagem de registros por tabela:
-- SELECT 'betano_eventos'              AS tabela, COUNT(*) AS total FROM betano_eventos
-- UNION ALL SELECT 'betano_mercados',  COUNT(*) FROM betano_mercados
-- UNION ALL SELECT 'betano_odds',      COUNT(*) FROM betano_odds
-- UNION ALL SELECT 'betano_historico_partidas', COUNT(*) FROM betano_historico_partidas
-- UNION ALL SELECT 'betano_historico_odds', COUNT(*) FROM betano_historico_odds
-- UNION ALL SELECT 'betano_log_coleta', COUNT(*) FROM betano_log_coleta;

-- Últimas coletas:
-- SELECT TOP 10 * FROM betano_log_coleta ORDER BY data_inicio DESC;

-- Histórico de partidas por liga:
-- SELECT liga, COUNT(*) AS total FROM betano_historico_partidas GROUP BY liga ORDER BY total DESC;

PRINT '';
PRINT '============================================================';
PRINT '✅ SETUP CONCLUÍDO COM SUCESSO!';
PRINT '============================================================';
GO
