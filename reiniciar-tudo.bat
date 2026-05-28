@echo off
title RadarDaBet - Reinicio Automatico
color 0E
cd /d C:\PRODUCAO

echo ============================================
echo   REINICIO AUTOMATICO - RADARDABET
echo   %date% %time%
echo ============================================
echo.

echo [1/4] Aguardando servidor encerrar (4s)...
timeout /t 4 /nobreak > nul

echo [2/4] Fechando todos os processos Node.js (server + coletor-odds + outros)...
taskkill /F /IM node.exe 2>nul
timeout /t 2 /nobreak > nul

echo [2b] Limpando cooldown de login (permite reconectar imediatamente apos reinicio)...
del "%TEMP%\bet365-login-fail.ts" 2>nul

echo [3/4] Fechando Edge na porta 9222...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":9222 " 2^>nul') do (
    if not "%%a"=="0" (
        echo  Matando PID %%a
        taskkill /F /PID %%a 2>nul
    )
)
timeout /t 2 /nobreak > nul

echo [4/4] Reiniciando tudo via iniciar-tudo.bat...
echo.
rem BET365_AUTO_RESTART=1 impede que iniciar-tudo.bat apague o cooldown de sessao
start "ControlFinance - Bet365" cmd /k "set BET365_AUTO_RESTART=1&& cd /d C:\PRODUCAO && call iniciar-tudo.bat"

echo  Reinicio disparado! Esta janela pode ser fechada.
timeout /t 5 /nobreak > nul
