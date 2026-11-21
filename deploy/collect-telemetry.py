#!/usr/bin/env python3
"""Read private Telemt metrics and send aggregates to the eBunny panel."""
import ipaddress
import json
import math
import os
import re
import subprocess
import sys
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

METRICS_URL = "http://127.0.0.1:9090/metrics"
MAX_METRICS_SIZE = 2 * 1024 * 1024
USER_FIELDS = {
    "telemt_user_connections_current": "connections",
    "telemt_user_octets_from_client_total": "received",
    "telemt_user_octets_to_client_total": "sent",
}


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def parse_metrics(text):
    totals = dict.fromkeys(USER_FIELDS.values(), 0)
    counts = dict.fromkeys(USER_FIELDS.values(), 0)
    uptime = None
    user_series_unsuppressed = False
    for line in text.splitlines():
        name, _, value = line.rpartition(" ")
        if name in ("telemt_uptime_seconds", "telemt_telemetry_user_series_suppressed"):
            number = float(value)
            if name == "telemt_uptime_seconds" and math.isfinite(number) and number >= 0:
                uptime = number
            elif name == "telemt_telemetry_user_series_suppressed":
                user_series_unsuppressed = number == 0
            continue
        field = USER_FIELDS.get(name.split("{", 1)[0])
        if field and re.fullmatch(r"[0-9]+", value):
            totals[field] += int(value)
            counts[field] += 1

    if uptime is None:
        return {"telemt": False}

    result = {"telemt": True, "uptime": uptime}
    if user_series_unsuppressed:
        result["connections"] = totals["connections"]
        if counts["received"] == counts["sent"] == counts["connections"]:
            result["bytes"] = totals["received"] + totals["sent"]
    return result


def read_telemt(opener):
    try:
        with opener.open(METRICS_URL, timeout=4) as response:
            payload = response.read(MAX_METRICS_SIZE + 1)
        if len(payload) > MAX_METRICS_SIZE:
            return {"telemt": False}
        return parse_metrics(payload.decode("utf-8"))
    except (OSError, ValueError):
        return {"telemt": False}


def probe_tunnel(interface, peer):
    try:
        check = subprocess.run(
            ["ping", "-n", "-c", "1", "-W", "2", "-I", interface, peer],
            capture_output=True,
            text=True,
            timeout=4,
            env={**os.environ, "LC_ALL": "C"},
            check=False,
        )
        if check.returncode == 1:
            return {"wireguard": False}
        if check.returncode == 0:
            rtt = re.search(r"time[=<]([0-9.]+)\s*ms", check.stdout)
            return {"wireguard": True, "latency": float(rtt[1]) if rtt else None}
    except (OSError, subprocess.TimeoutExpired):
        pass
    return {"wireguard": None}


def optional_ipv4(env_name):
    value = os.environ.get(env_name)
    return str(ipaddress.IPv4Address(value)) if value else None


def main():
    url = os.environ["PANEL_TELEMETRY_URL"]
    parsed = urlsplit(url)
    key = os.environ["TELEMETRY_INGEST_KEY"]
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or
            parsed.path != "/api/telemetry/sample" or parsed.query or parsed.fragment):
        raise ValueError("PANEL_TELEMETRY_URL должен быть HTTPS-адресом /api/telemetry/sample.")
    if not re.fullmatch(r"[a-fA-F0-9]{64}", key):
        raise ValueError("TELEMETRY_INGEST_KEY должен содержать 64 hex-символа.")
    interface = os.environ.get("WIREGUARD_INTERFACE", "wg-ebunny")
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,14}", interface):
        raise ValueError("Проверь WIREGUARD_INTERFACE.")
    peer = str(ipaddress.IPv4Address(os.environ.get("WIREGUARD_PEER_IP", "10.77.0.1")))
    opener = build_opener(NoRedirects)
    sample = {
        **read_telemt(opener),
        **probe_tunnel(interface, peer),
        "ingressIp": optional_ipv4("INGRESS_PUBLIC_IP"),
        "exitIp": optional_ipv4("EXIT_PUBLIC_IP"),
    }
    request = Request(url, json.dumps(sample).encode(), {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }, method="POST")
    with opener.open(request, timeout=10) as response:
        if response.status != 200:
            raise ValueError("Панель вернула неожиданный HTTP-статус.")
    print("Замер передан панели.")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, OSError, URLError) as error:
        print(f"Не удалось передать замер: {error}", file=sys.stderr)
        sys.exit(1)
