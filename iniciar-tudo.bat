@echo off
title ControlFinance - Bet365
color 0A
cd /d C:\PRODUCAO

echo ============================================
echo   CONTROLFINANCE - BET365 FUTEBOL VIRTUAL
echo ============================================
echo.

rem ── Reinicio manual: limpa cooldowns de sessao para comecar do zero ──
rem    (se vier de reiniciar-tudo.bat, BET365_AUTO_RESTART=1 e nao apaga)
if not "%BET365_AUTO_RESTART%"=="1" (
    del "%TEMP%\bet365-restart.ts"    2>nul
    del "%TEMP%\bet365-login-fail.ts" 2>nul
    echo [Pre] Cooldowns de sessao limpos ^(inicio manual^).
)
set BET365_AUTO_RESTART=

echo [0/3] Atualizando codigo do servidor...
git pull origin master
echo.

echo [1/3] Abrindo Edge com 2 abas do futebol virtual (porta 9222)...
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9222 ^
  --no-first-run ^
  --no-default-browser-check ^
  --user-data-dir="C:\Users\Administrador\AppData\Local\Microsoft\Edge\BetColetor" ^
  "https://www.bet365.bet.br/#/AVR/B146/R%%5E1/" ^
  "https://www.bet365.bet.br/#/AVR/B146/R%%5E1/"

echo.
echo  Aguardando Edge carregar a pagina (15s)...
timeout /t 15 /nobreak > nul
echo.

echo [2/3] Iniciando servidor principal (Coletor 1)...
echo  O coletor detectara e fara login automatico se necessario.
echo.
npm start
pause
