import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMediaServer } from '../bridge-runtime/src/media-server.mjs';

test('playlist HTTP CRUD rejects forged config/unknown items and lightweight polling excludes library', async (t) => {
  const server = createMediaServer({ projects: [{ id: 'a', type: 'image', playable: true }], onAction: async () => ({ ok: true }) });
  await server.start(); t.after(() => server.close());
  const post = (route, body, headers = {}) => fetch(new URL(route, server.baseUrl), { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('api/config', { playlists: { items: [] } })).status, 400);
  assert.equal((await post('api/playlists/manage', { action: 'create', name: 'x', ids: ['unknown'] })).status, 400);
  assert.equal((await post('api/playlists/manage', { action: 'create', name: 'x', ids: ['a'] }, { Origin: 'https://evil.test' })).status, 403);
  const created = await (await post('api/playlists/manage', { action: 'create', name: '<script>not code</script>', ids: ['a'] })).json();
  assert.equal(created.config.playlists.items.length, 1);
  const id = created.config.playlists.items[0].id;
  assert.equal((await post('api/playlists/manage', { action: 'update', id, name: 'renamed' })).status, 200);
  const state = await (await fetch(new URL('api/playlists?state=1', server.baseUrl))).json();
  assert.equal(Object.hasOwn(state.config, 'library'), false);
  assert.equal(Object.hasOwn(state.config, 'playlists'), false);
  assert.equal((await post('api/playlists/manage', { action: 'delete', id })).status, 200);
  const result = await (await fetch(new URL('api/playlists', server.baseUrl))).json();
  assert.deepEqual(result.config.playlists.items, []);
});

test('automatic rotation survives partial restore and stops after the last host restores', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-playlist-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.png'), Buffer.from([137, 80, 78, 71]));
  const selected = [];
  let anotherHostActive = true;
  const server = createMediaServer({ projects: ['a', 'b'].map((id) => ({ id, type: 'image', rootPath: root, mediaPath: path.join(root, 'a.png'), playable: true })),
    onConfigChange: async (config) => selected.push(config.selectedId), onAction: async () => ({ ok: true, injectorActive: anotherHostActive }) });
  await server.start(); t.after(() => server.close());
  const post = async (route, body) => { const r = await fetch(new URL(route, server.baseUrl), { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.status, 200); return r.json(); };
  await post('api/config', { selectedId: 'a' });
  const created = await post('api/playlists/manage', { action: 'create', name: 'rotate', ids: ['a', 'b'] });
  await post('api/playlists/manage', { action: 'settings', activeId: created.config.playlists.items[0].id, enabled: true, intervalSeconds: 5 });
  const until = Date.now() + 7500;
  while (!selected.includes('b') && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  assert.ok(selected.includes('b'));
  assert.equal((await post('api/action', { action: 'restore' })).injectorActive, true);
  const partial = await (await fetch(new URL('api/playlists', server.baseUrl))).json();
  assert.equal(partial.config.playlists.enabled, true);
  anotherHostActive = false;
  assert.equal((await post('api/action', { action: 'restore' })).injectorActive, false);
  const result = await (await fetch(new URL('api/playlists', server.baseUrl))).json();
  assert.equal(result.config.playlists.enabled, false);
  assert.equal(result.status.state, 'stopped');
});

test('preview failure feedback skips the selected candidate and rejects stale or forged reports', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-playlist-feedback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'fixture.png'), 'invalid but present');
  const server = createMediaServer({ projects: ['a', 'bad', 'b'].map((id) => ({ id, type: 'image',
    rootPath: root, mediaPath: path.join(root, 'fixture.png'), playable: true })) });
  await server.start(); t.after(() => server.close());
  const post = (route, body, headers = {}) => fetch(new URL(route, server.baseUrl), { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  await post('api/config', { selectedId: 'a' });
  const created = await (await post('api/playlists/manage', { action: 'create', name: 'feedback', ids: ['a', 'bad', 'b'] })).json();
  await post('api/playlists/manage', { action: 'settings', activeId: created.config.playlists.items[0].id });
  const next = await (await post('api/playlists/next', {})).json();
  assert.equal(next.config.selectedId, 'bad');
  const body = { selectedId: 'bad', revision: next.revision };
  assert.equal((await post('api/playlists/failed', body, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await post('api/playlists/failed', { ...body, selectedId: 'unknown' })).status, 409);
  const result = await (await post('api/playlists/failed', body)).json();
  assert.equal(result.config.selectedId, 'b');
  assert.ok(result.status.failedIds.includes('bad'));
  assert.equal((await post('api/playlists/failed', body)).status, 409);
  await post('api/playlists/manage', { action: 'retry' });
  await post('api/config', { selectedId: 'a' });
  const again = await (await post('api/playlists/next', {})).json();
  await post('api/config', { selectedId: 'b' });
  await post('api/config', { selectedId: 'bad' }); // ABA: same ID, newer selection.
  assert.equal((await post('api/playlists/failed', { selectedId: 'bad', revision: again.revision })).status, 409);
  assert.equal((await (await fetch(new URL('api/playlists?state=1', server.baseUrl))).json()).config.selectedId, 'bad');
});
