@echo off
title Edge - Remote Debug Odds (porta 9223)
echo ============================================
echo   ABRINDO EDGE PARA COLETA DE ODDS
echo ============================================
echo.
echo  Porta: 9223
echo  Se a sessao estiver salva, carrega direto.
echo  Se nao, faca login manualmente nesta janela.
echo.
echo ============================================

start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9223 ^
  --no-first-run ^
  --no-default-browser-check ^
  --user-data-dir="C:\Users\Administrador\AppData\Local\Microsoft\Edge\BetColetorOdds" ^
  "https://www.bet365.bet.br/#/AVR/B146/R%%5E1/"

echo Edge (odds) aberto! Aguarde carregar e verifique se o login esta ativo.
