/**
 * The active keyboard input language and the Shift state, kept in one place for both engines.
 *
 * Windows: Rust polls the foreground window's keyboard layout and sends `kuro-input-lang`
 * ({ lang: 'th' | '<iso-639-1>' }) on change; that language decides the keycap legends and the
 * key bubbles, whatever the UI language is. macOS / Linux send nothing, so the old rule stays:
 * the Thai legend is a second legend while the UI language is th-TH, and bubbles stay Latin.
 */
import { getActiveLocale } from './i18n';
import { bubbleForKey, type KeySpec } from './keyboardLayout';

/** How Thai legends are drawn on the keycaps. */
export type ThaiLegendMode =
  /** Latin only (today's keycap). */
  | 'off'
  /** UI-language rule (macOS / Linux, th-TH UI): Latin top-left, Thai small bottom-right. */
  | 'second'
  /** Thai input active (Windows): Thai large and centred, Latin small top-left. */
  | 'main';

/** The Windows desktop app (Tauri). The OBS page and the web demo get their value from events. */
const isWindowsDesktopApp =
  typeof navigator !== 'undefined' &&
  /Windows/i.test(navigator.userAgent || '') &&
  typeof window !== 'undefined' &&
  '__TAURI_INTERNALS__' in window;

let inputLang: string | null = null;
let shiftDown = 0;
const shiftVks = new Set<number>();
const listeners = new Set<(lang: string, prev: string | null) => void>();

function normalize(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return /^[a-z]{2,3}$/.test(s) ? s : null;
}

/** The current input language, or null when the backend does not report one (macOS / Linux). */
export function getInputLang(): string | null {
  return inputLang;
}

/** True when the keyboard picture follows the input language (Windows backend). */
export function followsInputLang(): boolean {
  return inputLang !== null || isWindowsDesktopApp;
}

/** Thai input is active (Windows). */
export function isThaiInput(): boolean {
  return inputLang === 'th';
}

export function thaiLegendMode(): ThaiLegendMode {
  if (followsInputLang()) return inputLang === 'th' ? 'main' : 'off';
  return getActiveLocale() === 'th-TH' ? 'second' : 'off';
}

/**
 * Sets the input language from a `kuro-input-lang` payload (or `get_input_lang`).
 * Returns true when it changed. Listeners are told about every change after the first value.
 */
export function setInputLang(raw: unknown): boolean {
  const next = normalize(
    raw && typeof raw === 'object' ? (raw as { lang?: unknown }).lang : raw,
  );
  if (!next || next === inputLang) return false;
  const prev = inputLang;
  inputLang = next;
  for (const fn of listeners) {
    try {
      fn(next, prev);
    } catch {
      // a listener must never break the others
    }
  }
  return true;
}

export function onInputLangChange(fn: (lang: string, prev: string | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Bubble text for a language switch: "ไทย" for Thai, else the 2-letter code in capitals. */
export function inputLangBubbleLabel(lang: string): string {
  return lang === 'th' ? 'ไทย' : lang.slice(0, 2).toUpperCase();
}

const SHIFT_VKS = new Set([0x10, 0xa0, 0xa1]);

/** Tracks Shift from the global key events (VK 0x10 / 0xA0 / 0xA1). */
export function noteKeyForShift(vk: number, down: boolean): void {
  if (!SHIFT_VKS.has(vk)) return;
  if (down) shiftVks.add(vk);
  else {
    shiftVks.delete(vk);
    // A generic VK_SHIFT up releases both sides.
    if (vk === 0x10) shiftVks.clear();
  }
  shiftDown = shiftVks.size;
}

export function isShiftDown(): boolean {
  return shiftDown > 0;
}

/** Forget Shift (window blur, privacy mode). */
export function resetShift(): void {
  shiftVks.clear();
  shiftDown = 0;
}

/** Bubble text for a key press under the current input language and Shift state. */
export function keyBubbleLabel(vk: number, spec: KeySpec | null): string {
  return bubbleForKey(vk, spec, {
    thaiInput: isThaiInput(),
    shift: isShiftDown(),
    followsInput: followsInputLang(),
  });
}

/**
 * The ` ~ key (VK 0xC0) is often the language hotkey. Its character bubble is held this long and
 * dropped when an input-language change arrives meanwhile (the switch shows "ไทย"/"EN" instead).
 * Only this key is delayed.
 */
export const GRAVE_BUBBLE_HOLD_MS = 350;
