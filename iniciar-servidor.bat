@echo off
title Servidor - Futebol Virtual
echo ========================================
echo   SERVIDOR - FUTEBOL VIRTUAL
echo ========================================
echo.
echo Atualizando codigo...
cd /d C:\PRODUCAO
git pull origin master
echo.
echo Iniciando servidor...
echo.
echo Para parar: Pressione Ctrl+C
echo.
npm start
pause
