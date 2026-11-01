/* ════════════════════════════════════════════════════════════════
   Анимации. Отдельный файл, подключается ПОСЛЕ app.js.

   Правила, которых придерживаемся: не дольше полутора секунд, ничего
   не загораживает кнопки, и при включённом «уменьшить движение»
   в системе всё сводится к обычной подписи без мультиков.
   ════════════════════════════════════════════════════════════════ */

function fxCalm(){
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch (e) { return false; }
}

function fxKill(){
  var old = document.getElementById('fx');
  if (old) old.remove();
}

/**
 * Сценка на весь экран: что-то происходит с документом.
 * kind: 'move' — лист влетает в папку, 'save' — галочка, 'star' — звезда.
 */
function fxShow(kind, caption, ms){
  if (fxCalm()) { if (caption) toast(caption); return; }

  fxKill();

  var art = kind === 'move' ? fxArtMove()
          : kind === 'star' ? fxArtStar()
          : fxArtSave();

  var box = document.createElement('div');
  box.id = 'fx';
  box.className = 'fx';
  box.innerHTML = '<div class="fxbox fx-' + kind + '">' + art +
                  (caption ? '<div class="fxcap">' + esc(caption) + '</div>' : '') +
                  '</div>';
  document.body.appendChild(box);

  setTimeout(function(){
    box.classList.add('out');
    setTimeout(function(){ if (box.parentNode) box.remove(); }, 260);
  }, ms || 1250);
}

/* Лист бумаги влетает в папку: задняя стенка, лист, передняя стенка. */
function fxArtMove(){
  return '<svg class="fxart" viewBox="0 0 120 92">' +
    // задняя стенка папки с язычком
    '<path class="fback" d="M27 24h22l6 7h41a5 5 0 0 1 5 5v44H22V29a5 5 0 0 1 5-5z"/>' +
    // лист — между стенками, поэтому выглядит вложенным
    '<g class="fdoc">' +
      '<rect x="45" y="17" width="30" height="40" rx="3"/>' +
      '<path class="fline" d="M51 27h18M51 34h18M51 41h11"/>' +
    '</g>' +
    // передняя стенка — она же карман
    '<rect class="ffront" x="12" y="48" width="96" height="34" rx="6"/>' +
    '<g class="fok"><circle cx="98" cy="20" r="12"/>' +
      '<path class="ftick" d="m92.5 20 4 4 7.5-7.5"/></g>' +
  '</svg>';
}

/* Галочка, которая рисуется. */
function fxArtSave(){
  return '<svg class="fxart" viewBox="0 0 120 92">' +
    '<g class="fok big"><circle cx="60" cy="46" r="26"/>' +
      '<path class="ftick" d="m48 46 9 9 17-17"/></g>' +
  '</svg>';
}

/* Звезда с лучиками. */
function fxArtStar(){
  var rays = '';
  for (var i = 0; i < 8; i++) {
    rays += '<line class="fray" x1="60" y1="20" x2="60" y2="9" ' +
            'transform="rotate(' + (i * 45) + ' 60 46)" ' +
            'style="animation-delay:' + (i * 22) + 'ms"/>';
  }
  return '<svg class="fxart" viewBox="0 0 120 92">' +
    '<g class="fstar"><path d="M60 24 65.29 38.72 80.93 39.2 68.56 48.78 ' +
      '72.93 63.8 60 55 47.07 63.8 51.44 48.78 39.07 39.2 54.71 38.72Z"/></g>' +
    rays +
  '</svg>';
}

/* Подсветить и «проглотить» ячейку лотка, куда бросили документ. */
function fxSlot(slot){
  if (!slot || fxCalm()) return;
  slot.classList.add('eat');
  setTimeout(function(){ slot.classList.remove('eat'); }, 420);
}
