/* main.js
 * The face detector frame on the cover.
 *
 * At rest the frame shows the portrait. Give it a photo and it marks every
 * face it finds. Face detection itself lives in face-finder.js
 * (LJ.findFaces). A photo given to the frame is read in the page only.
 * Nothing is uploaded.
 */
(function () {
  'use strict';

  var LJ = (window.LJ = window.LJ || {});
  var root = document.documentElement;

  LJ.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Colours are read from the stylesheet, so the scripts follow the page. */
  LJ.ink = function (name) {
    return getComputedStyle(root).getPropertyValue(name).trim();
  };

  var host = document.querySelector('[data-detector]');
  if (!host) return;

  var scope = host.querySelector('[data-scope]');
  var canvas = host.querySelector('.scope__canvas');
  var marks = host.querySelector('[data-marks]');
  var elState = host.querySelector('[data-state]');
  var elText = host.querySelector('[data-text]');
  var elHow = host.querySelector('[data-how]');
  var elResult = host.querySelector('[data-result]');
  var elFaces = host.querySelector('[data-faces]');
  var elScore = host.querySelector('[data-score]');
  var elTime = host.querySelector('[data-time]');
  var fileInput = host.querySelector('[data-file]');
  var btnSample = host.querySelector('[data-sample]');
  var btnReset = host.querySelector('[data-reset]');
  var sampleScript = host.getAttribute('data-sample-script');
  var ctx = canvas.getContext('2d');

  var MIN_SCAN_MS = 1100;   // long enough for the scan line to be seen
  var GIVE_UP_MS = 20000;

  var TEXT = {
    portrait: 'This frame is a face detector. Give it a photo and a neural network will mark every face it finds.',
    looking: 'Looking for faces. The detector is about 2 MB and loads the first time only.',
    one: 'Found 1 face.',
    many: 'Found {n} faces.',
    none: 'No face found. It may not be a person, or the faces are far from the camera.',
    failed: 'The face detector could not be loaded, so the photo is shown without a result. Check your connection and try again.',
    unreadable: 'That file could not be read as an image. Try a JPG or a PNG.'
  };
  var HOW = {
    portrait: 'It runs in your browser and your photo is not uploaded. It finds faces. It does not recognise who anyone is.',
    image: 'The model is BlazeFace, by Google, run with MediaPipe. It ran in your browser, and the photo was not uploaded.'
  };
  var LABEL = {
    portrait: 'Portrait of Laxsan Jeya, drawn in the style of a video game cover.',
    image: 'Your photo, with any faces found marked.'
  };

  // What the frame is showing.
  var S = {
    kind: 'portrait',   // 'portrait' or 'image'
    view: null,         // the picture at display quality
    work: null,         // a copy no larger than 640 px, for the detector
    fit: 'cover',
    rect: null,         // where the picture sits in the frame, as fractions
    faces: [],
    job: 0
  };

  function copyOf(src, most) {
    var sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
    if (!sw || !sh) throw new Error('unreadable');
    var k = Math.min(1, most / Math.max(sw, sh));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * k));
    c.height = Math.max(1, Math.round(sh * k));
    var x = c.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, c.width, c.height);
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  function render() {
    var box = scope.getBoundingClientRect();
    if (!box.width || !S.view) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var W = Math.round(box.width * dpr), H = Math.round(box.height * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }

    ctx.fillStyle = LJ.ink('--raise');
    ctx.fillRect(0, 0, W, H);

    var iw = S.view.width, ih = S.view.height;
    var k = S.fit === 'cover' ? Math.max(W / iw, H / ih) : Math.min(W / iw, H / ih);
    var dw = iw * k, dh = ih * k;
    var dx = (W - dw) / 2, dy = (H - dh) / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(S.view, dx, dy, dw, dh);

    S.rect = { x: dx / W, y: dy / H, w: dw / W, h: dh / H };
    placeMarks();
  }

  function placeMarks() {
    marks.textContent = '';
    if (!S.rect || !S.work) return;
    var few = S.faces.length <= 6;
    S.faces.forEach(function (f, i) {
      var el = document.createElement('span');
      el.className = 'mark';
      var top = S.rect.y + (f.y / S.work.height) * S.rect.h;
      el.style.left = (S.rect.x + (f.x / S.work.width) * S.rect.w) * 100 + '%';
      el.style.top = top * 100 + '%';
      el.style.width = (f.w / S.work.width) * S.rect.w * 100 + '%';
      el.style.height = (f.h / S.work.height) * S.rect.h * 100 + '%';
      el.style.setProperty('--i', i);
      if (top < 0.09) el.classList.add('mark--low');
      var tag = document.createElement('span');
      tag.className = 'mark__tag';
      var pct = Math.round(f.score * 100) + '%';
      tag.textContent = few ? 'Face ' + (i < 9 ? '0' : '') + (i + 1) + ' · ' + pct : pct;
      el.appendChild(tag);
      marks.appendChild(el);
    });
  }

  function setState(word) { if (elState) elState.textContent = word; }

  function showResult(faces, took) {
    S.faces = faces;
    placeMarks();
    var n = faces.length;
    setState(n === 0 ? 'No face' : n === 1 ? '1 face' : n + ' faces');
    elText.textContent = n === 0 ? TEXT.none : n === 1 ? TEXT.one : TEXT.many.replace('{n}', n);
    elFaces.textContent = n;
    elScore.textContent = n ? Math.round(faces[0].score * 100) + '%' : 'n/a';
    elTime.textContent = Math.round(took) + ' ms';
    elResult.hidden = false;
  }

  /* The first call also fetches the detector. A tiny blank picture goes
     through first, so that the time shown is for looking at the photo and not
     for the download. */
  var warmed = null;
  function warm() {
    if (warmed) return warmed;
    var blank = document.createElement('canvas');
    blank.width = blank.height = 32;
    warmed = LJ.findFaces(blank);
    warmed.catch(function () { warmed = null; });
    return warmed;
  }

  function detect() {
    var job = S.job;
    var began = performance.now();
    var took = 0;
    scope.classList.add('is-scanning');
    setState('Scanning');
    elText.textContent = TEXT.looking;
    elResult.hidden = true;

    var giveUp = new Promise(function (resolve, reject) {
      setTimeout(function () { reject(new Error('timeout')); }, GIVE_UP_MS);
    });
    var look = warm().then(function () {
      var t0 = performance.now();
      return LJ.findFaces(S.work).then(function (faces) {
        took = performance.now() - t0;
        return faces;
      });
    });
    var held = function (value) {
      var left = MIN_SCAN_MS - (performance.now() - began);
      return new Promise(function (resolve) { setTimeout(function () { resolve(value); }, Math.max(0, left)); });
    };

    Promise.race([look, giveUp]).then(held).then(function (faces) {
      if (job !== S.job) return;
      scope.classList.remove('is-scanning');
      showResult(faces, took);
    }).catch(function () {
      if (job !== S.job) return;
      scope.classList.remove('is-scanning');
      setState('Offline');
      elText.textContent = TEXT.failed;
    });
  }

  function show(kind, img, credit) {
    S.job++;
    S.kind = kind;
    S.fit = kind === 'portrait' ? 'cover' : 'contain';
    S.view = copyOf(img, 1280);
    S.work = copyOf(img, 640);
    S.faces = [];
    scope.classList.remove('is-scanning');
    canvas.setAttribute('aria-label', LABEL[kind]);
    elHow.textContent = credit ? HOW.image + ' ' + credit : HOW[kind];
    btnReset.hidden = kind === 'portrait';
    render();
    if (kind === 'portrait') {
      setState('Idle');
      elText.textContent = TEXT.portrait;
      elResult.hidden = true;
    } else {
      detect();
    }
  }

  function load(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = reject;
      img.src = src;
    });
  }

  function showPortrait() {
    if (!LJ.portraitPhoto) return;
    load(LJ.portraitPhoto.src).then(function (img) { show('portrait', img); });
  }

  function useFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { elText.textContent = TEXT.unreadable; return; }
    var url = URL.createObjectURL(file);
    load(url).then(function (img) {
      try { show('image', img); }
      finally { URL.revokeObjectURL(url); }
    }).catch(function () {
      URL.revokeObjectURL(url);
      elText.textContent = TEXT.unreadable;
    });
  }

  var sampleLoading = null;
  function loadSample() {
    if (sampleLoading) return sampleLoading;
    sampleLoading = new Promise(function (resolve, reject) {
      var use = function () { load(LJ.samplePhoto.src).then(resolve, reject); };
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

  fileInput.addEventListener('change', function () {
    useFile(fileInput.files && fileInput.files[0]);
    fileInput.value = '';
  });

  btnSample.addEventListener('click', function () {
    loadSample().then(function (img) {
      show('image', img, LJ.samplePhoto.credit);
    }).catch(function () { elText.textContent = TEXT.failed; });
  });

  btnReset.addEventListener('click', showPortrait);

  // A photo can also be dropped on the frame.
  ['dragenter', 'dragover'].forEach(function (name) {
    scope.addEventListener(name, function (e) {
      e.preventDefault();
      scope.classList.add('is-over');
    });
  });
  ['dragleave', 'drop'].forEach(function (name) {
    scope.addEventListener(name, function (e) {
      e.preventDefault();
      scope.classList.remove('is-over');
    });
  });
  scope.addEventListener('drop', function (e) {
    useFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  });

  if (window.ResizeObserver) new ResizeObserver(render).observe(scope);
  else window.addEventListener('resize', render);

  showPortrait();
})();
