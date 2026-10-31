"""Linux remote helper: opt-in native CLI config, byte-exact backups, conflict-safe restore.

Read one JSON action from stdin. Never print credentials or complete configuration.
"""
import base64
import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile


def digest(raw):
    return hashlib.sha256(raw).hexdigest() if raw is not None else None


def read_bytes(file):
    if os.path.islink(file):
        raise ValueError("Refusing symlink configuration: " + str(file))
    if not os.path.exists(file):
        return None
    with open(file, "rb") as handle:
        return handle.read()


def atomic_write(file, raw):
    directory = os.path.dirname(file)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".magpie-native-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
        os.replace(tmp, file)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def load_json(raw):
    value = json.loads((raw or b"{}").decode("utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError("Configuration must be a JSON object")
    return value


def codex_catalog(home, model, extra=None, metadata=None):
    """Register magpie model ids so Codex's /model picker can select them."""
    try:
        proc = subprocess.run(
            ["bash", "-lic", "codex debug models --bundled"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, check=False,
        )
        data = json.loads(proc.stdout)
        templates = data.get("models", [])
    except Exception:
        templates = []
    if not templates:
        cache = os.path.join(home, ".codex/models_cache.json")
        try:
            with open(cache, encoding="utf-8") as handle:
                templates = json.load(handle).get("models", [])
        except Exception:
            raise ValueError("Cannot load Codex model schema; catalog unchanged")
    base = model.split("/")[-1]
    template = next((m for m in templates if m.get("slug") == base), None) or templates[0]
    candidates = [model]
    for slug in extra or []:
        if isinstance(slug, str) and re.fullmatch(r"[A-Za-z0-9._/:\[\]-]{1,128}", slug):
            candidates.append(slug)
    wanted = []
    for slug in candidates:
        if slug and slug not in wanted:
            wanted.append(slug)
    entries = []
    for priority, slug in enumerate(wanted):
        entry = copy.deepcopy(template)
        entry["slug"] = slug
        entry["display_name"] = slug + " (magpie)"
        entry["description"] = "Routed through the local magpie gateway"
        entry["visibility"] = "list"
        entry["supported_in_api"] = True
        entry["priority"] = priority
        info = (metadata or {}).get(slug, {})
        levels = []
        for variant, options in info.get("variants", {}).items():
            effort = options.get("reasoningEffort", variant)
            if effort in ("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra") and effort not in levels:
                levels.append(effort)
        entry["supported_reasoning_levels"] = [{"effort": x, "description": x} for x in levels]
        entry["default_reasoning_level"] = levels[0] if levels else None
        limits = info.get("limit", {})
        if limits.get("context"):
            entry["context_window"] = limits["context"]
        # Model prompts and service tiers from another model must not be copied.
        for key in ("model_messages", "availability_nux", "service_tiers", "additional_speed_tiers"):
            entry.pop(key, None)
        entry["base_instructions"] = "You are Codex, a coding agent."
        # Older Codex builds require this field; some catalogs omit it.
        entry.setdefault("supports_parallel_tool_calls", True)
        entries.append(entry)
    target = os.path.join(home, ".codex/magpie-models.json")
    os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
    atomic_write(target, (json.dumps({"models": entries}, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    return target


def codex_config(raw, port, model, catalog_path=None):
    """Keep the existing provider id so Codex keeps the same conversation space.

    Only the selected provider's endpoint/auth is redirected to the tunnel.
    """
    text = (raw or b"").decode("utf-8-sig")
    if '"""' in text or "'''" in text:
        raise ValueError("Multiline TOML strings need manual configuration; original file unchanged")
    lines = text.splitlines(keepends=True)
    first_table = next((i for i, line in enumerate(lines) if line.lstrip().startswith("[")), len(lines))
    root = lines[:first_table]
    for line in root:
        if re.match(r'^\s*["\']?model_providers["\']?\s*[.=]', line):
            raise ValueError("Inline/dotted model_providers needs manual configuration")
    provider = "OpenAI"
    for line in root:
        match = re.match(r'^\s*model_provider\s*=\s*"([^"]+)"\s*(?:#.*)?$', line)
        if match:
            provider = match.group(1)
    if not re.fullmatch(r'[A-Za-z0-9_.-]+', provider):
        raise ValueError("Provider id is too complex for automatic configuration")

    # Rewrite root model_provider/model/model_catalog_json in place, keeping all other root keys.
    eol = "\r\n" if "\r\n" in text else "\n"
    out_root = []
    saw_provider = saw_model = saw_catalog = False
    for line in root:
        match = re.match(r'^(\s*)("?)(model_provider|model|model_catalog_json)\2(\s*=\s*)(.*?)(\r?\n)?$', line)
        if match and match.group(3) in ("model_provider", "model", "model_catalog_json"):
            key = match.group(3)
            if key == "model_provider":
                value = provider
            elif key == "model":
                value = model
            else:
                if not catalog_path:
                    out_root.append(line)
                    saw_catalog = True
                    continue
                existing = match.group(5).strip()
                if existing and existing not in ('"%s"' % catalog_path, "'%s'" % catalog_path, '"~/.codex/magpie-models.json"'):
                    raise ValueError("Existing model_catalog_json needs manual merge")
                value = catalog_path
            out_root.append('%s%s = "%s"%s' % (match.group(1), key, value, match.group(6) or ""))
            saw_provider = saw_provider or key == "model_provider"
            saw_model = saw_model or key == "model"
            saw_catalog = saw_catalog or key == "model_catalog_json"
        else:
            out_root.append(line)
    if not saw_provider:
        out_root.insert(0, 'model_provider = "%s"%s' % (provider, eol))
    if not saw_model:
        out_root.append('model = "%s"%s' % (model, eol))
    if catalog_path and not saw_catalog:
        out_root.append('model_catalog_json = "%s"%s' % (catalog_path, eol))

    # Find the provider's table and replace it. Its sub-tables are dropped because
    # env_key/auth would conflict with the local bearer token.
    header_re = re.compile(r'^\s*\[\s*model_providers\s*\.\s*([A-Za-z0-9_.-]+)\s*\]\s*(?:#.*)?$')
    start = None
    for i, line in enumerate(lines[first_table:], first_table):
        match = header_re.match(line)
        if match and match.group(1) == provider:
            if start is not None:
                raise ValueError("Duplicate provider table: " + provider)
            start = i
    if start is None:
        raise ValueError("Provider table not found: " + provider)
    end = start + 1
    sub_re = re.compile(r'^\s*\[\s*model_providers\s*\.\s*' + re.escape(provider) + r'\s*\.')
    while end < len(lines):
        stripped = lines[end].lstrip()
        if stripped.startswith("["):
            if sub_re.match(lines[end]):
                end += 1
                continue
            break
        end += 1

    # Keep the provider ID for history, and label the gateway accurately.
    name = "magpie"
    block = [
        "[model_providers.%s]%s" % (provider, eol),
        'name = "%s"%s' % (name, eol),
        'base_url = "http://127.0.0.1:%d/v1"%s' % (port, eol),
        'wire_api = "responses"%s' % eol,
        "requires_openai_auth = false" + eol,
        # Local placeholder; real upstream credentials stay on Windows.
        'experimental_bearer_token = "magpie"%s' % eol,
    ]
    result = "".join(out_root) + "".join(lines[first_table:start]) + "".join(block) + "".join(lines[end:])
    result = result.rstrip("\r\n") + eol

    # Validate whole TOML when a parser is available, without installing one.
    try:
        import tomllib as toml
    except ImportError:
        try:
            import tomli as toml
        except ImportError:
            try:
                from pip._vendor import tomli as toml
            except ImportError:
                toml = None
    if toml is not None:
        parsed = toml.loads(result)
        if parsed.get("model_provider") != provider or parsed.get("model") != model:
            raise ValueError("TOML validation failed")
        if parsed.get("model_providers", {}).get(provider, {}).get("base_url") != "http://127.0.0.1:%d/v1" % port:
            raise ValueError("Provider validation failed")
    return result.encode("utf-8")


def claude_config(raw, port, model, window=None, windows=None, bypass=False):
    config = load_json(raw)
    try:
        window = max(100000, min(1000000, int(window)))
    except (TypeError, ValueError):
        window = 400000
    # Claude Code reads the compaction window per model; a top-level key is ignored.
    settings = config.setdefault("modelSettings", {})
    if not isinstance(settings, dict):
        raise ValueError("Claude modelSettings must be an object")
    entries = {model: window}
    for name, value in (windows or {}).items():
        if isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9._/:\[\]-]{1,128}", name):
            try:
                value = int(value)
            except (TypeError, ValueError):
                continue
            if 100000 <= value <= 1000000:
                entries[name] = value
    for name, value in entries.items():
        entry = settings.setdefault(name, {})
        if not isinstance(entry, dict):
            raise ValueError("Claude modelSettings entry must be an object")
        entry["autoCompactWindow"] = value
    env = config.setdefault("env", {})
    if not isinstance(env, dict):
        raise ValueError("Claude env must be an object")
    env.pop("ANTHROPIC_API_KEY", None)
    env.update({
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:%d" % port,
        "ANTHROPIC_AUTH_TOKEN": "magpie",
        "ANTHROPIC_MODEL": model,
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    })
    config["model"] = model
    if bypass:
        permissions = config.setdefault("permissions", {})
        if not isinstance(permissions, dict):
            raise ValueError("Claude permissions must be an object")
        permissions["defaultMode"] = "bypassPermissions"
    return (json.dumps(config, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def paths(home, tool):
    return os.path.join(home, ".codex/config.toml" if tool == "codex" else ".claude/settings.json")


def status(home, tool, state_dir):
    file = paths(home, tool)
    raw = read_bytes(file)
    record_file = os.path.join(state_dir, tool + ".json")
    record = load_json(read_bytes(record_file))
    active = record.get("active", False)
    return {
        "active": bool(active),
        "changed": bool(active and digest(raw) != record.get("appliedHash")),
        "canRestore": bool(active and digest(raw) == record.get("appliedHash")),
        "file": file,
        "port": record.get("port") if active else None,
        "model": record.get("model") if active else None,
        "backup": record.get("backup") if active else None,
    }


def rolling_backup(file, raw):
    """Keep one rolling pre-change backup; remove old timestamped panel backups."""
    if raw is None:
        return None
    target = file + ".magpie-panel.bak"
    atomic_write(target, raw)
    base = os.path.basename(file) + ".magpie-panel."
    directory = os.path.dirname(file)
    try:
        for name in os.listdir(directory):
            if name.startswith(base) and name.endswith(".bak") and name != base + "bak" and re.search(r"\.before-(?:restore|update)\.\d+\.bak$", name):
                try:
                    os.unlink(os.path.join(directory, name))
                except OSError:
                    pass
    except OSError:
        pass
    return target


def dispatch(request, home=None):
    home = home or os.path.expanduser("~")
    state_dir = os.path.join(home, ".config/magpie-panel/native")
    action = request.get("action")
    if action == "status":
        return {tool: status(home, tool, state_dir) for tool in ("codex", "claude")}
    if action == "catalog":
        model = request.get("model", "")
        if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9._/:\[\]-]{1,128}", model):
            raise ValueError("Invalid model")
        catalog = codex_catalog(home, model, request.get("extra") or [], request.get("metadata"))
        file = paths(home, "codex")
        raw = read_bytes(file)
        record_file = os.path.join(state_dir, "codex.json")
        record = load_json(read_bytes(record_file))
        if record.get("active"):
            text = raw.decode("utf-8-sig")
            provider = re.search(r'^model_provider\s*=\s*"([A-Za-z0-9_.-]+)"', text, re.M)
            if not provider:
                raise ValueError("Cannot identify active Codex provider")
            pattern = r'(\[model_providers\.' + re.escape(provider.group(1)) + r'\]\s*\n)([^\[]*)'
            def rename(match):
                block = match.group(2)
                block = re.sub(r'^name\s*=.*$', 'name = "magpie"', block, flags=re.M)
                return match.group(1) + block
            text = re.sub(pattern, rename, text)
            if re.search(r'^model_catalog_json\s*=', text, re.M):
                text = re.sub(r'^model_catalog_json\s*=.*$', 'model_catalog_json = ' + json.dumps(catalog), text, flags=re.M)
            else:
                text = 'model_catalog_json = ' + json.dumps(catalog) + '\n' + text
            updated = text.encode("utf-8")
            if updated != raw:
                rolling_backup(file, raw)
                atomic_write(file, updated)
                record["appliedHash"] = digest(updated)
                atomic_write(record_file, json.dumps(record).encode("utf-8"))
        return {"catalog": catalog}
    tool = request.get("tool")
    if tool not in ("codex", "claude") or action not in ("apply", "restore"):
        raise ValueError("Invalid native CLI action")
    file = paths(home, tool)
    raw = read_bytes(file)
    record_file = os.path.join(state_dir, tool + ".json")
    record = load_json(read_bytes(record_file))
    force = bool(request.get("force"))
    if record.get("active") and digest(raw) != record.get("appliedHash") and not force:
        raise ValueError("Configuration changed after activation; refusing overwrite. Merge the backup manually.")
    os.makedirs(state_dir, mode=0o700, exist_ok=True)
    os.chmod(state_dir, 0o700)
    if action == "restore":
        if not record.get("active"):
            raise ValueError("No active native configuration to restore")
        original = read_bytes(record["backup"]) if record.get("originalExists") else None
        if record.get("originalExists") and (original is None or digest(original) != record.get("originalHash")):
            raise ValueError("Backup missing or changed; refusing restore")
        if raw is not None:
            rolling_backup(file, raw)
        if original is None:
            if os.path.exists(file):
                os.unlink(file)
        else:
            atomic_write(file, original)
            os.chmod(file, record.get("originalMode", 0o600))
        record["active"] = False
        atomic_write(record_file, json.dumps(record).encode("utf-8"))
        return {"restored": True, "file": file}
    port = request.get("port")
    model = request.get("model", "")
    if not isinstance(port, int) or isinstance(port, bool) or not 1024 <= port <= 65535:
        raise ValueError("Invalid port")
    if not re.fullmatch(r"[A-Za-z0-9._/:\[\]-]{1,128}", model):
        raise ValueError("Invalid model")
    if record.get("active") and not force:
        # Reapply after model/port changes from the original snapshot, not from prior generated TOML.
        source = read_bytes(record["backup"]) if record.get("originalExists") else None
        if digest(source) != record.get("originalHash"):
            raise ValueError("Backup changed; refusing overwrite")
    else:
        source = raw
    if force and tool == "claude" and isinstance(load_json(source).get("model"), str) and load_json(source).get("model"):
        model = load_json(source)["model"]
    window = request.get("contextWindow")
    limits = ((request.get("metadata") or {}).get(model) or {}).get("limit") or {}
    try:
        window = int(limits.get("context")) or window
    except (TypeError, ValueError):
        pass
    catalog_path = codex_catalog(home, model, request.get("extra"), request.get("metadata")) if tool == "codex" else None
    updated = codex_config(source, port, model, catalog_path) if tool == "codex" else claude_config(source, port, model, window, request.get("windows"), bool(request.get("bypass")))
    if not record.get("active"):
        backup = os.path.join(state_dir, tool + ".original.bak")
        if source is not None:
            atomic_write(backup, source)
        # Remove older timestamped originals; the record points at the fixed file.
        for name in os.listdir(state_dir):
            if name.startswith(tool + ".original.") and name.endswith(".bak") and name != tool + ".original.bak":
                try:
                    os.unlink(os.path.join(state_dir, name))
                except OSError:
                    pass
        record = {"originalExists": source is not None, "originalHash": digest(source), "backup": backup,
                  "originalMode": os.stat(file).st_mode & 0o777 if source is not None else 0o600}
    elif raw is not None:
        rolling_backup(file, raw)
    record.update({"active": True, "appliedHash": digest(updated), "port": port, "model": model})
    # Save recoverable metadata first; a failed config write is detected as a hash conflict.
    atomic_write(record_file, json.dumps(record).encode("utf-8"))
    atomic_write(file, updated)
    return {"applied": True, "file": file, "backup": record["backup"], "port": port, "model": model}


if __name__ == "__main__":
    try:
        home = os.environ.get("MAGPIE_NATIVE_HOME") or None
        print(json.dumps({"ok": True, "data": dispatch(json.load(sys.stdin), home)}, ensure_ascii=False))
    except Exception as error:
        # Do not echo the full file or request (both can contain credentials).
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
