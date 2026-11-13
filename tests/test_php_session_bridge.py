from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

PHP_INTEGRATION = Path(__file__).resolve().parents[1] / "integrations" / "php"


def _php_eval(body: str) -> str:
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    requires = "".join(
        f"require {json.dumps(str(PHP_INTEGRATION / name))};"
        for name in (
            "BridgeException.php",
            "LegacyIdentity.php",
            "LegacySessionBridge.php",
        )
    )
    result = subprocess.run(
        [php, "-r", requires + body],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def test_legacy_identity_requires_full_session_and_normalizes_role() -> None:
    output = _php_eval(
        "$session=['logged_in'=>true,'user_id'=>'7','username'=>'tester',"
        "'is_admin'=>1,'is_super_admin'=>0,'is_guest'=>'1'];"
        "$identity=TryHackX\\Media\\Integration\\LegacyIdentity::fromLegacySession($session);"
        "echo json_encode($identity->publicProfile(), JSON_THROW_ON_ERROR);"
    )
    assert json.loads(output) == {
        "id": 7,
        "username": "tester",
        "role": "admin",
        "is_guest": True,
    }


@pytest.mark.parametrize(
    "session_code",
    [
        "['logged_in'=>true]",
        "['logged_in'=>true,'user_id'=>1,'username'=>\"bad\\nname\"]",
        "['logged_in'=>1,'user_id'=>1,'username'=>'tester']",
        "['logged_in'=>true,'user_id'=>'0','username'=>'tester']",
    ],
)
def test_legacy_identity_rejects_incomplete_or_ambiguous_session(session_code: str) -> None:
    output = _php_eval(
        f"$session={session_code};"
        "try { TryHackX\\Media\\Integration\\LegacyIdentity::fromLegacySession($session); echo 'accepted'; }"
        "catch (TryHackX\\Media\\Integration\\BridgeAuthenticationException) { echo 'rejected'; }"
    )
    assert output == "rejected"


def test_bridge_csrf_is_session_bound_stable_and_constant_time_checked() -> None:
    output = _php_eval(
        "$reflection=new ReflectionClass(TryHackX\\Media\\Integration\\LegacySessionBridge::class);"
        "$bridge=$reflection->newInstanceWithoutConstructor();$session=[];"
        "$first=$bridge->csrfToken($session);$second=$bridge->csrfToken($session);"
        "$bridge->assertCsrf($session,$first);$wrongRejected=false;"
        "try{$bridge->assertCsrf($session,str_repeat('A',43));}"
        "catch(TryHackX\\Media\\Integration\\BridgeAuthorizationException){$wrongRejected=true;}"
        "echo json_encode(['same'=>$first===$second,'length'=>strlen($first),'wrong_rejected'=>$wrongRejected],"
        "JSON_THROW_ON_ERROR);"
    )
    assert json.loads(output) == {"same": True, "length": 43, "wrong_rejected": True}
