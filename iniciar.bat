@echo off
setlocal EnableExtensions
title MercadoOS
cd /d "%~dp0"

rem Node esta instalado con fnm. Un doble clic no carga esa ruta, hay que agregarla.
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\fnm.exe" set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"
if exist "%USERPROFILE%\AppData\Local\Microsoft\WinGet\Links\fnm.exe" set "PATH=%USERPROFILE%\AppData\Local\Microsoft\WinGet\Links;%PATH%"

where fnm >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%i in ('fnm env --shell cmd 2^>nul') do call %%i
)

if not exist "%USERPROFILE%\AppData\Roaming\fnm\node-versions\v20.20.2\installation\node.exe" goto :after_fnm_fallback
set "PATH=%USERPROFILE%\AppData\Roaming\fnm\node-versions\v20.20.2\installation;%PATH%"
:after_fnm_fallback

where node >nul 2>&1
if errorlevel 1 (
  echo No se encontro Node.js.
  echo Instala Node o abre este archivo desde una terminal donde "node -v" funcione.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Instalando dependencias, espera...
  call npm.cmd install
  if errorlevel 1 (
    echo Fallo npm install.
    pause
    exit /b 1
  )
)

netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul
if not errorlevel 1 (
  echo MercadoOS ya estaba abierto.
  start "" "http://localhost:3000"
  exit /b 0
)

echo Abriendo http://localhost:3000
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
echo No cierres esta ventana mientras uses el sistema.
node src\server.js
echo.
echo El servidor se detuvo.
pause
