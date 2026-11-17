var cwbScenePreview = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // bridge-runtime/src/workbench-scene-preview.mjs
  var workbench_scene_preview_exports = {};
  __export(workbench_scene_preview_exports, {
    createScenePreviewSlot: () => createScenePreviewSlot
  });

  // bridge-runtime/src/author-properties.mjs
  function validateAuthorPropertyPatch(schema, patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return null;
    const entries = Object.entries(patch);
    if (entries.length > 256) return null;
    const result = {};
    for (const [key, value] of entries) {
      if (["__proto__", "prototype", "constructor"].includes(key) || !Object.hasOwn(schema, key)) return null;
      const spec = schema[key];
      if (spec.type === "bool") {
        if (typeof value !== "boolean") return null;
      } else if (spec.type === "slider") {
        if (typeof value !== "number" || !Number.isFinite(value) || value < spec.min || value > spec.max || spec.integer && !Number.isInteger(value)) return null;
      } else if (spec.type === "color") {
        if (typeof value !== "string" || value.length > 96) return null;
        const components = value.trim().split(/\s+/);
        if (components.length !== 3 || components.some((n) => !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(n) || !Number.isFinite(Number(n)) || Number(n) < 0 || Number(n) > 1)) return null;
      } else if (spec.type === "combo") {
        if (!spec.options.some((option) => option.value === value)) return null;
      } else if (spec.type === "textinput") {
        if (typeof value !== "string" || value.length > 1024 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) return null;
      } else if (spec.type === "file" || spec.type === "directory") {
        if (typeof value !== "string" || value.length > 512) return null;
        if (value !== "" && value !== spec.default) {
          if (spec.type === "directory") {
            if (!/^cwb-author-directories\/[a-f0-9]{32}-[a-f0-9]{32}-[a-f0-9]{64}\.json$/.test(value)) return null;
          } else {
            const match = /^cwb-author-files\/[a-f0-9]{32}-[a-f0-9]{32}-[a-f0-9]{64}(\.[a-z0-9]+)$/.exec(value);
            if (!match || !spec.extensions?.includes(match[1])) return null;
          }
        }
      } else return null;
      result[key] = value;
    }
    return result;
  }
  function readAuthorProperties(schema, actual, validate) {
    const values = {};
    let rejected = 0;
    for (const [key, spec] of Object.entries(schema)) {
      if (!actual || !Object.hasOwn(actual, key)) {
        rejected++;
        continue;
      }
      let value = actual[key];
      if (spec.type === "color" && value && typeof value === "object" && !Array.isArray(value) && ["x", "y", "z"].every((axis) => typeof value[axis] === "number" && Number.isFinite(value[axis]))) {
        value = [value.x, value.y, value.z];
      }
      if (spec.type === "color" && Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n))) value = value.join(" ");
      const valid = validate({ [key]: spec }, { [key]: value });
      if (valid) values[key] = valid[key];
      else rejected++;
    }
    return { values, rejected };
  }

  // bridge-runtime/src/web-wallpaper-input.mjs
  function validateWebWallpaperInput(input) {
    const object = (value) => value && typeof value === "object" && !Array.isArray(value);
    const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
    const optionalKeys = (value, required, optional) => object(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
    if (input?.op === "audio" && keys(input, ["op", "values"]) && Array.isArray(input.values) && input.values.length === 128 && Array.from(input.values).every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)) {
      return { op: "audio", values: input.values.slice() };
    }
    const media = input?.value;
    if (input?.op === "lyrics" && keys(input, ["op", "value"]) && keys(media, ["text", "next"]) && [media.text, media.next].every((value) => typeof value === "string" && value.length <= 512)) return { op: "lyrics", value: { ...media } };
    if (input?.op === "mediaCapabilities" && keys(input, ["op", "value"]) && keys(media, ["sessionId", "commands"]) && typeof media.sessionId === "string" && (media.sessionId === "" || /^[a-f0-9]{32}$/.test(media.sessionId)) && Array.isArray(media.commands) && media.commands.length <= 4 && media.commands.every((value) => ["play", "pause", "previous", "next"].includes(value)) && (media.sessionId !== "" || media.commands.length === 0)) return { op: "mediaCapabilities", value: { sessionId: media.sessionId, commands: [...new Set(media.commands)] } };
    if (input?.op === "media" && keys(input, ["op", "value"]) && optionalKeys(media, ["state", "title", "artist", "album", "position", "duration"], ["albumArtist", "albumTitle", "subTitle", "genres", "contentType"]) && ["playing", "paused", "stopped"].includes(media.state) && ["title", "artist", "album"].every((key) => typeof media[key] === "string" && media[key].length <= 512) && [media.position, media.duration].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86400) && media.position <= media.duration && ["albumArtist", "albumTitle", "subTitle", "genres"].every((key) => !Object.hasOwn(media, key) || typeof media[key] === "string" && media[key].length <= 512) && (!Object.hasOwn(media, "contentType") || ["music", "video", "image"].includes(media.contentType))) {
      return { op: "media", value: {
        state: media.state,
        title: media.title,
        artist: media.artist,
        album: media.album,
        position: media.position,
        duration: media.duration,
        ...Object.fromEntries(["albumArtist", "albumTitle", "subTitle", "genres", "contentType"].filter((key) => Object.hasOwn(media, key)).map((key) => [key, media[key]]))
      } };
    }
    if (input?.op === "mediaStatus" && keys(input, ["op", "value"]) && keys(media, ["enabled"]) && typeof media.enabled === "boolean") {
      return { op: "mediaStatus", value: { enabled: media.enabled } };
    }
    if (input?.op === "mediaThumbnail" && keys(input, ["op", "value"]) && optionalKeys(media, ["thumbnail"], ["primaryColor", "secondaryColor", "tertiaryColor", "textColor", "highContrastColor"]) && Object.entries(media).every(([key, value]) => key === "thumbnail" || typeof value === "string" && /^#[a-fA-F0-9]{6}$/.test(value))) {
      const value = media.thumbnail;
      if (value === "") return { op: "mediaThumbnail", value: { ...media } };
      const match = typeof value === "string" && value.length <= 43720 && /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
      if (match && match[2].length % 4 === 0) {
        let bytes;
        try {
          bytes = atob(match[2]);
        } catch {
          throw TypeError("web_input_invalid");
        }
        const n = bytes.length, u8 = (offset) => bytes.charCodeAt(offset);
        const u32 = (offset) => u8(offset) * 16777216 + u8(offset + 1) * 65536 + u8(offset + 2) * 256 + u8(offset + 3);
        const le32 = (offset) => u8(offset) + u8(offset + 1) * 256 + u8(offset + 2) * 65536 + u8(offset + 3) * 16777216;
        const positiveSize = (width, height) => width > 0 && height > 0 && width <= 2048 && height <= 2048;
        const valid = match[1] === "png" ? n >= 45 && bytes.slice(0, 8) === "\x89PNG\r\n\n" && u32(8) === 13 && bytes.slice(12, 16) === "IHDR" && positiveSize(u32(16), u32(20)) && bytes.slice(-12) === "\0\0\0\0IEND\xAEB`\x82" : match[1] === "jpeg" ? n >= 4 && bytes.slice(0, 3) === "\xFF\xD8\xFF" && bytes.slice(-2) === "\xFF\xD9" : match[1] === "gif" ? n >= 14 && ["GIF87a", "GIF89a"].includes(bytes.slice(0, 6)) && positiveSize(u8(6) + u8(7) * 256, u8(8) + u8(9) * 256) && bytes.slice(-1) === ";" : n >= 20 && bytes.slice(0, 4) === "RIFF" && le32(4) + 8 === n && bytes.slice(8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.slice(12, 16));
        if (n <= 32768 && valid) return { op: "mediaThumbnail", value: { ...media } };
      }
    }
    throw TypeError("web_input_invalid");
  }

  // bridge-runtime/src/playback-policy.mjs
  function resolvePlayback(effects = {}, environment = {}) {
    const reasons = [];
    if (effects.playing === false) reasons.push("user");
    if (environment.hidden === true && effects.pauseWhenHidden !== false) reasons.push("hidden");
    if ((environment.onBattery ?? effects.onBattery) === true && effects.pauseOnBattery === true) reasons.push("battery");
    if (environment.inactive === true) reasons.push("inactive");
    return { userPlaying: effects.playing !== false, playing: reasons.length === 0, reasons };
  }

  // bridge-runtime/src/workbench-scene-preview.mjs
  function createScenePreviewSlot({
    node,
    project,
    client,
    api,
    getEffects,
    onStatus = () => {
    },
    beforeOpen = async () => {
    },
    window = globalThis,
    preserveOnFailure = false,
    readback = readAuthorProperties,
    validate = validateAuthorPropertyPatch,
    validateInput = validateWebWallpaperInput,
    playback = resolvePlayback,
    onMediaControl = null
  }) {
    let descriptor, released = false, committed = false, prepared = false, failed = false, closing;
    let sequence = 0, meter = null, startupTimer, renewalTimer, healthTimer, lastMessage = Date.now();
    let resolveReady, rejectReady;
    let propertyRequest = 0, propertyPending = null;
    let pointerDown = false;
    let lastControlRequest = 0, controlPending = 0;
    let pointerReceived = 0, pointerForwarded = 0, pointerBlocked = "none";
    const isWeb = project.type === "web";
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => {
    });
    const capability = (value) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
    const request = (op, extra = {}) => api("scene-preview", {
      method: "POST",
      keepalive: op === "close",
      body: JSON.stringify({ op, client, ...extra })
    });
    const send = (op, extra = {}) => {
      if (!descriptor || released || !node.contentWindow) return;
      node.contentWindow.postMessage({ source: isWeb ? "cwb-web-control" : "cwb-scene-control", channel: descriptor.channel, op, ...extra }, descriptor.origin);
    };
    const publish = (phase, reason) => {
      node.dataset.cwbScenePhase = phase;
      if (meter) {
        node.dataset.cwbSceneWidth = String(meter.width);
        node.dataset.cwbSceneHeight = String(meter.height);
        node.dataset.cwbSceneFps = String(meter.fps);
      }
      onStatus({ phase, active: committed, ...reason ? { reason } : {}, ...meter });
    };
    const update = () => {
      if (!prepared || released || failed) return;
      const effects = getEffects();
      const playing = playback(effects, { hidden: window.document?.hidden === true, inactive: !committed }).playing;
      if (!playing) pointerDown = false;
      const fit = ["cover", "contain", "fill"].includes(effects.fit) ? effects.fit : "cover";
      send("fit", { value: fit });
      send("volume", { value: playing && effects.audioEnabled === true ? Math.max(0, Math.min(100, Number(effects.volume) || 0)) / 100 : 0 });
      send("loopHold", { value: Math.max(0, Math.min(3600, Math.round(Number(effects.webLoopHoldSeconds) || 0))) });
      send("forceSingleLoop", { value: effects.webForceSingleLoop === true });
      send(playing ? "resume" : "pause");
    };
    const onVisibility = () => {
      lastMessage = Date.now();
      update();
    };
    const onPagehide = () => {
      void release();
    };
    const onPointer = (event) => {
      pointerReceived = Math.min(1e9, pointerReceived + 1);
      pointerBlocked = !committed ? "inactive" : released ? "released" : failed ? "failed" : !prepared ? "unprepared" : window.document?.hidden ? "hidden" : !playback(getEffects()).playing ? "paused" : "none";
      if (pointerBlocked !== "none") return;
      if (event.type !== "pointermove" && event.target?.closest?.('button,input,select,textarea,a,summary,[role="button"],[contenteditable]')) {
        if (event.type === "pointerup" && pointerDown) {
          pointerDown = false;
          send("pointerLeave");
        }
        pointerBlocked = "control";
        return;
      }
      const rect = node.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) {
        pointerBlocked = "geometry";
        return;
      }
      let u = (event.clientX - rect.left) / rect.width, v = (event.clientY - rect.top) / rect.height;
      if (![u, v].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
        pointerBlocked = "outside";
        pointerDown = false;
        send("pointerLeave");
        return;
      }
      if (event.type === "pointerdown") pointerDown = (event.buttons & 1) === 1;
      if (event.type === "pointerup") pointerDown = false;
      if (getEffects().mirror) u = 1 - u;
      pointerForwarded = Math.min(1e9, pointerForwarded + 1);
      send("pointer", {
        u,
        v,
        buttons: pointerDown ? event.buttons & 1 : 0,
        mods: Number(Boolean(event.shiftKey)) | Number(Boolean(event.ctrlKey)) << 1 | Number(Boolean(event.altKey)) << 2 | Number(Boolean(event.metaKey)) << 3
      });
    };
    const cleanup = () => {
      window.clearTimeout(startupTimer);
      window.clearInterval(renewalTimer);
      window.clearInterval(healthTimer);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("pagehide", onPagehide);
      window.document?.removeEventListener?.("visibilitychange", onVisibility);
      pointerDown = false;
      for (const type of ["pointermove", "pointerdown", "pointerup"]) window.removeEventListener(type, onPointer, { capture: true });
      if (propertyPending) {
        window.clearTimeout(propertyPending.timer);
        propertyPending.reject(Error("preview_cancelled"));
        propertyPending = null;
      }
    };
    const release = () => {
      if (closing) return closing;
      send("release");
      released = true;
      committed = false;
      cleanup();
      rejectReady(Error("preview_cancelled"));
      node.removeAttribute("src");
      node.remove();
      closing = opening.then(async () => {
        if (capability(descriptor?.handle)) await request("close", { handle: descriptor.handle }).catch(() => {
        });
      });
      return closing;
    };
    const fail = (reason) => {
      if (failed || released) return;
      failed = true;
      rejectReady(Error(reason));
      publish("failed", reason);
      if (committed && preserveOnFailure) {
        send("volume", { value: 0 });
        send("pause");
        cleanup();
      } else void release();
    };
    const onMessage = (event) => {
      if (released || failed || !descriptor || event.source !== node.contentWindow || event.origin !== descriptor.origin) return;
      const message = event.data;
      if (isWeb && message?.source === "cwb-web-media-control" && message.channel === descriptor.channel) {
        if (!committed || !prepared || window.document?.hidden || !playback(getEffects()).playing || !onMediaControl || !Number.isSafeInteger(message.requestId) || message.requestId <= lastControlRequest || controlPending >= 4 || !["play", "pause", "previous", "next"].includes(message.command) || !/^[a-f0-9]{32}$/.test(message.sessionId || "") || Object.keys(message).some((key) => !["source", "channel", "requestId", "command", "sessionId"].includes(key))) return;
        lastControlRequest = message.requestId;
        controlPending++;
        void Promise.resolve().then(() => {
          if (!committed || released || failed || window.document?.hidden || !playback(getEffects()).playing) throw Error("media_control_unavailable");
          return onMediaControl({ requestId: message.requestId, command: message.command, sessionId: message.sessionId });
        }).then(
          (value) => {
            if (!released && !failed) send("mediaControlResult", { requestId: message.requestId, ok: value?.ok === true });
          },
          () => {
            if (!released && !failed) send("mediaControlResult", { requestId: message.requestId, ok: false });
          }
        ).finally(() => {
          controlPending--;
        });
        return;
      }
      if (message?.source !== (isWeb ? "cwb-web" : "cwb-scene") || message.channel !== descriptor.channel || !Number.isSafeInteger(message.sequence) || message.sequence <= sequence || !["loading", isWeb ? "renderable" : "ready", "failed", "released"].includes(message.phase)) return;
      const readyPhase = message.phase === (isWeb ? "renderable" : "ready");
      if (readyPhase && (![message.width, message.height].every((n) => Number.isInteger(n) && n > 0 && n <= 4096) || (isWeb ? !Number.isSafeInteger(message.paintFrames) || message.paintFrames < 2 : !Number.isSafeInteger(message.draws) || message.draws <= 0 || !Number.isInteger(message.layers) || message.layers <= 0))) return;
      sequence = message.sequence;
      lastMessage = Date.now();
      if (message.phase === "failed" || message.phase === "released") {
        fail("preview_engine_failed");
        return;
      }
      if (readyPhase) {
        if (propertyPending && message.propertyRequest === propertyPending.id) {
          const pending = propertyPending;
          propertyPending = null;
          window.clearTimeout(pending.timer);
          const actual = readback(pending.schema, message.properties, validate);
          const directoryReady = !isWeb || !Object.values(pending.schema).some((spec) => spec.type === "directory") || message.directoryStatus === "ready";
          const available = directoryReady && (!isWeb || message.propertiesSupported === true) && (Object.keys(actual.values).length > 0 || Object.keys(pending.schema).length === 0);
          pending.resolve({
            phase: available ? "ready" : "unavailable",
            method: available ? isWeb ? "author-delivery" : "engine-readback" : "none",
            source: "workbench-preview",
            ...actual
          });
        }
        meter = {
          width: message.width,
          height: message.height,
          fps: Number.isFinite(message.fps) ? Math.round(Math.max(0, Math.min(240, message.fps))) : 0,
          draws: Number.isSafeInteger(message.draws) ? Math.min(1e9, message.draws) : 0,
          renderCompletions: Number.isSafeInteger(message.renderCompletions) ? Math.min(1e9, message.renderCompletions) : 0,
          ...isWeb ? { paintFrames: message.paintFrames, animationFrames: message.animationFrames || 0 } : {}
        };
        if (!prepared) {
          prepared = true;
          window.clearTimeout(startupTimer);
          send("properties", { values: descriptor.properties ?? {} });
          update();
          resolveReady();
        }
        publish(committed ? "ready" : "prepared");
      }
    };
    const opening = Promise.resolve().then(async () => {
      await beforeOpen();
      if (released) return;
      descriptor = await request("open", { id: project.id, fps: 60 });
      if (released) return;
      let origin, url;
      try {
        origin = new URL(descriptor.origin);
        url = new URL(descriptor.url);
      } catch {
        throw Error("preview_descriptor_invalid");
      }
      const webBase = typeof descriptor.resourceBase === "string" ? descriptor.resourceBase : "";
      const validWeb = new RegExp("^" + origin.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/[a-f0-9]{32}/files/project$").test(webBase) && url.href.startsWith(webBase + "/") && /\.html?$/i.test(url.pathname) && !url.search && !url.hash && url.pathname.split("/").every((part) => {
        try {
          return !/[\\\0]/.test(decodeURIComponent(part)) && ![".", ".."].includes(decodeURIComponent(part));
        } catch {
          return false;
        }
      });
      if (!capability(descriptor.handle) || !capability(descriptor.channel) || origin.origin !== descriptor.origin || origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port || origin.username || origin.password || url.origin !== origin.origin || (isWeb ? descriptor.type !== "web" || !validWeb : url.pathname !== "/wallpaper-engine/scene-live/index.html" || url.searchParams.get("type") !== "scene" || url.searchParams.get("src") !== "project")) throw Error("preview_descriptor_invalid");
      node.sandbox = "allow-scripts allow-same-origin";
      node.referrerPolicy = "no-referrer";
      node.style.pointerEvents = "none";
      window.addEventListener("message", onMessage);
      window.addEventListener("pagehide", onPagehide);
      window.document?.addEventListener?.("visibilitychange", onVisibility);
      for (const type of ["pointermove", "pointerdown", "pointerup"]) window.addEventListener(type, onPointer, { passive: true, capture: true });
      startupTimer = window.setTimeout(() => fail("preview_first_frame_timeout"), Math.min(9e4, Math.max(15e3, descriptor.firstFrameTimeoutMs || 9e4)));
      renewalTimer = window.setInterval(() => {
        void request("renew", { handle: descriptor.handle }).catch(() => fail("preview_lease_lost"));
      }, 15e3);
      healthTimer = window.setInterval(() => {
        if (!window.document?.hidden && prepared && Date.now() - lastMessage > 1e4) fail("preview_heartbeat_timeout");
      }, 1e3);
      publish("loading");
      node.src = descriptor.url;
    }).catch((error) => {
      fail(error.message === "preview_descriptor_invalid" ? error.message : "preview_unavailable");
    });
    return {
      node,
      kind: isWeb ? "Web" : "Scene",
      projectId: project.id,
      canonicalId: isWeb ? "backgroundWeb" : "backgroundScene",
      ready,
      update,
      release,
      async validatePrepared() {
        await opening;
        if (released || failed || !descriptor) return false;
        const result = await api("scene-preview", {
          method: "POST",
          signal: AbortSignal.timeout(8e3),
          body: JSON.stringify({ op: "validate", client, handle: descriptor.handle })
        }).catch(() => null);
        if (released || failed || result?.current !== true) return false;
        descriptor.properties = result.properties ?? {};
        if (prepared) send("properties", { values: descriptor.properties });
        return true;
      },
      activate() {
        if (released || failed || !prepared) throw Error("preview_unavailable");
        committed = true;
        update();
        publish("ready");
      },
      retire() {
        committed = false;
        update();
      },
      input(value) {
        if (!isWeb && value?.op !== "audio" || !prepared || !committed || released || failed || window.document?.hidden || !playback(getEffects()).playing || !node.contentWindow) return false;
        let input;
        try {
          input = validateInput(value);
        } catch {
          return false;
        }
        send(input.op, input.op === "audio" ? { values: input.values } : { value: input.value });
        return true;
      },
      properties(values) {
        if (prepared) send("properties", { values });
      },
      authorProperties(schema, values = null) {
        if (!prepared || !committed || released || failed) return Promise.reject(Error("preview_properties_unavailable"));
        if (propertyPending) return Promise.reject(Error("preview_properties_busy"));
        if (propertyRequest >= Number.MAX_SAFE_INTEGER) return Promise.reject(Error("preview_properties_unavailable"));
        return new Promise((resolve, reject) => {
          const id = ++propertyRequest;
          propertyPending = { id, schema, resolve, reject, timer: window.setTimeout(() => {
            if (propertyPending?.id !== id) return;
            window.clearTimeout(propertyPending.timer);
            propertyPending = null;
            reject(Error("preview_properties_timeout"));
          }, 3e3) };
          send(values === null ? "readProperties" : "properties", { propertyRequest: id, ...values === null ? {} : { values } });
        });
      },
      stats: () => meter ? { ...meter, pointerReceived, pointerForwarded, pointerBlocked } : null
    };
  }
  return __toCommonJS(workbench_scene_preview_exports);
})();
