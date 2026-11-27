import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConfigStore } from '../bridge-runtime/src/config-store.mjs';
import { createMediaServer } from '../bridge-runtime/src/media-server.mjs';
import { buildInjectionPlan } from '../bridge-overrides/src/injection-plan.mjs';
import { invokeBridgeAction } from '../src/bridge-runner.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZ8AAAAASUVORK5CYII=', 'base64');

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-library-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ConfigStore({ filePath: path.join(root, 'config.json') });
  await store.load();
  const original = path.join(root, 'WE-original.png');
  await writeFile(original, png);
  const server = createMediaServer({ configStore: store, projects: [{ id: 'we', title: 'WE 原图', type: 'image', source: 'workshop',
    playable: true, mediaPath: original, previewPath: original, rootPath: root, metadata: { contentRating: 'Everyone' } }], ...options });
  await server.start();
  t.after(() => server.close());
  const api = async (route, body, method = 'POST', headers = {}) => {
    const response = await fetch(new URL(`api/${route}`, server.baseUrl), { method,
      headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { error: text }; }
    return { status: response.status, ...payload };
  };
  const upload = async () => {
    const created = await api('library/jobs', { kind: 'import', filename: 'my.png', size: png.length, rating: 'pg13' });
    assert.equal(created.status, 202);
    const response = await fetch(new URL(`api/library/jobs/${created.job.id}/content`, server.baseUrl), {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: png });
    const result = await response.json();
    assert.equal(result.job.status, 'completed', result.job.error);
    return result.job.result.assetId;
  };
  return { root, store, server, api, upload, original };
}

test('image import -> inventory -> bounded injection -> token-scoped Range -> remove', async (t) => {
  const { server, store, api, upload, original } = await fixture(t);
  const id = await upload();
  const inventory = await api('inventory', undefined, 'GET');
  const image = inventory.projects.find((project) => project.id === id);
  assert.equal(image.type, 'image');
  assert.equal(image.source, 'imported');
  assert.equal(image.contentRating, 'pg13');
  assert.equal(image.eligible, true);
  assert.equal(inventory.stats.byType.image, 2);
  assert.doesNotMatch(JSON.stringify(inventory), /rootPath|mediaPath|fileName|WE-original/);
  await api('config', { selectedId: id });
  const plan = buildInjectionPlan({ server, config: store.get(), inventory });
  assert.equal(plan.metrics.wallpaperType, 'image');
  assert.ok(plan.metrics.applyBytes < 10 * 1024);
  assert.doesNotMatch(plan.applyScript, /assets|directory|fileName/);
  const media = await fetch(new URL(image.mediaUrl, server.origin), { headers: { Range: 'bytes=0-7' } });
  assert.equal(media.status, 206);
  assert.equal(media.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), png.subarray(0, 8));
  assert.equal((await fetch(new URL(image.mediaUrl.replace(server.basePath, '/wrong-token'), server.origin))).status, 404);
  assert.equal((await api('library/manage', { action: 'remove', ids: ['we'] })).status, 400);
  assert.equal((await api('library/manage', { action: 'remove', ids: [id] })).ok, true);
  assert.deepEqual(await readFile(original), png);
  assert.equal(store.get().selectedId, 'we');
});

test('busy library explicitly rejects inject before the bridge action handler runs', async (t) => {
  const handled = [];
  const { server, store, upload } = await fixture(t, { onAction: async (action) => {
    handled.push(action);
    return { ok: true, registeredHosts: [] };
  } });
  let committing, finish;
  const started = new Promise((resolve) => { committing = resolve; });
  const commit = new Promise((resolve) => { finish = resolve; });
  const set = store.set.bind(store);
  store.set = async (...args) => { committing(); await commit; return set(...args); };
  const uploading = upload();
  await Promise.race([started, uploading]);
  const invoke = (action) => invokeBridgeAction({ controlUrl: server.baseUrl, action });
  try {
    await assert.rejects(invoke('inject'), (error) => error.statusCode === 409 && error.notExecuted === true && !error.registeredHosts);
    assert.deepEqual(handled, []);
  } finally {
    finish();
    await uploading;
  }
  assert.deepEqual((await invoke('injection-status')).registeredHosts, []);
  assert.deepEqual(handled, ['injection-status']);
});

test('hide/restore/rating/policy reconcile selection and exclude all blocked media paths', async (t) => {
  const changes = [];
  const { server, store, api, upload } = await fixture(t, { onConfigChange: async (config) => changes.push(config) });
  const id = await upload();
  await api('config', { selectedId: id });
  const hidden = await api('library/manage', { action: 'hide', ids: [id, 'we'] });
  assert.equal(hidden.config.selectedId, null);
  const inventory = await api('inventory', undefined, 'GET');
  assert.equal(inventory.stats.hidden, 2);
  assert.equal(inventory.stats.eligible, 0);
  assert.equal(buildInjectionPlan({ server, config: store.get(), inventory }).metrics.wallpaperId, null);
  assert.equal((await api('config', { selectedId: id })).status, 409);
  const image = inventory.projects.find((project) => project.id === id);
  assert.equal((await fetch(new URL(image.mediaUrl, server.origin))).status, 404);
  assert.equal((await fetch(new URL(image.previewUrl, server.origin))).status, 200);
  await api('library/manage', { action: 'restore', ids: [id] });
  await api('library/manage', { action: 'rating', ids: [id], rating: 'mature' });
  const restricted = await api('config', { library: { allowedRatings: ['everyone'] } });
  assert.equal(restricted.config.selectedId, null);
  assert.equal((await fetch(new URL(image.previewUrl, server.origin))).status, 404);
  await api('library/manage', { action: 'restore-all' });
  assert.equal(store.get().selectedId, 'we');
  assert.ok(changes.length >= 5);
  assert.deepEqual(store.get().library.allowedRatings, ['everyone']);
});

test('API cannot forge resource index/path/hidden metadata; cross-origin writes have no side effects', async (t) => {
  const { store, api, upload } = await fixture(t);
  await upload();
  const before = store.get();
  for (const library of [{ assets: [] }, { directory: 'C:\\Windows' }, { hiddenIds: ['we'] },
    { allowedRatings: ['invalid'] }, [], null]) {
    assert.equal((await api('config', { library })).status, 400);
    assert.deepEqual(store.get(), before);
  }
  assert.equal((await api('library/manage', { action: 'hide', ids: ['missing'] })).status, 400);
  assert.equal((await api('library/manage', { action: 'hide', ids: ['we'] }, 'POST', { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await api('config', { selectedId: 'we' }, 'POST', { Origin: 'null' })).status, 403);
  assert.deepEqual(store.get(), before);
});

test('job status/cancel and invalid content methods are explicit, with immutable terminal state', async (t) => {
  const { api, server } = await fixture(t);
  const { job } = await api('library/jobs', { kind: 'import', filename: 'x.png', size: png.length });
  assert.equal((await api(`library/jobs/${job.id}`, undefined, 'GET')).job.status, 'queued');
  assert.equal((await api(`library/jobs/${job.id}/content`, undefined, 'GET')).status, 405);
  assert.equal((await api(`library/jobs/${job.id}/content`, {}, 'PUT')).status, 415);
  assert.equal((await api(`library/jobs/${job.id}/cancel`, {})).job.status, 'cancelled');
  const response = await fetch(new URL(`api/library/jobs/${job.id}/content`, server.baseUrl), {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: png });
  assert.equal(response.status, 409);
  assert.equal((await api(`library/jobs/${job.id}`, undefined, 'GET')).job.status, 'cancelled');
});

test('host-sync failure reports persisted metadata instead of claiming rollback', async (t) => {
  const { api, store } = await fixture(t, { onConfigChange: async () => { throw new Error('private host failure'); } });
  const result = await api('library/manage', { action: 'hide', ids: ['we'] });
  assert.equal(result.status, 502);
  assert.equal(result.saved, true);
  assert.deepEqual(store.get().library.hiddenIds, ['we']);
  assert.doesNotMatch(JSON.stringify(result), /private host failure/);
});
