import { spawn } from 'node:child_process';
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function runCompileScript({ executable, script, source, outputAssembly, outputType, referencedAssemblies, errorPrefix }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Source', source,
      '-OutputAssembly', outputAssembly,
      '-OutputType', outputType,
      '-ReferencedAssemblies', referencedAssemblies.join(','),
    ];
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(Error(`${errorPrefix}_timeout`)); }, 30000);
    child.once('error', () => { clearTimeout(timer); reject(Error(`${errorPrefix}_unavailable`)); });
    child.once('exit', code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(Error(`${errorPrefix}_failed${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

function runCscCompile({ source, outputAssembly, referencedAssemblies, errorPrefix }) {
  const csc = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe',
  );
  return new Promise((resolve, reject) => {
    const args = [
      '/nologo',
      '/optimize+',
      '/platform:x64',
      '/target:exe',
      `/out:${outputAssembly}`,
      ...referencedAssemblies.map((asm) => `/r:${asm}.dll`),
      source,
    ];
    const child = spawn(csc, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { output += chunk.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(Error(`${errorPrefix}_timeout`)); }, 30000);
    child.once('error', () => { clearTimeout(timer); reject(Error(`${errorPrefix}_unavailable`)); });
    child.once('exit', code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(Error(`${errorPrefix}_failed${output.trim() ? `: ${output.trim()}` : ''}`));
    });
  });
}

export async function compileWindowsMedia({ nativeRoot, outputRoot, platform = process.platform }) {
  if (platform !== 'win32') throw Error('windows_media_compile_requires_windows');
  await mkdir(outputRoot, { recursive: true });
  await copyFile(path.join(nativeRoot, 'windows-media.ps1'), path.join(outputRoot, 'windows-media.ps1'));
  const script = fileURLToPath(new URL('./compile-windows-media.ps1', import.meta.url));
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  await Promise.all([
    runCompileScript({
      executable,
      script,
      source: path.resolve(nativeRoot, 'windows-media.cs'),
      outputAssembly: path.resolve(outputRoot, 'windows-media.dll'),
      outputType: 'Library',
      referencedAssemblies: ['System.Drawing'],
      errorPrefix: 'windows_media_compile',
    }),
    runCscCompile({
      source: path.resolve(nativeRoot, 'cwb-win-helper.cs'),
      outputAssembly: path.resolve(outputRoot, 'cwb-win-helper.exe'),
      referencedAssemblies: ['System.Core', 'System.Management', 'System.Web.Extensions'],
      errorPrefix: 'windows_helper_compile',
    }),
  ]);
}
