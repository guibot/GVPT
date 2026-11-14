@echo off
rem Windows: pára o servidor lançado por start.bat e fecha o player (browser com o perfil video-player-browser).
taskkill /fi "WINDOWTITLE eq video-server*" /f >nul 2>nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*video-player-browser*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul
echo Parado.
