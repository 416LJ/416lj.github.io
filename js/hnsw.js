/* hnsw.js
 * Hierarchical Navigable Small World index for 2-D points.
 *
 * Follows Malkov & Yashunin (2016): exponentially distributed node levels,
 * greedy descent through the upper layers, a beam search on layer 0, and the
 * neighbour-selection heuristic that keeps links pointing in different
 * directions (which is what stops separate clusters from drifting apart).
 *
 * search() can record a trace of every step, so a search can be replayed on
 * screen. No DOM access in here.
 */
(function (root) {
  'use strict';

  var LJ = (root.LJ = root.LJ || {});

  /**
   * @param {object} [opts]
   * @param {number} [opts.M]               links per node on layers above 0
   * @param {number} [opts.M0]              links per node on layer 0
   * @param {number} [opts.efConstruction]  beam width while building
   * @param {number} [opts.maxLevel]        cap on the top layer
   * @param {function} [opts.rng]           uniform [0, 1) source
   */
  function HNSW(opts) {
    opts = opts || {};
    this.M = opts.M || 5;
    this.M0 = opts.M0 || this.M * 2;
    this.efConstruction = opts.efConstruction || 40;
    this.maxLevel = opts.maxLevel === undefined ? 2 : opts.maxLevel;
    this.rng = opts.rng || Math.random;
    this.mL = 1 / Math.log(this.M);

    this.xs = [];
    this.ys = [];
    this.levels = [];
    this.links = []; // links[layer][id] -> array of neighbour ids
    this.entry = -1;
    this.top = -1;
  }

  HNSW.prototype.size = function () {
    return this.xs.length;
  };

  HNSW.prototype.dist = function (id, qx, qy) {
    var dx = this.xs[id] - qx, dy = this.ys[id] - qy;
    return Math.sqrt(dx * dx + dy * dy);
  };

  HNSW.prototype.dist2 = function (a, b) {
    var dx = this.xs[a] - this.xs[b], dy = this.ys[a] - this.ys[b];
    return Math.sqrt(dx * dx + dy * dy);
  };

  HNSW.prototype.drawLevel = function () {
    var u = 0;
    while (u === 0) u = this.rng();
    return Math.min(this.maxLevel, Math.floor(-Math.log(u) * this.mL));
  };

  // Insert into an array kept sorted by ascending distance.
  function insertSorted(arr, item) {
    var lo = 0, hi = arr.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid].d < item.d) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, item);
  }

  /**
   * Beam search within one layer.
   * @param {Array<{id:number,d:number}>} entries starting points, with distances
   * @returns {Array<{id:number,d:number}>} up to ef nearest found, closest first
   */
  HNSW.prototype.searchLayer = function (qx, qy, entries, ef, layer, trace) {
    var visited = Object.create(null);
    var cand = [];    // to expand, ascending
    var found = [];   // best so far, ascending
    var i;
    for (i = 0; i < entries.length; i++) {
      visited[entries[i].id] = true;
      insertSorted(cand, entries[i]);
      insertSorted(found, entries[i]);
    }
    var links = this.links[layer];

    while (cand.length) {
      var c = cand.shift();
      if (found.length >= ef && c.d > found[found.length - 1].d) break;
      if (trace) trace.push({ t: 'expand', layer: layer, id: c.id });

      var nbrs = links[c.id];
      for (i = 0; i < nbrs.length; i++) {
        var e = nbrs[i];
        if (visited[e]) continue;
        visited[e] = true;
        var d = this.dist(e, qx, qy);
        var keep = found.length < ef || d < found[found.length - 1].d;
        if (trace) trace.push({ t: 'check', layer: layer, from: c.id, to: e, keep: keep });
        if (keep) {
          var item = { id: e, d: d };
          insertSorted(cand, item);
          insertSorted(found, item);
          if (found.length > ef) found.pop();
        }
      }
    }
    return found;
  };

  /**
   * Pick up to m links for a node from a candidate list (closest first).
   * A candidate is kept only if it is closer to the node than to every link
   * already kept, so the links spread out instead of piling up on one side.
   */
  HNSW.prototype.selectNeighbours = function (cands, m) {
    var kept = [];
    var spare = [];
    for (var i = 0; i < cands.length && kept.length < m; i++) {
      var c = cands[i];
      var ok = true;
      for (var j = 0; j < kept.length; j++) {
        if (this.dist2(c.id, kept[j].id) < c.d) { ok = false; break; }
      }
      if (ok) kept.push(c);
      else spare.push(c);
    }
    // Top up with the nearest rejected candidates so no node is left under-linked.
    for (var s = 0; s < spare.length && kept.length < m; s++) kept.push(spare[s]);
    return kept;
  };

  /** Add a point. Returns its id. */
  HNSW.prototype.add = function (x, y, level) {
    var id = this.xs.length;
    if (level === undefined) level = this.drawLevel();
    this.xs.push(x);
    this.ys.push(y);
    this.levels.push(level);
    var l;
    for (l = 0; l <= this.maxLevel; l++) {
      if (!this.links[l]) this.links[l] = [];
      this.links[l][id] = [];
    }

    if (this.entry === -1) {
      this.entry = id;
      this.top = level;
      return id;
    }

    var ep = [{ id: this.entry, d: this.dist(this.entry, x, y) }];
    for (l = this.top; l > level; l--) {
      ep = [this.searchLayer(x, y, ep, 1, l, null)[0]];
    }
    for (l = Math.min(this.top, level); l >= 0; l--) {
      var found = this.searchLayer(x, y, ep, this.efConstruction, l, null);
      var mMax = l === 0 ? this.M0 : this.M;
      var chosen = this.selectNeighbours(found, this.M);
      var layerLinks = this.links[l];
      for (var i = 0; i < chosen.length; i++) {
        var n = chosen[i].id;
        layerLinks[id].push(n);
        layerLinks[n].push(id);
        if (layerLinks[n].length > mMax) {
          // Re-select the neighbour's links from its own point of view.
          var own = [];
          for (var j = 0; j < layerLinks[n].length; j++) {
            var o = layerLinks[n][j];
            insertSorted(own, { id: o, d: this.dist2(n, o) });
          }
          var pruned = this.selectNeighbours(own, mMax);
          layerLinks[n] = pruned.map(function (p) { return p.id; });
        }
      }
      ep = found;
    }
    if (level > this.top) {
      this.top = level;
      this.entry = id;
    }
    return id;
  };

  /**
   * k nearest neighbours of (qx, qy).
   * @param {Array} [trace] if given, every step is appended to it
   * @returns {Array<{id:number,d:number}>} closest first
   */
  HNSW.prototype.search = function (qx, qy, k, ef, trace) {
    if (this.entry === -1) return [];
    ef = Math.max(ef || k, k);
    var ep = [{ id: this.entry, d: this.dist(this.entry, qx, qy) }];
    if (trace) trace.push({ t: 'enter', layer: this.top, id: this.entry });
    for (var l = this.top; l > 0; l--) {
      ep = [this.searchLayer(qx, qy, ep, 1, l, trace)[0]];
      if (trace) trace.push({ t: 'descend', layer: l, to: l - 1, id: ep[0].id });
    }
    var found = this.searchLayer(qx, qy, ep, ef, 0, trace).slice(0, k);
    if (trace) trace.push({ t: 'done', ids: found.map(function (f) { return f.id; }) });
    return found;
  };

  /** Exact k nearest by checking every point. The baseline HNSW is compared against. */
  HNSW.prototype.bruteForce = function (qx, qy, k) {
    var all = [];
    for (var i = 0; i < this.xs.length; i++) all.push({ id: i, d: this.dist(i, qx, qy) });
    all.sort(function (a, b) { return a.d - b.d; });
    return all.slice(0, k);
  };

  /** Ids present on a given layer. */
  HNSW.prototype.nodesOnLayer = function (layer) {
    var out = [];
    for (var i = 0; i < this.levels.length; i++) if (this.levels[i] >= layer) out.push(i);
    return out;
  };

  LJ.HNSW = HNSW;
})(typeof window !== 'undefined' ? window : globalThis);
