param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$SshArgs
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $scriptDir 'ssh_config'

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "SSH config not found: $configPath"
}

$argsList = @('-F', $configPath, 'aliyun-ubuntu')
if ($SshArgs) {
    $argsList += $SshArgs
}

& ssh @argsList
$exitCode = $LASTEXITCODE
if ($null -ne $exitCode) {
    exit $exitCode
}
