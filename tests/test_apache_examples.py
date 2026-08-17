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


@pytest.mark.parametrize("config", TRANSFER_CONFIGS, ids=lambda p: p.name)
def test_the_closing_block_still_covers_every_internal_route(config: Path) -> None:
    """Trasy wymienione w regule mają pokrywać to, co usługa naprawdę wystawia."""
    text = config.read_text(encoding="utf-8")
    for route in ("health", "v1/catalog-scan", "v1/metadata-worker", "v1/subtitle-cache", "v1/stats"):
        assert route in text, f"{config.name}: trasa {route} wypadła z reguły zamykającej"
