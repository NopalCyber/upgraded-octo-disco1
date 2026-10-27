'use strict';

const target = process.argv[2];
if (!target || !/^postgres(ql)?:\/\//.test(target)) {
  console.error('usage: node scripts/build-test-db.js <postgres://.../database>');
  process.exit(1);
}
process.env.DATABASE_URL = target;

(async () => {
  const core = require('../db');
  try {
    await core.init();
    await require('./seed-realistic-engagements').main('all');
  } finally {
    await core.db.close().catch(() => {});
  }
})().catch((error) => {
  console.error(`build-test-db: ${error && error.stack || error}`);
  process.exit(1);
});
