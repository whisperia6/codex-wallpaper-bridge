import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { embeddedHostHarness as harness, embeddedTargetControls } from '../test-support/desktop-ui.mjs';
import test from 'node:test';

test('embedded target dropdown recalls ports and forwards an occupied port only if reconciliation is pending', async () => {
  const controls = embeddedTargetControls();
  const h = await harness({ controls });
  h.handlers.DOMContentLoaded();
  const occupied = { installationId: 'codex', hostType: 'codex', port: 19335 };
  const sendState = (target) => h.handlers.message({ source: h.window.parent, origin: 'cwb-desktop://shell', data: {
    channel: 'cwb-control', type: 'desktop-state', state: {
      installations: [{ id: 'codex' }, { id: 'store' }, { id: 'ag', hostType: 'antigravity' }],
      selectedId: 'codex', port: 19335, portsByHost: { codex: 19335 },
      activeInjectionTargets: [target],
    },
  } });
  sendState(occupied);
  const select = controls['#desktopInstallationSelect'], input = controls['#desktopPortInput'];
  select.value = 'ag'; select.events.change();
  assert.equal(input.value, '9336');
  assert.equal(h.messages.at(-1).type, 'target-change');
  assert.equal(h.messages.at(-1).port, 9336);
  for (const id of ['ag', 'store']) {
    select.value = id;
    input.value = '19335';
    controls['#desktopApplyButton'].events.click();
    assert.match(controls['#desktopApplyStatus'].textContent, /19335.*Codex.*不同的端口/);
    assert.equal(h.messages.some(({ type }) => type === 'desktop-request'), false);
  }
  select.value = 'codex'; select.events.change();
  assert.equal(input.value, '19335');
  sendState({ ...occupied, reconcilePending: true });
  select.value = 'ag';
  input.value = '19335';
  controls['#desktopApplyButton'].events.click();
  const request = h.messages.find(({ type }) => type === 'desktop-request');
  assert.equal(request.action, 'apply');
  assert.equal(request.payload.installationId, 'ag');
  assert.equal(request.payload.port, 19335);
});

test('theme changes notify only a UI preference, never write configuration or request an apply', async () => {
  const h = await harness();
  h.handlers['cwb-workbench-theme-change']({ detail:{theme:'light'} });
  h.handlers['cwb-workbench-theme-change']({ detail:{theme:'invalid'} });
  assert.deepEqual(h.messages.map(({ _targetOrigin, ...value }) => ({ ...value, _targetOrigin })), [{ channel:'cwb-control', type:'workbench-theme', theme:'light', _targetOrigin:'cwb-desktop://shell' }]);
  assert.equal(h.requests.length, 0);
});

test('only parent desktop state from trusted origin can restore the workbench theme', async () => {
  const h = await harness(), themes = [];
  h.window.cwbWorkbenchTheme = { restore:theme => themes.push(theme) };
  h.handlers.message({source:{},origin:'cwb-desktop://shell',data:{channel:'cwb-control',type:'desktop-state',state:{workbenchTheme:'light'}}});
  h.handlers.message({source:h.window.parent,origin:'https://evil.invalid',data:{channel:'cwb-control',type:'desktop-state',state:{workbenchTheme:'light'}}});
  h.handlers.message({source:h.window.parent,origin:'cwb-desktop://shell',data:{channel:'cwb-control',type:'desktop-state',state:{workbenchTheme:'light'}}});
  assert.deepEqual(themes, ['light']);
});

test('embedded apply handshake waits for busy library state even between HTTP polls', async () => {
  const { flush } = await harness({ saving: true });
  const result = await flush('busy');
  assert.equal(result.ok, false);
  assert.match(result.message, /超时/);
});

test('embedded apply handshake refuses a library error and allows an idle saved page', async () => {
  assert.equal((await (await harness({ error: true })).flush('error')).ok, false);
  assert.equal((await (await harness()).flush('idle')).ok, true);
});

test('actual host code tracks library POST/PUT promises but does not track status reads', async () => {
  const { window, messages, fetches } = await harness();
  const post = window.fetch('api/library/manage', { method: 'POST' });
  const put = window.fetch('api/library/jobs/id/content', { method: 'PUT' });
  const get = window.fetch('api/library/jobs/id', { method: 'GET' });
  assert.deepEqual(messages.filter((message) => message.type === 'saving').map((message) => message.pending), [1, 2]);
  fetches[0]({}); fetches[1]({}); fetches[2]({});
  await Promise.all([post, put, get]);
  assert.equal(messages.filter((message) => message.type === 'saved').length, 1);
});

test('generated embedded host remains equal to its authoritative override', async () => {
  const [runtime, override] = await Promise.all([
    readFile(new URL('../bridge-runtime/public/electron-host.js', import.meta.url), 'utf8'),
    readFile(new URL('../bridge-overrides/public/electron-host.js', import.meta.url), 'utf8'),
  ]);
  assert.equal(runtime, override);
});

test('playlist file reads block apply before POST starts and parameter/list controls mark dirty', async () => {
  const h = await harness(); h.window.__cwbPlaylistBusy = true;
  assert.equal((await h.flush('reading')).ok, false);
  h.window.__cwbPlaylistBusy = false;
  const target = new h.Element(); h.documentHandlers.input({ target });
  assert.match(target.selector, /\[data-effect\]/); assert.match(target.selector, /#playlistTools/);
  assert.ok(h.messages.some((message) => message.type === 'dirty'));
  assert.equal((await h.flush('finished')).ok, true);
  const post = h.window.fetch('api/playlists/manage', { method: 'POST' });
  assert.equal(h.messages.at(-1).type, 'saving'); h.fetches[0]({}); await post;
});

test('author File uploads preserve binary bodies and block apply/exit flush until the write settles', async () => {
  const h = await harness(), file = Object.freeze({ name: 'chosen.png', size: 123 });
  const init = { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file };
  const uploading = h.window.fetch('api/author-properties/a/file/picture?filename=chosen.png&revision=2', init);
  const reading = h.window.fetch('api/author-properties/a', { method: 'GET' });
  assert.deepEqual(h.messages.filter(message => message.type === 'saving').map(message => message.pending), [1]);
  assert.equal(h.requests[0][1], init); assert.equal(h.requests[0][1].body, file);
  assert.equal((await h.flush('upload-pending')).ok, false);
  h.fetches[0]({}); h.fetches[1]({}); await Promise.all([uploading, reading]);
  const target = new h.Element(); h.documentHandlers.change({ target }); assert.match(target.selector, /#authorPropertiesPanel/);
  assert.equal((await h.flush('upload-saved')).ok, true);
});

test('directory import busy guard blocks apply/exit even between staged uploads and the final CAS', async () => {
  const h = await harness(); h.window.__cwbAuthorPropertiesBusy = true;
  const first = h.window.fetch('api/author-properties/a/directory-file/photos?filename=a.png&revision=2', { method: 'POST', body: {} });
  h.fetches[0]({}); await first;
  assert.equal((await h.flush('between-files')).ok, false);
  const commit = h.window.fetch('api/author-properties/a/directory/photos', { method: 'POST', body: '{}' });
  assert.equal((await h.flush('committing')).ok, false);
  h.fetches[1]({}); await commit; h.window.__cwbAuthorPropertiesBusy = false;
  assert.equal((await h.flush('directory-idle')).ok, true);
});
