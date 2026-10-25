#!/usr/bin/env python3
# Независимая сверка рейтинга ftso67.ru: пересчёт очков по методике 2026 из страниц сайта и сравнение с /rating.
# Запуск: python3 tools/live/check-rating.py <папка со скачанными страницами> (см. tools/live/README.md).
# Страницы и результат (results.json) содержат персональные данные — держать вне репозитория.
import re,html,json,math,collections
import sys, os
D=os.path.join(sys.argv[1] if len(sys.argv)>1 else os.path.expanduser('~/ftso-live'), '')
T=lambda x: re.sub(r'\s+',' ',html.unescape(re.sub(r'<[^>]+>',' ',x))).strip()
# players: id -> (name, sex)
ps={}
s=open(D+'players.html',encoding='utf-8').read()
for m in re.finditer(r'<tr data-player-row[^>]*>(.*?)</tr>',s,re.S):
    row=m.group(1)
    pid=int(re.search(r'<td>(\d+)</td>',row).group(1))
    sex=re.search(r'name="sex"[^>]*>.*?<option value="(M|F)" selected',row,re.S)
    ps[pid]=sex.group(1) if sex else None
TOUR={4:('adult','2026-07-19'),6:('adult','2026-09-07'),7:('u13','2026-08-30'),8:('u17','2026-08-30')}
WIN={'adult':{'A':1000,'B':800,'C':500,'D':250},'u17':{'A':800,'B':600,'C':300,'D':150},'u13':{'A':500,'B':350,'C':150,'D':80}}
TCAT={}
CAT={32:'A',24:'B',16:'C',8:'D'}
def pct(p): return 100 if p==1 else 60 if p==2 else 40 if p==3 else 30 if p==4 else 20 if p<=8 else 10 if p<=16 else 5 if p<=32 else 0
def pts(g,size,place,pair):
    pp=(WIN[g][CAT[size]]*pct(place)+50)//100
    return math.ceil(pp/2) if pair else pp
DISC={'одиночный':'single','парный':'double','микст':'mixed'}
results=[]  # (tid, pid, place, disc)
sizes={}
for t in TOUR:
    s=open(D+f't{t}.html',encoding='utf-8').read()
    TCAT[t]=re.search(r'категория ([ABCD])',s).group(1)
    i=s.find('Итоговые места участников'); seg=s[i:s.find('</table>',i)]
    for m in re.finditer(r'<tr>(.*?)</tr>',seg,re.S):
        cells=re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>',m.group(1),re.S)
        if len(cells)<4 or not T(cells[0]).isdigit(): continue
        pid=re.search(r'/player/(\d+)',cells[1]); 
        results.append((t,int(pid.group(1)) if pid else None,int(T(cells[0])),DISC.get(T(cells[3]),T(cells[3])),T(cells[1])))
    # set sizes from admin panel
    a=open(D+f'r{t}.html',encoding='utf-8').read()
    for m in re.finditer(r'name="size__(single|double|mixed)__([MFX*])"[^>]*>(.*?)</select>',a,re.S):
        sel=re.search(r'<option value="(\d+)" selected',m.group(3))
        if sel: sizes[(t,m.group(1),m.group(2))]=int(sel.group(1))
# counts per draw
cnt=collections.Counter()
for t,pid,pl,d,nm in results:
    sk='X' if d=='mixed' else (ps.get(pid) or '*')
    cnt[(t,d,sk)]+=1
def size_of(t,d,sk):
    if (t,d,sk) in sizes: return sizes[(t,d,sk)],'задан'
    if (t,d,'*') in sizes: return sizes[(t,d,'*')],'задан'
    return {'A':32,'B':24,'C':16,'D':8}[TCAT[t]],'по категории'
exp=collections.defaultdict(lambda: collections.defaultdict(list))
issues=[]
for t,pid,pl,d,nm in results:
    if pid is None: issues.append(f'турнир {t}: «{nm}» без ссылки на профиль (обезличен?)'); continue
    g=TOUR[t][0]; sk='X' if d=='mixed' else (ps.get(pid) or '*')
    if d!='mixed' and not ps.get(pid): issues.append(f'#{pid} {nm}: не указан пол')
    sz,how=size_of(t,d,sk)
    lst=f'{g}.{"single" if d=="single" else "pair"}'
    exp[lst][pid].append(pts(g,sz,pl,d!='single'))
# site lists
mism=[]; total=0
for g in ['adult','u17','u13']:
    for dd in ['single','pair']:
        s=open(D+f'rating-{g}-{dd}.html',encoding='utf-8').read()
        site={}
        for m in re.finditer(r'<div class="rplate__row">(.*?)</div>',s,re.S):
            row=m.group(1); pid=re.search(r'/player/(\d+)',row); p=re.search(r'rplate__pts">(\d+)',row)
            if pid and p: site[int(pid.group(1))]=int(p.group(1))
        e={pid:sum(sorted(v,reverse=True)[:10]) for pid,v in exp[f'{g}.{dd}'].items()}
        total+=len(site)
        for pid in set(site)|set(e):
            if site.get(pid)!=e.get(pid): mism.append(f'{g}.{dd} #{pid}: сайт {site.get(pid)} ≠ расчёт {e.get(pid)}')
        print(f'{g}.{dd}: на сайте {len(site)}, по расчёту {len(e)}')
print('строк всего', total)
print('РАСХОЖДЕНИЙ:', len(mism)); print('\n'.join(mism[:30]))
print('Размеры сеток:', {f'{k[0]}/{k[1]}/{k[2]}':size_of(*k) for k in sorted(cnt)})
print('ЗАМЕЧАНИЯ:', len(issues)); print('\n'.join(sorted(set(issues))[:40]))
json.dump({'results':results},open(D+'results.json','w'),ensure_ascii=False)
