// What a job needs from the user, for the Tasks view: 'captcha' (a human
// check on the site), 'action' (sign in, a stuck page, a job paused for the
// user), or ''. Only unfinished jobs need anything.
const ACTIVE_JOB_STATES = new Set(['queued', 'starting', 'running', 'waiting_for_desktop', 'waiting', 'needs_user']);

function jobNeed(data, done) {
  if (done || !ACTIVE_JOB_STATES.has(data.state)) return { need: '', needMessage: '' };
  const kind = String(data.attention?.kind || '');
  const reason = String(data.reason || '');
  const event = String(data.last_event || '');
  const message = String(data.attention?.message || event);
  if (/_verification$/.test(kind) || (data.state === 'needs_user' && /_verification$/.test(reason)) ||
      /verification required|human check|captcha/i.test(event)) {
    return { need: 'captcha', needMessage: message };
  }
  if (kind || data.state === 'needs_user' ||
      /sign-in required|did not become usable|not responding|approval|waiting for you/i.test(event)) {
    return { need: 'action', needMessage: message };
  }
  return { need: '', needMessage: '' };
}

module.exports = { jobNeed, ACTIVE_JOB_STATES };
