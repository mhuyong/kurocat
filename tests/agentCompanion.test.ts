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
