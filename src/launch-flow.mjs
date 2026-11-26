export async function runLaunchAndInjectFlow({
  installation,
  runningInstallations = [],
  port,
  adaptive,
  isEndpointReady,
  verifyEndpointOwner,
  confirmClose,
  confirmLaunchSeparate,
  closeCodex,
  launchCodex,
  waitForTarget,
  injectOnce,
  onPhase = () => {},
}) {
  if (typeof verifyEndpointOwner !== "function") {
    throw new Error("缺少必需的 verifyEndpointOwner 校验回调");
  }
  const measure = async (phase, task) => {
    const startedAt = performance.now();
    let ok = false;
    try { const result = await task(); ok = true; return result; }
    finally {
      try { onPhase({ phase, elapsedMs: performance.now() - startedAt, ok }); } catch {}
    }
  };
  const alreadyDebuggable = await measure("endpoint", () => isEndpointReady(port));
  if (alreadyDebuggable) await measure("owner", () => verifyEndpointOwner(installation, port));
  let selectedInstallation = installation;
  let closed = null;

  const hostName = installation?.hostType === "antigravity" || /(?:^|[\\/])antigravity\.exe$/i.test(String(installation?.path || ""))
    ? "Antigravity"
    : "Codex";
  if (!alreadyDebuggable && !installation?.isRunning) {
    const otherRunningInstallations = runningInstallations.filter(({ id, isRunning }) => isRunning && id !== installation.id);
    if (otherRunningInstallations.length > 0) {
      if (typeof confirmLaunchSeparate !== "function") {
        throw new Error(`启动另一版本的 ${hostName} 前需要确认，已停止启动`);
      }
      const confirmed = await measure("confirmation", () => confirmLaunchSeparate(installation, otherRunningInstallations));
      if (confirmed !== true) {
        return {
          canceled: true,
          message: `已取消，未启动另一版本，原有 ${hostName} 窗口保持不变`,
        };
      }
    }
  }

  if (installation?.isRunning && !alreadyDebuggable) {
    const confirmed = await measure("confirmation", () => confirmClose(installation));
    if (!confirmed) {
      return {
        canceled: true,
        message: `已取消，${hostName} 保持运行`,
      };
    }
    closed = await measure("close", () => closeCodex(installation));
    selectedInstallation = {
      ...installation,
      isRunning: false,
      processIds: [],
    };
  }

  let launch = null;
  if (!alreadyDebuggable) {
    launch = await measure("launch", () => launchCodex({
      installation: selectedInstallation,
      port,
    }));
    await measure("target", () => waitForTarget(port));
    await measure("owner", () => verifyEndpointOwner(selectedInstallation, port));
  }
  const injection = await measure("inject", () => injectOnce({ port, adaptive }));
  return {
    canceled: false,
    closed,
    launch,
    injection,
  };
}
