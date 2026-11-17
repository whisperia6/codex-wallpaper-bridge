(() => {
  "use strict";

  const DEFAULT_EFFECTS = Object.freeze({
    brightness: 72,
    darkness: 22,
    blur: 0,
    saturation: 100,
    fit: "cover",
    webLoopHoldSeconds: 0,
    webForceSingleLoop: false,
    playing: true,
    pauseWhenHidden: true,
    pauseOnBattery: false,
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
    defaultEffects: { ...DEFAULT_EFFECTS },
    filter: "all",
    query: "",
    connected: false,
    injected: false,
    loading: true,
    mediaRevision: 0,
    saveRevision: 0,
    saveTimer: null,
    saveQueue: Promise.resolve(),
    markedIds: new Set(),
    hiddenView: false,
    libraryPage: 1,
    libraryBusy: false,
    activeJobId: null,
    cancelBatch: false,
    playRejectedRevision: -1,
    playlistBusy: false,
    playbackPolling: false,
    effectsDirty: false,
    scenePreview: { id: null, phase: "idle" },
    sceneSelectingId: null,
    previewLoadingId: null,
    previewLoadingRevision: null,
  };
  let scenePreloadTimer = null;
  let scenePreloadRequest = null;
  let workbenchScenePreload = null;
  let sceneSelectionVersion = 0;

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  const elements = {
    root: document.documentElement,
    backgroundImage: $("#backgroundImage"),
    backgroundVideo: $("#backgroundVideo"),
    backgroundWeb: $("#backgroundWeb"),
    backgroundScene: $("#backgroundScene"),
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
    engineRetryButton: $("#engineRetryButton"),
    engineFallbackControl: $("#engineFallbackControl"),
    engineFallbackSelect: $("#engineFallbackSelect"),
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
    importInput: $("#importWallpapersInput"),
    importButton: $("#importWallpapersButton"),
    importRating: $("#importRatingSelect"),
    hiddenView: $("#hiddenViewInput"),
    batchHide: $("#batchHideButton"),
    restoreAll: $("#restoreAllWallpapersButton"),
    ratingPolicy: $("#ratingPolicyInputs"),
    directoryText: $("#libraryDirectoryText"),
    directoryInput: $("#libraryDirectoryInput"),
    migrateButton: $("#migrateLibraryButton"),
    assetTask: $("#assetTask"),
    taskText: $("#assetTaskText"),
    taskProgress: $("#assetTaskProgress"),
    cancelTask: $("#cancelAssetTaskButton"),
    moreWallpapers: $("#moreWallpapersButton"),
    confirmDialog: $("#libraryConfirmDialog"),
    confirmMessage: $("#libraryConfirmMessage"),
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
      ...raw,
      brightness: Math.round(clamp(percentLike(raw.brightness, DEFAULT_EFFECTS.brightness, 160), 10, 160, 72)),
      darkness: Math.round(percentLike(raw.darkness ?? raw.dim ?? raw.overlay, DEFAULT_EFFECTS.darkness, 90)),
      blur: Math.round(clamp(raw.blur ?? raw.blurPx, 0, 40, DEFAULT_EFFECTS.blur)),
      saturation: Math.round(percentLike(raw.saturation, DEFAULT_EFFECTS.saturation, 240)),
      fit,
      webLoopHoldSeconds: Math.round(clamp(raw.webLoopHoldSeconds, 0, 3600, DEFAULT_EFFECTS.webLoopHoldSeconds)),
      webForceSingleLoop: raw.webForceSingleLoop === true,
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

  function requestScenePreload(id, { force = false } = {}) {
    if (!state.connected) return Promise.resolve(null);
    if (id !== null) {
      const project = state.inventory.find((item) => item.id === id);
      if (!project || project.type !== "scene" || project.hidden || project.eligible === false || state.libraryBusy) return Promise.resolve(null);
    }
    if (!force && scenePreloadRequest?.id === id && Date.now() - scenePreloadRequest.startedAt < 120000) return scenePreloadRequest.promise;
    const request = { id, promise: null, startedAt: Date.now() };
    scenePreloadRequest = request;
    request.promise = api("scene-preload", { method: "POST", body: JSON.stringify({ id }), signal: AbortSignal.timeout(8000) })
      .then((result) => {
        if (result.status === "skipped" && scenePreloadRequest === request) scenePreloadRequest = null;
        return result;
      }).catch(() => {
        if (scenePreloadRequest === request) scenePreloadRequest = null;
        // Speculation is optional; normal selection still owns error feedback.
        return null;
      });
    return request.promise;
  }

  function scheduleScenePreload(project) {
    window.clearTimeout(scenePreloadTimer);
    if (project.type !== "scene" || project.id === state.selectedId || document.hidden
      || state.sceneSelectingId || state.previewLoadingRevision !== null || state.libraryBusy || state.playlistBusy) return;
    scenePreloadTimer = window.setTimeout(() => {
      if (state.sceneSelectingId || state.previewLoadingRevision !== null || state.libraryBusy || state.playlistBusy || document.hidden) return;
      preloadWorkbenchScene(project.id, "hover");
      void requestScenePreload(project.id);
    }, 400);
  }

  function previewIdentity(project) {
    return JSON.stringify([project.id, project.type, project.mediaUrl, project.webUrl, project.previewUrl, project.scenePreviewAvailable]);
  }

  function forgetWorkbenchPreload(cancel = false) {
    const warm = workbenchScenePreload;
    workbenchScenePreload = null;
    window.clearTimeout(warm?.timer);
    if (cancel && warm && previewSwitcher.status().requestedIdentity === warm.identity) previewSwitcher.cancel();
    return warm;
  }

  function preloadWorkbenchScene(id, source = "playlist") {
    if (!state.connected || document.hidden || state.libraryBusy || state.sceneSelectingId || state.previewLoadingRevision !== null) return;
    const project = state.inventory.find((item) => item.id === id);
    if (!project || project.type !== "scene" || !project.scenePreviewAvailable || project.hidden
      || project.eligible === false || project.id === state.selectedId || scenePreviewFailures.has(id)) {
      if (source === "playlist" && workbenchScenePreload?.source === "playlist") forgetWorkbenchPreload(true);
      return;
    }
    const status = previewSwitcher.status(), identity = previewIdentity(project);
    // Speculation cannot end a transition or replace an explicit selection.
    if (status.transitioning || (status.requestedIdentity && !workbenchScenePreload)) return;
    if (workbenchScenePreload?.identity === identity && workbenchScenePreload.expires > Date.now()) return;
    if (source === "playlist" && workbenchScenePreload?.source === "hover") return;
    forgetWorkbenchPreload();
    const handle = previewSwitcher.prepare(project, identity, { loadTimeoutMs: 90000 });
    const warm = { id, identity, handle, source, timer: null, expires: Date.now() + 120000, failed: false };
    workbenchScenePreload = warm;
    warm.timer = window.setTimeout(() => {
      if (workbenchScenePreload === warm) forgetWorkbenchPreload(true);
    }, 120000);
    void handle.ready.then((result) => {
      // Do not repeatedly reopen a failing speculative scene on every poll.
      if (!result.ok && workbenchScenePreload === warm) warm.failed = true;
    });
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
    return Boolean(project && ((project.type === "scene" && project.scenePreviewAvailable)
      || (["video", "web"].includes(project.type) && project.playable && (project.mediaUrl || project.webUrl))));
  }

  function updateLibrarySummary(filteredCount = null) {
    const total = state.inventory.length;
    if (state.loading) {
      elements.librarySummary.textContent = "正在连接 Wallpaper Engine…";
      return;
    }
    if (filteredCount != null && filteredCount !== total) {
      elements.librarySummary.textContent = `匹配 ${filteredCount} / ${total} 张 · 隐藏 ${state.stats.hidden ?? 0} 张`;
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
      const allowed = (state.config.library?.allowedRatings ?? ["everyone", "pg13", "mature", "unrated"])
        .includes(project.contentRating ?? "unrated");
      const matchesPolicy = state.hiddenView ? project.hidden && allowed : !project.hidden && project.eligible !== false;
      const matchesType = state.filter === "all" || project.type === state.filter;
      const haystack = `${project.title} ${project.type} ${project.id}`.toLocaleLowerCase("zh-CN");
      return matchesPolicy && matchesType && (!query || haystack.includes(query));
    });
  }

  function renderInventory() {
    const matching = filteredProjects();
    const projects = matching.slice(0, state.libraryPage * 60);
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
      card.disabled = Boolean(project.hidden || state.libraryBusy || project.eligible === false);
      card.classList.toggle("is-selected", project.id === state.selectedId);
      card.setAttribute("aria-selected", String(project.id === state.selectedId));
      card.setAttribute("aria-label", `选择壁纸：${project.title}`);
      title.textContent = project.title;
      type.textContent = typeLabel(project.type);
      live.textContent = isProjectPlayable(project) ? "动态预览" : project.type === "image" ? "静态图片" : "预览图";
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
      card.addEventListener("pointerenter", (event) => { if (event.pointerType !== "touch") scheduleScenePreload(project); });
      card.addEventListener("focus", () => scheduleScenePreload(project));
      card.addEventListener("pointerleave", () => window.clearTimeout(scenePreloadTimer));
      card.addEventListener("blur", () => window.clearTimeout(scenePreloadTimer));
      const mark = fragment.querySelector(".asset-mark");
      mark.checked = state.markedIds.has(project.id);
      mark.disabled = state.libraryBusy;
      mark.setAttribute("aria-label", `选择管理：${project.title}`);
      mark.addEventListener("change", () => {
        if (mark.checked && state.markedIds.size >= 100) { mark.checked = false; toast("每批最多管理 100 张壁纸", "error"); return; }
        if (mark.checked) state.markedIds.add(project.id);
        else state.markedIds.delete(project.id);
        renderLibraryControls();
      });
      const rating = fragment.querySelector(".asset-rating");
      rating.value = project.contentRating ?? "unrated";
      rating.disabled = state.libraryBusy;
      rating.setAttribute("aria-label", `${project.title} 的内容分级`);
      rating.addEventListener("change", () => manageLibrary("rating", [project.id], { rating: rating.value }));
      const restore = fragment.querySelector(".asset-restore");
      restore.hidden = !project.hidden;
      restore.disabled = state.libraryBusy;
      restore.addEventListener("click", () => manageLibrary("restore", [project.id]));
      const remove = fragment.querySelector(".asset-remove");
      remove.hidden = project.source !== "imported";
      remove.disabled = state.libraryBusy;
      remove.addEventListener("click", async () => {
        if (await confirmLibrary(`移除库索引和当前目录的「${project.title}」文件？迁移保留的旧副本与 WE 源文件不会删除。`)) {
          await manageLibrary("remove", [project.id]);
        }
      });
      elements.wallpaperList.append(fragment);
    }

    elements.wallpaperList.hidden = projects.length === 0;
    elements.emptyState.hidden = projects.length !== 0;
    if (!projects.length) {
      elements.emptyMessage.textContent = state.inventory.length
        ? "尝试更换关键词或筛选类型。"
        : "可以导入 JPG、PNG 或 MP4，也可以扫描 Wallpaper Engine 本地库。";
    }
    elements.moreWallpapers.hidden = projects.length >= matching.length;
    updateLibrarySummary(matching.length);
    renderLibraryControls();
  }

  let scenePreviewClient = null, activeSceneSlot = null;
  const scenePreviewClosing = new Set(), scenePreviewFailures = new Set();
  const previewSwitcher = cwbMedia.createMediaSwitcher({
    create(project, { revision }) {
      const kind = project.type === "scene" && project.scenePreviewAvailable ? "Scene"
        : project.type === "video" && project.mediaUrl ? "Video"
        : (project.type === "web" && project.scenePreviewAvailable ? "Web" : "Image");
      const media = elements[`background${kind}`].cloneNode(false);
      media.id = `background${kind}-pending-${revision}`;
      media.removeAttribute("src");
      media.classList.remove("is-visible");
      media.style.opacity = "0";
      if (["Scene", "Web"].includes(kind) && project.scenePreviewAvailable) {
        scenePreviewClient ??= crypto.randomUUID().replaceAll("-", "");
        elements.backgroundPlaceholder.parentNode.insertBefore(media, elements.backgroundPlaceholder);
        return cwbScenePreview.createScenePreviewSlot({ node: media, project, client: scenePreviewClient, api,
          onMediaControl: value => api("media/control", { method: "POST", body: JSON.stringify({ command: value.command, sessionId: value.sessionId, projectId: project.id }) }),
          getEffects: () => state.effects, beforeOpen: () => Promise.allSettled([...scenePreviewClosing]),
          onStatus(status) {
            const active = activeSceneSlot?.node === media;
            const selecting = state.previewLoadingId === project.id && state.previewLoadingRevision !== null
              && previewSwitcher.status().requestedIdentity === previewIdentity(project);
            if (!active && !selecting) {
              if (status.phase === "failed" && workbenchScenePreload?.handle.slot?.node === media) workbenchScenePreload.failed = true;
              return;
            }
            if (active && state.previewLoadingRevision !== null && state.previewLoadingId !== project.id) {
              if (status.phase === "failed") scenePreviewFailures.add(project.id);
              return;
            }
            state.scenePreview = { id: project.id, ...status };
            if (status.phase === "failed") {
              scenePreviewFailures.add(project.id);
              if (active) queueMicrotask(() => {
                if (activeSceneSlot?.node === media && state.previewLoadingRevision === null && !state.sceneSelectingId) void showProjectMedia(project);
              });
            }
            updatePreviewLabel();
          } });
      }
      let readyResolve, readyReject;
      const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      let committed = false, released = false, settled = false, frameCallback = null;
      const cancelFrame = () => {
        if (frameCallback !== null) media.cancelVideoFrameCallback?.(frameCallback);
        frameCallback = null;
      };
      const resolveReady = () => {
        if (released || settled) return;
        settled = true; cancelFrame(); readyResolve();
      };
      const decoded = () => media.readyState >= 2 && media.videoWidth > 0 && media.videoHeight > 0;
      const checkVideoReady = () => {
        if (released || settled || !decoded()) return;
        // Paused media cannot promise a compositor callback. This is decoded
        // readiness, not proof of a visible first frame in a Codex host.
        if (!cwbMedia.resolvePlayback(state.effects, { hidden: document.hidden === true }).playing || !media.requestVideoFrameCallback) resolveReady();
        else if (frameCallback === null) frameCallback = media.requestVideoFrameCallback(() => {
          frameCallback = null; if (decoded()) resolveReady();
        });
      };
      const update = () => {
        if (released) return;
        if (kind === "Video") {
          media.playbackRate = state.effects.playbackRate ?? 1;
          media.volume = (state.effects.volume ?? 50) / 100;
          media.muted = !committed || state.effects.audioEnabled !== true;
          if (!cwbMedia.resolvePlayback(state.effects, { hidden: document.hidden === true }).playing) media.pause();
          else if (!committed) media.play().catch(() => {});
          checkVideoReady();
        }
      };
      media.onerror = () => {
        if (released || settled) return;
        settled = true; cancelFrame(); readyReject(new Error("Media decode failed"));
      };
      if (kind === "Video") {
        media.muted = true;
        media.onloadeddata = checkVideoReady;
      } else media.onload = () => kind === "Image" ? media.decode().then(resolveReady, readyReject) : resolveReady();
      elements.backgroundPlaceholder.parentNode.insertBefore(media, elements.backgroundPlaceholder);
      media.src = kind === "Web" ? project.webUrl : (project.mediaUrl || project.previewUrl);
      update();
      return { node: media, kind, projectId: project.id, canonicalId: `background${kind}`, ready, update,
        activate() { committed = true; update(); },
        retire() { media.muted = true; },
        release() {
          released = true; cancelFrame();
          media.onload = media.onerror = media.onloadeddata = null;
          media.pause?.(); media.removeAttribute("src"); media.load?.(); media.remove();
        } };
    },
    commit(slot, before) {
      // Validate activation before muting or renaming the current scene.
      slot.activate();
      if (before) { before.node.id += "-retired"; before.retire(); }
      const reserved = document.getElementById(slot.canonicalId);
      if (reserved && reserved !== slot.node) reserved.remove();
      slot.node.id = slot.canonicalId;
      slot.node.style.removeProperty("opacity");
      slot.node.classList.add("is-visible");
      elements[slot.canonicalId] = slot.node;
      activeSceneSlot = ["Scene", "Web"].includes(slot.kind) ? slot : null;
      if (slot.projectId === state.selectedId) void authorPanel.refreshWhenIdle();
      if (slot.kind === "Video") playVideoIfNeeded();
      elements.backgroundPlaceholder.classList.remove("is-visible");
    },
    dispose: (slot) => {
      const closing = slot?.release();
      if (closing?.then) {
        scenePreviewClosing.add(closing);
        closing.then(() => scenePreviewClosing.delete(closing), () => scenePreviewClosing.delete(closing));
      }
    },
    transition: cwbMedia.runMediaTransition,
  });

  async function withPreviewAuthorReadback(id, result, apply = false) {
    const slot = id === state.selectedId ? activeSceneSlot : null;
    if (slot?.projectId !== id) return result;
    try {
      return { ...result, live: await slot.authorProperties(result.schema, apply ? result.values : null) };
    } catch {
      // Persistence already succeeded. A cancelled/failed preview readback is
      // not a disk failure and must not roll the confirmed controls back.
      return { ...result, live: { phase: 'failed', method: 'none', values: {} } };
    }
  }

  const authorPanel = cwbAuthorProperties.createAuthorPropertiesPanel({
    root: $("#authorPropertiesPanel"),
    fetchState: async (id) => withPreviewAuthorReadback(id, await api("author-properties/" + encodeURIComponent(id))),
    saveState: async (id, body) => {
      const result = await api("author-properties/" + encodeURIComponent(id), { method: "POST", body: JSON.stringify(body) });
      return withPreviewAuthorReadback(id, result, true);
    },
    uploadFile: async (id, key, file, revision) => {
      const query = new URLSearchParams({ filename: file.name, revision: String(revision) });
      const result = await api("author-properties/" + encodeURIComponent(id) + "/file/" + encodeURIComponent(key) + "?" + query, {
        method: "POST", body: file, headers: { "Content-Type": "application/octet-stream", "X-CWB-File-Size": String(file.size) },
      });
      return withPreviewAuthorReadback(id, result, true);
    },
    uploadDirectory: async (id, key, files, revision, progress) => {
      const result = await cwbAuthorProperties.uploadAuthorDirectory({ api, id, key, files, revision, ...progress });
      return withPreviewAuthorReadback(id, result, true);
    },
    onBusyChange: (busy) => { window.__cwbAuthorPropertiesBusy = busy; },
    onError: (error) => toast(error.message, "error"),
  });

  function clearBackgroundMedia() {
    state.mediaRevision++;
    state.previewLoadingRevision = null; state.previewLoadingId = null;
    forgetWorkbenchPreload();
    previewSwitcher.clear();
    activeSceneSlot = null;
    elements.backgroundPlaceholder.classList.add("is-visible");
  }

  function playVideoIfNeeded() {
    if (!elements.backgroundVideo.getAttribute("src")) return;
    if (!cwbMedia.resolvePlayback(state.effects, { hidden: document.hidden === true }).playing) {
      elements.backgroundVideo.pause();
      return;
    }
    const result = elements.backgroundVideo.play();
    if (result && typeof result.catch === "function") result.catch(() => {
      if (state.playRejectedRevision === state.mediaRevision) return;
      state.playRejectedRevision = state.mediaRevision;
      toast("浏览器拒绝自动播放，请点击播放；有声壁纸可能需要在 Codex 中交互后重新应用。", "error");
    });
  }

  async function showProjectMedia(project, { force = false } = {}) {
    state.mediaRevision++;
    if (!project) { clearBackgroundMedia(); return { ok: true }; }
    const revision = state.mediaRevision;
    state.previewLoadingRevision = revision; state.previewLoadingId = project.id;
    const warm = forgetWorkbenchPreload();
    if (force) scenePreviewFailures.delete(project.id);
    const fallback = project.scenePreviewAvailable && scenePreviewFailures.has(project.id);
    if (fallback) project = { ...project, scenePreviewAvailable: false };
    const identity = previewIdentity(project);
    if (project.scenePreviewAvailable) state.scenePreview = { id: project.id, phase: "loading" };
    try {
      if (!force && warm?.identity === identity) {
        const current = !warm.failed && warm.expires > Date.now()
          && await warm.handle.slot?.validatePrepared().catch(() => false);
        if (revision !== state.mediaRevision) return { ok: false, cancelled: true };
        if (!current && previewSwitcher.status().requestedIdentity === identity) previewSwitcher.cancel();
      }
      const result = await previewSwitcher.switchTo(project, identity, { ...state.effects, force,
        loadTimeoutMs: project.scenePreviewAvailable ? 90000 : 5000 });
      if (revision !== state.mediaRevision || result.cancelled) return result;
      if (!result.ok && project.scenePreviewAvailable) {
        scenePreviewFailures.add(project.id);
        state.scenePreview = { id: project.id, phase: "failed" };
        if (!previewSwitcher.status().identity && project.previewUrl) {
          const restored = await previewSwitcher.switchTo({ ...project, scenePreviewAvailable: false }, identity + "-fallback", state.effects);
          updatePreviewLabel();
          toast("Scene 实时预览未就绪，当前仅显示预览图；可显式重试引擎。", "error");
          return restored;
        }
      }
      if (result.error) toast("壁纸加载失败，已保留旧画面；可选择其他壁纸或重新扫描。", "error");
      return result;
    } finally {
      if (state.previewLoadingRevision === revision) { state.previewLoadingRevision = null; state.previewLoadingId = null; }
    }
  }

  function updatePreviewLabel() {
    const project = currentProject();
    if (!project) return;
    const preview = state.scenePreview;
    const playback = cwbMedia.resolvePlayback(state.effects, { hidden: document.hidden === true });
    if (["scene", "web"].includes(project.type) && project.scenePreviewAvailable) {
      const failed = scenePreviewFailures.has(project.id);
      const live = preview.id === project.id && preview.phase === "ready" && !failed;
      elements.previewStateText.textContent = failed ? "预览图回退" : live ? !playback.playing ? "预览已暂停" : project.type === "web" ? "Web GPU 实时" : `Scene 实时 · ${preview.fps ?? 0} FPS` : "GPU 加载中";
      elements.previewStateText.title = live ? `实际画布 ${preview.width}×${preview.height}；这里是引擎帧率，不是物理屏幕帧率。` : "工作台预览与 Codex 宿主验收相互独立。";
    } else {
      elements.previewStateText.textContent = isProjectPlayable(project)
        ? (playback.playing ? "本地预览中" : "预览已暂停") : "静态预览";
      elements.previewStateText.title = "";
    }
  }

  function updateNowPlaying() {
    const project = currentProject();
    void authorPanel.select(project);
    elements.welcomeCard.hidden = Boolean(project);
    elements.nowPlaying.hidden = !project;
    elements.injectButton.disabled = !project || state.libraryBusy || project.eligible === false;
    elements.engineRetryButton.hidden = !project || !["scene", "web"].includes(project.type);
    elements.engineRetryButton.disabled = !project || state.libraryBusy || project.eligible === false;
    if (elements.engineFallbackControl && elements.engineFallbackSelect) {
      elements.engineFallbackControl.hidden = !project || !["scene", "web"].includes(project.type);
      const select = elements.engineFallbackSelect;
      const images = state.inventory.filter(item => item.type === "image" && item.eligible !== false && !item.hidden && item.mediaUrl);
      const key = images.map(item => item.id).join("|");
      if (select.dataset.options !== key) {
        select.replaceChildren(new Option("默认预览图", ""), ...images.map(item => new Option(item.title, item.id)));
        select.dataset.options = key;
      }
      select.value = state.config.engineFallbacks?.[project?.id]?.staticId || "";
      select.disabled = !project || state.libraryBusy || project.eligible === false;
    }

    if (!project) return;
    elements.currentWallpaperTitle.textContent = project.title;
    elements.currentWallpaperType.textContent = typeLabel(project.type);
    const playable = isProjectPlayable(project);
    elements.playButton.disabled = !playable && !state.config.playlists?.enabled;
    elements.playButton.title = playable ? "播放/暂停" : "此项目仅支持静态预览";
    elements.playButton.classList.toggle("is-paused", !state.effects.playing);
    elements.playButton.setAttribute("aria-label", state.effects.playing ? "暂停预览" : "播放预览");
    updatePreviewLabel();
  }

  function rangeProgress(input) {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const value = Number(input.value);
    input.style.setProperty("--range-progress", `${((value - min) / (max - min)) * 100}%`);
  }

  function renderEffects() {
    for (const control of $$('[data-media]')) control.checked = state.config.media?.[control.dataset.media] === true;
    const effects = state.effects;
    elements.root.style.setProperty("--brightness", `${effects.brightness}%`);
    elements.root.style.setProperty("--saturation", `${effects.saturation}%`);
    elements.root.style.setProperty("--blur", `${effects.blur}px`);
    elements.root.style.setProperty("--dim", String(effects.darkness / 100));
    elements.root.style.setProperty("--wallpaper-fit", effects.fit);
    elements.root.style.setProperty("--wallpaper-position", effects.position ?? "50% 50%");
    elements.root.style.setProperty("--wallpaper-zoom", String((effects.zoom ?? 100) / 100));
    elements.root.style.setProperty("--wallpaper-mirror", effects.mirror ? "-1" : "1");
    elements.root.style.setProperty("--contrast", `${effects.contrast ?? 100}%`);
    elements.root.style.setProperty("--wallpaper-opacity", String((effects.opacity ?? 100) / 100));
    for (const control of $$('[data-effect]')) {
      const value = effects[control.dataset.effect] ?? state.defaultEffects[control.dataset.effect];
      if (value === undefined) continue;
      if (control.type === "checkbox") control.checked = Boolean(value);
      else control.value = value;
      if (control.type === "range") rangeProgress(control);
    }
    elements.backgroundVideo.playbackRate = effects.playbackRate ?? 1;
    elements.backgroundVideo.volume = (effects.volume ?? 50) / 100;
    elements.backgroundVideo.muted = effects.audioEnabled !== true;
    previewSwitcher.update();
    if (effects.reduceMotion) previewSwitcher.finishTransition();

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
        action: cwbMedia.resolvePlayback(effects, { hidden: document.hidden === true }).playing ? "play" : "pause",
      }, "*");
    } catch {
      // A sandboxed third-party wallpaper may reject messages; the static preview remains usable.
    }
    updateNowPlaying();
  }

  function configPayload(extra = {}) {
    const effects = { ...state.effects }; delete effects.onBattery;
    return {
      effects,
      media: { ...state.config.media },
      ...extra,
    };
  }

  async function persistConfig(extra = {}, revision = ++state.saveRevision) {
    setSaveState("saving", "正在保存…");
    const body = JSON.stringify(configPayload(extra));
    const previous = state.saveQueue;
    let finish;
    state.saveQueue = new Promise((resolve) => { finish = resolve; });
    try {
      await previous;
      const payload = await api("config", {
        method: "POST",
        body,
      });
      if (revision === state.saveRevision) setSaveState("saved", "设置已保存");
      const returned = extractConfig(payload);
      if (revision === state.saveRevision) state.config = { ...state.config, ...returned };
      if (revision === state.saveRevision) state.effectsDirty = false;
      return payload;
    } catch (error) {
      if (revision === state.saveRevision) setSaveState("error", "保存失败");
      throw error;
    } finally {
      finish();
    }
  }

  function scheduleConfigSave() {
    state.effectsDirty = true;
    window.clearTimeout(state.saveTimer);
    const revision = ++state.saveRevision;
    setSaveState("saving", "正在保存…");
    state.saveTimer = window.setTimeout(() => {
      persistConfig({}, revision).catch((error) => toast(error.message, "error"));
    }, 260);
  }

  async function selectProject(id) {
    const project = state.inventory.find((candidate) => candidate.id === id);
    if (!project || project.hidden || project.eligible === false || state.libraryBusy
      || (project.id === state.selectedId && !state.sceneSelectingId) || id === state.sceneSelectingId) return;

    window.clearTimeout(scenePreloadTimer);
    state.sceneSelectingId = id;
    const selectionVersion = ++sceneSelectionVersion;
    // Warm Codex while the workbench loads, not only after its preview is ready.
    if (project.type === "scene") void requestScenePreload(project.id, { force: true });
    else { scenePreloadRequest = null; void requestScenePreload(null); }
    const operation = showProjectMedia(project);
    const mediaRevision = state.mediaRevision;
    try {
      const result = await operation;
      if (mediaRevision !== state.mediaRevision || result.cancelled) return;
      if (!result.ok) { scenePreloadRequest = null; void requestScenePreload(null); return; }
      scenePreloadRequest = null;
      state.selectedId = project.id;
      renderInventory();
      updateNowPlaying();
      try { await persistConfig({ selectedId: project.id }); }
      catch (error) { toast(`壁纸已预览，但无法保存选择：${error.message}`, "error"); }
    } finally {
      if (sceneSelectionVersion === selectionVersion) state.sceneSelectingId = null;
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
    state.markedIds = new Set([...state.markedIds].filter((id) => state.inventory.some((project) => project.id === id)));
    state.loading = false;

    if (state.selectedId && !state.inventory.some((project) => project.id === state.selectedId && project.eligible !== false)) {
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
    if (payload.defaults) state.defaultEffects = { ...payload.defaults };
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
    renderLibraryControls();
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
    await loadLibraryDirectory().catch((error) => toast(error.message, "error"));
    await loadPlaylists().catch((error) => toast(error.message, "error"));
    await pollVideoTasks(true);
    setConnection(
      "connected",
      state.injected ? "已注入 Codex" : "本地服务已连接",
      state.injected ? "当前背景正在与 Codex 同步" : `${state.inventory.length} 张壁纸可用`,
    );
  }

  function renderLibraryControls() {
    elements.batchHide.disabled = state.libraryBusy || state.markedIds.size === 0;
    elements.batchHide.textContent = `${state.hiddenView ? "恢复" : "隐藏"}所选${state.markedIds.size ? ` (${state.markedIds.size})` : ""}`;
    elements.restoreAll.disabled = state.libraryBusy || !state.stats.hidden;
    for (const control of [elements.importButton, elements.importRating, elements.hiddenView,
      elements.migrateButton, elements.directoryInput, ...elements.ratingPolicy.querySelectorAll("input")]) {
      control.disabled = state.libraryBusy;
    }
    for (const input of elements.ratingPolicy.querySelectorAll("input")) {
      input.checked = (state.config.library?.allowedRatings ?? ["everyone", "pg13", "mature", "unrated"]).includes(input.value);
    }
  }

  const videoTasks = { polling: false, requesting: false, closed: false, video: null, cache: null, settingsVersion: 0, settingsSaving: 0 };
  const taskActive = job => job && !["completed", "failed", "cancelled"].includes(job.status);
  const taskLabels = { queued: "排队", probing: "探测", running: "处理中", verifying: "校验", committing: "提交",
    cancelling: "等待取消并收尾", stopping: "等待子进程退出", cancelled: "已取消", completed: "已完成", failed: "失败" };
  function renderVideoTasks() {
    const video = videoTasks.video, cache = videoTasks.cache, job = video?.job, migration = cache?.job;
    const busy = videoTasks.requesting || videoTasks.settingsSaving > 0 || taskActive(job) || cache?.busy;
    for (const control of $$('[data-video]')) {
      const value = state.config.video?.[control.dataset.video] ?? ({ faststart: true, useOptimized: false, fpsCap: 30, encoder: "auto" })[control.dataset.video];
      if (control.type === "checkbox") control.checked = Boolean(value);
      else if (document.activeElement !== control) control.value = value;
    }
    const capabilities = video?.capabilities;
    if (capabilities?.available !== null && capabilities?.available !== undefined) $("#videoToolsStatus").textContent = capabilities.available
      ? `可用编码器：${capabilities.encoders.join("、")}。列出硬件编码器不代表驱动可用，实际失败会尝试软件。`
      : `工具不可用：${capabilities.error || "video_tool_unavailable"}；继续播放原片，不自动下载。`;
    $("#videoJobProgress").value = job?.progress || 0;
    $("#videoJobStatus").textContent = job ? `${taskLabels[job.status] || job.status} · ${Math.round(job.progress * 100)}%${job.encoder ? ` · ${job.encoder}` : ""}${job.fallback ? " · 已回退软件" : ""}${job.error ? ` · ${job.error}` : ""}` : "没有视频任务";
    $("#optimizeVideoButton").disabled = busy || currentProject()?.type !== "video" || currentProject()?.eligible === false;
    $("#probeVideoToolsButton").disabled = busy;
    $("#cancelVideoJobButton").disabled = videoTasks.requesting || !job || !["queued", "probing", "running", "verifying"].includes(job.status);
    $("#retryVideoJobButton").disabled = busy || !job || !["failed", "cancelled"].includes(job.status);
    $("#applyOptimizedVideoButton").disabled = busy || job?.status !== "completed" || currentProject()?.id !== job?.projectId;
    if (cache) $("#cacheDirectoryStatus").textContent = `实际缓存：${cache.actualDirectory}；配置路径：${cache.configuredDirectory || "默认"}${cache.environmentOverride ? "；CWB_CACHE_ROOT 环境覆盖生效，不能迁移" : ""}。源目录始终保留。`;
    $("#cacheJobProgress").value = migration?.progress || 0;
    $("#cacheJobStatus").textContent = migration ? `${taskLabels[migration.status] || migration.status} · ${Math.round(migration.progress * 100)}%${migration.error ? ` · ${migration.error}` : ""}` : "没有缓存迁移任务";
    $("#migrateCacheButton").disabled = busy || !cache || cache.environmentOverride;
    $("#cacheDirectoryInput").disabled = busy || cache?.environmentOverride;
    $("#cancelCacheJobButton").disabled = videoTasks.requesting || !migration || !["queued", "running"].includes(migration.status);
    $("#retryCacheJobButton").disabled = busy || cache?.environmentOverride || !migration || !["failed", "cancelled"].includes(migration.status);
    $("#resumeCacheJobButton").disabled = busy || cache?.environmentOverride || !cache?.recovery?.resumable;
  }
  async function pollVideoTasks(force = false) {
    if (videoTasks.closed || videoTasks.polling || document.hidden || (!force && !$("#videoOptimizationPanel").open
      && !taskActive(videoTasks.video?.job) && !taskActive(videoTasks.cache?.job))) return;
    videoTasks.polling = true;
    try {
      const [video, cache] = await Promise.allSettled([api("video-jobs"), api("cache")]);
      if (video.status === "fulfilled") videoTasks.video = video.value;
      else $("#videoToolsStatus").textContent = `视频任务不可用：${video.reason.message}`;
      if (cache.status === "fulfilled") videoTasks.cache = cache.value;
      else $("#cacheDirectoryStatus").textContent = `缓存状态不可用：${cache.reason.message}`;
      if (!videoTasks.closed) renderVideoTasks();
      // Job completion does not refresh media URLs or change the active source.
    } finally { videoTasks.polling = false; }
  }
  async function videoTaskOperation(route, body = {}) {
    if (videoTasks.requesting) return;
    videoTasks.requesting = true; renderVideoTasks();
    try {
      const result = await api(route, { method: "POST", body: JSON.stringify(body) });
      if (route.startsWith("video-")) {
        if (result.job) videoTasks.video = { ...videoTasks.video, job: result.job };
        if (result.capabilities) videoTasks.video = { ...videoTasks.video, capabilities: result.capabilities };
      } else if (result.job) videoTasks.cache = { ...videoTasks.cache, job: result.job };
      await pollVideoTasks(true);
    } catch (error) { toast(error.message, "error"); }
    finally { videoTasks.requesting = false; renderVideoTasks(); }
  }
  async function saveVideoSettings(patch) {
    const previous = state.config.video, version = ++videoTasks.settingsVersion;
    const next = { ...previous, ...patch }; state.config.video = next;
    videoTasks.settingsSaving++; renderVideoTasks();
    try {
      await persistConfig({ video: next });
      if (version !== videoTasks.settingsVersion) return;
      await loadInventory(); const project = currentProject(); if (project) await showProjectMedia(project);
    } catch (error) {
      let confirmed = null;
      if (version === videoTasks.settingsVersion) confirmed = (await api("config").catch(() => null))?.config?.video;
      if (version === videoTasks.settingsVersion) {
        state.config.video = confirmed || previous;
        const saved = confirmed && Object.entries(next).every(([key, value]) => confirmed[key] === value);
        setSaveState("error", saved ? "设置已落盘，应用未确认" : confirmed ? "设置未保存" : "保存状态未确认");
        toast(saved ? "视频设置已保存，但宿主应用未确认；原播放不会因转码任务自动切换。" : error.message, "error");
      }
    } finally { videoTasks.settingsSaving--; renderVideoTasks(); }
  }

  async function loadLibraryDirectory() {
    const payload = await api("library");
    elements.directoryText.textContent = `实际资源目录：${payload.directory}`;
    elements.directoryText.title = payload.directory;
  }

  function activePlaylist() {
    return state.config.playlists?.items.find((item) => item.id === state.config.playlists.activeId);
  }

  function renderPlaylistStatus(status = {}) {
    const labels = { running: "轮播运行中", stopped: "轮播已停止", paused: "用户已暂停", insufficient: "合法候选不足两张，保留当前画面", busy: "资源任务进行中，暂缓轮播", error: "轮播未完成，请重试" };
    $("#playlistStatusText").textContent = `${labels[status.state] ?? "正在读取"}${status.failedIds?.length ? ` · 跳过 ${status.failedIds.length} 项` : ""}${status.error ? ` · ${status.error}` : ""}`;
  }

  function renderPlaylists() {
    const lists = state.config.playlists;
    if (!lists) return;
    for (const control of $$('#playlistTools input, #playlistTools select, #playlistTools button')) {
      control.disabled = state.playlistBusy || state.libraryBusy;
    }
    const select = $("#playlistSelect"); select.replaceChildren();
    for (const item of lists.items) {
      const option = document.createElement("option"); option.value = item.id;
      option.textContent = `${item.name} (${item.ids.length})`; select.append(option);
    }
    select.value = lists.activeId ?? "";
    $("#playlistEnabledInput").checked = lists.enabled;
    $("#playlistOrderSelect").value = lists.order;
    $("#playlistIntervalInput").value = lists.intervalSeconds;
    const entries = $("#playlistEntries"); entries.replaceChildren();
    const item = activePlaylist();
    for (const [index, id] of (item?.ids ?? []).entries()) {
      const li = document.createElement("li"); const label = document.createElement("span");
      const project = state.inventory.find((project) => project.id === id);
      label.textContent = `${index + 1}. ${project?.title ?? "已失效项目"}${project?.eligible === false ? "（规则排除）" : ""}`;
      label.title = label.textContent; li.append(label);
      for (const [text, delta] of [["↑", -1], ["↓", 1], ["移除", 0]]) {
        const button = document.createElement("button"); button.type = "button"; button.textContent = text;
        button.disabled = state.playlistBusy || state.libraryBusy || (delta !== 0 && (index + delta < 0 || index + delta >= item.ids.length));
        button.addEventListener("click", () => {
          const ids = [...item.ids];
          if (delta === 0) ids.splice(index, 1);
          else [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
          void playlistOperation({ action: "update", id: item.id, ids });
        }); li.append(button);
      }
      entries.append(li);
    }
    for (const button of [$("#playlistRenameButton"), $("#playlistDeleteButton"), $("#playlistAddCurrentButton"), $("#playlistAddMarkedButton"), $("#playlistNextButton")]) button.disabled = !item || state.playlistBusy || state.libraryBusy;
    $("#playlistEnabledInput").disabled ||= !item;
  }

  async function loadPlaylists() {
    const payload = await api("playlists");
    state.config.playlists = payload.config.playlists;
    renderPlaylists(); renderPlaylistStatus(payload.status);
    preloadWorkbenchScene(payload.status?.nextId);
  }

  async function playlistOperation(body, next = false) {
    if (state.playlistBusy || state.libraryBusy) return;
    state.playlistBusy = true; window.__cwbPlaylistBusy = true;
    renderPlaylists();
    try {
      window.clearTimeout(state.saveTimer);
      await persistConfig();
      if (typeof body === "function") body = await body();
      const result = await api(next ? "playlists/next" : "playlists/manage", { method: "POST", body: JSON.stringify(body) });
      state.config = { ...state.config, ...result.config };
      await syncServerPlayback(result);
      if (body.action === "import") toast(`WE 列表已导入，未匹配 ${result.unmatchedCount} 项`);
    } catch (error) { toast(error.message, "error"); await loadPlaylists().catch(() => {}); }
    finally { state.playlistBusy = false; window.__cwbPlaylistBusy = false; renderPlaylists(); }
  }

  async function syncServerPlayback(payload) {
    renderPlaylistStatus(payload.status);
    if (!state.effectsDirty) {
      state.effects = normalizeEffects({ ...payload.config.effects, onBattery: systemMediaSnapshot?.power.onBattery === true });
      // Older/lightweight responses may omit media. Absence is not a request
      // to disable a preference; merge only known, explicitly supplied booleans.
      const media = payload.config.media;
      if (media && typeof media === "object" && !Array.isArray(media)) {
        state.config.media = { ...state.config.media };
        for (const key of ["captureAudio", "nowPlaying", "allowControl", "onlineLyrics"]) {
          if (typeof media[key] === "boolean") state.config.media[key] = media[key];
        }
      }
      renderEffects();
    }
    const id = payload.config.selectedId;
    if (id === state.selectedId) { updateNowPlaying(); preloadWorkbenchScene(payload.status?.nextId); return; }
    const resultPromise = showProjectMedia(state.inventory.find((p) => p.id === id));
    const revision = state.mediaRevision;
    const result = await resultPromise;
    if (revision !== state.mediaRevision || result.cancelled) return;
    if (result.ok) {
      state.selectedId = id;
      state.config.selectedId = id;
      renderInventory(); updateNowPlaying();
      preloadWorkbenchScene(payload.status?.nextId);
    } else {
      // Never label the old frame as the newly requested selection. The server validates
      // the receipt in its write queue, so an old/ABA failure cannot undo a newer choice.
      const recovered = await api("playlists/failed", { method: "POST", body: JSON.stringify({ selectedId: id, revision: payload.revision }) });
      if (revision === state.mediaRevision) await syncServerPlayback(recovered);
    }
  }

  function systemLyricsStatusText(lyric, enabled) {
    if (!enabled) return '歌词：先启用歌曲读取';
    if (lyric?.state === 'ready') return `歌词：${lyric.source === 'local' ? '本地 LRC' : lyric.source === 'online' ? '在线同步歌词' : '已加载'}`;
    return ({ waiting: '歌词：等待当前歌曲', loading: '歌词：读取中', off: '歌词：在线查询未启用，可导入本地 LRC',
      not_found: '歌词：未找到同步歌词，可导入本地 LRC', unavailable: '歌词：读取失败，可导入本地 LRC' })[lyric?.state] || '歌词：等待当前歌曲';
  }

  let systemMediaSnapshot = null, systemMediaPolling = false, systemMediaClosed = false, nextSystemMediaPoll = 0;
  async function pollSystemMedia() {
    if (systemMediaPolling || systemMediaClosed || !state.connected || document.hidden) return;
    if (Date.now() < nextSystemMediaPoll) return;
    nextSystemMediaPoll = Date.now() + (state.config.media?.captureAudio ? 100 : 1000);
    systemMediaPolling = true; const revision = state.mediaRevision;
    try {
      const snapshot = await api("media", { signal: AbortSignal.timeout(3000) });
      if (systemMediaClosed) return;
      const powerChanged = state.effects.onBattery !== (snapshot.power.onBattery === true);
      systemMediaSnapshot = snapshot;
      state.effects.onBattery = snapshot.power.onBattery === true;
      if (powerChanged) { previewSwitcher.update(); playVideoIfNeeded(); updateNowPlaying(); }
      const policy = cwbMedia.resolvePlayback(state.effects, { hidden: document.hidden === true });
      $("#playbackPolicyStatus").textContent = policy.playing ? "壁纸播放中" : `壁纸暂停：${policy.reasons.map(value => ({ user: "手动", hidden: "窗口隐藏", battery: "电池供电" })[value] || value).join("、")}`;
      $("#systemMediaStatus").textContent = `频谱：${snapshot.sources.audio}；媒体：${snapshot.sources.media}`;
      $("#systemMediaTrack").textContent = snapshot.track ? `${snapshot.track.title} — ${snapshot.track.artist} (${Math.floor(snapshot.track.position)}/${Math.floor(snapshot.track.duration)}秒)` : "没有当前歌曲";
      $("#systemMediaLyrics").textContent = snapshot.lyric.text;
      $("#systemLyricsStatus").textContent = systemLyricsStatusText(snapshot.lyric, state.config.media?.nowPlaying === true);
      const cover = $("#systemMediaCover"), thumbnail = snapshot.inputs.find(input => input.op === "mediaThumbnail")?.value.thumbnail;
      if (thumbnail) { if (cover.getAttribute("src") !== thumbnail) cover.src = thumbnail; cover.hidden = false; }
      else { cover.removeAttribute("src"); cover.hidden = true; }
      for (const button of $$('[data-media-command]')) button.disabled = !snapshot.commands.includes(button.dataset.mediaCommand);
      if (revision !== state.mediaRevision || !policy.playing || document.hidden) return;
      const slot = activeSceneSlot?.projectId === state.selectedId ? activeSceneSlot : null;
      for (const input of snapshot.inputs) slot?.input?.(input);
      slot?.input?.({ op: "mediaStatus", value: { enabled: Boolean(snapshot.track) } });
      slot?.input?.({ op: "mediaCapabilities", value: { sessionId: snapshot.sessionId, commands: snapshot.commands } });
      slot?.input?.({ op: "lyrics", value: { text: snapshot.lyric.text, next: snapshot.lyric.next } });
    } catch { /* A media source may be unavailable; never substitute fixture music. */ }
    finally { systemMediaPolling = false; }
  }

  async function pollPlayback() {
    if (state.playbackPolling || !state.connected || state.libraryBusy || state.playlistBusy || state.effectsDirty
      || state.sceneSelectingId || state.previewLoadingRevision !== null) return;
    state.playbackPolling = true;
    const mediaRevision = state.mediaRevision, saveRevision = state.saveRevision;
    try {
      const payload = await api("playlists?state=1");
      if (state.libraryBusy || state.playlistBusy || state.effectsDirty || state.sceneSelectingId
        || mediaRevision !== state.mediaRevision || saveRevision !== state.saveRevision) return;
      await syncServerPlayback(payload);
    } catch { /* A disconnected service is surfaced by actions; do not spam polling errors. */ }
    finally { state.playbackPolling = false; }
  }

  async function libraryOperation(operation) {
    if (state.libraryBusy) return;
    state.libraryBusy = true;
    window.clearTimeout(scenePreloadTimer); forgetWorkbenchPreload(true);
    scenePreloadRequest = null; void requestScenePreload(null);
    hideError();
    state.cancelBatch = false;
    window.clearTimeout(state.saveTimer);
    renderInventory();
    updateNowPlaying();
    try {
      await persistConfig();
      setSaveState("saving", "资源任务进行中…");
      await operation();
      state.markedIds.clear();
      await loadConfig();
      await loadInventory();
      showProjectMedia(currentProject());
      await loadLibraryDirectory();
      setSaveState("saved", "资源设置已保存");
    } catch (error) {
      // A host-sync error can happen after a disk commit; re-read, never assume rollback.
      await loadConfig().catch(() => {});
      await loadInventory().catch(() => {});
      showProjectMedia(currentProject());
      setSaveState("error", "资源操作未完成");
      showError("资源操作未完成", error.message);
    } finally {
      state.libraryBusy = false;
      state.activeJobId = null;
      elements.cancelTask.disabled = true;
      renderInventory();
      updateNowPlaying();
    }
  }

  function manageLibrary(action, ids = [], extra = {}) {
    return libraryOperation(async () => {
      const payload = await api("library/manage", { method: "POST", body: JSON.stringify({ action, ids, ...extra }) });
      toast(payload.cleanupPending ? "已移除索引，磁盘清理未完成；保留文件待处理" : "资源设置已保存");
    });
  }

  function confirmLibrary(message) {
    // Native window.confirm is blocked by the desktop iframe's sandbox.
    const dialog = elements.confirmDialog;
    if (dialog.open) return Promise.resolve(false);
    elements.confirmMessage.textContent = message;
    dialog.returnValue = "cancel";
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
      dialog.showModal();
    });
  }

  function paintJob(job, label) {
    elements.assetTask.hidden = false;
    elements.taskProgress.max = Math.max(job.total, 1);
    elements.taskProgress.value = job.bytes;
    elements.taskText.textContent = `${label} · ${Math.round(job.bytes / Math.max(job.total, 1) * 100)}% · ${job.status}`;
    elements.cancelTask.disabled = !job.cancellable;
  }

  async function importFiles(files) {
    if (!files.length) return;
    const rating = elements.importRating.value;
    return libraryOperation(async () => {
      let completed = 0;
      for (const file of files) {
        if (state.cancelBatch) break;
        const { job } = await api("library/jobs", { method: "POST",
          body: JSON.stringify({ kind: "import", filename: file.name, size: file.size, rating }) });
        state.activeJobId = job.id;
        paintJob(job, file.name);
        let polling = false;
        const timer = window.setInterval(async () => {
          if (polling) return;
          polling = true;
          try { const payload = await api(`library/jobs/${job.id}`); if (state.activeJobId === job.id) paintJob(payload.job, file.name); }
          catch { /* Upload response remains authoritative if a progress read fails. */ }
          finally { polling = false; }
        }, 500);
        try {
          if (state.cancelBatch) await api(`library/jobs/${job.id}/cancel`, { method: "POST", body: "{}" });
          // File/Blob is streamed by Chromium; no arrayBuffer/Base64 is created.
          const payload = await api(`library/jobs/${job.id}/content`, {
            method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file,
          });
          paintJob(payload.job, file.name);
          if (payload.job.status === "cancelled") { state.cancelBatch = true; break; }
          if (payload.job.status !== "completed") throw new Error(payload.job.error || "导入失败");
          completed += 1;
        } catch (error) {
          await api(`library/jobs/${job.id}/cancel`, { method: "POST", body: "{}" }).catch(() => {});
          if (state.cancelBatch) {
            const payload = await api(`library/jobs/${job.id}`).catch(() => null);
            if (payload) paintJob(payload.job, file.name);
            break;
          }
          throw new Error(`已完成 ${completed} / ${files.length} 个；${file.name} 未完成：${error.message}`);
        } finally {
          window.clearInterval(timer);
          state.activeJobId = null;
        }
      }
      toast(`${state.cancelBatch ? "已取消后续导入" : "导入完成"}：${completed} / ${files.length} 个`);
    });
  }

  async function migrateLibrary() {
    const directory = elements.directoryInput.value.trim();
    if (!directory || !await confirmLibrary("复制已导入资源并切换目录？旧目录保留用于回退，未知文件和 WE 源文件不动。")) return;
    return libraryOperation(async () => {
      const { job } = await api("library/jobs", { method: "POST", body: JSON.stringify({ kind: "migrate", directory }) });
      state.activeJobId = job.id;
      let current = job;
      const deadline = Date.now() + 24 * 60 * 60 * 1000;
      while (!["completed", "failed", "cancelled"].includes(current.status) && Date.now() < deadline) {
        paintJob(current, "资源目录迁移");
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        current = (await api(`library/jobs/${job.id}`)).job;
      }
      paintJob(current, "资源目录迁移");
      if (current.status !== "completed") {
        await api(`library/jobs/${job.id}/cancel`, { method: "POST", body: "{}" }).catch(() => {});
        throw new Error(current.error || "迁移已取消或超时，原目录仍有效");
      }
      toast("目录已切换；旧文件保留供回退");
    });
  }

  async function invokeAction(action, extra = {}) {
    return api("action", {
      method: "POST",
      body: JSON.stringify({ action, ...extra }),
    });
  }

  async function rescan() {
    window.clearTimeout(scenePreloadTimer); forgetWorkbenchPreload(true);
    scenePreloadRequest = null;
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

  async function retryEngine() {
    const project = currentProject(); if (!project || !["scene", "web"].includes(project.type) || state.sceneSelectingId || state.previewLoadingRevision !== null) return;
    setBusy(elements.engineRetryButton, true);
    try {
      const preview = project.scenePreviewAvailable ? await showProjectMedia(project, { force: true }) : null;
      if (preview && !preview.ok) throw new Error("工作台 Scene 预览重试未就绪，已保留原画面。");
      // A local preview retry must not implicitly attach to an unrelated Codex.
      const payload = state.injected ? await invokeAction("retry-engine", { projectId: project.id }) : null;
      toast(responseMessage(payload, "工作台场景已重新加载；Codex 宿主状态单独验收"));
    } catch (error) { showError("场景重试未完成", error.message); }
    finally { setBusy(elements.engineRetryButton, false); }
  }

  async function restoreCodex() {
    setBusy(elements.restoreButton, true);
    setConnection("loading", "正在恢复", "移除 Codex 背景与视觉效果");
    try {
      const payload = await invokeAction("restore");
      state.injected = false;
      await loadPlaylists();
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
      ...state.effects,
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
    $("#videoOptimizationPanel").addEventListener("toggle", () => void pollVideoTasks(true));
    window.setInterval(() => void pollVideoTasks(), 1000);
    for (const control of $$('[data-video]')) control.addEventListener("change", () => {
      const value = control.type === "checkbox" ? control.checked : control.dataset.video === "fpsCap" ? Number(control.value) : control.value;
      void saveVideoSettings({ [control.dataset.video]: value });
    });
    $("#probeVideoToolsButton").addEventListener("click", () => void videoTaskOperation("video-tools/probe"));
    $("#optimizeVideoButton").addEventListener("click", () => {
      const project = currentProject(); if (project?.type !== "video") return;
      void videoTaskOperation("video-jobs", { id: project.id, options: { fpsCap: state.config.video?.fpsCap ?? 30, encoder: state.config.video?.encoder ?? "auto" } });
    });
    for (const [id, kind, action] of [["cancelVideoJobButton", "video-jobs", "cancel"], ["retryVideoJobButton", "video-jobs", "retry"],
      ["cancelCacheJobButton", "cache/jobs", "cancel"], ["retryCacheJobButton", "cache/jobs", "retry"]]) $("#" + id).addEventListener("click", () => {
      const job = (kind === "video-jobs" ? videoTasks.video : videoTasks.cache)?.job;
      if (job) void videoTaskOperation(`${kind}/${job.id}/${action}`);
    });
    $("#applyOptimizedVideoButton").addEventListener("click", () => {
      const job = videoTasks.video?.job;
      if (job?.status === "completed" && job.projectId === currentProject()?.id) void saveVideoSettings({ ...job.options, useOptimized: true });
    });
    $("#migrateCacheButton").addEventListener("click", async () => {
      const directory = $("#cacheDirectoryInput").value.trim();
      if (directory && await confirmLibrary("仅复制受管缓存并校验、切换目录，保留源缓存及未知文件。继续？")) void videoTaskOperation("cache/jobs", { directory });
    });
    $("#resumeCacheJobButton").addEventListener("click", () => void videoTaskOperation("cache/resume"));
    $("#playlistCreateButton").addEventListener("click", () => playlistOperation({ action: "create", name: $("#playlistNameInput").value || "新列表" }));
    $("#playlistRenameButton").addEventListener("click", () => playlistOperation({ action: "update", id: activePlaylist()?.id, name: $("#playlistNameInput").value }));
    $("#playlistDeleteButton").addEventListener("click", async () => {
      if (await confirmLibrary("仅删除播放列表，不删除任何壁纸文件。继续？")) await playlistOperation({ action: "delete", id: activePlaylist()?.id });
    });
    for (const [id, marked] of [["playlistAddCurrentButton", false], ["playlistAddMarkedButton", true]]) $("#" + id).addEventListener("click", () => {
      const item = activePlaylist(); if (!item) return;
      const added = marked ? [...state.markedIds] : [state.selectedId].filter(Boolean);
      void playlistOperation({ action: "update", id: item.id, ids: [...new Set([...item.ids, ...added])] });
    });
    $("#playlistSelect").addEventListener("change", () => playlistOperation({ action: "settings", activeId: $("#playlistSelect").value }));
    $("#playlistEnabledInput").addEventListener("change", () => playlistOperation({ action: "settings", enabled: $("#playlistEnabledInput").checked }));
    $("#playlistOrderSelect").addEventListener("change", () => playlistOperation({ action: "settings", order: $("#playlistOrderSelect").value }));
    $("#playlistIntervalInput").addEventListener("change", () => playlistOperation({ action: "settings", intervalSeconds: Number($("#playlistIntervalInput").value) }));
    $("#playlistNextButton").addEventListener("click", () => playlistOperation({}, true));
    $("#playlistRetryButton").addEventListener("click", () => playlistOperation({ action: "retry" }));
    $("#playlistImportButton").addEventListener("click", () => $("#playlistImportInput").click());
    $("#playlistImportInput").addEventListener("change", async () => {
      const file = $("#playlistImportInput").files[0]; $("#playlistImportInput").value = "";
      if (!file) return;
      if (file.size > 512 * 1024) { toast("WE JSON 超过 512 KiB 上限", "error"); return; }
      await playlistOperation(async () => ({ action: "import", value: await file.text() }));
    });
    window.setInterval(() => void pollPlayback(), 1500);
    window.setInterval(() => void pollSystemMedia(), 100);
    for (const control of $$('[data-media]')) control.addEventListener("change", () => {
      state.config.media = { ...state.config.media, [control.dataset.media]: control.checked }; scheduleConfigSave();
    });
    for (const button of $$('[data-media-command]')) button.addEventListener("click", async () => {
      const sessionId = systemMediaSnapshot?.sessionId; button.disabled = true;
      try { await api("media/control", { method: "POST", body: JSON.stringify({ command: button.dataset.mediaCommand, sessionId }) }); }
      catch { toast("播放器控制不可用或当前播放器已切换", "error"); }
      finally { void pollSystemMedia(); }
    });
    $("#systemLyricsInput")?.addEventListener("change", async () => {
      const input = $("#systemLyricsInput"), file = input.files[0], snapshot = systemMediaSnapshot; input.value = "";
      if (!file || !snapshot?.trackKey) return;
      if (file.size > 131072) { toast("歌词超过 128 KiB 上限", "error"); return; }
      try { await api("media/lyrics", { method: "POST", body: JSON.stringify({ lrc: await file.text(), sessionId: snapshot.sessionId, trackKey: snapshot.trackKey }) }); toast("本地歌词已保存"); }
      catch { toast("歌词保存失败或歌曲已切换", "error"); }
    });
    for (const control of $$('[data-effect]')) {
      control.addEventListener(control.type === "checkbox" ? "change" : "input", () => {
        const key = control.dataset.effect;
        if (control.type === "checkbox") state.effects[key] = control.checked;
        else if (control.tagName === "SELECT") state.effects[key] = control.value;
        else {
          if (control.value === "" || !Number.isFinite(Number(control.value))) return;
          state.effects[key] = clamp(control.value, Number(control.min), Number(control.max), state.effects[key]);
        }
        if (key === "positionX" || key === "positionY") {
          state.effects.position = `${state.effects.positionX}% ${state.effects.positionY}%`;
        }
        state.playRejectedRevision = -1;
        renderEffects();
        scheduleConfigSave();
      });
    }
    elements.searchInput.addEventListener("input", () => {
      state.query = elements.searchInput.value;
      state.libraryPage = 1;
      renderInventory();
    });

    elements.typeFilters.addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]");
      if (!button) return;
      state.filter = button.dataset.filter;
      state.libraryPage = 1;
      $$(".filter-chip").forEach((chip) => chip.classList.toggle("is-active", chip === button));
      renderInventory();
    });

    elements.importButton.addEventListener("click", () => elements.importInput.click());
    elements.importInput.addEventListener("change", () => {
      const files = [...elements.importInput.files];
      elements.importInput.value = "";
      void importFiles(files);
    });
    elements.hiddenView.addEventListener("change", () => {
      state.hiddenView = elements.hiddenView.checked;
      state.libraryPage = 1;
      state.markedIds.clear();
      renderInventory();
    });
    elements.batchHide.addEventListener("click", () => manageLibrary(state.hiddenView ? "restore" : "hide", [...state.markedIds]));
    elements.restoreAll.addEventListener("click", () => manageLibrary("restore-all"));
    elements.ratingPolicy.addEventListener("change", () => {
      const allowedRatings = [...elements.ratingPolicy.querySelectorAll("input:checked")].map((input) => input.value);
      void libraryOperation(() => api("config", { method: "POST", body: JSON.stringify({ library: { allowedRatings } }) }));
    });
    elements.migrateButton.addEventListener("click", migrateLibrary);
    elements.cancelTask.addEventListener("click", async () => {
      state.cancelBatch = true;
      elements.cancelTask.disabled = true;
      if (state.activeJobId) {
        try { const payload = await api(`library/jobs/${state.activeJobId}/cancel`, { method: "POST", body: "{}" }); paintJob(payload.job, "取消任务"); }
        catch (error) { toast(error.message, "error"); }
      }
    });
    elements.moreWallpapers.addEventListener("click", () => { state.libraryPage += 1; renderInventory(); });

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
      state.effects = normalizeEffects(state.defaultEffects);
      renderEffects();
      scheduleConfigSave();
      toast("显示设置已重置");
    });

    elements.injectButton.addEventListener("click", injectCodex);
    elements.engineRetryButton.addEventListener("click", retryEngine);
    elements.engineFallbackSelect?.addEventListener("change", async () => {
      const project = currentProject(), select = elements.engineFallbackSelect;
      if (!project || !["scene", "web"].includes(project.type) || state.libraryBusy) return;
      const map = { ...state.config.engineFallbacks };
      if (select.value) map[project.id] = { staticId: select.value }; else delete map[project.id];
      select.disabled = true;
      try { await persistConfig({ engineFallbacks: map }); toast("静态回退已保存"); }
      catch (error) { toast(error.message, "error"); }
      finally { updateNowPlaying(); }
    });
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
      void pollSystemMedia();
      if (document.hidden) window.clearTimeout(scenePreloadTimer);
      previewSwitcher.update();
      playVideoIfNeeded();
    });
    window.addEventListener("pagehide", () => {
      videoTasks.closed = true;
      systemMediaClosed = true;
      window.clearTimeout(scenePreloadTimer); forgetWorkbenchPreload(); previewSwitcher.close();
    });
  }

  elements.backgroundPlaceholder.classList.add("is-visible");
  elements.injectButton.disabled = true;
  bindEvents();
  renderEffects();
  initialize();
})();
