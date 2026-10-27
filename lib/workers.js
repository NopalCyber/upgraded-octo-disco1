'use strict';

const { Worker } = require('node:worker_threads');
const path = require('path');

const POOL_SIZE = 2;
const WORKER_FILE = path.join(__dirname, 'docx-worker.js');

let seq = 0;
const idle = [];
const queue = [];
const inflight = new Map();
const pool = new Set();
let started = false;
let shuttingDown = false;
let closePromise = null;
let closeResolve = null;
let closeTimer = null;
let terminating = false;
let forcedClose = false;

function spawn() {
  const w = new Worker(WORKER_FILE);
  pool.add(w);
  w.unref();
  w.on('message', (msg) => {
    const cur = inflight.get(w);
    if (!cur || msg.id !== cur.id) return;
    inflight.delete(w);
    if (msg.ok) cur.resolve(Buffer.from(msg.buf));
    else cur.reject(new Error(msg.error));
    dispatch(w);
  });
  w.on('error', (err) => {
    const cur = inflight.get(w);
    inflight.delete(w);
    if (cur) cur.reject(err);
  });
  w.on('exit', (code) => {
    pool.delete(w);
    removeIdle(w);
    const cur = inflight.get(w);
    inflight.delete(w);
    if (cur) cur.reject(new Error(`docx worker exited (code ${code})`));
    if (shuttingDown) {
      maybeFinishClose();
    } else if (started) {
      dispatch(spawn());
    }
  });
  return w;
}

function removeIdle(worker) {
  const i = idle.indexOf(worker);
  if (i !== -1) idle.splice(i, 1);
}

function dispatch(w) {
  if (!pool.has(w)) return;
  const next = queue.shift();
  if (!next) {
    if (!idle.includes(w)) idle.push(w);
    maybeFinishClose();
    return;
  }
  inflight.set(w, next);
  try {
    w.postMessage(next.msg);
  } catch (error) {
    inflight.delete(w);
    next.reject(error);
    try { w.terminate(); } catch (_) {}
  }
}

function ensurePool() {
  if (started) return;
  started = true;
  for (let i = 0; i < POOL_SIZE; i++) idle.push(spawn());
}

function run(msg) {
  if (shuttingDown) return Promise.reject(new Error('docx worker pool is shutting down'));
  ensurePool();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const job = { id, msg: { ...msg, id }, resolve, reject };
    const w = idle.pop();
    if (w) { inflight.set(w, job); w.postMessage(job.msg); }
    else queue.push(job);
  });
}

function generateDocx(doc, ws) {
  return run({ kind: 'doc', doc: JSON.parse(JSON.stringify(doc)), ws: { client_name: ws.client_name } });
}

function htmlToDocxPooled(html, headerHtml, options) {
  return run({ kind: 'html', html, headerHtml: headerHtml || null, options: options || {} });
}

function finaliseClose() {
  if (!closeResolve) return;
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = null;
  pool.clear();
  idle.length = 0;
  started = false;
  shuttingDown = false;
  terminating = false;
  const resolve = closeResolve;
  const result = { forced: forcedClose };
  closeResolve = null;
  closePromise = null;
  forcedClose = false;
  resolve(result);
}

function terminatePool() {
  if (terminating) return;
  terminating = true;
  idle.length = 0;
  const activeWorkers = [...pool];
  if (!activeWorkers.length) return finaliseClose();
  Promise.allSettled(activeWorkers.map(worker => {
    try { return worker.terminate(); }
    catch (_) { return undefined; }
  })).then(finaliseClose);
}

function forceClose() {
  if (!shuttingDown) return;
  forcedClose = true;
  const error = new Error('docx worker pool closed before queued work completed');
  while (queue.length) queue.shift().reject(error);
  for (const job of inflight.values()) job.reject(error);
  inflight.clear();
  terminatePool();
}

function maybeFinishClose() {
  if (!shuttingDown || queue.length || inflight.size) return;
  terminatePool();
}

function close({ timeoutMs = 5000, force = false } = {}) {
  if (closePromise) {
    const existingClose = closePromise;
    if (force) forceClose();
    return existingClose;
  }

  shuttingDown = true;
  closePromise = new Promise(resolve => { closeResolve = resolve; });
  const currentClose = closePromise;
  const parsedTimeout = Number(timeoutMs);
  const boundedTimeout = Number.isFinite(parsedTimeout) ? Math.max(0, parsedTimeout) : 5000;
  if (force || boundedTimeout === 0) {
    forceClose();
  } else {
    closeTimer = setTimeout(forceClose, boundedTimeout);
    maybeFinishClose();
  }
  return currentClose;
}

function status() {
  return {
    started,
    shuttingDown,
    workers: pool.size,
    idle: idle.length,
    queued: queue.length,
    inflight: inflight.size
  };
}

module.exports = { generateDocx, htmlToDocxPooled, close, status };
