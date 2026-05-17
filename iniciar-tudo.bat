@echo off
title ControlFinance - Bet365
color 0A
cd /d C:\PRODUCAO

echo ============================================
echo   CONTROLFINANCE - BET365 FUTEBOL VIRTUAL
echo ============================================
echo.

echo [0/3] Atualizando codigo do servidor...
cd /d C:\PRODUCAO
git pull origin master
echo.

echo [1/3] Abrindo Edge (porta 9222)...
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9222 ^
  --no-first-run ^
  --no-default-browser-check ^
  --user-data-dir="C:\Users\Administrador\AppData\Local\Microsoft\Edge\BetColetor"

echo.
echo ============================================
echo  EDGE (porta 9222):
echo.
echo  Acesse: https://www.bet365.bet.br/#/AVR/B146/R%%5E1/
echo  Faca login e aguarde as ligas aparecerem na tela.
echo  Depois pressione qualquer tecla aqui.
echo ============================================
echo.
pause > nul

echo Abrindo segunda aba para o Coletor 2 (odds)...
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --profile-directory="BetColetor" ^
  "https://www.bet365.bet.br/#/AVR/B146/R%%5E1/"

echo.
echo ============================================
echo  SEGUNDA ABA (Coletor 2):
echo.
echo  Uma segunda aba foi aberta no mesmo Edge.
echo  Aguarde as ligas aparecerem nela tambem.
echo  Depois pressione qualquer tecla aqui.
echo ============================================
echo.
pause > nul

echo [2/3] Iniciando servidor + Coletor 2 (odds)...
echo.
echo  Servidor principal: http://localhost:3000
echo  Coletor 2 abrira aba propria no Edge ja aberto (porta 9222)
echo.

start "Coletor 2 - Odds e Proximos Jogos" cmd /k "cd /d C:\PRODUCAO && node -r dotenv/config backend/services/bet365-coletor-odds.js"

echo [3/3] Iniciando servidor principal...
echo.
npm start
pause
