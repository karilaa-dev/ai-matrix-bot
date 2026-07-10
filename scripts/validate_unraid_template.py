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
    "MATRIX_BOT_USER_ID",
    "MATRIX_OWNER_ID",
    "MATRIX_DEVICE_ID",
    "MATRIX_ACCESS_TOKEN",
    "MATRIX_RECOVERY_KEY",
    "OPENROUTER_API_KEY",
    "TAVILY_API_KEY",
    "DOCLING_URL",
}
assert required_targets <= configs.keys(), required_targets - configs.keys()
for target in required_targets:
    assert configs[target].get("Required") == "true", target

masked = {
    "MATRIX_ACCESS_TOKEN",
    "MATRIX_RECOVERY_KEY",
    "OPENROUTER_API_KEY",
    "TAVILY_API_KEY",
}
for target in masked:
    assert configs[target].get("Mask") == "true", target

expected_defaults = {
    "/app/data": "/mnt/user/appdata/ai-matrix-bot",
    "/app/data/files": "/mnt/user/ai-matrix-bot",
    "HOME": "/app/data/home",
    "MATRIX_DATABASE_PATH": "/app/data/matrix-bot.sqlite",
    "CORE_DATABASE_URL": "file:/app/data/codex-core.sqlite",
    "MATRIX_STORAGE_PATH": "/app/data/matrix/sync",
    "MATRIX_CRYPTO_PATH": "/app/data/matrix/crypto",
    "CODEX_HOME": "/app/data/codex",
    "FILE_ROOT": "/app/data/files",
    "BASH_ROOT": "/app/data/files/bash",
}
for target, expected in expected_defaults.items():
    assert configs[target].get("Default") == expected, target

docling_url = configs["DOCLING_URL"].get("Default", "")
assert docling_url.startswith(("http://", "https://"))
assert docling_url != "http://docling:5001"

print("Unraid template validation passed")
