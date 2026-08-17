# Wystawienie na zewnątrz

Do tej pory każda instrukcja opisywała instalację widoczną wyłącznie z tej samej
maszyny. Ten dokument opisuje trzy kształty wystawienia i mówi, co dokładnie
trzeba zmienić w każdym — łącznie z tym, czego **nie** wolno zostawić po drodze.

| Kształt | Kto kończy TLS | Co widzi gość |
|---|---|---|
| **A. Za reverse proxy** | proxy (osobna maszyna) | adres proxy; adres serwera aplikacji się nie pojawia |
| **B. Wprost, publiczny adres** | ten Apache | adres tego serwera |
| **C. Tylko localhost** | nic albo ten Apache | nic — dostęp z tej maszyny |

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

**3. `[app] base_url` jako pełny adres.** Domyślnie jest to ścieżka względna
(`/media-next/`), a link aktywacyjny idzie **e-mailem** — w ścieżce względnej
nikt nie kliknie, więc rejestracji nie da się dokończyć. To najczęstszy sposób,
w jaki publiczna instalacja „działa", a mimo to nikt nowy się nie zarejestruje.

```toml
[app]
base_url = "https://twoj.host/media-next/"
```

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
wyżej.

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

1. `https://twoj.host/media-next/` ładuje się i **pozwala się zalogować**.
2. `http://twoj.host/media-next/` **przekierowuje** na HTTPS, a nie pokazuje
   aplikacji, która odbija każde kliknięcie.
3. Utwór **gra**, a plik **się pobiera** (to sprawdza `/media-transfer/`).
4. `https://twoj.host/media-transfer/health/ready` oddaje **403 albo 404**,
   nie `ready`.
5. Rejestracja nowego konta kończy się mailem z **klikalnym** linkiem.
6. Po nieudanych logowaniach z jednego adresu przychodzi ograniczenie, a nie
   blokada dla wszystkich naraz (to sprawdza `[proxy] trusted`).
