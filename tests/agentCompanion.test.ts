// Front-end unit tests for the AI companion's typed-text queue. Run with `npm run test:frontend`
// (bundled by esbuild, executed by `node --test`; no browser needed).
import './setupDomGlobals';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AgentCompanionController, type KeyEventOptions } from '../src/agentCompanion';

/** Every controller a test makes is stopped after it, so no TTL timer of an old one fires later. */
function trackCtl(c: AgentCompanionController): AgentCompanionController {
  liveControllers.push(c);
  return c;
}
const liveControllers: AgentCompanionController[] = [];
afterEach(() => {
  for (const c of liveControllers.splice(0)) c.handleEvent({ kind: 'status', status: 'idle' });
});

interface Press {
  vk: number;
  bubble?: string;
  at: number;
}

function makeController(allow: { typedText: boolean }) {
  const presses: Press[] = [];
  const target = {
    onKeyDown(vk: number, _repeat?: boolean, opts?: KeyEventOptions) {
      presses.push({ vk, bubble: opts?.bubble, at: performance.now() });
    },
    onKeyUp() {},
    triggerCuriousDemo() {},
    triggerCrossDemo() {},
    triggerSleepDemo() {},
  };
  const ctl = trackCtl(new AgentCompanionController({
    bubbleEl: null,
    getTarget: () => target,
    is3DTarget: () => false,
    allowSound: () => false,
    allowTypedText: () => allow.typedText,
  }));
  return { ctl, presses };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LONG = 'npm run build -- --mode production --verbose && echo done && ls -la dist assets';

function working(ctl: AgentCompanionController) {
  ctl.handleEvent({ kind: 'status', status: 'working', autoType: true, typedText: LONG, ttlMs: 30_000 });
}

function stop(ctl: AgentCompanionController) {
  ctl.handleEvent({ kind: 'status', status: 'idle' });
}

test('setting turned off: queued real text stops at once, quiet typing goes on', async () => {
  const allow = { typedText: true };
  const { ctl, presses } = makeController(allow);
  working(ctl);
  await sleep(400);
  const typedBefore = presses.filter((p) => p.bubble).length;
  assert.ok(typedBefore > 0, 'real text was typing before the switch');
  assert.ok(ctl.hasQueuedTypedText());

  allow.typedText = false;
  const switchedAt = performance.now();
  ctl.refreshTypedTextPermission();
  assert.equal(ctl.hasQueuedTypedText(), false, 'queue dropped at once');

  await sleep(1200);
  const after = presses.filter((p) => p.at > switchedAt);
  assert.equal(after.filter((p) => p.bubble).length, 0, 'no bubble after the switch');
  assert.ok(after.length > 0, 'quiet pretend-typing continues');
  stop(ctl);
});

test('setting off without an explicit refresh: the next key already checks it', async () => {
  const allow = { typedText: true };
  const { ctl, presses } = makeController(allow);
  working(ctl);
  await sleep(300);
  allow.typedText = false; // e.g. a key timer already scheduled before the UI saw the change
  const switchedAt = performance.now();
  await sleep(1000);
  assert.equal(presses.filter((p) => p.at > switchedAt && p.bubble).length, 0);
  assert.equal(ctl.hasQueuedTypedText(), false);
  stop(ctl);
});

test('privacy guard starts mid-typing: real text dropped and not resumed afterwards', async () => {
  const allow = { typedText: true };
  const { ctl, presses } = makeController(allow);
  working(ctl);
  await sleep(400);
  assert.ok(presses.some((p) => p.bubble), 'real text was typing');

  const guardAt = performance.now();
  ctl.setPrivacyMode(true);
  assert.equal(ctl.hasQueuedTypedText(), false, 'queue dropped at once');
  await sleep(600);
  assert.equal(presses.filter((p) => p.at > guardAt).length, 0, 'nothing pressed during the guard');

  const leftAt = performance.now();
  ctl.setPrivacyMode(false);
  await sleep(1500);
  const after = presses.filter((p) => p.at > leftAt);
  assert.equal(after.filter((p) => p.bubble).length, 0, 'real text does not resume');
  assert.equal(after.length, 0, 'setting on: no pretend keys either, pose only');
  stop(ctl);
});

test('Thai typed text: one keycap per Thai character, marks on a dotted circle, debug log has no text', async () => {
  const allow = { typedText: true };
  const logs: string[] = [];
  const presses: Press[] = [];
  const target = {
    onKeyDown(vk: number, _r?: boolean, opts?: KeyEventOptions) {
      presses.push({ vk, bubble: opts?.bubble, at: performance.now() });
    },
    onKeyUp() {},
    triggerCuriousDemo() {},
    triggerCrossDemo() {},
    triggerSleepDemo() {},
  };
  const ctl = trackCtl(new AgentCompanionController({
    bubbleEl: null,
    getTarget: () => target,
    is3DTarget: () => false,
    allowSound: () => false,
    allowTypedText: () => allow.typedText,
    debugLog: (stage, detail) => logs.push(`${stage} ${detail}`),
  }));
  ctl.handleEvent({ kind: 'status', status: 'working', autoType: true, typedText: 'สวัสดี', ttlMs: 30_000 });
  await sleep(1100);
  const bubbles = presses.filter((p) => p.bubble).map((p) => p.bubble);
  assert.deepEqual(bubbles, ['ส', 'ว', '◌ั', 'ส', 'ด', '◌ี']);
  assert.ok(logs.some((l) => l.startsWith('ui.queue keys=6 skipped_no_key=0')), logs.join('\n'));
  assert.ok(!logs.some((l) => l.includes('สวัสดี')), 'the log never holds the text');
  stop(ctl);
});

// ---- Spec change 3: keycap legends follow the script of the AI text being typed ----
import { getInputLang, onInputLangChange, setInputLang, thaiLegendMode } from '../src/inputLang';

/** A controller whose key presses record the legend mode at the moment of each key. */
function legendRig() {
  const modes: Array<{ bubble?: string; mode: string }> = [];
  const target = {
    onKeyDown(_vk: number, _r?: boolean, opts?: KeyEventOptions) {
      if (opts?.bubble) modes.push({ bubble: opts.bubble, mode: thaiLegendMode() });
    },
    onKeyUp() {},
    triggerCuriousDemo() {},
    triggerCrossDemo() {},
    triggerSleepDemo() {},
  };
  const ctl = trackCtl(new AgentCompanionController({
    bubbleEl: null,
    getTarget: () => target,
    is3DTarget: () => false,
    allowSound: () => false,
    allowTypedText: () => true,
  }));
  return { ctl, modes };
}
const typeText = (ctl: AgentCompanionController, text: string) =>
  ctl.handleEvent({ kind: 'status', status: 'working', autoType: true, typedText: text, ttlMs: 30_000 });

test('A: system Thai, AI types English -> Latin legends while typing, Thai again afterwards', async () => {
  setInputLang('th');
  const { ctl, modes } = legendRig();
  let flips = 0;
  const off = onInputLangChange(() => flips++);
  assert.equal(thaiLegendMode(), 'main', 'owner is on Thai');
  typeText(ctl, 'git status');
  await sleep(400);
  assert.equal(thaiLegendMode(), 'off', 'English legends while the AI types English');
  await sleep(1400);
  assert.ok(modes.length >= 10 && modes.every((m) => m.mode === 'off'), JSON.stringify(modes));
  assert.deepEqual(modes.slice(0, 3).map((m) => m.bubble), ['g', 'i', 't']);
  assert.equal(thaiLegendMode(), 'off', 'legends stay on the AI text script while the status is working');
  ctl.handleEvent({ kind: 'status', status: 'done' });
  assert.equal(thaiLegendMode(), 'main', 'back to the owner language when the status ends');
  assert.equal(getInputLang(), 'th', 'tracked input language untouched');
  assert.equal(flips, 0, 'no language switch event (so no language bubble)');
  off();
  stop(ctl);
});

test('B: system English, AI types Thai -> Thai legends while typing, English again afterwards', async () => {
  setInputLang('en');
  const { ctl, modes } = legendRig();
  assert.equal(thaiLegendMode(), 'off');
  typeText(ctl, 'สวัสดี');
  await sleep(300);
  assert.equal(thaiLegendMode(), 'main');
  await sleep(1300);
  assert.ok(modes.length === 6 && modes.every((m) => m.mode === 'main'), JSON.stringify(modes));
  assert.equal(thaiLegendMode(), 'main', 'Thai legends stay while the status is working');
  ctl.handleEvent({ kind: 'status', status: 'done' });
  assert.equal(thaiLegendMode(), 'off', 'back to English when the status ends');
  assert.equal(getInputLang(), 'en');
  stop(ctl);
});

test('C: mixed text switches at each script change; digits/space/punctuation keep the run', async () => {
  setInputLang('en');
  const { ctl, modes } = legendRig();
  typeText(ctl, 'echo สวัสดี ok');
  await sleep(2200);
  const seq = modes.map((m) => `${m.bubble}:${m.mode}`).join(' ');
  // Latin run, Thai run (the space before it stays Latin, the one after stays Thai), Latin run.
  const want = ['e','c','h','o','␣'].map((b) => `${b}:off`)
    .concat(['ส','ว','◌ั','ส','ด','◌ี','␣'].map((b) => `${b}:main`))
    .concat(['o','k'].map((b) => `${b}:off`)).join(' ');
  assert.equal(seq, want);
  stop(ctl);
});

test('digits/space/punctuation first: Latin legends until the first Thai letter; other scripts are skipped', async () => {
  setInputLang('th');
  const { ctl, modes } = legendRig();
  typeText(ctl, '12 -สวัสดี漢字x');
  await sleep(2000);
  const seq = modes.map((m) => `${m.bubble}:${m.mode}`);
  assert.deepEqual(seq.slice(0, 4), ['1:off', '2:off', '␣:off', '-:off'], seq.join(' '));
  assert.equal(seq[4], 'ส:main');
  assert.ok(!seq.some((s) => s.startsWith('漢') || s.startsWith('字')), 'CJK has no keycap');
  // CJK mid-text does not change the legends: the Thai run goes straight to the Latin 'x'.
  assert.equal(seq[seq.length - 1], 'x:off');
  stop(ctl);
});

test('D: the owner presses a real key mid-typing -> legends return to the owner language at once', async () => {
  setInputLang('th');
  const { ctl } = legendRig();
  typeText(ctl, 'git status --short --branch');
  await sleep(300);
  assert.equal(thaiLegendMode(), 'off');
  ctl.notifyRealUserInput();
  assert.equal(thaiLegendMode(), 'main', 'immediately Thai again (owner language)');
  stop(ctl);
});

test('stopped / replaced without text: legends go back to the owner language', async () => {
  setInputLang('th');
  const { ctl } = legendRig();
  typeText(ctl, 'git status --short');
  await sleep(300);
  assert.equal(thaiLegendMode(), 'off');
  ctl.handleEvent({ kind: 'status', status: 'done' });
  assert.equal(thaiLegendMode(), 'main');
  typeText(ctl, 'ls -la');
  await sleep(300);
  assert.equal(thaiLegendMode(), 'off');
  stop(ctl);
  assert.equal(thaiLegendMode(), 'main');
});

// ---- sa decision (5.1.2-th.4): with "Show what the AI types" on, only real AI text is typed ----

/** Records every key press (with its bubble), whether the cat had a real key down. */
function pressRig(allowTyped = true) {
  const presses: Array<{ vk: number; bubble?: string; at: number }> = [];
  const target = {
    onKeyDown(vk: number, _r?: boolean, opts?: KeyEventOptions) {
      presses.push({ vk, bubble: opts?.bubble, at: performance.now() });
    },
    onKeyUp() {},
    triggerCuriousDemo() {},
    triggerCrossDemo() {},
    triggerSleepDemo() {},
  };
  const allow = { typedText: allowTyped };
  const ctl = trackCtl(new AgentCompanionController({
    bubbleEl: null,
    getTarget: () => target,
    is3DTarget: () => false,
    allowSound: () => false,
    allowTypedText: () => allow.typedText,
  }));
  return { ctl, presses, allow };
}
const textless = (ctl: AgentCompanionController, extra: object = {}) =>
  ctl.handleEvent({ kind: 'status', status: 'working', autoType: true, ...extra });

test('AC1: Bash text, a Read, a Bash text -> keys only while the two texts type; legends stay English on Thai Windows', async () => {
  setInputLang('th');
  const { ctl, presses } = pressRig();
  assert.equal(thaiLegendMode(), 'main');
  typeText(ctl, 'git log --oneline');
  await sleep(2400);
  const first = presses.length;
  assert.equal(first, 'git log --oneline'.length, 'the whole first text typed');
  assert.ok(presses.every((p) => p.bubble), 'every key has a bubble');
  assert.equal(thaiLegendMode(), 'off', 'English legends stay after the text');
  textless(ctl); // the Read: no text
  await sleep(1500);
  assert.equal(presses.length, first, 'no key press during the Read (no pretend typing)');
  assert.equal(thaiLegendMode(), 'off', 'still English legends between texts');
  typeText(ctl, 'npm test now');
  await sleep(1500);
  assert.equal(presses.length, first + 'npm test now'.length);
  assert.ok(presses.every((p) => p.bubble), 'no key without a bubble, ever');
  assert.equal(thaiLegendMode(), 'off');
  stop(ctl);
  assert.equal(thaiLegendMode(), 'main');
});

test('a text-less working event does not cut a text that is being typed', async () => {
  setInputLang('th');
  const { ctl, presses } = pressRig();
  typeText(ctl, 'abcdefghijklmnopqrstuvwxyz0123456789');
  await sleep(200);
  textless(ctl);
  textless(ctl);
  ctl.handleEvent({ kind: 'status', status: 'thinking' });
  assert.ok(ctl.hasQueuedTypedText(), 'queue survives');
  await sleep(4800);
  assert.equal(presses.length, 36, 'all 36 keys typed');
  stop(ctl);
});

test('the same call reported twice (Pre then Post) is typed once', async () => {
  setInputLang('en');
  const { ctl, presses } = pressRig();
  typeText(ctl, 'ls -la');
  await sleep(1200);
  typeText(ctl, 'ls -la');
  await sleep(800);
  assert.equal(presses.length, 6);
  stop(ctl);
});

test('AC2: a filtered secret text (no text arrives) -> pose only, no key presses', async () => {
  setInputLang('en');
  const { ctl, presses } = pressRig();
  textless(ctl, { text: 'running a command' });
  await sleep(1200);
  assert.equal(presses.length, 0);
  stop(ctl);
});

test('AC3: status done / error / idle -> legends back to the owner language', async () => {
  for (const status of ['done', 'error', 'idle'] as const) {
    setInputLang('th');
    const { ctl } = pressRig();
    typeText(ctl, 'ls');
    await sleep(300);
    assert.equal(thaiLegendMode(), 'off');
    ctl.handleEvent({ kind: 'status', status });
    assert.equal(thaiLegendMode(), 'main', status);
  }
});

test('AC4: the owner presses a key during the pause -> legends to the owner language at once', async () => {
  setInputLang('th');
  const { ctl, presses } = pressRig();
  typeText(ctl, 'ls');
  await sleep(600);
  assert.equal(thaiLegendMode(), 'off', 'stays English during the pause');
  ctl.notifyRealUserInput();
  assert.equal(thaiLegendMode(), 'main');
  await sleep(600);
  assert.equal(presses.length, 2, 'still no pretend keys');
  stop(ctl);
});

test('AC5: setting off -> quiet pretend-typing on the owner layout, no bubbles (as before)', async () => {
  setInputLang('th');
  const { ctl, presses } = pressRig(false);
  textless(ctl);
  await sleep(1200);
  assert.ok(presses.length > 3, 'pretend keys');
  assert.ok(presses.every((p) => !p.bubble));
  assert.equal(thaiLegendMode(), 'main');
  stop(ctl);
});

test('debug log: per key and per cut, never any text', async () => {
  setInputLang('en');
  const lines: string[] = [];
  const target = {
    lastKeyBubble: undefined as string | undefined,
    onKeyDown() { this.lastKeyBubble = 'spawned'; },
    onKeyUp() {},
    triggerCuriousDemo() {},
    triggerCrossDemo() {},
    triggerSleepDemo() {},
  };
  const ctl = trackCtl(new AgentCompanionController({
    bubbleEl: null,
    getTarget: () => target,
    is3DTarget: () => true,
    allowSound: () => false,
    allowTypedText: () => true,
    debugLog: (stage, detail) => lines.push(`${stage} ${detail}`),
  }));
  typeText(ctl, 'zq9 and a longer tail of text');
  await sleep(250);
  ctl.handleEvent({ kind: 'status', status: 'done' });
  const log = lines.join(' | ');
  assert.match(log, /ui\.key vk=0x5a .*bubble=true reason=spawned render=3d/);
  assert.match(log, /ui\.cut reason=auto_typing_stopped keys_left=\d/);
  assert.ok(!/zq9/i.test(log), 'no text in the log');
});

test('Thai text with spaces and punctuation keeps Thai legends for the whole text', async () => {
  setInputLang('en');
  const { ctl, modes } = legendRig();
  typeText(ctl, 'สวัสดีครับ, วันนี้อากาศดีมาก. ไปกินข้าวกัน (เร็ว ๆ นี้) 123 นะ');
  await sleep(5500);
  assert.ok(modes.length > 40, `typed ${modes.length}`);
  assert.ok(modes.every((m) => m.mode === 'main'), 'every key, spaces and punctuation too, on Thai legends');
  assert.equal(thaiLegendMode(), 'main', 'still Thai while the status is working');
  stop(ctl);
});

test('Read / Grep / Glob: one label bubble, no key press; other tools: nothing; setting off: nothing', async () => {
  setInputLang('en');
  const labels: string[] = [];
  const presses: number[] = [];
  const target = {
    onKeyDown(vk: number) { presses.push(vk); },
    onKeyUp() {},
    showLabelBubble(l: string) { labels.push(l); },
    triggerCuriousDemo() {},
    triggerCrossDemo() {},
    triggerSleepDemo() {},
  };
  const allow = { typedText: true };
  const ctl = trackCtl(new AgentCompanionController({
    bubbleEl: null,
    getTarget: () => target,
    is3DTarget: () => false,
    allowSound: () => false,
    allowTypedText: () => allow.typedText,
  }));
  for (const tool of ['Read', 'Grep', 'Glob']) textless(ctl, { tool });
  textless(ctl, { tool: 'mcp__x__y' });
  assert.equal(labels.length, 3);
  assert.match(labels[0], /read/i);
  assert.match(labels[1], /search/i);
  await sleep(800);
  assert.equal(presses.length, 0, 'no fake key presses');
  allow.typedText = false;
  textless(ctl, { tool: 'Read' });
  assert.equal(labels.length, 3, 'setting off: no label');
  stop(ctl);
});

test('a "waiting" (permission) event during Read/Bash keeps the text and the legends; the owner key resets them', async () => {
  setInputLang('en');
  const { ctl, presses } = pressRig();
  typeText(ctl, 'สวัสดี ครับ ผม ชื่อ แมว');
  await sleep(500);
  assert.equal(thaiLegendMode(), 'main');
  ctl.handleEvent({ kind: 'status', status: 'waiting' });
  assert.ok(ctl.hasQueuedTypedText(), 'permission prompt does not cut the text');
  assert.equal(thaiLegendMode(), 'main', 'legends stay Thai');
  await sleep(2500);
  assert.equal(presses.length, [...'สวัสดี ครับ ผม ชื่อ แมว'].length, 'whole text typed');
  assert.equal(thaiLegendMode(), 'main');
  ctl.notifyRealUserInput();
  assert.equal(thaiLegendMode(), 'off');
  stop(ctl);
});

test('an 83-key text is typed clearly faster than before (pace adapts to the length); a short one keeps the relaxed pace', async () => {
  setInputLang('en');
  const { ctl, presses } = pressRig();
  const t0 = performance.now();
  typeText(ctl, 'a'.repeat(5) + 'bcdefghijklmnopqrstuvwxyz '.repeat(3));
  const total = 5 + 26 * 3;
  await sleep(5400); // Node timers on Windows tick at ~16 ms; the old pace needed 8 s for these keys
  assert.equal(presses.length, total, 'all keys typed within 5.4 s');
  const lastAt = presses[presses.length - 1].at - t0;
  assert.ok(lastAt < 5200, `last key at ${Math.round(lastAt)} ms`);
  stop(ctl);
  const short = pressRig();
  const s0 = performance.now();
  typeText(short.ctl, 'ls -la');
  await sleep(900);
  assert.equal(short.presses.length, 6);
  assert.ok(short.presses[5].at - s0 > 300, 'short text keeps a visible pace');
  stop(short.ctl);
});
