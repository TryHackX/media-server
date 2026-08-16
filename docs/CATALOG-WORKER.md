# Worker katalogu mediów

Worker działa jako osobne polecenie Pythona, poza obsługą HTTP, Apache i PHP. Jego zadaniem jest
przyrostowe wykrywanie plików oraz zapis gotowego katalogu do wspólnej bazy MySQL/MariaDB. Nie
modyfikuje plików multimedialnych.

## Bezpieczny pierwszy przebieg

Najpierw zastosuj migracje wyłącznie na bazie stagingowej, a następnie uruchom analizę bez zapisu:

```powershell
media-server --config config\config.local.toml migrate
media-server --config config\config.local.toml scan --root music --kind music
media-server --config config\config.local.toml scan --root movies --kind movies
```

Domyślny tryb to `dry-run`. Wynik JSON pokazuje liczbę plików nowych, zmienionych,
niezmienionych, brakujących i błędów. Dopiero po sprawdzeniu raportu wolno dodać `--apply`:

```powershell
media-server --config config\config.local.toml scan --root music --kind music --apply
```

Dla nowych i zmienionych plików można zakolejkować odczyt metadanych:

```powershell
media-server --config config\config.local.toml scan --root music --kind music --metadata --apply
media-server --config config\config.local.toml scan --root movies --kind movies --metadata --apply
```

Samo parsowanie wykonuje osobne, limitowane polecenie — obsługuje obie kolejki naraz:

```powershell
media-server --config config\config.local.toml metadata-worker --limit 500 --timeout-seconds 30
```

## Co czyta worker

| Rodzaj | Czytnik | Zapisuje |
|---|---|---|
| audio | Mutagen (tagi) | `title`, `artist`, `album`, `duration_ms`, `metadata_json.audio` |
| wideo | `ffprobe` | `duration_ms`, `video_width`, `video_height`, `video_codec`, `audio_codec`, `frame_rate`, `is_hdr`, `metadata_json.video` |

`ffprobe` jest brany z katalogu skonfigurowanego FFmpeg (`stereo.ffmpeg_path`); bez niego zadania
wideo kończą się czytelnym błędem, a kolejka audio pracuje dalej. Każdy plik ma własny proces:
Mutagen w procesie potomnym, `ffprobe` z natury osobno — uszkodzony kontener nie zatrzymuje workera,
a przekroczony czas kończy tylko to jedno zadanie.

HDR rozpoznajemy po krzywej przenoszenia (`smpte2084`, `arib-std-b67`); same primaries `bt2020`
liczą się dopiero razem z głębią 10/12 bitów. Okładka osadzona w pliku jest strumieniem wideo
o kodeku obrazkowym (`mjpeg`, `png`), więc jest pomijana przy wyborze właściwego obrazu.

Skan nie otwiera plików — porównuje `size + mtime`. Żeby wymusić ponowny odczyt po zmianie tego,
**co** wyciągamy z pliku (a nie samego pliku), obie sekcje mają wersję: `metadata_json.audio.schema`
i `metadata_json.video.schema`. Podniesienie `PROBE_SCHEMA` w `probe.py` sprawia, że najbliższy skan
z `--metadata` zakolejkuje wszystkie filmy ponownie, mimo niezmienionych plików.

## Gwarancje bezpieczeństwa

- skan nie podąża za symlinkami, junctionami ani innymi reparse pointami wewnątrz źródła;
- skonfigurowany katalog główny jest kanonizowany i musi istnieć;
- nie są skanowane katalogi `sources` ani `soucres` jako część repozytorium; worker widzi tylko
  jawnie skonfigurowane źródło;
- pojedynczy root chroni blokada doradcza bazy, więc dwa procesy nie zapisują go równocześnie;
- rekordy są zapisywane porcjami, a brakujące pliki są oznaczane dopiero po pełnym, udanym skanie;
- błąd odczytu katalogu lub przerwanie procesu zapisuje status skanu `failed` albo `cancelled`
  i nie uruchamia etapu oznaczania braków;
- pusty wcześniej niepusty root oraz utrata większości dużego katalogu są domyślnie blokowane.
  Flagi `--allow-mass-missing` wolno użyć tylko po sprawdzeniu montowania dysku i raportu dry-run;
- „usunięcie” jest miękkie: rekord otrzymuje `catalog_status = missing` oraz `deleted_at`.
  Dane ocen i odtworzeń nie są kasowane.

## Wydajność

Worker katalogu używa `os.scandir`, statystyk systemu plików i porównań `size + mtime_ns`.
Zawartość każdego pliku nie jest hashowana, a skan nie uruchamia parsera tagów. Operacje bazy są
wykonywane w porcjach; domyślnie po 500 rekordów, z zakresem `--batch-size 10..5000`.

Każdy plik metadanych trafia do osobnego procesu potomnego. Przekroczenie timeoutu kończy tylko ten
proces i oznacza zadanie jako błędne; katalog oraz następne zadania nadal działają.

Aktualnie obsługiwane są typowe kontenery audio dla roota `music` oraz wideo dla `movies`.
Root `mixed` przyjmuje oba typy. Obrazy (okładki, plakaty) i bezpieczne pliki pomocnicze
(napisy, `.nfo`, `.cue`) są zapisywane jako elementy o `media_kind` `image` / `other` i liczone
w raporcie skanu (`images`, `auxiliary`); nie są odtwarzane, ale służą jako podglądy folderów.

## Stan skanu

Każdy zapisujący przebieg ma rekord w `catalog_scans`:

- `running` — proces pracuje;
- `completed` — cały root odczytano, a etap braków zakończył się atomowo;
- `failed` — skan lub baza zgłosiły błąd;
- `cancelled` — proces przerwano.

Kolejka używa `background_jobs` ze stanami `queued`, `running`, `done` i `failed`.
Klucz zadania obejmuje identyfikator pliku oraz jego mtime, dzięki czemu powtórny skan nie tworzy
duplikatów.

## Harmonogram

Jedno polecenie robi cały przebieg: `media-server maintenance` — skan każdego skonfigurowanego
źródła, porcja kolejki metadanych i porcja gatunków filmów, w tej kolejności. Każdy krok jest
ograniczony (`--scan-batch`, `--metadata-limit`, `--titles-limit`), a błąd jednego nie przerywa
pozostałych: awaria Filmwebu nie ma prawa wstrzymać kolejki odczytu plików. Rodzaj źródła bierze
się z `media_roots`, więc źródło, którego nikt jeszcze nie skanował, jest **pomijane z powodem**,
a nie zgadywane z nazwy. Kod wyjścia jest niezerowy, gdy którykolwiek krok zawiódł.

Uruchamianie: na Debianie timer `tryhackx-media-maintenance.timer` (usługa `oneshot`), na Windows
zadanie „TryHackX Media Maintenance” z `scripts\run-maintenance-windows.ps1`. Nakładania się
przebiegów pilnuje harmonogram — systemd nie uruchomi drugiej instancji jednostki, a zadanie jest
zarejestrowane z `-MultipleInstances IgnoreNew`; kod nie trzyma własnej blokady.

Żadnego z workerów nie wolno uruchamiać w PHP ani wewnątrz żądania użytkownika.

## Znane ograniczenia i następny krok

Zmiana nazwy pliku jest widziana jako nowy rekord i brak starego rekordu; system nie próbuje
zgadywać tożsamości na podstawie kosztownego hasha całej zawartości.

Kolejkę można opróżnić poleceniem powyżej albo przyciskiem w panelu (Indeksowanie → „Kolejka
odczytu plików”), który bierze porcję 200 plików; drugie kliknięcie w trakcie pracy dostaje `409`,
bo jednocześnie pracuje jeden worker. Pomiar na tej instalacji: 600 filmów w 67 s (ok. 110 ms na
plik). Zaplanowane uruchamianie jest opisane wyżej („Harmonogram”). Okładki filmów wyciągane
z pliku, alert dla długo wiszącego statusu `running` oraz cykliczne czyszczenie zakończonych zadań
pozostają do zrobienia.

