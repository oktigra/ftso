// Поведение публичной части: тема, бургер, параллакс, 3D-наклон карточек.
// Перенесено из логики макета (DCLogic) в обычный DOM без рантайма прототипа.
// Файл внешний, а не инлайн: строгий CSP (script-src 'self') инлайн бы заблокировал.
(function () {
  'use strict';

  var reduce =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var isMobile = function () {
    return window.matchMedia && window.matchMedia('(max-width:960px)').matches;
  };

  // --- тема: localStorage 'ftso-theme', волна смены сверху вниз -------------
  var THEME_KEY = 'ftso-theme';
  var themeTimer = null;

  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    var next = cur === 'dark' ? 'light' : 'dark';

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

  var toggle = document.querySelector('[data-theme-toggle]');
  if (toggle) toggle.addEventListener('click', toggleTheme);

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
    var syncMinor = function () {
      var v = birth.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        // Дата не введена или неполна — показываем всё: угадывать не наше дело.
        Array.prototype.forEach.call(blocks, function (el) { el.hidden = false; });
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
        el.hidden = want === 'minor' ? !minor : minor;
      });
    };
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
})();
