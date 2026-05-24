@echo off
chcp 65001 >nul
echo ============================================
echo   CloudCLI 一键启动
echo ============================================
echo.

:: Kill processes on target ports
for %%p in (3001 5173) do (
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%p.*LISTENING"') do (
        echo 杀掉占用端口 %%p 的进程 PID:%%a
        taskkill /F /PID %%a >nul 2>&1
    )
)

:: Copy .env if not exists
if not exist ".env" (
    echo 创建 .env 配置文件...
    copy .env.example .env >nul
)

echo 启动开发服务器...
echo   后端: http://localhost:3001
echo   前端: http://localhost:5173
echo.
npm run dev
