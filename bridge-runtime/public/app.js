(() => {
  "use strict";

  const DEFAULT_EFFECTS = Object.freeze({
    brightness: 72,
    darkness: 22,
    blur: 0,
    saturation: 100,
    fit: "cover",
    playing: true,
  });

  const TYPE_LABELS = {
    video: "VIDEO",
    web: "WEB",
    scene: "SCENE",
    image: "IMAGE",
    application: "APP",
    unknown: "OTHER",
  };

  const state = {
    inventory: [],
    stats: {},
    config: {},
    selectedId: null,
    effects: { ...DEFAULT_EFFECTS },
    filter: "all",
    query: "",
    connected: false,
    injected: false,
    loading: true,
    mediaRevision: 0,
    saveRevision: 0,
    saveTimer: null,
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  const elements = {
    root: document.documentElement,
    backgroundImage: $("#backgroundImage"),
    backgroundVideo: $("#backgroundVideo"),
    backgroundWeb: $("#backgroundWeb"),
    backgroundPlaceholder: $("#backgroundPlaceholder"),
    wallpaperList: $("#wallpaperList"),
    wallpaperTemplate: $("#wallpaperCardTemplate"),
    emptyState: $("#emptyState"),
    emptyMessage: $("#emptyMessage"),
    librarySummary: $("#librarySummary"),
    sourcePath: $("#sourcePath"),
    searchInput: $("#searchInput"),
    typeFilters: $("#typeFilters"),
    connectionStatus: $("#connectionStatus"),
    statusTitle: $("#statusTitle"),
    statusDetail: $("#statusDetail"),
    refreshLibraryButton: $("#refreshLibraryButton"),
    emptyRescanButton: $("#emptyRescanButton"),
    rescanButton: $("#rescanButton"),
    restoreButton: $("#restoreButton"),
    injectButton: $("#injectButton"),
    welcomeCard: $("#welcomeCard"),
    nowPlaying: $("#nowPlaying"),
    playButton: $("#playButton"),
    currentWallpaperTitle: $("#currentWallpaperTitle"),
    currentWallpaperType: $("#currentWallpaperType"),
    previewStateText: $("#previewStateText"),
    brightnessRange: $("#brightnessRange"),
    darknessRange: $("#darknessRange"),
    blurRange: $("#blurRange"),
    saturationRange: $("#saturationRange"),
    brightnessValue: $("#brightnessValue"),
    darknessValue: $("#darknessValue"),
    blurValue: $("#blurValue"),
    saturationValue: $("#saturationValue"),
    fitSelect: $("#fitSelect"),
    playbackToggle: $("#playbackToggle"),
    resetEffectsButton: $("#resetEffectsButton"),
    saveIndicator: $("#saveIndicator"),
    errorBanner: $("#errorBanner"),
    errorTitle: $("#errorTitle"),
    errorMessage: $("#errorMessage"),
    retryButton: $("#retryButton"),
    dismissErrorButton: $("#dismissErrorButton"),
    toastRegion: $("#toastRegion"),
    openHelpButton: $("#openHelpButton"),
    helpDialog: $("#helpDialog"),
  };

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function normalizeType(value) {
    const type = String(value || "unknown").trim().toLowerCase();
    if (type.includes("video")) return "video";
    if (type.includes("web") || type.includes("html")) return "web";
    if (type.includes("scene")) return "scene";
    if (type.includes("image") || type.includes("picture")) return "image";
    if (type.includes("app")) return "application";
    return type || "unknown";
  }

  function normalizeProject(project, index) {
    const raw = project && typeof project === "object" ? project : {};
    const id = raw.id ?? raw.projectId ?? raw.workshopId ?? raw.path ?? `wallpaper-${index}`;
    const type = normalizeType(raw.type ?? raw.projectType ?? raw.kind);
    const previewUrl = raw.previewUrl ?? raw.thumbnailUrl ?? raw.preview ?? raw.thumbnail ?? "";
    const mediaUrl = raw.mediaUrl ?? raw.videoUrl ?? raw.fileUrl ?? "";
    const webUrl = raw.webUrl ?? raw.pageUrl ?? raw.entryUrl ?? "";
    const explicitPlayable = raw.playable ?? raw.supportsLive ?? raw.live;

    return {
      ...raw,
      id: String(id),
      title: String(raw.title ?? raw.name ?? raw.displayName ?? `未命名壁纸 ${index + 1}`),
      type,
      previewUrl: String(previewUrl || ""),
      mediaUrl: String(mediaUrl || ""),
      webUrl: String(webUrl || ""),
      playable: explicitPlayable == null
        ? Boolean(webUrl || mediaUrl || type === "video")
        : Boolean(explicitPlayable),
    };
  }

  function extractInventory(payload) {
    if (Array.isArray(payload)) return { projects: payload, stats: {} };
    if (!payload || typeof payload !== "object") return { projects: [], stats: {} };
    const nested = payload.data && typeof payload.data === "object" ? payload.data : payload;
    const projects = nested.projects ?? nested.items ?? nested.inventory ?? nested.wallpapers ?? [];
    const stats = nested.stats ?? nested.summary ?? {};
    return { projects: Array.isArray(projects) ? projects : [], stats };
  }

  function percentLike(value, fallback, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    // Accept legacy fractional configs while treating current integer values as percentages.
    if (numeric >= 0 && numeric <= 2 && !Number.isInteger(numeric)) return clamp(numeric * 100, 0, max, fallback);
    return clamp(numeric, 0, max, fallback);
  }

  function normalizeEffects(effects = {}) {
    const raw = effects && typeof effects === "object" ? effects : {};
    const fit = ["cover", "contain", "fill"].includes(raw.fit) ? raw.fit : DEFAULT_EFFECTS.fit;
    return {
      brightness: Math.round(percentLike(raw.brightness, DEFAULT_EFFECTS.brightness, 150)),
      darkness: Math.round(percentLike(raw.darkness ?? raw.dim ?? raw.overlay, DEFAULT_EFFECTS.darkness, 85)),
      blur: Math.round(clamp(raw.blur ?? raw.blurPx, 0, 30, DEFAULT_EFFECTS.blur)),
      saturation: Math.round(percentLike(raw.saturation, DEFAULT_EFFECTS.saturation, 180)),
      fit,
      playing: raw.playing ?? raw.autoplay ?? raw.playback ?? DEFAULT_EFFECTS.playing,
    };
  }

  function extractConfig(payload) {
    if (!payload || typeof payload !== "object") return {};
    const nested = payload.data && typeof payload.data === "object" ? payload.data : payload;
    return nested.config && typeof nested.config === "object" ? nested.config : nested;
  }

  async function api(path, options = {}) {
    const request = {
      cache: "no-store",
      credentials: "same-origin",
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    };

    let response;
    try {
      response = await fetch(`api/${path}`, request);
    } catch (error) {
      throw new Error("无法连接本地桥接服务，请确认程序仍在运行。", { cause: error });
    }

    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text };
      }
    }

    if (!response.ok) {
      const message = payload?.message ?? payload?.error?.message ?? payload?.error ?? `请求失败（HTTP ${response.status}）`;
      throw new Error(String(message));
    }
    return payload;
  }

  function setConnection(stateName, title, detail) {
    elements.connectionStatus.dataset.state = stateName;
    elements.statusTitle.textContent = title;
    elements.statusDetail.textContent = detail;
  }

  function setBusy(button, busy) {
    if (!button) return;
    button.disabled = busy;
    button.classList.toggle("is-busy", busy);
    button.setAttribute("aria-busy", String(busy));
  }

  function setSaveState(mode, text) {
    elements.saveIndicator.classList.toggle("is-saving", mode === "saving");
    elements.saveIndicator.classList.toggle("is-error", mode === "error");
    elements.saveIndicator.lastChild.textContent = text;
  }

  function showError(title, message) {
    elements.errorTitle.textContent = title;
    elements.errorMessage.textContent = message;
    elements.errorBanner.hidden = false;
  }

  function hideError() {
    elements.errorBanner.hidden = true;
  }

  function toast(message, type = "success") {
    const node = document.createElement("div");
    node.className = `toast${type === "error" ? " is-error" : ""}`;
    node.textContent = message;
    elements.toastRegion.append(node);
    window.setTimeout(() => {
      node.classList.add("is-leaving");
      window.setTimeout(() => node.remove(), 200);
    }, 2800);
  }

  function responseMessage(payload, fallback) {
    return String(payload?.message ?? payload?.data?.message ?? fallback);
  }

  function currentProject() {
    return state.inventory.find((project) => project.id === state.selectedId) ?? null;
  }

  function typeLabel(type) {
    return TYPE_LABELS[type] ?? String(type || "OTHER").toUpperCase();
  }

  function isProjectPlayable(project) {
    return Boolean(project && project.playable && (project.mediaUrl || project.webUrl));
  }

  function updateLibrarySummary(filteredCount = null) {
    const total = state.inventory.length;
    if (state.loading) {
      elements.librarySummary.textContent = "正在连接 Wallpaper Engine…";
      return;
    }
    if (filteredCount != null && filteredCount !== total) {
      elements.librarySummary.textContent = `显示 ${filteredCount} / ${total} 张壁纸`;
      return;
    }

    const live = state.inventory.filter(isProjectPlayable).length;
    const hintedTotal = Number(state.stats.total ?? state.stats.count);
    const displayTotal = Number.isFinite(hintedTotal) ? hintedTotal : total;
    elements.librarySummary.textContent = displayTotal
      ? `${displayTotal} 张壁纸 · ${live} 张可动态预览`
      : "未扫描到可用项目";
  }

  function updateSourceLabel() {
    const source = state.stats.sourcePath
      ?? state.stats.rootPath
      ?? state.stats.wallpaperRoot
      ?? state.stats.source
      ?? "Wallpaper Engine 本地库";
    elements.sourcePath.textContent = String(source);
    elements.sourcePath.title = String(source);
  }

  function filteredProjects() {
    const query = state.query.trim().toLocaleLowerCase("zh-CN");
    return state.inventory.filter((project) => {
      const matchesType = state.filter === "all" || project.type === state.filter;
      const haystack = `${project.title} ${project.type} ${project.id}`.toLocaleLowerCase("zh-CN");
      return matchesType && (!query || haystack.includes(query));
    });
  }

  function renderInventory() {
    const projects = filteredProjects();
    elements.wallpaperList.replaceChildren();

    for (const project of projects) {
      const fragment = elements.wallpaperTemplate.content.cloneNode(true);
      const card = fragment.querySelector(".wallpaper-card");
      const preview = fragment.querySelector("img");
      const title = fragment.querySelector(".wallpaper-card__title");
      const type = fragment.querySelector(".wallpaper-card__type");
      const live = fragment.querySelector(".wallpaper-card__live");
      const play = fragment.querySelector(".wallpaper-card__play");

      card.dataset.id = project.id;
      card.dataset.type = project.type;
      card.classList.toggle("is-selected", project.id === state.selectedId);
      card.setAttribute("aria-selected", String(project.id === state.selectedId));
      card.setAttribute("aria-label", `选择壁纸：${project.title}`);
      title.textContent = project.title;
      type.textContent = typeLabel(project.type);
      live.textContent = isProjectPlayable(project) ? "动态预览" : "预览图";
      live.classList.toggle("is-live", isProjectPlayable(project));
      play.hidden = !isProjectPlayable(project);

      if (project.previewUrl) {
        preview.src = project.previewUrl;
        preview.alt = `${project.title} 预览图`;
        preview.addEventListener("error", () => preview.classList.add("is-broken"), { once: true });
      } else {
        preview.removeAttribute("src");
        preview.classList.add("is-broken");
      }

      card.addEventListener("click", () => selectProject(project.id));
      elements.wallpaperList.append(fragment);
    }

    elements.wallpaperList.hidden = projects.length === 0;
    elements.emptyState.hidden = projects.length !== 0;
    if (!projects.length) {
      elements.emptyMessage.textContent = state.inventory.length
        ? "尝试更换关键词或筛选类型。"
        : "请确认 Wallpaper Engine 已安装并包含本地壁纸。";
    }
    updateLibrarySummary(projects.length);
  }

  function clearBackgroundMedia() {
    state.mediaRevision += 1;
    for (const media of [elements.backgroundImage, elements.backgroundVideo, elements.backgroundWeb]) {
      media.classList.remove("is-visible");
    }
    elements.backgroundVideo.pause();
    elements.backgroundVideo.removeAttribute("src");
    elements.backgroundVideo.load();
    elements.backgroundImage.removeAttribute("src");
    elements.backgroundWeb.removeAttribute("src");
    elements.backgroundPlaceholder.classList.add("is-visible");
  }

  function revealMedia(media, revision) {
    if (revision !== state.mediaRevision) return;
    for (const candidate of [elements.backgroundImage, elements.backgroundVideo, elements.backgroundWeb]) {
      candidate.classList.toggle("is-visible", candidate === media);
    }
    elements.backgroundPlaceholder.classList.remove("is-visible");
  }

  function showImage(url, revision) {
    if (!url) return;
    elements.backgroundImage.onload = () => revealMedia(elements.backgroundImage, revision);
    elements.backgroundImage.onerror = () => {
      if (revision === state.mediaRevision) elements.backgroundPlaceholder.classList.add("is-visible");
    };
    elements.backgroundImage.src = url;
  }

  function playVideoIfNeeded() {
    if (!state.effects.playing) {
      elements.backgroundVideo.pause();
      return;
    }
    const result = elements.backgroundVideo.play();
    if (result && typeof result.catch === "function") result.catch(() => {});
  }

  function showProjectMedia(project) {
    clearBackgroundMedia();
    const revision = state.mediaRevision;
    if (!project) return;

    const mediaLower = project.mediaUrl.toLowerCase().split(/[?#]/)[0];
    const looksLikeVideo = project.type === "video" || /\.(mp4|webm|mov|m4v|ogv)$/.test(mediaLower);

    if (project.webUrl && project.playable && project.type === "web") {
      elements.backgroundWeb.onload = () => revealMedia(elements.backgroundWeb, revision);
      elements.backgroundWeb.src = project.webUrl;
      return;
    }

    if (project.mediaUrl && project.playable && looksLikeVideo) {
      elements.backgroundVideo.onloadeddata = () => {
        revealMedia(elements.backgroundVideo, revision);
        playVideoIfNeeded();
      };
      elements.backgroundVideo.onerror = () => showImage(project.previewUrl, revision);
      elements.backgroundVideo.src = project.mediaUrl;
      elements.backgroundVideo.load();
      playVideoIfNeeded();
      return;
    }

    showImage(project.mediaUrl || project.previewUrl, revision);
  }

  function updateNowPlaying() {
    const project = currentProject();
    elements.welcomeCard.hidden = Boolean(project);
    elements.nowPlaying.hidden = !project;
    elements.injectButton.disabled = !project;

    if (!project) return;
    elements.currentWallpaperTitle.textContent = project.title;
    elements.currentWallpaperType.textContent = typeLabel(project.type);
    const playable = isProjectPlayable(project);
    elements.playButton.disabled = !playable;
    elements.playButton.title = playable ? "播放/暂停" : "此项目仅支持静态预览";
    elements.playButton.classList.toggle("is-paused", !state.effects.playing);
    elements.playButton.setAttribute("aria-label", state.effects.playing ? "暂停预览" : "播放预览");
    elements.previewStateText.textContent = playable
      ? (state.effects.playing ? "本地预览中" : "预览已暂停")
      : "静态预览";
  }

  function rangeProgress(input) {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const value = Number(input.value);
    input.style.setProperty("--range-progress", `${((value - min) / (max - min)) * 100}%`);
  }

  function renderEffects() {
    const effects = state.effects;
    elements.root.style.setProperty("--brightness", `${effects.brightness}%`);
    elements.root.style.setProperty("--saturation", `${effects.saturation}%`);
    elements.root.style.setProperty("--blur", `${effects.blur}px`);
    elements.root.style.setProperty("--dim", String(effects.darkness / 100));
    elements.root.style.setProperty("--wallpaper-fit", effects.fit);

    elements.brightnessRange.value = effects.brightness;
    elements.darknessRange.value = effects.darkness;
    elements.blurRange.value = effects.blur;
    elements.saturationRange.value = effects.saturation;
    elements.fitSelect.value = effects.fit;
    elements.playbackToggle.checked = Boolean(effects.playing);
    elements.brightnessValue.value = `${effects.brightness}%`;
    elements.darknessValue.value = `${effects.darkness}%`;
    elements.blurValue.value = `${effects.blur}px`;
    elements.saturationValue.value = `${effects.saturation}%`;

    for (const range of [elements.brightnessRange, elements.darknessRange, elements.blurRange, elements.saturationRange]) {
      rangeProgress(range);
    }

    if (effects.playing) playVideoIfNeeded();
    else elements.backgroundVideo.pause();
    try {
      elements.backgroundWeb.contentWindow?.postMessage({
        type: "codex-wallpaper-bridge",
        action: effects.playing ? "play" : "pause",
      }, "*");
    } catch {
      // A sandboxed third-party wallpaper may reject messages; the static preview remains usable.
    }
    updateNowPlaying();
  }

  function configPayload(extra = {}) {
    return {
      selectedId: state.selectedId,
      effects: { ...state.effects },
      ...extra,
    };
  }

  async function persistConfig(extra = {}, revision = ++state.saveRevision) {
    setSaveState("saving", "正在保存…");
    try {
      const payload = await api("config", {
        method: "POST",
        body: JSON.stringify(configPayload(extra)),
      });
      if (revision === state.saveRevision) setSaveState("saved", "设置已保存");
      const returned = extractConfig(payload);
      state.config = { ...state.config, ...returned };
      return payload;
    } catch (error) {
      if (revision === state.saveRevision) setSaveState("error", "保存失败");
      throw error;
    }
  }

  function scheduleConfigSave() {
    window.clearTimeout(state.saveTimer);
    const revision = ++state.saveRevision;
    setSaveState("saving", "正在保存…");
    state.saveTimer = window.setTimeout(() => {
      persistConfig({}, revision).catch((error) => toast(error.message, "error"));
    }, 260);
  }

  async function selectProject(id) {
    const project = state.inventory.find((candidate) => candidate.id === id);
    if (!project || project.id === state.selectedId) return;

    state.selectedId = project.id;
    renderInventory();
    showProjectMedia(project);
    updateNowPlaying();

    try {
      await persistConfig({ selectedId: project.id });
    } catch (error) {
      toast(`壁纸已预览，但无法保存选择：${error.message}`, "error");
    }
  }

  async function loadInventory({ showSkeleton = false } = {}) {
    if (showSkeleton) {
      state.loading = true;
      elements.librarySummary.textContent = "正在扫描本机壁纸…";
    }

    const payload = await api("inventory");
    const { projects, stats } = extractInventory(payload);
    state.inventory = projects.map(normalizeProject);
    state.stats = stats && typeof stats === "object" ? stats : {};
    state.loading = false;

    if (state.selectedId && !state.inventory.some((project) => project.id === state.selectedId)) {
      state.selectedId = null;
    }
    updateSourceLabel();
    renderInventory();
    updateNowPlaying();
    return payload;
  }

  async function loadConfig() {
    const payload = await api("config");
    const config = extractConfig(payload);
    state.config = config;
    state.selectedId = String(
      config.selectedId
      ?? config.wallpaperId
      ?? config.selectedWallpaper?.id
      ?? state.selectedId
      ?? "",
    ) || null;
    state.effects = normalizeEffects(config.effects ?? config.appearance ?? config);
    state.injected = Boolean(config.injected ?? config.isInjected ?? false);
    renderEffects();
    return payload;
  }

  async function initialize() {
    hideError();
    setConnection("loading", "正在连接", "检查本地桥接服务");
    state.loading = true;

    const [configResult, inventoryResult] = await Promise.allSettled([
      loadConfig(),
      loadInventory({ showSkeleton: true }),
    ]);

    if (inventoryResult.status === "rejected") {
      state.loading = false;
      state.inventory = [];
      renderInventory();
      setConnection("error", "桥接服务离线", "无法读取 Wallpaper Engine 库");
      showError("无法读取壁纸库", inventoryResult.reason?.message ?? "请确认本地服务仍在运行。");
      return;
    }

    if (configResult.status === "rejected") {
      state.effects = { ...DEFAULT_EFFECTS };
      renderEffects();
      toast(`设置读取失败，已使用默认值：${configResult.reason?.message ?? "未知错误"}`, "error");
    }

    state.connected = true;
    const selected = currentProject();
    if (selected) showProjectMedia(selected);
    else clearBackgroundMedia();
    renderInventory();
    updateNowPlaying();
    setConnection(
      "connected",
      state.injected ? "已注入 Codex" : "本地服务已连接",
      state.injected ? "当前背景正在与 Codex 同步" : `${state.inventory.length} 张壁纸可用`,
    );
  }

  async function invokeAction(action, extra = {}) {
    return api("action", {
      method: "POST",
      body: JSON.stringify({ action, ...extra }),
    });
  }

  async function rescan() {
    setBusy(elements.rescanButton, true);
    elements.refreshLibraryButton.classList.add("is-spinning");
    elements.refreshLibraryButton.disabled = true;
    hideError();
    try {
      const payload = await invokeAction("rescan");
      await loadInventory({ showSkeleton: true });
      const selected = currentProject();
      if (selected) showProjectMedia(selected);
      setConnection("connected", "扫描完成", `${state.inventory.length} 张壁纸可用`);
      toast(responseMessage(payload, `已找到 ${state.inventory.length} 张壁纸`));
    } catch (error) {
      setConnection("error", "扫描失败", "无法访问 Wallpaper Engine 本地库");
      showError("重新扫描失败", error.message);
    } finally {
      setBusy(elements.rescanButton, false);
      elements.refreshLibraryButton.classList.remove("is-spinning");
      elements.refreshLibraryButton.disabled = false;
    }
  }

  async function injectCodex() {
    const project = currentProject();
    if (!project) {
      toast("请先选择一张壁纸", "error");
      return;
    }

    setBusy(elements.injectButton, true);
    setConnection("loading", "正在注入 Codex", "连接桌面窗口并应用背景");
    try {
      await persistConfig();
      const payload = await invokeAction("inject", { selectedId: project.id });
      state.injected = true;
      setConnection("connected", "已注入 Codex", `${project.title} · 效果实时同步`);
      toast(responseMessage(payload, "背景已成功注入 Codex"));
    } catch (error) {
      setConnection("error", "注入失败", "Codex 窗口未连接");
      showError("无法注入 Codex", error.message);
    } finally {
      setBusy(elements.injectButton, false);
      elements.injectButton.disabled = !currentProject();
    }
  }

  async function restoreCodex() {
    setBusy(elements.restoreButton, true);
    setConnection("loading", "正在恢复", "移除 Codex 背景与视觉效果");
    try {
      const payload = await invokeAction("restore");
      state.injected = false;
      setConnection("connected", "已恢复官方外观", "本地预览仍会保留");
      toast(responseMessage(payload, "Codex 已恢复官方外观"));
    } catch (error) {
      setConnection("error", "恢复失败", "未能移除已注入效果");
      showError("无法恢复官方外观", error.message);
    } finally {
      setBusy(elements.restoreButton, false);
    }
  }

  function readEffectsFromControls() {
    state.effects = {
      brightness: Number(elements.brightnessRange.value),
      darkness: Number(elements.darknessRange.value),
      blur: Number(elements.blurRange.value),
      saturation: Number(elements.saturationRange.value),
      fit: elements.fitSelect.value,
      playing: elements.playbackToggle.checked,
    };
    renderEffects();
    scheduleConfigSave();
  }

  async function togglePlayback(forceValue = null) {
    const project = currentProject();
    if (!isProjectPlayable(project)) return;
    state.effects.playing = forceValue == null ? !state.effects.playing : Boolean(forceValue);
    renderEffects();
    scheduleConfigSave();
    try {
      await invokeAction(state.effects.playing ? "play" : "pause", { selectedId: state.selectedId });
    } catch {
      // Preview playback works without a connected Codex renderer, so action failure is non-fatal.
    }
  }

  function bindEvents() {
    elements.searchInput.addEventListener("input", () => {
      state.query = elements.searchInput.value;
      renderInventory();
    });

    elements.typeFilters.addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]");
      if (!button) return;
      state.filter = button.dataset.filter;
      $$(".filter-chip").forEach((chip) => chip.classList.toggle("is-active", chip === button));
      renderInventory();
    });

    for (const input of [
      elements.brightnessRange,
      elements.darknessRange,
      elements.blurRange,
      elements.saturationRange,
    ]) {
      input.addEventListener("input", readEffectsFromControls);
    }
    elements.fitSelect.addEventListener("change", readEffectsFromControls);
    elements.playbackToggle.addEventListener("change", () => togglePlayback(elements.playbackToggle.checked));
    elements.playButton.addEventListener("click", () => togglePlayback());

    elements.resetEffectsButton.addEventListener("click", () => {
      state.effects = { ...DEFAULT_EFFECTS };
      renderEffects();
      scheduleConfigSave();
      toast("显示设置已重置");
    });

    elements.injectButton.addEventListener("click", injectCodex);
    elements.restoreButton.addEventListener("click", restoreCodex);
    elements.rescanButton.addEventListener("click", rescan);
    elements.refreshLibraryButton.addEventListener("click", rescan);
    elements.emptyRescanButton.addEventListener("click", rescan);
    elements.retryButton.addEventListener("click", initialize);
    elements.dismissErrorButton.addEventListener("click", hideError);

    elements.openHelpButton.addEventListener("click", () => {
      if (typeof elements.helpDialog.showModal === "function") elements.helpDialog.showModal();
      else elements.helpDialog.setAttribute("open", "");
    });

    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        elements.searchInput.focus();
        elements.searchInput.select();
      }
      if (event.key === "Escape" && document.activeElement === elements.searchInput && elements.searchInput.value) {
        elements.searchInput.value = "";
        state.query = "";
        renderInventory();
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) elements.backgroundVideo.pause();
      else if (state.effects.playing) playVideoIfNeeded();
    });
  }

  elements.backgroundPlaceholder.classList.add("is-visible");
  elements.injectButton.disabled = true;
  bindEvents();
  renderEffects();
  initialize();
})();
