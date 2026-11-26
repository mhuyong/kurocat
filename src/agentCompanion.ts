import { catAudio } from './audio';
import { t } from './i18n';
import { keyForChar, type TypedKey } from './keyboardLayout';

export type AgentStatusKind = 'working' | 'thinking' | 'waiting' | 'done' | 'error' | 'idle';
export type AgentActionKind =
  | 'happy'
  | 'pet'
  | 'angry'
  | 'curious'
  | 'sleep'
  | 'wake'
  | 'tail_pat';

export interface AgentCompanionEvent {
  kind: 'status' | 'action' | 'bubble';
  status?: AgentStatusKind | string;
  action?: AgentActionKind | string;
  source?: string;
  text?: string;
  tool?: string;
  /** Real text to type key by key ("Show what the AI types"); filtered and trimmed in Rust. */
  typedText?: string;
  autoType?: boolean;
  sound?: boolean;
  ttlMs?: number;
  ts?: number;
}

/** Extra flags for an engine key event. */
export interface KeyEventOptions {
  /**
   * The key was not pressed by the user (AI companion auto-typing): the paws and keycaps
   * move as usual, but no character bubble / key popup is shown unless `bubble` is given.
   * Synthetic keys never touch the Shift state, the ` ~ hold logic or the language bubble.
   */
  synthetic?: boolean;
  /** Exact bubble text for a synthetic key (the character the AI typed). */
  bubble?: string;
}

const SYNTHETIC: KeyEventOptions = { synthetic: true };

export interface AgentCompanionTarget {
  onKeyDown(vk: number, repeat?: boolean, opts?: KeyEventOptions): void;
  onKeyUp(vk: number): void;
  triggerCuriousDemo(duration?: number): void;
  triggerCrossDemo(): void;
  triggerSleepDemo(): void;
  triggerHappyDemo?(duration?: number): void;
  triggerWakeDemo?(): void;
  triggerTailPatDemo?(): void;
}

// Natural coding keystroke VKs (home-row letters, symbols, space, enter, backspace)
const CODING_VKS: readonly number[] = [
  0x41, 0x43, 0x44, 0x45, 0x46, 0x47, 0x49, 0x4c, 0x4d, 0x4e,
  0x4f, 0x50, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x20,
  0x20, 0x0d, 0x08, 0xbc, 0xbe,
];

export interface AgentCompanionOptions {
  bubbleEl: HTMLDivElement | null;
  getTarget: () => AgentCompanionTarget | null;
  is3DTarget: () => boolean;
  allowSound: () => boolean;
  /** False on surfaces that must never show the AI's real text (the OBS overlay). */
  allowTypedText?: () => boolean;
  /**
   * Opt-in debug log (the app's agent-debug.flag file). Gets a stage and codes/counts only,
   * never any text.
   */
  debugLog?: (stage: string, detail: string) => void;
}

/** Pace of real-text typing: one character every 70-120 ms. */
const TYPED_MIN_MS = 70;
const TYPED_JITTER_MS = 50;

export class AgentCompanionController {
  private readonly bubbleEl: HTMLDivElement | null;
  private readonly getTarget: () => AgentCompanionTarget | null;
  private readonly is3DTarget: () => boolean;
  private readonly allowSound: () => boolean;
  private readonly allowTypedText: () => boolean;
  private readonly debugLog: (stage: string, detail: string) => void;

  private activeStatus: AgentStatusKind = 'idle';
  private privacyPaused = false;
  private autoTyping = false;
  private realUserInputUntil = 0;
  private typeTimer: number | null = null;
  private releaseTimers = new Set<number>();
  private heldVirtualVks = new Set<number>();
  private ttlTimer: number | null = null;
  private burstRemaining = 0;
  private lastSoundAt = 0;
  private typedQueue: TypedKey[] = [];
  /** The text the queue holds, so a duplicate event (PreToolUse + PostToolUse) does not restart it. */
  private queuedText = '';

  constructor(opts: AgentCompanionOptions) {
    this.bubbleEl = opts.bubbleEl;
    this.getTarget = opts.getTarget;
    this.is3DTarget = opts.is3DTarget;
    this.allowSound = opts.allowSound;
    this.allowTypedText = opts.allowTypedText ?? (() => true);
    this.debugLog = opts.debugLog ?? (() => {});
  }

  public setPrivacyMode(active: boolean): void {
    this.privacyPaused = Boolean(active);
    if (this.privacyPaused) {
      // Drop the AI's queued real text at once; it does not resume after the guard ends.
      this.dropTypedText();
      this.releaseAllVirtualKeys();
      this.hideBubble();
    }
  }

  /**
   * Call when "Show what the AI types" may have changed. When it is now off, the queued real
   * text is dropped at once and the quiet pretend-typing (no bubbles) carries on.
   */
  public refreshTypedTextPermission(): void {
    if (!this.allowTypedText()) this.dropTypedText();
  }

  /** True while real AI text is queued (for tests and diagnostics). */
  public hasQueuedTypedText(): boolean {
    return this.typedQueue.length > 0;
  }

  private dropTypedText(): void {
    this.typedQueue = [];
    this.queuedText = '';
  }

  /** Pause synthetic coding keystrokes briefly so the user's real keyboard/mouse always wins. */
  public notifyRealUserInput(): void {
    if (!this.autoTyping) return;
    this.realUserInputUntil = performance.now() + 1800;
    this.releaseAllVirtualKeys();
  }

  public handleEvent(ev: AgentCompanionEvent): void {
    if (!ev || typeof ev !== 'object') return;
    if (this.privacyPaused) {
      this.debugLog('ui.drop', `reason=privacy_paused kind=${ev.kind} status=${ev.status ?? '-'}`);
      return;
    }
    this.debugLog(
      'ui.event',
      `kind=${ev.kind} status=${ev.status ?? '-'} action=${ev.action ?? '-'} typed_chars=${[...(ev.typedText ?? '')].length} bubble_was=${this.bubbleEl?.classList.contains('hidden') ? 'hidden' : 'shown'}`,
    );

    this.clearTtlTimer();
    const target = this.getTarget();
    const is3d = this.is3DTarget();
    const ttl = Math.max(1200, Math.min(300_000, ev.ttlMs ?? 6500));

    if (ev.kind === 'action' && ev.action) {
      this.stopAutoTyping();
      this.activeStatus = 'idle';
      this.dispatchAction(ev.action, target, is3d);
      if (ev.text) {
        this.showBubble(ev.source, ev.text, 'info');
        this.scheduleTtlClear(ttl);
      }
      if (ev.sound && this.allowSound()) {
        this.playNoticeThrottled(ev.action === 'angry' ? 'error' : 'done');
      }
      return;
    }

    if (ev.kind === 'bubble') {
      if (ev.text) {
        this.showBubble(ev.source, ev.text, 'info');
        this.scheduleTtlClear(ttl);
      } else {
        this.hideBubble();
      }
      return;
    }

    const status = (ev.status || 'idle').toLowerCase() as AgentStatusKind;
    this.activeStatus = status;

    switch (status) {
      case 'working': {
        const typing = this.queueTypedText(ev.typedText);
        if (ev.autoType !== false || typing) {
          this.startAutoTyping();
        } else {
          this.stopAutoTyping();
        }
        this.showBubble(ev.source, ev.text || t('agent.coding'), 'working');
        this.scheduleTtlClear(ev.ttlMs ?? 45_000);
        break;
      }
      case 'thinking': {
        if (ev.autoType) {
          this.startAutoTyping();
        } else {
          this.stopAutoTyping();
        }
        target?.triggerCuriousDemo(is3d ? 2.6 : 2600);
        this.showBubble(ev.source, ev.text || t('agent.thinking'), 'thinking');
        this.scheduleTtlClear(ev.ttlMs ?? 35_000);
        break;
      }
      case 'waiting': {
        this.stopAutoTyping();
        target?.triggerCuriousDemo(is3d ? 4.2 : 4200);
        this.showBubble(ev.source, ev.text || t('agent.waiting'), 'waiting');
        this.scheduleTtlClear(ev.ttlMs ?? 90_000);
        if (ev.sound !== false && this.allowSound()) {
          this.playNoticeThrottled('waiting');
        }
        break;
      }
      case 'done': {
        this.stopAutoTyping();
        if (target?.triggerHappyDemo) {
          target.triggerHappyDemo(is3d ? 2.8 : 2800);
        } else {
          target?.triggerCuriousDemo(is3d ? 2.2 : 2200);
        }
        this.showBubble(ev.source, ev.text || t('agent.done'), 'done');
        this.scheduleTtlClear(ev.ttlMs ?? 6_500);
        if (ev.sound !== false && this.allowSound()) {
          this.playNoticeThrottled('done');
        }
        break;
      }
      case 'error': {
        this.stopAutoTyping();
        target?.triggerCrossDemo();
        this.showBubble(ev.source, ev.text || t('agent.error'), 'error');
        this.scheduleTtlClear(ev.ttlMs ?? 8_500);
        if (ev.sound !== false && this.allowSound()) {
          this.playNoticeThrottled('error');
        }
        break;
      }
      default: {
        this.stopAutoTyping();
        if (ev.text) {
          this.showBubble(ev.source, ev.text, 'info');
          this.scheduleTtlClear(ev.ttlMs ?? 3_200);
        } else {
          this.hideBubble();
        }
        break;
      }
    }
  }

  private dispatchAction(
    action: string,
    target: AgentCompanionTarget | null,
    is3d: boolean,
  ): void {
    if (!target) return;
    switch (action.toLowerCase()) {
      case 'happy':
      case 'pet':
        if (target.triggerHappyDemo) {
          target.triggerHappyDemo(is3d ? 2.8 : 2800);
        } else {
          target.triggerCuriousDemo(is3d ? 2.4 : 2400);
        }
        break;
      case 'angry':
        target.triggerCrossDemo();
        break;
      case 'curious':
        target.triggerCuriousDemo(is3d ? 3.5 : 3500);
        break;
      case 'sleep':
        target.triggerSleepDemo();
        break;
      case 'wake':
        if (target.triggerWakeDemo) {
          target.triggerWakeDemo();
        } else {
          target.triggerCuriousDemo(is3d ? 1.5 : 1500);
        }
        break;
      case 'tail_pat':
        if (target.triggerTailPatDemo) {
          target.triggerTailPatDemo();
        } else {
          target.onKeyDown(0x0d, false, SYNTHETIC);
          window.setTimeout(() => target.onKeyUp(0x0d), 140);
        }
        break;
    }
  }

  private playNoticeThrottled(kind: 'done' | 'waiting' | 'error'): void {
    const now = performance.now();
    if (now - this.lastSoundAt < 1200) return;
    this.lastSoundAt = now;
    catAudio.playAgentNotice(kind);
  }

  /**
   * Queues the AI's real text, replacing whatever is still queued. Characters with no key on
   * the keyboard (CJK, emoji, ...) are skipped. Returns true when something was queued.
   */
  private queueTypedText(text: string | undefined): boolean {
    if (!text || this.privacyPaused || !this.allowTypedText()) {
      this.debugLog(
        'ui.queue',
        `dropped has_text=${Boolean(text)} privacy=${this.privacyPaused} allow=${this.allowTypedText()}`,
      );
      // A new event replaces whatever is still queued, also when it has no text to type.
      this.typedQueue = [];
      return false;
    }
    if (text === this.queuedText && this.typedQueue.length > 0) return true;
    const keys: TypedKey[] = [];
    let skipped = 0;
    for (const ch of text) {
      const key = keyForChar(ch);
      if (key) keys.push(key);
      else skipped += 1;
    }
    this.debugLog('ui.queue', `keys=${keys.length} skipped_no_key=${skipped}`);
    this.queuedText = text;
    this.typedQueue = keys;
    if (keys.length > 0 && this.autoTyping) {
      // Start the new text right away instead of finishing a quiet burst.
      this.scheduleNextVirtualKey(40);
    }
    return keys.length > 0;
  }

  private startAutoTyping(): void {
    if (this.autoTyping) return;
    this.autoTyping = true;
    this.burstRemaining = 5 + Math.floor(Math.random() * 7);
    this.scheduleNextVirtualKey(40);
  }

  private stopAutoTyping(): void {
    this.autoTyping = false;
    this.typedQueue = [];
    if (this.typeTimer !== null) {
      window.clearTimeout(this.typeTimer);
      this.typeTimer = null;
    }
    this.releaseAllVirtualKeys();
  }

  private releaseAllVirtualKeys(): void {
    for (const id of this.releaseTimers) {
      window.clearTimeout(id);
    }
    this.releaseTimers.clear();
    const target = this.getTarget();
    for (const vk of this.heldVirtualVks) {
      target?.onKeyUp(vk);
    }
    this.heldVirtualVks.clear();
  }

  private scheduleNextVirtualKey(delayMs: number): void {
    if (!this.autoTyping) return;
    if (this.typeTimer !== null) {
      window.clearTimeout(this.typeTimer);
    }
    this.typeTimer = window.setTimeout(() => {
      this.typeTimer = null;
      if (!this.autoTyping) return;

      const now = performance.now();
      if (this.privacyPaused || now < this.realUserInputUntil) {
        this.scheduleNextVirtualKey(260);
        return;
      }

      const target = this.getTarget();
      // Checked on every key, so a key already scheduled never types real text after the
      // setting went off.
      if (this.typedQueue.length > 0 && !this.allowTypedText()) this.dropTypedText();
      const typed = this.typedQueue.shift();
      if (typed) {
        if (target) {
          if (this.heldVirtualVks.delete(typed.vk)) target.onKeyUp(typed.vk);
          target.onKeyDown(typed.vk, false, { synthetic: true, bubble: typed.bubble });
          this.heldVirtualVks.add(typed.vk);
          const rid = window.setTimeout(() => {
            this.releaseTimers.delete(rid);
            if (this.heldVirtualVks.delete(typed.vk)) {
              this.getTarget()?.onKeyUp(typed.vk);
            }
          }, 45 + Math.floor(Math.random() * 15));
          this.releaseTimers.add(rid);
        }
        // When the text is done and the AI still works, the quiet pretend-typing takes over.
        this.burstRemaining = 5 + Math.floor(Math.random() * 7);
        this.scheduleNextVirtualKey(
          this.typedQueue.length > 0
            ? TYPED_MIN_MS + Math.floor(Math.random() * TYPED_JITTER_MS)
            : 320 + Math.floor(Math.random() * 280),
        );
        return;
      }
      if (target) {
        const vk = CODING_VKS[Math.floor(Math.random() * CODING_VKS.length)];
        target.onKeyDown(vk, false, SYNTHETIC);
        this.heldVirtualVks.add(vk);
        const holdMs = 55 + Math.floor(Math.random() * 55);
        const rid = window.setTimeout(() => {
          this.releaseTimers.delete(rid);
          if (this.heldVirtualVks.delete(vk)) {
            this.getTarget()?.onKeyUp(vk);
          }
        }, holdMs);
        this.releaseTimers.add(rid);
      }

      this.burstRemaining -= 1;
      if (this.burstRemaining <= 0) {
        this.burstRemaining = 5 + Math.floor(Math.random() * 8);
        this.scheduleNextVirtualKey(260 + Math.floor(Math.random() * 340));
      } else {
        this.scheduleNextVirtualKey(75 + Math.floor(Math.random() * 105));
      }
    }, delayMs);
  }

  private showBubble(
    source: string | undefined,
    text: string,
    tone: 'working' | 'thinking' | 'waiting' | 'done' | 'error' | 'info',
  ): void {
    const el = this.bubbleEl;
    if (!el) return;
    const prefix = source && source !== 'AI' && source !== 'MCP' ? `${source} · ` : '';
    const icon =
      tone === 'working'
        ? '💻'
        : tone === 'thinking'
          ? '🧠'
          : tone === 'waiting'
            ? '⏳'
            : tone === 'done'
              ? '✅'
              : tone === 'error'
                ? '❌'
                : '🐾';
    el.dataset.tone = tone;
    el.textContent = `${icon} ${prefix}${text}`;
    el.classList.remove('hidden');
  }

  private hideBubble(): void {
    if (!this.bubbleEl) return;
    this.bubbleEl.classList.add('hidden');
  }

  private clearTtlTimer(): void {
    if (this.ttlTimer !== null) {
      window.clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
    }
  }

  private scheduleTtlClear(ms: number): void {
    this.clearTtlTimer();
    this.ttlTimer = window.setTimeout(() => {
      this.ttlTimer = null;
      this.debugLog('ui.ttl_clear', `after_ms=${ms}`);
      this.activeStatus = 'idle';
      this.stopAutoTyping();
      this.hideBubble();
    }, ms);
  }

  public getStatus(): AgentStatusKind {
    return this.activeStatus;
  }

  public dispose(): void {
    this.clearTtlTimer();
    this.stopAutoTyping();
    this.hideBubble();
  }
}
