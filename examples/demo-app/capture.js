// Test page for the `capture` window: a tiny state machine that mimics a real app with a loading
// splash. It flips <body data-state> so a selector-based capture block can trim to the content span:
//   0.0s  loading (black splash)  → the raw's dead head the capture window drops
//   2.0s  playing (content shown) → capture `start`
//   6.0s  done    (content ended) → capture `end`   (≈4s window)
//
// It ALSO calls window.__demorecorder?.mark(...) to show the event-based API. The optional-chain
// makes it a no-op outside a recording, so the call can live in real app code forever. Either signal
// works on its own; when both fire the engine keeps the first (see Driver.markCapture).
const setState = (state, mark) => {
  document.body.setAttribute('data-state', state);
  const badge = document.getElementById('badge');
  if (badge && state === 'done') badge.textContent = '■ Finalizado';
  // Event-based mark (harmless alongside the selector the example YAML watches).
  window.__demorecorder?.mark(mark);
};

setTimeout(() => setState('playing', 'start'), 2000);
setTimeout(() => setState('done', 'end'), 6000);
