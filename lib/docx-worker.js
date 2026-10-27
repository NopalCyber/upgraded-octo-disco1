'use strict';
const { parentPort } = require('node:worker_threads');
const htmlToDocx = require('html-to-docx');
const { generateDocxBuffer } = require('./docx-gen');
const { normalise } = require('./docx-html');

async function convertHtmlQuietly(html, headerHtml, options) {
  const originalLog = console.log;
  console.log = (...args) => {
    if (args.length === 1 && typeof args[0] === 'boolean') return;
    originalLog(...args);
  };
  try {
    return await htmlToDocx(normalise(html), normalise(headerHtml), options);
  } finally {
    console.log = originalLog;
  }
}

parentPort.on('message', async (job) => {
  try {
    const result = job.kind === 'html'
      ? await convertHtmlQuietly(job.html, job.headerHtml || null, job.options || {})
      : await generateDocxBuffer(job.doc, job.ws);
    const buf = Buffer.isBuffer(result)
      ? result
      : result && typeof result.arrayBuffer === 'function'
        ? Buffer.from(await result.arrayBuffer())
        : Buffer.from(result);
    parentPort.postMessage({ id: job.id, ok: true, buf });
  } catch (e) {
    parentPort.postMessage({ id: job.id, ok: false, error: e.message });
  }
});
