import { createHash } from 'node:crypto';

export const SCENE_RENDERER_ASSET = 'webwallgl.mjs';
const PINNED_SHA256 = '29b2c0e813b3e033aa1cf6bc72c290184501f2cf25f4f21ca622aef016c76cc0';
const COMPLETE = '            if (!forced) rt.raf = requestAnimationFrame(renderLoop);';
const ACK = '\n            globalThis.__cwbSceneRenderComplete?.();';

/** WebWallGL exposes first-frame readiness, but no per-frame input ACK.
 * The exact 3.1.0 ESM build has a named completion point after cursor dispatch,
 * input reset and text updates. The ACK does not prove pixels were presented.
 */
export function applySceneRenderCompletionOverlay(bytes) {
  if (!Buffer.isBuffer(bytes) || createHash('sha256').update(bytes).digest('hex') !== PINNED_SHA256) {
    throw Error('scene_renderer_overlay_mismatch');
  }
  const source = bytes.toString('utf8'), first = source.indexOf(COMPLETE);
  if (first < 0 || source.indexOf(COMPLETE, first + COMPLETE.length) !== -1) throw Error('scene_renderer_overlay_mismatch');
  const end = first + COMPLETE.length;
  return Buffer.from(source.slice(0, end) + ACK + source.slice(end));
}
