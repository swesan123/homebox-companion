import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function load(filename) {
	const source = readFileSync(new URL(`../../src/lib/utils/${filename}`, import.meta.url), 'utf8');
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const exports = {};
	runInNewContext(outputText, { exports, URL });
	return exports;
}
const { parseHomeboxQr: parseInVm } = load('homeboxQr.ts');
// The module runs in its own VM realm; normalise so deep equality ignores prototypes.
const parseHomeboxQr = (text) => JSON.parse(JSON.stringify(parseInVm(text)));

const uuid = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

test('parses location, item and asset URLs from any host', () => {
	assert.deepEqual(parseHomeboxQr(`https://homebox.example.com/location/${uuid}`), {
		type: 'location',
		id: uuid,
	});
	assert.deepEqual(parseHomeboxQr(`http://192.168.1.5:7745/item/${uuid}`), {
		type: 'item',
		id: uuid,
	});
	assert.deepEqual(parseHomeboxQr('https://other.test/a/000-001'), {
		type: 'asset',
		id: '000-001',
	});
});

test('tolerates trailing slashes, query strings, fragments, sub-paths and whitespace', () => {
	assert.deepEqual(parseHomeboxQr(`  https://h.test/homebox/item/${uuid}/?x=1#top\n`), {
		type: 'item',
		id: uuid,
	});
	assert.deepEqual(parseHomeboxQr(`https://h.test/location/${uuid}/edit`), {
		type: 'location',
		id: uuid,
	});
	assert.deepEqual(parseHomeboxQr('https://h.test/a/000-001/'), { type: 'asset', id: '000-001' });
});

test('accepts bare paths without a host', () => {
	assert.deepEqual(parseHomeboxQr(`/location/${uuid}`), { type: 'location', id: uuid });
	assert.deepEqual(parseHomeboxQr('/a/000-042'), { type: 'asset', id: '000-042' });
});

test('ignores a host or query that merely looks like a route', () => {
	assert.equal(parseHomeboxQr(`https://h.test/?next=/location/${uuid}`), null);
	assert.equal(parseHomeboxQr('https://a.test/other/path'), null);
});

test('returns null for unrecognised codes', () => {
	for (const text of [
		'',
		'hello',
		'WIFI:S:guest;T:WPA;P:secret;;',
		'https://homebox.example.com/items',
		'https://homebox.example.com/location/',
		'https://homebox.example.com/item/not a uuid',
		'https://short.example/abc123',
	]) {
		assert.equal(parseHomeboxQr(text), null, text);
	}
});
