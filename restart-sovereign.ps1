# Sovereign Forex Prime - One-Click Restart + Dashboard Auto-Open
Write-Host "🔄 Stopping any running Sovereign Forex server..." -ForegroundColor Yellow
Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

Write-Host "🚀 Starting Sovereign Forex Prime..." -ForegroundColor Green
$env:NODE_ENV = 'development'

# Auto-open dashboard
Start-Process "http://localhost:3000"

# Start the server
npx tsx server.ts
