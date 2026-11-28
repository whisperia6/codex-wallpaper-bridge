export const DEFAULT_GLASS_EFFECTS = Object.freeze({
  liquidGlass: true,
  glassOpacity: 62,
  glassBlur: 18,
  glassBorderOpacity: 12,
  glassSaturation: 130,
  glassTint: "dark",
  glassComposer: true,
  sidebarBlur: true,
});

// Serialized into the host bootstrap. Keep runtime dependencies in parameters.
export function normalizeLiquidGlass(value, fallback, defaults = fallback) {
  const valid = (input) => typeof input === "number" && Number.isFinite(input);
  const number = (key, min, max) => {
    const next = valid(value[key]) ? value[key] : valid(defaults[key]) ? defaults[key] : fallback[key];
    return Math.min(max, Math.max(min, next));
  };
  const boolean = (key) => typeof value[key] === "boolean" ? value[key]
    : typeof defaults[key] === "boolean" ? defaults[key] : fallback[key];
  const tints = ["dark", "neutral", "frost"];
  return {
    liquidGlass: boolean("liquidGlass"),
    glassOpacity: number("glassOpacity", 0, 100),
    glassBlur: number("glassBlur", 0, 60),
    glassBorderOpacity: number("glassBorderOpacity", 0, 100),
    glassSaturation: number("glassSaturation", 100, 220),
    glassTint: [value.glassTint, defaults.glassTint, fallback.glassTint].find(tint => tints.includes(tint)),
    glassComposer: boolean("glassComposer"),
    sidebarBlur: boolean("sidebarBlur"),
  };
}
