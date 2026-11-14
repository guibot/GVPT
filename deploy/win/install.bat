@echo off
rem Windows: instala tudo o que o projecto precisa (Node.js, ffmpeg, Chrome), prepara a pasta e pergunta pelo arranque automatico.
rem Pode ser corrido varias vezes: so instala o que falta. O Windows pede permissao (UAC) para instalar.
rem   set AUTOSTART=yes ou no   responde de antemao a pergunta do arranque automatico
setlocal
set "ROOT=%~dp0..\.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"

echo.
echo ===== 1/5 winget =====
where winget >nul 2>nul
if errorlevel 1 goto nowinget
echo ja instalado.

echo.
echo ===== 2/5 Node.js =====
where node >nul 2>nul
if not errorlevel 1 goto nodeok
call :install OpenJS.NodeJS.LTS || goto fail
where node >nul 2>nul
if errorlevel 1 goto reopen
:nodeok
echo Node.js pronto.

echo.
echo ===== 3/5 ffmpeg =====
where ffmpeg >nul 2>nul
if not errorlevel 1 goto ffok
call :install Gyan.FFmpeg || goto fail
where ffmpeg >nul 2>nul
if errorlevel 1 goto reopen
:ffok
echo ffmpeg pronto.

echo.
echo ===== 4/5 Browser =====
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" goto browserok
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" goto browserok
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" goto browserok
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" goto browserok
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" goto browserok
call :install Google.Chrome || goto fail
:browserok
echo Browser pronto.

echo.
echo ===== 5/5 A preparar o projecto =====
rem Tira a marca "descarregado da internet" dos ficheiros (evita avisos do Windows), menos em node_modules.
powershell -NoProfile -Command "Get-ChildItem -LiteralPath '%ROOT%' -Recurse -File | Where-Object { $_.FullName -notmatch 'node_modules' } | Unblock-File" >nul 2>nul
pushd "%ROOT%\server" || goto fail
call npm install --omit=dev
if errorlevel 1 goto npmfail
popd

echo.
set "ANS=%AUTOSTART%"
if not defined ANS set /p ANS=Arrancar sozinho quando entrares no Windows? [s/N]
if defined ANS set "ANS=%ANS:~0,1%"
if /i "%ANS%"=="s" goto doauto
if /i "%ANS%"=="y" goto doauto
echo Arranque automatico nao ligado. Para ligar mais tarde: deploy\win\autostart.bat on
goto done
:doauto
call "%ROOT%\deploy\win\autostart.bat" on

:done
echo.
echo ===== Tudo pronto =====
echo Para arrancar: duplo clique em deploy\win\start.bat
echo Se a firewall perguntar pelo "node", escolhe Permitir em redes privadas (para o painel abrir noutros dispositivos).
echo.
pause
exit /b 0

:install
echo A instalar %1 (o Windows pode pedir permissao)...
winget install --id %1 -e --silent --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo.
  echo Falhou a instalacao de %1.
  exit /b 1
)
rem O PATH da janela atual nao muda sozinho: le o novo PATH do registo.
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%P"
exit /b 0

:nowinget
echo.
echo Falta o winget. Abre a Microsoft Store, atualiza o "Instalador de Aplicacoes" e corre este ficheiro de novo.
echo (Em alternativa instala a mao: Node.js LTS, ffmpeg e Chrome.)
pause
exit /b 1

:reopen
echo.
echo Instalado, mas esta janela ainda nao o encontra. Fecha esta janela e corre o install.bat outra vez.
pause
exit /b 1

:npmfail
popd
echo.
echo Falhou o "npm install". Verifica a ligacao a internet e corre de novo.
pause
exit /b 1

:fail
echo.
echo A instalacao nao terminou. Corre de novo, ou instala a mao o que falta.
pause
exit /b 1
