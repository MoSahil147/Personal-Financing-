// Every balance change reads the current numbers, works out the new ones and
// writes them back. Two of those running at once would overwrite each other
// (the second write is based on numbers from before the first), so a change
// would be lost. This runs every request that changes money one at a time.
//
// It also makes retries safe: the app re-sends a request when the server is
// waking up, and if the first attempt actually got through, applying it again
// would count it twice. Each change carries an Idempotency-Key that stays the
// same across retries; a repeat gets the first answer back instead.

const REMEMBER_MS = 15 * 60 * 1000;
// A request that never finishes must not block everything after it forever.
const MAX_HOLD_MS = 60 * 1000;

let tail = Promise.resolve();
const seen = new Map(); // key -> { at, status, body, type }

function forgetOld(now) {
  for (const [key, v] of seen) if (now - v.at > REMEMBER_MS) seen.delete(key);
}

function moneyLock(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  let release;
  const done = new Promise((resolve) => { release = resolve; });
  const prev = tail;
  tail = prev.then(() => done);

  prev.then(() => {
    const timer = setTimeout(release, MAX_HOLD_MS);
    res.on('finish', () => { clearTimeout(timer); release(); });
    res.on('close', () => { clearTimeout(timer); release(); });

    const given = req.get('Idempotency-Key');
    // Tied to the exact request, so a key can only ever replay its own answer.
    const key = given && given.length <= 100 ? `${req.method} ${req.originalUrl} ${given}` : null;
    if (key) {
      forgetOld(Date.now());
      const earlier = seen.get(key);
      if (earlier) {
        res.status(earlier.status);
        if (earlier.type) res.type(earlier.type);
        return res.end(earlier.body);
      }
      const end = res.end.bind(res);
      res.end = (chunk, ...rest) => {
        // Only remember answers that were applied; a failed attempt may be retried.
        if (res.statusCode < 500) {
          seen.set(key, { at: Date.now(), status: res.statusCode, body: chunk, type: res.get('Content-Type') });
        }
        return end(chunk, ...rest);
      };
    }
    next();
  });
}

// Runs fn with the same one-at-a-time guarantee, for money changes made
// outside a request that changes money (e.g. while loading the boxes).
function exclusive(fn) {
  const run = tail.then(fn);
  tail = run.catch(() => {});
  return run;
}

module.exports = moneyLock;
module.exports.exclusive = exclusive;
