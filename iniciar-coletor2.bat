@echo off
title Coletor 2 - Odds e Proximos Jogos (porta 9223)
echo  Iniciando Coletor 2 em modo autonomo (porta 9223)...
echo  Certifique-se de que o Edge esta aberto na porta 9223 antes de continuar.
echo.
cd /d C:\PRODUCAO
set BET365_ODDS_DEBUG_PORT=9223
node -r dotenv/config backend/services/bet365-coletor-odds.js
pause
