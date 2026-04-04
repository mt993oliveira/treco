@echo off
title Parar Futebol Virtual
echo ========================================
echo   PARAR - FUTEBOL VIRTUAL
echo ========================================
echo.
echo Parando processos Node.js...
echo.
taskkill /F /IM node.exe 2>nul
if %errorlevel% equ 0 (
    echo.
    echo ✅ Processos parados com sucesso!
) else (
    echo.
    echo ⚠️ Nenhum processo Node.js em execução
)
echo.
pause
