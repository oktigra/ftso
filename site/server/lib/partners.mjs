// ПАРТНЁРЫ И СПОНСОРЫ (06.09.2026): полоса под первым экраном главной и ряд в подвале.
// Показываются только активные и только с логотипом; приглашение «станьте партнёром»
// висит всегда последним слотом и ведёт на форму обратной связи.
export function activePartners(db) {
  return db
    .prepare('SELECT id, name, url, logo_upload_id FROM partners WHERE is_active = 1 AND logo_upload_id IS NOT NULL ORDER BY sort, id')
    .all();
}

export function allPartners(db) {
  return db.prepare('SELECT id, name, url, logo_upload_id, sort, is_active FROM partners ORDER BY sort, id').all();
}
