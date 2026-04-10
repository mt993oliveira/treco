@echo off
title Coletor Bet365 - Futebol Virtual
color 0A
echo ============================================
echo   COLETOR BET365 - FUTEBOL VIRTUAL
echo ============================================
echo.
echo  ANTES DE CONTINUAR, certifique-se de que:
echo.
echo  1. O Edge foi aberto com: abrir-edge-debug.bat
echo  2. Voce acessou no Edge:
echo     https://www.bet365.bet.br/#/AVR/B146/R%%5E1/
echo  3. As ligas de futebol virtual estao visiveis
echo.
echo  Pressione qualquer tecla para iniciar o coletor...
echo ============================================
pause > nul

cd /d C:\PRODUCAO
node -r dotenv/config backend/scheduler-bet365.js
pause
