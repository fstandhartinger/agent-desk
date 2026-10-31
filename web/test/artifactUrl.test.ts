import assert from 'node:assert/strict';
import { it } from 'node:test';
import { artifactUrl, parseArtifactUrl } from '../src/lib/artifactUrl';
it('accepts canonical, encoded, uppercase and path ids; ignores invalid ids', () => {
  for (const path of ['/?a=abcdef', '/?a=a%23ABCDEF', '/a/ABCDEF', '/a/A%23ABCDEF']) assert.deepEqual(parseArtifactUrl(path).ids, ['abcdef']);
  const entry = parseArtifactUrl('/?a=ABCDEF,a%23abcdef,garbage,123abc&voice=gemini&q=Was%20ist%20das%3F');
  assert.deepEqual(entry.ids, ['abcdef', '123abc']);
  assert.deepEqual(entry.invalid, ['garbage']);
  assert.equal(entry.voice, 'gemini'); assert.equal(entry.question, 'Was ist das?');
  assert.equal(parseArtifactUrl('/?voice=bad').voice, null);
  assert.equal(parseArtifactUrl('/a/%E0%A4%A').ids.length, 0);
});
it('caps ids and generates URLs without raw hashes', () => {
  assert.equal(parseArtifactUrl('/?a=000001,000002,000003,000004,000005,000006,000007,000008,000009').ids.length, 8);
  const link = artifactUrl(['A#ABCDEF', '123abc'], 'xai', 'a#abcdef?');
  assert(!link.includes('#'));
  assert.deepEqual(parseArtifactUrl(link).ids, ['abcdef', '123abc']);
});
