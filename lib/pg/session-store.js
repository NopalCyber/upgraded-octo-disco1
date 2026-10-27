'use strict';

const session = require('express-session');

const DAY_MS = 24 * 60 * 60 * 1000;

function expiryText(sess) {
  const cookie = sess && sess.cookie;
  let at = null;
  if (cookie && cookie.expires) at = new Date(cookie.expires);
  else if (cookie && typeof cookie.maxAge === 'number') at = new Date(Date.now() + cookie.maxAge);
  if (!at || Number.isNaN(at.getTime())) at = new Date(Date.now() + DAY_MS);
  return at.toISOString().slice(0, 19).replace('T', ' ');
}

class PgSessionStore extends session.Store {
  constructor({ db }) {
    super();
    this.db = db;
  }

  get(sid, callback) {
    this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expire > utc_now_text()').get(sid)
      .then((row) => callback(null, row ? JSON.parse(row.sess) : null), callback);
  }

  set(sid, sess, callback) {
    this.db.prepare(`INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
      ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`)
      .run(sid, JSON.stringify(sess), expiryText(sess))
      .then(() => callback && callback(null), (error) => callback && callback(error));
  }

  touch(sid, sess, callback) {
    this.db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?').run(expiryText(sess), sid)
      .then(() => callback && callback(null), (error) => callback && callback(error));
  }

  destroy(sid, callback) {
    this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid)
      .then(() => callback && callback(null), (error) => callback && callback(error));
  }

  length(callback) {
    this.db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE expire > utc_now_text()').get()
      .then((row) => callback(null, row.c), callback);
  }

  clear(callback) {
    this.db.prepare('DELETE FROM sessions').run()
      .then(() => callback && callback(null), (error) => callback && callback(error));
  }
}

module.exports = { PgSessionStore, expiryText };
