// ПУБЛИЧНАЯ РЕГИСТРАЦИЯ ИГРОКА.
//
// Путь: форма -> заявка в БД + две записи в журнал согласий -> МОДЕРАЦИЯ ->
// игрок. Прямой записи в players отсюда нет: попасть в players значит попасть
// в открытый рейтинг, и решение об этом принимает человек, а не отправитель формы.
import { registrationInput, ValidationError } from '../lib/validate.mjs';
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
      // ДВЕ РАЗДЕЛЬНЫЕ отметки (ч. 6 ст. 10.1). Обработка обязательна — без неё
      // нет основания. Публикация добровольна: отказ не мешает подать заявку.
      const acceptProcessing = req.body.consent_processing === '1';
      const acceptDistribution = req.body.consent_distribution === '1';
      if (!acceptProcessing) {
        throw new ValidationError(
          'Без согласия на обработку персональных данных заявку принять нельзя — это её правовое основание.',
        );
      }

      // Черновик держим до успеха: упадёт валидация — поля вернутся заполненными.
      req.session.registerDraft = {
        ...data,
        consent_processing: acceptProcessing,
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
          full_name: req.body.full_name,
          city: req.body.city,
          sex: req.body.sex,
          age_group: req.body.age_group,
          email: req.body.email,
          consent_processing: req.body.consent_processing === '1',
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
