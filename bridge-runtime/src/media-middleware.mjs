import { WindowsMediaProvider, MEDIA_COMMANDS } from './windows-media-provider.mjs';
import { validateWebWallpaperInput } from './web-wallpaper-input.mjs';
import { lyricAt, lyricKey, LyricsStore } from './media-lyrics.mjs';
import { resolvePlayback } from './playback-policy.mjs';

/** Latest-value producer cache; one in-flight delivery, never a PCM/CDP queue. */
export class MediaMiddleware {
  #getConfig; #create; #provider; #dispatch; #onPower; #getOccluded; #lyrics; #latest = new Map();
  #session = { id: '', commands: [] }; #power = { onBattery: false }; #sources = { audio: 'off', media: 'off' };
  #closed = false; #queue = Promise.resolve(); #timer = null; #pumping = null; #generation = 0;
  #track = null; #trackKey = ''; #rows = []; #flags = ''; #deliveryFailures = 0;
  #lyricRequest = 0; #lyricImport = 0; #lyricStatus = { state: 'waiting', source: 'none' };
  #requested = { audio: false, media: false, power: false }; #unsubscribe; #writes = new Set();
  constructor({ getConfig, createProvider = () => new WindowsMediaProvider(), dispatch = async () => {}, onPower = async () => {},
    getOccluded = () => false, lyrics = new LyricsStore() }) {
    this.#getConfig = getConfig; this.#create = createProvider; this.#dispatch = dispatch; this.#onPower = onPower; this.#lyrics = lyrics;
    this.#getOccluded = getOccluded;
    this.#latest.set('mediaStatus', { op: 'mediaStatus', value: { enabled: false } });
  }
  configure() {
    const operation = this.#queue.then(async () => {
      if (this.#closed) throw Error('media_closed');
      const config = await this.#getConfig(), settings = config.media || {};
      if (this.#closed) throw Error('media_closed');
      const flags = { audio: settings.captureAudio === true, media: settings.nowPlaying === true, power: config.effects?.pauseOnBattery === true };
      const signature = JSON.stringify({ ...flags, control: settings.allowControl === true, online: settings.onlineLyrics === true });
      const providerStatus = this.#provider?.status();
      const retry = Object.values(flags).some(Boolean) && providerStatus?.running === false
        && ['unavailable', 'protocol_limit'].includes(providerStatus.reason);
      // Retry only on an explicit configure/save, never from polling or control.
      if (signature === this.#flags && !retry) return;
      const previous = this.#requested; this.#requested = flags;
      this.#generation++; this.#lyrics.cancel?.(); this.#flags = signature;
      if (!flags.audio) this.#latest.delete('audio');
      if (!flags.media) this.#clearMedia();
      this.#sources.audio = flags.audio ? previous.audio ? this.#sources.audio : 'starting' : 'off';
      this.#sources.media = flags.media ? previous.media ? this.#sources.media : 'starting' : 'off';
      if (!flags.power) { this.#power = { onBattery: false }; await this.#onPower(this.#power); }
      if (this.#closed) throw Error('media_closed');
      if (!this.#provider) { this.#provider = this.#create(); this.#unsubscribe = this.#provider.onEvent(event => this.#receive(event)); }
      try { await this.#provider.configure(flags); }
      catch { this.#flags = ''; this.#sources = { audio: flags.audio ? 'unavailable' : 'off', media: flags.media ? 'unavailable' : 'off' }; this.#clearMedia(); }
      if (this.#closed) throw Error('media_closed');
      if (this.#provider.status()?.reason === 'unsupported') this.#sources = { audio: flags.audio ? 'unavailable' : 'off', media: flags.media ? 'unavailable' : 'off' };
      clearInterval(this.#timer); this.#timer = null;
      if (Object.values(flags).some(Boolean)) { this.#timer = setInterval(() => { void this.pump(); }, flags.audio ? 100 : 1000); this.#timer.unref?.(); }
      if (this.#track) void this.#loadLyrics();
      await this.pump(); // clear/replay once even when every source was disabled
    });
    this.#queue = operation.catch(() => {}); return operation;
  }
  #clearMedia() {
    this.#session = { id: '', commands: [] }; this.#track = null; this.#trackKey = ''; this.#rows = [];
    this.#lyricRequest++; this.#lyricStatus = { state: 'waiting', source: 'none' };
    this.#latest.delete('media'); this.#latest.delete('mediaThumbnail');
    this.#latest.set('mediaStatus', { op: 'mediaStatus', value: { enabled: false } });
    this.#generation++; this.#lyrics.cancel?.();
  }
  #receive(event) {
    if (this.#closed) return;
    if (event.type === 'unavailable') {
      this.#clearMedia(); this.#latest.delete('audio'); this.#sources = { audio: this.#requested.audio ? 'unavailable' : 'off', media: this.#requested.media ? 'unavailable' : 'off' };
      this.#power = { onBattery: false }; void Promise.resolve(this.#onPower(this.#power)).catch(() => {}); return;
    }
    if (event.type === 'status') { if (!this.#requested[event.source]) return; this.#sources[event.source] = event.state; if (event.source === 'audio' && event.state !== 'ready') this.#latest.delete('audio'); return; }
    if (event.type === 'power') {
      if (!this.#requested.power) return;
      this.#power = { onBattery: event.onBattery }; void Promise.resolve(this.#onPower(this.#power)).catch(() => {}); return;
    }
    if (event.type === 'session') { if (this.#requested.media) this.#session = { id: event.id, commands: [...event.commands] }; return; }
    if (event.type !== 'input') return;
    let input; try { input = validateWebWallpaperInput(event.input); } catch { return; }
    if (!(input.op === 'audio' ? this.#requested.audio : this.#requested.media)) return;
    this.#latest.set(input.op, input);
    if (input.op === 'audio') this.#sources.audio = 'ready';
    if (input.op === 'mediaStatus' && input.value.enabled) this.#sources.media = 'ready';
    if (input.op === 'mediaStatus' && !input.value.enabled) this.#clearMedia();
    if (input.op === 'media') {
      const key = lyricKey(input.value); this.#track = { ...input.value };
      if (key !== this.#trackKey) { this.#latest.delete('mediaThumbnail'); this.#trackKey = key; this.#rows = []; this.#generation++; this.#lyrics.cancel?.(); void this.#loadLyrics(); }
    }
  }
  async #loadLyrics() {
    const generation = this.#generation, track = this.#track, request = ++this.#lyricRequest;
    if (!track) return;
    const current = () => !this.#closed && generation === this.#generation && request === this.#lyricRequest && lyricKey(track) === this.#trackKey;
    this.#lyricStatus = { state: 'loading', source: 'none' };
    try {
      const config = await this.#getConfig();
      // Cancellation can happen while awaiting configuration, before a request
      // has an AbortController. Do not start that stale request afterwards.
      if (!current() || config.media?.nowPlaying !== true) return;
      const options = { online: config.media?.onlineLyrics === true };
      const result = this.#lyrics.lookup ? await this.#lyrics.lookup(track, options)
        : { rows: await this.#lyrics.get(track, options), state: 'ready', source: 'none' };
      if (!current()) return;
      this.#rows = result.rows;
      this.#lyricStatus = { state: result.state === 'cancelled' ? 'waiting' : result.state, source: result.source };
    } catch { if (current()) { this.#rows = []; this.#lyricStatus = { state: 'unavailable', source: 'none' }; } }
  }
  async snapshot() {
    const config = await this.#getConfig();
    const commands = config.media?.nowPlaying && config.media?.allowControl ? this.#session.commands : [];
    const inputs = [...this.#latest.values()].filter(input => input.op === 'audio' ? config.media?.captureAudio : config.media?.nowPlaying).map(input => structuredClone(input));
    if (!inputs.some(input => input.op === 'audio')) inputs.unshift({ op: 'audio', values: Array(128).fill(0) });
    return { power: { ...this.#power }, occluded: this.#getOccluded(), provider: this.#provider?.status() || { running: false, reason: 'off' }, sources: { ...this.#sources },
      sessionId: commands.length || config.media?.nowPlaying ? this.#session.id : '', commands: [...commands], trackKey: config.media?.nowPlaying ? this.#trackKey : '',
      track: config.media?.nowPlaying && this.#track ? { ...this.#track } : null,
      lyric: { ...lyricAt(config.media?.nowPlaying ? this.#rows : [], this.#track?.position || 0), ...(config.media?.nowPlaying ? this.#lyricStatus : { state: 'off', source: 'none' }) }, inputs,
      deliveryFailures: this.#deliveryFailures };
  }
  pump() {
    if (this.#closed || this.#pumping) return this.#pumping;
    this.#pumping = (async () => {
      const generation = this.#generation, config = await this.#getConfig(), snapshot = await this.snapshot();
      const inputs = snapshot.inputs;
      if (!inputs.some(input => input.op === 'audio')) inputs.unshift({ op: 'audio', values: Array(128).fill(0) });
      if (!inputs.some(input => input.op === 'mediaStatus')) inputs.unshift({ op: 'mediaStatus', value: { enabled: false } });
      inputs.push({ op: 'mediaCapabilities', value: { sessionId: snapshot.sessionId, commands: snapshot.commands } });
      inputs.push({ op: 'lyrics', value: { text: snapshot.lyric.text, next: snapshot.lyric.next } });
      for (const input of inputs) {
        if (this.#closed || generation !== this.#generation || (await this.#getConfig()).selectedId !== config.selectedId) break;
        try { await this.#dispatch(config.selectedId, validateWebWallpaperInput(input)); }
        catch { this.#deliveryFailures = Math.min(1e9, this.#deliveryFailures + 1); }
      }
    })().finally(() => { this.#pumping = null; }); return this.#pumping;
  }
  async control(value) {
    const config = await this.#getConfig();
    if (this.#closed || !config.media?.nowPlaying || !config.media?.allowControl || !this.#provider
      || !value || Object.keys(value).some(key => !['command', 'sessionId', 'projectId'].includes(key))
      || value.sessionId !== this.#session.id || !this.#session.id || !MEDIA_COMMANDS.includes(value.command) || !this.#session.commands.includes(value.command)
      || (value.projectId !== undefined && (value.projectId !== config.selectedId || !resolvePlayback(config.effects, this.#power).playing))) throw Error('media_control_unavailable');
    const ok = await this.#provider.control({ command: value.command, sessionId: value.sessionId });
    if (!ok) throw Error('media_control_rejected'); return { ok: true };
  }
  async importLyrics(value) {
    if (this.#closed || !this.#track || value?.sessionId !== this.#session.id || value?.trackKey !== this.#trackKey
      || Object.keys(value).some(key => !['sessionId', 'trackKey', 'lrc'].includes(key))) throw Error('lyrics_track_changed');
    const track = this.#track, key = this.#trackKey;
    if (this.#writes.size >= 4) throw Error('lyrics_busy');
    const imported = ++this.#lyricImport;
    this.#lyricRequest++; this.#lyrics.cancel?.(); this.#lyricStatus = { state: 'loading', source: 'local' };
    const saving = this.#lyrics.set(track, value.lrc); this.#writes.add(saving);
    let rows;
    try { rows = await saving; }
    catch (error) { if (!this.#closed && key === this.#trackKey && imported === this.#lyricImport) this.#lyricStatus = { state: 'unavailable', source: 'none' }; throw error; }
    finally { this.#writes.delete(saving); }
    if (!this.#closed && key === this.#trackKey && imported === this.#lyricImport) {
      this.#lyricRequest++; this.#lyrics.cancel?.(); this.#rows = rows; this.#lyricStatus = { state: 'ready', source: 'local' };
    }
    return { ok: true, lines: rows.length };
  }
  close() {
    this.#closed = true; this.#generation++; clearInterval(this.#timer); this.#lyrics.close();
    const closing = this.#provider?.close();
    closing?.catch(() => {});
    return this.#queue.then(async () => { clearInterval(this.#timer); await this.#pumping; await Promise.allSettled([...this.#writes]); await closing; this.#unsubscribe?.(); });
  }
}
