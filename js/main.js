/* main.js
 * Page behaviour: the day and night editions, panel reveals, the running
 * head, and the two generated drawings (the floor of photographs and the
 * focus lines).
 */
(function () {
  'use strict';

  var LJ = (window.LJ = window.LJ || {});
  var root = document.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var SVG_NS = 'http://www.w3.org/2000/svg';

  LJ.reduceMotion = reduceMotion;

  /** Current edition colours, for anything drawn on a canvas. */
  LJ.palette = function () {
    var cs = getComputedStyle(root);
    var read = function (name) { return cs.getPropertyValue(name).trim(); };
    return {
      paper: read('--paper'),
      ink: read('--ink'),
      inkSoft: read('--ink-soft'),
      blue: read('--blue'),
      red: read('--red')
    };
  };

  function svgEl(name, attrs) {
    var el = document.createElementNS(SVG_NS, name);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }


  /* Edition switch
     ---------------------------------------------------------------------- */

  var toggle = document.getElementById('edition-toggle');
  var toggleText = toggle && toggle.querySelector('[data-edition-text]');

  // Night is the default edition. Day applies only once the reader has chosen it.
  function currentEdition() {
    return root.getAttribute('data-theme') === 'light' ? 'day' : 'night';
  }

  function syncToggle() {
    if (!toggle) return;
    var night = currentEdition() === 'night';
    var next = night ? 'Day edition' : 'Night edition';
    toggle.setAttribute('aria-pressed', String(night));
    toggle.setAttribute('aria-label', 'Switch to the ' + next.toLowerCase());
    if (toggleText) toggleText.textContent = next;
  }

  function announceEdition() {
    window.dispatchEvent(new CustomEvent('lj:edition', { detail: currentEdition() }));
  }

  function setEdition(edition) {
    if (edition === 'day') root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
    try { localStorage.setItem('lj-edition', edition); } catch (err) {}
    // Keep the browser chrome (mobile address bar) matched to the page.
    var themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute('content', edition === 'day' ? '#f4efe4' : '#100f0d');
    syncToggle();
    announceEdition();
  }

  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = currentEdition() === 'night' ? 'day' : 'night';

      if (!document.startViewTransition || reduceMotion.matches) {
        setEdition(next);
        return;
      }

      // The new edition floods out from the button, in a few held frames.
      var box = toggle.getBoundingClientRect();
      var x = box.left + box.width / 2;
      var y = box.top + box.height / 2;
      var reach = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
      var transition = document.startViewTransition(function () { setEdition(next); });
      transition.ready.then(function () {
        root.animate(
          { clipPath: ['circle(0px at ' + x + 'px ' + y + 'px)', 'circle(' + reach + 'px at ' + x + 'px ' + y + 'px)'] },
          { duration: 560, easing: 'steps(10, end)', pseudoElement: '::view-transition-new(root)' }
        );
      }).catch(function () {});
    });
  }

  syncToggle();


  /* Cover name: the part of each line that lies over the print
     ---------------------------------------------------------------------- */

  // The name runs into the artwork frame. main.css draws that part in the
  // print's ink, and needs to be told where it is. Measured here, per line,
  // and again whenever the layout changes.
  var nameLines = document.querySelectorAll('.cover__name-line');
  var printFrame = document.querySelector('.art__frame');

  function cutName() {
    var frame = printFrame.getBoundingClientRect();
    nameLines.forEach(function (line) {
      var box = line.getBoundingClientRect();
      var top = Math.max(box.top, frame.top);
      var height = Math.min(box.bottom, frame.bottom) - top;
      var across = frame.left < box.right && frame.right > box.left;
      line.style.setProperty('--cut-x', Math.max(0, frame.left - box.left).toFixed(1) + 'px');
      line.style.setProperty('--cut-y', (top - box.top).toFixed(1) + 'px');
      line.style.setProperty('--cut-h', (across && height > 0 ? height : 0).toFixed(1) + 'px');
    });
  }

  if (nameLines.length && printFrame) {
    cutName();
    window.addEventListener('resize', cutName);
    if ('ResizeObserver' in window) {
      var nameWatch = new ResizeObserver(cutName);
      nameWatch.observe(printFrame);
      nameWatch.observe(nameLines[0].parentElement);
    }
    // The letters change width when the display face arrives.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(cutName);
  }


  /* Panel reveals
     ---------------------------------------------------------------------- */

  var revealTargets = document.querySelectorAll('[data-reveal]');

  if ('IntersectionObserver' in window && revealTargets.length) {
    root.classList.add('reveal-ready');
    var revealer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        revealer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 });
    revealTargets.forEach(function (el) { revealer.observe(el); });
  }


  /* Running head: name the section being read
     ---------------------------------------------------------------------- */

  var runningTitle = document.querySelector('[data-running-title]');
  var titled = document.querySelectorAll('[data-title]');

  if (runningTitle && titled.length && 'IntersectionObserver' in window) {
    var reader = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) runningTitle.textContent = entry.target.getAttribute('data-title');
      });
    }, { rootMargin: '-45% 0px -54% 0px' });
    titled.forEach(function (el) { reader.observe(el); });
  }


  /* Drawing: a floor of photographs, running back to the horizon
     ---------------------------------------------------------------------- */

  var crowdAspect = 0;

  function drawCrowd(svg) {
    if (!LJ.mulberry32) return;
    var box = svg.getBoundingClientRect();
    if (box.width < 10 || box.height < 10) return;
    crowdAspect = box.width / box.height;

    // The drawing is laid out to the panel's own proportions, so nothing is cropped.
    var W = 900;
    var H = Math.round(W / crowdAspect);
    var horizon = Math.round(H * 0.37);
    var hazeH = Math.round(H * 0.16);
    var rng = LJ.mulberry32(416);

    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

    var frag = document.createDocumentFragment();

    // Haze above the horizon: screentone that thins out as it rises.
    var defs = svgEl('defs', {});
    var fade = svgEl('linearGradient', { id: 'crowd-haze-fade', x1: 0, y1: 0, x2: 0, y2: 1 });
    fade.appendChild(svgEl('stop', { offset: 0, 'stop-color': '#000' }));
    fade.appendChild(svgEl('stop', { offset: 1, 'stop-color': '#fff' }));
    var mask = svgEl('mask', { id: 'crowd-haze', maskUnits: 'userSpaceOnUse', x: 0, y: horizon - hazeH, width: W, height: hazeH + 6 });
    mask.appendChild(svgEl('rect', { x: 0, y: horizon - hazeH, width: W, height: hazeH + 6, fill: 'url(#crowd-haze-fade)' }));
    defs.appendChild(fade);
    defs.appendChild(mask);
    frag.appendChild(defs);
    frag.appendChild(svgEl('rect', {
      x: 0, y: horizon - hazeH, width: W, height: hazeH + 6,
      fill: 'url(#tone-mid)', mask: 'url(#crowd-haze)'
    }));

    // Rows of cards, far to near. Scale grows with depth, so it reads as a floor.
    // A thousand-odd cards would be a lot of elements, so the distant rows are
    // each drawn as one path. Only the nearest rows, where cards visibly
    // overlap, get an element per card.
    var candidates = [];
    var y = horizon;
    var row = 0;

    var cardPath = function (cx, cy, w, h, cos, sin) {
      var hx = w / 2, hy = h / 2;
      var corner = function (px, py) {
        return (cx + px * cos - py * sin).toFixed(1) + ' ' + (cy + px * sin + py * cos).toFixed(1);
      };
      return 'M' + corner(-hx, -hy) + 'L' + corner(hx, -hy) + 'L' + corner(hx, hy) + 'L' + corner(-hx, hy) + 'Z';
    };
    var dotPath = function (px, py, r) {
      var rr = r.toFixed(2);
      return 'M' + (px - r).toFixed(1) + ' ' + py.toFixed(1) +
        'a' + rr + ' ' + rr + ' 0 1 0 ' + (2 * r).toFixed(2) + ' 0' +
        'a' + rr + ' ' + rr + ' 0 1 0 ' + (-2 * r).toFixed(2) + ' 0Z';
    };
    var addCards = function (d, s) {
      var el = svgEl('path', { 'class': 'crowd-card', d: d });
      el.style.strokeWidth = Math.max(0.7, 2.3 * Math.pow(s, 0.8)).toFixed(2) + 'px';
      frag.appendChild(el);
    };

    while (y < H + 40) {
      var t = Math.min(1, (y - horizon) / (H - horizon));
      var s = 0.2 + 1.45 * Math.pow(t, 1.25);
      var cw = 50 * s, ch = 36 * s;
      var step = cw * 1.2;
      var merged = s <= 0.74;
      var rowCards = '', rowFaces = '';

      for (var x = -rng() * step; x < W + cw; x += step) {
        var cx = x + (rng() - 0.5) * cw * 0.2;
        var cy = y + ch / 2 + (rng() - 0.5) * ch * 0.2;
        var a = (rng() - 0.5) * 20 * Math.PI / 180;
        var cos = Math.cos(a), sin = Math.sin(a);
        var outline = cardPath(cx, cy, cw, ch, cos, sin);
        var dots = '';

        if (s > 0.34) {
          // Faces in the photo: one to three dots.
          var faces = 1 + ((rng() * 3) | 0);
          var pick = (rng() * faces) | 0;
          for (var f = 0; f < faces; f++) {
            var fx = ((f + 0.5) / faces - 0.5) * cw * 0.66 + (rng() - 0.5) * cw * 0.06;
            var fy = (rng() - 0.5) * ch * 0.22;
            var px = cx + fx * cos - fy * sin;
            var py = cy + fx * sin + fy * cos;
            dots += dotPath(px, py, 2.5 * s);

            // Remember one face per near card as a possible stop on the thread.
            // Skip the margins and the corner the closing caption sits in.
            var open = cx > 90 && cx < W - 90 && cy < H - 44 && !(cx > W * 0.56 && cy > H * 0.74);
            if (f === pick && s > 0.56 && open) candidates.push({ row: row, s: s, x: px, y: py });
          }
        }

        if (merged) {
          rowCards += outline;
          rowFaces += dots;
        } else {
          addCards(outline, s);
          if (dots) frag.appendChild(svgEl('path', { 'class': 'crowd-face', d: dots }));
        }
      }

      if (merged) {
        addCards(rowCards, s);
        if (rowFaces) frag.appendChild(svgEl('path', { 'class': 'crowd-face', d: rowFaces }));
      }
      y += ch * 0.8;
      row++;
    }

    // The red thread: one guest, found in photo after photo, far to near.
    // One stop per row, wandering across the floor.
    var byRow = {};
    candidates.forEach(function (c) { (byRow[c.row] = byRow[c.row] || []).push(c); });
    var rows = Object.keys(byRow).map(Number).sort(function (p, q) { return p - q; });
    var wander = [0.46, 0.74, 0.3, 0.6, 0.2, 0.52, 0.36, 0.66, 0.26];
    var you = rows.map(function (r, i) {
      var target = W * wander[i % wander.length];
      return byRow[r].reduce(function (best, c) {
        return Math.abs(c.x - target) < Math.abs(best.x - target) ? c : best;
      });
    });

    if (you.length > 1) {
      var d = 'M' + you[0].x.toFixed(1) + ' ' + you[0].y.toFixed(1);
      for (var k = 1; k < you.length; k++) d += 'L' + you[k].x.toFixed(1) + ' ' + you[k].y.toFixed(1);
      frag.appendChild(svgEl('path', { 'class': 'crowd-thread', d: d, pathLength: 1 }));
      you.forEach(function (p) {
        frag.appendChild(svgEl('circle', { 'class': 'crowd-face crowd-face--you', cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: (3.3 * p.s).toFixed(2) }));
        frag.appendChild(svgEl('circle', { 'class': 'crowd-ring', cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: (8.5 * p.s).toFixed(1) }));
      });
    }

    svg.appendChild(frag);
  }

  var crowd = document.querySelector('[data-crowd]');
  if (crowd) {
    drawCrowd(crowd);
    if ('ResizeObserver' in window) {
      var crowdTimer = 0;
      new ResizeObserver(function () {
        clearTimeout(crowdTimer);
        crowdTimer = setTimeout(function () {
          var box = crowd.getBoundingClientRect();
          if (box.height < 10) return;
          var aspect = box.width / box.height;
          if (!crowdAspect || Math.abs(aspect - crowdAspect) / crowdAspect > 0.04) drawCrowd(crowd);
        }, 160);
      }).observe(crowd);
    }
  }


  /* Drawing: focus lines converging on the figure
     ---------------------------------------------------------------------- */

  function drawFocusLines(svg) {
    if (!LJ.mulberry32) return;
    var rng = LJ.mulberry32(98);
    var W = 600, H = 420, cx = W / 2, cy = H / 2 + 6;
    var count = 150;
    var d = '';
    for (var i = 0; i < count; i++) {
      var a = (i + rng() * 0.9) * (Math.PI * 2 / count);
      var half = (0.22 + rng() * rng() * 1.5) * Math.PI / 180;
      // The clear area in the middle is an ellipse, wider than it is tall.
      var rx = 205 * (0.92 + rng() * 0.36);
      var ry = 118 * (0.92 + rng() * 0.36);
      var tipX = cx + Math.cos(a) * rx, tipY = cy + Math.sin(a) * ry;
      var far = 560;
      d += 'M' + tipX.toFixed(1) + ' ' + tipY.toFixed(1) +
        'L' + (cx + Math.cos(a - half) * far).toFixed(1) + ' ' + (cy + Math.sin(a - half) * far).toFixed(1) +
        'L' + (cx + Math.cos(a + half) * far).toFixed(1) + ' ' + (cy + Math.sin(a + half) * far).toFixed(1) + 'Z';
    }
    svg.appendChild(svgEl('path', { 'class': 'focus-line', d: d }));
  }

  var focus = document.querySelector('[data-focus]');
  if (focus) drawFocusLines(focus);
})();
