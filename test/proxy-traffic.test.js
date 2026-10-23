import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { makeVault } from '../src/lib.js';
import { createTrafficStore } from '../src/proxy-traffic.js';

test('capture is encrypted, private, binary-safe, paginated and persistent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aigate-traffic-'));
  const db = new DatabaseSync(':memory:');
  const vault = makeVault(randomBytes(32));
  try {
    const store = await createTrafficStore({ db, directory, ...vault });
    const capture = await store.start({ headers: ['Authorization', 'Bearer SECRET_TEST_VALUE'], target: '/?token=secret', method: 'POST' });
    const binary = randomBytes(180000);
    await capture.chunk('request', binary); await capture.finish('complete', 200);
    const saved = readFileSync(join(directory, readdirSync(directory)[0]));
    assert.equal(saved.includes('SECRET_TEST_VALUE'), false);
    assert.equal(saved.includes('secret'), false);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, readdirSync(directory)[0])).mode & 0o777, 0o600);
    assert.equal(store.get(capture.id).request_bytes, binary.length);
    const first = await store.page(capture.id, -1, 2);
    assert.equal(first.events.length, 2); assert.equal(first.next_after, 1);
    const events = [];
    for await (const event of store.events(capture.id)) events.push(event);
    assert.equal(events[0].headers[1], 'Bearer SECRET_TEST_VALUE');
    assert.deepEqual(Buffer.concat(events.filter(e => e.type === 'request_body').map(e => Buffer.from(e.data, 'base64'))), binary);
    const restarted = await createTrafficStore({ db, directory, ...vault });
    assert.equal((await restarted.page(capture.id)).events.at(-1).state, 'complete');
    assert.equal(store.list(1)[0].file_id, undefined);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('unfinished requests are marked interrupted when storage reopens', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aigate-traffic-restart-'));
  const db = new DatabaseSync(':memory:');
  const vault = makeVault(randomBytes(32));
  try {
    const store = await createTrafficStore({ db, directory, ...vault });
    const capture = await store.start({ method: 'GET', target: '/' });
    const reopened = await createTrafficStore({ db, directory, ...vault });
    assert.equal(reopened.get(capture.id).state, 'interrupted');
    assert.equal((await reopened.page(capture.id)).events.at(-1).type, 'interrupted');
    await capture.finish('interrupted');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('finish drains admitted writes and prevents events after its terminal record', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aigate-traffic-race-'));
  const db = new DatabaseSync(':memory:');
  try {
    const store = await createTrafficStore({ db, directory, ...makeVault(randomBytes(32)) });
    const capture = await store.start({ method: 'POST', target: '/' });
    const pending = capture.chunk('request', Buffer.from('pending-data'));
    const finish = capture.finish('client_abort');
    await assert.rejects(capture.append('late-event'), /closed/);
    await Promise.all([pending, finish]);
    const events = (await store.page(capture.id)).events;
    assert.deepEqual(events.map(e => e.type), ['request', 'request_body', 'end']);
    assert.equal(events.at(-1).request_bytes, 12);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('capture IDs and sequence numbers reject event swapping and reordering', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aigate-traffic-tamper-'));
  const db = new DatabaseSync(':memory:');
  try {
    const store = await createTrafficStore({ db, directory, ...makeVault(randomBytes(32)) });
    const a = await store.start({ method: 'GET', target: '/first' }); await a.chunk('response', Buffer.from('a')); await a.finish('complete', 200);
    const b = await store.start({ method: 'GET', target: '/second' }); await b.finish('complete', 200);
    const rowA = db.prepare('SELECT file_id FROM proxy_traffic WHERE id=?').get(a.id);
    const rowB = db.prepare('SELECT file_id FROM proxy_traffic WHERE id=?').get(b.id);
    const file = join(directory, rowA.file_id + '.events');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    writeFileSync(file, [lines[1], lines[0], lines[2]].join('\n') + '\n');
    await assert.rejects(store.page(a.id), /identity or ordering/);
    writeFileSync(file, readFileSync(join(directory, rowB.file_id + '.events')));
    await assert.rejects(store.page(a.id), /identity or ordering/);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
