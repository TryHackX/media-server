# Wystawienie na zewnątrz

Do tej pory każda instrukcja opisywała instalację widoczną wyłącznie z tej samej
maszyny. Ten dokument opisuje cztery kształty wystawienia i mówi, co dokładnie
trzeba zmienić w każdym — łącznie z tym, czego **nie** wolno zostawić po drodze.

| Kształt | Kto kończy TLS | Co widzi gość |
|---|---|---|
| **A. Za reverse proxy** (VPS przed serwerem domowym) | proxy (osobna maszyna) | adres proxy; adres serwera aplikacji się nie pojawia |
| **B. Wprost, publiczny adres** (VPS albo domowy komputer z przekierowanym portem) | ten Apache | adres tego serwera |
| **C. Tylko localhost** | nic albo ten Apache | nic — dostęp z tej maszyny |
| **D. Tylko sieć prywatna** (serwer domowy oglądany z telefonu) | zwykle nic | adres z LAN-u, np. `192.168.1.10` |

**Kompletny host wirtualny dla kształtów A i B** jest w
`deploy/apache/media-vhost.conf.example`: nazwa serwera, `DocumentRoot`,
certyfikat, HSTS, przekierowanie z portu 80 i włączenie obu fragmentów
konfiguracji. Same fragmenty (`media-next.conf.example`,
`media-transfer.conf.example`) **nie wystarczą** — nie mówią, pod jaką nazwą
serwer odpowiada ani gdzie ma `DocumentRoot`, więc bez hosta pod adresem stoi
domyślna strona Apache'a, a `configtest` i tak mówi „Syntax OK".

**Aplikacja stoi pod głównym adresem.** `https://twoj.host/` prowadzi wprost do
biblioteki — nie ma podkatalogu do dopisywania. Odpowiada za to `DocumentRoot`
hosta wirtualnego wskazujący na `public/assets/build`, a nie alias: `Alias "/"`
przykryłby wszystkie pozostałe aliasy na serwerze.

Instalacja pod podkatalogiem jest nadal możliwa i wymaga **trzech zgodnych
wartości**, bo każda z nich mówi to samo w innym miejscu:

1. `MEDIA_APP_BASE=/media-next/ npm run build` — front i service worker.
   W PowerShellu: `$env:MEDIA_APP_BASE='/media-next/'; npm run build`.
   **Nie w Git Bashu**: zamienia on wartość zaczynającą się od ukośnika na ścieżkę
   Windows i front buduje się dla `C:/Program Files/Git/media-next/`. Sprawdzone;
   błąd nie zgłasza się w żaden sposób poza tym, co wyląduje w `index.html`;
2. `Alias "/media-next/" "${TRYHACKX_MEDIA_ROOT}/public/assets/build/"` zamiast
   `DocumentRoot`, a w `media-next.conf` przedrostek w regule `AliasMatch`
   publicznego profilu (`^/media-next/account/[^/]+/?$`) — bez tego wejście
   wprost pod adres profilu kończy się 404;
3. `[app] base_url` z tym samym przedrostkiem, inaczej link aktywacyjny prowadzi
   obok aplikacji.

Trasa mostu (`/media-next-api`) i trasa transferu (`/media-transfer/`) zostają
tam, gdzie są: front zna je z osobnego wpisu `meta`, niezależnego od tego, gdzie
stoi sama aplikacja.

**Kształt B jest domyślny w tym repozytorium.** Ktoś, kto sklonuje projekt
i postawi go na własnym VPS-ie z normalnym certyfikatem, nie musi robić nic
z proxy: `[proxy] trusted` zostaje puste, nagłówki `X-Forwarded-*` nie są wtedy
w ogóle czytane, a HTTPS rozpoznaje się z własnego połączenia.

## Trzy rzeczy, bez których publiczna instalacja jest gorsza od lokalnej

**1. HTTPS, i to wymuszone.** Most odrzuca logowanie po zwykłym HTTP —
odpowiedzią jest `422`, celowo, bo inaczej hasło i ciasteczko sesji lecą tekstem.
Konsekwencja jest jednak mylącą awarią: aplikacja **ładuje się poprawnie**, a
każde kliknięcie odbija się o błąd, i gość sam nie zgadnie, że brakuje litery
„s". Dlatego na porcie 80 ma stać przekierowanie na HTTPS, a nie sama aplikacja.

**2. HSTS na hoście serwującym TLS.** Bez niego pierwsze wejście po `http://`
zdąży wysłać ciasteczko, zanim przekierowanie zadziała:

```apache
Header always set Strict-Transport-Security "max-age=31536000"
```

**3. `[app] base_url` jako pełny adres.** Domyślnie jest to sama ścieżka, a link
aktywacyjny idzie **e-mailem** — w ścieżce względnej nikt nie kliknie, więc
rejestracji nie da się dokończyć. To najczęstszy sposób, w jaki publiczna
instalacja „działa", a mimo to nikt nowy się nie zarejestruje.

```toml
[app]
base_url = "https://twoj.host/"
```

Instalator umie to zapisać od razu — `--base-url https://twoj.host/`, a dla
kształtu A również `--proxy-trusted '203.0.113.10, 2001:db8::10'`. Adresy proxy
są przy okazji sprawdzane: literówka w adresie nie odzywa się w żaden sposób,
tylko po cichu wyłącza rozpoznanie gościa.

## Kształt A: za reverse proxy

Wpisz adresy proxy do prywatnej konfiguracji:

```toml
[proxy]
trusted = "203.0.113.10, 2001:db8::10"
```

Ten jeden wpis włącza dwie rzeczy naraz i **obie są konieczne**:

- **kto jest gościem** — bez tego `REMOTE_ADDR` jest adresem proxy, więc limit
  prób logowania i CAPTCHA widzą wszystkich jako jedną osobę i przestają
  cokolwiek chronić;
- **czym gość przyszedł** — proxy kończące TLS rozmawia z nami zwykłym HTTP,
  więc bez tego most odrzuca każde żądanie jako niezabezpieczone, a ciasteczko
  sesji traci atrybut `Secure`.

Nagłówki `X-Forwarded-For` i `X-Forwarded-Proto` są czytane **wyłącznie** wtedy,
gdy przyniósł je host z tej listy. To nie jest ostrożność na wyrost: te nagłówki
pisze klient i może w nich napisać cokolwiek.

**Po stronie proxy** muszą być spełnione trzy warunki, inaczej lista wyżej nic
nie daje:

1. proxy **samo** ustawia `X-Forwarded-For` i `X-Forwarded-Proto`
   i **kasuje** to, co przysłał klient;
2. proxy naprawdę pośredniczy (`proxy_pass`), a nie przekierowuje — przy
   przekierowaniu przeglądarka łączy się z serwerem aplikacji bezpośrednio
   i jego adres przestaje być czymkolwiek ukrytym;
3. proxy przekazuje oryginalny nagłówek `Host`, inaczej Apache zbuduje
   przekierowanie ze **swojej** nazwy — i wypisze ją gościowi.

### Czy adres serwera może wyciec

Aplikacja nie buduje żadnego bezwzględnego adresu z tego, czym sama jest:
front używa adresów względnych, linki w poczcie biorą się z `[app] base_url`,
a strona gościa i trasy transferu też są względne. Zostają trzy rzeczy **poza**
aplikacją, i to one decydują:

- **DNS** — nazwa musi wskazywać na proxy. To jest publiczne i nie da się tego
  ukryć aplikacją.
- **Konfiguracja proxy** — punkty 2 i 3 wyżej.
- **Wszystko inne na tym samym adresie** — inna usługa na tym łączu, wysyłka
  poczty wprost z tej maszyny, cokolwiek, co odezwie się z tego adresu.

## Kształt B: wprost, bez proxy

Nie ustawiaj `[proxy] trusted`. Zostaw je puste — wtedy nagłówki `X-Forwarded-*`
są ignorowane i nikt nie podszyje się pod inny adres ani nie zadeklaruje, że
jego zwykłe HTTP jest szyfrowane.

Poza tym: certyfikat, przekierowanie z portu 80, HSTS i pełny `base_url` jak
wyżej — wszystko to jest w `deploy/apache/media-vhost.conf.example`.

To samo dotyczy domowego komputera z przekierowanym portem: z punktu widzenia
aplikacji nie ma różnicy między VPS-em a łączem domowym. Różnica jest poza nią
i warto ją znać: adres domowy zwykle się zmienia (potrzebny DNS dynamiczny),
a certyfikat trzeba odnawiać z tej samej maszyny — Let's Encrypt musi mieć jak
dojść pod nazwę, więc port 80 też ma być przekierowany.

## Kształt D: tylko sieć prywatna, bez TLS

Instalacja domowa oglądana z telefonu i laptopa po adresie z LAN-u, bez nazwy
i bez certyfikatu. Wszystko działa poza jedną rzeczą: most **odrzuca logowanie
po zwykłym HTTP** (`422`), a wyjątek dla HTTP dotyczy wyłącznie pętli zwrotnej,
czyli tej jednej maszyny. Objaw jest mylący — aplikacja ładuje się poprawnie
i odbija każde kliknięcie.

```toml
[session]
require_https = false
```

**To jest zdjęcie zabezpieczenia, nie opcja wygody.** Hasło i ciasteczko sesji
lecą wtedy tekstem po całej sieci lokalnej — łącznie z Wi-Fi, do którego ma
dostęp każdy gość w domu. Wolno to zrobić w sieci, którą się kontroluje;
w internecie **nie**, i sama ta linia nie wystarczy, żeby zaszkodzić tylko
w jedną stronę: jeśli ten sam serwer jest jednocześnie wystawiony publicznie,
wyłączenie dotyczy również gości z zewnątrz.

Lepsza droga, jeśli jest na nią cierpliwość: własna nazwa w prywatnym DNS
i certyfikat z własnego CA albo z Let's Encrypt przez wyzwanie DNS-01. Wtedy
`require_https` zostaje na `true`, a service worker (aplikacja instalowalna
na telefonie) w ogóle zaczyna działać — przeglądarki wymagają do niego
bezpiecznego kontekstu, którego zwykłe HTTP spoza localhosta nie daje.

`[proxy] trusted` zostaje puste, `[app] base_url` może zostać ścieżką — chyba
że w tej sieci ma działać rejestracja pocztą; wtedy pełny adres z LAN-u.

## Reguły dostępu w Apache

`deploy/apache/media-next.conf.example` i `media-transfer.conf.example` mają
w komentarzu wariant lokalny i publiczny. **Drugi plik jest obowiązkowy** —
bez niego biblioteka się wyświetla, ale nic nie zagra ani się nie pobierze.

Trasy transferu (`/media-transfer/`) przy wystawieniu publicznym muszą być
otwarte, i to jest zamierzone: chroni je **podpisany token o krótkim czasie
życia**, wydawany przez most po sprawdzeniu sesji. Bez tokenu żądanie i tak
kończy się odmową. Zdrowie usługi i zlecenia zadań zostają zamknięte na zawsze,
osobną regułą, niezależnie od tego, jak szeroko otwarte są trasy transferu.

Sama usługa transferowa nasłuchuje **wyłącznie na pętli zwrotnej**
(`server.host = "127.0.0.1"`); `allow_remote_bind` istnieje, ale wystawianie jej
wprost oznaczałoby oddanie plików bez Apache i bez tokenów — nie rób tego.

## Zanim uznasz, że działa

1. `https://twoj.host/` ładuje się i **pozwala się zalogować**.
2. `http://twoj.host/` **przekierowuje** na HTTPS, a nie pokazuje
   aplikacji, która odbija każde kliknięcie.
3. Utwór **gra**, a plik **się pobiera** (to sprawdza `/media-transfer/`).
4. `https://twoj.host/media-transfer/health/ready` oddaje **403 albo 404**,
   nie `ready`. **Jeśli oddaje `200`, sprawdź kolejność sekcji, a nie ich treść.**
   `<Location>` i `<LocationMatch>` scalają się w kolejności z pliku, a przy
   domyślnym `AuthMerging Off` `Require` z sekcji późniejszej **zastępuje**
   wcześniejsze — więc blok zamykający zdrowie musi stać **po** bloku
   otwierającym trasy transferu. Postawiony przed nim znika bez śladu: reguła
   jest w pliku, `configtest` mówi „Syntax OK", zwykłe trasy działają normalnie,
   a zdrowie odpowiada całemu internetowi. Tak było tutaj do 17.08.2026.
   Sprawdź też `…/v1/catalog-scan` — `405` znaczy, że żądanie **dotarło** do
   usługi i chroni ją już tylko wewnętrzny klucz; ma być `403`.
5. Rejestracja nowego konta kończy się mailem z **klikalnym** linkiem.
6. Po nieudanych logowaniach z jednego adresu przychodzi ograniczenie, a nie
   blokada dla wszystkich naraz (to sprawdza `[proxy] trusted`).
7. Z telefonu: aplikacja **daje się zainstalować** (ikona na ekranie startowym
   otwiera się bez paska adresu), a po wyłączeniu sieci pokazuje stronę „Brak
   połączenia" zamiast błędu przeglądarki. To jedyny sposób sprawdzenia service
   workera — wymaga HTTPS i prawdziwej przeglądarki.
