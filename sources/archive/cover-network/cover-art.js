/* cover-art.js
 * The cover artwork. A small network learns a picture, and what it predicts
 * is printed as screentone. It can be given three pictures:
 *
 *   portrait   The default. The ink (features and contours) is traced from a
 *              photo ahead of time by execution/mangafy_portrait.py. The
 *              network learns the tone that goes under it: skin, hair, cloth.
 *   monogram   The initials, as plain dots.
 *   image      A picture the visitor hands over. It is read, shrunk and
 *              learned entirely in the page. It is never sent anywhere.
 *
 * The frame always prints in the day palette, black ink on cream paper,
 * whichever edition the page is in. A halftone face only reads one way round.
 *
 * Blue pencil = the under-drawing, there from the start.
 * Dots        = what the network currently predicts. Dot size is the predicted
 *               ink density at that spot.
 * Ink         = portrait only. Laid over the pencil from the top down as
 *               training goes on.
 *
 * Training runs off the main thread (field-trainer.js). This file prepares
 * the target, draws each frame the trainer sends back, and runs the controls.
 */
(function () {
  'use strict';

  var LJ = window.LJ;
  var host = document.querySelector('[data-cover-art]');
  if (!host || !LJ || !LJ.FieldNet || !LJ.createTrainer) return;

  var canvas = host.querySelector('.art__canvas');
  var frame = canvas.parentElement;
  var ctx = canvas.getContext('2d');
  var elStep = host.querySelector('[data-step]');
  var elLoss = host.querySelector('[data-loss]');
  var elWeights = host.querySelector('[data-weights]');
  var elText = host.querySelector('[data-art-text]');
  var elHow = host.querySelector('[data-art-how]');
  var probe = host.querySelector('[data-probe]');
  var fileInput = host.querySelector('[data-art-file]');
  var fileLabel = host.querySelector('[data-art-file-label]');
  var btnReset = host.querySelector('[data-art-reset]');
  var btnInitials = host.querySelector('[data-art-initials]');
  var btnSave = host.querySelector('[data-art-save]');
  var btnRetrain = host.querySelector('[data-retrain]');

  var portrait = LJ.portrait && LJ.portrait.tone ? LJ.portrait : null;
  var HOME = portrait ? 'portrait' : 'monogram';

  /* One network size per picture. Two letters need very little. The portrait's
     tone map is smooth, so a modest network with low frequencies fits it
     cleanly. A photograph, texture and all, needs several times the weights
     and finer frequencies to come out recognisable. */
  var JOBS = {
    portrait: {
      net: { features: 32, hidden: 40, sigma: 2.2, lr: 0.006 },
      batch: 256,
      maxSteps: 1100,
      lrEnd: 0.1,
      // Held back at first, so the picture can be seen arriving.
      pace: { tickMs: 14, slowUntil: 120, slowSteps: 2, fastSteps: 10, frameEvery: 2 }
    },
    monogram: {
      net: { features: 20, hidden: 24, sigma: 2.0, lr: 0.005 },
      batch: 192,
      maxSteps: 900,
      pace: { tickMs: 12, slowUntil: 180, slowSteps: 1, fastSteps: 4, frameEvery: 2 }
    },
    image: {
      net: { features: 48, hidden: 64, sigma: 6.0, lr: 0.003 },
      batch: 256,
      maxSteps: 1800,
      lrEnd: 0.15,
      // As fast as the device allows, with a fresh print after each burst.
      pace: { tickMs: 0, budgetMs: 100, frameEvery: 1 }
    }
  };
  // With reduced motion: train quietly, print once at the end.
  var QUIET_PACE = { tickMs: 0, budgetMs: 60, frameEvery: 0 };

  var TEXT = {
    portrait: 'The lines are traced from a photo of me. The dots are a small neural network working out the shading, live in your browser.',
    monogram: 'A small neural network is learning to draw these two letters, live in your browser.',
    looking: 'Looking for faces in your image.',
    learning: 'Now learning the picture. Nothing is uploaded: it all runs in this browser.',
    noFace: 'No face found. It may not be a person, or the faces are far from the camera.',
    unreadable: 'That file could not be read as an image. Try a JPG or a PNG.'
  };
  // The plain answer to "what is it learning?", shown under the description.
  var HOW = {
    own: 'What it learns: for any spot on the page, how dark the dot there should be. It memorises this one picture. It does not recognise what is in it.',
    image: 'Two models are at work. A face detector, trained in advance on many photos, marks the faces. The small network then memorises this one picture from scratch.'
  };
  var LABEL = {
    portrait: 'Portrait of Laxsan Jeya, drawn in ink lines and halftone dots.',
    monogram: 'The initials L J, printed in halftone dots.',
    image: 'Your image, printed in halftone dots.'
  };

  var TARGET_HEIGHT = 88;   // rows in the training bitmap
  var FLOOR = 0.09;         // predicted density under this prints as bare paper
  var INK_STEPS = 10;       // the ink comes down the page in this many held steps
  var FONT = '"Noto Serif Display", Georgia, serif';
  var TAU = Math.PI * 2;

  var S = {
    w: 0, h: 0, dpr: 1, aspect: 1,
    pitch: 9,             // distance between neighbouring dots, CSS px
    kind: HOME,           // 'portrait', 'monogram' or 'image'
    source: null,         // the visitor's image, kept so it can be re-cropped on resize
    faces: null,          // faces found in it, in its own pixels. null = not known
    fit: null,            // where that image sits in the frame, as fractions of the frame
    rect: null,           // where the portrait sits in the frame, CSS px
    target: null,         // { xy, t, n, tw, th }
    dots: null,           // { n, x, y, xy, val }
    hasFrame: false,
    sketch: null,         // offscreen canvas: everything drawn under the dots
    inked: null,          // offscreen canvas: the portrait's ink
    pal: null,            // the print palette
    pointer: null,        // { x, y } in CSS px while over the frame
    seed: 20261,
    jobId: 0,
    step: 0, maxSteps: 1, loss: null, done: false,
    quiet: false,
    onScreen: true
  };

  var pick = 0;             // counts image choices, so a slow one cannot overtake a newer one

  var trainer = LJ.createTrainer();

  trainer.onmessage = function (m) {
    if (m.id !== S.jobId) return;            // a frame from a job that has been replaced
    if (m.type === 'ready') {
      if (elWeights) elWeights.textContent = m.weights.toLocaleString('en-US');
    } else if (m.type === 'frame') {
      if (!S.dots || m.vals.length !== S.dots.n) return;   // lattice changed since it was computed
      S.dots.val = m.vals;
      S.hasFrame = true;
      S.step = m.step;
      S.loss = m.loss;
      S.done = m.done;
      draw();
      readout();
      if (m.done && btnSave) btnSave.hidden = S.kind !== 'image';
    }
  };


  /* The print palette and the portrait's layers
     ---------------------------------------------------------------------- */

  function printPalette() {
    var cs = getComputedStyle(frame);
    var read = function (name, fallback) { return cs.getPropertyValue(name).trim() || fallback; };
    return {
      paper: read('--print-paper', '#f4efe4'),
      ink: read('--print-ink', '#131210'),
      pencil: read('--print-pencil', '#2a3fe2'),
      red: read('--print-red', '#df3b1f')
    };
  }

  // The portrait's ink and its cut-out figure arrive as images with an alpha
  // channel. They are only ever drawn, never read back.
  var layers = { ink: null, figure: null };

  function loadLayer(name, url) {
    if (!url) return;
    var img = new Image();
    img.decoding = 'async';
    img.onload = function () {
      layers[name] = img;
      if (S.kind === 'portrait' && S.dots) {
        buildSketch();
        draw();
      }
    };
    img.src = url;
  }

  // A layer in one flat colour: fill, then keep the fill only where the layer is.
  function tint(img, colour) {
    var c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    var x = c.getContext('2d');
    x.fillStyle = colour;
    x.fillRect(0, 0, c.width, c.height);
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(img, 0, 0);
    return c;
  }

  var toneBytes = null;
  function portraitTone() {
    if (!toneBytes) {
      var raw = atob(portrait.tone);
      toneBytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) toneBytes[i] = raw.charCodeAt(i);
    }
    return toneBytes;
  }

  /* Fit the portrait over the frame: fill it, crop the overflow, and keep the
     head in view whatever shape the frame is. Most of any spare height comes
     off the bottom, so the crown and the disc behind it stay whole. */
  function placePortrait() {
    var k = portrait.w / portrait.h;
    var w = Math.max(S.w, S.h * k), h = w / k;
    var faceCentred = S.h * 0.47 - portrait.faceY * h;
    var topKept = (S.h - h) * 0.2;
    S.rect = {
      x: Math.min(0, Math.max(S.w - w, S.w * 0.5 - portrait.faceX * w)),
      y: Math.min(0, Math.max(S.h - h, Math.max(faceCentred, topKept))),
      w: w,
      h: h
    };
  }


  /* Targets
     ---------------------------------------------------------------------- */

  /* Layout of the monogram, shared by the pencil sketch and the training
     target so the two line up exactly. Returns draw calls for a W x H box. */
  function monogram(c, W, H) {
    c.textBaseline = 'alphabetic';
    c.textAlign = 'left';
    // Measure both letters at 100px, then scale. In this face the J hangs
    // below the baseline, so its full ink height is used, not its cap height.
    c.font = '900 100px ' + FONT;
    var mL = c.measureText('L');
    var mJ = c.measureText('J');
    var box = function (m) {
      return {
        w: m.actualBoundingBoxLeft + m.actualBoundingBoxRight,
        h: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent
      };
    };
    var bL = box(mL), bJ = box(mJ);
    // Corner to corner on a diagonal: together they span 80% of the width and
    // 88% of the height at most.
    var k = Math.min((0.8 * W) / (bL.w + bJ.w), (0.88 * H) / (bL.h + bJ.h));
    c.font = '900 ' + (100 * k).toFixed(2) + 'px ' + FONT;
    var padX = (W - (bL.w + bJ.w) * k) / 2;
    var padY = (H - (bL.h + bJ.h) * k) / 2;
    return [
      // L: upper left
      { ch: 'L', x: padX + mL.actualBoundingBoxLeft * k, y: padY + mL.actualBoundingBoxAscent * k },
      // J: lower right
      { ch: 'J', x: W - padX - mJ.actualBoundingBoxRight * k, y: H - padY - mJ.actualBoundingBoxDescent * k }
    ];
  }

  function targetSize() {
    var th = S.kind === 'monogram' ? TARGET_HEIGHT : TARGET_HEIGHT + 8;
    return { tw: Math.max(24, Math.round(th * S.aspect)), th: th };
  }

  function targetCanvas() {
    var size = targetSize();
    var off = document.createElement('canvas');
    off.width = size.tw;
    off.height = size.th;
    var c = off.getContext('2d', { willReadFrequently: true });
    c.fillStyle = '#fff';
    c.fillRect(0, 0, size.tw, size.th);
    return { off: off, c: c, tw: size.tw, th: size.th };
  }

  // Where each training sample sits, in the network's own coordinates.
  function sampleGrid(tw, th) {
    var xy = new Float32Array(tw * th * 2);
    for (var j = 0; j < th; j++) {
      for (var i = 0; i < tw; i++) {
        var k = j * tw + i;
        xy[2 * k] = ((i + 0.5) / tw * 2 - 1) * S.aspect;
        xy[2 * k + 1] = (j + 0.5) / th * 2 - 1;
      }
    }
    return xy;
  }

  /* Pixels of a small canvas to training rows: how dark the picture is at
     each sample. */
  function rowsFrom(c, tw, th, stretch) {
    var px = c.getImageData(0, 0, tw, th).data;
    var n = tw * th;
    var t = new Float32Array(n);
    var k;
    for (k = 0; k < n; k++) {
      t[k] = 1 - (0.299 * px[4 * k] + 0.587 * px[4 * k + 1] + 0.114 * px[4 * k + 2]) / 255;
    }

    if (stretch) {
      // Auto-contrast: stretch the 2nd to 98th percentile across the full
      // range, so a flat or dim photo still prints with real blacks.
      var hist = new Uint32Array(256);
      for (k = 0; k < n; k++) hist[Math.min(255, (t[k] * 255) | 0)]++;
      var lo = 0, hi = 255, seen = 0, cut = n * 0.02;
      while (lo < 255 && seen + hist[lo] < cut) seen += hist[lo++];
      seen = 0;
      while (hi > 0 && seen + hist[hi] < cut) seen += hist[hi--];
      if (hi - lo > 20) {
        var a = lo / 255, span = (hi - lo) / 255;
        for (k = 0; k < n; k++) t[k] = Math.min(1, Math.max(0, (t[k] - a) / span));
      }
    }
    return { xy: sampleGrid(tw, th), t: t, n: n, tw: tw, th: th };
  }

  function buildMonogramTarget() {
    var tc = targetCanvas();
    tc.c.fillStyle = '#000';
    monogram(tc.c, tc.tw, tc.th).forEach(function (g) { tc.c.fillText(g.ch, g.x, g.y); });
    S.target = rowsFrom(tc.c, tc.tw, tc.th, false);
  }

  /* Fit a visitor's image over the frame: fill it and crop the overflow. If
     faces were found, the crop is centred on them. If not, tall pictures keep
     more of their top, where a face usually is. */
  function fitImage() {
    var src = S.source;
    var k = Math.max(S.w / src.width, S.h / src.height);
    var w = src.width * k, h = src.height * k;
    var x = (S.w - w) / 2, y = (S.h - h) * 0.35;
    if (S.faces && S.faces.length) {
      var total = 0, cx = 0, cy = 0;
      S.faces.forEach(function (f) {
        var area = f.w * f.h;
        total += area;
        cx += (f.x + f.w / 2) * area;
        cy += (f.y + f.h / 2) * area;
      });
      x = S.w * 0.5 - (cx / total) * k;
      y = S.h * 0.45 - (cy / total) * k;
    }
    x = Math.min(0, Math.max(S.w - w, x));
    y = Math.min(0, Math.max(S.h - h, y));
    S.fit = { x: x / S.w, y: y / S.h, w: w / S.w, h: h / S.h };
  }

  function buildImageTarget() {
    var tc = targetCanvas();
    fitImage();
    tc.c.imageSmoothingEnabled = true;
    tc.c.imageSmoothingQuality = 'high';
    tc.c.drawImage(S.source, S.fit.x * tc.tw, S.fit.y * tc.th, S.fit.w * tc.tw, S.fit.h * tc.th);
    S.target = rowsFrom(tc.c, tc.tw, tc.th, true);
  }

  /* The portrait's target is read straight from its tone map, through the
     same placement the ink is drawn with, so dots and lines register. */
  function buildPortraitTarget() {
    var size = targetSize(), tw = size.tw, th = size.th;
    var tone = portraitTone(), pw = portrait.w, ph = portrait.h, r = S.rect;
    var n = tw * th;
    var t = new Float32Array(n);
    for (var j = 0; j < th; j++) {
      for (var i = 0; i < tw; i++) {
        // sample centre in frame px, then in tone map px
        var sx = ((i + 0.5) / tw * S.w - r.x) / r.w * pw - 0.5;
        var sy = ((j + 0.5) / th * S.h - r.y) / r.h * ph - 0.5;
        sx = Math.min(pw - 1.001, Math.max(0, sx));
        sy = Math.min(ph - 1.001, Math.max(0, sy));
        var x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
        var o = y0 * pw + x0;
        t[j * tw + i] = (
          (tone[o] * (1 - fx) + tone[o + 1] * fx) * (1 - fy) +
          (tone[o + pw] * (1 - fx) + tone[o + pw + 1] * fx) * fy
        ) / 255;
      }
    }
    S.target = { xy: sampleGrid(tw, th), t: t, n: n, tw: tw, th: th };
  }

  function buildTarget() {
    if (S.kind === 'portrait') buildPortraitTarget();
    else if (S.kind === 'image' && S.source) buildImageTarget();
    else buildMonogramTarget();
  }


  /* Drawing
     ---------------------------------------------------------------------- */

  function hexToRgb(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var v = parseInt(h, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  function hairline(c, x0, y0, x1, y1) {
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
  }

  /* Everything that sits under the dots. Built once per layout, then stamped
     onto the canvas each frame.
       portrait   the red disc, the figure standing in front of it, two
                  construction lines, and the ink as blue pencil
       monogram   letter outlines and their guides
       image      a soft ghost of the picture */
  function buildSketch() {
    var pal = S.pal;
    var off = document.createElement('canvas');
    off.width = Math.round(S.w * S.dpr);
    off.height = Math.round(S.h * S.dpr);
    var c = off.getContext('2d');
    c.scale(S.dpr, S.dpr);
    c.strokeStyle = pal.pencil;
    c.lineJoin = 'round';
    c.lineWidth = 1;
    S.inked = null;

    if (S.kind === 'portrait') {
      var r = S.rect;
      c.fillStyle = pal.red;
      c.beginPath();
      c.arc(r.x + portrait.sunX * r.w, r.y + portrait.sunY * r.h, portrait.sunR * r.w, 0, TAU);
      c.fill();
      if (layers.figure) c.drawImage(tint(layers.figure, pal.paper), r.x, r.y, r.w, r.h);

      // the centre line of the face and the line of the eyes
      if (portrait.axisX && portrait.eyeY) {
        var ax = Math.round(r.x + portrait.axisX * r.w) + 0.5;
        var ey = Math.round(r.y + portrait.eyeY * r.h) + 0.5;
        c.globalAlpha = 0.45;
        c.beginPath();
        hairline(c, ax, 0, ax, S.h);
        hairline(c, 0, ey, S.w, ey);
        c.stroke();
      }
      if (layers.ink) {
        c.globalAlpha = 0.55;
        c.drawImage(tint(layers.ink, pal.pencil), r.x, r.y, r.w, r.h);
        S.inked = tint(layers.ink, pal.ink);
      }
      S.sketch = off;
      return;
    }

    if (S.kind === 'image') {
      var t = S.target, rgb = hexToRgb(pal.pencil);
      var ghost = document.createElement('canvas');
      ghost.width = t.tw;
      ghost.height = t.th;
      var g = ghost.getContext('2d');
      var img = g.createImageData(t.tw, t.th);
      for (var k = 0; k < t.n; k++) {
        img.data[4 * k] = rgb[0];
        img.data[4 * k + 1] = rgb[1];
        img.data[4 * k + 2] = rgb[2];
        img.data[4 * k + 3] = Math.round(t.t[k] * 255);
      }
      g.putImageData(img, 0, 0);
      c.globalAlpha = 0.3;
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = 'high';
      c.drawImage(ghost, 0, 0, S.w, S.h);
    } else {
      var glyphs = monogram(c, S.w, S.h);
      // guides: baseline, cap line and left edge of each letter
      c.globalAlpha = 0.5;
      c.beginPath();
      glyphs.forEach(function (gl) {
        var m = c.measureText(gl.ch);
        var base = Math.round(gl.y) + 0.5;
        var cap = Math.round(gl.y - m.actualBoundingBoxAscent) + 0.5;
        var left = Math.round(gl.x - m.actualBoundingBoxLeft) + 0.5;
        hairline(c, 0, base, S.w, base);
        hairline(c, 0, cap, S.w, cap);
        hairline(c, left, 0, left, S.h);
      });
      c.stroke();
      // letter outlines
      c.globalAlpha = 0.95;
      c.lineWidth = 1.4;
      c.setLineDash([6, 4]);
      glyphs.forEach(function (gl) { c.strokeText(gl.ch, gl.x, gl.y); });
      c.setLineDash([]);
      c.lineWidth = 1;
    }

    // centre mark
    var mx = Math.round(S.w / 2) + 0.5, my = Math.round(S.h / 2) + 0.5;
    c.globalAlpha = 0.5;
    c.beginPath();
    hairline(c, mx - 9, my, mx + 9, my);
    hairline(c, mx, my - 9, mx, my + 9);
    c.stroke();
    S.sketch = off;
  }

  /* Dot lattice at 45 degrees, the classic screentone angle. Bold dots suit
     the monogram. A face gets a finer screen, about 80 dots across, so that
     it holds together. */
  function buildDots() {
    S.pitch = S.kind === 'monogram' ? 9 : Math.min(7.5, Math.max(5.5, S.w / 82));
    var p = S.pitch * Math.SQRT2;
    var xs = [], ys = [];
    var rowIndex = 0;
    for (var y = 0; y <= S.h + p; y += p / 2, rowIndex++) {
      for (var x = (rowIndex % 2) * (p / 2); x <= S.w + p; x += p) {
        xs.push(x);
        ys.push(y);
      }
    }
    var n = xs.length;
    var xy = new Float32Array(n * 2);
    for (var i = 0; i < n; i++) {
      xy[2 * i] = (xs[i] / S.w * 2 - 1) * S.aspect;
      xy[2 * i + 1] = ys[i] / S.h * 2 - 1;
    }
    S.dots = { n: n, x: Float32Array.from(xs), y: Float32Array.from(ys), xy: xy, val: new Float32Array(n) };
    S.hasFrame = false;
  }

  function measure() {
    S.w = frame.clientWidth;
    S.h = frame.clientHeight;
    S.dpr = Math.min(window.devicePixelRatio || 1, 2);
    S.aspect = S.w / S.h;
    canvas.width = Math.round(S.w * S.dpr);
    canvas.height = Math.round(S.h * S.dpr);
  }

  /* Print the dots onto any context. The live canvas also gets the pointer
     loupe; a saved copy does not. */
  function printDots(c, ptr) {
    var d = S.dots;
    var rMax = S.pitch * 0.69;
    var lens = 96, lens2 = lens * lens;
    c.beginPath();
    for (var i = 0; i < d.n; i++) {
      var v = d.val[i];
      // Below the floor nothing prints, which keeps stray specks off the paper.
      var r = v > FLOOR ? rMax * Math.sqrt((v - FLOOR) / (1 - FLOOR)) : 0;
      if (ptr) {
        // Under the pointer the lattice itself shows through, like a loupe on print.
        var dx = d.x[i] - ptr.x, dy = d.y[i] - ptr.y;
        var q = dx * dx + dy * dy;
        if (q < lens2) {
          var k = 1 - Math.sqrt(q) / lens;
          r = Math.max(r * (1 + 0.35 * k * k), 1.5 * k);
        }
      }
      if (r < 0.35) continue;
      c.moveTo(d.x[i] + r, d.y[i]);
      c.arc(d.x[i], d.y[i], r, 0, TAU);
    }
    c.fill();
  }

  /* How far down the frame the ink has come, 0 to 1. It follows the training
     run, in a few held steps. */
  function inkReach() {
    if (S.done || S.quiet) return 1;
    var p = (S.step / S.maxSteps - 0.1) / 0.75;
    return Math.min(1, Math.max(0, Math.floor(p * INK_STEPS) / INK_STEPS));
  }

  function draw() {
    var pal = S.pal, ptr = S.pointer;
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.clearRect(0, 0, S.w, S.h);
    if (S.sketch) ctx.drawImage(S.sketch, 0, 0, S.w, S.h);

    if (S.hasFrame) {
      ctx.fillStyle = pal.ink;
      printDots(ctx, ptr);
    }

    if (S.kind === 'portrait' && S.inked) {
      var reach = inkReach(), r = S.rect;
      if (reach > 0) {
        var edge = Math.round(S.h * reach);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, S.w, edge);
        ctx.clip();
        ctx.drawImage(S.inked, r.x, r.y, r.w, r.h);
        ctx.restore();
        if (reach < 1) {
          // the line the ink has reached
          ctx.strokeStyle = pal.pencil;
          ctx.lineWidth = 1;
          ctx.beginPath();
          hairline(ctx, 0, edge + 0.5, S.w, edge + 0.5);
          ctx.stroke();
        }
      }
    }

    if (S.kind === 'image' && S.faces && S.faces.length && S.fit) markFaces();

    if (ptr) {
      ctx.strokeStyle = pal.pencil;
      ctx.lineWidth = 1;
      ctx.beginPath();
      var hx = Math.round(ptr.x) + 0.5, hy = Math.round(ptr.y) + 0.5;
      hairline(ctx, hx, 0, hx, S.h);
      hairline(ctx, 0, hy, S.w, hy);
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ptr.x, ptr.y, 9, 0, TAU);
      ctx.stroke();
    }
  }

  /* A pencil bracket round each face the detector found, with how sure it was. */
  function markFaces() {
    var pal = S.pal, src = S.source, fit = S.fit;
    ctx.lineJoin = 'miter';
    ctx.font = '700 10px "M PLUS 1 Code", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    S.faces.forEach(function (f) {
      var x = (fit.x + f.x / src.width * fit.w) * S.w;
      var y = (fit.y + f.y / src.height * fit.h) * S.h;
      var w = f.w / src.width * fit.w * S.w;
      var h = f.h / src.height * fit.h * S.h;
      if (x + w < 8 || y + h < 8 || x > S.w - 8 || y > S.h - 8) return;   // cropped out of the frame
      var arm = Math.max(8, Math.min(w, h) * 0.24);
      var corners = function () {
        ctx.beginPath();
        ctx.moveTo(x, y + arm); ctx.lineTo(x, y); ctx.lineTo(x + arm, y);
        ctx.moveTo(x + w - arm, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + arm);
        ctx.moveTo(x + w, y + h - arm); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - arm, y + h);
        ctx.moveTo(x + arm, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - arm);
        ctx.stroke();
      };
      // paper first, then pencil, so the bracket shows over light and dark alike
      ctx.strokeStyle = pal.paper;
      ctx.lineWidth = 5;
      corners();
      ctx.strokeStyle = pal.pencil;
      ctx.lineWidth = 2.5;
      corners();

      var tag = 'FACE ' + Math.round(f.score * 100) + '%';
      var tw = ctx.measureText(tag).width + 12;
      var tx = Math.min(S.w - tw - 4, Math.max(4, x));
      var ty = y - 22 > 4 ? y - 22 : y + h + 6;
      ctx.fillStyle = pal.pencil;
      ctx.fillRect(tx, ty, tw, 17);
      ctx.fillStyle = pal.paper;
      ctx.fillText(tag, tx + 6, ty + 9);
    });
  }

  function readout() {
    if (elStep) elStep.textContent = ('000' + S.step).slice(-4);
    if (elLoss) elLoss.textContent = S.loss === null ? '0.000' : Math.max(0, S.loss).toFixed(3);
  }


  /* Jobs
     ---------------------------------------------------------------------- */

  function startJob() {
    var job = JOBS[S.kind];
    S.quiet = !!(LJ.reduceMotion && LJ.reduceMotion.matches);
    S.jobId++;
    S.step = 0;
    S.maxSteps = job.maxSteps;
    S.loss = null;
    S.done = false;
    S.hasFrame = false;
    if (btnSave) btnSave.hidden = true;
    trainer.post({
      type: 'start',
      id: S.jobId,
      net: { features: job.net.features, hidden: job.net.hidden, sigma: job.net.sigma, lr: job.net.lr, seed: S.seed },
      batch: job.batch,
      maxSteps: job.maxSteps,
      lrEnd: job.lrEnd || 1,
      pace: S.quiet ? QUIET_PACE : job.pace,
      targetXY: S.target.xy,
      targetT: S.target.t,
      dotsXY: S.dots.xy
    });
    if (!S.onScreen) trainer.post({ type: 'pause' });
    draw();
    readout();
  }

  /* Lay everything out for the frame's current size. A fresh network when the
     picture or the frame's proportions change, the same one otherwise. */
  function setup(fresh) {
    measure();
    if (S.w < 40 || S.h < 40) return;
    S.pal = printPalette();
    if (S.kind === 'portrait') placePortrait();
    if (fresh || !S.target) buildTarget();
    buildSketch();
    buildDots();
    if (fresh || !S.jobId) {
      startJob();
    } else {
      trainer.post({ type: 'dots', dotsXY: S.dots.xy });
      draw();
    }
  }

  function imageText() {
    var faces = S.faces;
    if (!faces) return TEXT.learning;                         // the detector could not be reached
    if (!faces.length) return TEXT.noFace + ' ' + TEXT.learning;
    var found = faces.length === 1 ? 'Found 1 face' : 'Found ' + faces.length + ' faces';
    return found + ', marked in blue. ' + TEXT.learning;
  }

  function syncControls() {
    var kind = S.kind;
    if (elText) elText.textContent = kind === 'image' ? imageText() : TEXT[kind];
    if (elHow) elHow.textContent = kind === 'image' && S.faces ? HOW.image : HOW.own;
    if (fileLabel) fileLabel.textContent = kind === 'image' ? 'Use another image' : 'Use your own image';
    if (btnReset) {
      btnReset.hidden = kind === HOME;
      btnReset.textContent = HOME === 'portrait' ? 'Back to the portrait' : 'Back to the initials';
    }
    if (btnInitials) btnInitials.hidden = kind !== 'portrait';
    if (btnSave && kind !== 'image') btnSave.hidden = true;
    canvas.setAttribute('aria-label', LABEL[kind]);
  }

  function show(kind) {
    pick++;                                  // lets go of any image still being looked at
    S.kind = kind;
    if (kind !== 'image') {
      S.source = null;
      S.faces = null;
    }
    S.seed = kind === HOME ? 20261 : (Math.random() * 1e9) | 0;
    syncControls();
    whenReady(kind, function () { setup(true); });
  }


  /* A visitor's own image
     ---------------------------------------------------------------------- */

  function decode(file) {
    var viaElement = function () {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
        img.src = url;
      });
    };
    if (!window.createImageBitmap) return viaElement();
    return window.createImageBitmap(file).catch(viaElement);
  }

  // Keep a modest working copy, flattened onto white, and let the original go.
  function workingCopy(src) {
    var sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
    if (!sw || !sh) throw new Error('unreadable');
    var k = Math.min(1, 640 / Math.max(sw, sh));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * k));
    c.height = Math.max(1, Math.round(sh * k));
    var x = c.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, c.width, c.height);
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, c.width, c.height);
    if (src.close) src.close();
    return c;
  }

  /* A visitor's image is first checked for faces, then learned. The check
     gets a few seconds, since its first run has a download to make. If it
     takes longer, learning starts without it, and any faces are marked when
     the answer arrives. */
  function useFile(file) {
    if (!file) return;
    var fail = function () { if (elText) elText.textContent = TEXT.unreadable; };
    if (file.type && file.type.indexOf('image/') !== 0) { fail(); return; }
    var mine = ++pick;
    decode(file).then(function (src) {
      if (mine !== pick) return;             // a newer choice has replaced this one
      var copy = workingCopy(src);
      var begun = false;
      var begin = function (faces) {
        begun = true;
        S.source = copy;
        S.faces = faces;
        S.kind = 'image';
        S.seed = (Math.random() * 1e9) | 0;
        syncControls();
        setup(true);
      };
      if (!LJ.findFaces) { begin(null); return; }

      if (elText) elText.textContent = TEXT.looking;
      var patience = setTimeout(function () {
        if (mine === pick && !begun) begin(null);
      }, 6000);
      LJ.findFaces(copy).then(function (faces) {
        clearTimeout(patience);
        if (mine !== pick) return;
        if (!begun) { begin(faces); return; }
        // Late. Keep the crop that training started with, and mark the faces.
        S.faces = faces;
        syncControls();
        draw();
      }, function () {
        clearTimeout(patience);
        if (mine === pick && !begun) begin(null);
      });
    }).catch(fail);
  }

  if (fileInput) {
    fileInput.addEventListener('change', function () {
      useFile(fileInput.files && fileInput.files[0]);
      fileInput.value = '';   // so choosing the same file again still fires
    });
  }

  // Dropping a picture onto the frame works too.
  ['dragenter', 'dragover'].forEach(function (type) {
    frame.addEventListener(type, function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') === -1) return;
      e.preventDefault();
      frame.classList.add('is-drop');
    });
  });
  ['dragleave', 'dragend', 'drop'].forEach(function (type) {
    frame.addEventListener(type, function () { frame.classList.remove('is-drop'); });
  });
  frame.addEventListener('drop', function (e) {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    useFile(e.dataTransfer.files[0]);
  });

  if (btnReset) btnReset.addEventListener('click', function () { show(HOME); });
  if (btnInitials) btnInitials.addEventListener('click', function () { show('monogram'); });

  if (btnRetrain) {
    btnRetrain.addEventListener('click', function () {
      S.seed = (Math.random() * 1e9) | 0;
      startJob();
    });
  }

  // Save the print as it stands: dots on paper, without the pencil or the loupe.
  if (btnSave) {
    btnSave.addEventListener('click', function () {
      if (!S.dots || !S.hasFrame) return;
      var scale = 2;
      var out = document.createElement('canvas');
      out.width = Math.round(S.w * scale);
      out.height = Math.round(S.h * scale);
      var c = out.getContext('2d');
      c.scale(scale, scale);
      c.fillStyle = S.pal.paper;
      c.fillRect(0, 0, S.w, S.h);
      c.fillStyle = S.pal.ink;
      printDots(c, null);
      out.toBlob(function (blob) {
        if (!blob) return;
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'screentone.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      }, 'image/png');
    });
  }


  /* Pointer: a loupe, plus the value printed at that spot
     ---------------------------------------------------------------------- */

  var redrawQueued = false;
  function queueRedraw() {
    if (redrawQueued) return;
    redrawQueued = true;
    requestAnimationFrame(function () {
      redrawQueued = false;
      draw();
    });
  }

  function updateProbe() {
    if (!probe || !S.pointer || !S.dots || !S.hasFrame) return;
    var d = S.dots, px = S.pointer.x, py = S.pointer.y;
    var best = 0, bestQ = Infinity;
    for (var i = 0; i < d.n; i++) {
      var dx = d.x[i] - px, dy = d.y[i] - py;
      var q = dx * dx + dy * dy;
      if (q < bestQ) { bestQ = q; best = i; }
    }
    var x = (px / S.w * 2 - 1) * S.aspect;
    var y = py / S.h * 2 - 1;
    probe.textContent = 'x ' + x.toFixed(2) + '  y ' + y.toFixed(2) + '  ink ' + d.val[best].toFixed(2);
    var flip = px > S.w * 0.55;
    var below = py < 44;
    probe.style.transform = 'translate(' +
      Math.round(px + (flip ? -14 : 14)) + 'px,' +
      Math.round(py + (below ? 16 : -30)) + 'px)' + (flip ? ' translateX(-100%)' : '');
    probe.classList.add('is-on');
  }

  canvas.addEventListener('pointermove', function (e) {
    var box = canvas.getBoundingClientRect();
    S.pointer = { x: e.clientX - box.left, y: e.clientY - box.top };
    updateProbe();
    queueRedraw();
  });

  canvas.addEventListener('pointerleave', function () {
    S.pointer = null;
    if (probe) probe.classList.remove('is-on');
    queueRedraw();
  });


  /* Housekeeping
     ---------------------------------------------------------------------- */

  // Stay idle while the cover is scrolled away.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      var on = entries[0].isIntersecting;
      if (on === S.onScreen) return;
      S.onScreen = on;
      trainer.post({ type: on ? 'resume' : 'pause' });
    }, { threshold: 0.02 }).observe(host);
  }

  // Resize: keep the trained network unless the frame's proportions really change.
  var resizeTimer = 0;
  if ('ResizeObserver' in window) {
    new ResizeObserver(function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        var w = frame.clientWidth, h = frame.clientHeight;
        if (Math.abs(w - S.w) < 2 && Math.abs(h - S.h) < 2) return;
        var reshape = !S.jobId || Math.abs(w / h - S.aspect) / S.aspect > 0.06;
        setup(reshape);
      }, 140);
    }).observe(frame);
  }

  // The monogram is drawn with the display face, so it waits for that to load.
  // The other pictures can start at once.
  function whenReady(kind, go) {
    if (kind !== 'monogram' || !document.fonts || !document.fonts.load) { go(); return; }
    document.fonts.load('900 100px "Noto Serif Display"').then(go, go);
  }

  if (portrait) {
    loadLayer('ink', host.getAttribute('data-portrait-ink'));
    loadLayer('figure', host.getAttribute('data-portrait-figure'));
  }
  syncControls();
  whenReady(S.kind, function () { setup(true); });
})();
