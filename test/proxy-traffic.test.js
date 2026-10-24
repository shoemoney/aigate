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
    await capture.chunk('request', Buffer.from('unfinished'));
    await capture.finish('complete', 200);
    // Simulate process death before the terminal write, using a closed handle.
    const row = db.prepare('SELECT file_id FROM proxy_traffic WHERE id=?').get(capture.id);
    const file = join(directory, row.file_id + '.events');
    writeFileSync(file, readFileSync(file, 'utf8').trim().split('\n').slice(0, -1).join('\n') + '\n');
    db.prepare("UPDATE proxy_traffic SET state='running',finished=NULL,status=NULL,request_bytes=0,response_bytes=0 WHERE id=?").run(capture.id);
    const reopened = await createTrafficStore({ db, directory, ...vault });
    assert.equal(reopened.get(capture.id).state, 'interrupted');
    const events = (await reopened.page(capture.id)).events;
    assert.equal(events.at(-1).type, 'interrupted');
    assert.equal(events.at(-1).request_bytes, 10);
    const saved = readFileSync(file, 'utf8');
    await createTrafficStore({ db, directory, ...vault });
    assert.equal(readFileSync(file, 'utf8'), saved);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

// Fail the SQL metadata update after the encrypted terminal fsync. This emulates
// the exact crash gap without adding a production test hook or keeping stale
// capture handles alive across the simulated restart.
function failMetadataOnce(db) {
  let failed = false;
  return {
    exec: sql => db.exec(sql),
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.startsWith('UPDATE proxy_traffic SET finished=')) return statement;
      return { run(...args) {
        if (!failed) { failed = true; throw new Error('fixture crash after durable terminal'); }
        return statement.run(...args);
      } };
    },
  };
}

test('a durable end survives metadata-update failure and repeated recovery without a second terminal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aigate-traffic-end-gap-'));
  const db = new DatabaseSync(':memory:'), vault = makeVault(randomBytes(32));
  try {
    const store = await createTrafficStore({ db: failMetadataOnce(db), directory, ...vault });
    const capture = await store.start({ method: 'POST', target: '/completed' });
    await capture.chunk('request', Buffer.from('request bytes'));
    await capture.append('response', { status: 207, headers: [] });
    await capture.chunk('response', Buffer.from('response bytes'));
    await assert.rejects(capture.finish('complete', 207), /fixture crash/);
    assert.equal(store.get(capture.id).state, 'running');
    const row = db.prepare('SELECT file_id FROM proxy_traffic WHERE id=?').get(capture.id);
    const file = join(directory, row.file_id + '.events'), before = readFileSync(file, 'utf8');
    const terminal = JSON.parse(vault.decrypt(before.trim().split('\n').at(-1))).event;
    assert.equal(terminal.type, 'end');
    for (let i = 0; i < 3; i++) {
      const reopened = await createTrafficStore({ db, directory, ...vault });
      assert.deepEqual(reopened.get(capture.id), {
        id: capture.id, started: store.get(capture.id).started, finished: terminal.at,
        client_id: null, provider: null, status: 207, state: 'complete', request_bytes: 13, response_bytes: 14,
      });
      const events = (await reopened.page(capture.id)).events;
      assert.equal(events.filter(event => ['end', 'interrupted'].includes(event.type)).length, 1);
      assert.equal(readFileSync(file, 'utf8'), before);
    }
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('recovery interruption is idempotent across its own terminal-fsync to metadata-update crash gap', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aigate-traffic-interrupted-gap-'));
  const db = new DatabaseSync(':memory:'), vault = makeVault(randomBytes(32));
  try {
    const store = await createTrafficStore({ db, directory, ...vault });
    const capture = await store.start({ method: 'POST', target: '/unfinished' });
    await capture.chunk('request', Buffer.from('abc'));
    await capture.append('response', { status: 202, headers: [] });
    await capture.chunk('response', Buffer.from('xy'));
    await capture.finish('complete', 202);
    const row = db.prepare('SELECT file_id FROM proxy_traffic WHERE id=?').get(capture.id), file = join(directory, row.file_id + '.events');
    writeFileSync(file, readFileSync(file, 'utf8').trim().split('\n').slice(0, -1).join('\n') + '\n');
    db.prepare("UPDATE proxy_traffic SET state='running',finished=NULL,status=NULL,request_bytes=0,response_bytes=0 WHERE id=?").run(capture.id);
    await assert.rejects(createTrafficStore({ db: failMetadataOnce(db), directory, ...vault }), /fixture crash/);
    assert.equal(store.get(capture.id).state, 'running');
    const before = readFileSync(file, 'utf8'), terminal = JSON.parse(vault.decrypt(before.trim().split('\n').at(-1))).event;
    assert.equal(terminal.type, 'interrupted');
    for (let i = 0; i < 3; i++) {
      const reopened = await createTrafficStore({ db, directory, ...vault });
      const row = reopened.get(capture.id);
      assert.equal(row.state, 'interrupted'); assert.equal(row.finished, terminal.at); assert.equal(row.status, 202);
      assert.equal(row.request_bytes, 3); assert.equal(row.response_bytes, 2);
      assert.equal((await reopened.page(capture.id)).events.filter(event => ['end', 'interrupted'].includes(event.type)).length, 1);
      assert.equal(readFileSync(file, 'utf8'), before);
    }
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const trailingType of ['late_event', 'end', 'interrupted']) test(`authenticated ${trailingType} after a terminal is rejected on read and recovery`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aigate-traffic-terminal-trail-'));
  const db = new DatabaseSync(':memory:'), vault = makeVault(randomBytes(32));
  try {
    const store = await createTrafficStore({ db, directory, ...vault });
    const capture = await store.start({ method: 'GET', target: '/terminal-trail' }); await capture.finish('complete', 200);
    const row = db.prepare('SELECT file_id FROM proxy_traffic WHERE id=?').get(capture.id), file = join(directory, row.file_id + '.events');
    const before = readFileSync(file, 'utf8');
    const extra = vault.encrypt(JSON.stringify({ capture_id: row.file_id, sequence: 2,
      event: { type: trailingType, at: new Date().toISOString(), state: 'interrupted', status: 500, request_bytes: 0, response_bytes: 0 } }));
    writeFileSync(file, before + extra + '\n');
    await assert.rejects(store.page(capture.id), /after its terminal/);
    await assert.rejects(store.page(capture.id, -1, 1), /after its terminal/, 'pagination must not bless a corrupt suffix');
    db.prepare("UPDATE proxy_traffic SET state='running',finished=NULL WHERE id=?").run(capture.id);
    const reopened = await createTrafficStore({ db, directory, ...vault });
    assert.equal(reopened.get(capture.id).state, 'logging_error');
    assert.equal(readFileSync(file, 'utf8'), before + extra + '\n', 'recovery must not append another terminal to corrupt data');
    await assert.rejects(reopened.page(capture.id), /after its terminal/);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('recovery rejects failed authentication, terminal byte-count corruption and an empty truncated capture', async () => {
  for (const corruption of ['authentication', 'counts', 'empty']) {
    const directory = mkdtempSync(join(tmpdir(), 'aigate-traffic-corrupt-recovery-'));
    const db = new DatabaseSync(':memory:'), vault = makeVault(randomBytes(32));
    try {
      const store = await createTrafficStore({ db, directory, ...vault });
      const capture = await store.start({ method: 'GET', target: '/bad-record' }); await capture.chunk('request', Buffer.from('abc')); await capture.finish('complete', 200);
      const row = db.prepare('SELECT file_id FROM proxy_traffic WHERE id=?').get(capture.id), file = join(directory, row.file_id + '.events');
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      if (corruption === 'authentication') lines[1] = 'not an authenticated event';
      else if (corruption === 'counts') { const end = JSON.parse(vault.decrypt(lines.at(-1))); end.event.request_bytes = 999; lines[lines.length - 1] = vault.encrypt(JSON.stringify(end)); }
      const corrupt = corruption === 'empty' ? '' : lines.join('\n') + '\n'; writeFileSync(file, corrupt);
      db.prepare("UPDATE proxy_traffic SET state='running',finished=NULL WHERE id=?").run(capture.id);
      const reopened = await createTrafficStore({ db, directory, ...vault });
      assert.equal(reopened.get(capture.id).state, 'logging_error'); assert.equal(readFileSync(file, 'utf8'), corrupt);
      await assert.rejects(reopened.page(capture.id));
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  }
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
