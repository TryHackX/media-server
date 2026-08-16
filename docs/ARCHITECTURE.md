# Architektura

System jest modularnym monolitem w trzech procesach: PHP odpowiada za sesję, konta i krótkie
API, Python za transfer/ZIP/miniatury/tryb zgodny, a TypeScript za wspólny interfejs.
Przeglądarka nigdy nie przekazuje ścieżki systemowej — każdy transfer zaczyna się od
`media_item_id` i krótkiego, zaszyfrowanego ticketu.

## Katalogi mediów są tylko do odczytu

**Nic w tym systemie nie zapisuje do plików multimedialnych.** To nie jest przypadek ani
uprzejmość — to warunek, na którym biblioteka może jednocześnie być zasiewem torrentów:
zmiana choćby jednego bajta albo czasu modyfikacji unieważniłaby seedowanie.

Wynika z tego kilka decyzji, które inaczej wyglądałyby dziwnie:

- **Edytor tagów zapisuje do bazy**, do `media_metadata_overrides`, a nie do pliku. Odczyt
  łączy jedno z drugim (`COALESCE(mo.title, mi.title)`), więc poprawka jest widoczna wszędzie,
  a plik zostaje nietknięty.
- **Okładki, napisy i tryb zgodny** produkują nowe pliki w `runtime/`, nigdy obok oryginału.
- **Odcisk pliku** (`content_fingerprint`) otwiera plik w trybie `rb` i czyta 128 KiB z dwóch
  końców. Odczyt nie zmienia ani zawartości, ani `mtime`.
- **Gatunek i rok** biorą się z nazwy pliku albo z sieci i lądują w kolumnach katalogu —
  właśnie dlatego, że dopisanie ich do pliku nie wchodzi w grę.

Sprawdzenie, gdyby kiedyś trzeba było to udowodnić: katalog trzyma `size_bytes` i `mtime_ns`
z chwili skanu, więc porównanie ich z `stat()` na dysku pokazuje każdą zmianę.

```text
Przeglądarka
  ├─ strony i krótkie API ──> most PHP (/media-next-api) ──> jedna baza media_server
  └─ audio/video/plik/ZIP ──> Apache proxy (/media-transfer) ──> Python transfer :8765
                                    └─ FFmpeg (tryb zgodny, miniatury, napisy) ──> cache w runtime/
```

## Procesy

1. **Most PHP** — logowanie i rejestracja z aktywacją, CAPTCHA, sesja z CSRF, biblioteka,
   kolekcje, oceny, panel administracyjny, grupy uprawnień oraz wystawianie krótkich tokenów
   transferowych. Egzekwuje uprawnienia i godzinowe limity pobierania przy wystawianiu ticketu.
2. **Transfer (Python/FastAPI)** — tylko bajty: Range, HEAD, ZIP64 STORE, miniatury, napisy
   WebVTT i strumienie trybu zgodnego. Nie renderuje HTML i nie przyjmuje ścieżek bez
   zaszyfrowanego uprawnienia; limit równoczesnych strumieni konta odczytuje z claima tokenu.
3. **Worker** — skanowanie przyrostowe katalogu, kolejka metadanych (mutagen w podprocesie
   z twardym limitem czasu) i wygrzewanie cache napisów; zlecany z CLI albo z panelu przez
   wewnętrzne endpointy chronione kluczem.

Rozdzielenie procesów nie oznacza trzech projektów. To jeden modularny monolit, jedna
konfiguracja (`config/config.local.toml` czytana przez Pythona przez `tomllib` i przez PHP
własnym parserem podzbioru TOML — komentarze, tabele, stringi, liczby, wartości logiczne),
jedne migracje i wspólny model danych, ale ciężka praca nie blokuje żądań interfejsu.
Ścieżki wewnątrz drzewa projektu (cache, dołączony FFmpeg, spool poczty) mogą być względne
i są rozwiązywane względem katalogu projektu; katalogi mediów są zawsze bezwzględne.

## Tokeny transferowe

- AES-256-GCM, prefiks `v1.`, AAD `tryhackx-media-transfer:v1`, TTL ≤ 900 s;
- claimy: `kind` (file/archive), `items` (źródło + ścieżka względna), `name`, `disposition`,
  `sub` (id konta) oraz opcjonalnie `max_streams` (limit równoczesnych strumieni trybu zgodnego)
  i `max_downloads` (limit równoczesnych pobrań — tylko dla `attachment`); oba pochodzą z grupy
  uprawnień konta i są egzekwowane przez Python bez dostępu do bazy;
- Python odrzuca ścieżki wychodzące poza skonfigurowane źródło, dowiązania symboliczne
  i junction points.

## Uprawnienia

Grupa uprawnień jest jedynym źródłem praw konta (`permission_groups`): 11 flag (pobieranie,
ocenianie, ulubione, kolekcje, przeglądanie kolekcji i profili, udostępnianie, dostęp do
muzyki, dostęp do filmów, tryb zgodny wideo, edycja tagów) i cztery limity (równoczesne
strumienie, liczba pobrań w oknie N minut, okno, równoczesne pobrania). Konto gościa to
członkostwo w systemowej grupie „Goście” (`users.is_guest` jest lustrem). Administratorzy
omijają prawa i limity. Limit globalny (`app_settings`) działa niezależnie od limitu grupy;
rezerwacja pobrania jest atomowa (blokada wiersza konta).

## Transfer

- Strumień pliku ma ograniczoną pamięć i obsługuje pojedynczy zakres bajtów.
- Nieobsługiwany multi-range skutkuje pełną odpowiedzią zamiast błędnej wieloczęściowej.
- `If-Range` zapobiega łączeniu fragmentów różnych wersji pliku.
- ZIP korzysta z ZIP64 i STORE, ponieważ audio oraz wideo są już skompresowane.
- Semafory ograniczają równoległe transfery, strumienie FFmpeg, ekstrakcję napisów
  i generowanie miniatur; oczekujący klient dostaje 503 po upływie czasu kolejki.
- Porzucone strumienie trybu zgodnego sprząta osobny obserwator rozłączenia, więc zamknięta
  karta nie blokuje slotu do końca limitu czasu.

## Wspólna baza

Migracje `001`–`019` obejmują użytkowników, sesje, źródła, elementy mediów, hierarchię
folderów, oceny, statystyki odtwarzania, kolekcje (ręczne i inteligentne, z opisem
i kolejnością), nadpisania metadanych i okładek, ustawienia aplikacji, tokeny aktywacyjne,
próby logowania, grupy uprawnień, rejestr pobrań, audit log oraz indeks ścieżek względnych.
Wszystkie tabele używają InnoDB i `utf8mb4`. Runner migracji prowadzi rejestr
`schema_migrations` z sumami kontrolnymi.

## Jakość i wydanie

`python scripts/check.py` uruchamia tę samą bramkę co CI (`.github/workflows/ci.yml`): `ruff`,
`pytest`, `php -l`, `tsc`, produkcyjny build frontendu do katalogu tymczasowego, testy node,
`pip check` i skan sekretów (w tym porównanie z wartościami z prywatnego configu); `--audit`
dodaje `pip-audit` i `npm audit`. Zależności Pythona są przypięte w uniwersalnych lockach
z hashami (`requirements.lock`, `requirements-dev.lock`; odświeżanie `scripts/lock-deps.py`),
frontend w `package-lock.json`.

## Frontend

Jeden projekt TypeScript/Vite ze wspólnym shellem dla wszystkich stron poza logowaniem.
CSS ma warstwy `tokens`, `reset`, `base`, `components`, `utilities`, `pages` i jeden zestaw
responsywnych breakpointów. Dynamiczne elementy używają klas i bezpiecznego DOM zamiast
`innerHTML` i indywidualnego `style.*`. Szczegóły w `FRONTEND.md`.
