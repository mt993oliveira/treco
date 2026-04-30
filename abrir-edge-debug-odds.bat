@echo off
title Edge - Remote Debug Odds (porta 9223)
echo ============================================
echo   ABRINDO EDGE PARA COLETA DE ODDS
echo ============================================
echo.
echo  Porta: 9223
echo  Faca login na Bet365 nesta janela.
echo.
echo ============================================

start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9223 ^
  --no-first-run ^
  --no-default-browser-check ^
  --user-data-dir="C:\Users\Administrador\AppData\Local\Microsoft\Edge\BetColetorOdds"

echo Edge (odds) aberto! Faca login na Bet365 e navegue para o futebol virtual.
