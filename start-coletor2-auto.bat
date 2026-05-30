@echo off
title Coletor 2 - Odds e Proximos Jogos
cd /d C:\PRODUCAO
node -r dotenv/config backend/services/bet365-coletor-odds.js
