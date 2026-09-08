// ПУБЛИЧНАЯ ЗАЯВКА ТРЕНЕРА В РЕЕСТР (08.09.2026).
//
// Карточка тренера — распространение персональных данных, поэтому форма собирает
// согласие по ст. 10.1 с ОТДЕЛЬНОЙ отметкой по каждому полю: что не отмечено, то
// не публикуется. Заявка уходит на модерацию, сама на сайт ничего не выводит.
//
// Файлов форма не принимает намеренно: фото тренера — отдельный шаг, его загружает
// секретарь после проверки согласия.
import { ValidationError } from '../lib/validate.mjs';
import {
  applicationInput, createApplication, getByToken, OPTIONAL_FIELDS,
} from '../lib/coach-applications.mjs';
import { LEGAL_VERSION_LABEL, OPERATOR } from '../lib/legal.mjs';

const STATUS_RU = { pending: 'на рассмотрении', approved: 'опубликована', rejected: 'отклонена' };

export default function mountCoachApplication(app, { db, limitCoachApplication }) {
  function renderForm(req, res, { errors = [], values = {}, status = 200 } = {}) {
    res.status(status).render('coach-apply', {
      title: 'Анкета тренера — ФТСО',
      errors,
      values,
      fields: OPTIONAL_FIELDS,
      legalVersionLabel: LEGAL_VERSION_LABEL,
      op: OPERATOR,
    });
  }

  app.get('/coaches/apply', (req, res) => renderForm(req, res));

  app.post('/coaches/apply', limitCoachApplication, (req, res, next) => {
    try {
      // АНТИСПАМ: приманка. Заполнена — отвечаем как при успехе, ничего не пишем.
      if (req.body.website) return res.redirect(303, '/coaches/apply/sent');

      const data = applicationInput(req.body, OPERATOR);
      const { token } = createApplication(db, data, req.ip);
      req.session.coachApplyToken = token;
      return res.redirect(303, '/coaches/apply/sent');
    } catch (err) {
      if (err instanceof ValidationError) {
        return renderForm(req, res, { errors: [err.message], values: req.body, status: 400 });
      }
      return next(err);
    }
  });

  app.get('/coaches/apply/sent', (req, res) => {
    const token = req.session.coachApplyToken;
    const app_ = token ? getByToken(db, token) : null;
    res.render('coach-apply-sent', {
      title: 'Анкета отправлена — ФТСО',
      application: app_,
      statusRu: STATUS_RU,
      op: OPERATOR,
    });
  });
}
