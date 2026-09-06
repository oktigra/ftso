// МАРШРУТЫ СЕТКИ/ПРОТОКОЛА ТУРНИРА — общие для витрины и админки (06.09.2026).
// Витрина: только опубликованные турниры (черновик — 404). Админка: любые —
// секретарь ведёт турнир черновиком до публикации и именно тогда качает протокол.
import { listGroups } from './groups.mjs';
import { listBrackets } from './brackets.mjs';
import { tournamentParticipants } from './content.mjs';
import { sheetModel, tournamentPdf, tournamentDocx, tournamentProtocolXlsx } from './tournament-export.mjs';
import { TOURNAMENT_KIND_RU } from './validate.mjs';

const safeFile = (name) => name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'tournament';

export function mountTournamentSheets(app, { db, prefix, publishedOnly, erasedLabel, middlewares = [] }) {
  const load = (id) => db
    .prepare(`SELECT id, name, end_date, start_date, category, city, kind, age_group FROM tournaments WHERE id = ?${publishedOnly ? ' AND is_published = 1' : ''}`)
    .get(id);
  const model = (id) => {
    const tournament = load(id);
    if (!tournament) return null;
    return sheetModel({ tournament, groups: listGroups(db, id), brackets: listBrackets(db, id), results: tournamentParticipants(db, id, { erasedLabel }) });
  };
  const idOf = (req) => (/^\d+$/.test(req.params.id) ? Number(req.params.id) : null);
  const attach = (res, ext, id, title, mime) => {
    res.type(mime);
    res.setHeader('Content-Disposition', `attachment; filename="${ext === 'xlsx' ? 'protocol' : 'bracket'}-${id}.${ext}"; filename*=UTF-8''${encodeURIComponent(safeFile(title) + (ext === 'xlsx' ? ' — протокол' : '') + '.' + ext)}`);
  };

  app.get(`${prefix}/:id/bracket.pdf`, ...middlewares, async (req, res, next) => {
    const id = idOf(req); const m = id && model(id);
    if (!m) return next();
    try { attach(res, 'pdf', id, m.title, 'application/pdf'); res.send(await tournamentPdf(m)); } catch (err) { next(err); }
  });
  app.get(`${prefix}/:id/bracket.docx`, ...middlewares, async (req, res, next) => {
    const id = idOf(req); const m = id && model(id);
    if (!m) return next();
    try { attach(res, 'docx', id, m.title, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); res.send(await tournamentDocx(m)); } catch (err) { next(err); }
  });
  app.get(`${prefix}/:id/protocol.xlsx`, ...middlewares, (req, res, next) => {
    const id = idOf(req); const m = id && model(id);
    if (!m) return next();
    attach(res, 'xlsx', id, m.title, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(tournamentProtocolXlsx(m));
  });
  app.get(`${prefix}/:id/print`, ...middlewares, (req, res, next) => {
    const id = idOf(req); const tournament = id && load(id);
    if (!tournament) return next();
    res.render('tournament-print', {
      title: `${tournament.name} — сетка и результаты — ФТСО`,
      tournament,
      kindRu: TOURNAMENT_KIND_RU,
      groups: listGroups(db, id),
      brackets: listBrackets(db, id),
      results: tournamentParticipants(db, id, { erasedLabel }),
      filesPrefix: `${prefix}/${id}`,
      backHref: publishedOnly ? `/tournaments/${id}` : `/admin/tournaments/${id}/results`,
    });
  });
}
