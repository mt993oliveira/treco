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

echo [1/3] Abrindo Edge principal (resultados - porta 9222)...
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9222 ^
  --no-first-run ^
  --no-default-browser-check ^
  --user-data-dir="C:\Users\Administrador\AppData\Local\Microsoft\Edge\BetColetor"

echo.
echo ============================================
echo  EDGE PRINCIPAL (porta 9222):
echo.
echo  Acesse: https://www.bet365.bet.br/#/AVR/B146/R%%5E1/
echo  Aguarde as ligas aparecerem na tela.
echo  Depois pressione qualquer tecla aqui.
echo ============================================
echo.
pause > nul

echo [2/3] Abrindo Edge de odds (porta 9223)...
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9223 ^
  --no-first-run ^
  --no-default-browser-check ^
  --user-data-dir="C:\Users\Administrador\AppData\Local\Microsoft\Edge\BetColetorOdds"

echo.
echo ============================================
echo  EDGE DE ODDS (porta 9223):
echo.
echo  Faca login na Bet365 nesta segunda janela.
echo  Navegue para: https://www.bet365.bet.br/#/AVR/B146/R%%5E1/
echo  Aguarde as ligas aparecerem.
echo  Depois pressione qualquer tecla aqui.
echo ============================================
echo.
pause > nul

echo [3/3] Iniciando servidor + coletor de odds...
echo.
echo  Servidor principal: http://localhost:3000/bet365-historico.html
echo  Coletor de odds rodando em janela separada (porta 9223)
echo.

start "Coletor de Odds - BET365" cmd /k "cd /d C:\PRODUCAO && node -r dotenv/config backend/services/bet365-coletor-odds.js"

npm start
pause
