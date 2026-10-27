'use strict';

function requireInternalEvidenceMutation(req, res, next) {
  if (!req.user || req.user.user_type !== 'firm') {
    return res.status(403).send('Forbidden');
  }
  return next();
}

module.exports = { requireInternalEvidenceMutation };
