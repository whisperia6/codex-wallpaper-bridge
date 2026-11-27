import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import {
  activateStoreCodex,
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
  assert.match(calls[0].args.at(-1), /GetFileName\(\$targetPath\)/);
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

test("closing Codex reports actionable permission guidance when remaining processes are access denied", async () => {
  const logs = [];
  await assert.rejects(() => closeCodexProcesses({
    installation: {
      path: "D:\\codex\\ChatGPT.exe",
      isRunning: true,
      processIds: [5100, 5101, 5102],
    },
    onLog: (entry) => logs.push(entry.text),
    processRunner: async () => ({
      stdout: JSON.stringify({
        matchedProcessIds: [5100, 5101, 5102],
        remainingProcessIds: [5100, 5101],
        accessDeniedProcessIds: [5100, 5101],
        killErrors: ["win32:5"],
      }),
    }),
    validateExecutableFn: async (value) => value,
  }), /2 个进程权限不足.*管理员身份/);
  assert.ok(logs.some((line) => line.includes("win32:5")));
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

test("activateStoreCodex retries with PowerShell after the helper reports COM access denied", async () => {
  const appUserModelId = "OpenAI.Codex_2p2nqsd0c76g0!App";
  const args = ["--remote-debugging-port=9335", "--user-data-dir=C:\\Test Profiles\\codex-1"];
  const signal = new AbortController().signal;
  const calls = [];
  const result = await activateStoreCodex({
    appUserModelId,
    args,
    signal,
    runWinHelper: async (subcommand, options) => {
      assert.equal(subcommand, "activate-store-app");
      calls.push(options);
      throw Object.assign(new Error("0x80070005 (E_ACCESSDENIED)"), { code: 1 });
    },
    processRunner: async (command, commandArgs, options) => {
      assert.equal(command, "powershell.exe");
      assert.deepEqual(commandArgs.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
      assert.match(commandArgs[3], /\[CwbStoreActivator\]::Activate/);
      calls.push(options);
      return { stdout: '\uFEFF{"processId":9001,"createdNew":false}' };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1]);
  assert.equal(calls[1].signal, signal);
  assert.equal(calls[1].env.CWB_STORE_AUMID, appUserModelId);
  assert.equal(calls[1].env.CWB_STORE_ARGS, formatWindowsArgumentLine(args));
  assert.deepEqual(result, { processId: 9001, createdNew: false });
});

test("activateStoreCodex does not retry a canceled helper invocation", async () => {
  const abort = new DOMException("Canceled", "AbortError");
  await assert.rejects(activateStoreCodex({
    appUserModelId: "OpenAI.Codex_2p2nqsd0c76g0!App",
    args: [],
    runWinHelper: async () => { throw abort; },
    processRunner: async () => assert.fail("PowerShell must not run after an abort"),
  }), (error) => error === abort);
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

  const executablePath = "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe";
  readyCalls = 0;
  const fallback = await launchCodex({
    installation: {
      kind: "store",
      path: executablePath,
      appUserModelId: "OpenAI.Codex_2p2nqsd0c76g0!App",
      isRunning: false,
    },
    port: 9335,
    profileRoot: "C:\\Profiles",
    isEndpointReady: async () => ++readyCalls >= 2,
    validateExecutableFn: async (value) => value,
    mkdirFn: async () => {},
    activateStoreApp: async () => { throw new Error("COM unavailable"); },
    spawnImpl: (file) => {
      assert.equal(file, executablePath);
      spawns++;
      return { pid: 9002, unref() {}, kill() {} };
    },
  });
  assert.equal(fallback.processId, 9002);
  assert.equal(spawns, 1);
});

test("launchCodex waits for detached spawn before releasing the child or polling CDP", async (t) => {
  for (const event of ["spawn", "error"]) {
    await t.test(event, async () => {
      const spawnError = Object.assign(new Error("Alias execution denied"), { code: "EACCES" });
      const calls = [];
      const child = Object.assign(new EventEmitter(), {
        pid: 9002,
        unref: () => calls.push("unref"),
      });
      const launch = launchCodex({
        installation: { path: "C:/fixture/ChatGPT.exe" },
        port: 9335,
        profileRoot: "C:/fixture/profiles",
        isEndpointReady: async () => {
          calls.push("probe");
          return calls.length > 1;
        },
        validateExecutableFn: async (file) => file,
        mkdirFn: async () => {},
        spawnImpl: () => {
          setImmediate(() => {
            calls.push(event);
            child.emit(event, spawnError);
          });
          return child;
        },
      });

      if (event === "error") {
        await assert.rejects(launch, (error) => error === spawnError);
        assert.deepEqual(calls, ["probe", "error"]);
      } else {
        assert.equal((await launch).processId, child.pid);
        assert.deepEqual(calls, ["probe", "spawn", "unref", "probe"]);
      }
    });
  }
});

test("launchCodex only uses a Store alias with a valid matching package identity", async (t) => {
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const localAppData = "C:\\Users\\Test User\\AppData\\Local";
  process.env.LOCALAPPDATA = localAppData;
  t.after(() => {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
  });
  const packageFamilyName = "OpenAI.Codex_2p2nqsd0c76g0";
  const aliasesRoot = path.win32.join(localAppData, "Microsoft", "WindowsApps");
  const aliasPath = path.win32.join(aliasesRoot, packageFamilyName, "chatgpt-desktop.exe");
  const otherAliasPath = path.win32.join(aliasesRoot, "Other.Package_123", "chatgpt-desktop.exe");
  const storeIdentity = { appUserModelId: `${packageFamilyName}!App` };
  const executablePath = "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe";
  const profileRoot = "C:\\Test Profiles";
  const expectedProfile = path.join(profileRoot, profileDirectoryName(executablePath, "codex"));
  const cases = [
    { name: "available alias", candidate: aliasPath, validateAlias: true, expectedPath: aliasPath },
    { name: "missing alias file", candidate: aliasPath, validateAlias: true, missing: true },
    { name: "alias outside WindowsApps", candidate: "C:\\Other\\chatgpt-desktop.exe" },
    { name: "alias from another package", candidate: otherAliasPath },
    { name: "missing AUMID with an alias from another package", candidate: otherAliasPath, identity: {} },
    { name: "malformed AUMID with an alias from another package", candidate: otherAliasPath,
      identity: { appUserModelId: `${packageFamilyName}!bad app` } },
    { name: "path traversal in alias", candidate: `${aliasesRoot}\\..\\WindowsApps\\${packageFamilyName}\\chatgpt-desktop.exe` },
  ];
  for (const { name, candidate, validateAlias, missing, identity = storeIdentity, expectedPath = executablePath } of cases) {
    await t.test(name, async () => {
      let probes = 0;
      const validatedPaths = [];
      const logs = [];
      const proxy = "http://127.0.0.1:8080";
      const result = await launchCodex({
        installation: {
          kind: "store",
          path: executablePath,
          ...identity,
          appExecutionAliasPath: candidate,
        },
        port: 9335,
        profileRoot,
        extraArgs: [`--proxy-server=${proxy}`],
        onLog: ({ text }) => logs.push(text),
        isEndpointReady: async () => ++probes >= 2,
        validateExecutableFn: async (file) => {
          validatedPaths.push(file);
          if (missing && file === candidate) throw Object.assign(new Error("Alias is missing"), { code: "ENOENT" });
          return file;
        },
        mkdirFn: async (directory) => assert.equal(directory, expectedProfile),
        activateStoreApp: async () => { throw new Error("COM unavailable"); },
        spawnImpl: (file, args, { env }) => {
          assert.equal(file, expectedPath);
          assert.ok(args.includes(`--user-data-dir=${expectedProfile}`));
          assert.ok(args.includes("--remote-debugging-port=9335"));
          assert.ok(args.includes(`--proxy-server=${proxy}`));
          assert.equal(env.HTTPS_PROXY, proxy);
          assert.ok(env.NO_PROXY.split(",").includes("127.0.0.1"));
          return { pid: 9002, unref() {}, kill() {} };
        },
      });

      assert.deepEqual(validatedPaths, validateAlias ? [executablePath, candidate] : [executablePath]);
      assert.equal(result.profilePath, expectedProfile);
      assert.equal(result.processId, 9002);
      assert.ok(logs.some((message) => message.includes(expectedPath)));
    });
  }
});

test("launchCodex handles cancellation when the Store helper returns a PID", async (t) => {
  for (const createdNew of [true, false]) {
    await t.test(`createdNew: ${createdNew}`, async () => {
      const controller = new AbortController();
      const killed = [];
      const processId = 7777;
      await assert.rejects(launchCodex({
        installation: {
          kind: "store",
          path: "C:/fixture/ChatGPT.exe",
          appUserModelId: "OpenAI.Codex_2p2nqsd0c76g0!App",
        },
        port: 9335,
        profileRoot: "C:/fixture/profiles",
        signal: controller.signal,
        isEndpointReady: async () => false,
        validateExecutableFn: async (file) => file,
        mkdirFn: async () => {},
        activateStoreApp: (options) => activateStoreCodex({
          ...options,
          runWinHelper: async () => {
            controller.abort();
            return { stdout: JSON.stringify({ processId, createdNew }) };
          },
          processRunner: async () => assert.fail("PowerShell must not run after helper success"),
        }),
        spawnImpl: () => assert.fail("Direct spawn must not run after helper success"),
        killProcessFn: (pid) => killed.push(pid),
      }), { name: "AbortError" });
      assert.deepEqual(killed, createdNew ? [processId] : []);
    });
  }
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
    activateStoreApp: async () => ({ processId: 7777, createdNew: true }),
    killProcessFn: (pid) => { killed.push(pid); },
  }), { name: "AbortError" });
  assert.deepEqual(killed, [7777]);
});

test("launchCodex never kills a pre-existing Store Codex process returned by ActivateApplication", async () => {
  const killed = [];
  await assert.rejects(launchCodex({
    installation: {
      kind: "store",
      path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe",
      appUserModelId: "OpenAI.Codex_2p2nqsd0c76g0!App",
      isRunning: false,
    },
    port: 9335,
    profileRoot: "C:\\Profiles",
    isEndpointReady: async () => false,
    validateExecutableFn: async (value) => value,
    mkdirFn: async () => {},
    activateStoreApp: async () => ({ processId: 8888, createdNew: false }),
    killProcessFn: (pid) => { killed.push(pid); },
  }), /已在普通模式运行/);
  assert.deepEqual(killed, []);
});
