@echo off
title Coletor 2 - Odds e Proximos Jogos (porta 9223)
cd /d C:\PRODUCAO
set BET365_ODDS_DEBUG_PORT=9223
node -r dotenv/config backend/services/bet365-coletor-odds.js
