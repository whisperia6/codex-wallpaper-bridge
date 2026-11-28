import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import electron from 'electron';
import { buildCompatibilityRestoreScript, buildCompatibilityScript } from '../src/compatibility-script.mjs';
import { buildApplyScript, buildBootstrapScript, buildRestoreScript } from '../bridge-overrides/src/injected-renderer.mjs';

const hosts = ['codex', 'antigravity'];
const glassUpdates = {
  dark: {},
  neutral: { glassTint: 'neutral', glassOpacity: 80, glassBlur: 31, glassBorderOpacity: 45, glassSaturation: 175 },
  frost: { glassTint: 'frost', glassOpacity: 80, glassBlur: 31, glassBorderOpacity: 45, glassSaturation: 175 },
  zero: { glassOpacity: 0 },
  sidebarOff: { sidebarBlur: false },
  composerOff: { glassComposer: false },
  masterOff: { liquidGlass: false },
};

const exec = promisify(execFile);
let proof;
async function browserProof() {
  proof ??= (async () => {
    const temporaryRoot = path.resolve(os.tmpdir());
    const root = await mkdtemp(path.join(temporaryRoot, 'cwb-compat-surfaces-'));
    try {
      const input = path.join(root, 'input.json');
      await writeFile(input, JSON.stringify({
        root,
        safe: buildCompatibilityScript({ adaptive: false }),
        adaptive: buildCompatibilityScript({ adaptive: true }),
        restore: buildCompatibilityRestoreScript(),
        glass: Object.fromEntries(hosts.map(hostType => [hostType, {
          bootstrap: buildBootstrapScript({ hostType }),
          compat: buildCompatibilityScript({ hostType }),
          updates: Object.entries(glassUpdates).map(([name, effects]) => [name, buildApplyScript({ effects })]),
          restore: buildRestoreScript(),
        }])),
      }));
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const { stdout } = await exec(electron, [fileURLToPath(new URL('../scripts/compatibility-surfaces-fixture.cjs', import.meta.url)), input], {
        env, windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024,
      });
      assert.match(stdout, /CWB_COMPAT_SURFACES_OK/);
      return JSON.parse(await readFile(path.join(root, 'proof.json'), 'utf8'));
    } finally {
      assert.equal(path.dirname(path.resolve(root)), temporaryRoot);
      assert.ok(path.basename(root).startsWith('cwb-compat-surfaces-'));
      await rm(root, { recursive: true, force: true });
    }
  })();
  return proof;
}

for (const host of hosts) {
  test(`${host}: enabled liquid glass updates tint, blur, saturation and highlights in the same renderer`, async () => {
    const { fallback, dark, neutral, frost } = (await browserProof()).glass[host];
    for (const surface of ['sidebar', 'composer', 'bubble', ...(host === 'antigravity' ? ['scroll'] : [])]) {
      assert.deepEqual(fallback[surface], dark[surface], surface);
      assert.equal(dark[surface].filter, 'blur(18px) saturate(1.3)', surface);
      assert.equal(neutral[surface].filter, 'blur(31px) saturate(1.75)');
      assert.match(neutral[surface].shadow, /rgba\(255, 255, 255, 0\.45\)/);
      assert.notEqual(neutral[surface].background, dark[surface].background);
      assert.notEqual(frost[surface].background, neutral[surface].background);
    }
    assert.deepEqual(frost.root, {
      attributes: { cwbLiquidGlass: 'on', cwbSidebarBlur: 'on', cwbGlassComposer: 'on', cwbGlassTint: 'frost' },
      properties: ['0.8', '31px', '0.45', '175%', '0.44'],
    });
    if (host === 'antigravity') assert.equal(frost.cardToken, frost.composer.background);
  });

  test(`${host}: surface toggles preserve the wallpaper, native controls and portal styles through restore`, async () => {
    const { before, dark, sidebarOff, composerOff, masterOff, restored } = (await browserProof()).glass[host];
    for (const state of [sidebarOff, masterOff]) {
      assert.equal(state.sidebar.background, 'rgba(0, 0, 0, 0)');
      assert.equal(state.sidebar.filter, 'none');
      assert.equal(state.wallpaper, true);
    }
    assert.equal(sidebarOff.composer.filter, dark.composer.filter);
    assert.equal(composerOff.sidebar.filter, dark.sidebar.filter);
    for (const state of [composerOff, masterOff]) {
      for (const surface of ['composer', 'bubble']) {
        assert.equal(state[surface].filter, 'none');
        assert.equal(state[surface].background, before[surface].background);
      }
    }
    if (host === 'antigravity') assert.equal(masterOff.scroll.filter, 'none');
    for (const state of [dark, sidebarOff, composerOff, masterOff]) {
      for (const surface of ['editor', 'code', 'action', 'menu', 'dialog', 'tooltip', 'radixCard', 'baseCard']) {
        assert.deepEqual(state[surface], before[surface], surface);
      }
      assert.equal(state.focus, 'editor');
    }
    assert.deepEqual(restored, before);
    assert.deepEqual(restored.root, { attributes: {}, properties: ['', '', '', '', ''] });
  });
}

test('antigravity: standalone zero-opacity glass keeps dialog and menu tokens solid through live updates and restore', async () => {
  const { before, standalone, zero } = (await browserProof()).glass.antigravity;
  assert.equal(standalone.zero.cardToken, 'rgba(24, 27, 36, 0)');
  assert.equal(standalone.neutral.cardToken, 'rgba(49, 49, 54, 0.8)');
  const solid = {
    tokenDialog: 'rgb(31, 31, 39)',
    tokenMenu: 'rgb(31, 31, 39)',
    dialogGlass: 'rgb(31, 31, 39)',
    dialogBackground: 'rgb(20, 20, 24)',
  };
  for (const state of [standalone.zero, standalone.neutral, zero]) {
    assert.deepEqual(state.protectedTokens, solid);
  }
  assert.deepEqual(standalone.restored, before);
});

for (const theme of ['dark', 'light']) {
  test(`${theme}: plaintext-only and empty contenteditable composers keep native styling`, async () => {
    const p = (await browserProof())[theme];
    for (const id of ['composerPlaintext', 'composerEmptyEditable']) {
      const original = p.before[id];
      assert.notEqual(original.background, 'rgba(0, 0, 0, 0)');
      assert.match(original.border, /rgb\(131, 181, 255\)/);
      assert.notEqual(original.shadow, 'none');
      for (const state of [p.safe, p.adaptive, p.afterRestore.styles]) {
        assert.deepEqual(state[id], original, id);
      }
    }
    assert.notEqual(p.before.composerReadOnly.background, 'rgba(0, 0, 0, 0)');
    assert.equal(p.safe.composerReadOnly.background, 'rgba(0, 0, 0, 0)');
  });
  test(`${theme}: the focused Codex composer textarea keeps its background, border and focus shadow`, async () => {
    const p = (await browserProof())[theme];
    const input = p.before.composerInput;
    assert.equal(p.safeInputFocused, true);
    assert.notEqual(input.background, 'rgba(0, 0, 0, 0)');
    assert.match(input.border, /rgb\(131, 181, 255\)/);
    assert.notEqual(input.shadow, 'none');
    for (const state of [p.safe, p.adaptive, p.afterRestore.styles]) {
      assert.deepEqual(state.composerInput, input);
    }
  });
  test(`${theme}: long-chat footer and its opaque backing clear beyond the adaptive scan limit`, async () => {
    const p = (await browserProof())[theme];
    assert.ok(p.footerScanIndex > 3000);
    for (const surface of ['threadFooter', 'footerBacking']) {
      assert.notEqual(p.before[surface].background, 'rgba(0, 0, 0, 0)');
      for (const mode of ['safe', 'adaptive']) {
        assert.equal(p[mode][surface].background, 'rgba(0, 0, 0, 0)', `${mode}: ${surface}`);
        for (const property of ['border', 'outline', 'shadow', 'font', 'color', 'inlineStyle']) {
          assert.equal(p[mode][surface][property], p.before[surface][property], property);
        }
      }
      assert.deepEqual(p.afterRestore.styles[surface], p.before[surface]);
    }
    assert.equal(p.footerReplacement.background, 'rgba(0, 0, 0, 0)');
  });
  test(`${theme}: footer rules preserve controls, unrelated footers and dialogs`, async () => {
    const p = (await browserProof())[theme];
    for (const mode of ['safe', 'adaptive']) {
      for (const id of ['footerAction', 'unrelatedFooter', 'dialogFooter', 'dialogFooterBacking']) {
        assert.deepEqual(p[mode][id], p.before[id], `${mode}: ${id}`);
      }
    }
  });
  for (const surface of ['toolbar', 'spaceHeader']) {
    test(`${theme}: safe compatibility clears only the ${surface} background`, async () => {
      const p = (await browserProof())[theme];
      assert.notEqual(p.before[surface].background, 'rgba(0, 0, 0, 0)');
      assert.equal(p.safe[surface].background, 'rgba(0, 0, 0, 0)');
      for (const property of ['border', 'outline', 'shadow', 'font', 'color', 'inlineStyle']) {
        assert.equal(p.safe[surface][property], p.before[surface][property], property);
      }
    });
  }
  test(`${theme}: buttons, search input, editor, attachment and dialogs retain their styling`, async () => {
    const p = (await browserProof())[theme];
    for (const id of ['button', 'directButton', 'directRoleButton', 'search', 'editor', 'attachment', 'menuSurface', 'dialogSurface', 'overlap', 'unrelated']) {
      assert.deepEqual(p.safe[id], p.before[id], id);
    }
    assert.equal(p.safeInputFocused, true);
  });
  test(`${theme}: React replacement and attribute repurposing do not retain transparent backgrounds`, async () => {
    const p = (await browserProof())[theme];
    assert.equal(p.safe.legacyToolbar.background, 'rgba(0, 0, 0, 0)');
    assert.equal(p.replacement.background, p.before.composerBody.background);
    assert.equal(p.repurposed.background, p.before.composerBody.background);
    assert.equal(p.repurposed.inlineStyle, p.before.composerBody.inlineStyle);
  });
  test(`${theme}: compatibility reinjection is singular and restoration returns all original styles`, async () => {
    const p = (await browserProof())[theme];
    assert.equal(p.styleCount, 1);
    assert.equal(p.afterRestore.styleCount, 0);
    assert.equal(p.afterRestore.runtime, false);
    assert.equal(p.afterRestore.marker, false);
    for (const id of ['toolbar', 'legacyToolbar', 'spaceHeader', 'composerBody', 'button', 'directButton', 'directRoleButton', 'search', 'editor', 'attachment', 'menuSurface', 'dialogSurface']) {
      assert.deepEqual(p.afterRestore.styles[id], p.before[id], id);
    }
  });
  test(`${theme}: adaptive mode also handles narrow surfaces without mutating fonts or theme`, async () => {
    const p = (await browserProof())[theme];
    for (const id of ['toolbar', 'legacyToolbar', 'spaceHeader']) {
      assert.equal(p.adaptive[id].background, 'rgba(0, 0, 0, 0)', id);
    }
    for (const mode of ['safe', 'adaptive']) {
      assert.equal(p[mode].composerBody.background, p.before.composerBody.background, mode);
      assert.equal(p[mode].composerBody.image, p.before.composerBody.image, mode);
    }
    for (const id of ['button', 'directButton', 'directRoleButton', 'search', 'editor', 'attachment', 'menuSurface', 'dialogSurface']) {
      assert.deepEqual(p.adaptive[id], p.before[id], id);
    }
    assert.equal(p.themeUnchanged, true);
    assert.deepEqual(p.errors, []);
  });
  test(`${theme}: actual shared plugin/page header backing and inner row become transparent`, async () => {
    const p = (await browserProof())[theme];
    assert.notEqual(p.before.stickyHeader.before.background, 'rgba(0, 0, 0, 0)');
    assert.notEqual(p.before.stickyHeaderRow.background, 'rgba(0, 0, 0, 0)');
    for (const mode of ['safe', 'adaptive']) {
      assert.equal(p[mode].stickyHeader.before.background, 'rgba(0, 0, 0, 0)');
      assert.equal(p[mode].stickyHeaderRow.background, 'rgba(0, 0, 0, 0)');
    }
  });
  test(`${theme}: the actual 32px composer spacer gradient is removed in both modes`, async () => {
    const p = (await browserProof())[theme];
    assert.match(p.before.composerFade.image, /linear-gradient/);
    assert.equal(p.safe.composerFade.image, 'none');
    assert.equal(p.adaptive.composerFade.image, 'none');
  });
  test(`${theme}: ordinary gradients, unrelated sticky content, dialogs and plugin actions stay intact`, async () => {
    const p = (await browserProof())[theme];
    for (const mode of ['safe', 'adaptive']) {
      for (const id of ['contentGradient', 'unrelatedSticky', 'dialogStickyHeader', 'pluginAction']) {
        assert.deepEqual(p[mode][id], p.before[id], `${mode}: ${id}`);
      }
    }
  });
  test(`${theme}: restoration also brings back the native sticky pseudo-background and composer fade`, async () => {
    const p = (await browserProof())[theme];
    for (const id of ['stickyHeader', 'stickyHeaderRow', 'composerFade', 'dialogStickyHeader']) {
      assert.deepEqual(p.afterRestore.styles[id], p.before[id], id);
    }
  });
}
