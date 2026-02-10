#!/usr/bin/env python3

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


try:
    import yaml  # type: ignore
except Exception as exc:  # pragma: no cover
    print(
        "PyYAML is required to validate skills. Install it with:\n"
        "  python3 -m pip install pyyaml\n",
        file=sys.stderr,
    )
    raise SystemExit(2) from exc


ALLOWED_FRONTMATTER_KEYS = {
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
}


@dataclass(frozen=True)
class ValidationError:
    path: Path
    message: str


def _parse_frontmatter(path: Path) -> dict[str, Any]:
    content = path.read_text(encoding="utf-8")
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError("missing frontmatter start delimiter '---' on first line")

    end_index = None
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            end_index = index
            break

    if end_index is None:
        raise ValueError("missing frontmatter end delimiter '---'")

    frontmatter_text = "\n".join(lines[1:end_index])
    try:
        data = yaml.safe_load(frontmatter_text)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"invalid YAML frontmatter: {exc}") from exc

    if not isinstance(data, dict):
        raise ValueError("frontmatter must be a YAML map")

    return data


def _is_lower_alnum(char: str) -> bool:
    if char.isdigit():
        return True
    return char.isalpha() and char == char.lower()


def _validate_name(value: Any, expected: str) -> list[str]:
    errors: list[str] = []
    if not isinstance(value, str):
        return ["name must be a string"]

    if not (1 <= len(value) <= 64):
        errors.append("name must be 1-64 characters")

    if value != expected:
        errors.append(f"name must match directory/file name '{expected}'")

    if value.startswith("-") or value.endswith("-"):
        errors.append("name must not start or end with '-'")

    if "--" in value:
        errors.append("name must not contain consecutive hyphens ('--')")

    for char in value:
        if char == "-":
            continue
        if not _is_lower_alnum(char):
            errors.append(
                "name may only contain lowercase alphanumeric characters and hyphens"
            )
            break

    return errors


def _validate_description(value: Any) -> list[str]:
    if not isinstance(value, str):
        return ["description must be a string"]
    if not (1 <= len(value) <= 1024):
        return ["description must be 1-1024 characters"]
    return []


def _validate_optional_string(value: Any, *, field: str, min_len: int, max_len: int) -> list[str]:
    if not isinstance(value, str):
        return [f"{field} must be a string"]
    if not (min_len <= len(value) <= max_len):
        return [f"{field} must be {min_len}-{max_len} characters"]
    return []


def _validate_metadata(value: Any) -> list[str]:
    if not isinstance(value, dict):
        return ["metadata must be a map of string keys to string values"]

    for key, item in value.items():
        if not isinstance(key, str) or not isinstance(item, str):
            return ["metadata must be a map of string keys to string values"]

    return []


def _validate_allowed_tools(value: Any) -> list[str]:
    if not isinstance(value, str):
        return ["allowed-tools must be a string"]
    if not value.strip():
        return ["allowed-tools must not be empty"]

    tokens = value.split()
    for token in tokens:
        # Spec: "space-delimited list of tools". Common forms:
        # - Read
        # - Bash(git:*)
        if "(" in token or ")" in token:
            if not (token.count("(") == 1 and token.endswith(")")):
                return [f"allowed-tools token '{token}' is not well-formed"]
            head, tail = token.split("(", 1)
            if not head or not head[0].isalpha() or not all(
                c.isalnum() or c == "-" for c in head
            ):
                return [f"allowed-tools token '{token}' is not well-formed"]
            inside = tail[:-1]
            if not inside or any(ch.isspace() for ch in inside):
                return [f"allowed-tools token '{token}' is not well-formed"]
        else:
            if not token[0].isalpha() or not all(c.isalnum() or c == "-" for c in token):
                return [f"allowed-tools token '{token}' is not well-formed"]

    return []


def _expected_name_for_skill_file(path: Path) -> str:
    if path.name == "SKILL.md":
        return path.parent.name
    return path.stem


def validate_skill(path: Path) -> list[ValidationError]:
    errors: list[ValidationError] = []
    try:
        frontmatter = _parse_frontmatter(path)
    except Exception as exc:  # noqa: BLE001
        return [ValidationError(path=path, message=str(exc))]

    unknown_keys = sorted(set(frontmatter.keys()) - ALLOWED_FRONTMATTER_KEYS)
    if unknown_keys:
        errors.append(
            ValidationError(
                path=path,
                message=f"unknown frontmatter keys: {', '.join(unknown_keys)}",
            )
        )

    expected_name = _expected_name_for_skill_file(path)
    for message in _validate_name(frontmatter.get("name"), expected_name):
        errors.append(ValidationError(path=path, message=message))
    for message in _validate_description(frontmatter.get("description")):
        errors.append(ValidationError(path=path, message=message))

    if "license" in frontmatter:
        for message in _validate_optional_string(
            frontmatter["license"],
            field="license",
            min_len=1,
            max_len=10_000,
        ):
            errors.append(ValidationError(path=path, message=message))

    if "compatibility" in frontmatter:
        for message in _validate_optional_string(
            frontmatter["compatibility"],
            field="compatibility",
            min_len=1,
            max_len=500,
        ):
            errors.append(ValidationError(path=path, message=message))

    if "metadata" in frontmatter:
        for message in _validate_metadata(frontmatter["metadata"]):
            errors.append(ValidationError(path=path, message=message))

    if "allowed-tools" in frontmatter:
        for message in _validate_allowed_tools(frontmatter["allowed-tools"]):
            errors.append(ValidationError(path=path, message=message))

    return errors


def find_skill_files(skills_dir: Path) -> list[Path]:
    return sorted(skills_dir.glob("*.md")) + sorted(skills_dir.glob("*/SKILL.md"))


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    skills_dir = repo_root / "skills"
    if not skills_dir.exists():
        return 0

    skill_files = find_skill_files(skills_dir)
    if not skill_files:
        return 0

    all_errors: list[ValidationError] = []
    for path in skill_files:
        all_errors.extend(validate_skill(path))

    if not all_errors:
        return 0

    print("Skill validation failed:\n", file=sys.stderr)
    for err in all_errors:
        rel = err.path.relative_to(repo_root)
        print(f"- {rel}: {err.message}", file=sys.stderr)

    return 1


if __name__ == "__main__":
    raise SystemExit(main())

