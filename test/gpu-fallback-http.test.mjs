import assert from 'node:assert/strict';
import { mkdtemp, open, writeFile, rm } from 'node:fs/promises';
import { get } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMediaServer } from '../bridge-runtime/src/media-server.mjs';

function packageBytes(files) {
  const magic = Buffer.from('PKGV0001'), header = Buffer.alloc(4 + magic.length + 4);
  header.writeUInt32LE(magic.length); magic.copy(header, 4); header.writeUInt32LE(files.length, 4 + magic.length);
  let offset = 0; const table = [], data = [];
  for (const [name, value] of files) {
    const bytes = Buffer.from(value), text = Buffer.from(name), entry = Buffer.alloc(4 + text.length + 8);
    entry.writeUInt32LE(text.length); text.copy(entry, 4); entry.writeUInt32LE(offset, 4 + text.length);
    entry.writeUInt32LE(bytes.length, 8 + text.length); offset += bytes.length; table.push(entry); data.push(bytes);
  }
  return Buffer.concat([header, ...table, ...data]);
}

test('package-video fallback streams only a bounded validated MP4/WebM extent, including suffix/HEAD/416 and changed package rejection', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-pkg-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'scene.pkg');
  await writeFile(file, packageBytes([['scene.json', '{}'], ['materials/clip.mp4', '0123456789'], ['private.json', 'secret']]));
  const server = createMediaServer({ projects: [{ id: 'pkg', type: 'scene', rootPath: root }] });
  await server.start(); t.after(() => server.close());
  const url = new URL('api/embedded-video/pkg', server.baseUrl);
  const suffix = await fetch(url, { headers: { Range: 'bytes=-3' } });
  assert.equal(suffix.status, 206); assert.equal(await suffix.text(), '789');
  assert.equal(suffix.headers.get('content-range'), 'bytes 7-9/10'); assert.equal(suffix.headers.get('content-type'), 'video/mp4');
  assert.equal((await fetch(url, { method: 'HEAD' })).headers.get('content-length'), '10');
  assert.equal((await fetch(url, { headers: { Range: 'bytes=10-' } })).status, 416);
  assert.equal(await (await fetch(url)).text(), '0123456789');
  await writeFile(file, packageBytes([['scene.json', '{}'], ['materials/clip.webm', 'webm-data']]));
  const webm = await fetch(url, { headers: { Range: 'bytes=0-3' } });
  assert.equal(webm.status, 206);
  assert.equal(webm.headers.get('content-type'), 'video/webm');
  assert.equal(await webm.text(), 'webm');
  await writeFile(file, packageBytes([['../scene.json', '{}'], ['clip.mp4', 'wrong']]));
  assert.equal((await fetch(url)).status, 404);
});

test('embedded-video fallback serves only registered eligible project-contained videos with Range', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-gpu-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'clip.mp4'); await writeFile(file, Buffer.from('0123456789'));
  const server = createMediaServer({ projects: [
    { id: 'scene', type: 'scene', rootPath: root, embeddedVideoPath: file },
    { id: 'escape', type: 'scene', rootPath: root, embeddedVideoPath: path.join(root, '..', 'secret.mp4') },
    { id: 'script', type: 'scene', rootPath: root, embeddedVideoPath: path.join(root, 'script.js') },
    { id: 'wrong', type: 'web', rootPath: root, embeddedVideoPath: file },
  ] });
  await server.start(); t.after(() => server.close());
  const response = await fetch(new URL('api/embedded-video/scene', server.baseUrl), { headers: { Range: 'bytes=2-5' } });
  assert.equal(response.status, 206); assert.equal(await response.text(), '2345');
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
  for (const id of ['escape', 'script', 'wrong', 'unknown']) assert.equal((await fetch(new URL('api/embedded-video/' + id, server.baseUrl))).status, 404);
  assert.equal((await fetch(new URL('api/embedded-video/scene', server.baseUrl), { method: 'POST' })).status, 405);
});

test('disconnect while reading the package index closes the handle before creating a stream', { timeout: 5000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-pkg-disconnect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'scene.pkg');
  await writeFile(file, packageBytes([['scene.json', '{}'], ['clip.mp4', 'video']]));
  const probe = await open(file);
  const handlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const server = createMediaServer({ projects: [{ id: 'pkg', type: 'scene', rootPath: root }] });
  await server.start();
  t.after(() => server.close());

  const opened = Promise.withResolvers();
  const resumeIndex = Promise.withResolvers();
  const originalRead = handlePrototype.read;
  t.mock.method(handlePrototype, 'read', async function (...args) {
    opened.resolve(this);
    await resumeIndex.promise;
    return originalRead.apply(this, args);
  });
  const req = get(new URL('api/embedded-video/pkg', server.baseUrl));
  req.on('error', () => {});
  try {
    const handle = await opened.promise;
    const closedOrStreamed = Promise.withResolvers();
    handle.once('close', () => closedOrStreamed.resolve('closed'));
    t.after(() => handle.close());
    const originalCreateReadStream = handle.createReadStream;
    t.mock.method(handle, 'createReadStream', (...args) => {
      closedOrStreamed.resolve('streamed');
      return originalCreateReadStream.apply(handle, args);
    });
    const disconnected = new Promise((resolve) => req.once('close', resolve));
    req.destroy();
    await disconnected;
    await server.close();
    resumeIndex.resolve();
    assert.equal(await closedOrStreamed.promise, 'closed');
    assert.equal(handle.fd, -1);
  } finally {
    resumeIndex.resolve();
    req.destroy();
  }
});
