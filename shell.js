/* ════════════════════════════════════════════════════════════════
   Окно приложения: полный экран и безопасные поля.
   Подключается ПОСЛЕ app.js.

   Полноэкранный режим Telegram убирает собственную шапку клиента,
   но взамен вешает поверх страницы крестик и меню в правом верхнем
   углу, а сверху остаётся строка состояния телефона. Поэтому
   одновременно с запросом полного экрана считаем верхний отступ и
   отдаём его в CSS — иначе заголовок уезжает под часы и кнопку
   закрытия.

   Старые клиенты полноэкранный режим не знают. Там всё остаётся
   как было: tg.expand() уже вызван в app.js, отступ выходит
   нулевым, вёрстка не меняется.
   ════════════════════════════════════════════════════════════════ */

var SHELL_W = 460;   // ширина колонки на большом экране

var SHELL_CSS = [
  '/* ── полный экран (shell.js) ── */',
  '.head{padding-top:calc(18px + var(--sat, 0px))}',
  /* Экран правки углов рисуется поверх всего и про шапку клиента
     ничего не знает — ему отступ нужен отдельно. */
  '.crop{padding-top:var(--sat, 0px)}',
  /* В полноэкранном режиме крестик Telegram висит справа сверху,
     поэтому заголовку там тесно. */
  'body.tgfull .head h1{padding-right:92px}',
  'body.tgfull .head p{padding-right:92px}',
  /* Широкое окно (Telegram на компьютере, веб-версия): держим
     приложение колонкой шириной с телефон посередине, а не
     растягиваем список и кнопки на весь монитор. Плавающие части —
     карточка, лоток переноса — выравниваем по той же колонке. */
  '@media (min-width: 600px){',
  '  html{background:#07090d}',
  '  body{max-width:' + SHELL_W + 'px;margin:0 auto;',
  '       border-left:1px solid var(--line);border-right:1px solid var(--line)}',
  '  .sheet{max-width:' + SHELL_W + 'px;margin:0 auto}',
  '  .tray{left:calc(50% - ' + SHELL_W / 2 + 'px);right:calc(50% - ' + SHELL_W / 2 + 'px)}',
  '  .toast{max-width:' + (SHELL_W - 40) + 'px}',
  '}'
].join('\n');

(function(){
  var st = document.createElement('style');
  st.id = 'shellcss';
  st.textContent = SHELL_CSS;
  document.head.appendChild(st);
})();


/* Сколько сверху занято чужим. Telegram отдаёт два набора полей:
   safeAreaInset — вырез и строка состояния самого телефона,
   contentSafeAreaInset — накладка клиента, и отсчитывается она уже
   от нижней границы первого. Поэтому складываем. Перебрать здесь
   не страшно — заголовок просто опустится ниже; недобрать значит
   спрятать его под часы и крестик. */
function shellTop(){
  if (!tg) return 0;
  var a = (tg.safeAreaInset && tg.safeAreaInset.top) || 0;
  var b = (tg.contentSafeAreaInset && tg.contentSafeAreaInset.top) || 0;
  return a + b;
}

/* Телефон или нет — по тому, что сообщает сам клиент Telegram:
   ios, android, android_x. Остальное — tdesktop, macos, веб-версии. */
function shellPhone(){
  var p = String((tg && tg.platform) || '').toLowerCase();
  return p === 'ios' || p.indexOf('android') === 0;
}

function shellFit(){
  var top = shellTop();
  document.documentElement.style.setProperty('--sat', top + 'px');
  document.body.classList.toggle('tgfull', !!(tg && tg.isFullscreen));
  if (typeof fitViewport === 'function') fitViewport();
}

(function(){
  if (!tg) return;

  // Свайп вниз в Telegram закрывает приложение. На экране правки
  // углов это означало бы, что документ исчезает прямо под пальцем.
  try { if (tg.disableVerticalSwipes) tg.disableVerticalSwipes(); } catch (e) {}

  // Полный экран нужен только телефону: там он убирает шапку Telegram
  // и даёт место документу. На компьютере он растягивает приложение
  // на весь монитор, поэтому там его не просим, а если клиент
  // запомнил полноэкранный режим с прошлого раза — выходим из него.
  try {
    if (shellPhone()) {
      if (tg.requestFullscreen) tg.requestFullscreen();
    } else if (tg.isFullscreen && tg.exitFullscreen) {
      tg.exitFullscreen();
    }
  } catch (e) {
    console.warn('полный экран недоступен: ' + e);
  }

  if (tg.onEvent) {
    ['fullscreenChanged', 'safeAreaChanged', 'contentSafeAreaChanged', 'viewportChanged']
      .forEach(function(name){
        try { tg.onEvent(name, shellFit); } catch (e) {}
      });
    // Клиент может отказать — например, на планшете в окне.
    try {
      tg.onEvent('fullscreenFailed', function(){
        console.warn('клиент отказал в полном экране');
        shellFit();
      });
    } catch (e) {}
  }

  shellFit();
  // Поля приезжают не мгновенно: переспрашиваем после запроса.
  setTimeout(shellFit, 300);
  setTimeout(shellFit, 1200);
})();
