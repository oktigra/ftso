# DNS-зона ftso67.ru — снимок 01.10.2026 (DoH dns.google, замер чата)

Зачем: зона обслуживается NS Timeweb из СТАРОГО shared-аккаунта ck55933 (hosting.timeweb.ru),
тариф которого истекает 15.10.2026. Если зона пропадёт — восстанавливать по этой таблице в
Timeweb Cloud (nd750780) или у любого DNS-хостинга, затем NS у RU-CENTER. TTL 600 на всех записях.

| Имя | Тип | TTL | Значение |
|---|---|---|---|
| ftso67.ru. | NS | 600 | `ns2.timeweb.ru.` |
| ftso67.ru. | NS | 600 | `ns4.timeweb.org.` |
| ftso67.ru. | NS | 600 | `ns1.timeweb.ru.` |
| ftso67.ru. | NS | 600 | `ns3.timeweb.org.` |
| ftso67.ru. | SOA | 600 | `ns1.timeweb.ru. dns.timeweb.ru. 2026082400 28800 7200 259200 300` |
| ftso67.ru. | A | 81 | `194.87.187.42` |
| www.ftso67.ru. | A | 600 | `194.87.187.42` |
| ftso67.ru. | MX | 600 | `10 mx.yandex.net.` |
| ftso67.ru. | TXT | 600 | `v=spf1 include:_spf.timeweb.ru include:_spf.yandex.net ~all` |
| _dmarc.ftso67.ru. | TXT | 600 | `v=DMARC1; p=none; rua=mailto:info@ftso67.ru; fo=1; adkim=r; aspf=r; pct=100` |
| mail._domainkey.ftso67.ru. | TXT | 600 | `v=DKIM1; k=rsa; t=s; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC3tdFe9wK4eRkb7zrrJyxz7sCi6RFZthxi1GyCpkQ4zqwkBq0NlX0ey6Oyr9pzEXpx8BA87Dtq/kbsOx1uZfAi/Zszg1Akyo2YFwiqv3j8Uom7qC3LYrVtA1qRnS10EPB4TH3VKtmUvOAWf4tTjOJQFHxAcrGU5TGy0Uc784pZlQIDAQAB` |
| yamail-26080515130954466.ftso67.ru. | CNAME | 600 | `mail.yandex.ru.` |

Примечания:
- AAAA-записей нет (удалены при переезде на VPS 194.87.187.42, IPv6 VPS не проверялся).
- MX/SPF/DKIM/DMARC/CNAME `yamail-…` — почта Яндекс 360, переносить дословно; SPF содержит `include:_spf.timeweb.ru` (историческое, не мешает).
- Проверка после переноса: `dig +short ftso67.ru A` → 194.87.187.42; `dig +short ftso67.ru MX` → `10 mx.yandex.net.`; `dig +short mail._domainkey.ftso67.ru TXT` — ключ выше.
