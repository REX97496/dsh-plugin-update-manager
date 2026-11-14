@echo off
rem Push the local release commits + tag to GitHub.
rem A Git Credential Manager window will open once; sign in and the token is cached.
cd /d "%~dp0.."
if not "%HTTPS_PROXY%"=="" goto run
set HTTPS_PROXY=http://127.0.0.1:7897
set HTTP_PROXY=http://127.0.0.1:7897
:run
set GIT_SSL_NO_VERIFY=true
git push origin main
if errorlevel 1 goto fail
git push origin v0.1.2
if errorlevel 1 goto fail
echo.
echo Pushed main and tag v0.1.2.
goto end
:fail
echo.
echo Push failed. Sign in when the credential window appears, or run: git push origin main --tags
:end
pause
