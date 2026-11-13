"""Stopping FFmpeg and giving back what a compatibility stream held.

Two failures, both reproduced here with an ordinary child process instead of
FFmpeg, so they run on any machine CI has:

* Since Python 3.12 ``Process.wait()`` resolves only once the child has exited
  **and** every pipe to it has reached its end. A stdout nobody reads any more —
  the read-ahead buffer is full because the viewer paused — never reaches it.
  FFmpeg blocked writing into that full pipe does not act on SIGTERM, so the
  grace period ran out, the kill followed, and the wait started right after it
  never finished: the seek that asked for the stop hung with it. Windows kills
  on ``terminate()`` already, so there the hang needs an FFmpeg that outlives the
  first signal; the tests simulate that by making ``terminate()`` do nothing,
  which is what SIGTERM amounts to for an FFmpeg stuck in ``write()``.
* Starlette ends a streamed response on disconnect by cancelling it through an
  anyio cancel scope, and anyio cancels **every** ``await`` inside that scope,
  including the ones in ``finally``. The cleanup that stops FFmpeg, returns the
  transfer slot and lowers the transfer counter never got past its first line.
"""
from __future__ import annotations

import asyncio
import subprocess
import sys
import time
from dataclasses import replace
from pathlib import Path

import anyio

import media_server.app as app_module
from media_server import stereo
from media_server.app import create_app
from media_server.config import AppConfig, StereoConfig
from media_server.paths import ResolvedItem
from media_server.security import GrantItem, seal_grant
from media_server.stereo import CompatibleProcessRegistry, compatible_media_chunks

# A stand-in for FFmpeg that writes as fast as the pipe allows and never stops.
_FLOOD = "import sys\nchunk = b'x' * 65536\nwhile True:\n    sys.stdout.buffer.write(chunk)\n"
# A stand-in for FFmpeg that says a little and then has nothing more to say.
_STALL = "import sys, time\nsys.stdout.buffer.write(b'x' * 1024)\nsys.stdout.buffer.flush()\ntime.sleep(3600)\n"


def _resolved(path: Path) -> ResolvedItem:
    stat = path.stat()
    return ResolvedItem(path.resolve(), path.name, stat.st_size, stat.st_mtime_ns)


def _ignore_sigterm(process: asyncio.subprocess.Process) -> None:
    """Make the polite stop do nothing, as SIGTERM does for FFmpeg stuck in write()."""
    process.terminate = lambda: None  # type: ignore[method-assign]


def _kill_leftover(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        try:
            process._transport._proc.kill()  # noqa: SLF001 - the test's own cleanup
        except (AttributeError, OSError):
            pass


async def _until_reading_paused(process: asyncio.subprocess.Process) -> None:
    """Wait until the event loop has stopped reading the child's stdout.

    That is the state a paused viewer leaves behind: the read-ahead queue is full,
    the stream reader's buffer is over its limit, and the transport stops asking
    the pipe for more.
    """
    pipe = process._transport.get_pipe_transport(1)  # noqa: SLF001 - the precondition itself
    deadline = time.monotonic() + 15
    while pipe.is_reading():
        assert time.monotonic() < deadline, "the stdout pipe never filled up"
        await asyncio.sleep(0.02)


def test_stopping_a_process_does_not_wait_for_a_pipe_nobody_reads() -> None:
    async def scenario() -> float:
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-c", _FLOOD,
            stdin=subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=64 * 1024,
        )
        try:
            await _until_reading_paused(process)
            _ignore_sigterm(process)
            started = time.monotonic()
            await asyncio.wait_for(stereo._stop_process(process), timeout=30)
            assert process.returncode is not None
            return time.monotonic() - started
        finally:
            _kill_leftover(process)

    # Closing our end of the pipe is what lets the wait finish — and it also
    # ends a writer that ignored the polite signal, well inside the grace period.
    assert asyncio.run(scenario()) < 10


def test_a_seek_is_not_held_up_by_the_stream_it_replaces(tmp_path: Path, monkeypatch) -> None:
    """The exact path a seek takes: ``begin()`` stops the previous FFmpeg."""
    film = tmp_path / "film.mkv"
    film.write_bytes(b"film")
    monkeypatch.setattr(stereo, "compatible_stream_command", lambda *_args, **_kwargs: [sys.executable, "-c", _FLOOD])
    monkeypatch.setattr(stereo, "_PIPE_LIMIT_BYTES", 64 * 1024)
    monkeypatch.setattr(stereo, "_READAHEAD_BYTES", 256 * 1024)

    async def scenario() -> None:
        registry = CompatibleProcessRegistry()
        generation = await registry.begin("viewer-1")
        body = compatible_media_chunks(
            _resolved(film), StereoConfig(ffmpeg_path="ffmpeg"), 64 * 1024,
            stream_id="viewer-1", stream_generation=generation, process_registry=registry,
        )
        # The viewer took one fragment and paused; FFmpeg ran ahead until both the
        # read-ahead queue and the pipe were full.
        assert await anext(body)
        process = registry._processes["viewer-1"][1]
        try:
            await _until_reading_paused(process)
            _ignore_sigterm(process)
            started = time.monotonic()
            await asyncio.wait_for(registry.begin("viewer-1"), timeout=30)
            assert time.monotonic() - started < 10
            assert process.returncode is not None
            # The superseded body winds down by itself instead of waiting on FFmpeg.
            await asyncio.wait_for(body.aclose(), timeout=15)
        finally:
            _kill_leftover(process)

    asyncio.run(scenario())


def test_a_cancelled_stream_still_stops_its_ffmpeg(tmp_path: Path, monkeypatch) -> None:
    """Cancelled the way Starlette cancels a response, while waiting for output."""
    film = tmp_path / "film.mkv"
    film.write_bytes(b"film")
    monkeypatch.setattr(stereo, "compatible_stream_command", lambda *_args, **_kwargs: [sys.executable, "-c", _STALL])

    async def scenario() -> None:
        registry = CompatibleProcessRegistry()
        generation = await registry.begin("viewer-2")
        body = compatible_media_chunks(
            _resolved(film), StereoConfig(ffmpeg_path="ffmpeg"), 64 * 1024,
            stream_id="viewer-2", stream_generation=generation, process_registry=registry,
        )
        first_fragment = asyncio.Event()

        async def respond() -> None:
            async for _ in body:
                first_fragment.set()

        async with anyio.create_task_group() as group:
            group.start_soon(respond)
            await asyncio.wait_for(first_fragment.wait(), timeout=15)
            process = registry._processes["viewer-2"][1]
            # The viewer disconnected while the body waited for FFmpeg.
            group.cancel_scope.cancel()
        try:
            assert process.returncode is not None
            assert "viewer-2" not in registry._processes
        finally:
            _kill_leftover(process)

    asyncio.run(scenario())


class _Lease:
    async def release(self) -> None:
        return None


def test_a_retired_stream_does_not_drop_the_counter_of_the_seek_that_retired_it() -> None:
    """The old stream's cleanup lands between the seek's ``begin()`` and its lease."""
    async def scenario() -> None:
        registry = CompatibleProcessRegistry()
        first = await registry.begin("viewer-3")
        old_lease = _Lease()
        assert await registry.bind_lease("viewer-3", first, old_lease)
        second = await registry.begin("viewer-3")  # the seek
        await registry.discard_lease("viewer-3", first, old_lease)  # the old body winds down
        assert await registry.bind_lease("viewer-3", second, _Lease()), "the seek was refused as superseded"
        assert await registry.is_current("viewer-3", second)

    asyncio.run(scenario())


def _compatible_token(config: AppConfig, path: str) -> str:
    return seal_grant(
        key=config.security.transfer_key,
        kind="file",
        items=[GrantItem(root="music", path=path)],
        download_name=Path(path).name,
        disposition="inline",
        ttl_seconds=900,
        subject="7",
        max_streams=1,
        purpose="compat",
    )


def test_a_viewer_who_leaves_gives_back_the_slot_and_the_counter(
    app_config: AppConfig, media_root: Path, monkeypatch
) -> None:
    """The whole route, driven the way uvicorn drives it (ASGI spec 2.3)."""
    (media_root / "movie.mkv").write_bytes(b"video-source")
    config = replace(app_config, stereo=StereoConfig(ffmpeg_path="ffmpeg", max_concurrent_jobs=1))
    token = _compatible_token(config, "movie.mkv")
    finished: list[str] = []

    async def stalled_chunks(*_args, **_kwargs):
        try:
            yield b"fragment-one"
            await asyncio.sleep(3600)  # FFmpeg has nothing more to say yet
            yield b"never"
        finally:
            finished.append("body")

    async def fake_info(*_args, **_kwargs) -> dict[str, object]:
        return {"duration_seconds": 60.0, "video_codec": "h264", "audio_tracks": [], "subtitle_tracks": []}

    monkeypatch.setattr(app_module, "compatible_media_chunks", stalled_chunks)
    monkeypatch.setattr(app_module, "probe_media_info", fake_info)
    application = create_app(config)

    async def scenario() -> list[dict]:
        left = asyncio.Event()
        sent: list[dict] = []
        asked = False

        async def receive() -> dict:
            nonlocal asked
            if not asked:
                asked = True
                return {"type": "http.request", "body": b"", "more_body": False}
            await left.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict) -> None:
            sent.append(message)
            if message["type"] == "http.response.body" and message.get("body"):
                left.set()  # the viewer leaves right after the first fragment

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": f"/v1/stereo/{token}",
            "raw_path": f"/v1/stereo/{token}".encode("ascii"),
            "query_string": b"stream_id=viewer-123456",
            "root_path": "",
            "headers": [],
            "client": ("127.0.0.1", 50000),
            "server": ("127.0.0.1", 8765),
        }
        await asyncio.wait_for(application(scope, receive, send), timeout=15)
        return sent

    sent = asyncio.run(scenario())
    assert sent[0]["status"] == 200
    assert finished == ["body"]
    state = application.state
    assert not state.stereo_semaphore.locked(), "the transfer slot was never given back"
    assert state.metrics.transfers_active == 0, "the transfer counter stayed up"
    assert state.subject_streams._streams == {}, "the account's stream stayed counted"
    assert state.compatible_processes._leases == {}
