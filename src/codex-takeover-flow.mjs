import { hasAnyCodexDebugPort } from './codex-processes.mjs';

// Recheck at every async boundary. Cancellation never authorizes another close,
// launch or injection, even if an already-started OS operation must finish first.
export async function runCodexTakeoverFlow({
  installation, port, adaptive, expectedProcesses, signal, isCurrent,
  listProcesses, isEndpointReady, confirmClose, closeCodex, launchCodex,
  waitForTarget, verifyOwner, injectOnce,
}) {
  const check = () => {
    if (signal.aborted || !isCurrent()) throw new Error('自动接管已取消');
  };
  const step = async (fn) => { check(); const result = await fn(); check(); return result; };
  const expected = new Map(expectedProcesses.map(p => [p.processId, p.commandLine]));
  const confirmedInstallation = { ...installation, isRunning: true, processIds: [...expected.keys()] };
  const recheck = async () => {
    if (await step(() => isEndpointReady(port))) return false;
    const processes = await step(() => listProcesses(installation));
    // A changed process set needs a new user decision, not an expanded kill set.
    return expected.size > 0 && processes.length === expected.size && processes.every(p =>
      p.mainWindowHandle > 0 && !hasAnyCodexDebugPort(p.commandLine)
      && expected.get(p.processId) === p.commandLine);
  };
  if (!await recheck()) return { skipped: true };
  // Dialog can remain open while restore/quit cancels the task. Its late result
  // is ignored and cannot resurrect the operation.
  const confirmed = await step(() => new Promise((resolve, reject) => {
    const abort = () => reject(new Error('自动接管已取消'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { check(); return confirmClose(confirmedInstallation); })
      .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  }));
  if (!confirmed) return { canceled: true };
  if (!await recheck()) return { skipped: true };
  await step(() => closeCodex(confirmedInstallation, expectedProcesses));
  await step(() => launchCodex({ installation: { ...installation, isRunning: false, processIds: [] }, port, signal }));
  await step(() => waitForTarget(port, signal));
  await step(() => verifyOwner(installation, port));
  await step(() => injectOnce({ port, adaptive, signal }));
  return { restored: true };
}
