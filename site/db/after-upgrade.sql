-- ЧТО НАКАТЫВАЕТСЯ ПОСЛЕ ПЕРЕСБОРКИ ТАБЛИЦ.
--
-- Здесь всё, что ссылается на consents.guardian_id: триггеры неизменяемости
-- журнала и индекс поиска по представителю. Вынесено из schema.sql намеренно —
-- на базе, поднятой с прежней схемы, этой колонки в момент применения
-- schema.sql ещё нет, и CREATE упал бы «no such column».
-- Порядок в db/migrate.mjs: таблицы -> пересборка и доливка колонок -> ЭТОТ файл.
-- Идемпотентно: CREATE ... IF NOT EXISTS.
PRAGMA foreign_keys = ON;

-- Поиск согласий по субъекту-представителю (его права по ст. 14 и срок хранения).
CREATE INDEX IF NOT EXISTS idx_consents_guardian ON consents (guardian_id, kind, id DESC);

-- UPDATE запрещён ЦЕЛИКОМ, кроме ОДНОГО перехода: доливки player_id/guardian_id
-- к записи, сделанной в момент подачи заявки (субъекта в БД тогда ещё не было).
-- Доливка идёт только NULL -> значение и ничего другого в строке не трогает,
-- поэтому содержание согласия остаётся ровно тем, что принял человек.
CREATE TRIGGER IF NOT EXISTS consents_immutable_update
BEFORE UPDATE ON consents FOR EACH ROW
WHEN NOT (
      NEW.id            IS OLD.id
  AND NEW.registration_id IS OLD.registration_id
  AND NEW.subject_ref   IS OLD.subject_ref
  AND NEW.kind          IS OLD.kind
  AND NEW.event         IS OLD.event
  AND NEW.legal_version IS OLD.legal_version
  AND NEW.source        IS OLD.source
  AND NEW.basis         IS OLD.basis
  AND NEW.document_date IS OLD.document_date
  AND NEW.ip            IS OLD.ip
  AND NEW.at            IS OLD.at
  AND (NEW.player_id   IS OLD.player_id   OR (OLD.player_id   IS NULL AND NEW.player_id   IS NOT NULL))
  AND (NEW.guardian_id IS OLD.guardian_id OR (OLD.guardian_id IS NULL AND NEW.guardian_id IS NOT NULL))
)
BEGIN
  SELECT RAISE(ABORT, 'consents: запись журнала согласий неизменяема — отзыв оформляется НОВОЙ строкой');
END;

CREATE TRIGGER IF NOT EXISTS consents_immutable_delete
BEFORE DELETE ON consents FOR EACH ROW
WHEN (SELECT erasure_open FROM consents_gate WHERE id = 1) = 0
BEGIN
  SELECT RAISE(ABORT, 'consents: запись журнала согласий не удаляется — только через withConsentErasure (ст. 21 и срок хранения)');
END;
