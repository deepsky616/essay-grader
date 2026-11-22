@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0" || exit /b 1
node.exe -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >nul 2>&1
if errorlevel 1 goto need_node
if not exist "node_modules\kordoc\dist\cli.js" (
    echo Installing the local Kordoc reader...
    call npm.cmd --prefix "." install --no-save --ignore-scripts --no-package-lock --omit=peer --no-audit --no-fund kordoc@4.25.3
    if errorlevel 1 goto end
)
powershell.exe -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $reader = (Get-Item -LiteralPath './read-kordoc.mjs').FullName; $pdf = New-Object Windows.Forms.OpenFileDialog; $pdf.Title = 'Select the original assessment PDF'; $pdf.Filter = 'Assessment PDF (*.pdf)|*.pdf'; $pdf.RestoreDirectory = $true; if ($pdf.ShowDialog() -ne 'OK') { exit }; $report = New-Object Windows.Forms.SaveFileDialog; $report.Title = 'Save the Kordoc report'; $report.Filter = 'Kordoc report (*.json)|*.json'; $report.RestoreDirectory = $true; $report.InitialDirectory = [IO.Path]::GetDirectoryName($pdf.FileName); $report.FileName = [IO.Path]::GetFileNameWithoutExtension($pdf.FileName) + '.kordoc.json'; if ($report.ShowDialog() -ne 'OK') { exit }; & node.exe $reader $pdf.FileName $report.FileName; exit $LASTEXITCODE"
goto end
:need_node
echo Node.js LTS 20 or newer is required. Install from https://nodejs.org/ko/download and reopen this file.
:end
popd
pause
