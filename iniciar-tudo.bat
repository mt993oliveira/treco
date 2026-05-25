@echo off
title ControlFinance - Bet365
color 0A
cd /d C:\PRODUCAO

echo ============================================
echo   CONTROLFINANCE - BET365 FUTEBOL VIRTUAL
echo ============================================
echo.

echo [0/3] Atualizando codigo do servidor...
git pull origin master
echo.

echo [1/3] Abrindo Edge na pagina do futebol virtual (porta 9222)...
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9222 ^
  --no-first-run ^
  --no-default-browser-check ^
  --user-data-dir="C:\Users\Administrador\AppData\Local\Microsoft\Edge\BetColetor" ^
  "https://www.bet365.bet.br/#/AVR/B146/R%%5E1/"

echo.
echo  Aguardando Edge carregar a pagina (15s)...
timeout /t 15 /nobreak > nul
echo.

echo [2/3] Iniciando Coletor 2 (Odds e Proximos Jogos)...
start "Coletor 2 - Odds e Proximos Jogos" cmd /k "cd /d C:\PRODUCAO && node -r dotenv/config backend/services/bet365-coletor-odds.js"
echo.

echo [3/3] Iniciando servidor principal...
echo  O coletor detectara e fara login automatico se necessario.
echo.
npm start
pause
