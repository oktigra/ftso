// ПУБЛИЧНАЯ РЕГИСТРАЦИЯ ИГРОКА.
//
// Путь: форма -> заявка в БД + две записи в журнал согласий -> МОДЕРАЦИЯ ->
// игрок. Прямой записи в players отсюда нет: попасть в players значит попасть
// в открытый рейтинг, и решение об этом принимает человек, а не отправитель формы.
import { registrationInput, ValidationError, splitName } from '../lib/validate.mjs';
import { createRegistration, byToken } from '../lib/registrations.mjs';
import { queueMail, flushOutbox, mailSubmitted } from '../lib/mailer.mjs';
import { LEGAL_VERSION_LABEL, OPERATOR } from '../lib/legal.mjs';

const STATUS_RU = {
  pending: 'на рассмотрении',
  approved: 'одобрена',
  rejected: 'отклонена',
};

export default function mountRegister(app, { db, config, limitRegister }) {
  /** Черновик в сессии: ошибка валидации не должна стирать введённое. */
  const draft = (req) => req.session.registerDraft || {};
  const splitNameFields = (full, prefix = '') => {
    const p = splitName(full); const k = (n) => (prefix ? `${prefix}_${n}` : n);
    return { [k('last_name')]: p.last, [k('first_name')]: p.first, [k('middle_name')]: p.middle };
  };

  function renderForm(req, res, { errors = [], status = 200 } = {}) {
    res.status(status).render('register', {
      title: 'Регистрация игрока — ФТСО',
      errors,
      values: draft(req),
      legalVersionLabel: LEGAL_VERSION_LABEL,
      op: OPERATOR,
    });
  }

  app.get('/register', (req, res) => renderForm(req, res));

  app.post('/register', limitRegister, async (req, res, next) => {
    try {
      // АНТИСПАМ: поле-приманка, скрытое от человека и видимое боту. Заполнено —
      // отвечаем как при успехе, но ничего не пишем: бот не должен понять, что
      // его отсеяли, а человек сюда не попадёт.
      if (String(req.body.website || '').trim() !== '') {
        return res.redirect('/register/sent');
      }

      const data = registrationInput(req.body);
      // РАЗДЕЛЬНЫЕ отметки (ч. 6 ст. 10.1). Обработка обязательна — без неё
      // нет основания. Публикация добровольна: отказ не мешает подать заявку.
      const acceptDistribution = req.body.consent_distribution === '1';

      if (data.guardian) {
        // НЕСОВЕРШЕННОЛЕТНИЙ: обе отметки представителя обязательны и проверяются
        // ПОРОЗНЬ, потому что у них разные субъекты. Согласие за ребёнка без
        // согласия представителя на СВОИ данные невозможно: без данных
        // представителя нечем подтвердить, что согласие дал именно он.
        if (req.body.consent_guardian_child !== '1') {
          throw new ValidationError(
            'Без согласия законного представителя на обработку персональных данных участника ' +
              'заявку принять нельзя — это её правовое основание.',
          );
        }
        if (req.body.consent_guardian_self !== '1') {
          throw new ValidationError(
            'Нужно отдельное согласие законного представителя на обработку ЕГО СОБСТВЕННЫХ данных ' +
              '(ФИО, родство, почта): без них Федерация не может подтвердить, что согласие за ' +
              'участника дано законным представителем.',
          );
        }
      } else if (req.body.consent_processing !== '1') {
        throw new ValidationError(
          'Без согласия на обработку персональных данных заявку принять нельзя — это её правовое основание.',
        );
      }

      // Черновик держим до успеха: упадёт валидация — поля вернутся заполненными.
      req.session.registerDraft = {
        ...data,
        ...splitNameFields(data.full_name),
        ...(data.guardian
          ? {
            ...splitNameFields(data.guardian.full_name, 'guardian'),
            guardian_relation: data.guardian.relation,
            guardian_email: data.guardian.email,
            // Почту участника в черновик не возвращаем: у минора её нет.
            email: '',
          }
          : {}),
        consent_processing: req.body.consent_processing === '1',
        consent_guardian_child: req.body.consent_guardian_child === '1',
        consent_guardian_self: req.body.consent_guardian_self === '1',
        consent_distribution: acceptDistribution,
      };

      const { token } = createRegistration(db, {
        ...data,
        distribution: acceptDistribution,
        ip: req.ip,
      });

      const statusUrl = `${req.protocol}://${req.get('host')}/register/status/${token}`;
      const letter = mailSubmitted({ fullName: data.full_name, statusUrl });
      queueMail(db, { to: data.email, kind: 'registration.submitted', ...letter });
      // Отправка НЕ блокирует ответ: заявка уже принята, а письмо, если SMTP
      // недоступен, останется в очереди и будет видно в админке.
      flushOutbox(db).catch((err) => console.error('[почта] разбор очереди упал', err));

      delete req.session.registerDraft;
      req.session.registerToken = token;
      return req.session.save(() => res.redirect(`/register/status/${token}`));
    } catch (err) {
      if (err instanceof ValidationError) {
        req.session.registerDraft = {
          last_name: req.body.last_name,
          first_name: req.body.first_name,
          middle_name: req.body.middle_name,
          city: req.body.city,
          sex: req.body.sex,
          email: req.body.email,
          birth_date: req.body.birth_date,
          guardian_last_name: req.body.guardian_last_name,
          guardian_first_name: req.body.guardian_first_name,
          guardian_middle_name: req.body.guardian_middle_name,
          guardian_relation: req.body.guardian_relation,
          guardian_email: req.body.guardian_email,
          consent_processing: req.body.consent_processing === '1',
          consent_guardian_child: req.body.consent_guardian_child === '1',
          consent_guardian_self: req.body.consent_guardian_self === '1',
          consent_distribution: req.body.consent_distribution === '1',
        };
        return req.session.save(() => renderForm(req, res, { errors: err.messages, status: 400 }));
      }
      return next(err);
    }
  });

  // Отдельный адрес для отсеянного бота: страница «отправлено» без заявки.
  app.get('/register/sent', (req, res) => {
    res.render('register-status', {
      title: 'Заявка отправлена — ФТСО',
      registration: null,
      statusText: 'на рассмотрении',
      op: OPERATOR,
    });
  });

  /**
   * СТРАНИЦА СТАТУСА. Доступ по секретной ссылке: пароля у заявителя ещё нет
   * (он появится в личном кабинете), а знать решение он должен. Неверный токен —
   * 404 в стиле сайта, чтобы перебором нельзя было нащупать существующие заявки.
   */
  app.get('/register/status/:token', (req, res, next) => {
    const reg = byToken(db, req.params.token);
    if (!reg) return next();
    res.render('register-status', {
      title: 'Статус заявки — ФТСО',
      registration: reg,
      statusText: STATUS_RU[reg.status] || reg.status,
      op: OPERATOR,
    });
  });
}
