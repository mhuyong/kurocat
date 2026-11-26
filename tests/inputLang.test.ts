// Check I (PR #2 regression): the owner's own typing follows the Windows input language, and an
// input-language change re-draws the legends. Unit-level; the AI-typing override never leaks.
import './setupDomGlobals';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAiLegendScript,
  keyBubbleLabel,
  onInputLangChange,
  setAiLegendScript,
  setInputLang,
  thaiLegendMode,
} from '../src/inputLang';
import { resolveKeyByVk } from '../src/keyboardLayout';

const VK_A = 0x41;
const VK_GRAVE = 0xc0;
const bubble = (vk: number) => keyBubbleLabel(vk, resolveKeyByVk(vk));

test('check I: input-language change switches legends and the owner key bubbles', () => {
  const seen: string[] = [];
  const off = onInputLangChange((lang) => seen.push(lang));
  setAiLegendScript(null);

  setInputLang('en');
  assert.equal(thaiLegendMode(), 'off', 'English input: Latin legends');
  assert.equal(bubble(VK_A).toLowerCase(), 'a');

  setInputLang('th');
  assert.equal(thaiLegendMode(), 'main', 'Thai input: Thai legends');
  assert.equal(bubble(VK_A), 'ฟ', 'the A key types ฟ on Kedmanee');

  setInputLang('en');
  assert.equal(thaiLegendMode(), 'off', 'back to Latin');
  assert.equal(bubble(VK_A).toLowerCase(), 'a');
  assert.deepEqual(seen.slice(-2), ['th', 'en'], 'each switch notified the engines (they re-draw the keycaps)');
  off();
});

test('check I: the ` ~ key still shows the grave bubble while the keyboard follows the input language', () => {
  setAiLegendScript(null);
  setInputLang('en');
  assert.equal(bubble(VK_GRAVE), '`');
  setInputLang('th');
  assert.equal(bubble(VK_GRAVE), '_', 'Thai input: the key types its Kedmanee character (ๅ/_ row)');
  setInputLang('en');
});

test('check I: the AI typing override never changes the owner key bubbles or the tracked language', () => {
  setInputLang('th');
  setAiLegendScript('latin');
  assert.equal(thaiLegendMode(), 'off', 'legends follow the AI text while it types');
  assert.equal(bubble(VK_A), 'ฟ', 'the owner still types Thai');
  setAiLegendScript(null);
  assert.equal(getAiLegendScript(), null);
  assert.equal(thaiLegendMode(), 'main', 'handed back to the owner language');
  setInputLang('en');
});
