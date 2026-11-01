/* ════════════════════════════════════════════════════════════════
   Загрузка пачкой. Отдельный файл, чтобы app.js не раздувался.
   Подключается ПОСЛЕ app.js — пользуется его функциями и данными.
   ════════════════════════════════════════════════════════════════ */
/* ── загрузка пачкой ──
   Файлы гоняем по одному: одним запросом десять файлов не улезут
   ни в предел на размер, ни в предел на время работы скрипта. */
var BULK_MAX = 10;
var bulk = null;

// Без проверки старый index.html из кэша браузера уронит весь скрипт.
if (el('bulk')) el('bulk').onchange = function(){
  var picked = Array.prototype.slice.call(this.files || []).slice(0, BULK_MAX);
  this.value = '';
  if (!picked.length) return;

  var heavy = picked.filter(function(f){ return f.size > 8 * 1024 * 1024; });
  if (heavy.length) {
    alert('Слишком тяжёлый файл: ' + heavy[0].name + ' (' +
          (heavy[0].size / 1024 / 1024).toFixed(1) + ' МБ). Предел 8 МБ на файл.');
    return;
  }

  tap('medium');
  el('addStart').hidden = true;
  bulk = { items: [] };
  bulkRun(picked, 0);
};

function bulkRun(files, i){
  if (i >= files.length) { tap('soft'); return drawBulk(); }

  el('addBody').innerHTML =
    '<div class="state"><div class="ring"></div>Читаю документы…<br>' +
    (i + 1) + ' из ' + files.length + '</div>' +
    '<div class="bprog"><i style="width:' +
      Math.round(i / files.length * 100) + '%"></i></div>';

  readFile(files[i])
    .then(function(f){ return callApi({ api: 'upload', init: initData(), files: [f] }); })
    .then(function(res){
      if (res && res.ok) {
        var d = res.doc || {};
        d.fileId = res.fileId;
        d.src    = files[i].name;
        d.dup    = res.dup || null;
        // Дубли и недоразобранное по умолчанию выключены.
        d.take   = !d.dup && !!d.owner && !!d.cat;
        bulk.items.push(d);
      } else {
        bulk.items.push({ src: files[i].name, take: false,
                          bad: (res && res.error) || 'нет ответа' });
      }
      bulkRun(files, i + 1);
    })
    .catch(function(e){
      bulk.items.push({ src: files[i].name, take: false, bad: String(e.message || e) });
      bulkRun(files, i + 1);
    });
}

function bulkWhy(d){
  if (d.bad)  return { cls: 'bad',  html: '<div class="e">' + esc(d.bad) + '</div>' };
  if (!d.owner || !d.cat)
    return { cls: 'warn', html: '<div class="w">Не понял, кому и в какую папку — открой и укажи</div>' };
  if (d.dup)
    return { cls: 'warn', html: '<div class="w">Похоже на дубль: ' + esc(d.dup.why) + '</div>' };
  return { cls: '', html: '' };
}

function bulkReady(d){
  return !!(d.take && !d.bad && d.owner && d.cat);
}

function drawBulk(){
  var ok = bulk.items.filter(bulkReady).length;

  var h = '<div class="notice">Разобрал ' + bulk.items.length + '. Проверь список: ' +
          'галочка — сохранить, нажатие на строку — поправить.</div>';

  bulk.items.forEach(function(d, i){
    var w   = bulkWhy(d);
    var sub = (d.owner && d.cat)
      ? (ownerOf(d.owner) ? ownerOf(d.owner).label : d.owner) + ' · ' +
        (catOf(d.owner, d.cat) ? catOf(d.owner, d.cat).label : d.cat)
      : esc(d.src || '');

    h += '<div class="brow ' + w.cls + (d.take ? '' : ' off') + '" data-b="' + i + '">' +
         '<button class="btick" data-tick="' + i + '" aria-label="Сохранять">' +
           '<svg viewBox="0 0 24 24"><use href="#i-check"/></svg></button>' +
         '<div class="bbody" data-open="' + i + '">' +
           '<div class="t">' + esc(d.name || d.src || 'Без названия') + '</div>' +
           '<div class="s">' + esc(sub) + '</div>' + w.html +
         '</div></div>';
  });

  h += '<button class="btn primary" id="b_save"' + (ok ? '' : ' disabled') + '>' +
       'Сохранить отмеченные (' + ok + ')</button>' +
       '<button class="btn danger" id="b_no">Отменить всё</button>';

  el('addBody').innerHTML = h;

  Array.prototype.forEach.call(document.querySelectorAll('.btick'), function(b){
    b.onclick = function(){
      var d = bulk.items[Number(b.getAttribute('data-tick'))];
      if (d.bad) { say('Этот файл не разобрался — сохранить нечего.'); return; }
      tap();
      d.take = !d.take;
      drawBulk();
    };
  });

  Array.prototype.forEach.call(document.querySelectorAll('.bbody'), function(b){
    b.onclick = function(){ tap(); bulkEdit(Number(b.getAttribute('data-open'))); };
  });

  el('b_save').onclick = bulkSave;
  el('b_no').onclick   = function(){
    tap('medium');
    bulk.items.forEach(function(d){
      if (d.fileId) callApi({ api: 'discard', init: initData(), fileId: d.fileId });
    });
    bulk = null;
    resetAdd();
  };
}

/* Правка одной строки — те же поля, что и при обычной загрузке. */
function bulkEdit(i, pickedOwner){
  var d = bulk.items[i];
  if (!d || d.bad) return;

  var ow = pickedOwner !== undefined ? pickedOwner : d.owner;

  el('addBody').innerHTML =
    '<div class="notice">Файл: ' + esc(d.src || '') + '</div>' +
    (d.dup ? '<div class="notice"><b>Похоже на дубль</b> — ' + esc(d.dup.why) +
             '.<br>В архиве: ' + esc(d.dup.name) +
             (d.dup.issued ? ', выдан ' + esc(d.dup.issued) : '') + '</div>' : '') +
    field('b_name', 'Название документа', d.name) +
    picker('b_owner', 'Кому принадлежит', ownerOpts(), ow) +
    picker('b_cat',   'Папка', catOpts(ow), ow === d.owner ? d.cat : '') +
    field('b_org',    'Организация', d.org) +
    field('b_num',    'Номер',       d.number) +
    '<div class="two">' +
      field('b_issue',  'Дата выдачи',  d.issue,  'date') +
      field('b_expiry', 'Действует до', d.expiry, 'date') +
    '</div>' +
    '<div class="field"><label>Заметка</label><textarea id="b_note">' +
      esc(d.note || '') + '</textarea></div>' +
    '<button class="btn primary" id="b_ok">Готово</button>';

  el('b_owner').onchange = function(){ bulkGrab(i); bulkEdit(i, this.value); };
  el('b_ok').onclick = function(){
    bulkGrab(i);
    if (!d.name) { say('Впиши название.'); return; }
    tap();
    if (d.owner && d.cat) d.take = true;   // починил — значит сохраняем
    drawBulk();
  };
}

function bulkGrab(i){
  var d = bulk.items[i];
  function v(id){ var e = el(id); return e ? e.value.trim() : ''; }
  d.name   = v('b_name');   d.owner  = v('b_owner');
  d.cat    = v('b_cat');    d.org    = v('b_org');
  d.number = v('b_num');    d.issue  = v('b_issue');
  d.expiry = v('b_expiry'); d.note   = v('b_note');
}

function bulkSave(){
  var todo = bulk.items.filter(bulkReady);
  var skip = bulk.items.filter(function(d){ return !bulkReady(d); });
  if (!todo.length) return;

  tap('medium');
  var done = [], failed = [];

  (function next(i){
    if (i >= todo.length) {
      // Что не сохраняем — убираем из «Входящих», чтобы не копились.
      skip.forEach(function(d){
        if (d.fileId) callApi({ api: 'discard', init: initData(), fileId: d.fileId });
      });
      return drawBulkDone(done, failed, skip.length);
    }

    el('addBody').innerHTML =
      '<div class="state"><div class="ring"></div>Сохраняю…<br>' +
      (i + 1) + ' из ' + todo.length + '</div>' +
      '<div class="bprog"><i style="width:' +
        Math.round(i / todo.length * 100) + '%"></i></div>';

    var d   = todo[i];
    var doc = JSON.parse(JSON.stringify(d));
    doc.keepBoth = true;   // про дубли уже спросили в списке

    callApi({ api: 'save', init: initData(), doc: doc })
      .then(function(res){
        if (res && res.ok) done.push(res.title || d.name);
        else failed.push((d.name || d.src) + ' — ' + ((res && res.error) || 'нет ответа'));
        next(i + 1);
      })
      .catch(function(e){
        failed.push((d.name || d.src) + ' — ' + String(e.message || e));
        next(i + 1);
      });
  })(0);
}

function drawBulkDone(done, failed, skipped){
  var h = '<div class="notice good"><b>Сохранено: ' + done.length + '</b>' +
          (skipped ? '<br>Пропущено: ' + skipped : '') + '</div>';

  if (failed.length) {
    h += '<div class="notice bad"><b>Не сохранилось: ' + failed.length + '</b><br>' +
         failed.map(esc).join('<br>') + '</div>';
  }

  h += '<button class="btn ghost" onclick="resetAdd()">Добавить ещё</button>';

  bulk = null;
  el('addBody').innerHTML = h;
  tap('medium');
  boot();
}
