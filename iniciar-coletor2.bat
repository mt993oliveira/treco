@echo off
title Aguardando login do Coletor 1...
echo  Aguardando 3 minutos para o Coletor 1 fazer login...
timeout /t 180 /nobreak > nul
title Coletor 2 - Odds e Proximos Jogos
cd /d C:\PRODUCAO
node -r dotenv/config backend/services/bet365-coletor-odds.js
pause
