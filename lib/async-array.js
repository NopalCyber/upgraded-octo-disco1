'use strict';

async function filterAsync(items, predicate) {
  const kept = [];
  for (let i = 0; i < items.length; i += 1) {
    if (await predicate(items[i], i, items)) kept.push(items[i]);
  }
  return kept;
}

async function findAsync(items, predicate) {
  for (let i = 0; i < items.length; i += 1) {
    if (await predicate(items[i], i, items)) return items[i];
  }
  return undefined;
}

async function findIndexAsync(items, predicate) {
  for (let i = 0; i < items.length; i += 1) {
    if (await predicate(items[i], i, items)) return i;
  }
  return -1;
}

async function someAsync(items, predicate) {
  for (let i = 0; i < items.length; i += 1) {
    if (await predicate(items[i], i, items)) return true;
  }
  return false;
}

async function everyAsync(items, predicate) {
  for (let i = 0; i < items.length; i += 1) {
    if (!(await predicate(items[i], i, items))) return false;
  }
  return true;
}

module.exports = { filterAsync, findAsync, findIndexAsync, someAsync, everyAsync };
