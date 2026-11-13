/* index-demo.js
 * Chapter 01 demo: an HNSW index (hnsw.js) built in the page, and a search
 * replayed step by step across three stacked panels, one per layer.
 *
 * The search shown is the real one. search() records every node it expands
 * and every distance it computes; this file only decides how long each of
 * those steps stays on screen.
 */
(function () {
  'use strict';

  var LJ = window.LJ;
  var host = document.querySelector('[data-index-demo]');
  if (!host || !LJ || !LJ.HNSW) return;

  var stage = host.querySelector('[data-stage]');
  var canvas = host.querySelector('.demo__canvas');
  var ctx = canvas.getContext('2d');
  var tierEls = [0, 1, 2].map(function (l) { return host.querySelector('.tier[data-layer="' + l + '"]'); });
  var stepEls = [0, 1, 2].map(function (l) { return host.querySelector('[data-step-for="' + l + '"]'); });
  var elResult = host.querySelector('[data-result]');
  var elVerify = host.querySelector('[data-verify]');
  var elCount = host.querySelector('[data-count-hnsw]');
  var elCountAll = host.querySelector('[data-count-all]');
  var elBar = host.querySelector('[data-bar-hnsw]');
  var elBarAll = host.querySelector('[data-bar-all]');
  var elN = host.querySelector('[data-n]');
  var btnDrop = host.querySelector('[data-drop]');

  var K = 5;          // neighbours returned
  var EF = 12;        // beam width on layer 0
  var PAD = 16;       // keep points off the panel borders, CSS px
  var TAU = Math.PI * 2;

  // Time each kind of step is held, in ms. The upper layers are slower on
  // purpose: they are the part worth watching.
  var PACE = {
    2: { expand: 220, check: 92 },
    1: { expand: 180, check: 72 },
    0: { expand: 52, check: 18 }
  };
  // The first, automatic replay runs at this pace. Searches the reader asks
  // for run faster, since by then they know what they are looking at.
  var SPEED_ASKED = 1.6;

  var S = {
    index: null, n: 0, aspect: 3.3, small: false,
    w: 0, h: 0, dpr: 1,
    rects: [],         // inner drawing rect per layer
    base: null,        // offscreen canvas: the static graph
    palette: null,
    query: null,       // { x, y } in index space
    timeline: null,
    startedAt: 0,
    speed: 1,
    playing: false,
    raf: 0,
    hover: null,       // { u, v } normalised position under the pointer
    shown: { count: -1, layer: -1 },
    touched: false,
    autoPlayed: false
  };

  /* Clustered points. Each cluster stands for one person, seen in many photos. */
  function makeFaces(rng, n, aspect, clusters) {
    var centres = [], guard = 0;
    while (centres.length < clusters && guard++ < 6000) {
      var c = { x: 0.06 * aspect + rng() * 0.88 * aspect, y: 0.2 + rng() * 0.6, s: 0.055 + rng() * 0.05 };
      // Ask for less elbow room the longer it takes to place a centre.
      var room = guard < 2000 ? 0.42 : 0.3;
      var clear = centres.every(function (o) { return Math.hypot(o.x - c.x, o.y - c.y) > room; });
      if (clear) centres.push(c);
    }
    var pts = [];
    var strays = Math.round(n * 0.07);
    while (pts.length < n - strays) {
      var k = centres[(rng() * centres.length) | 0];
      var x = k.x + LJ.gauss(rng) * k.s, y = k.y + LJ.gauss(rng) * k.s;
      if (x > 0.02 && x < aspect - 0.02 && y > 0.04 && y < 0.96) pts.push([x, y]);
    }
    while (pts.length < n) pts.push([0.03 + rng() * (aspect - 0.06), 0.05 + rng() * 0.9]);
    // Shuffle, so points are not inserted one cluster at a time.
    for (var i = pts.length - 1; i > 0; i--) {
      var j = (rng() * (i + 1)) | 0;
      var tmp = pts[i]; pts[i] = pts[j]; pts[j] = tmp;
    }
    return pts;
  }

  function buildIndex() {
    S.n = S.small ? 260 : 560;
    var pts = makeFaces(LJ.mulberry32(S.small ? 21 : 326), S.n, S.aspect, S.small ? 9 : 16);
    // Node levels come from their own stream, so the layer sizes do not shift
    // when the panel is a different shape. Seed 6 gives a well-spread top layer.
    var index = new LJ.HNSW({ M: 5, M0: 10, efConstruction: 40, maxLevel: 2, rng: LJ.mulberry32(6) });
    pts.forEach(function (p) { index.add(p[0], p[1]); });
    S.index = index;

    [0, 1, 2].forEach(function (l) {
      var el = host.querySelector('[data-layer-count="' + l + '"]');
      var count = index.nodesOnLayer(l).length;
      if (el) el.textContent = (l === 0 ? 'all ' : '') + count + ' faces';
    });
    if (elN) elN.textContent = String(S.n);
    if (elCountAll) elCountAll.textContent = String(S.n);
    if (elBarAll) elBarAll.style.width = '100%';
  }

  function layout() {
    var box = stage.getBoundingClientRect();
    S.w = box.width;
    S.h = box.height;
    S.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(S.w * S.dpr);
    canvas.height = Math.round(S.h * S.dpr);
    S.rects = tierEls.map(function (el) {
      var r = el.getBoundingClientRect();
      return { x: r.left - box.left + PAD, y: r.top - box.top + PAD, w: r.width - PAD * 2, h: r.height - PAD * 2 };
    });
  }

  function pos(layer, id) {
    var r = S.rects[layer];
    return { x: r.x + (S.index.xs[id] / S.aspect) * r.w, y: r.y + S.index.ys[id] * r.h };
  }

  function posQ(layer, q) {
    var r = S.rects[layer];
    return { x: r.x + (q.x / S.aspect) * r.w, y: r.y + q.y * r.h };
  }

  /* The static graph: every layer's links and nodes, drawn once. */
  function renderBase() {
    var off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    var c = off.getContext('2d');
    c.scale(S.dpr, S.dpr);
    var index = S.index, pal = S.palette;
    var style = [
      { edge: 0.17, width: 0.8, node: 1.9 },
      { edge: 0.34, width: 1, node: 2.7 },
      { edge: 0.55, width: 1.3, node: 3.6 }
    ];

    for (var l = 2; l >= 0; l--) {
      var ids = index.nodesOnLayer(l);
      var i, a, b;

      // On the upper layers, ghost the full set so it is clear they are subsets.
      if (l > 0) {
        c.fillStyle = pal.ink;
        c.globalAlpha = 0.16;
        c.beginPath();
        for (i = 0; i < index.size(); i++) {
          a = pos(l, i);
          c.moveTo(a.x + 1, a.y);
          c.arc(a.x, a.y, 1, 0, TAU);
        }
        c.fill();
      }

      c.strokeStyle = pal.ink;
      c.globalAlpha = style[l].edge;
      c.lineWidth = style[l].width;
      c.beginPath();
      var seen = Object.create(null);
      for (i = 0; i < ids.length; i++) {
        var id = ids[i];
        var links = index.links[l][id];
        a = pos(l, id);
        for (var j = 0; j < links.length; j++) {
          var key = id < links[j] ? id + '-' + links[j] : links[j] + '-' + id;
          if (seen[key]) continue;
          seen[key] = true;
          b = pos(l, links[j]);
          c.moveTo(a.x, a.y);
          c.lineTo(b.x, b.y);
        }
      }
      c.stroke();

      c.globalAlpha = 1;
      c.fillStyle = pal.ink;
      c.beginPath();
      for (i = 0; i < ids.length; i++) {
        a = pos(l, ids[i]);
        c.moveTo(a.x + style[l].node, a.y);
        c.arc(a.x, a.y, style[l].node, 0, TAU);
      }
      c.fill();
    }
    S.base = off;
  }

  /* Turn a search trace into timed drawing instructions. */
  function buildTimeline(trace) {
    var t = 0, items = [], checks = 1;
    trace.forEach(function (e) {
      if (e.t === 'enter') {
        items.push({ at: t, type: 'enter', layer: e.layer, id: e.id });
        t += 340;
      } else if (e.t === 'expand') {
        items.push({ at: t, type: 'expand', layer: e.layer, id: e.id });
        t += PACE[e.layer].expand;
      } else if (e.t === 'check') {
        checks++;
        items.push({ at: t, type: 'check', layer: e.layer, from: e.from, to: e.to, keep: e.keep, count: checks });
        t += PACE[e.layer].check;
      } else if (e.t === 'descend') {
        t += 140;
        items.push({ at: t, type: 'descend', layer: e.layer, to: e.to, id: e.id });
        t += 430;
      } else if (e.t === 'done') {
        t += 180;
        e.ids.forEach(function (id, i) {
          items.push({ at: t + i * 95, type: 'hit', layer: 0, id: id, order: i });
        });
        t += e.ids.length * 95 + 80;
        items.push({ at: t, type: 'circle', layer: 0, ids: e.ids });
        t += 520;
      }
    });
    return { items: items, duration: t, checks: checks };
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // A circle drawn the way a pen draws one: slightly uneven, overshooting its start.
  function penCircle(x, y, r, progress, phase) {
    var steps = 28;
    var sweep = TAU * 1.12 * progress;
    ctx.beginPath();
    for (var i = 0; i <= steps; i++) {
      var f = i / steps;
      var a = phase + sweep * f;
      var rr = r * (1 + 0.07 * Math.sin(a * 2 + phase * 3)) + f * progress * 1.8;
      var px = x + rr * Math.cos(a), py = y + rr * Math.sin(a);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  function drawQuery(q, strong) {
    var pal = S.palette;
    for (var l = 0; l < 3; l++) {
      var p = posQ(l, q), r = S.rects[l];
      ctx.strokeStyle = pal.blue;
      ctx.globalAlpha = strong ? 0.5 : 0.4;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(Math.round(p.x) + 0.5, r.y - PAD + 3);
      ctx.lineTo(Math.round(p.x) + 0.5, r.y + r.h + PAD - 3);
      ctx.moveTo(r.x - PAD + 3, Math.round(p.y) + 0.5);
      ctx.lineTo(r.x + r.w + PAD - 3, Math.round(p.y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      if (strong) {
        ctx.fillStyle = pal.paper;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6.5, 0, TAU);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = pal.blue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.4, 0, TAU);
        ctx.fill();
      }
    }
  }

  /* Paint the state of the replay at time T (ms since it started). */
  function drawAt(T) {
    var pal = S.palette, index = S.index;
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.clearRect(0, 0, S.w, S.h);
    if (S.base) ctx.drawImage(S.base, 0, 0, S.w, S.h);

    if (!S.timeline || !S.query) {
      if (S.hover) drawQuery({ x: S.hover.u * S.aspect, y: S.hover.v }, false);
      updateStatus(0, -1);
      return;
    }

    var items = S.timeline.items;
    var q = S.query;
    var layerNow = -1, count = 1;
    var lastExpand = { 0: -1, 1: -1, 2: -1 };
    var i, it, a, b, p;

    drawQuery(q, true);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // pass 1: links looked along
    for (i = 0; i < items.length; i++) {
      it = items[i];
      if (it.at > T) break;
      layerNow = it.type === 'descend' ? it.to : it.layer;
      if (it.type !== 'check') continue;
      count = it.count;
      a = pos(it.layer, it.from);
      b = pos(it.layer, it.to);
      var age = T - it.at;
      if (it.keep) {
        p = clamp01(age / 130);
        ctx.strokeStyle = pal.blue;
        ctx.globalAlpha = it.layer === 0 ? 0.75 : 0.9;
        ctx.lineWidth = it.layer === 0 ? 1.3 : 1.8;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.x + (b.x - a.x) * p, a.y + (b.y - a.y) * p);
        ctx.stroke();
      } else if (age < 300) {
        // looked at and rejected: a pencil stroke that fades
        ctx.strokeStyle = pal.blue;
        ctx.globalAlpha = 0.6 * (1 - age / 300);
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.globalAlpha = 1;

    // pass 2: the route, drops between layers, and visited nodes
    for (i = 0; i < items.length; i++) {
      it = items[i];
      if (it.at > T) break;
      if (it.type === 'expand') {
        a = pos(it.layer, it.id);
        if (it.layer > 0 && lastExpand[it.layer] !== -1) {
          b = pos(it.layer, lastExpand[it.layer]);
          p = clamp01((T - it.at) / 160);
          ctx.strokeStyle = pal.blue;
          ctx.lineWidth = 3.4;
          ctx.beginPath();
          ctx.moveTo(b.x, b.y);
          ctx.lineTo(b.x + (a.x - b.x) * p, b.y + (a.y - b.y) * p);
          ctx.stroke();
        }
        lastExpand[it.layer] = it.id;
        ctx.fillStyle = pal.blue;
        ctx.beginPath();
        ctx.arc(a.x, a.y, it.layer === 0 ? 3 : 4.6, 0, TAU);
        ctx.fill();
      } else if (it.type === 'enter') {
        a = pos(it.layer, it.id);
        p = clamp01((T - it.at) / 260);
        ctx.strokeStyle = pal.blue;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(a.x, a.y, 5 + 9 * p, 0, TAU);
        ctx.globalAlpha = 1 - p * 0.75;
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (it.type === 'descend') {
        a = pos(it.layer, it.id);
        b = pos(it.to, it.id);
        p = clamp01((T - it.at) / 330);
        ctx.strokeStyle = pal.blue;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.x + (b.x - a.x) * p, a.y + (b.y - a.y) * p);
        ctx.stroke();
        ctx.setLineDash([]);
        if (p >= 1) {
          ctx.fillStyle = pal.paper;
          ctx.beginPath();
          ctx.arc(b.x, b.y, 5.2, 0, TAU);
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    // pass 3: the answer. Each match is marked, then the set is circled in red pen.
    for (i = 0; i < items.length; i++) {
      it = items[i];
      if (it.at > T) break;
      if (it.type === 'hit') {
        a = pos(0, it.id);
        b = posQ(0, q);
        p = clamp01((T - it.at) / 200);
        ctx.strokeStyle = pal.red;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x + (a.x - b.x) * p, b.y + (a.y - b.y) * p);
        ctx.stroke();
        if (p >= 1) {
          ctx.fillStyle = pal.red;
          ctx.beginPath();
          ctx.arc(a.x, a.y, 3.4, 0, TAU);
          ctx.fill();
        }
      } else if (it.type === 'circle') {
        // Smallest tidy circle around the query and its matches.
        b = posQ(0, q);
        var gx = b.x, gy = b.y, j;
        for (j = 0; j < it.ids.length; j++) { a = pos(0, it.ids[j]); gx += a.x; gy += a.y; }
        gx /= it.ids.length + 1;
        gy /= it.ids.length + 1;
        var reach = Math.hypot(b.x - gx, b.y - gy);
        for (j = 0; j < it.ids.length; j++) {
          a = pos(0, it.ids[j]);
          reach = Math.max(reach, Math.hypot(a.x - gx, a.y - gy));
        }
        reach = Math.max(15, reach + 10);
        p = clamp01((T - it.at) / 380);
        ctx.strokeStyle = pal.red;
        ctx.lineWidth = 2.6;
        penCircle(gx, gy, reach, p, 0.9);
        if (p >= 1) {
          var tag = it.ids.length + ' NEAREST';
          ctx.font = '700 10px "M PLUS 1 Code", ui-monospace, monospace';
          ctx.textBaseline = 'middle';
          var tw = ctx.measureText(tag).width + 12;
          // Sit the tag beside the circle, on whichever side has room.
          var r0 = S.rects[0];
          var tx = gx + reach + 8 + tw < r0.x + r0.w + PAD ? gx + reach + 8 : gx - reach - 8 - tw;
          ctx.fillStyle = pal.red;
          ctx.fillRect(tx, gy - 9, tw, 18);
          ctx.fillStyle = pal.paper;
          ctx.fillText(tag, tx + 6, gy + 0.5);
        }
      }
    }

    updateStatus(count, T >= S.timeline.duration ? -1 : layerNow);
  }

  /* DOM side of the replay: live count, which layer is active. */
  function updateStatus(count, layer) {
    if (count !== S.shown.count) {
      S.shown.count = count;
      if (elCount) elCount.textContent = String(count);
      if (elBar) elBar.style.width = (100 * count / S.n).toFixed(1) + '%';
    }
    if (layer !== S.shown.layer) {
      S.shown.layer = layer;
      for (var l = 0; l < 3; l++) {
        tierEls[l].classList.toggle('is-active', l === layer);
        if (stepEls[l]) stepEls[l].classList.toggle('is-active', l === layer);
      }
    }
  }

  function finish() {
    var q = S.query, index = S.index;
    var found = index.search(q.x, q.y, K, EF, null).map(function (f) { return f.id; });
    var truth = index.bruteForce(q.x, q.y, K).map(function (f) { return f.id; });
    var right = found.filter(function (id) { return truth.indexOf(id) !== -1; }).length;
    var checks = S.timeline.checks;
    if (elResult) {
      elResult.textContent = 'Found the ' + K + ' nearest after comparing against ' + checks + ' of ' + S.n +
        ' faces. A full scan compares against all ' + S.n + '.';
    }
    if (elVerify) {
      elVerify.textContent = 'Checked against a full scan: ' + right + ' of ' + K + ' correct.' +
        (right < K ? ' The index is approximate. It trades a little accuracy for a lot of speed.' : '');
    }
  }

  function tick(now) {
    S.raf = 0;
    if (!S.playing) return;
    var T = (now - S.startedAt) * S.speed;
    if (T >= S.timeline.duration) {
      S.playing = false;
      drawAt(S.timeline.duration);
      finish();
      return;
    }
    drawAt(T);
    S.raf = requestAnimationFrame(tick);
  }

  function runSearch(qx, qy, speed) {
    var trace = [];
    S.query = { x: qx, y: qy };
    S.speed = speed || 1;
    S.index.search(qx, qy, K, EF, trace);
    S.timeline = buildTimeline(trace);
    S.shown.count = -1;
    if (elResult) elResult.textContent = 'Searching.';
    if (elVerify) elVerify.textContent = '';
    if (S.raf) cancelAnimationFrame(S.raf);

    if (LJ.reduceMotion && LJ.reduceMotion.matches) {
      // No replay: show where the search ended up.
      S.playing = false;
      drawAt(S.timeline.duration);
      finish();
      return;
    }
    S.playing = true;
    S.startedAt = performance.now();
    S.raf = requestAnimationFrame(tick);
  }

  /* Pointer position to a normalised spot inside whichever panel it is over. */
  function locate(e) {
    var box = canvas.getBoundingClientRect();
    var x = e.clientX - box.left, y = e.clientY - box.top;
    for (var l = 0; l < 3; l++) {
      var r = S.rects[l];
      if (x >= r.x - PAD && x <= r.x + r.w + PAD && y >= r.y - PAD && y <= r.y + r.h + PAD) {
        return { u: clamp01((x - r.x) / r.w), v: clamp01((y - r.y) / r.h) };
      }
    }
    return null;
  }

  var hoverQueued = false;
  canvas.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'touch') return;
    S.hover = locate(e);
    if (S.playing || S.timeline || hoverQueued) return;
    hoverQueued = true;
    requestAnimationFrame(function () {
      hoverQueued = false;
      if (!S.playing && !S.timeline) drawAt(0);
    });
  });

  canvas.addEventListener('pointerleave', function () {
    S.hover = null;
    if (!S.playing && !S.timeline) drawAt(0);
  });

  canvas.addEventListener('click', function (e) {
    var spot = locate(e);
    if (!spot) return;
    S.touched = true;
    runSearch(spot.u * S.aspect, spot.v, SPEED_ASKED);
  });

  if (btnDrop) {
    btnDrop.addEventListener('click', function () {
      S.touched = true;
      // Usually land near an existing face, sometimes anywhere at all.
      var index = S.index, qx, qy;
      if (Math.random() < 0.8) {
        var id = (Math.random() * index.size()) | 0;
        qx = index.xs[id] + (Math.random() - 0.5) * 0.12;
        qy = index.ys[id] + (Math.random() - 0.5) * 0.12;
      } else {
        qx = Math.random() * S.aspect;
        qy = Math.random();
      }
      runSearch(Math.min(S.aspect - 0.02, Math.max(0.02, qx)), Math.min(0.97, Math.max(0.03, qy)), SPEED_ASKED);
    });
  }

  function measureShape() {
    var r = tierEls[0].getBoundingClientRect();
    return { small: r.width < 520, aspect: (r.width - PAD * 2) / (r.height - PAD * 2) };
  }

  function setup(rebuild) {
    var shape = measureShape();
    if (!isFinite(shape.aspect) || shape.aspect <= 0) return;
    if (rebuild || !S.index) {
      S.small = shape.small;
      S.aspect = shape.aspect;
      buildIndex();
      S.query = null;
      S.timeline = null;
      S.playing = false;
    }
    S.palette = LJ.palette();
    layout();
    renderBase();
    if (S.timeline && !S.playing) drawAt(S.timeline.duration);
    else if (!S.playing) drawAt(0);
  }

  var resizeTimer = 0;
  if ('ResizeObserver' in window) {
    new ResizeObserver(function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        var shape = measureShape();
        var changed = shape.small !== S.small || Math.abs(shape.aspect - S.aspect) / S.aspect > 0.04;
        if (changed && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
        setup(changed);
      }, 140);
    }).observe(stage);
  }

  window.addEventListener('lj:edition', function () {
    if (!S.index) return;
    S.palette = LJ.palette();
    renderBase();
    if (!S.playing) drawAt(S.timeline ? S.timeline.duration : 0);
  });

  setup(true);

  /* Play one search the first time the demo scrolls into view, so it explains
     itself to a reader who never touches it. */
  if ('IntersectionObserver' in window) {
    var auto = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting || S.autoPlayed) return;
      S.autoPlayed = true;
      auto.disconnect();
      setTimeout(function () {
        if (!S.touched) runSearch(S.aspect * 0.71, 0.42);
      }, 450);
    }, { threshold: 0.45 });
    auto.observe(stage);
  }
})();
