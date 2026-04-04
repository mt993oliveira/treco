@echo off
title Coletor Bet365 - Futebol Virtual
color 0A
echo ============================================
echo   COLETOR BET365 - FUTEBOL VIRTUAL
echo ============================================
echo.
echo  URL: https://www.bet365.bet.br/#/AVR/B146/R^1/
echo  Intervalo: 1 minuto
echo.
echo  IMPORTANTE: Uma janela do Chrome sera aberta
echo  e minimizada automaticamente. NAO feche ela.
echo.
echo ============================================
cd /d C:\PRODUCAO
node -r dotenv/config backend/scheduler-bet365.js
pause
