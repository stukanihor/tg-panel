/* ════════════════════════════════════════════════════════════════════
   Архив документов — логика мини-приложения.

   Адрес веб-приложения Apps Script. Если создашь НОВОЕ развёртывание
   вместо новой версии — адрес сменится, поменяй его здесь.
   ════════════════════════════════════════════════════════════════════ */
var API = 'https://script.google.com/macros/s/AKfycbxUus4MoPjOp_6R30VUspQyZNeRUPs2yGFN9PnvP8SQY2IfEjbU4QnOxGlcpQETy8XQ/exec';

var tg     = window.Telegram ? window.Telegram.WebApp : null;
var rows   = [];
var OWNERS = [];
var CATS   = {};
var draft  = null;     // загруженный документ, ждущий подтверждения
var filter = '';       // выбранная плитка на экране «Сроки»

var TITLES = {
  deadlines: ['Сроки',    'Что просрочено и что скоро истекает'],
  archive:   ['Архив',    'Все документы и поиск по ним'],
  ask:       ['Вопрос',   'Отвечаю по реестру и самим документам'],
  add:       ['Добавить', 'Распознаю скан и разложу по папкам']
};

var HINTS = [
  'за сколько предупреждать о выезде',
  'какой залог за квартиру',
  'что входит в страховку',
  'когда истекает Aufenthaltstitel'
];

/* Иконка по названию папки. */
function catIcon(cat){
  var c = String(cat || '');
  if (/Личные/i.test(c))        return 'i-id';
  if (/Германия/i.test(c))      return 'i-shield';
  if (/Медицина/i.test(c))      return 'i-heart';
  if (/Финанс|налог/i.test(c))  return 'i-euro';
  if (/Работа|образов/i.test(c))return 'i-case';
  if (/Авто|Права/i.test(c))    return 'i-car';
  if (/Жиль/i.test(c))          return 'i-home';
  if (/Страхов/i.test(c))       return 'i-umbrella';
  if (/Брак|семья/i.test(c))    return 'i-users';
  if (/Jobcenter|пособи/i.test(c)) return 'i-bank';
  return 'i-doc';
}

function icon(id, cls){
  return '<span class="ic ' + (cls || '') + '"><svg viewBox="0 0 24 24"><use href="#' +
         id + '"/></svg></span>';
}
function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function el(id){ return document.getElementById(id); }
function initData(){ return (tg && tg.initData) ? tg.initData : ''; }
function tap(style){
  if (tg && tg.HapticFeedback) {
    try { tg.HapticFeedback.impactOccurred(style || 'light'); } catch (e) {}
  }
}

if (tg) {
  tg.ready();
  tg.expand();
  try { tg.setHeaderColor('secondary_bg_color'); } catch (e) {}
}

/* ── связь с Apps Script ────────────────────────────────────── */
function callApi(params){
  return fetch(API, { method: 'POST', body: JSON.stringify(params) })
    .then(function(r){ return r.json(); })
    .catch(function(){
      // Запасной путь для лёгких запросов: файл так не отправить.
      if (params.files) throw new Error('не удалось отправить файл на сервер');
      var qs = Object.keys(params)
        .filter(function(k){ return typeof params[k] !== 'object'; })
        .map(function(k){ return k + '=' + encodeURIComponent(params[k]); })
        .join('&');
      return jsonp(qs);
    });
}

var seq = 0;
function jsonp(qs){
  return new Promise(function(resolve, reject){
    var name = '__cb' + (++seq) + '_' + Date.now();
    var s    = document.createElement('script');
    var done = false;
    window[name] = function(d){ done = true; resolve(d); delete window[name]; s.remove(); };
    s.onerror = function(){ if (!done) { reject(new Error('сервер недоступен')); s.remove(); } };
    s.src = API + '?' + qs + '&callback=' + name;
    document.body.appendChild(s);
    setTimeout(function(){ if (!done) reject(new Error('сервер не ответил за 90 секунд')); }, 90000);
  });
}

/* ── загрузка данных ────────────────────────────────────── */
function boot(){
  if (!initData()) {
    el('subtitle').textContent = '';
    el('deadlines').innerHTML =
      '<div class="state">Открой приложение из Telegram — кнопкой «Архив» ' +
      'рядом со скрепкой.<br>По прямой ссылке оно не работает намеренно.</div>';
    return;
  }

  el('deadlines').innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';

  callApi({ api: 'bootstrap', init: initData() })
    .then(function(res){
      if (!res || !res.ok) {
        el('subtitle').textContent = '';
        el('deadlines').innerHTML =
          '<div class="state">Не получилось: ' + esc(res && res.error || 'нет ответа') + '</div>';
        return;
      }
      rows   = res.rows   || [];
      OWNERS = res.owners || [];
      CATS   = res.cats   || {};
      drawDeadlines();
      drawList('');
      updateHead('deadlines');
    })
    .catch(function(e){
      el('deadlines').innerHTML = '<div class="state">Ошибка связи: ' + esc(e.message || e) + '</div>';
    });
}

function bucket(r){
  if (r.days === null || !r.until) return 'ok';
  if (r.days < 0)   return 'over';
  if (r.days <= 60) return 'soon';
  return 'ok';
}
function counts(){
  var c = { over: 0, soon: 0, ok: 0 };
  rows.forEach(function(r){ c[bucket(r)]++; });
  return c;
}

/* ── экран «Сроки» ───────────────────────────────────────── */
function drawDeadlines(){
  var c = counts();

  el('stats').innerHTML =
    '<div class="stats">' +
      statTile('over',  c.over, 'Просрочено', 'red') +
      statTile('soon',  c.soon, 'Скоро',      'amber') +
      statTile('ok',    c.ok,   'В порядке',  'green') +
    '</div>';

  Array.prototype.forEach.call(document.querySelectorAll('.stat'), function(t){
    t.onclick = function(){
      tap();
      filter = (filter === t.getAttribute('data-k')) ? '' : t.getAttribute('data-k');
      drawDeadlines();
    };
  });

  var over = rows.filter(function(r){ return bucket(r) === 'over'; })
                 .sort(function(a,b){ return a.days - b.days; });
  var soon = rows.filter(function(r){ return bucket(r) === 'soon'; })
                 .sort(function(a,b){ return a.days - b.days; });
  var rest = rows.filter(function(r){ return bucket(r) === 'ok'; });

  var h = '';
  if (!rows.length) {
    h = '<div class="state">В архиве пока пусто.<br>Добавь первый документ.</div>';
  } else {
    if ((!filter || filter === 'over') && over.length) h += section('Просрочено', over, 'red');
    if ((!filter || filter === 'soon') && soon.length) h += section('Истекает в ближайшие 60 дней', soon, 'amber');
    if ((!filter || filter === 'ok')   && rest.length) h += section('В порядке', rest, 'green');
    if (!h) h = '<div class="state">В этой группе пусто.</div>';
  }

  el('deadlines').innerHTML = h;
  bindCards();
}

function statTile(key, n, label, color){
  return '<div class="stat ' + color + (filter === key ? ' sel' : '') + '" data-k="' + key + '">' +
           '<div class="n">' + n + '</div><div class="l">' + label + '</div></div>';
}

function section(title, list, color){
  var h = '<div class="group"><h2>' + esc(title) + '</h2>';
  list.forEach(function(r, n){ h += cardHtml(r, color, n); });
  return h + '</div>';
}

function cardHtml(r, color, n){
  var i = rows.indexOf(r);
  var badge = '';
  if (r.days !== null && r.until) {
    if (r.days < 0)        badge = '<span class="badge red">' + Math.abs(r.days) + ' дн. назад</span>';
    else if (r.days <= 60) badge = '<span class="badge amber">' + r.days + ' дн.</span>';
  }
  var sub = r.owner + ' · ' + r.cat.replace(/^[\d.]+\s*/, '');
  if (r.until) sub += ' · до ' + r.until;

  return '<div class="card" data-i="' + i + '" style="animation-delay:' +
           Math.min(n * 28, 240) + 'ms">' +
           icon(catIcon(r.cat), color || '') +
           '<div class="body"><div class="t">' + esc(r.name) + '</div>' +
           '<div class="s">' + esc(sub) + '</div></div>' +
           (badge || '<span class="chev"><svg viewBox="0 0 24 24"><use href="#i-chev"/></svg></span>') +
         '</div>';
}

/* ── экран «Архив» ───────────────────────────────────────── */
function drawList(query){
  var q = String(query || '').trim().toLowerCase();
  var hit = rows.filter(function(r){
    if (!q) return true;
    return (r.name + ' ' + r.org + ' ' + r.number + ' ' + r.cat + ' ' +
            r.owner + ' ' + r.note).toLowerCase().indexOf(q) !== -1;
  });

  if (!hit.length) {
    el('list').innerHTML = '<div class="state">Ничего не нашлось.</div>';
    return;
  }

  var by = {};
  hit.forEach(function(r){ (by[r.owner] = by[r.owner] || []).push(r); });

  var h = '', n = 0;
  Object.keys(by).sort().forEach(function(owner){
    h += '<div class="group"><h2>' + esc(owner) + ' · ' + by[owner].length + '</h2>';
    by[owner].forEach(function(r){ h += cardHtml(r, '', n++); });
    h += '</div>';
  });

  el('list').innerHTML = h;
  bindCards();
}

/* ── карточка документа ──────────────────────────────────── */
function bindCards(){
  Array.prototype.forEach.call(document.querySelectorAll('.card'), function(c){
    c.onclick = function(){ tap(); openSheet(rows[Number(c.getAttribute('data-i'))]); };
  });
}

function kv(k, v){
  if (!v) return '';
  return '<div class="kv"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';
}

function openSheet(r){
  if (!r) return;

  var state = bucket(r);
  var sub = state === 'over' ? 'Просрочен ' + Math.abs(r.days) + ' дн. назад'
          : state === 'soon' ? 'Истекает через ' + r.days + ' дн.'
          : (r.until ? 'Действует до ' + r.until : 'Бессрочный');

  el('sheet').innerHTML =
    '<div class="grab"></div>' +
    '<h3>' + esc(r.name) + '</h3>' +
    '<div class="sub">' + esc(sub) + '</div>' +
    kv('Кому', r.owner) +
    kv('Папка', r.cat) +
    kv('Организация', r.org) +
    kv('Номер', r.number) +
    kv('Выдан', r.issued) +
    (r.note ? '<div class="memo">' + esc(r.note) + '</div>' : '') +
    (r.link ? '<a class="act" href="' + esc(r.link) + '" target="_blank">' +
              '<svg viewBox="0 0 24 24"><use href="#i-link"/></svg>Открыть файл</a>' : '');

  el('scrim').classList.add('on');
  document.body.classList.add('sheet-open');
  if (tg && tg.BackButton) { tg.BackButton.show(); }
}

function closeSheet(){
  el('scrim').classList.remove('on');
  document.body.classList.remove('sheet-open');
  if (tg && tg.BackButton) tg.BackButton.hide();
}

el('scrim').onclick = function(ev){ if (ev.target.id === 'scrim') closeSheet(); };
if (tg && tg.BackButton) tg.BackButton.onClick(closeSheet);

/* ── экран «Вопрос» ──────────────────────────────────────── */
el('chips').innerHTML = HINTS.map(function(t){
  return '<span class="chip">' + esc(t) + '</span>';
}).join('');

Array.prototype.forEach.call(document.querySelectorAll('.chip'), function(c){
  c.onclick = function(){ el('question').value = c.textContent; ask(); };
});

function ask(){
  var q = el('question').value.trim();
  if (!q) return;
  tap();

  el('send').disabled = true;
  el('thread').innerHTML =
    '<div class="bubble">' + esc(q) + '</div>' +
    '<div class="reply"><span class="ring" style="width:18px;height:18px;border-width:2px;' +
    'display:inline-block;vertical-align:-3px;margin:0 8px 0 0"></span>Смотрю архив…</div>';

  callApi({ api: 'ask', init: initData(), q: q })
    .then(function(res){
      el('send').disabled = false;
      var text = (res && res.ok) ? res.answer
               : 'Не получилось: ' + (res && res.error || 'нет ответа');
      el('thread').innerHTML =
        '<div class="bubble">' + esc(q) + '</div>' +
        '<div class="reply">' + esc(text) + '</div>';
      tap('soft');
    })
    .catch(function(e){
      el('send').disabled = false;
      el('thread').innerHTML =
        '<div class="bubble">' + esc(q) + '</div>' +
        '<div class="reply">Ошибка связи: ' + esc(e.message || e) + '</div>';
    });
}
el('send').onclick = ask;
el('q').oninput = function(){ drawList(this.value); };

/* ── экран «Добавить» ──────────────────────────────────── */
function resetAdd(){
  draft = null;
  el('addStart').hidden = false;
  el('addBody').innerHTML = '';
  el('file').value = '';
}

function readFile(f){
  return new Promise(function(resolve, reject){
    var fr = new FileReader();
    fr.onload  = function(){ resolve({ name: f.name, mime: f.type,
                                       data: String(fr.result).split(',')[1] }); };
    fr.onerror = function(){ reject(new Error('не смог прочитать ' + f.name)); };
    fr.readAsDataURL(f);
  });
}

el('file').onchange = function(){
  var picked = Array.prototype.slice.call(this.files || []).slice(0, 6);
  if (!picked.length) return;

  var heavy = picked.filter(function(f){ return f.size > 8 * 1024 * 1024; });
  if (heavy.length) {
    alert('Слишком тяжёлый файл: ' + heavy[0].name + ' (' +
          (heavy[0].size / 1024 / 1024).toFixed(1) + ' МБ). Предел 8 МБ.');
    this.value = '';
    return;
  }

  tap('medium');
  el('addStart').hidden = true;
  el('addBody').innerHTML =
    '<div class="state"><div class="ring"></div>Читаю документ…<br>До полуминуты.</div>';

  Promise.all(picked.map(readFile))
    .then(function(files){ return callApi({ api: 'upload', init: initData(), files: files }); })
    .then(function(res){
      if (!res || !res.ok) return fail(res && res.error || 'нет ответа');
      draft = res.doc || {};
      draft.fileId = res.fileId;
      drawForm(res.note || '');
      tap('soft');
    })
    .catch(function(e){ fail(e.message || e); });
};

function fail(msg){
  el('addBody').innerHTML =
    '<div class="notice bad">' + esc(msg) + '</div>' +
    '<button class="btn ghost" onclick="resetAdd()">Назад</button>';
}

function field(id, label, value, type){
  return '<div class="field"><label>' + esc(label) + '</label>' +
    '<input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(value || '') + '"></div>';
}

function picker(id, label, opts, chosen){
  var h = '<div class="field"><label>' + esc(label) + '</label><div class="selwrap">' +
          '<select id="' + id + '"><option value="">— не выбрано —</option>';
  opts.forEach(function(o){
    h += '<option value="' + esc(o.v) + '"' + (o.v === chosen ? ' selected' : '') + '>' +
         esc(o.t) + '</option>';
  });
  return h + '</select><svg viewBox="0 0 24 24"><use href="#i-down"/></svg></div></div>';
}

function drawForm(note){
  var owners = OWNERS.map(function(o){ return { v: o.key, t: o.label }; });
  var cats   = (CATS[draft.owner] || []).map(function(c){ return { v: c.key, t: c.label }; });

  el('addBody').innerHTML =
    (note ? '<div class="notice">' + esc(note) + '</div>' : '') +
    field('f_name', 'Название документа', draft.name) +
    picker('f_owner', 'Кому принадлежит', owners, draft.owner) +
    picker('f_cat',   'Папка',            cats,   draft.cat) +
    field('f_org',    'Организация',      draft.org) +
    field('f_num',    'Номер',            draft.number) +
    '<div class="two">' +
      field('f_issue',  'Дата выдачи',  draft.issue,  'date') +
      field('f_expiry', 'Действует до', draft.expiry, 'date') +
    '</div>' +
    '<div class="field"><label>Заметка</label><textarea id="f_note">' +
      esc(draft.note || '') + '</textarea></div>' +
    '<button class="btn primary" id="f_save">Сохранить в архив</button>' +
    '<button class="btn danger" id="f_cancel">Отменить и удалить файл</button>';

  el('f_owner').onchange = function(){ collect(); draft.cat = ''; drawForm(note); };
  el('f_save').onclick   = function(){ save(false, false); };
  el('f_cancel').onclick = cancelDraft;
}

function collect(){
  function v(id){ var e = el(id); return e ? e.value.trim() : ''; }
  draft.name = v('f_name');   draft.owner  = v('f_owner');
  draft.cat  = v('f_cat');    draft.org    = v('f_org');
  draft.number = v('f_num');  draft.issue  = v('f_issue');
  draft.expiry = v('f_expiry'); draft.note = v('f_note');
}

function save(replace, keepBoth){
  collect();
  if (!draft.owner || !draft.cat) {
    alert('Выбери, кому принадлежит документ и в какую папку его положить.');
    return;
  }
  tap();

  var doc = JSON.parse(JSON.stringify(draft));
  doc.replace  = !!replace;
  doc.keepBoth = !!keepBoth;

  el('addBody').innerHTML =
    '<div class="state"><div class="ring"></div>Сохраняю в Drive и пишу в реестр…</div>';

  callApi({ api: 'save', init: initData(), doc: doc })
    .then(function(res){
      if (res && res.duplicate) return drawDup(res.duplicate);
      if (!res || !res.ok) return fail(res && res.error || 'нет ответа');

      el('addBody').innerHTML =
        '<div class="notice good"><b>Сохранено</b><br>' + esc(res.title) + '<br>' +
        esc(res.where) + '</div>' +
        '<a class="act" href="' + esc(res.url) + '" target="_blank">' +
        '<svg viewBox="0 0 24 24"><use href="#i-link"/></svg>Открыть файл</a>' +
        '<button class="btn ghost" onclick="resetAdd()">Добавить ещё</button>';
      tap('medium');
      boot();
    })
    .catch(function(e){ fail(e.message || e); });
}

function drawDup(dup){
  el('addBody').innerHTML =
    '<div class="notice"><b>Похоже, такой документ уже есть</b> — ' + esc(dup.why) + '.<br><br>' +
      'В архиве: ' + esc(dup.name) + (dup.issued ? ', выдан ' + esc(dup.issued) : '') + '<br>' +
      'Новый: ' + esc(draft.name || 'без названия') +
      (draft.issue ? ', выдан ' + esc(draft.issue) : '') + '</div>' +
    '<button class="btn primary" id="d_rep">Заменить старый</button>' +
    '<button class="btn ghost" id="d_both">Оставить оба</button>' +
    '<button class="btn danger" id="d_no">Отменить</button>';

  el('d_rep').onclick  = function(){ save(true, false); };
  el('d_both').onclick = function(){ save(false, true); };
  el('d_no').onclick   = cancelDraft;
}

function cancelDraft(){
  var id = draft && draft.fileId;
  resetAdd();
  if (id) callApi({ api: 'discard', init: initData(), fileId: id });
}

/* ── навигация ───────────────────────────────────────────── */
function updateHead(name){
  var t = TITLES[name];
  el('title').textContent = t[0];

  if (name === 'deadlines' && rows.length) {
    var c = counts();
    el('subtitle').textContent = c.over
      ? 'Требуют внимания: ' + c.over
      : (c.soon ? 'Скоро истекает: ' + c.soon : 'Всё в порядке, ' + rows.length + ' документов');
  } else if (name === 'archive' && rows.length) {
    el('subtitle').textContent = rows.length + ' документов в архиве';
  } else {
    el('subtitle').textContent = t[1];
  }
}

Array.prototype.forEach.call(document.querySelectorAll('nav button'), function(b){
  b.onclick = function(){
    tap();
    var name = b.getAttribute('data-s');
    Array.prototype.forEach.call(document.querySelectorAll('nav button'), function(x){
      x.classList.toggle('on', x === b);
    });
    ['deadlines','archive','ask','add'].forEach(function(n){
      el('s-' + n).classList.toggle('on', n === name);
    });
    updateHead(name);
    window.scrollTo(0, 0);
  };
});

boot();
