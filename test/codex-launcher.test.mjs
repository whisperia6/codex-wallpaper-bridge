import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexArguments,
  closeCodexProcesses,
  formatWindowsArgumentLine,
  launchCodex,
  profileDirectoryName,
} from "../src/codex-launcher.mjs";

for (const stage of ['endpoint', 'validation', 'waiting']) test(`canceled launch at ${stage} leaves no unready owned process`, async () => {
  const controller = new AbortController(); let probes = 0, dirs = 0, starts = 0, kills = 0, validations = 0;
  await assert.rejects(launchCodex({
    installation: { path: 'C:/fixture/ChatGPT.exe', isRunning: false }, port: 9335, profileRoot: 'C:/fixture/profiles',
    signal: controller.signal,
    isEndpointReady: async () => {
      probes++; if (stage === 'endpoint' || (stage === 'waiting' && probes === 2)) controller.abort();
      return false;
    },
    validateExecutableFn: async value => { validations++; if (stage === 'validation') controller.abort(); return value; },
    mkdirFn: async () => { dirs++; },
    spawnImpl: () => { starts++; return { pid: 42, unref() {}, kill() { kills++; } }; },
  }), { name: 'AbortError' });
  assert.equal(starts, stage === 'waiting' ? 1 : 0);
  assert.equal(kills, starts); assert.equal(dirs, starts);
  if (stage === 'endpoint') assert.equal(validations, 0);
});

test('takeover close passes an explicit identity allowlist and guards process-set changes', async () => {
  const expectedProcesses = [{ processId: 42, commandLine: 'ChatGPT.exe' }];
  await closeCodexProcesses({ installation: { path: 'C:/fixture/ChatGPT.exe' }, expectedProcesses,
    validateExecutableFn: async p => p,
    processRunner: async (_, args, options) => {
      assert.deepEqual(JSON.parse(options.env.CWB_EXPECTED_PROCESSES), expectedProcesses);
      assert.match(args.at(-1), /process set changed/);
      assert.match(args.at(-1), /\$matched = \$roots/);
      return { stdout: JSON.stringify({ matchedProcessIds: [42], remainingProcessIds: [] }) };
    },
  });
});
test('invalid takeover allowlist and canceled close never execute the process runner', async () => {
  let calls = 0;
  const options = { installation: { path: 'C:/fixture/ChatGPT.exe' }, validateExecutableFn: async p => p,
    processRunner: async () => { calls++; } };
  for (const expectedProcesses of [[], [{ processId: 0, commandLine: 'x' }], [{ processId: 42, commandLine: 'x --remote-debugging-port=9335' }]]) {
    await assert.rejects(closeCodexProcesses({ ...options, expectedProcesses }), /清单无效/);
  }
  const controller = new AbortController();
  await assert.rejects(closeCodexProcesses({ ...options, signal: controller.signal,
    validateExecutableFn: async p => { controller.abort(); return p; } }), { name: 'AbortError' });
  assert.equal(calls, 0);
  await assert.rejects(launchCodex({ signal: controller.signal }), { name: 'AbortError' });
});

test("Codex launches CDP on loopback with an isolated profile", () => {
  assert.deepEqual(buildCodexArguments({ port: 9336, profilePath: "C:\\Temp\\Codex Store" }), [
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9336",
    "--user-data-dir=C:\\Temp\\Codex Store",
  ]);
});

test("profile directory names are stable, safe, and distinct by executable path", () => {
  const store = profileDirectoryName("C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe");
  const local = profileDirectoryName("D:\\Work\\Codex\\ChatGPT.exe");

  assert.match(store, /^codex-[a-f0-9]{12}$/);
  assert.notEqual(store, local);
  assert.equal(store, profileDirectoryName("c:\\PROGRAM FILES\\WindowsApps\\OpenAI.Codex\\app\\chatgpt.exe"));
});

test("closing Codex passes the selected executable through the environment and verifies no processes remain", async () => {
  const executablePath = "D:\\Portable Apps\\Codex\\ChatGPT.exe";
  const calls = [];
  const result = await closeCodexProcesses({
    installation: {
      path: executablePath,
      isRunning: true,
      processIds: [4100, 4200],
    },
    processRunner: async (file, args, options) => {
      calls.push({ file, args, options });
      return {
        stdout: JSON.stringify({ matchedProcessIds: [4100, 4200], remainingProcessIds: [] }),
      };
    },
    validateExecutableFn: async (value) => value,
  });

  assert.equal(result.closedCount, 2);
  assert.deepEqual(result.processIds, [4100, 4200]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "powershell.exe");
  assert.equal(calls[0].options.env.CWB_TARGET_EXE, executablePath);
  assert.doesNotMatch(calls[0].args.join(" "), /D:\\\\Portable Apps\\\\Codex/);
});

test("closing Codex fails when the selected executable still has running processes", async () => {
  await assert.rejects(() => closeCodexProcesses({
    installation: {
      path: "D:\\Work\\Codex\\ChatGPT.exe",
      isRunning: true,
      processIds: [5100],
    },
    processRunner: async () => ({
      stdout: JSON.stringify({ matchedProcessIds: [5100], remainingProcessIds: [5100] }),
    }),
    validateExecutableFn: async (value) => value,
  }), /仍有 1 个进程/);
});

test("formatWindowsArgumentLine quotes spaces cleanly for Store activation", () => {
  assert.equal(
    formatWindowsArgumentLine([
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9335",
      "--user-data-dir=C:\\Users\\Test User\\profiles\\codex-1",
    ]),
    '--remote-debugging-address=127.0.0.1 --remote-debugging-port=9335 "--user-data-dir=C:\\Users\\Test User\\profiles\\codex-1"',
  );
});

test("launchCodex activates Store builds via AUMID to preserve Store taskbar icon and falls back to spawn on error", async () => {
  const activations = [];
  let spawns = 0;
  let readyCalls = 0;
  const result = await launchCodex({
    installation: {
      kind: "store",
      path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe",
      appUserModelId: "OpenAI.Codex_2p2nqsd0c76g0!App",
      isRunning: false,
    },
    port: 9335,
    profileRoot: "C:\\Profiles",
    isEndpointReady: async () => ++readyCalls >= 2,
    validateExecutableFn: async (value) => value,
    mkdirFn: async () => {},
    activateStoreApp: async (options) => {
      activations.push(options);
      return { processId: 9001 };
    },
    spawnImpl: () => {
      spawns++;
      return { pid: 9002, unref() {}, kill() {} };
    },
  });

  assert.equal(result.connected, true);
  assert.equal(result.processId, 9001);
  assert.equal(activations.length, 1);
  assert.equal(activations[0].appUserModelId, "OpenAI.Codex_2p2nqsd0c76g0!App");
  assert.equal(spawns, 0);

  // Fallback to direct spawn when Store activation throws
  readyCalls = 0;
  const fallback = await launchCodex({
    installation: {
      kind: "store",
      path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe",
      appUserModelId: "OpenAI.Codex_2p2nqsd0c76g0!App",
      isRunning: false,
    },
    port: 9335,
    profileRoot: "C:\\Profiles",
    isEndpointReady: async () => ++readyCalls >= 2,
    validateExecutableFn: async (value) => value,
    mkdirFn: async () => {},
    activateStoreApp: async () => { throw new Error("COM unavailable"); },
    spawnImpl: () => {
      spawns++;
      return { pid: 9002, unref() {}, kill() {} };
    },
  });
  assert.equal(fallback.processId, 9002);
  assert.equal(spawns, 1);
});

test("launchCodex cleans up a Store-activated PID if endpoint wait is aborted", async () => {
  const controller = new AbortController();
  const killed = [];
  let probes = 0;
  await assert.rejects(launchCodex({
    installation: {
      kind: "store",
      path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe",
      appUserModelId: "OpenAI.Codex_2p2nqsd0c76g0!App",
      isRunning: false,
    },
    port: 9335,
    profileRoot: "C:\\Profiles",
    signal: controller.signal,
    isEndpointReady: async () => {
      if (++probes === 2) controller.abort();
      return false;
    },
    validateExecutableFn: async (value) => value,
    mkdirFn: async () => {},
    activateStoreApp: async () => ({ processId: 7777 }),
    killProcessFn: (pid) => { killed.push(pid); },
  }), { name: "AbortError" });
  assert.deepEqual(killed, [7777]);
});
