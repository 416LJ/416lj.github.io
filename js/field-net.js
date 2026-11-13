/* field-net.js
 * A small coordinate network: (x, y) -> ink density.
 *
 * Random Fourier features feed a two-hidden-layer ReLU MLP. It is trained
 * with binary cross-entropy and Adam, by plain backpropagation, on typed
 * arrays. No DOM access in here, so the same file runs under Node for tests.
 *
 * Everything lives inside one named function. That lets field-trainer.js hand
 * the very same source to a Web Worker as text, so the network is written once.
 */
(function (root) {

  function defineFieldNet(root) {
    'use strict';

    var LJ = (root.LJ = root.LJ || {});

    // Small seeded PRNG, so a given seed always draws the same page.
    function mulberry32(seed) {
      var a = seed >>> 0;
      return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        var t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    // Standard normal sample (Box-Muller).
    function gauss(rng) {
      var u = 0;
      while (u === 0) u = rng();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
    }

    /**
     * @param {object} [opts]
     * @param {number} [opts.features] number of random Fourier projections
     * @param {number} [opts.hidden]   units in each hidden layer
     * @param {number} [opts.sigma]    spread of the projection frequencies, in cycles per unit
     * @param {number} [opts.lr]       Adam learning rate
     * @param {number} [opts.seed]
     */
    function FieldNet(opts) {
      opts = opts || {};
      var F = (this.F = opts.features || 20);
      var H = (this.H = opts.hidden || 24);
      var D = (this.D = 2 * F);
      this.lr = opts.lr || 0.01;
      this.sigma = opts.sigma || 2.4;
      this.step = 0;

      var rng = mulberry32(opts.seed === undefined ? 1 : opts.seed);

      // Fixed projection matrix B (F x 2). Not trained.
      this.B = new Float32Array(F * 2);
      for (var i = 0; i < F * 2; i++) this.B[i] = gauss(rng) * this.sigma;

      // Parameter layout in one flat buffer: W1, b1, W2, b2, W3, b3.
      this.oW1 = 0;
      this.ob1 = this.oW1 + H * D;
      this.oW2 = this.ob1 + H;
      this.ob2 = this.oW2 + H * H;
      this.oW3 = this.ob2 + H;
      this.ob3 = this.oW3 + H;
      this.size = this.ob3 + 1;

      this.p = new Float32Array(this.size);
      this.g = new Float32Array(this.size);
      this.m = new Float32Array(this.size);
      this.v = new Float32Array(this.size);

      // He initialisation for the ReLU layers; biases start at zero.
      var k;
      var s1 = Math.sqrt(2 / D);
      for (k = this.oW1; k < this.ob1; k++) this.p[k] = gauss(rng) * s1;
      var s2 = Math.sqrt(2 / H);
      for (k = this.oW2; k < this.ob2; k++) this.p[k] = gauss(rng) * s2;
      var s3 = Math.sqrt(1 / H);
      for (k = this.oW3; k < this.ob3; k++) this.p[k] = gauss(rng) * s3;

      // Scratch activations for one sample.
      this.h1 = new Float32Array(H);
      this.h2 = new Float32Array(H);
      this.d1 = new Float32Array(H);
      this.d2 = new Float32Array(H);
    }

    /** Number of trainable weights. */
    FieldNet.prototype.paramCount = function () {
      return this.size;
    };

    /**
     * Fourier-encode n points. xy holds x0, y0, x1, y1, ...
     * Returns (or fills) an n x D buffer of [sin, cos] pairs.
     */
    FieldNet.prototype.encode = function (xy, n, out) {
      var F = this.F, D = this.D, B = this.B;
      out = out || new Float32Array(n * D);
      var TAU = 2 * Math.PI;
      for (var i = 0; i < n; i++) {
        var x = xy[2 * i], y = xy[2 * i + 1];
        var o = i * D;
        for (var f = 0; f < F; f++) {
          var a = TAU * (B[2 * f] * x + B[2 * f + 1] * y);
          out[o + 2 * f] = Math.sin(a);
          out[o + 2 * f + 1] = Math.cos(a);
        }
      }
      return out;
    };

    /**
     * Forward pass for n encoded points, starting at row `from` (default 0).
     * Writes ink density in [0, 1] to the matching rows of out. Taking a row
     * range lets a caller spread one full evaluation over several slices.
     */
    FieldNet.prototype.predict = function (enc, n, out, from) {
      var D = this.D, H = this.H, p = this.p;
      var oW1 = this.oW1, ob1 = this.ob1, oW2 = this.oW2, ob2 = this.ob2, oW3 = this.oW3;
      var b3 = p[this.ob3];
      var h1 = this.h1;
      from = from || 0;
      var end = from + n;
      out = out || new Float32Array(end);
      for (var i = from; i < end; i++) {
        var e = i * D, j, k, s, w;
        for (j = 0; j < H; j++) {
          s = p[ob1 + j];
          w = oW1 + j * D;
          for (k = 0; k < D; k++) s += p[w + k] * enc[e + k];
          h1[j] = s > 0 ? s : 0;
        }
        var z = b3;
        for (j = 0; j < H; j++) {
          s = p[ob2 + j];
          w = oW2 + j * H;
          for (k = 0; k < H; k++) s += p[w + k] * h1[k];
          if (s > 0) z += p[oW3 + j] * s;
        }
        out[i] = 1 / (1 + Math.exp(-z));
      }
      return out;
    };

    /**
     * One Adam step on a mini-batch.
     * @param {Float32Array} enc      encoded training points (rows x D)
     * @param {Float32Array} target   ink density per row, in [0, 1]
     * @param {Uint32Array|Int32Array} idx  row indices that make up the batch
     * @param {number} n              batch size
     * @returns {number} mean binary cross-entropy over the batch
     */
    FieldNet.prototype.trainStep = function (enc, target, idx, n) {
      var D = this.D, H = this.H, p = this.p, g = this.g;
      var oW1 = this.oW1, ob1 = this.ob1, oW2 = this.oW2, ob2 = this.ob2, oW3 = this.oW3, ob3 = this.ob3;
      var h1 = this.h1, h2 = this.h2, d1 = this.d1, d2 = this.d2;
      var i, j, k, s, w;

      g.fill(0);
      var loss = 0;
      var inv = 1 / n;

      for (i = 0; i < n; i++) {
        var row = idx[i];
        var e = row * D;
        var t = target[row];

        // forward
        for (j = 0; j < H; j++) {
          s = p[ob1 + j];
          w = oW1 + j * D;
          for (k = 0; k < D; k++) s += p[w + k] * enc[e + k];
          h1[j] = s > 0 ? s : 0;
        }
        var z = p[ob3];
        for (j = 0; j < H; j++) {
          s = p[ob2 + j];
          w = oW2 + j * H;
          for (k = 0; k < H; k++) s += p[w + k] * h1[k];
          s = s > 0 ? s : 0;
          h2[j] = s;
          z += p[oW3 + j] * s;
        }

        // loss, written in the numerically stable logit form
        loss += (z > 0 ? z : 0) - z * t + Math.log(1 + Math.exp(z > 0 ? -z : z));

        // backward
        var dz = (1 / (1 + Math.exp(-z)) - t) * inv;
        g[ob3] += dz;
        for (j = 0; j < H; j++) {
          g[oW3 + j] += dz * h2[j];
          d2[j] = h2[j] > 0 ? dz * p[oW3 + j] : 0;
          d1[j] = 0;
        }
        for (j = 0; j < H; j++) {
          var dj = d2[j];
          if (dj === 0) continue;
          g[ob2 + j] += dj;
          w = oW2 + j * H;
          for (k = 0; k < H; k++) {
            g[w + k] += dj * h1[k];
            d1[k] += dj * p[w + k];
          }
        }
        for (j = 0; j < H; j++) {
          if (h1[j] <= 0) continue;
          var dk = d1[j];
          g[ob1 + j] += dk;
          w = oW1 + j * D;
          for (k = 0; k < D; k++) g[w + k] += dk * enc[e + k];
        }
      }

      // Adam update
      this.step++;
      var b1 = 0.9, b2 = 0.999, eps = 1e-8;
      var c1 = 1 - Math.pow(b1, this.step);
      var c2 = 1 - Math.pow(b2, this.step);
      var a = (this.lr * Math.sqrt(c2)) / c1;
      var m = this.m, v = this.v;
      for (k = 0; k < this.size; k++) {
        var gk = g[k];
        m[k] = b1 * m[k] + (1 - b1) * gk;
        v[k] = b2 * v[k] + (1 - b2) * gk * gk;
        p[k] -= (a * m[k]) / (Math.sqrt(v[k]) + eps);
      }

      return loss * inv;
    };

    LJ.mulberry32 = mulberry32;
    LJ.gauss = gauss;
    LJ.FieldNet = FieldNet;
  }

  defineFieldNet(root);
  root.LJ.defineFieldNet = defineFieldNet;
})(typeof window !== 'undefined' ? window : globalThis);
