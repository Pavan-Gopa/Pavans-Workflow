#!/usr/bin/env python3
"""Deterministic tests for workflow_skills.py (show, set, apply, check, atomic writes)."""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).with_name("workflow_skills.py")
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("workflow_skills", SCRIPT)
assert spec and spec.loader
ws = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ws)

DESIGNERS = ("workflow-designer", "workflow-designer-backup", "workflow-design-advisor", "workflow-design-advisor-backup")


def shipped_agent(rel: str) -> bytes:
    """This checkout's agent file as upstream ships it: local additions removed and, since the tests assert
    the canonical `autoloadSkills: [...]` spelling, a hand-spelled line (an installed project may have one)
    rewritten to it."""
    data = ws.upstream_bytes(ROOT, rel, (ROOT / rel).read_bytes())
    lines = ws._lines(data.decode("utf-8"))
    index = ws._line_index(lines, ws._frontmatter_end(lines))
    if index is not None:
        lines[index] = "autoloadSkills: " + json.dumps(ws.read_skills(data.decode("utf-8"))) + ws._split_line(lines[index])[1]
    return "".join(lines).encode("utf-8")


def make_project(path: Path) -> Path:
    """A project holding this checkout's agent files as upstream ships them (any local additions removed)."""
    agents = path / ".omp/agents"
    agents.mkdir(parents=True)
    for source in sorted((ROOT / ".omp/agents").glob("workflow-*.md")):
        rel = f".omp/agents/{source.name}"
        (path / rel).write_bytes(shipped_agent(rel))
    return path


def snapshot(project: Path) -> dict[str, bytes]:
    return {str(p.relative_to(project)): p.read_bytes() for p in sorted(project.rglob("*")) if p.is_file()}


def cli(project: Path, *args: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    return subprocess.run([sys.executable, str(SCRIPT), *args, "--target", str(project)], capture_output=True, text=True, env=env)


def rejected(project: Path, agents: list[str], skills: list[str], needle: str) -> None:
    before = snapshot(project)
    try:
        ws.commit(project, ws.plan_set(project, agents, skills))
    except ws.SkillsError as error:
        assert needle in str(error), (needle, str(error))
    else:
        raise AssertionError(f"expected rejection containing {needle!r}")
    assert snapshot(project) == before, "a rejected set changed files"


def by_agent(project: Path) -> dict[str, dict]:
    return {entry["agent"]: entry for entry in ws.show(project)["agents"]}


# Every spelling of the key and list OMP's own parseFrontmatter accepts (pi-utils/src/frontmatter.ts),
# each with LF and CRLF newlines. A None line means the agent file has no autoloadSkills line at all.
VARIANTS = (
    ("canonical", 'autoloadSkills: ["ponytail"]'),
    ("spaced list", 'autoloadSkills: [ "ponytail" ]'),
    ("single-quoted items", "autoloadSkills: [ 'ponytail' ]"),
    ("space before colon", 'autoloadSkills : ["ponytail"]'),
    ("double-quoted key", '"autoloadSkills": ["ponytail"]'),
    ("single-quoted key", "'autoloadSkills': ['ponytail']"),
    ("kebab-case key", "autoload-skills: [ponytail]"),
    ("trailing comment", 'autoloadSkills: ["ponytail"] # the coder'),
    ("explicit empty list", "autoloadSkills: []"),
    ("empty list with space", "autoloadSkills: [ ]"),
    ("missing line", None),
)


def omp_autoload(texts: list[str]) -> list[list[str] | None] | None:
    """What OMP's own parseFrontmatter (the pinned package, run by Bun) reads as autoloadSkills in each
    text; None when Bun or the package is unavailable. WF_REQUIRE_OMP=1 (CI's OMP job) makes that an error."""
    bun = os.environ.get("WF_OMP_BUN") or shutil.which("bun")
    module = ROOT / "ci/typecheck/node_modules/@oh-my-pi/pi-utils/src/frontmatter.ts"
    if not bun or not module.is_file():
        assert os.environ.get("WF_REQUIRE_OMP") != "1", f"WF_REQUIRE_OMP=1 but bun or {module} is missing"
        return None
    script = (
        f"import {{ parseFrontmatter }} from {json.dumps(str(module))};\n"
        "const texts = JSON.parse(await Bun.stdin.text());\n"
        'console.log(JSON.stringify(texts.map((t: string) => parseFrontmatter(t, { level: "off" }).frontmatter.autoloadSkills ?? null)));\n'
    )
    with tempfile.TemporaryDirectory() as raw:
        runner = Path(raw) / "omp_frontmatter.ts"
        runner.write_text(script, encoding="utf-8")
        done = subprocess.run([bun, str(runner)], input=json.dumps(texts), capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


def skills_line_count(text: str) -> int:
    return sum(1 for line in text.split("\n") if ws._KEY.match(line))


def variants(root: Path) -> None:
    """Install, set, verify and check against every key/list spelling and newline style."""
    original_text = shipped_agent(".omp/agents/workflow-coder.md").decode("utf-8")
    shipped = next(line for line in original_text.split("\n") if ws._KEY.match(line))
    cases = []
    for name, line in VARIANTS:
        for newline in ("\n", "\r\n"):
            text = original_text.replace(shipped + "\n", "" if line is None else line + "\n")
            assert (line is None) == (skills_line_count(text) == 0)
            cases.append((f"{name} {'CRLF' if newline == chr(13) + chr(10) else 'LF'}", text.replace("\n", newline)))
    after_texts: list[str] = []
    for index, (label, text) in enumerate(cases):
        project = root / str(index)
        (project / ".omp/agents").mkdir(parents=True)
        coder = project / ".omp/agents/workflow-coder.md"
        coder.write_bytes(text.encode("utf-8"))
        original = coder.read_bytes()
        defaults = ws.read_skills(text) or []

        ws.commit(project, ws.plan_set(project, ["workflow-coder"], ["graphify"]))
        after = coder.read_bytes().decode("utf-8")
        after_texts.append(after)
        assert skills_line_count(after) == 1, (label, "the existing key is replaced, never duplicated", after)
        assert ws.read_skills(after) == [*defaults, "graphify"], (label, after)
        assert after.count("\r\n") == (after.count("\n") if "CRLF" in label else 0), (label, "newline bytes preserved")
        assert ws.check(project)[0][0] == "OK", (label, ws.check(project))
        assert ws.upstream_bytes(project, ".omp/agents/workflow-coder.md", after.encode("utf-8")) == original, (label, "digest input is the shipped file")
        assert ws.plan_apply(project) == ({}, []), (label, "apply is idempotent")
        assert by_agent(project)["workflow-coder"]["added"] == ["graphify"], label
        # set again with the same names changes nothing
        ws.commit(project, ws.plan_set(project, ["workflow-coder"], ["graphify"]))
        assert coder.read_bytes().decode("utf-8") == after, label

        ws.commit(project, ws.plan_set(project, ["workflow-coder"], []))
        assert coder.read_bytes() == original, (label, "removal restores the file byte for byte")
        assert not (project / ws.OVERLAY_REL).exists(), label

    reads = omp_autoload(after_texts)
    if reads is None:
        print("SKIP workflow_skills.selftest: OMP frontmatter parity (bun or the pinned @oh-my-pi/pi-utils not available)")
    else:
        for (label, _), text, loaded in zip(cases, after_texts, reads):
            assert loaded == ws.read_skills(text), (label, "OMP reads", loaded, "helper reads", ws.read_skills(text))
            assert "graphify" in (loaded or []), (label, "the added skill is effective in OMP", loaded)

    # two spellings of the key in one file cannot be resolved safely
    project = root / "dup"
    (project / ".omp/agents").mkdir(parents=True)
    twice = original_text.replace(shipped + "\n", shipped + "\nautoload-skills: [x]\n")
    (project / ".omp/agents/workflow-coder.md").write_text(twice, encoding="utf-8")
    rejected(project, ["workflow-coder"], ["graphify"], "more than once")


def membership(root: Path) -> None:
    """`has` (the doctor's check) matches list members only: not comments, longer names or other keys."""
    project = root
    (project / ".omp/agents").mkdir(parents=True)
    cases = (
        ('autoloadSkills: []  # ponytail', 1),
        ('autoloadSkills: ["ponytail-review"]', 1),
        ('autoloadSkills: ["not-ponytail"]', 1),
        ('autoloadSkills: ["x", "ponytail"]', 0),
        ("autoloadSkills : [ 'ponytail' , x ]", 0),
        ('"autoloadSkills": [ponytail]', 0),
    )
    for line, expected in cases:
        text = f"---\nname: workflow-coder\nmodel: m\n{line}\ndescription: ponytail\n---\nbody ponytail\n"
        (project / ".omp/agents/workflow-coder.md").write_text(text, encoding="utf-8")
        assert cli(project, "has", "--agent", "workflow-coder", "--skill", "ponytail").returncode == expected, line


def main() -> int:
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        project = make_project(tmp / "p")
        pristine = snapshot(project)

        # --- show: the 16 agents, defaults only -------------------------------------
        shown = ws.show(project)
        agents = by_agent(project)
        assert len(agents) == 16 and shown["warnings"] == [] and shown["version"] == 1, shown
        base = {name: entry["effective"] for name, entry in agents.items()}  # whatever this release ships
        cb, bb = base["workflow-coder"], base["workflow-coder-backup"]
        assert "ponytail" in cb and agents["workflow-coder"]["workflow"] == cb
        assert agents["workflow-coder"]["added"] == [] and agents["workflow-coder"]["file"] == ".omp/agents/workflow-coder.md"

        for name in DESIGNERS:
            assert agents[name]["forbidden"] == ["ponytail"], name
            assert "ponytail" not in base[name], name
        assert agents["workflow-coder"]["forbidden"] == [] and agents["workflow-architect"]["forbidden"] == []
        assert not {"graphify", "web-design-guidelines", "x-y"} & {s for skills in base.values() for s in skills}, "test names must not be defaults"

        # --- set then show round-trips; the overlay is project data -------------------
        ws.commit(project, ws.plan_set(project, ["workflow-coder", "workflow-coder-backup"], ["graphify", "web-design-guidelines"]))
        agents = by_agent(project)
        for name, defaults in (("workflow-coder", cb), ("workflow-coder-backup", bb)):
            assert agents[name]["effective"] == [*defaults, "graphify", "web-design-guidelines"], agents[name]
            assert agents[name]["added"] == ["graphify", "web-design-guidelines"] and agents[name]["workflow"] == defaults
        assert (project / ".omp/agents/workflow-coder.md").read_text().count("autoloadSkills: " + json.dumps([*cb, "graphify", "web-design-guidelines"]) + "\n") == 1
        assert json.loads((project / ws.OVERLAY_REL).read_text()) == {
            "version": 1,
            "added": {"workflow-coder": ["graphify", "web-design-guidelines"], "workflow-coder-backup": ["graphify", "web-design-guidelines"]},
        }
        assert by_agent(project)["workflow-tester"]["added"] == [], "other agents are untouched"

        # replacing: previous additions are removed, defaults stay and keep their order
        ws.commit(project, ws.plan_set(project, ["workflow-coder"], ["x-y", "graphify"]))
        assert by_agent(project)["workflow-coder"]["effective"] == [*cb, "graphify", "x-y"]
        assert by_agent(project)["workflow-coder-backup"]["effective"] == [*bb, "graphify", "web-design-guidelines"]

        # --- apply twice gives the same files -----------------------------------------
        coder = project / ".omp/agents/workflow-coder.md"
        coder.write_bytes(pristine[".omp/agents/workflow-coder.md"])  # an upstream copy without the additions
        writes, notes = ws.plan_apply(project)
        assert set(writes) == {".omp/agents/workflow-coder.md"} and notes == [], writes
        ws.commit(project, writes)
        assert by_agent(project)["workflow-coder"]["effective"] == [*cb, "x-y", "graphify"]
        once = snapshot(project)
        assert ws.plan_apply(project) == ({}, []), "apply is idempotent"
        assert snapshot(project) == once

        # --- remove everything: byte-identical, overlay gone ---------------------------
        ws.commit(project, ws.plan_set(project, ["workflow-coder", "workflow-coder-backup"], []))
        assert snapshot(project) == pristine, "removing every addition restores the files exactly"

        # a role without an autoloadSkills line: added after model:, removed without a trace
        bare = next((name for name, skills in base.items() if not skills), None)
        if bare:
            bare_file = project / f".omp/agents/{bare}.md"
            ws.commit(project, ws.plan_set(project, [bare], ["graphify"]))
            lines = bare_file.read_text().splitlines()
            model = next(i for i, line in enumerate(lines) if line.startswith("model:"))
            assert lines[model + 1] == 'autoloadSkills: ["graphify"]', lines[:8]
            ws.commit(project, ws.plan_set(project, [bare], []))
            assert snapshot(project) == pristine

        # --- rejections change nothing --------------------------------------------------
        rejected(project, ["workflow-nope"], ["graphify"], "unknown agent 'workflow-nope'")
        rejected(project, ["workflow-coder", "workflow-nope"], ["graphify"], "unknown agent")
        rejected(project, ["../../etc/passwd"], ["graphify"], "unknown agent")
        rejected(project, ["workflow-designer"], ["ponytail"], "must not load")
        rejected(project, ["workflow-architect", "workflow-design-advisor-backup"], ["graphify", "ponytail"], "must not load")
        rejected(project, ["workflow-coder"], ["ponytail"], "already loaded by the Workflow")
        if base["workflow-architect"]:
            rejected(project, ["workflow-architect"], [base["workflow-architect"][0]], "already loaded by the Workflow")
        for bad in ("Bad_Name", "UPPER", "a b", "-x", "x-", "x--y", "../x", "a" * 65, ""):
            rejected(project, ["workflow-coder"], ["graphify", bad], "malformed skill name")

        # --- a failed write rolls back every file -----------------------------------------
        before = snapshot(project)
        real_replace, calls = ws.os.replace, []

        def failing_replace(src, dst):
            calls.append(dst)
            if len(calls) == 2:
                raise OSError("injected disk failure")
            return real_replace(src, dst)

        ws.os.replace = failing_replace
        try:
            ws.commit(project, ws.plan_set(project, ["workflow-coder", "workflow-coder-backup"], ["graphify"]))
            raise AssertionError("commit should have failed")
        except OSError as error:
            assert "injected" in str(error)
        finally:
            ws.os.replace = real_replace
        assert len(calls) == 2
        assert snapshot(project) == before, "all files restored, no temp files left, no overlay"

        # --- the command line: the consumer's contract ---------------------------------------
        done = cli(project, "set", "--agent", "workflow-coder", "--agent", "workflow-coder-backup", "--skills=graphify,x-y", "--json")
        assert done.returncode == 0, done.stderr
        out = json.loads(done.stdout)
        assert out == ws.show(project) and {e["agent"] for e in out["agents"]} >= {"workflow-coder", "workflow-coder-backup"}
        coder_entry = next(e for e in out["agents"] if e["agent"] == "workflow-coder")
        assert coder_entry["added"] == ["graphify", "x-y"] and coder_entry["workflow"] == cb
        shown_cli = json.loads(cli(project, "show", "--json").stdout)
        assert shown_cli == out
        done = cli(project, "set", "--agent", "workflow-coder", "--agent", "workflow-coder-backup", "--skills=", "--json")
        assert done.returncode == 0 and snapshot(project) == pristine, done.stderr
        for args, needle in (
            (["set", "--agent", "workflow-designer", "--skills=ponytail", "--json"], "must not load"),
            (["set", "--agent", "workflow-zzz", "--skills=graphify", "--json"], "unknown agent"),
            (["set", "--agent", "workflow-coder", "--skills=Bad Name", "--json"], "malformed"),
            (["set", "--agent", "workflow-coder", "--skills=ponytail", "--json"], "already loaded"),
        ):
            done = cli(project, *args)
            assert done.returncode != 0 and needle in done.stderr and done.stdout == "", (args, done)
        assert snapshot(project) == pristine

        # --- check (doctor lines) ------------------------------------------------------------
        assert ws.check(project) == [("OK", "no per-role skill additions")]
        ws.commit(project, ws.plan_set(project, ["workflow-coder"], ["graphify"]))
        assert ws.check(project)[0][0] == "OK"
        coder.write_bytes(pristine[".omp/agents/workflow-coder.md"])
        level, text = ws.check(project)[0]
        assert level == "FAIL" and "graphify" in text and "workflow_skills.py apply" in text, text
        assert cli(project, "check").returncode == 1
        ws.commit(project, ws.plan_apply(project)[0])
        assert cli(project, "check").returncode == 0

        # --- upstream_bytes: additions never show up in the recorded digest ----------------------
        rel = ".omp/agents/workflow-coder.md"
        assert ws.upstream_bytes(project, rel, coder.read_bytes()) == pristine[rel]
        assert ws.upstream_bytes(project, "README.md", b"x") == b"x"
        assert ws.upstream_bytes(project, ".omp/agents/other.md", b"x") == b"x"

        # --- a malformed overlay is reported, never guessed at -----------------------------------
        (project / ws.OVERLAY_REL).write_text("{oops", encoding="utf-8")
        assert ws.check(project)[0][0] == "FAIL"
        assert cli(project, "show").returncode == 2
        assert ws.upstream_bytes(project, rel, coder.read_bytes()) == coder.read_bytes(), "unreadable overlay: bytes unchanged"
        (project / ws.OVERLAY_REL).write_text('{"version": 1, "added": {"workflow-coder": ["Bad Name"]}}', encoding="utf-8")
        assert ws.check(project)[0][0] == "FAIL"

        # an upstream default that was also an addition leaves the overlay when upstream ships it
        (project / ws.OVERLAY_REL).write_text('{"version": 1, "added": {"workflow-coder": ["graphify"]}}', encoding="utf-8")
        coder.write_text(ws.add_skills(coder.read_text(), ["graphify"]), encoding="utf-8")
        writes, notes = ws.plan_apply(project, {rel})
        assert writes == {ws.OVERLAY_REL: None} and "now a Workflow default" in notes[0], (writes, notes)

        variants(tmp / "variants")
        membership(tmp / "membership")

    print("workflow_skills.selftest: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
