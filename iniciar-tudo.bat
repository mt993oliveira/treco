@echo off
title ControlFinance - Bet365
color 0A
cd /d C:\PRODUCAO

echo ============================================
echo   CONTROLFINANCE - BET365 FUTEBOL VIRTUAL
echo ============================================
echo.

echo [1/2] Abrindo Edge com debug...
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9222 ^
  --no-first-run ^
  --no-default-browser-check ^
  --user-data-dir="C:\Users\Administrador\AppData\Local\Microsoft\Edge\BetColetor"

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

echo [2/2] Iniciando servidor + coletor...
echo.
echo  Apos iniciar, acesse: http://localhost:3000/bet365-historico.html
echo.
npm start
pause
