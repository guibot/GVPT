@echo off
rem Windows: arrancar automaticamente ao iniciar sessao (atalho na pasta Startup do utilizador).
rem   deploy\win\autostart.bat on | off | status
setlocal
set "FILE=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\video-server.cmd"
if /i "%~1"=="on" goto on
if /i "%~1"=="off" goto off
if exist "%FILE%" (echo autostart: LIGADO) else (echo autostart: desligado)
exit /b 0
:on
> "%FILE%" echo @echo off
>> "%FILE%" echo set MINIMIZE=1
>> "%FILE%" echo start "" /min cmd /c "%~dp0start.bat"
echo autostart LIGADO.
exit /b 0
:off
del "%FILE%" >nul 2>nul
echo autostart DESLIGADO.
exit /b 0
