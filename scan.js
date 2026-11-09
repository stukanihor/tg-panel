/* ════════════════════════════════════════════════════════════════
   «Скан из фото». Подключается ПОСЛЕ app.js и bulk.js.

   Что делает:
     1. находит края листа на снимке и выпрямляет перспективу;
     2. выравнивает освещение, отбеливает бумагу, добавляет контраст.

   Края ищем без OpenCV. Он умеет всё это из коробки, но тянет
   девять мегабайт на первую загрузку приложения — для одной
   операции дорого. Нужный конвейер — градиент, крупнейший контур,
   выпуклая оболочка, четырёхугольник максимальной площади,
   гомография — укладывается в этот файл и считается быстрее.

   При одиночной загрузке показываем углы и даём их подвинуть:
   автоматика ошибается на сложном фоне, и тогда проще поправить
   пальцем, чем переснимать. В пачке спрашивать про каждый из
   десяти файлов — мучение, поэтому там режем только когда
   уверены, а иначе оставляем кадр целиком.

   Фотографии, отправленные в чат боту, идут мимо браузера и
   остаются необработанными — обсчитывать их негде.
   ════════════════════════════════════════════════════════════════ */

var SCAN_MAX  = 2200;   // длинная сторона результата, px (≈185 dpi для A4)
var SCAN_Q    = 0.88;   // качество JPEG
var SCAN_MIN  = 400;    // мельче — не трогаем, это не документ
var SCAN_CELL = 16;     // во столько раз сетка оценки фона мельче кадра
var SCAN_WORK = 420;    // размер кадра, на котором ищем края

var SCAN_CSS = [
  '/* ── обработка снимков (scan.js) ── */',
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
  '}',
  '',
  '/* экран правки углов */',
  '.crop{',
  '  position:fixed;inset:0;z-index:90;background:#0b0f14;',
  '  display:flex;flex-direction:column;',
  '}',
  '.crophead{',
  '  flex:none;padding:14px 18px 10px;color:#e8eef6;',
  '}',
  '.crophead b{display:block;font-size:16px;font-weight:600}',
  '.crophead i{',
  '  display:block;font-style:normal;font-size:12.5px;line-height:1.4;',
  '  color:#9fb0c2;margin-top:3px;',
  '}',
  '.cropbox{',
  '  flex:1;position:relative;min-height:0;margin:0 14px;',
  '  touch-action:none;overflow:hidden;',
  '}',
  '.cropbox canvas{position:absolute;left:0;top:0}',
  '.cropfoot{flex:none;padding:12px 14px calc(14px + env(safe-area-inset-bottom))}',
  '.cropfoot .btn{margin-top:8px}',
  '.cropwarn{',
  '  margin:0 14px 8px;padding:9px 12px;border-radius:12px;',
  '  background:rgba(245,176,65,.16);color:#f5b041;',
  '  font-size:12.5px;line-height:1.4;',
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
    '<i>обрежу по краям листа, выровняю перспективу и освещение. ' +
    'PDF не трогаю.</i></span>';
  box.appendChild(row);

  var cb = el('scanon');
  cb.checked = scanOn();
  cb.onchange = function(){ scanSet(cb.checked); tap(); };
})();

/* Какой путь загрузки сейчас работает. Слушаем на document в фазе
   перехвата: так мы узнаём о выборе файлов раньше, чем сработают
   обработчики в app.js и bulk.js, и менять их не приходится. */
var scanBulk = false;
document.addEventListener('change', function(ev){
  var id = ev.target && ev.target.id;
  if (id === 'bulk') scanBulk = true;
  else if (id === 'file') scanBulk = false;
}, true);


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


/* ═══════════════════ ПОИСК КРАЁВ ЛИСТА ═════════════════════════ */

/* Края ищем на сильно уменьшенной копии: текст при этом сливается
   в серое, а граница листа остаётся — именно это нам и нужно. */
function scanEdges(gray, w, h){
  // лёгкое размытие, чтобы зерно матрицы не давало ложных градиентов
  var bl = new Float32Array(w * h);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var s = 0, c = 0;
      for (var dy = -1; dy <= 1; dy++) {
        var yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (var dx = -1; dx <= 1; dx++) {
          var xx = x + dx; if (xx < 0 || xx >= w) continue;
          s += gray[yy * w + xx]; c++;
        }
      }
      bl[y * w + x] = s / c;
    }
  }

  var mag = new Float32Array(w * h);
  var hist = new Uint32Array(256);
  var n = 0;

  for (var j = 1; j < h - 1; j++) {
    for (var i = 1; i < w - 1; i++) {
      var o = j * w + i;
      var gx = -bl[o - w - 1] - 2 * bl[o - 1] - bl[o + w - 1] +
                bl[o - w + 1] + 2 * bl[o + 1] + bl[o + w + 1];
      var gy = -bl[o - w - 1] - 2 * bl[o - w] - bl[o - w + 1] +
                bl[o + w - 1] + 2 * bl[o + w] + bl[o + w + 1];
      var m = Math.sqrt(gx * gx + gy * gy) / 4;
      mag[o] = m;
      hist[m > 255 ? 255 : m | 0]++;
      n++;
    }
  }

  // порог по доле самых контрастных точек
  var need = Math.round(n * 0.10), acc = 0, thr = 255;
  for (var b = 255; b > 0; b--) { acc += hist[b]; if (acc >= need) { thr = b; break; } }
  if (thr < 12) thr = 12;

  var mask = new Uint8Array(w * h);
  for (var k = 0; k < w * h; k++) mask[k] = mag[k] >= thr ? 1 : 0;
  return mask;
}

/* Крупнейшая связная цепочка контрастных точек. Граница листа —
   длинная замкнутая линия, а буквы распадаются на мелкие кляксы,
   поэтому побеждает обычно именно рамка. Компоненты оцениваем по
   охвату кадра, а не по числу точек: плотный текстовый блок точек
   даёт больше, но занимает меньше. */
function scanBlob(mask, w, h){
  var lab = new Int32Array(w * h).fill(-1);
  var stack = new Int32Array(w * h);
  var best = null, id = 0;

  for (var s = 0; s < w * h; s++) {
    if (!mask[s] || lab[s] !== -1) continue;

    var top = 0; stack[top++] = s; lab[s] = id;
    var minx = w, maxx = -1, miny = h, maxy = -1, cnt = 0;
    var pts = [];

    while (top > 0) {
      var p = stack[--top];
      var px = p % w, py = (p - px) / w;
      cnt++;
      if (px < minx) minx = px;
      if (px > maxx) maxx = px;
      if (py < miny) miny = py;
      if (py > maxy) maxy = py;
      pts.push(px, py);

      for (var dy = -1; dy <= 1; dy++) {
        var yy = py + dy; if (yy < 0 || yy >= h) continue;
        for (var dx = -1; dx <= 1; dx++) {
          var xx = px + dx; if (xx < 0 || xx >= w) continue;
          var q = yy * w + xx;
          if (mask[q] && lab[q] === -1) { lab[q] = id; stack[top++] = q; }
        }
      }
    }
    id++;

    var span = (maxx - minx + 1) * (maxy - miny + 1);
    if (!best || span > best.span) best = { span: span, cnt: cnt, pts: pts };
  }
  return best;
}

/* Выпуклая оболочка, обход Эндрю. */
function scanHull(pts){
  var p = [];
  for (var i = 0; i < pts.length; i += 2) p.push([pts[i], pts[i + 1]]);
  p.sort(function(a, b){ return a[0] - b[0] || a[1] - b[1]; });
  if (p.length < 3) return p;

  function cross(o, a, b){
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  }

  var lo = [];
  for (var k = 0; k < p.length; k++) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p[k]) <= 0) lo.pop();
    lo.push(p[k]);
  }
  var up = [];
  for (var m = p.length - 1; m >= 0; m--) {
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p[m]) <= 0) up.pop();
    up.push(p[m]);
  }
  lo.pop(); up.pop();
  return lo.concat(up);
}

/* Четырёхугольник наибольшей площади с вершинами в точках
   оболочки. Для каждой диагонали берём самую дальнюю точку с
   каждой стороны — это и даёт максимум. */
function scanQuad(hull){
  var n = hull.length;
  if (n < 4) return null;

  // На длинной оболочке перебор тяжелеет — прореживаем.
  if (n > 48) {
    var step = n / 48, cut = [];
    for (var t = 0; t < 48; t++) cut.push(hull[Math.floor(t * step)]);
    hull = cut; n = 48;
  }

  function area(a, b, c){
    return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  }

  var best = null;
  for (var i = 0; i < n; i++) {
    for (var k = i + 2; k < n; k++) {
      var b1 = -1, a1 = -1, b2 = -1, a2 = -1;
      for (var j = i + 1; j < k; j++) {
        var s1 = area(hull[i], hull[k], hull[j]);
        if (s1 > a1) { a1 = s1; b1 = j; }
      }
      for (var l = k + 1; l < n + i; l++) {
        var ll = l % n;
        var s2 = area(hull[i], hull[k], hull[ll]);
        if (s2 > a2) { a2 = s2; b2 = ll; }
      }
      if (b1 < 0 || b2 < 0) continue;
      if (!best || a1 + a2 > best.a) {
        best = { a: a1 + a2, q: [hull[i], hull[b1], hull[k], hull[b2]] };
      }
    }
  }
  return best ? best.q : null;
}

/* Приводим четыре точки к порядку: левый верх, правый верх,
   правый низ, левый низ. */
function scanOrder(q){
  var cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
  var cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  var s = q.slice().sort(function(a, b){
    return Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx);
  });
  // первая точка — та, что ближе к левому верхнему углу
  var bi = 0, bd = Infinity;
  for (var i = 0; i < 4; i++) {
    var d = s[i][0] * s[i][0] + s[i][1] * s[i][1];
    if (d < bd) { bd = d; bi = i; }
  }
  return [s[bi], s[(bi + 1) % 4], s[(bi + 2) % 4], s[(bi + 3) % 4]];
}

/* Похоже ли найденное на лист бумаги. Отбраковываем слишком
   мелкое, слишком кривое и вырожденное — лучше отдать кадр без
   обрезки, чем отрезать половину документа. */
function scanSane(q, w, h){
  if (!q) return false;

  var a = Math.abs(
    (q[0][0] * q[1][1] - q[1][0] * q[0][1]) +
    (q[1][0] * q[2][1] - q[2][0] * q[1][1]) +
    (q[2][0] * q[3][1] - q[3][0] * q[2][1]) +
    (q[3][0] * q[0][1] - q[0][0] * q[3][1])) / 2;
  if (a < 0.18 * w * h) return false;

  var min = Math.min(w, h);
  for (var i = 0; i < 4; i++) {
    var p = q[i], n = q[(i + 1) % 4], pr = q[(i + 3) % 4];
    var dx = n[0] - p[0], dy = n[1] - p[1];
    if (Math.sqrt(dx * dx + dy * dy) < 0.22 * min) return false;

    var ax = pr[0] - p[0], ay = pr[1] - p[1];
    var cos = (dx * ax + dy * ay) /
              (Math.sqrt(dx * dx + dy * dy) * Math.sqrt(ax * ax + ay * ay) || 1);
    if (Math.abs(cos) > 0.64) return false;   // угол вне 50°…130°
  }
  return true;
}

/* Выравнивание яркости перед поиском краёв. Снимок почти всегда
   светлее с одной стороны, и общий порог по градиенту срезает
   границу листа в тёмном углу — именно там, где она ещё нужна.
   Делим на местный максимум, и контраст становится одинаковым по
   всему кадру. */
function scanLevel(gray, w, h){
  var cell = Math.max(8, Math.round(Math.max(w, h) / 10));
  var gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  var fld = scanField(gray, w, h, gw, gh, cell);

  var out = new Uint8Array(w * h);
  for (var y = 0; y < h; y++) {
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
      if (bg < 20) bg = 20;

      var v = gray[y * w + x] * 255 / bg;
      out[y * w + x] = v > 255 ? 255 : v | 0;
    }
  }
  return out;
}

/* Расширение светлого: каждая точка берёт максимум из соседей.
   Тонкие тёмные штрихи текста при этом затягивает, а широкий
   тёмный фон вокруг листа остаётся. Когда лист лежит на светлой
   столешнице и граница еле видна, это единственный способ не дать
   буквам перетянуть на себя весь запас контраста. */
function scanDilate(gray, w, h, times){
  var a = gray, b = new Uint8Array(w * h);
  for (var t = 0; t < times; t++) {
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var m = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx; if (xx < 0 || xx >= w) continue;
            var v = a[yy * w + xx]; if (v > m) m = v;
          }
        }
        b[y * w + x] = m;
      }
    }
    var tmp = a; a = b; b = (tmp === gray) ? new Uint8Array(w * h) : tmp;
  }
  return a;
}

/* Одна попытка поиска на заданном рабочем размере. */
function scanTry(cv, work, fat, lev){
  var w0 = cv.width, h0 = cv.height;
  var k = Math.min(1, work / Math.max(w0, h0));
  var w = Math.max(40, Math.round(w0 * k)), h = Math.max(40, Math.round(h0 * k));

  var sc = document.createElement('canvas');
  sc.width = w; sc.height = h;
  var sx = sc.getContext('2d', { willReadFrequently: true });
  sx.drawImage(cv, 0, 0, w, h);

  var d = sx.getImageData(0, 0, w, h).data;
  var gray = new Uint8Array(w * h);
  for (var i = 0, p = 0; i < w * h; i++, p += 4) {
    gray[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
  }

  // Порядок важен: сначала затягиваем текст, потом выравниваем
  // яркость. Выравнивание подтягивает тёмный фон к белому, и если
  // стол сам по себе светлый, граница листа после него исчезает —
  // поэтому часть попыток идёт по исходной яркости.
  var base = fat ? scanDilate(gray, w, h, fat) : gray;
  if (lev) base = scanLevel(base, w, h);

  var blob = scanBlob(scanEdges(base, w, h), w, h);
  if (!blob) return null;

  var quad = scanQuad(scanHull(blob.pts));
  if (!quad || !scanSane(quad, w, h)) return null;

  quad = scanOrder(quad);
  return quad.map(function(pt){ return [pt[0] / k, pt[1] / k]; });
}

/* Весь поиск целиком: отдаёт четыре точки в координатах исходника
   или null, если лист не нашёлся.

   Пробуем на нескольких масштабах. На мелком тексте и узорах
   мельче — лучше: буквы сливаются в серое, а длинная граница
   листа переживает уменьшение и остаётся единственной заметной
   линией. Но слишком мелко — и сам лист теряет углы, поэтому
   начинаем с крупного. */
/* Чуть раздвигаем найденный четырёхугольник наружу. Ошибка в
   сторону фона стоит полоски стола на краю скана, ошибка внутрь —
   срезанной строчки документа. Цена несопоставима, поэтому
   сознательно промахиваемся наружу. */
function scanGrow(q, w, h){
  var cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
  var cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  var pad = 0.012;

  return q.map(function(p){
    var x = cx + (p[0] - cx) * (1 + pad);
    var y = cy + (p[1] - cy) * (1 + pad);
    return [Math.max(0, Math.min(w, x)), Math.max(0, Math.min(h, y))];
  });
}

function scanFind(cv){
  var tries = [
    [SCAN_WORK, 0, 1], [260, 0, 1], [170, 0, 1],
    [SCAN_WORK, 0, 0], [260, 2, 0], [170, 2, 0]
  ];
  for (var i = 0; i < tries.length; i++) {
    var q = scanTry(cv, tries[i][0], tries[i][1], tries[i][2]);
    if (!q) continue;
    // Первые три попытки идут по выровненной яркости — они
    // срабатывают, когда лист заметно контрастнее фона, и углы
    // тогда точны. Остальные — спасательные, для светлого стола:
    // лист находят, но углы гуляют. В пачке по таким не режем.
    return { quad: scanGrow(q, cv.width, cv.height), sure: i < 3 };
  }
  return null;
}


/* ═══════════════════ ВЫПРЯМЛЕНИЕ ═══════════════════════════════ */

/* Гомография по четырём парам точек: решаем систему 8×8 методом
   Гаусса. Считаем обратное преобразование — из готового листа в
   исходный кадр, чтобы на выходе не осталось дыр. */
function scanHomography(src, dst){
  var a = [], b = [];
  for (var i = 0; i < 4; i++) {
    var x = src[i][0], y = src[i][1], u = dst[i][0], v = dst[i][1];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }

  for (var c = 0; c < 8; c++) {
    var piv = c;
    for (var r = c + 1; r < 8; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    if (Math.abs(a[piv][c]) < 1e-9) return null;
    var tr = a[c]; a[c] = a[piv]; a[piv] = tr;
    var tb = b[c]; b[c] = b[piv]; b[piv] = tb;

    for (var r2 = 0; r2 < 8; r2++) {
      if (r2 === c) continue;
      var f = a[r2][c] / a[c][c];
      if (!f) continue;
      for (var c2 = c; c2 < 8; c2++) a[r2][c2] -= f * a[c][c2];
      b[r2] -= f * b[c];
    }
  }

  var m = [];
  for (var q = 0; q < 8; q++) m.push(b[q] / a[q][q]);
  m.push(1);
  return m;
}

function scanWarp(cv, quad){
  function len(a, b){
    var dx = a[0] - b[0], dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy);
  }
  var W = Math.round(Math.max(len(quad[0], quad[1]), len(quad[3], quad[2])));
  var H = Math.round(Math.max(len(quad[0], quad[3]), len(quad[1], quad[2])));
  if (W < 50 || H < 50) return null;

  var k = Math.min(1, SCAN_MAX / Math.max(W, H));
  W = Math.round(W * k); H = Math.round(H * k);

  var dst = [[0, 0], [W, 0], [W, H], [0, H]];
  var m = scanHomography(dst, quad);   // из листа в кадр
  if (!m) return null;

  var sx = cv.getContext('2d', { willReadFrequently: true });
  var src = sx.getImageData(0, 0, cv.width, cv.height);
  var sd = src.data, sw = cv.width, sh = cv.height;

  var out = document.createElement('canvas');
  out.width = W; out.height = H;
  var ox = out.getContext('2d', { willReadFrequently: true });
  var oi = ox.createImageData(W, H);
  var od = oi.data;

  for (var y = 0; y < H; y++) {
    for (var x = 0; x < W; x++) {
      var den = m[6] * x + m[7] * y + m[8];
      var u = (m[0] * x + m[1] * y + m[2]) / den;
      var v = (m[3] * x + m[4] * y + m[5]) / den;

      var o = (y * W + x) << 2;
      if (u < 0 || v < 0 || u > sw - 1 || v > sh - 1) {
        od[o] = od[o + 1] = od[o + 2] = 255; od[o + 3] = 255;
        continue;
      }

      var u0 = u | 0, v0 = v | 0;
      var u1 = u0 + 1 > sw - 1 ? u0 : u0 + 1;
      var v1 = v0 + 1 > sh - 1 ? v0 : v0 + 1;
      var fu = u - u0, fv = v - v0;

      var p00 = (v0 * sw + u0) << 2, p01 = (v0 * sw + u1) << 2;
      var p10 = (v1 * sw + u0) << 2, p11 = (v1 * sw + u1) << 2;

      for (var ch = 0; ch < 3; ch++) {
        var top = sd[p00 + ch] * (1 - fu) + sd[p01 + ch] * fu;
        var bot = sd[p10 + ch] * (1 - fu) + sd[p11 + ch] * fu;
        od[o + ch] = top * (1 - fv) + bot * fv;
      }
      od[o + 3] = 255;
    }
  }

  ox.putImageData(oi, 0, 0);
  return out;
}


/* ═══════════════════ СВЕТ И КОНТРАСТ ═══════════════════════════ */

/* Бумага — самое светлое в кадре, поэтому фоном считаем не среднюю
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


/* ═══════════════════ ЭКРАН ПРАВКИ УГЛОВ ════════════════════════ */

/* Показывает снимок с четырьмя точками. Возвращает обещание:
   массив из четырёх точек — резать по ним, null — не резать. */
function scanEditor(cv, quad, title){
  return new Promise(function(resolve){
    var auto = !!quad;
    if (!quad) {
      var mx = cv.width * 0.08, my = cv.height * 0.08;
      quad = [[mx, my], [cv.width - mx, my],
              [cv.width - mx, cv.height - my], [mx, cv.height - my]];
    }

    var box = document.createElement('div');
    box.className = 'crop';
    box.innerHTML =
      '<div class="crophead"><b>' + esc(title || 'Края листа') + '</b>' +
      '<i>' + (auto ? 'Нашёл границы сам. Поправь точки, если промахнулся.'
                    : 'Границы не распознал — расставь точки по углам листа.') +
      '</i></div>' +
      (auto ? '' : '<div class="cropwarn">Чаще всего так бывает, когда лист ' +
                   'лежит на светлой столешнице и края сливаются.</div>') +
      '<div class="cropbox" id="cropbox"></div>' +
      '<div class="cropfoot">' +
        '<button class="btn primary" id="crop_go">Обрезать и выпрямить</button>' +
        '<button class="btn ghost" id="crop_no">Оставить как есть</button>' +
      '</div>';
    document.body.appendChild(box);

    var host = box.querySelector('#cropbox');
    var cnv  = document.createElement('canvas');
    host.appendChild(cnv);
    var cx = cnv.getContext('2d');

    var sc = 1, offx = 0, offy = 0;

    function layout(){
      var bw = host.clientWidth, bh = host.clientHeight;
      if (!bw || !bh) return;
      sc = Math.min(bw / cv.width, bh / cv.height);
      var w = Math.round(cv.width * sc), h = Math.round(cv.height * sc);
      offx = Math.round((bw - w) / 2); offy = Math.round((bh - h) / 2);
      cnv.width = w; cnv.height = h;
      cnv.style.left = offx + 'px';
      cnv.style.top  = offy + 'px';
      draw();
    }

    function draw(){
      cx.clearRect(0, 0, cnv.width, cnv.height);
      cx.drawImage(cv, 0, 0, cnv.width, cnv.height);

      // затемняем всё вне выделения
      cx.save();
      cx.beginPath();
      cx.rect(0, 0, cnv.width, cnv.height);
      cx.moveTo(quad[0][0] * sc, quad[0][1] * sc);
      for (var i = 3; i >= 0; i--) cx.lineTo(quad[i][0] * sc, quad[i][1] * sc);
      cx.closePath();
      cx.fillStyle = 'rgba(8,12,18,.62)';
      cx.fill('evenodd');
      cx.restore();

      cx.beginPath();
      cx.moveTo(quad[0][0] * sc, quad[0][1] * sc);
      for (var j = 1; j < 4; j++) cx.lineTo(quad[j][0] * sc, quad[j][1] * sc);
      cx.closePath();
      cx.strokeStyle = '#3e8bff';
      cx.lineWidth = 2;
      cx.stroke();

      for (var k = 0; k < 4; k++) {
        var px = quad[k][0] * sc, py = quad[k][1] * sc;
        cx.beginPath(); cx.arc(px, py, 11, 0, 7);
        cx.fillStyle = '#fff'; cx.fill();
        cx.beginPath(); cx.arc(px, py, 11, 0, 7);
        cx.strokeStyle = '#3e8bff'; cx.lineWidth = 3; cx.stroke();
      }
    }

    var drag = -1;

    function at(ev){
      var r = cnv.getBoundingClientRect();
      return [(ev.clientX - r.left) / sc, (ev.clientY - r.top) / sc];
    }

    host.addEventListener('pointerdown', function(ev){
      var p = at(ev), best = -1, bd = 1e9;
      for (var i = 0; i < 4; i++) {
        var dx = quad[i][0] - p[0], dy = quad[i][1] - p[1];
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < bd) { bd = d; best = i; }
      }
      // 26 экранных пикселей — палец попадает уверенно
      if (bd * sc > 26) return;
      drag = best;
      host.setPointerCapture(ev.pointerId);
      tap();
      ev.preventDefault();
    });

    host.addEventListener('pointermove', function(ev){
      if (drag < 0) return;
      var p = at(ev);
      quad[drag][0] = Math.max(0, Math.min(cv.width,  p[0]));
      quad[drag][1] = Math.max(0, Math.min(cv.height, p[1]));
      draw();
      ev.preventDefault();
    });

    function up(){ drag = -1; }
    host.addEventListener('pointerup', up);
    host.addEventListener('pointercancel', up);

    function close(val){
      window.removeEventListener('resize', layout);
      box.remove();
      resolve(val);
    }

    box.querySelector('#crop_go').onclick = function(){
      tap('medium');
      close(scanOrder(quad));
    };
    box.querySelector('#crop_no').onclick = function(){ tap(); close(null); };

    window.addEventListener('resize', layout);
    // даём верстке встать, иначе clientHeight ещё нулевой
    requestAnimationFrame(function(){ requestAnimationFrame(layout); });
  });
}


/* ═══════════════════ СБОРКА ════════════════════════════════════ */

function scanCanvas(img, max){
  var w0 = img.width  || img.naturalWidth;
  var h0 = img.height || img.naturalHeight;
  if (!w0 || !h0) throw new Error('пустая картинка');

  var k = Math.min(1, max / Math.max(w0, h0));
  var cv = document.createElement('canvas');
  cv.width  = Math.round(w0 * k);
  cv.height = Math.round(h0 * k);
  cv.getContext('2d', { willReadFrequently: true })
    .drawImage(img, 0, 0, cv.width, cv.height);
  return cv;
}

function scanify(file, interactive, title){
  return scanBitmap(file).then(function(img){
    var w0 = img.width || img.naturalWidth;
    var h0 = img.height || img.naturalHeight;
    if (Math.max(w0 || 0, h0 || 0) < SCAN_MIN) throw new Error('слишком мелкая');

    // Работаем с копией нормального размера: резать и выпрямлять
    // надо до уменьшения, иначе теряется мелкий шрифт.
    var cv = scanCanvas(img, SCAN_MAX * 1.4);
    if (img.close) { try { img.close(); } catch (e) {} }

    var hit  = scanFind(cv);
    var quad = hit ? hit.quad : null;

    // В пачке режем только по уверенному распознаванию: спросить
    // про каждый из десяти файлов нельзя, а срезать угол документа
    // молча — хуже, чем оставить кадр целиком.
    var pick = interactive
      ? scanEditor(cv, quad, title)
      : Promise.resolve(hit && hit.sure ? quad : null);

    return pick.then(function(q){
      var work = null;
      if (q) work = scanWarp(cv, q);
      if (!work) {
        // без обрезки — просто ужимаем до рабочего размера
        work = scanCanvas(cv, SCAN_MAX);
      }

      var wx = work.getContext('2d', { willReadFrequently: true });
      var im = wx.getImageData(0, 0, work.width, work.height);
      scanFlatten(im, work.width, work.height);
      wx.putImageData(im, 0, 0);

      return work.toDataURL('image/jpeg', SCAN_Q);
    });
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

  return scanify(f, !scanBulk, f.name)
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
