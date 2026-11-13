/* cover-art.js
 * The framed print on the cover, and the face detection demo that lives in it.
 *
 * At rest the frame shows the portrait: ink lines over halftone dots, in
 * front of a red disc. All of it is prepared ahead of time from a photo by
 * execution/mangafy_portrait.py. This file only prints it.
 *
 * Give the frame a photo (the visitor's own, or the sample) and it becomes a
 * face detector. The photo is printed as halftone, face-finder.js looks for
 * faces in it, and each face found gets a bracket and the model's confidence.
 * The photo is read in the page and is never sent anywhere.
 *
 * The frame always prints in the day palette, black ink on cream paper,
 * whichever edition the page is in. A halftone face only reads one way round.
 */
(function () {
  'use strict';

  var LJ = window.LJ;
  var host = document.querySelector('[data-cover-art]');
  if (!host || !LJ) return;

  var canvas = host.querySelector('.art__canvas');
  var frame = canvas.parentElement;
  var ctx = canvas.getContext('2d');
  var elText = host.querySelector('[data-art-text]');
  var elHow = host.querySelector('[data-art-how]');
  var elResult = host.querySelector('[data-art-result]');
  var elFaces = host.querySelector('[data-faces]');
  var elScore = host.querySelector('[data-score]');
  var elTime = host.querySelector('[data-time]');
  var probe = host.querySelector('[data-probe]');
  var fileInput = host.querySelector('[data-art-file]');
  var fileLabel = host.querySelector('[data-art-file-label]');
  var btnSample = host.querySelector('[data-art-sample]');
  var btnReset = host.querySelector('[data-art-reset]');
  var btnSave = host.querySelector('[data-art-save]');

  var portrait = LJ.portrait && LJ.portrait.tone ? LJ.portrait : null;

  var TEXT = {
    portrait: 'This frame is also a face detector. Give it a photo and a neural network will mark every face it finds.',
    looking: 'Looking for faces. The detector is about 2 MB and loads the first time only.',
    none: 'No face found. It may not be a person, or the faces are far from the camera.',
    failed: 'The face detector could not be loaded, so the photo is printed without a result. Check your connection and try again.',
    unreadable: 'That file could not be read as an image. Try a JPG or a PNG.'
  };
  var HOW = {
    portrait: 'It runs in your browser and your photo is not uploaded. The portrait above is traced from a photo of me.',
    image: 'The model is BlazeFace, by Google, run with MediaPipe. It runs in your browser, and the photo is not uploaded.'
  };
  var LABEL = {
    portrait: 'Portrait of Laxsan Jeya, drawn in ink lines and halftone dots.',
    image: 'Your photo, printed in halftone dots, with any faces found marked.'
  };

  var FLOOR = 0.09;          // density under this prints as bare paper
  var REVEAL_MS = 1500;      // how long the portrait takes to arrive
  var REVEAL_STEPS = 12;     // in this many held frames
  var SCAN_MS = 1500;        // one pass of the scan line while looking for faces
  var MIN_SCAN_MS = 900;     // the scan is shown for at least this long
  var GIVE_UP_MS = 20000;    // how long to wait for the detector before saying so
  var TAU = Math.PI * 2;

  var S = {
    w: 0, h: 0, dpr: 1, aspect: 1,
    pitch: 7,              // distance between neighbouring dots, CSS px
    kind: 'portrait',      // or 'image'
    source: null,          // the photo being shown: a small canvas
    credit: '',            // a credit line for it, when it is the sample
    bitmap: null,          // its brightness, cropped to the frame: { t, w, h }
    fit: null,             // where the photo sits in the frame, as fractions of the frame
    faces: null,           // faces found in it, in its own pixels. null = no answer yet
    detecting: false,
    failed: false,
    took: 0,               // how long the detector took, ms
    rect: null,            // where the portrait sits in the frame, CSS px
    dots: null,            // { n, x, y, val }
    under: null,           // offscreen canvas: everything drawn under the dots
    inked: null,           // offscreen canvas: the portrait's ink
    pal: null,
    pointer: null,         // { x, y } in CSS px while over the frame
    reveal: 1,             // 0 to 1: how far the portrait has arrived
    revealStart: 0,
    scanStart: 0,
    raf: 0
  };

  var pick = 0;            // counts photo choices, so a slow one cannot overtake a newer one

  function quiet() {
    return !!(LJ.reduceMotion && LJ.reduceMotion.matches);
  }


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
        buildUnder();
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


  /* A photo: where it sits, and how dark it is
     ---------------------------------------------------------------------- */

  /* Fit the photo over the frame: fill it and crop the overflow. If faces
     were found, the crop is centred on them. If not, tall pictures keep more
     of their top, where a face usually is. */
  function fitPhoto() {
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

  /* The cropped photo as a small map of ink density, 0 to 1. Contrast is
     stretched between the 2nd and 98th percentiles, so a flat or dim photo
     still prints with real blacks. */
  function buildBitmap() {
    fitPhoto();
    var bh = 220, bw = Math.max(24, Math.round(bh * S.aspect));
    var off = document.createElement('canvas');
    off.width = bw;
    off.height = bh;
    var c = off.getContext('2d', { willReadFrequently: true });
    c.fillStyle = '#fff';
    c.fillRect(0, 0, bw, bh);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(S.source, S.fit.x * bw, S.fit.y * bh, S.fit.w * bw, S.fit.h * bh);

    var px = c.getImageData(0, 0, bw, bh).data;
    var n = bw * bh, t = new Float32Array(n), k;
    for (k = 0; k < n; k++) {
      t[k] = 1 - (0.299 * px[4 * k] + 0.587 * px[4 * k + 1] + 0.114 * px[4 * k + 2]) / 255;
    }
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
    S.bitmap = { t: t, w: bw, h: bh };
  }

  // Value of a w x h map at a fractional position, blended from its four neighbours.
  function sample(map, w, h, sx, sy) {
    sx = Math.min(w - 1.001, Math.max(0, sx));
    sy = Math.min(h - 1.001, Math.max(0, sy));
    var x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0, o = y0 * w + x0;
    return (map[o] * (1 - fx) + map[o + 1] * fx) * (1 - fy) +
      (map[o + w] * (1 - fx) + map[o + w + 1] * fx) * fy;
  }


  /* Drawing
     ---------------------------------------------------------------------- */

  function hairline(c, x0, y0, x1, y1) {
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
  }

  /* Everything that sits under the dots, built once per layout. For the
     portrait: the red disc, the figure standing in front of it, two
     construction lines, and the ink as blue pencil. A photo has nothing under
     its dots but paper. */
  function buildUnder() {
    S.under = null;
    S.inked = null;
    if (S.kind !== 'portrait' || !portrait) return;

    var pal = S.pal, r = S.rect;
    var off = document.createElement('canvas');
    off.width = Math.round(S.w * S.dpr);
    off.height = Math.round(S.h * S.dpr);
    var c = off.getContext('2d');
    c.scale(S.dpr, S.dpr);

    c.fillStyle = pal.red;
    c.beginPath();
    c.arc(r.x + portrait.sunX * r.w, r.y + portrait.sunY * r.h, portrait.sunR * r.w, 0, TAU);
    c.fill();
    if (layers.figure) c.drawImage(tint(layers.figure, pal.paper), r.x, r.y, r.w, r.h);

    // the centre line of the face and the line of the eyes
    if (portrait.axisX && portrait.eyeY) {
      var ax = Math.round(r.x + portrait.axisX * r.w) + 0.5;
      var ey = Math.round(r.y + portrait.eyeY * r.h) + 0.5;
      c.strokeStyle = pal.pencil;
      c.lineWidth = 1;
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
    S.under = off;
  }

  /* Dot lattice at 45 degrees, the classic screentone angle, about 82 dots
     across. Each dot takes its size from the picture at that spot. */
  function buildDots() {
    S.pitch = Math.min(7.5, Math.max(5.5, S.w / 82));
    var p = S.pitch * Math.SQRT2;
    var xs = [], ys = [];
    var rowIndex = 0;
    for (var y = 0; y <= S.h + p; y += p / 2, rowIndex++) {
      for (var x = (rowIndex % 2) * (p / 2); x <= S.w + p; x += p) {
        xs.push(x);
        ys.push(y);
      }
    }
    var n = xs.length, val = new Float32Array(n), i;
    if (S.kind === 'portrait' && portrait) {
      var tone = portraitTone(), r = S.rect;
      for (i = 0; i < n; i++) {
        val[i] = sample(tone, portrait.w, portrait.h,
          (xs[i] - r.x) / r.w * portrait.w - 0.5,
          (ys[i] - r.y) / r.h * portrait.h - 0.5) / 255;
      }
    } else if (S.bitmap) {
      var b = S.bitmap;
      for (i = 0; i < n; i++) {
        val[i] = sample(b.t, b.w, b.h, xs[i] / S.w * b.w - 0.5, ys[i] / S.h * b.h - 0.5);
      }
    }
    S.dots = { n: n, x: Float32Array.from(xs), y: Float32Array.from(ys), val: val };
  }

  function measure() {
    S.w = frame.clientWidth;
    S.h = frame.clientHeight;
    S.dpr = Math.min(window.devicePixelRatio || 1, 2);
    S.aspect = S.w / S.h;
    canvas.width = Math.round(S.w * S.dpr);
    canvas.height = Math.round(S.h * S.dpr);
  }

  /* Print the dots onto any context. `grow` scales them while the portrait is
     arriving. The live canvas also gets the pointer loupe; a saved copy does not. */
  function printDots(c, ptr, grow) {
    var d = S.dots;
    var rMax = S.pitch * 0.69 * grow;
    var lens = 96, lens2 = lens * lens;
    c.beginPath();
    for (var i = 0; i < d.n; i++) {
      var v = d.val[i];
      // The square root makes the dot's area, not its radius, follow the tone.
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

  /* A bracket round each face the detector found, with how sure it was. */
  function markFaces(c) {
    var pal = S.pal, src = S.source, fit = S.fit;
    c.lineJoin = 'miter';
    c.font = '700 10px "M PLUS 1 Code", ui-monospace, monospace';
    c.textBaseline = 'middle';
    S.faces.forEach(function (f) {
      var x = (fit.x + f.x / src.width * fit.w) * S.w;
      var y = (fit.y + f.y / src.height * fit.h) * S.h;
      var w = f.w / src.width * fit.w * S.w;
      var h = f.h / src.height * fit.h * S.h;
      if (x + w < 8 || y + h < 8 || x > S.w - 8 || y > S.h - 8) return;   // cropped out of the frame
      var arm = Math.max(8, Math.min(w, h) * 0.24);
      var corners = function () {
        c.beginPath();
        c.moveTo(x, y + arm); c.lineTo(x, y); c.lineTo(x + arm, y);
        c.moveTo(x + w - arm, y); c.lineTo(x + w, y); c.lineTo(x + w, y + arm);
        c.moveTo(x + w, y + h - arm); c.lineTo(x + w, y + h); c.lineTo(x + w - arm, y + h);
        c.moveTo(x + arm, y + h); c.lineTo(x, y + h); c.lineTo(x, y + h - arm);
        c.stroke();
      };
      // paper first, then blue, so the bracket shows over light and dark alike
      c.strokeStyle = pal.paper;
      c.lineWidth = 6;
      corners();
      c.strokeStyle = pal.pencil;
      c.lineWidth = 3;
      corners();

      var tag = 'FACE ' + Math.round(f.score * 100) + '%';
      var tw = c.measureText(tag).width + 12;
      var tx = Math.min(S.w - tw - 4, Math.max(4, x));
      var ty = y - 22 > 4 ? y - 22 : y + h + 6;
      c.fillStyle = pal.pencil;
      c.fillRect(tx, ty, tw, 17);
      c.fillStyle = pal.paper;
      c.fillText(tag, tx + 6, ty + 9);
    });
  }

  function draw() {
    var pal = S.pal, ptr = S.pointer;
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.clearRect(0, 0, S.w, S.h);
    if (S.under) ctx.drawImage(S.under, 0, 0, S.w, S.h);

    // The dots swell in over the first half of the reveal.
    ctx.fillStyle = pal.ink;
    printDots(ctx, ptr, Math.sqrt(Math.min(1, S.reveal / 0.5)));

    // Then the ink comes down the frame over the pencil.
    if (S.kind === 'portrait' && S.inked) {
      var reach = Math.min(1, Math.max(0, (S.reveal - 0.25) / 0.75));
      if (reach > 0) {
        var edge = Math.round(S.h * reach), r = S.rect;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, S.w, edge);
        ctx.clip();
        ctx.drawImage(S.inked, r.x, r.y, r.w, r.h);
        ctx.restore();
        if (reach < 1) {
          ctx.strokeStyle = pal.pencil;
          ctx.lineWidth = 1;
          ctx.beginPath();
          hairline(ctx, 0, edge + 0.5, S.w, edge + 0.5);
          ctx.stroke();
        }
      }
    }

    if (S.kind === 'image' && S.faces && S.faces.length) markFaces(ctx);

    // While the detector is working, a scan line passes down the frame.
    if (S.detecting && !quiet()) {
      var pass = ((performance.now() - S.scanStart) % SCAN_MS) / SCAN_MS;
      var sy = Math.round(Math.floor(pass * 30) / 30 * S.h);
      ctx.fillStyle = pal.pencil;
      ctx.globalAlpha = 0.14;
      ctx.fillRect(0, sy - 46, S.w, 46);
      ctx.globalAlpha = 1;
      ctx.fillRect(0, sy, S.w, 3);
    }

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

  // One loop serves both animations: the portrait arriving, and the scan line.
  function animate() {
    S.raf = 0;
    if (S.reveal < 1) {
      var p = (performance.now() - S.revealStart) / REVEAL_MS;
      S.reveal = p >= 1 ? 1 : Math.floor(p * REVEAL_STEPS) / REVEAL_STEPS;
    }
    draw();
    if (S.reveal < 1 || (S.detecting && !quiet())) S.raf = requestAnimationFrame(animate);
  }

  function run() {
    if (!S.raf) S.raf = requestAnimationFrame(animate);
  }


  /* Layout and state
     ---------------------------------------------------------------------- */

  function setup() {
    measure();
    if (S.w < 40 || S.h < 40) return;
    S.pal = printPalette();
    if (S.kind === 'portrait') {
      if (portrait) placePortrait();
    } else {
      buildBitmap();
    }
    buildUnder();
    buildDots();
    draw();
  }

  function syncControls() {
    var photo = S.kind === 'image';
    var text = TEXT.portrait;
    if (photo) {
      if (S.detecting) text = TEXT.looking;
      else if (S.failed) text = TEXT.failed;
      else if (!S.faces || !S.faces.length) text = TEXT.none;
      else text = (S.faces.length === 1 ? 'Found 1 face' : 'Found ' + S.faces.length + ' faces') +
        ', marked in blue with how sure the model is.';
    }
    if (elText) elText.textContent = text;
    if (elHow) elHow.textContent = (photo ? HOW.image : HOW.portrait) + (photo && S.credit ? ' ' + S.credit : '');

    var answered = photo && !S.detecting && !S.failed && !!S.faces;
    if (elResult) elResult.hidden = !answered;
    if (answered) {
      var best = S.faces.reduce(function (m, f) { return Math.max(m, f.score); }, 0);
      if (elFaces) elFaces.textContent = String(S.faces.length);
      if (elScore) elScore.textContent = S.faces.length ? Math.round(best * 100) + '%' : 'n/a';
      if (elTime) elTime.textContent = S.took < 1000 ? Math.round(S.took) + ' ms' : (S.took / 1000).toFixed(1) + ' s';
    }

    if (fileLabel) fileLabel.textContent = photo ? 'Try another photo' : 'Find faces in your photo';
    if (btnSample) btnSample.hidden = photo && !!S.credit;
    if (btnReset) btnReset.hidden = !photo;
    if (btnSave) btnSave.hidden = !photo || S.detecting;
    canvas.setAttribute('aria-label', photo ? LABEL.image : LABEL.portrait);
  }

  function showPortrait(arrive) {
    pick++;                                  // lets go of any photo still being looked at
    S.kind = 'portrait';
    S.source = null;
    S.bitmap = null;
    S.faces = null;
    S.detecting = false;
    S.failed = false;
    S.credit = '';
    S.reveal = arrive && !quiet() ? 0 : 1;
    S.revealStart = performance.now();
    syncControls();
    setup();
    if (S.reveal < 1) run();
  }


  /* A photo
     ---------------------------------------------------------------------- */

  /* Print the photo straight away, then ask the detector about it. When the
     answer comes, the crop is centred on the faces and they are marked. */
  function showPhoto(copy, credit) {
    var mine = ++pick;
    S.kind = 'image';
    S.source = copy;
    S.credit = credit || '';
    S.faces = null;
    S.reveal = 1;
    S.detecting = !!LJ.findFaces;
    S.failed = !LJ.findFaces;
    S.scanStart = performance.now();
    syncControls();
    setup();
    if (!S.detecting) return;
    run();

    var done = false;
    var finish = function (faces) {
      if (done || mine !== pick) return;
      done = true;
      clearTimeout(patience);
      S.took = performance.now() - S.scanStart;
      var show = function () {
        if (mine !== pick) return;
        S.detecting = false;
        S.failed = !faces;
        S.faces = faces;
        syncControls();
        setup();
      };
      // Once loaded, the detector answers in a few hundredths of a second.
      // The scan is held for one beat, so the answer can be seen to arrive.
      var held = quiet() ? 0 : Math.max(0, MIN_SCAN_MS - S.took);
      if (held) setTimeout(show, held);
      else show();
    };
    var patience = setTimeout(function () { finish(null); }, GIVE_UP_MS);
    LJ.findFaces(copy).then(finish, function () { finish(null); });
  }

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

  function unreadable() {
    if (elText) elText.textContent = TEXT.unreadable;
  }

  function useFile(file) {
    if (!file) return;
    if (file.type && file.type.indexOf('image/') !== 0) { unreadable(); return; }
    var mine = pick;
    decode(file).then(function (src) {
      if (mine !== pick) return;             // a newer choice has replaced this one
      showPhoto(workingCopy(src), '');
    }).catch(unreadable);
  }

  /* The sample photo is kept as data inside a script, and fetched only when
     asked for. A picture loaded that way can be read back from a canvas even
     when the site is opened straight from disk. */
  var sampleScript = (document.currentScript ? document.currentScript.src : '').replace(/cover-art\.js.*$/, 'sample-photo.js');
  var sampleLoading = null;

  function loadSample() {
    if (sampleLoading) return sampleLoading;
    sampleLoading = new Promise(function (resolve, reject) {
      var use = function () {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = reject;
        img.src = LJ.samplePhoto.src;
      };
      if (LJ.samplePhoto) { use(); return; }
      var el = document.createElement('script');
      el.src = sampleScript;
      el.onload = use;
      el.onerror = reject;
      document.head.appendChild(el);
    });
    sampleLoading.catch(function () { sampleLoading = null; });
    return sampleLoading;
  }

  if (btnSample) {
    btnSample.addEventListener('click', function () {
      var mine = pick;
      loadSample().then(function (img) {
        if (mine !== pick) return;
        showPhoto(workingCopy(img), LJ.samplePhoto.credit);
      }).catch(unreadable);
    });
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

  if (btnReset) btnReset.addEventListener('click', function () { showPortrait(true); });

  // Save the print as it stands: dots on paper and the face brackets, without the loupe.
  if (btnSave) {
    btnSave.addEventListener('click', function () {
      if (!S.dots || S.kind !== 'image') return;
      var scale = 2;
      var out = document.createElement('canvas');
      out.width = Math.round(S.w * scale);
      out.height = Math.round(S.h * scale);
      var c = out.getContext('2d');
      c.scale(scale, scale);
      c.fillStyle = S.pal.paper;
      c.fillRect(0, 0, S.w, S.h);
      c.fillStyle = S.pal.ink;
      printDots(c, null, 1);
      if (S.faces && S.faces.length) markFaces(c);
      out.toBlob(function (blob) {
        if (!blob) return;
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'faces.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      }, 'image/png');
    });
  }


  /* Pointer: a loupe, plus the ink density printed at that spot
     ---------------------------------------------------------------------- */

  var redrawQueued = false;
  function queueRedraw() {
    if (redrawQueued || S.raf) return;       // an animation in progress repaints anyway
    redrawQueued = true;
    requestAnimationFrame(function () {
      redrawQueued = false;
      draw();
    });
  }

  function updateProbe() {
    if (!probe || !S.pointer || !S.dots) return;
    var d = S.dots, px = S.pointer.x, py = S.pointer.y;
    var best = 0, bestQ = Infinity;
    for (var i = 0; i < d.n; i++) {
      var dx = d.x[i] - px, dy = d.y[i] - py;
      var q = dx * dx + dy * dy;
      if (q < bestQ) { bestQ = q; best = i; }
    }
    probe.textContent = 'ink ' + Math.round(d.val[best] * 100) + '%';
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

  var resizeTimer = 0;
  if ('ResizeObserver' in window) {
    new ResizeObserver(function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (Math.abs(frame.clientWidth - S.w) < 2 && Math.abs(frame.clientHeight - S.h) < 2) return;
        setup();
      }, 140);
    }).observe(frame);
  }

  if (portrait) {
    loadLayer('ink', host.getAttribute('data-portrait-ink'));
    loadLayer('figure', host.getAttribute('data-portrait-figure'));
  }
  showPortrait(true);
})();
