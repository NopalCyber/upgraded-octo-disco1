'use strict';

const FLAG_KEY = 'control_reads_converged';

function converged() {
  return true;
}

function tables() {
  return {
    converged: true,
    cs:    'v_control_states',
  };
}

module.exports = { FLAG_KEY, converged, tables };
