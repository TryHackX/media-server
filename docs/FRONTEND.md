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
  src/
    router.ts       miękki router SPA
    pages/          logika poszczególnych stron
    shared/         API, bezpieczny DOM, ikony, odtwarzacz, viewer, wizualizacje
    styles/         tokens, reset, base, components, utilities, pages, refinements
```

Dynamiczne elementy powstają przez `createElement`/`textContent`. Kod nie korzysta z
`innerHTML` (poza stałymi, nieinterpolowanymi ikonami SVG stanu odtwarzania), inline styles,
zewnętrznych fontów ani zewnętrznego zestawu ikon. Jedyny wyjątek sieciowy to skrypt wybranego
dostawcy CAPTCHA, dociągany na stronie logowania tylko wtedy, gdy ochrona jest włączona w
panelu — dlatego szablony Apache nadają `/media-next/login/` osobną CSP dopuszczającą źródła
reCAPTCHA/hCaptcha/Turnstile; reszta aplikacji zachowuje `script-src 'self'`.

Router SPA jest odporny na błąd montowania strony (łańcuch nawigacji z `catch`), a nieudane
pobranie sesji nie jest buforowane — kolejna nawigacja ponawia próbę.

## Wydajność i skalowanie

- podział kodu na osobne chunki stron;
- siatka oparta na `auto-fill/minmax`, bez stałej liczby kolumn;
- okno renderowania listy (`240` kart) zamiast nieskończonego DOM;
- `minmax(0, 1fr)` i `min-width: 0` zabezpieczają pełny ekran przed rozszerzaniem layoutu;
- karty używają `content-visibility: auto` i jawnego containment;
- `prefers-reduced-motion` wyłącza przejścia;
- katalog ma paginację kursorową po `media_items.id`, bez kosztownego dużego `OFFSET`.

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
