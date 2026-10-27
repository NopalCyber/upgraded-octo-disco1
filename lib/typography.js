'use strict';

function normalizeDisplayPunctuation(value) {
  if (typeof value !== 'string') return value;
  const entityPattern = new RegExp('&' + 'mdash;', 'gi');
  return value
    .replace(/\u2014/g, '-')
    .replace(entityPattern, '-');
}

function confirmationName(value) {
  return String(value == null ? '' : value)
    .replace(/\u2014/g, '-')
    .normalize('NFC')
    .trim();
}

function confirmationMatchesRenderedName(submitted, stored) {
  return confirmationName(submitted) === confirmationName(stored);
}

module.exports = {
  normalizeDisplayPunctuation,
  confirmationName,
  confirmationMatchesRenderedName,
};
