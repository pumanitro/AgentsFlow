'use strict';
// Node mirror of env.sh (CommonJS). Keep the two in sync.
const path = require('path');
const os = require('os');

const PF_REPO = '/Users/iij/Desktop/AgentsFlow';
const PF_TMP = '/Users/iij/.claude/jobs/106e55f3/tmp';
const PF_SCRATCH_PEER = path.join(PF_TMP, 'pf-scratch-peer');
const munge = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

module.exports = {
  PF_REPO,
  PF_E2E: path.join(PF_REPO, 'scripts', 'mobile-e2e'),
  PF_TMP,
  PF_USERDATA: path.join(PF_TMP, 'pf-mobile-userdata'),
  PF_SCRATCH_PEER,
  // 47821 (the contract's example) is held by ai-factory/rent-model-5090/refresh_server.py.
  PF_PORT: Number(process.env.PF_PORT || 47822),
  PF_SIDE: Number(process.env.PF_SIDE || 47832),
  PF_PIDFILE: path.join(PF_TMP, 'pf-mobile.pid'),
  PF_LOG: path.join(PF_TMP, 'pf-mobile.log'),
  EVIDENCE: '/Users/iij/.claude/plan-and-execute/AgentsFlow-mobile-app/evidence',
  TRANSCRIPTS: path.join(os.homedir(), '.claude', 'projects', munge(PF_SCRATCH_PEER)),
  PEER_ID: 'peer-lisa-test',
  munge,
};
