export async function runLaunchAndInjectFlow({
  installation,
  port,
  adaptive,
  isEndpointReady,
  confirmClose,
  closeCodex,
  launchCodex,
  waitForTarget,
  injectOnce,
}) {
  const alreadyDebuggable = await isEndpointReady(port);
  let selectedInstallation = installation;
  let closed = null;

  if (installation?.isRunning && !alreadyDebuggable) {
    const confirmed = await confirmClose(installation);
    if (!confirmed) {
      return {
        canceled: true,
        message: "已取消，Codex 保持运行",
      };
    }
    closed = await closeCodex(installation);
    selectedInstallation = {
      ...installation,
      isRunning: false,
      processIds: [],
    };
  }

  let launch = null;
  if (!alreadyDebuggable) {
    launch = await launchCodex({
      installation: selectedInstallation,
      port,
    });
    await waitForTarget(port);
  }
  const injection = await injectOnce({ port, adaptive });
  return {
    canceled: false,
    closed,
    launch,
    injection,
  };
}
