import test from 'node:test';
import assert from 'node:assert/strict';
import de from '../static/app/src/i18n/de.js';
import en from '../static/app/src/i18n/en.js';

test('German and English have the same keys', () => {
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
});

// The UI's message formatter supports {name} and one level of plural branches;
// a {placeholder} inside a plural branch would be shown to users as raw text.
test('No placeholders nested inside plural branches', () => {
  const nested = /\{\w+, plural,(?:[^{}]|\{[^{}]*\})*\{[^{}]*\{\w+\}/;
  for (const dict of [de, en]) {
    const bad = Object.entries(dict).filter(([, v]) => nested.test(v)).map(([k]) => k);
    assert.deepEqual(bad, []);
  }
});

test('Placeholders match between the languages', () => {
  // Placeholders are lower camel case; single-word plural forms ({Projektrolle}) are not.
  const names = (v) => [...v.matchAll(/\{([a-z]\w*)\}/g)].map((m) => m[1]).filter((n) => n !== 'count').sort();
  const mismatched = Object.keys(en).filter((k) => JSON.stringify(names(en[k])) !== JSON.stringify(names(de[k])));
  assert.deepEqual(mismatched, []);
});
