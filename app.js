/* ════════════════════════════════════════════════════════════════
   Архив документов — логика мини-приложения.

   Адрес веб-приложения Apps Script. Если создашь НОВОЕ развёртывание
   вместо новой версии — адрес сменится, поменяй его здесь.
   ════════════════════════════════════════════════════════════════ */
var API = 'https://script.google.com/macros/s/AKfycbx5ymhDr9J4GTxZWDbGD0E96kM6Dcn6TSnaNAv8eOgechELqIplWS8Mjscw5nSfFbW7/exec';

var tg     = window.Telegram ? window.Telegram.WebApp : null;
var rows   = [];
var trash  = [];     // удалённое: лежит в «99_Архив», можно вернуть
var OWNERS = [];
var CATS   = {};
var draft  = null;     // загруженный документ, ждущий подтверждения
var filter = '';       // выбранная плитка на экране «Сроки»
var shown  = null;     // документ, открытый в карточке
var previews = {};     // кэш превью по ссылке на файл
var shareOpen = false; // у открытого документа включён доступ по ссылке
var navOwner  = null;  // раскрытый владелец в «Архиве»
var navCat    = null;  // раскрытая папка

var VIEWS = ['grid', 'list', 'compact'];
var view  = 'grid';
try { if (VIEWS.indexOf(localStorage.getItem('view')) >= 0) view = localStorage.getItem('view'); }
catch (e) {}

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

/* Иконка по ключу папки — по последней цифре категории. */
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

/* Высота окна в Telegram не равна window.innerHeight: часть кадра уходит
   под панель приложения. Без этого низ страницы оказывается за экраном. */
function fitViewport(){
  var h = (tg && tg.viewportStableHeight) ? tg.viewportStableHeight
        : (tg && tg.viewportHeight)       ? tg.viewportHeight
        : window.innerHeight;
  if (h > 0) document.documentElement.style.setProperty('--vh', h + 'px');
}
fitViewport();
if (tg && tg.onEvent) {
  try { tg.onEvent('viewportChanged', fitViewport); } catch (e) {}
}
window.addEventListener('resize', fitViewport);
window.addEventListener('orientationchange', function(){ setTimeout(fitViewport, 250); });

/* ── связь с Apps Script ── */
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

/* ── загрузка данных ── */
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
      trash  = res.trash  || [];
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

/* ── экран «Сроки» ── */
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
  loadThumbs();
}

function statTile(key, n, label, color){
  return '<div class="stat ' + color + (filter === key ? ' sel' : '') + '" data-k="' + key + '">' +
           '<div class="n">' + n + '</div><div class="l">' + label + '</div></div>';
}

function section(title, list, color){
  var h = '<div class="group"><h2>' + esc(title) + '</h2>';
  list.forEach(function(r, n){
    h += cardHtml(r, color, n);
  });
  return h + '</div>';
}

function cardHtml(r, color, n, showPath){
  var i = rows.indexOf(r);
  var badge = badgeHtml(r);

  var sub = subFor(r, showPath);
  if (r.until && !r.ever) sub += ' · до ' + fmtDay(r.until);

  return '<div class="card" data-i="' + i + '" style="animation-delay:' +
           Math.min(n * 28, 240) + 'ms">' +
           shotHtml(r, color) +
           '<div class="body"><div class="t">' + esc(r.name) + '</div>' +
           '<div class="s">' + esc(sub) + '</div></div>' +
           (r.fav ? '<span class="star"><svg viewBox="0 0 24 24"><use href="#i-star"/></svg></span>' : '') +
           (badge || '<span class="chev"><svg viewBox="0 0 24 24"><use href="#i-chev"/></svg></span>') +
         '</div>';
}

/* ── экран «Архив»: владелец → папка → документы ── */
function ownerOf(key){
  for (var i = 0; i < OWNERS.length; i++) if (OWNERS[i].key === key) return OWNERS[i];
  return null;
}
function catOf(ownerKey, catKey){
  var l = CATS[ownerKey] || [];
  for (var i = 0; i < l.length; i++) if (l[i].key === catKey) return l[i];
  return null;
}
function docsIn(ownerLabel, catLabel){
  return rows.filter(function(r){
    return r.owner === ownerLabel && (catLabel === null || r.cat === catLabel);
  });
}
/* Названия владельцев и папок начинаются с номера — он задаёт
   порядок на Drive, а на экране только мешает. */
function bare(s){
  return String(s == null ? '' : s).replace(/^\d+(?:\.\d+)*[.)]?\s+/, '');
}

/* В реестре даты лежат в машинном виде. На экране привычнее так,
   как они написаны на самих документах. */
function fmtDay(v){
  var m = String(v == null ? '' : v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? m[3] + '.' + m[2] + '.' + m[1] : String(v == null ? '' : v);
}

function plural(n){
  var t = n % 10, h = n % 100;
  var w = (t === 1 && h !== 11) ? 'документ'
        : (t >= 2 && t <= 4 && (h < 12 || h > 14)) ? 'документа' : 'документов';
  return n + ' ' + w;
}

function drawList(query){
  var q = String(query || '').trim().toLowerCase();

  el('crumbs').innerHTML = crumbHtml(q);
  bindCrumbs();

  var h = '', docs = false;

  if (q) {
    var hit = rows.filter(function(r){
      return (r.name + ' ' + r.org + ' ' + r.number + ' ' + r.cat + ' ' +
              r.owner + ' ' + r.note).toLowerCase().indexOf(q) !== -1;
    });
    h = hit.length ? docsHtml(hit, true) : '<div class="state">Ничего не нашлось.</div>';
    docs = true;
  } else if (!navOwner) {
    h = rootSeg() + favHtml() + (rootAll ? byOwnerHtml() : ownersHtml());
    docs = rootAll;
  } else if (!navCat) {
    h = foldersHtml(navOwner);
  } else if (navCat === LOSTCAT) {
    var lost = lostDocs(navOwner);
    h = lost.length ? docsHtml(lost, false)
                    : '<div class="state">Здесь пусто.</div>';
    docs = true;
  } else {
    var o = ownerOf(navOwner), c = catOf(navOwner, navCat);
    var list = (o && c) ? docsIn(o.label, c.label) : [];
    h = list.length ? docsHtml(list, false)
                    : '<div class="state">В этой папке пока пусто.</div>';
    docs = true;
  }

  el('views').hidden = !docs;
  el('list').innerHTML = h +
    ((q || navOwner) ? '' :
      '<button class="btn ghost" id="zipAll">Скачать архив</button>' + trashHtml());

  bindCards();
  bindTrash();
  bindFolders();
  loadThumbs();
  if (el('s-archive').classList.contains('on')) updateHead('archive');
  syncBack();
}

/* ── хлебные крошки ── */
function crumbHtml(q){
  if (q) return '<span class="cr">Поиск по всему архиву</span>';

  var h = '<span class="cr' + (navOwner ? ' lnk' : '') + '" data-lv="0">Архив</span>';
  if (navOwner) {
    var o = ownerOf(navOwner);
    h += '<svg class="crsep" viewBox="0 0 24 24"><use href="#i-chev"/></svg>' +
         '<span class="cr' + (navCat ? ' lnk' : '') + '" data-lv="1">' +
         esc(o ? o.label : '') + '</span>';
  }
  if (navCat) {
    var c = navCat === LOSTCAT ? { label: 'Без папки' } : catOf(navOwner, navCat);
    h += '<svg class="crsep" viewBox="0 0 24 24"><use href="#i-chev"/></svg>' +
         '<span class="cr">' + esc(c ? c.label : '') + '</span>';
  }
  return h;
}

function bindCrumbs(){
  Array.prototype.forEach.call(document.querySelectorAll('.cr.lnk'), function(c){
    c.onclick = function(){
      tap();
      if (c.getAttribute('data-lv') === '0') { navOwner = null; navCat = null; }
      else navCat = null;
      drawList(el('q').value);
    };
  });
}

/* ── уровень 1: владельцы ──
   Два вида на выбор. Папками — когда ищешь по смыслу и знаешь, где
   лежит. Списком — когда хочешь увидеть всё, что есть у человека, и
   не помнишь, в какой папке оно оказалось. Выбор запоминается. */
var rootAll = false;
try { rootAll = localStorage.getItem('root') === 'all'; } catch (e) {}

function rootSeg(){
  return '<div class="seg wide" id="rootseg">' +
    '<b class="' + (rootAll ? '' : 'on') + '" data-r="0">Папки</b>' +
    '<b class="' + (rootAll ? 'on' : '') + '" data-r="1">Все документы</b>' +
  '</div>';
}

function byOwnerHtml(){
  var h = '';
  OWNERS.forEach(function(o, i){
    var list = docsIn(o.label, null);
    if (!list.length) return;
    h += '<div class="group"><h2 class="owh">' +
         '<span class="av a' + (i % 4) + '">' + esc(bare(o.label).charAt(0)) + '</span>' +
         esc(bare(o.label)) + ' · ' + plural(list.length) + '</h2>' +
         docsHtml(list, 'cat') + '</div>';
  });
  return h || '<div class="state">В архиве пока пусто.</div>';
}


function favHtml(){
  var list = rows.filter(function(r){ return r.fav; });
  if (!list.length) return '';

  var h = '<div class="group"><h2><svg viewBox="0 0 24 24"><use href="#i-star"/></svg>' +
          'Избранное · ' + list.length + '</h2>';
  list.forEach(function(r, n){ h += cardHtml(r, 'amber', n, true); });
  return h + '</div>';
}

/* Документы, чья папка в реестре не совпала ни с одной настоящей папкой.
   Без этого они пропадают из навигации, хотя в счётчике владельца видны. */
var LOSTCAT = '__lost__';

function lostDocs(ownerKey){
  var o = ownerOf(ownerKey);
  if (!o) return [];
  var known = {};
  (CATS[ownerKey] || []).forEach(function(c){ known[c.label] = 1; });
  return docsIn(o.label, null).filter(function(r){ return !known[r.cat]; });
}

function ownersHtml(){
  var h = '<div class="group">';
  OWNERS.forEach(function(o, i){
    var n = docsIn(o.label, null).length;
    var f = (CATS[o.key] || []).length;
    h += '<div class="card nav own" data-o="' + esc(o.key) + '" style="animation-delay:' +
         Math.min(i * 30, 200) + 'ms">' +
         '<span class="av a' + (i % 4) + '">' + esc(bare(o.label).charAt(0)) + '</span>' +
         '<div class="body"><div class="t">' + esc(bare(o.label)) + '</div>' +
         '<div class="s">' + f + ' папок · ' + plural(n) + '</div></div>' +
         '<button class="dots" data-mo="' + esc(o.key) + '" aria-label="Переименовать">' +
         '<svg viewBox="0 0 24 24"><use href="#i-dots"/></svg></button></div>';
  });
  return h + '</div>';
}

/* ── уровень 2: папки владельца ── */
function foldersHtml(ok){
  var o = ownerOf(ok);
  if (!o) return '';

  var list = CATS[ok] || [];
  var h = '<div class="group">';

  list.forEach(function(c, i){
    var n = docsIn(o.label, c.label).length;
    h += '<div class="card nav" data-c="' + esc(c.key) + '" style="animation-delay:' +
         Math.min(i * 24, 200) + 'ms">' +
         icon(catIcon(c.label)) +
         '<div class="body"><div class="t">' + esc(c.label) + '</div>' +
         '<div class="s">' + plural(n) + '</div></div>' +
         '<button class="dots" data-m="' + esc(c.key) + '" aria-label="Что сделать с папкой">' +
         '<svg viewBox="0 0 24 24"><use href="#i-dots"/></svg></button></div>';
  });

  var lost = lostDocs(ok);
  if (lost.length) {
    h += '<div class="card nav" data-lost="1">' + icon('i-doc', 'amber') +
         '<div class="body"><div class="t">Без папки</div>' +
         '<div class="s">' + plural(lost.length) + ' · папка не найдена</div></div>' +
         '<span class="chev"><svg viewBox="0 0 24 24"><use href="#i-chev"/></svg></span></div>';
  }

  return h + '</div>' +
    '<div class="tip">Папку можно перетащить выше или ниже — номера ' +
    'пересчитаются сами.</div>' +
    '<button class="btn ghost" id="newFolder">Новая папка</button>';
}

/* ── уровень 3: документы, три вида ── */
function docsHtml(list, showPath){
  if (view === 'grid')    return tilesHtml(list, showPath);
  if (view === 'compact') return compactHtml(list, showPath);

  var h = '<div class="group">';
  list.forEach(function(r, n){ h += cardHtml(r, '', n, showPath); });
  return h + '</div>';
}

/* Что писать под названием документа. Зависит от того, что и так
   видно по месту: внутри папки владелец и папка известны, в списке
   по владельцу известен владелец, в поиске — ничего. */
function subFor(r, mode){
  if (mode === false)  return r.org || 'без организации';
  if (mode === 'cat')  return bare(r.cat) + (r.org ? ' · ' + r.org : '');
  return bare(r.owner) + ' · ' + bare(r.cat);
}

function tilesHtml(list, showPath){
  var h = '<div class="tiles">';
  list.forEach(function(r, n){
    var i = rows.indexOf(r);
    h += '<div class="tile" data-i="' + i + '"' +
         (r.link ? ' data-link="' + esc(r.link) + '"' : '') +
         ' style="animation-delay:' + Math.min(n * 26, 240) + 'ms">' +
         '<div class="shot"' + (r.link ? ' data-th="' + esc(r.link) + '"' : '') + '>' +
           (thumbs[r.link] ? '<img src="' + thumbs[r.link] + '" alt="">' : icon(catIcon(r.cat))) +
         '</div>' +
         '<div class="cap"><div class="t">' + esc(r.name) + '</div>' +
         '<div class="s">' + esc(showPath ? subFor(r, showPath)
              : (r.until && !r.ever ? 'до ' + fmtDay(r.until) : 'бессрочный')) +
         '</div></div>' + badgeHtml(r) + (r.fav ? '<span class="star"><svg viewBox="0 0 24 24"><use href="#i-star"/></svg></span>' : '') + '</div>';
  });
  return h + '</div>';
}

function compactHtml(list, showPath){
  var h = '<div class="rowsbox">';
  list.forEach(function(r, n){
    var i = rows.indexOf(r);
    h += '<div class="line" data-i="' + i + '" style="animation-delay:' +
         Math.min(n * 14, 180) + 'ms">' +
         '<span class="nm">' + esc(r.name) + '</span>' +
         (showPath ? '<span class="pt">' + esc(subFor(r, showPath)) + '</span>' : '') +
         (r.fav ? '<span class="star"><svg viewBox="0 0 24 24"><use href="#i-star"/></svg></span>' : '') + badgeHtml(r) + '</div>';
  });
  return h + '</div>';
}

function badgeHtml(r){
  if (r.days === null || !r.until) return '';
  if (r.days < 0)  return '<span class="badge red">' + Math.abs(r.days) + ' дн. назад</span>';
  if (r.days <= 60) return '<span class="badge amber">' + r.days + ' дн.</span>';
  return '';
}

/* ── миниатюры документов ────────────────────────────────────────
   Раньше превью тянулось по одному на плитку — экран из шести
   собирался несколько секунд. Теперь бот отдаёт их пачкой из своего
   кэша, а здесь они ещё и переживают переходы между экранами. */
var thumbs = {};
try { thumbs = JSON.parse(sessionStorage.getItem('thumbs') || '{}') || {}; }
catch (e) { thumbs = {}; }

function saveThumbs(){
  try { sessionStorage.setItem('thumbs', JSON.stringify(thumbs)); } catch (e) {}
}

/* Место под миниатюру. Пока её нет — значок категории: пустая серая
   рамка на экране выглядит как поломка. */
function shotHtml(r, color){
  if (!r.link) return icon(catIcon(r.cat), color || '');
  var t = thumbs[r.link];
  return '<span class="mini" data-th="' + esc(r.link) + '">' +
         (t ? '<img src="' + t + '" alt="">' : icon(catIcon(r.cat), color || '')) +
         '</span>';
}

function paintThumbs(){
  Array.prototype.forEach.call(document.querySelectorAll('[data-th]'), function(e){
    var t = thumbs[e.getAttribute('data-th')];
    if (t && !e.querySelector('img')) e.innerHTML = '<img src="' + t + '" alt="">';
  });
}

var thumbRun = 0;
function loadThumbs(){
  paintThumbs();

  var want = [], seen = {};
  Array.prototype.forEach.call(document.querySelectorAll('[data-th]'), function(e){
    var l = e.getAttribute('data-th');
    if (!l || seen[l] || thumbs[l]) return;
    seen[l] = 1;
    want.push(l);
  });
  if (!want.length) return;

  var run = ++thumbRun;
  callApi({ api: 'thumbs', init: initData(), links: want.slice(0, 24) })
    .then(function(res){
      if (run !== thumbRun || !res || !res.ok) return;
      var got = res.thumbs || {}, n = 0;
      for (var k in got) { thumbs[k] = got[k]; n++; }
      if (n) { saveThumbs(); paintThumbs(); }
      // За один заход бот готовит ограниченное число новых миниатюр.
      // Если что-то осталось и в этот раз хоть что-то пришло — идём
      // за остатком; иначе останавливаемся, чтобы не зациклиться.
      if (res.more && n) loadThumbs();
    })
    .catch(function(){});
}

/* ── переключатель вида ── */
function syncViews(){
  Array.prototype.forEach.call(document.querySelectorAll('#views button'), function(b){
    b.classList.toggle('on', b.getAttribute('data-v') === view);
  });
}
Array.prototype.forEach.call(document.querySelectorAll('#views button'), function(b){
  b.onclick = function(){
    tap();
    view = b.getAttribute('data-v');
    try { localStorage.setItem('view', view); } catch (e) {}
    syncViews();
    drawList(el('q').value);
  };
});
syncViews();

/* ── переходы по папкам и меню папки ── */
function bindFolders(){
  Array.prototype.forEach.call(document.querySelectorAll('.card[data-o]'), function(c){
    c.onclick = function(){
      tap();
      navOwner = c.getAttribute('data-o');
      navCat   = null;
      drawList('');
      el('scroll').scrollTop = 0;
    };
  });

  Array.prototype.forEach.call(document.querySelectorAll('.card[data-lost]'), function(c){
    c.onclick = function(){
      tap();
      navCat = LOSTCAT;
      drawList('');
      el('scroll').scrollTop = 0;
    };
  });

  Array.prototype.forEach.call(document.querySelectorAll('.card[data-c]'), function(c){
    c.onclick = function(){
      tap();
      navCat = c.getAttribute('data-c');
      drawList('');
      el('scroll').scrollTop = 0;
    };
  });

  Array.prototype.forEach.call(document.querySelectorAll('.dots'), function(b){
    b.onclick = function(ev){
      ev.stopPropagation();
      tap();
      var mo = b.getAttribute('data-mo');
      if (mo) ownerSheet(mo);
      else    folderSheet(navOwner, b.getAttribute('data-m'));
    };
  });

  var seg = el('rootseg');
  if (seg) {
    Array.prototype.forEach.call(seg.querySelectorAll('b'), function(b){
      b.onclick = function(){
        tap();
        rootAll = b.getAttribute('data-r') === '1';
        try { localStorage.setItem('root', rootAll ? 'all' : 'folders'); } catch (e) {}
        drawList('');
        el('scroll').scrollTop = 0;
      };
    });
  }

  var add = el('newFolder');
  if (add) add.onclick = function(){ tap(); newFolderSheet(navOwner); };

  var zip = el('zipAll');
  if (zip) zip.onclick = function(){ tap(); zipSheet('', ''); };
}

/* ── корзина: свёрнутый список внизу «Архива» ── */
function trashHtml(){
  if (!trash.length) return '';

  var h = '<div class="group bin"><h2 id="binhead">' +
          '<svg viewBox="0 0 24 24"><use href="#i-bin"/></svg>' +
          'Корзина · ' + trash.length +
          '<svg class="caret" viewBox="0 0 24 24"><use href="#i-down"/></svg></h2>' +
          '<div id="binlist" hidden>';

  trash.forEach(function(t, i){
    h += '<div class="card dim">' + icon(catIcon(t.cat)) +
         '<div class="body"><div class="t">' + esc(t.name) + '</div>' +
         '<div class="s">' + esc(t.owner + (t.gone ? ' · удалён ' + fmtDay(t.gone) : '')) + '</div></div>' +
         '<button class="undo" data-t="' + i + '">Вернуть</button></div>';
  });

  return h + '<div class="binnote">Файлы лежат в папке «99_Архив» на Drive — ' +
         'ничего не стёрто насовсем.</div></div></div>';
}

function bindTrash(){
  var head = el('binhead');
  if (!head) return;

  head.onclick = function(){
    tap();
    var box = el('binlist');
    box.hidden = !box.hidden;
    head.classList.toggle('open', !box.hidden);
  };

  Array.prototype.forEach.call(document.querySelectorAll('.undo'), function(b){
    b.onclick = function(ev){
      ev.stopPropagation();
      var t = trash[Number(b.getAttribute('data-t'))];
      if (!t) return;

      tap('medium');
      b.disabled = true;
      b.textContent = '…';

      callApi({ api: 'restore', init: initData(), link: t.link, name: t.name })
        .then(function(res){
          if (!res || !res.ok) {
            b.disabled = false; b.textContent = 'Вернуть';
            say('Не вышло: ' + (res && res.error || 'нет ответа'));
            return;
          }
          tap('medium');
          boot();
        })
        .catch(function(e){
          b.disabled = false; b.textContent = 'Вернуть';
          say(e.message || String(e));
        });
    };
  });
}

function say(msg){
  if (tg && tg.showAlert) { try { tg.showAlert(msg); return; } catch (e) {} }
  alert(msg);
}

/* ── карточка документа ── */
function bindCards(){
  var sel = '.card[data-i], .tile[data-i], .line[data-i]';
  Array.prototype.forEach.call(document.querySelectorAll(sel), function(c){
    c.onclick = function(){ tap(); openSheet(rows[Number(c.getAttribute('data-i'))]); };
  });
}

function showSheet(html){
  el('sheet').innerHTML = html;
  el('scrim').classList.add('on');
  document.body.classList.add('sheet-open');
  el('sheet').scrollTop = 0;
  syncBack();
}

function kv(k, v){
  if (!v) return '';
  return '<div class="kv"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';
}

function openSheet(r){
  if (!r) return;
  shown = r;

  var state = bucket(r);
  var sub = state === 'over' ? 'Просрочен ' + Math.abs(r.days) + ' дн. назад'
          : state === 'soon' ? 'Истекает через ' + r.days + ' дн.'
          : (r.until && !r.ever) ? 'Действует до ' + fmtDay(r.until) : 'Бессрочный';

  el('sheet').innerHTML =
    '<div class="grab"></div>' +
    (r.link ? '<div class="prev" id="prev"><div class="skel tall"></div></div>' : '') +
    '<h3>' + esc(r.name) + '</h3>' +
    '<div class="sub"><span class="pill ' + state + '">' + esc(sub) + '</span></div>' +
    termHtml(r) +
    kv('Кому', bare(r.owner)) +
    kv('Папка', r.cat) +
    kv('Организация', r.org) +
    kv('Номер', r.number) +
    kv('Выдан', fmtDay(r.issued)) +
    (r.note ? '<div class="memo">' + esc(r.note) + '</div>' : '') +
    (r.link ? '<a class="act" href="' + esc(r.link) + '" target="_blank">' +
              '<svg viewBox="0 0 24 24"><use href="#i-link"/></svg>Открыть файл</a>' : '') +
    favBtn(r) +
    (r.link ? '<button class="btn ghost" id="s_share">Поделиться</button>' : '') +
    '<button class="btn ghost" id="s_edit">Изменить</button>' +
    '<button class="btn ghost" id="s_move">Переместить</button>' +
    '<button class="btn danger" id="s_del">Удалить из архива</button>';

  if (r.link) el('s_share').onclick = function(){ tap(); drawShare(r); };
  el('s_fav').onclick  = function(){ toggleFav(r); };
  el('s_edit').onclick = function(){ tap(); editSheet(r); };
  el('s_move').onclick = function(){ tap(); moveSheet(r); };
  el('s_del').onclick  = function(){ askDelete(r); };
  bindTerm(r);
  if (r.link) loadPreview(r);

  el('scrim').classList.add('on');
  document.body.classList.add('sheet-open');
  el('sheet').scrollTop = 0;
  syncBack();
}

/* ── выгрузка архива одним файлом ── */
function zipSheet(ownerKey, catKey){
  var cats = ownerKey ? catOpts(ownerKey) : [];

  showSheet(
    '<div class="grab"></div>' +
    '<h3>Скачать архив</h3>' +
    '<div class="sub">Соберу выбранное в один ZIP</div>' +
    '<div id="zpmsg"></div>' +
    picker('zp_owner', 'Чьи документы', ownerOpts(), ownerKey, '— весь архив —') +
    (ownerKey
      ? picker('zp_cat', 'Папка', cats, catKey, '— все папки —')
      : '') +
    '<div class="hint">Внутри архив разложен так же: владелец → папка → файл. ' +
      'Готовый ZIP придёт файлом в чат с ботом и останется на Drive ' +
      'в папке «98_Выгрузки».</div>' +
    '<button class="btn primary" id="zp_go">Собрать</button>' +
    '<button class="btn ghost" id="zp_no">Отмена</button>');

  el('zp_owner').onchange = function(){ zipSheet(this.value, ''); };
  el('zp_no').onclick     = function(){ tap(); closeSheet(); };

  el('zp_go').onclick = function(){
    var o = el('zp_owner').value;
    var c = el('zp_cat') ? el('zp_cat').value : '';

    tap();
    el('zp_go').disabled = true;
    el('zpmsg').innerHTML =
      '<div class="notice">Собираю. Это может занять до минуты — ' +
      'каждый файл качается с Drive.</div>';

    callApi({ api: 'zip', init: initData(), owner: o, cat: c })
      .then(function(res){
        el('zp_go').disabled = false;
        if (!res || !res.ok) {
          el('zpmsg').innerHTML = '<div class="notice bad">' +
            esc(res && res.error || 'нет ответа') + '</div>';
          return;
        }
        tap('medium');
        drawZipDone(res);
      })
      .catch(function(e){
        el('zp_go').disabled = false;
        el('zpmsg').innerHTML = '<div class="notice bad">' + esc(e.message || e) + '</div>';
      });
  };
}

function drawZipDone(res){
  var warn = '';
  if (res.lost)  warn += '<br>Не открылось файлов: ' + res.lost + '.';
  if (res.heavy) warn += '<br>Не поместилось по объёму: ' + res.heavy + '.';

  el('sheet').innerHTML =
    '<div class="grab"></div>' +
    '<h3>Готово</h3>' +
    '<div class="sub">' + esc(res.what) + '</div>' +
    '<div class="notice good"><b>' + esc(res.name) + '</b><br>' +
      'Файлов: ' + res.files + ' · ' + res.mb + ' МБ' + warn + '</div>' +
    (res.sent
      ? '<div class="hint" style="margin-bottom:14px">Архив уже лежит файлом ' +
        'в чате с ботом — оттуда сохраняй или пересылай.</div>'
      : '<div class="notice">В Telegram не отправил: слишком большой. ' +
        'Качай по ссылке ниже.</div>') +
    '<a class="act" href="' + esc(res.url) + '" target="_blank">' +
      '<svg viewBox="0 0 24 24"><use href="#i-link"/></svg>Открыть на Drive</a>' +
    (res.sent
      ? '<button class="btn primary" id="zp_chat">Перейти в чат</button>'
      : '') +
    '<button class="btn ghost" id="zp_close">Закрыть</button>';

  var go = el('zp_chat');
  if (go) go.onclick = function(){ if (tg && tg.close) tg.close(); };
  el('zp_close').onclick = function(){ tap(); closeSheet(); };
}

/* ── правка карточки ── */
function editSheet(r){
  showSheet(
    '<div class="grab"></div>' +
    '<h3>Изменить</h3>' +
    '<div class="sub">' + esc(r.owner + ' → ' + r.cat) + '</div>' +
    '<div id="edmsg"></div>' +
    field('e_name', 'Название документа', r.name) +
    field('e_org',  'Организация',        r.org) +
    field('e_num',  'Номер',              r.number) +
    '<div class="two">' +
      field('e_issue', 'Дата выдачи',  r.issued, 'date') +
      field('e_exp',   'Действует до', r.until,  'date') +
    '</div>' +
    '<div class="field"><label>Заметка</label><textarea id="e_note">' +
      esc(r.note || '') + '</textarea></div>' +
    '<div class="hint">Владельца и папку меняет «Переместить». Имя файла ' +
      'на Drive пересоберётся из даты, владельца и нового названия.</div>' +
    '<button class="btn primary" id="e_go">Сохранить</button>' +
    '<button class="btn ghost" id="e_back">Назад</button>');

  el('e_back').onclick = function(){ tap(); openSheet(r); };
  el('e_go').onclick   = function(){
    var name = el('e_name').value.trim();
    if (!name) { say('Название не может быть пустым.'); return; }

    tap();
    el('e_go').disabled = true;
    el('edmsg').innerHTML = '<div class="notice">Сохраняю…</div>';

    callApi({ api: 'edit', init: initData(), link: r.link, name: r.name,
              newName: name,
              org:     el('e_org').value.trim(),
              number:  el('e_num').value.trim(),
              issue:   el('e_issue').value,
              expiry:  el('e_exp').value,
              note:    el('e_note').value.trim() })
      .then(function(res){
        if (!res || !res.ok) {
          el('e_go').disabled = false;
          el('edmsg').innerHTML = '<div class="notice bad">' +
            esc(res && res.error || 'нет ответа') + '</div>';
          return;
        }
        // Превью кэшируется по ссылке, а она могла смениться вместе с именем.
        if (r.link) delete previews[r.link];
        closeSheet();
        tap('medium');
        boot();
      })
      .catch(function(e){
        el('e_go').disabled = false;
        el('edmsg').innerHTML = '<div class="notice bad">' + esc(e.message || e) + '</div>';
      });
  };
}

/* ── срок действия ───────────────────────────────────────────────
   На сканах сплошь и рядом стоит дата, которая сроком не является:
   заверение перевода, выдача дубликата. Модель принимает её за срок,
   и документ без срока начинает гореть красным. Этот переключатель
   гасит его, не стирая дату, — отметка живёт в реестре отдельной
   колонкой, и вернуть всё обратно можно одним касанием. */
function termHtml(r){
  var ever = !!r.ever;
  var seg =
    '<div class="seg" id="s_term">' +
      '<b class="' + (ever ? '' : 'on') + '" data-ev="0">До даты</b>' +
      '<b class="' + (ever ? 'on' : '') + '" data-ev="1">Бессрочный</b>' +
    '</div>';

  var body;
  if (ever) {
    body = '<div class="tnote">В «Сроках» не появится.' +
           (r.until ? ' Дата со скана сохранена: ' + esc(fmtDay(r.until)) + '.' : '') + '</div>';
  } else if (r.until) {
    body = '<div class="tdate"><b class="' +
           (r.days !== null && r.days < 0 ? 'over' : r.days !== null && r.days <= 60 ? 'soon' : '') +
           '">' + esc(fmtDay(r.until)) + '</b>' +
           '<span>дата распознана со скана — переключи, если срока у документа нет</span></div>';
  } else {
    body = '<div class="tdate"><span>даты нет, за сроком и так никто не следит</span></div>';
  }

  return '<div class="term' + (ever ? ' off' : '') + '">' +
         '<div class="trow"><span>Срок действия</span>' + seg + '</div>' + body + '</div>';
}

/** Сколько дней осталось до даты. Нужно, чтобы вернуть счётчик при
    обратном переключении, не дожидаясь ответа сервера. */
function daysLeft(until){
  if (!until) return null;
  var t = Date.parse(until);
  if (isNaN(t)) return null;
  return Math.round((t - Date.now()) / 86400000);
}

function bindTerm(r){
  var box = el('s_term');
  if (!box) return;
  Array.prototype.forEach.call(box.querySelectorAll('b'), function(b){
    b.onclick = function(){ setEver(r, b.getAttribute('data-ev') === '1'); };
  });
}

function setEver(r, on){
  if (!!r.ever === on) return;

  var box = el('s_term');
  if (box) box.classList.add('wait');
  tap('medium');

  callApi({ api: 'ever', init: initData(), link: r.link, name: r.name, on: on ? 1 : 0 })
    .then(function(res){
      if (box) box.classList.remove('wait');
      if (!res || !res.ok) {
        say('Не вышло: ' + (res && res.error || 'нет ответа'));
        return;
      }
      r.ever = on;
      r.days = on ? null : daysLeft(r.until);
      if (shown === r) openSheet(r);
      drawDeadlines();
      drawList(el('q').value);
    })
    .catch(function(e){
      if (box) box.classList.remove('wait');
      say(e.message || String(e));
    });
}


/* ── перенос документа в другую папку ── */
function favBtn(r){
  return '<button class="btn ghost favbtn' + (r.fav ? ' on' : '') + '" id="s_fav">' +
         '<svg viewBox="0 0 24 24"><use href="#i-star"/></svg>' +
         '<span>' + (r.fav ? 'В избранном' : 'В избранное') + '</span></button>';
}

function toggleFav(r){
  var want = !r.fav;
  var b    = el('s_fav');
  tap('medium');
  b.disabled = true;

  callApi({ api: 'star', init: initData(), link: r.link, name: r.name, on: want ? 1 : 0 })
    .then(function(res){
      b.disabled = false;
      if (!res || !res.ok) {
        say('Не вышло: ' + (res && res.error || 'нет ответа'));
        return;
      }
      r.fav = want;
      b.classList.toggle('on', want);
      b.querySelector('span').textContent = want ? 'В избранном' : 'В избранное';
      if (want) fx('star', 'В избранном');
      drawList(el('q').value);
      drawDeadlines();
    })
    .catch(function(e){ b.disabled = false; say(e.message || String(e)); });
}

var NEWCAT = '__new__';   // служебное значение пункта «Новая папка»

function ownerOpts(){
  return OWNERS.map(function(o){ return { v: o.key, t: o.label }; });
}
function catOpts(ownerKey){
  return (CATS[ownerKey] || []).map(function(c){ return { v: c.key, t: c.label }; });
}

function moveSheet(r, pickedOwner){
  var o  = OWNERS.filter(function(x){ return x.label === r.owner; })[0];
  var ok = pickedOwner || (o ? o.key : (OWNERS[0] ? OWNERS[0].key : ''));

  showSheet(
    '<div class="grab"></div>' +
    '<h3>Переместить</h3>' +
    '<div class="sub">' + esc(r.name) + '</div>' +
    '<div class="hint" style="margin-bottom:18px">Сейчас: ' +
      esc(r.owner + ' → ' + r.cat) + '</div>' +
    '<div id="mvmsg"></div>' +
    picker('mv_owner', 'Кому', ownerOpts(), ok) +
    picker('mv_cat',   'Папка',
           catOpts(ok).concat([{ v: NEWCAT, t: '+ Новая папка…' }]), '') +
    '<div class="field" id="mv_newbox" hidden><label>Название новой папки</label>' +
      '<textarea class="ta" id="mv_newname" rows="1" placeholder="например, 1.7 Банк"></textarea></div>' +
    '<button class="btn primary" id="mv_go">Перенести</button>' +
    '<button class="btn ghost" id="mv_back">Назад</button>');

  el('mv_owner').onchange = function(){ moveSheet(r, this.value); };
  el('mv_back').onclick   = function(){ tap(); openSheet(r); };

  el('mv_cat').onchange = function(){
    var box = el('mv_newbox');
    box.hidden = this.value !== NEWCAT;
    if (!box.hidden) el('mv_newname').focus();
  };

  el('mv_go').onclick = function(){
    var ownerKey = el('mv_owner').value;
    var catKey   = el('mv_cat').value;
    if (!ownerKey || !catKey) { say('Выбери папку, куда переносим.'); return; }

    // Новую папку заводим тем же запросом, что и на экране папок,
    // и только потом переносим в неё файл.
    var fresh = '';
    if (catKey === NEWCAT) {
      fresh = el('mv_newname').value.trim();
      if (!fresh) { say('Впиши название новой папки.'); return; }
    }

    tap();
    el('mv_go').disabled = true;
    el('mvmsg').innerHTML = '<div class="notice">' +
      (fresh ? 'Создаю папку…' : 'Переношу…') + '</div>';

    var ready = fresh
      ? callApi({ api: 'folderNew', init: initData(), owner: ownerKey, name: fresh })
          .then(function(res){
            if (!res || !res.ok) throw new Error(res && res.error || 'не вышло создать папку');
            CATS = res.cats || CATS;
            var made = (CATS[ownerKey] || []).filter(function(c){
              return c.label === fresh;
            })[0];
            if (!made) throw new Error('папка создалась, но не нашлась в списке');
            el('mvmsg').innerHTML = '<div class="notice">Переношу…</div>';
            return made.key;
          })
      : Promise.resolve(catKey);

    var went = '';

    ready
      .then(function(key){
        var c = catOf(ownerKey, key);
        went = c ? c.label : fresh;
        return callApi({ api: 'move', init: initData(), link: r.link, name: r.name,
                         owner: ownerKey, cat: key });
      })
      .then(function(res){
        if (!res || !res.ok) throw new Error(res && res.error || 'нет ответа');
        closeSheet();
        tap('medium');
        fx('move', 'Перенесено в «' + went + '»');
        boot();
      })
      .catch(function(e){
        el('mv_go').disabled = false;
        el('mvmsg').innerHTML = '<div class="notice bad">' + esc(e.message || e) + '</div>';
      });
  };
}

/* ── новая папка ── */
function newFolderSheet(ownerKey){
  var o = ownerOf(ownerKey);
  showSheet(
    '<div class="grab"></div>' +
    '<h3>Новая папка</h3>' +
    '<div class="sub">' + esc(o ? o.label : '') + '</div>' +
    '<div id="nfmsg"></div>' +
    '<div class="field"><label>Название</label>' +
      '<textarea class="ta" id="nf_name" rows="1" placeholder="например, 1.7 Банк"></textarea></div>' +
    '<div class="hint">Папка появится и в приложении, и на Drive — внутри папки владельца.</div>' +
    '<button class="btn primary" id="nf_go">Создать</button>' +
    '<button class="btn ghost" id="nf_no">Отмена</button>');

  el('nf_no').onclick = function(){ tap(); closeSheet(); };
  el('nf_go').onclick = function(){
    var name = el('nf_name').value.trim();
    if (!name) { say('Впиши название папки.'); return; }

    tap();
    el('nf_go').disabled = true;
    el('nfmsg').innerHTML = '<div class="notice">Создаю…</div>';

    callApi({ api: 'folderNew', init: initData(), owner: ownerKey, name: name })
      .then(function(res){
        if (!res || !res.ok) {
          el('nf_go').disabled = false;
          el('nfmsg').innerHTML = '<div class="notice bad">' +
            esc(res && res.error || 'нет ответа') + '</div>';
          return;
        }
        CATS = res.cats || CATS;
        closeSheet();
        tap('medium');
        drawList('');
      })
      .catch(function(e){
        el('nf_go').disabled = false;
        el('nfmsg').innerHTML = '<div class="notice bad">' + esc(e.message || e) + '</div>';
      });
  };
}

/* ── владелец: переименовать ── */
function ownerSheet(ownerKey){
  var o = ownerOf(ownerKey);
  if (!o) return;

  var n = docsIn(o.label, null).length;
  var f = (CATS[ownerKey] || []).length;

  showSheet(
    '<div class="grab"></div>' +
    '<h3>' + esc(o.label) + '</h3>' +
    '<div class="sub">' + f + ' папок · ' + plural(n) + '</div>' +
    '<div id="owmsg"></div>' +
    '<div class="field"><label>Название</label>' +
      '<textarea class="ta" id="ow_name" rows="1">' + esc(o.label) + '</textarea></div>' +
    '<div class="field"><label>Короткое имя для файлов</label>' +
      '<textarea class="ta" id="ow_slug" rows="1">' + esc(o.slug || '') + '</textarea></div>' +
    '<div class="hint">Название поменяется везде: в реестре, в списке папок и ' +
      'в корзине. Короткое имя подставляется в начало имени файла при загрузке — ' +
      'у уже сохранённых файлов имена не меняются.</div>' +
    '<button class="btn primary" id="ow_go">Переименовать</button>' +
    '<button class="btn ghost" id="ow_no">Назад</button>');

  el('ow_no').onclick = function(){ tap(); closeSheet(); };
  el('ow_go').onclick = function(){
    var label = el('ow_name').value.trim();
    if (!label) { say('Название не может быть пустым.'); return; }

    tap();
    el('ow_go').disabled = true;
    el('owmsg').innerHTML = '<div class="notice">Переименовываю…</div>';

    callApi({ api: 'ownerRen', init: initData(), owner: ownerKey,
              label: label, slug: el('ow_slug').value.trim() })
      .then(function(res){
        if (!res || !res.ok) {
          el('ow_go').disabled = false;
          el('owmsg').innerHTML = '<div class="notice bad">' +
            esc(res && res.error || 'нет ответа') + '</div>';
          return;
        }
        OWNERS = res.owners || OWNERS;
        CATS   = res.cats   || CATS;
        closeSheet();
        tap('medium');
        boot();
      })
      .catch(function(e){
        el('ow_go').disabled = false;
        el('owmsg').innerHTML = '<div class="notice bad">' + esc(e.message || e) + '</div>';
      });
  };
}

/* ── папка: переименовать или удалить ── */
function folderSheet(ownerKey, catKey, moveTo){
  var o = ownerOf(ownerKey), c = catOf(ownerKey, catKey);
  if (!o || !c) return;

  var n = docsIn(o.label, c.label).length;

  showSheet(
    '<div class="grab"></div>' +
    '<h3>' + esc(c.label) + '</h3>' +
    '<div class="sub">' + esc(o.label) + ' · ' + plural(n) + '</div>' +
    '<div id="fdmsg"></div>' +
    '<div class="field"><label>Название папки</label>' +
      '<textarea class="ta" id="fd_name" rows="1">' + esc(c.label) + '</textarea></div>' +
    '<button class="btn primary" id="fd_ren">Переименовать</button>' +
    '<div class="hint">Папка переименуется и на Drive, и во всех записях реестра.</div>' +
    '<button class="btn ghost" id="fd_zip">Скачать папку</button>' +
    '<div id="fdkill"></div>' +
    '<button class="btn ghost" id="fd_back">Назад</button>');

  el('fd_back').onclick = function(){ tap(); closeSheet(); };
  el('fd_zip').onclick  = function(){ tap(); zipSheet(ownerKey, catKey); };

  el('fd_ren').onclick = function(){
    var name = el('fd_name').value.trim();
    if (!name) { say('Название не может быть пустым.'); return; }

    tap();
    el('fd_ren').disabled = true;
    el('fdmsg').innerHTML = '<div class="notice">Переименовываю…</div>';

    callApi({ api: 'folderRen', init: initData(),
              owner: ownerKey, cat: catKey, name: name })
      .then(function(res){
        if (!res || !res.ok) {
          el('fd_ren').disabled = false;
          el('fdmsg').innerHTML = '<div class="notice bad">' +
            esc(res && res.error || 'нет ответа') + '</div>';
          return;
        }
        CATS = res.cats || CATS;
        closeSheet();
        tap('medium');
        boot();
      })
      .catch(function(e){
        el('fd_ren').disabled = false;
        el('fdmsg').innerHTML = '<div class="notice bad">' + esc(e.message || e) + '</div>';
      });
  };

  drawKill(ownerKey, catKey, n, moveTo);
}

/* Блок удаления: если в папке что-то есть — сначала спрашиваем, куда перенести. */
function drawKill(ownerKey, catKey, n, moveTo){
  var box = el('fdkill');
  if (!box) return;

  if (!n) {
    box.innerHTML = '<button class="btn danger" id="fd_del">Удалить папку</button>';
    el('fd_del').onclick = function(){ killFolder(ownerKey, catKey, '', ''); };
    return;
  }

  var to = moveTo || (OWNERS[0] ? OWNERS[0].key : '');
  box.innerHTML =
    '<div class="swrow" style="display:block">' +
      '<b style="display:block;font-size:14.5px">Удалить папку</b>' +
      '<span style="display:block;color:var(--muted);font-size:12.5px;line-height:1.45;margin:3px 0 14px">' +
        'В папке ' + plural(n) + '. Выбери, куда их перенести — после переноса папка удалится.' +
      '</span>' +
      picker('fd_towner', 'Перенести к', ownerOpts(), to) +
      picker('fd_tocat',  'В папку',     catOpts(to), '') +
      '<button class="btn danger" id="fd_del">Перенести и удалить</button>' +
    '</div>';

  el('fd_towner').onchange = function(){ drawKill(ownerKey, catKey, n, this.value); };
  el('fd_del').onclick = function(){
    var tOwner = el('fd_towner').value, tCat = el('fd_tocat').value;
    if (!tOwner || !tCat) { say('Выбери, куда перенести документы.'); return; }
    killFolder(ownerKey, catKey, tOwner, tCat);
  };
}

function killFolder(ownerKey, catKey, toOwner, toCat){
  var c = catOf(ownerKey, catKey);
  var msg = 'Удалить папку «' + (c ? c.label : '') + '»?' +
            (toCat ? '\n\nДокументы сначала переедут в выбранную папку.' : '');

  function go(){
    tap('medium');
    el('fdmsg').innerHTML = '<div class="notice">Удаляю…</div>';

    callApi({ api: 'folderDel', init: initData(), owner: ownerKey, cat: catKey,
              toOwner: toOwner || '', toCat: toCat || '' })
      .then(function(res){
        if (!res || !res.ok) {
          el('fdmsg').innerHTML = '<div class="notice bad">' +
            esc(res && res.error || 'нет ответа') + '</div>';
          return;
        }
        CATS   = res.cats || CATS;
        navCat = null;
        closeSheet();
        tap('medium');
        boot();
      })
      .catch(function(e){
        el('fdmsg').innerHTML = '<div class="notice bad">' + esc(e.message || e) + '</div>';
      });
  }

  if (tg && tg.showConfirm) {
    try { tg.showConfirm(msg, function(yes){ if (yes) go(); }); return; } catch (e) {}
  }
  if (confirm(msg)) go();
}

/* ── превью первой страницы ── */
function loadPreview(r){
  var box = el('prev');
  if (!box) return;
  shareOpen = false;

  if (previews[r.link]) return paintPreview(box, previews[r.link], r);

  callApi({ api: 'preview', init: initData(), link: r.link })
    .then(function(res){
      if (shown !== r) return;
      var fresh = el('prev');
      if (!fresh) return;
      shareOpen = !!(res && res.open);
      if (!res || !res.ok) {
        fresh.innerHTML = '<div class="prevno">' +
          esc(res && res.error || 'превью недоступно') + '</div>';
        return;
      }
      var src = 'data:' + res.mime + ';base64,' + res.b64;
      previews[r.link] = src;
      paintPreview(fresh, src, r);
    })
    .catch(function(){
      var fresh = el('prev');
      if (fresh) fresh.innerHTML = '<div class="prevno">превью не загрузилось</div>';
    });
}

function paintPreview(box, src, r){
  box.innerHTML = '<a href="' + esc(r.link) + '" target="_blank">' +
                  '<img src="' + src + '" alt=""></a>';
}

/* ── поделиться ── */
function drawShare(r){
  el('sheet').innerHTML =
    '<div class="grab"></div>' +
    '<h3>Поделиться</h3>' +
    '<div class="sub">' + esc(r.name) + '</div>' +
    '<div id="shmsg"></div>' +

    '<button class="btn primary" id="sh_tg">Прислать файл в чат</button>' +
    '<div class="hint">Бот пришлёт документ тебе в Telegram — оттуда перешлёшь ' +
      'кому угодно обычной пересылкой. Доступ к файлу на Drive не меняется.</div>' +

    '<div class="field sep"><label>Отправить на почту</label>' +
      '<input id="sh_mail" type="email" inputmode="email" autocomplete="email" ' +
      'placeholder="name@example.com"></div>' +
    '<button class="btn ghost" id="sh_mailgo">Отправить письмом</button>' +
    '<div class="hint">Документ уйдёт вложением, до 24 МБ. Копия останется ' +
      'в «Отправленных» у i@4poll.com.</div>' +

    '<div class="swrow"><div class="swtext"><b>Доступ по ссылке</b>' +
      '<span>Пока включён, файл откроет любой, у кого есть ссылка</span></div>' +
      '<label class="sw"><input type="checkbox" id="sh_link"' +
      (shareOpen ? ' checked' : '') + '><i></i></label></div>' +
    '<div id="shlink">' + (shareOpen ? linkBox(r) : '') + '</div>' +

    '<button class="btn ghost" id="sh_back">Назад</button>';

  el('sh_back').onclick   = function(){ tap(); openSheet(r); };
  el('sh_tg').onclick     = function(){ sendShare(r, { how: 'tg' }); };
  el('sh_mailgo').onclick = function(){
    var to = el('sh_mail').value.trim();
    if (!to) { say('Впиши адрес почты.'); return; }
    sendShare(r, { how: 'mail', to: to });
  };
  el('sh_link').onchange = function(){ toggleLink(r, this); };
  bindLinkBox(r);
}

function linkBox(r){
  return '<div class="linkbox"><div class="url" id="sh_url">' + esc(r.link) + '</div>' +
         '<div class="two"><button class="btn ghost" id="sh_tglink">В Telegram</button>' +
         '<button class="btn ghost" id="sh_copy">Скопировать</button></div></div>';
}

function bindLinkBox(r){
  var a = el('sh_tglink'), b = el('sh_copy');
  if (a) a.onclick = function(){
    tap();
    var u = 'https://t.me/share/url?url=' + encodeURIComponent(r.link) +
            '&text=' + encodeURIComponent(r.name);
    if (tg && tg.openTelegramLink) tg.openTelegramLink(u);
    else window.open(u, '_blank');
  };
  if (b) b.onclick = function(){
    tap();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(r.link)
        .then(function(){ b.textContent = 'Скопировано'; })
        .catch(function(){ say(r.link); });
    } else {
      say(r.link);
    }
  };
}

function toggleLink(r, box){
  var want = box.checked;
  box.disabled = true;
  tap('medium');

  callApi({ api: 'link', init: initData(), link: r.link, on: want ? 1 : 0 })
    .then(function(res){
      box.disabled = false;
      if (!res || !res.ok) {
        box.checked = !want;
        say('Не вышло: ' + (res && res.error || 'нет ответа'));
        return;
      }
      shareOpen = want;
      el('shlink').innerHTML = want ? linkBox(r) : '';
      bindLinkBox(r);
    })
    .catch(function(e){
      box.disabled = false; box.checked = !want;
      say(e.message || String(e));
    });
}

function sendShare(r, how){
  var msg = el('shmsg');
  msg.innerHTML = '<div class="notice">Отправляю…</div>';
  el('sh_tg').disabled = true;
  el('sh_mailgo').disabled = true;
  tap();

  callApi({ api: 'share', init: initData(), link: r.link, name: r.name,
            how: how.how, to: how.to || '' })
    .then(function(res){
      el('sh_tg').disabled = false;
      el('sh_mailgo').disabled = false;

      if (!res || !res.ok) {
        msg.innerHTML = '<div class="notice bad">' +
          esc(res && res.error || 'нет ответа') + '</div>';
        return;
      }
      tap('medium');

      if (res.how === 'mail') {
        msg.innerHTML = '<div class="notice good">Письмо ушло на ' + esc(res.to) + '</div>';
        el('sh_mail').value = '';
      } else {
        msg.innerHTML = '<div class="notice good">Файл в чате с ботом — ' +
          'перешли его кому нужно.</div>' +
          '<button class="btn primary" id="sh_go">Перейти в чат</button>';
        var go = el('sh_go');
        if (go) go.onclick = function(){ if (tg && tg.close) tg.close(); };
      }
    })
    .catch(function(e){
      el('sh_tg').disabled = false;
      el('sh_mailgo').disabled = false;
      msg.innerHTML = '<div class="notice bad">' + esc(e.message || e) + '</div>';
    });
}

/* ── удаление: файл в «99_Архив», строка в «Корзину» ── */
function askDelete(r){
  tap('medium');
  var msg = 'Убрать «' + r.name + '» из архива?\n\n' +
            'Файл переедет в папку 99_Архив, а запись — в корзину. ' +
            'Вернуть можно в любой момент.';

  if (tg && tg.showConfirm) {
    try { tg.showConfirm(msg, function(yes){ if (yes) doDelete(r); }); return; }
    catch (e) {}
  }
  if (confirm(msg)) doDelete(r);
}

function doDelete(r){
  el('sheet').innerHTML =
    '<div class="grab"></div><div class="state"><div class="ring"></div>Убираю в архив…</div>';

  callApi({ api: 'trash', init: initData(), link: r.link, name: r.name })
    .then(function(res){
      if (!res || !res.ok) {
        el('sheet').innerHTML = '<div class="grab"></div><div class="notice bad">' +
          esc(res && res.error || 'нет ответа') + '</div>' +
          '<button class="btn ghost" onclick="closeSheet()">Закрыть</button>';
        return;
      }
      closeSheet();
      tap('medium');
      boot();
    })
    .catch(function(e){
      el('sheet').innerHTML = '<div class="grab"></div><div class="notice bad">' +
        esc(e.message || e) + '</div>' +
        '<button class="btn ghost" onclick="closeSheet()">Закрыть</button>';
    });
}

function closeSheet(){
  shown = null;
  el('scrim').classList.remove('on');
  document.body.classList.remove('sheet-open');
  syncBack();
}

/* Системная «Назад» в Telegram: сначала закрывает шторку,
   потом поднимает на уровень выше по папкам. */
function goBack(){
  if (document.body.classList.contains('sheet-open')) { closeSheet(); return; }
  if (navCat)   { navCat   = null; drawList(el('q').value); return; }
  if (navOwner) { navOwner = null; drawList(el('q').value); return; }
}

function syncBack(){
  if (!tg || !tg.BackButton) return;
  var need = document.body.classList.contains('sheet-open') || !!navOwner;
  try { need ? tg.BackButton.show() : tg.BackButton.hide(); } catch (e) {}
}

el('scrim').onclick = function(ev){ if (ev.target.id === 'scrim') closeSheet(); };
if (tg && tg.BackButton) tg.BackButton.onClick(goBack);

/* ── экран «Вопрос» ── */
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
  el('question').value = '';
  if (el('question').blur) el('question').blur();
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

/* ── экран «Добавить» ── */
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

/* Однострочное поле в телефоне вмещает символов тридцать, а
   «Aufenthaltstitel (Elektronischer Aufenthaltstitel)» или полное
   имя ведомства — втрое больше. В input остаток уезжает за край, и
   чтобы прочитать значение перед сохранением, его надо прокручивать
   внутри поля. Поэтому текстовые поля — textarea, которая растёт
   под содержимое; перенос строки в них запрещён, ведёт себя она
   по-прежнему как одна строка. */
function field(id, label, value, type){
  if (type === 'date') {
    return '<div class="field"><label>' + esc(label) + '</label>' +
      '<input id="' + id + '" type="date" value="' + esc(value || '') + '"></div>';
  }
  return '<div class="field"><label>' + esc(label) + '</label>' +
    '<textarea class="ta" id="' + id + '" rows="1">' + esc(value || '') + '</textarea></div>';
}

function grow(t){
  if (!t) return;
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight + 2, 260) + 'px';
}
function growAll(root){
  Array.prototype.forEach.call((root || document).querySelectorAll('textarea'), grow);
}

document.addEventListener('input', function(ev){
  var t = ev.target;
  if (!t || t.tagName !== 'TEXTAREA') return;
  // вставка из буфера может принести переносы — убираем
  if (t.classList.contains('ta') && t.value.indexOf('\n') !== -1) {
    t.value = t.value.replace(/\s*\n+\s*/g, ' ');
  }
  grow(t);
});

document.addEventListener('keydown', function(ev){
  var t = ev.target;
  if (ev.key === 'Enter' && t && t.classList && t.classList.contains('ta')) ev.preventDefault();
});

/* Поля рисуются в десятке разных мест. Вместо того чтобы помнить
   про каждое, подхватываем их появление в документе. */
if (window.MutationObserver) {
  new MutationObserver(function(list){
    for (var i = 0; i < list.length; i++) {
      var add = list[i].addedNodes;
      for (var j = 0; j < add.length; j++) {
        var n = add[j];
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'TEXTAREA') grow(n);
        else if (n.querySelector && n.querySelector('textarea')) growAll(n);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

function picker(id, label, opts, chosen, emptyLabel){
  var h = '<div class="field"><label>' + esc(label) + '</label><div class="selwrap">' +
          '<select id="' + id + '"><option value="">' +
          esc(emptyLabel || '— не выбрано —') + '</option>';
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
      (dup.owner ? '<span style="color:var(--muted)">' +
                   esc(dup.owner + ' → ' + dup.cat) + '</span><br>' : '') +
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

/* ── навигация ── */
function updateHead(name){
  var t = TITLES[name];
  el('title').textContent = t[0];

  if (name === 'deadlines' && rows.length) {
    var c = counts();
    el('subtitle').textContent = c.over
      ? 'Требуют внимания: ' + c.over
      : (c.soon ? 'Скоро истекает: ' + c.soon : 'Всё в порядке, ' + rows.length + ' документов');
  } else if (name === 'archive' && rows.length) {
    var o = navOwner ? ownerOf(navOwner) : null;
    var c = (o && navCat) ? catOf(navOwner, navCat) : null;
    el('subtitle').textContent =
      c ? plural(docsIn(o.label, c.label).length)
        : o ? ((CATS[o.key] || []).length + ' папок · ' + plural(docsIn(o.label, null).length))
            : plural(rows.length) + ' в архиве';
  } else {
    el('subtitle').textContent = t[1];
  }
}

Array.prototype.forEach.call(document.querySelectorAll('nav button'), function(b){
  b.onclick = function(){
    tap();
    var name = b.getAttribute('data-s');

    // Повторный тап по вкладке «Архив» поднимает в самый верх.
    if (name === 'archive' && b.classList.contains('on')) {
      navOwner = null; navCat = null; el('q').value = ''; drawList('');
    }

    Array.prototype.forEach.call(document.querySelectorAll('nav button'), function(x){
      x.classList.toggle('on', x === b);
    });
    ['deadlines','archive','ask','add'].forEach(function(n){
      el('s-' + n).classList.toggle('on', n === name);
    });
    updateHead(name);
    el('scroll').scrollTop = 0;
  };
});

/* ── перетаскивание документа в папку ──
   На телефоне папки и документы на разных уровнях, поэтому при начале
   перетаскивания снизу выезжает лоток с папками владельца — туда и бросаем.
   Пальцем тянем после долгого нажатия, мышью — сразу. */
var drag = null;
var swallowClick = false;

function dragItem(t){
  var n = t;
  while (n && n !== document.body) {
    if (n.classList) {
      if (n.classList.contains('dots')) return null;   // это меню, не перенос
      if (n.getAttribute('data-i') !== null &&
          (n.classList.contains('card') || n.classList.contains('tile') ||
           n.classList.contains('line')))
        return { kind: 'doc', node: n };
      if (n.getAttribute('data-c') !== null && n.classList.contains('card'))
        return { kind: 'folder', node: n };
    }
    n = n.parentNode;
  }
  return null;
}

function onDown(e){
  if (drag || (e.button != null && e.button !== 0)) return;

  var found = dragItem(e.target);
  if (!found) return;

  var r = null;
  if (found.kind === 'doc') {
    r = rows[Number(found.node.getAttribute('data-i'))];
    if (!r) return;
  } else if (!navOwner || (CATS[navOwner] || []).length < 2) {
    return;                                            // переставлять нечего
  }

  drag = { kind: found.kind, r: r, node: found.node, x: e.clientX, y: e.clientY,
           lastY: e.clientY, mouse: e.pointerType === 'mouse',
           active: false, timer: null, slot: null, was: '' };

  if (!drag.mouse) drag.timer = setTimeout(startDrag, 380);
}

function onMove(e){
  if (!drag) return;

  if (!drag.active) {
    var dx = Math.abs(e.clientX - drag.x), dy = Math.abs(e.clientY - drag.y);
    if (dx > 8 || dy > 8) {
      if (drag.mouse) startDrag();
      else { clearTimeout(drag.timer); drag = null; }  // пальцем это прокрутка
    }
    return;
  }

  drag.lastY = e.clientY;
  moveGhost(e.clientX, e.clientY);

  if (drag.kind === 'doc') { highlightSlot(e.clientX, e.clientY); return; }
  reorderTo(e.clientY);
  setEdge(e.clientY);
}

function startDrag(){
  if (!drag || drag.active) return;
  dropLeftovers();
  drag.active = true;
  tap('medium');
  hideToast();
  drag.node.classList.add('lift');

  var title = drag.node.querySelector('.t');
  var g = document.createElement('div');
  g.className = 'dghost';
  g.textContent = drag.kind === 'doc' ? drag.r.name
                : (title ? title.textContent : 'Папка');
  document.body.appendChild(g);
  drag.ghost = g;

  moveGhost(drag.x, drag.y);

  if (drag.kind === 'doc') showTray(drag.r);
  else drag.was = folderKeys();
}

/* ── перестановка папок ──
   Карточку двигаем прямо в DOM: так сразу видно, куда она встанет,
   а на отпускании порядок уже готов — его и отправляем на сервер. */
function folderKeys(){
  return Array.prototype.map.call(
    document.querySelectorAll('#list .card[data-c]'),
    function (n){ return n.getAttribute('data-c'); }).join(',');
}

function reorderTo(y){
  var box = drag.node.parentNode;
  if (!box) return;

  var sibs = Array.prototype.filter.call(box.children, function (n){
    return n !== drag.node && n.classList && n.classList.contains('card') &&
           n.getAttribute('data-c') !== null;
  });
  if (!sibs.length) return;

  for (var i = 0; i < sibs.length; i++) {
    var r = sibs[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) {
      if (sibs[i].previousElementSibling !== drag.node) {
        box.insertBefore(drag.node, sibs[i]);
        tap('soft');
      }
      return;
    }
  }

  var last = sibs[sibs.length - 1];
  if (last.nextElementSibling !== drag.node) {
    box.insertBefore(drag.node, last.nextElementSibling);
    tap('soft');
  }
}

/* У края экрана список едет сам — иначе до дальних папок не дотянуться. */
var edge = { t: null, d: 0 };

function setEdge(y){
  var box = el('scroll');
  var r   = box.getBoundingClientRect();
  var d   = 0;
  if      (y < r.top + 90)    d = -11;
  else if (y > r.bottom - 90) d =  11;
  if (d === edge.d) return;

  stopEdge();
  edge.d = d;
  if (!d) return;

  edge.t = setInterval(function (){
    if (!drag || !drag.active) { stopEdge(); return; }
    var before = box.scrollTop;
    box.scrollTop += edge.d;
    if (box.scrollTop === before) { stopEdge(); return; }
    reorderTo(drag.lastY);
  }, 16);
}

function stopEdge(){
  if (edge.t) clearInterval(edge.t);
  edge.t = null;
  edge.d = 0;
}

function saveOrder(was){
  var now = folderKeys();
  if (!now || now === was) return;

  tap('medium');
  toast('Меняю порядок…', 6000);

  callApi({ api: 'folderOrd', init: initData(), owner: navOwner, keys: now })
    .then(function (res){
      if (!res || !res.ok) {
        toast('Не вышло: ' + (res && res.error || 'нет ответа'), 3200);
        drawList(el('q').value);
        return;
      }
      CATS = res.cats || CATS;
      toast(res.moved ? 'Порядок и номера обновлены' : 'Порядок сохранён');
      boot();
    })
    .catch(function (e){
      toast(String(e.message || e), 3200);
      drawList(el('q').value);
    });
}

/* Подчищаем за прерванным перетаскиванием: экран мог перерисоваться. */
function dropLeftovers(){
  Array.prototype.forEach.call(document.querySelectorAll('.dghost'), function(g){ g.remove(); });
  Array.prototype.forEach.call(document.querySelectorAll('.lift'), function(n){
    n.classList.remove('lift');
  });
}

function moveGhost(x, y){
  if (!drag || !drag.ghost) return;
  var half = drag.ghost.offsetWidth / 2 + 6;
  var max  = document.documentElement.clientWidth - half;
  drag.ghost.style.left = Math.max(half, Math.min(x, max)) + 'px';
  drag.ghost.style.top  = Math.max(46, y) + 'px';
}

function highlightSlot(x, y){
  var el2  = document.elementFromPoint(x, y);
  var slot = null;
  while (el2 && el2 !== document.body) {
    if (el2.classList && el2.classList.contains('slot')) { slot = el2; break; }
    el2 = el2.parentNode;
  }
  if (slot === drag.slot) return;

  if (drag.slot) drag.slot.classList.remove('hot');
  drag.slot = slot;
  if (slot) { slot.classList.add('hot'); tap('soft'); }
}

function onUp(){
  if (!drag) return;
  var d = drag;
  drag = null;
  if (d.timer) clearTimeout(d.timer);
  stopEdge();
  if (!d.active) return;

  dropLeftovers();

  // Не даём отпусканию превратиться в обычный тап по карточке.
  swallowClick = true;
  setTimeout(function(){ swallowClick = false; }, 320);

  if (d.kind === 'folder') { saveOrder(d.was); return; }

  if (d.slot && typeof fxSlot === 'function') fxSlot(d.slot);
  hideTray();
  if (!d.slot) return;
  var ownerKey = d.slot.getAttribute('data-so');
  var catKey   = d.slot.getAttribute('data-sc');
  if (!catKey) { moveSheet(d.r); return; }
  dropMove(d.r, ownerKey, catKey);
}

function showTray(r){
  var o    = OWNERS.filter(function(x){ return x.label === r.owner; })[0];
  var list = o ? (CATS[o.key] || []).filter(function(c){ return c.label !== r.cat; }) : [];

  var h = '';
  list.forEach(function(c){
    h += '<div class="slot" data-so="' + esc(o.key) + '" data-sc="' + esc(c.key) + '">' +
         '<svg viewBox="0 0 24 24"><use href="#' + catIcon(c.label) + '"/></svg>' +
         '<span>' + esc(c.label.replace(/^[\d.]+\s*/, '')) + '</span></div>';
  });
  h += '<div class="slot other" data-so="" data-sc="">' +
       '<svg viewBox="0 0 24 24"><use href="#i-dots"/></svg>' +
       '<span>Другая папка…</span></div>';

  var t = el('tray');
  t.innerHTML = '<div class="trayin' + (list.length > 7 ? ' dense' : '') + '">' +
                h + '</div>';
  t.hidden = false;
  requestAnimationFrame(function(){ t.classList.add('on'); });
}

function hideTray(){
  var t = el('tray');
  t.classList.remove('on');
  setTimeout(function(){ if (!drag) { t.hidden = true; t.innerHTML = ''; } }, 220);
}

function dropMove(r, ownerKey, catKey){
  var c = catOf(ownerKey, catKey);
  toast('Переношу…');

  callApi({ api: 'move', init: initData(), link: r.link, name: r.name,
            owner: ownerKey, cat: catKey })
    .then(function(res){
      if (!res || !res.ok) { toast('Не вышло: ' + (res && res.error || 'нет ответа'), 3200); return; }
      tap('medium');
      fx('move', 'Перенесено в «' + (c ? c.label : '') + '»');
      boot();
    })
    .catch(function(e){ toast(String(e.message || e), 3200); });
}

/* Анимации живут в fx.js. Если тот не подгрузился — обходимся тостом. */
function fx(kind, text){
  if (typeof fxShow === 'function') fxShow(kind, text);
  else if (text) toast(text);
}

var toastTimer = null;

function hideToast(){
  clearTimeout(toastTimer);
  var t = el('toast');
  t.classList.remove('on');
  setTimeout(function (){ if (!t.classList.contains('on')) t.hidden = true; }, 250);
}

function toast(text, ms){
  var t = el('toast');
  t.textContent = text;
  t.hidden = false;
  requestAnimationFrame(function(){ t.classList.add('on'); });

  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){
    t.classList.remove('on');
    setTimeout(function(){ t.hidden = true; }, 250);
  }, ms || 1900);
}

document.addEventListener('pointerdown', onDown);
document.addEventListener('pointermove', onMove);
document.addEventListener('pointerup', onUp);
document.addEventListener('pointercancel', onUp);
// Прокрутку во время перетаскивания гасим здесь: pointermove для этого не годится.
document.addEventListener('touchmove', function(e){
  if (drag && drag.active) e.preventDefault();
}, { passive: false });
document.addEventListener('click', function(e){
  if (swallowClick) { e.stopPropagation(); e.preventDefault(); }
}, true);

boot();
