class CatAudio {
  private ctx: AudioContext | null = null;
  private enabled = true;
  private graphReady = false;
  private masterGain: GainNode | null = null;
  private currentIntensity = 0;
  private sources: AudioScheduledSourceNode[] = [];
  private deviceWatcherAttached = false;
  private rebuildTimer: number | null = null;

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.setPurrIntensity(0);
    }
  }

  /**
   * Output device changes (headphones plugged in / Bluetooth headset connecting) kill the
   * WebView2 audio stream: the context keeps reporting `running` but renders into nothing.
   * Rebuilding the graph on the fresh default device brings the purr back without a restart.
   */
  private attachDeviceWatcher(): void {
    if (this.deviceWatcherAttached) return;
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!media || typeof media.addEventListener !== 'function') return;
    media.addEventListener('devicechange', () => this.scheduleRebuild());
    this.deviceWatcherAttached = true;
  }

  private scheduleRebuild(): void {
    // Bluetooth headsets fire several devicechange events while the profile settles (A2DP/HFP),
    // so coalesce them into a single rebuild.
    if (this.rebuildTimer !== null) return;
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuild();
    }, 280);
  }

  private teardownGraph(): void {
    const ctx = this.ctx;
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
      try {
        src.disconnect();
      } catch {
        // already disconnected
      }
    }
    this.sources = [];
    if (this.masterGain) {
      try {
        this.masterGain.disconnect();
      } catch {
        // already disconnected
      }
    }
    this.masterGain = null;
    this.graphReady = false;
    this.ctx = null;
    if (ctx) {
      ctx.onstatechange = null;
      void ctx.close().catch(() => {});
    }
  }

  private rebuild(): void {
    if (!this.ctx) return;
    // Keep the level the user is petting at, so a mid-stroke device switch does not stutter the purr
    const keepIntensity = this.enabled ? this.currentIntensity : 0;
    this.teardownGraph();
    if (keepIntensity > 0.01 && this.ensurePurrGraph() && this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(keepIntensity * 0.26, this.ctx.currentTime, 0.05);
    }
  }

  private ensurePurrGraph(): boolean {
    if (!this.enabled) return false;
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    if (this.graphReady) return true;

    const ctx = this.ctx;
    const sampleRate = ctx.sampleRate;
    const bufLen = Math.floor(sampleRate * 3.0);
    const noiseBuf = ctx.createBuffer(1, bufLen, sampleRate);
    const data = noiseBuf.getChannelData(0);
    // Smooth warm noise buffer for organic feline throat & breath texture
    for (let i = 0; i < bufLen; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;
    noiseSrc.loop = true;

    // Layer 1: Warm chest rumble (~190 Hz)
    const warmFilter = ctx.createBiquadFilter();
    warmFilter.type = 'bandpass';
    warmFilter.frequency.value = 190;
    warmFilter.Q.value = 1.15;
    const warmGain = ctx.createGain();
    warmGain.gain.value = 1.45;

    // Layer 2: Soft breathy throat resonance (~520 Hz)
    const breathFilter = ctx.createBiquadFilter();
    breathFilter.type = 'bandpass';
    breathFilter.frequency.value = 520;
    breathFilter.Q.value = 1.4;
    const breathGain = ctx.createGain();
    breathGain.gain.value = 0.34;

    // 24.5 Hz feline purr flutter amplitude modulation (0.30 .. 1.00)
    const flutterGain = ctx.createGain();
    flutterGain.gain.value = 0.65;
    const flutterLfo = ctx.createOscillator();
    flutterLfo.type = 'sine';
    flutterLfo.frequency.value = 24.5;
    const flutterDepth = ctx.createGain();
    flutterDepth.gain.value = 0.35;
    flutterLfo.connect(flutterDepth);
    flutterDepth.connect(flutterGain.gain);

    // Slow cozy breathing cadence (~0.68 Hz: inhale/exhale swell)
    const breathCycleGain = ctx.createGain();
    breathCycleGain.gain.value = 0.76;
    const breathLfo = ctx.createOscillator();
    breathLfo.type = 'sine';
    breathLfo.frequency.value = 0.68;
    const breathDepth = ctx.createGain();
    breathDepth.gain.value = 0.24;
    breathLfo.connect(breathDepth);
    breathDepth.connect(breathCycleGain.gain);

    // Soft lowpass polish so it sounds cozy on both speakers & headphones
    const polishFilter = ctx.createBiquadFilter();
    polishFilter.type = 'lowpass';
    polishFilter.frequency.value = 1400;

    // Master output gain (starts silent, ramps smoothly during petting)
    const master = ctx.createGain();
    master.gain.value = 0;

    noiseSrc.connect(warmFilter);
    warmFilter.connect(warmGain);
    warmGain.connect(flutterGain);

    noiseSrc.connect(breathFilter);
    breathFilter.connect(breathGain);
    breathGain.connect(flutterGain);

    flutterGain.connect(breathCycleGain);
    breathCycleGain.connect(polishFilter);
    polishFilter.connect(master);
    master.connect(ctx.destination);

    noiseSrc.start();
    flutterLfo.start();
    breathLfo.start();

    this.sources = [noiseSrc, flutterLfo, breathLfo];
    this.masterGain = master;
    this.graphReady = true;

    // Hard interruptions (device removed under us, OS audio reset) leave the context dead:
    // rebuild instead of staying silent until the next restart.
    const watched = ctx;
    ctx.onstatechange = () => {
      if (this.ctx !== watched) return;
      const state = watched.state as string;
      if (state === 'closed' || state === 'interrupted') this.scheduleRebuild();
    };
    this.attachDeviceWatcher();

    return true;
  }

  /**
   * Smoothly drives real-time organic cat purring (0 = silent, 1 = full cozy purr).
   */
  public setPurrIntensity(intensity: number): void {
    const target = this.enabled ? Math.max(0, Math.min(1, intensity)) : 0;
    if (target <= 0.01 && !this.graphReady) return;
    if (Math.abs(target - this.currentIntensity) < 0.005) return;
    this.currentIntensity = target;

    if (target > 0.01 && !this.ensurePurrGraph()) return;
    if (!this.ctx || !this.masterGain) return;

    if (target > 0.01 && this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }

    const now = this.ctx.currentTime;
    const targetGain = target * 0.26;
    const timeConst = target > 0.01 ? 0.14 : 0.22;
    this.masterGain.gain.setTargetAtTime(targetGain, now, timeConst);
  }

  /**
   * Soft, cozy synthesized notification chime for AI Companion events (done / waiting / error).
   * Respects the global sound toggle and leaves zero persistent audio nodes behind.
   */
  public playAgentNotice(kind: 'done' | 'waiting' | 'error'): void {
    if (!this.enabled) return;
    if (!this.ensurePurrGraph() || !this.ctx) return;
    const ctx = this.ctx;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }

    const notes: Array<{ freq: number; delay: number; dur: number; gain: number }> =
      kind === 'done'
        ? [
            { freq: 587.33, delay: 0.0, dur: 0.16, gain: 0.085 },
            { freq: 880.0, delay: 0.095, dur: 0.24, gain: 0.095 },
          ]
        : kind === 'waiting'
          ? [{ freq: 659.25, delay: 0.0, dur: 0.22, gain: 0.075 }]
          : [
              { freq: 311.13, delay: 0.0, dur: 0.14, gain: 0.075 },
              { freq: 246.94, delay: 0.11, dur: 0.20, gain: 0.075 },
            ];

    const t0 = ctx.currentTime + 0.01;
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = kind === 'error' ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(n.freq, t0 + n.delay);
      g.gain.setValueAtTime(0.0001, t0 + n.delay);
      g.gain.linearRampToValueAtTime(n.gain, t0 + n.delay + 0.018);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.delay + n.dur);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(t0 + n.delay);
      osc.stop(t0 + n.delay + n.dur + 0.02);
      osc.onended = () => {
        try {
          osc.disconnect();
          g.disconnect();
        } catch {
          // ignore
        }
      };
    }
  }
}

export const catAudio = new CatAudio();
