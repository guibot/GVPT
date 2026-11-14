@echo off
rem Windows: arranca o servidor (janela minimizada) e abre o player em ecra inteiro. Duplo clique.
rem   set NO_PLAYER=1   so o servidor (sem abrir o browser)
rem   set PORT=8080     porta do servidor
rem Para parar: deploy\win\stop.bat
setlocal
cd /d "%~dp0..\..\server" || exit /b 1
if not defined PORT set PORT=8080
if not defined PLAYER_URL set PLAYER_URL=http://localhost:%PORT%/player/

where node >nul 2>nul || (echo Falta o Node.js. Corre primeiro: deploy\win\install.bat & pause & exit /b 1)
where ffmpeg >nul 2>nul || (echo Falta o ffmpeg. Corre primeiro: deploy\win\install.bat & pause & exit /b 1)
if not exist node_modules call npm install --omit=dev

if "%MINIMIZE%"=="1" (start "video-server" /min node index.js) else (start "video-server" node index.js)

if "%NO_PLAYER%"=="1" exit /b 0

set /a n=0
:wait
curl -fs -o nul http://localhost:%PORT%/api/info && goto up
set /a n+=1
if %n% geq 60 goto up
timeout /t 1 /nobreak >nul
goto wait

:up
set "BROWSER="
if not defined BROWSER if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER (echo Sem Chrome nem Edge. Abre %PLAYER_URL% num browser. & pause & exit /b 1)

start "" "%BROWSER%" --user-data-dir="%LocalAppData%\video-player-browser" --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble --disable-features=Translate,TranslateUI --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required --overscroll-history-navigation=0 --disable-pinch "%PLAYER_URL%"
exit /b 0
