/* ═══════════════════════════════════════════════════════════════════
   Архив документов — логика мини-приложения.

   Адрес веб-приложения Apps Script. Если создашь НОВОЕ развёртывание
   вместо новой версии — адрес сменится, поменяй его здесь.
   ═══════════════════════════════════════════════════════════════════ */
var API = 'https://script.google.com/macros/s/AKfycbxUus4MoPjOp_6R30VUspQyZNeRUPs2yGFN9PnvP8SQY2IfEjbU4QnOxGlcpQETy8XQ/exec';

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

/* ── связь с Apps Script ───────────────────────────────────────── */
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

/* ── загрузка данных ───────────────────────────────────────────── */
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

/* ── экран «Сроки» ─────────────────────────────────────────────── */
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
  list.forEach(function(r, n){
    h += cardHtml(r, color, n);
  });
  return h + '</div>';
}

function cardHtml(r, color, n){
  var i = rows.indexOf(r);
  var badge = '';
  if (r.days !== null && r.until) {
    if (r.days < 0)       badge = '<span class="badge red">' + Math.abs(r.days) + ' дн. назад</span>';
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

/* ── экран «Архив» ─────────────────────────────────────────────── */
function drawList(query){
  var q = String(query || '').trim().toLowerCase();
  var hit = rows.filter(function(r){
    if (!q) return true;
    return (r.name + ' ' + r.org + ' ' + r.number + ' ' + r.cat + ' ' +
            r.owner + ' ' + r.note).toLowerCase().indexOf(q) !== -1;
  });

  var h = '';
  if (!hit.length) {
    h = '<div class="state">Ничего не нашлось.</div>';
  } else {
    var by = {};
    hit.forEach(function(r){ (by[r.owner] = by[r.owner] || []).push(r); });

    var n = 0;
    Object.keys(by).sort().forEach(function(owner){
      h += '<div class="group"><h2>' + esc(owner) + ' · ' + by[owner].length + '</h2>';
      by[owner].forEach(function(r){ h += cardHtml(r, '', n++); });
      h += '</div>';
    });
  }

  el('list').innerHTML = h + trashHtml();
  bindCards();
  bindTrash();
}

/* ── корзина: свёрнутый список внизу «Архива» ──────────────────── */
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
         '<div class="s">' + esc(t.owner + (t.gone ? ' · удалён ' + t.gone : '')) + '</div></div>' +
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

/* ── карточка документа ────────────────────────────────────────── */
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
  shown = r;

  var state = bucket(r);
  var sub = state === 'over' ? 'Просрочен ' + Math.abs(r.days) + ' дн. назад'
          : state === 'soon' ? 'Истекает через ' + r.days + ' дн.'
          : (r.until ? 'Действует до ' + r.until : 'Бессрочный');

  el('sheet').innerHTML =
    '<div class="grab"></div>' +
    '<h3>' + esc(r.name) + '</h3>' +
    '<div class="sub">' + esc(sub) + '</div>' +
    (r.link ? '<div class="prev" id="prev"><div class="skel tall"></div></div>' : '') +
    kv('Кому', r.owner) +
    kv('Папка', r.cat) +
    kv('Организация', r.org) +
    kv('Номер', r.number) +
    kv('Выдан', r.issued) +
    (r.note ? '<div class="memo">' + esc(r.note) + '</div>' : '') +
    (r.link ? '<a class="act" href="' + esc(r.link) + '" target="_blank">' +
              '<svg viewBox="0 0 24 24"><use href="#i-link"/></svg>Открыть файл</a>' : '') +
    (r.link ? '<button class="btn ghost" id="s_share">Поделиться</button>' : '') +
    '<button class="btn danger" id="s_del">Удалить из архива</button>';

  if (r.link) el('s_share').onclick = function(){ tap(); drawShare(r); };
  el('s_del').onclick = function(){ askDelete(r); };
  if (r.link) loadPreview(r);

  el('scrim').classList.add('on');
  document.body.classList.add('sheet-open');
  if (tg && tg.BackButton) { tg.BackButton.show(); }
}

/* ── превью первой страницы ────────────────────────────────────── */
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

/* ── поделиться ───────────────────────────────────────────────── */
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
    '<div class="hint">Документ уйдёт вложением, до 24 МБ.</div>' +

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

/* ── удаление: файл в «99_Архив», строка в «Корзину» ───────────── */
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
  if (tg && tg.BackButton) tg.BackButton.hide();
}

el('scrim').onclick = function(ev){ if (ev.target.id === 'scrim') closeSheet(); };
if (tg && tg.BackButton) tg.BackButton.onClick(closeSheet);

/* ── экран «Вопрос» ────────────────────────────────────────────── */
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

/* ── экран «Добавить» ──────────────────────────────────────────── */
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

/* ── навигация ─────────────────────────────────────────────────── */
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
