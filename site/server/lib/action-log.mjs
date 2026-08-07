// Журнал действий (КП): каждое изменение данных -> кто, что, когда.
// action = JSON {type, object_id, diff}.
export function logAction(db, userId, type, objectId = null, diff = null) {
  db.prepare('INSERT INTO action_log (user_id, action) VALUES (?, ?)').run(
    userId ?? null,
    JSON.stringify({ type, object_id: objectId, diff }),
  );
}

export function recentActions(db, limit = 50) {
  return db
    .prepare(
      `SELECT a.id, a.action, a.at, u.username
         FROM action_log a LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.id DESC LIMIT ?`,
    )
    .all(limit)
    .map((r) => ({ ...r, parsed: JSON.parse(r.action) }));
}
