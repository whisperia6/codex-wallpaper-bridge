param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$OutputAssembly,
  [ValidateSet('Library','ConsoleApplication')][string]$OutputType = 'Library',
  [string]$ReferencedAssemblies = 'System.Drawing'
)
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $OutputAssembly){ throw 'media_assembly_exists' }
$refs = @($ReferencedAssemblies -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
Add-Type -Path $Source -ReferencedAssemblies $refs -OutputAssembly $OutputAssembly -OutputType $OutputType
if(!(Test-Path -LiteralPath $OutputAssembly)){ throw 'media_assembly_missing' }
