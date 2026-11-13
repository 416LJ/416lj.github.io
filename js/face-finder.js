/* face-finder.js
 * Finds faces in a picture, in the page. Nothing is uploaded.
 *
 * This is a different kind of model from the one in field-net.js. That one
 * starts from nothing and memorises a single picture. This one, BlazeFace, was
 * trained ahead of time by Google on a great many photographs, and can say
 * where the faces are in a picture it has never seen. It is run here with the
 * MediaPipe runtime.
 *
 *   LJ.findFaces(canvas) -> Promise of [{ x, y, w, h, score }, ...]
 *
 * Boxes are in the canvas's own pixels. The promise rejects if the detector
 * cannot be loaded, for instance when offline.
 *
 * Nothing here is fetched until the first call: the runtime (about 2 MB over
 * the wire) comes from a CDN at a pinned version, the model from this site.
 *
 * It is tuned to be sure rather than thorough. The picture is checked whole
 * and as four quarters. Cutting it finer does find the small faces of a
 * distant crowd, but in testing it also began to see faces in mountains and
 * cats, which is the worse mistake to make.
 */
(function (root) {
  'use strict';

  var LJ = (root.LJ = root.LJ || {});

  var RUNTIME = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  var here = document.currentScript ? document.currentScript.src : '';
  var MODEL_SCRIPT = here.replace(/face-finder\.js.*$/, 'face-model-data.js');

  var detectorPromise = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = function () { reject(new Error('could not load ' + src)); };
      document.head.appendChild(el);
    });
  }

  function modelBytes() {
    var raw = atob(LJ.faceModel);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function detector() {
    if (detectorPromise) return detectorPromise;
    detectorPromise = Promise.all([
      import(RUNTIME + '/vision_bundle.mjs'),
      LJ.faceModel ? null : loadScript(MODEL_SCRIPT)
    ]).then(function (loaded) {
      var vision = loaded[0];
      // The runtime reports its start-up notes ("INFO: ...") through
      // console.error. Those are let go quietly. Real errors still get through.
      var report = console.error;
      console.error = function () {
        if (typeof arguments[0] === 'string' && arguments[0].indexOf('INFO:') === 0) return;
        report.apply(console, arguments);
      };
      var restore = function () { console.error = report; };
      var ready = vision.FilesetResolver.forVisionTasks(RUNTIME + '/wasm').then(function (files) {
        return vision.FaceDetector.createFromOptions(files, {
          baseOptions: { modelAssetBuffer: modelBytes(), delegate: 'CPU' },
          runningMode: 'IMAGE',
          minDetectionConfidence: 0.5
        });
      });
      ready.then(restore, restore);
      return ready;
    });
    // A failed load is not remembered, so a later call can try again.
    detectorPromise.catch(function () { detectorPromise = null; });
    return detectorPromise;
  }

  function overlap(a, b) {
    var x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    var y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    var shared = x * y;
    return shared / (a.w * a.h + b.w * b.h - shared);
  }

  LJ.findFaces = function (canvas) {
    return detector().then(function (det) {
      var W = canvas.width, H = canvas.height;
      var found = [];

      // The model looks at a small square copy of whatever it is given, so a
      // face that is small in the frame can slip past it. The picture is
      // checked whole, then again as four overlapping quarters.
      var views = [{ x: 0, y: 0, w: W, h: H, least: 0.5 }];
      var tw = W * 0.62, th = H * 0.62;
      [[0, 0], [W - tw, 0], [0, H - th], [W - tw, H - th]].forEach(function (o) {
        views.push({ x: o[0], y: o[1], w: tw, h: th, least: 0.7 });
      });

      var scratch = document.createElement('canvas');
      var sx = scratch.getContext('2d');
      views.forEach(function (v) {
        var k = Math.min(1, 640 / Math.max(v.w, v.h));
        scratch.width = Math.max(1, Math.round(v.w * k));
        scratch.height = Math.max(1, Math.round(v.h * k));
        sx.drawImage(canvas, v.x, v.y, v.w, v.h, 0, 0, scratch.width, scratch.height);
        var result = det.detect(scratch);
        (result.detections || []).forEach(function (d) {
          var b = d.boundingBox;
          var score = d.categories && d.categories[0] ? d.categories[0].score : 0;
          if (!b || score < v.least) return;
          found.push({ x: v.x + b.originX / k, y: v.y + b.originY / k, w: b.width / k, h: b.height / k, score: score });
        });
      });

      // The same face seen in more than one view: keep the surest sighting.
      found.sort(function (a, b) { return b.score - a.score; });
      var faces = [];
      found.forEach(function (f) {
        if (faces.every(function (g) { return overlap(f, g) < 0.3; })) faces.push(f);
      });
      return faces;
    });
  };
})(typeof window !== 'undefined' ? window : globalThis);
