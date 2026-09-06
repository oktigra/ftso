// ПУБЛИЧНЫЙ ПРОФИЛЬ ИГРОКА — /player/:id (ТЗ ред. 6, модель РТТ).
//
// Адрес — числовой id, как /player/44931 у РТТ, не транслит ФИО. Профиль есть у
// КАЖДОГО игрока, кроме обезличенного по ст. 21 — у анонимной вершины графа
// матчей личной страницы нет (404). Согласия и возраст на существование профиля
// не влияют: результаты соревнований публикуются на основании участия.
//
// Фотография — /player/:id/photo: то же изображение, что в кабинете, встроенно
// и без кэша (см. sendUploadInline). Удалена в кабинете -> 404 здесь сразу.
import { playerRatingHistory, playerProfile, statusLabel, DISCIPLINE_RU } from '../lib/rating-service.mjs';
import { uploadById, sendUploadInline } from '../lib/uploads.mjs';
import { AGE_SLICES } from '../lib/age.mjs';
import { SECTIONS } from '../lib/nav.mjs';

const SEX_RU = { M: 'муж.', F: 'жен.' };

export default function mountPlayer(app, { db, config }) {
  app.get('/player/:id', (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    const profile = playerProfile(db, Number(req.params.id));
    const history = profile && !profile.anonymized ? playerRatingHistory(db, Number(req.params.id), 'single') : { points: [], best: null };
    // Тренер и игрок — разные записи с разными основаниями публикации; здесь только метка связи.
    const coach = profile && !profile.anonymized ? db.prepare('SELECT id, club, city FROM coaches WHERE player_id = ?').get(Number(req.params.id)) : null;
    if (!profile) return next(); // -> общий 404-обработчик
    res.render('player', {
      title: `${profile.fullName} — профиль игрока — ФТСО`,
      metaDescription: `${profile.fullName}${profile.city ? ', ' + profile.city : ''} — результаты соревнований, рейтинговые очки и сыгранные матчи на сайте Федерации тенниса Смоленской области.`,
      profile,
      history,
      coach,
      sexRu: SEX_RU,
      disciplineRu: DISCIPLINE_RU,
      statusText: profile.rating ? statusLabel(profile.rating.status) : null,
      sliceLabels: new Map(AGE_SLICES.map((s) => [s.id, s.label])),
      section: SECTIONS.find((s) => s.path === '/rating'),
    });
  });

  app.get('/player/:id/photo', (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    const row = db
      .prepare('SELECT photo_upload_id, anonymized_at FROM players WHERE id = ?')
      .get(Number(req.params.id));
    if (!row || row.anonymized_at || !row.photo_upload_id) return next();
    const upload = uploadById(db, row.photo_upload_id);
    if (!upload || !sendUploadInline(req, res, upload, config.upload.dir)) return next();
  });
}
