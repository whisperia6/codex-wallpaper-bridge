import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { applySceneRenderCompletionOverlay, SCENE_RENDERER_ASSET } from '../bridge-runtime/src/scene-render-overlay.mjs';

test('runtime overlay adds exactly one acknowledgement after input reset and next-frame scheduling without changing vendored bytes', async () => {
  const file = new URL('../bridge-runtime/vendor/webwallgl/' + SCENE_RENDERER_ASSET, import.meta.url);
  const original = await readFile(file), saved = Buffer.from(original), patched = applySceneRenderCompletionOverlay(original);
  const insertion = '\n            globalThis.__cwbSceneRenderComplete?.();';
  assert.equal(patched.toString().split(insertion).length, 2);
  const text = patched.toString(), index = text.indexOf(insertion);
  assert.ok(text.slice(index - 350, index).includes('pointerSrc.beginFrame()'));
  assert.ok(text.slice(0, index).endsWith('if (!forced) rt.raf = requestAnimationFrame(renderLoop);'));
  assert.ok(Buffer.from(text.replace(insertion, '')).equals(original));
  assert.ok(original.equals(saved)); assert.ok((await readFile(file)).equals(saved));
  assert.equal(createHash('sha256').update(original).digest('hex'), '29b2c0e813b3e033aa1cf6bc72c290184501f2cf25f4f21ca622aef016c76cc0');
});
test('overlay refuses other versions, tampered bytes, arbitrary input and already-patched scripts', async () => {
  const original = await readFile(new URL('../bridge-runtime/vendor/webwallgl/' + SCENE_RENDERER_ASSET, import.meta.url));
  const altered = Buffer.from(original); altered[0] ^= 1;
  for (const input of [null, original.toString(), Buffer.alloc(0), altered, Buffer.concat([original, original]), applySceneRenderCompletionOverlay(original)]) {
    assert.throws(() => applySceneRenderCompletionOverlay(input), /scene_renderer_overlay_mismatch/);
  }
});
