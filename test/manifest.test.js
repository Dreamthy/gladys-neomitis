import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (name) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)));
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const packageJson = JSON.parse(read('package.json'));

test('the manifest carries every field the store validates', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.gladys_version);
  assert.ok(manifest.cover_image.startsWith('https://'));
  assert.deepEqual(manifest.transports, ['cloud']);
});

test('descriptions are multi-language and within the 10-100 character range', () => {
  for (const language of ['en', 'fr']) {
    const text = manifest.description[language];
    assert.equal(typeof text, 'string', `description.${language}`);
    assert.ok(text.length >= 10 && text.length <= 100, `description.${language}: ${text.length}`);
  }
});

test('the manifest version and the image tag stay in lockstep', () => {
  assert.equal(manifest.version, packageJson.version);
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    `docker_image must be tagged ${manifest.version}, got ${manifest.docker_image}`,
  );
  // The build workflow derives the image from `ghcr.io/${GITHUB_REPOSITORY,,}`,
  // so the manifest has to use the lowercased repository name too.
  assert.equal(manifest.docker_image, manifest.docker_image.toLowerCase());
});

test('the configuration asks for the credentials the Axenco API needs', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((field) => [field.key, field]));
  assert.equal(fields.email.type, 'string');
  assert.equal(fields.email.required, true);
  assert.equal(fields.password.type, 'secret', 'a password must never be a plain string field');
  assert.equal(fields.password.required, true);
  assert.equal(fields.refresh_interval.type, 'number');

  for (const field of manifest.config_schema) {
    assert.ok(field.label.en, `${field.key}: an English label is mandatory`);
    assert.match(field.key, /^[a-z0-9_]+$/);
  }
});

test('the cover image respects the store constraints', () => {
  const cover = read('cover.png');
  assert.equal(cover.subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(cover.readUInt32BE(16), 800, 'width must be exactly 800px');
  assert.equal(cover.readUInt32BE(20), 534, 'height must be exactly 534px');
  assert.ok(cover.length < 150 * 1024, `cover.png must stay under 150 KB (${cover.length} bytes)`);
});

test('both documentation files exist and are long enough for the indexer', () => {
  for (const language of ['en', 'fr']) {
    assert.ok(read(`docs/${language}.md`).length > 300, `docs/${language}.md is too short`);
  }
});
