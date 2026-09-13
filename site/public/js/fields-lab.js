/* КОНСТРУКТОР ВИДА ПОЛЕЙ (/admin/fields).
   Тумблеры не перезагружают страницу: атрибут data-fx на <html> меняется на
   месте, а вид полей в site.css целиком висит на этом атрибуте — образцы ниже
   перерисовываются сами. Скрытое поле формы держит тот же набор, поэтому
   «Применить» сохраняет ровно то, что видно. */
(function () {
  var form = document.getElementById('fx-form');
  if (!form) return;
  var value = document.getElementById('fx-value');
  var current = document.getElementById('fx-current');
  var openLink = document.getElementById('fx-open');
  var toggles = Array.prototype.slice.call(document.querySelectorAll('.fx-toggle'));

  function apply() {
    // Порядок берём из разметки — он же порядок в словаре на сервере.
    var picked = toggles.filter(function (t) { return t.checked; }).map(function (t) { return t.value; });
    var fx = picked.join(' ');
    document.documentElement.setAttribute('data-fx', fx);
    value.value = fx;
    current.textContent = fx || '(без эффектов)';
    if (openLink) openLink.href = '/contacts?fx=' + encodeURIComponent(fx);
  }

  toggles.forEach(function (t) { t.addEventListener('change', apply); });

  var presets = document.getElementById('fx-presets');
  if (presets) {
    presets.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-preset]');
      if (!btn) return;
      var want = (btn.getAttribute('data-preset') || '').split(' ').filter(Boolean);
      toggles.forEach(function (t) { t.checked = want.indexOf(t.value) !== -1; });
      apply();
    });
  }

  apply();
})();
