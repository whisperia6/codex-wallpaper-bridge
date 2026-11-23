(() => {
  "use strict";

  const KEY = "cwb.workbench.theme";
  const valid = value => value === "dark" || value === "light";
  let current = "dark";
  let chosenLocally = false;

  function apply(value, notify = false) {
    if (!valid(value)) return;
    if (notify) chosenLocally = true;
    const changed = value !== current;
    current = value;
    document.documentElement.dataset.workbenchTheme = value;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", value);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", value === "light" ? "#f4f5f7" : "#0c0d10");
    for (const button of document.querySelectorAll("[data-theme-choice]")) {
      button.setAttribute("aria-pressed", String(button.dataset.themeChoice === value));
    }
    try { window.localStorage.setItem(KEY, value); } catch { /* Storage can be disabled; switching still works. */ }
    if (changed && notify) window.dispatchEvent(new CustomEvent("cwb-workbench-theme-change", { detail: { theme: value } }));
  }

  let saved;
  try { saved = window.localStorage.getItem(KEY); } catch { /* Use the default without requiring storage access. */ }
  // The desktop shell has a stable origin; its preference survives a bridge restart/port change.
  const initial = new URL(window.location.href).searchParams.get("workbenchTheme");
  apply(valid(initial) ? initial : valid(saved) ? saved : "dark");
  window.cwbWorkbenchTheme = Object.freeze({ current: () => current,
    // A delayed desktop-state acknowledgement must not undo an explicit button click.
    restore: value => { if (!chosenLocally) apply(value); } });

  document.addEventListener("DOMContentLoaded", () => {
    for (const button of document.querySelectorAll("[data-theme-choice]")) {
      button.addEventListener("click", () => apply(button.dataset.themeChoice, true));
    }
    apply(current);
  }, { once: true });
  window.addEventListener("storage", event => {
    if (event.key === KEY && (event.newValue === null || valid(event.newValue))) apply(event.newValue || "dark");
  });
})();
