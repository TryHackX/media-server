"""Reguły dostępu w przykładach Apache — kolejność, która decyduje o tym, czy działają.

``<Location>`` i ``<LocationMatch>`` scalają się w kolejności, w jakiej stoją
w pliku, a przy domyślnym ``AuthMerging Off`` dyrektywy ``Require`` z sekcji
późniejszej **zastępują** wcześniejsze, zamiast się z nimi sumować. Blok
zamykający zdrowie usługi i zlecanie zadań musi więc stać **po** szerokim bloku
otwierającym trasy transferu, inaczej znika bez śladu.

Zmierzone 17.08.2026 na osobnym ``httpd`` (dwie konfiguracje różniące się
wyłącznie kolejnością, wolny port, ta sama trasa): przy kolejności „deny po
grant" ``/media-transfer/health/ready`` oddaje 403, przy odwrotnej — 404, czyli
żądanie dociera do usługi. Zwykłe trasy transferu odpowiadają identycznie w obu
układach, więc nic tego nie zgłasza: konfiguracja wygląda dobrze, ``configtest``
mówi „Syntax OK", a smoke test po cutoverze pokazał publicznie dostępne zdrowie
usługi. To jedyny czytelnik tej kolejności.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
APACHE = PROJECT_ROOT / "deploy" / "apache"

# Pliki, które w ogóle wystawiają trasę transferu. `media-next.conf.example`
# jej nie dotyka, a `media-vhost.conf.example` tylko wciąga oba fragmenty.
TRANSFER_CONFIGS = [
    APACHE / "media-transfer.conf.example",
    APACHE / "media-next-stage-wamp.conf.example",
]

# Blok zamykający: zdrowie i trasy zlecające zadania.
NARROW_DENY = re.compile(r'<LocationMatch\s+"\^/media-transfer/\(health\|')
# Blok otwierający trasy transferu — w dwóch wariantach zapisu, jakie tu są.
BROAD_OPEN = re.compile(r'<Location(?:Match)?\s+"?/?\^?/?media-transfer(?:\(\?:/\|\$\)|/)"?>')


def _lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines()


@pytest.mark.parametrize("config", TRANSFER_CONFIGS, ids=lambda p: p.name)
def test_both_blocks_are_present(config: Path) -> None:
    lines = _lines(config)
    assert any(NARROW_DENY.search(line) for line in lines), (
        f"{config.name}: brak bloku zamykającego zdrowie i zlecanie zadań"
    )
    assert any(BROAD_OPEN.search(line) for line in lines), (
        f"{config.name}: brak bloku otwierającego trasy transferu"
    )


@pytest.mark.parametrize("config", TRANSFER_CONFIGS, ids=lambda p: p.name)
def test_the_closing_block_comes_after_the_opening_one(config: Path) -> None:
    lines = _lines(config)
    deny = next(i for i, line in enumerate(lines) if NARROW_DENY.search(line))
    broad = next(i for i, line in enumerate(lines) if BROAD_OPEN.search(line))
    assert deny > broad, (
        f"{config.name}: blok zamykający stoi w linii {deny + 1}, a otwierający w {broad + 1}. "
        "Późniejsze `Require` zastępuje wcześniejsze, więc w tej kolejności zdrowie usługi "
        "i zlecanie zadań są osiągalne z zewnątrz. Przenieś blok zamykający niżej."
    )


def _internal_routes() -> list[str]:
    """Trasy usługi, które wymagają klucza wewnętrznego — czytane z kodu, nie z pamięci.

    Ręczna lista już raz się rozjechała: `/v1/title-worker` doszło do usługi, nie
    doszło do reguły w Apache i odpowiadało z zewnątrz, chronione wyłącznie kluczem.
    """
    source = (PROJECT_ROOT / "src" / "media_server" / "app.py").read_text(encoding="utf-8")
    routes = []
    for match in re.finditer(r'@app\.post\("/(v1/[a-z0-9-]+)"\)', source):
        body = source[match.end(): match.end() + 600]
        if "_internal_key_matches(" in body.split("@app.", 1)[0]:
            routes.append(match.group(1))
    return routes


def test_the_internal_routes_are_found_at_all() -> None:
    # Guards the guard: a refactor that renames the key check must not quietly
    # turn the test below into a loop over nothing.
    assert {"v1/catalog-scan", "v1/title-worker"} <= set(_internal_routes())


@pytest.mark.parametrize("config", TRANSFER_CONFIGS, ids=lambda p: p.name)
def test_the_closing_block_covers_every_internal_route(config: Path) -> None:
    """Każda trasa z kluczem wewnętrznym ma być zamknięta w Apache — plus zdrowie."""
    deny = next(line for line in _lines(config) if NARROW_DENY.search(line))
    for route in ["health", *_internal_routes()]:
        assert route in deny, f"{config.name}: trasa {route} nie jest zamknięta regułą w Apache"


BRIDGE_CONFIGS = [
    APACHE / "media-next.conf.example",
    APACHE / "media-next-stage-wamp.conf.example",
]


@pytest.mark.parametrize("config", BRIDGE_CONFIGS, ids=lambda p: p.name)
def test_the_bridge_names_its_own_caching(config: Path) -> None:
    """``Header always set Cache-Control`` on the bridge's address added a second header.

    The bridge sends ``no-store`` with every JSON answer, an hour for a cover and a
    few minutes for the redirect to a thumbnail. ``always set`` writes to another
    header table than the script's, so both went out — ``no-store`` beside
    ``private, max-age=3600`` — and a browser kept nothing: every cover of every
    listing was fetched again (live, 11.11.2026).

    The default is therefore conditional: only an answer without a ``Cache-Control``
    of its own gets one. Measured on Apache 2.4.65 with the PHP module and with a CGI
    script: ``setifempty`` (without ``always``) is right under the module, doubles the
    header under FastCGI — whose headers live in the other table — and leaves Apache's
    own refusals bare; ``always set … expr=-z %{resp:Cache-Control}`` is right in all
    three.
    """
    text = config.read_text(encoding="utf-8")
    block = re.search(r'<Location(?:Match)?\s+"\^?/media-next-api\$?">(.*?)</Location(?:Match)?>', text, re.S)
    assert block is not None, f"{config.name}: brak bloku mostu"
    directives = [line.strip() for line in block.group(1).splitlines() if line.strip() and not line.strip().startswith("#")]
    cache = [line for line in directives if "Cache-Control" in line]
    assert cache == ['Header always set Cache-Control "no-store" "expr=-z %{resp:Cache-Control}"'], (
        f"{config.name}: {cache}"
    )
