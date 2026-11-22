// Run with: node --test tests/chunked-upload.test.mjs   (Node >= 20.19 / 22.7, no browser needed)
// Exercises static/js/chunked-upload.js against an in-process fake of the /api/uploads API.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {
    Sha256, SessionUpload, createXhrTransport, getSessionConfig, shouldUseSessions, UploadError,
    chooseChunkSize, measureUploadSpeed, getCachedUploadSpeed,
} from '../static/js/chunked-upload.js';

const MIB = 1024 * 1024;
const hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------- SHA-256 vectors
test('Sha256 matches known vectors', () => {
    const v = (s) => new Sha256().update(Buffer.from(s)).digestHex();
    assert.equal(v(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(v('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(v('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    const million = new Sha256();
    const a = Buffer.alloc(1000, 'a');
    for (let i = 0; i < 1000; i++) million.update(a);
    assert.equal(million.digestHex(), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('Sha256 incremental updates equal one-shot for all boundary lengths and random splits', () => {
    for (const len of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 65537]) {
        const data = crypto.randomBytes(len);
        const h = new Sha256();
        let off = 0;
        while (off < len) {
            const n = Math.min(len - off, 1 + Math.floor(Math.random() * 150));
            h.update(data.subarray(off, off + n));
            off += n;
        }
        assert.equal(h.digestHex(), hex(data), `len ${len}`);
    }
});

// ---------------------------------------------------------------- fake server
function makeServer(opts = {}) {
    const st = {
        sessions: new Map(), puts: new Map(), creates: 0, deletes: [], log: [],
        faults: { busyOnce: new Set(), badSumOnce: new Set(), dropOnce: new Set(), always500: new Set() },
        finalizeCalls: 0, csrfMissing: 0, enabled: true, probes: [], probeStatus: 200, ...opts,
    };
    const send = (res, status, obj, headers = {}) => {
        const body = JSON.stringify(obj);
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(body);
    };
    const view = (s) => {
        const idx = [...s.chunks.keys()].sort((a, b) => a - b);
        const ranges = [];
        for (const i of idx) {
            const last = ranges[ranges.length - 1];
            if (last && last[1] === i - 1) last[1] = i; else ranges.push([i, i]);
        }
        return {
            id: s.id, state: s.state, filename: s.filename, total_size: s.size, chunk_size: s.chunkSize,
            total_chunks: Math.ceil(s.size / s.chunkSize), confirmed_chunks: idx.length, confirmed_ranges: ranges,
            ...(s.state === 'finalized' ? { file_id: 42, final_name: s.filename } : {}),
        };
    };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const parts = url.pathname.split('/').filter(Boolean); // api uploads [id] [chunks idx|finalize]
        if (req.method !== 'GET' && req.headers['x-csrf-token'] !== 'tok123') {
            st.csrfMissing++;
            return send(res, 403, { error: 'csrf' });
        }
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('error', () => {});
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            const [, , id, kind, idx] = parts;
            if (req.method === 'GET' && id === 'config') {
                return send(res, 200, { enabled: st.enabled, threshold_bytes: 4 * MIB, chunk_size_bytes: st.ceiling || MIB, max_chunk_size_bytes: 50 * MIB, max_parallel_chunks: 8, session_ttl_hours: 24 });
            }
            if (req.method === 'POST' && id === 'probe') {
                st.probes.push({ len: body.length, contentLength: Number(req.headers['content-length']) });
                if (st.probeStatus !== 200) return send(res, st.probeStatus, { error: 'server_busy' }, { 'Retry-After': '1' });
                return send(res, 200, { bytes: body.length });
            }
            if (req.method === 'GET' && !id) {
                return send(res, 200, { sessions: [...st.sessions.values()].filter(s => ['open', 'finalizing'].includes(s.state)).map(view) });
            }
            if (req.method === 'POST' && !id) {
                const j = JSON.parse(body.toString());
                st.creates++;
                const s = { id: 's' + st.creates, state: 'open', filename: j.filename, size: j.size, chunkSize: j.chunk_size, path: j.path, chunks: new Map(), body: j };
                st.sessions.set(s.id, s);
                return send(res, 201, view(s));
            }
            const s = st.sessions.get(id);
            if (!s) return send(res, 404, { error: 'session_not_found' });
            if (req.method === 'GET') {
                if (s.state === 'finalizing' && --s.pollsLeft <= 0) s.state = 'finalized';
                return send(res, 200, view(s));
            }
            if (req.method === 'DELETE') { st.deletes.push(id); s.state = 'cancelled'; return send(res, 200, view(s)); }
            if (req.method === 'PUT' && kind === 'chunks') {
                const i = Number(idx);
                st.puts.set(i, (st.puts.get(i) || 0) + 1);
                if (st.faults.always500.has(i)) return send(res, 500, { error: 'internal_error' });
                if (st.faults.dropOnce.delete(i)) return req.socket.destroy();
                if (st.faults.busyOnce.delete(i)) return send(res, 429, { error: 'server_busy' }, { 'Retry-After': '3' });
                if (st.faults.badSumOnce.delete(i)) return send(res, 422, { error: 'chunk_checksum_mismatch' });
                if (hex(body) !== req.headers['x-chunk-sha256']) return send(res, 422, { error: 'chunk_checksum_mismatch' });
                const exp = Math.min(s.chunkSize, s.size - i * s.chunkSize);
                if (body.length !== exp) return send(res, 400, { error: 'chunk_length_mismatch' });
                s.chunks.set(i, body);
                return send(res, 200, { index: i, size: body.length, duplicate: false });
            }
            if (req.method === 'POST' && kind === 'finalize') {
                st.finalizeCalls++;
                const j = JSON.parse(body.toString() || '{}');
                if (s.chunks.size !== Math.ceil(s.size / s.chunkSize)) return send(res, 409, { error: 'incomplete_upload' });
                const whole = Buffer.concat([...s.chunks.keys()].sort((a, b) => a - b).map(k => s.chunks.get(k)));
                if (hex(whole) !== j.sha256) { s.state = 'failed'; return send(res, 409, { error: 'session_failed', message: 'sha256 mismatch' }); }
                if (s.state === 'open') { s.state = 'finalizing'; s.pollsLeft = 2; }
                return send(res, 202, view(s)); // client must poll GET until finalized
            }
            send(res, 404, { error: 'nope' });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, st, base: `http://127.0.0.1:${server.address().port}` })));
}

// Minimal XMLHttpRequest on top of fetch so the real createXhrTransport can run in Node.
function installFakeXhr(base) {
    globalThis.XMLHttpRequest = class {
        constructor() { this.h = {}; this.upload = {}; }
        open(m, u) { this.m = m; this.u = base + u; }
        setRequestHeader(k, v) { this.h[k] = v; }
        getResponseHeader(k) { return this.resH ? this.resH.get(k) : null; }
        abort() { this.ctl && this.ctl.abort(); }
        send(body) {
            this.ctl = new AbortController();
            if (this.upload.onprogress && body && body.byteLength) this.upload.onprogress({ lengthComputable: true, loaded: body.byteLength });
            fetch(this.u, { method: this.m, headers: this.h, body, signal: this.ctl.signal, duplex: 'half' })
                .then(async (r) => { this.status = r.status; this.resH = r.headers; this.responseText = await r.text(); this.onload(); })
                .catch((e) => (e.name === 'AbortError' ? this.onabort() : this.onerror()));
        }
    };
}

const mkFile = (size, name = 'big.bin') => new File([crypto.randomBytes(size)], name, { type: 'application/octet-stream' });
const memStore = () => { let m = {}; return { read: () => ({ ...m }), write: (x) => { m = { ...x }; } }; };
const fastSleep = (log) => async (ms) => { log.push(ms); };

async function setup(t, opts) {
    const srv = await makeServer(opts);
    installFakeXhr(srv.base);
    t.after(() => { srv.server.close(); srv.server.closeAllConnections(); });
    return { ...srv, transport: createXhrTransport(() => 'tok123') };
}

// ---------------------------------------------------------------- end-to-end
test('config gate: disabled server or small file keeps the legacy path', async (t) => {
    const { st, transport } = await setup(t);
    const cfg = await getSessionConfig(transport);
    assert.equal(cfg.threshold_bytes, 4 * MIB);
    assert.equal(shouldUseSessions(cfg, { size: 4 * MIB }), false);
    assert.equal(shouldUseSessions(cfg, { size: 4 * MIB + 1 }), true);
    st.enabled = false;
    assert.equal(await getSessionConfig(transport), null);
});

test('full upload with 429+Retry-After, 422, dropped connection, 202 finalize; digest and chunks verified', async (t) => {
    const { st, transport } = await setup(t);
    st.faults.busyOnce.add(1);
    st.faults.badSumOnce.add(2);
    st.faults.dropOnce.add(3);
    const file = mkFile(10 * MIB + 12345);
    const cfg = await getSessionConfig(transport);
    const sleeps = [], statuses = [], progress = [];
    const up = new SessionUpload({
        file, targetPath: '/docs', overwrite: true, config: cfg, transport, store: memStore(),
        sleep: fastSleep(sleeps), random: () => 0.5,
        onStatus: (k, i) => statuses.push([k, i]), onProgress: (n) => progress.push(n),
    });
    const r = await up.run();
    assert.deepEqual(r, { fileId: 42, finalName: 'big.bin' });
    const s = st.sessions.get('s1');
    assert.equal(s.state, 'finalized');
    assert.equal(s.body.path, '/docs');
    assert.equal(s.body.overwrite, true);
    assert.equal(s.chunks.size, 11);
    const whole = Buffer.concat([...Array(11).keys()].map(i => s.chunks.get(i)));
    assert.equal(hex(whole), hex(Buffer.from(await file.arrayBuffer())));
    assert.equal(st.csrfMissing, 0);
    assert.ok(sleeps.some(ms => ms >= 3000 && ms < 3600), 'Retry-After: 3 honoured: ' + sleeps);
    assert.ok(statuses.some(([k, i]) => k === 'waiting' && i.seconds === 3));
    assert.ok(statuses.some(([k]) => k === 'retry'), 'backoff after 422 / dropped connection');
    assert.ok(statuses.some(([k]) => k === 'verifying') && statuses.some(([k]) => k === 'finalizing'));
    assert.equal(st.puts.get(1), 2); assert.equal(st.puts.get(2), 2); assert.equal(st.puts.get(3), 2);
    assert.equal(st.puts.get(0), 1);
    assert.equal(progress.at(-1), file.size);
    assert.ok(progress.every(n => n <= file.size));
    assert.equal(st.creates, 1);
});

test('resume: failed run leaves the session, second run skips confirmed chunks and reuses the session', async (t) => {
    const { st, transport } = await setup(t);
    st.faults.always500.add(5);
    const file = mkFile(8 * MIB);
    const cfg = await getSessionConfig(transport);
    const store = memStore();
    const mk = () => new SessionUpload({ file, targetPath: '/a', config: { ...cfg, max_parallel_chunks: 2 }, transport, store, sleep: fastSleep([]), random: () => 0 });
    await assert.rejects(mk().run(), (e) => e instanceof UploadError && e.status === 500);
    const s = st.sessions.get('s1');
    assert.equal(s.state, 'open');
    const had = new Set(s.chunks.keys());
    assert.ok(had.size >= 1 && !had.has(5));
    st.puts.clear();
    st.faults.always500.clear();
    const r = await mk().run();
    assert.equal(r.fileId, 42);
    assert.equal(st.creates, 1, 'no new session');
    for (const i of had) assert.equal(st.puts.get(i), undefined, `chunk ${i} was not re-sent`);
    assert.equal(st.sessions.get('s1').state, 'finalized');
    assert.deepEqual(store.read(), {}, 'finalized sessions are forgotten');
});

test('resume is only attempted for the same destination folder', async (t) => {
    const { st, transport } = await setup(t);
    st.faults.always500.add(2);
    const file = mkFile(5 * MIB);
    const cfg = await getSessionConfig(transport);
    const store = memStore();
    const base = { file, config: cfg, transport, store, sleep: fastSleep([]), random: () => 0 };
    await assert.rejects(new SessionUpload({ ...base, targetPath: '/a' }).run());
    st.faults.always500.clear();
    await new SessionUpload({ ...base, targetPath: '/b' }).run();
    assert.equal(st.creates, 2, 'different folder -> new session');
    assert.equal(st.sessions.get('s2').path, '/b');
});

test('cancel() aborts and DELETEs the session', async (t) => {
    const { st, transport } = await setup(t);
    st.faults.busyOnce.add(0);
    const file = mkFile(6 * MIB);
    const cfg = await getSessionConfig(transport);
    let up;
    const sleep = (ms, signal) => new Promise((_, rej) => { // park forever in the 429 wait until aborted
        signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
    });
    up = new SessionUpload({ file, targetPath: '/', config: { ...cfg, max_parallel_chunks: 1 }, transport, store: memStore(), sleep, random: () => 0,
        onStatus: (k) => { if (k === 'waiting') setTimeout(() => up.cancel(), 0); } });
    await assert.rejects(up.run(), (e) => e.name === 'AbortError');
    await up.cancel();
    assert.deepEqual(st.deletes, ['s1']);
    assert.equal(st.sessions.get('s1').state, 'cancelled');
});

test('whole-file checksum mismatch ends as session_failed with the server reason', async (t) => {
    const { st, transport } = await setup(t);
    const file = mkFile(5 * MIB);
    const cfg = await getSessionConfig(transport);
    // Flip a stored byte just before finalize so the server-side whole-file digest disagrees.
    const up = new SessionUpload({ file, targetPath: '/', config: cfg, transport, store: memStore(), sleep: fastSleep([]), random: () => 0,
        onStatus: (k) => { if (k === 'verifying') { const c = st.sessions.get('s1').chunks.get(0); c[0] ^= 0xff; } } });
    await assert.rejects(up.run(), (e) => e.code === 'session_failed' && e.reason === 'sha256 mismatch');
});

// ---------------------------------------------------------------- adaptive chunk size
const MB = 1000 * 1000;

test('chooseChunkSize: table', () => {
    const c = (o) => chooseChunkSize({ ceiling: 50 * MIB, parallel: 1, ...o });
    assert.equal(c({ bytesPerSec: 0.1 * MB, parallel: 4 }), 4 * MIB, 'very slow link is floored at 4 MiB');
    assert.equal(c({ bytesPerSec: 1 * MB, parallel: 1 }), 38 * MIB, '1 MB/s: 40 MB = 38.1 MiB, rounded down');
    assert.equal(c({ bytesPerSec: 1 * MB, parallel: 4 }), 9 * MIB, 'parallel divides the budget: 10 MB = 9.5 MiB -> 9');
    assert.equal(c({ bytesPerSec: 3 * MB, parallel: 3 }), 38 * MIB, '~3 MB/s link, 3 streams');
    assert.equal(c({ bytesPerSec: 50 * MB, parallel: 1 }), 50 * MIB, 'fast link is capped at the ceiling');
    assert.equal(c({ bytesPerSec: 50 * MB, parallel: 4, ceiling: 32 * MIB }), 32 * MIB);
    assert.equal(c({ bytesPerSec: 10 * MIB, parallel: 4 }), 50 * MIB);
    assert.equal(c({ bytesPerSec: 10 * MIB, parallel: 8, ceiling: 64 * MIB }), 50 * MIB);
    assert.equal(c({ bytesPerSec: 2.5 * MIB, parallel: 2 }), 50 * MIB, '2.5 MiB/s * 40 / 2 = exactly 50 MiB');
    assert.equal(c({ bytesPerSec: 2.51 * MIB, parallel: 4 }), 25 * MIB, 'result is a whole number of MiB');
    assert.equal(c({ bytesPerSec: 1 * MB, parallel: 1, targetSeconds: 10 }), 9 * MIB, 'targetSeconds is honoured');
    assert.equal(c({ bytesPerSec: 0.1 * MB, parallel: 1, minBytes: 8 * MIB }), 8 * MIB, 'minBytes is honoured');
    assert.equal(c({ bytesPerSec: 0.1 * MB, ceiling: 2 * MIB }), 2 * MIB, 'ceiling wins over the minimum');
    for (const bad of [null, undefined, NaN, Infinity, -Infinity, 0, -5, '10', {}]) {
        assert.equal(c({ bytesPerSec: bad }), 16 * MIB, `invalid ${String(bad)} -> 16 MiB`);
        assert.equal(c({ bytesPerSec: bad, ceiling: 8 * MIB }), 8 * MIB, 'invalid speed -> min(ceiling, 16 MiB)');
    }
    // every result is a whole MiB within [1 MiB, ceiling]
    for (const bps of [1, 12345, 777777, 3 * MB, 123456789, 1e12]) {
        for (const parallel of [1, 2, 3, 4]) {
            const v = c({ bytesPerSec: bps, parallel });
            assert.equal(v % MIB, 0);
            assert.ok(v >= 4 * MIB && v <= 50 * MIB, `${bps}/${parallel} -> ${v}`);
        }
    }
});

// Transport stub that records requests and answers per call.
function stubTransport(answers) {
    const calls = [];
    const fn = async (req) => {
        calls.push({ method: req.method, url: req.url, len: req.body && req.body.byteLength, headers: req.headers, hasSignal: !!req.signal });
        const a = answers[calls.length - 1] ?? { status: 200, json: { bytes: req.body.byteLength } };
        if (typeof a === 'function') return a(req);
        if (a instanceof Error) throw a;
        return a;
    };
    fn.calls = calls;
    return fn;
}

test('measureUploadSpeed: warm-up then 4 MiB, only the second request is timed', async () => {
    const tr = stubTransport([]);
    const stamps = [];
    const seq = [1000, 3000]; // ms: second request took 2 s
    const now = () => { stamps.push(tr.calls.length); return seq.shift(); };
    const bps = await measureUploadSpeed(tr, { now });
    assert.equal(bps, 4 * MIB / 2);
    assert.equal(tr.calls.length, 2);
    assert.deepEqual(tr.calls.map(c => [c.method, c.url, c.len]), [
        ['POST', '/api/uploads/probe', 256 * 1024], ['POST', '/api/uploads/probe', 4 * MIB],
    ]);
    // the clock is read after the warm-up finished (1 call made) and after the second one (2 calls made)
    assert.deepEqual(stamps, [1, 2]);
});

test('measureUploadSpeed: any failure returns null (429, 503, error, timeout, abort)', async () => {
    const R = (status) => ({ status, json: { error: 'x' } });
    assert.equal(await measureUploadSpeed(stubTransport([R(429)])), null, 'warm-up 429');
    assert.equal(await measureUploadSpeed(stubTransport([R(503)])), null, 'warm-up 503');
    const second429 = stubTransport([R(200), R(429)]);
    assert.equal(await measureUploadSpeed(second429), null, 'second 429');
    assert.equal(second429.calls.length, 2);
    assert.equal(await measureUploadSpeed(stubTransport([R(200), R(503)])), null, 'second 503');
    assert.equal(await measureUploadSpeed(stubTransport([R(200), R(500)])), null, 'second 500');
    assert.equal(await measureUploadSpeed(stubTransport([new Error('network error')])), null, 'warm-up throws');
    assert.equal(await measureUploadSpeed(stubTransport([R(200), new Error('network error')])), null, 'second throws');
    // never answers until aborted: the hard timeout must fire and abort the request
    let aborted = false;
    const hang = stubTransport([(req) => new Promise((_, rej) => req.signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); }))]);
    const t0 = Date.now();
    assert.equal(await measureUploadSpeed(hang, { timeoutMs: 40 }), null, 'timeout');
    assert.ok(Date.now() - t0 < 2000);
    assert.ok(aborted, 'the in-flight request was aborted');
    // a transport that ignores the signal still cannot hold the probe past the deadline
    const deaf = stubTransport([() => new Promise(() => {})]);
    assert.equal(await measureUploadSpeed(deaf, { timeoutMs: 40 }), null);
    // outer abort
    const ctl = new AbortController(); ctl.abort();
    assert.equal(await measureUploadSpeed(stubTransport([]), { signal: ctl.signal }), null);
});

test('measureUploadSpeed against the fake API through the real XHR transport', async (t) => {
    const { st, transport } = await setup(t);
    const bps = await measureUploadSpeed(transport);
    assert.ok(Number.isFinite(bps) && bps > 0, 'bytes/second: ' + bps);
    assert.deepEqual(st.probes.map(p => p.len), [256 * 1024, 4 * MIB]);
    assert.deepEqual(st.probes.map(p => p.contentLength), [256 * 1024, 4 * MIB], 'real Content-Length');
    assert.equal(st.csrfMissing, 0, 'CSRF header is sent');
    st.probeStatus = 429;
    assert.equal(await measureUploadSpeed(transport), null);
    st.probeStatus = 503;
    assert.equal(await measureUploadSpeed(transport), null);
});

test('getCachedUploadSpeed: shares one probe, expires after 5 min, re-probes sooner after a failure', async () => {
    let t = 0, calls = 0, result = 2 * MB;
    const measure = async () => { calls++; return result; };
    const cache = { entry: null };
    const now = () => t;
    const get = () => getCachedUploadSpeed('tr', { cache, now, measure });
    const [a, b] = await Promise.all([get(), get()]);
    assert.equal(a, 2 * MB); assert.equal(b, 2 * MB);
    assert.equal(calls, 1, 'concurrent files share one probe');
    t = 4 * 60 * 1000; await get(); assert.equal(calls, 1, 'still cached after 4 min');
    t = 5 * 60 * 1000 + 1; result = null; await get(); assert.equal(calls, 2, 'expired after 5 min');
    t += 30 * 1000; await get(); assert.equal(calls, 2, 'failure is cached briefly');
    t += 31 * 1000; result = 1 * MB; assert.equal(await get(), 1 * MB); assert.equal(calls, 3, 'failure re-probed after a minute');
});

test('new session: create call carries the chosen chunk_size; probe happens once per queue', async (t) => {
    const { st, transport } = await setup(t, { ceiling: 50 * MIB });
    const cfg = await getSessionConfig(transport);
    assert.equal(cfg.chunk_size_bytes, 50 * MIB);
    const speedCache = { entry: null };
    let measured = 0;
    const measureSpeed = async () => { measured++; return 1 * MB; }; // slow uplink
    const mk = (file) => new SessionUpload({ file, targetPath: '/q', config: { ...cfg, max_parallel_chunks: 8 }, transport, store: memStore(),
        sleep: fastSleep([]), random: () => 0, speedCache, measureSpeed });
    const file = mkFile(30 * MIB);
    const statuses = [];
    const up = mk(file);
    up.o.onStatus = (k) => statuses.push(k);
    await up.run();
    // parallel = min(8, 4) = 4; floor(1e6 * 40 / 4) = 10 MB = 9.5 MiB -> 9 MiB
    assert.equal(st.sessions.get('s1').body.chunk_size, 9 * MIB);
    assert.equal(st.sessions.get('s1').chunks.size, 4, '30 MiB / 9 MiB = 4 chunks');
    assert.ok(statuses.includes('probing'));
    await mk(mkFile(10 * MIB, 'second.bin')).run();
    assert.equal(st.sessions.get('s2').body.chunk_size, 9 * MIB);
    assert.equal(measured, 1, 'queued files reuse the cached speed');
});

test('new session: failed probe falls back to min(ceiling, 16 MiB); fast link uses the ceiling', async (t) => {
    const { st, transport } = await setup(t, { ceiling: 50 * MIB });
    const cfg = await getSessionConfig(transport);
    const base = { targetPath: '/', config: cfg, transport, sleep: fastSleep([]), random: () => 0 };
    await new SessionUpload({ ...base, file: mkFile(5 * MIB), store: memStore(), speedCache: { entry: null }, measureSpeed: async () => null }).run();
    assert.equal(st.sessions.get('s1').body.chunk_size, 16 * MIB);
    await new SessionUpload({ ...base, file: mkFile(5 * MIB), store: memStore(), speedCache: { entry: null }, measureSpeed: async () => 100 * MB }).run();
    assert.equal(st.sessions.get('s2').body.chunk_size, 50 * MIB);
    // real probe path against the fake server (server answers 503): still uploads, with the fallback
    st.probeStatus = 503;
    await new SessionUpload({ ...base, file: mkFile(5 * MIB), store: memStore(), speedCache: { entry: null } }).run();
    assert.equal(st.sessions.get('s3').body.chunk_size, 16 * MIB);
    assert.equal(st.csrfMissing, 0);
});

test('resumed session keeps its chunk size and does not probe', async (t) => {
    const { st, transport } = await setup(t, { ceiling: 50 * MIB });
    st.faults.always500.add(2);
    const cfg = await getSessionConfig(transport);
    const file = mkFile(30 * MIB);
    const store = memStore();
    let measured = 0;
    const measureSpeed = async () => { measured++; return 1 * MB; };
    const mk = (speedCache) => new SessionUpload({ file, targetPath: '/r', config: cfg, transport, store, sleep: fastSleep([]), random: () => 0, speedCache, measureSpeed });
    await assert.rejects(mk({ entry: null }).run(), (e) => e instanceof UploadError && e.status === 500);
    assert.equal(measured, 1);
    const created = st.sessions.get('s1').chunkSize;
    assert.equal(created, 9 * MIB, 'parallel min(8, 4) = 4: 10 MB = 9.5 MiB -> 9 MiB');
    st.faults.always500.clear();
    // a brand-new (empty) cache proves the resume path itself never probes
    await mk({ entry: null }).run();
    assert.equal(measured, 1, 'resume did not probe');
    assert.equal(st.creates, 1);
    assert.equal(st.sessions.get('s1').chunkSize, created);
    assert.equal(st.sessions.get('s1').state, 'finalized');
});
