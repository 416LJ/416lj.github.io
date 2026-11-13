/* audit-demo.js
 * Chapter 03 demo: an SSH key audit in miniature.
 *
 * Every server keeps a list of the keys it accepts. Every key belongs to a
 * person. The audit walks each list, looks each owner up in the directory,
 * removes the keys of anyone who has left, and writes a report.
 *
 * The names, servers and keys are made up. The steps are the real ones.
 */
(function () {
  'use strict';

  var LJ = window.LJ || {};
  var host = document.querySelector('[data-audit-demo]');
  if (!host) return;

  var elPeople = host.querySelector('[data-people]');
  var elServers = host.querySelector('[data-servers]');
  var elReport = host.querySelector('[data-report]');
  var btnRun = host.querySelector('[data-run]');
  var btnReset = host.querySelector('[data-reset]');

  var PEOPLE = ['amara', 'bo', 'chen', 'dana', 'eli', 'farid'];
  var LEFT_AT_START = ['dana'];
  var SERVERS = [
    { name: 'web-01', keys: ['amara', 'bo', 'dana', 'eli'] },
    { name: 'api-01', keys: ['bo', 'chen', 'dana', 'farid'] },
    { name: 'db-01', keys: ['amara', 'chen', 'eli'] }
  ];
  var STEP_MS = 150;        // time spent on each key
  var REMOVE_MS = 420;      // extra time when a key is being removed

  var S = {
    left: {},               // name -> true once that person has left
    removed: {},            // "server/owner" -> true once that key is gone
    running: false,
    timer: 0
  };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // A short, stable stand-in for a key fingerprint.
  function fingerprint(server, owner) {
    var s = server + '/' + owner, h = 2166136261;
    for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return ('0000000' + (h >>> 0).toString(16)).slice(-8);
  }

  function countPlural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }


  /* Drawing
     ---------------------------------------------------------------------- */

  // The buttons are built once and then updated in place, so a keyboard user
  // keeps their place in the list after pressing one.
  var personButtons = {};

  function buildPeople() {
    PEOPLE.forEach(function (name) {
      var li = el('li');
      var btn = el('button', 'person');
      btn.type = 'button';
      btn.appendChild(el('span', 'person__name', name));
      btn.appendChild(el('span', 'person__state', ''));
      btn.addEventListener('click', function () {
        if (S.running) return;
        S.left[name] = !S.left[name];
        renderPeople();
        hint();
      });
      personButtons[name] = btn;
      li.appendChild(btn);
      elPeople.appendChild(li);
    });
  }

  function renderPeople() {
    PEOPLE.forEach(function (name) {
      var gone = !!S.left[name];
      var btn = personButtons[name];
      btn.classList.toggle('is-left', gone);
      btn.setAttribute('aria-pressed', String(gone));
      btn.setAttribute('aria-disabled', String(S.running));
      btn.lastChild.textContent = gone ? 'Left' : 'Active';
    });
  }

  function renderServers() {
    elServers.textContent = '';
    SERVERS.forEach(function (server) {
      var card = el('div', 'panel server');
      var head = el('p', 'server__name');
      head.appendChild(el('b', '', server.name));
      head.appendChild(el('span', '', 'authorized_keys'));
      card.appendChild(head);
      var list = el('ul', 'server__keys');
      server.keys.forEach(function (owner) {
        var id = server.name + '/' + owner;
        var row = el('li', 'key' + (S.removed[id] ? ' is-removed' : ''));
        row.setAttribute('data-key', id);
        row.appendChild(el('code', 'key__print', 'ssh-ed25519 …' + fingerprint(server.name, owner)));
        row.appendChild(el('span', 'key__owner', owner));
        row.appendChild(el('span', 'key__state', S.removed[id] ? 'removed' : ''));
        list.appendChild(row);
      });
      card.appendChild(list);
      elServers.appendChild(card);
    });
  }

  function report(lines) {
    elReport.textContent = '';
    lines.forEach(function (line) {
      elReport.appendChild(el('p', line.cls || '', line.text));
    });
  }

  // What the report panel says before an audit has run.
  function hint() {
    var gone = PEOPLE.filter(function (p) { return S.left[p]; });
    var who = gone.length ? gone.join(', ') + (gone.length === 1 ? ' has' : ' have') + ' left.' : 'Nobody has left.';
    report([
      { cls: 'audit__quiet', text: 'No audit has run yet.' },
      { cls: 'audit__quiet', text: who + ' Run the audit to see what it finds.' }
    ]);
  }


  /* The audit
     ---------------------------------------------------------------------- */

  function keyRow(id) {
    return elServers.querySelector('[data-key="' + id + '"]');
  }

  function finish(checked, removedNow) {
    S.running = false;
    btnRun.disabled = false;
    renderPeople();

    var lines = [
      { cls: 'audit__head', text: 'To: operations' },
      { cls: 'audit__head', text: 'Subject: SSH key audit' }
    ];
    if (!removedNow.length) {
      lines.push({ text: 'Checked ' + countPlural(checked, 'key', 'keys') + ' on ' + countPlural(SERVERS.length, 'server', 'servers') + '. Every key belongs to someone in the directory. Nothing to remove.' });
    } else {
      var owners = {};
      removedNow.forEach(function (r) { owners[r.owner] = true; });
      var people = Object.keys(owners).length;
      lines.push({ text: 'Checked ' + countPlural(checked, 'key', 'keys') + ' on ' + countPlural(SERVERS.length, 'server', 'servers') + '. Removed ' + countPlural(removedNow.length, 'key', 'keys') + ' belonging to ' + countPlural(people, 'person who has', 'people who have') + ' left:' });
      removedNow.forEach(function (r) {
        lines.push({ cls: 'audit__item', text: r.owner + ' on ' + r.server });
      });
    }
    report(lines);
  }

  function run() {
    if (S.running) return;
    S.running = true;
    btnRun.disabled = true;
    renderPeople();
    report([{ cls: 'audit__quiet', text: 'Checking every key against the directory.' }]);

    // Every key still in place, server by server.
    var queue = [];
    SERVERS.forEach(function (server) {
      server.keys.forEach(function (owner) {
        var id = server.name + '/' + owner;
        if (!S.removed[id]) queue.push({ id: id, server: server.name, owner: owner });
      });
    });

    var removedNow = [];
    var instant = !!(LJ.reduceMotion && LJ.reduceMotion.matches);
    var i = 0;

    var step = function () {
      if (i > 0) {
        var prev = keyRow(queue[i - 1].id);
        if (prev) prev.classList.remove('is-checking');
      }
      if (i >= queue.length) {
        finish(queue.length, removedNow);
        return;
      }
      var k = queue[i++];
      var row = keyRow(k.id);
      var orphan = !!S.left[k.owner];
      if (row) row.classList.add('is-checking');
      if (orphan) {
        S.removed[k.id] = true;
        removedNow.push(k);
        if (row) {
          row.classList.add('is-orphan');
          row.querySelector('.key__state').textContent = 'owner has left';
        }
        var settle = function () {
          if (row) {
            row.classList.add('is-removed');
            row.querySelector('.key__state').textContent = 'removed';
          }
          step();
        };
        if (instant) settle();
        else S.timer = setTimeout(settle, REMOVE_MS);
      } else if (instant) {
        step();
      } else {
        S.timer = setTimeout(step, STEP_MS);
      }
    };
    step();
  }

  function reset() {
    clearTimeout(S.timer);
    S.running = false;
    S.left = {};
    S.removed = {};
    LEFT_AT_START.forEach(function (name) { S.left[name] = true; });
    btnRun.disabled = false;
    renderPeople();
    renderServers();
    hint();
  }

  btnRun.addEventListener('click', run);
  btnReset.addEventListener('click', reset);
  buildPeople();
  reset();
})();
