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
  applicationInput, createApplication, getByToken, REGISTRIES,
} from '../lib/coach-applications.mjs';
import { LEGAL_VERSION_LABEL, OPERATOR } from '../lib/legal.mjs';

const STATUS_RU = { pending: 'на рассмотрении', approved: 'опубликована', rejected: 'отклонена' };

// Два реестра — одна механика. Различаются путь, набор полей и подписи.
const KINDS = {
  coaches: {
    registry: REGISTRIES.coaches, path: '/coaches', session: 'coachApplyToken',
    view: 'coach-apply', title: 'Анкета тренера — ФТСО', purpose: 'реестра тренеров',
  },
  referees: {
    registry: REGISTRIES.referees, path: '/referees', session: 'refereeApplyToken',
    view: 'referee-apply', title: 'Анкета судьи — ФТСО', purpose: 'реестра спортивных судей',
  },
};

export default function mountCoachApplication(app, { db, limitCoachApplication }) {
  for (const kind of Object.values(KINDS)) {
    const renderForm = (req, res, { errors = [], values = {}, status = 200 } = {}) => {
      res.status(status).render(kind.view, {
        title: kind.title,
        errors,
        values,
        fields: kind.registry.fields,
        legalVersionLabel: LEGAL_VERSION_LABEL,
        op: OPERATOR,
      });
    };

    app.get(`${kind.path}/apply`, (req, res) => renderForm(req, res));

    app.post(`${kind.path}/apply`, limitCoachApplication, (req, res, next) => {
      try {
        // АНТИСПАМ: приманка. Заполнена — отвечаем как при успехе, ничего не пишем.
        if (req.body.website) return res.redirect(303, `${kind.path}/apply/sent`);

        const data = applicationInput(req.body, OPERATOR, kind.registry.fields, kind.purpose);
        const { token } = createApplication(db, data, req.ip, kind.registry);
        req.session[kind.session] = token;
        return res.redirect(303, `${kind.path}/apply/sent`);
      } catch (err) {
        if (err instanceof ValidationError) {
          return renderForm(req, res, { errors: [err.message], values: req.body, status: 400 });
        }
        return next(err);
      }
    });

    app.get(`${kind.path}/apply/sent`, (req, res) => {
      const token = req.session[kind.session];
      const application = token ? getByToken(db, token, kind.registry) : null;
      res.render('coach-apply-sent', {
        title: 'Анкета отправлена — ФТСО',
        application,
        statusRu: STATUS_RU,
        op: OPERATOR,
        backPath: kind.path,
        backLabel: kind.path === '/coaches' ? 'К реестру тренеров' : 'К реестру судей',
      });
    });
  }
}
