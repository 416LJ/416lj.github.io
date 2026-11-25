/* globe.js
 * A turning globe, drawn on a canvas.
 *
 * The land comes from Natural Earth (public domain) by way of globe-data.js:
 * coastlines, and an even grid of dots that fall on land. Everything is
 * projected by hand: each point is a unit vector, turned by the view, and
 * dropped flat onto the screen (an orthographic view, as if from far away).
 *
 * The lit side is the real one. The sun's position is worked out from the
 * clock, and land on the night side is drawn dimmer.
 *
 * Drag to turn it, or use the arrow keys. The buttons under it fly to a place.
 */
(function () {
  'use strict';

  var LJ = window.LJ || {};
  var host = document.querySelector('[data-globe]');
  if (!host || !LJ.globeData) return;

  var canvas = host.querySelector('.globe__canvas');
  var glCanvas = host.querySelector('.globe__photo');
  var clock = host.querySelector('[data-globe-clock]');
  var buttons = host.querySelectorAll('[data-place]');
  var ctx = canvas.getContext('2d');
  var RAD = Math.PI / 180;
  var still = !!LJ.reduceMotion;

  // Where the label's leader line heads off to: right or left, up or down.
  var PLACES = {
    toronto: { name: 'Toronto', lat: 43.65, lon: -79.38, dx: 1, dy: 1 },
    ottawa: { name: 'Ottawa', lat: 45.42, lon: -75.7, dx: 1, dy: -1 },
    vegas: { name: 'Las Vegas', lat: 36.17, lon: -115.14, dx: -1, dy: -1 }
  };

  var SPIN = still ? 0 : -4.5;   // degrees a second; the surface moves east
  var HOLD_MS = 6000;            // how long a chosen place is held in view

  var view = { lon: -64, lat: 24, speed: SPIN };
  var size = { w: 0, h: 0, dpr: 1, r: 0 };
  var colour = {};
  var held = false, holdUntil = 0, fly = null, chosen = null;
  var visible = true, dirty = true, last = 0;
  var orbit = 0;

  function vec(lon, lat) {
    var c = Math.cos(lat * RAD);
    return [c * Math.sin(lon * RAD), Math.sin(lat * RAD), c * Math.cos(lon * RAD)];
  }

  /* The data, as unit vectors
     ------------------------------------------------------------------ */

  // Coastlines. A cut marks where the pen lifts: the map's own seam along
  // the date line and the edge at the south pole are not coast.
  var coast = LJ.globeData.coast.map(function (ring) {
    var n = ring.length / 2;
    var v = new Float32Array(n * 3), cut = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var lon = ring[i * 2] / 10, lat = ring[i * 2 + 1] / 10;
      var p = vec(lon, lat);
      v[i * 3] = p[0]; v[i * 3 + 1] = p[1]; v[i * 3 + 2] = p[2];
      if (i > 0) {
        var plon = ring[i * 2 - 2] / 10, plat = ring[i * 2 - 1] / 10;
        if ((Math.abs(lon) > 179.9 && Math.abs(plon) > 179.9) || (lat < -89.9 && plat < -89.9)) cut[i] = 1;
      }
    }
    return { v: v, cut: cut, n: n };
  });

  var dotCount = LJ.globeData.dots.length / 2;
  var dots = new Float32Array(dotCount * 3);
  var lit = new Uint8Array(dotCount);
  for (var d = 0; d < dotCount; d++) {
    var dv = vec(LJ.globeData.dots[d * 2] / 10, LJ.globeData.dots[d * 2 + 1] / 10);
    dots[d * 3] = dv[0]; dots[d * 3 + 1] = dv[1]; dots[d * 3 + 2] = dv[2];
  }

  function line(points) {
    var v = new Float32Array(points.length * 3);
    points.forEach(function (p, i) { v[i * 3] = p[0]; v[i * 3 + 1] = p[1]; v[i * 3 + 2] = p[2]; });
    return { v: v, cut: null, n: points.length };
  }

  // The grid: a meridian every 30 degrees, a parallel every 30.
  var grid = [];
  (function () {
    var lon, lat, pts;
    for (lon = -180; lon < 180; lon += 30) {
      pts = [];
      for (lat = -84; lat <= 84; lat += 4) pts.push(vec(lon, lat));
      grid.push(line(pts));
    }
    for (lat = -60; lat <= 60; lat += 30) {
      pts = [];
      for (lon = -180; lon <= 180; lon += 4) pts.push(vec(lon, lat));
      grid.push(line(pts));
    }
  })();

  Object.keys(PLACES).forEach(function (key) {
    PLACES[key].v = vec(PLACES[key].lon, PLACES[key].lat);
  });

  /* The sun
     ------------------------------------------------------------------ */

  var sun = [0, 0, 1];
  var terminator = null;

  // The point on Earth directly under the sun, from the date and time.
  function sunNow(now) {
    var start = Date.UTC(now.getUTCFullYear(), 0, 1);
    var day = Math.floor((now.getTime() - start) / 864e5);
    var hours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    var g = (2 * Math.PI / 365) * (day + (hours - 12) / 24);
    var decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) -
      0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) -
      0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    var eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    return { lon: -15 * (hours - 12 + eq / 60), lat: decl / RAD };
  }

  function two(n) { return (n < 10 ? '0' : '') + n; }

  function setSun() {
    var now = new Date();
    var at = sunNow(now);
    sun = vec(at.lon, at.lat);
    for (var i = 0; i < dotCount; i++) {
      lit[i] = dots[i * 3] * sun[0] + dots[i * 3 + 1] * sun[1] + dots[i * 3 + 2] * sun[2] > -0.04 ? 1 : 0;
    }
    // The line between day and night: every point a quarter turn from the sun.
    var up = Math.abs(sun[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    var u = [sun[1] * up[2] - sun[2] * up[1], sun[2] * up[0] - sun[0] * up[2], sun[0] * up[1] - sun[1] * up[0]];
    var ul = Math.sqrt(u[0] * u[0] + u[1] * u[1] + u[2] * u[2]);
    u = [u[0] / ul, u[1] / ul, u[2] / ul];
    var w = [sun[1] * u[2] - sun[2] * u[1], sun[2] * u[0] - sun[0] * u[2], sun[0] * u[1] - sun[1] * u[0]];
    var pts = [];
    for (var a = 0; a <= 360; a += 4) {
      var c = Math.cos(a * RAD), s = Math.sin(a * RAD);
      pts.push([u[0] * c + w[0] * s, u[1] * c + w[1] * s, u[2] * c + w[2] * s]);
    }
    terminator = line(pts);
    if (clock) clock.textContent = ', now ' + two(now.getUTCHours()) + ':' + two(now.getUTCMinutes()) + ' UTC';
    dirty = true;
  }

  /* Drawing
     ------------------------------------------------------------------ */

  // A colour at no strength, for gradients to fade out to. Fading to plain
  // "transparent" would pass through grey on the way.
  function clear(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',0)';
  }

  function readColours() {
    colour.line = LJ.ink('--line');
    colour.text = LJ.ink('--text');
    colour.accent = LJ.ink('--accent');
    colour.sheet = LJ.ink('--bg');
    colour.raise = LJ.ink('--raise');
    colour.lineClear = clear(colour.line);
    colour.sheetClear = clear(colour.sheet);
    dirty = true;
  }

  function resize() {
    var box = canvas.getBoundingClientRect();
    if (!box.width) return;
    size.dpr = Math.min(2, window.devicePixelRatio || 1);
    size.w = Math.round(box.width * size.dpr);
    size.h = Math.round(box.height * size.dpr);
    canvas.width = size.w;
    canvas.height = size.h;
    size.r = Math.min(size.w, size.h) * 0.43;
    dirty = true;
  }

  // The view, as the nine numbers that turn a point on the globe towards us.
  var m = new Float32Array(9);
  function setMatrix() {
    var cl = Math.cos(view.lon * RAD), sl = Math.sin(view.lon * RAD);
    var cp = Math.cos(view.lat * RAD), sp = Math.sin(view.lat * RAD);
    m[0] = cl;        m[1] = 0;   m[2] = -sl;
    m[3] = -sl * sp;  m[4] = cp;  m[5] = -cl * sp;
    m[6] = sl * cp;   m[7] = sp;  m[8] = cl * cp;
  }

  function turn(x, y, z) {
    return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
  }

  // Stroke a line on the globe, lifting the pen where it goes round the back.
  function trace(l, cx, cy, r) {
    var v = l.v, n = l.n;
    var px = 0, py = 0, pz = -1, down = false;
    for (var i = 0; i < n; i++) {
      var X = v[i * 3], Y = v[i * 3 + 1], Z = v[i * 3 + 2];
      var x = m[0] * X + m[1] * Y + m[2] * Z;
      var y = m[3] * X + m[4] * Y + m[5] * Z;
      var z = m[6] * X + m[7] * Y + m[8] * Z;
      if (i === 0 || (l.cut && l.cut[i])) {
        down = false;
      } else if (z > 0 && pz > 0) {
        if (!down) { ctx.moveTo(cx + px * r, cy - py * r); down = true; }
        ctx.lineTo(cx + x * r, cy - y * r);
      } else if (z > 0 !== pz > 0) {
        // Crossing the edge: find the point on the rim.
        var t = pz / (pz - z);
        var ex = px + (x - px) * t, ey = py + (y - py) * t;
        var el = Math.sqrt(ex * ex + ey * ey) || 1;
        ex /= el; ey /= el;
        if (pz > 0) {
          if (!down) ctx.moveTo(cx + px * r, cy - py * r);
          ctx.lineTo(cx + ex * r, cy - ey * r);
          down = false;
        } else {
          ctx.moveTo(cx + ex * r, cy - ey * r);
          ctx.lineTo(cx + x * r, cy - y * r);
          down = true;
        }
      } else {
        down = false;
      }
      px = x; py = y; pz = z;
    }
  }

  // The orbit: a tilted ring. Its far half is drawn before the globe.
  function ringPoint(a) {
    var x = Math.cos(a) * 1.15, z = Math.sin(a) * 1.15;
    var tilt = 74 * RAD, roll = -20 * RAD;
    var y = -z * Math.cos(tilt), z2 = z * Math.sin(tilt);
    return [x * Math.cos(roll) - y * Math.sin(roll), x * Math.sin(roll) + y * Math.cos(roll), z2];
  }

  function drawRing(cx, cy, r, front) {
    ctx.beginPath();
    var from = front ? 0 : Math.PI, to = from + Math.PI;
    for (var a = from; a <= to + 0.001; a += Math.PI / 60) {
      var p = ringPoint(a);
      if (a === from) ctx.moveTo(cx + p[0] * r, cy - p[1] * r);
      else ctx.lineTo(cx + p[0] * r, cy - p[1] * r);
    }
    ctx.strokeStyle = colour.line;
    ctx.globalAlpha = front ? 0.55 : 0.3;
    ctx.lineWidth = size.dpr;
    ctx.setLineDash([3 * size.dpr, 5 * size.dpr]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  function drawSatellite(cx, cy, r, front) {
    var p = ringPoint(orbit);
    if (p[2] > 0 !== front) return;
    var s = 3 * size.dpr;
    ctx.fillStyle = colour.accent;
    ctx.fillRect(cx + p[0] * r - s, cy - p[1] * r - s, s * 2, s * 2);
  }

  function drawPlace(key, cx, cy, r, time) {
    var place = PLACES[key];
    var p = turn(place.v[0], place.v[1], place.v[2]);
    if (p[2] < 0.06) return;
    var k = size.dpr;
    var fade = Math.min(1, (p[2] - 0.06) / 0.22);
    var x = cx + p[0] * r, y = cy - p[1] * r;

    ctx.globalAlpha = fade;
    ctx.strokeStyle = colour.accent;
    ctx.fillStyle = colour.accent;
    ctx.lineWidth = k;

    // A ring that pulses on the chosen place.
    if (key === chosen && !still) {
      var beat = (time / 1400) % 1;
      ctx.globalAlpha = fade * (1 - beat);
      ctx.beginPath();
      ctx.arc(x, y, (5 + beat * 16) * k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = fade;
    }
    ctx.beginPath();
    ctx.arc(x, y, 3.2 * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 6.5 * k, 0, Math.PI * 2);
    ctx.stroke();

    // The leader line and the label.
    var ax = x + place.dx * 5 * k, ay = y + place.dy * 5 * k;
    var bx = x + place.dx * 24 * k, by = y + place.dy * 24 * k;
    var ex = bx + place.dx * 12 * k;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(ex, by);
    ctx.stroke();

    var label = place.name.toUpperCase();
    ctx.font = '500 ' + 10.5 * k + 'px "IBM Plex Mono", ui-monospace, Menlo, monospace';
    if ('letterSpacing' in ctx) ctx.letterSpacing = k + 'px';
    var tw = ctx.measureText(label).width;
    var pad = 5 * k, th = 17 * k;
    var tx = place.dx > 0 ? ex + 2 * k : ex - 2 * k - tw - pad * 2;
    // On a small canvas the label is kept from running off the edge.
    tx = Math.max(2 * k, Math.min(size.w - 2 * k - tw - pad * 2, tx));
    ctx.fillStyle = colour.sheet;
    ctx.fillRect(tx, by - th / 2, tw + pad * 2, th);
    ctx.strokeRect(tx, by - th / 2, tw + pad * 2, th);
    ctx.fillStyle = colour.text;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(label, tx + pad, by + 0.5 * k);
    ctx.globalAlpha = 1;
  }

  function draw(time) {
    var W = size.w, H = size.h, r = size.r;
    if (!W) return;
    var cx = W / 2, cy = H / 2;
    setMatrix();
    ctx.clearRect(0, 0, W, H);

    // Once the photo has arrived it is painted on the canvas underneath, and
    // the drawn globe is rubbed out over it, a little more each frame.
    var shown = photo && photo.ready;
    var reveal = shown ? Math.min(1, (time - photo.since) / (still ? 1 : 900)) : 0;
    if (shown) paintPhoto();

    if (reveal < 1) {
      drawBall(cx, cy, r);
      if (reveal > 0) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.globalAlpha = reveal;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 1.16, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        dirty = true;
      }
    }

    // The far half of the orbit sits behind the globe: it is drawn after the
    // ball, but only outside the rim.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip('evenodd');
    drawRing(cx, cy, r, false);
    drawSatellite(cx, cy, r, false);
    ctx.restore();

    Object.keys(PLACES).forEach(function (key) {
      if (key !== chosen) drawPlace(key, cx, cy, r, time);
    });
    if (chosen) drawPlace(chosen, cx, cy, r, time);

    drawRing(cx, cy, r, true);
    drawSatellite(cx, cy, r, true);
  }

  // The globe as a drawing: grid, land in dots, coastlines.
  function drawBall(cx, cy, r) {
    var k = size.dpr;

    // The air: a soft ring just outside the rim.
    var air = ctx.createRadialGradient(cx, cy, r * 0.98, cx, cy, r * 1.14);
    air.addColorStop(0, colour.line);
    air.addColorStop(1, colour.lineClear);
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = air;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.14, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // The ball itself.
    ctx.fillStyle = colour.raise;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    var shade = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
    shade.addColorStop(0, colour.sheetClear);
    shade.addColorStop(1, colour.sheet);
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = shade;
    ctx.fill();
    ctx.globalAlpha = 1;

    // Grid.
    ctx.beginPath();
    for (var g = 0; g < grid.length; g++) trace(grid[g], cx, cy, r);
    ctx.strokeStyle = colour.line;
    ctx.globalAlpha = 0.17;
    ctx.lineWidth = k;
    ctx.stroke();

    // Land, as dots: lit ones first, then the night side, dimmer.
    var s = Math.max(1.3 * k, r * 0.0105);
    for (var pass = 1; pass >= 0; pass--) {
      ctx.beginPath();
      for (var i = 0; i < dotCount; i++) {
        if (lit[i] !== pass) continue;
        var X = dots[i * 3], Y = dots[i * 3 + 1], Z = dots[i * 3 + 2];
        var z = m[6] * X + m[7] * Y + m[8] * Z;
        if (z <= 0.02) continue;
        var x = m[0] * X + m[1] * Y + m[2] * Z;
        var y = m[3] * X + m[4] * Y + m[5] * Z;
        var q = s * (0.5 + 0.5 * z);
        ctx.rect(cx + x * r - q / 2, cy - y * r - q / 2, q, q);
      }
      ctx.fillStyle = colour.line;
      ctx.globalAlpha = pass ? 0.95 : 0.4;
      ctx.fill();
    }

    // Coast.
    ctx.beginPath();
    for (var c = 0; c < coast.length; c++) trace(coast[c], cx, cy, r);
    ctx.strokeStyle = colour.line;
    ctx.globalAlpha = 0.62;
    ctx.lineWidth = k;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // The line between day and night.
    if (terminator) {
      ctx.beginPath();
      trace(terminator, cx, cy, r);
      ctx.strokeStyle = colour.accent;
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([2 * k, 5 * k]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;

    // Rim.
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = colour.line;
    ctx.lineWidth = 1.25 * k;
    ctx.stroke();
  }

  /* The photo globe
     A picture of the Earth by day and one by night, wrapped round the ball
     by a small program that runs on the graphics card. For every pixel it
     works out which point of the globe is there, looks that point up in both
     pictures, and mixes them by how much sun the point is getting.
     ------------------------------------------------------------------ */

  var photo = null;

  var VERTEX = [
    '#version 300 es',
    'in vec2 corner;',
    'void main() { gl_Position = vec4(corner, 0.0, 1.0); }'
  ].join('\n');

  var FRAGMENT = [
    '#version 300 es',
    'precision highp float;',
    'uniform vec2 uSize;',       // the canvas, in pixels
    'uniform float uRadius;',    // the globe, in pixels
    'uniform mat3 uToWorld;',    // turns a point facing us back onto the globe
    'uniform vec3 uSun;',        // where the sun is, as seen from here
    'uniform sampler2D uDay;',
    'uniform sampler2D uNight;',
    'out vec4 colour;',
    'const float PI = 3.141592653589793;',
    '',
    // Look a point of the globe up in a flat map. The map has a seam down
    // the date line; near it, the smoother of two ways of counting longitude
    // is used to judge how fine a copy of the map to read.
    'vec3 lookUp(sampler2D map, vec3 w) {',
    '  float v = 0.5 - asin(clamp(w.y, -1.0, 1.0)) / PI;',
    '  float uA = atan(w.x, w.z) / (2.0 * PI) + 0.5;',
    '  float uB = fract(uA + 0.5) - 0.5;',
    '  vec2 a = vec2(uA, v), b = vec2(uB, v);',
    '  bool smoothA = fwidth(uA) <= fwidth(uB);',
    '  vec2 dx = smoothA ? dFdx(a) : dFdx(b);',
    '  vec2 dy = smoothA ? dFdy(a) : dFdy(b);',
    '  return textureGrad(map, a, dx, dy).rgb;',
    '}',
    '',
    'void main() {',
    '  vec2 p = (gl_FragCoord.xy - 0.5 * uSize) / uRadius;',
    '  float d = length(p);',
    '',
    // The glow of the air beyond the rim, brighter on the sunlit side.
    '  float out_ = clamp((d - 1.0) / 0.13, 0.0, 1.0);',
    '  float towards = dot(normalize(vec3(p, 0.0001)), uSun);',
    '  float glow = pow(1.0 - out_, 3.0) * (0.28 + 0.6 * smoothstep(-0.5, 0.7, towards));',
    '  vec4 halo = vec4(vec3(0.36, 0.62, 1.0) * glow, glow);',
    '  if (d >= 1.0) { colour = halo; return; }',
    '',
    '  vec3 n = vec3(p, sqrt(1.0 - d * d));',
    '  vec3 w = uToWorld * n;',
    '  vec3 day = lookUp(uDay, w);',
    '  vec3 night = lookUp(uNight, w);',
    '  float light = dot(n, uSun);',
    '',
    // Daylight, with a glint of the sun on open water.
    '  float water = smoothstep(0.03, 0.12, day.b - max(day.r, day.g));',
    '  vec3 sea = mix(day, vec3(0.03, 0.16, 0.42), 0.35 * water);',
    '  vec3 lit = sea * (0.10 + 1.25 * pow(max(light, 0.0), 0.7));',
    '  vec3 halfway = normalize(uSun + vec3(0.0, 0.0, 1.0));',
    '  lit += vec3(1.0, 0.93, 0.8) * pow(max(dot(n, halfway), 0.0), 140.0) * water * 0.32;',
    '',
    // Night: the land faintly, and the lights of cities. In the night
    // picture the land is blue and the lights are warm, which tells them apart.
    '  float lamps = max(night.r - night.b * 0.92, 0.0);',
    '  vec3 dark = night * vec3(0.8, 0.92, 1.15) + vec3(1.0, 0.8, 0.5) * lamps * 5.5;',
    '',
    '  float dayness = smoothstep(-0.12, 0.2, light);',
    '  vec3 c = mix(dark, lit, dayness);',
    // A warm band where day meets night.
    '  float dusk = smoothstep(-0.2, 0.02, light) * (1.0 - smoothstep(0.02, 0.3, light));',
    '  c += vec3(0.3, 0.12, 0.03) * dusk * 0.2;',
    // The air seen edge on, at the rim.
    '  float rim = pow(1.0 - n.z, 2.6);',
    '  c = mix(c, vec3(0.42, 0.68, 1.0), rim * (0.2 + 0.6 * smoothstep(-0.35, 0.4, light)));',
    '',
    '  float edge = clamp((1.0 - d) * uRadius, 0.0, 1.0);',
    '  colour = mix(halo, vec4(c, 1.0), edge);',
    '}'
  ].join('\n');

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = reject;
      img.src = src;
    });
  }

  function startPhoto() {
    if (photo || !glCanvas || !LJ.globePhoto) return;
    var gl = glCanvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) return;   // the drawn globe stays

    function compile(type, source) {
      var s = gl.createShader(type);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }

    var program;
    try {
      program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    } catch (e) {
      if (window.console) console.warn('The photo globe could not start, so the drawn one stays.', e);
      return;
    }
    gl.useProgram(program);

    // One triangle, big enough to cover the canvas.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var corner = gl.getAttribLocation(program, 'corner');
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

    var sharper = gl.getExtension('EXT_texture_filter_anisotropic');
    function wrap(img, unit) {
      var t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (sharper) {
        gl.texParameterf(gl.TEXTURE_2D, sharper.TEXTURE_MAX_ANISOTROPY_EXT,
          Math.min(8, gl.getParameter(sharper.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      }
    }

    Promise.all([loadImage(LJ.globePhoto.day), loadImage(LJ.globePhoto.night)]).then(function (maps) {
      wrap(maps[0], 0);
      wrap(maps[1], 1);
      gl.uniform1i(gl.getUniformLocation(program, 'uDay'), 0);
      gl.uniform1i(gl.getUniformLocation(program, 'uNight'), 1);
      photo = {
        gl: gl,
        size: gl.getUniformLocation(program, 'uSize'),
        radius: gl.getUniformLocation(program, 'uRadius'),
        toWorld: gl.getUniformLocation(program, 'uToWorld'),
        sun: gl.getUniformLocation(program, 'uSun'),
        ready: true,
        since: performance.now()
      };
      host.classList.add('is-photo');
      dirty = true;
    }).catch(function () {});
  }

  function paintPhoto() {
    var gl = photo.gl;
    if (glCanvas.width !== size.w || glCanvas.height !== size.h) {
      glCanvas.width = size.w;
      glCanvas.height = size.h;
    }
    gl.viewport(0, 0, size.w, size.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(photo.size, size.w, size.h);
    gl.uniform1f(photo.radius, size.r);
    // The view's nine numbers, read the other way, turn a point back.
    gl.uniformMatrix3fv(photo.toWorld, false, m);
    var s = turn(sun[0], sun[1], sun[2]);
    gl.uniform3f(photo.sun, s[0], s[1], s[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // The two pictures are large, so they are fetched after the page is up.
  function fetchPhoto() {
    var src = host.getAttribute('data-photo-script');
    if (!src || !glCanvas) return;
    if (LJ.globePhoto) { startPhoto(); return; }
    var el = document.createElement('script');
    el.src = src;
    el.onload = startPhoto;
    document.head.appendChild(el);
  }

  /* Movement
     ------------------------------------------------------------------ */

  function wrap(lon) { return ((lon + 540) % 360) - 180; }

  function choose(key) {
    chosen = key;
    Array.prototype.forEach.call(buttons, function (b) {
      b.classList.toggle('is-chosen', b.getAttribute('data-place') === key);
    });
    dirty = true;
  }

  // Turn to a place, then move the page to the job that was done there.
  var going = 0;
  function goTo(key) {
    flyTo(key);
    var link = host.querySelector('[data-place="' + key + '"]');
    var target = link && document.querySelector(link.getAttribute('href'));
    if (!target) return;
    clearTimeout(going);
    going = setTimeout(function () {
      target.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
    }, still ? 0 : 950);
  }

  // The pin under a point on the screen, if there is one.
  function pinAt(clientX, clientY) {
    var box = canvas.getBoundingClientRect();
    var scale = size.dpr, found = null, nearest = 18;
    Object.keys(PLACES).forEach(function (key) {
      var p = turn(PLACES[key].v[0], PLACES[key].v[1], PLACES[key].v[2]);
      if (p[2] < 0.06) return;
      var x = box.left + (size.w / 2 + p[0] * size.r) / scale;
      var y = box.top + (size.h / 2 - p[1] * size.r) / scale;
      var gap = Math.sqrt((clientX - x) * (clientX - x) + (clientY - y) * (clientY - y));
      if (gap < nearest) { nearest = gap; found = key; }
    });
    return found;
  }

  function flyTo(key) {
    var place = PLACES[key];
    var to = { lon: place.lon, lat: Math.max(-60, Math.min(60, place.lat * 0.62)) };
    choose(key);
    holdUntil = performance.now() + HOLD_MS;
    view.speed = 0;
    if (still) {
      view.lon = to.lon; view.lat = to.lat;
      dirty = true;
      return;
    }
    fly = { from: { lon: view.lon, lat: view.lat }, by: { lon: wrap(to.lon - view.lon), lat: to.lat - view.lat }, at: performance.now(), ms: 1100 };
  }

  function frame(time) {
    var dt = Math.min(0.05, (time - last) / 1000 || 0);
    last = time;

    if (fly) {
      var t = Math.min(1, (time - fly.at) / fly.ms);
      var e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      view.lon = wrap(fly.from.lon + fly.by.lon * e);
      view.lat = fly.from.lat + fly.by.lat * e;
      if (t === 1) fly = null;
      dirty = true;
    } else if (!held) {
      if (chosen && time > holdUntil) choose(null);
      // After a throw or a hold, the spin eases back to its steady pace.
      var want = time < holdUntil ? 0 : SPIN;
      view.speed += (want - view.speed) * Math.min(1, dt * 1.8);
      if (Math.abs(view.speed) > 0.01) {
        view.lon = wrap(view.lon + view.speed * dt);
        dirty = true;
      }
    }

    if (!still) {
      orbit = (orbit + dt * 0.5) % (Math.PI * 2);
      dirty = true;
    }

    if (dirty) {
      draw(time);
      dirty = false;
    }
    if (visible) requestAnimationFrame(frame);
    else running = false;
  }

  var running = false;
  function start() {
    if (running) return;
    running = true;
    last = 0;
    requestAnimationFrame(frame);
  }

  // Dragging.
  var grab = null, pressed = null;
  canvas.addEventListener('pointerdown', function (e) {
    grab = { x: e.clientX, y: e.clientY, t: performance.now() };
    pressed = { x: e.clientX, y: e.clientY, pin: pinAt(e.clientX, e.clientY) };
    held = true;
    fly = null;
    view.speed = 0;
    canvas.classList.add('is-held');
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!grab) {
      // Over a pin, the pointer shows it can be picked.
      canvas.style.cursor = pinAt(e.clientX, e.clientY) ? 'pointer' : '';
      return;
    }
    var perPx = 180 / (Math.PI * (size.r / size.dpr));
    var now = performance.now();
    var dx = e.clientX - grab.x, dy = e.clientY - grab.y;
    var moved = -dx * perPx;
    view.lon = wrap(view.lon + moved);
    view.lat = Math.max(-75, Math.min(75, view.lat + dy * perPx));
    var gap = Math.max(8, now - grab.t) / 1000;
    view.speed = Math.max(-240, Math.min(240, moved / gap));
    grab = { x: e.clientX, y: e.clientY, t: now };
    dirty = true;
  });
  function release() {
    if (!grab) return;
    if (performance.now() - grab.t > 120) view.speed = 0;   // held still, then let go
    grab = null;
    held = false;
    holdUntil = 0;
    canvas.classList.remove('is-held');
  }
  canvas.addEventListener('pointerup', function (e) {
    var was = pressed;
    pressed = null;
    release();
    // A press on a pin that did not turn into a drag picks that place.
    if (was && was.pin && Math.abs(e.clientX - was.x) + Math.abs(e.clientY - was.y) < 6) goTo(was.pin);
  });
  canvas.addEventListener('pointercancel', function () { pressed = null; release(); });

  canvas.addEventListener('keydown', function (e) {
    var step = { ArrowLeft: [12, 0], ArrowRight: [-12, 0], ArrowUp: [0, 8], ArrowDown: [0, -8] }[e.key];
    if (!step) return;
    e.preventDefault();
    fly = null;
    view.lon = wrap(view.lon + step[0]);
    view.lat = Math.max(-75, Math.min(75, view.lat + step[1]));
    view.speed = 0;
    holdUntil = performance.now() + HOLD_MS;
    dirty = true;
  });

  Array.prototype.forEach.call(buttons, function (b) {
    b.addEventListener('click', function (e) {
      e.preventDefault();
      goTo(b.getAttribute('data-place'));
    });
  });

  /* Start
     ------------------------------------------------------------------ */

  readColours();
  resize();
  setSun();
  setInterval(setSun, 60000);

  if (document.readyState === 'complete') fetchPhoto();
  else window.addEventListener('load', fetchPhoto);

  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
  else window.addEventListener('resize', resize);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { dirty = true; });

  // Only turn while it can be seen.
  if (window.IntersectionObserver) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible) start();
    }).observe(canvas);
  }
  start();
})();
