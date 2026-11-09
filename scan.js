/* ════════════════════════════════════════════════════════════════
   «Скан из фото». Отдельный файл, подключается ПОСЛЕ app.js и bulk.js.

   Что делает: выравнивает освещение (тень от руки, перепад яркости
   от окна), отбеливает бумагу и добавляет контраст. Цвет сохраняем
   намеренно — на удостоверениях есть фото и цветные печати, в ч/б
   они разваливаются.

   Чего НЕ делает: не ищет края листа и не правит перспективу. Это
   умеет сканер в Заметках на айфоне, и он делает это лучше — если
   фото сильно под углом, снимай им и присылай готовый PDF.

   Работает только для файлов, выбранных в приложении. Фотографии,
   отправленные в чат боту, идут мимо браузера и остаются как есть.
   ════════════════════════════════════════════════════════════════ */

var SCAN_MAX  = 2200;   // длинная сторона результата, px (≈185 dpi для A4)
var SCAN_Q    = 0.88;   // качество JPEG
var SCAN_MIN  = 400;    // мельче — не трогаем, это не документ
var SCAN_CELL = 16;     // во столько раз сетка оценки фона мельче кадра

var SCAN_CSS = [
  '/* ── переключатель обработки (scan.js) ── */',
  '.scanrow{',
  '  display:flex;gap:11px;align-items:flex-start;cursor:pointer;',
  '  margin-top:12px;padding:13px 15px;',
  '  border:1px solid var(--line);border-radius:var(--r-xl);',
  '  background:var(--surface);',
  '}',
  '.scanrow input{flex:none;width:18px;height:18px;margin-top:1px;accent-color:var(--accent)}',
  '.scanrow span{display:block;font-size:14px;line-height:1.35}',
  '.scanrow b{display:block;font-weight:600}',
  '.scanrow i{',
  '  display:block;font-style:normal;margin-top:3px;',
  '  color:var(--muted);font-size:12.5px;line-height:1.4;',
  '}'
].join('\n');

(function(){
  var st = document.createElement('style');
  st.id = 'scancss';
  st.textContent = SCAN_CSS;
  document.head.appendChild(st);
})();


/* ── настройка ───────────────────────────────────────────────── */
function scanOn(){
  try { return localStorage.getItem('scan') !== '0'; } catch (e) { return true; }
}
function scanSet(v){
  try { localStorage.setItem('scan', v ? '1' : '0'); } catch (e) {}
}

(function(){
  var box = el('addStart');
  if (!box) return;

  var row = document.createElement('label');
  row.className = 'scanrow';
  row.innerHTML =
    '<input type="checkbox" id="scanon">' +
    '<span><b>Обрабатывать фото как скан</b>' +
    '<i>выровняю освещение, отбелю бумагу, добавлю контраст. ' +
    'PDF и так не трогаю.</i></span>';
  box.appendChild(row);

  var cb = el('scanon');
  cb.checked = scanOn();
  cb.onchange = function(){ scanSet(cb.checked); tap(); };
})();


/* ── чтение картинки ─────────────────────────────────────────── */
/* createImageBitmap сам разворачивает кадр по EXIF — без него
   снятое вертикально фото уезжает набок. Где его нет (старый
   Safari) или где формат не по зубам (HEIC) — откатываемся. */
function scanBitmap(file){
  if (window.createImageBitmap) {
    try {
      return createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) {}
  }
  return new Promise(function(resolve, reject){
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload  = function(){ URL.revokeObjectURL(url); resolve(img); };
    img.onerror = function(){ URL.revokeObjectURL(url); reject(new Error('формат не открылся')); };
    img.src = url;
  });
}


/* ── оценка фона ─────────────────────────────────────────────────
   Бумага — самое светлое в кадре, поэтому фоном считаем не среднюю
   яркость клетки, а её верхний процентиль: среднее на плотном
   тексте увело бы фон в серый и выбелило буквы вместе с бумагой.
   Берём 90-й, а не максимум: максимум цепляет блик от лампы. */
function scanField(lum, w, h, gw, gh, cell){
  var grid = new Float32Array(gw * gh);
  var hist = new Uint32Array(64);

  for (var gy = 0; gy < gh; gy++) {
    for (var gx = 0; gx < gw; gx++) {
      var x0 = gx * cell, x1 = Math.min(x0 + cell, w);
      var y0 = gy * cell, y1 = Math.min(y0 + cell, h);

      hist.fill(0);
      var n = 0;
      for (var y = y0; y < y1; y++) {
        var off = y * w;
        for (var x = x0; x < x1; x++) { hist[lum[off + x] >> 2]++; n++; }
      }

      var need = Math.max(1, Math.round(n * 0.10)), acc = 0, b = 63;
      for (; b > 0; b--) { acc += hist[b]; if (acc >= need) break; }
      grid[gy * gw + gx] = b * 4 + 2;
    }
  }

  // Сглаживаем сетку, иначе на готовой картинке проступят квадраты.
  var out = new Float32Array(gw * gh);
  for (var j = 0; j < gh; j++) {
    for (var i = 0; i < gw; i++) {
      var s = 0, c = 0;
      for (var dj = -1; dj <= 1; dj++) {
        for (var di = -1; di <= 1; di++) {
          var jj = j + dj, ii = i + di;
          if (jj < 0 || jj >= gh || ii < 0 || ii >= gw) continue;
          s += grid[jj * gw + ii]; c++;
        }
      }
      out[j * gw + i] = s / c;
    }
  }
  return out;
}


/* ── основная обработка кадра на месте ───────────────────────── */
function scanFlatten(im, w, h){
  var d = im.data;
  var n = w * h;

  var lum = new Uint8Array(n);
  for (var i = 0, p = 0; i < n; i++, p += 4) {
    lum[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
  }

  var cell = Math.max(24, Math.round(Math.max(w, h) / SCAN_CELL));
  var gw   = Math.ceil(w / cell);
  var gh   = Math.ceil(h / cell);
  var fld  = scanField(lum, w, h, gw, gh, cell);

  // Кривая контраста: всё светлее 238 становится чистой бумагой,
  // всё темнее 18 — уверенно чёрным. Остальное растягиваем между.
  var lut = new Uint8Array(256);
  var lo = 18, hi = 238, k = 255 / (hi - lo);
  for (var v = 0; v < 256; v++) {
    var t = (v - lo) * k;
    lut[v] = t < 0 ? 0 : t > 255 ? 255 : t;
  }

  for (var y = 0; y < h; y++) {
    // Билинейная выборка фона: координата в сетке и веса по строке.
    var fy = (y + 0.5) / cell - 0.5;
    var y1 = Math.floor(fy); var wy = fy - y1;
    if (y1 < 0) { y1 = 0; wy = 0; }
    if (y1 >= gh - 1) { y1 = gh - 1; wy = 0; }
    var y2 = Math.min(y1 + 1, gh - 1);
    var r1 = y1 * gw, r2 = y2 * gw;

    for (var x = 0; x < w; x++) {
      var fx = (x + 0.5) / cell - 0.5;
      var x1 = Math.floor(fx); var wx = fx - x1;
      if (x1 < 0) { x1 = 0; wx = 0; }
      if (x1 >= gw - 1) { x1 = gw - 1; wx = 0; }
      var x2 = Math.min(x1 + 1, gw - 1);

      var bg = fld[r1 + x1] * (1 - wx) * (1 - wy) +
               fld[r1 + x2] * wx       * (1 - wy) +
               fld[r2 + x1] * (1 - wx) * wy +
               fld[r2 + x2] * wx       * wy;

      // Потолок на множитель: иначе в тенях вылезет цветной шум.
      var f = 255 / (bg < 40 ? 40 : bg);
      if (f > 2.2) f = 2.2;
      if (f < 1)   f = 1;

      var o = (y * w + x) << 2;
      var r = d[o] * f, g = d[o + 1] * f, b = d[o + 2] * f;
      d[o]     = lut[r > 255 ? 255 : r | 0];
      d[o + 1] = lut[g > 255 ? 255 : g | 0];
      d[o + 2] = lut[b > 255 ? 255 : b | 0];
    }
  }
}


function scanify(file){
  return scanBitmap(file).then(function(img){
    var w0 = img.width  || img.naturalWidth;
    var h0 = img.height || img.naturalHeight;
    if (!w0 || !h0) throw new Error('пустая картинка');
    if (Math.max(w0, h0) < SCAN_MIN) throw new Error('слишком мелкая');

    var k = Math.min(1, SCAN_MAX / Math.max(w0, h0));
    var w = Math.round(w0 * k), h = Math.round(h0 * k);

    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, w, h);
    if (img.close) { try { img.close(); } catch (e) {} }

    var im = cx.getImageData(0, 0, w, h);
    scanFlatten(im, w, h);
    cx.putImageData(im, 0, 0);

    return cv.toDataURL('image/jpeg', SCAN_Q);
  });
}


/* ── подмена чтения файла ────────────────────────────────────────
   app.js и bulk.js оба зовут readFile — перехватываем здесь, и
   обработка появляется сразу в обоих путях загрузки. Любая осечка
   откатывает на исходный файл: лучше необработанное фото, чем
   потерянный документ. */
var readFilePlain = readFile;

readFile = function(f){
  if (!f || !scanOn() || !/^image\//.test(f.type || '')) return readFilePlain(f);

  return scanify(f)
    .then(function(url){
      var dot  = String(f.name || 'photo').lastIndexOf('.');
      var base = dot > 0 ? f.name.slice(0, dot) : (f.name || 'photo');
      return { name: base + '.jpg', mime: 'image/jpeg', data: url.split(',')[1] };
    })
    .catch(function(e){
      console.warn('скан не вышел, шлю как есть: ' + (e && e.message || e));
      return readFilePlain(f);
    });
};
