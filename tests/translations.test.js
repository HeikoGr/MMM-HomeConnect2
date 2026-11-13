"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const languages = ["en", "de", "da"];
const translations = Object.fromEntries(
  languages.map((lang) => [lang, JSON.parse(fs.readFileSync(path.join(root, "translations", `${lang}.json`), "utf8"))]),
);

// Every file that can hand a key to translate(): the frontend, the shared renderers and the
// backend (status payloads carry a messageKey).
const sourceFiles = [
  "MMM-HomeConnect2.js",
  "node_helper.js",
  ...fs
    .readdirSync(path.join(root, "lib"))
    .filter((file) => file.endsWith(".js"))
    .map((file) => `lib/${file}`),
];
const source = sourceFiles.map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");

test("all languages carry the same keys", () => {
  const keys = Object.keys(translations.en).sort();
  for (const lang of languages.slice(1)) {
    assert.deepEqual(Object.keys(translations[lang]).sort(), keys, lang);
  }
});

test("every key is used somewhere in the code", () => {
  const unused = Object.keys(translations.en).filter((key) => !source.includes(`"${key}"`));
  assert.deepEqual(unused, []);
});

test("every key the code translates literally exists", () => {
  const used = [...source.matchAll(/translate\(\s*"([A-Z0-9_]+)"/g)].map((match) => match[1]);
  assert.ok(used.length > 0);
  assert.deepEqual(
    used.filter((key) => !Object.hasOwn(translations.en, key)),
    [],
  );
});
