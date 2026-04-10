@echo off
title ControlFinance - Bet365
color 0A
cd /d C:\PRODUCAO

echo ============================================
echo   CONTROLFINANCE - BET365 FUTEBOL VIRTUAL
echo ============================================
echo.

echo [1/3] Abrindo Edge com debug...
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9222 ^
  --no-first-run ^
  --no-default-browser-check ^
  --user-data-dir="C:\Users\Administrador\AppData\Local\Microsoft\Edge\BetColetor"

echo [2/3] Iniciando servidor web (porta 3000)...
start "Servidor Web" cmd /k "cd /d C:\PRODUCAO && npm start"

echo.
echo ============================================
echo  AGORA FACA O SEGUINTE NO EDGE QUE ABRIU:
echo.
echo  Acesse:
echo  https://www.bet365.bet.br/#/AVR/B146/R%%5E1/
echo.
echo  Aguarde as ligas aparecerem na tela.
echo  Depois pressione qualquer tecla aqui.
echo ============================================
echo.
pause > nul

echo [3/3] Iniciando coletor...
echo.
node -r dotenv/config backend/scheduler-bet365.js
pause
