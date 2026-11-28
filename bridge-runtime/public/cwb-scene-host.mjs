// Keep the bridge alive even when the engine module fails to load.
import('/wallpaper-engine/scene-live/webwallgl.mjs').then(
  engine => window.__cwbStartScene?.(engine),
  () => window.__cwbStartScene?.(null),
);
