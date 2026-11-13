/* field-trainer.js
 * Trains a FieldNet away from the main thread and reports back as it goes.
 *
 * The trainer speaks a small message protocol. Normally it runs in a Web
 * Worker, so a large network can train flat out without the page stuttering.
 * Where a worker cannot be started it runs inline, behind the same interface.
 *
 *   to the trainer
 *     { type: 'start', id, net, batch, maxSteps, lrEnd, pace, targetXY, targetT, dotsXY }
 *     { type: 'dots', dotsXY }     new sample points, same network
 *     { type: 'pause' } | { type: 'resume' } | { type: 'stop' }
 *
 *   from the trainer
 *     { type: 'ready', id, weights }
 *     { type: 'frame', id, step, loss, vals, done }
 *
 * `pace` sets the tempo. Either a fixed number of steps per tick
 * (slowSteps until slowUntil, then fastSteps), or budgetMs to train as many
 * steps as fit in that time. frameEvery says how often to send a frame, in
 * ticks. Zero means only once training has finished.
 *
 * `lrEnd` (optional) lets the learning rate fall in a straight line to that
 * fraction of its starting value by the last step. Large steps find the
 * picture quickly. Small ones at the end settle the flat areas, which would
 * otherwise stay speckled.
 */
(function (root) {
  'use strict';

  var LJ = (root.LJ = root.LJ || {});

  /* The trainer itself. `scope` is the worker's global, or a stand-in object
     when running inline. It must not touch anything outside `scope`, because
     in a worker this function arrives as source text with no closure. */
  function trainerMain(scope) {
    'use strict';

    var FieldNet = scope.LJ.FieldNet;
    var mulberry32 = scope.LJ.mulberry32;
    var clock = scope.performance;
    var now = function () { return clock ? clock.now() : Date.now(); };

    var S = null;          // the job in progress
    var paused = false;
    var timer = 0;

    // Cross-entropy can never go below the entropy of a soft target, so that
    // floor is subtracted. The loss reported then falls towards zero as the
    // fit improves, whatever the picture.
    function entropy(t) {
      return t <= 0 || t >= 1 ? 0 : -(t * Math.log(t) + (1 - t) * Math.log(1 - t));
    }

    function step() {
      var n = S.targetT.length, idx = S.idx, floor = 0;
      for (var b = 0; b < idx.length; b++) {
        idx[b] = (S.rng() * n) | 0;
        floor += S.floorOf[idx[b]];
      }
      if (S.lrEnd < 1) S.net.lr = S.lrStart * (1 - (1 - S.lrEnd) * S.net.step / S.maxSteps);
      var loss = S.net.trainStep(S.targetEnc, S.targetT, idx, idx.length) - floor / idx.length;
      S.loss = S.loss === null ? loss : S.loss * 0.94 + loss * 0.06;
    }

    function sendFrame(done) {
      var vals = new Float32Array(S.dotsN);
      S.net.predict(S.dotsEnc, S.dotsN, vals);
      scope.postMessage(
        { type: 'frame', id: S.id, step: S.net.step, loss: S.loss, vals: vals, done: !!done },
        [vals.buffer]
      );
    }

    function schedule() {
      if (S && !paused && !S.finished) timer = setTimeout(tick, S.pace.tickMs || 0);
    }

    function tick() {
      timer = 0;
      if (!S || paused || S.finished) return;
      var net = S.net, pace = S.pace;

      if (pace.budgetMs) {
        var t0 = now();
        do { step(); } while (net.step < S.maxSteps && now() - t0 < pace.budgetMs);
      } else {
        var k = net.step < (pace.slowUntil || 0) ? (pace.slowSteps || 1) : (pace.fastSteps || 1);
        while (k-- > 0 && net.step < S.maxSteps) step();
      }

      S.ticks++;
      var done = net.step >= S.maxSteps;
      if (done) S.finished = true;
      if (done || (pace.frameEvery && S.ticks % pace.frameEvery === 0)) sendFrame(done);
      schedule();
    }

    function start(m) {
      if (timer) clearTimeout(timer);
      timer = 0;
      var net = new FieldNet(m.net);
      var n = m.targetT.length;
      var floorOf = new Float32Array(n);
      for (var i = 0; i < n; i++) floorOf[i] = entropy(m.targetT[i]);
      S = {
        id: m.id,
        net: net,
        rng: mulberry32((m.net.seed || 1) * 7 + 1),
        idx: new Uint32Array(m.batch),
        targetT: m.targetT,
        targetEnc: net.encode(m.targetXY, n),
        floorOf: floorOf,
        dotsN: m.dotsXY.length / 2,
        dotsEnc: null,
        maxSteps: m.maxSteps,
        lrStart: net.lr,
        lrEnd: m.lrEnd > 0 && m.lrEnd < 1 ? m.lrEnd : 1,
        pace: m.pace,
        loss: null,
        ticks: 0,
        finished: false
      };
      S.dotsEnc = net.encode(m.dotsXY, S.dotsN);
      scope.postMessage({ type: 'ready', id: S.id, weights: net.paramCount() });
      if (m.pace.frameEvery) sendFrame(false);   // the untrained field, before the first step
      schedule();
    }

    scope.onmessage = function (e) {
      var m = e.data;
      if (m.type === 'start') {
        start(m);
      } else if (m.type === 'dots') {
        if (!S) return;
        S.dotsN = m.dotsXY.length / 2;
        S.dotsEnc = S.net.encode(m.dotsXY, S.dotsN);
        sendFrame(S.finished);
      } else if (m.type === 'pause') {
        paused = true;
        if (timer) clearTimeout(timer);
        timer = 0;
      } else if (m.type === 'resume') {
        if (!paused) return;
        paused = false;
        schedule();
      } else if (m.type === 'stop') {
        if (timer) clearTimeout(timer);
        timer = 0;
        S = null;
      }
    };
  }

  /**
   * Start a trainer. Returns { post(message), onmessage, terminate(), mode }.
   * Set onmessage to a function that takes the trainer's messages.
   */
  LJ.createTrainer = function () {
    var api = { onmessage: null, mode: 'worker' };
    var backend = null;
    var lastStart = null;

    function deliver(data) {
      if (api.onmessage) api.onmessage(data);
    }

    function useInline() {
      api.mode = 'inline';
      var scope = {
        LJ: LJ,
        performance: root.performance,
        onmessage: null,
        postMessage: function (data) { setTimeout(function () { deliver(data); }, 0); }
      };
      trainerMain(scope);
      backend = {
        post: function (msg) { setTimeout(function () { scope.onmessage({ data: msg }); }, 0); },
        kill: function () { scope.onmessage({ data: { type: 'stop' } }); }
      };
    }

    function useWorker() {
      // The worker is built from the functions already loaded on this page, so
      // it also works when the site is opened straight from disk, where a
      // worker script file would be refused.
      var source = '(' + LJ.defineFieldNet.toString() + ')(self);\n(' + trainerMain.toString() + ')(self);';
      var url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      var worker = new Worker(url);
      var heard = false;
      worker.onmessage = function (e) {
        heard = true;
        deliver(e.data);
      };
      worker.onerror = function () {
        if (heard) return;
        // It never started. Carry on inline and replay the job it was given.
        worker.terminate();
        useInline();
        if (lastStart) backend.post(lastStart);
      };
      backend = {
        post: function (msg) { worker.postMessage(msg); },
        kill: function () { worker.terminate(); URL.revokeObjectURL(url); }
      };
    }

    try {
      if (!root.Worker || !root.Blob || !root.URL || !root.URL.createObjectURL) throw new Error('no worker support');
      useWorker();
    } catch (err) {
      useInline();
    }

    api.post = function (msg) {
      if (msg.type === 'start') lastStart = msg;
      backend.post(msg);
    };
    api.terminate = function () { backend.kill(); };
    return api;
  };
})(typeof window !== 'undefined' ? window : globalThis);
