# Licence and attribution

This project is distributed under the **MIT** licence (see `LICENSE`; copyright holder: TryHackX).

## Origin of the transfer design

Single-range HTTP handling, memory-bounded reads and ZIP64 archives built with the STORE method
were designed after patterns from
[TryHackX-Files](https://github.com/TryHackX/TryHackX-Files), which is published under the
PolyForm Noncommercial 1.0.0 licence. The code in this repository is an independent Python
implementation of those patterns (`src/media_server/ranges.py`, `streaming.py`, `zipstream.py`).

Both projects belong to the same owner, so the MIT licence above applies to this repository in
full. If code is ever copied verbatim from the reference project, the corresponding PolyForm
Noncommercial notice must be added to `LICENSE` for those parts.

## Dependencies

Python and npm dependencies carry their own licences (MIT / BSD / Apache-2.0 / PSF); the complete
list follows from `requirements*.lock` and `frontend/package-lock.json`. Font Awesome Free is
bundled under CC BY 4.0 (icons), SIL OFL 1.1 (fonts) and MIT (code).
