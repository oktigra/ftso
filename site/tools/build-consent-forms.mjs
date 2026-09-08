/**
 * БЛАНКИ СОГЛАСИЯ НА РАСПРОСТРАНЕНИЕ ПДн (ст. 10.1 152-ФЗ) — для реестров
 * тренеров и судей на сайте Федерации.
 *
 * Зачем отдельное согласие. Результаты соревнований публикуются по факту участия
 * (п. 5 ч. 1 ст. 6), согласия не требуют. А карточка тренера или судьи — это
 * распространение персональных данных неопределённому кругу лиц, и на него нужно
 * ОТДЕЛЬНОЕ согласие по ст. 10.1: в нём субъект сам перечисляет, что именно можно
 * публиковать, и может поставить запреты и условия.
 *
 * Состав бланка — по ч. 6 ст. 10.1 и Приказу Роскомнадзора № 439 от 24.02.2021:
 * данные субъекта, данные оператора, цель, перечень данных отдельно по каждой
 * категории, условия и запреты, срок, ресурс публикации, подпись и дата.
 *
 * Реквизиты оператора берутся из server/lib/legal.mjs — второй копии, способной
 * разойтись с сайтом, не заводим.
 *
 * Запуск: node tools/build-consent-forms.mjs [каталог]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import { OPERATOR } from '../server/lib/legal.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.argv[2] || resolve(ROOT, '..');

const line = (text, opts = {}) => new Paragraph({ spacing: { after: 120 }, ...opts, children: [new TextRun({ text, size: 22, ...(opts.run || {}) })] });
const bold = (text) => new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text, size: 22, bold: true })] });
const fill = (label) => new Paragraph({
  spacing: { after: 160 },
  children: [new TextRun({ text: label + ' ', size: 22 }), new TextRun({ text: '_'.repeat(Math.max(12, 74 - label.length)), size: 22 })],
});
const small = (text) => new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text, size: 18, italics: true })] });

function form({ role, roleGenitive, dataList, purpose }) {
  const children = [
    new Paragraph({ alignment: AlignmentType.CENTER, heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: 'СОГЛАСИЕ', bold: true, size: 28 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 },
      children: [new TextRun({ text: `на обработку персональных данных, разрешённых субъектом\nдля распространения (статья 10.1 Федерального закона № 152-ФЗ)\n${roleGenitive}`, size: 22 })] }),

    bold('1. Субъект персональных данных'),
    fill('Фамилия, имя, отчество:'),
    fill('Контактный телефон:'),
    fill('Адрес электронной почты:'),

    bold('2. Оператор, получающий согласие'),
    line(`${OPERATOR.name}`),
    line(`Адрес: ${OPERATOR.address}`),
    line(`ОГРН ${OPERATOR.ogrn}, ИНН ${OPERATOR.inn}, КПП ${OPERATOR.kpp}`),
    line(`Телефон: ${OPERATOR.phone}, электронная почта: ${OPERATOR.email}`),
    line(`Ответственный за организацию обработки персональных данных: ${OPERATOR.responsible.title} ${OPERATOR.responsible.name}`),

    bold('3. Цель обработки'),
    line(purpose),

    bold('4. Сведения об информационном ресурсе, на котором будет размещение'),
    line(`Официальный сайт Федерации: https://${OPERATOR.site} (раздел «${role === 'тренер' ? 'Тренеры' : 'Судьи'}»)`),

    bold('5. Перечень персональных данных, разрешённых для распространения'),
    small('Отметьте «да» напротив каждой строки, которую разрешаете публиковать. Строка без отметки не публикуется.'),
    ...dataList.map((d) => new Paragraph({
      spacing: { after: 100 },
      children: [new TextRun({ text: `☐  ${d}`, size: 22 })],
    })),
    fill('Иные сведения, которые разрешаю опубликовать:'),

    bold('6. Условия и запреты (часть 9 статьи 10.1)'),
    new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: '☐  Запрещаю передачу моих данных, кроме предоставления доступа неограниченному кругу лиц на указанном сайте', size: 22 })] }),
    new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: '☐  Запрещаю обработку моих данных иными лицами (кроме размещения на сайте Федерации)', size: 22 })] }),
    fill('Иные условия:'),

    bold('7. Срок действия согласия'),
    line('Согласие действует до его отзыва. Отзыв подаётся в письменной форме по адресу Оператора или на его электронную почту; сведения снимаются с сайта в срок, установленный частью 12 статьи 10.1 (три рабочих дня).'),

    bold('8. Подпись'),
    small('Подтверждаю, что ознакомлен(а) с Политикой обработки персональных данных Оператора, размещённой по адресу https://' + OPERATOR.site + '/privacy, и что данные предоставлены мной добровольно.'),
    new Paragraph({ spacing: { before: 240 }, children: [new TextRun({ text: 'Дата: «____» __________________ 20____ г.          Подпись: ______________ / ____________________ /', size: 22 })] }),

    new Paragraph({ spacing: { before: 400 }, children: [new TextRun({ text: 'Отметки Федерации (заполняет секретарь)', bold: true, size: 20 })] }),
    small('Основание публикации: согласие от «____» ____________ 20____ г. — эту строку и дату вносят в карточку на сайте, в поля «Основание публикации» и «Дата документа». Оригинал хранится в делах Федерации.'),
  ];

  return new Document({
    creator: OPERATOR.name,
    title: `Согласие на распространение персональных данных (${role})`,
    styles: { default: { document: { run: { font: 'Times New Roman', size: 22 } } } },
    sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 800 } } }, children }],
  });
}

const forms = [
  {
    file: 'soglasie-trener.docx',
    role: 'тренер',
    roleGenitive: 'для реестра тренеров Смоленской области',
    purpose: 'Ведение и размещение на официальном сайте Федерации реестра тренеров Смоленской области — для информирования спортсменов, их законных представителей и организаторов соревнований о тренерах региона и о том, как с ними связаться.',
    dataList: [
      'Фамилия, имя, отчество',
      'Город (населённый пункт)',
      'Клуб, спортивная школа или иное место работы',
      'Специализация (с какими группами работаю)',
      'Квалификация: образование, тренерская категория, сертификаты',
      'Стаж тренерской работы',
      'Контактный телефон',
      'Адрес электронной почты',
      'Фотография (портрет)',
    ],
  },
  {
    file: 'soglasie-sudya.docx',
    role: 'судья',
    roleGenitive: 'для реестра спортивных судей Смоленской области',
    purpose: 'Ведение и размещение на официальном сайте Федерации реестра спортивных судей Смоленской области — для информирования организаторов соревнований и участников о судейском составе региона.',
    dataList: [
      'Фамилия, имя, отчество',
      'Город (населённый пункт)',
      'Судейская категория и дата её присвоения',
      'Опыт судейства (соревнования, годы)',
      'Контактный телефон',
      'Адрес электронной почты',
      'Фотография (портрет)',
    ],
  },
];

mkdirSync(OUT_DIR, { recursive: true });
for (const f of forms) {
  const buf = await Packer.toBuffer(form(f));
  const out = resolve(OUT_DIR, f.file);
  writeFileSync(out, buf);
  console.log(`${out}: ${f.role}, пунктов перечня ${f.dataList.length}, ${buf.length} байт`);
}
