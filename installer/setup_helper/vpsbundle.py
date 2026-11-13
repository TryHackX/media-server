"""The folder a home-server owner carries to the VPS: two Apache sites, one certificate, a guide.

Shape A of ``docs/PUBLIC-EXPOSURE.md`` — a VPS in front of the home machine, so
that the home address appears nowhere — is a dozen decisions that are easy to get
subtly wrong by hand: which headers the proxy must set and which it must delete,
where the long timeout belongs, how the proxy knows the machine it reaches is
really the home server. The wizard asks four questions and writes the answers
down as files that only need copying.

The templates live in ``installer/templates/vps``. Rendering is plain substitution
of ``{{NAME}}`` placeholders, and a placeholder left unfilled is an error rather
than a line of nonsense in somebody's Apache configuration.

Both installers produce this bundle from the same templates: the Windows wizard
(``Zainstaluj.cmd``) and the Debian installer (``zainstaluj-debian.sh``). What the
VPS is told to do is identical; what differs is the handful of sentences about
the *home* machine (which firewall was set, where the key lies, how to copy the
folder), kept in ``PLATFORM_TEXT``. A Debian home server additionally gets
``vps-setup.sh``: the same files and the same steps as the guide, in one script
that checks its own result and undoes itself when it fails.

Standard library only.
"""
from __future__ import annotations

import base64
import hashlib
import ipaddress
import re
from collections.abc import Mapping, Sequence
from pathlib import Path

from .apacheconf import ApacheConfError, normalise_addresses, normalise_host_name

SITE_NAME = "tryhackx-media"
PLATFORMS = ("windows", "debian")
# The line by which a file on the VPS is recognised as written by ``vps-setup.sh``.
SCRIPT_MARKER = "TRYHACKX-MEDIA-SERVER-MANAGED v1"
SETUP_SCRIPT = "vps-setup.sh"
SETUP_SCRIPT_TEMPLATE = "vps-setup.sh.tmpl"
_ACME_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
_PLACEHOLDER = re.compile(r"\{\{([A-Z0-9_]+)\}\}")
_PEM_BLOCK = re.compile(
    r"-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END CERTIFICATE-----", re.DOTALL
)

# Template → name in the bundle.
FILES: tuple[tuple[str, str], ...] = (
    ("site-http.conf.tmpl", f"{SITE_NAME}.conf"),
    ("site-https.conf.tmpl", f"{SITE_NAME}-ssl.conf"),
    ("maintenance.html", "maintenance.html"),
    ("INSTRUKCJA-VPS.md.tmpl", "INSTRUKCJA-VPS.md"),
    ("VPS-GUIDE.md.tmpl", "VPS-GUIDE.md"),
)

# The sentences about the home machine. Each may use the placeholders of the bundle
# itself ({{BUNDLE_DIR}}, {{VPS_PRIMARY}}, {{VPS_ADDRESSES}}); they are filled in
# before the sentence goes into a guide. The Windows texts are the ones the guides
# carried before a second platform existed, to the letter.
PLATFORM_TEXT: dict[str, dict[str, str]] = {
    "windows": {
        "GENERATOR": "the Windows wizard",
        "EXTRA_ROWS_PL": "",
        "EXTRA_ROWS_EN": "",
        "KEY_LOCATION_PL": "`config\\origin\\` w katalogu serwera",
        "KEY_LOCATION_EN": "`config\\origin\\` in the server folder",
        "HOME_FIREWALL_PL": (
            "Zaporę Windows kreator już ustawił: port 443 przyjmuje połączenia **tylko z adresu VPS**\n"
            "({{VPS_ADDRESSES}}). Dla reszty internetu Twój adres domowy wygląda, jakby nic na nim nie działało."
        ),
        "HOME_FIREWALL_EN": (
            "The wizard has already set Windows Firewall: port 443 accepts connections **only from the VPS**\n"
            "({{VPS_ADDRESSES}}). To the rest of the internet your home address looks as if nothing ran on it."
        ),
        # When the general "Apache HTTP Server" rules stayed on, or Windows Firewall is off, the
        # sentence above would promise what is not true (audit P2-6).
        "HOME_FIREWALL_UNMANAGED_PL": (
            "Zapora Windows **nie** wpuszcza tylko VPS: zostały włączone ogólne reguły „Apache HTTP Server”\n"
            "albo zapora jest wyłączona, więc port 443 przyjmuje połączenia od każdego i skaner internetu połączy\n"
            "Twój adres domowy z tą stroną. Włącz zaporę i uruchom kreator → „Sposób dostępu”, zostawiając\n"
            "zaznaczone wyłączenie ogólnych reguł: wtedy wejdzie tylko VPS ({{VPS_ADDRESSES}})."
        ),
        "HOME_FIREWALL_UNMANAGED_EN": (
            "Windows Firewall does **not** admit the VPS only: the general \"Apache HTTP Server\" rules stayed on\n"
            "or the firewall is off, so port 443 accepts connections from anybody and an internet scanner will tie\n"
            "your home address to this site. Switch the firewall on and run the wizard → \"Access mode\", leaving\n"
            "switching off the general rules ticked: then only the VPS gets in ({{VPS_ADDRESSES}})."
        ),
        # The old copy goes first: `scp -r` into a folder that already exists nests the new bundle
        # inside the old one, and the old origin.crt would be installed again (audit P3-19).
        "COPY_STEP_PL": (
            "Na komputerze domowym, w PowerShellu (Windows 10/11 ma `ssh` i `scp` wbudowane). Pierwsze\n"
            "polecenie usuwa poprzednią kopię paczki — bez niego nowa trafiłaby do środka starej:\n\n"
            '```powershell\nssh root@{{VPS_PRIMARY}} "rm -rf /root/tryhackx-bundle"\n'
            'scp -r "{{BUNDLE_DIR}}" root@{{VPS_PRIMARY}}:/root/tryhackx-bundle\n```'
        ),
        "COPY_STEP_EN": (
            "On the home computer, in PowerShell (Windows 10/11 ships `ssh` and `scp`). The first command\n"
            "removes the previous copy of the bundle — without it the new one would land inside the old:\n\n"
            '```powershell\nssh root@{{VPS_PRIMARY}} "rm -rf /root/tryhackx-bundle"\n'
            'scp -r "{{BUNDLE_DIR}}" root@{{VPS_PRIMARY}}:/root/tryhackx-bundle\n```'
        ),
        "STEP4_INTRO_PL": "",
        "STEP4_INTRO_EN": "",
        "STOP_HOME_PL": "ikona WampServer → Stop All Services",
        "STOP_HOME_EN": "WampServer icon → Stop All Services",
        "NEW_BUNDLE_HINT_PL": "po każdym „Wygeneruj certyfikat od nowa” w kreatorze paczka jest nowa",
        "NEW_BUNDLE_HINT_EN": 'every "Generate a new certificate" in the wizard produces a new bundle',
        # The tile's own name: there is no "Change settings" button (audit P3-18).
        "FIX_VPS_ADDRESS_PL": "uruchom `Zainstaluj.cmd` → „Sposób dostępu” i popraw adres VPS",
        "FIX_VPS_ADDRESS_EN": 'run `Install.cmd` → "Access mode" and correct the VPS address',
        "VPS_CHANGED_PL": (
            "w domu `Zainstaluj.cmd` → „Sposób dostępu”\n"
            "  (kreator poprawi zaporę i listę zaufanych proxy), u dostawcy domeny popraw rekord DNS."
        ),
        "VPS_CHANGED_EN": (
            'at home run `Install.cmd` → "Access mode" (the\n'
            "  wizard corrects the firewall and the trusted-proxy list), and fix the DNS record."
        ),
        "CERT_RENEW_PL": (
            "Przed tą datą wygeneruj\n"
            "  nowy w kreatorze („Dostęp” → „Wygeneruj certyfikat od nowa”) i skopiuj nowy `origin.crt` na VPS."
        ),
        "CERT_RENEW_EN": (
            "Before that date generate\n"
            '  a new one in the wizard ("Access" → "Generate a new certificate") and copy the new `origin.crt`\n'
            "  to the VPS."
        ),
        "HOME_NOTE_EXTRA_PL": "",
        "HOME_NOTE_EXTRA_EN": "",
    },
    "debian": {
        "GENERATOR": "zainstaluj-debian.sh",
        "EXTRA_ROWS_PL": (
            "\n| `vps-setup.sh` | nigdzie — uruchamiasz go na VPS; sam robi wszystko z kroku 4, sprawdza wynik "
            "i przy błędzie cofa zmiany |"
        ),
        "EXTRA_ROWS_EN": (
            "\n| `vps-setup.sh` | nowhere — you run it on the VPS; it does all of step 4 by itself, checks the "
            "result and undoes its changes when something fails |"
        ),
        "KEY_LOCATION_PL": "`/etc/tryhackx-media-server/origin/`",
        "KEY_LOCATION_EN": "`/etc/tryhackx-media-server/origin/`",
        "HOME_FIREWALL_PL": (
            "Zaporę (`ufw`) instalator już ustawił: port 443 przyjmuje połączenia **tylko z adresu VPS**\n"
            "({{VPS_ADDRESSES}}). Dla reszty internetu Twój adres domowy wygląda, jakby nic na nim nie działało."
        ),
        "HOME_FIREWALL_EN": (
            "The installer has already set the firewall (`ufw`): port 443 accepts connections **only from the VPS**\n"
            "({{VPS_ADDRESSES}}). To the rest of the internet your home address looks as if nothing ran on it."
        ),
        # Also when ufw was on already with a rule of somebody else's for 443 ("Apache Full"): the
        # installer's narrow rule is then not the only one letting anybody in (audit P3-3).
        "HOME_FIREWALL_UNMANAGED_PL": (
            "Zapora **nie wpuszcza tylko VPS-a**: instalator jej nie zmieniał (tak wybrano) albo była już włączona\n"
            "z regułą otwierającą port 443 dla wszystkich (np. `Apache Full`). Zadbaj, żeby port 443 przyjmował\n"
            "połączenia tylko z adresu VPS ({{VPS_ADDRESSES}}) — np. `sudo ufw delete allow 'Apache Full'` — inaczej\n"
            "skaner internetu połączy Twój adres domowy z tą stroną."
        ),
        "HOME_FIREWALL_UNMANAGED_EN": (
            "The firewall does **not** admit the VPS only: the installer did not touch it (as chosen), or it was on\n"
            "already with a rule opening port 443 to everybody (`Apache Full`, for one). Make sure port 443 accepts\n"
            "connections from the VPS only ({{VPS_ADDRESSES}}) — `sudo ufw delete allow 'Apache Full'`, for one —\n"
            "otherwise an internet scanner will tie your home address to this site."
        ),
        "COPY_STEP_PL": (
            "Instalator proponuje zrobić ten i następny krok za Ciebie przez SSH — przy instalacji albo później:\n"
            "`sudo bash zainstaluj-debian.sh --zmien vps`. Ręcznie, na serwerze domowym (pierwsze polecenie\n"
            "usuwa poprzednią kopię paczki — bez niego nowa trafiłaby do środka starej):\n\n"
            "```bash\nsudo ssh root@{{VPS_PRIMARY}} 'rm -rf /root/tryhackx-bundle'\n"
            "sudo scp -r {{BUNDLE_DIR}} root@{{VPS_PRIMARY}}:/root/tryhackx-bundle\n```"
        ),
        "COPY_STEP_EN": (
            "The installer offers to do this step and the next one for you over SSH — during installation or later:\n"
            "`sudo bash zainstaluj-debian.sh --zmien vps --lang en`. By hand, on the home server (the first command\n"
            "removes the previous copy of the bundle — without it the new one would land inside the old):\n\n"
            "```bash\nsudo ssh root@{{VPS_PRIMARY}} 'rm -rf /root/tryhackx-bundle'\n"
            "sudo scp -r {{BUNDLE_DIR}} root@{{VPS_PRIMARY}}:/root/tryhackx-bundle\n```"
        ),
        "STEP4_INTRO_PL": (
            "Najprościej jednym skryptem — robi wszystko, co niżej, sprawdza wynik i przy błędzie cofa zmiany:\n\n"
            "```bash\nbash /root/tryhackx-bundle/vps-setup.sh\n```\n\n"
            "Można go uruchamiać wielokrotnie; `--dry-run` tylko pokazuje, co zrobi, `--usun` zdejmuje konfigurację.\n"
            "Kod wyjścia 3 znaczy: VPS jest gotowy, ale dom jeszcze nie odpowiada (router, adres).\n"
            "To samo ręcznie, krok po kroku:\n\n"
        ),
        "STEP4_INTRO_EN": (
            "The simplest way is one script — it does everything below, checks the result and undoes its changes\n"
            "on failure:\n\n"
            "```bash\nbash /root/tryhackx-bundle/vps-setup.sh --lang en\n```\n\n"
            "It can be run again at any time; `--dry-run` only shows what it would do, `--usun` removes the\n"
            "configuration. Exit code 3 means: the VPS is ready, but home does not answer yet (router, address).\n"
            "The same by hand, step by step:\n\n"
        ),
        "STOP_HOME_PL": "`sudo systemctl stop apache2`, a potem `sudo systemctl start apache2`",
        "STOP_HOME_EN": "`sudo systemctl stop apache2`, then `sudo systemctl start apache2`",
        "NEW_BUNDLE_HINT_PL": "po każdej wymianie certyfikatu paczka jest nowa; `--odnow` wymienia go bez przerwy",
        "NEW_BUNDLE_HINT_EN": "every certificate change produces a new bundle; `--odnow` rotates it without downtime",
        "FIX_VPS_ADDRESS_PL": "uruchom w domu `sudo bash zainstaluj-debian.sh --zmien dostep` i popraw adres VPS",
        "FIX_VPS_ADDRESS_EN": (
            "at home run `sudo bash zainstaluj-debian.sh --zmien dostep --lang en` and correct the VPS address"
        ),
        "VPS_CHANGED_PL": (
            "w domu `sudo bash zainstaluj-debian.sh --zmien dostep`\n"
            "  (instalator poprawi zaporę, listę zaufanych proxy i tę paczkę), u dostawcy domeny popraw rekord DNS."
        ),
        "VPS_CHANGED_EN": (
            "at home run `sudo bash zainstaluj-debian.sh --zmien dostep --lang en` (the\n"
            "  installer corrects the firewall, the trusted-proxy list and this bundle), and fix the DNS record."
        ),
        "CERT_RENEW_PL": (
            "Przed tą datą uruchom w domu\n"
            "  `sudo bash zainstaluj-debian.sh --odnow` — wymienia certyfikat bez przerwy w działaniu strony\n"
            "  (VPS przez chwilę ufa staremu i nowemu)."
        ),
        "CERT_RENEW_EN": (
            "Before that date run\n"
            "  `sudo bash zainstaluj-debian.sh --odnow --lang en` at home — it replaces the certificate without\n"
            "  interrupting the site (for a moment the VPS trusts both the old and the new one)."
        ),
        "HOME_NOTE_EXTRA_PL": (
            " Bez ręcznej edycji: w domu `sudo bash zainstaluj-debian.sh --zmien dostep` z nowym adresem, potem "
            "jeszcze raz `vps-setup.sh` na VPS."
        ),
        "HOME_NOTE_EXTRA_EN": (
            " Without editing by hand: at home run `sudo bash zainstaluj-debian.sh --zmien dostep --lang en` with the "
            "new address, then `vps-setup.sh` on the VPS once more."
        ),
    },
}

# The Windows bundle carries vps-setup.sh too (audit P3-22): its row in the file table and the
# "one script" way of step 4 read the same on both systems - nothing in them is Debian-at-home.
for _key in ("EXTRA_ROWS_PL", "EXTRA_ROWS_EN", "STEP4_INTRO_PL", "STEP4_INTRO_EN"):
    PLATFORM_TEXT["windows"][_key] = PLATFORM_TEXT["debian"][_key]
del _key

# What ``vps-setup.sh`` carries inside itself: placeholder in the script, file of
# the bundle, the here-document delimiter that closes it.
_PAYLOADS: tuple[tuple[str, str, str], ...] = (
    ("PAYLOAD_HTTP_SITE", f"{SITE_NAME}.conf", "__TRYHACKX_PAYLOAD_HTTP_SITE__"),
    ("PAYLOAD_HTTPS_SITE", f"{SITE_NAME}-ssl.conf", "__TRYHACKX_PAYLOAD_HTTPS_SITE__"),
    ("PAYLOAD_MAINTENANCE", "maintenance.html", "__TRYHACKX_PAYLOAD_MAINTENANCE__"),
    ("PAYLOAD_ORIGIN", "origin.crt", "__TRYHACKX_PAYLOAD_ORIGIN__"),
)
# Values the script holds between single quotes.
_QUOTED_IN_SCRIPT = ("DOMAIN", "SITE", "HOME_TARGET", "CERT_SHA256", "ACME_EMAIL", "ACME_AGREE", "LANGUAGE", "MARKER")


class BundleError(ValueError):
    """The bundle could not be produced; nothing usable was written."""


def home_target(address: str) -> tuple[str, str]:
    """How the home machine is written inside a ``https://…/`` URL, and what kind of address it is.

    An IPv4 address is what almost everybody has; a host name means dynamic DNS;
    an IPv6 address needs brackets.
    """
    candidate = address.strip()
    try:
        parsed = ipaddress.ip_address(candidate.strip("[]"))
    except ValueError:
        try:
            return normalise_host_name(candidate), "name"
        except ApacheConfError as exc:
            raise BundleError(
                f"„{address}” nie jest adresem IP ani nazwą hosta (np. 203.0.113.10 albo dom.example.org)"
            ) from exc
    if parsed.is_loopback or parsed.is_unspecified or parsed.is_multicast:
        raise BundleError(f"„{address}” nie jest adresem, pod którym VPS znajdzie komputer w domu")
    if parsed.version == 6:
        return f"[{parsed.compressed}]", "ipv6"
    return str(parsed), "ipv4"


def certificate_fingerprint(pem: str) -> str:
    """SHA-256 of the certificate, written the way ``openssl x509 -fingerprint -sha256`` prints it."""
    match = _PEM_BLOCK.search(pem)
    if match is None:
        raise BundleError("Plik certyfikatu serwera domowego nie zawiera certyfikatu PEM")
    try:
        der = base64.b64decode("".join(match.group(1).split()), validate=True)
    except ValueError as exc:
        raise BundleError("Certyfikat serwera domowego jest uszkodzony") from exc
    digest = hashlib.sha256(der).hexdigest().upper()
    return ":".join(digest[i:i + 2] for i in range(0, len(digest), 2))


def _first_certificate(pem: str) -> str:
    match = _PEM_BLOCK.search(pem)
    if match is None:
        raise BundleError("Plik certyfikatu serwera domowego nie zawiera certyfikatu PEM")
    return match.group(0).strip() + "\n"


def render(template: str, values: Mapping[str, str], name: str) -> str:
    def substitute(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in values:
            raise BundleError(f"Szablon {name}: brak wartości dla {{{{{key}}}}}")
        return values[key]

    return _PLACEHOLDER.sub(substitute, template)


def build_values(
    *,
    host_name: str,
    home_address: str,
    vps_addresses: Sequence[str],
    lan_address: str,
    bundle_dir: str,
    certificate_pem: str,
    certificate_not_after: str,
    generated: str,
    platform: str = "windows",
    language: str = "pl",
    acme_email: str = "",
    acme_agree: bool = False,
    firewall_managed: bool = True,
) -> dict[str, str]:
    if platform not in PLATFORMS:
        raise BundleError(f"Nieznana platforma serwera domowego: {platform}")
    if language not in {"pl", "en"}:
        raise BundleError(f"Nieznany język paczki: {language}")
    email = acme_email.strip()
    if email and _ACME_EMAIL.fullmatch(email) is None:
        raise BundleError(f"„{acme_email}” nie wygląda na adres e-mail (potrzebny dla Let's Encrypt)")
    domain = normalise_host_name(host_name)
    try:
        addresses = normalise_addresses(vps_addresses)
    except ApacheConfError as exc:
        raise BundleError(str(exc)) from exc
    if not addresses:
        raise BundleError("Podaj co najmniej jeden adres VPS")
    target, kind = home_target(home_address)
    if kind != "name" and target.strip("[]") in addresses:
        raise BundleError("Adres domowy i adres VPS są takie same — to muszą być dwie różne maszyny")
    for value in (lan_address, bundle_dir, certificate_not_after, generated):
        if "{{" in value or "\n" in value or "\r" in value:
            raise BundleError("Niedozwolone znaki w danych paczki")

    dns_rows = []
    for address in addresses:
        record = "AAAA" if ipaddress.ip_address(address).version == 6 else "A"
        dns_rows.append(f"| `{record}` | `{domain}` | `{address}` |")
    primary = next((a for a in addresses if ipaddress.ip_address(a).version == 4), addresses[0])
    site_file = f"{SITE_NAME}-ssl.conf"
    if kind == "name":
        note_pl = (
            f"VPS łączy się z domem po nazwie `{target}`, więc wystarczy, że dynamiczny DNS nadąża. Apache "
            "sprawdza nazwę przy starcie — po zmianie adresu wykonaj na VPS `systemctl reload apache2` "
            "(albo dodaj to polecenie do crona, np. co godzinę)."
        )
        note_en = (
            f"the VPS reaches home by the name `{target}`, so dynamic DNS only has to keep up. Apache "
            "resolves the name when it starts — after a change run `systemctl reload apache2` on the VPS "
            "(or put that command in cron, hourly for instance)."
        )
    else:
        note_pl = (
            f"w pliku `/etc/apache2/sites-available/{site_file}` zamień stary adres na nowy w trzech "
            "liniach (`ProxyPass` ×2 i `ProxyPassReverse`), potem `apache2ctl configtest && systemctl "
            "reload apache2`. Jeśli adres zmienia się często, załóż dynamiczny DNS i podaj kreatorowi "
            "nazwę zamiast adresu."
        )
        note_en = (
            f"in `/etc/apache2/sites-available/{site_file}` replace the old address with the new one in "
            "three lines (`ProxyPass` ×2 and `ProxyPassReverse`), then `apache2ctl configtest && systemctl "
            "reload apache2`. If the address changes often, set up dynamic DNS and give the wizard the "
            "name instead of the address."
        )
    values = {
        "DOMAIN": domain,
        "SITE": SITE_NAME,
        "HOME_TARGET": target,
        "HOME_ADDRESS": target.strip("[]"),
        "HOME_NOTE_PL": note_pl,
        "HOME_NOTE_EN": note_en,
        "VPS_ADDRESSES": ", ".join(addresses),
        "VPS_PRIMARY": primary,
        "LAN_IP": lan_address or "ADRES-KOMPUTERA-W-SIECI-DOMOWEJ",
        "BUNDLE_DIR": bundle_dir,
        "CERT_SHA256": certificate_fingerprint(certificate_pem),
        "CERT_NOT_AFTER": certificate_not_after or "—",
        "DNS_RECORDS": "\n".join(dns_rows),
        "GENERATED": generated,
    }
    # The sentences about the home machine, with the bundle's own values filled in.
    texts = dict(PLATFORM_TEXT[platform])
    unmanaged_pl = texts.pop("HOME_FIREWALL_UNMANAGED_PL")
    unmanaged_en = texts.pop("HOME_FIREWALL_UNMANAGED_EN")
    extra_pl, extra_en = texts.pop("HOME_NOTE_EXTRA_PL"), texts.pop("HOME_NOTE_EXTRA_EN")
    if kind != "name":
        # With a dynamic name nothing has to be edited; with a bare address the installer can redo it.
        values["HOME_NOTE_PL"] += extra_pl
        values["HOME_NOTE_EN"] += extra_en
    if not firewall_managed and unmanaged_pl:
        texts["HOME_FIREWALL_PL"], texts["HOME_FIREWALL_EN"] = unmanaged_pl, unmanaged_en
    for key, text in texts.items():
        values[key] = render(text, values, f"PLATFORM_TEXT[{platform}][{key}]")
    values.update(
        {
            "PLATFORM": platform,
            "LANGUAGE": language,
            "MARKER": SCRIPT_MARKER,
            "ACME_EMAIL": email,
            "ACME_AGREE": "1" if acme_agree else "0",
        }
    )
    return values


def render_setup_script(template: str, values: Mapping[str, str], files: Mapping[str, str]) -> str:
    """``vps-setup.sh``: the guide's fourth step as one script, carrying the bundle's files inside itself.

    The script must not be able to say anything the files do not, so what it
    writes on the VPS is the text of the bundle's own files, embedded verbatim.
    """
    for key in _QUOTED_IN_SCRIPT:
        if any(ch in values[key] for ch in "'\\\n\r"):
            raise BundleError(f"Wartości {key} nie da się bezpiecznie zapisać w skrypcie dla VPS")
    for key in ("GENERATOR", "GENERATED"):
        if "\n" in values[key] or "\r" in values[key]:
            raise BundleError(f"Wartości {key} nie da się zapisać w komentarzu skryptu dla VPS")
    payloads: dict[str, str] = {}
    for placeholder, name, delimiter in _PAYLOADS:
        text = files[name].replace("\r\n", "\n").rstrip("\n")
        if delimiter in text.split("\n"):
            raise BundleError(f"Plik {name} zawiera linię, która zakończyłaby go w skrypcie przedwcześnie")
        payloads[placeholder] = text
    return render(template.replace("\r\n", "\n"), {**values, **payloads}, SETUP_SCRIPT_TEMPLATE)


def embedded_payloads(script: str) -> dict[str, str]:
    """The files a rendered ``vps-setup.sh`` carries, as it would write them — for tests and for doubt."""
    found: dict[str, str] = {}
    for _placeholder, name, delimiter in _PAYLOADS:
        match = re.search(rf"<<'{delimiter}'\n(.*?)\n{delimiter}\n", script, re.DOTALL)
        if match is None:
            raise BundleError(f"Skrypt dla VPS nie zawiera pliku {name}")
        found[name] = match.group(1) + "\n"
    return found


def render_bundle(template_dir: Path, values: Mapping[str, str], certificate_pem: str) -> dict[str, str]:
    """Every file of the bundle as ``name → text``; nothing is written here."""
    files: dict[str, str] = {}
    for template_name, target_name in FILES:
        template = (template_dir / template_name).read_text(encoding="utf-8")
        files[target_name] = render(template, values, template_name)
    # Only the certificate itself — a file that also held a key would be caught here.
    files["origin.crt"] = _first_certificate(certificate_pem)
    # Both platforms: the VPS is Debian or Ubuntu whatever the home runs, and the script's checks and
    # rollback are what a Windows user needs as much (audit P3-22).
    script = (template_dir / SETUP_SCRIPT_TEMPLATE).read_text(encoding="utf-8")
    files[SETUP_SCRIPT] = render_setup_script(script, values, files)
    return files


def write_bundle(output_dir: Path, files: Mapping[str, str]) -> list[str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    written: list[str] = []
    for name, text in files.items():
        target = output_dir / name
        # LF everywhere: these files are read on Linux.
        with open(target, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text.replace("\r\n", "\n"))
        if name.endswith(".sh"):
            target.chmod(0o755)
        written.append(str(target))
    return written
