@echo off
title Iniciar Coletor Betano
echo ============================================
echo   INICIAR COLETOR BETANO - PRODUCAO
echo ============================================
echo.
echo Este script vai:
echo 1. Verificar se PM2 esta instalado
echo 2. Iniciar o agendador de coletas
echo 3. Configurar para iniciar com Windows
echo.
pause

cd /d %~dp0

echo.
echo ============================================
echo   1. VERIFICANDO PM2
echo ============================================
echo.

pm2 --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ PM2 nao encontrado. Instalando...
    npm install -g pm2
    if %errorlevel% neq 0 (
        echo.
        echo ❌ Erro ao instalar PM2. Instale manualmente:
        echo    npm install -g pm2
        pause
        exit /b 1
    )
    echo ✅ PM2 instalado com sucesso!
) else (
    echo ✅ PM2 ja esta instalado
)

echo.
echo ============================================
echo   2. INICIANDO AGENDADOR
echo ============================================
echo.

pm2 list | find "betano-coletor" >nul 2>&1
if %errorlevel% equ 0 (
    echo ℹ️  Agendador ja existe. Reiniciando...
    pm2 restart betano-coletor
) else (
    echo 🚀 Iniciando agendador...
    pm2 start backend/scheduler.js --name "betano-coletor"
)

echo.
echo ============================================
echo   3. CONFIGURANDO STARTUP
echo ============================================
echo.

echo 💾 Salvando configuracao atual...
pm2 save

echo.
echo ⚙️  Configurando startup do Windows...
pm2 startup

echo.
echo ============================================
echo   4. VERIFICANDO STATUS
echo ============================================
echo.

pm2 status betano-coletor

echo.
echo ============================================
echo   COMANDOS UTEIS
echo ============================================
echo.
echo Para ver logs em tempo real:
echo   pm2 logs betano-coletor
echo.
echo Para monitorar uso de CPU/memoria:
echo   pm2 monit
echo.
echo Para ver status:
echo   pm2 status
echo.
echo Para parar:
echo   pm2 stop betano-coletor
echo.
echo Para reiniciar:
echo   pm2 restart betano-coletor
echo.
echo ============================================
echo   ✅ COLETOR INICIADO COM SUCESSO!
echo ============================================
echo.
echo O agendador vai coletar dados a cada 1 minuto, 24h por dia.
echo.
pause
