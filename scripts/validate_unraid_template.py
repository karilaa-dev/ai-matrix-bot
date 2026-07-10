#!/usr/bin/env python3
"""Validate the deployable invariants of the Unraid container template."""

from pathlib import Path
from xml.etree import ElementTree


TEMPLATE = Path(__file__).resolve().parents[1] / "templates" / "ai-matrix-bot.xml"
root = ElementTree.parse(TEMPLATE).getroot()


def text(name: str) -> str:
    value = root.findtext(name)
    assert value is not None, f"missing <{name}>"
    return value.strip()


assert root.tag == "Container"
assert text("Repository") == "ghcr.io/karilaa-dev/ai-matrix-bot:latest"
assert text("Network") == "bridge"
assert text("Privileged") == "false"
assert "--user=99:100" in text("ExtraParams")
assert root.find("WebUI") is not None

configs = {
    element.attrib["Target"]: element.attrib
    for element in root.findall("Config")
}
assert not any(config.get("Type") == "Port" for config in configs.values())

required_targets = {
    "/app/data",
    "/app/data/files",
    "MATRIX_HOMESERVER_URL",
    "MATRIX_OWNER_ID",
    "MATRIX_ENCRYPTION_SECRET",
}
assert required_targets <= configs.keys(), required_targets - configs.keys()
for target in required_targets:
    assert configs[target].get("Required") == "true", target

masked = {
    "MATRIX_ACCESS_TOKEN",
    "MATRIX_PASSWORD",
    "MATRIX_ENCRYPTION_SECRET",
    "OPENROUTER_API_KEY",
    "TAVILY_API_KEY",
}
for target in masked:
    assert configs[target].get("Mask") == "true", target

for target in {"MATRIX_ACCESS_TOKEN", "MATRIX_LOGIN", "MATRIX_PASSWORD"}:
    assert target in configs, target
    assert configs[target].get("Required") == "false", target
assert configs["MATRIX_LOGIN"].get("Mask") == "false"

expected_defaults = {
    "/app/data": "/mnt/user/appdata/ai-matrix-bot",
    "/app/data/files": "/mnt/user/ai-matrix-bot",
}
for target, expected in expected_defaults.items():
    assert configs[target].get("Default") == expected, target

assert configs["DOCLING_URL"].get("Default", "") == ""
for target in {"DOCLING_URL", "OPENROUTER_API_KEY", "TAVILY_API_KEY"}:
    assert configs[target].get("Required") == "false", target

removed_deployment_knobs = {
    "MATRIX_BOT_USER_ID",
    "MATRIX_DEVICE_ID",
    "MATRIX_RECOVERY_KEY",
    "HOME",
    "MATRIX_DATABASE_PATH",
    "MATRIX_SESSION_PATH",
    "CORE_DATABASE_URL",
    "MATRIX_STORAGE_PATH",
    "MATRIX_CRYPTO_PATH",
    "CODEX_HOME",
    "FILE_ROOT",
    "BASH_ROOT",
}
assert not (removed_deployment_knobs & configs.keys()), removed_deployment_knobs & configs.keys()

print("Unraid template validation passed")
