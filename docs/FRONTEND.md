# Wspólny frontend stagingowy

Frontend znajduje się w `frontend/` i jest lekką aplikacją wielostronicową TypeScript/Vite —
bez frameworka UI w runtime. Wszystkie strony poza logowaniem współdzielą jeden shell (sesja,
nawigacja boczna, stały odtwarzacz audio) oraz miękki router SPA, który przechwytuje kliknięcia
w linki tej samej aplikacji i domontowuje moduły stron bez pełnego przeładowania. Ikony Font
Awesome są bundlowane lokalnie, bez CDN.

Produkcyjny build trafia do ignorowanego katalogu `public/assets/build/` i jest wystawiony
lokalnie wyłącznie przez alias `/media-next/`; bezpośrednia ścieżka repozytorium zwraca `403`.

## Trasy

- `/media-next/` — wspólny ekran startowy;
- `/media-next/login/` — samodzielne logowanie i rejestracja z aktywacją mailową
  (obsługuje też linki `?activate=` i `?email_change=`);
- `/media-next/music/` — katalog i odtwarzacz audio (parametr `?collection=` otwiera playlistę);
- `/media-next/movies/` — katalog i odtwarzacz wideo z trybem zgodnym;
- `/media-next/collections/` — przeglądarka kolekcji własnych i udostępnionych;
- `/media-next/account/` — profil, statystyki, kolekcje, zmiana hasła i adresu e-mail
  (podścieżka `/account/<nazwa>/` otwiera cudzy publiczny profil);
- `/media-next/admin/` — panel administracyjny w kategoriach (przegląd, konta, bezpieczeństwo,
  grupy, biblioteka, napisy, indeksowanie);
- `/media-next-api` — cienki kontroler PHP sesji, katalogu i ticketów transferowych;
- `/media-transfer` — lokalny reverse proxy wyłącznie do procesu Python.

Trasy są nazwami stagingowymi i obecnie wymagają klienta lokalnego. Konfiguracja Apache, kod
mostu i prywatny TOML niezależnie blokują zdalny HTTP. Stare trasy nie zostały przełączone.

## Struktura

```text
frontend/
  index.html
  login/ music/ movies/ collections/ account/ admin/   (wejścia HTML)
  public/theme-boot.js   motyw przed pierwszą klatką (zwykły skrypt z tego samego źródła)
  src/
    router.ts       miękki router SPA
    pages/          logika poszczególnych stron; pages/library/ — części strony biblioteki
    shared/         API, bezpieczny DOM, ikony, viewer, wizualizacje;
                    shared/player/ — trzy powierzchnie odtwarzacza (dok, kolejka, wizualizacja)
    styles/         core.css (każda strona) + app.css (aplikacja) — patrz „Arkusze stylów i tokeny”
```

Dynamiczne elementy powstają przez `createElement`/`textContent`. Kod nie korzysta z
`innerHTML` (poza stałymi, nieinterpolowanymi ikonami SVG stanu odtwarzania), inline styles,
zewnętrznych fontów ani zewnętrznego zestawu ikon. Jedyny wyjątek sieciowy to skrypt wybranego
dostawcy CAPTCHA, dociągany na stronie logowania tylko wtedy, gdy ochrona jest włączona w
panelu — dlatego szablony Apache nadają `/media-next/login/` osobną CSP dopuszczającą źródła
reCAPTCHA (v2 i v3 — te same źródła)/hCaptcha/Turnstile; reszta aplikacji zachowuje
`script-src 'self'`. Własny proof-of-work (`shared/pow.ts`, worker z tego samego źródła) nie
potrzebuje zmian w CSP i działa wszędzie.

Router SPA jest odporny na błąd montowania strony (łańcuch nawigacji z `catch`), a nieudane
pobranie sesji nie jest buforowane — kolejna nawigacja ponawia próbę.

## Wydajność i skalowanie

- podział kodu na osobne chunki stron;
- siatka oparta na `auto-fill/minmax`, bez stałej liczby kolumn;
- okno renderowania listy (`240` kart) zamiast nieskończonego DOM;
- `minmax(0, 1fr)` i `min-width: 0` zabezpieczają pełny ekran przed rozszerzaniem layoutu;
- karty używają `content-visibility: auto` i jawnego containment;
- `prefers-reduced-motion` wyłącza przejścia;
- katalog ma paginację kursorową po `media_items.id`, bez kosztownego dużego `OFFSET`;
- **pierwsze wejście (od 11.11.2026)**: każde wejście HTML aplikacji nazywa skrypt swojej strony
  obok routera (`<script type="module" src="/src/pages/<strona>.ts">`), więc Vite wypisuje w HTML
  wszystkie statyczne chunki i przeglądarka pobiera je jedną falą, a nie po odkryciu w routerze;
  angielski słownik (`shared/i18n-en.ts`, ok. 100 kB) i wizualizacje (`visualizations/kit.ts`:
  rejestr, silnik, wyszukiwarka presetów, ok. 68 kB) są osobnymi chunkami pobieranymi dopiero, gdy
  są potrzebne. JS pierwszego wejścia na strony aplikacji: 353–437 → 201–319 kB (start 245 kB,
  79 kB gzip), logowanie: JS 138 → 46 kB i CSS 125 → 23 kB, strona gościa: JS 104 → 11 kB.
  Zmierzone `tools/bundle.mjs` z audytu;
- font ikon jest proszony od startu skryptu (`primeIconFont()` w `shared/icons.ts`), równolegle
  z sesją, a nie dopiero gdy pierwsza ikona trafi do layoutu.

## Progi responsywne (świadomie nieujednolicone)

W CSS jest 18 różnych szerokości (22–88 rem) w 39 regułach w 11 plikach. Nowe reguły używają
trzech: 34, 48 i 64 rem. Reszty nie ujednolicono, bo to nie jest kosmetyka: każdy próg stoi tam,
gdzie treść jego komponentu przestaje się mieścić, więc przesunięcie zmienia układ na prawdziwych
urządzeniach (przegląd 08.11.2026):

- **46 → 48 rem** (sześć reguł: dok, podgląd filmu, filtry biblioteki, import) przełączyłoby dok
  na układ telefonu przy 768 px — tablet w pionie dostałby dok w jednej kolumnie i straciłby
  gwiazdki oceny;
- **50 → 48 rem** (kolumny „Aktywności”, formularze konta i panelu, logowanie) przywróciłoby
  kolumny przy 769–800 px tam, gdzie dziś jest jedna — do obejrzenia z prawdziwą treścią;
- **dok** (od 12.11.2026) nie pyta już o szerokość okna: układ wybiera jego własna szerokość
  (`@container dock`, progi 68 i 92 rem — obok paska bocznego szerokość okna mówi niewiele),
  a `shared/player/dock.ts` czyta tę samą szerokość (`DOCK_TWO_ROWS_REM` w `player/contracts.ts`).
  „Telefon” dla odtwarzacza to jedno zapytanie zapisane dwa razy — `PHONE_PLAYER` w `contracts.ts`
  i `@media` w `player.css` — zmieniać razem. 78 rem zostało tylko jako „od tej szerokości okna dok
  startuje zwinięty, jeśli nikt nie wybrał inaczej”.

Decyzja 09.11.2026: zostaje jak jest — ujednolicenie nic by widzowi nie poprawiło, a zmieniłoby
układ na tabletach. Propozycja mapowania, gdyby kiedyś było trzeba: 32/38/40 → 34; 43/44/46/50/52 → 48; 60/68 → 64; 74/78/80/88 bez
zmian (szkielet strony i dok). Robić wyłącznie z urządzeniami właściciela (telefon, tablet
w pionie i poziomie, laptop ok. 1280 px) i z decyzją, które komponenty mają przechodzić razem.

Progi dodane 11.11.2026 (każdy z pomiarem w komentarzu przy regule): **26 rem** — pasek biblioteki
na telefonie zamiast „Odtwórz folder” pokazuje samo „Odtwórz” (cztery kontrolki z całą frazą nie
mieszczą się w jednym rzędzie 350 px), a poniżej **21,5 rem** sam znak odtwarzania; **34 rem** — karta następnego odcinka układa obraz nad tekstem dopiero na
telefonie (na tablecie obraz obok tekstu); reguły `@media (pointer: coarse)` — cele dotyku 44 px
i pola 16 px (bez przybliżania przez iOS).

## Arkusze stylów i tokeny (od 11.11.2026)

- **Dwa wejścia zamiast jednego.** `styles/core.css` ładuje każda strona: ikony, `tokens`, `reset`,
  `base`, `components`, `utilities` i `public.css` (logowanie, strona gościa oraz to, co aplikacja
  z nimi dzieli: konfiguracja 2FA, widżet anty-bot, `.form-status`, wyłącznik animacji przy
  `prefers-reduced-motion`). `styles/app.css` ładuje tylko aplikacja (`router.ts`): `pages`,
  `library`, `metadata-editor`, `player`, `admin`, `collections`, `video-viewer`, `cards`,
  `action-menu`, `home`, `motion`, a na końcu `refinements`, `list-picker`, `panels`. Oba pliki zaczynają się
  od `@layer tokens, reset, base, components, utilities, pages;`, więc kolejność warstw nie zależy
  od tego, który arkusz przeglądarka przeczyta pierwszy. Logowanie i strona gościa nie pobierają
  `app.css`; sprawdzone na żywym DOM-ie: dołożenie arkuszy aplikacji nie zmienia stylu obliczonego
  żadnego elementu tych stron (poza niewidocznym paskiem postępu nawigacji).
- **Wszystko w `app.css` to `@layer pages`**, gdzie przy równej specyficzności wygrywa późniejsza
  reguła — kolejność importów jest częścią stylów. `refinements.css`, `panels.css`
  i `list-picker.css` są świadomie ostatnie: to nadpisania. Każdy plik ma jeden blok
  `@layer pages` (wcześniej `library.css` miał pięć).
- **Kolory tylko w `tokens.css`.** Pozostałe arkusze nie mają literałów koloru: biorą token albo
  składają przezroczystość z trójki kanałów, np. `rgb(var(--color-accent-rgb) / 12%)`. Trójki:
  `--color-accent-rgb`, `-canvas-rgb`, `-canvas-raised-rgb`, `-surface-hover-rgb`, `-overlay-rgb`,
  `-shadow-rgb`, `-highlight-rgb`, `-info-rgb`, `-focus-rgb`, `-warning-rgb`; trójka i token pełny
  to jeden kolor zapisany dwa razy — zmieniać razem. Motyw to jeden blok
  `[data-theme="…"]` przedefiniowujący te nazwy (bez `:root`, żeby podgląd motywu w ustawieniach
  mógł założyć go na zwykły element). Wyjątek: `visualizations/voltviz/stage.css`
  (lustro klas narzędziowych wizualizatora — tam kolor jest nazwą klasy). Nowe tokeny znaczeniowe:
  `--color-border-control` (obramowanie pól, kontrast 3:1), `--color-text-subtle` (4.5:1 na tle),
  `--color-on-accent`, `--color-*-border`, `--color-on-*-soft`, `--color-overlay`, `--color-scrim`,
  `--color-glass`, `--color-video-black`.
- **Wcięcia ekranu.** Każdy HTML ma `viewport-fit=cover`; `--safe-top/right/bottom/left`
  (`env(safe-area-inset-*)`) dodają je pasek górny, boczny, dok, panele i arkusze dialogów.
- **Cel dotyku bez zmiany wysokości.** Dwie małe linie doku („odtwarzane z”, linia techniczna) mają
  pod `pointer: coarse` dopełnienie do ok. 44 px i ujemny margines o tę samą wartość — jako zwykłe
  `min-height` podnosiły zwinięty dok o 29 px.
- **Prawa kolumna doku ma co najmniej szerokość swojej zawartości** (`minmax(max-content, 1fr)`),
  a od 12.11.2026 dok ma trzy układy według własnej szerokości: powyżej 92 rem jeden rząd ze
  wszystkim; 68–92 rem jeden rząd bez podpisu gwiazdek i z suwakiem głośności schowanym za
  przyciskiem (kolumna tytułu w oknie 1440 px: 246 px zamiast kilku liter); do 68 rem dwa rzędy,
  które można zwinąć do jednego. Telefon ma minigracz i arkusz — niżej.
- **Wejście kart tylko raz.** Animację `surface-enter` uruchamia atrybut `data-entering`, który
  `arrive(kontener)` z `shared/dom.ts` zakłada na ok. 0,7 s przy pierwszym narysowaniu miejsca;
  przerysowanie po literze w wyszukiwarce już jej nie powtarza.

## Wspólne klocki `shared/` (od 11.11.2026)

- `confirm.ts` — `confirmDialog({ title, message, confirmLabel, danger })` zamiast
  `window.confirm` (rola `alertdialog`, fokus na „Anuluj”, wraca na przycisk, który je otworzył).
  `toast.ts` — `showToast(tekst, "info" | "success" | "error")` zamiast `alert`; region ma
  `data-modal-exempt`, więc widać go nad dialogiem i w pełnym ekranie.
- `api.ts` — `failureText(error, fallback)` pokazuje komunikat mostu (np. „Masz już playlistę
  o tej nazwie”) zamiast zgadywać przyczynę; `isAborted(error)`; `browseLibrary`,
  `searchProfiles`, `getCollection` przyjmują `signal`. `getIndexingStatus()` pyta o
  `admin_indexing_status` (małe liczniki sekcji „Indeksowanie”, co 4 s), a gdy most jej nie zna
  (starszy most odpowiada `405` — nieznany odczyt wpada w „method not allowed”), wraca do
  `?action=admin`.
- `datetime.ts` + `formatDateTime()` w `format.ts` — każdy czas pokazywany człowiekowi przechodzi
  tędy; czyta zarówno `YYYY-MM-DD HH:MM:SS` (jak dotąd: czas lokalny), jak i ISO 8601 z przesunięciem.
  Most dokłada obok każdego pola czasu bliźniaka `<nazwa>_iso` (ta sama chwila w UTC); `adoptIsoTimes()`
  wpisuje go pod starą nazwę w jednym miejscu — tam, gdzie przychodzi odpowiedź (`request()` w
  `api.ts` i `ask()` strony gościa) — więc strony dalej czytają `created_at`, a dostają chwilę.
  Sprawdzone z przeglądarką przestawioną o sześć stref: ta sama sesja 21:56 → 15:56.
- `random-id.ts` — `randomId()` z `crypto.getRandomValues` (`crypto.randomUUID` istnieje tylko
  w bezpiecznym kontekście, a aplikacja bywa otwierana po HTTP w sieci domowej).
- `rating.ts` + `rating-steps.ts` — ocena to jeden suwak (`role="slider"`, strzałki / PageUp /
  Home / End / cyfry, Enter zatwierdza, Escape cofa), a nie dziesięć przycisków: jedna pozycja
  Tab na kartę zamiast dziesięciu.
- `section-tabs.ts` — zakładki sekcji konta i panelu (jedna implementacja): aktywna przewija się
  na środek, krawędzie paska gasną, gdy jest dalszy ciąg, etykiety są zawsze.
- `modal.ts` — elementy z `data-modal-exempt` nie są wyłączane (`inert`); dialog otwarty nad
  innym panelem modalnym sam zdejmuje z siebie `inert`; fokus wraca zawsze, gdy cel nie jest `inert`.
  Póki jakikolwiek dialog jest otwarty, strona pod nim stoi: klasa `has-open-dialog` na `<html>`
  (`base.css`: `overflow: hidden`, `overscroll-behavior: none`, przy pasku przewijania
  `scrollbar-gutter: stable`). `inert` nie zatrzymuje przewijania — kółko i palec nad nagłówkiem,
  tłem albo treścią przewiniętą do końca przewijały stronę pod okienkiem. Ramka okienka
  (`library.css`): nagłówek i treść w wierszach `auto minmax(0, 1fr)`, treść przewija się sama;
  panel stoi w środkowym z trzech wierszy `1fr auto 1.15fr`, więc jest nieco powyżej środka, ale
  nigdy ponad krawędzią ekranu (12.11.2026 (2)).
- `tooltips.ts` — dymek pokazuje się po fokusie tylko przy `:focus-visible`, nie po dotknięciu;
  żyje w elemencie pełnoekranowym, jeśli taki jest.
- `media-session.ts` — to, co system wie o muzyce: tytuł z okładką, pozycja (`setPositionState`),
  przyciski. Bez `seekbackward`/`seekforward` — iOS rysuje je w miejscu „poprzedni/następny”.
- `library-labels.ts`, `media-labels.ts` — czyste funkcje nazw (dekada, klasa obrazu, kontener
  MKV/MP4/TS, identyfikator z adresu) z testami w Node.
- `i18n.ts` + `i18n-en.ts` — tłumacz i osobny chunk ze słownikiem. Aplikacja woła
  `loadLanguage(język)` (przełącza i czeka na słownik; nigdy nie rzuca — bez słownika zostaje
  polski); powłoka woła wcześniej `preloadLanguage()` z podpowiedzią z `localStorage`
  (`media-language`), żeby słownik szedł równolegle z sesją. `setLanguage()` tylko przełącza.
  Testy, które sprawdzają angielski, importują `english` i wołają `provideDictionary("en", english)`.
- `visualizations/kit.ts` — rejestr, silnik i wyszukiwarka presetów w jednym module, pobieranym
  przy pierwszym otwarciu panelu wizualizacji (`loadVisualizers()` w `player/visualizer-panel.ts`); do tego
  czasu lista w panelu mówi „Wczytywanie wizualizacji…”, a `AudioContext` powstaje nadal w tym
  samym naciśnięciu (wymóg Safari).

## Zachowania, które warto znać (od 11.11.2026)

- **Brak sesji.** `401` → strona logowania z `?next=` zawierającym też `#fragment`; `403` →
  logowanie; każda inna awaria → ekran „Serwer nie odpowiada / Brak połączenia” z przyciskiem
  ponowienia i samoczynnym odświeżeniem po zdarzeniu `online` (bez pętli przekierowań).
- **Klawiatura.** Pierwszy element strony to „Przejdź do treści”; po miękkiej nawigacji fokus
  dostaje nagłówek strony (bez obwódki). Schowany pasek boczny jest `inert`; otwarty przenosi
  fokus do siebie, a treść pod nim jest `inert`.
- **Historia w bibliotece.** Wejście do folderu i do playlisty to wpis historii (`pushState`);
  „Wstecz” wraca do poprzedniego miejsca bez przeładowania. Router wysyła przed przerysowaniem
  anulowalne `media:popstate` — strona biblioteki obsługuje je sama.
- **Otwarcie „Muzyki” niczego nie odtwarza.** Wraca kolejka, którą słuchacz miał; gdy nic nie było
  zapisane i nic nie wybrano, nie powstaje kolejka 160 utworów i dok się nie pokazuje (wyjątek:
  link `?play=`). Decyzja właściciela z 11.11.2026.
- **Pasek filtrów nie spycha siatki.** Filtry są proszone równolegle z listą; po pokazaniu paska
  jego wysokość trafia do `localStorage` (`media-<biblioteka>-filter-bar`, piksele) i przy
  następnym wejściu to miejsce jest trzymane od pierwszej klatki. Na telefonie pasek jest zwinięty
  i nic nie rezerwuje.
- **Ładowanie.** Nowe miejsce po 150 ms pokazuje szkielet kart; błąd listy ma „Spróbuj ponownie”.
- **Telefon.** Pasek biblioteki to jeden rząd: kolejność, filtry, odtwarzanie („Odtwórz”) i „⋯”
  (pobieranie, okładka, eksport); „Pobierz wybrane” pojawia się dopiero, gdy coś zaznaczono.
- **Następny odcinek.** Panel leży w ramce wideo (w pełnym ekranie — w scenie), nagłówek
  z odliczaniem jest przyklejony, następny odcinek to osobna karta nad propozycjami; przejście do
  kolejnego odcinka zostaje w pełnym ekranie; natywny pełny ekran `<video>` jest najpierw opuszczany.
  Od 12.11.2026 odliczanie widać też jako pierścień wokół znaku odtwarzania na kadrze następnego
  odcinka (12 s, zatrzymany i przygaszony po pierwszym znaku życia w pokoju), karta odcinka wjeżdża,
  propozycje dochodzą po kolei, a panel znika wygaszeniem.
- **PWA.** `sw.js` (`shell-v3`) nie odpowiada na nawigacje do `/media-next-api` i `/media-transfer`
  (przy bazie `/` przechwytywał pobieranie), strony trzyma bez parametrów adresu, a pamięć zasobów
  czyści po nowym buildzie i ogranicza do 700 wpisów. Ikona `icon-maskable-512.png` jest pełnym
  kaflem ze znakiem w strefie bezpiecznej.

## Motyw, ruch, strona startowa, dok i karty (od 12.11.2026)

Druga fala etapu 4. Każdy punkt mówi, gdzie to jest i czego pilnować przy zmianie.

### Motyw „Estoril Blue”

- Drugi zestaw tokenów w `tokens.css` (`[data-theme="blue"]`; pierwszy to `:root,
  [data-theme="emerald"]`). Nowe nazwy w obu motywach: `--gradient-progress` (linia postępu;
  w niebieskim przechodzi w czerwień sygnatury dopiero pod koniec utworu), `--color-signature-*`,
  `--glow-ambient`, `--ambient-light` (nieruchoma poświata tła, `body::after`), `--ease-exit`,
  `--duration-sheet`, `--duration-exit`. Kontrast każdej pary tekst/tło w obu motywach liczy
  `tools/contrast.mjs` z notatek etapu (wszystkie pary ≥ AA).
- `shared/theme.ts` — lista motywów, `resolveTheme({account, stored, unsaved})`, `applyTheme()`
  (atrybut na `<html>` i `<meta name="theme-color">`). **Motyw należy do konta** (preferencja
  `theme`, zapis przez `saveUserPreferences`); `localStorage["media-theme"]` to tylko kopia dla
  następnego startu. Przełącznik: Moje konto → Ustawienia; zmiana działa od razu (przejście widoku
  rodzaju `theme`), podglądy obu motywów rysują się w swoich kolorach przez `data-theme` na elemencie.
- `public/theme-boot.js` — zwykły (nie modułowy) skrypt w `<head>` każdego wejścia: czyta kopię
  z `localStorage` i zakłada motyw przed pierwszą klatką. Osobny plik, bo CSP to `script-src 'self'`.
  Znacznik `<!--theme-boot-->` w HTML zamienia wtyczka builda (`scripts/theme-boot.mjs`) na
  `<script src="…/theme-boot.js?v=<skrót treści>">`; service worker traktuje ten adres jak zasób
  niezmienny. Kolory tła obu motywów są w trzech miejscach — `tokens.css`, `theme.ts`,
  `theme-boot.js` — i pilnuje ich `theme.test.ts`.

### Ruch

- Zasada: animowane są tylko `opacity`, `transform` (także `translate`/`scale`/`rotate`)
  i `clip-path`; wszystko stoi w `@media (prefers-reduced-motion: no-preference)` albo gaśnie przez
  wspólny wyłącznik z `public.css`. Czasy i krzywe: `--duration-*`, `--ease-*` w `tokens.css`,
  te same liczby dla skryptu w `shared/motion-math.ts` (czysta arytmetyka z testami: FLIP,
  opóźnienia kolejki, ciągnięcie arkusza, ułamek odliczania).
- `shared/motion.ts`: `startTransition(rodzaj, zmiana)` — View Transitions tam, gdzie są
  (`html[data-vt="page|swap|theme"]` wybiera czasy w `motion.css`), bez nich zmiana wykonuje się
  wprost, a treść strony wjeżdża przez WAAPI (`pageRise`). Przejście nie startuje pod zredukowanym
  ruchem, w ukrytej karcie ani gdy inne trwa. Router czeka na pierwszą treść nowej strony najwyżej
  110 ms. `flipFrom()`, `dismiss(element)` (zamknięcie z wyjściem: `aria-hidden`, potem usunięcie po
  `--dialog-exit`), `pulse()`.
- Dialogi wychodzą tak, jak wchodzą (`@starting-style` + `transition-behavior: allow-discrete`;
  przeglądarka bez nich pokazuje i chowa od razu). Na telefonie (≤ 34 rem) dialog jest arkuszem od
  dołu z uchwytem; `shared/sheet-gestures.ts` — jeden zestaw nasłuchów dla wszystkich arkuszy —
  pozwala go ściągnąć w dół za górne 72 px (nie za kontrolki). Arkusz, który sam animuje swoje
  zamknięcie (odtwarzacz), dostaje na czas zamykania `data-pulled-by` z liczbą pikseli.
- `shared/viewport.ts` — `--keyboard-inset` i `html.has-keyboard` z VisualViewport: arkusz dialogu
  stoi nad klawiaturą ekranową, a minigracz na czas pisania zjeżdża z ekranu.
- Lista nowego miejsca wchodzi kolejką (`arrive()`), karty dołożone do listy już widocznej tylko
  się pokazują (`data-appended`). Zakładki konta i panelu mają przesuwany znacznik. Powiadomienia
  mają linię życia. Gwiazdki i serce odpowiadają na naciśnięcie.

### Strona startowa

- `pages/home.ts` rysuje to, co zwraca `GET ?action=home` (kontrakt: półki z identyfikatorem,
  karty, „kontynuuj” na górze, „zaskocz mnie”, liczba ukrytych propozycji). Czysta część —
  które półki, w jakiej kolejności, jaki tytuł i jaki postęp — jest w `shared/home-model.ts`
  z testami w Node. Kolejność półek i ich wygląd to tabela `SHELVES`; nowa półka z mostu to
  jeden wpis w niej.
- Odpowiedź jest pamiętana w module (wejście z powrotem rysuje się od razu, bez szkieletu)
  i odświeżana w tle; porównanie podpisów (`homeSignature`) decyduje, czy przerysować.
- Półki „Losowe filmy / seriale / utwory” mają na każdej karcie znak odtwarzania i przycisk
  „Wylosuj inne” (prośba o jedną półkę z nowym ziarnem); odświeżenie w tle ich nie podmienia.
- Karta z pozycją (`position_ms`) znika przez `continue_dismiss`, propozycja przez `home_dismiss`;
  „Przywróć wszystkie” w stopce cofa ukrycia. Na telefonie półka przewija się w bok z przyciąganiem,
  na szerokim ekranie jest jednym rzędem z „Zobacz wszystkie”.

### Odtwarzacz: rdzeń i trzy powierzchnie

- `shared/audio-player.ts` (ok. 1470 wierszy zamiast 2862) trzyma element audio, kolejkę i jej
  stronicowanie, historię, zapisany stan, licznik odtworzeń i sesję mediów — i nic, co jest
  rysowane. Rysują trzy moduły w `shared/player/`: `dock.ts`, `queue-panel.ts`,
  `visualizer-panel.ts`; mówią z rdzeniem przez interfejsy z `contracts.ts` (`DockHandlers`,
  `QueueModel`, `VisualizerHost`). Publiczne API odtwarzacza się nie zmieniło.
- Rdzeń ogłasza zmianę utworu zdarzeniem `media:track-changed` (`detail.id`) i trzyma na `<html>`
  klasę `is-audio-playing` — po nich karta grającego utworu i wiersz kolejki pokazują trzy słupki.
- Wysokość doku jest faktem, nie zgadywaniem: dok mierzy się sam i zapisuje `--dock-height` na
  `<html>`; z tej liczby biorą odstęp dolny strony i położenie obu paneli (wcześniej trzy stałe
  w rem, po jednej na próg).
- **Telefon** (wąski ekran albo niski w poziomie): minigracz — okładka, tytuł, odtwarzanie,
  następny, kolejka, cienka linia postępu na górnej krawędzi, uchwyt — który po dotknięciu albo
  pchnięciu w górę otwiera się w arkusz na cały ekran. Arkusz jest dialogiem (strona pod nim
  `inert`, Escape zamyka), zamyka się przyciskiem, ściągnięciem w dół albo zmianą strony; wizyta
  zawsze zaczyna się od minigracza. Okładka przelatuje między małym a dużym miejscem (FLIP),
  arkusz odsłania się `clip-path` od paska minigracza. Rozmiary są płynne (`clamp`, `vmin`, `dvh`,
  jednostki kontenera dla okładki, wcięcia ekranu jako przezroczyste obramowanie doku) — od 320 px
  po duże telefony i poziom; niski ekran zdejmuje kolejno głośność i linię techniczną.
- Suwak głośności znika tam, gdzie strona nie może ustawić głośności (iPhone: `audio.volume` jest
  tylko do odczytu) — do chwili, gdy głośnością steruje węzeł `GainNode` wizualizacji.
- Panel kolejki na szerokim ekranie wyrasta z rogu nad dokiem, na telefonie jest arkuszem zza
  minigracza; panel wizualizacji odsłania się od dołu. Oba mają wejście i wyjście.

### Biblioteka: części strony i karty

- `pages/library-page.ts` (1386 wierszy zamiast 2421) trzyma stan miejsca, pasek, nawigację,
  budowanie kolejek i wczytywanie list. Reszta jest w `pages/library/`: `cards.ts` (trzy rodzaje
  kart; czego potrzebują od strony, mówi `CardContext`), `previews.ts` (obrazy kart: leniwe,
  z kolejnymi kandydatami, obracane w folderach), `grid-window.ts` (okno 240 kart), `filters.ts`
  (pasek filtrów i adres), `collection-picker.ts`, `cover-dialog.ts`, `transfers.ts`.
- Karty (`styles/cards.css` — reguły zebrane z `pages.css`, `library.css` i `refinements.css`;
  `grid-window.css` wszedł do tego pliku): okładka utworu cała i kwadratowa, kadr filmu 16:9
  z klasą obrazu, HDR i czasem na obrazie, folder i playlista ze znakiem w rogu zamiast glifu na
  środku. Naciśnięcie karty gdziekolwiek robi to, co jej obraz (rozciągnięty obszar przycisku);
  ścieżka pliku jest podpowiedzią karty, nie trzecim wierszem tekstu. Stopka: gwiazdki, serce
  i „⋯” (`shared/action-menu.ts`) z resztą działań. Pod palcem gwiazdki i strzałki kolejności
  playlisty przechodzą do tego menu — `cards.ts` sprawdza przy otwarciu, co arkusz stylów schował.
- `shared/action-menu.ts` — krótkie menu przy przycisku, na `<body>` (karta przycina swoją
  zawartość), jedno naraz; strzałki, Home/End, Escape oddaje fokus. Położenie liczy
  `action-menu-place.ts` (test w Node).
- Poprawka przy okazji: filtry muzyki odczytywały `hires` z adresu do złego pola, gdy biblioteka
  miała gatunki albo dekady — link z `?hires=yes` otwierał się bez tego filtra.

### Czego nie ruszono

- `refinements.css` i `panels.css` nadal istnieją: zostały w nich reguły części, których ta fala
  nie dotykała (nakładka podglądu filmu, panele konta i administracji, edytor okładki). Reguły
  doku, wizualizacji, zakładek sekcji, kart i paska biblioteki wróciły do plików swoich komponentów.
- Font ikon bez zmian (decyzja właściciela).
- Linia postępu na kartach filmów w bibliotece czeka na most: lista `browse` nie podaje pozycji
  oglądania (strona startowa ją ma z `home`).

## Sesja i transfer

Token sesji pozostaje w cookie PHP i nie trafia do `localStorage`. Frontend pobiera token CSRF
do pamięci bieżącej karty. Odtwarzanie i pobieranie rozpoczyna się dopiero po otrzymaniu
krótkiego ticketu dla serwerowego `media_item_id`. Przeglądarka nie wysyła do mostu ścieżki
pliku. ZIP jest uruchamiany formularzem POST, dzięki czemu duży token listy nie trafia do URL.
Przekroczenie godzinowego limitu pobierania kończy się odpowiedzią `429` i czytelnym
komunikatem w interfejsie.

Wylogowanie korzysta z POST chronionego CSRF i usuwa cookie sesji. Uprawnienia interfejsu
(pobieranie, oceny, kolekcje, udostępnianie) wynikają z pola `permissions` sesji, rozwiązanego
z grupy uprawnień konta.

**Wyzwania i krok w górę (od 11.11.2026).** `shared/captcha.ts` montuje widżet dostawcy, którego
nazwał serwer, a `token(action)` jest asynchroniczne dla wszystkich: reCAPTCHA v3 wykonuje się przy
wysyłce, proof-of-work (`shared/pow.ts`, wyszukiwanie w `shared/pow-worker.ts`, bez workera —
porcjami na głównym wątku) pobiera wyzwanie z `captcha_challenge` i liczy w tle, pokazując cichy
pasek postępu. Żeton jest jednorazowy — po każdej próbie `reset()`. Odpowiedź `428
captcha_required` obsługuje **jedno miejsce**: `request()` w `shared/api.ts` — pokazuje okno
`shared/step-up.ts` (proof-of-work i v3 bez klikania, widżet z przyciskiem „Dalej”), wymienia
rozwiązanie na przepustkę (`captcha_pass`), a potem powtarza odrzucone żądanie z bieżącym tokenem
CSRF. Równoczesne odmowy czekają na jedno okno; zamknięcie okna to `ApiError(428)`. Żądania
`keepalive` nie pytają. W aplikacji serwer zawsze każe proof-of-work (CSP stron aplikacji to
`script-src 'self'`); dostawcy zewnętrzni działają tylko na stronie logowania. `429` niesie
`retry_after` i komunikat mostu (pauza albo blokada).

**Weryfikacja dwuetapowa.** Logowanie (`signIn`) może odpowiedzieć `two_factor: "code"` albo
`"setup"` (administrator, gdy jest wymagana; razem z sekretem) — `login.ts` rysuje wtedy drugi
krok (kod z aplikacji albo kod odzyskiwania, `signInSecondFactor`). Konfiguracja w „Moje konto” →
Bezpieczeństwo (`twoFactorPanel`): hasło → kod QR, klucz tekstem i link `otpauth://` (dotknięcie
na telefonie otwiera aplikację) → pierwszy kod → kody odzyskiwania pokazane raz (kopiuj, zapisz do
pliku). Wspólne kawałki: `shared/two-factor-ui.ts`. Kod QR rysuje własny koder
`shared/qr.ts` (bajty UTF-8, poziom M, wersje 1–15, SVG ciemne na białym) — sekret nie wychodzi do
żadnej usługi; `qr.test.ts` porównuje macierze z segno 1.6 (wersje 1–2 i 4–15, wszystkie maski),
a kody z przeglądarki dekoduje zxing (sprawdzone przy pisaniu). Maskę wybiera kara liczona na
gotowym symbolu (jak ZXing), więc przy automatycznej masce bywa inna niż w segno, który liczy ją
przed wpisaniem informacji o formacie — oba kody są poprawne.

**Panel → Bezpieczeństwo**: dostawca z kluczami osobno dla każdego (przełączenie listy pokazuje
zapisany klucz publiczny i to, czy sekret jest), minimalny wynik v3, trudność proof-of-work,
wyzwanie przy logowaniu (zawsze / po N nieudanych / nigdy), progi drabiny (tabela: wyzwanie od,
pauza od, okno w sekundach), wymóg 2FA dla administratorów, a pod formularzem lista
„Ograniczeni i zablokowani” z „Odblokuj”. Karta użytkownika: znaczek „2FA” i „Zresetuj 2FA”.

## Odtwarzacz, kolejka i „Moje konto”

Stan po poprawkach z audytu (08.11.2026; pomiary w przeglądarce, kolejka 160 wierszy):

- **Wiersze kolejki powstają tylko przy otwartym panelu.** Zmiana utworu przesuwa znacznik
  (`aria-current`) zamiast przebudowywać okno: wcześniej każdy utwór, także przy zamkniętym
  panelu, to ok. 2 000 elementów i 5–10 ms, teraz dwa atrybuty i ok. 1 ms. Zmiana przy
  zamkniętym panelu oznacza wiersze jako nieaktualne i otwarcie rysuje je raz; ocena utworu
  odmalowuje tylko jego wiersz.
- **Stan w `localStorage` ma dwa klucze.** `media-player-state-v1:<id>` — migawka kolejki (do
  400 pozycji, ok. 90–220 KB) — zapisuje się przy zmianie kolejki, utworu, trybu i okna;
  `media-player-progress-v1:<id>` (ok. 150 B: utwór, sekunda, czy gra) co 2,5 s odtwarzania
  i przy play/pauzie. Przy przywracaniu wygrywa nowszy zapis o tym samym utworze
  (`resumePoint`). Wcześniej co 2,5 s zapisywała się cała migawka, a przy zmianie utworu trzy razy.
- **`player.ready()`** czeka tylko na odczyt stanu z pamięci przeglądarki. Bilet strumienia
  przywróconego utworu przychodzi w tle, więc strona po F5 rysuje się od razu; play naciśnięty,
  zanim bilet dojdzie, jest zapamiętany i wykonany po jego przyjściu.
- **`AudioContext` wizualizacji jest wznawiany** przy każdym play (naciśnięcie, zdarzenia `play`
  i `playing`), przy zmianie jego stanu w trakcie grania i po powrocie karty na wierzch. Po
  przerwaniu (rozmowa, Siri, ekran blokady) iOS zostawiał go wstrzymanego, a muzyka „grała”
  bezgłośnie.
- **Panel kolejki jest modalny** (`openModal` z opcją `alsoActive`): strona pod nim jest `inert`,
  fokus wchodzi na listę, Escape zamyka, a fokus wraca do przycisku, który go otworzył. Dok i tło
  panelu zostają aktywne, bo dok celowo leży nad tłem.
- **Budowanie kolejki w bibliotece** (`library-page.ts`) ma dwa żetony: `queueRequest` (najnowsze
  żądanie; starsze, czekające na pierwszą stronę, odpada) i `installedQueue` (kolejka, którą
  trzyma odtwarzacz; jej loadery działają, dopóki inna jej nie zastąpi). Nieudana albo pusta
  nowa kolejka nie psuje już tej, która gra. „Odtwórz folder” czeka na wszystkie trwające
  budowania (licznik) i zawsze wraca do życia.
- **Wyłączenie losowania na playliście** szuka grającego utworu poza wczytanym oknem: czyta
  kolejne strony listy w jej porządku (najwyżej 10 × 100 pozycji, `findInPages`), a kolejka idzie
  dalej od jego miejsca. Dalej niż to utwór gra na czele kolejki, a lista w porządku po nim.
- **Podgląd filmu:** Escape w trakcie przechodzenia do następnego odcinka wygrywa — `open()`
  po zatrzymaniu poprzedniego filmu (w trybie zgodnym czeka na anulowanie strumienia, do 4 s)
  sprawdza, czy podgląd nie został w tym czasie zamknięty (`openIntent`). Nieudane przewinięcie
  w trybie zgodnym zwalnia oś czasu (`media:compatible-seek-failed`), która wcześniej zostawała
  na żądanej sekundzie.
- **Inne urządzenia w panelu kolejki** (od 11.11.2026) idą za „Aktywnymi sesjami”. Kolejka
  urządzenia pamięta sesję, która ją zapisała (`playback_queues.session_hash`, migracja 045; skrót
  SHA-256 jak w `user_sessions`, nigdy sam identyfikator), a most dzieli wiersze
  (`CatalogActions::visibleQueueDevices`, test `tests/test_php_queue_devices.py`):
  - sesja otwarta (widziana w czasie życia sesji PHP, jak w panelu sesji) — „Na innych
    urządzeniach”, przycisk „Przejmij” (tamto urządzenie się zatrzymuje);
  - sesja zamknięta (wylogowanie, „Wyloguj wszystkie oprócz tej”, nowe hasło) — wcale;
  - reszta (sesja wygasła sama albo wiersz sprzed migracji) — przez 7 dni w „Ostatnio na innych
    urządzeniach”, przycisk „Wznów tutaj” i × „Zapomnij to urządzenie” (`playback_queue_forget`).
    Z kilku takich wierszy o tej samej nazwie zostaje najnowszy, a nazwa urządzenia, które jest
    teraz zalogowane, chowa jej starsze wiersze (to zwykle ta sama przeglądarka pod nowym
    identyfikatorem po wyczyszczeniu danych). Nazwa urządzenia, które pyta, nie chowa niczego:
    drugi komputer „Windows · Chrome” zostaje.
  Wcześniej lista brała każdą kolejkę z 30 dni, więc telefon wylogowany wczoraj był do „Przejmij”,
  a „Aktywne sesje” pokazywały tylko komputer. Ramka urządzeń ma do 15rem (najwyżej 38% wysokości
  ekranu), żeby zmieściły się obie grupy.
- **Sterowanie filmu w trybie zgodnym** (`compatibleControls`, od 11.11.2026):
  - na telefonie i każdym ekranie dotykowym (`max-width: 46rem` albo `pointer: coarse`) pasek ma
    własny wiersz na całą szerokość, a pod nim: odtwórz, −10 s, +10 s, czas, dźwięk, pełny ekran.
    Wcześniej pasek dzielił wiersz z przyciskami (ok. 200 px na telefonie: pół minuty na piksel
    w dwugodzinnym filmie), a reguła chowająca „ostatni przycisk” chowała pełny ekran;
  - pasek bierze wskaźnik na siebie (`.viewer-controls__progress-wrap`; sam range służy klawiaturze
    i czytnikom ekranu): mysz stawia pozycję tam, gdzie wskazuje, i przed kliknięciem pokazuje
    czas pod kursorem; palec ląduje tak samo, a potem przesuwa pozycję od miejsca, w którym jest —
    tym wolniej, im wyżej nad paskiem (`seek-gesture.ts`: od 48 px ×½, od 96 px ×¼, od 144 px ×⅒;
    dymek mówi „dokładnie ×¼”);
  - dwa stuknięcia w lewą albo prawą trzecią część obrazu: −/+10 s, każde kolejne 10 s więcej
    („+30 s” na obrazie); pojedyncze stuknięcie z boku czeka 320 ms na drugie. W pełnym ekranie
    z ukrytym sterowaniem pierwsze stuknięcie tylko je pokazuje. Mysz: klik nadal pauzuje;
  - klawisze na pasku: strzałki ±10 s, PageUp/PageDown ±60 s, Home/End (range ma krok 0,01 s,
    więc strzałka nie ruszała się wcale); kolejne naciśnięcia sumują się w jeden restart (650 ms);
  - pełny ekran: scena przez `requestFullscreen`, Safari przez `webkitRequestFullscreen`,
    a iPhone (bez pełnego ekranu elementu) przez odtwarzacz samego wideo; telefon obraca się do
    poziomu (`screen.orientation.lock`, oddawane przy wyjściu);
  - w nagłówku podglądu na telefonie zostają ikony „Pobierz” i „Odtwórz oryginał” z nazwą na
    przycisku — wcześniej reguła chowała wszystkie `span`, także ikony, i zostawały puste kwadraty.
- **Zapas filmu w trybie zgodnym (Media Source)** (`stream-buffer.ts`, `mp4-codecs.ts`, od
  11.11.2026). Tryb zgodny wysyła film jako pofragmentowane MP4 (FFmpeg, fragment co 2 s) na
  jednej długiej odpowiedzi. Podany jako `src`, Chrome trzymał z niego stale tylko 2,3–2,4 s do
  przodu (pomiar na komputerze i telefonie), więc każde zwolnienie łącza zatrzymywało obraz. Teraz
  strona sama czyta odpowiedź i podaje ją `SourceBuffer`owi, aż przed odtwarzaniem leży zapas
  z ustawień (`video_buffer_seconds`, panel admina „Zapas filmu w trybie zgodnym”, domyślnie 60 s,
  0 = jak dawniej), potem przestaje czytać (FFmpeg na serwerze czeka za swoim buforem) i czyta
  dalej, gdy film idzie. Pliki zostają bez zmian. Za odtwarzaniem zostaje 30 s; pełny przydział
  przeglądarki (ok. 150 MB obrazu na komputerze, mniej na telefonie) obniża zapas zamiast
  przerywać. Kodeki do `addSourceBuffer` czyta `mp4-codecs.ts` z nagłówka (avcC, hvcC, av1C, vpcC,
  esds; testy na ręcznie zbudowanych pudełkach). Przewinięcie w obrębie wczytanego zapasu nie
  zaczyna nowego strumienia: element przewija w miejscu (±10 s od razu); dalej — nowy strumień
  jak dotąd. Zerwany strumień kończy źródło błędem, a obsługa błędów podglądu zaczyna nowy od tej
  samej sekundy; strumień, którego kodeków Media Source nie przyjmie, i przeglądarka bez Media
  Source (iPhone) grają jak dawniej (`src`). Sprawdzone na żywo (H.264 i HEVC, komputer i
  emulowany telefon): zapas 60 s po kilku sekundach, +10 s bez nowego strumienia, skok o 3 min
  z nowym, koniec filmu z „Co dalej”.
- **„Moje konto” buduje się raz.** Zmiana odmalowuje tylko swój panel: widoczność profilu — okno
  udostępniania (bez zapytań), edycja, anulowanie i usunięcie listy — jej kartę (licznik
  kolekcji lokalnie), nowa lista z formularza albo z importu — jedno zapytanie `account`
  (liczniki i nowa karta na początku siatki), import ocen — liczniki i listy ocenionych oraz
  ulubionych tej biblioteki. Wcześniej każda z tych zmian czytała konto od nowa i przebudowywała
  stronę (z przeglądu 1 + 8 zapytań), gubiąc przegląd importu, wpisane hasła i otwartą edycję
  innej listy, a okno udostępniania zostawało na „Zapisywanie…”.

## Komendy developerskie

Wymagany jest Node zgodny z aktualnym Vite. Zależności są przypięte przez `package-lock.json`.

```powershell
cd frontend
npm ci
npm run build
npm run test:ui
```

Na Debianie polecenia są identyczne. Node jest potrzebny do budowania ze źródeł, ale nie do
serwowania gotowych statycznych plików wydania.

## Ikony: Font Awesome Free i opcjonalnie Pro

Interfejs rysuje ikony z **Font Awesome Free 7** (styl Solid) — to działa w każdej instalacji,
bez żadnej konfiguracji. Lista ikon jest w `src/shared/icons.ts`, a ich kody w przyciętym
`src/styles/icons.css`; test `icons.test.ts` pilnuje, żeby obie listy się zgadzały.

Właściciel z licencją **Font Awesome Pro** może dać administratorom wybór stylu (Light, Thin,
Duotone, Sharp…):

1. Pobierz z konta Font Awesome paczkę **Web** dla wersji 7 i rozpakuj ją do
   `frontend/vendor/fontawesome-pro/` (tak, żeby leżały tam `css/`, `webfonts/`, `metadata/`
   i `manifest.json`).
2. Zbuduj front: `npm run build`. W logu pojawi się np. `Font Awesome Pro 7.3.1: 16 styles on
   offer`.
3. W panelu: **Administracja → Biblioteka → Ikony** wybierz zestaw „Font Awesome Pro” i styl;
   podgląd zmienia się od razu, a po zapisaniu styl widzą wszyscy od następnego otwarcia strony.

Build (`scripts/icon-packs.mjs`) nie bierze całego CSS paczki: kopiuje tylko pliki fontów
oferowanych stylów i generuje mały arkusz, który ustawia dwie zmienne CSS (rodzinę i grubość).
Styl trafia na listę tylko wtedy, gdy według metadanych paczki ma **każdą** ikonę interfejsu —
inaczej gdzieś pojawiłby się pusty kwadrat. Bez paczki, albo po buildzie bez niej, ustawienie
„Pro” po cichu rysuje Free.

**Rozmiar fontu (stan 11.11.2026).** Font Free to 116 kB dla 58 ikon, a każdy font Pro 380–600 kB.
Zostaje `font-display: block` (ikony nie mają zamiennika — `swap` rysowałby puste kwadraty), a font
Free jest proszony od startu skryptu (`primeIconFont()`), równolegle z sesją. **Przycięcie fontu
do używanych ikon nie jest zrobione i wymaga decyzji właściciela**: fonty Font Awesome 7 są
w formacie CFF, więc przycinanie potrzebuje narzędzia (nowa zależność buildu, np. `subset-font`
albo `fonttools`), a „Font Awesome” jest nazwą zastrzeżoną licencji OFL — przycięty font Free
musiałby dostać inną nazwę wewnętrzną. Alternatywa bez fontu: ikony z plików SVG paczki Free
(CC BY 4.0), ale to zmienia mechanizm stylów Pro.

> **Licencja.** Font Awesome Pro wolno używać na własnym serwerze, ale nie wolno go publikować.
> Katalog `frontend/vendor/` jest w `.gitignore` i nie może trafić do publicznego repozytorium ani
> do paczki wydania; wynik buildu (`public/assets/build/`) również jest ignorowany. U właściciela
> cały `frontend/vendor/` (z Pro) jest osobnym, **prywatnym** repozytorium,
> [media-server-vendor](https://github.com/TryHackX/media-server-vendor), klonowanym w to miejsce
> przed instalacją z klona (`README.md`, *From a clone of this repository*).

## Dźwięk wizualizacji przy 96/192 kHz

`AudioContext` odtwarzacza ma częstotliwość karty dźwiękowej: zwykle 44,1 lub 48 kHz, ale
u właściciela 192 kHz. Wszystkie wizualizacje są strojone pod 44,1/48 kHz (okno N próbek, widmo
do ~22 kHz). Czytane wprost przy 192 kHz te same N próbek to ćwierć okna, a słyszalne widmo
zajmuje pierwszą ćwiartkę binów. Dlatego szybszy kontekst jest czytany jak 48 kHz
(`visualizations/audio-rate.ts`):

- `rateFactor()` daje 1 przy 44,1/48 kHz, 2 przy 88,2/96, a 4 przy 176,4/192 kHz;
- silnik ustawia analizator `fftSize × factor`. Wtyczki 2D dostają przebieg uśredniony w dół
  (`decimate`) i tylko słyszalne biny, a `frame.sampleRate` to częstotliwość po przeliczeniu
  (z niej liczą pasma `frequencyValue` i `frequencyAverage`);
- AVS (`avs/analyser.ts`) bierze z lewego i prawego kanału (dwa analizatory za rozdzielaczem)
  najnowsze 576 × factor próbek i uśrednia je do 576, czyli okna, jakie dawał Winamp;
- MilkDrop i Geiss: butterchurn dostaje próbki od nas — lewy i prawy kanał przez dłuższe
  analizatory (`stereoTap`), środek jako ich średnią — w `render({ audioLevels })`, a kontekst
  widzi z częstotliwością 48 kHz (`atRate`), bo z niej liczy pasma basu, środka i góry;
- Internal (każda wizualizacja ma własny analizator), Geiss (Winamp) (`geiss/index.ts`, jak AVS:
  576 próbek z lewego i prawego kanału) i Formy dźwięku (`soundforms/audio.ts`) robią to samo
  u siebie, a VoltViz w `voltviz/audio/host/rate.ts`.

Odtwarzanie się nie zmienia (kontekst nadal gra z częstotliwością karty), a przy 44,1/48 kHz
każda ścieżka działa dokładnie jak wcześniej.

**Głośność.** Od chwili, gdy wizualizacja przepuści dźwięk przez Web Audio
(`createMediaElementSource`), głośność i wyciszenie odtwarzacza to `GainNode` **za** analizatorem,
a element `<audio>` gra na pełnej głośności (`audio-player.ts`, `applyVolume`). Wizualizacje
widzą więc muzykę taką, jaka jest, jak w Winampie (dane brane przed głośnością). Wcześniej
suwak na 30 % dawał im trzecią część sygnału, a wyciszenie ciszę.

## Wizualizacje Fable w „Internal” (WebGL 2)

Dziesięć własnych wizualizacji rysowanych w WebGL 2, każda z czterema presetami (razem 40), jako presety wizualizatora
„Internal” obok jego szesnastu wizualizacji 2D. Są oryginalne — żadna nie odtwarza istniejącego wizualizatora ani
shadera; klasyczne są tylko techniki (stabilne płyny, reakcja–dyfuzja, fraktalne płomienie, śledzenie promieni po polu
odległości, parkietaże hiperboliczne).

### Pliki

| Plik | Co robi |
|---|---|
| `frontend/src/shared/visualizations/fable/catalog.ts` | Lista: 10 wizualizacji, ich presety, nazwy po polsku (klucze i18n), co która potrzebuje (`usesSource`, `gentle`), `load()` — dynamiczny import jej modułu. Identyfikator presetu w „Internal”: `<wizualizacja>--<preset>`, np. `liquid-silk--oil`. Bez zależności, więc lista i wyszukiwarka nie pobierają żadnej wizualizacji. |
| `fable/support.ts` | `fableSupported()` — WebGL 2 i bufor zmiennoprzecinkowy do rysowania (`EXT_color_buffer_float` albo `…_half_float`). Pytane raz; lista i katalog wyszukiwania idą za tą samą odpowiedzią. |
| `fable/host.ts` | Jedno płótno i jeden kontekst WebGL 2 dla wszystkich presetów: pobieranie modułu, kompilacja w tle, przenikanie w GL, analiza dźwięku, obraz źródłowy, adaptacyjna rozdzielczość. |
| `fable/overlay.ts`, `fable/stage.css` | Przycisk „Wybierz obraz lub wideo” nad obrazem (wygląd jak „Upload Image” VoltViz) i okrągły „Wróć do okładki”. |
| `fable/core/kit.ts` | Warstwa WebGL 2: programy, cele zmiennoprzecinkowe, pary ping-pong, przebiegi pełnoekranowe i chmury punktów, pomiar czasu GPU. |
| `fable/core/audio.ts` | `AudioAnalysis` — pasma, obwiednie, wykrywanie stopy, faza taktu, „czas muzyczny”; tekstura `uSpec` (128 pasm + przebieg). |
| `fable/core/post.ts` | Od obrazu HDR do ekranu: bloom na sześciu oktawach, krzywa tonalna zachowująca barwę, **regulator luminancji**, gradacja, ziarno i dithering. |
| `fable/core/source.ts` | Obraz źródłowy: okładka / obraz / klatka wideo jako tekstura sRGB, a bez nich — rysowany na bieżąco „obraz zastępczy”. |
| `fable/core/adaptive.ts` | `AdaptiveScale` — skala rozdzielczości roboczej według czasu klatki. |
| `fable/core/glsl.ts`, `fable/core/types.ts` | Wspólny GLSL (szum, palety, interferencja cienkiej warstwy) i kontrakt wizualizacji (`FvDefinition`, `FvInstance`, `FvFrame`). |
| `fable/vis/01…10-*.ts` | Wizualizacje; każda eksportuje `definition` i jest osobnym kawałkiem builda (4,5–12 kB gzip). |
| `internal.ts`, `internal-plugin.ts` | „Internal”: lista, Auto, przenikanie, a teraz także warstwa Fable. |

Testy (w `test:ui`): `fable/catalog.test.ts` (kształt listy, identyfikatory, tłumaczenia, zgodność listy z modułami i
z katalogiem wyszukiwania), `fable/core/adaptive.test.ts`, `fable/core/audio.test.ts`.

### Jak to działa

- **Lista.** `internalPresetGroups()` zwraca grupę bez nagłówka (16 wizualizacji 2D, jak dotąd) i — gdy przeglądarka
  potrafi je narysować — dziesięć grup z nagłówkiem (nazwa wizualizacji) po cztery presety. Tę samą funkcję wywołuje
  lista wizualizatora (`presetGroups`) i katalog wyszukiwania (`catalog` we wtyczce), więc obie pokazują to samo. Nazwy
  po polsku są kluczami i18n; angielskie są w jednym bloku `i18n-en.ts`.
- **Jedno płótno.** Host tworzy się przy pierwszym presecie Fable. Moduł wizualizacji pobierany jest dynamicznie przy
  pierwszym pokazaniu jej presetu; programy kompilują się w tle (`KHR_parallel_shader_compile`), a obraz na ekranie
  gra dalej. Dopiero gotowy preset wchodzi na ekran.
- **Przenikanie.** Fable→Fable: host rysuje oba presety do dwóch celów i miesza je w GL przez 1,2 s. Każda inna para
  (2D→Fable, Fable→2D, 2D→2D): płótno wchodzące narasta nad dotychczasowym przez `opacity` w CSS
  (`.internal-stage__layer`), jak dotąd.
- **Auto, ulubione, blokada, „›”.** Bez zmian w panelu: presety Fable są zwykłymi pozycjami `presets()`. Auto tasuje
  wszystkie 56; każde pokazanie presetu Fable dostaje nowe ziarno losowe, więc powrót do presetu nie powtarza obrazu.
  Preset, którego nie udało się pobrać, skompilować ani narysować, jest w tej wizycie pomijany; jeśli był wybrany
  ręcznie, obraz przejmuje Auto (zapisany wybór się nie zmienia).
- **Kompilacja bez zacięć.** Programy o kilku wyjściach są w `kit.ts` rozkładane na jeden program na wyjście, a rysowanie
  do celu o kilku załącznikach — na jeden przebieg na załącznik. Powód zmierzony: ANGLE na Direct3D kompiluje taki
  program dla jednego wyjścia przy linkowaniu, a drugi raz — w wątku GPU, przy pierwszym rysowaniu — i obraz całej
  strony stał wtedy 0,15–0,9 s przy każdym starcie takiego presetu. Po zmianie: najdłuższa przerwa między klatkami przy
  przełączaniu Fable→Fable 7 ms (pomiar niżej). Koszt: przebiegi o dwóch wyjściach liczą się dwa razy.

### Presety

| # | Wizualizacja | Presety | Obraz źródłowy | Tryb łagodny |
|---|---|---|---|---|
| 1 | Płynny jedwab | Oliwa na wodzie, Opal, Żar, Głębia | — | — |
| 2 | Zorza nad jeziorem | Zieleń polarna, Fiolet i róż, Lodowy błękit, Czerwona korona | — | — |
| 3 | Mgławica miliona iskier | Galaktyka spiralna, Mgławica emisyjna, Meduza, Bliźniacze wiry | — | — |
| 4 | Kryształowa katedra | Ametyst, Szmaragd, Lód, Bursztyn | — | — |
| 5 | Ocean światła | Laguna, Złota godzina, Bioluminescencja, Pryzmat | — | — |
| 6 | Oddychające ściany | Oddech, Roztopy, Smugi, Geometria | tak | domyślny |
| 7 | Spirala Droste | Spirala, Kalejdoskop, Podwójna helisa, Okno w oknie | tak | domyślny |
| 8 | Żywe wzory | Koral, Perły, Filigran, Koronka | tak | domyślny |
| 9 | Fraktalne płomienie | Pajęczyna, Mandala, Galaktyka, Skrzydła | tak (paleta) | domyślny |
| 10 | Tunel hiperprzestrzeni | Neon {7,3}, Witraż {5,4}, Apeirogon {∞,3}, Kryształ {4,5} | tak | domyślny |

### Dźwięk

Host ma własny `AnalyserNode` za węzłem odtwarzacza: `fftSize` 2048, `smoothingTimeConstant` 0,5, zakres
**−90…−10 dB**. Domyślny zakres −100…−30 dB obcina głośne nagrania: biny basu stoją na 255 przez cały takt i stopy nie
da się odróżnić od reszty. Na urządzeniu szybszym niż 48 kHz węzeł jest dłuższy i czytany w dół, jak w „Internal”
(`audio-rate.ts`).

`AudioAnalysis` raz na klatkę liczy z bajtów widma i przebiegu:

- pasma `bass`, `lowMid`, `mid`, `high`, `air` i głośność `level` — w dziedzinie mocy, każde względem własnego
  niedawnego szczytu i dołka (cichy fragment porusza obrazem jak głośny), przez obwiednię atak/zanik;
- `kick` — początek uderzenia w basie (35–130 Hz), z czasem martwym **0,34 s**: nic sterowanego stopą nie pulsuje
  częściej niż trzy razy na sekundę; `hat` — to samo w górze widma (iskry);
- `beat`, `period`, `beatPhase`, `beatConfidence` — licznik uderzeń i oszacowanie tempa; `breath` — faza obracająca
  się raz na takt; `flow` — „czas muzyczny”, który nigdy nie staje; `presence` — głośność bezwzględna (cisza = 0).

Wspólna zasada odwzorowania: stopa napędza ruch, geometrię i miejscowy blask (nigdy jasność całego kadru), bas —
falowanie i wir, środek — turbulencję i tempo pełzania, góra — iskry i połysk; w ciszy obraz żyje dalej na `flow`.

### Obraz źródłowy (presety 6–10)

Kolejność: obraz lub wideo wybrane przez słuchacza → okładka granego utworu → obraz zastępczy rysowany w shaderze.

- Okładka jest czytana tam, gdzie pokazuje ją odtwarzacz — `navigator.mediaSession.metadata.artwork`, a bez niej
  obrazek w doku (`.audio-dock__artwork-image`) — raz na sekundę, tak samo jak robi to VoltViz.
- Własny plik (`image/*`, `video/*`) czytany jest przez `URL.createObjectURL`: **nie jest nigdzie wysyłany ani
  zapisywany**. Zostaje do zamknięcia strony albo do „Wróć do okładki”. Wideo gra wyciszone w pętli i tylko wtedy, gdy
  pokazuje je preset. Pliku, którego przeglądarka nie umie pokazać, przycisk odmawia komunikatem na 3 s.
- Przycisk jest widoczny tylko nad presetami, które używają obrazu; chowa się razem z paskiem panelu
  (`.visualizer-panel__overlay`). Kamery nie ma.

### Wydajność

Adaptacyjna rozdzielczość: `AdaptiveScale` obniża skalę roboczą (do 0,35), gdy klatka trwa za długo, i ostrożnie ją
podnosi; kieruje się czasem GPU klatki (`EXT_disjoint_timer_query_webgl2`), a gdzie go nie ma — odstępem między
klatkami. Budżet: 16,7 ms, na urządzeniach z dotykiem 33,3 ms. Płótno ma najwyżej 2560×1440 pikseli i współczynnik
pikseli do 2. Mgławica i Płomienie zmniejszają też liczbę cząstek.

Czas GPU jednej klatki (mediana, RTX 3080 Ti, ANGLE D3D11, GPU zajęte w ok. 55–60 % innymi programami):

| Wizualizacja | 1920×1080 | 780×1688 przy skali 0,5 |
|---|---|---|
| Płynny jedwab | 0,43 ms | 0,21 ms |
| Zorza nad jeziorem | 1,16 ms | 0,31 ms |
| Mgławica miliona iskier | 2,58 ms | 0,38 ms |
| Kryształowa katedra | 1,35 ms | 0,41 ms |
| Ocean światła | 0,82 ms | 0,23 ms |
| Oddychające ściany | 0,93 ms | 0,26 ms |
| Spirala Droste | 0,22 ms | 0,10 ms |
| Żywe wzory | 0,35 ms | 0,16 ms |
| Fraktalne płomienie | 1,66 ms | 0,33 ms |
| Tunel hiperprzestrzeni | 0,37 ms | 0,16 ms |

Start presetu w przeglądarce, która nic jeszcze nie skompilowała: wątek strony jest zajęty najwyżej ok. 12 ms
(utworzenie) i 2–4 ms (pierwsza klatka); kompilacja w tle trwa 0,1–0,7 s, dla Oceanu ok. 1,3 s, a dla Kryształowej
katedry **ok. 6 s** — przez ten czas gra dotychczasowy obraz.

### Bezpieczeństwo dla osób wrażliwych na błyski

- Regulator luminancji w `post.ts` mierzy średnią luminancję gotowej klatki i ogranicza tempo jej zmian: obraz może
  szybko pojaśnieć, ale ciemnieje nie szybciej niż 0,3 na sekundę, więc para przeciwnych zmian o 10 % pełnej
  luminancji („błysk” z WCAG 2.3.1) nie zmieści się więcej niż trzy razy w sekundzie. W trybie łagodnym ograniczone
  jest też rozjaśnianie.
- Tryb łagodny jest domyślny dla presetów 6–10 (pole `gentle` w `catalog.ts`) i dla wszystkich, gdy system prosi o
  mniej ruchu (`prefers-reduced-motion`). Przełącznika w panelu nie ma.
- Filmy pokazowe (16–20 s na preset, `scratch/renders/fable-vis/`) przeszły pomiar: najwyżej dwie przeciwne zmiany
  luminancji o 10 % na sekundę w którejkolwiek ćwiartce kadru.

### Czego nie sprawdzono

- Żywej aplikacji: panelu, ulubionych, blokady, wyszukiwarki i „›” — sprawdzony jest sam „Internal” utworzony przez
  swoją wtyczkę na pustej stronie (`scratch/fable-vis/tools/check.mjs`, zrzuty w
  `scratch/renders/fable-vis/integration/`), oraz prywatny build.
- Prawdziwego telefonu, Firefoksa i Safari. Rozkład programów o kilku wyjściach pomaga na ANGLE/Direct3D; gdzie indziej
  jest nieszkodliwy, ale niczego nie zmierzono.
- Przeglądarek bez `KHR_parallel_shader_compile` — tam pierwsze rysowanie czeka na kompilację (zacięcie przy starcie
  presetu).
- Urządzenia audio szybszego niż 48 kHz (ścieżka `audio-rate.ts` jest napisana jak w „Internal”, nie była uruchomiona).
- Utraty kontekstu WebGL (presety Fable są wtedy pomijane do ponownego otwarcia panelu) i zapasowej ścieżki Mgławicy
  bez `EXT_color_buffer_float`.
- Okładki z innego pochodzenia bez nagłówków CORS — przewidziano obraz zastępczy, nie było na czym sprawdzić.
- Zgodności ruchu z muzyką „na oko”: filmy oceniano po klatkach, nie oglądając ich z dźwiękiem.

Sprawdzone na żywo 11.11.2026 (build na serwerze, konto tymczasowe, potem skasowane): lista Internal ma 56 presetów
(16 + 40 pod dziesięcioma nagłówkami); Oliwa na wodzie, Zieleń polarna, Ametyst (pierwsza kompilacja w tle),
Pryzmat — klatka co 6,9 ms, najgorsza 8 ms; gwiazdka dodaje i zdejmuje ulubione; w Oddychających ścianach
„Wybierz obraz lub wideo” → „Zmień obraz lub wideo” z własnym obrazem; losowy „›” przechodzi między presetami
Fable i 2D. Nie sprawdzone: prawdziwy telefon, Firefox, Safari.

## Wizualizacje MilkDrop i Geiss

Dwie wtyczki z listy wizualizacji, **MilkDrop** i **Geiss (MilkDrop)**, to MilkDrop Ryana Geissa
uruchomiony przez [butterchurn](https://github.com/jberg/butterchurn) 3 (WebGL 2) z presetami
`butterchurn-presets` (paczki base, extra, md1 i image — 472 presety, od 08.11.2026 także 122
z paczki image; Geiss to te, których autorem jest Ryan Geiss). Po wybraniu wtyczki pojawia się lista presetów (od 11.11.2026 nie `<select>`, tylko lista
z wyszukiwaniem, niżej): **Auto — płynne przejścia**
(domyślnie: preset gra ~24 s i przenika się w kolejny przez 2,7 s, kolejność to przetasowana talia
bez powtórek) albo konkretny preset. Przy zmianie utworu tytuł przelatuje przez obraz, jak w
Winampie. Rozdzielczość to rozmiar panelu × `devicePixelRatio` (do 2, najwyżej ~8 Mpx).
butterchurn rysuje klatkę na własnym płótnie w rozmiarze podanym w `setRendererSize` i kopiuje ją
1:1, a jego `pixelRatio` skaluje tylko tekstury. Dlatego dostaje piksele naszego płótna i
`pixelRatio: 1`. Z rozmiarem CSS i `pixelRatio: 2` telefon pokazywał ćwiartkę obrazu w lewym
górnym rogu, a ekran 4K z przyciętą rozdzielczością — lewy górny wycinek za dużej klatki.

- **CSP:** presety są kompilowane do **WebAssembly** (`onlyUseWASM`), więc polityka strony
  potrzebuje `script-src 'self' 'wasm-unsafe-eval'` — pozwala kompilować wasm i nic więcej.
  Ścieżki JS butterchurna (`new Function`, czyli `'unsafe-eval'`) nie używamy. Bez tego wpisu
  select pokazuje „Niedostępne w tej przeglądarce”, a reszta wizualizacji działa normalnie.
- **Rozmiar:** silnik ~240 KB i presety ~3,4 MB (≈ 0,6 MB po gzip; paczka image to 1 MB
  i 160 KB z tego) to osobne fragmenty ładowane dopiero przy pierwszym otwarciu tej wizualizacji.
- **Tekstury** (`milkdrop-textures.ts`): preset dostaje tekstury, które nazywa
  (`sampler_worms`), zanim się wczyta — z buildu (`vendor/milkdrop-textures`, niżej), a bez nich
  sześć tekstur MilkDropa, które `butterchurn-presets` ma w `imageData` (MIT, ~200 KB, pobierane
  tylko wtedy, gdy któraś jest potrzebna). Czego nie ma nigdzie, dostaje clouds2 butterchurna,
  jak dotąd.
- **Wadliwe presety:** `BROKEN_PRESETS` jest od 10.11.2026 pusty. Sześć z audytu 07.11.2026 (dwa
  czarne, w tym Geiss — Game of Life 3, cztery gasnące) psuła jedna rzecz: kropki prostej fali,
  których butterchurn nie rysował (łatka `basic-wave-dots`, niżej) — Game of Life 3 zasiewają
  tylko one. Flexi, Geiss and Rovastar — chaos layered tokamak z czarnej klatki gaśnie jak
  w MilkDropie (jego reakcja rośnie z obrazu, który zostawił poprzedni preset); w odtwarzaczu
  przed nim zawsze coś było, poza pierwszym presetem po otwarciu. Dwa, które rzucały
  z WebAssembly, grają od 09.11 (łatki eel-wasm niżej). Preset, który rzuci u kogoś innego, jest
  od razu zastępowany i zapamiętywany w `localStorage` (`media-visualizer-failed-presets`).
  Czarny obraz przez 5 s przy grającej muzyce przełącza tryb auto dalej.
- **Obsługa:** małe ‹ i › tuż przy liście presetów chodzą po historii pokazanych presetów tej
  wizualizacji, jak przeglądarka (`VisualizerEngine.previousPreset`/`stepPresetForward`):
  - ‹ wraca do poprzedniego, także po losowaniu w trybie Auto, i zostawia go wybranym;
  - › idzie naprzód po tym, co ‹ cofnęło. Na końcu historii robi to, co dawny „następny”: w Auto
    losuje dalej (a jeśli ‹ wyłączyło Auto, włącza je z powrotem), inaczej bierze następny
    z listy;
  - działają na najniższym poziomie, czyli na presetach z wybranej paczki i kategorii. Duże ⏮ ⏭
    dalej zmieniają samą wizualizację.
  - **kostka obok ›** (losowy następny preset, `audio-player.ts`, `random-next.ts`): włączona
    (akcent i obwódka, `aria-pressed`) sprawia, że › i dwuklik przy przypiętym presecie biorą
    preset wylosowany zamiast następnego z listy. Losowanie idzie z tego, co pokazuje lista
    (wybrana paczka i kategoria, `presets()`, albo `randomPool()` wizualizacji: w VoltViz to, do
    czego dochodzi ›, więc wybory Halftone Pulse tylko z jednego z nich), przy „Auto — tylko
    ulubione” (od dwóch ulubionych) spośród ulubionych, i nigdy nie trafia na preset na ekranie
    ani przypięty. W Auto nic się nie zmienia (Auto i tak losuje). ‹ dalej cofa po tym, co
    naprawdę było pokazane, a › po cofnięciu najpierw idzie naprzód po historii. Wyłączona —
    wszystko jak dotąd. Stan jest zapamiętywany w przeglądarce (`media-visualizer-random-next`)
    i dotyczy każdej wizualizacji z presetami. Sprawdzone 10.11 w Chrome na VoltViz (10 losowań:
    bez powtórzeń z rzędu, bez wyborów Halftone Pulse, ‹ pięć razy wstecz po tej samej drodze)
    i MilkDropie (paczka 472 presetów; trzy ulubione przy „Auto — tylko ulubione” — losowania
    tylko spośród nich; po wyłączeniu › bierze następny z listy).
  - historia ‹/› czeka, aż preset, do którego przeszła, będzie na ekranie (`awaiting` w
    `VisualizerEngine.shown`): VoltViz przez chwilę pokazuje jeszcze opuszczany preset (przenikanie),
    a ‹ zapisywało go wtedy jako nowo pokazany, więc kolejne ‹ skakało między dwoma presetami
    (poprawione 10.11.2026).

  Dwuklik na obrazie działa jak ›. Pasek i kursor chowają się po 2,5 s bez ruchu nad obrazem
  (i na pełnym ekranie). Otwarta lista presetów albo paczek (i select wizualizacji z fokusem)
  trzyma pasek, żeby lista nie wisiała nad obrazem bez niego: najwyżej pół minuty od ostatniego
  użycia (przewinięcie i wyszukiwanie budzą pasek same), potem lista się zamyka.
- **Lista presetów i paczek** (`shared/list-picker.ts`, czysta część w `list-picker-model.ts`,
  style `styles/list-picker.css`; od 11.11.2026). Dawniej dwa `<select>`. Lista presetów ma do
  16 900 pozycji (MilkDrop, „Wszystkie paczki”), AVS 15 202 w 1 011 grupach, a lista paczek AVS
  769. Chrome przy każdym otwarciu budował wszystkie opcje w okienku selecta. Strona stawała na
  0,9–2,1 s na komputerze i 1,6–3,7 s w emulacji telefonu.
  - **Wygląd i miejsce:** przycisk w miejscu selecta (ten sam wygląd paska) otwiera listę
    w warstwie najwyższej (`popover="manual"`). Panel jej nie przycina, a na pełnym ekranie
    stoi nad panelem. Wejście w pełny ekran i wyjście z niego zamykają listę. Na komputerze
    lista ma co najmniej 26 rem (paczki 22 rem) i do 36 rem wysokości, pod przyciskiem (nad
    nim, gdy pod spodem brak miejsca). Na telefonie (do 46 rem) jest arkuszem od dołu ekranu
    z uchwytem, z przyciemnionym tłem, na ~82% wysokości. Arkusz podnosi się nad klawiaturę
    ekranową (`visualViewport`). Wygląd tylko ciemny, jak cała aplikacja (`tokens.css`).
  - **Rysowanie:** istnieją tylko wiersze w widoku i kilka obok (8, na dotyku 14). Wszystkie
    wiersze mają tę samą wysokość (`--list-picker-row`: 2,25 rem, na dotyku 2,75 rem, w arkuszu
    2,85 rem), więc pozycja przewinięcia od razu wskazuje pierwszy wiersz. Kilkadziesiąt
    elementów wierszy jest w kolejnym przebiegu wypełnianych od nowa (`render`).
    Nagłówek grupy, w której jest góra listy, zostaje przypięty nad wierszami.
  - **Wartości jak w selekcie:** `auto`, `auto:favorites` („Auto — tylko ulubione”, od dwóch
    ulubionych), grupa „★ Ulubione” na górze, grupy z nagłówkami. Wybór woła silnik tylko wtedy,
    gdy wartość się zmienia (jak `change`): `setAutoFavorites` / `choosePreset` / `choosePool`.
  - **Przycisk** pokazuje wybraną wartość: w Auto „Auto: <preset na ekranie>”. Wybrany preset
    spoza listy pokazuje swoją nazwę (select zostawał wtedy pusty). W liście gwiazdka oznacza
    ulubione, a fala preset na ekranie, ✓ wybraną pozycję.
  - **Szukanie** od 12 pozycji w górę. Pole nie rozróżnia wielkości liter ani znaków
    diakrytycznych („lodz” znajdzie „Łódź”, `foldText`). Każde słowo musi być w nazwie albo
    w nagłówku grupy („cream dancer”, „visbot 2” w paczkach). Nagłówki zostają nad
    znalezionymi. Licznik pokazuje „72 z 16 900”, a bez szukania „16 900 presetów”. Skróty
    (Auto, ulubione na górze, `aside`) nie wchodzą do liczby. Pierwszy znak przy 16 905
    wierszach to ~11 ms (składanie nazw, potem trzymane przy wierszach), kolejne 3–6 ms.
  - **Klawiatura:** przycisk to combobox (↓ ↑ albo litera otwierają; litera od razu trafia do
    pola). Po otwarciu fokus jest w polu (też combobox, `aria-activedescendant` na podświetlonej
    opcji listboksa z `aria-setsize`/`aria-posinset`). ↓ ↑ Page Up/Down Home End przesuwają,
    Enter wybiera i oddaje fokus przyciskowi. Escape najpierw czyści pole, potem zamyka (panelu
    już nie zamyka, jak przy selekcie). Tab zamyka i idzie dalej od przycisku. Spacja na liście
    wybiera, nie włącza muzyki. Bez pola (Geiss: głębia koloru) litery skaczą do pozycji jak
    w selekcie.
  - **Dotyk:** fokus idzie na listę, nie na pole, więc klawiatura nie zasłania listy, dopóki
    ktoś nie stuknie w pole. „Gotowe” klawiatury chowa klawiaturę i zostawia listę. Stuknięcie
    w wiersz wybiera i zamyka. Nic nie zostaje z fokusem, więc pasek odpoczywa jak zwykle.
  - **Poza listą:** wciśnięcie poza nią zamyka listę i nic więcej nie robi, jak przy okienku
    selecta. Dwuklik na liście nie przełącza presetu (lista leży w pasku).
  - **Zmierzone 11.11.2026** w Chrome bez okna, na prawdziwym `AudioPlayer` z paczkami
    właściciela. Czas od wciśnięcia do klatki z listą:

    | lista | pozycji | przedtem (do odwieszenia strony) | teraz (`open()` / lista na ekranie) |
    |---|---|---|---|
    | MilkDrop, Wszystkie paczki | 16 900 | 2,1 s, telefon 3,7 s | 5–7 ms / 12 ms |
    | MilkDrop, Cream of the Crop | 9 795 | 0,9 s, telefon 1,6 s | 5–7 ms / 12 ms |
    | AVS, Wszystkie paczki | 15 202 | 1,9 s, telefon 3,3 s | 5 ms / 13 ms |
    | AVS, paczki | 769 | 40–50 ms | 5 ms / 13 ms |

    Na telefonie (390×844) lista jest na ekranie 75–87 ms od dotknięcia, ale `click` przychodzi
    dopiero po oderwaniu palca (w teście 45–65 ms), więc to ~20–25 ms po nim.
  - **Szukanie we wszystkich wizualizacjach** (od 11.11.2026; `visualizations/preset-search.ts` —
    czyste dopasowanie i wiersze, z testami — oraz `preset-catalogs.ts` — wczytywanie i pamięć).
    Pod własnymi wynikami listy są grupy: najpierw „<wizualizacja>: inne paczki” (presety tej,
    która gra, z paczek, których lista teraz nie pokazuje — MilkDrop na wbudowanych znajduje
    Cream of the Crop), potem każda inna wizualizacja włączona przez administratora, w kolejności
    panelu, bez „Ulubionych”. Przy wyniku jego paczka albo kategoria, przyciemniona. Grupa pokazuje
    50 wyników (do 60 — wszystkie), dalej wiersz „Pokaż jeszcze N”. Licznik: „12 z 16 900 + 340
    w innych”; póki katalogi idą — „Szukanie w innych wizualizacjach…”. Lista presetów ma pole
    szukania zawsze (`searchFrom: 1`).
    - Katalog to opcjonalne `catalog(fetchJson)` wtyczki, zbudowane tym samym kodem co jej lista
      (wspólne moduły, nic nie jest powtórzone): MilkDrop 16 900 (nazwy butterchurna z
      `presetPackMeta`, 30 kB zamiast 3,4 MB presetów), AVS 15 202, Shadery 170, VoltViz 105,
      Klasyka retro 79, Formy dźwięku 36, Geiss (MilkDrop) 29, Geiss (Winamp) 25, Internal 16.
      Pobierane dopiero przy pierwszym znaku w polu (nigdy przy otwarciu panelu albo listy),
      najwyżej 4 naraz, trzymane do końca strony; nieudany próbuje się przy następnym szukaniu,
      a katalog Geissa (Winamp) czyta się za każdym razem (zapisane presety się zmieniają).
    - Wybór presetu innej wizualizacji robi to co zmiana jej selecta (wybór zapamiętany) i startuje
      ją od razu na tym presecie (`engine.select(id, preset)` → `ExternalOptions.preset`); MilkDrop
      i AVS przechodzą do paczki, która go ma. Preset „innej paczki” tej, która gra, uruchamia ją od
      nowa na nim (jej start znajduje paczkę). Z klawiatury fokus idzie na select wizualizacji.
    - Koszt znaku przy ~32 500 obcych wpisach: samo szukanie 2,4 ms (mediana; najwięcej 3,3),
      cała obsługa pola 3–4 ms, z MilkDropem „Wszystkie paczki” na własnej liście 4 ms (najwięcej
      8). Składanie nazw raz, gdy katalog przyjdzie: MilkDrop ~27 ms, AVS ~10 ms.
    - Sprawdzone na żywo: w Internal „geiss” → grupy MilkDrop, Geiss (MilkDrop) i dalsze, wybór
      przełącza na MilkDrop z tym presetem; MilkDrop na „Wbudowane” → „dancer” → „MilkDrop: inne
      paczki” (Cream of the Crop), wybór uruchamia go z paczką „Wszystkie kategorie” Cream of
      the Crop. Nie sprawdzone: prawdziwy czytnik ekranu i klawiatura telefonu.
- **Auto, „zostaw” i ulubione** (MilkDrop, Geiss, AVS i każda wizualizacja z presetami):
  - w trybie Auto pozycja listy pokazuje, co gra: „Auto: <nazwa presetu>”;
  - przycisk z kłódką zostawia ten preset na stałe (koniec trybu Auto);
  - gwiazdka dodaje preset na ekranie do ulubionych albo go z nich usuwa. Ulubione stoją na
    górze listy w grupie „★ Ulubione”; od dwóch ulubionych jest też „Auto — tylko ulubione”.
  - Ulubione są na koncie: tabela `visualizer_favorites` (migracja 040), akcje mostu
    `visualizer_favorites` (GET) i `visualizer_favorites_save` (POST: lista `{id, label,
    favorite}`), limit 500 na wizualizację. `visualizations/favorites.ts` pobiera je raz na
    stronę i zmienia od razu; zapis idzie w tle, a odrzucony zapis wraca do stanu z serwera.
  - Przy pierwszym wejściu ulubione z przeglądarki (`media-visualizer-favorites:<id>`) przechodzą
    na konto i znikają z `localStorage`. Brakujące nazwy uzupełnia lista wizualizacji, gdy ta
    się pokaże (`nameFavorites`).
  - Gość i instalacja bez migracji trzymają ulubione w przeglądarce, jak wcześniej.
    „Auto — tylko ulubione” (`media-visualizer-auto-favorites:<id>`) to zawsze wybór
    przeglądarki.
  - „Tylko ulubione” obowiązuje od pierwszego presetu: silnik podaje listę ulubionych już przy
    starcie wizualizacji (`ExternalOptions.autoFilter`), a nie dopiero po nim.
- **Wizualizacja, której nie został żaden preset** (wszystkie się wysypały), nie ma listy ani
  przycisku „następny”: `presets()` zwraca pustą listę, a panel chowa po wczytaniu oba elementy.
- **Internal** (`internal-plugin.ts`, `internal.ts`) to 16 własnych wizualizacji 2D jako presety
  jednej wtyczki:
  - kolejność w `INTERNAL_ORDER` (kuratorowana czwórka na początku);
  - każda rysuje na własnym płótnie z własnym `AnalyserNode` (swój `fftSize` i
    `smoothingTimeConstant`);
  - Auto to talia co 30 s, a następna przenika się przez 1,2 s.

  Do 08.11.2026 każda była osobną wtyczką. Zapisane ustawienia i wybór z ich identyfikatorami
  znaczą Internal, z tą wizualizacją wybraną (`canonicalVisualizerId`; w PHP
  `FORMER_INTERNAL_VISUALIZERS` przy odczycie i zapisie).
- **„Ulubione”** (`favorites-plugin.ts`, `favorites-visualizer.ts`, id `favorites`) to ulubione
  presety wszystkich wizualizacji, które panel oferuje (`ExternalOptions.sources`), w grupach po
  wizualizacji:
  - wpis to wizualizacja i preset; ta sama wizualizacja zmienia preset po swojemu, inna
    wczytuje się w warstwie nad ekranem i przenika przez 1 s;
  - wizualizacje otwierane są z `ExternalOptions.preset` i `persist: false` (nic nie
    zapamiętują; MilkDrop bierze wtedy wszystkie paczki naraz);
  - ulubiony, którego już nie ma, i wizualizacja, która nie wstaje, są pomijane do końca
    wizyty;
  - gwiazdka zdejmuje preset z ulubionych jego wizualizacji (`favoriteOf`);
  - panel nie pokazuje tu grupy „★ Ulubione” ani „Auto — tylko ulubione”
    (`PresetState.favoritesList`);
  - bez ulubionych pokazuje podpowiedź.
- **Geiss (Winamp)** (`geiss.ts`, katalog `geiss/`) to osobna wtyczka: wierny port wtyczki
  Geissa, bez WebGL i WebAssembly — sekcja „Wizualizacja Geiss (Winamp)” niżej. Zastąpiła
  „Geiss Classic” (podobieństwo w WebGL 2) i przejęła jej identyfikator `geiss-classic`.
- **Nowe wtyczki są włączone** na istniejących instalacjach (identyfikator, którego żaden zapisany
  porządek nie zna, jest nowy, a nie wyłączony); w panelu można je wyłączyć jak każdą inną.

### Silnik: butterchurn z poprawkami (`scripts/butterchurn-patches.mjs`)

butterchurn zostaje zależnością npm w dokładnej wersji 3.0.0-beta.5. Wtyczka Vite
`butterchurnPatches()` (w `vite.config.ts`) przy wczytywaniu `dist/butterchurn.js` podmienia
w nim dokładnie wskazane fragmenty tekstu; łatka, której tekstu nie ma tyle razy, ile oczekuje
(np. po aktualizacji butterchurna), zatrzymuje build i podaje swoją nazwę — nic nie przestaje
działać po cichu. Łatki, nie fork: lista jest krótka, każda ma powód obok, a presety butterchurna
grają jak dotąd. Testy: `scripts/butterchurn-patches.test.mjs` (w `npm run test:ui`).

- **eel-wasm, kompilator równań, liczy jak ns-eel2 MilkDropa:** `loop(n)` przy n < 1 nie wyskakuje
  już z bloku, konwersje liczby na całkowitą nie rzucają („float unrepresentable” — stąd czarne
  presety), `%` to |a| mod |b|, przypisanie NaN i ∞ zapisuje 0, `rand(x)` losuje z [0, ⌊x⌋].
- **MilkDrop 2:** macierze `rot_s1`…`rot_uf4` i `rot_rand1`…`4` w shaderach — losowane przy
  wczytaniu presetu i obracane w czasie jak w `ApplyShaderParams` (RotX · przesunięcie · RotZ ·
  RotY); butterchurn ich nie miał, a hlslparser odrzucał takie shadery.
- **MilkDrop 2 — wartości, które butterchurn podawał inaczej** (wszystko według
  `ApplyShaderParams` i `milkdropfs.cpp`):
  - `time` w shaderach to czas od startu presetu, zawijany co 10 000 s (butterchurn: od startu
    wizualizacji); równania i macierze `rot_*` liczą dalej od startu, jak w MilkDropie;
  - `roam_cos`, `roam_sin`, `slow_roam_cos`, `slow_roam_sin` z częstotliwościami i fazami
    MilkDropa (0,329 + 1,2 rad…; butterchurn miał inne i bez faz);
  - `vol` i `vol_att` w shaderach to 0,3333 · `treb` (`treb_att`): w MilkDropie to przecinek
    w `0.3333f*(bass, mid, treb)`, który zostawia sam treb — ma go MilkDrop 2 i MilkDrop 3
    (i MDropDX12), więc ich presety na nim wyrosły;
  - `progress` w równaniach (we wszystkich blokach, też kształtów i fal) i w shaderach: w trybie
    Auto od 0 do 1 przez czas presetu (`milkdrop.ts`, `mdProgress`), a dla presetu wybranego
    ręcznie 0 — tak MilkDrop traktuje preset zablokowany (co klatkę zeruje czas startu);
  - kropki prostej fali (`bWaveDots`, 3 427 z 16 427 presetów) to punkty o rozmiarze 1 piksela, jak
    w `DrawWave` (Direct3D bez `D3DRS_POINTSIZE`): shader butterchurna nie ustawiał `gl_PointSize`,
    którego rozmiar WebGL zostawia nieokreślony, i Chrome (ANGLE) nie rysował ich wcale
    (`basic-wave-dots`). Cztery kopie przesunięte o piksel (kropki 2 × 2, gruba linia) MilkDrop
    rysuje dopiero przy teksturze szerokiej na co najmniej 512 (`drawing_its`), butterchurn przy
    każdej (`basic-wave-fat-dots`). Kropki fal własnych (`uSize`) były już jak w MilkDropie;
  - preset wczytywany z przejściem MilkDrop wczytuje przez osiem klatek (`LoadPresetTick`:
    `m_nLoadingPreset` od 1 do 8, shader warpa przy 2, compa przy 5): przez te klatki rysuje
    sam stary preset, a przejście rusza po ósmej. Tu tak samo (`stagedLoad`, `stageTick`;
    `milkdrop.ts` włącza to przez `mdStageLoads`): `loadPreset` kompiluje od razu, podłącza
    preset po ósmej narysowanej klatce i dopiero wtedy się kończy; nowe wczytanie w tym czasie
    zajmuje miejsce poprzedniego, jak drugi `LoadPreset`. Wczytanie bez przejścia — od razu.
- **BeatDrop i MilkDrop 3:**
  - q1–q64 (`_qi`…`_qp` w shaderach) i do 16 kształtów i 16 fal (obiekty powyżej czterech
    dokładane dopiero, gdy preset ich ma);
  - proste fale 8–17 BeatDropa (mod 18; m.in. widmo, gwiazda, kwiat, lasso, trójkąt, fajerwerki);
  - to, czym BeatDrop różni się od MilkDropa 2 i 3, tylko w paczkach BeatDropa (`md.beatdrop`,
    `packEngine` = `beatdrop`; MilkDrop 3 to `milkdrop3`): fale 0 i 6 ze średniej obu kanałów
    (MilkDrop: z prawego i z lewego), `vol` w shaderach jako średnia pasm (BeatDrop poprawił
    przecinek) i `time` w shaderach od startu wizualizacji (`GetTime()`, nie od startu presetu);
  - `get_fft()`/`get_wave()`: tekstury 1024×2 i 480×2 liczone jak w `plugin.cpp` BeatDropa
    (FFT 2048 próbek z oknem Hanna, normalizacja RMS, `FFTAttack`/`FFTDecay` presetu, pamięć
    szczytu). Próbki float daje `milkdrop.ts` z własnych analizatorów, które powstają dopiero,
    gdy preset czyta te tekstury;
  - zegar i data: `sysTime`, `sysDate`, a w równaniach `year`…`totalseconds`;
  - mysz: `mouse` w shaderach, `mousex`, `mousey`, `mousedown`, `mouseclick` w równaniach —
    kursor nad obrazem; poza nim −1, jak w BeatDropie. Klawisze (`ctrllt`…) zostają 0 z założenia:
    wizualizacja nie ma własnej klawiatury (strzałki i klawisze należą do odtwarzacza i strony);
  - `aspect_sd` = `aspect` (tryb zależny od ekranu jest w BeatDropie domyślnie wyłączony).
- **Presety podwójne MilkDropa 3** (`.milk2`) i **sprite'y MilkDropa 3** (bloki `[SPRITE…]`,
  rysowane w pięciu miejscach klatki) — niżej, w „Presety MilkDrop 3”.

Zmienne zegara i myszy dostaje tylko preset, który je czyta i nigdy ich nie przypisuje (lista
w `md.engine` z konwertera): preset MilkDropa 2 z własną zmienną `second` zostaje przy swojej.
`progress` dostaje każdy preset, który go czyta — MilkDrop ustawia go przed każdym blokiem, więc
własne przypisanie i tak nie przetrwa.

### Dodatkowe paczki presetów MilkDrop (`vendor/milkdrop-presets`)

Obok presetów butterchurna build może dołożyć **własne paczki presetów MilkDrop**, np. paczki
projectM: **Cream of the Crop** (9 795 presetów, które ISOSCELES posortował w kategorie
Dancer, Drawing, Fractal…), **MilkDrop original** (552 presety z ostatniego oficjalnego wydania
MilkDropa), **projectM classic** (4 189 presetów dawnych wydań projectM w 10 katalogach:
tryptonaut, milkdrop, stock…; ten sam plik bywa w kilku z nich) i **En D** (40 presetów, z
własnymi teksturami), a także dwa katalogi z [BeatDrop](https://github.com/OfficialIncubo/BeatDrop-Music-Visualizer):
**Incubo_'s Presets** (627) i **MilkDrop2077 Presets** (763), i **MilkDrop 3** (462: z oficjalnego
instalatora MilkDropa 3.37 147 presetów podwójnych `.milk2` w kategorii „Double presets” i 291
`.milk` w „Presets”, a w kategoriach „MDropDX12” i „XorPlayer” 22 presety z paczki MDropDX12
i 2 z XorPlayera — zawsze te, których nie ma żadna inna paczka; zob. „Presety MilkDrop 3”).
Wbudowanych nie zastępują: wizualizacja **MilkDrop** dostaje trzeci select, **Paczka presetów**:

- **Wbudowane (butterchurn)** — domyślnie, czyli dokładnie to, co było dotąd;
- **Wszystkie paczki**;
- **Oryginalny MilkDrop 2 (klasyka)**;
- **MilkDrop 3**;
- nagłówki z „Wszystkie kategorie” albo jedną kategorią: **BeatDrop** (Incubo_'s Presets,
  MilkDrop2077 Presets), **projectM — Cream of the Crop**, **projectM — En D** i
  **projectM — klasyczne presety**.

Lista presetów (z nagłówkami kategorii i grup) i tryb **Auto** biorą presety z wybranej paczki;
wybór jest zapamiętywany (`media-visualizer-pack:milkdrop`). **Geiss (MilkDrop)** zostaje przy
presetach butterchurna. Bez katalogu select się nie pojawia, a build jest taki jak wcześniej.

**Instalacja.** Katalog jest w `.gitignore`, więc presety nie trafiają do repozytorium:

```powershell
cd frontend
git clone --depth 1 https://github.com/projectM-visualizer/presets-cream-of-the-crop vendor/milkdrop-presets/cream-of-the-crop
git clone --depth 1 https://github.com/projectM-visualizer/presets-milkdrop-original vendor/milkdrop-presets/milkdrop-original
git clone --depth 1 https://github.com/projectM-visualizer/presets-projectm-classic vendor/milkdrop-presets/projectm-classic
git clone --depth 1 https://github.com/projectM-visualizer/presets-en-d vendor/milkdrop-presets/en-d
git clone --depth 1 https://github.com/projectM-visualizer/presets-milkdrop-texture-pack vendor/milkdrop-textures/projectm
npm run build
```

BeatDrop to repozytorium 1,6 GB (z programem i bibliotekami), więc bierzemy z niego tylko dwa
katalogi z `resources/Milkdrop2/presets/` — `Incubo_'s Presets` i `MilkDrop2077 Presets` — do
`vendor/milkdrop-presets/beatdrop/` (z `PRESET LICENSE.md` obok), np. pobierając same pliki
`.milk` z raw.githubusercontent.com. Część z nich to przeróbki shaderów z Shadertoy na licencji
**CC BY-NC-SA 3.0** (tylko niekomercyjnie, z podaniem autorów), reszta jest bez licencji —
dlatego tylko w `vendor/` (zob. `NOTICE.md`).

**Własne presety.** Każdy katalog w `vendor/milkdrop-presets/` to osobna paczka (nazwa
z nazwy katalogu). Pierwszy poziom podkatalogów to kategorie, głębsze to grupy; katalog-opakowanie,
w którym leży wszystko, jest pomijany. Wystarczy wrzucić pliki `.milk` (albo `.milk2`), np.
`vendor/milkdrop-presets/moje/Ulubione/nazwa.milk`, i zbudować front ponownie. Paczka, której
nazwa mówi `beatdrop`, `milkdrop3` albo `md3` (`packEngine`), liczy proste fale jak BeatDrop
i MilkDrop 3 (modulo 18: tryb 8 to linia widma, nie tryb 0 MilkDropa 2); gdzie indziej robi tak
tylko preset z trybem 9 lub wyższym.

**Konwersja** odbywa się przy buildzie, w wątkach roboczych (`scripts/milkdrop-presets.mjs`,
`milkdrop-convert.mjs`, `milkdrop-hlsl.mjs`):

- **Równania** (`src/shared/visualizations/milkdrop-eel.ts`) czyta się dokładnie tak, jak czyta
  je MilkDrop: preprocesor ns-eel2 (`?:`, `x[i]`, `$pi`, `!`, `%`…) i jego gramatyka (poziomy
  `| & + - * /` z tablic parsera), potem zapis w pełni w nawiasach dla eel-wasm, który `&&`
  i porównania grupuje inaczej (`a == 1 && b == 2` dawało tam 0); `memcpy`, `memset`, `invsqrt`,
  `freembuf`, liczby z wykładnikiem i `^=`/`|=`/`&=` zapisuje jego środkami. Build kompiluje każdy
  blok eel-wasm, który trafia do przeglądarki (z łatkami), więc preset, który by się nie
  skompilował, w ogóle nie trafia na listę. Blok, którego nie skompilowałby i MilkDrop (błąd
  składni w samym presecie, np. `0.99l`), zostaje pusty jak w MilkDropie — z notatką
  w `notes.txt`. Plik `.milk` czyta `splitPreset` z milkdrop-preset-utils (kształty i fale 4–15
  osobno, bo ona zna 0–3).
- **Shadery** warp i comp tłumaczy z HLSL na GLSL hlslparser-js, ten sam, którego używa
  milkdrop-preset-converter. Ma on błąd: drugi i każdy kolejny operator w łańcuchu zamienia na
  `&&` (`a + b + c` daje `bool(a + b) && bool(c)`), co psuło 8 387 z 8 500 shaderów obu paczek.
  Dlatego `milkdrop-hlsl.mjs` rozwija makra i stawia nawiasy wokół każdego działania, a wynik
  z nadmiarowym `&&` jest odrzucany.
- **Dopasowanie do butterchurna 3:** wynik dostaje `rad`, `ang`, `uv_orig` i `hue_shader` jako
  parametry, kopie uniformów, do których shader zapisuje, wartości zmiennych globalnych liczone
  na starcie (także tablic liczonych z uniformów), `uniform` przy teksturach (także
  z `sampler_state`) i porównania `%` z liczbą całkowitą. `mendGlsl` poprawia to, czego GLSL ES
  nie przyjmuje w wyniku hlslparsera, choć D3DX przyjmował HLSL: funkcję bez `return` (D3DX
  kompiluje tylko wywoływane, więc taka nigdy nie jest wołana), `saturate(!x)` (clamp z bool),
  argument `out` funkcji `sincos` w konwersji typu i przypisanie do wiersza macierzy
  (`rot[0] = float2(…)`, zapisane element po elemencie).
- **Pakiety npm:** ostatni krok `convertShader` gubił każdą globalną zmienną `int`, więc jego
  trzy kroki robimy sami. Build potrzebuje więc tylko części milkdrop-preset-convertera,
  czyli `hlslparser-js` i `milkdrop-preset-utils` (devDependencies, MIT).
- **Funkcje, których hlslparser nie zna** — `round()`, `tanh()`, `log10()`, `distance()`,
  `refract()`, `all()` — dostają definicje w samym shaderze (`hlsl_round()` itd.); `round()`
  wykluczał wcześniej 85 presetów; od 08.11 także `trunc()`, `fwidth()` i `fmod()`/`%` (HLSL obcina
  w stronę zera, GLSL-owe `mod()` zaokrągla w dół). Tekstury MilkDropa z prefiksem, którego
  butterchurn nie deklaruje (`sampler_fw_noise_hq`, `sampler_pw_noisevol_hq`), czytają jego
  własną teksturę (wcześniej clouds2 albo błąd tłumaczenia — 21 presetów Cream of the Crop).
- **Matematyka D3D9, jak ją liczy MilkDrop** (`d3dMath` w `milkdrop-hlsl.mjs`). MilkDrop 2,
  MilkDrop 3 i BeatDrop kompilują shadery kompilatorem z `d3dx9_31.dll` (flaga
  `D3DXSHADER_USE_LEGACY_D3DX9_31_DLL`, w kodzie MilkDropa `1<<16`; profile ps_2_0,
  ps_2_a/ps_2_b, ps_3_0 według `PSVERSION` presetu). Próbne shadery
  skompilowane tą samą biblioteką (zainstalowany DirectX, `D3DXDisassembleShader`) pokazały to
  samo we wszystkich czterech profilach:
  - `pow(x, y)` to instrukcja `pow` (ps_2_x) albo log · mul · exp (ps_3_0) — obie liczą |x|^y —
    a `sqrt`, `rsqrt`, `log` i `log2` idą przez instrukcje `rsq` i `log`, które też biorą |x|.
    WebGL daje dla ujemnego x NaN, czyli czarny piksel, więc x dostaje `abs()`;
  - stały wykładnik skalarny 0, ±0,5, 1, 2, 3, 4, 5, 6, 8 i −1…−4 kompilator rozpisuje:
    mnożenia, które zachowują znak (x · (x · x) dla 3), ich odwrotność dla −1…−4, `rsq` dla ±0,5,
    samo x dla 1 i 1 dla 0 — konwerter tak samo (`hlsl_pow_3()` itd.). Inne stałe (7, 16, 1,5…)
    to znów instrukcja, |x|^y;
  - stały wykładnik wektorowy (`float3(5, 1, .5)`) to log · mul · exp na każdej składowej, poza
    składową 1 (samo x) i 0 (1);
  - stała z nazwą liczy się jak liczba tam, gdzie kompilator ją składa (też sprawdzone na DLL):
    globalna `static` (z `const` albo bez) i lokalna, której nic potem nie przypisuje. Globalna
    bez `static` to uniform, więc zostaje zmienną; nazwę zadeklarowaną dwa razy albo zapisaną
    przez parametr `out` konwerter też zostawia zmienną (zmieniło to 2 presety).
- **Składnia, której hlslparser nie czyta, zapisana inaczej** (`milkdrop-hlsl.mjs`, ten sam sens):
  - konstruktor zaraz po nawiasie (`(float3(a, b, c).z * 2)`) — hlslparser bierze go za konstruktor
    w nawiasie i nie czyta `.z` po nim; dostaje jednoargumentowy `+`. Ten nawias stawiał nasz
    własny przepis na błąd `&&`;
  - pętle `for`: puste klauzule (`for (; i++ < 9; )`) i operator przecinka w nich
    (`z += d, o += c / z` trafia na koniec ciała pętli i przed każde jej `continue`);
  - `#if` z wyrażeniem (`#if HAS_FFT_PEAK` BeatDropa), indeks float (`tab[uv.x % 4]` → `int()`),
    tablica wypełniana wektorami (`float s[16] = {a, b, c, d}` z czterech float4), `%=`,
    zmienna `sample`;
  - operator przecinka w nawiasie (`lerp(a, 1, (max(b, c), max(d, e)))`, `x * (1.5, -.5, 0)`):
    HLSL bierze ostatnią wartość (D3DX ostrzega X3081), a hlslparser czytał go jako kolejne
    argumenty albo brał pierwszą. Sześć presetów (np. „babylon”, „Starcraft (Chaos Tile)”)
    wygląda przez to inaczej niż do 09.11 — tak, jak w MilkDropie;
  - `tex3D` na teksturze 2D (losowej) czyta ją w (u, v), sampler bez prefiksu `sampler_`
    (`sampler rand00;` — MilkDrop bierze nazwę i bez niego), własne `PI` presetu (szablony
    butterchurna mają swoje).
- **Shader, którego nie skompiluje i MilkDrop** — `}` zostawiona po zakomentowanej pętli zamyka
  `shader_body` przed końcem (MilkDrop domyka funkcję ostatnią `}`) — dostaje shader zastępczy
  MilkDropa (`data/comp_ps.fx`, `warp_ps.fx`), jak w MilkDropie; notatka w `notes.txt`.
- **BeatDrop / MilkDrop 3:** to, co dodają, gra (silnik wyżej); konwerter deklaruje shaderom ich
  nazwy (`get_fft()`, q33–q64, `sysTime`, `mouse`, `aspect_sd` — `beatdropShaderNames`), a ich
  `FFTAttack`/`FFTDecay` i zmienne silnika zapisuje w polu `md` presetu. Pominięty byłby tylko
  preset z kształtem lub falą powyżej 16 (`beyondMilkdrop2`; w paczkach nie ma żadnego).
- **Cache:** wyniki trafiają do `frontend/node_modules/.cache/milkdrop-presets/` (kluczem jest
  zawartość pliku, silnik paczki i wersja konwertera), więc kolejny build tylko je odczytuje.
  Pierwszy build trwa ok. 2 minut dłużej (konwersja z próbną kompilacją równań), kolejne ok.
  2–3 s dłużej niż bez paczek. Presety,
  których nie da się przełożyć wiernie, są pomijane i wypisane w `failed.txt` w tym katalogu —
  build nigdy przez nie nie pada.

**Wynik:** `assets/milkdrop/<paczka>/index-<hash>.json` (nazwy, kategorie i grupy; dla Cream of
the Crop ok. 600 KB) oraz porcje `<hash>.json` po najwyżej 32 presety (zwykle ok. 130 KB).
Z sześcioma paczkami i teksturami to 1 377 plików i 840 MB (tekstury 747 MB, z czego 703 MB to
losowe zestawy BeatDropa; Cream of the Crop ok. 65 MB, projectM classic 13 MB, BeatDrop 9 MB,
MilkDrop 3 5 MB), a przeglądarka pobiera porcję dopiero wtedy, gdy któryś z jej presetów ma
zagrać, a teksturę, gdy preset jej używa; service worker zatrzymuje pobrane.

**Stan (09.11.2026; przegląd końcowy 10–11.11.2026):**
- Przekonwertowane wszystkie 16 428 presetów (08.11: 15 749, 217 pominiętych): Cream of the Crop
  9 795, projectM classic 4 189, BeatDrop 1 390 (Incubo_'s Presets 627, MilkDrop2077 Presets
  763), MilkDrop original 552, MilkDrop 3 462, En D 40. `failed.txt` jest pusty; `notes.txt` ma
  14 notatek: 11 bloków EEL, których nie skompilowałby i MilkDrop (zostają puste), dwa shadery
  zastępcze („liquid circuitry”, wyżej) i blok sprite'a w pierwszej połowie jednego presetu
  podwójnego, którego MilkDrop 3 nie czyta (niżej).
- Przegląd w przeglądarce objął wszystkie 15 970 (Edge bez okna, WebGL 2, 60 klatek, dźwięk
  syntetyczny), ostatni raz 09.11 po matematyce D3D9 i wartościach MilkDropa (shadery 5 670
  presetów się zmieniły, silnik gra inaczej każdy): równania każdego się wczytują, shadery
  kompilują i linkują, żaden nie rzuca ani się nie zawiesza; 462 presety MilkDropa 3
  (z instalatora, MDropDX12 i XorPlayera) przeszły ten sam przegląd 09.11 w całości, ostatni
  raz po sprite'ach i siatce wzorów (niżej): wszystkie się wczytują, kompilują i rysują, bez
  błędów GL. Ten sam
  przegląd przed poprawkami (08.11, 15 748 presetów): 60 nie wczytywało równań, 292 shaderów się
  nie kompilowało, 23 rzucały w trakcie — rysowało 15 373.
- Ciemnych po 60 klatkach jest 638 z 16 428: 585 w dawnych paczkach (08.11: 779, przed
  matematyką D3D9: 661; 181 się rozjaśniło, 105 ściemniło, bo np. `sqrt` ujemnej liczby daje
  teraz |x| jak w D3D9, a nie NaN) i 53 w MilkDropie 3 (bez sprite'ów 58: pięć rozjaśnił ich
  sprite, żaden nie ściemniał). To nie błąd: część rozjaśnia się
  później albo czeka na beat. „XorDevs Corridor1” (BeatDrop), cały czarny przez NaN
  z `pow(cos(…), 16)`, rysuje teraz swój korytarz. Czarny zostaje „XorDev - MilkDrop2077 -
  Black hole” z XorPlayera: dzieli przez licznik pętli równy 0 (`/ i` przy `i = 0`), więc każdy
  piksel to NaN — błąd pliku, nie konwersji (kopia w Milkwave ma na to `denom = i == 0 ? 1 : i`).
- **Przegląd końcowy (10–11.11.2026)** wszystkich 16 428 presetów po zmianach z 10.11 (kropki,
  przejścia po ośmiu klatkach, sprite'y MilkDropa 3): Chrome bez okna (WebGL 2 na D3D11), 60 klatek,
  192×108, ten sam syntetyczny dźwięk, pięć przeglądarek naraz (`scratch/milkdrop-audit/tools-1011/`:
  `harness-full`, `cdp-run3.mjs`, `compare_full.py`). Równania każdego się wczytują, shadery
  kompilują i linkują, żaden nie rzuca, nie zostawia błędu GL ani się nie zawiesza.
  - Ciemnych po 60 klatkach 461 (09.11: 638): 307 się rozjaśniło (m.in. kropki prostej fali), 129
    ściemniało — w tym oknie, bo „grube” kropki MilkDrop rysuje dopiero od tekstury 512.
  - Wszystkie 461 jeszcze raz w 960×540, 300 klatek, jasność z każdego piksela co 30 klatek
    (`harness-big`): ciemnych zostaje 166, z czego 153 były ciemne już 09.11 (czekają na muzykę
    albo beat, część z założenia), jeden doszedł po 09.11. 12 było jasnych 09.11: 9 z nich
    rozbłyska po jasnym poprzednim presecie albo w późniejszych klatkach — preset zaczyna od
    obrazu, który zastanie (jak w MilkDropie), a przegląd idzie w innej kolejności niż 09.11.
    Ostatnie 3 to warianty „Isosceles edit” (Flexi - emergencey 2 — edit5b i edit5e minimal,
    suksma - Zylot - Fusion (sunbirth mix) …): reakcja-dyfuzja, czarna ze sztucznym dźwiękiem
    w każdym ustawieniu; w odtwarzaczu z prawdziwą muzyką (11.11) „sunbirth” świeci od razu,
    a edit5b po kilkudziesięciu sekundach rozrasta się w białe struktury — nie błąd.
  - Pierwsze podejście dało inne liczby: `AudioContext` tej maszyny działa od 10.11 na 192 kHz,
    a butterchurn liczy pasma bas/środek/góra z częstotliwości kontekstu (kubełki FFT po 187,5 Hz),
    więc ten sam sygnał miał inny bas. Odtwarzacz jest na to odporny (`audio-rate.ts`: `atRate`
    pokazuje butterchurnowi 48 kHz); strony przeglądu mają teraz `AudioContext` 48 kHz.

  Wizualizacja wykrywa przy wczytaniu presetu albo w trakcie grania każdy preset, który się
  nie skompiluje lub rzuci, i pomija go na stałe (`localStorage`), tak jak przy presetach
  wbudowanych.

### Presety MilkDrop 3 (`.milk2` i sprite'y)

`.milk2` MilkDropa 3 to dwa całe presety (`[PRESET1_BEGIN]`…`[PRESET2_END]`, każdy jak
`.milk`) i nagłówek: `blending_pattern` (jeden z 30 wzorów), `blending_progress`,
`blending_direction`, `random_1`…`random_5`. MilkDrop 3 gra go jak przejście MilkDropa 2
z pierwszego presetu w drugi, **zatrzymane** na `blending_progress`: oba presety liczą swoje
równania i shadery, ruch siatki miesza się w każdym jej węźle według wzoru, a obraz końcowy to
shader comp drugiego nałożony na pierwszy z tą samą maską.

- **Build** (`splitMilk2`, `convertDouble`): każda połowa konwertowana jak `.milk` MilkDropa 3
  (fale modulo 18; echo zoom ≥ 8 to skala 0–100 menu MilkDropa 3: 1 + e/100), obie z
  `random_1`…`4` jako `rand_preset`. W porcji preset to `{ double: { first, second, blend } }`.
- **Odtwarzanie** (`milkdrop.ts`, łatki `double-preset-*`): pierwsza połowa wchodzi zwykłym
  przejściem, potem druga z `md.blend` dochodzi w tempie przejścia do `blending_progress`
  i tam stoi; butterchurn ma przejścia MilkDropa 2 (te same wzory A·p + C na węzłach siatki),
  więc łatka podmienia tylko wzór na wzór MilkDropa 3 i trzyma postęp. Przy wyjściu
  (`mdReleaseDouble`) wstrzymane przejście dobiega do drugiej połowy — pierwsza odchodzi w swoim
  wzorze — a potem następny preset wchodzi zwykłym przejściem. MilkDrop 3 miesza presety
  podwójne płynnie od wersji 3.3x (README MilkDropa 3: „Blending support for .milk2 files”); jak
  dokładnie, nie wiadomo (MilkDrop 3 PRO jest zamknięty, a MDropDX12 robi to jeszcze po staremu:
  pierwsza połowa znika od razu) — dwa kroki to nasze odtworzenie.
- **Wzory** (`md3Pattern`, `md3Field`): wszystkie 30 (`side`, `plasma`, `cercle`, `stars`,
  `snail`…) według wzorów, które MDropDX12 (CC BY-NC) odczytał z dekompilacji MilkDropa 3 PRO
  i zmierzył sondą (`engine_presets.cpp`) — napisane od nowa, nie skopiowane. 09.11 sprawdzone
  z samym programem MilkDropa 3.37 (analiza statyczna, niżej): `corner`, `patches`, `stars2`,
  `arrow` i `plasma`/`plasma2`/`plasma3` z generatorem plazmy liczy on dokładnie tak samo, co do
  stałych. Siatka: MilkDrop 3.37 liczy wzór w węzłach swojej siatki, domyślnie 64 × 48
  (`MeshSize`, wysokość 3/4 szerokości, najwyżej 192 × 144), a butterchurn ma 48 × 36 jak
  MilkDrop 2 — więc wzór liczymy na siatce 64 × 48 (od niej zależy normalizacja plazmy i to, co
  pada na węzły w `horizontal`) i próbkujemy dwuliniowo w węzłach butterchurna; siatka ruchu
  zostaje 48 × 36. Zamkniętej wersji PRO nikt nie sprawdzi; 3.37 to darmowe wydanie
  z instalatora. Nieznana nazwa wzoru: zwykłe przenikanie.
- **Sprite'y** (bloki `[SPRITE1_BEGIN]`…`[SPRITE1_END]` MilkDropa 3.25+; konwerter
  `parseSprite`, silnik `spriteQuad`/`drawSprites` i łatki `sprite-*`): rysowane tak, jak rysuje
  je MilkDrop 3.37. Opis wzięty z analizy statycznej jego programu: instalator pobrany drugi raz
  za zgodą właściciela i **nigdy nie uruchomiony**, 32-bitowy program z jego zasobów rozłożony
  `dumpbin /disasm`, dane czytane Pythonem (`-I`), wszystko skasowane potem; nic z programu nie
  jest skopiowane. Ma je 115 z 462 presetów paczki (24 podwójne, 91 zwykłych, w tym 16
  z MDropDX12).
  - Czytanie: w `.milk` tylko w presecie wersji 300 (`MILKDROP_PRESET_VERSION=300`, tak MilkDrop 3
    zapisuje preset ze sprite'em; mają ją wszystkie 91), w `.milk2` tylko z `sprite=1`
    w nagłówku i tylko z drugim presetem — jego zakres MilkDrop 3 rozciąga do ostatniego
    `[SPRITE1_END]`, więc blok po `[PRESET2_END]` jest jego, a blok w pierwszym presecie pomija
    (jeden plik, notatka). Liczą się klucze, nie znaczniki: plik z `[SPRITE1]` zamiast
    `[SPRITE1_BEGIN]` też ma sprite'a. Kod to `code_1`, `code_2`… do pierwszej brakującej (jak
    `ReadCode` MilkDropa 2), bez kodu init. Wartości, których blok nie ma: Blend 4, Burn 1,
    Alpha 1, SX i SY −0,5, Repeat 1, reszta 0 (reset MilkDropa 3).
  - Jeden sprite presetu (gniazdo 63 menedżera tekstur MilkDropa 2), z obrazkiem z `sprites\`
    albo `textures\`, i jego kod co klatkę ze zmiennymi sprite'ów MilkDropa 2 (`x`, `y`, `sx`,
    `sy`, `rot`, `flipx`, `flipy`, `r`, `g`, `b`, `a`, `repeatx`, `repeaty`, `burn`, `done`;
    `time` od wczytania, `frame`, `fps`, `progress`, `bass`…`treb_att`). Wartości bloku: X i Y
    dodane do 2x − 1 i 2y − 1, SX i SY do sx i sy, Alpha mnoży a, RepeatX/Y mnożą repeatx/y,
    Rot 1 i 2 obracają o ± czas × Speed (czas MilkDropa od startu).
  - Warstwa (`SpriteLayer`): 0 na gotowym obrazie po compie, 1 po warpie i blurze (przed
    kształtami), 2 przed falami, 3 przed falą prostą, 4 po ramkach. Burn 1 / 0 / inne: zawsze /
    nigdy / jak każe `burn` z kodu — wtedy sprite rysuje się najpierw do obrazu, który wraca
    w następnej klatce, a potem tam, gdzie rysował (w warstwach 1–4 to ten sam obraz, więc dwa
    razy — jak w MilkDropie 3); `done` kończy sprite'a, wypalonego przy tym w proporcjach 4:3.
  - Mieszanie (`SpriteBlend`, stany D3D9 z programu): 0 alfa koloru, 1 bez mieszania,
    2 addytywnie, 3 kolorem źródła, 4 alfa tekstury × a (domyślne), 5 mnożenie, 6 mnożenie
    przez odwrotność, 7 negatyw, 8 jak 4 z kolorem odbitym powyżej 0,5 (c > 0,5 → 1 − c),
    9 ADDSIGNED i mnożenie, 10 MODULATE2X addytywnie; kolor wierzchołka 8-bitowy jak D3DCOLOR.
    Klucz koloru (`SpriteColorKey`) jak w D3DX: MilkDrop 3 podaje `0xFF000000 | klucz`, a D3DX
    porównuje też alfę, więc przezroczystą czernią staje się tylko nieprzezroczysty teksel
    dokładnie tego koloru (do 10.11 także półprzezroczysty; ma takie jeden obrazek,
    `triangle4.png`). GIF (MilkDrop 3 czyta go przez GDI+): wszystkie klatki, bez klucza koloru,
    opóźnienia w setnych sekundy (0 → 0,1 s), w pętli od wczytania (`milkdrop-gif.ts`, dekoder
    pobierany dopiero z pierwszym GIF-em).
  - Obraz i próbkowanie (10.11, drugi raz z programu, tak samo: instalator pobrany za zgodą
    właściciela, rozmiar i SHA-256 zgodne z wydaniem na GitHubie, nigdy nie uruchomiony,
    skasowany). `LoadTex` (`texmgr`) prosi `D3DXCreateTextureFromFileExW` o szerokość i wysokość
    `D3DX_DEFAULT` — D3DX zaokrągla je w górę do potęgi dwójki (tekstury shaderów MilkDrop 3 czyta
    z `D3DX_DEFAULT_NONPOW2`, bez zaokrąglania) — o wszystkie poziomy mipmap (`D3DX_DEFAULT`, filtr
    pudełkowy) i o domyślny filtr; GIF to `CreateTexture` z jednym poziomem, w rozmiarze klatki.
    `DrawUserSprites` nie ustawia żadnego stanu samplera, więc działa to, co klatka zostawiła na
    etapie 0. MIN, MAG i MIP to zawsze LINEAR (ustawiają je tak początek klatki,
    `RestoreShaderParams` po shaderze warpa i compa, przebiegi blura, warp i comp bez shaderów),
    czyli filtrowanie trójliniowe, nigdy anizotropowe; jedyny wyjątek to nakładka wybierana w oknie
    ustawień (nie w presecie), która przed warstwą 1 ustawia MIP NONE. Adres: WRAP po shaderze compa
    (warstwa 0, w przejściu też starego presetu) i po shaderze warpa; CLAMP po przebiegach blura,
    które biegną, gdy któryś z rysowanych shaderów czyta blur (w przejściu też starego presetu);
    przy warpie bez shadera (`PSVERSION_WARP=0`) `wrap` presetu (> 0,5 → WRAP); comp bez shadera
    adresu nie rusza. Ma to znaczenie przy krawędziach obrazka (WRAP wciąga przeciwną krawędź)
    i przy `repeat` > 1; w paczce 42 sprite'y w warstwie 1 rysują się z CLAMP przez blur, a jeden
    („spiral out”) przez `wrap` 0. Tu: `d3dxTextureSize` i `stretchedTexture`
    (`milkdrop-textures.ts`) robią obraz jak D3DX — klucz, rozciągnięcie w GPU liniowo między
    czterema sąsiednimi tekselami z zawijaniem na brzegach (filtry D3DX zawijają, jeśli nie dostaną
    flag MIRROR; dokładnego jądra filtra trójkątnego D3DX w programie nie ma, to odtworzenie
    z dokumentacji), surowe piksele pliku (bez premultiplikacji i zarządzania kolorem, jak czyta je
    D3DX), pełne mipmapy; silnik rysuje sprite'a z własnym obiektem samplera (`spriteSampler`,
    `spriteWraps`). Do 10.11 sprite brał sampler, który butterchurn zostawił na jednostce 0
    (trójliniowy, z adresem według `wrap` presetu), więc klatki GIF-a o jednym poziomie były
    niekompletną teksturą: oba presety z GIF-em („GIF test” i „GIF test2”) rysowały czarną
    teksturę zamiast animacji.
  - Przejście (10.11, z programu): `LoadPreset` zabija sprite'a gniazda 63 i czyści jego plik
    i kod, zanim przeczyta nowy preset, a nowy preset przynosi swojego sprite'a przy czytaniu pliku
    (jego wartości nadpisują poprzednie, czas i klatka sprite'a liczą się od tej chwili). Stary
    sprite znika więc od razu, nowy od razu jest w pełni; nic się nie przenika — alfa sprite'a to
    tylko `a` × Alpha, a do rysowania nie dochodzi ani postęp przejścia, ani jego alfa. Postęp
    dochodzi tylko do kodu sprite'a jako `progress` = `m_fBlendProgress` bieżącego presetu:
    w przejściu od 0 do 1, po nim jego ostatnia wartość (tuż ponad 1, nic jej nie przycina), po
    wejściu bez przejścia 0 (zero zapisane przy wczytaniu), w presecie podwójnym wstrzymany postęp.
    Tu tak samo (`spriteStart`, `spriteProgress`; do 10.11 po przejściu i po cięciu było 1); żaden
    ze 115 kodów sprite'ów nie czyta `progress`. MilkDrop 3 czyta plik nowego presetu od razu, a
    mieszanie zaczyna po etapach wczytania (`m_nLoadingPreset` 1 → 8, jeden na klatkę), więc
    przez 8 klatek nowy sprite leży na samym starym obrazie — od 10.11.2026 tu też: w czasie
    etapów `drawSprites` rysuje sprite presetu, który czeka (`mdStaged`), a starego już nie.
  - Czego nie ma albo nie wiadomo: drugiego, „zapisanego” sprite'a edytora sprite'ów MilkDropa 3
    (stan interfejsu, nie presetu); `sprites\jello2.png` nie ma w instalatorze ani w repozytoriach
    MDropDX12 i Milkwave (tam tylko `Jello1.png`), więc dwa presety MDropDX12 grają bez sprite'a.
    Przegląd (10.11): 113 presetów rysuje swojego sprite'a; po 60 klatkach 61 jest jaśniejszych niż
    bez niego, 51 ciemniejszych, 3 prawie bez zmiany (sprite mnoży czarne tło albo ginie pod falą).
- **Nie odtworzone, z powodem:**
  - `.milk3` to nie format MilkDropa 3, tylko MDropDX12: JSON z shaderami z Shadertoya i GLSL
    Sandbox przełożonymi na HLSL SM 5.0, z przebiegami Image i Buffer A–D (`milk3_format.h`).
    Jawnie nie ma żadnego pliku `.milk3`, a granie ich to osobny odtwarzacz Shadertoya, nie
    preset MilkDropa.
- **Treść** (`vendor/milkdrop-presets/milkdrop3/`, z `SOURCE.txt`): presety z oficjalnego
  instalatora MilkDropa 3.37 (`MilkDrop3.exe` z wydania na GitHubie milkdrop2077/MilkDrop3,
  rozmiar i SHA-256 zgodne z podanymi tam). Pobrany za zgodą właściciela tylko po presety
  i **nigdy nie uruchomiony**: jego dane to dwa archiwa ZIP w zasobach programu (główne
  i opcjonalny zestaw „wymagających” presetów), czytane modułem `zipfile` Pythona (`python -I`);
  instalator i rozpakowane pliki skasowane potem. Wzięte wszystkie 147 `.milk2` i te `.milk`,
  których nie ma inna paczka — 290 z 391 (porównanie treści bez końców linii; 95 jest
  w BeatDropie, 6 w paczkach projectM) — plus `ring5.milk` z Milkwave. Licencja instalatora:
  darmowy do użytku osobistego, komercyjnie nie — więc tylko w `vendor/`. Do tego dwie
  kategorie z GitHuba, każda z `SOURCE.txt`: „MDropDX12” — 22 z 93 presetów `bundle/presets`
  MDropDX12 (głównie przeróbki MilkDrop2077; reszta jest już w BeatDropie, w „Presets” i w
  MilkDrop original; repozytorium CC BY-NC 4.0, presety podpisane przez autorów) — i
  „XorPlayer” — 2 z 3 przeróbek shaderów XorDeva z XorPlayera (repozytorium BSD-3, shadery na
  warunkach XorDeva; trzeci, „Grok2”, jest w BeatDropie). Bez tekstur, których by brakowało.
  Obrazki sprite'ów: 39 z 82 z tego samego instalatora — te, które presety nazywają
  (`vendor/milkdrop-textures/milkdrop3-sprites/`, 17 MB, każdy jako `sprite_<nazwa>`, z
  `SOURCE.txt` i `random-pool: no`) — oraz dwie jego tekstury, które presety biorą za sprite'a
  (`MilkDrop3_023`, `MilkDrop3_026`; do `milkdrop3/`). Brakuje tylko `sprites\jello2.png`.

### Tekstury presetów (`vendor/milkdrop-textures`)

Presety MilkDropa sięgają po tekstury po nazwie pliku (`sampler_worms` to `worms.jpg`).
butterchurn ma tylko clouds2 i pustą, a dotąd każdy inny preset dostawał clouds2. Build bierze
obrazy z `vendor/milkdrop-textures/` (np. [paczka tekstur
projectM](https://github.com/projectM-visualizer/presets-milkdrop-texture-pack): 67 plików
JPEG, 3,5 MB — tekstury MilkDropa i te, których używają presety społeczności), a z katalogów
paczek te, o które preset prosi po nazwie (En D trzyma swoje w `Textures/`; okładki i logo
zostają). Bez licencji, więc tylko w `vendor/` (zob. `NOTICE.md`).

- **Build** (`scripts/milkdrop-textures.mjs`): każdy obraz (JPEG — też `.jfif` —, PNG, GIF, WebP, BMP; `.tga`
  i `.dds` są wypisywane jako pominięte) trafia do `assets/milkdrop/textures/<nazwa>-<hash>.<ext>`,
  a jego nazwa, plik i wymiary (z nagłówka pliku) — do `virtual:milkdrop-presets`
  (`textures.list`). Globalne `vec4 texsize_<nazwa>;` presetów, których MilkDrop ustawia,
  a butterchurn nie (były zerami), dostają przy budowaniu wymiary tekstury, a dla nazwy,
  której nie ma, wymiary clouds2. Cache konwersji się przez to nie zmienia.
- **Przeglądarka** (`milkdrop-textures.ts`): przed `loadPreset` pobiera tekstury, których preset
  używa (zadeklarowanych i nieczytanych nie pobiera), i rejestruje je w butterchurnie
  (`renderer.image.samplers`, czytanym co klatkę). Nazwy bez względu na wielkość liter;
  prefiksy `fw_`/`fc_`/`pw_`/`pc_` wybierają filtrowanie i zawijanie, jak w MilkDropie.
  Preset czeka na tekstury najwyżej 2,5 s; spóźniona pojawia się w klatce, w której dojdzie.
  Sprite presetu MilkDropa 3 dostaje swój obraz pod własną nazwą (`md_sprite_<nazwa>`) tak, jak
  robi go D3DX dla MilkDropa 3: klucz koloru (nieprzezroczyste piksele dokładnie tego koloru stają
  się przezroczystą czernią), potem rozciągnięcie do potęgi dwójki na każdym boku i pełne mipmapy
  — w GPU (`stretchedTexture`), z surowych pikseli pliku; w pamięci liczy się rozmiar po
  rozciągnięciu. GIF — każdą klatkę jako osobną teksturę o jednym poziomie (do 96 MB; większy gra
  pierwszą klatką). Szczegóły i powód: „Presety MilkDrop 3”, sprite'y.
- **Losowe tekstury** `rand00`…`rand15` (też `rand03_smalltiled` — tylko te, których nazwa
  tak się zaczyna) losują teksturę z katalogu przy każdym wczytaniu presetu, jedną na slot dla
  obu shaderów, a `texsize_randNN` dostaje jej wymiary. Wylosowana ma w shaderze własną nazwę
  (`sampler_rand00_pick12`), więc przenikający się poprzedni preset zachowuje swoją. Bez
  tekstur w buildzie losują spośród tych z `imageData`.
- **Pamięć:** tekstury zostają na GPU, dopóki presety ich używają; powyżej ok. 64 MB najdawniej
  używane idą pierwsze, nigdy te bieżącego i poprzedniego presetu. Większe niż
  `MAX_TEXTURE_SIZE` są zmniejszane.
- **Źródła i pula losowa:** `SOURCE.txt` katalogu może mieć wiersz `random-pool: no` (tekstury
  tylko po nazwie) albo `random-pool: prefixed` (po nazwie i w slotach z prefiksem, jak
  `rand00_chelsea`, ale nie w zwykłych `randNN`) — tak jest u BeatDropa, żeby jego 72 obrazy nie
  zmieniały losowania presetów MilkDropa 2. Slot z prefiksem, dla którego nie ma żadnej
  tekstury, zostaje przy clouds2.
- **Stan (09.11.2026):** 594 tekstury, 747 MB: 67 z paczki projectM, 4 z En D, 72 z BeatDropa
  (`vendor/milkdrop-textures/beatdrop/`), 401 z losowych zestawów BeatDropa (404 obrazy, 703 MB,
  częściowo z grafiką postaci z filmów; trzy powtórzone nazwy pominięte) — od 09.11.2026
  w buildzie (`vendor/milkdrop-textures/beatdrop-random-sets/`; decyzja właściciela: prywatny
  odtwarzacz, użytek niekomercyjny; obrazy są dociągane dopiero przez preset, który ich używa) —,
  4 z mdpresetpack na SourceForge (`portal1`, `portal2`, `AbalonyStosich`, `noise64`;
  `vendor/milkdrop-textures/mdpresetpack/`) i 7 z instalatora MilkDropa 3 (`Pattern_005`,
  `Pattern_007`, `Pattern_032`, `Pattern_047`, `MilkDrop3_023`, `MilkDrop3_024`, `MilkDrop3_026`;
  `vendor/milkdrop-textures/milkdrop3/`), każde źródło z `SOURCE.txt`; do tego 39 obrazków
  sprite'ów MilkDropa 3 (`vendor/milkdrop-textures/milkdrop3-sprites/`, 17 MB). Z presetów
  paczek 1 218 czyta tekstury, których butterchurn nie ma, i wszystkie 1 218 dostają wszystkie
  (08.11: 910 z 1 076); 113 ze 115 sprite'ów ma swój obrazek (bez `jello2.png`); `Pattern_047`
  („MilkDrop2077 - AVS swirling3”) był tylko w instalatorze. Lista brakujących:
  `node_modules/.cache/milkdrop-presets/textures-missing.txt`. W przeglądarce 65 presetów
  z teksturami przeszło porównanie z tym samym presetem bez nich (ta sama losowość i dźwięk):
  każdy dostał swoje tekstury, a 52 wyglądają po 1,5 s wyraźnie inaczej.

## Wizualizacja Geiss (Winamp)

**Co to jest.** Wtyczka Ryana Geissa do Winampa (Geiss 4.30, 1998–2023) przeniesiona z jej
własnego kodu ([geissomatik/geiss](https://github.com/geissomatik/geiss), 3-Clause BSD, licencja
w `geiss/LICENSE-geiss.txt`) we wszystkich trzech głębiach koloru:
- **32 bity** — domyślnie, jak w 4.30: od 4.27 domyślny tryb wideo jest 32-bitowy, a od 4.29
  Geiss bierze tryb pulpitu, czyli dziś 32 bity. Fale, kropki nuclide, chasers i tytuł mają
  kolory, belka rysuje się trzy razy z rozszczepieniem barw, a ekran pokazuje każdy bajt
  podwojony;
- **16 bitów** — rysuje jak 32 bity, a ekran dostaje 5-6-5;
- **8 bitów** — klasyczny Geiss z paletą (domyślny tryb do 4.26).

W panelu nazywa się „Geiss (Winamp)” i zajmuje miejsce oraz identyfikator `geiss-classic`
dawnego „Geiss Classic” (podobieństwo w WebGL 2, usunięte), więc zapisany porządek, lista
włączonych i wybór w przeglądarce działają dalej. „Geiss (MilkDrop)” to co innego: presety
MilkDropa autorstwa Geissa, odtwarzane przez butterchurna (`milkdrop.ts`).

**Pliki:**
- `geiss/sim.ts` — port, funkcja po funkcji, bez importów (testy uruchamiają go bez bundlera):
  - `render1()` / `RenderFX()` — kolejność klatki i efekty rysowane w starą klatkę;
  - `Process_Map()` (asm z `proc_map.cpp`) — każdy piksel to ważona suma czterech pikseli
    źródła. Przy 8 bitach reszta z DL przechodzi na następny piksel (dither wolnego
    wygaszania); przy 16/32 bitach pętla MMX robi to samo dla niebieskiego, zielonego,
    czerwonego i czwartego bajtu naraz, z resztą w `mm6`;
  - `GenerateChunkOfNewMap()` — 25 map; następna liczy się po kawałku w tle i wchodzi na beat;
  - `GetWaveData()` / `RenderDots()` / `RenderWave()` — 576 próbek z Winampa, wyzwalanie
    poziomem, wykrywanie beatu i „big beatu”, przesuwanie obrazu (shifting), fale 1–7
    (powyżej 8 bitów w kolorach);
  - `Effects.h` — shade bobs, chasers, belka, kropkowy chaser, kropki nuclide, siatka, cząstki
    słoneczne, przygaszony środek, każdy z paletą i w kolorze;
  - `video.h` — `FX_Random_Palette()` / `PutPalette()` / `CrankPal()` (8 bitów), przenikanie
    palet przez 9 klatek, a z `Merge_All_VS_To_Backbuffer()` to, co trafia na ekran
    (`presentFrame()`);
  - wyskakujący tytuł utworu i własne napisy GEISS.INI (`showMessage()`, klawisze `m##`),
    wypalane po chwili w obraz; `drawTitle()` / `presentFrame()` rysują je nad klatką tak, jak
    GDI rysował je w tylnym buforze;
  - analiza Fouriera z `GetWaveData()` (23 pasma, powyżej 8 bitów co klatkę) i kolory fal według
    muzyki (`syncColorToSound`).
- `geiss/maps.ts` — 25 map jako presety: identyfikator `map-01`…`map-25`, numer z klawiszy
  „##” wtyczki, polska nazwa (klucz `t()`) według komentarzy Geissa w kodzie, a także
  `mapRatings()`.
- `geiss/presets.ts` — własne presety w przeglądarce (GEISS.INI, niżej): sloty 00–99, odczyt
  i zapis `localStorage`, sprawdzanie zapisanego presetu (czyste funkcje, testy).
- `geiss/messages.ts` — własne napisy w przeglądarce (GEISS.INI `[CUSTOM MESSAGES]`): sloty
  00–99, odczyt wartości tak jak `GetPrivateProfileString` (`messageText()`), zapis
  `localStorage`, oraz opcja kolorów fal według muzyki (czyste funkcje, testy).
- `geiss/title-font.ts` — tytuły i napisy tak, jak rysował je GDI (szerokości znaków GDI,
  kształty z Ariala przeglądarki; niżej).
- `geiss/overlay.ts`, `geiss/stage.css` — ramka „Presety i napisy” nad obrazem: zakładki
  „Presety” (zapisz, wczytaj, usuń) i „Własne napisy” (zapisz, zmień, pokaż, usuń) oraz opcja
  „Kolory fal według muzyki”.
- `geiss/index.ts` — adapter: dźwięk, obraz, panel, głębia koloru, presety. Scena to
  `.geiss-stage` (płótno obrazu i ramka presetów nad nim).
- `geiss.ts` — wpis wtyczki: `fftSize` 1024, bez wygładzania.

**Arytmetyka.** Oryginał to 32-bitowy C++ na x86 (SSE2, `/fp:precise`) ze wstawkami asm i MMX.
Gdzie liczy we `float`, port zaokrągla `Math.fround` po każdym działaniu, a gdzie promuje do
`double`, nie zaokrągla. Jego `sinf`/`cosf`/`powf`/`sqrtf` na x86 to `(float)f((double)x)`, więc
port robi to samo. `rand()` to LCG MSVC. Uwzględnione są też szczegóły kompilatora i procesora:
- `(unsigned char)` z `float` poza zakresem daje 0 (cvttss2si);
- MSVC woła prawy `rand()` z wyrażenia `a*rand… + b*rand…` pierwszy (mapa 15);
- tablica efektów ma dziewiąty, nienazwany efekt, który liczy się do limitu;
- `protective_factor` przy pierwszej mapie wynosi 0;
- DL na starcie pętli 8-bitowej to 0xA1, czyli to, co zostawił w EDX ostatni `ReplaceDWORD`;
- pętla MMX nie zeruje `mm6`, więc pierwszy piksel dodaje to, co rejestr trzymał: przy 32
  bitach podwojone bajty pikseli W−4 i W−3 ostatniego widocznego wiersza (resztę kopii na
  ekran z poprzedniej klatki), przy 16 bitach resztę z końca poprzedniej pętli. Kawałek mapy 15
  liczy `atan2` na stosie x87, który ma te same rejestry co MMX: zostaje po nim mantysa π
  (0xC90FDAA22168C235), gdy ostatni piksel leżał na lewo od środka mapy, a inaczej zera
  w trzech pierwszych słowach;
- w fali 7 powyżej 8 bitów lokalne `float b` (wyraz wolny prostej) przesłania kolor niebieski
  i trafia do obrazu zamiast niego, jak w oryginale.

Pętlę MMX port liczy po dwa 16-bitowe pasy w jednej liczbie 32-bitowej (niebieski z czerwonym,
zielony z czwartym bajtem), co skraca ją prawie o połowę. Wynik jest ten sam: przy reszcie
poniżej 256 i wagach sumujących się najwyżej do 256 niższy pas nie przekracza 65 535, więc nie
dosięga wyższego. Pierwszy piksel (cały `mm6`) i rzadkie wagi powyżej 256 (źródło tuż nad
górną krawędzią obrazu, gdzie `toByte()` zawija) liczą się pas po pasie.

**Obraz.** CPU liczy bajty jak oryginał, a `presentFrame()` robi z nich to, co pokazywała karta:
przy 8 bitach indeks przez paletę, przy 32 bitach każdy bajt podwojony (najwyżej 255, PADDUSB),
przy 16 bitach podwojony i obcięty do 5-6-5. Adapter kładzie klatkę na płótnie 2D, które
przeglądarka skaluje do panelu (dwuliniowo, jak monitor w trybie pełnoekranowym).
- Rozmiar to panel w pikselach urządzenia (DPR do 2), najwyżej 1280×720 (telefon: 800×450);
  szerokość jest wielokrotnością 16 (kopia 32-bitowa brała po 16 pikseli), wysokość 4, minimum
  320×200. Geiss 4.29+ też brał to, co dawał pulpit; mapy liczą ruch względem środka, więc nie
  zależą od rozmiaru.
- Zmiana rozmiaru (pełny ekran) po 250 ms przebudowuje mapę dla nowego rozmiaru. Obraz,
  paleta, zegar i historia dźwięku przechodzą dalej (`GeissOptions.from`).
- Gdy procesor nie nadąża, obraz się zmniejsza, a gdy znów nadąża, sam wraca do pełnego
  rozmiaru (`geiss/budget.ts`, `PictureBudget`, czysta logika; testy w `geiss.test.ts`). Geiss
  4.30 nigdy nie zmieniał trybu wideo w trakcie działania. Mierzył za to fps z ostatnich 30
  klatek (`time_array` w `render1()`, od 33. klatki wygładzane: `fps·0,95 + 0,05·nowe`) i do niego
  dopasowywał ruch, życie mapy i wygaszanie. Port ocenia koszt klatki w tych samych oknach po 30
  klatek, ich medianą, więc pojedyncza droga klatka (mapa liczona od razu: „n”, wybór mapy,
  50–150 ms) nic nie znaczy:
  - w dół szybko: trzy okna z rzędu z medianą powyżej 14 ms (ok. 1,5 s przy 60 kl./s) i obraz
    bierze 60% pikseli, najmniej 400×300;
  - w górę powoli: koszt następnego rozmiaru (piksele / 0,6, najwyżej tyle, ile chce panel) to
    mediana razy stosunek pikseli; gdy przez 8 s każde okno przewiduje najwyżej 80% z 14 ms,
    obraz rośnie o ten krok. Część klatki nie zależy od pikseli, więc przewidywanie raczej zawyża;
  - bez wahań: w dół przy 14 ms, w górę dopiero przy 11,2 ms przewidywanych na większym obrazie,
    więc obciążenie, przy którym większy obraz byłby za wolny, zostawia mniejszy. Krok w górę
    cofnięty w ciągu 6 s (złe przewidywanie widać po 2–4 s) podwaja czekanie przed następnym (do
    64 s), a krok, który się utrzymał, wraca je do 8 s;
  - przerwa dłuższa niż 3 s w oknie (ukryta karta, zamknięty panel) i każdy nowy obraz (rozmiar,
    głębia koloru) zaczynają liczenie od nowa, a pierwszego okna nowego obrazu się nie ocenia.

  Przebudowa przenosi obraz, paletę, zegar i dźwięk jak zmiana rozmiaru (`GeissOptions.from`);
  `sim.ts` się nie zmienia, więc w każdym rozmiarze rysunek jest tym samym portem co do bitu.
  Sprawdzone w przeglądarce 10.11.2026 (panel 1280×720, 32 bity): 48 wątków zajmujących procesor
  zmniejszyło obraz do 992×556 po ok. 2 s, a po ich zatrzymaniu obraz wrócił do 1280×720 po ok.
  11 s.
- Koszt klatki na komputerze deweloperskim przy 1312×708 (panel 1920×1040): `frame()` razem
  z `presentFrame()` w Node (ten sam V8) to ok. 5,5 ms przy 8 bitach, 9,6 ms przy 32 i 10,6 ms
  przy 16 bitach; w Chrome z `putImageData` mediana ok. 6,7 ms przy 8 bitach i ok. 10 ms przy
  32 bitach (pomiar przy obciążonym procesorze). Telefon w pionie (416×860, 8 bitów) to ok.
  2,6 ms. Mapa liczona od razu (wybór mapy, „następny”) zajmuje 50–150 ms, jak klawisz „n”
  w oryginale. Auto liczy następną mapę w tle, bez przycinania.

**Czas.** Klatka przypada na odświeżenie ekranu, najwyżej 80 na sekundę (60/75 Hz — każde
odświeżenie, 120 Hz — co drugie, 144 Hz — 72 kl./s). Zegar `clock()` Geissa to milisekundy od
startu bez przerw ukrytej karty. Geiss mierzy z niego fps jak w `render1()`:
- ruch na klatkę zwalnia przy fps powyżej 30;
- mapa żyje 550 klatek przy 30 fps (ok. 18 s);
- zanik jest na klatkę, jak w oryginale przy danym odświeżaniu.

**Dźwięk.** Co klatkę najnowsze 576 próbek lewego i prawego kanału (dwa analizatory za
rozdzielaczem, 1024 próbki przy 44,1/48 kHz, przy 96/192 kHz uśrednione w dół) zamienione
w bajty, które Winamp dawał wtyczkom, tym samym kodem co AVS (`avs/winamp-visdata.ts`, opis
w sekcji AVS): fala to górny bajt 16-bitowej próbki (−128…127, `pcmTopByte`), a widmo to 576
bajtów Winampa z FFT 512 (`winampSpectrum`), każdy kanał osobno. Tablica `g_logtab` należy do
AVS-a, więc Geiss jej nie używa. Widmo czyta tylko mapa 10 w trybie „spectrum”.

**Panel.** Presety to 25 map z numerami Geissa („1. Spirala”…„25. Głęboki zoom”).
- **Auto** to wybór samego Geissa: losowanie wagami gwiazdek z rejestru 4.30 (mapy 5–9 po 5,
  17 → 4, 15 → 2, 12 → 1, reszta 3). Następna mapa liczy się w tle i wchodzi, gdy jest gotowa,
  a przy wykrytym rytmie na „big beat”. Razem z mapą losują się fala, efekty i (przy 8 bitach)
  paleta.
- **Przypięta mapa** wraca z nowymi parametrami (środek, obrót, fala, efekty, przy 8 bitach
  paleta), jakby inne mapy nie miały gwiazdek.
- **„Auto — tylko ulubione”** losuje wyłącznie spośród ulubionych map.
- **„Następny”** w Auto to klawisz „n”: przygotowywana mapa od razu, zawsze inna niż bieżąca.
  Przy przypiętej mapie to kolejna mapa z listy.
- **Twoje presety (GEISS.INI)**: grupa listy pod mapami, „Preset 07: 5. Superperspektywa”
  (identyfikator `preset-07`). Wybrany preset to `[07` z blokadą Geissa (klawisz L): mapa
  zostaje na ekranie, Auto jej nie zmienia, a wybór jest zapamiętany jak przypięta mapa
  (`media-visualizer-preset:geiss-classic`). Działają ‹, ›, gwiazdka i „Ulubione”; „Auto —
  tylko ulubione” losuje dalej same mapy. Nowy rozmiar obrazu albo głębia koloru wczytują
  przypięty preset od nowa w nowym obrazie, jak `[##` by go tam wczytał (środek jest ułamkiem
  szerokości i wysokości).
- **Ramka „Presety i napisy”** w prawym dolnym rogu obrazu chowa się razem z paskiem
  (`.visualizer-panel__overlay`); na telefonie ma najwyżej 52% wysokości ekranu, żeby nie
  wchodziła pod trzy rzędy paska. Ma dwie zakładki (strzałki przełączają je z klawiatury) i pod
  nimi opcję kolorów fal:
  - **Presety**: slot 00–99 (01 na początku, przy każdym „wolne” albo nazwa mapy),
    „Zapisz”/„Nadpisz” (`]##`, mapa na ekranie), listę zapisanych z „Wczytaj” („Na ekranie” przy
    przypiętym) i koszem. Usunięcie pyta drugi raz („Usunąć?”, 4 s); usunięty preset z ekranu
    zostawia na nim swoją mapę, przypiętą;
  - **Własne napisy** (niżej, „GEISS.INI — własne napisy”);
  - **Kolory fal według muzyki** (niżej).
- Nadpisanie slotu zmienia nazwę pod tym samym identyfikatorem, więc lista panelu przebudowuje
  się też wtedy (`ExternalVisualizer.presetsRevision`, `PresetState.revision`; wcześniej tylko
  przy zmianie liczby presetów).
- **Głębia koloru** to trzeci select panelu, ten sam, w którym MilkDrop ma paczki presetów,
  a Shadery źródła (`pools()` / `choosePool()`): to istniejące miejsce na wybór jednej
  wizualizacji, więc nie trzeba nowego elementu. Wtyczka nadaje mu nazwę „Głębia koloru”
  (`ExternalVisualizer.poolsLabel()`: etykieta i podpowiedź selectu; bez niej panel pisze
  „Paczka presetów”). Pozycje: „Kolor 32-bitowy (domyślny)”, „Kolor 16-bitowy” i „Paleta
  8-bitowa (klasyczna)”. Wybór jest zapamiętywany (`media-visualizer-pack:geiss-classic`, jak
  paczka MilkDropa) i obowiązuje też w „Ulubionych”. Działa od następnej klatki: mapa się
  przebudowuje, a obraz przechodzi do nowej głębi (z palety w jej barwach, do palety przez
  najjaśniejszy kanał, od razu z nową paletą). Oryginał zmieniał tryb wideo dopiero po
  ponownym uruchomieniu.
- **Tytuł utworu** z `announce()` pokazuje się jak w Winampie (`Check_For_New_Song_Title()`,
  `Plop_Songtitle_Using_Backbuffer_As_Scratch()`):
  - czcionka to ta, którą wtyczka dostawała od GDI: `CreateFont(24, 10, …, 700, …,
    DEFAULT_CHARSET, …, DEFAULT_QUALITY, VARIABLE_PITCH | FF_DONTCARE, NULL)` daje Arial Bold,
    komórkę 24 px przy 20 px na em, linię bazową 19 px od góry; szerokość 10 jest jego własną.
    Przy obrazie szerokim na 320 pikseli wtyczka czcionki nie robiła (`FXW > 320`) i pisała
    czcionką DC, SYSTEM_FONT (komórka 16, linia bazowa 13);
  - kolory: tekst (225, 225, 225) z cieniem (20, 20, 20) o piksel w prawo i w dół, przezroczyście;
    przy 8 bitach najbliższe im kolory palety (pierwszy z równych, jak GDI — sprawdzone na 22 000
    paletach), przy 16 bitach słowa 5-6-5 (górne bity), przy 32 bitach dokładnie;
  - pozycja: suma czterech `rand()` na każdą oś w obrębie pasa obrazu, liczona z szerokości
    tekstu, jaką podaje `GetTextExtentPoint()`;
  - czas: 20 klatek przy 30 fps (`fps_at_last_mode_switch`), w ostatniej klatce tekst wypala się
    w obraz i rozpływa z mapą: przy 8 bitach indeks 225 w każdym pikselu prostokąta tekstu, który
    GDI narysował (nieprzezroczyście, z czarnym tłem) indeksem powyżej 1 — więc paleta, w której
    najbliższa czerni leży powyżej indeksu 1, wypala cały prostokąt („białe pole” z 4.x); powyżej
    8 bitów w losowym jasnym kolorze `g_title_R/G/B` (128 + rand()%99 na kanał, R w pierwszym
    bajcie, jak w oryginale).
  - start w trakcie utworu: Geiss co klatkę czytał tytuł okna Winampa, więc włączony w trakcie
    utworu od razu pokazywał jego tytuł (i brał jego kolor). Odtwarzacz ogłasza tylko nowy utwór,
    więc Geiss włączony później bierze grany utwór z `navigator.mediaSession` („tytuł — wykonawca”,
    jak ogłoszenie; `playingTitle()` w `geiss/index.ts`). Do 11.11.2026 (5) pierwszy tytuł
    przychodził dopiero z następnym utworem, a napis pokazany przed nim wypalał się na czarno
    (`g_title_R/G/B` były jeszcze zerami).
- **Jak rysowany jest tekst** (`geiss/title-font.ts`): czcionek Windows nie dołączamy, więc
  tekst rysuje Arial przeglądarki (albo Liberation Sans / Arimo, potem bezszeryfowa), litera po
  literze w miejscu pióra GDI — szerokości znaków U+0020–U+017F i kilku znaków interpunkcji
  zmierzone z GDI (`gdi_probe.cpp`) są w pliku — bez wygładzania, jak GDI przy 8 bitach (piksel
  jest tekstem od 2/3 pokrycia, co daje grubość pni GDI). Szerokość tekstu, a więc i miejsce
  napisu, jest taka jak w oryginale; kształty liter prawie: wobec pikseli GDI dla 12 tytułów
  (także polskich) wspólne jest 0,92 pikseli tekstu w Arialu Bold i 0,81 w zastępstwie
  SYSTEM_FONT (Arial Bold 13 px; MS Sans Serif i Tahoma wypadały gorzej).
- **Kolory fal według muzyki** (opcja z panelu konfiguracji Geissa: „Don't base the wave colors
  on the music” odznaczone, `g_bSyncColorToSound`; w oryginale domyślnie wyłączona): fala
  w 97% bierze kolor z muzyki — pasma 0–7 analizy Fouriera to czerwony, 7–14 zielony, 13–23
  niebieski (×2,4, z odjęciem części od czerwonego), przeskalowane do jasności fali — w 3%
  z numeru klatki i jest o 35% jaśniejsza. Działa przy 16 i 32 bitach (przy 8 bitach fala to
  indeks palety, jak w oryginale). Analiza liczy się powyżej 8 bitów co klatkę także przy
  wyłączonej opcji, jak w oryginale, więc włączenie w trakcie daje te same klatki. Port liczy ją
  z tablicami `cosf`/`sinf` (te same stałe, które wtyczka liczyła co klatkę). Wybór jest
  zapamiętany w przeglądarce (`media-visualizer-geiss-sync-colour`, "1"), przechodzi przez
  przebudowy obrazu, a zmiana w innej karcie przychodzi zdarzeniem `storage`.

**Zgodność z oryginałem.** Wzorcem jest oryginalny kod skompilowany MSVC dla 32-bitowego x86:
`main.cpp`, `proc_map.cpp` z samomodyfikującym się asm, `Effects.h`, `video.h`, `Sysstuff.h`,
bez zmian. DirectDraw zastępuje atrapa (powierzchnie 8-, 16- i 32-bitowe w pamięci, paleta
zapisująca `SetEntries`), a Winampa host, który co klatkę podaje `waveformData`/`spectrumData`
z pliku i zegar 1/fps. Wzorzec i port dostają te same dane, ziarno i skrypt klawiszy;
porównywane są bajty, które pokazuje ekran (przy 8 bitach też paleta), całe klatki albo ich
sumy CRC-32. Klatki ostatecznej wersji są identyczne co do bitu:
- 8 bitów: 25 map z wymuszonymi falami 1–7 i każdym efektem, po 3000 klatek w 640×480,
  800×600, 1280×720 i 320×240; Auto na „Sandstorm” 600 i 3600 klatek (3 samoczynne zmiany
  mapy, shifting), także na bajtach Winampa z `winamp-visdata.ts`; dwa inne ziarna przy 30 fps,
  po 2400 klatek;
- 32 bity: te same 25 map po 3000 klatek w tych czterech rozmiarach; Auto 600 i 3600 klatek
  (3 samoczynne zmiany mapy, shifting); dwa inne ziarna przy 30 fps, po 2400 klatek;
- 16 bitów: 25 map po 3000 klatek w 640×480 i 1280×720; Auto 3600 klatek;
- tytuły i własne napisy (harness `harness_messages.cpp`: `GetDC()` atrapy to sekcja DIB
  w formacie powierzchni, więc tekst rysuje prawdziwy GDI; maski liter GDI dostaje port):
  8 bitów 640×480, 800×600, 1280×720, 384×240 i 320×240 (SYSTEM_FONT), 32 bity 1280×720,
  384×240 i 320×240, 16 bitów 800×600 i 384×240, po 540 klatek — tytuł, napis nad tytułem,
  napis nad napisem, napis pusty (brak w GEISS.INI), 255 znaków, polskie litery, wartość
  w cudzysłowie, nowy tytuł w trakcie napisu; pełne klatki 640×480 przy 8 i 32 bitach bajt
  w bajt. Powyżej 8 bitów z czcionką bez wygładzania (`NONANTIALIASED_QUALITY`): przy 8 bitach
  GDI i tak nie wygładza (klatki z `DEFAULT_QUALITY` są identyczne);
- kolory fal według muzyki: Sandstorm 800×600 przy 32 i 16 bitach, 3600 klatek (z wyłączeniem
  i włączeniem w trakcie i 13 mapami); Auto z tytułem, napisami i tą opcją, 1024×576, 8 i 32
  bity, 3600 klatek.

Wzorzec, narzędzia porównania i arkusze (oryginał | port | różnica ×32) leżą poza
repozytorium, w ignorowanym `scratch/`: `scratch/geiss-reference/` (atrapa DirectDraw
`harness.cpp`, `build.bat` dla MSVC x86, źródła Geissa 4.30 i skrypty porównań) oraz arkusze
w `scratch/renders/geiss/`. W repozytorium zostaje `visualizations/geiss.test.ts`, który na
sygnale syntetycznym (liczby całkowite, ten sam w C++ i TS) sprawdza sumy CRC-32 klatek
wzorca: wszystkie mapy, fale i efekty w 384×240 przy 8, 16 i 32 bitach oraz Auto z mapą
spectrum i zmianą mapy w 320×200 przy 8 i 32 bitach.
`geiss-messages.test.ts` trzyma sumy wzorca dla napisów i tytułów (384×240 przy 8, 16 i 32
bitach; litery z prostokątów — I, -, _, ., | — tak jak narysował je GDI) i dla kolorów fal
według muzyki (wszystkie mapy przy 32 i 16 bitach, Auto 320×200), zachowanie napisu, kolor GDI
i „białe pole”, magazyn napisów.

**GEISS.INI — własne presety.** Geiss 4.30 zapisuje klawiszami `]##` i wczytuje `[##` sekcję
`[PRESET ##]` w GEISS.INI (`SavePreset()`/`LoadPreset()` w `Effects.h`; instalator żadnego nie
dostarcza, ustawienia są w rejestrze). Port ma to samo (`sim.ts`, `savePreset()`/`loadPreset()`),
a sloty 00–99 trzyma w przeglądarce (`localStorage` `media-visualizer-geiss-presets`: JSON
`{"07": {klucze GEISS.INI}}`; zmiany z innej karty przychodzą zdarzeniem `storage`).
- **Treść** to klucze Geissa: środek mapy jako ułamek szerokości i wysokości (`x_center`,
  `y_center`), mapa (`mode`), tłumienie ruchu (`damping`), fala (`wave`), suma wag, czyli
  wygaszanie (`magic`), krok głośności fali (`volpos`), shifting (`shift`), jasność palety
  (`gamma`), obrót i skala (`t1`, `t2`, `s1`, `s2`; „2” to piksele z ditheringiem), parametry
  mapy `f1`–`f4`, osiem efektów (`effect_chasers`… `effect_spectral`), paleta 8-bitowa
  (jaśniejsze pasmo, paleta „FX” albo trzy krzywe) i kropki widma (`spectrum`).
- **Wczytanie** robi to, co `LoadPreset()` i `GenerateChunkOfNewMap(true)`: mapa liczona od razu
  (bez zerowania licznika fps, inaczej niż klawisze `##`), `rand()` zużywany tak samo (także
  losowania mapy, które preset potem nadpisuje), paleta przez `FX_Random_Palette(true)`,
  przenikana przez 9 klatek, efekty i shifting dopiero przy podmianie mapy. Czego plik nie trzyma,
  losuje się jak w Geissie od nowa: wiry mapy 6, dither mapy 7, drganie mapy 14. Kierunek siatki
  zostaje. Brak klucza daje domyślną wartość `LoadPreset()`; bez `x_center` presetu nie ma.
- **Zapis** ma te same klucze, a wartości dobiera tak, żeby `LoadPreset()` — także oryginału —
  oddał dokładnie zapisaną mapę. Plik Geissa tego nie zapewniał w czterech miejscach:
  - floaty: Geiss pisał `%f` (sześć miejsc), więc obrót wracał inny o ok. 5e-7; port zapisuje
    pełną precyzję;
  - środek: `gXC/FXW` z sześcioma miejscami potrafił po `(int)(x_center*FXW)` wrócić o piksel
    mniejszy (170/384 → 0,442708 → 169). Port zapisuje float, który daje ten sam piksel;
  - `magic` mapy 12: Geiss zapisywał sumę wag już obniżoną (×0,98), a wczytanie obniża ją znowu,
    więc mapa 12 ciemniała z każdym wczytaniem (250 → 245). Port zapisuje sumę sprzed obniżenia;
  - górny brzeg jaśniejszego pasma palety: Geiss zapisywał go pod kluczem `pal_hi_oband`, a czytał
    `pal_hi_band`, więc paleta z pasmem (co dziesiąta) traciła je przy wczytaniu. Port pisze
    `pal_hi_band`.

  Paleta jest zapisywana tylko przy 8 bitach (wyżej Geiss jej nie robi, a zapisywał zera). Preset
  zapisany w kolorze, wczytany przy palecie 8-bitowej, dostaje nową losową paletę jak nowa mapa;
  Geiss zbudowałby ją z krzywych „0”, czyli całą białą.
- **Sprawdzone z oryginałem** (wzorzec z komendami `save N`/`load N`, czyli `SavePreset()` i
  `LoadPreset()` Geissa na prawdziwym pliku INI przez `GetPrivateProfileString`;
  `scratch/geiss-reference/harness_presets.cpp`): port wczytujący GEISS.INI zapisany przez
  oryginał daje te same 440 klatek co do bitu, z paletą (8 bitów, mapy 12, 1, 15, 17, 6 i slot
  pusty). Oryginał wczytujący plik zapisany przez port daje klatki portu przy 8 i 32 bitach.
  `geiss-presets.test.ts` trzyma sumy CRC wzorca dla obu kierunków, round trip każdej z 25 map
  przy 8 i 32 bitach (mapa, środek, fala, efekty, shifting, kropki widma, paleta; tablice mapy
  identyczne poza mapami 6, 7 i 14, a zapisany ponownie preset jest ten sam), cztery różnice
  pliku Geissa i magazyn slotów.

**GEISS.INI — własne napisy.** Geiss 4.24+ pokazuje klawiszami `m##` napis ## z sekcji
`[CUSTOM MESSAGES]` (`MESSAGE 7=Hello Dad - I'm in Jail!`; `LoadCustomMsg()` w `Effects.h`).
Port: `sim.ts` `showMessage(tekst)`, sloty 00–99 w przeglądarce (`localStorage`
`media-visualizer-geiss-messages`: JSON `{"07": "wartość jak w GEISS.INI"}`; zmiany z innej karty
przychodzą zdarzeniem `storage`).
- **Wyświetlenie** jak w oryginale: napis zastępuje tytuł od razu, także w trakcie innego tytułu
  albo napisu (nowe losowe miejsce), na (20 + 1) klatek przy 30 fps, i tak samo wypala się
  w obraz — przy 16/32 bitach w kolorze ostatniego tytułu (napis nie losuje własnego). Błąd
  oryginału zostaje: przez średnik po `if (LoadCustomMsg(…));` brakujący napis też „się pokazuje”
  (pusty tekst, ale losowania i czas jak przy napisie). Tytuł, który zmienił się w trakcie napisu,
  wraca potem po cichu, bez wyskakiwania (`g_LastMessageWasCustom`); następny wyskakuje normalnie.
- **Treść** to wartość z GEISS.INI, czytana jak przez `GetPrivateProfileString`: bez spacji na
  brzegach, a w cudzysłowie (`"  tekst  "`) ze spacjami w środku; najwyżej 255 znaków
  (`g_song_title[256]`), jedna linia.
- **Zakładka „Własne napisy”** w ramce: slot 00–99 („01: wolne” albo treść), pole tekstu
  i „Zapisz”/„Nadpisz” (Enter też), lista zapisanych z „Pokaż” (to `m##`), ołówkiem (slot i treść
  do edycji) i koszem (pyta drugi raz). Pusty tekst nie zapisuje się („Wpisz treść napisu.”).
  Klawiszy `m##` nie ma: Escape w panelu zamyka panel.
- Na liście presetów panelu napisów nie ma: lista mówi, co jest na ekranie na stałe (mapa,
  preset), a napis to chwilowe zdarzenie nad obrazem, bez stanu „wybrany”.

**Czego nie ma** (nic z tego nie zmienia domyślnego obrazu):
- trybu 24-bitowego i 16-bitowego 5-5-5: to warianty kopii na ekran dla kart, które takie tryby
  miały (24 bity bez podwajania, czyli o połowę ciemniej); obraz w pamięci jest ten sam co przy
  32/16 bitach, a dzisiejszy pulpit ma 32 bity;
- klawiatury (presety `[##`/`]##` i napisy `m##` są w ramce „Presety i napisy”: Escape zamyka
  w panelu cały panel, a w Geissie przerywał komendę), tekstów pomocy i FPS oraz losowych
  powtórek tytułu (`g_random_songtitle_freq` domyślnie 0);
- wygładzania tytułów i napisów powyżej 8 bitów: GDI wygładzał je (`DEFAULT_QUALITY`) tylko
  przy włączonym w Windows wygładzaniu czcionek, więc wygląd zależał od systemu; port rysuje je
  jak przy 8 bitach, gdzie GDI nigdy nie wygładza;
- liter dokładnie jak GDI: hinting Ariala w GDI i rasteryzacja przeglądarki się różnią (0,92
  wspólnych pikseli; szerokości i miejsca są dokładne), a SYSTEM_FONT (obraz 320 pikseli) to
  bitmapa Windows, której przeglądarka nie rysuje — zastępuje ją Arial Bold 13 px.

## Wizualizacja VoltViz

**VoltViz** to wtyczka z presetami, w której każdy preset jest jedną z własnych wizualizacji
projektu [voltviz](https://github.com/sanderdw/voltviz) 0.35.1 (MIT, VoltViz Contributors; three.js,
Canvas 2D i WebGPU). Kod voltviz leży w `src/shared/visualizations/voltviz/` (licencja w
`LICENSE-voltviz.txt`, nagłówek w każdym pliku) możliwie blisko oryginału, a zmiany forka są
opisane słowem „Fork:”. Nasze są adapter (`voltviz/index.ts`, `catalog.ts`, `halftone.ts`,
`logo.ts`, `outline.ts`, `overlays.ts`, `stage.css`), WebGL 2 dla wizualizacji pisanych w WebGPU
(`visualizers/lib/webgl2.ts` i przetłumaczone shadery w `visualizers/impl/gl/`) oraz rejestracja
(`voltviz-plugin.ts`).

- **Lista i Auto:** 49 wizualizacji pod nazwami z voltviz (i Your Logo raz na każde logo
  właściciela, a Halftone Pulse ze swoimi 51 wyborami, niżej), alfabetycznie. Auto rozdaje je jak
  przetasowaną talię co 30 s: nowa rysuje się 0,3 s niewidocznie (shadery), potem przez 0,5 s
  przenika się z poprzednią. Wybór zapamiętuje `media-visualizer-preset:voltviz`, a ulubione
  i „Auto — tylko ulubione” działają jak w MilkDropie. Wizualizacja, która rzuci wyjątek, wypada
  z listy na stałe (`media-visualizer-failed-voltviz`). Taka, której nie dało się pobrać ani
  uruchomić w 15 s (albo zabrakło kontekstu WebGL), wypada tylko do końca wizyty.
- **WebGPU i WebGL 2:** Pulsar, Oscilloscope, Daybreak i Blob Tracker są w voltviz napisane
  wprost w WebGPU i WGSL. Gdzie przeglądarka daje adapter WebGPU (strona HTTPS albo localhost),
  rysują w WebGPU i nazywają się „… (WebGPU)”; gdzie nie (Firefox, starszy Safari, zwykłe HTTP
  w LAN), rysują w WebGL 2 jako „… (WebGL)”. Lista ma więc zawsze 49 wizualizacji (do 10.11.2026
  bez WebGPU 44, przed Icons 48); sprawdzone z `navigator.gpu` usuniętym ze strony.
  - `visualizers/lib/webgl2.ts` odtwarza tę część API WebGPU, której te cztery używają: bufory
    (uniform, storage czytany jako atrybuty instancji, odczyt przez `mapAsync`), tekstury
    z widokami poziomów mipmap, samplery, grupy wiązań, przebiegi renderowania z mieszaniem,
    `writeTexture` i `copyExternalImageToTexture`. Przebieg obliczeniowy Blob Trackera (siatka
    jasności dla śledzenia plam) to przebieg fragmentów do celu R32UI, odczytywany asynchronicznie
    przez bufor pikseli i fence, jak `mapAsync`. Kod wizualizacji zostaje ten sam: zmiana „Fork:”
    to tylko wybór GPU na początku fabryki, a adapter podaje go w `gpuBackend`.
  - Shadery są przetłumaczone z WGSL na GLSL ES 3.00 w `visualizers/impl/gl/<Nazwa>.ts`,
    deklaracja po deklaracji i funkcja po funkcji, z komentarzami; moduł GLSL znajduje się po
    etykiecie modułu WGSL. Wiersze leżą w pamięci jak w WebGPU (każdy shader wierzchołków odwraca
    y, na płótno idzie odwrócony blit), więc `@builtin(position)` to `gl_FragCoord`, a odczyty
    `textureLoad` trafiają w te same piksele.
  - Światło jest w celach 16-bitowych zmiennoprzecinkowych jak w WebGPU, co wymaga
    `EXT_color_buffer_float` (albo `_half_float`); bez niego albo bez WebGL 2 wizualizacja wypada
    do końca wizyty. Moduły GLSL i `webgl2.ts` pobiera tylko przeglądarka bez WebGPU.
  - **Która ścieżka:** WebGPU tam, gdzie jest, bo WebGL nie daje tych samych pikseli. Porównanie
    10.11.2026 w Chrome: dwie instancje obok siebie, 640×360, ten sam dźwięk (Sandstorm od 60 s),
    ta sama klatka `AudioFrame`, zegar i liczby losowe. Oscilloscope i Blob Tracker (razem
    z prostokątami śledzenia z odczytu GPU) wychodzą identycznie z dokładnością do 1 poziomu na
    kanał, Daybreak w scenie mgławicy też. Różnią się tylko miejsca losowane skrótem
    `fract(sin(x)·43758…)`: gwiazdy i ziarno Pulsara, kąty promieni Daybreaka. `sin` dużego
    argumentu każdy backend liczy inaczej (WebGPU na D3D12 i WebGL na D3D11 przez ANGLE różnią
    się już na czwartym miejscu po przecinku), a skrót mnoży tę różnicę dziesiątki tysięcy razy.
    Wygląd i ruch są te same, piksele nie. Arkusze porównań (WebGPU | WebGL | różnica ×8) leżą
    poza repozytorium.
- **Your Logo:** voltviz rysuje wgrany plik SVG: kontury jego kształtów jako świecące neonowe
  linie, zamknięte z kopiami odsuwanymi w głąb na beat, cząstki z wysokich tonów, obrót 3D. Panel
  nie ma uploadu, więc logo bierze się z ignorowanego `vendor/voltviz-logos/` (logotypy
  właściciela, nigdy w repozytorium; ich pliki trafiają tylko do builda jako zasoby). Plugin
  `scripts/voltviz-logos.mjs` daje `virtual:voltviz-logos`: plik po pliku z `?url&no-inline`
  (`connect-src` strony nie czyta `data:`), a panel ma jeden preset na logo, „Twoje logo: <nazwa
  z pliku>” (id `yourlogo-<nazwa>`). Auto traktuje je jak jedną kartę talii i losuje jedno z nich.
  Bez katalogu (albo bez obrazów w nim) Your Logo nie ma na liście.
  - SVG idzie do czytnika voltviz (`loadSvg`) bez zmian.
  - PNG, WebP, JPEG i GIF są obrysowywane w przeglądarce (`voltviz/logo.ts`, czysta funkcja,
    testy w `voltviz-logo.test.ts`). Pokrycie piksela logo to na przezroczystym tle krycie (kontur
    w połowie krawędzi, a gdy dużą część obrazu zajmuje półprzezroczysta poświata, jak w logo
    z 2013 r., na 85% najwyższego krycia, żeby poświata została poza konturem), a na kryjącym tle
    odległość koloru od mediany brzegu. Potem lekkie rozmycie, izolinie metodą marching squares,
    wygładzenie i próbkowanie jak `getPointAtLength` w voltviz (300–3000 punktów według długości
    w pikselach obrazu, ostatni na pierwszym) oraz normalizacja jak w `loadSvg`. Kontury idą od
    lewej, więc neonowe kolory (co drugi kontur) zmieniają się jak litery. Wtyczka dostaje gotowe
    ścieżki (`loadPaths`, zmiana „Fork:”); obrys logo 512 px to ok. 40 ms, raz na stronę.
  - To samo logo jako SVG (przez `loadSvg`) i jako jego PNG (przez obrys) wygląda i rusza się tak
    samo: te same kształty, skala i obrót; różni się tylko przydział kolorów i kopii, bo kolejność
    ścieżek w dokumencie SVG jest inna niż od lewej.
- **Icons:** 40 ikon lucide w kolejności voltviz (Heart … Fish), neonowe kontury z obrotem 3D,
  kopie zamkniętych kształtów odsuwane w głąb, cząstki z wysokich tonów; nowa ikona na mocnym
  beacie, nie częściej niż co 4 s. Kod rysowania jest kodem voltviz bez zmian. voltviz robi ikony
  w React (`react-dom/server` + lucide-react 1.59.0) i próbkuje każdy element 301 razy przez
  `getPointAtLength`; port bierze je inaczej (zmiany „Fork:” w `impl/Icons.ts`):
  - Dane ikon są z pakietu `lucide` 1.59.0, tej samej wersji co lucide-react w lockfile voltviz
    0.35.1 (ISC; osiem ikon pochodzi z Feather, MIT; `NOTICE-voltviz.txt`). To te same elementy
    i atrybuty: zapisane tak jak zapisuje je React dają bajt w bajt ten sam SVG dla wszystkich 40.
  - `getPointAtLength` w Chrome 157 mierzy ścieżkę od nowa przy każdym wywołaniu (ok. 0,2 ms na
    krzywą). Montowanie Icons w voltviz to 2031 ms zablokowanej strony. `voltviz/outline.ts` liczy
    te same odpowiedzi bez DOM, raz na element, w 32-bitowych floatach (`Math.fround`):
    - `<path>` jak Blink: parser liczb, normalizacja (łuki na krzywe sześcienne do 90°, kwadratowe
      na sześcienne) i pomiar `SVGPathQuery` (krzywa dzielona na pół, aż wielokąt kontrolny różni
      się od cięciwy o najwyżej 1e-8 skali krzywej, najwyżej 20 razy; punkt cofnięty od końca
      kawałka wzdłuż niego);
    - `<circle>` i `<line>` jak Skia: koło to cztery stożkowe od prawego punktu, zgodnie
      z ruchem wskazówek (`addOval`), mierzone przez `SkContourMeasure` z tolerancją 0,5 jednostki
      (koło o promieniu 2 ma więc w Chrome obwód 8√2, nie 4π — port też).
  - Zgodność z Chrome 157 dla 42 742 punktów 142 elementów: 133 długości i 94,4% punktów
    identyczne co do bitu; reszta różni się najwyżej o 1,7e-5 jednostki ikony (ostatnie bity
    `sinf`/`cosf`/`tanf`/`atan2f` w łukach). Po normalizacji to 1,6e-6, czyli 0,0007 px przy
    1080p. Te same podścieżki (149) i te same zamknięte (53). Klatki voltviz i portu przy tym
    samym dźwięku, zegarze i liczbach losowych są identyczne co do piksela (6 klatek 800×450,
    1–21 s, `scratch/renders/voltviz/icons-upstream-vs-port.png`).
  - Ikona jest liczona przy pierwszym pokazaniu i zostaje do końca wizyty (voltviz liczy
    wszystkie 40 przy każdym montowaniu). Chrome 157: montowanie 10,9 ms, zmiana ikony najwyżej
    5,1 ms, wszystkie 40 od nowa 20,8 ms.
  - **Nakładka** jak w voltviz: komponent Reacta `Overlay` z `Icons.tsx` jako zwykły DOM
    (`voltviz/overlays.ts`, `iconsOverlay`), w warstwie wizualizacji, przez to samo api
    (`shuffle`, `getIconName`, `subscribe`). Na starcie zwinięta do przycisku z okiem; otwarta
    pokazuje nazwę ikony i „Losuj” (Shuffle: inna ikona niż ta na ekranie). Te same znaczniki,
    klasy Tailwinda (ich reguły w `stage.css`, wartości i kolejność z Tailwinda 4.3.3, którego
    używa voltviz), ikony lucide i czcionka skórki „modern”. W voltviz nakładkę chowa „Hide UI”
    aplikacji; tu ma klasę `.visualizer-panel__overlay` i chowa się razem z paskiem panelu
    (`panels.css`), na komputerze i na dotyku, a dwuklik na niej nie przełącza presetu. Teksty
    przez `t()`: po polsku „Losuj”, „Pokaż/Ukryj przyciski” i nazwy 40 ikon („Słuchawki”…), po
    angielsku słowa voltviz.
  - **Porównanie z voltviz** 10.11.2026 w Chrome: komponent `Overlay` voltviz 0.35.1 w React
    z CSS skompilowanym przez Tailwind 4.3.3 z jego nazw klas, obok portu w stylach aplikacji, na
    tej samej klatce i w tym samym rozmiarze, po angielsku: zwinięta, otwarta, po „Shuffle”.
    Położenie, rozmiary, kolory, obwódki i ikony są te same; różnią się tylko piksele brzegów
    liter (wygładzanie tekstu), 0,7–0,8% obszaru
    (`scratch/renders/vis-extras/icons-overlay-upstream-vs-port.png`).
  - Testy: `voltviz-icons.test.ts` (długości i punkty Chrome dla kół, linii i ścieżek, parser,
    pula 40 ikon, podścieżki i zamknięte kształty jak w Chrome).
- **Halftone Pulse — wybory i styl:** w voltviz nakładka Reacta (Style) ma Mode (Auto i 23
  tryby), Shape (Auto i 27 kształtów) oraz Colors (Source albo Neon), ustawiane razem. Panel ma
  jedno i drugie:
  - **51 presetów** tuż pod „Halftone Pulse” (`voltviz/halftone.ts`), dla ulubionych i Auto:
    „Halftone Pulse — neon”, grupa „Halftone Pulse — tryby” (tryb stały, kształty zmienia Auto co
    8 taktów) i „Halftone Pulse — kształty” (kształt stały, tryby zmienia Auto). Auto talii
    rozdaje samo „Halftone Pulse”, wybory tylko z „Auto — tylko ulubione”, gdy są wśród
    ulubionych. › przechodzi przez wybory tylko wtedy, gdy już stoi na którymś.
  - **nakładka voltviz** (`overlays.ts`, `halftoneOverlay`) nad każdym z nich: oko, „Styl”, a w
    nim Mode, Shape i Colors — dowolne połączenie, ustawiane od razu (`setMode`, `setShape`,
    `setNeon`, jak efekty Reacta w voltviz). Znaczniki, klasy i wygląd jak w voltviz; w
    porównaniu (jak przy Icons) karta stylu, listy, strzałki i przycisk kolorów wychodzą
    identyczne co do piksela (`halftone-overlay-upstream-vs-port.png`). W voltviz włączony neon
    nie zmienia wyglądu przycisku, tylko napis: jego klasy fuksji stoją w CSS Tailwinda przed
    białymi i przegrywają z nimi. Port powtarza to, bo tak to wygląda w voltviz.
    Obok „Styl” stoi „Upload Image” (po polsku „Wybierz obraz”) — niżej.
  - **Twój styl:** zmiana w nakładce staje się wyglądem samego „Halftone Pulse”, zapamiętanym
    w przeglądarce (`media-visualizer-voltviz-halftone`: tryb, kształt, neon; domyślnie Auto,
    Auto, kolory źródła, czyli dotychczasowe „Halftone Pulse”). „Halftone Pulse” otwiera się
    w nim przy następnym pokazaniu, także z Auto. Zmiana zrobiona na którymś z 51 presetów nie
    jest już tym presetem: to, co na ekranie, staje się „Halftone Pulse” w tym stylu, bez nowego
    startu (lista, przypięcie i gwiazdka idą za tym). Same presety się nie zmieniają, więc
    ulubione i Auto działają jak dotąd.
  - **Własny obraz („Upload Image”)**: jak w voltviz etykieta z ikoną `image-plus` i ukrytym
    `<input type="file" accept="image/*">`, „Zmień obraz” („Change Image”), gdy obraz jest
    wybrany; obraz staje się źródłem półtonu zamiast okładki (`setImage` w `HalftonePulse.ts`,
    pierwszeństwo jak w voltviz: obraz > okładka > scena generowana).
    - Plik zostaje w przeglądarce: adapter robi z niego `URL.createObjectURL` (voltviz czytał go
      `FileReader` jako `data:`), a wizualizacja zmniejsza go na płótnie do 256 pikseli. Nic nie
      idzie na serwer ani do `localStorage`.
    - Jak długo: w voltviz obraz żył razem z nakładką (do zmiany wizualizacji). Tu zostaje, dopóki
      strona jest otwarta — Auto rozdające inne wizualizacje, inny preset Halftone Pulse,
      zamknięcie i otwarcie panelu go nie gubią (każdy Halftone Pulse dostaje go przed pierwszą
      klatką); przeładowanie strony wraca do okładki. Zapisywanie obrazu w przeglądarce na stałe
      byłoby przechowywaniem prywatnego pliku bez potrzeby.
    - Dodane wobec voltviz: okrągły przycisk z ikoną `image-off` obok etykiety, „Wróć do okładki”
      (voltviz drogi powrotu nie miał), widoczny tylko przy wybranym obrazie; etykieta przyjmuje
      fokus i Enter/Spację (w voltviz z klawiatury nie dało się jej użyć); plik, którego
      przeglądarka nie umie narysować, nic nie zmienia, a etykieta przez 3 s mówi „Tego pliku nie
      da się wyświetlić”.
    - Porównanie z voltviz 0.35.1 (React + Tailwind 4.3.3, jak przy Styl): stan z „Upload Image”
      i z „Change Image” — znaczniki, klasy i położenie te same, różni się tylko wygładzanie
      tekstu; po wyborze obrazu port ma dodatkowy przycisk powrotu
      (`scratch/renders/extras3/voltviz-upload-upstream-vs-port.png`). W panelu (komputer
      i telefon): obraz jako półton, zły plik, inny preset i z powrotem, powrót do okładki
      (`voltviz-upload-panel.png`).

  Dlaczego tak: tryb × kształt × kolory (z Auto) to 1 344 połączenia, za dużo na presety. Jedno
  zapamiętane połączenie na „Halftone Pulse” daje każdy wygląd przy nakładce wiernej voltviz
  i nie zmienia znaczenia 51 presetów ani ulubionych.
  - Adapter ustawia wygląd przed pierwszą klatką. Zmiana „Fork:” w `HalftonePulse.ts` sprawia, że
    to wygląd otwarcia, bez 0,6-sekundowego przejścia z domyślnego wyglądu (półton, koła), które
    w voltviz daje wybór z nakładki w trakcie. Od 1,5 s klatki są identyczne z voltviz co do
    piksela (4 wybory × 5 klatek, z okładką i bez); różni się tylko pierwsze 0,6 s.
  - Nazwy trybów i kształtów są po polsku przez `t()` (po angielsku to nazwy voltviz).
    `voltviz-halftone.test.ts` porównuje identyfikatory i nazwy z `HalftonePulse.ts`, sprawdza
    odczyt zapamiętanego stylu i nazwy ikon nakładki Icons.
  - Sprawdzone w Chrome (komputer i telefon 390×844 z dotykiem): preset „tryb: Próg” + w Stylu
    kształt Gwiazda i neon → na ekranie i w liście „Halftone Pulse”, styl zapisany; po ponownym
    otwarciu „Halftone Pulse” rysuje Próg, gwiazdy i neon, a nakładka pokazuje te wybory.
- **Pominięte:** MilkDrop i MilkDrop Warp, bo odtwarzacz ma własny MilkDrop. Moss Ball i Flame
  mają shadery na licencjach CC BY-NC 4.0 i CC BY-NC-SA 3.0 (nie MIT), więc nie ma ich
  w repozytorium (są w `vendor/voltviz-extra/`, niżej). Nakładki Reacta są obie, w całości
  (od 11.11.2026 także „Upload Image” Halftone Pulse).
- **Okładka i tytuł:** wizualizacje, które w voltviz czytają metadane Sendspina (Vinyl,
  Background Image, Glitch Background, Halftone Pulse, Particles Stream, Blob Tracker, Blur Image),
  dostają tytuł i wykonawcę z `navigator.mediaSession`, a okładkę z obrazka w docku odtwarzacza.
  Bez okładki pokazują zastępczą okładkę voltviz albo scenę generowaną.
- **Warstwy:** scena (`.voltviz-stage`) ma `isolation: isolate`, więc `z-index` wizualizacji
  (Vinyl, Background Image, Dutch Grid, Dutch Grid WebGL) zostaje w scenie, a pasek panelu ma
  własny `z-index` (`styles/player.css`). Wcześniej płótno Vinyla przykrywało menu i przycisk
  zamykania (08.11.2026).
- **Dźwięk:** silnik audio voltviz (`voltviz/audio/`) podpina się pod `AnalyserNode` odtwarzacza
  (`analyser.connect(…)`) i nie zmienia tego, co słychać. Analiza (onsety stopy, werbla
  i hi-hatu, tempo, siatka beatów, czyli całe `AudioFrame`) działa w AudioWorklecie. Build wydaje
  go jako osobny plik z tego samego originu (`assets/analysis.worklet-*.js`), więc wystarcza CSP
  `script-src 'self'`; bez AudioWorkletu (zwykłe HTTP w LAN) analiza idzie przez ScriptProcessor.
  Widmo, przebieg i pasma dają analizatory voltviz o rozmiarach FFT, na których strojono każdą
  wizualizację. Kontekst szybszy niż 48 kHz (karta 96/192 kHz) jest czytany jak 44,1/48 kHz
  (`audio/host/rate.ts`). AI beat trackingu (onnxruntime-web) nie ma. Zmiana utworu restartuje
  szukanie beatu, po kilku sekundach bez klatek (panel zamknięty, karta w tle) analiza stoi,
  a `destroy()` odłącza tylko własne węzły. Lista identyfikatorów wtyczek w
  `integrations/php/CatalogActions.php` zna `voltviz`, więc na istniejących instalacjach
  wtyczka przychodzi włączona.
- **Moss Ball i Flame z `vendor/voltviz-extra/`** (gitignore), dla właściciela, który chce je
  mieć na swojej stronie:
  - wystarczą oryginalne `MossBall.ts` i `Flame.ts` z voltviz 0.35.1, bez zmian;
  - `scripts/voltviz-extra.mjs` dokłada je do listy (`virtual:voltviz-extra`) jako
    „Moss Ball (ledhieu)” i „Flame (kuvkar)”, bo licencje wymagają uznania autorstwa;
  - ich względne importy rozwiązuje tak, jakby leżały w `voltviz/visualizers/impl/`;
  - bez katalogu build jest jak bez nich. Szczegóły licencji w `NOTICE.md`.
- **Rozmiar:** adapter z analizą ~75 KB, three.js ~580 KB, a każda wizualizacja to osobny
  fragment 1–35 KB. Icons to 22,8 KB (9,1 KB gzip) razem z danymi 40 ikon i `outline.ts`;
  z Reactem, react-dom/server i lucide-react, jak w voltviz, byłoby to 235 KB. Listy wyborów
  Halftone Pulse są w adapterze (ok. 4 KB). Shadery GLSL czterech wizualizacji WebGPU to 10–20 KB na wizualizację plus
  `webgl2.ts` 15 KB, pobierane tylko bez WebGPU. Wszystko jest pobierane dopiero przy pierwszym
  otwarciu VoltViz.
  Rozdzielczość to panel × `devicePixelRatio` (do 2, najwyżej 1440p).

## Wizualizacja „Formy dźwięku”

**Formy dźwięku** (ang. Sound Forms, id `soundforms`; `soundforms-plugin.ts`, kod w
`src/shared/visualizations/soundforms/`) to własne wizualizacje 3D w czystym WebGL 2, bez three.js
i bez zależności: 36 presetów jednej wtyczki w siedmiu grupach. Odtwarzają wygląd typów
i wariantów vizz.fm, które wskazał właściciel. vizz.fm jest zamknięty, więc kod, shadery i liczby
są nasze: oglądaliśmy tylko obraz aplikacji, niczego z niej nie pobieraliśmy ani nie kopiowaliśmy.
Pole `answers` w `catalog.ts` mówi, któremu wariantowi odpowiada preset.

- **Grupy** (vizz.fm → my):
  - Kule z kolców — Textured Sphere 1–11: kula pchana szumem i muzyką (każda łata słucha swojego
    pasma) jako druty z ukrytą tylną stroną, kropki albo trójkąty, z dziurami, nad wodą, od środka;
  - Fale z linii — Wavy Form 1–13: linie, każda to chwila muzyki (widmo albo przebieg), wygięte
    w pole do horyzontu, tunel, nić, wstęgę, korytarz, wir, skrzydło, sprężynę, dysk, koronę…;
  - Widmo w przestrzeni — Classic Spectrum 6, 7, 10, 11, 12: plastry widma, pierścienie, tuba
    i miasto słupków z bloków jak na wskaźniku LED;
  - Siatki punktów — Mesh Grid 5, 6, 9: pole z bokeh (głębia ostrości per punkt), spirala, kwiat;
  - Roje cząstek — Particle Dance 3 i 4; Kropki — Dot Grid 3; Pierścienie — Equalizer Rings 4.
  - „Dot Girl 3” z listy właściciela to w vizz.fm „Dot Grid 3” (typu Dot Girl tam nie ma), więc
    nie był potrzebny żaden model postaci.
- **Auto, ulubione, „zostaw”, „następny”, `persist: false`, `autoFilter`** działają jak w Internal:
  talia co 30 s, nowy preset rysuje klatkę niewidocznie (kompilacja shaderów) i przenika się przez
  1,2 s. Wybór: `media-visualizer-preset:soundforms`. Preset, którego shadery nie skompilują się na
  danym GPU, wypada z listy do końca wizyty.
- **Obraz:** jeden canvas i jeden kontekst WebGL 2. Scena rysuje poza ekranem (half float, gdy GPU
  pozwala), a `pipeline.ts` ją wykańcza: poświata albo miękka ostrość, rybie oko i rozszczepienie
  barw, rozmycie promieniste, lustro, smugi, winieta. Programy kompilują się raz na wizytę.
  Rozdzielczość to panel × `devicePixelRatio` (do 2, najwyżej ~2,4 Mpx); linie i kropki skalują się
  z obrazem, a telefon w pionie widzi scenę szerzej. Utrata kontekstu jest obsłużona, a `destroy()`
  zwalnia wszystkie obiekty GPU i odłącza analizator.
- **Dźwięk:** własny `AnalyserNode` za analizatorem odtwarzacza (2048 próbek przy 44,1/48 kHz,
  przy 96/192 kHz `rateFactor`/`scaledFftSize`/`decimate`), 128 pasm 32 Hz–16 kHz w skali
  logarytmicznej, przebieg od zbocza, bas/środek/góra, beat i powolne wzmocnienie cichej muzyki
  (do 2,6×; cisza zostaje ciszą). Historia muzyki (60 wierszy na sekundę) jest teksturą czytaną
  przez shadery. W ciszy obraz się uspokaja: płaskie linie, wygaszone widmo i pierścienie, wolny
  dryf.
- **CSP i rozmiar:** bez `eval`, `new Function`, stylów i pobierania czegokolwiek, więc wystarcza
  `script-src 'self'`. Osobny fragment ~71 KB (~23 KB gzip), pobierany przy pierwszym otwarciu;
  przy 1920×1080 klatka zajmuje GPU ok. 1,5–2 ms (pomiar 08.11.2026). Test: `soundforms.test.ts`.

## Wizualizacja „Shadery” (Monkey Hi Hat i music_visualizer)

**Shadery** (ang. Shaders, id `shaders`; `shaders-plugin.ts`, runner w
`src/shared/visualizations/shaders/`, konwerter w `scripts/shader-visualizers.mjs`, `shader-glsl.mjs`
i `shader-glsl-types.mjs`) to wtyczka z presetami, która gra shadery dwóch programów:

- [Monkey Hi Hat](https://github.com/MV10/monkey-hi-hat) Jona McGuire'a, z jego repozytorium treści
  [Volt's Laboratory](https://github.com/MV10/volts-laboratory): 115 wizualizacji (81 reaguje na
  muzykę, 7 w stylu VertexShaderArt, 19 wieloprzebiegowych), 41 efektów i 20 przejść;
- [music_visualizer](https://github.com/bradleybauer/music_visualizer) Bradleya Bauera: 14 małych
  shaderów (oscyloskopy, Lissajous, widma, spektrogram).

Treść nie jest nasza i nie może trafić do repozytorium: Volt's Laboratory nie ma licencji, a jego
shadery to w większości adaptacje z Shadertoy (domyślnie CC BY-NC-SA 3.0); music_visualizer jest na
GPL-3. Leży więc, jak paczki MilkDropa i AVS, w `frontend/vendor/shader-visualizers/` (gitignore),
tylko na serwerze właściciela:

```
vendor/shader-visualizers/volts-laboratory/   shaders/ fx/ crossfades/ libraries/ textures/
vendor/shader-visualizers/music_visualizer/   src/shaders/
```

To foldery repozytoriów bez zmian (`SOURCE.txt` mówi, z którego commita, pobrane 08.11.2026): pliki
tekstowe shaderów i z `textures/` tylko 57 obrazów i filmów, które wymieniają pliki `.conf`. Bez nich `virtual:shader-visualizers` jest `null` i wtyczki nie ma w panelu.

- **Konwersja przy buildzie** (~0,5 s): GLSL 450/330 → GLSL ES 3.00. Nagłówek `#version 300 es`
  z precyzją; wartości początkowe uniformów (`uniform float x = 1;`) idą do pliku presetu, a runner
  je ustawia; zmienne globalne z niestałym inicjalizatorem są przypisywane na początku `main`;
  `const` z niestałą wartością traci `const`; liczby całkowite tam, gdzie desktopowy GLSL sam
  zamienia je na float (`float x = 1;`, `x * 2`, `pow(x, 2)`, `vec2 / textureSize(…)` przez makro,
  `return 0;`) — po preprocesorze i wyznaczeniu typu każdego wyrażenia — dostają `1.0` albo
  `float(…)`. Nazwy z `__` (zastrzeżone w ES) dostają `_u2_`. Biblioteki z `[libraries]` są
  doklejane na końcu, po `#undef` makr pliku. Wynik: indeks i plik JSON na preset w
  `assets/shaders/` (~1,6 MB) i obrazy z filmami w `assets/shaders/textures/` (57 plików, ~25 MB),
  zapisane obok bundla i pobierane dopiero przy otwarciu
  wtyczki i gdy preset ma zagrać. Czego nie da się przekonwertować, ląduje w
  `node_modules/.cache/shader-visualizers/failed.txt`; build się nie zatrzymuje.
- **Runner (nasz, MIT):** jeden kontekst WebGL 2. Przebiegi `[multipass]` z buforami (wejście
  liczbowe to bufor z tej klatki, literowe — z poprzedniej, jak w Monkey Hi Hat), VertexQuad
  i VertexIntegerArray (`vertexId`, `vertexCount`, tryby rysowania), uniformy Monkey Hi Hat
  (`resolution`, `time` z `RandomTimeOffset`, `frame`, `randomrun(4)`, `randomseed`,
  `randomnumber`, `date`, `clocktime`, `fxactive`, `silent`, `[uniforms]` z zakresami losowanymi
  na start, `[fx-uniforms:…]`), `RenderResolutionLimit` i `FXResolutionLimit`. Shadery geometrii
  music_visualizera (8 z 14: Default, Blocky FFT, Blocky Osc, Dual Oscilloscope, FFT, FFT And Wave,
  Lissajous, Oscilloscope) WebGL 2 nie ma, więc konwerter robi z nich instancjonowany vertex
  shader: instancja to jedno wywołanie, wierzchołek k liczy shader od nowa i bierze róg k % 3
  trójkąta k / 3 (paski są cięte na trójkąty); liczbę trójkątów odczytuje z tekstu shadera.
  Programy kompilują się w tle (`KHR_parallel_shader_compile`), więc następny preset nie zacina
  obrazu.
- **Dźwięk:** tekstury eyecandy (biblioteki audio Monkey Hi Hat) liczone z analizatora odtwarzacza:
  `eyecandyShadertoy` 1024×2 (widmo do 11 kHz wygładzone jak w WebAudio i przebieg, dane w kanale
  zielonym), `eyecandyWebAudio` i `eyecandyFreqDB` 1024×128 z historią (43 wiersze na sekundę),
  w skali eyecandy (dB 16-bitowych próbek: +96,3 dB względem dBFS, potem /60 albo /90).
  music_visualizer dostaje falę i widmo kanału lewego i prawego (2048 wartości, R16F): ten sam
  format danych, ale stabilizacja przebiegu jest nasza (odcinek najbardziej podobny do poprzedniej
  klatki w obrębie okresu najsilniejszego niskiego tonu). Karta 96/192 kHz jest czytana jak
  44,1/48 kHz (`audio-rate.ts`).
- **Lista i paczki:** grupy „Monkey Hi Hat — reagują na muzykę”, „Monkey Hi Hat — VertexShaderArt”,
  „Monkey Hi Hat — efekty na losowej wizualizacji”, „Monkey Hi Hat — bez reakcji na muzykę”
  i „music_visualizer (Bradley Bauer)”. Nazwa to nazwa pliku, w nawiasie autorzy z `Byline`
  (np. „Acrylic (Renard_VRC, Elsio)”); pełne podpisy zostają w plikach. Wybór źródła (Wszystkie
  źródła / Monkey Hi Hat / music_visualizer) to paczka presetów panelu
  (`media-visualizer-pack:shaders`).
- **Efekty:** preset efektu rysuje efekt nad losową wizualizacją, która reaguje na muzykę i nie
  wyklucza go w `[fx-blacklist]`, z jej `[fx-uniforms:…]`; efekt wchodzi przez 2 s jak w Monkey Hi
  Hat. Grają wszystkie 41: ghostly nakłada na obraz czarno-biały film (jeden z pięciu klipów),
  a starship wstawia wizualizację w okna i ekrany jednego z sześciu kokpitów (obraz statku i jego
  maski losowane razem, jak `RandomTextureSync`). Bez tych plików oba wypadają z listy.
- **Auto, ulubione, „zostaw”, ‹/›, `persist: false`, `autoFilter`** — jak w innych wtyczkach.
  Auto rozdaje talię co 30 s (60 s dla `SwitchTimeHint=Double`) spośród presetów reagujących na
  muzykę albo z ulubionych; następny kompiluje się w tle i wchodzi jednym z 20 przejść Volt's
  Laboratory przez 2 s (bez nich zwykłym przenikaniem). Wybór: `media-visualizer-preset:shaders`.
  Preset, którego przeglądarka nie skompiluje, wypada na stałe (`media-visualizer-failed-shaders`,
  po adresie pliku — po zmianie w buildzie wraca); niepobrany albo niegotowy w 20 s — do końca
  wizyty. Czarny obraz przy grającej muzyce przez 6 s: Auto idzie dalej.
- **Obraz:** canvas = panel × `devicePixelRatio` (do 2, najwyżej 1440p), każdy shader w swoim
  limicie rozdzielczości, mniejszy (do 35%), gdy klatki przychodzą za wolno; najwyżej 60 klatek na
  sekundę (efekty ze sprzężeniem liczą na klatki). Utrata kontekstu jest obsłużona; `destroy()`
  zwalnia programy, bufory, tekstury, węzły audio i sam kontekst.
- **Tekstury i filmy** z `volts-laboratory/textures/`: zdjęcia i szumy Shadertoy, cubemapy (krzyż
  4×3 krojony na ściany jak w Monkey Hi Hat), obrazy statku i filmy. Film gra w pętli bez dźwięku,
  nowa klatka trafia do tekstury, gdy film się przesunie, shader dostaje `<nazwa>_duration`,
  `_progress` i `_resolution`, a `destroy()` zatrzymuje film i zwalnia teksturę. Bez tych plików szumy
  są generowane (RGBA z przesunięciem 37/17, którego wymaga szum 3D iq, szary, „niebieski”, Bayer
  8×8), zdjęcia zastępuje kolorowy szum (gwiazdy dla „Stars”), cubemapy — niebo, a ghostly
  i starship wypadają z listy.
- **CSP i rozmiar:** bez `eval` i `new Function`; fragment ~37 KB (13 KB gzip).
- **Testy:** `scripts/shader-visualizers.test.mjs` (na wymyślonych fragmentach, bez treści).
  Sprawdzone 08.11.2026 w Chrome (ANGLE) na prawdziwej muzyce,
  każdy preset dwa razy z tym samym ziarnem i zegarem — w ciszy i z muzyką: wszystkie 170 z listy
  kompilują się i rysują; obraz z muzyką różni się od ciszy we wszystkich 14 music_visualizera,
  70 z 73 wizualizacji Monkey Hi Hat czytających dźwięk, 6 z 6 VertexShaderArt z dźwiękiem i 40 z 41
  efektów (Skinimax nad ciemną bazą wychodzi prawie czarny). Wyjątki to treść, nie runner:
  Paint Bomb dorysowuje falę tylko przy `randomrun < 0.5`, a Stained Glass i The Machine liczą
  dźwięk, ale wyniku nie używają. 35 bez dźwięku daje w obu przebiegach ten sam obraz. Przy
  192 kHz widmo i przebieg wyglądają jak przy 48 kHz; przy `devicePixelRatio` 2 obraz wypełnia
  canvas (np. 360×640 dla panelu 180×320).

## Wizualizacja AVS (Winamp)

Silnik to fork **webvs** w `src/shared/visualizations/avs/webvs/` (MIT, licencja obok). Zmiany
forka są opisane w plikach słowem „Fork:”. Najważniejsze:

- **Bez `eval`:** kompilator skryptów webvs (`new Function`) zastąpiony przez `avs/eel.ts`,
  czyli parser eel-wasm i kompilację do domknięć JS. Dochodzą `getspec`, `megabuf`, `loop`,
  `while`, bloki w nawiasach, `assign(if(…), v)`. Kod per-piksel też liczy procesor.
  Od 10.11 te same drzewa składni idą też do WebAssembly (`avs/eel-wasm-backend.ts`, punkt niżej);
  domknięcia zostają jako droga zapasowa i wzorzec, z którym wasm zgadza się co do bitu.
- **Pola komponentów bez inicjalizatorów:** konstruktor bazowy `Component` woła `init()`,
  a inicjalizatory pól klasy (TypeScript z `useDefineForClassFields`) biegną dopiero po nim
  i nadpisują to, co `init()` ustawił. Pole ustawiane w `init()` jest więc tylko deklarowane.
  Do 09.11 kasowało to stan Texera v1, AVI, portów APE/SVP, Multi Delay i linii w Clear Screen
  (tryb mieszania z Set Render Mode): w przeglądarce nic nie rysowały, choć testy przechodziły.
  Pilnuje tego `webvs/componentFields.test.ts` (czyta źródła komponentów).
- **Kod presetów liczy się jak w AVS 2.81, nie jak w EEL2:**
  - `avs/eel-grouping.ts` przegrupowuje działania tak, jak robił to parser ns-eel AVS-a
    (sprawdzone na tablicach jego parsera ze źródeł 2.81d): `* / %` na jednym poziomie od lewej,
    `+ -` na jednym, `&` mocniej niż `|`, jednoargumentowy minus najmocniej. eel-wasm, jak EEL2,
    wiązał `%` mocniej niż `*`, więc `x=dirx*w%w/w*2-1` (Orifice) dawało zawsze -1. Co autor
    ujął w nawias, zostaje; nawiasy czyta się z tekstu, bo drzewo eel-wasm ich nie pamięta.
  - `avs/eel-math.ts`: `%` na wartościach bezwzględnych zaokrąglonych do najbliższej (`fistp`),
    reszta bez znaku, przez zero daje 0; `&` i `|` na 64-bitowych zaokrągleniach; prawda w `if`,
    `band`, `bor`, `bnot`, `&&`, `||` i `while` to |x| ≥ 0,00001. `sin`, `cos` i `tan` jak
    koprocesor x87 (`fsin`, `fcos`, `fsincos` w ns-eel 2.81, tak samo EEL2 na x86): argument od
    ±2^63 wzwyż jest poza zakresem rozkazu, więc `sin` i `cos` oddają go bez zmian, a `tan` daje
    NaN. Presety, w których wartości rosną bez końca (S_KuPeRS — Broken Mirror), w AVS wracają
    przez to do małych liczb, a nie dochodzą do nieskończoności (u nas czarny obraz do 09.11).
  - `gettime(-1)` i `gettime(-2)` zwracają pozycję i długość utworu z odtwarzacza (w AVS pytały
    Winampa). Na pauzie pozycja stoi, po czym poznaje ją np. Echolot. Bez utworu dają 0, jak AVS,
    któremu Winamp nie odpowiedział. Każda inna wartość s to jeden zegar minus s
    (`avs_eelif.cpp`: GetTickCount()/1000 − s; u nas sekundy od startu silnika, `eelGettime`
    w `eel-math.ts` z testem), więc `start = gettime(0)`, a potem `gettime(start)` to czas od
    startu. Do 09.11 `gettime(s)` dla s innego niż 0 liczyło od 1970 roku, więc odstępy klatek
    budowane z `gettime(0)` wychodziły ogromne: micro-d — octopus skin i oba blockfuckery były
    czarne, sound cruiser zaczynał za późno, blobby smith (rce-ordinary) rysował co innego.
    Zegar to całe milisekundy przez 1000, jak `GetTickCount()/1000` AVS-a: liczymy
    `(teraz − start) / 1000`. Do 11.11 było `teraz/1000 − start/1000`, co przy dzisiejszej epoce
    (1,7·10^9 s) myli się do 2,4·10^−7 s, a presety, które sumują czasy klatek
    (`speed = gettime(0)-t`), rozjeżdżały się z tym (effekthasch — femme fatale (ALIAS remix),
    Theory …).
  - Nazwy bez względu na wielkość liter, a zmienna liczy tylko pierwsze 8 znaków
    (`NSEEL_MAX_VARIABLE_NAMELEN 8` w ns-eel 2.81), więc `abcdefgh1` i `abcdefgh2` to jedna
    zmienna. Nazwy funkcji liczą się w całości. 24 presety piszą tę samą nazwę raz małymi, raz
    wielkimi literami (`X`/`x`, `SIN`/`sin`, `RAND`/`rand`): `SIN(…)` wypadało dotąd jako
    nieznana funkcja, a `X=…` pisało do innej zmiennej niż ta, którą czyta efekt.
  - `$PI`, `$E` i `$PHI` to tekst, który ns-eel wklejał: 3.141592653589793, 2.71828183
    i 1.61803399.
  - `rand(v)` z `v` poniżej 1 ustawia `v` na 1: ns-eel dawał funkcji adres zmiennej.
- **Kod presetów jako WebAssembly** (`avs/eel-wasm-backend.ts`, od 10.11.2026):
  - Każda instancja kodu (efekt z sekcjami init / per frame / on beat / per point) dostaje jeden
    moduł wasm, budowany w TypeScripcie bajt po bajcie z drzewa, które `eel.ts` zamienia
    w domknięcia. Bez nowej zależności i bez wykonywania tekstu źródłowego; CSP potrzebuje tylko
    `'wasm-unsafe-eval'`, które ma od MilkDropa. Średni moduł ma 2,2 KB.
  - Generator idzie po drzewie jak `compileNode`/`compileCall`: te same działania w tej samej
    kolejności (przy `/` najpierw dzielnik, dzielna tylko gdy nie jest 0; w `memset` liczba przed
    wartością; `band`, `bor` i `if` nie liczą tego, czego nie trzeba), te same granice (`loop` do
    2^20 obrotów, warunek `while` najwyżej 2^20 + 1 razy) i ta sama osłona przed NaN
    i nieskończonością przy każdym zapisie. + − × ÷, `sqrt`, `floor`, `ceil`, `min`, `max` dają
    w wasm te same liczby co w JS (także ±0 i NaN); `fistp` (połówki do parzystej) to
    `f64.nearest`; `%`, `&`, `|`, `~`, `<<`, `>>` idą na i32/i64 z regułami zakresu
    z `eel-math.ts`. `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `pow`, `exp`, `log`,
    `log10` to zaimportowane same funkcje `Math` (V8 woła je z wasm bez przejścia przez JS);
    zakres x87 (±2^63), `log` liczb ≤ 0 i osłona `sigmoid` są w module. `rand`, `gettime`,
    `getosc`, `getspec` i `gmegabuf` to importy tych samych funkcji JS, których używają domknięcia.
  - Pamięć: jedna `WebAssembly.Memory` na bank rejestrów, czyli na wczytany preset (`Main` robi
    nowy bank przy każdym `loadPreset`). Na początku `reg00…reg99` — właściwości banku stają się
    akcesorami do niej, więc instancje wasm, instancje na domknięciach i host APE widzą jedne
    rejestry — potem zmienne instancji i jej `megabuf` (8 MB, przy pierwszym użyciu, jak
    w `eel.ts`). Pamięć znika razem z presetem. `gmegabuf` zostaje tablicą `eel.ts`, wspólną
    z domknięciami i przeżywającą presety, jak w AVS.
  - Zmienne zostają właściwościami instancji dla efektów (`code.x`, `code.skip` …): akcesory do
    pamięci. SuperScope i Texer II w pętli punktów czytają i piszą je przez `EelPort` — sloty
    pamięci zamiast szukania po nazwie (instancje kodu są w V8 obiektami słownikowymi).
  - Kiedy: pierwsze uruchomienie sekcji (po `setup()`) odkłada instancję do kolejki; bajty modułu
    powstają między klatkami (porcje po 6 ms), kompilacja idzie w tle (`WebAssembly.compile`),
    a do tego czasu liczą domknięcia. Przy uruchomieniu po przyjściu modułu stan przechodzi do
    pamięci (zmienne z właściwości, `megabuf` z `eel.ts`) i dalej liczy wasm. Każda granica między
    uruchomieniami jest bezpieczna, bo obie drogi zostawiają na niej ten sam stan. Moduły o tych
    samych bajtach kompilują się raz (pamięć podręczna 256). Pierwsza klatka po wczytaniu presetu
    nie jest przez to wolniejsza (Raz — 10 Wireframe, 163 instancje: 152 ms przed, 162 ms po;
    Hboy — 01 Intro, 181: 119 i 112 ms); wszystkie instancje liczą w wasm po kilku klatkach.
  - Z powrotem do domknięć — dokładnie, ze zmiennymi i `megabuf` — gdy czegoś nie da się odbić
    w pamięci: zmienna, która przy pierwszym uruchomieniu nie jest liczbą (nazwa składowej
    instancji, np. `init` czy `analyser`: 30 instancji w całym zbiorze), zapis przez efekt wartości,
    która nie jest liczbą, inny bank rejestrów z `setup()`. Klony z `CodeInstance.clone` liczą
    domknięciami na swoich właściwościach, jak dotąd. Bez WebAssembly, przy błędzie kompilacji albo
    gdy strona nie dostanie już pamięci wasm — liczą domknięcia. Przełączniki:
    `globalThis.__avsEelWasm = false` (same domknięcia, porównania A/B), `__avsEelWasmSync = true`
    (kompilacja od razu przy pierwszym uruchomieniu — testy), `__avsEelWasmStats = {}` (ile
    instancji poszło do wasm, ile nie i dlaczego).
  - `getosc` i `getspec` (od rundy 5, 10.11 wieczorem) liczą się w module: analizator AVS trzyma
    bajty dźwięku w osobnej `WebAssembly.Memory` o jednej stronie, bez wzrostu (`createVisdata(true)`
    w `analyser.ts`, układ `VISDATA_OFFSETS` w `winamp-visdata.ts`), którą moduł importuje jako
    drugą pamięć (multi-memory) i czyta z niej to samo, co funkcja JS — bez wywołania z wasm do JS
    na każdy punkt (Zevensoft — TwirlyColours: 102 tys. wywołań na klatkę, ok. 4 ms mniej). Bez
    multi-memory w przeglądarce (`MULTI_MEMORY` sprawdza to raz, np. Safari) albo z analizatorem
    bez tej pamięci zostaje import funkcji JS jak dotąd; podmiana analizatora po zbudowaniu modułu
    wraca dla tej instancji do domknięć. `__avsEelWasmVis = false` wyłącza tę drogę.
  - Dowód zgodności: `eel-wasm-backend.test.ts` (w `test:ui`) liczy oboma drogami wygenerowane
    programy obu dialektów (600: każda zmienna po każdym wywołaniu, rejestry, cały `megabuf`
    i `gmegabuf`), każde działanie i funkcję na 45 × 45 wartościach brzegowych (±0, połówki,
    2^31, 2^62…2^63, NaN, ±∞), granice pętli i `memset`/`memcpy`/`freembuf` (także kolejność
    argumentów ze skutkami ubocznymi), idiomy AVS i przejście w tle z domknięć do wasm. Test łapie
    każdą z 18 celowo wprowadzonych pomyłek. Poza testem: kod wszystkich presetów z
    `vendor/avs-presets` (12 755 presetów z kodem, 80 516 instancji, z czego 69 648 w wasm, reszta
    bez sekcji do uruchomienia) oboma drogami w Node, wywoływany jak w efektach — 0 różnic. Sumy
    klatek w przeglądarce: „Stan”, runda 4.
- **Składnia EEL2** (`avs/eel2-parser.ts`) dla presetów pisanych pod chavs albo AVS 2.82+:
  `a ? b : c` (każdą część można pominąć), `x[y]` (pamięć pod x + y), `gmem[y]`, funkcje
  użytkownika (`function f(a b) local(…) instance(…) ( … );`, wklejane w miejsce wywołań, jak
  robi EEL2), `while (warunek) (kod)`, `$x1F`, `$'a'`, `~`, `<<`, `>>`, `===`, `!==`.
  - Preset, którego kod gdziekolwiek używa składni tylko z EEL2 (i daje się nią przeczytać), jest
    w całości czytany jak w EEL2: grupowanie działań z gramatyki EEL2 (`eel2.y`: `%` i przesunięcia
    przed `/`, `/` przed `*`, `-` przed `+`, `& | ~` na jednym poziomie, potem porównania,
    `&& ||`, `?:`), nazwy do 16 znaków, stałe EEL2. Wybór robi `Main.loadPreset`
    (`presetEelDialect`) i zapisuje go przy kodzie (`_dialect`, Movement przekazuje go workerowi).
  - Każdy inny preset liczy się dalej jak w ns-eel AVS 2.81 (wyżej). Pojedyncza notatka ze
    znakiem zapytania między instrukcjami („what shape? (length)”) nie czyni presetu EEL2, bo nie
    daje się przeczytać jako EEL2.
  - Od 09.11 dowodem jest też `;` w nawiasie (`loop(n, a = a + 1; b = b * a)`): 2.81 ciął kod na
    każdym `;`, więc taka sekcja nic tam nie robiła, a autor pisał ją pod EEL2. W
    `vendor/avs-presets` (13 965 presetów) jako EEL2 czytają się 3 (t-k ×2, montana). Presety
    z AVS Trans nie należą do nich: AVS Trans rozpisuje sekwencje w nawiasach na `exec2`/`exec3`
    dla ns-eel 2.81, jak robiła wtyczka (niżej). Notatkę ze znakiem zapytania albo `[` ma 30
    presetów (np. JjcL237 — Let Me Paint My Way Out) i żaden nie jest przez to EEL2.
  - Bajt od 0x80 w kodzie EEL2 kończy instrukcję: nic więcej do najbliższego `;` (także przez
    końce wierszy), tak czyta wzorzec (notatki autorów, niżej).
- **SuperScope zaczyna `x` i `y` od 0**, jak AVS, i trzyma ostatnią wartość z kodu. Kod, który
  nie ustawia `x` (pionowa linia w Echolocie), rysował się wcześniej poza ekranem. Od 09.11
  rysuje jak `r_sscope.cpp`, piksel w piksel przez `avsLine` i plotter z `avsDraw.ts` (wcześniej
  linie GL): `line()` AVS-a bez dalszego końca, `drawmode` i `linesize` czytane z kodu przy
  każdym punkcie, kolor `(int)(c·255)` tego punktu, mieszanie z Set Render Mode, `v` z bajtów
  AVS-a (`avsChannel`, fala z odwróconym bitem znaku; ostatnie punkty czytają bajt za kanałem,
  w AVS pierwszy bajt następnej tablicy `visdata`, np. prawego kanału po lewym — od tego zależy
  `t=t+abs(v)*2` w Nixa — Freedom of Shape). Kod init i per punkt działa tylko wtedy,
  gdy się skompilował (bez kodu per punkt nic się nie rysuje). `w` i `h` dostaje co klatkę przed
  kodem, jak w AVS (także Dynamic Shift i kod Effect List): preset, który w init przypisuje
  `W=3.14*2`, od drugiej klatki znów liczy z szerokością ekranu (Marco — forever1a).
- **Movement** (`trans/Movement.ts`, `movementTable.ts`, `movementWorker.ts`) to port
  `r_trans.cpp`:
  - tablica „skąd bierze się każdy piksel” liczona jak w AVS: wbudowane efekty z wzorów C,
    własny kod per piksel z `d`, `r`, `x`, `y`, `sw`, `sh`;
  - pozycje z dokładnością 1/32 piksela, „source mapped” i przełączanie na beacie;
  - tablicę liczy Web Worker; zanim wróci (albo bez tekstur float w GPU), działa przybliżenie
    na siatce Dynamic Movement (`GridMovement`).
- **Dynamic Movement** (`CpuDynamicMovement.ts`, `dmoveTable.ts`) liczy jak `r_dmove.cpp` co do
  bitu: punkty siatki co (w << 16)/gridW, kod daje pozycje 16.16 przez `(int)`, a między punktami
  AVS szedł w liczbach całkowitych (krok na wiersz i na piksel to różnica przez liczbę pikseli,
  obcięta do zera; bez „wrap” pozycja trzymana w [0, w_adj − 1], z „wrap” zawijana raz na piksel).
  Procesor przechodzi siatkę do poziomu komórek, a karta graficzna dolicza piksele: start + j·krok
  rozbite na część >> 8 i niski bajt, co floaty liczą dokładnie (`dmoveAt` to wzór, test porównuje
  go z przejściem piksel po pikselu). BLEND4_16 albo piksel, a „blend” i „alpha only” mieszają
  MMX-owym `BLEND_ADJ` z Winampa: (s·a + d·(255 − a)) >> 8. Cztery Dynamic Movement przy
  1280×720: ok. 4 ms na klatkę. Bez tekstur float zostaje siatka GPU. We współrzędnych
  biegunowych AVS po kodzie punktu przelicza zmienne w miejscu (`*var_d *= max_screen_d`,
  `*var_r -= M_PI*0.5`), więc kod klatki następnej klatki widzi `d` ostatniego punktu w 16.16
  i `r − π/2`; od 09.11 tak samo u nas (`dmoveGrid`, z testem). Broken Mirror czyta w kodzie
  klatki `d` i `r`.
  **Dynamic Distance Modifier** (`DistanceModifier.ts`) jest per piksel, z przybliżonym `isqrt`
  z AVS.
- **Effect List mieszający przez bufor** (wejście albo wyjście „Buffer”) liczy MMX-owym
  `BLEND_ADJ` z 2.81, (lista·v + klatka·(255 − v)) >> 8 przy v z najjaśniejszego kanału bufora
  (`r_list.cpp`), więc to, czego bufor nie zasłania, gaśnie o 1/256 na klatkę. Do 09.11 było tu
  dzielenie przez 255 z tablicy C, przy którym nic nie gasło (Atero — Neon Dreams: ślady bez końca).
- **Arytmetyka AVS** (`avsSupport.ts`): bilinear `BLEND4` z MMX (gubi 1–2 poziomy na przejście),
  50/50 jako `(a >> 1) + (b >> 1)`, mieszanie buforów w liczbach całkowitych. „Adjustable” w Effect
  List i Buffer Save to MMX z Release 2.81 (`mmx_adjblend_block`: (s·v + d·(255 − v)) >> 8,
  przy bieli poziom mniej); Color Map i Picture II zostają przy tablicy C (`blendTwoGlsl(…, true)`).
  „Adjustable” w Effect List przy wartości 255 i więcej (suwak albo `alphain`/`alphaout` z kodu)
  to zwykła kopia, jak w `r_list.cpp` (`if (use_blendin == 10 && use_inblendval >= 255)
  use_blendin=1`, tak samo wyjście), a nie `BLEND_ADJ`, który dawał każdy poziom o jeden niżej
  (VA017 neon — 09: lista z `alphaout=alphain*15`; 136 presetów z suwakiem na 255; od 11.11).
- **Mirror** (`trans/Mirror.ts`, `mirrorFade.ts`) jak `r_mirror.cpp`: do czterech przebiegów (lewa
  na prawą, prawa na lewą, góra na dół, dół na górę, każdy na wyniku poprzedniego); „on beat
  random” to `(rand() % 16) & mode` na beat i 0 przed pierwszym. Płynne przejście: kierunek wchodzi
  od 1/16 albo schodzi od 16/16 o szesnastkę co `slower` klatek, w górnych półbajtach; stan przejść
  był w AVS statyczny, wspólny dla wszystkich Mirrorów presetu (u nas zerowany przy wczytaniu
  presetu, AVS trzymał go też między presetami). webvs miał własne ćwiartki i przejście liniowe.
- **Grain** jak `r_grain.cpp`: „static” to tablica `rand() % 255` i `rand() % 100` na piksel
  (od ilości 40 ziarno dostaje każdy jasny piksel; było 51 % przy 51), skala s/256 w dół, nakładana
  shaderem. Na stronie testowej losuje z własnego generatora jak wzorzec (`grainRand`).
  Ziarno ruchome (bez „static”) ma od 11.11 (2) dwie drogi:
  - **dokładna** — na stronie porównań (`__avsTestRandom`) i z `__avsGrainExact = true`: jak
    AVS 2.81 konstruktor wtyczki wypełnia tablicę 491 bajtów `rand() & 255` i zaczyna od
    `rand() % 491`; co klatkę miejsce idzie o `rand() % 300`, a każdy jasny piksel (od górnego
    wiersza, od lewej) bierze bajt szansy i — gdy ten wypadnie poniżej ilość·255/100 — bajt skali;
    co 16. miejsce tablica przeskakuje o `rand() % 73` (`fastrandbyte()`). Przejście robi procesor
    w WebAssembly (`trans/grainDice.ts`; bez WebAssembly ta sama pętla w JavaScripcie): zwykle po
    masce jasnych pikseli, którą pakuje GPU (32 piksele na teksel, odczyt 1/32 klatki), a bajty
    skali nakłada shader (`trans/grainMask.ts`); na klatce, którą trzyma seria na procesorze (Grain
    jest wtedy jej użytkownikiem), po niej samej. Wzór zgadza się ze wzorcem co do piksela
    (effekthasch — femme fatale (ALIAS remix): w klatce 300 2 % → 100 % pikseli jak we wzorcu).
    Koszt przy 1280×720: 5–10 ms na klatkę na każde ruchome Grain (głównie czekanie odczytu na to,
    co GPU ma jeszcze do narysowania; samo przejście ok. 2 ms);
  - **w odtwarzaczu** — shader losuje na piksel te same dwa bajty (szansa i skala) z tym samym
    rozkładem, bez odczytu z GPU. AVS 2.81 ustawia ziarno `rand()` od czasu przy każdym starcie
    (`main.cpp`: `srand(…GetCurrentThreadId())`), więc przejście tablicy daje w Winampie inny wzór
    w każdej sesji; dokładna droga nie zmienia więc niczego, co widać, a kosztowała do kilkudziesięciu
    ms na klatkę (Predator Eye View z czterema Grain: 5 → 38 ms).

  Testy porównują przejście (po klatce, po masce, w JavaScripcie i WebAssembly) z dosłownym portem
  pętli C i liczbą wywołań `rand()` (`grainDice.test.ts`).
- **Dynamic Shift** jak `r_shift.cpp`: x, y i alpha = 0, 0, 0,5 tylko tuż przed kodem init
  i tylko, gdy jest; między klatkami zostają. Bez subpikseli przesunięcie `(int)`, z nimi BLEND4
  z wagami odwróconymi przy części dodatniej: nawet w miejscu obraz traci poziom i dostaje czarną
  ramkę, w którą wchodzą presety ze sprzężeniem.
- **Losowość** (`avsRandom.ts`): normalnie dowolny generator. Strona porównawcza ustawia
  `globalThis.__avsTestRandom`, a wtedy i `rand(x)` w kodzie, i efekty losują z jednego `rand()`
  Microsoftu, jak w AVS 2.81 (`rand() % (int)max(x, 1)` z ns-eel), w kolejności AVS, po 30
  losowaniach, które wzorzec zużywa na nazwy trzech list głównych. Wzorzec ma do tego
  podmieniony `rand` w EEL2 (był Mersenne Twister). `globalThis.__avsSynchronousTables` liczy
  tablice Movement od razu, bez workera.

  Jedno losowanie więcej albo mniej przesuwa wszystkie następne. Ślad losowań (klatka,
  komponent, liczba; narzędzia w `scratch/avs-reference/README.md`) zgadza się dziś ze wzorcem
  w 362 z 365 presetów. W trzech (Raz — Clean, Raz — Labyrinth Zone, VisKey — Loop) kod Texera II
  przekracza próg zależny od dźwięku albo czasu o klatkę wcześniej. FyrewurX losuje z własnego
  generatora, i tak robi oryginał: `fyrewurx.ape` ma dołączone statycznie CRT, a jego `rand()` to
  `rand()` MSVC od ziarna 1, bez `srand`, wspólny dla wszystkich FyrewurX i nigdy nie zerowany (port
  trzyma go w module, niżej). Gdy odtworzenie brało `rand()` AVS-a, rozjeżdżało każdy Moving
  Particle, Starfield i `rand()` po sobie (40 presetów, m.in. oba „Chess”).
- **Dźwięk jak z Winampa** (`avs/analyser.ts`, `avs/winamp-visdata.ts`): co klatkę najnowsze 576
  próbek lewego i prawego kanału (dwa analizatory za rozdzielaczem kanałów na węźle odtwarzacza;
  przed nim wzmacniacz z dwoma kanałami, więc mono trafia do obu, jak u Winampa) zamienione
  w bajty, które Winamp dawał wtyczkom wizualizacji. Sposób liczenia odczytany ze źródeł Winampa
  5 (`vsa_addpcmdata` w `VIS.cpp`, licencja WCL pozwala je czytać i studiować; kod napisany od
  nowa z opisu):
  - fala: górny bajt 16-bitowej próbki, −128…127;
  - widmo: górne bajty pierwszych 512 próbek, filtr DC y = x − x₁ + 0,99·y₁, okno Hanna
    0,5 − 0,5·cos(2πn/511), FFT 512 bez skalowania, |X[k]|/16 obcięte do 255 dla 256 binów (bin 0
    razem z członem Nyquista), każdy bin dwa razy, za pierwszym razem w pół drogi od
    poprzedniego, a ostatnie 64 bajty to połowienie ostatniego binu; zaokrąglenie do
    najbliższej, połówki do parzystej (`fistp`);
  - AVS 2.81 przepuszczał każdy bajt widma przez tablicę `g_logtab` (`main.cpp`):
    255·log(1 + 60x/255)/log 60, więc ciche składowe stoją wysoko.

  Efekty czytają te bajty tak jak w AVS (`avsVisdata`, `avsChannel` w `avsDraw.ts`):
  - kanał lewy, prawy albo środek jako `visdata[0][x]/2 + visdata[1][x]/2` na znakowych `char`.
    Dla widma bajt od 128 w górę jest tam ujemny, więc kanały po dwóch stronach 128 dają złą
    sumę (200 i 50 → 253) — tak AVS rysował;
  - `getosc` i `getspec` liczą `getvis` z `avs_eelif.cpp` na bajtach;
  - Bass Spin, Rotating Stars i Timescope czytają swoje kanały (Timescope zawsze lewe widmo,
    a za 576 kolejne tablice), Dot Plane lewe widmo, Dot Fountain lewą falę, a `v` w Texerze II
    to (lewy + prawy bajt fali)/256.
  - Beat liczy głośniejszy kanał: suma |bajt fali|, jak `lt[ch]` w `main.cpp`.

  Bajty zgadzają się z wzorcem co do jednego (299 klatek, 688 896 bajtów;
  `scratch/avs-reference/tools/visdata_check.mjs`). Nie odtwarzamy dwóch rzeczy:
  - „szczytu” z kilku wywołań `Render` Winampa między klatkami AVS (Winamp wołał wtyczkę co
    ~14 ms);
  - tego, jak liczyły starsze wersje Winampa (2.x): źródło jest z linii 5.

  **Skala dla innych wtyczek Winampa:** całe to liczenie mieszka w `avs/winamp-visdata.ts`
  (czysty moduł, bez importów). Bajty samego Winampa to `pcmTopByte` (fala) i `winampSpectrum`
  (576 bajtów widma z bloku górnych bajtów); `AVS_LOG_TABLE` i `avsVisdataFrom` dokładają tablicę
  `g_logtab`, która należy tylko do AVS-a. Geiss (mapa 10) bierze bajty Winampa bez tej tablicy.

  Od rundy 5 analizator AVS (`NodeAnalyser`) trzyma te bajty w jednej stronie pamięci
  WebAssembly (`createVisdata(true)`: widmo lewe, prawe, fala lewa, prawa pod `VISDATA_OFFSETS`),
  z której kod presetów w wasm czyta `getosc`/`getspec` wprost; dla reszty silnika to zwykłe
  tablice jak dotąd. `createVisdata()` bez argumentu (zapasowe bajty `avsVisdata` w `avsDraw.ts`,
  testy) daje zwykłe tablice.
- **Dodatkowe komponenty** (`trans/Extras.ts`): ConvolutionFilter, Blur, Interleave,
  Custom BPM, Global Variables i Framerate Limiter (jak `e_frameratelimiter.cpp`: klatka co
  najmniej 1000/limit ms, w całych ms; 69 presetów z importu VISBOT). Comment
  i AVSTransAutomation nic nie rysują (AVS Trans działa przy wczytaniu presetu, niżej).
- **Wtyczki (APE) i SVP Loader** (`ape/apeHost.ts`): interfejs wtyczek AVS-a w przeglądarce.
  Port dostaje to, co AVS dawał APE: `render(visdata, isBeat, framebuffer, fbout, w, h)` na
  pikselach 0x00RRGGBB od górnego wiersza oraz z APEinfo rejestry reg00–reg99, tryb linii
  i bufory globalne (czytane z karty graficznej i odsyłane, gdy port w nie pisze). Klatka idzie
  na procesor i z powrotem raz na komponent (`readPixels`, jak w Texerze II), chyba że port tylko
  dodaje do pikseli z nasyceniem i ma `additive(ctx, plot)` (FyrewurX): wtedy jego zapisy idą przez
  plotter (`avsDraw.ts`) jako dodawanie GL, co liczy się dokładnie na 8-bitowych kanałach, bez
  kopii klatki (`__avsApeAdditive = false` na stronie testowej wraca do kopii). SVP Loader
  (`r_svp.cpp`) daje wtyczce Sonique falę po 512 bajtów na kanał, widmo po 256 (pary bajtów AVS-a
  połowione i dodane) i GetTickCount, a ona rysuje w klatce. Port, który rzuci wyjątkiem, staje
  (raz, z ostrzeżeniem w konsoli), a reszta presetu rysuje dalej.
  - Konwerter (`scripts/webvsc/browser.js`): identyfikatory, które AVS 2.81 uruchamiał jako
    własne efekty (`NamedApeToBuiltinTrans` w `rlib.cpp`: „Winamp Starfield/Text/Bump/Mosaic v1”,
    „Nullsoft MIRROR v1” i inne), idą do tych efektów (18 presetów importu). Wtyczki, które
    silnik uruchamia przez host, oraz nieznane, zostają z identyfikatorem i bajtami konfiguracji
    (`{ type: "Ape", apeId, config }`). FyrewurX wychodzi jako `{ type: "FyrewurX", apeId, config }`:
    z portem w `vendor/avs-apes` biegnie przez host (`apeComponentType` w `apeHost.ts`, wołane
    w `Container.ts`: port wtyczki zastępuje zastępnik silnika), bez niego — dawne odtworzenie
    z `render/ExtraRender.ts` (czyta „enabled” z bajtów konfiguracji).
  - W repozytorium (źródła na licencji zgodnej z MIT): Trans: Normalise za `e_normalise.cpp`
    z grandchild (`ape/builtinApes.ts`) i Holden05: Multi Delay za `r_multidelay.cpp` z 2.81d
    (`trans/MultiDelay.ts`, `multiDelayRing.ts`; test porównuje go z dosłownym portem bajt po
    bajcie).
  - Porty wtyczek bez opublikowanych źródeł leżą u właściciela w `frontend/vendor/avs-apes/`
    (poza gitem, `scripts/avs-apes.mjs`, `virtual:avs-apes`, osobny kawałek ładowany przy starcie
    AVS); port tego samego identyfikatora zastępuje wbudowany. Powstały ze statycznego odczytu
    binarek z paczek VISBOT (dumpbin i Python, nic nie było uruchamiane ani ładowane; notatki
    w `scratch/avs-reference/apes/`). Lista niżej, w „Stanie”.
- **Texer II** (`render/TexerII.ts`) to port `DrawParticle` z `e_texer2.cpp` (APE Acko.net) na
  procesorze, piksel w piksel z jego MMX. Co klatkę obraz wraca z karty graficznej
  (`readPixels`), cząstki rysują się w kolejności kodu i obraz idzie z powrotem jako klatka.
  - „Resize”: bitmapa skalowana do sizex × sizey własnym filtrem dwuliniowym Texera II (kroki
    16.16, ułamki 8-bitowe, każdy iloczyn przesunięty w prawo) i zawsze przez filtr koloru (bez
    „colorize” biały: × 255 >> 8).
  - Bez „resize”: bitmapa w swoim rozmiarze pomniejszonym o piksel w każdą stronę, tak jak
    wychodził jej prostokąt; kolor mnoży się (>> 8) tylko z „colorize”.
  - Dziesięć trybów linii z Set Render Mode we własnej arytmetyce Texera II: 50/50 to
    (a + b) >> 1, mnożenie i „adjustable” przesuwają iloczyny o 8, a „adjustable” waży w dwóch
    ścieżkach odwrotnie, jak w oryginale.
  - Ujemne rozmiary odbijają bitmapę, „wrap” rysuje cząstkę jeszcze raz za krawędzią, którą
    zachodzi (Texer II z AVS 2.81 zawijał raz).
  - Do 480 linii to klatka AVS; wyżej cząstki rosną z klatką (przez ścieżkę „resize”).

  Wcześniej był to Texer z webvs (prostokąty z filtrem GL i mieszaniem GL).

  Od 10.11 (wydajność, wynik co do bitu ten sam):
  - arytmetyka cząstki jest w czystym `render/texerParticle.ts` (test porównuje ją z dosłownym portem,
    którym była: 1 500 losowych cząstek, wszystkie tryby i obie ścieżki); poziomy przebieg filtra
    wiersza bitmapy liczy się raz dla wierszy klatki, które go czytają;
  - Texery II jeden po drugim w liście (między nimi tylko Comment, Set Render Mode, Custom BPM) dzielą
    jedną kopię klatki na procesorze (`webvs/cpuFrameRun.ts`): odczyt na początku serii, wysyłka na
    końcu, zamiast po razie na każdy. Effect List przed każdym dzieckiem mówi, czy następne też jest
    Texerem II (`avsCpuRunNext`), i oddaje klatkę po ostatnim dziecku (także po wyjątku). Hboy — 01 Intro
    (176 Texerów II, każdy kopiował klatkę 1280×720 w obie strony): 679 → 52 ms na klatkę samą serią,
    z drogą GPU niżej 678 → 34 ms (świeża strona). Od rundy 5 do serii należą też Super Scope'y,
    których zapisy plotter miesza na procesorze (50/50, mnożenie, „adjustable”; `avsDraw.ts`
    niżej): OnionRing — 15 czytał klatkę 27 razy na klatkę, teraz raz. Klatka, w której rysował
    tylko plotter, wraca jako sam prostokąt, w który pisał (piksele poza zapisami bez zmian,
    alfa 1 w zapisanych, jak po rysowaniu plottera), a ta z Texerem II — cała, jak dotąd;
  - od 11.11 (2) do serii należą też Convolution Filter z jądrem rekurencyjnym i ruchome Grain
    w dokładnej drodze (strona porównań); że komponent jest w serii, zależy od jego ustawień, więc
    mówi to polem `avsCpuFrameUser` (`cpuFrameRun.ts` `kind()`). Grain bierze klatkę z serii, gdy
    ta ją trzyma, a inaczej liczy na masce i klatki nie odczytuje;
  - ścieżka „resize” (czyli każda cząstka powyżej 480 linii) w trybach, które blending GL liczy
    dokładnie (zastąp, dodaj, maksimum, minimum, oba odejmowania; 98 % Texerów II w presetach), idzie
    na kartę graficzną (`render/texerGpu.ts`): procesor liczy prostokąt cząstki i dla każdej jej kolumny
    i wiersza kolumnę/wiersz bitmapy z 8-bitowym ułamkiem (krok 16.16 jako int, `walkColumns`,
    `walkRows`), a shader fragmentów liczy cztery próbki, filtr, `& 0xffff` i kolor na liczbach
    całkowitych poniżej 2^24 (highp float trzyma je dokładnie; mnożenia i przesunięcia o potęgi dwójki)
    i GL miesza cząstki w kolejności kodu. Dane idą teksturami RGBA8 szerokości 2048 (indeks liniowy →
    teksel bez dzielenia), bitmapa też liniowo, więc próbka za końcem wiersza czyta następny wiersz,
    a za końcem bitmapy 0, jak tablica na procesorze. Bez highp w shaderach fragmentów, w trybach 50/50,
    mnożenie, „adjustable”, XOR i dla ścieżki bez „resize” rysuje procesor. Test `texerParticle.test.ts`
    liczy formułę shadera z tych samych tablic i porównuje z procesorem (1 200 losowych cząstek).
    `__avsTexerGpu = false` i `__avsCpuRun = false` na stronie testowej wracają do dawnych dróg.
- **Picture i Picture II** (`render/AvsPicture.ts`) jak `r_picture.cpp` i APE Picture II
  (`e_picture2.cpp` z grandchild/vis_avs): bitmapa skalowana do klatki na procesorze, raz na
  rozmiar klatki, a potem mieszana w shaderze poziom w poziom (`blendTwoGlsl`).
  - Picture: rozciągnięcie albo proporcje wzdłuż jednej osi z czarnym tłem; zastąp, dodaj albo
    50/50, a „adapt” zamienia 50/50 w dodawanie na beat i przez `onBeatPersist` klatek po nim.
    Skalowanie jak `StretchBlt` z GDI w trybie COLORONCOLOR, który bierze piksel źródła spod
    środka piksela celu: ⌊(d + ½)·s/D⌋. Zmierzone na samym GDI przez ctypes, tak jak robił to
    `r_picture.cpp` (`LoadImage`, `StretchBlt`, `GetDIBits`; `tools/gdi_stretch.py`): 60 z 60
    osi; dotychczasowe ⌊d·s/D⌋ trafiało w 15.
  - Picture II: skalowanie po całych pikselach albo filtr dwuliniowy AVS (BLEND4, ramka
    podwojonych krawędzi), dziesięć trybów mieszania, osobny tryb, filtr i wartość na beat.
  - Bez bitmapy oba nic nie rysują, jak AVS (`ResourceManager.hasImage`). Wcześniej Picture był
    duszkiem webvs czytającym inne pola, a Picture II nic nie rysował.
- **Unique Tone** liczy tabelę tonu jak `r_onetone.cpp` (`(unsigned char)((i / 255.0) · kanał)`)
  i miesza w shaderze na bieżącej klatce: zastąp, dodaj z nasyceniem, 50/50. Upstream mieszał
  przez GL do drugiej tekstury pary, czyli do starszej klatki, więc ton „dodaj” zamieniał kolory
  na szarość i przepalał obraz do bieli (Riftweaver, alien surf, Eye am, systemscan i inne).
  `ShaderProgram.run` kopiuje teraz bieżącą klatkę każdemu programowi `swapFrame` z mieszaniem
  przez GL.
- **Moving Particle „Default”** to tryb linii z ostatniego Set Render Mode (`BLEND_LINE`, bez
  niego zastąpienie), jak `r_parts.cpp`; wcześniej dodawał i nachodzące cząsteczki bielały.
- **Effect List zaczyna od domyślnego trybu linii** (zastąp, 1 px) i po sobie oddaje rodzicowi
  jego tryb, jak `r_list.cpp` (`g_line_blend_mode = 0`).
- **Fast Brightness i Multiplier** liczą jak `r_fastbright.cpp` i `r_multiplier.cpp`:
  - ×2, ×4, ×8 z nasyceniem na kanałach, ×½, ×¼, ×⅛ z obcięciem jak przesunięcie bitów;
  - „infinite root” robi biały z każdego piksela, który nie jest czarny, a „infinite square”
    czarny z każdego, który nie jest czysto biały. Oba działają na całych pikselach i pomijają
    piksel 0;
  - konwerter podaje mnożnik Fast Brightness wprost (2, 0,5 albo 1), a nie numer trybu.
- **Color Map** piecze wszystkie mapy. „Włączona” decyduje tylko o tym, która mapa jest pierwsza
  i między którymi przechodzi cykl; bez żadnej włączonej gra mapa 0, jak w AVS.
- **Obrazki z paczek:** build zbiera bitmapy z `vendor/avs-presets` (Texer, Texer II, Picture
  szukały ich po nazwie w folderze AVS) i serwuje je obok wbudowanych (`images`
  w `virtual:avs-presets`). Nazwy szuka się bez względu na wielkość liter, jak na Windows.
  Gdy dwie paczki mają pod tą samą nazwą różne obrazki, każda kopia idzie osobno
  (`resources/<sha10>/<nazwa>`), a preset dostaje kopię najbliższą swojemu folderowi
  (`imageOverrides`; 3 nazwy, 7 presetów importu). `Main.loadPreset` zapomina wtedy obrazek
  wczytany pod tą nazwą przez poprzedni preset.
  Obrazka, którego nie ma w żadnej paczce, w Texerze II zastępuje jego domyślny sprite; Texer
  (pierwszy), Picture i Picture II bez obrazka nic nie rysują.
- **Texer, pierwszy APE** (`render/TexerV1.ts`, za `e_texer.cpp` z grandchild/vis_avs; 308
  presetów): każdy zapalony piksel klatki, w kolejności czytania i do liczby cząstek (zawsze co
  najmniej jeden), dostaje bitmapę na środku, dodaną z nasyceniem; wynik zaczyna od czerni albo
  od klatki („add to input”), a „colorize” mnoży bitmapę przez kolor piksela, (c · m) >> 8.
  Wynik zastępuje klatkę. Do 09.11 converter dawał te presety webvsowemu „Texerowi” (sprite'y
  z kodem, w rodzaju Texera II) z polami, których on nie zna, więc rysowały co innego albo nic.
  Powyżej okna AVS (~480 linii) bitmapa rośnie z klatką.
- **AVS Trans Automation** (`avsTrans.ts`, translator wtyczki TomyLobo w wersji 1.25, sprawdzony
  z jej binarką: `scratch/avs-reference/apes/eeltrans.md`): wtyczka podpinała się pod kompilację
  ns-eel, więc gdy w presecie jest włączona (flaga ostatnio wczytanej konfiguracji),
  `Main.loadPreset` przepisuje każdy kawałek kodu tak, jak trafiał do ns-eel 2.81:
  - z przodu idzie kod wszystkich komponentów AVS Trans, każdy z `;\r\n`;
  - komentarze wypadają, a `//$avstrans_...` to ustawienia (tryb, „translate first level”,
    zamiany);
  - `#define` z nawiasami to makro w stylu C (z `##`), bez nawiasów to tekst bez względu na
    wielkość liter;
  - tryb „exec”, domyślny wtyczki (żaden preset go nie zmienia): w argumentach funkcji `x = y`
    to `assign(x, y)`, a `a; b; c` to `exec3(a, b, c)` (dłuższe zagnieżdża:
    `exec2(exec3(a, b, c), d)`); na najwyższym poziomie tylko z „translate first level”,
    przypisanie do `megabuf(…)` zawsze; na końcu `;\r\n`, a `[` `]` stają się `(` `)`.

  Dotąd zostawała postać liniowa (tak robi grandchild, bo jego EEL2 przyjmuje `;` w nawiasach),
  więc 70 presetów z AVS Trans czytało się jako EEL2 albo miało martwe sekcje; teraz kompiluje je
  ns-eel 2.81, jak w AVS. Kod zaczynający się od `//$notrans` zostaje bez zmian. AVS Trans ma 80
  presetów. Testy są w `avsTrans.test.ts`.
- **Custom BPM** zmienia beat dla efektów po nim w tej samej liście, jak `r_bpm.cpp`:
  - tryby: „co n-ty beat” (skip), „stałe tempo” (arbitrary) albo „odwrotnie” (invert);
  - pierwsze beaty można pominąć.

  webvsc czytał jego ustawienia źle aż do 08.11.2026 (`getRadioButton`, opis w
  `scripts/webvsc/README.md`). Wszystkie 22 Custom BPM-y z presetów wychodziły jako „stałe tempo
  21 ms po 21 pominiętych beatach”, a naprawdę to „co 2., 4., 5., 9., 10. albo 11. beat”.
- **Convolution Filter** (`trans/Convolution.ts`, 7 346 włączonych filtrów w 4 054 presetach) liczy jak
  `e_convolution.cpp` (MMX generowany w locie):
  - kanały w całych poziomach 0…255; dodatnie i ujemne składniki sumowane osobno, bias jako
    256 × bias;
  - różnica w jednym z trzech trybów: zwykła (nie poniżej 0); „wrap”, który webvsc nazywa
    `edgeMode: WRAP` (ujemna zawija się do 65536 + różnica); „absolute” (psubsw i skasowany bit
    znaku, więc ujemna wychodzi jako 32768 + różnica, czyli biel — to nie jest wartość
    bezwzględna);
  - ujemna skala odwraca znaki i dzieli przez moduł;
  - dwa przejścia: jądro obrócone o ćwierć obrotu i suma obu (paddusw — komentarz w źródle mówi
    psubusw, ale bajty to paddusw);
  - dzielenie: przesunięciem dla potęgi dwójki albo 16-bitowym mnożeniem przez 65536 / skala;
  - packuswb czyta słowo ze znakiem, więc 32768 i więcej to czerń;
  - krawędzie jak kod generowany przez wtyczkę: lewa i górna powtarzają kolumnę i wiersz 0;
    trzy ostatnie kolumny wyniku czytają najwyżej kolumnę w − 2 (przesunięcia
    `min(…, width-2)`), kolumny przed nimi czytają sąsiadów, jacy są (czwarta od końca sięga
    ostatniej); każdy wiersz czyta najwyżej wiersz h − 2 (wskaźnik `c[6]` stoi, gdy następny
    byłby ostatnim wierszem) — ostatniego wiersza filtr nie czyta nigdy;
  - jądro, które zaczyna się od co najmniej 24 zer, liczy w miejscu (`use_fbout` = 0): każdy
    odczyt leży na pikselu jeszcze niepoliczonym, chyba że krawędź cofa go na policzony. Od 11.11 (2)
    każde takie jądro (393 filtry) liczy się jak we wtyczce:
    - z samym środkiem (309, np. „×5/2”): ostatni wiersz czyta wiersz nad nim już przefiltrowany,
      a ostatnia kolumna kolumnę przed nią — tam shader liczy filtr dwa razy;
    - z samych zer (2): nic nie czyta, wynik jak na GPU;
    - 78 innych (70 jednoprzebiegowych i 8 dwuprzebiegowych, których obrócone jądro czyta tylko
      wiersze poniżej — w tym mykaL — just another sound: jego jedyna waga sięgająca wiersza powyżej
      mnoży, po obróceniu, przez zapisane tam 0) czyta piksele już policzone tylko w ostatniej kolumnie
      i dwóch ostatnich wierszach. Od 11.11 (4) liczy je w całości GPU, bez odczytu klatki
      (`trans/convolutionEdges.ts`, `ConvolutionEdgesGpu`), dwoma przebiegami po zwykłym:
      - wiersz h − 2 czyta siebie na lewo (wiersze niżej przycina do niego) — rekurencja wzdłuż wiersza,
        najwyżej trzy piksele wstecz, nieliniowa (nasycenie, dzielenie, pakowanie), więc nie da się jej
        rozłożyć na równoległe kroki. Przebieg do tekstury w × 1 liczy ją w każdym fragmencie od
        początku: wszystkie te same w kroków po wierszu, jaki był, i każdy zostawia krok swojej kolumny
        (pętla do 16 384 kroków; szersze klatki liczy procesor z odczytu jak dotąd);
      - wiersz h − 1 czyta tylko wiersz h − 2 już policzony, a kolumna w − 1 (nad nimi) tylko piksel
        w − 2 swojego wiersza, który daje zwykły filtr: drugi przebieg rysuje na klatkę te piksele
        i wiersz h − 2, z obrazu, jaki był (tekstury, którą czytał zwykły przebieg), i z wiersza.
      Kosztuje to tyle co zwykły filtr (przy 1280×720 do ~1 ms więcej; z odczytem pasków było +4–9 ms,
      w ciężkim presecie do +29 ms, bo odczyt czeka na całą kolejkę GPU);
    - 4 dwuprzebiegowe z wagą w wierszach 4–6 w kolumnie 3 albo na lewo od niej (Grandchild —
      proxy (gc's t.a.c.o.-remix), oba journey (alt), for . exoniemetry (wotl remix)) to filtr
      rekurencyjny w dwóch wymiarach: obrócone jądro czyta wiersz powyżej, już policzony (exoniemetry
      także piksel dwa wcześniej w wierszu). Na GPU byłby to przebieg na każdy wiersz (720 rysowań
      i kopii na klatkę) albo w każdym fragmencie cały stożek zależności, który rośnie o trzy kolumny
      na wiersz (O(j²) kroków) — więc liczy procesor, całą klatkę w kolejności wtyczki, w WebAssembly
      SIMD (`trans/convolutionWasm.ts`, moduł robiony dla jądra: `i16x8.add`, `add_sat_u`, `sub`,
      `sub_sat_u`, `sub_sat_s`, `mul`, `shr_u`, `narrow_i16x8_u` to paddw, paddusw, psubw, psubusw,
      psubsw, pmullw, psrlw, packuswb wtyczki; środek wiersza dwa piksele na krok, chyba że piksel
      czyta ten tuż przed sobą, kolumny brzegowe po jednym z przyciętymi odczytami). Gdy klatki nie
      dzieli z nikim, odczyt idzie wprost do pamięci modułu i wysyłka z niej, w kolejności wierszy GL
      (bez odwracania i kopii); gdy przed albo za nim jest inny użytkownik serii klatki
      (`cpuFrameRun.ts`), przez serię. Sam filtr przy 1280×720: 1,7–3,2 ms, z odczytem i wysyłką klatki
      preset wolniejszy o 4–10 ms niż ze zwykłym (niedokładnym) filtrem; bez WebAssembly SIMD liczy
      JavaScript (`convolveAvs`), wynik ten sam.

    Arytmetykę GPU, procesora i WebAssembly daje jeden plan zrobiony jak `create_draw_func`
    (`planConvolution`; shader z niego: `convolutionGlsl`). Wyszło przy tym pięć miejsc, w których
    dotychczasowy shader liczył inaczej niż kod wtyczki (27 z 2 415 różnych ustawień filtrów
    w presetach, 38 presetów):
    - drugie przejście mnoży przez wagę zapisaną dla miejsca już obróconego (`pmullw
      [ecx+8·(7·y+x)]` z x = 6 − wiersz, y = kolumna), nie przez wagę obracanego wpisu — dla wag
      innych niż 1 i potęga dwójki, które przesuwa `psllw` (27 filtrów w 26 presetach, np. drew —
      pixeled seas., Degnic — Nuclear blobs, mykaL — just another sound);
    - iloczyn piksela i wagi powyżej 257 zostaje 16-bitowy (`pmullw`; 8 presetów z wagami 384,
      1 111, −266, −323, −350, np. pan am — ministeck, Pixelcraft — Chromabubbles);
    - bias to słowo 256·|bias| z 16 bitami (|bias| ≥ 256 zawija; 3 presety, np. jheriko — Yet
      Another Grid);
    - „absolute” czyta sumy jako słowa ze znakiem (`psubsw`: 32 768 i więcej to liczba ujemna),
      a bez wag ujemnych nie odejmuje w ogóle (stary shader obcinał wtedy sumę do 32 767; 3 presety
      z sumą wag 441, np. l0tus — carcinogenic haze);
    - przy ujemnej skali o `paddw` albo `paddusw` listy decyduje suma wag dodatnich sprzed zamiany
      znaków (żaden preset, ale kod tak liczy).

    Testy: `convolutionCpu.test.ts` porównuje plan z emulacją wygenerowanego kodu instrukcja po
    instrukcji (bloki im = 0…6, wskaźniki wierszy na stosie, pętla edi; 400 losowych jąder, trybów,
    skal i klatek) i sprawdza, że przeliczone krawędzie dają to samo co cała klatka w kolejności
    wtyczki; `convolutionWasm.test.ts` porównuje WebAssembly z JavaScriptem (klatka w obu porządkach
    wierszy). Sondy wobec wzorca, co do piksela (640×360): 25 presetów (jądra w miejscu z presetów,
    każda z pięciu różnic arytmetyki, ze sprzężeniem i bez, dwa filtry po sobie) w klatkach 1–120 oraz
    po jednej sondzie na każde z 55 różnych jąder w miejscu, jakie mają presety, w klatkach 1, 2, 5,
    10, 30, 60. Przed 11.11 (2) różniły się wszystkie poza „×5/2” i biasem 300 (tam biel w obu).

  Wcześniej skala −1 z „absolute” dawała czerń (YUMinimized biały po Invert), „wrap” zawijał
  współrzędne zamiast wartości, a dwa przejścia były pomijane. Do 11.11 krawędź powtarzała
  ostatni wiersz i kolumnę (OnionRing — Blood On The Motorway różnił się od wzorca od pierwszej
  klatki w dwóch ostatnich wierszach i kolumnach). Sprawdzone presetami-sondami (linie w ośmiu
  ostatnich kolumnach i wierszach, jądra z jednym wpisem: +3 w prawo, +2, +3 w dół, środek ×5/2,
  środek dwuprzebiegowo) wobec wzorca: co do piksela.
- **Triangle** (APE „Render: Triangle” TomyLobo; `render/Triangle.ts`, arytmetyka w
  `render/triangleRaster.ts` z testem; 174 presety, 904 trójkąty) liczy jak `e_triangle.cpp`
  z grandchild/vis_avs, bo źródła wtyczki nie ma:
  - zmienne: `n` = 0 przed kodem init; `w` i `h` także w init (grandchild ustawia je dopiero po
    init, więc tam h = 0, ale „3 zebras (yathosho's stereovision mix)” i „destroy dat!” liczą
    w init n1 = h i h/3, a w AVS rysowały); co klatkę przed kodem klatki x1…y3 = 0 i red1…blue3
    = 1, więc trójkąt bez ustawionego koloru jest biały (92 trójkąty w 54 presetach); `b` nie
    jest beatem — wtyczka go nie ustawia, a grandchild w swoich presetach sam go wygasza
    (`b = b-b*pow(speed,.3)`); `i` nie wraca do 0 przed kodem klatki;
  - `n` zaokrąglone jak C `round`; trójkąt k dostaje skip = 0 i i = narysowane/(n − 1), więc
    pominięte (`skip` ≠ 0, także NaN) się nie liczą;
  - narożniki (v + 1)·(rozmiar − 1)/2 obcięte do int (NaN i przepełnienie to INT_MIN jak x86);
    wiersze od wiersza górnego narożnika (bez niego, chyba że leży nad klatką) do wiersza dolnego
    (bez niego); x krawędzi w 32-bitowej arytmetyce całkowitej z dzieleniem do zera; prawy koniec
    wiersza bez ostatniego piksela i nigdy ostatnia kolumna klatki;
  - kolor `(int)(c·255)` przez całkowite `max`/`min` z `platform.h`: poniżej 0 i NaN czarny,
    od 1 biały, a od 2^31/255 znów czarny;
  - mieszanie: tryb linii z Set Render Mode, każdy wiersz jako zapisy `BLEND_LINE` przez plotter
    (`avsDraw.ts`); Triangle jest, jak Super Scope, użytkownikiem serii na procesorze
    (`cpuFrameRun.ts`). Z `zbuf` ≠ 0 trójkąt idzie przez bufor głębi wspólny dla wszystkich
    Triangle (statyczny we wtyczce): piksel bierze kolor (zastępuje, bez mieszania), gdy
    z1·100000 (najwyżej 40000·100000, poniżej 0 zero) jest co najmniej tym, co bufor trzyma;
    `zbclear` ≠ 0 czyści bufor przed rysowaniem (85 trójkątów używa bufora).

  Do 11.11 trójkąty rysował GL z kolorem 0 tam, gdzie preset go nie ustawił, `n` w dół, bez
  bufora głębi i z `b` = beat: VA017 neon — 09 był prawie czarny, Hboy — fragile (yathosho's ill
  bill mix) biały, oba Blood On The Motorway (OnionRing, VB178 i remiks yathosho VB213) po kilku
  klatkach białe. Teraz fragile zgadza się ze wzorcem co do piksela w każdej sprawdzonej klatce do
  300., remiks Blood On The Motorway (VB213) tak samo poza kilkoma pikselami na klatkę (tablica
  Movement, biblioteka matematyczna), a Blood On The Motorway (VB178) do klatki 145 — w 146.
  Interferences wzorca kładzie warstwę piksel obok (niżej, „Klasyczne efekty AVS”). Wszystkie
  174 presety z Triangle wobec wzorca (klatki 30, 90, 150): identycznych 5 → 40, z MAD < 1
  w każdej z trzech 20 → 90; bliżej wzorca 118, bez zmian 50, sześć minimalnie dalej — te są
  daleko od wzorca w obu buildach przez inne komponenty (Picture II z JPG, Text, którego wzorzec
  nie ma, Global Variables). Szybkość: trójkąty mieszane dokładnie (50/50 przez plotter)
  kosztują więcej — stripe state 8–14 → 17–25 ms na klatkę, thick glass 3–5 → ok. 10 ms
  (1280×720, maszyna obciążona z zewnątrz).
- **Porty efektów AVS** (`trans/Native.ts`, `render/Triangle.ts`, `render/Text.ts`,
  `render/ExtraRender.ts`), przeniesione wprost ze źródeł vis_avs (licencja BSD). Każdy liczy
  to samo co oryginał, w krokach 0…255:
  - **kolor:** Fadeout, Brightness, Colorfade, Color Reduction, Color Modifier;
  - **piksele:** Scatter z nowym losowaniem w każdej klatce, Grain (wyżej), Water, Bump, Mosaic;
  - **ruch:** Dynamic Shift, Roto Blitter, Blitter Feedback. Roto Blitter od 09.11 jak
    `r_rotblit.cpp` co do bitu: wiersz idzie od sstart + wiersz·ds_dy o ds_dx na piksel w 16.16,
    zawijany przy każdym kroku, BLEND4_16 z 8-bitowych ułamków (122 presety; wcześniej
    obrót we floatach). Blitter Feedback (84 presety) jak `r_blit.cpp`: przybliżenie od isx +
    x·ds_x w 16.16 przez MMX-owy BLEND4, oddalenie jako pudełko ((w << 16)/ds_x) & ~3 na środku
    z krokiem od 32768, reszta klatki zostaje;
  - **pamięć klatek:** Video Delay jak `r_videodelay.cpp` z 2.81 (282 presety importu): AVS
    zaczyna od `framedelay` = 10, a `load_config` ustawia tylko `delay`, więc wczytany preset
    opóźnia o 10 klatek; na beatach opóźnienie to klatki od beatu · `delay` (do 400). Bufor
    zaczyna od zer (pierwsze klatki czarne), a zmiana opóźnienia przesuwa klatki tak jak `memmove`
    AVS-a (`videoDelayRing.ts`; test porównuje go z dosłownym portem bajt po bajcie). Klatki
    leżą na karcie graficznej: ponad 128 MB zostaje co n-ta (opóźnienie bez zmian);
  - **AVI** (`render/Avi.ts`, `r_avi.cpp`; 47 presetów): klip z folderu AVS rozciągnięty na
    klatkę, jedna klatka klipu na klatkę renderu (`AVIStreamGetFrame(i++ % długość)`), a z
    „speed” nowa dopiero po tylu ms (GetTickCount), do tego czasu ta sama. Mieszanie: addytywne
    z „blend” albo z „adapt” na beacie i przez „persist” klatek po nim (licznik wspólny dla
    wszystkich AVI, jak static w `render()`), inaczej 50/50 z „blendavg” lub „adapt”, inaczej
    zastąpienie. Rozciągnięcie jak GDI: piksel źródła spod środka piksela klatki. Klipy z paczek
    (22 pliki `.avi`: Indeo 3/5 i surowe, 4–356 klatek, do 385×328) przerobione naszym FFmpeg na
    atlasy klatek WebP w `vendor/avs-videos` (9 MB, poza gitem; skrypt
    `scratch/avs-reference/visbot/plugins/avi_atlas.py`): elementu `<video>` nie da się przesuwać
    o klatkę indeksu, a puste wpisy indeksu AVI pokazują klatkę poprzednią, więc atlas trzyma
    różne klatki, a mapa prowadzi z numeru klatki strumienia do kafla. Build daje efektowi
    najbliższą kopię nazwy (`videoResolver`). FLOWERS.AVI (Dynamic Duo — 16 danjoe -stargazer)
    przyszedł 10.11 z wydania VD001 (Indeo 5, 160×120, 8 klatek; Wayback, wyżej przy imporcie).
    Nie ma tylko VISBOT.AVI (VISBOT — 01 intro): nie ma go w żadnym z 346 wydań — jak w AVS bez
    pliku, efekt nic nie rysuje. Wzorzec AVI nie pokaże (nie ma kodeków Video for Windows), więc
    sprawdzone są klatki w przeglądarce (danjoe: Fireworks, Firebottom, Sloxplode, Dance6)
    i przegląd 47 presetów (rysuje 46, czarny jest jeden z brakującym klipem);
  - **pozostałe:** OnBeat Clear, Add Borders, MultiFilter (chrome), Triangle, Text, Starfield,
    Dot Plane, Moving Particle. Add Borders (APE „Virtual Effect: Addborders”, 478 presetów) jak
    `e_addborders.cpp` z grandchild (odczyt jej binarki; `trans/addBorders.ts` z testem): góra
    i dół mają `size` % wysokości,
    boki `size` % szerokości (dzielenie całkowite), co najmniej piksel, `size` 1…50; do 09.11
    brany był za liczbę pikseli (DarK MatteR — Transform).

  Klatki, które komponent trzyma między klatkami, pochodzą z puli (`avsSupport.ts`). Rozmiar
  czcionki z Text build odczytuje z samego pliku `.avs`, bo webvsc go pomija. Przesunięcie Text
  (x i y w procentach) ma znak i liczy się jak w `r_text.cpp`: `(int)(przesunięcie · rozmiar /
  100)`; webvsc czytał je bez znaku, więc tekst przesunięty w lewo albo w górę wypadał za ekran.

  **Bump** jak `r_bump.cpp`: `fbout` zaczyna czarne, a liczą się tylko wiersze 1…h−2
  i kolumny 1…w−2, więc ramka szerokości piksela (AVS) zostaje czarna. Światło stoi w całych
  pikselach (`(int)(x·w)` przycięte do 0…w), odległość od niego też, a piksel, którego czterej
  sąsiedzi są czarni, zostaje czarny tylko wtedy, gdy głębia idzie z samej klatki (z bufora
  liczy się zawsze). „Old style” (x i y w procentach, presety bez tego pola) czyta konwerter
  (`oldStyle`); w obecnych paczkach wszystkie 106 efektów Bump ma nowy styl. Brightness liczy
  tabelami `r_bright.cpp` na całych poziomach, bez poprawki +0,001.

  **Starfield** jak `r_stars.cpp`: liczba gwiazd z `MulDiv` (zaokrąglona, wcześniej obcięta),
  prędkość i jej krok po beacie jako `float` z sumami w doublach, jak x87, a kolorowa gwiazda
  przez `BLEND_ADAPT` (górne półbajty szarości i koloru ważone w 16 krokach, do 240).
- **Klasyczne efekty AVS** (`render/Classic.ts`, `trans/Interferences.ts`, `trans/WaterBump.ts`),
  przeniesione z vis_avs 2.81d z tym samym stanem między klatkami, reakcją na beat i liczeniem
  (dzielenie i rzutowania jak w C, `float` tam, gdzie AVS go używał):
  - **render:** Simple (wszystkie tryby z `r_simple.cpp`, też wypełnione), Dot Grid,
    Oscilloscope Star, Ring (`r_oscring.cpp`; wcześniej odtworzony SuperScope'em, z innym
    środkiem kanałów i promieniem), Rotating Stars, Timescope, Bass Spin, Dot Fountain;
  - **trans:** Interferences (shader, liczby całkowite AVS), Water Bump (pole wysokości liczone
    na procesorze, losowe krople z `rand()` C; shader czyta piksel, który wskazuje pole).
    Interferences liczy kąt i wygaszanie jak 2.81: `PI` = 3.14159 i `status` jako float. Wzorzec
    (grandchild) bierze `M_PI` i double, więc rzadko kładzie warstwę piksel obok (Blood On The
    Motorway, VB178: pierwsza różnica w klatce 146, potwierdzona symulacją obu rachunków); tu
    wzorzec się myli.

  Wspólne rysowanie jest w `avsDraw.ts`:
  - `avsLine` to `line()` z `linedraw.cpp`: Bresenham AVS bez ostatniego piksela, szerokość
    i przycinanie;
  - piksele mieszają się jak `BLEND_LINE` (dziesięć trybów Set Render Mode, `g_blendtable`
    z jej 12 wyjątkami);
  - kilka zapisów w ten sam piksel: tryby, które się składają (replace, additive, maximum,
    minimum, subtractive 1, XOR), dają jeden zapis, pozostałe idą w przebiegach. Ponad 8
    przebiegów (gęste SuperScope'y z 50/50, odejmowaniem, mnożeniem albo „adjustable”) klatka
    wraca na procesor (`readPixels`), zapisy mieszają się po kolei, dokładnie jak w AVS, i wynik
    wraca jednym przebiegiem (Mr_Nudge — 01FireWorks: 3,75 zamiast 218 ms na klatkę);
  - Set Render Mode przekazuje też wartość „Adjustable”;
  - od 09.11 (runda 2) przebieg nie kopiuje już całej klatki: tryby, które blending GL liczy
    dokładnie na 8-bitowych kanałach (replace, additive, maximum, minimum przez
    `EXT_blend_minmax`, oba odejmowania), idą wprost do klatki; pozostałe (50/50, multiply,
    adjustable, XOR) kopiują do tekstury pomocniczej tylko prostokąt, w który ten przebieg pisze,
    i czytają z niej. Stara droga (kopia całej klatki) zostaje za `__avsPlotterDirect = false`
    do porównań;
  - od 10.11 odejmowanie 2 (źródło − klatka), jedyny bezpośredni tryb, który się nie składa, nie idzie
    już w przebiegach (po jednym na każdy zapis do najczęściej trafianego piksela, przy szerokich
    liniach tysiące): wszystkie zapisy idą jednym rysowaniem w kolejności AVS-a (GL miesza fragmenty
    jednego rysowania w kolejności punktów, a ten tryb potrzebuje tylko piksela klatki i zapisu, więc
    wynik jest ten sam), z przesunięciem `y · w + x` i kolorem 0xRRGGBB jako liczbami, które rozpakowuje
    shader wierzchołków (mnożenie przez 1/w zamiast dzielenia); `__avsPlotterAll = false` wraca do
    przebiegów. Tryby, które się składają, składają się dalej (to samo jednym rysowaniem wszystkich
    zapisów było przy szerokich liniach — Raz — Wireframe, Mr_Nudge — 05Mr DJ — wielokrotnie
    wolniejsze), ale złożone piksele bezpośrednich trybów też idą tymi dwiema liczbami na punkt zamiast
    pięciu liczonych na procesorze.
    Linie dają zapisy seriami (`plotRun`: kolumna albo wiersz szerokiej linii naraz);
  - od rundy 5 (10.11 wieczorem) plotter trzyma zapisy jako prostokąty jednego koloru (12 bajtów:
    x, y, szerokość, wysokość po 16 bitów i kolor 0xRRGGBB): szeroka linia daje prostokąt na każdą
    kolumnę albo wiersz, a prostokąt, który przylega do poprzedniego w tym samym kolorze, dołącza do
    niego — te same piksele i ta sama kolejność zapisów każdego piksela. Potem:
    - tryby, które blending GL liczy dokładnie (zastąp, dodaj, maksimum, minimum, oba odejmowania),
      to jedno rysowanie instancjonowane (`ANGLE_instanced_arrays`) prostokątów w kolejności AVS-a:
      GL miesza fragmenty jednego rysowania w kolejności prymitywów, więc każdy piksel dostaje swoje
      zapisy po kolei (Raz — Peace And Love pisze 59 mln pikseli na klatkę; składane zapis po
      zapisie na procesorze zajmowało ok. 480 ms);
    - w klatkę, którą trzyma seria na procesorze (Texer II albo Super Scope przed nim; tryby
      bezpośrednie do 2^20 zapisów), i przy 50/50, mnożeniu albo „adjustable” ponad `MAX_PASSES`
      przebiegów albo ponad 2^17 zapisów (`CPU_BLEND_WRITES`) zapisy mieszają się na procesorze
      arytmetyką `BLEND_LINE`, całym pikselem z tablic (`blendRectsCpu`), po kolei jak w AVS;
    - reszta (XOR, kilka przebiegów 50/50 …) idzie listami pikseli jak dotąd; dla 50/50, mnożenia
      i „adjustable” liczba przebiegów liczy się w tej samej pętli, która rozpisuje prostokąty
      (`expandCounted`).

    Bez `ANGLE_instanced_arrays` (albo na procesorze big-endian) tryby bezpośrednie idą listami
    pikseli, a bez `highp` w shaderach fragmentów (stare GPU telefonów) cały plotter zostaje przy
    listach: wysyłka prostokąta po serii (`cpuFrameRun.ts` `flushRows`) adresuje teksele przez
    `gl_FragCoord`, a w połowie precyzji powyżej ok. 1024 px trafia w sąsiednie. Przy wyłączonej
    szybkiej drodze plotter oddaje klatkę serii przed rysowaniem na GPU (Super Scope po Texerze II
    nie gubi rysunku); obie rzeczy z niezależnego przeglądu kodu. `__avsPlotterFast = false` na stronie testowej zostawia listy pikseli dla każdego
    rysowania (dawna droga, do porównań). Test `avsDraw.test.ts`: 20 000 losowych linii wobec
    dawnego `avsLinePixels`, zapisy z prostokątów wobec list pikseli w 3 000 losowych ciągach,
    przebiegi z `expandCounted` wobec `flushPixels`, `blendRectsCpu` wobec `blendLineCpu` we
    wszystkich trybach;
  - bufory wierzchołków wypełniane co klatkę (plotter, SuperScope'y i inne przez `webgl/Buffer.ts`)
    dostają `DYNAMIC_DRAW` (dane wpisane raz zostają `STATIC_DRAW`). Ze `STATIC_DRAW` przy każdym
    wpisie ANGLE na D3D11 zwalniał z każdym kolejnym presetem w tej samej stronie: po czterdziestu
    presetach `bufferData` brało ok. 125 ms na klatkę, a EL-vis — BlueSpectrum rysował 160 ms na klatkę
    zamiast 20 (the great escape: 1 600 zamiast 22). W odtwarzaczu, gdzie presety zmieniają się w jednej
    stronie, to był główny powód „wolnych” presetów; świeża strona tego nie pokazywała.

  To, co AVS liczył w pikselach okna (rozstaw Dot Grid, kolumny Timescope, Water Bump,
  przesunięcia Interferences, kropki, szerokość linii), działa w rozmiarze okna AVS (~480 linii)
  i jest skalowane. Do 480 linii daje to dokładnie klatkę AVS.

  Porównanie ze wzorcem przy 640×360 (izolowane presety):
  - Dot Grid, Water Bump, Interferences („replace”), Moving Particle i Rotating Stars w ciszy
    zgadzają się co do piksela;
  - Oscilloscope Star i Simple oscyloskop różnią się tylko pierwszą próbką.

  Wzorzec (grandchild/vis_avs) od 08.11.2026 wieczorem ma poprawione (opis w
  `scratch/avs-reference/README.md`, łatka `vis_avs-local-fixes.diff`):
  - dźwięk: najnowsze 576 próbek po kolei i bajty Winampa z tablicą `g_logtab`, jak u nas
    (wcześniej fala opóźniona o 447 próbek, próbka 0 nieruszana, widmo z przepełnionych tablic);
  - `rand` w kodzie to `rand()` C, jak w ns-eel 2.81 (był Mersenne Twister EEL2);
  - wywrotki (56 z 303 i 23 z 62 presetów) — cztery błędy pamięci, znalezione
    AddressSanitizerem MSVC i śladem stosu z symbolami:
    - `getosc` czytał 1152 · 1152 bajtów za tablicą visdata (indeks na złym wymiarze);
    - Movement „source mapped” z 50/50 mieszał z wskaźnikiem przesuniętym już za klatkę;
    - asembler Texera II pod MSVC: trzy `push` na cztery `pop` w wierszu (rejestry wywołującego
      zniszczone), 8-bajtowe `alpha` zapisywane przez 4-bajtowy wskaźnik i `mm6` niewypełniony
      w trybie „adjustable”;
  - środek widma na znakowych `char` w Simple, SuperScope i Ring (był bez znaku), Timescope
    zawsze z lewego widma, Bass Spin z przełącznikami lewy/prawy na swoich miejscach, Picture
    z próbkowaniem `StretchBlt`;
  - Starfield jak `r_stars.cpp` (liczba gwiazd z `MulDiv`, prędkość jako `float`; `max()`
    z `platform.h` obcinał ją do całości);
  - bufory globalne jak `getGlobalBuffer` z `rlib.cpp`: istnieją dopiero po zapisie Buffer Save,
    a wcześniej Dynamic Movement (z kodem), Bump i listy mieszające przez bufor nic nie robią;
    wzorzec dawał je zawsze;
  - mysz na środku okna (`getkbmouse` daje 0, jak u nas); w lewym górnym rogu Hboy — Orifice
    pokazywał ukrytą nakładkę z wykresami;
  - (09.11) dźwięk już w klatce 1 (bajty zgadzają się w 300 z 300 klatek); linie ukośne mieszają
    z pikselem docelowym (było (0, 0)); Interferences additive i 50/50 z klatką; tablica kolorów
    Dot Fountain ze znakiem; Mirror przepisany z `r_mirror.cpp`; Dynamic Movement mieszający MMX;
    zmienne Dynamic Movement, DDM i Color Modifier przed kodem init (init szedł z w = h = 0);
    Dynamic Shift trzyma x i y między klatkami (zerował je co klatkę); kolor SuperScope i Simple
    od pozycji 0 (była niezainicjowana); tryb linii „adjustable” waży klatkę przez v, a kolor
    przez 255 − v, jak `BLEND_ADJ_NOMMX(*fb, color, v)` w `BLEND_LINE` (było odwrotnie); lista
    główna zaczyna każdą klatkę od trybu linii 0, jak `r_list.cpp` (Set Render Mode z końca
    klatki sięgał do następnej).

  Wzorzec nadal różni się od AVS 2.81 w kilku miejscach, więc jego obraz to dowód, nie wyrocznia:
  - EEL2 zamiast ns-eel: grupuje działania inaczej (Orifice), kompiluje kod, którego 2.81 nie
    przyjmował (niezamknięty nawias w Inca), inaczej czyta `.` (VisKey), a `&` i `%` obcina do
    zera zamiast zaokrąglać jak `fistp` w 2.81 (Marco — A Droug Called Music: `-2.6 & -1.2` to
    tam -2, w 2.81 -3; Spectral Mishap i Speed Merchant: `7.6 % 3` to tam 1, w 2.81 2;
    `and_probe.py`, `mod_probe.py`);
  - nie ma Text (wyłączony w grandchild) ani FyrewurX (APE bez źródła; u nas port binarki, niżej);
  - Grain losuje z własnego generatora (celowo; u nas na stronie testowej ten sam).
- **Bufory globalne jak w AVS:** osiem buforów. Numery spoza zakresu, np. 40 albo 254, są
  przycinane tak jak w AVS. Dynamic Movement i Bump mogą czytać zapisany bufor; jeśli nikt go
  nie zapisał, nic nie robią. Tak samo Buffer Save w trybie „restore”: `r_stack.cpp` przydziela
  bufor przy każdym innym trybie, a sam odczyt nieprzydzielonego nic nie robi (u nas czyścił
  klatkę — Tonic — Bla-Bla-X2). Effect List obsługuje tryby „Buffer”, „Adjustable” i „Minimum”
  oraz `beat`, `enabled`, `clear`, `alphain` i `alphaout` z własnego kodu. Jak w `r_list.cpp`
  kod listy biegnie przed sprawdzeniem, czy jest włączona, więc lista wyłączona w ustawieniach
  może włączyć się sama. Presety rysują tak raz, na starcie i po zmianie rozmiaru, wzór do
  bufora: `enabled=1-equal(lw,w)*equal(lh,h)`. „Włącz na beat” dotyczy tylko listy
  wyłączonej.
- **Nowy preset zaczyna od obrazu poprzedniego** (od 10.11.2026), jak w Winampie: AVS 2.81 ma
  jeden framebuffer na wszystkie presety. Bez przejścia nowa lista główna rysuje w klatce, którą
  zostawił poprzedni preset (`r_transition.cpp`), z przejściem obie zaczynają od jej kopii,
  a `r_list.cpp` czyści ją tylko przy „Clear every frame”. Presety-części, np. S_KuPeRS — AVS
  Parts („DynMov …”, „Mov …”: sam ruch, wg readme paczki do wstawiania w swój preset), poruszają
  więc obraz, który zastały; u nas startowały od czerni i były czarne. Dwa z pięciu „DynMov”
  i dwa z ośmiu „Mov” mają „Clear every frame” — te są czarne także w Winampie.
  - `Main.loadPreset(preset, { carryFrame: true })` (tak woła odtwarzacz, `avs/index.ts`) zabiera
    lista główna ostatnią klatkę (`EffectList.takeFrame`, tekstura wyjęta z `TextureSetManager`,
    bez kopiowania), a nowa lista główna rysuje ją w pierwszej klatce zamiast czyścić. Preset,
    który nie zdążył narysować klatki (czeka na bitmapy), oddaje dalej obraz poprzedniego; zmiana
    rozmiaru zaczyna od czerni, jak nowy framebuffer AVS-a.
  - Bez `carryFrame` (strony porównań i przeglądu) preset zaczyna od czerni, jak świeżo
    uruchomiony AVS, więc porównania ze wzorcem i wykrywanie czarnych presetów się nie zmieniają.
  - Sprawdzone 10.11 ze wzorcem: `harness/ref_render.c` wczytuje drugi preset przed klatką
    `AVS_SWITCH_AT` (`AVS_SWITCH_PRESET`), a strona porównawcza przełącza przez adapter
    odtwarzacza (`vis.choose`), ten sam dźwięk i beaty. SScope x=sin(r)2+cos(t)2 przez 120 klatek,
    potem DynMov x=(if(what,x,x-(0.1inv))), Mov d=atan(d)-y albo DynMov d=bx-sin(ax)-dx-0.1
    (z „Clear every frame”): klatki 1–300 identyczne co do bitu w 640×360; części poruszają
    gwiazdę scope'a przez 1–3 s, aż zniknie, a ta z czyszczeniem jest czarna od pierwszej klatki
    (arkusze w `scratch/renders/avs-carry/`).
- **Beat** jak w AVS: średni poziom wobec opadającego szczytu. Próg głośności podąża jednak za
  głośnością utworu, więc ciche nagrania też dają beat.
- **Poprawione błędy webvs:**
  - zerowanie pól klas (osobny `tsconfig` z `useDefineForClassFields: false`);
  - indeksy tekstur po usunięciu bufora;
  - `%` i `&&` w GLSL;
  - ujemne bufory SuperScope;
  - powtórzone pozycje w ColorMap;
  - mnożenie `×256`, przez które każdy tryb Multiply dawał biel;
  - Mosaic, Moving Particle i Color Clip w jednostkach AVS;
  - nazwy kluczy i cykli ColorMap;
  - reset stanu GL po klatce, która rzuciła wyjątek;
  - pętla sprzężenia WebGL, przez którą klatka zapamiętana w Effect List (Water, Video Delay)
    zostawała czarna;
  - SuperScope zmieniający znak `y` w miejscu (psuło kod czytający poprzedni punkt);
  - `ShaderProgram.run` po `copyOver()` wiąże `u_srcTexture` jeszcze raz. Kopiarka zostawiała
    jednostkę tekstury 0 pustą, więc mieszanie w shaderze (Maximum, 50/50, XOR, Multiply,
    Minimum z Set Render Mode) czytało czerń i działało jak zastąpienie;
  - `ShaderProgram.run` ustawia `u_resolution` także przy rysowaniu do bufora (bez zestawu
    tekstur). Bez tego Buffer Save „co drugi piksel” niczego nie zapisywał (Formula 223277 biała).

  Kod, którego AVS 2.81 nie umiał skompilować, nic nie robi, i to całą sekcją: `NSEEL_code_compile`
  ciął tekst na każdym `;` (nawias nie chroni) i gdy choć jeden kawałek nie przeszedł przez
  gramatykę `cal.y`, oddawał pusty uchwyt (`avs/ns-eel-syntax.ts`: leksyka z DFA `nseel-lextab.c`,
  `.` to 0, `0FFh` to 4080; funkcje 2.81 z liczbą argumentów; `eel.ts` z `strict`). W sześciu
  paczkach AVSociety tak wypada 28 sekcji w 24 presetach (`x=x/2=30-5+y`, `: r=r+d*d`, dwie
  instrukcje bez średnika); wcześniej liczyliśmy ich czytelne części. Efekty, które w AVS
  sprawdzały uchwyt, patrzą na `codeInst.compiled`: Dynamic Shift bez kodu init nie ustawia x,
  y, alpha, Movement z kodem, który się nie skompilował, to tożsamość bez subpikseli, SuperScope
  bez kodu per punkt nic nie rysuje. Liczby po tym sprawdzeniu (`nsEelNormalize`) piszemy
  cyframi z kropką (`plainNumber`): JavaScript zapisywał 0.0000001 jako `1e-7`, czego czytnik
  EEL za nim nie bierze, i do 11.11 przepadała cała sekcja, choć AVS ją kompilował. Tak Texer II
  w obu „Theory Of Pretty Much Everything” (effekthasch, VB234, i retusz framey'a, VB235:
  `size = osize/(prspctv+0.0000001)`) nie liczył kodu klatki i obraz był czarny; łącznie
  16 presetów z liczbą poniżej 10^−6 w kodzie.

  **Notatki autorów.** Bajt od 0x80 w górę to dla leksera ns-eel ujemny `char`, czyli koniec
  tekstu: reszty kawałka nie czyta. Tak pisano notatki: ALT+0160 (spacja niełamiąca), `£`, `¤`,
  `·`, `©` po kodzie albo jako osobny kawałek. Kawałek, który jest samą notatką, pomijamy, choć
  według źródeł 2.81d psułby całą sekcję (`cal.y` chce wyrażenia; sprawdzone na tablicach
  parsera): UnConeD, Jheriko, Tuggummi, Raz, PAK-9 i inni budowali wokół takich notatek całe
  sekcje (`©;` między częściami kodu klatki w Whacko AVS V — Anemone, `·hyperboloid 1;`
  w Jheriko — Plasma Storm), więc AVS, w którym je pisali, je pomijał; wzorzec też. Spacja
  niełamiąca to bajt 0xA0, nie biała spacja: nie obcina jej ani podział na kawałki, ani
  `compileExpr` (`String.trim` to robił). Tak ożyło 1 983 sekcji w 261 presetach (260 z importu
  VISBOT; część dawała wcześniej czarny ekran, np. Tuggummi — Sound Pyramid).

  Dziś w 13 965 presetach z `vendor` martwych zostaje 550 sekcji w 382 presetach (bez tekstu
  wbudowanych efektów Movement, którego AVS nie kompilował): niezamknięte nawiasy, przypisania
  w środku wyrażeń, nieznane funkcje (`mb`, `initregs` — makra bez swojego `#define`) i inne
  błędy, z którymi presety wyszły.

**Presety** leżą w `frontend/vendor/avs-presets/` (ignorowane przez gita, jak Font Awesome Pro).
Każdy folder najwyższego poziomu to paczka w panelu, jego podfoldery to kategorie, głębsze to
grupy (jak w MilkDrop). Build (`scripts/avs-presets.mjs`) konwertuje każdy `.avs` do JSON-a
i pakuje je paczkami: jeden indeks `assets/avs/index-<hash>.json` (paczka → grupy → nazwa
i numer kawałka) i kawałki `<paczka>/<hash>.json` po najwyżej 40 presetów albo 192 kB, ładowane
na żądanie (8 ostatnich w pamięci, `chunkLoader`). Konwersje leżą w
`node_modules/.cache/avs-presets` pod sha256 pliku, więc przebudowa bez zmian w presetach trwa
ok. 6 s zamiast 13 s. Identyfikator presetu zostaje „Nazwa — paczka / foldery”, więc zapisane
wybory dalej działają. Panel ma pule jak MilkDrop: „Wszystkie paczki” (domyślnie) albo jedna
paczka i jej kategorie (`avs/packs.ts`, testy w `packs.test.ts`); preset zmienia się
asynchronicznie, z przejściem, gdy jego kawałek dojdzie. Plik, którego nazwa zaczyna się od
kropek („... and what become.avs”), to preset, nie plik ukryty. Konwerter to webvsc 2.3.0 (MIT)
skopiowany do `scripts/webvsc/` z poprawkami:
- numery buforów;
- tryby „Minimum”;
- przesunięte o bajt pola Movement;
- `effectId` i bit „source mapped na beacie”;
- pola Oscilloscope Star, Interferences, Dot Plane i Dot Fountain (liczby ze znakiem, zapisany
  obrót) oraz tryb „Minimum” w Set Render Mode;
- kolejność kodu Bump: `r_bump.cpp` zapisuje najpierw kod na klatkę, potem na beat, a webvsc
  czytał je na odwrót. Wszystkie 106 Bumpów (101 presetów) ma kod na klatkę, zwykle domyślny
  `x=0.5+cos(t)*0.3; …; t=t+0.1`, więc światło ruszało się tylko na beat, a kod na beat 18 z nich
  szedł w każdej klatce;
- blok kodu Effect List („AVS 2.8+ Effect List Config”) rozpoznawany po nazwie, także z innym
  numerem niż zwykły (4 presety importu traciły kod listy);
- przesunięcia Text jako liczby ze znakiem (1 236 efektów Text w imporcie).
- ustawienia Effect List czytane jak `r_list.cpp` (10.11): efekty zaczynają się zaraz za tym, co
  się zmieściło w rozszerzonym bloku. Lista bez rozszerzonych ustawień (bajt rozmiaru 0, nullsoft —
  lone — Shirka's eye) czytała się 4 bajty obok, jako śmieci („APE bez nazwy”), a w 1 035 listach
  z blokiem 28-bajtowym „włącz na beat” brało liczbę z numeru pierwszego efektu (w 28 presetach
  wychodziło włączone, choć AVS tego pola tam nie czytał).

Bez tego folderu build ma tylko paczkę „mscopes” (niżej).

**Import z archiwum VISBOT** (visbot.net/archive, 09.11.2026). Archiwum to zbiór paczek AVS
wydawanych przez lata; uznane za wiarygodne jako źródło danych, ale nic z niego nie było
uruchamiane: archiwa i instalatory czyta Python (`python -I`) jako bajty, a do `vendor` idą tylko
pliki z nagłówkiem presetu AVS i obrazki, które któryś preset wymienia. Spis: 88 folderów
autorów, 569 paczek (536 `.7z`, 33 `.zip`, 73,6 MB) i `default_presets` Nullsoftu. Formaty
(narzędzia w `scratch/avs-reference/nsis/` i `scratch/avs-reference/visbot/`): 7z z filtrem
BCJ2 (port `Bcj2_Decode`, CRC sprawdzane), NSIS 2 (solidny i niesolidny: LZMA, zlib, bzip2 NSIS,
też wariant z bet 2.0; uszkodzony blok wypada, reszta zostaje), nagłówki alf i bet NSIS 2.0
czytane po danych, NSIS 1.0x–1.9x, PiMP (1999–2000), samorozpakowujące się zipy i instalatory
w instalatorach.
- Z 17 515 presetów w paczkach zostało 13 600: 2 399 to ten sam plik w innej paczce (zostaje
  w najmniejszej, zwykle w oryginale przed kompilacją), 1 515 powtórzeń w tej samej paczce,
  363 już były w sześciu paczkach AVSociety, a jeden plik jest uszkodzony w archiwum (Atero —
  Trans - Unique Tone: każdy bajt NUL zamieniony w spację, AVS też go nie przeczyta).
- Pominięte: 963 APE, 692 DLL i 509 EXE z instalatorów (nigdy nie wyjęte ani uruchomione;
  osobnych paczek z samymi APE w archiwum autorów nie ma), opisy (`.diz`, `.txt`, `.htm`),
  `vis_avs.dat` (stan startowy AVS, nie preset), dźwięk i wideo (`.wav`, `.avi`, `.mp3`),
  skórki Winampa (`.wsz`), 61 czcionek `.ttf` (Text podaje nazwę czcionki systemowej, build ich
  nie używa) i 377 bitmap, których żaden preset nie wymienia.
- Dwie paczki, których import 09.11 nie otworzył, doszły 10.11.2026 (55 presetów; narzędzia
  w `scratch/avs-reference/visbot/recover-1011/`):
  - HuRriC4nE — Pack1: archiwum na serwerze jest ucięte (270 000 z 345 268 bajtów, bez nagłówka
    7z). Strumień instalatora (BCJ x86 + LZMA, znaleziony po swoim miejscu w danych) daje 78%
    instalatora NSIS, a jego strumień solid — cały skrypt i 17 z 20 plików: wszystkie 10 presetów
    i 2 bitmapy, których używają (brakuje dźwięku i wtyczki ekranu powitalnego).
  - Nic01 — Nic03 - 2D vs 3D: stary instalator Clickteam (`InstItClass`): łańcuch bloków
    `[u16 id][u16 flagi][u32 rozmiar]` (spis plików `0x1243`, pliki `0x7f7f` — każdy osobnym
    strumieniem) i odmiana deflate Marka Adlera: 4-bitowy nagłówek bloku (typ 5 stałe kody,
    6 dynamiczne, 7 bez kompresji; bit 3 — ostatni), kody długości w kolejności 18, 17, 16,
    0…15, blok bez kompresji bez NLEN. Odczytane z kodu instalatora statycznie i napisane od
    nowa w Pythonie (`clickteam_inflate.py`); 46 plików zgadza się z rozmiarami ze spisu: 45
    presetów i deinstalator (pominięty).
- Wydania samego VISBOT-a (serie VA, VB, VC, VD, VE, 10.11.2026): archiwum autorów ma ich tylko
  część (VB200, VE002–VE009), a `visbot.net/files/packs` już nie odpowiada. Kopie z 2023 r.
  w Wayback Machine (spis CDX: 346 wydań, wszystkie pobrane za zgodą właściciela) dały 6 245
  presetów, z czego 5 080 to bajt w bajt presety, które już były (zwykle te same paczki u autorów
  albo w VB200), a 1 165 doszło jako `visbot/<wydanie>/…` w 124 folderach (wydania bez nowych
  presetów nic nie dodają). Do tego flowers.avi z VD001 (`vendor/avs-videos`, niżej przy AVI).
  - 315 instalatorów to NSIS 2.46.3/2.46.5 „Unicode” Jima Parka (napisy UTF-16, kody
    0xE000–0xE003), 8 to NSIS 3.08 (UTF-16, kody 1–4), jeden NSIS 3.05 ANSI (kody 1–4 w bajtach) —
    VISBOT przepakował tak stare wydania. Czytnik (`nsis/extract_all.py`) brał je za ANSI NSIS 2
    i gubił nazwy plików; teraz rozpoznaje wariant po kodach w tabeli napisów (pary kod + liczba
    z ustawionymi wysokimi bitami albo kody Parka; pomiar na wszystkich 346 w `codestats.py`).
    Instalatory ANSI NSIS 2 dają te same pliki co przedtem (porównanie list wszystkich paczek).
  - Narzędzia, spis i logi: `scratch/avs-reference/visbot/recover-1011/wayback/`
    (`fetch_wayback_packs.py`, `stage_wayback.py` — ten sam układ i `SOURCE.txt` co import 09.11).
- Paczki leżą jako `<autor>/<paczka>/…` (AVSociety obok sześciu, które były), każda
  z `SOURCE.txt`: adres, sha256 archiwum, typ instalatora, ile presetów dodano i dlaczego czegoś
  nie. Presety są dziełem autorów i żadna licencja nie pozwala ich rozpowszechniać, dlatego
  folder zostaje poza gitem.

**Efekty i presety z mscopes** (`webvs/mscopes/`, BSD-3, licencja `LICENSE-mscopes.txt` obok).
To port „nowoczesnej warstwy” [mscopes](https://github.com/GarAlex/mscopes) (C++/Metal, macOS)
jako komponenty AVS. Nazwy mają przedrostek `Mscopes`, bo AVS ma własne APE „Fluid” i „Particle
System”, a webvsc tak je nazywa.
- **Efekty GPU:** kernele Metal przepisane na GLSL z tymi samymi parametrami i wartościami
  domyślnymi. Są to Bloom (piramida poświaty), Kaleidoscope, RgbSplit, ToneMap, Vignette,
  Shockwave, Glitch, Streaks, Lens, RadialBlur, NeonEdges, Duotone, Shimmer, CRT i Trails.
- **Rysowane:** Particles, Vectorscope, Scope, Starfield, Ring. Wygładzanie mscopes (pokrycie
  piksela przez linię) liczy shader fragmentów, a światło dodaje się z obcięciem do bieli.
- **Symulacje:** FlowParticles, Fluid (stable fluids) i ReactionDiffusion (Gray-Scott).
  - Stan cząstek leży w teksturach float.
  - Gradienty szumu z haszu mscopes liczy procesor, bo GLSL ES 1.00 nie ma liczb całkowitych.
  - Bez tekstur float te efekty nic nie rysują.
- **PixelShader:** skrypt per piksel tłumaczony z EEL do GLSL z semantyką mscopes (`noise`,
  `hsv`, `getr/g/b`, `frac`, `lerp`, `clamp`, `smoothstep`).
- **Wbudowane efekty**, z których składają się presety mscopes: FeedbackWarp, Blur, ColorMap,
  Grain.

Kontekst webvs to WebGL 1, więc shadery są w GLSL ES 1.00. Przejście na WebGL 2 zmieniłoby
rozszerzenia, na których stoją Movement i Dynamic Distance Modifier. `prev` z mscopes (końcowy
obraz poprzedniej klatki) to kopia tekstury listy robiona na początku klatki (`host.ts`), tylko
dla list z Trails albo FeedbackWarp. Preset z `"floatFrame": true` dostaje klatkę w half-float,
jak float framebuffer mscopes (`TextureSetManager`, piąty argument; `mscopes/gl.ts`). Zwykłe
presety AVS mają dalej 8 bitów.

**Analiza dźwięku mscopes** (`analysis.ts`) to port `Analyzer`, `BeatDetector`, `Features` i FFT:
- widmo, beat i tempo;
- 32 pasma z własnym wzmocnieniem oraz `level`;
- kick, snare i hat ze strumienia próbek (ile przyszło od poprzedniej klatki, mówi zegar
  AudioContext).

Liczy się tylko dla presetów, które jej używają. Test `analysis.test.ts` przenosi testy mscopes
na syntetycznej perkusji. **Zmienne skryptów** `kick`, `snare`, `hat`, `onset`, `level`,
`bass_att`, `mid_att` i `treb_att` działają w każdym kodzie AVS (`audioVars.ts`, wpięte
w `compileExpr`). Jak w mscopes, preset, który sam przypisuje taką nazwę, zachowuje własną
zmienną. Żaden z obecnych presetów tych nazw nie używa.

**Paczka „mscopes”:** 17 wbudowanych presetów (Classic Tunnel … Aurora) przepisanych
z `core/effects/Presets.cpp` do `mscopes/presets.json`. `avs-presets.mjs` dodaje je do każdego
builda jako „Nazwa — mscopes”.

**Stan (09.11.2026; 10.11 doszło 55 presetów dwóch odzyskanych paczek i 1 165 z wydań VISBOT —
panel ma 15 202):**
- 13 982 presety w 96 paczkach: 365 z sześciu paczek AVSociety (Back2Future, B2F_Originals,
  ninja_avs, Renaissance, 8_ronin, Anthology), 13 600 z importu VISBOT i 17 mscopes. Nowe 55
  (HuRriC4nE — Pack1, Nic01 — Nic03 - 2D vs 3D) przeszły ten sam przegląd: wszystkie się
  wczytują i liczą 90 klatek bez wyjątku, żaden nie jest czarny ani stojący.
- Nowe 1 165 z wydań VISBOT (10.11, `visbot/<wydanie>/…`) tak samo: wszystkie się wczytują
  i liczą 90 klatek bez wyjątku, nieznanego komponentu i komunikatu; 1 133 rysuje i się rusza,
  15 stoi (wzory; dwa prawie białe także we wzorcu), 17 czarnych. 22 czarne i prawie białe
  porównane ze wzorcem (640×360, klatki 90 i 300, świeży start): 7 takich samych we wzorcu,
  8 rysuje jak wzorzec (później niż okno przeglądu albo z drobną różnicą), a 7 różniło się
  wyraźnie — przyczyny i poprawki 11.11: Triangle, krawędzie Convolution Filter, „adjustable” 255,
  liczby w kodzie, `gettime` (punkty wyżej; CHANGELOG 11.11.2026 (1)).
- Przegląd wszystkich 15 202 po poprawkach z 11.11 (1) i (2) (320×180, 90 klatek, ustalony zegar
  i `Math.random`, wasm od pierwszego uruchomienia; ta sama strona co przegląd bazowy z 10.11): 0 wyjątków
  i 0 komunikatów. W 14 027 wspólnych z przeglądem bazowym czarnych 160 → 158: 5 zaczęło rysować,
  3 ściemniały w klatce 90 — Userkaft — Another to the angel Marion Raven (czarny także we wzorcu,
  z nim teraz zgodny w 99 %) i dwa presety troubleshootera z FyrewurX (TS — Dance Or Die Intro
  (psychic version), TS — MasterHit (Hit Me Mix)): FyrewurX przenosi stan przez całą stronę, a nowa
  lista zmieniła kolejność presetów w porcjach; w świeżej stronie rysują (wzorzec nie ma FyrewurX ani
  Text, więc tam są czarne). Skrót klatki 90 różny w 3 133 z 14 027 — presety z Triangle, Convolution
  Filter, listą „adjustable”, `gettime`, liczbami poniżej 10^−6 i ruchomym Grain. Nowe 1 171:
  0 wyjątków i komunikatów, 15 ciemnych w klatce 90. Cztery presety przekroczyły w równoległym
  przebiegu limit czasu; pojedynczo liczą 300 klatek w 0,6–0,9 s i zgadzają się ze wzorcem
  w 99,3–100 % (Runar — 20 Winds of Erazemia [X0R m1x], unripeLemon — acid fun, yathosho — glibnitz
  (deleted reconstructed), Degnic — I dunno).
- Przegląd importu w przeglądarce (headless Chrome, każdy preset: wczytanie, kompilacja, 90
  klatek od 1:00 przy 320×180, pomiar obrazu; `scratch/avs-reference/visbot/audit/`): wszystkie
  13 600 wczytują się i liczą bez wyjątku, 13 443 rysują obraz. Czarnych zostaje 157:
  - 42 mają komponent, którego nie mamy (niżej);
  - 79 jest czarnych także we wzorcu (klatki 90 i 300; Jheriko — 01 - Intro zgadza się z nim
    w klatkach 150 i 300 co do piksela);
  - 18 rysuje się jak we wzorcu przy 640×360 i 300 klatkach (czarne tylko w oknie przeglądu);
  - 15 rysowało tylko we wzorcu, choć cały ich kod się kompilował — po rundzie 2 rysują
    wszystkie, a 14 zgadza się ze wzorcem (niżej);
  - 3 bez porównania: dwie nazwy spoza ASCII (micro-d), których wzorzec nie otwiera, i JjcL237 —
    The SurReal (wzorzec nie dał klatek) — porównane w rundzie 2 (niżej).

  Sześć starych paczek i mscopes: 379 z 382 rysuje; czarne w oknie przeglądu są Hboy — Orifice
  (tabela niżej), Nixa — Dynamic Julia IV - itself i Alchemist — Forever Star.
- Komponenty, których do rundy 2 nie było (presetów importu → gdzie są teraz; „źródło” to
  opublikowany kod, „binarka” to port ze statycznego odczytu wtyczki z paczek VISBOT):

  | komponent | presety | źródło | teraz |
  |---|---|---|---|
  | SVP Loader (Sonique): voronoi 30, ball 16, miffo 6, xoo 6, smear 5, starwave 2, blaze.uvs 2, liquid 2, beatpipe.uvs 1 | 65 | nie | binarka, `vendor/avs-apes` (9 portów) |
  | AVI | 47 | tak (`r_avi.cpp`) | silnik; klipy z paczek w `vendor/avs-videos` (FLOWERS.AVI od 10.11), bez VISBOT.AVI (1 preset) |
  | Trans: Normalise | 38 | tak (grandchild) | silnik; w `vendor/avs-apes` port binarki, który go zastępuje (zaokrąglenia oryginału) |
  | Misc: Buffer blend | 30 | nie | binarka, vendor |
  | Shreyas uberCLS v2.00 | 11 | nie | binarka, vendor |
  | Winamp 3DAPE v1 | 11 | nie | binarka, vendor (siatki `.asc` z paczek) |
  | Flock Off | 10 | nie | binarka, vendor |
  | VisFrac v1.0 | 10 | nie | binarka, vendor |
  | Winamp Starfield/Text/Mosaic/Bump v1 | 8/5/4/1 | tak (efekty 2.81) | silnik: AVS uruchamiał je jako własne efekty (`NamedApeToBuiltinTrans`) |
  | Nullsoft TV v1 | 6 | nie | binarka, vendor |
  | GeissFluid | 6 | nie | binarka, vendor |
  | Virtual Effect: Screen Reverse | 4 | nie | binarka, vendor |
  | Camillo Plasma: BOX | 3 | nie | binarka, vendor |
  | Tentacles 3D, Amoeba | 2 i 2 | nie | binarka, vendor |
  | Holden05: Multi Delay | 2 | tak (`r_multidelay.cpp`) | silnik |
  | Metaballs 3D | 1 | nie | binarka, vendor |
  | Virtual Effect: Negative Strobe | 1 | nie | binarka (10.11, `NegativeStrobe.zip` ze strony autora goebish.free.fr/vfx, pobrany przez właściciela), vendor: odwraca kolory klatki przez `speed` klatek z każdych 2·`speed` + 1, niezależnie od muzyki |
  | SetLwidth | 1 | nie | brak: binarki nie ma w paczkach, w zbiorach APE z forum Winampa (2022–2023) ani w kolekcjach w sieci; wtyczki szukał też grandchild |
  | Slideshow | 1 | nie | brak i bez sensu: preset (Magic-X — Tournament-Devil) pokazuje obrazki z dysku autora (`D:\Max Payne\MAX-FX Tools\…\Fire\Reel`), więc i w Winampie u kogokolwiek innego nic by nie wyświetlił; sama wtyczka jest w sieci (slideshow108.exe, 2002) |
  | APE bez nazwy | 1 | — | to był błąd konwertera (lista czytana 4 bajty obok; od 10.11 poprawione, lone — Shirka's eye ma 6 Moving Particle i inne efekty AVS) |
  | Texer (pierwszy) | 308 | tak (grandchild) | silnik (wcześniej źle przekładany na Texera webvs) |

  Czego z binarek nie dało się odtworzyć, opisują notatki `scratch/avs-reference/apes/<wtyczka>.md`
  (sekcje „not recovered”): w większości ostatni bit `fsin`/`fcos`/`pow` x87 wobec `Math`,
  ziarno `GetTickCount()` i stan `rand` per wątek, tekstury Liquid z katalogu Winampa, napis GDI
  w smear (przybliżony canvasem), ścieżki 3DNow!/MMXEXT VisFrac. Wzorzec tych wtyczek nie zna,
  więc porty sprawdzają testy (204 w `vendor/avs-apes`) i obraz w przeglądarce (każdy rysuje).
- **FyrewurX** (APE „FunkyFX FyrewurX v1”, 522 presety, 1 129 wystąpień; 10.11.2026): do tej pory
  odtworzenie z wyglądu (pomarańczowe kropki na każdy beat), teraz port `fyrewurx.ape` z paczki
  VISBOT ishan/Rocky_AVS_II (`vendor/avs-apes/fyrewurx.ts`, 11 testów; notatki z adresami
  w `scratch/avs-reference/apes/fyrewurx.md`; plik pobrany, czytany statycznie i usunięty). Wtyczka
  trzyma szczyty widma (576 pasm, spadek 0,4 na ms) i na beat, nie częściej niż co 100 ms, gdy
  poziom pasm 0…100 wobec poprzedniej klatki przekracza próg, wypuszcza w losowym miejscu do 300
  iskier (najwyżej 1 000 naraz): kąt z koła 2048 kroków (π jako 3.1412789f), prędkość do 180 px/s,
  życie 750–1 250 ms, drganie ±½ piksela co klatkę; każda iskra to kwadrat 3 × 3 w kolorze
  z konfiguracji (tego odtworzenie nie czytało), dodany z nasyceniem i gasnący liniowo. Czas to
  `timeGetTime()` (port dodaje stały „czas od startu systemu”, żeby pierwszy beat miał zapas 2 s jak
  w Winampie). Liczy w pikselach klatki, więc jak inne efekty pikselowe biegnie w rozmiarze okna AVS
  (do 480 linii co do bitu, wyżej skalowany). Nie odtworzone: nic z tego, co się wykonuje (martwe
  tryby emitera i dialog pominięte). Przegląd 522 presetów (320×180, 90 klatek): wszystkie się
  wczytują i liczą, bez ostrzeżeń; czarne 4 (2 były czarne i wcześniej, 2 rozjaśniało odtworzenie).
  Próbka 43 presetów ze wzorcem z wyciętym FyrewurX (wzorzec go nie ma): 40 zgodnych, mediana 0,0
  (niezgodne: dwa z Text i TS — Magic Chords III (3D-Now! mix): bisekcja wskazała Bump przy
  identycznym wejściu, a wzorzec rozjaśnia w nim piksele, których czterej sąsiedzi są czarni, czego
  `r_bump.cpp` nie robi; nasz wynik zgadza się co do piksela z portem `r_bump.cpp` w numpy — różnica
  po stronie wzorca).
- Próbki importu ze wzorcem (klatki 150 i 300, 640×360): losowa (40, ziarno 20261109, najwyżej
  dwie na autora, bez nieobsługiwanych komponentów) 38 z 39 zgodnych, mediana 0,2; presety
  z notatkami 13 z 16, mediana 0,2; presety czytane jako EEL2 6 z 8, mediana 1,0. Niezgodne to
  chaotyczne rozejście sprzężeń (b) albo różnice EEL2 we wzorcu (a); w jednym (micro-d — chroma
  coma, AVS Trans) obraz jest jaśniejszy niż u nas.
- Runda 2 (wieczór 09.11, bisekcja w obu silnikach, `scratch/avs-reference/README.md`):
  - 15 czarnych tylko u nas: rysują wszystkie, 14 zgodnych — 10 z wynikiem 0,0 (Broken Mirror,
    oba girlmiracle, Fat Osc, Starfoam, Transform i inne), 4 do 0,6 (Atero — Neon Dreams 0,6).
    Przyczyny w silniku: pola kasowane po `init()`, mieszanie linii w Clear Screen, `d`/`r`
    Dynamic Movement, zakres `sin`/`cos` x87, procenty Add Borders, zegar `gettime`, MMX-owy
    `BLEND_ADJ` list mieszających przez bufor (wyżej). DarK MatteR — Transform różnił się tylko
    przez wzorzec, który dostawał
    Acid.bmp innej paczki (z jego własnym 0,0). skB1 — spirit realm (37,5): EEL2 wzorca czyta
    `i*pi*99%3` jako `i*pi*(99%3)`; z nawiasami, które daje 2.81, wynik 4,4.
  - 3 bez porównania: sound cruiser i octopus skin (kopie z nazwami ASCII) 0,1; The SurReal —
    wzorzec pada przy wczytaniu drugiego Convolution Filter (7×7 jedynek, dzielnik 59), więc
    porównane są pierwsze dwa komponenty i wewnętrzna lista: 7 wariantów, wszystkie 0,0.
  - Próbka nowych komponentów (27 presetów): Texer 12 z 12 (trzy dopiero z nieskompresowanymi
    kopiami bitmap RLE8 `whacko6-05/07.bmp`, których loader BMP wzorca nie czyta, a GDI w AVS
    czytał), Normalise 5 z 6, Multi Delay 1 z 1, AVS Trans 7 z 8; mediana 0,2. Niezgodne:
    GC — b0rk 3n' f4me (31,9; Normalise, port binarki zaokrągla inaczej niż grandchild we wzorcu)
    i synth-c — clusterfuck (37,0; dziwny atraktor liczony z czasu klatki). Strona testowa daje
    silnikowi odtwarzacz, który na `gettime(-1)`/`(-2)` odpowiada jak wzorzec bez Winampa.
  - Przegląd 720 presetów, których dotyczy runda (APE 148, SVP 66, AVI 47, AVS Trans 80, Texer
    308 i 160 dawnych czarnych; 320×180, 90 klatek): wszystkie się wczytują i liczą, żaden port
    nie staje, nie ma nieznanych komponentów. Czarnych 95, wszystkie były czarne już w pierwszym
    przeglądzie (71 jest czarnych także we wzorcu); wśród APE i SVP żadnego, wśród AVI jeden
    (VISBOT — 01 intro, bez klipu VISBOT.AVI).
- Koszt: indeks 565 kB, 1 012 kawałków (razem 75,1 MB JSON-ów), 745 obrazków paczek (47,3 MB);
  build 13 s, z pamięcią konwersji 6 s. Preset wczytuje się w medianie w 35 ms (95% do 127 ms).
  Panel: otwarcie 95 ms, lista paczek (643 pozycje) 19 ms, pełna lista 13 982 presetów ok.
  0,4 s (raz, przy zmianie puli), paczka z 2 144 presetami 67 ms, odświeżenie panelu z pełną
  listą 2,7 ms.
- Czas klatki przy 320×180 (przegląd 08.11): mediana 2,2 ms; ponad 33 ms 165 presetów, ponad
  100 ms 11, ponad 200 ms 4 (najgorszy denkensiefursich — 07 the great escape, 608 SuperScope'ów,
  919 ms). Plotter bez kopii całej klatki (runda 2, `avsDraw.ts` wyżej), pomiar jak pierwszy
  (strona przeglądu: średnia z pierwszych 40 klatek po wczytaniu przy 320×180 i 20 przy
  1280×720; build z początku rundy → końcowy):
  - 320×180, 165 najwolniejszych: mediana 36,6 → 30,0 ms, ponad 33 ms 104 → 66, ponad 100 ms
    10 → 5 (the great escape 554 → 422 ms);
  - 1280×720, 14 z 40 najwolniejszych, które zmierzył pierwszy pomiar: mediana 104,5 → 71,8 ms,
    każdy szybszy (×1,13–×2,1; Hboy — 01 Intro 1690 → 800 ms, particles-II 657 → 318 ms).

  W ustalonym rytmie (bez trzech pierwszych klatek, stara i nowa droga w jednej stronie) przy
  320×180 kopia klatki nie była głównym kosztem: mediana 27,8 → 26,9 ms (najwięcej ×2,9, STRIPE
  4), a the great escape rysuje 24 ms obiema drogami — średnią z przeglądu psują pierwsze klatki
  po wczytaniu 608 SuperScope'ów. Przy 1280×720 (14 presetów, mierzone obok innej strony, więc
  porównawczo) mediana 82,2 → 69,3 ms, the great escape 476 → 94 ms, metatron 68 → 17 ms; Hboy —
  01 Intro ok. 800 ms obiema drogami (koszt jest gdzie indziej).
  Klatki: w jednej stronie stara droga powtarza własne klatki w 104 ze 165 presetów; w 83 z nich
  nowa daje te same, a pozostałe 21 daje te same 20 klatek, gdy każdy przebieg ma świeżą stronę
  (różnicę robił stan przeniesiony między przebiegami w jednej stronie, nie plotter).
- Runda 3 (10.11): wydajność. Pomiar w ustalonym rytmie: świeża strona na każdy preset (w jednej
  stronie presety zwalniały jeden po drugim — `Buffer.ts` wyżej — więc dawne pomiary w jednej stronie
  zawyżały czasy), dźwięk płynie z klatkami (od 1:00, beaty są), 10 klatek po wczytaniu pominiętych,
  20 mierzonych z czekaniem na kartę graficzną, nic innego na karcie; lista 165 presetów „slow”
  z rundy 2.
  Przy 1280×720: mediana 65,0 → 16,4 ms, średnia 152,7 → 39,0; ponad 33 ms 120 → 46, ponad 100 ms
  63 → 13, ponad 200 ms 32 → 4; żaden wolniejszy (jedyny „wolniejszy” o ponad 15 % i 2 ms, Jheriko —
  Hexahedron 13,7 → 16,6, przy powtórzeniu 14,7/17,9 → 14,4/13,8: szum). Przy 320×180: mediana 21,5 → 11,4 ms, ponad 33 ms 28 → 13, ponad 100 ms 2 → 0, żaden wolniejszy.
  Największe zyski: hboy — full of stars (reprise) 3 938 → 18 ms, Hboy — 01 Intro 678 → 28,
  amphirion — necromancer's pot 653 → 35, Tuggummi vs UnConeD — L-y-d-s-i-c 630 → 14, zamuz — visions vi
  435 → 7. W długiej sesji (te same 165 presetów jeden po drugim w jednej stronie, jak w odtwarzaczu)
  przy 1280×720: mediana 114,5 → 16,8 ms, ponad 33 ms 160 → 48, ponad 100 ms 91 → 14, ponad 200 ms
  43 → 4 — po zmianie tak samo jak w świeżej stronie.
  Zostają głównie presety, w których czas idzie na kod per punkt SuperScope'ów i Texerów II (micro-d —
  3° number preset 1 s, Raz — Peace And Love 0,55 s, Raz — 01 Introduction 0,33 s, Zevensoft —
  TwirlyColours 0,27 s): wykonanie samego kodu EEL, nie rysowanie.
  Główne koszty (czas własny komponentów z synchronizacją po każdym, 165 presetów przed zmianą
  przy 1280×720, jeszcze w jednej stronie): Texer II 21,3 s w 86 presetach (każdy kopiował klatkę
  do procesora i z powrotem, a cząstki liczył procesor), SuperScope 15,4 s w 152 (w dużej części
  `bufferData` spowolnione przez wcześniejsze presety strony). Poprawki opisane wyżej (Texer II: seria
  na jednej kopii klatki, ścieżka „resize” na karcie graficznej; plotter: odejmowanie 2 jednym
  rysowaniem, `plotRun`; `DYNAMIC_DRAW`). Klatki co do bitu: skróty
  każdej z 20 klatek od wczytania (świeża strona na preset, powtarzalna strona testowa: TESTING.md)
  przed i po — 165 z 165 presetów listy przy 1280×720, 298 z 298 losowych przy 640×360 (2 z 300 zmienia
  poprawka konwertera list), 12 z 12 presetów z FyrewurX; pojedyncze niepowtarzalne klatki zdarzały się
  tylko przy kilku równoległych przebiegach (w obu buildach) i znikały przy powtórzeniu. Ścieżka GPU
  Texera II wobec procesora, jedno rysowanie plottera wobec przebiegów i seria Texerów wobec kopii na
  każdy: te same klatki (przełączniki `__avsTexerGpu`, `__avsPlotterAll`, `__avsCpuRun`).
  Czarne w krótkim przeglądzie, a nie we wzorcu (24: 21 z klasy „lit” i trzy inne), puszczone na
  600 klatek przy 640×360: 22 rozjaśniają się (w medianie od klatki 90, najpóźniej 210), lone —
  Shirka's eye po poprawce konwertera list (wyżej), czarne zostaje VISBOT — 01 intro (bez VISBOT.AVI,
  jak AVS bez pliku). Z czterech czarnych presetów z FyrewurX trzy rozjaśniają się do klatki 240,
  a yathosho — littly buddy — fuckmeplastic jest czarny z natury (lista mnoży się z czarną klatką
  główną i odejmuje od niej; wzorzec też czarny).
- Runda 4 (10.11): kod presetów w WebAssembly. Profil przed zmianą (1280×720, 18 najwolniejszych,
  czas własny po pliku źródłowym): kod EEL to ok. 90 % czasu w micro-d — 3° number preset, 08 mutáns
  mogyoró i Synth-C — Inverse Eruption, ok. 80 % w Zevensoft — TwirlyColours, 75 % w Raz — 10
  Wireframe, połowa w UnConeD vs Jaak — Sound rings remake; szło na szukanie zmiennych po nazwie
  (`scope[name]` na obiekcie słownikowym) i wywołania domknięć. Zdanie z rundy 3, że wszystkie
  pozostałe wolne presety to kod EEL, było za szerokie: w Raz — Peace And Love, Raz — 01
  Introduction, Nic01 — Swirling Mass i Particle Cube, Planet X, Just Another Tunnel, „just like
  el-vis taught me” (×4), Deamon — Play the guitar i Zevensoft — FloatingBlocks czas idzie na plotter
  (`avsDraw.ts`: `flush`, `plotRun`, `avsLine`), a kod to kilka procent — to następny kandydat.
  Wynik (metoda rundy 3; w rozgrzewce pauza po klatce, żeby moduły skompilowane w tle się
  podmieniły, jak między klatkami `requestAnimationFrame`):

  | | przed | po |
  |---|---|---|
  | 1280×720, mediana (165 presetów) | 16,8 ms | 8,7 ms |
  | 1280×720, średnia | 39,4 ms | 25,6 ms |
  | 1280×720, presetów wolniejszych niż 30 kl./s | 47 | 28 |
  | 1280×720, ponad 100 ms / ponad 200 ms | 13 / 4 | 11 / 2 |
  | 320×180, mediana | 11,4 ms | 4,3 ms |
  | 320×180, presetów wolniejszych niż 30 kl./s | 12 | 1 |
  | długa sesja (165 presetów w jednej stronie, 1280×720), mediana | 16,8 ms | 8,8 ms |
  | długa sesja, presetów wolniejszych niż 30 kl./s | 47 | 28 |

  Największe zyski (1280×720, świeża strona): micro-d — 3° number preset 947 → 132 ms, Zevensoft —
  TwirlyColours 272 → 60, UnConeD vs Jaak — Sound rings remake 81 → 36, Raz — 10 Wireframe 68 → 14,
  da7id — superscope cross 61 → 25, 08 mutáns mogyoró 59 → 8,9, Synth-C — Inverse Eruption 48 → 3,6,
  vflorelo — Quite simple 33 → 3,9. Żaden preset nie jest wolniejszy (o ponad 15 % i 2 ms) w świeżej
  stronie przy żadnym rozmiarze; dwa „wolniejsze” z długiej sesji (zamuz — visions vi, Mr_Nudge —
  05Mr DJ) to odstające pomiary bazy — powtórzone po 3 i 10 razy wychodzą tak samo w obu buildach.
  Klatki co do bitu (skróty każdej z 20 klatek od wczytania, świeża strona na preset): 165 ze 165
  presetów listy przy 1280×720, 12 z 12 z FyrewurX przy 1280×720 i 300 z 300 losowych przy 640×360 —
  w obu trybach: z kompilacją od razu (wasm od pierwszego uruchomienia każdej sekcji, także init) i
  w tle, jak na stronie (pierwsze klatki domknięcia, potem przejście). W pierwszym przebiegu (12
  przeglądarek naraz) 163–164 ze 165, 10–11 z 12 i 295–297 z 300; każdy różny powtórzony pojedynczo
  dał te same klatki co baza — baza sama ze sobą też różni się w takim przebiegu (2 z 12 presetów
  FyrewurX). Magic Chords III w trybie w tle: 34 z 35 przebiegów identycznych, a w różnym zmienne
  kodu Bump (jedyny kod EEL presetu) były te same w każdej klatce.
  Przegląd wszystkich 13 982 presetów (320×180, 90 klatek, kopia strony przeglądu z ustalonym
  zegarem i `Math.random` na preset, wasm od pierwszego uruchomienia): 0 wyjątków i 0 komunikatów
  (baza tak samo), czarnych 160 i 160; skrót klatki 90 identyczny w 13 787 z 13 971. 184 różne to
  w 173 presety z FyrewurX (statyczny generator wtyczki przenosi stan przez całą stronę), w 2
  `gmegabuf`, w 9 kawałki, które po zawieszeniu ruszyły od innego presetu; wszystkie 195 (z 11 bez
  wiersza w jednym z przebiegów) puszczone w świeżej stronie dają klatki bazy. Kod działał jako wasm
  w 13 341 presetach (82 765 instancji); przy domknięciach zostało 30 instancji ze zmienną `init`.
  Przy tym wyszedł wyciek sprzed zmiany: bitmapa w pamięci podręcznej `ResourceManager` trzymała
  przez `onload` komponent, który o nią poprosił (Texer II …), a z nim cały poprzedni preset.
  W jednej stronie (165 presetów listy, pełne GC co 10) sterta JS rosła 201 → 1 670 MB; z wasm każdy
  zatrzymany preset trzymał też rezerwację pamięci wasm, aż po 1 200–2 300 presetach w jednej stronie
  `new WebAssembly.Memory` odmawiał. Teraz `getImage` zdejmuje obsługę zdarzeń, gdy zadziała: po GC
  żyje tylko pamięć bieżącego presetu, sterta 180–280 MB (skok do ok. 800 MB po Raz — 01 Introduction
  to tablice plottera, które zostają w największym użytym rozmiarze i nie rosną dalej), tak samo
  z wasm i bez. Gdyby pamięci wasm mimo to zabrakło, instancja zostaje przy domknięciach (wcześniej
  klatka kończyła się wyjątkiem).
- Runda 5 (10.11, wieczór): plotter i `getspec`/`getosc` w wasm. Profil przed zmianą (1280×720,
  28 presetów wolniejszych niż 30 kl./s po rundzie 4, świeża strona, wasm od pierwszego
  uruchomienia; liczniki zapisów z buildu z licznikami): presety z trybami bezpośrednimi piszą
  dziesiątki milionów pikseli na klatkę szerokimi liniami (Raz — Peace And Love 59 mln w 4,9 mln
  serii, Raz — 01 Introduction 41 mln, Deamon — Play the guitar 11 mln) i prawie cały czas szedł na
  składanie ich na procesorze (`flush` 325 ms, `plotRun` 102 ms na klatkę w Peace And Love);
  presety z 50/50, mnożeniem i „adjustable” czytały klatkę z karty raz na każdy Super Scope
  (OnionRing — 15: 27 odczytów na klatkę, amphirion — cubic spectrum 26, „just like el-vis taught
  me” ×4: 9, Nic01 — Swirling Mass 6) i mieszały na procesorze funkcją na kanał (`blendLineCpu`,
  `avsMulCpu`: ok. 120 ms w Swirling Mass). Zmiany opisane wyżej (prostokąty, rysowanie
  instancjonowane, Super Scope w serii na procesorze, mieszanie całego piksela, `getosc`/`getspec`
  w module).

  W trakcie weryfikacji pierwszy kandydat okazał się wolniejszy w łańcuchach Super Scope'ów 50/50
  z kilkoma przebiegami (07 - the great escape: 608 Super Scope'ów, r03 Jello Cube, 05 amphirion —
  abstrkt fundamentals; +3–5 ms): osobne liczenie przebiegów przed rozpisaniem prostokątów
  (z czyszczeniem `seen[]` wiersz po wierszu) kosztowało 7–11 ms na klatkę. Teraz liczy je pętla
  rozpisująca (`expandCounted`), jak dotąd lista pikseli. Spróbowane i odrzucone (wolniejsze
  w pomiarze): listy pikseli zamiast prostokątów dla 50/50 (el-vis ×4 19 → 31 ms), kropki przez
  punkty zamiast instancji, próg procesora 2^20 zamiast 2^17.

  Wynik — UWAGA: zmierzony przy dużym obciążeniu maszyny z zewnątrz (trening sieci właściciela:
  karta graficzna ok. 99 %, procesor blisko 100 %), więc liczby bezwzględne i różnice rzędu
  milisekund to szum; build przed i po zmianą na przemian, dwa przebiegi, mediana z dwóch, świeża
  strona, 1280×720, 10 klatek rozgrzewki z pauzą 30 ms, 20 mierzonych, lista 28 presetów
  wolniejszych niż 30 kl./s po rundzie 4:

  | 28 presetów, 1280×720 (maszyna obciążona z zewnątrz) | przed | po |
  |---|---|---|
  | mediana | 101,7 ms | 22,8 ms |
  | średnia | 116,7 ms | 33,8 ms |
  | wolniejszych niż 30 kl./s | 28 | 9 |
  | ponad 100 ms / ponad 200 ms | 15 / 2 | 1 / 0 |

  Największe zyski: Deamon — Play the guitar 113 → 5 ms (×23), Raz — 01 Introduction 295 → 15
  (×20), Raz — Peace And Love 490 → 77 (×6), „just like el-vis taught me” ×4 123–163 → 27–28,
  amphirion — cubic spectrum 101 → 15, OnionRing — 15 103 → 19, Jheriko — Just Another Tunnel
  140 → 28, Nic01 — Swirling Mass 180 → 57 i Particle Cube 126 → 36, Planet X 148 → 60, Zevensoft —
  FloatingBlocks 113 → 42. Bez zmiany cztery, w których czas idzie gdzie indziej (kod EEL albo inne
  efekty): micro-d — 3° number preset, Zevensoft — TwirlyColours, STRIPE 4, ZXe — My mind
  imprisoned 2.

  Przy tym obciążeniu rozrzut tego samego buildu sięgał 30–50 % między przebiegami. Wcześniej
  (pierwszy kandydat, ta sama metoda, cała lista 165 presetów, porcjami po 15 na przemian):
  1280×720 mediana 6,9 → 4,8 ms, średnia 24,3 → 9,1, wolniejszych niż 30 kl./s 27 → 7, ponad
  100 ms 10 → 1, ponad 200 ms 2 → 0 — z łańcuchami 50/50 opisanymi wyżej jako jedynymi
  wolniejszymi, co poprawka usunęła (60 klatek, 3 przebiegi na przemian: amphirion — abstrkt
  fundamentals 17,2 → 13,2 ms, hboy — full of stars (reprise) bez zmian, the great escape
  15,5 → 16,3 i Jello Cube 6,3 → 6,7 ms, a ten sam build z dawnym plotterem 16,0 i 6,8 ms — reszta
  różnicy to szum buildu).

  Pamięć w długiej sesji (165 presetów listy dwa razy w jednej stronie, po 20 klatek, wasm w tle,
  pełne GC co 10 presetów): po każdym GC żyje jedna pamięć wasm, sterta JS po GC 180–836 MB w bazie
  (w drugiej rundzie 793–836: listy pikseli plottera zostają w największym użytym rozmiarze po Raz —
  01 Introduction) i 164–222 MB po zmianie; proces renderera 251–912 MB wobec 247–313 MB; liczba
  obiektów WebGL bez wzrostu.

  Klatki co do bitu (build przed zmianą i po niej):
  - skróty każdej z 20 klatek od wczytania (świeża strona, ziarno, cztery przeglądarki naraz):
    165 ze 165 presetów listy przy 1280×720 z wasm od pierwszego uruchomienia i 164 ze 164 w tle
    (jedna strona się nie wczytała), 300 z 300 losowych przy 640×360 w tle i 299 z 299 od razu
    (jedna strona się nie wczytała), 12 z 12 z FyrewurX od razu i 11 z 12 w tle (Spring — degnic
    pod obciążeniem; w świeżej stronie ponownie — te same klatki w obu trybach). Nowy build
    z `__avsPlotterFast = false` i `__avsEelWasmVis = false` daje klatki bazy (28 z 28). Magic
    Chords III w trybie w tle bez stałych tablic Movement bywał różny (nowy build 8 z 10, baza 10
    z 10), ze stałymi (`__avsSynchronousTables`) 20 z 20 w obu: tablica z workera przychodzi przy
    innej klatce, gdy klatki liczą się szybciej;
  - przegląd wszystkich 14 037 presetów (320×180, 90 klatek, kopia strony przeglądu z ustalonym
    zegarem i `Math.random`, te same ustawienia co przegląd bazy): z wasm od pierwszego uruchomienia
    0 wyjątków i 0 komunikatów, czarnych 161 → 160, skrót klatki 90 identyczny w 13 764 z 14 019;
    z wasm w tle (pauza przed każdą klatką) 0 wyjątków w klatkach (7 „Failed to fetch” pod rząd
    w jednym kawałku to HTTP strony testowej), 0 komunikatów, czarnych 160 → 161, identyczny
    w 13 966 z 14 019. Różne to w 234 z 255 i 39 z 53 presety z FyrewurX albo `gmegabuf` (statyczny
    generator wtyczki i globalny bufor przenoszą stan przez całą stronę), reszta — kawałki, które po
    zawieszeniu ruszyły od innego presetu;
  - wszystkie 302 presety różne w którymkolwiek przeglądzie, ze zmianą „czarny”, wyjątkiem albo bez
    wiersza, w świeżej stronie (90 klatek, każda sumowana, 320×180, stałe tablice Movement, oba
    buildy, oba tryby, cztery przeglądarki naraz): 273 i 282 identyczne. Różne (48) pojedynczo, po
    dwa razy każdym buildem w każdym trybie: od razu 36, w tle 37 identycznych we wszystkich
    przebiegach; pozostałe różnią się między przebiegami także w bazie (do 3 różnych ciągów klatek
    na 8 przebiegów; seria yathosho — sensorama/substanz/iooi, bez FyrewurX i bez plottera, z Text —
    ma po dwa ciągi, oba w obu buildach). Cztery, w których nowy build miał ciąg niewidziany
    w bazie, jeszcze 4 razy każdym buildem w obu trybach: nowy build 32 z 32 przebiegów
    z najczęstszymi klatkami, baza 30 z 32;
  - testy: `avsDraw.test.ts` (nowy, w `test:ui`: 20 000 losowych linii wobec dawnego `avsLinePixels`,
    zapisy pikseli z prostokątów wobec list pikseli w 3 000 losowych ciągach `plot`/`plotRun`/`span`/
    linii, przebiegi z `expandCounted` wobec liczenia `flushPixels`, `blendRectsCpu` wobec
    `blendLineCpu` we wszystkich trybach), `eel-wasm-backend.test.ts` (getosc/getspec z pamięci
    visdata: siatka 69 × 69 × 22 kanały oboma drogami, 400 klatek zmieniających się bajtów, zmiana
    analizatora); każda z 28 celowych pomyłek w nowym kodzie złapana (4 dalsze były równoważne —
    liczyły to samo — i zostały zastąpione).
- Zgodność ze wzorcem (grandchild/vis_avs z poprawkami, klatki 150 i 300; „zgodny” to wynik
  poniżej 15): 280 z 303 presetów Anthology i 8_ronin (mediana 0,1) i 53 z 62 starszych
  (mediana 0,5, klatka 300). 08.11 rano: 154 z 247 (mediana 9,8) i 19 z 39 (17,8).
  Losowania zgadzają się co do klatki i komponentu w 362 z 365 presetów. Różnice szuka
  bisekcja po komponentach w obu silnikach (`scratch/avs-reference/README.md`): prawie każda
  zatrzymała się na komponencie liczonym inaczej niż w 2.81 i ten jest poprawiony (wyżej).
- Pozostałe różnice (32 presety) mają jedną z przyczyn:

  | przyczyna | presety |
  |---|---|
  | (a) wzorzec bez Text | Tonic — 3, DisGuy — Wonderland 2, AVSociety — Intro CD1, Rradikal — Cryogenic Pulse (obok innych przyczyn też Inca, Prison, red vs green, oba Hope Brings, Orifice) |
  | (a) wzorzec nie ma FyrewurX (u nas od 10.11 port binarki; z FyrewurX wyciętym zgodne, gdzie nie ma też Text) | Prison, GrayOil Conceptual RMX, Chess (Triple RMX), Magic Chords III, red vs green, Shallow Silence, disco ma cubism, future mainframe |
  | (a) EEL2 we wzorcu kompiluje kod, którego 2.81 nie przyjmował (tam cała sekcja nic nie robiła) | Inca, rmx_of_lesson10, T () M, Evolus, Hope Brings (Heartfelt3-L), Hope Brings (Full Strength-L), Z.N.S, JjcL237 — Let Me Paint My Way Out |
  | (a) EEL2 grupuje działania inaczej | Hboy — Orifice (`dirx*w%w/w*2-1`), duo — lost in a thought (`c*dm%40`), Drew — Collect and Win |
  | (a) EEL2 liczy inaczej `.`, `&`, `%` | VisKey — Satur-n-day Night (`.`), Marco — A Droug Called Music (`&`), Spectral Mishap i Speed Merchant (`%`) |
  | (b) chaotyczne rozejście: drobne różnice float (x87 w 2.81, double u nas) rosną w sprzężeniu | TS — UnderGround Nation i amanita muscaria (150 klatek co do piksela), Radical Dimensions (Movement z `log` liczb ujemnych), Degnic — Helium, Drew — Lans of Kansis (w obu ostatnich część różnicy to grupowanie EEL2) |
  | (c) różnica silnika | żadna: każda znaleziona jest poprawiona |
- Makra AVSTrans (`#define`, Echolot) rozwija przy wczytaniu presetu `webvs/avsTrans.ts` (port wtyczki).
- **Interleave** (`trans/Extras.ts`) jak `r_interleave.cpp`: wiersze na przemian pełne
  i wzorzyste, w wzorzystych co drugi odcinek `tx` pikseli, wzór wyśrodkowany resztą z dzielenia;
  na beat skok do x2/y2 i powrót o (beatdur + 448)/512 na klatkę. Maski wierszy i kolumn liczy
  procesor, shader miesza w całych poziomach.
- **Obrazek, który się nie wczyta** (404, sieć), jest pomijany (`ResourceManager.getImage`);
  wcześniej loader czekał na niego bez końca i cała wizualizacja stawała na czarnej klatce.
- Nazwy opcji z webvsc są tłumaczone w `converterCompat.ts` i `avsBlend()`.
- AVS nie jest już wersją testową (08.11.2026): etykieta to „AVS (Winamp)”, a na instalacji,
  która jeszcze go nie znała, przychodzi włączony jak każda nowa wizualizacja.

## Wizualizacja „Klasyka retro”

**Klasyka retro** (ang. Retro Classics, id `retro`; `retro-plugin.ts`, kod w
`src/shared/visualizations/retro/`) odtwarza wygląd pierwszych wizualizacji muzyki: tych, które
zamknięta wtyczka fomalhaut (Winamp/foobar2000, wszelkie prawa zastrzeżone) zebrała w jednym
miejscu. Z fomalhauta nie wzięliśmy nic poza listą trybów; każdy tryb ma własne źródło.

- **Grupy i presety** (79 z portami z vendor, 65 bez nich):
  - Cthugha (17, tylko w buildzie z `frontend/vendor/cthugha`, niżej): Cthugha 5.3 (DOS),
    5.3 · Upwards i 5.3 · Kaleidescope; Cthugha-L, Cthugha-L · 320 × 200 i sześć z zablokowanym
    wyświetlaniem (kalejdoskop, kalejdoskop 90°, walec, pole wysokości, zginana płaszczyzna,
    obracana płyta); glcthugha, czyli OpenGL Cthughi-L (cały program oraz Simple Tube, Smooth
    Height, Almost a Ring, 2Planes, Cross);
  - Cthugha98 (8): cały program, Flame & Wave, Translate, Particles, Kaleidoscope oraz trzy widoki
    wersji 3Dfx (obrót, krajobraz z dołu, chmura punktów); z vendor zamiast nich 4 presety portu:
    Cthugha98, Cthugha98 · Kaleidescope, Cthugha98 3Dfx, Cthugha98 3Dfx · Downwards;
  - Cthugha-4-Winamp (5): cała wtyczka, Scope, Analyzer, Translate, Quad; z vendor zamiast nich
    6 presetów portu: cała wtyczka, Kaleidoscope 2x2, Weidth 2x1, Analyzer, 320 × 240 i Tab
    generators (z tablicami programów z `tabs\`);
  - Atari Video Music (1977) (10 ustawień panelu): Solid 1 × 1 (ustawienie, od którego każe
    zacząć instrukcja), Auto All, Hole i Ring 1 × 1, Solid 1 × 1 z miękkimi kształtami i z
    jednolitym kolorem, Solid 3 × 2, Hole 2 × 2, Ring 5 × 4, Auto 5 × 8;
  - Trackery (20 presetów, 19 programów), według platform i mniej więcej według lat:
    - Amiga: Ultimate Soundtracker 1.21, D.O.C SoundTracker 2.0, NoiseTracker 2.0,
      Future Composer 1.4, SidMon 1.0, SidMon II, OctaMED Professional 4.0, Oktalyzer 1.57,
      ProTracker 2.3 (oscyloskopy albo analizator), AHX 2.3d;
    - DOS i Windows: Composer 669 1.3, Scream Tracker 3.21, Fasttracker II,
      Impulse Tracker 2.14, ModPlug Tracker 1.16;
    - C64 i Amstrad CPC: SoundMonitor 1.1, JCH Editor 3.04, Soundtracker DMA 2.0,
      Arkos Tracker 3;
  - VSG+ (DOS) (21): „VSG+”, który zmienia efekt na stopie mniej więcej co 20 s, i każdy z 20
    efektów osobno. Nazwy efektów opisują je, więc są tłumaczone;
  - Autorzy (1): napisy końcowe z twórcami pierwowzorów (niżej).
- **Auto, ulubione, „zostaw”, „następny”, `persist: false`, `autoFilter`** działają jak w Formach
  dźwięku. Auto to talia co 30 s z przenikaniem 1,2 s, a wybór trafia do
  `media-visualizer-preset:retro`. Scena, która się nie uruchomi, wypada z listy do końca wizyty.
  Kod każdej sceny to osobny fragment, pobierany przy pierwszym pokazaniu.
- **Obraz:** scena rysuje w rozdzielczości oryginału:
  - AVM: 192 × 240 linii TV;
  - trackery: 320 × 256 albo 640 × 256 (Amiga PAL), 640 × 400 (DOS), 800 × 600 (ModPlug),
    384 × 272 z ramką (C64, CPC), 1280 × 720 (Arkos Tracker 3);
  - Cthugha 5.3: 320 × 200; Cthugha-L: ekran dwa razy większy od bufora; glcthugha: okno
    600 linii, szerokie jak panel, rysowane przez WebGL 2;
  - Cthugha98 i Cthugha-4-Winamp: 640 × 480 w 256 kolorach (port wersji 3Dfx: 640 × 480 przez
    WebGL 2); VSG+: 640 × 480 w 16 kolorach.

  `presenter.ts` skaluje obraz do panelu × `devicePixelRatio` (najwyżej 2) metodą „sharp
  bilinear”. Najpierw powiększa o całą wielokrotność najbliższym sąsiadem, resztę dwuliniowo, więc
  piksele są równe i ostre. AVM dostaje wykończenie telewizora: obraz miękki wzdłuż linii i ciemne
  przerwy między liniami. Scena rysowana przez WebGL (glcthugha) oddaje swoje płótno
  (`surface()`), a prezenter skaluje je tak samo.
- **Dźwięk:** własne analizatory za analizatorem odtwarzacza (`audio.ts`, `analysis.ts`). Lewy
  i prawy kanał są osobno, po 8192 próbki; 96/192 kHz obsługuje `audio-rate.ts`. Liczbę próbek
  nowych od poprzedniej klatki wyznacza zegar kontekstu, więc symulacje układów dostają każdą
  próbkę raz.
- **Atari Video Music** (`avm-circuit.ts`, `avm.ts`) to symulacja układu z patentu US 4,081,829,
  od 09.11.2026 także według schematu (CA010270) i instrukcji obsługi C240:
  - Pole ma 262 linie, 60 pól na sekundę. Każda linia bierze energię obu kanałów z własnej chwili.
  - Energia: filtr pasmowy wejścia (bieguny 129 i 887 Hz), ujemne połówki ładują kondensator C23
    (4,7 µF) w ułamku milisekundy. CONTOUR ustala, jak szybko się rozładowuje: w lewo ok. 10 ms
    (kształt żyje 2 ms po każdym szczycie, czyli „soft shapes”, smugi), w prawo ok. 238 ms
    (stały romb, „geometric shapes”). Rozładowanie idzie w stronę poziomu poniżej spoczynku, więc
    po ciszy kształt znika, a nie gaśnie powoli.
  - Dwie rampy V z liczników 4-bitowych (193 mV na rampę), jedna na linię, druga na pole,
    porównane z energią dają romb. SOLID to OR, HOLE to XOR, RING to impulsy 7 taktów od zboczy
    sygnału XOR.
  - Kolor wybiera odczep linii opóźniającej na sygnale koloru 3,58 MHz według liczby przejść przez
    zero (tablica I patentu). Detektor przejść bierze sygnał sprzed GAIN, przez filtr
    górnoprzepustowy 362 Hz i komparator z histerezą 24 mV. Licznik obsługuje kanały na
    przemian; kanał liczony bierze odczep z bieżącej liczby, więc jego odcień zmienia się pasami
    w dół ekranu.
  - COLOR ustala polaryzację linii opóźniającej, a rampy dochodzą do tego samego wyprowadzenia
    przez C18. Odcień zmienia się więc z odległością od środka rombu, jak na obrazkach z
    instrukcji: w lewo „less color”, w środku „rainbow of colors” (pierścienie), w prawo „solid
    color”. Kształt krzywej opóźnienia od napięcia to nasz model; układu A2 nikt nie opisał.
  - Wejście to wyjście liniowe wzmacniacza: muzyka sprowadzona do 250 mV z instrukcji. GAIN
    ustawia się jak właściciel „na oko”: najszersza linia pola średnio na 15 kroków rampy, czyli
    romb prawie do brzegów; presety rozsuwają kanały.
  - Kolor wychodzi jak z telewizora: YIQ, chroma rozmyta wzdłuż linii, szara linia tam, gdzie
    odcień skacze. Widać średnią dwóch ostatnich pól. AUTO i AUTO ALL losowo zmieniają kształt
    i siatkę, najchętniej na bit.
  - Porównanie: nagranie prawdziwego urządzenia („Atari Video Music.webm” z Wikimedia Commons,
    CC BY 4.0, Victor Grigas) i sześć obrazków z instrukcji.
- **Trackery** (`trackers/`) są narysowane od zera: fonty jako ASCII-art w `trackers/fonts*.ts`,
  układy i kolory według zrzutów ekranu. Nie ma w nich nic z programów ani z klonów.
  - Nuty powstają z muzyki (`trackers/song.ts`). Sześć detektorów rozpoznaje stopę, bas, werbel,
    hi-hat, melodię i akord.
  - Tempo wynika z odstępów stopy (80–180 BPM), cztery wiersze na beat. Efekty bierze z dynamiki.
  - Zagrane wiersze się nie zmieniają. Wskaźniki i oscyloskopy działają jak w oryginałach.
  - Wspólne części: `soundtracker-parts.ts`, `sequence-amiga2.ts` (pozycje sekwencera),
    `c64.ts` i `eightbit.ts` (ekrany tekstowe C64 i CPC).
  - SidMon 1.0 (Reinier van Vliet, Turtle Byte, 1989) gra w edytorze wzorców, bo tam ma PLAY
    i STOP: lista kroków, NOTE, INST, BEND TO, BEND SPEED, krok grany podświetlony; fonty
    (`fonts-sidmon1.ts`) przepisane ze zrzutów, B, F i # dorysowane w tym stylu, logo z kresek.
    SidMon II (Michael Kleps) gra na ekranie utworu; „SidMon 2.1” z listy fomalhauta to on.
  - SoundMonitor pokazuje główny ekran.
- **Cthugha (tylko vendor):** porty w `frontend/vendor/cthugha/`, który jest ignorowany przez
  git: Cthugha 5.3 i Cthugha-L z kodu źródłowego, Cthugha98 i Cthugha-4-Winamp z samych programów
  (analiza statyczna kodu maszynowego kopii właściciela, bez uruchamiania). Licencja źródeł
  Cthughi pozwala używać ich tylko niekomercyjnie i z podaniem autorów; Cthugha98 to postcardware,
  Cthugha-4-Winamp jest darmowa tylko do użytku osobistego (`COPYING-cthugha-53.txt`,
  `COPYING-cthugha-L.txt`, `COPYING-cthugha98.txt`, `COPYING-cthugha4winamp.txt` i `SOURCE.md`
  w tym folderze, akapit w `NOTICE.md`). `scripts/retro-cthugha.mjs` daje moduł
  `virtual:retro-cthugha` z katalogiem presetów i loaderem silnika; preset z polem `group` trafia
  pod inny nagłówek, a nasze presety tego nagłówka ustępują mu miejsca (`catalog.ts`). Bez folderu
  moduł jest `null`, grupy Cthugha nie ma, a Cthugha98 i Cthugha-4-Winamp to nasze odtworzenia.
  - **Cthugha 5.3 (DOS)** (`dos/`; Kevin „Zaph” Burfitt, Torps Productions, 1995):
    - 15 płomieni przetłumaczonych z asemblera x86 instrukcja po instrukcji (pary pikseli
      zapisywane słowem, liczniki pętli jak w kodzie, `divsub[]`), 24 fale, 8 sposobów
      wyświetlania; jeden bufor 320 × 204, ekran 320 × 200, 70 klatek na sekundę;
    - pętla `main()`: zmiana wszystkiego co 200–949 klatek, po ciszy albo po 17 bardzo głośnych
      klatkach; co kilka przebiegów obrazek (cały albo kawałek w losowym miejscu); tablice
      przesunięć; „FFT” jako miganie palety; napisy w ciszy wypalane w buforze;
    - `rand()` z Microsoft C; jak oryginał zawsze zaczyna tym samym zestawem (rand przed srand);
    - dane z dystrybucji i dodatków: 8 palet wbudowanych, 32 pliki map, 12 obrazków, 6 tablic,
      znaki z `CHARSET.C` (skrypty w scratch);
    - poprawiliśmy cztery błędy, które wymienia też fomalhaut: „Downwards” przesuwał obraz zamiast
      go odwracać, oba kalejdoskopy miały szew, palety wbudowane były przeliczone na 6 bitów
      tylko w części, a duże obrazki pokazywały lewy górny róg.
  - **Cthugha-L 1.4** (Harald Deischinger, na podstawie Cthughi Zapha), port linia po linii:
    - 18 płomieni, z przejściami „w miejscu” i sumami zawijanymi w 8 bitach;
    - 29 fal;
    - 13 sposobów wyświetlania, w tym 3D programowe; Zick Zack jest wyłączony jak w oryginale;
    - tablice przesunięć z programów w `tab/`, ładowane po 10 linii na klatkę jak w oryginale;
    - 9 palet wbudowanych, 169 plików `map/` i palety 6 obrazków `pcx/`;
    - procesy dźwięku (brak, Filter1, Filter2, FFT), wygładzanie palety i flashlight;
    - AutoChanger, który zmienia wszystko co 5–15 s, po energii uderzeń albo gdy muzyka wraca po
      ciszy, i napisy w ciszy;
    - 25 klatek na sekundę; bufor ma 150 linii, a jego szerokość wynika z proporcji panelu; ekran
      jest dwa razy większy, z czterokrotnym lustrem. Preset 320 × 200 ma domyślny bufor
      oryginału, 160 × 100, na ekranie 4:3. Nowy utwór pokazuje jeden z obrazków, jak klawisz `x`;
    - poprawiliśmy dwa błędy oryginału: wysokie obrazki rysowały się od złej linii, a dwie tablice
      mieszały się podczas ładowania.
  - **glcthugha** (`gl/`, OpenGL Cthughi-L 1.4) — port `GL_display.cc`, `GL_Light.cc`,
    `GL_Background.cc`, `GL_Fly.cc` i `CthughaDisplayGL.cc`:
    - 17 wyświetleń 3D: Plate, 2Plates, Plane, dPlane, 2Planes, Wave1, Wave, Height, Cross,
      CWave, NearRing, Tube, SHeight, 2D-Big, 2D-Quad, Sphere, Cones; do trzech buforów naraz
      (każdy z własnym płomieniem, falą i paletą), jeden AutoChanger dla wszystkiego;
    - światło (brak, dwa układy kolorowych reflektorów, jeden biały), tło (obrazek pod obiektem
      albo dodany na nim, brak), „fly” (pierścienie ognia przy płaszczyznach), mgła;
    - jak w programie: bufory 256 × 256, okno 600 linii, kolor 0 szary (200, 200, 200), tekstury
      filtrowane liniowo, kamera, która bez joysticka sama krąży (`joystick.cc`), sfera i stożki
      jak w GLU Mesy 3, tekst ciszy czcionką kreskową GLUT (z freeglut, licencja MIT);
    - `gl/emulator.ts` to nasz kawałek OpenGL 1.x na WebGL 2 (tryb natychmiastowy, stosy macierzy,
      oświetlenie wierzchołków, mgła, mieszanie), więc kod wyświetleń przeszedł prawie wprost;
    - zmiana: widok 3D rysuje się w każdej klatce panelu (ruch kamery jest płynniejszy), bufory
      dalej w swoich 25 klatkach na sekundę;
    - porównanie ze zrzutami autora ze strony Cthughi-L; nowsze zapisano jako RGB w plikach TGA
      (te są BGR), więc mają zamieniony czerwony z niebieskim — arkusz pokazuje je poprawione.
  - **Cthugha98 0.6a** (`c98/`; Zaph, październik 1998) — port z `Cthugha98.exe` i
    `Cthugha98-3dfx.exe` (MSVC 6, kod niezoptymalizowany, czytany z `dumpbin /disasm`):
    - 13 płomieni (już w C, dla dowolnego bufora), 28 fal (23 losowane, 5 nigdy), 8 sposobów
      wyświetlania: bufor ma rozmiar ekranu 640 × 480 podzielony przez dzielniki wyświetlania
      (640 × 480, 640 × 240, 320 × 240, 320 × 480); przebiegi 200–949 klatek, zmiana po ciszy
      albo 65 głośnych klatkach; obrazki (cały albo kawałek); tablice przesunięć 320 × 200
      rozciągane na cały ekran; napisy w ciszy; `rand()` z MSVC;
    - nowe w 98: „przebiegi specjalne” (3/8 zmian) z cząstkami — rój 2500 kropek z odpychaczami
      (0x40F6C2) albo fontanna (0x41071B) — na czystym, przesuwanym albo wygaszanym buforze;
    - dane: 8 palet wbudowanych, znaki i napisy z programu, 65 map, 4 obrazki i 3 tablice
      z archiwów danych Cthughi 97 (`convert_c98.py` w scratch);
    - zachowane dziwactwa: „FFT” nie jest nigdy wołane, palety zmieniają się od razu, obrazki
      dostają paletę ogólną, „Kaleidescope” powtarza lewą połowę zamiast ją odbijać, w 2D
      DirectDraw trzyma kolory 0 i 255 jako czarny i biały;
    - wersja 3Dfx: ten sam silnik na ekranie 256 × 256, pokazany przez Glide jako pole wysokości
      64 × 64 obracane o 0,5° na klatkę (z góry, a przy „Downwards” z dołu) albo, w przebiegu
      specjalnym, jako chmura punktów; `c98/glide.ts` odtwarza obliczenia na CPU dokładnie,
      a Voodoo (cieniowanie Gourauda, W-bufor, RGB 565 z ditheringiem) przez WebGL 2; 60 klatek
      na sekundę jak w programie; wersja 2D bez limitu klatek, tu 30 na sekundę.
  - **Cthugha-4-Winamp 1.50** (`c4w/`; Krunoslav Pisačić, 1998) — port z `Vis_sh.dll` (MSVC 5,
    kod zoptymalizowany): 16 płomieni, 20 fal, 4 wyświetlania, pętla Render z wykrywaniem stopy
    Justina Frankela (co 8. stopa zmiana, co 16. tytuł, co 32. obrazek), pięć tablic, które DLL
    sama zapisywała przy pierwszym starcie, 73 mapy (VOLCANO.MAP najpierw), dwa obrazki GIF,
    litery 3D z `objs\*.obj` składające tytuł na początku utworu; 640 × 480, 40 klatek na
    sekundę (25 ms modułu).
    - Preset „Tab generators” dokłada 16 tablic programów z `tabs\`: mkspace, mkhuricane
      i mkgentable ze źródeł `tabgens_src` oraz (od 10.11.2026, `c4w/tabgens.ts`) trzy programy
      bez źródeł w C, przeniesione z samych plików (16-bitowy DOS, analiza statyczna, nic nie
      uruchomione): Wintabs.exe Toma Willaerta (QuickBASIC po EXEPACK; skompilowany kod to
      dołączony `wintabs.bas`) — slidever, slidehor, fourcorn, blocks; TABMAKE.EXE Kasuhy
      (Turbo Pascal po WWPACK) — smoke.tab: zamiany wpisów dwóch pikseli w promieniu 3 (na końcu
      11), aż union-find połączy wszystkie piksele; Randomize nie jest wołane, więc to zawsze ten
      sam plik; Wintab.exe Simona Wernera (Turbo C++ z tablicą symboli Turbo Debuggera) —
      slidehor, slidever, corners, squares, blocks, warp, ripple, warple.
    - Tytuł wpisywany w płomienie (10007E70): `CreateFont(wysokość komórki 48, 40, … 16,
      FW_NORMAL, DEFAULT_CHARSET, DEFAULT_QUALITY, VARIABLE_PITCH, krój)` z Arial, Courier New,
      Script albo Times New Roman, biały na czarnym na 8-bitowej powierzchni DirectDraw — więc bez
      wygładzania. Metryki i szerokości znaków GDI (komórka, linia bazowa, em, szerokości U+0020–
      U+017F) są w `c4w/gdi-fonts.ts` (zmierzone `gdi_probe.cpp`, same liczby); z nich port
      wybiera rozmiar jak wtyczka (od 48 w dół co 8, aż tekst zmieści się w 300 px).
    - Czcionki Windows nie są dołączone. Arial, Courier New i Times New Roman rysuje czcionka
      z komputera widza, gdy przeglądarka ją ma (`retro/cthughalike/local-font.ts`): rozpoznana
      pomiarem — szerokość próbki i wysokość wielkiego H w 200 px muszą być tej czcionki (Android
      odpowiada na „Arial” Robotem, bliźniaki metryczne mają szerokości, ale nie H) — i narysowana
      jak GDI na 8 bitach: każda litera w miejscu pióra GDI, linia bazowa GDI, bez wygładzania.
      Gdzie jej nie ma (Android, Linux bez niej), jak dotąd kreskowe kroje, ale już z metrykami
      i szerokościami GDI. Script to wektorowa czcionka Windows (SCRIPT.FON), której przeglądarki
      nie rysują: zawsze kreskowa kursywa, teraz z prawdziwymi szerokościami — wcześniej
      szacowane szerokości Times × 1,25 były o 55–75% za duże, więc tytuł w Script wychodził
      mniejszy niż w oryginale (np. „The Chemical Brothers” 24 px zamiast 48).
    - Wobec powierzchni z GDI (cztery tytuły, każdy krój, wspólne piksele tekstu): Arial 0,17 →
      0,77, Courier New 0,14 → 0,69, Times New Roman 0,19 → 0,73, Script 0,05 → 0,10; bez czcionki
      w systemie 0,26 / 0,33 / 0,18 (`scratch/renders/extras3/c4w-title-surfaces.png`,
      `c4w-title-frames.png`). `globalThis.retroLocalFonts = false` przed startem udaje system
      bez tych czcionek (do porównań).
    - Zachowane dziwactwa: ripple.tab mierzy odległość od wyniku poprzedniego piksela, środkowa
      linia warp.tab bierze kąt z linii wyżej, blocks.tab Wintaba tasuje bloki 80 × 80 według
      `srand(time)` (tu ziarno sceny). Wintab nadpisałby trzy pliki Wintabs; zostają oba
      zestawy, wersje Wintabs z dopiskiem „(Wintabs)”.
    - Tablice powstają po kawałku, 2 ms na klatkę (wtyczka ładowała tablice w osobnym wątku);
      smoke.tab w całości to ok. 0,2 s.
    - Sprawdzenie: niezależna implementacja w Pythonie daje te same 13 plików bajt w bajt;
      żadna wartość przed obcięciem do liczby całkowitej nie leży bliżej niż 1e-9 od liczby
      całkowitej, więc 80-bitowe x87 dałoby to samo. Żadnej z tych tablic nie ma w archiwach
      właściciela jako gotowego pliku. Cthugha98 czyta inny format (320 × 200), więc jej nie
      dotyczą.
- **Cthugha98 i Cthugha-4-Winamp** w repozytorium to nasze odtworzenia (MIT): źródeł żadnego
  z tych programów nikt nie udostępnił. Wspólny silnik `cthughalike/` (płomienie, fale,
  tablice przesunięć, palety, sceny cząstek, wyświetlania, pole wysokości 3D, litery) powstał
  według opisów, stron programów, nagrań i zrzutów ekranu. W buildzie z vendor zastępują je porty
  z samych programów (wyżej).
  - Cthugha98 (Zaph, Windows 95, 1997–98): 640 × 480, 30 klatek na sekundę; efekt zmienia się co
    kilka sekund albo na głośnym ataku. Wersja 3Dfx rysowała obraz jako krajobraz na karcie
    Voodoo: tu programowe pole wysokości, oświetlone i obracane, widziane z góry, z dołu albo
    jako chmura punktów.
  - Cthugha-4-Winamp (Krunoslav Pisačić, 1998, wersja 1.50): efekt zmienia się po liczbie
    uderzeń; na początku utworu duże litery 3D składają tytuł, potem tytuł wypala się w obrazie
    i co jakiś czas wraca.
- **VSG+ (DOS)** to nasze odtworzenie (MIT) programu VSG 1.0 VGA (QuickBASIC, Neven Pintaric,
  2000) w postaci, do której fomalhaut rozbudował go jako VSG+: 20 efektów z okręgów, linii
  i punktów na ekranie 640 × 480 w 16 kolorach (tryb 12h), z paletą EGA albo innych komputerów.
  Samego VSG nigdzie nie ma, więc sześć efektów (struny, słupki VU, mora, tunel, oscyloskop
  kołowy, figury Lissajous) idzie za zrzutem z README fomalhauta, a pozostałe 14 powstało z nazw,
  w tym samym stylu.
- **Autorzy** (`credits.ts`, lista w `credits-list.ts`): napisy końcowe jak w intrach z Amigi
  i DOS-u, 320 × 256 — tytuł w kolorach coppera, gwiazdy, dwa paski rastra, nazwiska fontem 8 × 8
  wjeżdżające od dołu, pasek widma na dole. Muzyka działa delikatnie: gwiazdy przyspieszają
  z głośnością, tytuł i paski jaśnieją na uderzeniu, widmo idzie za dźwiękiem; napisy płyną
  równo, żeby dało się je czytać. Lista podaje autorów Cthughi (Kevin „Zaph” Burfitt i Torps
  Productions, Harald Deischinger, Krunoslav Pisačić), AVM (Atari, Robert J. Brown), każdego
  trackera, VSG (Neven Pintaric) i Geissa (Ryan Geiss) — według `NOTICE.md`, `SOURCE.md` i ekranów
  samych programów. Linie Cthughi zostają też bez vendor, bo to fakty. Nagłówki i uwagi idą przez
  `t()`, nazwiska nigdy; test pilnuje, żeby każdy preset trackera miał swój wpis.
- **Rozmiar i wydajność** (build testowy i przeglądarka, panel 1024 × 724, DPR 1, 09.11.2026):
  - fragmenty: wtyczka 20 KB (7 KB gzip), AVM 5 KB, trackery po 3–7 KB (Arkos Tracker 26 KB,
    ModPlug 16 KB, Soundtracker DMA 15 KB) plus wspólne `song.ts` (18 KB) i fonty (21 KB);
    silnik Cthugha98 i Cthugha-4-Winamp 44 KB (17 KB gzip) oraz ich sceny, 13 i 6 KB; VSG+ 24 KB
    (10 KB gzip); SidMon 1.0 8 KB. Z vendor: Cthugha-L 747 KB (247 KB gzip), glcthugha 35 KB
    (11 KB gzip) do niego, Cthugha 5.3 2,1 MB (870 KB gzip, głównie obrazki i tablice;
    pobierana dopiero z jej presetem), port Cthugha98 z 3Dfx 874 KB (511 KB gzip, głównie mapy,
    obrazki i tablice), port Cthugha-4-Winamp 450 KB (301 KB gzip; z generatorami tablic od
    10.11.2026);
  - średni czas `render()` razem z prezenterem: Cthugha 5.3 0,7–0,8 ms, Cthugha-L 0,5–0,8 ms,
    Cthugha98 1,3–1,8 ms (3Dfx 2,4–4,8 ms, p95 do 9,5 ms), Cthugha-4-Winamp 2,5–2,9 ms,
    AVM 1,8–3,7 ms, trackery 0,4–2,6 ms, VSG+ 1,2–2,5 ms, glcthugha 0,5–4 ms (Cross, trzy
    bufory, najwięcej). Wszystkie presety ruszyły bez ostrzeżeń w konsoli. Porty (sama scena,
    bez prezentera, 09.11.2026): Cthugha98 0,85 ms (p95 1,7 ms), 3Dfx 0,4 ms na CPU,
    Cthugha-4-Winamp 0,8–0,9 ms.
- **Nie da się, z powodem:**
  - w portach Cthugha98 i Cthugha-4-Winamp (z programów): liczba klatek wersji 2D Cthugha98
    (program nie miał limitu, tu 30 na sekundę), czcionki Windows tytułu w Cthugha-4-Winamp tam,
    gdzie widz ich nie ma (nie wolno ich dołączyć: są wtedy nasze kreskowe z metrykami GDI; gdzie
    ma Arial, Courier New albo Times New Roman, rysują one), czcionka Script (wektorowa,
    przeglądarki jej nie rysują), dokładne zaokrąglenia Voodoo
    (według emulacji MAME); zrzutu wersji 2D Cthugha98 nie ma w żadnym źródle;
  - Cthugha97 (alfa 0.5): to zoptymalizowany build wcześniejszej wersji, każdą funkcję
    trzeba by tłumaczyć od nowa, a 0.6a ją zastępuje — nie przenieśliśmy;
  - 14 z 20 efektów VSG+ według prawdziwego programu: VSG 1.0 nie istnieje w sieci (ani program,
    ani źródła, ani zrzuty), te efekty narysowaliśmy z samych nazw;
  - edytor nut SoundMonitora: nikt go nie sfotografował;
  - krzywa opóźnienia linii AVM od napięcia (układ A2): nikt jej nie opisał, a potwierdziłby ją
    tylko pomiar prawdziwego egzemplarza; jest dobrana do obrazków z instrukcji.
- **Testy:** `retro/retro.test.ts` (rampy, tablica I, kształty, pokrętła z instrukcji, kolor,
  analiza, napisy końcowe), `retro/trackers.test.ts`, `retro/trackers-sound.test.ts`,
  `retro/trackers-amiga2.test.ts`, `retro/trackers-gui.test.ts`, `retro/trackers-8bit.test.ts`,
  `retro/trackers-cpc.test.ts`, `retro/cthugha98.test.ts`, `retro/vsg.test.ts`.
