/* ════════════════════════════════════════════════════════════════
   Анимации. Отдельный файл, подключается ПОСЛЕ app.js.

   Правила, которых придерживаемся: не дольше полутора секунд, ничего
   не загораживает кнопки, и при включённом «уменьшить движение»
   в системе всё сводится к обычной подписи без мультиков.
   ════════════════════════════════════════════════════════════════ */

/* Стили держим здесь же, а не в style.css: вся анимация — один модуль,
   правится в одном файле. Вставляем до первого показа. */
var FX_CSS = [
  '/* ── анимации (fx.js) ── */',
  '.fx{',
  '  position:fixed;inset:0;z-index:80;display:grid;place-items:center;',
  '  pointer-events:none;background:rgba(0,0,0,.42);',
  '  -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);',
  '  animation:fxin .18s var(--ease);',
  '}',
  '.fx.out{animation:fxout .26s var(--ease) forwards}',
  '@keyframes fxin {from{opacity:0}to{opacity:1}}',
  '@keyframes fxout{to{opacity:0}}',
  '',
  '.fxbox{',
  '  display:flex;flex-direction:column;align-items:center;gap:14px;',
  '  padding:26px 28px 22px;border-radius:var(--r-xl);',
  '  background:var(--surface);max-width:78vw;',
  '  box-shadow:0 18px 50px rgba(0,0,0,.45);',
  '  animation:fxpop .34s var(--ease) backwards;',
  '}',
  '@keyframes fxpop{from{opacity:0;transform:scale(.88) translateY(10px)}}',
  '.fxart{width:148px;height:114px;display:block;overflow:visible}',
  '.fxcap{',
  '  font-size:14px;font-weight:600;text-align:center;line-height:1.35;',
  '  max-width:230px;overflow-wrap:anywhere;',
  '}',
  '',
  '/* папка и лист */',
  '.fback{fill:var(--raised);stroke:var(--line);stroke-width:2}',
  '.ffront{',
  '  fill:var(--accent);stroke:none;',
  '  transform-origin:60px 82px;animation:fflap .9s var(--ease) both;',
  '}',
  '/* Бумага светлая в любой теме — иначе читается как дыра в папке. */',
  '.fdoc rect{fill:#f4f7fb;stroke:#c7d3e0;stroke-width:1.6}',
  '.fline{stroke:#9fb0c2;stroke-width:2.4;stroke-linecap:round;fill:none}',
  '.fdoc{animation:fdoc .85s var(--ease) both}',
  '@keyframes fdoc{',
  '  0%  {transform:translateY(-40px) rotate(-10deg) scale(1.06);opacity:0}',
  '  22% {opacity:1}',
  '  72% {transform:translateY(10px) rotate(1deg) scale(.95)}',
  '  100%{transform:translateY(16px) rotate(0) scale(.94);opacity:1}',
  '}',
  '@keyframes fflap{',
  '  0%,44%{transform:rotate(0) translateY(0)}',
  '  60%   {transform:rotate(-4deg) translateY(2px)}',
  '  100%  {transform:rotate(0) translateY(0)}',
  '}',
  '',
  '/* галочка */',
  '.fok circle{fill:none;stroke:var(--green);stroke-width:2.6;',
  '  animation:fxpop2 .3s var(--ease) .62s backwards}',
  '.fok.big circle{stroke-width:3}',
  '.ftick{',
  '  fill:none;stroke:var(--green);stroke-width:3.4;',
  '  stroke-linecap:round;stroke-linejoin:round;',
  '  stroke-dasharray:40;stroke-dashoffset:40;',
  '  animation:ftick .42s var(--ease) .74s forwards;',
  '}',
  '.fx-save .fok circle{animation-delay:.04s}',
  '.fx-save .ftick{animation-delay:.18s}',
  '@keyframes ftick {to{stroke-dashoffset:0}}',
  '@keyframes fxpop2{from{opacity:0;transform:scale(.6);transform-origin:center}}',
  '',
  '/* звезда */',
  '.fstar path{',
  '  fill:var(--amber);stroke:var(--amber);stroke-width:3;stroke-linejoin:round;',
  '  transform-origin:60px 46px;animation:fstar .55s var(--ease) both;',
  '}',
  '@keyframes fstar{',
  '  0%  {transform:scale(.3) rotate(-35deg);opacity:0}',
  '  65% {transform:scale(1.14) rotate(6deg);opacity:1}',
  '  100%{transform:scale(1) rotate(0)}',
  '}',
  '.fray{',
  '  stroke:var(--amber);stroke-width:3;stroke-linecap:round;',
  '  transform-origin:60px 46px;opacity:0;',
  '  animation:fray .5s var(--ease) both;',
  '}',
  '@keyframes fray{',
  '  0%  {opacity:0;stroke-dasharray:0 14}',
  '  45% {opacity:.9;stroke-dasharray:11 3}',
  '  100%{opacity:0;stroke-dasharray:0 14;transform:translateY(-5px)}',
  '}',
  '',
  '/* ячейка лотка «проглатывает» документ */',
  '.slot.eat{animation:feat .42s var(--ease)}',
  '@keyframes feat{',
  '  0%  {transform:scale(1.06)}',
  '  38% {transform:scale(.88);background:rgba(62,139,255,.34)}',
  '  100%{transform:scale(1)}',
  '}',
  '',
  '@media (prefers-reduced-motion: reduce){',
  '  .fx,.fxbox,.fdoc,.ffront,.fok circle,.ftick,.fstar path,.fray,.slot.eat{',
  '    animation:none !important;',
  '  }',
  '}'
].join('\n');
(function(){
  var st = document.createElement('style');
  st.id = 'fxcss';
  st.textContent = FX_CSS;
  document.head.appendChild(st);
})();

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
