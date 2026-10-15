Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$frontendDir = Split-Path -Parent $PSScriptRoot
$createdEmail = -not (Test-Path Env:NURI_E2E_EMAIL)
$createdPassword = -not (Test-Path Env:NURI_E2E_PASSWORD)
$secretPointer = [IntPtr]::Zero
$changedDirectory = $false

try {
    if ($createdEmail) {
        $email = (Read-Host "NURI 测试账号").Trim()
        if (-not $email) {
            throw "NURI_E2E_EMAIL cannot be empty"
        }
        $env:NURI_E2E_EMAIL = $email
    }

    if ($createdPassword) {
        $securePassword = Read-Host "NURI 测试密码" -AsSecureString
        $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR(
            $securePassword
        )
        $env:NURI_E2E_PASSWORD =
            [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
    }

    Push-Location $frontendDir
    $changedDirectory = $true
    & npm run e2e:login
    if ($LASTEXITCODE -ne 0) {
        throw "Authenticated E2E test failed with exit code $LASTEXITCODE"
    }
}
finally {
    if ($changedDirectory) {
        Pop-Location
    }
    if ($secretPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
    }
    if ($createdEmail) {
        Remove-Item Env:NURI_E2E_EMAIL -ErrorAction SilentlyContinue
    }
    if ($createdPassword) {
        Remove-Item Env:NURI_E2E_PASSWORD -ErrorAction SilentlyContinue
    }
}
