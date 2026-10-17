$Host.UI.RawUI.WindowTitle = "Servidor Nextfilm"
Set-Location -LiteralPath $PSScriptRoot

node server\server.js "E:\"

Write-Host ""
Write-Host "El servidor se ha detenido."
Read-Host "Pulsa Enter para cerrar esta ventana"