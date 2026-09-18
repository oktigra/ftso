// ПОЖЕРТВОВАНИЯ НА РАСЧЁТНЫЙ СЧЁТ ФЕДЕРАЦИИ — платёжный QR по ГОСТ Р 56042-2014
// (просьба владельца 19.09.2026). Его читают приложения всех российских банков:
// человек сканирует, видит реквизиты и сумму, подтверждает — деньги уходят напрямую
// на счёт, без посредников и комиссий получателя. Сайт при этом не собирает никаких
// данных плательщика — платёж целиком в его банке.
//
// ВКЛЮЧЕНИЕ: четыре строки в .env — DONATE_ACCOUNT (р/с), DONATE_BIC, DONATE_BANK,
// DONATE_CORR (корсчёт). Пока хоть одна пуста, страница /donate отдаёт 404 и ссылки на
// неё не показываются: выкатывать QR с неверными реквизитами нельзя — деньги уйдут не туда.
import QRCode from 'qrcode';
import { OPERATOR } from './legal.mjs';

const PURPOSE_DEFAULT = 'Добровольное пожертвование на уставную деятельность. НДС не облагается';

/** Настройки пожертвований из окружения. enabled — все обязательные реквизиты заданы и корректны. */
export function donateConfig(env = process.env) {
  const account = String(env.DONATE_ACCOUNT || '').replace(/\s+/g, '');
  const bic = String(env.DONATE_BIC || '').replace(/\s+/g, '');
  const corr = String(env.DONATE_CORR || '').replace(/\s+/g, '');
  const bank = String(env.DONATE_BANK || '').trim();
  const purpose = String(env.DONATE_PURPOSE || PURPOSE_DEFAULT).trim().slice(0, 210);
  const problems = [];
  if (!/^\d{20}$/.test(account)) problems.push('DONATE_ACCOUNT: расчётный счёт — 20 цифр');
  if (!/^\d{9}$/.test(bic)) problems.push('DONATE_BIC: БИК — 9 цифр');
  if (!/^\d{20}$/.test(corr)) problems.push('DONATE_CORR: корсчёт — 20 цифр');
  if (!bank) problems.push('DONATE_BANK: название банка');
  // Суммы-подсказки на странице, рубли. Пусто → без подсказок, только «своя сумма».
  const presets = String(env.DONATE_PRESETS || '300,500,1000,3000').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0 && n <= 1000000).slice(0, 6);
  // ЧЛЕНСКИЙ ВЗНОС (19.09.2026): отдельная вкладка с тем же счётом, но своим назначением
  // и ФИО плательщика. Сумма — DUES_AMOUNT (рубли, пусто → вводит сам); шаблон назначения —
  // DUES_PURPOSE с подстановками {year} и {name}. QR взноса собирается В БРАУЗЕРЕ: ФИО на
  // сервер не уходит и не хранится.
  const duesAmount = Number(String(env.DUES_AMOUNT || '').replace(/[^\d]/g, '')) || null;
  const duesPurpose = String(env.DUES_PURPOSE || 'Членский взнос за {year} год, {name}. НДС не облагается').trim().slice(0, 210);
  return { enabled: problems.length === 0, problems, account, bic, corr, bank, purpose, presets, duesAmount, duesPurpose };
}

/**
 * Строка платежа по ГОСТ Р 56042-2014, кодировка UTF-8 (ST00012). Сумма — в копейках,
 * необязательна: без неё плательщик вводит сумму сам. Имя получателя — как в банке
 * (полное наименование из ЕГРЮЛ), ≤160 символов по стандарту.
 */
export function gostPayload(cfg, sumRub = null, purpose = cfg.purpose) {
  const fields = [
    ['Name', OPERATOR.name],
    ['PersonalAcc', cfg.account],
    ['BankName', cfg.bank],
    ['BIC', cfg.bic],
    ['CorrespAcc', cfg.corr],
    ['PayeeINN', OPERATOR.inn],
    ['KPP', OPERATOR.kpp],
    ['Purpose', purpose],
  ];
  if (Number.isFinite(sumRub) && sumRub > 0) fields.push(['Sum', String(Math.round(sumRub * 100))]);
  // Разделитель — «|»; в значениях его быть не должно.
  return 'ST00012|' + fields.map(([k, v]) => `${k}=${String(v).replace(/\|/g, ' ')}`).join('|');
}

/** Заготовка строки для сборки QR в браузере: всё, кроме назначения и суммы. */
export function gostPrefix(cfg) {
  return gostPayload(cfg, null, '').replace(/\|Purpose=$/, '');
}

/** SVG платёжного QR (уровень коррекции M, как советует ГОСТ для печати и экрана). */
export async function donateQrSvg(cfg, sumRub = null) {
  return QRCode.toString(gostPayload(cfg, sumRub), { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#0b1f18', light: '#ffffff' } });
}

/** Сумма из запроса: целые рубли от 10 до 1 000 000, иначе null (без суммы). */
export function parseSum(raw) {
  const n = Number(String(raw || '').replace(/[^\d]/g, ''));
  return Number.isInteger(n) && n >= 10 && n <= 1000000 ? n : null;
}
