// СПОРТИВНЫЙ РАЗРЯД ИГРОКА (17.10.2026): разряд по ЕВСК, присвоенный приказом
// Минспорта Смоленской области, — показывается в профиле. Хранится в players:
// sport_rank (код), sport_rank_order (приказ текстом), sport_rank_date (дата приказа),
// sport_rank_until (срок действия; пусто — не показываем срок).

export const SPORT_RANKS = [
  { id: 'ms', label: 'Мастер спорта России' },
  { id: 'kms', label: 'Кандидат в мастера спорта' },
  { id: 'r1', label: 'I спортивный разряд' },
  { id: 'r2', label: 'II спортивный разряд' },
  { id: 'r3', label: 'III спортивный разряд' },
  { id: 'j1', label: 'I юношеский спортивный разряд' },
  { id: 'j2', label: 'II юношеский спортивный разряд' },
  { id: 'j3', label: 'III юношеский спортивный разряд' },
];
const LABEL = new Map(SPORT_RANKS.map((r) => [r.id, r.label]));

const ruDate = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.split('-').reverse().join('.') : '');

/** Строка для профиля; null — разряда нет. */
export function sportRankView(p, today = new Date().toISOString().slice(0, 10)) {
  const id = p.sportRank || p.sport_rank;
  if (!id || !LABEL.has(id)) return null;
  const until = p.sportRankUntil || p.sport_rank_until || '';
  const expired = Boolean(until && until < today);
  return {
    title: LABEL.get(id),
    order: p.sportRankOrder || p.sport_rank_order || '',
    expired,
    untilText: until ? (expired ? `срок истёк ${ruDate(until)}` : `действует до ${ruDate(until)}`) : '',
  };
}

/** Проверка ввода из админки: пустой разряд очищает все поля. */
export function sportRankInput(body) {
  const id = String(body.sport_rank || '').trim();
  if (!id) return { sport_rank: null, sport_rank_order: null, sport_rank_date: null, sport_rank_until: null };
  if (!LABEL.has(id)) throw new Error('Неизвестный спортивный разряд');
  const date = (v, name) => {
    const s = String(v || '').trim();
    if (!s) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${name}: нужна дата`);
    return s;
  };
  const order = String(body.sport_rank_order || '').trim().slice(0, 200) || null;
  return { sport_rank: id, sport_rank_order: order, sport_rank_date: date(body.sport_rank_date, 'Дата приказа'), sport_rank_until: date(body.sport_rank_until, 'Действует до') };
}
