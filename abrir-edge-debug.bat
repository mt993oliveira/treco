@echo off
title Edge - Remote Debug (Bet365)
echo ============================================
echo   ABRINDO EDGE COM REMOTE DEBUG
echo ============================================
echo.
echo  Porta: 9222
echo  Apos abrir, acesse normalmente a Bet365
echo  e depois rode: node testar-bet365.js
echo.
echo ============================================

start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9222 ^
  --no-first-run ^
  --no-default-browser-check ^
  --user-data-dir="C:\Users\Administrador\AppData\Local\Microsoft\Edge\BetColetor"

echo Edge aberto! Navegue para a Bet365 e rode o teste.
