// Front-end unit tests for the AI companion's typed-text queue. Run with `npm run test:frontend`
// (bundled by esbuild, executed by `node --test`; no browser needed).
import './setupDomGlobals';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentCompanionController, type KeyEventOptions } from '../src/agentCompanion';

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
  const ctl = new AgentCompanionController({
    bubbleEl: null,
    getTarget: () => target,
    is3DTarget: () => false,
    allowSound: () => false,
    allowTypedText: () => allow.typedText,
  });
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
  assert.ok(after.length > 0, 'quiet pretend-typing continues');
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
  const ctl = new AgentCompanionController({
    bubbleEl: null,
    getTarget: () => target,
    is3DTarget: () => false,
    allowSound: () => false,
    allowTypedText: () => allow.typedText,
    debugLog: (stage, detail) => logs.push(`${stage} ${detail}`),
  });
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
  const ctl = new AgentCompanionController({
    bubbleEl: null,
    getTarget: () => target,
    is3DTarget: () => false,
    allowSound: () => false,
    allowTypedText: () => true,
  });
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
  assert.equal(thaiLegendMode(), 'main', 'back to the owner language after the text');
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
  assert.equal(thaiLegendMode(), 'off', 'back to English');
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
  typeText(ctl, undefined as unknown as string); // a new event with no text replaces the queue
  assert.equal(thaiLegendMode(), 'main');
  stop(ctl);
});
