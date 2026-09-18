// Поведение публичной части: тема, бургер, параллакс, 3D-наклон карточек.
// Перенесено из логики макета (DCLogic) в обычный DOM без рантайма прототипа.
// Файл внешний, а не инлайн: строгий CSP (script-src 'self') инлайн бы заблокировал.
(function () {
  'use strict';

  // ПОДТВЕРЖДЕНИЕ ОПАСНЫХ ДЕЙСТВИЙ. Любая красная кнопка-submit (.btn--danger) —
  // удаление, отклонение — идёт на сервер только после «ОК» в диалоге. Одно
  // правило на все формы админки: 05.09.2026 владелец удалил сам себя одним
  // кликом. Текст — из data-confirm кнопки либо общий. Без JS форма уйдёт как
  // раньше — сервер и так проверяет права и CSRF.
  // ГЛАВНАЯ: переключатель топ-10 «Все / Мужчины / Женщины».
  document.querySelectorAll('[data-top-tab]').forEach(function (b) {
    b.addEventListener('click', function () {
      var key = b.getAttribute('data-top-tab');
      document.querySelectorAll('[data-top-tab]').forEach(function (x) { x.classList.toggle('is-active', x === b); });
      document.querySelectorAll('[data-top-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-top-panel') !== key; });
    });
  });

  // ТУРНИРЫ: возраст «ввод вручную» показывает поле; «Редактировать» открывает поля строки.
  document.querySelectorAll('[data-age-select]').forEach(function (sel) {
    var scope = sel.closest('td') || sel.closest('form') || document;
    var custom = scope.querySelector('[data-age-custom]');
    if (!custom) return;
    var sync = function () { var on = sel.value === 'custom'; custom.hidden = !on; if (custom.tagName !== 'DIV') custom.style.display = on ? '' : 'none'; };
    sel.addEventListener('change', sync); sync();
  });
  document.querySelectorAll('tr[data-editable]').forEach(function (tr) {
    tr.classList.add('t-row--ro');
    var btn = tr.querySelector('[data-edit]');
    if (btn) btn.addEventListener('click', function () { tr.classList.remove('t-row--ro'); tr.classList.add('t-row--ed'); });
  });

  // ЯНДЕКС.МЕТРИКА — ТОЛЬКО ПОСЛЕ СОГЛАСИЯ. Без cookie ftso.analytics=1 счётчик
  // не грузится вовсе; «Отклонить» пишет 0 на год и больше не спрашивает.
  // «Настройки cookie» в подвале снова показывают баннер.
  (function () {
    var bar = document.querySelector('[data-cookie-bar]');
    if (!bar) return;
    var id = bar.getAttribute('data-metrika');
    var loaded = false;
    function setChoice(v) {
      document.cookie = 'ftso.analytics=' + v + '; Max-Age=' + (60 * 60 * 24 * 365) + '; Path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
    }
    function loadMetrika() {
      if (loaded || !id) return;
      loaded = true;
      window.ym = window.ym || function () { (window.ym.a = window.ym.a || []).push(arguments); };
      window.ym.l = Date.now();
      var s = document.createElement('script');
      s.async = true;
      s.src = 'https://mc.yandex.ru/metrika/tag.js';
      document.head.appendChild(s);
      // Без вебвизора: запись действий посетителя федерации не нужна, а объём ПДн — меньше.
      window.ym(Number(id), 'init', { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: false });
    }
    bar.querySelector('[data-cookie-accept]').addEventListener('click', function () { setChoice('1'); bar.hidden = true; loadMetrika(); });
    bar.querySelector('[data-cookie-decline]').addEventListener('click', function () { setChoice('0'); bar.hidden = true; });
    var settings = document.querySelector('[data-cookie-settings]');
    if (settings) settings.addEventListener('click', function (e) { e.preventDefault(); bar.hidden = false; bar.scrollIntoView({ block: 'end' }); });
    if (bar.getAttribute('data-choice') === '1') loadMetrika();
  })();

  // ГАЛЕРЕЯ: полноэкранный просмотр на <dialog> (ТЗ 4.8). Клик по снимку —
  // открыть, ←/→ или кнопки — листать, Esc/крестик/клик по фону — закрыть.
  (function () {
    var box = document.querySelector('[data-lightbox]');
    var items = Array.prototype.slice.call(document.querySelectorAll('[data-gallery-item]'));
    if (!box || !items.length || typeof box.showModal !== 'function') return;
    var img = box.querySelector('.lightbox__img');
    var cap = box.querySelector('.lightbox__caption');
    var cur = 0;
    function show(i) {
      cur = (i + items.length) % items.length;
      var a = items[cur];
      img.src = a.getAttribute('href');
      img.alt = a.getAttribute('data-caption') || '';
      cap.textContent = a.getAttribute('data-caption') || '';
      if (!box.open) box.showModal();
    }
    items.forEach(function (a, i) {
      a.addEventListener('click', function (e) { e.preventDefault(); show(i); });
    });
    box.querySelector('[data-lightbox-prev]').addEventListener('click', function () { show(cur - 1); });
    box.querySelector('[data-lightbox-next]').addEventListener('click', function () { show(cur + 1); });
    box.querySelector('[data-lightbox-close]').addEventListener('click', function () { box.close(); });
    box.addEventListener('click', function (e) { if (e.target === box) box.close(); });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') show(cur - 1);
      if (e.key === 'ArrowRight') show(cur + 1);
    });
    box.addEventListener('close', function () { img.src = ''; });
  })();

  // Печатная версия рейтинга: кнопка «Сохранить как PDF» — это window.print().
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-print]') : null;
    if (b) window.print();
  });

  document.addEventListener('submit', function (e) {
    var btn = e.submitter;
    if (!btn || !btn.classList || !btn.classList.contains('btn--danger')) return;
    var q = btn.getAttribute('data-confirm') ||
      ('Подтвердите: «' + (btn.textContent || '').trim() + '». Отменить будет нельзя.');
    if (!window.confirm(q)) e.preventDefault();
  });

  var reduce =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var isMobile = function () {
    return window.matchMedia && window.matchMedia('(max-width:960px)').matches;
  };

  // --- тема: localStorage 'ftso-theme', волна смены сверху вниз -------------
  // Тем ТРИ (07.09.2026): светлая, тёмная, теплая. Выбор — в меню «Цветовая
  // тема» в шапке; сама смена и «волна» здесь же, чтобы не расходились.
  var THEME_KEY = 'ftso-theme';
  var THEMES = ['light', 'dark', 'warm'];
  var themeTimer = null;

  function currentTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    return THEMES.indexOf(t) >= 0 ? t : 'light';
  }

  function applyTheme(next) {
    if (THEMES.indexOf(next) < 0 || next === currentTheme()) return;

    if (!reduce) {
      var h = document.documentElement.scrollHeight || 1;
      var maxDelay = 2.6; // сек — разброс задержки сверху вниз
      var els = document.querySelectorAll(
        '.site-header, main > section, .site-footer, .table-scroll, .stat, .info-card, .reg-card, .news-card',
      );
      Array.prototype.forEach.call(els, function (el) {
        var top = el.getBoundingClientRect().top + window.scrollY;
        el.style.transitionDelay =
          (Math.min(1, Math.max(0, top / h)) * maxDelay).toFixed(3) + 's';
      });
      clearTimeout(themeTimer);
      // задержки снимаем после завершения, чтобы не тормозить ховеры
      themeTimer = setTimeout(function () {
        Array.prototype.forEach.call(els, function (el) {
          el.style.transitionDelay = '';
        });
      }, 7600);
    }

    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (e) {
      /* приватный режим — тема просто не запомнится */
    }
  }

  // --- высота липкой плашки «режим разработки» ------------------------------
  // Плашка прилипает к верху, шапка садится под неё. Высота плашки зависит от
  // ширины экрана (текст переносится), в CSS её не вычислить — меряем и кладём
  // в переменную. Пересчитываем на resize: поворот телефона меняет число строк.
  var devNotice = document.querySelector('.dev-notice');
  if (devNotice) {
    var syncNoticeHeight = function () {
      document.documentElement.style.setProperty('--dev-notice-h', devNotice.offsetHeight + 'px');
    };
    syncNoticeHeight();
    window.addEventListener('resize', syncNoticeHeight);
    // Шрифты догружаются после первого кадра и могут изменить высоту строки.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncNoticeHeight);
  }

  // --- появление секций при прокрутке --------------------------------------
  // Секции въезжают снизу по одной, каждая один раз. Без IntersectionObserver
  // и при reduced-motion класс .reveal не вешается вовсе — страница обычная.
  var revealNodes = [];
  function revealAll() {
    revealNodes.forEach(function (n) { n.classList.add('is-in'); });
  }
  if (!reduce && 'IntersectionObserver' in window) {
    revealNodes = Array.prototype.slice.call(document.querySelectorAll('main > section'));
    if (revealNodes.length) {
      revealNodes.forEach(function (n, i) {
        n.classList.add('reveal');
        n.style.transitionDelay = (i * 0.12).toFixed(2) + 's';
      });
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        });
      }, { rootMargin: '0px 0px -6% 0px', threshold: 0.04 });
      revealNodes.forEach(function (n) { io.observe(n); });
      // Страховка: если наблюдатель по какой-то причине не отработал, через
      // 2,5 с показываем всё — пустая страница хуже любого эффекта.
      setTimeout(revealAll, 2500);
    }
  }

  // --- меню «Цветовая тема» -------------------------------------------------
  var themeMenu = document.querySelector('[data-theme-menu]');
  if (themeMenu) {
    var themeBtn = themeMenu.querySelector('[data-theme-menu-btn]');
    var picks = Array.prototype.slice.call(themeMenu.querySelectorAll('[data-theme-pick]'));
    var markCurrent = function () {
      var cur = currentTheme();
      picks.forEach(function (b) {
        b.setAttribute('aria-current', b.getAttribute('data-theme-pick') === cur ? 'true' : 'false');
      });
    };
    var closeTheme = function () {
      themeMenu.classList.remove('is-open');
      themeBtn.setAttribute('aria-expanded', 'false');
    };
    themeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = themeMenu.classList.toggle('is-open');
      themeBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) {
      if (themeMenu.classList.contains('is-open') && !themeMenu.contains(e.target)) closeTheme();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && themeMenu.classList.contains('is-open')) {
        closeTheme();
        themeBtn.focus();
      }
    });
    picks.forEach(function (b) {
      b.addEventListener('click', function () {
        closeTheme();
        var next = b.getAttribute('data-theme-pick');
        var changed = next !== currentTheme();
        applyTheme(next);
        markCurrent();
        // Смена темы — блоки гаснут и въезжают заново (ТЗ оформления 07.09.2026).
        if (changed && !reduce && revealNodes.length) {
          revealNodes.forEach(function (n) { n.classList.remove('is-in'); });
          setTimeout(revealAll, 120);
        }
      });
    });
    markCurrent();
  }

  // --- бургер-меню ---------------------------------------------------------
  var burger = document.querySelector('[data-burger]');
  var menu = document.getElementById('primary-menu');
  if (burger && menu) {
    burger.addEventListener('click', function () {
      var open = menu.classList.toggle('is-open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) {
      if (!menu.classList.contains('is-open')) return;
      if (menu.contains(e.target) || burger.contains(e.target)) return;
      menu.classList.remove('is-open');
      burger.setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menu.classList.contains('is-open')) {
        menu.classList.remove('is-open');
        burger.setAttribute('aria-expanded', 'false');
        burger.focus();
      }
    });
  }

  // --- «Ещё»: выпадающий список остальных разделов (только на десктопе) -----
  var moreBtn = document.querySelector('[data-more]');
  if (moreBtn) {
    var moreWrap = moreBtn.parentElement;
    var closeMore = function () {
      moreWrap.classList.remove('is-open');
      moreBtn.setAttribute('aria-expanded', 'false');
    };
    moreBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = moreWrap.classList.toggle('is-open');
      moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) {
      if (moreWrap.classList.contains('is-open') && !moreWrap.contains(e.target)) closeMore();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && moreWrap.classList.contains('is-open')) {
        closeMore();
        moreBtn.focus();
      }
    });
  }

  // --- параллакс (на мобильном и при reduced-motion выключен) ---------------
  var ticking = false;
  function applyParallax() {
    ticking = false;
    var off = reduce || isMobile();
    var vh = window.innerHeight;
    Array.prototype.forEach.call(document.querySelectorAll('[data-parallax]'), function (el) {
      if (off) {
        el.style.transform = '';
        return;
      }
      var sp = parseFloat(el.getAttribute('data-parallax')) || 0;
      var r = el.getBoundingClientRect();
      var delta = r.top + r.height / 2 - vh / 2;
      el.style.transform = 'translate3d(0,' + (-delta * sp).toFixed(1) + 'px,0)';
    });
  }
  function onScroll() {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(applyParallax);
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  applyParallax();

  // --- 3D-наклон карточек: делегированный mousemove по .fx-card ------------
  if (!reduce) {
    document.addEventListener('mousemove', function (e) {
      if (isMobile() || !e.target.closest) return;
      var card = e.target.closest('.fx-card');
      if (!card) return;
      var r = card.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width - 0.5;
      var py = (e.clientY - r.top) / r.height - 0.5;
      card.style.transform =
        'perspective(1000px) rotateY(' + px * 8 + 'deg) rotateX(' + -py * 8 + 'deg) translateY(-6px)';
    });
    document.addEventListener('mouseout', function (e) {
      if (!e.target.closest) return;
      var card = e.target.closest('.fx-card');
      if (card && (!e.relatedTarget || !card.contains(e.relatedTarget))) card.style.transform = '';
    });
  }


  // --- форма регистрации: блок законного представителя ----------------------
  //
  // ПРОГРЕССИВНОЕ УЛУЧШЕНИЕ, а не условие работы формы: без JS видны оба блока,
  // и заявка всё равно проходит — обязательность решает СЕРВЕР по дате рождения
  // (см. server/lib/validate.mjs). Здесь только убираем со страницы то, что
  // конкретному заявителю заполнять не нужно.
  var birth = document.getElementById('r-birth');
  if (birth) {
    var blocks = document.querySelectorAll('[data-minor]');
    // Скрытый блок ОТКЛЮЧАЕТСЯ целиком: его поля не валидируются браузером
    // (иначе required в невидимом поле молча блокирует отправку) и не уходят на сервер.
    var setBlock = function (el, hidden) {
      el.hidden = hidden;
      Array.prototype.forEach.call(el.querySelectorAll('input, select, textarea'), function (i) { i.disabled = hidden; });
    };
    var syncMinor = function () {
      var v = birth.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        // Даты ещё нет — форма ВЗРОСЛОГО целиком (почта и чекбокс согласия видны сразу:
        // аудит формы ищет чекбокс, не заполняя её), блок представителя добавится по дате.
        Array.prototype.forEach.call(blocks, function (el) { setBlock(el, el.getAttribute('data-minor') === 'minor'); });
        return;
      }
      var p = v.split('-');
      var now = new Date();
      var age = now.getFullYear() - Number(p[0]);
      var m = now.getMonth() + 1 - Number(p[1]);
      if (m < 0 || (m === 0 && now.getDate() < Number(p[2]))) age -= 1;
      var minor = age < 18;
      Array.prototype.forEach.call(blocks, function (el) {
        var want = el.getAttribute('data-minor');
        setBlock(el, want === 'minor' ? !minor : minor);
      });
    };
    birth.addEventListener('input', syncMinor);
    birth.addEventListener('change', syncMinor);
    birth.addEventListener('blur', syncMinor);
    syncMinor();
  }

  // Кнопка «Скопировать» у одноразового секрета (data-copy).
  Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (btn) {
    btn.addEventListener('click', function () {
      var value = btn.getAttribute('data-copy');
      var done = function () { btn.textContent = 'Скопировано'; btn.disabled = true; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done, function () { window.prompt('Скопируйте вручную:', value); });
      } else {
        window.prompt('Скопируйте вручную:', value);
      }
    });
  });

  // Показать/скрыть пароль: кнопка у каждого поля пароля. Живёт здесь, а не в
  // шаблонах: CSP разрешает скрипты только из этого файла.
  Array.prototype.forEach.call(document.querySelectorAll('input[type="password"]'), function (input) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', 'Показать пароль');
    btn.textContent = 'Показать';
    btn.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      btn.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
      btn.textContent = show ? 'Скрыть' : 'Показать';
      input.focus();
    });
    var wrap = document.createElement('span');
    wrap.className = 'pw-field';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    wrap.appendChild(btn);
  });

  // Строки таблицы турниров — кликабельны целиком (в макете row как ссылка).
  Array.prototype.forEach.call(document.querySelectorAll('tr[data-href]'), function (row) {
    row.addEventListener('click', function (e) {
      if (e.target.closest('a')) return;
      window.location.href = row.getAttribute('data-href');
    });
  });

  // ПАЧКА ФОТО: сервер режет тело запроса на своём пороге, и делает это ДО нашего кода —
  // пользователь видел бы сырую страницу 413 без объяснений. Считаем сумму заранее.
  Array.prototype.forEach.call(document.querySelectorAll('input[type="file"][data-max-mb]'), function (input) {
    var limit = Number(input.getAttribute('data-max-mb')) || 0;
    if (!limit) return;
    var form = input.form;
    var note = form ? form.querySelector('[data-size-warning]') : null;
    var tooBig = false;
    var check = function () {
      var total = 0;
      Array.prototype.forEach.call(input.files || [], function (f) { total += f.size; });
      var mb = total / (1024 * 1024);
      tooBig = mb > limit;
      if (!note) return;
      if (tooBig) {
        note.textContent = 'Выбрано ' + mb.toFixed(1) + ' МБ, сервер примет до ' + limit + ' МБ. Загрузите частями.';
        note.hidden = false;
      } else {
        note.hidden = true;
        note.textContent = '';
      }
    };
    input.addEventListener('change', check);
    if (form) {
      form.addEventListener('submit', function (e) {
        check();
        if (tooBig) { e.preventDefault(); if (note) note.scrollIntoView({ block: 'center' }); }
      });
    }
  });

  // КАЛЕНДАРЬ ТУРНИРОВ С ДОРОЖКАМИ (18.09.2026).
  // Десктоп: навёл на день — полосы, не проходящие через него, гаснут.
  // Телефон: нажал на день — под сеткой раскрывается его список; полосы там скрыты CSS.
  document.querySelectorAll('.cal__grid').forEach(function (grid) {
    var bars = Array.prototype.slice.call(grid.querySelectorAll('.cal__bar'));
    var lists = document.querySelector('[data-cal-lists]');
    var covers = function (bar, iso) { return bar.getAttribute('data-from') <= iso && iso <= bar.getAttribute('data-to'); };
    // ВЕСЬ ТУРНИР ПОДНИМАЕТСЯ: кусок на соседней неделе подсвечивается вместе с тем, на который навели.
    grid.addEventListener('mouseover', function (e) {
      var bar = e.target.closest('.cal__bar'); if (!bar) return;
      var id = bar.getAttribute('data-id');
      bars.forEach(function (b) { b.classList.toggle('is-hover', b !== bar && b.getAttribute('data-id') === id); });
    });
    grid.addEventListener('mouseout', function (e) {
      if (e.target.closest('.cal__bar')) bars.forEach(function (b) { b.classList.remove('is-hover'); });
    });
    // ОДИНАКОВЫЕ КЛЕТКИ: все дорожки месяца — высотой с самую высокую полосу.
    var fit = function () {
      if (window.matchMedia('(max-width: 720px)').matches) { grid.style.removeProperty('--cal-bar-h'); return; }
      grid.style.removeProperty('--cal-bar-h');
      var h = 0;
      bars.forEach(function (b) { h = Math.max(h, b.offsetHeight); });
      if (h) grid.style.setProperty('--cal-bar-h', (h + 7) + 'px'); // 7px — верхний отступ полосы
      // Корт — по реальной форме ячейки: выше, чем шире → вертикальный.
      var cell = grid.querySelector('.cal__cell[data-day]');
      if (cell) { var r = cell.getBoundingClientRect(); grid.classList.toggle('is-tall', r.height > r.width); grid.classList.toggle('is-wide', r.height <= r.width); }
    };
    fit(); window.addEventListener('resize', fit);
    grid.addEventListener('mouseover', function (e) {
      var cell = e.target.closest('.cal__cell[data-day]');
      if (!cell) return;
      // Гасим чужие полосы только над днём, в котором что-то есть: над пустым днём гасить
      // нечего, а единственный турнир месяца блек от любого движения мыши (скрин владельца 18.09).
      if (!cell.classList.contains('has-items')) { bars.forEach(function (b) { b.classList.remove('is-dim'); }); return; }
      var iso = cell.getAttribute('data-day');
      bars.forEach(function (b) { b.classList.toggle('is-dim', !covers(b, iso)); });
    });
    grid.addEventListener('mouseout', function (e) {
      if (e.target.closest('.cal__cell[data-day]')) bars.forEach(function (b) { b.classList.remove('is-dim'); });
    });
    var open = function (iso) {
      if (!lists) return;
      var any = false;
      lists.querySelectorAll('.cal__daylist').forEach(function (l) { var on = l.getAttribute('data-day') === iso; l.hidden = !on; any = any || on; });
      grid.querySelectorAll('.cal__cell').forEach(function (c) { c.classList.toggle('is-selected', c.getAttribute('data-day') === iso && any); });
    };
    grid.addEventListener('click', function (e) {
      if (e.target.closest('.cal__bar')) return; // по полосе — переход на турнир
      var cell = e.target.closest('.cal__cell.has-items');
      if (cell) open(cell.getAttribute('data-day'));
    });
    grid.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var cell = e.target.closest('.cal__cell.has-items');
      if (cell) { e.preventDefault(); open(cell.getAttribute('data-day')); }
    });
    // На телефоне сразу показываем сегодняшний день, если в нём что-то есть, иначе первый непустой.
    var today = grid.querySelector('.cal__cell.is-today.has-items') || grid.querySelector('.cal__cell.has-items');
    if (today && lists && window.matchMedia('(max-width: 720px)').matches) open(today.getAttribute('data-day'));
  });

  // ЗОНА ФАЙЛА (18.09.2026). Публичные формы размечены на сервере (.file-drop готов), в
  // админке обёртка строится здесь вокруг любого input[type=file] — «делай для всех».
  // Без JS остаётся обычное поле. Файл кладётся в тот же input, формы не меняются.
  var fmtSize = function (n) { return n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' КБ' : (n / 1048576).toFixed(1).replace('.', ',') + ' МБ'; };
  var canDrag = window.matchMedia('(hover: hover)').matches && typeof DataTransfer !== 'undefined';
  var initFileDrop = function (box) {
    var input = box.querySelector('input[type="file"]');
    var nameEl = box.querySelector('[data-file-name]');
    var listEl = box.querySelector('[data-file-list]');
    if (!input || (!nameEl && !listEl)) return;
    // Накопительный режим (multiple + список): новый выбор ДОБАВЛЯЕТСЯ к уже лежащим,
    // а не заменяет их — иначе три документа по одному не собрать (замечание владельца 18.09).
    var multi = !!listEl && input.multiple;
    var max = Number(box.getAttribute('data-file-max')) || (input.multiple ? 20 : 1);
    var kept = [];
    var setFiles = function (arr) {
      if (typeof DataTransfer === 'undefined') return;
      var dt = new DataTransfer(); arr.forEach(function (f) { dt.items.add(f); }); input.files = dt.files;
    };
    var delBtn = function (onClick) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'file-drop__del'; b.textContent = 'Удалить';
      b.addEventListener('click', onClick); return b;
    };
    var render = function () {
      var files = multi ? kept : (input.files ? Array.prototype.slice.call(input.files) : []);
      if (listEl) {
        listEl.innerHTML = '';
        files.forEach(function (f, i) {
          var li = document.createElement('li'); li.className = 'file-drop__item';
          var t = document.createElement('span'); t.textContent = f.name + ' · ' + fmtSize(f.size); li.appendChild(t);
          li.appendChild(delBtn(function () { kept.splice(i, 1); setFiles(kept); render(); }));
          listEl.appendChild(li);
        });
        listEl.hidden = !files.length;
        box.classList.toggle('has-file', files.length > 0);
        box.classList.toggle('is-full', files.length >= max);
        var zoneText = box.querySelector('.file-drop__text b');
        if (zoneText) zoneText.textContent = files.length >= max ? 'Больше нельзя — до ' + max + ' файлов' : (files.length ? 'Добавить ещё файл' : 'Добавить файл');
        return;
      }
      nameEl.innerHTML = '';
      if (!files.length) { nameEl.hidden = true; box.classList.remove('has-file'); return; }
      var text = files.length === 1 ? files[0].name + ' · ' + fmtSize(files[0].size)
        : files.length + ' ' + (files.length < 5 ? 'файла' : 'файлов') + ': ' + files.map(function (f) { return f.name; }).join(', ');
      nameEl.appendChild(document.createTextNode(text));
      nameEl.appendChild(delBtn(function () { input.value = ''; render(); }));
      nameEl.hidden = false; box.classList.add('has-file');
    };
    var accept = function (list) {
      var arr = Array.prototype.slice.call(list);
      if (!arr.length) return;
      if (multi) {
        arr.forEach(function (f) {
          var dup = kept.some(function (k) { return k.name === f.name && k.size === f.size; });
          if (!dup && kept.length < max) kept.push(f);
        });
        setFiles(kept);
      } else if (input.multiple) setFiles(arr);
      else setFiles(arr.slice(0, 1));
      render();
    };
    input.addEventListener('change', function () { if (multi) { accept(input.files); } else render(); });
    if (canDrag) {
      ['dragenter', 'dragover'].forEach(function (ev) { box.addEventListener(ev, function (e) { e.preventDefault(); box.classList.add('is-over'); }); });
      ['dragleave', 'drop'].forEach(function (ev) { box.addEventListener(ev, function (e) { e.preventDefault(); box.classList.remove('is-over'); }); });
      box.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) accept(e.dataTransfer.files); });
    }
    render();
  };
  document.querySelectorAll('[data-file-drop]').forEach(initFileDrop);
  // Админка: обёртка вокруг голого поля. Компактный вид — если поле без своей подписи (стоит в таблице).
  document.querySelectorAll('input[type="file"]').forEach(function (input) {
    if (input.closest('[data-file-drop]')) return;
    if (!input.id) input.id = 'file-' + Math.random().toString(36).slice(2, 8);
    var hasLabel = !!document.querySelector('label[for="' + input.id + '"]');
    var compact = !hasLabel || input.hasAttribute('data-file-compact');
    var box = document.createElement('div'); box.className = 'file-drop' + (compact ? ' file-drop--compact' : ''); box.setAttribute('data-file-drop', '');
    input.parentNode.insertBefore(box, input);
    input.classList.add('file-drop__input'); box.appendChild(input);
    var zone = document.createElement('label'); zone.className = 'file-drop__zone'; zone.htmlFor = input.id;
    var icon = document.createElement('span'); icon.className = 'file-drop__icon'; icon.setAttribute('aria-hidden', 'true');
    var text = document.createElement('span'); text.className = 'file-drop__text';
    var isImage = input.accept && /image/.test(input.accept);
    var b = document.createElement('b'); b.textContent = compact ? (isImage ? 'Изображение' : 'Файл') : (input.multiple ? 'Выберите файлы' : (isImage ? 'Выберите изображение' : 'Выберите файл'));
    text.appendChild(b);
    if (!compact) { var or = document.createElement('span'); or.className = 'file-drop__or'; or.textContent = ' или перетащите сюда'; text.appendChild(or); }
    zone.appendChild(icon); zone.appendChild(text);
    if (!compact && input.accept) { var meta = document.createElement('span'); meta.className = 'file-drop__meta'; meta.textContent = input.accept.replace(/application\/[^,]+/g, '').replace(/image\/\*/, 'изображение').replace(/text\/csv/, '').split(',').map(function (x) { return x.trim().replace(/^\./, '').toUpperCase(); }).filter(Boolean).join(', '); zone.appendChild(meta); }
    var nameEl = document.createElement('span'); nameEl.className = 'file-drop__name'; nameEl.setAttribute('data-file-name', ''); nameEl.hidden = true;
    box.appendChild(zone); box.appendChild(nameEl);
    initFileDrop(box);
  });

  // ЧЛЕНСКИЙ ВЗНОС (19.09.2026): QR собирается в браузере — ФИО плательщика на сервер не уходит.
  // Строка по ГОСТ Р 56042-2014: заготовка с сервера (реквизиты) + назначение с ФИО и годом + сумма в копейках.
  var dues = document.querySelector('[data-dues]');
  if (dues) {
    var form = dues.querySelector('[data-dues-form]');
    var out = dues.querySelector('[data-dues-code]');
    var purposeOut = dues.querySelector('[data-dues-purpose-out]');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = form.name.value.trim().replace(/\s+/g, ' ').replace(/\|/g, ' ');
      var sum = Number(String(form.sum.value).replace(/[^\d]/g, ''));
      if (!name) { form.name.focus(); return; }
      if (!(sum >= 10 && sum <= 1000000)) { form.sum.focus(); return; }
      // «И.И.. НДС» — инициалы с точкой упираются в точку шаблона: двойную точку схлопываем.
      var purpose = dues.getAttribute('data-dues-purpose').replace('{year}', dues.getAttribute('data-dues-year')).replace('{name}', name).replace(/\.\./g, '.').slice(0, 210);
      var payload = dues.getAttribute('data-dues-prefix') + '|Purpose=' + purpose + '|Sum=' + Math.round(sum * 100);
      if (!window.QRCode || !window.QRCode.toString) { out.hidden = false; out.textContent = 'Не удалось собрать код — переведите по реквизитам справа.'; return; }
      window.QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#0b1f18', light: '#ffffff' } }, function (err, svg) {
        if (err) { out.hidden = false; out.textContent = 'Не удалось собрать код — переведите по реквизитам справа.'; return; }
        out.innerHTML = svg; out.hidden = false;
        purposeOut.textContent = 'Назначение в коде: ' + purpose + ' · ' + sum.toLocaleString('ru-RU') + ' ₽';
        purposeOut.hidden = false;
        out.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    });
  }
})();
