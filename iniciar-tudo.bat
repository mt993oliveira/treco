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

echo [0/4] Atualizando codigo do servidor...
git pull origin master
echo.

echo [1/4] Abrindo Edge porta 9222 — Coletor 1 (resultados)...
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9222 ^
  --no-first-run ^
  --no-default-browser-check ^
  --user-data-dir="C:\Users\Administrador\AppData\Local\Microsoft\Edge\BetColetor" ^
  "https://www.bet365.bet.br/#/AVR/B146/R%%5E1/"

echo [2/4] Abrindo Edge porta 9223 — Coletor 2 (odds, conta propria)...
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9223 ^
  --no-first-run ^
  --no-default-browser-check ^
  --user-data-dir="C:\Users\Administrador\AppData\Local\Microsoft\Edge\BetColetorOdds" ^
  "https://www.bet365.bet.br/#/AVR/B146/R%%5E1/"

echo.
echo  Aguardando Edge carregar as paginas (15s)...
timeout /t 15 /nobreak > nul
echo.

echo [3/4] Iniciando Coletor 2 em janela separada (aguarda 35s para Edge 9223 estabilizar e fazer login)...
start "Coletor 2 - Odds (porta 9223)" cmd /k "cd /d C:\PRODUCAO && echo  Aguardando Edge 9223 estabilizar... && timeout /t 35 /nobreak > nul && set BET365_ODDS_DEBUG_PORT=9223 && node -r dotenv/config backend/services/bet365-coletor-odds.js"

echo [4/4] Iniciando servidor principal ^(Coletor 1 + backend^)...
echo  O coletor detectara e fara login automatico se necessario.
echo.
npm start
pause
